/**
 * AgentDOM auth wallet — single token store for every provider.
 *
 * Implements the auth half of the .well-known/agentdom protocol (see
 * WELL-KNOWN-SPEC.md). One MCP-callable surface manages OAuth2,
 * api_key, and session_cookie auth across every SaaS vendor.
 *
 * Storage: ~/.agentdom/wallet.json (0600). Keychain upgrade is v0.2.
 *
 * Public API:
 *   discover(provider)   → fetch .well-known/agentdom.json, return manifest
 *   auth({provider, ...})→ start OAuth flow OR prompt for API key
 *   tokens()             → list providers + scopes (no secrets returned)
 *   token(provider)      → fetch valid token (refreshing if needed)
 *   revoke(provider)     → remove from wallet
 *
 * CLI:
 *   agentdom auth <provider>           — interactive
 *   agentdom auth list                 — show known providers
 *   agentdom auth revoke <provider>    — remove
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { atomicWrite, fetchRetry } = require('../lib/resilience');
const keychain = require('../lib/keychain');
const { pkceAuth, OAUTH_REGISTRY } = require('../lib/oauth-pkce');

const WALLET_DIR = path.join(os.homedir(), '.agentdom');
const WALLET_FILE = path.join(WALLET_DIR, 'wallet.json');
const WELL_KNOWN_PATH = '/.well-known/agentdom.json';

const C = { green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m', r: '\x1b[0m' };
const ok = m => process.stdout.write(`  ${C.green}✓${C.r} ${m}\n`);
const fail = m => process.stderr.write(`  ${C.red}✗${C.r} ${m}\n`);
const info = m => process.stdout.write(`  ${C.cyan}→${C.r} ${m}\n`);
const dim = m => process.stdout.write(`  ${C.gray}${m}${C.r}\n`);

// ── Wallet I/O ──────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
}

function readWallet() {
  try {
    if (!fs.existsSync(WALLET_FILE)) return { wallet: '0.1', providers: {} };
    return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'));
  } catch { return { wallet: '0.1', providers: {} }; }
}

function writeWallet(w) {
  ensureDir();
  atomicWrite(WALLET_FILE, w, { mode: 0o600 });
}

function setProvider(host, entry) {
  const w = readWallet();
  w.providers[host] = { ...entry, obtained_at: new Date().toISOString() };
  writeWallet(w);
}

function getProvider(host) {
  return readWallet().providers[host] || null;
}

function deleteProvider(host) {
  const w = readWallet();
  if (!w.providers[host]) return false;
  delete w.providers[host];
  writeWallet(w);
  return true;
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** Fetch the well-known manifest for a provider host (e.g. "hubspot.com").
 *  Falls back to bundled polyfill manifests when the remote endpoint is absent. */
async function discover(provider, opts = {}) {
  const host = normalizeHost(provider);
  const url = `https://${host}${WELL_KNOWN_PATH}`;

  // 1. Try live .well-known/agentdom.json
  try {
    const res = await fetchRetry(url, {}, { timeoutMs: opts.timeoutMs || 5000, retries: 1 });
    if (res.ok) {
      const manifest = await res.json();
      if (manifest.version || manifest.capabilities) return { manifest, source_url: url };
    }
  } catch (_) {}

  // 2. Fall back to bundled polyfill manifest
  try {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url || `file://${process.cwd()}/`);
    const localPath = req.resolve(`./manifests/${host}.json`);
    const manifest = JSON.parse(require('fs').readFileSync(localPath, 'utf-8'));
    return { manifest, source_url: `polyfill:${host}` };
  } catch (_) {}

  // Also try with path module (CJS context)
  try {
    const fs = require('fs');
    const path = require('path');
    const localPath = path.join(__dirname, '..', 'manifests', `${host}.json`);
    if (fs.existsSync(localPath)) {
      const manifest = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      return { manifest, source_url: `polyfill:${host}` };
    }
  } catch (_) {}

  return {
    error: `${url} not reachable and no bundled polyfill found for ${host}`,
    hint: `Run: npx agentdom-publisher init --openapi=./openapi.json --host=${host}`,
  };
}


function normalizeHost(s) {
  return String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*/, '');
}

// ── OAuth 2.0 — browser-mediated authorization code flow ────────────────────

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function openInBrowser(url) {
  if (process.platform === 'darwin') execFileSync('open', [url]);
  else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url]);
  else execFileSync('xdg-open', [url]);
}

function joinScopes(intents, scopesFor) {
  const s = new Set();
  for (const i of intents) for (const sc of (scopesFor[i] || [])) s.add(sc);
  return [...s];
}

async function oauthFlow({ host, manifest, clientId, clientSecret, intents, timeoutMs = 300000 }) {
  const auth = manifest.auth || {};
  if (auth.method !== 'oauth2') throw new Error(`Provider ${host} does not advertise oauth2 auth.`);
  if (auth.client_id_required && !clientId) {
    throw new Error(`Provider ${host} requires a client_id. Pass it via --client-id or env AGENTDOM_<HOST>_CLIENT_ID.`);
  }
  const scopes = intents && intents.length ? joinScopes(intents, auth.scopes_for || {}) : [];

  const port = await pickFreePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const csrf = crypto.randomBytes(16).toString('hex');

  const codePromise = new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') {
        res.writeHead(404); res.end('not found'); return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        res.end(`<h2>Auth failed</h2><pre>${error}</pre><p>You can close this tab.</p>`);
        srv.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.end('<h2>Missing code</h2>');
        srv.close();
        reject(new Error('OAuth callback missing code parameter.'));
        return;
      }
      if (state !== csrf) {
        res.end('<h2>CSRF mismatch</h2>');
        srv.close();
        reject(new Error('CSRF state mismatch — possible attack.'));
        return;
      }
      res.end('<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>');
      srv.close();
      resolve(code);
    });
    srv.listen(port, '127.0.0.1');
    setTimeout(() => { try { srv.close(); } catch (_) {} reject(new Error('OAuth flow timed out.')); }, timeoutMs);
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: csrf,
  });
  if (scopes.length) params.set('scope', scopes.join(' '));
  const authUrl = `${auth.authorize_url}?${params}`;
  info(`Opening browser to ${auth.authorize_url}…`);
  info(`Local callback: ${redirectUri}`);
  openInBrowser(authUrl);

  const code = await codePromise;
  ok('Authorization code received.');

  // Exchange code for token
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (clientSecret) tokenBody.set('client_secret', clientSecret);

  const tokRes = await fetch(auth.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: tokenBody,
  });
  if (!tokRes.ok) {
    const body = await tokRes.text();
    throw new Error(`Token exchange failed: ${tokRes.status} ${body.slice(0, 300)}`);
  }
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(`Token endpoint returned no access_token: ${JSON.stringify(tok).slice(0, 200)}`);

  const entry = {
    method: 'oauth2',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
    scopes,
    client_id: clientId,
    token_url: auth.token_url,
  };
  setProvider(host, entry);
  return entry;
}

async function refreshOauthToken(host) {
  const entry = getProvider(host);
  if (!entry || entry.method !== 'oauth2' || !entry.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refresh_token,
    client_id: entry.client_id,
  });
  const res = await fetchRetry(entry.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  }, { retries: 2, timeoutMs: 8000 });
  if (!res.ok) return null;
  const tok = await res.json();
  if (!tok.access_token) return null;
  const updated = {
    ...entry,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || entry.refresh_token,
    expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : entry.expires_at,
    obtained_at: new Date().toISOString(),
  };
  setProvider(host, updated);
  return updated;
}

// ── API key flow — open obtain_url, prompt to paste ─────────────────────────

async function apiKeyFlow({ host, manifest, key }) {
  const auth = manifest.auth || {};
  if (auth.method !== 'api_key') throw new Error(`Provider ${host} does not advertise api_key auth.`);
  if (!key) {
    if (auth.obtain_url) {
      info(`Open ${auth.obtain_url} in your browser, copy your API key, then re-run with --key=<value>.`);
      try { openInBrowser(auth.obtain_url); } catch (_) {}
    }
    throw new Error('API key not provided. Pass via --key or env.');
  }
  const entry = {
    method: 'api_key',
    key,
    header: auth.header || 'Authorization',
    format: auth.format || 'Bearer {token}',
  };
  setProvider(host, entry);
  return entry;
}

// ── Public auth() entry point ───────────────────────────────────────────────

/** Authenticate to a provider. Reads its well-known manifest, runs the
 *  appropriate flow, persists the token. */
async function auth({ provider, intents = [], clientId, clientSecret, key, force = false } = {}) {
  if (!provider) throw new Error('auth requires { provider }');
  const host = normalizeHost(provider);

  // 1. Check Keychain first (faster than file)
  if (!force) {
    const kToken = await keychain.getToken(host);
    if (kToken && !keychain.isExpired(kToken)) {
      return { reused: true, ...sanitize(kToken), provider: host, storage: 'keychain' };
    }
    // Check file-based wallet as fallback
    const existing = getProvider(host);
    if (existing) {
      if (existing.method === 'oauth2' && existing.expires_at && new Date(existing.expires_at) > new Date()) {
        return { reused: true, ...sanitize(existing), provider: host, storage: 'wallet-file' };
      }
      if (existing.method !== 'oauth2') return { reused: true, ...sanitize(existing), provider: host, storage: 'wallet-file' };
    }
  }

  // 2. Try PKCE engine first (handles PKCE, device flow, API key interactively)
  const pkceConfig = OAUTH_REGISTRY[host];
  if (pkceConfig) {
    try {
      const token = await pkceAuth(host, { forceReauth: force, config: pkceConfig });
      // Mirror to file wallet for backwards compat
      setProvider(host, token);
      return { provider: host, ...sanitize(token), storage: await keychain.storageBackend() };
    } catch (e) {
      console.error(`[AgentDOM] pkceAuth failed for ${host}: ${e.message} — trying manifest flow`);
    }
  }

  // 3. Fallback: discover manifest and use legacy flow
  const d = await discover(host);
  if (d.error) throw new Error(`discover ${host}: ${d.error}`);
  const m = d.manifest;
  const method = (m.auth && m.auth.method) || 'none';

  if (method === 'none') {
    setProvider(host, { method: 'none' });
    return { provider: host, method, no_auth_required: true };
  }
  if (method === 'oauth2') {
    clientId = clientId || m.auth.client_id || process.env[`AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_ID`];
    clientSecret = clientSecret || process.env[`AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_SECRET`];
    const entry = await oauthFlow({ host, manifest: m, clientId, clientSecret, intents });
    await keychain.setToken(host, entry);
    return { provider: host, ...sanitize(entry) };
  }
  if (method === 'api_key') {
    const entry = await apiKeyFlow({ host, manifest: m, key });
    await keychain.setToken(host, entry);
    return { provider: host, ...sanitize(entry) };
  }
  if (method === 'session_cookie') {
    info(`Provider ${host} uses session_cookie auth — log in via your browser. AgentDOM will read cookies from the active CDP session at dispatch time.`);
    setProvider(host, { method: 'session_cookie', domain: m.auth.domain || host });
    return { provider: host, method, requires_browser_session: true };
  }
  throw new Error(`Unknown auth method: ${method}`);
}

function sanitize(entry) {
  const { access_token, refresh_token, key, client_id, ...safe } = entry;
  return {
    ...safe,
    has_access_token: !!access_token,
    has_refresh_token: !!refresh_token,
    has_api_key: !!key,
  };
}

// ── Token retrieval (auto-refresh) ──────────────────────────────────────────

async function token(provider) {
  const host = normalizeHost(provider);

  // 1. Keychain (preferred — faster + more secure)
  const kToken = await keychain.getToken(host);
  if (kToken) {
    if (!keychain.isExpired(kToken)) {
      if (kToken.method === 'oauth2')  return { provider: host, method: 'oauth2',  access_token: kToken.access_token,  scopes: kToken.scope };
      if (kToken.method === 'api_key') return { provider: host, method: 'api_key', key: kToken.key, header: kToken.header, format: kToken.format };
      return { provider: host, method: kToken.method };
    }
    // Expired — try refresh via keychain token
    if (kToken.refresh_token) {
      try {
        const pkceConfig = OAUTH_REGISTRY[host];
        if (pkceConfig) {
          const { refreshToken, scheduleRefresh } = require('../lib/oauth-pkce');
          const refreshed = await refreshToken(host, kToken, pkceConfig);
          scheduleRefresh(host, refreshed, pkceConfig);
          return { provider: host, method: 'oauth2', access_token: refreshed.access_token, scopes: refreshed.scope };
        }
      } catch (e) {
        console.error(`[token] refresh failed for ${host}: ${e.message}`);
      }
    }
  }

  // 2. File wallet fallback
  let entry = getProvider(host);
  if (!entry) return { error: `No auth for ${host}. Call auth({ provider: "${host}" }) first.` };
  if (entry.method === 'oauth2') {
    if (entry.expires_at && new Date(entry.expires_at) <= new Date(Date.now() + 30000)) {
      const refreshed = await refreshOauthToken(host);
      if (refreshed) entry = refreshed;
    }
    return { provider: host, method: 'oauth2', access_token: entry.access_token, scopes: entry.scopes };
  }
  if (entry.method === 'api_key') {
    return { provider: host, method: 'api_key', key: entry.key, header: entry.header, format: entry.format };
  }
  return { provider: host, method: entry.method };
}

// ── Listing + revocation ────────────────────────────────────────────────────

async function tokens() {
  // Merge keychain + file providers
  const keychainProviders = await keychain.listProviders();
  const fileProviders     = Object.keys(readWallet().providers || {});
  const all = [...new Set([...keychainProviders, ...fileProviders])];
  const results = [];
  for (const host of all) {
    const kToken = await keychain.getToken(host);
    const fEntry = getProvider(host);
    const entry  = kToken || fEntry;
    if (entry) results.push({ provider: host, ...sanitize(entry), expired: kToken ? keychain.isExpired(kToken) : false });
  }
  return results;
}

function revoke(provider) {
  const removed = deleteProvider(normalizeHost(provider));
  return { revoked: removed, provider };
}

// ── CLI entry ───────────────────────────────────────────────────────────────

function help() {
  process.stdout.write(`
${C.cyan}agentdom auth${C.r} <provider> [--client-id ID] [--client-secret SECRET] [--key KEY] [--intent <id>...] [--force]
${C.cyan}agentdom auth${C.r} list
${C.cyan}agentdom auth${C.r} revoke <provider>

Examples:
  agentdom auth hubspot.com --intent contacts.create
  agentdom auth linear.app --key lin_api_xxxxxxxxxxxx
  agentdom auth list
  agentdom auth revoke hubspot.com

OAuth: client_id can be set via env AGENTDOM_<HOST>_CLIENT_ID (e.g.
       AGENTDOM_HUBSPOT_COM_CLIENT_ID). Same for _CLIENT_SECRET.
`);
}

function parseArgs(argv) {
  const out = { intents: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--client-id') out.clientId = argv[++i];
    else if (a === '--client-secret') out.clientSecret = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--intent') out.intents.push(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  return { opts: out, rest };
}

async function run(argv = []) {
  const { opts, rest } = parseArgs(argv);
  if (opts.help || rest.length === 0) { help(); process.exit(opts.help ? 0 : 1); }
  const verb = rest[0].toLowerCase();
  if (verb === 'list') {
    const list = tokens();
    if (!list.length) { dim('No providers in wallet.'); return; }
    process.stdout.write(`\n  ${C.cyan}Wallet${C.r}  (${WALLET_FILE})\n`);
    for (const e of list) {
      process.stdout.write(`  ${C.green}●${C.r} ${e.provider.padEnd(24)} ${e.method.padEnd(15)} ${e.scopes ? '(' + e.scopes.length + ' scopes)' : ''}\n`);
    }
    process.stdout.write('\n');
    return;
  }
  if (verb === 'revoke') {
    const r = revoke(rest[1]);
    if (r.revoked) ok(`Revoked ${r.provider}`); else fail(`${rest[1]} not in wallet.`);
    return;
  }
  // Default: auth a provider
  try {
    const result = await auth({ provider: rest[0], ...opts });
    ok(`Authenticated ${result.provider} (${result.method || 'oauth2'})`);
    if (result.scopes && result.scopes.length) dim(`Scopes: ${result.scopes.join(', ')}`);
  } catch (e) {
    fail(e.message);
    process.exit(2);
  }
}

module.exports = {
  run,
  auth,
  token,
  tokens,
  revoke,
  discover,
  readWallet,
  writeWallet,
  WALLET_FILE,
  WALLET_DIR,
};
