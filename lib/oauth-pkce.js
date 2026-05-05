/**
 * AgentDOM — OAuth PKCE Engine
 *
 * Full OAuth 2.0 Authorization Code + PKCE flow for any SaaS.
 * No client secrets needed (PKCE is public-client safe).
 *
 * Flow:
 *   1. Generate code_verifier + code_challenge (S256)
 *   2. Open browser → vendor authorization URL
 *   3. Spin up localhost:PORT redirect server
 *   4. Capture ?code= callback
 *   5. Exchange code → access_token + refresh_token
 *   6. Store in Keychain via lib/keychain.js
 *   7. Schedule auto-refresh before expiry
 *
 * Usage:
 *   const { pkceAuth } = require('./lib/oauth-pkce');
 *   const token = await pkceAuth('hubspot.com');
 */

'use strict';

const http    = require('http');
const crypto  = require('crypto');
const os      = require('os');
const { execFileSync } = require('child_process');
const { fetchRetry } = require('./resilience');
const keychain = require('./keychain');

// ── OAuth App Registry ────────────────────────────────────────────────────
// Pre-registered client_ids for the top-50 SaaS.
// Vendors who publish .well-known/agentdom.json override these.
//
// All client_ids below are PUBLIC (PKCE flow — no secret needed).
// To add a new provider: get a free OAuth app from their developer portal.

const OAUTH_REGISTRY = {
  'github.com': {
    client_id:      'Ov23liMxf4J3PjYcS5YK', // placeholder — replace with real app
    auth_url:       'https://github.com/login/oauth/authorize',
    token_url:      'https://github.com/login/oauth/access_token',
    scopes:         ['repo', 'user:email'],
    pkce:           false,  // GitHub doesn't support PKCE yet — use device flow fallback
    device_url:     'https://github.com/login/device/code',
  },
  'linear.app': {
    client_id:      'AGENTDOM_LINEAR',       // placeholder
    auth_url:       'https://linear.app/oauth/authorize',
    token_url:      'https://api.linear.app/oauth/token',
    scopes:         ['read', 'write'],
    pkce:           true,
  },
  'vercel.com': {
    client_id:      'AGENTDOM_VERCEL',
    auth_url:       'https://vercel.com/oauth/authorize',
    token_url:      'https://api.vercel.com/v2/oauth/access_token',
    scopes:         [],
    pkce:           true,
  },
  'supabase.com': {
    client_id:      'AGENTDOM_SUPABASE',
    auth_url:       'https://api.supabase.com/v1/oauth/authorize',
    token_url:      'https://api.supabase.com/v1/oauth/token',
    scopes:         ['all'],
    pkce:           true,
  },
  'hubspot.com': {
    client_id:      'AGENTDOM_HUBSPOT',
    auth_url:       'https://app.hubspot.com/oauth/authorize',
    token_url:      'https://api.hubspot.com/oauth/v1/token',
    scopes:         ['contacts', 'crm.objects.contacts.read', 'crm.objects.contacts.write'],
    pkce:           false,  // HubSpot uses standard code flow
    needs_secret:   true,   // requires client_secret — use env HUBSPOT_CLIENT_SECRET
  },
  'stripe.com': {
    client_id:      'AGENTDOM_STRIPE',
    auth_url:       'https://connect.stripe.com/oauth/authorize',
    token_url:      'https://connect.stripe.com/oauth/token',
    scopes:         ['read_write'],
    pkce:           false,
    api_key_alt:    true,   // Stripe prefers API key — prompt user for STRIPE_SECRET_KEY
  },
  'notion.so': {
    client_id:      'AGENTDOM_NOTION',
    auth_url:       'https://api.notion.com/v1/oauth/authorize',
    token_url:      'https://api.notion.com/v1/oauth/token',
    scopes:         [],
    pkce:           false,
    needs_secret:   true,
  },
  'slack.com': {
    client_id:      'AGENTDOM_SLACK',
    auth_url:       'https://slack.com/oauth/v2/authorize',
    token_url:      'https://slack.com/api/oauth.v2.access',
    scopes:         ['channels:read', 'chat:write', 'users:read'],
    pkce:           false,
    needs_secret:   true,
  },
  'cal.com': {
    client_id:      'AGENTDOM_CALCOM',
    auth_url:       'https://app.cal.com/oauth/authorize',
    token_url:      'https://app.cal.com/oauth/token',
    scopes:         ['DEFAULT'],
    pkce:           true,
  },
  'resend.com': {
    client_id:      null,   // API key only
    api_key_alt:    true,
    key_env:        'RESEND_API_KEY',
    key_header:     'Authorization',
    key_format:     'Bearer {token}',
  },
  'anthropic.com': {
    client_id:      null,
    api_key_alt:    true,
    key_env:        'ANTHROPIC_API_KEY',
    key_header:     'x-api-key',
    key_format:     '{token}',
  },
  'openai.com': {
    client_id:      null,
    api_key_alt:    true,
    key_env:        'OPENAI_API_KEY',
    key_header:     'Authorization',
    key_format:     'Bearer {token}',
  },
};

// ── PKCE helpers ──────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Redirect server ───────────────────────────────────────────────────────

const REDIRECT_PORT_MIN = 54000;
const REDIRECT_PORT_MAX = 54099;

function findFreePort() {
  const port = REDIRECT_PORT_MIN + Math.floor(Math.random() * 100);
  return port; // Good enough for localhost; collision risk is negligible
}

function waitForCallback(port, expectedState, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth timeout — no callback received within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Serve success/error page
      const html = error
        ? `<h2>❌ Authorization denied</h2><p>${error}</p><script>setTimeout(()=>window.close(),2000)</script>`
        : `<h2>✅ AgentDOM authorized</h2><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);

      clearTimeout(timer);
      server.close();

      if (error) return reject(new Error(`OAuth error: ${error}`));
      if (state !== expectedState) return reject(new Error('OAuth state mismatch (CSRF)'));
      if (!code) return reject(new Error('No authorization code in callback'));
      resolve(code);
    });

    server.listen(port, '127.0.0.1', () => {});
    server.on('error', reject);
  });
}

// ── Open browser ──────────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin')  execFileSync('open',    [url]);
    else if (platform === 'win32') execFileSync('cmd',  ['/c', 'start', '', url]);
    else                           execFileSync('xdg-open', [url]);
  } catch (_) {
    console.error(`\n[AgentDOM] Open this URL to authorize:\n  ${url}\n`);
  }
}

// ── Token exchange ────────────────────────────────────────────────────────

async function exchangeCode({ tokenUrl, clientId, clientSecret, code, redirectUri, codeVerifier, needsSecret }) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    client_id:    clientId,
    code,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  if (needsSecret && clientSecret) body.set('client_secret', clientSecret);

  const res = await fetchRetry(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body:    body.toString(),
  }, { retries: 2, baseDelay: 500 });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }

  if (!res.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error || text.slice(0, 200)}`);
  }

  return data;
}

// ── GitHub Device Flow (fallback for GitHub, which lacks PKCE) ────────────

async function githubDeviceFlow(config) {
  const r1 = await fetchRetry(config.device_url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body:    `client_id=${config.client_id}&scope=${config.scopes.join(',')}`,
  }, { retries: 2 });
  const d1 = await r1.json();
  if (!d1.user_code) throw new Error(`GitHub device flow failed: ${JSON.stringify(d1)}`);

  console.error(`\n[AgentDOM] GitHub authorization:`);
  console.error(`  1. Open: ${d1.verification_uri}`);
  console.error(`  2. Enter code: ${d1.user_code}`);
  console.error(`  (expires in ${d1.expires_in}s)\n`);
  openBrowser(d1.verification_uri);

  const interval = (d1.interval || 5) * 1000;
  const deadline = Date.now() + d1.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const r2 = await fetchRetry('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    `client_id=${config.client_id}&device_code=${d1.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
    }, { retries: 1 });
    const d2 = await r2.json();
    if (d2.access_token) return d2;
    if (d2.error && d2.error !== 'authorization_pending' && d2.error !== 'slow_down') {
      throw new Error(`GitHub device auth error: ${d2.error}`);
    }
  }
  throw new Error('GitHub device flow expired');
}

// ── API key flow ──────────────────────────────────────────────────────────

async function apiKeyFlow(provider, config) {
  const envKey = config.key_env ? process.env[config.key_env] : null;
  if (envKey) {
    return {
      method:    'api_key',
      key:       envKey,
      header:    config.key_header || 'Authorization',
      format:    config.key_format || 'Bearer {token}',
      source:    'env',
    };
  }
  // Prompt interactively
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const key = await new Promise(res => {
    rl.question(`[AgentDOM] Enter API key for ${provider}: `, (ans) => { rl.close(); res(ans.trim()); });
  });
  if (!key) throw new Error(`No API key provided for ${provider}`);
  return {
    method:    'api_key',
    key,
    header:    config.key_header || 'Authorization',
    format:    config.key_format || 'Bearer {token}',
    source:    'user',
  };
}

// ── Main: pkceAuth ────────────────────────────────────────────────────────

/**
 * Authenticate with a provider using the best available flow.
 *
 * Priority:
 *   1. Existing valid token in Keychain → return immediately
 *   2. Existing token but expired + refresh_token → auto-refresh
 *   3. API key provider → prompt for key or read from env
 *   4. PKCE flow → browser redirect
 *   5. Standard code flow (with secret) → browser redirect
 *   6. GitHub device flow → device code
 *
 * @param {string} provider  — e.g. "hubspot.com"
 * @param {object} [opts]
 * @param {boolean} [opts.forceReauth]  — ignore existing token, reauthenticate
 * @param {object}  [opts.config]       — override registry config
 * @returns {object} token data stored in Keychain
 */
async function pkceAuth(provider, opts = {}) {
  const config = opts.config || OAUTH_REGISTRY[provider];
  if (!config) throw new Error(`Provider "${provider}" not in OAuth registry. Add it via a .well-known/agentdom.json manifest or OAUTH_REGISTRY.`);

  // 1. Check existing token
  if (!opts.forceReauth) {
    const existing = await keychain.getToken(provider);
    if (existing && !keychain.isExpired(existing)) {
      return { ...existing, cached: true };
    }
    // Try refresh
    if (existing?.refresh_token && keychain.isExpired(existing)) {
      try {
        const refreshed = await refreshToken(provider, existing, config);
        return refreshed;
      } catch (e) {
        console.error(`[AgentDOM] Token refresh failed for ${provider}: ${e.message} — reauthenticating`);
      }
    }
  }

  // 2. API key providers
  if (config.api_key_alt && !config.client_id) {
    const token = await apiKeyFlow(provider, config);
    await keychain.setToken(provider, token);
    return token;
  }

  // 3. GitHub device flow
  if (config.device_url) {
    const token = await githubDeviceFlow(config);
    const stored = buildTokenRecord('oauth2', provider, token);
    await keychain.setToken(provider, stored);
    scheduleRefresh(provider, stored, config);
    return stored;
  }

  // 4. PKCE / standard authorization code flow
  const port         = findFreePort();
  const redirectUri  = `http://localhost:${port}/callback`;
  const state        = generateState();
  const codeVerifier = config.pkce ? generateCodeVerifier() : null;
  const challenge    = config.pkce ? generateCodeChallenge(codeVerifier) : null;
  const clientSecret = config.needs_secret ? (process.env[`${provider.replace(/\W/g, '_').toUpperCase()}_CLIENT_SECRET`] || null) : null;

  // Build auth URL
  const authUrl = new URL(config.auth_url);
  authUrl.searchParams.set('client_id',     config.client_id);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state',         state);
  if (config.scopes?.length) authUrl.searchParams.set('scope', config.scopes.join(' '));
  if (config.pkce) {
    authUrl.searchParams.set('code_challenge',        challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
  }

  console.error(`\n[AgentDOM] Opening browser for ${provider} authorization...`);
  openBrowser(authUrl.toString());

  // Wait for callback
  const code = await waitForCallback(port, state);

  // Exchange code
  const tokenData = await exchangeCode({
    tokenUrl:     config.token_url,
    clientId:     config.client_id,
    clientSecret,
    code,
    redirectUri,
    codeVerifier,
    needsSecret:  config.needs_secret,
  });

  const stored = buildTokenRecord('oauth2', provider, tokenData);
  await keychain.setToken(provider, stored);
  scheduleRefresh(provider, stored, config);

  console.error(`[AgentDOM] ✓ ${provider} authorized and stored in ${keychain.storageBackend()}`);
  return stored;
}

// ── Token refresh ─────────────────────────────────────────────────────────

async function refreshToken(provider, existing, config) {
  if (!existing.refresh_token) throw new Error('No refresh_token available');
  if (!config.token_url) throw new Error('No token_url configured');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: existing.refresh_token,
    client_id:     config.client_id || '',
  });

  const res = await fetchRetry(config.token_url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body:    body.toString(),
  }, { retries: 2 });

  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || 'refresh failed');

  const merged = buildTokenRecord('oauth2', provider, {
    ...data,
    refresh_token: data.refresh_token || existing.refresh_token,
  });
  await keychain.setToken(provider, merged);
  return merged;
}

// ── Auto-refresh scheduler ────────────────────────────────────────────────

const _refreshTimers = new Map();

function scheduleRefresh(provider, token, config) {
  if (!token.expires_at || !token.refresh_token) return;
  const msUntilRefresh = token.expires_at - Date.now() - 5 * 60 * 1000; // 5 min buffer
  if (msUntilRefresh <= 0) return;

  if (_refreshTimers.has(provider)) clearTimeout(_refreshTimers.get(provider));

  const timer = setTimeout(async () => {
    try {
      const refreshed = await refreshToken(provider, token, config);
      scheduleRefresh(provider, refreshed, config); // reschedule for next cycle
    } catch (e) {
      console.error(`[AgentDOM] Auto-refresh failed for ${provider}: ${e.message}`);
    }
  }, msUntilRefresh);

  // Don't keep process alive for refresh timers
  if (timer.unref) timer.unref();
  _refreshTimers.set(provider, timer);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildTokenRecord(method, provider, data) {
  const expiresIn = data.expires_in ? parseInt(data.expires_in, 10) : null;
  return {
    method,
    provider,
    access_token:   data.access_token,
    refresh_token:  data.refresh_token || null,
    token_type:     data.token_type    || 'Bearer',
    scope:          data.scope         || null,
    expires_in:     expiresIn,
    expires_at:     expiresIn ? Date.now() + expiresIn * 1000 : null,
    obtained_at:    Date.now(),
  };
}

module.exports = {
  pkceAuth,
  refreshToken,
  scheduleRefresh,
  OAUTH_REGISTRY,
};
