/**
 * AgentDOM — Desktop Platform Dispatcher (Phase 5)
 *
 * Single entry point: `require('./desktop-agent/platform').getBridge()`
 * returns the right native bridge for the current OS. Every bridge exposes
 * the same surface (see `desktop-agent/index.js` exports + the Phase 5
 * additions: listWindows, getAccessibilityTree, pressKey, readElement,
 * clickInWindow, getWindowFrame) so callers do no platform branching.
 *
 *   darwin  → ./index.js                  (existing AppleScript / JXA / AX)
 *   linux   → ./linux-atspi.js            (AT-SPI2 via Python helper)
 *   win32   → ./win-uia.js                (UIA via Python helper)
 *   other   → no-op stub (every method returns a structured error)
 *
 * Cached after the first call. `_reset()` is exposed for tests so the
 * dispatcher can be re-evaluated with a different `process.platform`.
 */

'use strict';

let _cached = null;
let _cachedFor = null;

/**
 * @returns {object} the platform-specific bridge module
 */
function getBridge() {
  const p = process.platform;
  if (_cached && _cachedFor === p) return _cached;

  let bridge;
  switch (p) {
    case 'darwin':
      bridge = require('./index.js');
      break;
    case 'linux':
      bridge = require('./linux-atspi.js');
      break;
    case 'win32':
      bridge = require('./win-uia.js');
      break;
    default:
      bridge = _makeStub(p);
  }

  _cached    = bridge;
  _cachedFor = p;
  return bridge;
}

/**
 * Build a stub bridge whose methods all return a structured "platform not
 * supported" error. Keeps the call sites in desktop-mcp-server.js identical
 * across every OS — no `if (process.platform === ...)` guards needed.
 */
function _makeStub(platformName) {
  const err = (extra = {}) => ({
    error: `Platform ${platformName} not supported`,
    hint:  'AgentDOM desktop bridges are available on darwin, linux, win32.',
    ...extra,
  });

  return {
    platform: platformName,
    isSupported: false,

    checkPermissions: () => ({ ok: false, hint: `Platform ${platformName} not supported` }),
    isRunning: () => false,
    listApps: () => err(),
    listWindows: () => err(),
    scanApp: () => err(),
    getAccessibilityTree: () => err(),
    clickElement: () => ({ clicked: false, ...err() }),
    typeIntoField: () => ({ typed: false, ...err() }),
    typeText: () => ({ typed: false, ...err() }),
    pressKeys: () => ({ pressed: false, ...err() }),
    pressKey:  () => ({ pressed: false, ...err() }),
    clickMenu: () => ({ clicked: false, ...err() }),
    activate:  () => undefined,
    openApp:   () => undefined,
    screenshotApp: () => err(),
    readElement:   () => err(),
    clickInWindow: () => ({ clicked: false, ...err() }),
    getWindowFrame: () => null,
    getDisplays:   () => err(),
  };
}

/** Drop the cached bridge. Tests use this when mutating process.platform. */
function _reset() {
  _cached = null;
  _cachedFor = null;
}

module.exports = {
  getBridge,
  _reset,
  _makeStub,
};
