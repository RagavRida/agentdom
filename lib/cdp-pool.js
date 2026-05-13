/**
 * AgentDOM — CDP Session Pool (Phase 4)
 *
 * Browser transport (Puppeteer / CDP) pays its biggest tax on `newPage()`
 * + `page.goto()` — often 800–2000ms per call. For multi-step flows on
 * the same origin, that's wasted budget on every dispatch.
 *
 * This pool keeps up to 3 attached Page objects keyed by origin and
 * reuses them across dispatches when the page is already on the target
 * origin. LRU eviction on overflow; idle pages auto-close after 60s.
 *
 * The pool is browser-agnostic: callers pass a `browser` with
 * `.newPage()` returning a Page-like object. Each Page must implement
 * `url()` and `close()`; optional `goto(url)`.
 *
 * Usage:
 *   const cdp = require('./cdp-pool');
 *   const page = await cdp.getSession('https://github.com', browser);
 *   // … use page …
 *   cdp.releaseSession('https://github.com');
 */

'use strict';

const DEFAULT_MAX        = 3;
const DEFAULT_IDLE_MS    = 60 * 1000;

// Pool state: origin → { page, lastUsed, idleTimer, inUse }
const _sessions = new Map();
const _stats = {
  created:  0,
  reused:   0,
  evicted:  0,
  closed:   0,
  idleClosed: 0,
};

let _max = DEFAULT_MAX;
let _idleMs = DEFAULT_IDLE_MS;

/**
 * Configure pool limits. Call before first getSession.
 * @param {{max?:number, idleMs?:number}} opts
 */
function configure(opts = {}) {
  if (typeof opts.max === 'number')    _max = opts.max;
  if (typeof opts.idleMs === 'number') _idleMs = opts.idleMs;
}

/**
 * Acquire (or create) a Page bound to `origin`. If the cached page is
 * already on the target origin, we skip `goto()` entirely — the main
 * latency win.
 *
 * @param {string} origin — full origin "https://github.com" (no path)
 * @param {{newPage:Function}} browser — Puppeteer Browser (or duck-typed)
 * @returns {Promise<object>} the Page object
 */
async function getSession(origin, browser) {
  const key = _normOrigin(origin);
  if (!browser || typeof browser.newPage !== 'function') {
    throw new Error('cdp-pool.getSession: browser with newPage() required');
  }

  // 1. Cached?
  const entry = _sessions.get(key);
  if (entry) {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.lastUsed = Date.now();
    entry.inUse    = true;

    // Skip nav if already on origin
    const currentUrl = _safeUrl(entry.page);
    if (!currentUrl || !currentUrl.startsWith(key)) {
      if (typeof entry.page.goto === 'function') {
        await entry.page.goto(key);
      }
    }
    _stats.reused++;
    return entry.page;
  }

  // 2. Evict if at capacity (LRU — oldest released wins)
  if (_sessions.size >= _max) {
    await _evictLRU();
  }

  // 3. Fresh page
  const page = await browser.newPage();
  if (typeof page.goto === 'function') {
    try { await page.goto(key); } catch (_) { /* nav may fail in tests */ }
  }

  _sessions.set(key, {
    page,
    lastUsed:  Date.now(),
    idleTimer: null,
    inUse:     true,
  });
  _stats.created++;
  return page;
}

/**
 * Mark a session as no longer in active use. Starts the idle timer; the
 * page is closed automatically after `idleMs`. Subsequent getSession on
 * the same origin cancels the timer and reuses.
 *
 * @param {string} origin
 */
function releaseSession(origin) {
  const key = _normOrigin(origin);
  const entry = _sessions.get(key);
  if (!entry) return;
  entry.inUse   = false;
  entry.lastUsed = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const t = setTimeout(() => _closeIdle(key), _idleMs);
  if (t.unref) t.unref();
  entry.idleTimer = t;
}

/**
 * Close every pooled page. Call on process exit.
 */
async function shutdown() {
  const tasks = [];
  for (const [key, entry] of _sessions) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    tasks.push(_safeClose(entry.page).then(() => {
      _stats.closed++;
    }));
    _sessions.delete(key);
  }
  await Promise.all(tasks);
}

/**
 * Diagnostic stats.
 */
function stats() {
  return {
    size:       _sessions.size,
    max:        _max,
    created:    _stats.created,
    reused:     _stats.reused,
    evicted:    _stats.evicted,
    closed:     _stats.closed,
    idleClosed: _stats.idleClosed,
    origins:    [..._sessions.keys()],
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

function _normOrigin(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('cdp-pool: origin required');
  // Accept origin or full URL; collapse to "scheme://host[:port]"
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/\/$/, '');
  }
}

function _safeUrl(page) {
  try { return typeof page.url === 'function' ? page.url() : null; }
  catch { return null; }
}

async function _safeClose(page) {
  try { if (typeof page.close === 'function') await page.close(); }
  catch (_) { /* already closed */ }
}

async function _evictLRU() {
  // Prefer evicting a not-in-use session; fall back to oldest overall.
  let victimKey = null;
  let oldest = Infinity;
  for (const [k, e] of _sessions) {
    if (e.inUse) continue;
    if (e.lastUsed < oldest) { oldest = e.lastUsed; victimKey = k; }
  }
  if (!victimKey) {
    oldest = Infinity;
    for (const [k, e] of _sessions) {
      if (e.lastUsed < oldest) { oldest = e.lastUsed; victimKey = k; }
    }
  }
  if (!victimKey) return;
  const v = _sessions.get(victimKey);
  if (v.idleTimer) clearTimeout(v.idleTimer);
  _sessions.delete(victimKey);
  _stats.evicted++;
  await _safeClose(v.page);
}

async function _closeIdle(key) {
  const entry = _sessions.get(key);
  if (!entry || entry.inUse) return;
  _sessions.delete(key);
  _stats.idleClosed++;
  await _safeClose(entry.page);
}

/** Reset for tests. */
async function _resetForTests() {
  await shutdown();
  _max = DEFAULT_MAX;
  _idleMs = DEFAULT_IDLE_MS;
  _stats.created    = 0;
  _stats.reused     = 0;
  _stats.evicted    = 0;
  _stats.closed     = 0;
  _stats.idleClosed = 0;
}

module.exports = {
  getSession,
  releaseSession,
  shutdown,
  configure,
  stats,
  _resetForTests,
};
