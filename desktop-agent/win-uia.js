/**
 * AgentDOM — Windows UIA Bridge (Phase 5)
 *
 * JS wrapper around `desktop-agent/helpers/uia-bridge.py`. Same public
 * surface as `linux-atspi.js` (and `desktop-agent/index.js` on macOS) so
 * the dispatch router does not need platform-specific branching.
 */

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');

const HELPER_PATH = path.join(__dirname, 'helpers', 'uia-bridge.py');
const PYTHON_BIN  = process.env.AGENTDOM_PYTHON || 'python3';

// ── Helper invocation ──────────────────────────────────────────────────────

/**
 * Run the UIA Python helper with one JSON command. Returns the helper's
 * envelope: `{ ok, data | error, hint?, ... }`.
 *
 * @param {string} cmd
 * @param {object} args
 * @param {{timeoutMs?:number, python?:string, helperPath?:string}} [opts]
 * @returns {object}
 */
function runHelper(cmd, args = {}, opts = {}) {
  const python = opts.python      || _runner.pythonBin || PYTHON_BIN;
  const helper = opts.helperPath  || _runner.helperPath || HELPER_PATH;
  const spawnImpl = _runner.spawnSync || spawnSync;

  const payload = JSON.stringify({ cmd, args });
  let res;
  try {
    res = spawnImpl(python, [helper], {
      input:     payload,
      encoding:  'utf-8',
      timeout:   opts.timeoutMs || 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, error: `helper spawn failed: ${e.message}`, hint: 'install python3 and `pip install uiautomation`' };
  }

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return { ok: false, error: 'python3 not found on PATH', hint: 'install Python 3 from python.org' };
    }
    return { ok: false, error: `helper failed: ${res.error.message}` };
  }
  if (res.status === 2) {
    return {
      ok: false,
      error: 'UIA helper unavailable',
      hint:  (res.stderr || '').trim() || 'pip install uiautomation comtypes',
    };
  }
  const out = (res.stdout || '').trim();
  if (!out) return { ok: false, error: 'empty helper stdout', stderr: (res.stderr || '').trim() };
  try { return JSON.parse(out); }
  catch (e) { return { ok: false, error: `bad helper JSON: ${e.message}`, raw: out.slice(0, 500) }; }
}

const _runner = { spawnSync: null, pythonBin: null, helperPath: null };
function _setRunner(opts = {}) {
  if ('spawnSync'  in opts) _runner.spawnSync  = opts.spawnSync;
  if ('pythonBin'  in opts) _runner.pythonBin  = opts.pythonBin;
  if ('helperPath' in opts) _runner.helperPath = opts.helperPath;
}
function _resetRunner() {
  _runner.spawnSync = null; _runner.pythonBin = null; _runner.helperPath = null;
}

// ── Validation ─────────────────────────────────────────────────────────────

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

function _flattenTree(node, out = []) {
  if (!node) return out;
  out.push({
    role:   node.role  || 'unknown',
    label:  node.name  || '',
    states: node.states || [],
    bounds: node.bounds || null,
  });
  if (Array.isArray(node.children)) for (const c of node.children) _flattenTree(c, out);
  return out;
}

// ── Public surface ─────────────────────────────────────────────────────────

function checkPermissions() {
  if (process.platform !== 'win32') {
    return { ok: false, hint: `Platform ${process.platform} is not Windows — this bridge expects Win32 + UIA.` };
  }
  try {
    const spawnImpl = _runner.spawnSync || spawnSync;
    const res = spawnImpl(_runner.pythonBin || PYTHON_BIN, [_runner.helperPath || HELPER_PATH, '--check'], {
      encoding: 'utf-8', timeout: 5000,
    });
    if (res.error || res.status !== 0) {
      return { ok: false, hint: 'python3 + uiautomation required. Try: pip install uiautomation comtypes' };
    }
    const parsed = JSON.parse((res.stdout || '').trim() || '{}');
    if (parsed.ok) return { ok: true };
    return { ok: false, hint: parsed.hint || parsed.error || 'UIA unavailable' };
  } catch (e) {
    return { ok: false, hint: `Could not probe UIA: ${e.message}` };
  }
}

function isRunning(appName) {
  const name = validateAppName(appName);
  const env = runHelper('list_windows');
  if (!env.ok) return false;
  const target = name.toLowerCase();
  return (env.data || []).some(w => (w.app || '').toLowerCase().includes(target));
}

function listApps() {
  const env = runHelper('list_windows');
  if (!env.ok) return { error: env.error, hint: env.hint };
  return (env.data || []).map(w => ({
    name:      w.app,
    role:      w.role,
    pid:       w.pid,
    frontmost: false,
  }));
}
const listWindows = listApps;

function scanApp(appName) {
  const name = validateAppName(appName);
  const env = runHelper('get_tree', { app: name });
  if (!env.ok) return { error: env.error, hint: env.hint, app: name };
  return _flattenTree(env.data);
}

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
const pressKey = pressKeys;

function readElement(appName, label) {
  const name = validateAppName(appName);
  const lbl  = validateLabel(label);
  const { label: bare, index } = parseLabelIndex(lbl);
  const env  = runHelper('read', { app: name, label: bare, index });
  if (env.ok) return { ...env.data, app: name };
  return { error: env.error, hint: env.hint, matched: env.matched || 0, app: name };
}

// ── Lightweight shims ──────────────────────────────────────────────────────

function typeText(appName, text) {
  // UIA's SendKeys at the helper layer requires app focus; defer to press_key
  // with the raw text for keystroke synthesis.
  const env = runHelper('press_key', { app: appName, key: String(text || '') });
  if (env.ok) return { typed: true, method: 'SendKeys' };
  return { typed: false, error: env.error, hint: env.hint };
}

function activate(appName) {
  validateAppName(appName);
  // Without PowerShell, leave activation to the OS; UIA can drive elements
  // headlessly so explicit focus is usually unnecessary.
}

function openApp(appName) {
  const name = validateAppName(appName);
  try { execFileSync('cmd', ['/c', 'start', '', name], { stdio: 'ignore' }); }
  catch (_) { /* best-effort */ }
}

function clickMenu(appName, menuPath) {
  if (typeof menuPath !== 'string') return { clicked: false, error: 'menuPath must be a string' };
  const segs = menuPath.split('>').map(s => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const r = clickElement(appName, seg);
    if (!r || !r.clicked) return { ...r, clicked: false, error: r?.error || `failed at ${seg}` };
  }
  return { clicked: true, path: segs, app: appName };
}

function clickInWindow(appName, x, y) {
  const tree = getAccessibilityTree(appName);
  if (!tree || tree.error) return { clicked: false, error: tree?.error || 'no window' };
  if (!tree.bounds) return { clicked: false, error: 'window bounds unavailable' };
  const sx = Math.round(tree.bounds.x + Number(x));
  const sy = Math.round(tree.bounds.y + Number(y));
  // UIA helper doesn't expose mouse synthesis directly; this is a placeholder
  // for any future spawn into a Win32 SendInput helper.
  return { clicked: false, error: 'clickInWindow synthesis not implemented on Windows yet',
           planned: { x: sx, y: sy }, app: appName };
}

function getWindowFrame(appName) {
  const tree = getAccessibilityTree(appName);
  if (!tree || tree.error || !tree.bounds) return null;
  return { x: tree.bounds.x, y: tree.bounds.y, w: tree.bounds.w, h: tree.bounds.h };
}

function screenshotApp(appName, outputPath) {
  void appName;
  const out = String(outputPath || `screenshot_${Date.now()}.png`);
  // On Windows the original index.js used PowerShell; without it, leave a
  // structured stub so callers can fall back to OS tooling.
  return { error: 'screenshotApp: pure-Python path not implemented; use PowerShell bridge in index.js',
           path: out };
}

function getDisplays() {
  return { error: 'getDisplays not implemented without PowerShell on win-uia bridge' };
}

module.exports = {
  platform:    'win32',
  isSupported: process.platform === 'win32',

  // Phase 5 unified surface
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
