/**
 * AgentDOM — Token Cache (Phase 4)
 *
 * In-memory read-through cache layered on top of `lib/keychain`. Avoids
 * hitting OS Keychain / encrypted-file on every dispatch_intent call —
 * which on macOS keytar can cost ~5–15ms per read.
 *
 *   • TTL = min(expires_at − now − 60s, 5 min). Never cached past expiry.
 *   • Invalidated whenever keychain.setToken / deleteToken fires its
 *     `onTokenChange` notifier.
 *   • Process-wide singleton (one Map for the lifetime of the process).
 *
 * Cache is opportunistic: a miss simply falls through to keychain. Cache
 * does NOT mutate token shape — it stores exactly what keychain returned.
 *
 * Usage:
 *   const cache = require('./token-cache');
 *   const token = await cache.getCached('openrouter.ai');
 *   cache.invalidate('openrouter.ai');
 *   await cache.warmAll();
 */

'use strict';

const keychain = require('./keychain');

const MAX_TTL_MS    = 5 * 60 * 1000;       // never cache longer than 5 min
const EXPIRY_BUFFER_MS = 60 * 1000;        // expire 60s before token does

const _cache = new Map(); // host → { token, cachedAt, expiresAtMs }
const _stats = { hits: 0, misses: 0, invalidations: 0, warmed: 0 };

let _subscribed = false;
_subscribe();

/**
 * Read-through cache lookup. Returns cached token (deep copy) or fetches
 * via keychain and caches. Returns null if not in keychain.
 *
 * @param {string} host
 * @returns {Promise<object|null>}
 */
async function getCached(host) {
  const key = _norm(host);
  const entry = _cache.get(key);
  const now = Date.now();
  if (entry && entry.expiresAtMs > now) {
    _stats.hits++;
    return _clone(entry.token);
  }
  if (entry) _cache.delete(key); // stale — drop

  _stats.misses++;
  const fresh = await keychain.getToken(key);
  if (fresh) _store(key, fresh);
  return fresh ? _clone(fresh) : null;
}

/**
 * Drop a single host from the cache.
 * @param {string} host
 */
function invalidate(host) {
  const key = _norm(host);
  if (_cache.delete(key)) _stats.invalidations++;
}

/**
 * Drop everything.
 */
function clear() {
  _stats.invalidations += _cache.size;
  _cache.clear();
}

/**
 * Pre-load every provider currently in keychain. Runs at process start
 * to remove first-call latency.
 *
 * @returns {Promise<{warmed:number, providers:string[]}>}
 */
async function warmAll() {
  const providers = await keychain.listProviders();
  let warmed = 0;
  for (const host of providers) {
    try {
      const tok = await keychain.getToken(host);
      if (tok) { _store(host, tok); warmed++; }
    } catch (_) { /* skip — invalid entry */ }
  }
  _stats.warmed += warmed;
  return { warmed, providers };
}

/**
 * Diagnostic stats. Hit rate = hits / (hits + misses).
 */
function stats() {
  const total = _stats.hits + _stats.misses;
  return {
    hits:          _stats.hits,
    misses:        _stats.misses,
    invalidations: _stats.invalidations,
    warmed:        _stats.warmed,
    size:          _cache.size,
    hitRate:       total > 0 ? _stats.hits / total : 0,
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

function _norm(host) {
  return String(host || '').trim().toLowerCase();
}

function _ttlFor(token) {
  const now = Date.now();
  if (typeof token?.expires_at === 'number' && token.expires_at > 0) {
    const untilExpiry = token.expires_at - now - EXPIRY_BUFFER_MS;
    if (untilExpiry <= 0) return 0;
    return Math.min(untilExpiry, MAX_TTL_MS);
  }
  // ISO-string expires_at
  if (typeof token?.expires_at === 'string') {
    const t = Date.parse(token.expires_at);
    if (!isNaN(t)) {
      const untilExpiry = t - now - EXPIRY_BUFFER_MS;
      if (untilExpiry <= 0) return 0;
      return Math.min(untilExpiry, MAX_TTL_MS);
    }
  }
  // No expiry → cap at MAX_TTL_MS (api_keys, session_cookies, etc.)
  return MAX_TTL_MS;
}

function _store(host, token) {
  const ttl = _ttlFor(token);
  if (ttl <= 0) return;
  _cache.set(_norm(host), {
    token:       _clone(token),
    cachedAt:    Date.now(),
    expiresAtMs: Date.now() + ttl,
  });
}

function _clone(o) {
  // Token shapes are JSON-safe; structuredClone falls back to JSON otherwise.
  try { return structuredClone(o); }
  catch { return JSON.parse(JSON.stringify(o)); }
}

function _subscribe() {
  if (_subscribed) return;
  if (typeof keychain.onTokenChange === 'function') {
    keychain.onTokenChange((host) => invalidate(host));
    _subscribed = true;
  }
}

/** Reset for tests. */
function _resetForTests() {
  _cache.clear();
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.invalidations = 0;
  _stats.warmed = 0;
}

module.exports = {
  getCached,
  invalidate,
  clear,
  warmAll,
  stats,
  _resetForTests,
};
