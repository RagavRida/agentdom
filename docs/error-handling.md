# AgentDOM Error Handling Specification

Version: 0.1 — 2026-05-05

---

## Standard Error Envelope

Every AgentDOM tool, MCP handler, and dispatch result returns a
**standard envelope**:

```json
// Success
{
  "ok": true,
  "data": { /* result payload */ }
}

// Failure
{
  "ok": false,
  "error": "Human-readable error message",
  "hint": "Optional actionable advice for the agent/user",
  "retry_after": 5000  // Optional: ms to wait before retrying
}
```

### Rules

1. **`ok` is always present.** Boolean. Never null or missing.
2. **`data` is present on success.** Contains the tool's payload.
3. **`error` is present on failure.** Always a non-empty string.
4. **`hint` is optional.** A suggestion for recovery (e.g., "Try
   `agentdom auth hubspot.com` first").
5. **`retry_after` is optional.** If present, the agent should wait this
   many milliseconds before retrying. Used for rate-limited APIs (429).
6. **Envelope wrapping is the caller's job.** The `envelope()` helper in
   `lib/resilience.js` makes this trivial:

   ```js
   const { envelope } = require('./lib/resilience');
   return envelope(true, { scanned: 42 });
   return envelope(false, { error: 'App not running', hint: 'Run agentdom launch' });
   ```

---

## Retry Strategy

All network calls (`fetch`) use `fetchRetry()` from `lib/resilience.js`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `retries` | 3 | Total retry attempts after initial failure |
| `baseDelay` | 300ms | First retry delay (before jitter) |
| `maxDelay` | 5000ms | Maximum delay cap |
| `timeoutMs` | 10000ms | Per-request AbortController timeout |
| `retryOn` | `[429, 500, 502, 503, 504]` | HTTP status codes triggering retry |

### Backoff Formula

```
delay = min(baseDelay × 2^attempt, maxDelay) × jitter
jitter = uniform_random(0.75, 1.25)
```

### Retry-After Header

If the server sends `Retry-After: N`, we use `N × 1000` ms (capped at
`maxDelay`) instead of our exponential backoff for that attempt.

### What's NOT retried

- HTTP 4xx (except 429) — client errors, retrying won't help
- AbortError from user-provided signal — intentional cancellation
- Network errors after all retries exhausted — throw to caller

---

## Atomic Writes

All persistent state files use `atomicWrite()` from `lib/resilience.js`:

```
write to <file>.tmp.<pid>  →  rename to <file>
```

### Why

A `writeFileSync` that gets interrupted (crash, SIGKILL, full disk) leaves
a partially-written file. On next boot, `JSON.parse(readFileSync(...))` 
throws, and the wallet/sessions state is lost.

Atomic write guarantees: either the old file or the new file exists, never
a half-written one. POSIX `rename(2)` is atomic. Windows `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING` is effectively atomic on NTFS.

### Files Protected

| File | Module | Contains |
|------|--------|----------|
| `~/.agentdom/wallet.json` | `commands/auth.js` | OAuth tokens, API keys |
| `~/.agentdom/sessions.json` | `commands/launch.js` | CDP session records |
| `~/.agentdom/checkpoints/*.json` | `integrations/browser-engine.js` | Workflow state |

---

## Timeout Audit

Every `await` that touches I/O has an explicit timeout:

| Call | Timeout | Module |
|------|---------|--------|
| `fetchRetry` (per request) | 10s default | `lib/resilience.js` |
| `discover()` | 5s | `commands/auth.js` |
| `refreshOauthToken()` | 8s | `commands/auth.js` |
| `probeCDP()` | 800ms | `commands/launch.js` |
| `waitForCDP()` | 15s total | `commands/launch.js` |
| `page.goto()` | 30s | `cli.js`, `browser-engine.js` |
| AppleScript calls | 5s | `desktop-agent/index.js` |
| Python AX bridge | 10s | `desktop-agent/index.js` |
| `osascript` quit app | 5s | `commands/launch.js` |

---

## Usage in MCP Handlers

MCP tool handlers should use `envelopeCall()` for automatic error wrapping:

```js
const { envelopeCall } = require('./lib/resilience');

// In your MCP handler:
async function handleTool(name, args) {
  return envelopeCall(async () => {
    // ... do work ...
    return { items: 42 };
    // Automatically wrapped: { ok: true, data: { items: 42 } }
    // On throw: { ok: false, error: "..." }
  });
}
```

---

## Migration Guide

### Before (raw)
```js
fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2));
const res = await fetch(url);
return { success: true, result: data };
```

### After (hardened)
```js
const { atomicWrite, fetchRetry, envelope } = require('./lib/resilience');
atomicWrite(WALLET_FILE, w, { mode: 0o600 });
const res = await fetchRetry(url, {}, { retries: 2 });
return envelope(true, data);
```
