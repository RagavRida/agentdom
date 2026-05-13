/**
 * AgentDOM — Token Lifecycle Manager (Phase 2D)
 *
 * Handles the entire lifecycle of auth tokens:
 *
 *   • Auto-refresh — background timer fires 5 min before expiry
 *   • Rate-limit tracking — per-provider request counters + backoff
 *   • Token health checks — periodic validation against provider
 *   • Graceful degradation — if refresh fails, mark token as stale
 *
 * This module is a singleton — it manages all active providers for
 * the lifetime of the AgentDOM process. Timers use `unref()` so they
 * don't keep the process alive.
 *
 * Usage:
 *   const lifecycle = require('./lib/token-lifecycle');
 *   lifecycle.track('hubspot.com', tokenData, registryConfig);
 *   lifecycle.onRefresh((provider, newToken) => { ... });
 *   lifecycle.onExpiry((provider) => { ... });
 */

'use strict';

const keychain = require('./keychain');

// ── Constants ─────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS   = 5 * 60 * 1000;   // Refresh 5 min before expiry
const MIN_REFRESH_MS      = 30 * 1000;        // Never schedule sooner than 30s
const RATE_LIMIT_WINDOW   = 60 * 1000;        // 1 min sliding window
const DEFAULT_RATE_LIMIT  = 100;              // requests per window

// ── State ─────────────────────────────────────────────────────────────────

const _timers       = new Map(); // provider → timer ID
const _rateLimits   = new Map(); // provider → { count, windowStart, limit, backoffUntil }
const _listeners    = { refresh: [], expiry: [], error: [] };
const _tracked      = new Map(); // provider → { token, config, status }

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Start tracking a provider's token for auto-refresh.
 *
 * @param {string} provider — e.g. "hubspot.com"
 * @param {object} token    — token data from keychain
 * @param {object} config   — registry config (needs token_url, client_id for refresh)
 */
function track(provider, token, config) {
  _tracked.set(provider, {
    token,
    config,
    status:    'active',
    lastCheck: Date.now(),
  });

  // Initialize rate limit tracker
  if (!_rateLimits.has(provider)) {
    _rateLimits.set(provider, {
      count:        0,
      windowStart:  Date.now(),
      limit:        config?.rate_limit || DEFAULT_RATE_LIMIT,
      backoffUntil: 0,
    });
  }

  _scheduleRefresh(provider, token, config);
}

/**
 * Stop tracking a provider (e.g. after revoke).
 */
function untrack(provider) {
  const timer = _timers.get(provider);
  if (timer) clearTimeout(timer);
  _timers.delete(provider);
  _tracked.delete(provider);
  _rateLimits.delete(provider);
}

/**
 * Record an API request to a provider (for rate-limit tracking).
 * Returns { allowed: boolean, retryAfterMs?: number }.
 */
function recordRequest(provider) {
  let rl = _rateLimits.get(provider);
  if (!rl) {
    rl = { count: 0, windowStart: Date.now(), limit: DEFAULT_RATE_LIMIT, backoffUntil: 0 };
    _rateLimits.set(provider, rl);
  }

  // Check backoff
  if (rl.backoffUntil > Date.now()) {
    return { allowed: false, retryAfterMs: rl.backoffUntil - Date.now() };
  }

  // Slide window
  if (Date.now() - rl.windowStart > RATE_LIMIT_WINDOW) {
    rl.count = 0;
    rl.windowStart = Date.now();
  }

  rl.count++;
  if (rl.count > rl.limit) {
    // Back off for 1 window
    rl.backoffUntil = Date.now() + RATE_LIMIT_WINDOW;
    return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW };
  }

  return { allowed: true };
}

/**
 * Handle a 429 from a provider — enter backoff.
 */
function handleRateLimit(provider, retryAfterMs = RATE_LIMIT_WINDOW) {
  let rl = _rateLimits.get(provider);
  if (!rl) {
    rl = { count: 0, windowStart: Date.now(), limit: DEFAULT_RATE_LIMIT, backoffUntil: 0 };
    _rateLimits.set(provider, rl);
  }
  rl.backoffUntil = Date.now() + retryAfterMs;
  // Halve the rate limit for adaptive throttling
  rl.limit = Math.max(10, Math.floor(rl.limit * 0.5));
}

/**
 * Get the status of a tracked provider.
 */
function getStatus(provider) {
  const info = _tracked.get(provider);
  if (!info) return null;
  const rl = _rateLimits.get(provider) || {};
  return {
    provider,
    status:     info.status,
    lastCheck:  info.lastCheck,
    expired:    info.token ? keychain.isExpired(info.token) : true,
    rateLimit:  {
      count:    rl.count || 0,
      limit:    rl.limit || DEFAULT_RATE_LIMIT,
      inBackoff: (rl.backoffUntil || 0) > Date.now(),
    },
  };
}

/**
 * Get status of all tracked providers.
 */
function getAllStatus() {
  return [..._tracked.keys()].map(getStatus);
}

/**
 * Register event listeners.
 *   lifecycle.onRefresh((provider, newToken) => { ... })
 *   lifecycle.onExpiry((provider) => { ... })
 *   lifecycle.onError((provider, error) => { ... })
 */
function onRefresh(fn) { _listeners.refresh.push(fn); }
function onExpiry(fn)  { _listeners.expiry.push(fn); }
function onError(fn)   { _listeners.error.push(fn); }

function _emit(event, ...args) {
  for (const fn of _listeners[event] || []) {
    try { fn(...args); } catch (_) {}
  }
}

// ── Internal: refresh scheduling ──────────────────────────────────────────

function _scheduleRefresh(provider, token, config) {
  // Clear any existing timer
  const existing = _timers.get(provider);
  if (existing) clearTimeout(existing);

  // Only schedule if we have an expiry and a refresh_token
  if (!token?.expires_at || !token?.refresh_token) return;
  if (!config?.token_url) return;

  const msUntilExpiry  = token.expires_at - Date.now();
  const msUntilRefresh = Math.max(MIN_REFRESH_MS, msUntilExpiry - REFRESH_BUFFER_MS);

  if (msUntilExpiry <= 0) {
    // Already expired — try refresh immediately
    _doRefresh(provider, token, config);
    return;
  }

  const timer = setTimeout(() => _doRefresh(provider, token, config), msUntilRefresh);
  if (timer.unref) timer.unref(); // Don't keep process alive
  _timers.set(provider, timer);
}

async function _doRefresh(provider, token, config) {
  const info = _tracked.get(provider);
  if (!info) return; // No longer tracked

  try {
    const { fetchRetry } = require('./resilience');

    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: token.refresh_token,
      client_id:     config.client_id || '',
    });

    // Some providers need client_secret for refresh too
    if (config.needs_secret) {
      const envKey = `AGENTDOM_${provider.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_SECRET`;
      const secret = process.env[envKey];
      if (secret) body.set('client_secret', secret);
    }

    const res = await fetchRetry(config.token_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    body.toString(),
    }, { retries: 2, baseDelay: 1000 });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || 'refresh failed');
    }

    // Build new token record
    const expiresIn = data.expires_in ? parseInt(data.expires_in, 10) : null;
    const newToken = {
      method:        token.method || 'oauth2',
      provider,
      access_token:  data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      token_type:    data.token_type    || 'Bearer',
      scope:         data.scope         || token.scope,
      expires_in:    expiresIn,
      expires_at:    expiresIn ? Date.now() + expiresIn * 1000 : null,
      obtained_at:   Date.now(),
    };

    // Persist
    await keychain.setToken(provider, newToken);

    // Update tracked state
    info.token     = newToken;
    info.status    = 'active';
    info.lastCheck = Date.now();

    // Schedule next refresh
    _scheduleRefresh(provider, newToken, config);

    // Notify listeners
    _emit('refresh', provider, newToken);

  } catch (err) {
    if (info) {
      info.status    = 'stale';
      info.lastCheck = Date.now();
    }
    _emit('error', provider, err);
    _emit('expiry', provider);
    console.error(`[token-lifecycle] refresh failed for ${provider}: ${err.message}`);
  }
}

/**
 * Force-refresh a specific provider's token right now.
 * @param {string} provider
 * @returns {object|null} new token or null on failure
 */
async function forceRefresh(provider) {
  const info = _tracked.get(provider);
  if (!info) return null;
  try {
    await _doRefresh(provider, info.token, info.config);
    return _tracked.get(provider)?.token || null;
  } catch { return null; }
}

/**
 * Shut down all timers. Call on process exit.
 */
function shutdown() {
  for (const [, timer] of _timers) clearTimeout(timer);
  _timers.clear();
  _tracked.clear();
  _rateLimits.clear();
}

module.exports = {
  track,
  untrack,
  recordRequest,
  handleRateLimit,
  getStatus,
  getAllStatus,
  forceRefresh,
  onRefresh,
  onExpiry,
  onError,
  shutdown,
  // Expose for testing
  _timers,
  _tracked,
  _rateLimits,
};
