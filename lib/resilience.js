/**
 * AgentDOM — Resilience Primitives
 *
 * Shared utilities for hardened I/O across all AgentDOM modules:
 *
 *   fetchRetry(url, init, opts)  — fetch with exp-backoff + jitter + timeout
 *   atomicWrite(file, data)      — write-tmp + rename (crash-safe)
 *   envelope(ok, data|error)     — standard tool return shape
 *   withRetry(fn, opts)          — generic async retry
 *
 * Every MCP tool and CLI command should use these instead of raw fetch/fs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Connection-pool integration (Phase 4). Lazy-required to avoid a cycle
// with any future caller that loads resilience at module init.
let _pool = null;
function _getPool() {
  if (_pool === null) {
    try { _pool = require('./connection-pool'); }
    catch (_) { _pool = false; }
  }
  return _pool || null;
}

// ── Error envelope ──────────────────────────────────────────────────────────

/**
 * Standard tool return shape. Every tool, MCP handler, and dispatch result
 * should go through this so LLM callers get a predictable contract.
 *
 *   { ok: true,  data: { ... } }
 *   { ok: false, error: "string", hint?: "string", retry_after?: ms }
 */
function envelope(ok, payload = {}) {
  if (ok) return { ok: true, data: payload };
  const { error, hint, retry_after, ...rest } = payload;
  return {
    ok: false,
    error: error || 'Unknown error',
    ...(hint ? { hint } : {}),
    ...(retry_after ? { retry_after } : {}),
    ...rest,
  };
}

/** Wrap a sync or async function, catching throws and converting to envelope. */
async function envelopeCall(fn) {
  try {
    const result = await fn();
    return envelope(true, result);
  } catch (e) {
    return envelope(false, { error: e.message || String(e) });
  }
}

// ── Atomic file write ───────────────────────────────────────────────────────

/**
 * Write `data` to `filePath` atomically: write to a temp file in the same
 * directory, then rename. Rename is atomic on POSIX (and effectively atomic
 * on Windows NTFS). Prevents corrupt wallet/session files if the process
 * crashes mid-write.
 *
 * @param {string} filePath — target file (directories created if needed)
 * @param {string|object} data — string or object (auto-JSON-stringified)
 * @param {object} [opts] — { mode: 0o600 }
 */
function atomicWrite(filePath, data, opts = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = filePath + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, { mode: opts.mode || 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Clean up the temp file on any error
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// ── Fetch with retry + exponential backoff + jitter ─────────────────────────

const DEFAULT_RETRY_OPTS = {
  retries: 3,
  baseDelay: 300,      // ms — first retry waits ~300ms
  maxDelay: 5000,      // ms — cap
  timeoutMs: 10000,    // per-request timeout
  retryOn: [429, 500, 502, 503, 504],  // HTTP status codes to retry
};

/**
 * fetch() wrapper with:
 *   - Per-request AbortController timeout
 *   - Exponential backoff: delay = min(baseDelay * 2^attempt, maxDelay)
 *   - Jitter: ±25% randomization to prevent thundering herd
 *   - Retry on network errors + specific HTTP status codes
 *
 * Returns the Response on success, throws on exhausted retries.
 */
async function fetchRetry(url, init = {}, opts = {}) {
  const { retries, baseDelay, maxDelay, timeoutMs, retryOn } = { ...DEFAULT_RETRY_OPTS, ...opts };
  let lastError = null;

  // Resolve a per-host pooled agent so subsequent calls reuse keep-alive
  // connections. Node's global fetch (undici) does not honor http.Agent
  // directly, but passing it on init is harmless when ignored and used by
  // any other HTTP libs / future dispatcher wiring.
  let pooledAgent = null;
  try {
    const pool = _getPool();
    if (pool) pooledAgent = pool.getAgent(url);
  } catch (_) { /* pool optional */ }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchInit = { ...init, signal: controller.signal };
      if (pooledAgent && !fetchInit.agent) fetchInit.agent = pooledAgent;
      const res = await fetch(url, fetchInit);
      clearTimeout(timer);

      // Success or non-retryable status
      if (res.ok || !retryOn.includes(res.status)) return res;

      // Retryable status — check Retry-After header
      lastError = new Error(`HTTP ${res.status} from ${url}`);
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter && attempt < retries) {
        const waitMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 1000;
        await sleep(Math.min(waitMs, maxDelay));
        continue;
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      // Don't retry on user abort
      if (e.name === 'AbortError' && init.signal?.aborted) throw e;
    }

    // Exponential backoff with jitter
    if (attempt < retries) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * (0.75 + Math.random() * 0.5); // ±25%
      await sleep(jitter);
    }
  }
  throw lastError || new Error(`fetchRetry exhausted ${retries} retries for ${url}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Generic async retry ─────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff.
 * Compatible with the existing `withRetry` in desktop-agent but enhanced
 * with jitter and configurable backoff.
 */
async function withRetry(fn, { retries = 3, baseDelay = 300, maxDelay = 5000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries) {
        const delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
        await sleep(delay * (0.75 + Math.random() * 0.5));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  envelope,
  envelopeCall,
  atomicWrite,
  fetchRetry,
  withRetry,
};
