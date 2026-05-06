/**
 * AgentDOM Secrets Resolver
 *
 * Resolves credentials for any provider with ZERO human interaction.
 * Agents are deployed once with secrets pre-injected — they never ask.
 *
 * Resolution order (fastest/safest first):
 *  1. Environment variables  (AGENTDOM_<HOST>_KEY / _TOKEN)
 *  2. ~/.agentdom/wallet.json (pre-seeded at deploy time)
 *  3. OS Keychain (macOS / Windows / Linux)
 *  4. AWS SSM Parameter Store  (if AWS_REGION set)
 *  5. HashiCorp Vault          (if VAULT_ADDR set)
 *  6. 1Password Secrets        (if OP_SERVICE_ACCOUNT_TOKEN set)
 *  7. Fail with clear message  (run `agentdom setup <host>` once)
 *
 * For OAuth providers — refresh tokens are stored at deploy time.
 * The agent rotates access tokens automatically using stored refresh tokens.
 * No browser. No prompts. No human.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WALLET_FILE = path.join(os.homedir(), '.agentdom', 'wallet.json');
const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');

// ── Env-var convention ────────────────────────────────────────────────────────
// AGENTDOM_LINEAR_APP_KEY, AGENTDOM_OPENROUTER_AI_KEY, AGENTDOM_RESEND_COM_KEY
function envKey(host) {
  return 'AGENTDOM_' + host.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
}
function envToken(host) {
  return 'AGENTDOM_' + host.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN';
}

// ── 1. Environment variables ──────────────────────────────────────────────────
function fromEnv(host) {
  const key   = process.env[envKey(host)];
  const token = process.env[envToken(host)];
  if (key || token) {
    return { method: 'api_key', token: key || token, source: 'env', host };
  }
  // Generic fallback names providers may use
  const generic = process.env[`${host.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_API_KEY`];
  if (generic) return { method: 'api_key', token: generic, source: 'env_generic', host };
  return null;
}

// ── 2. Wallet file ────────────────────────────────────────────────────────────
function loadWalletData() {
  // AGENTDOM_WALLET_B64 — portable base64 wallet (Docker, serverless, CI)
  if (process.env.AGENTDOM_WALLET_B64) {
    try { return JSON.parse(Buffer.from(process.env.AGENTDOM_WALLET_B64, 'base64').toString('utf-8')); }
    catch { /* malformed, fall through */ }
  }
  // AGENTDOM_WALLET_PATH — explicit file path
  if (process.env.AGENTDOM_WALLET_PATH) {
    try { return JSON.parse(fs.readFileSync(process.env.AGENTDOM_WALLET_PATH, 'utf-8')); }
    catch { /* missing, fall through */ }
  }
  // Default ~/.agentdom/wallet.json
  if (!fs.existsSync(WALLET_FILE)) return { wallet: '0.1', providers: {} };
  try { return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); }
  catch { return { wallet: '0.1', providers: {} }; }
}

function fromWallet(host) {
  try {
    const w = loadWalletData();
    const entry = (w.providers || {})[host];
    if (!entry) return null;
    // Check OAuth token expiry
    if (entry.method === 'oauth2' && entry.expires_at) {
      const expiresAt = new Date(entry.expires_at);
      if (expiresAt < new Date() && !entry.refresh_token) return null;
    }
    return { ...entry, source: process.env.AGENTDOM_WALLET_B64 ? 'wallet_b64' : process.env.AGENTDOM_WALLET_PATH ? 'wallet_path' : 'wallet', host };
  } catch { return null; }
}

// ── 3. OS Keychain ────────────────────────────────────────────────────────────
async function fromKeychain(host) {
  try {
    const keychain = require('./keychain');
    const token = await keychain.getToken(host);
    if (token && !keychain.isExpired(token)) return { ...token, source: 'keychain', host };
  } catch { }
  return null;
}

// ── 4. AWS SSM Parameter Store ────────────────────────────────────────────────
async function fromAWSSSM(host) {
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) return null;
  const paramPath = `/agentdom/${host}/token`;
  try {
    const out = execFileSync('aws', [
      'ssm', 'get-parameter', '--name', paramPath, '--with-decryption',
      '--query', 'Parameter.Value', '--output', 'text',
      '--region', process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore','pipe','ignore'] }).trim();
    if (out && out !== 'None') return { method: 'api_key', token: out, source: 'aws_ssm', host };
  } catch { }
  return null;
}

// ── 5. HashiCorp Vault ────────────────────────────────────────────────────────
async function fromVault(host) {
  if (!process.env.VAULT_ADDR) return null;
  const secretPath = `secret/agentdom/${host}`;
  try {
    const out = execFileSync('vault', [
      'kv', 'get', '-format=json', secretPath,
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore','pipe','ignore'] });
    const data = JSON.parse(out);
    const token = data?.data?.data?.token || data?.data?.token;
    if (token) return { method: 'api_key', token, source: 'vault', host };
  } catch { }
  return null;
}

// ── 6. 1Password Secrets Automation ──────────────────────────────────────────
async function from1Password(host) {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) return null;
  const ref = `op://AgentDOM/${host}/token`;
  try {
    const token = execFileSync('op', ['read', ref], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore','pipe','ignore'],
    }).trim();
    if (token) return { method: 'api_key', token, source: '1password', host };
  } catch { }
  return null;
}

// ── OAuth token auto-refresh ──────────────────────────────────────────────────
async function refreshOAuthToken(entry) {
  if (!entry.refresh_token) return null;
  const tokenUrl = entry.token_url;
  if (!tokenUrl) return null;
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entry.refresh_token,
        client_id: entry.client_id || '',
        client_secret: entry.client_secret || '',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const refreshed = {
      ...entry,
      token: data.access_token,
      refresh_token: data.refresh_token || entry.refresh_token,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
    };
    // Persist refreshed token back to wallet
    saveToWallet(entry.host, refreshed);
    return refreshed;
  } catch { return null; }
}

function saveToWallet(host, entry) {
  try {
    if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive: true });
    let w = { wallet: '0.1', providers: {} };
    if (fs.existsSync(WALLET_FILE)) {
      try { w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); } catch {}
    }
    if (!w.providers) w.providers = {};
    w.providers[host] = { ...entry, saved_at: new Date().toISOString() };
    fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2), { mode: 0o600 });
  } catch {}
}

// ── Main resolver ─────────────────────────────────────────────────────────────
/**
 * Resolve a credential for a provider host. Never prompts the human.
 * 
 * @param {string} host  e.g. "openrouter.ai", "resend.com"
 * @returns {{ method, token, source, host } | null}
 */
async function resolve(host) {
  host = host.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*/, '');

  // 1. Env vars (fastest, most common in CI/CD)
  const envResult = fromEnv(host);
  if (envResult) return envResult;

  // 2. Wallet file (pre-seeded by setup or deploy script)
  const walletResult = fromWallet(host);
  if (walletResult) {
    // Auto-refresh OAuth tokens if expired
    if (walletResult.method === 'oauth2' && walletResult.expires_at) {
      const exp = new Date(walletResult.expires_at);
      const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
      if (exp < fiveMinFromNow && walletResult.refresh_token) {
        const refreshed = await refreshOAuthToken({ ...walletResult, host });
        if (refreshed) return refreshed;
      }
    }
    return walletResult;
  }

  // 3. OS Keychain
  const keychainResult = await fromKeychain(host);
  if (keychainResult) return keychainResult;

  // 4–6. External vaults (parallel)
  const [ssmResult, vaultResult, opResult] = await Promise.allSettled([
    fromAWSSSM(host),
    fromVault(host),
    from1Password(host),
  ]);
  const external = [ssmResult, vaultResult, opResult]
    .find(r => r.status === 'fulfilled' && r.value);
  if (external) return external.value;

  return null;
}

/**
 * Resolve or throw — used in dispatch_intent to fail fast with a clear message.
 */
async function resolveOrThrow(host) {
  const cred = await resolve(host);
  if (cred) return cred;

  const envVarName = envKey(host);
  throw new Error(
    `No credentials found for ${host}.\n\n` +
    `Options (no human needed for any of these):\n` +
    `  • Set env var:   export ${envVarName}=your-token\n` +
    `  • Pre-seed:      echo '{"wallet":"0.1","providers":{"${host}":{"method":"api_key","token":"your-token"}}}' > ~/.agentdom/wallet.json\n` +
    `  • AWS SSM:       aws ssm put-parameter --name /agentdom/${host}/token --value your-token --type SecureString\n` +
    `  • Vault:         vault kv put secret/agentdom/${host} token=your-token\n` +
    `  • 1Password:     Store in vault "AgentDOM" → item "${host}" → field "token"\n\n` +
    `One-time interactive setup (developer only):\n` +
    `  agentdom setup ${host}`
  );
}

/**
 * Save a credential (called by setup/deploy scripts, not by agents).
 */
function save(host, credential) {
  saveToWallet(host, { ...credential, host });
}

/**
 * List all available credentials without exposing tokens.
 */
async function list() {
  const sources = [];

  // Env vars
  const envVars = Object.keys(process.env)
    .filter(k => k.startsWith('AGENTDOM_') && (k.endsWith('_KEY') || k.endsWith('_TOKEN')))
    .map(k => ({
      host: k.replace(/^AGENTDOM_/, '').replace(/_KEY$|_TOKEN$/, '').toLowerCase().replace(/_/g, '.'),
      source: 'env',
      key: k,
    }));
  sources.push(...envVars);

  // Wallet
  try {
    if (fs.existsSync(WALLET_FILE)) {
      const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'));
      const providers = Object.keys(w.providers || {});
      providers.forEach(host => sources.push({ host, source: 'wallet', method: w.providers[host].method }));
    }
  } catch {}

  return sources;
}

module.exports = { resolve, resolveOrThrow, save, list, fromEnv, fromWallet, envKey };
