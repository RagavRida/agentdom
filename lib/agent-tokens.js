/**
 * AgentDOM Agent Token Protocol
 *
 * Allows publishers to declare a machine-to-machine auth endpoint
 * so AI agents can provision their own scoped tokens programmatically.
 *
 * No human browser redirect. No manual paste. The agent calls the
 * publisher's /agent-tokens endpoint using a master credential and
 * receives a short-lived, scoped token for itself.
 *
 * Protocol spec (in .well-known/agentdom.json):
 *
 * {
 *   "auth": {
 *     "method": "api_key",
 *     "agent_tokens": {
 *       "issue":  "POST https://api.example.com/agent-tokens",
 *       "revoke": "DELETE https://api.example.com/agent-tokens/{id}",
 *       "rotate": "POST https://api.example.com/agent-tokens/{id}/rotate",
 *       "list":   "GET https://api.example.com/agent-tokens",
 *       "max_ttl_seconds": 86400,
 *       "scopes": ["read", "write", "emails:send"]
 *     }
 *   }
 * }
 *
 * Client API (used by AgentDOM agents):
 *   issueAgentToken(host, { scopes, ttl, agentId })  → { token, id, expires_at }
 *   rotateAgentToken(host, tokenId)                   → { token, expires_at }
 *   revokeAgentToken(host, tokenId)                   → { revoked: true }
 *   listAgentTokens(host)                             → [{ id, scopes, expires_at }]
 *   ensureAgentToken(host, opts)                      → token (auto-issues or rotates)
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const WALLET_FILE  = path.join(os.homedir(), '.agentdom', 'wallet.json');
const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');

// ── Wallet helpers ─────────────────────────────────────────────────────────────
function readWallet() {
  try {
    if (process.env.AGENTDOM_WALLET_B64)
      return JSON.parse(Buffer.from(process.env.AGENTDOM_WALLET_B64,'base64').toString());
    if (process.env.AGENTDOM_WALLET_PATH)
      return JSON.parse(fs.readFileSync(process.env.AGENTDOM_WALLET_PATH,'utf-8'));
    if (!fs.existsSync(WALLET_FILE)) return { wallet:'0.1', providers:{} };
    return JSON.parse(fs.readFileSync(WALLET_FILE,'utf-8'));
  } catch { return { wallet:'0.1', providers:{} }; }
}

function writeWallet(w) {
  if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive:true });
  fs.writeFileSync(WALLET_FILE, JSON.stringify(w,null,2), { mode:0o600 });
}

function getMasterCredential(host, w) {
  const entry = (w.providers || {})[host];
  if (!entry) return null;
  return entry.token || entry.key || null;
}

function storeAgentToken(host, tokenEntry, w) {
  if (!w.providers) w.providers = {};
  if (!w.providers[host]) w.providers[host] = {};
  w.providers[host].agent_token = {
    ...tokenEntry,
    stored_at: new Date().toISOString(),
  };
  writeWallet(w);
}

// ── Discover agent_tokens spec from manifest ──────────────────────────────────
async function getAgentTokenSpec(host) {
  // Try .well-known first
  try {
    const res = await fetch(`https://${host}/.well-known/agentdom.json`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const m = await res.json();
      if (m?.auth?.agent_tokens) return m.auth.agent_tokens;
    }
  } catch {}

  // Fall back to bundled polyfill
  try {
    const localPath = path.join(__dirname, '..', 'manifests', `${host}.json`);
    if (fs.existsSync(localPath)) {
      const m = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      if (m?.auth?.agent_tokens) return m.auth.agent_tokens;
    }
  } catch {}

  return null;
}

function resolveUrl(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => params[k] || '');
}

function extractMethod(urlSpec) {
  const parts = urlSpec.trim().split(/\s+/);
  if (parts.length === 2 && ['GET','POST','PUT','PATCH','DELETE'].includes(parts[0])) {
    return { method: parts[0], url: parts[1] };
  }
  return { method: 'POST', url: parts[0] };
}

// ── Issue a new agent token ───────────────────────────────────────────────────
/**
 * Issue a new scoped agent token via the publisher's agent_tokens endpoint.
 * Uses the stored master credential (API key or OAuth access token).
 */
async function issueAgentToken(host, { scopes = [], ttl = 3600, agentId = 'agentdom' } = {}) {
  const spec = await getAgentTokenSpec(host);
  if (!spec) throw new Error(
    `${host} does not support the agent_tokens protocol.\n` +
    `Ask them to add auth.agent_tokens to their .well-known/agentdom.json`
  );

  const w = readWallet();
  const masterToken = getMasterCredential(host, w);
  if (!masterToken) throw new Error(
    `No master credential for ${host}. Run: agentdom setup ${host}`
  );

  const { method, url } = extractMethod(spec.issue);
  const authHeader = (w.providers[host]?.key_header || 'Authorization');
  const authFormat = (w.providers[host]?.key_format || 'Bearer {token}').replace('{token}', masterToken);

  const body = { scopes, ttl_seconds: ttl, agent_id: agentId };
  const res = await fetch(url, {
    method,
    headers: {
      [authHeader]: authFormat,
      'Content-Type': 'application/json',
      'User-Agent': 'AgentDOM/3.2',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${host} agent_tokens.issue failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const tokenEntry = {
    id:         data.id || data.token_id,
    token:      data.token || data.access_token || data.api_key,
    scopes:     data.scopes || scopes,
    expires_at: data.expires_at || (ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null),
    issued_via: 'agent_tokens_protocol',
    host,
  };

  storeAgentToken(host, tokenEntry, w);
  return tokenEntry;
}

// ── Rotate an existing agent token ───────────────────────────────────────────
async function rotateAgentToken(host, tokenId) {
  const spec = await getAgentTokenSpec(host);
  if (!spec?.rotate) throw new Error(`${host} does not support token rotation`);

  const w = readWallet();
  const masterToken = getMasterCredential(host, w);
  if (!masterToken) throw new Error(`No master credential for ${host}`);

  const { method, url } = extractMethod(resolveUrl(spec.rotate, { id: tokenId }));
  const authHeader = (w.providers[host]?.key_header || 'Authorization');
  const authFormat = (w.providers[host]?.key_format || 'Bearer {token}').replace('{token}', masterToken);

  const res = await fetch(url, {
    method,
    headers: { [authHeader]: authFormat, 'User-Agent': 'AgentDOM/3.2' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Token rotation failed (${res.status})`);
  const data = await res.json();

  const existing = (w.providers[host]?.agent_token) || {};
  const rotated = {
    ...existing,
    token:      data.token || data.access_token,
    expires_at: data.expires_at || null,
    rotated_at: new Date().toISOString(),
  };
  storeAgentToken(host, rotated, w);
  return rotated;
}

// ── Revoke an agent token ─────────────────────────────────────────────────────
async function revokeAgentToken(host, tokenId) {
  const spec = await getAgentTokenSpec(host);
  if (!spec?.revoke) throw new Error(`${host} does not support token revocation`);

  const w = readWallet();
  const masterToken = getMasterCredential(host, w);
  const { method, url } = extractMethod(resolveUrl(spec.revoke, { id: tokenId }));
  const authHeader = (w.providers[host]?.key_header || 'Authorization');
  const authFormat = (w.providers[host]?.key_format || 'Bearer {token}').replace('{token}', masterToken);

  const res = await fetch(url, {
    method,
    headers: { [authHeader]: authFormat, 'User-Agent': 'AgentDOM/3.2' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Token revocation failed (${res.status})`);

  // Remove from wallet
  if (w.providers[host]?.agent_token?.id === tokenId) {
    delete w.providers[host].agent_token;
    writeWallet(w);
  }
  return { revoked: true, id: tokenId };
}

// ── ensureAgentToken — main entry for agents ──────────────────────────────────
/**
 * The main function agents call. Returns a valid scoped token:
 * - Issues new token if none exists
 * - Returns cached token if still valid
 * - Rotates token if expiring within 5 minutes
 * Never requires human interaction.
 */
async function ensureAgentToken(host, opts = {}) {
  const w = readWallet();
  const existing = w.providers?.[host]?.agent_token;

  // Already have a token?
  if (existing?.token && existing.expires_at) {
    const exp = new Date(existing.expires_at);
    const fiveMin = new Date(Date.now() + 5 * 60 * 1000);
    if (exp > fiveMin) return existing; // still good
    if (existing.id) {
      // Rotate instead of issue new
      try { return await rotateAgentToken(host, existing.id); } catch {}
    }
  }

  // Issue a fresh agent token
  return await issueAgentToken(host, opts);
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const host = argv[0];
  const subcmd = argv[1] || 'issue';
  const getArg = (f) => argv.find(a => a.startsWith(`--${f}=`))?.split('=').slice(1).join('=');

  if (!host) {
    console.log(`
agentdom agent-token <provider> [issue|rotate|revoke|list]

The Agent Token Protocol — publishers issue scoped tokens to agents
without any browser login or human interaction.

Commands:
  agentdom agent-token resend.com                     Issue token (default)
  agentdom agent-token resend.com issue --scopes=emails:send --ttl=3600
  agentdom agent-token resend.com rotate <token-id>
  agentdom agent-token resend.com revoke <token-id>

Prerequisites:
  • Publisher must have auth.agent_tokens in .well-known/agentdom.json
  • You must have a master credential: agentdom setup resend.com
`);
    process.exit(0);
  }

  (async () => {
    try {
      if (subcmd === 'rotate') {
        const tokenId = argv[2];
        if (!tokenId) { console.error('Usage: agentdom agent-token <host> rotate <token-id>'); process.exit(1); }
        const r = await rotateAgentToken(host, tokenId);
        console.log(`✓ Rotated token for ${host}`);
        console.log(JSON.stringify(r, null, 2));
      } else if (subcmd === 'revoke') {
        const tokenId = argv[2];
        if (!tokenId) { console.error('Usage: agentdom agent-token <host> revoke <token-id>'); process.exit(1); }
        const r = await revokeAgentToken(host, tokenId);
        console.log(`✓ Revoked token ${tokenId} for ${host}`);
        console.log(JSON.stringify(r, null, 2));
      } else {
        // issue or ensure
        const scopes  = (getArg('scopes') || '').split(',').filter(Boolean);
        const ttl     = parseInt(getArg('ttl') || '3600', 10);
        const agentId = getArg('agent-id') || 'agentdom';
        const r = await issueAgentToken(host, { scopes, ttl, agentId });
        console.log(`✓ Agent token issued for ${host}`);
        console.log(JSON.stringify(r, null, 2));
      }
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { issueAgentToken, rotateAgentToken, revokeAgentToken, ensureAgentToken, getAgentTokenSpec };
