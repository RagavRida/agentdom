/**
 * AgentDOM — Linux AT-SPI Bridge (Phase 5)
 *
 * JS wrapper around `desktop-agent/helpers/atspi-bridge.py`. The Python
 * helper does the actual AT-SPI work; this module marshals JSON requests
 * over stdin/stdout and exposes the same surface as `desktop-agent/index.js`
 * (macOS) so the MCP server can call the platform.getBridge() result
 * without any platform-specific branching.
 *
 * Public methods mirror the macOS bridge:
 *   isRunning, checkPermissions, listApps, scanApp, clickElement,
 *   typeIntoField, pressKeys, clickMenu, typeText, activate, openApp,
 *   screenshotApp, clickInWindow, getWindowFrame
 *
 * Plus the Phase 5 unified-API aliases the dispatch router expects:
 *   listWindows  = listApps
 *   getAccessibilityTree = scanApp
 *   pressKey     = pressKeys
 *   readElement  = read value/text of a labeled element
 */

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELPER_PATH = path.join(__dirname, 'helpers', 'atspi-bridge.py');
const PYTHON_BIN  = process.env.AGENTDOM_PYTHON || 'python3';

// ── Helper invocation ──────────────────────────────────────────────────────

/**
 * Run the AT-SPI Python helper with one JSON command. Returns the parsed
 * envelope `{ ok, data | error, ...}` produced by the helper.
 *
 * @param {string} cmd   — one of: list_windows, get_tree, click, type, press_key, read
 * @param {object} args  — command-specific argument object
 * @param {{timeoutMs?:number, python?:string, helperPath?:string}} [opts]
 * @returns {object}
 */
function runHelper(cmd, args = {}, opts = {}) {
  const python = opts.python      || _runner.pythonBin || PYTHON_BIN;
  const helper = opts.helperPath  || _runner.helperPath || HELPER_PATH;

  // Allow tests to swap the entire spawn implementation.
  const spawnImpl = _runner.spawnSync || spawnSync;

  const payload = JSON.stringify({ cmd, args });
  let res;
  try {
    res = spawnImpl(python, [helper], {
      input: payload,
      encoding: 'utf-8',
      timeout: opts.timeoutMs || 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, error: `helper spawn failed: ${e.message}`, hint: 'install python3 and python3-atspi' };
  }

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return { ok: false, error: 'python3 not found on PATH', hint: 'install python3, then `pip install pygobject`' };
    }
    return { ok: false, error: `helper failed: ${res.error.message}` };
  }
  if (res.status === 2) {
    return {
      ok: false,
      error: 'AT-SPI helper unavailable',
      hint:  (res.stderr || '').trim() || 'install python3-atspi / pygobject and start at-spi-dbus-bus.service',
    };
  }
  const out = (res.stdout || '').trim();
  if (!out) {
    return { ok: false, error: 'empty helper stdout', stderr: (res.stderr || '').trim() };
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: `bad helper JSON: ${e.message}`, raw: out.slice(0, 500) };
  }
}

/** Test seam — swap the runner internals. */
const _runner = {
  spawnSync: null,
  pythonBin: null,
  helperPath: null,
};
function _setRunner(opts = {}) {
  if ('spawnSync'  in opts) _runner.spawnSync  = opts.spawnSync;
  if ('pythonBin'  in opts) _runner.pythonBin  = opts.pythonBin;
  if ('helperPath' in opts) _runner.helperPath = opts.helperPath;
}
function _resetRunner() {
  _runner.spawnSync = null;
  _runner.pythonBin = null;
  _runner.helperPath = null;
}

// ── Validation (mirrors index.js) ──────────────────────────────────────────

function validateAppName(name) {
  if (!name || typeof name !== 'string') throw new Error('App name is required');
  if (name.length > 100) throw new Error('App name too long');
  if (/[;&|`$(){}[\]!#<>]/.test(name)) throw new Error(`Invalid characters in app name: "${name}"`);
  return name.trim();
}
function validateLabel(s, field = 'label') {
  if (typeof s !== 'string') throw new Error(`${field} must be a string`);
  if (s.length > 500) throw new Error(`${field} too long`);
  return s;
}

function parseLabelIndex(label) {
  if (typeof label !== 'string') return { label, index: 1 };
  const m = label.match(/^(.*) \((\d+)\)$/);
  if (!m) return { label, index: 1 };
  return { label: m[1], index: parseInt(m[2], 10) };
}

function _unwrap(envelope, errorShape = {}) {
  if (envelope && envelope.ok && envelope.data !== undefined) return envelope.data;
  return { ...errorShape, error: envelope.error || 'unknown', hint: envelope.hint };
}

// ── Tree → flat element list (matches macOS bridge output style) ──────────

function _flattenTree(node, out = []) {
  if (!node) return out;
  out.push({
    role:   node.role  || 'unknown',
    label:  node.name  || '',
    states: node.states || [],
    bounds: node.bounds || null,
  });
  if (Array.isArray(node.children)) {
    for (const ch of node.children) _flattenTree(ch, out);
  }
  return out;
}

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Probe whether the AT-SPI helper is runnable on this machine.
 * @returns {{ok:boolean, hint?:string}}
 */
function checkPermissions() {
  if (process.platform !== 'linux') {
    return { ok: false, hint: `Platform ${process.platform} is not Linux — this bridge expects Linux + AT-SPI2.` };
  }
  // Probe via `--check`
  const probe = runHelper('__noop__', {}, { /* default */ });
  // The helper rejects unknown cmds with ok:false. We use a real `--check`
  // path instead by invoking python directly.
  try {
    const spawnImpl = _runner.spawnSync || spawnSync;
    const res = spawnImpl(_runner.pythonBin || PYTHON_BIN, [_runner.helperPath || HELPER_PATH, '--check'], {
      encoding: 'utf-8', timeout: 5000,
    });
    if (res.error || res.status !== 0) {
      return { ok: false, hint: 'python3 + python3-atspi required. Try: sudo apt install python3-atspi gir1.2-atspi-2.0' };
    }
    const parsed = JSON.parse((res.stdout || '').trim() || '{}');
    if (parsed.ok) return { ok: true };
    return { ok: false, hint: parsed.hint || parsed.error || 'Atspi unavailable' };
  } catch (e) {
    return { ok: false, hint: `Could not probe AT-SPI: ${e.message}` };
    void probe;
  }
}

/** Is `appName` attached to the AT-SPI desktop? */
function isRunning(appName) {
  const name = validateAppName(appName);
  const env = runHelper('list_windows');
  if (!env.ok) return false;
  const target = name.toLowerCase();
  return (env.data || []).some(w => (w.app || '').toLowerCase().includes(target));
}

/** List every top-level window known to AT-SPI. */
function listApps() {
  const env = runHelper('list_windows');
  if (!env.ok) return { error: env.error, hint: env.hint };
  return (env.data || []).map(w => ({
    name:      w.app,
    role:      w.role,
    children:  w.children,
    frontmost: false,
  }));
}

/** Alias mandated by Phase 5 unified surface. */
const listWindows = listApps;

/** Full accessibility tree for `appName` (flat list, like macOS scanApp). */
function scanApp(appName) {
  const name = validateAppName(appName);
  const env = runHelper('get_tree', { app: name });
  if (!env.ok) return { error: env.error, hint: env.hint, app: name };
  return _flattenTree(env.data);
}

/** Alias: returns the *nested* tree (richer than scanApp's flat list). */
function getAccessibilityTree(appName) {
  const name = validateAppName(appName);
  const env = runHelper('get_tree', { app: name });
  if (!env.ok) return { error: env.error, hint: env.hint, app: name };
  return env.data;
}

function clickElement(appName, label) {
  const name = validateAppName(appName);
  const lbl  = validateLabel(label);
  const { label: bare, index } = parseLabelIndex(lbl);
  const env  = runHelper('click', { app: name, label: bare, index });
  if (env.ok) return { ...env.data, app: name, element: bare };
  return { clicked: false, error: env.error, hint: env.hint, matched: env.matched || 0,
           index, app: name, element: bare };
}

function typeIntoField(appName, fieldLabel, text) {
  const name = validateAppName(appName);
  const lbl  = validateLabel(fieldLabel, 'fieldLabel');
  const txt  = validateLabel(typeof text === 'string' ? text : String(text), 'text');
  const { label: bare, index } = parseLabelIndex(lbl);
  const env = runHelper('type', { app: name, field: bare, text: txt, index });
  if (env.ok) return { ...env.data, app: name };
  return { typed: false, error: env.error, hint: env.hint, matched: env.matched || 0,
           index, app: name };
}

function pressKeys(appName, shortcut) {
  validateAppName(appName);
  if (typeof shortcut !== 'string') throw new Error('shortcut must be a string');
  const env = runHelper('press_key', { app: appName, key: shortcut });
  if (env.ok) return env.data;
  return { pressed: false, error: env.error, hint: env.hint };
}

/** Phase 5 alias. */
const pressKey = pressKeys;

/** Read the value/text of a labeled element. */
function readElement(appName, label) {
  const name = validateAppName(appName);
  const lbl  = validateLabel(label);
  const { label: bare, index } = parseLabelIndex(lbl);
  const env  = runHelper('read', { app: name, label: bare, index });
  if (env.ok) return { ...env.data, app: name };
  return { error: env.error, hint: env.hint, matched: env.matched || 0, app: name };
}

// ── Stubs / lightweight shims so the API surface stays uniform ────────────

function typeText(appName, text) {
  // Linux: AT-SPI has no notion of "focused field" we can reach from another
  // process — use xdotool/ydotool if installed. Best-effort via helper's
  // generate_keyboard_event would require focusing first; for now we surface
  // a hint when the global typer is unavailable.
  try {
    execFileSync('which', ['ydotool'], { stdio: 'ignore' });
    execFileSync('ydotool', ['type', '--', String(text || '')]);
    return { typed: true, method: 'ydotool' };
  } catch (_) {}
  try {
    execFileSync('which', ['xdotool'], { stdio: 'ignore' });
    execFileSync('xdotool', ['type', '--', String(text || '')]);
    return { typed: true, method: 'xdotool' };
  } catch (_) {}
  void appName;
  return { typed: false, error: 'no xdotool/ydotool', hint: 'sudo apt install xdotool ydotool' };
}

function activate(appName) {
  validateAppName(appName);
  try {
    execFileSync('wmctrl', ['-a', appName], { timeout: 3000, stdio: 'ignore' });
  } catch (_) { /* no-op */ }
}

function openApp(appName) {
  const name = validateAppName(appName);
  try {
    execFileSync('gtk-launch', [name], { timeout: 3000, stdio: 'ignore' });
  } catch (_) {
    try { execFileSync('xdg-open', [name], { timeout: 3000, stdio: 'ignore' }); } catch (_) {}
  }
}

function clickMenu(appName, menuPath) {
  if (typeof menuPath !== 'string') return { clicked: false, error: 'menuPath must be a string' };
  // Walk path by clicking each segment — AT-SPI's tree exposes menu items
  // as discrete accessibles, so iterating clickElement is the right approach.
  const segs = menuPath.split('>').map(s => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const r = clickElement(appName, seg);
    if (!r || !r.clicked) return { ...r, clicked: false, error: r?.error || `failed at ${seg}` };
  }
  return { clicked: true, path: segs, app: appName };
}

function clickInWindow(appName, x, y) {
  // AT-SPI window-relative coords require knowing the window's screen bounds.
  // get_tree returns bounds for the app root.
  const tree = getAccessibilityTree(appName);
  if (!tree || tree.error) return { clicked: false, error: tree?.error || 'no window' };
  if (!tree.bounds) return { clicked: false, error: 'window bounds unavailable' };
  const sx = Math.round(tree.bounds.x + Number(x));
  const sy = Math.round(tree.bounds.y + Number(y));
  // Defer to xdotool/ydotool for synthetic click — Atspi.generate_mouse_event
  // works too but requires the helper invocation path.
  try { execFileSync('xdotool', ['mousemove', String(sx), String(sy), 'click', '1'], { stdio: 'ignore' }); }
  catch (_) {
    try { execFileSync('ydotool', ['mousemove', '--absolute', '-x', String(sx), '-y', String(sy), 'click', '1'], { stdio: 'ignore' }); }
    catch (_) { return { clicked: false, error: 'no xdotool/ydotool installed' }; }
  }
  return { clicked: true, app: appName, screen: { x: sx, y: sy } };
}

function getWindowFrame(appName) {
  const tree = getAccessibilityTree(appName);
  if (!tree || tree.error || !tree.bounds) return null;
  return { x: tree.bounds.x, y: tree.bounds.y, w: tree.bounds.w, h: tree.bounds.h };
}

function screenshotApp(appName, outputPath) {
  const out = String(outputPath || `screenshot_${Date.now()}.png`);
  try { execFileSync('gnome-screenshot', ['-f', out], { timeout: 5000 }); }
  catch (_) {
    try { execFileSync('scrot', [out], { timeout: 5000 }); }
    catch (_) { return { error: 'no gnome-screenshot/scrot installed', path: out }; }
  }
  return out;
}

function getDisplays() {
  // xrandr enumeration — output parsing kept loose
  try {
    const raw = execFileSync('xrandr', ['--current'], { encoding: 'utf-8', timeout: 3000 });
    const list = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\S+) connected (primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/);
      if (m) {
        list.push({
          id: m[1], primary: !!m[2],
          x: Number(m[5]), y: Number(m[6]),
          width: Number(m[3]), height: Number(m[4]),
        });
      }
    }
    return list;
  } catch (e) {
    return { error: e.message, hint: 'install xrandr or run on a session with X11/Wayland' };
  }
}

// ── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  platform:    'linux',
  isSupported: process.platform === 'linux',

  // Phase 5 unified surface (per spec)
  listWindows,
  getAccessibilityTree,
  clickElement,
  typeIntoField,
  pressKey,
  readElement,
  clickInWindow,
  getWindowFrame,

  // Parity with desktop-agent/index.js
  checkPermissions,
  isRunning,
  listApps,
  scanApp,
  typeText,
  pressKeys,
  clickMenu,
  activate,
  openApp,
  screenshotApp,
  getDisplays,

  // Test seams
  runHelper,
  _setRunner,
  _resetRunner,
};
