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

// Persist a provider entry. Always routes through Keychain (encrypted-file
// fallback handled internally by lib/keychain.js). Never writes plaintext
// to wallet.json — Phase 2 hardening.
async function setProvider(host, entry) {
  const record = { ...entry, obtained_at: new Date().toISOString() };
  await keychain.setToken(host, record);
}

// Legacy file reader — kept ONLY for migration / backup tooling.
// Active code paths must call keychain.getToken(host) instead.
// Returns null when the wallet file is in encrypted-blob form (the keychain
// file-fallback shape: {v,iv,tag,data}), since those bytes can only be
// decoded via keychain.getToken().
function getProviderLegacy(host) {
  const w = readWallet();
  if (!w || !w.providers || typeof w.providers !== 'object') return null;
  return w.providers[host] || null;
}

async function deleteProvider(host) {
  let removed = false;
  try {
    const r = await keychain.deleteToken(host);
    if (r?.ok) removed = true;
  } catch (_) {}
  // Also scrub any residual entry in the legacy plaintext file (post-migration
  // this should always be empty, but be defensive).
  try {
    const w = readWallet();
    if (w.providers && w.providers[host]) {
      delete w.providers[host];
      writeWallet(w);
      removed = true;
    }
  } catch (_) {}
  return removed;
}

// ── Discovery ───────────────────────────────────────────────────────────────

// In-process TTL cache — 5 min. Prevents repeated network fetches during
// a single agentdom run session. Refreshes automatically on next process start.
const _discoverCache = new Map(); // host → { result, ts }
const DISCOVER_TTL_MS = 5 * 60 * 1000;

/** Fetch the well-known manifest for a provider host (e.g. "hubspot.com").
 *  Falls back to bundled polyfill manifests when the remote endpoint is absent.
 *  Results are cached in-process for 5 minutes. */
async function discover(provider, opts = {}) {
  const host = normalizeHost(provider);
  const url  = `https://${host}${WELL_KNOWN_PATH}`;

  // Return from cache if fresh
  if (!opts.noCache) {
    const cached = _discoverCache.get(host);
    if (cached && (Date.now() - cached.ts) < DISCOVER_TTL_MS) {
      return cached.result;
    }
  }

  // 1. Try live .well-known/agentdom.json (quick, 1 retry)
  try {
    const res = await fetchRetry(url, {}, { timeoutMs: opts.timeoutMs || 4000, retries: 1 });
    if (res.ok) {
      const manifest = await res.json();
      if (manifest.version || manifest.capabilities) {
        const result = { manifest, source_url: url };
        _discoverCache.set(host, { result, ts: Date.now() });
        return result;
      }
    }
  } catch (_) { /* unreachable or non-JSON — fall through */ }

  // 2. Fall back to bundled polyfill (CJS __dirname, always available)
  const localPath = path.join(__dirname, '..', 'manifests', `${host}.json`);
  if (fs.existsSync(localPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      console.log(`  ${host} — using bundled polyfill manifest`);
      const result = { manifest, source_url: `polyfill:${host}` };
      _discoverCache.set(host, { result, ts: Date.now() });
      return result;
    } catch (e) {
      return { error: `Bundled polyfill for ${host} is malformed: ${e.message}` };
    }
  }

  return {
    error: `${url} not reachable and no bundled polyfill found for ${host}`,
    hint:  `Run: npx agentdom-publisher init --openapi=./openapi.json --host=${host}`,
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

async function oauthFlow({ host, manifest, clientId, clientSecret, intents, timeoutMs = 300000, config }) {
  // config can come from auto-detection (setup.js detectAuthMethod) or manifest
  const auth = config || manifest?.auth || {};
  const oauthMethods = ['oauth2', 'oauth2_pkce', 'oauth2_cc', 'oauth2_device', 'device_flow'];
  if (!oauthMethods.includes(auth.method)) {
    throw new Error(`Provider ${host} does not advertise OAuth auth (got: ${auth.method}).`);
  }
  // Resolve auth URLs — prefer config over manifest fields
  const _authUrl  = auth.auth_url   || auth.authorize_url || manifest?.auth?.authorize_url;
  const _tokenUrl = auth.token_url  || manifest?.auth?.token_url;
  if (!_authUrl)  throw new Error(`No auth_url for ${host}. Provide it via manifest or auto-detected config.`);
  if (!_tokenUrl) throw new Error(`No token_url for ${host}. Provide it via manifest or auto-detected config.`);

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
  info(`Opening browser to ${_authUrl}…`);
  info(`Local callback: ${redirectUri}`);
  openInBrowser(`${_authUrl}?${params}`);

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

  const tokRes = await fetch(_tokenUrl, {
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
    token_url: _tokenUrl,
  };
  await setProvider(host, entry);
  return entry;
}

async function refreshOauthToken(host) {
  const entry = await keychain.getToken(host) || getProviderLegacy(host);
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
  await setProvider(host, updated);
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
  await setProvider(host, entry);
  return entry;
}

// ── Public auth() entry point ───────────────────────────────────────────────

/** Authenticate to a provider. Reads its well-known manifest, runs the
 *  appropriate flow, persists the token. */
async function auth({ provider, intents = [], clientId, clientSecret, key, force = false, config } = {}) {
  if (!provider) throw new Error('auth requires { provider }');
  const host = normalizeHost(provider);

  // 1. Check Keychain first (faster than file)
  if (!force) {
    const kToken = await keychain.getToken(host);
    if (kToken && !keychain.isExpired(kToken)) {
      return { reused: true, ...sanitize(kToken), provider: host, storage: 'keychain' };
    }
    // Check file-based wallet as fallback (legacy plaintext entries only —
    // post-migration this should always be empty)
    const existing = getProviderLegacy(host);
    if (existing) {
      if (existing.method === 'oauth2' && existing.expires_at && new Date(existing.expires_at) > new Date()) {
        return { reused: true, ...sanitize(existing), provider: host, storage: 'wallet-file' };
      }
      if (existing.method !== 'oauth2') return { reused: true, ...sanitize(existing), provider: host, storage: 'wallet-file' };
    }
  }

  // 2. Try PKCE engine (handles PKCE, device flow, API key interactively)
  // config from setup.js auto-detection takes priority over static registry
  const pkceConfig = config || OAUTH_REGISTRY[host];
  if (pkceConfig && (pkceConfig.auth_url || pkceConfig.device_url || pkceConfig.client_id || pkceConfig.api_key_alt)) {
    try {
      const token = await pkceAuth(host, { forceReauth: force, config: pkceConfig });
      // pkceAuth already stores via keychain.setToken; no second write needed.
      return { provider: host, ...sanitize(token), storage: keychain.storageBackend() };
    } catch (e) {
      console.error(`[AgentDOM] pkceAuth failed for ${host}: ${e.message} — falling back to manifest flow`);
    }
  }

  // 3. Fallback: discover manifest and use legacy flow
  const d = await discover(host);
  if (d.error) throw new Error(`discover ${host}: ${d.error}`);
  const m = d.manifest;
  const method = (m.auth && m.auth.method) || 'none';

  if (method === 'none') {
    await setProvider(host, { method: 'none' });
    return { provider: host, method, no_auth_required: true };
  }
  if (method === 'oauth2' || method === 'oauth2_pkce' || method === 'oauth2_cc') {
    clientId = clientId || m.auth.client_id || config?.client_id || process.env[`AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_ID`];
    clientSecret = clientSecret || process.env[`AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_SECRET`];
    const entry = await oauthFlow({ host, manifest: m, clientId, clientSecret, intents, config: config || m.auth });
    return { provider: host, ...sanitize(entry) };
  }
  if (method === 'api_key') {
    const entry = await apiKeyFlow({ host, manifest: m, key });
    return { provider: host, ...sanitize(entry) };
  }
  if (method === 'device_flow' || method === 'oauth2_device') {
    const entry = await oauthFlow({ host, manifest: m, clientId, clientSecret, intents, forceDevice: true, config: config || m.auth });
    return { provider: host, ...sanitize(entry) };
  }
  if (method === 'session_cookie') {
    info(`Provider ${host} uses session_cookie auth — log in via your browser. AgentDOM will read cookies from the active CDP session at dispatch time.`);
    await setProvider(host, { method: 'session_cookie', domain: m.auth.domain || host });
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

  // 2. Legacy plaintext wallet fallback (pre-migration only — bootstrap
  // empties this file on first run)
  let entry = getProviderLegacy(host);
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
    const fEntry = getProviderLegacy(host);
    const entry  = kToken || fEntry;
    if (entry) results.push({ provider: host, ...sanitize(entry), expired: kToken ? keychain.isExpired(kToken) : false });
  }
  return results;
}

async function revoke(provider) {
  const host = normalizeHost(provider);
  const removed = await deleteProvider(host);
  // Also stop tracking for auto-refresh so we don't keep hitting a dead token.
  try { require('../lib/token-lifecycle').untrack(host); } catch (_) {}
  return { revoked: removed, provider: host };
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
    const list = await tokens();
    if (!list.length) { dim('No providers in wallet.'); return; }
    process.stdout.write(`\n  ${C.cyan}Wallet${C.r}  (backend: ${keychain.storageBackend()})\n`);
    for (const e of list) {
      process.stdout.write(`  ${C.green}●${C.r} ${e.provider.padEnd(24)} ${(e.method || 'unknown').padEnd(15)} ${e.scopes ? '(' + e.scopes.length + ' scopes)' : ''}\n`);
    }
    process.stdout.write('\n');
    return;
  }
  if (verb === 'revoke') {
    const r = await revoke(rest[1]);
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
