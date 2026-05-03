#!/usr/bin/env node
/**
 * AgentDOM Desktop Agent — Full macOS/Windows native app automation
 * Scan, click, type, navigate menus, take screenshots on ANY native app.
 */

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PLATFORM = os.platform(); // 'darwin' | 'win32' | 'linux'

// ════════════════════════════════════════════════
//  Input sanitization & validation
// ════════════════════════════════════════════════

function sanitizeAS(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\0/g, '').slice(0, 2000)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function sanitizePS(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\0/g, '').slice(0, 2000)
    .replace(/'/g, "''")
    .replace(/`/g, '``');
}

function validateAppName(name) {
  if (!name || typeof name !== 'string') throw new Error('App name is required');
  if (name.length > 100) throw new Error('App name too long');
  if (/[;&|`$(){}[\]!#<>]/.test(name)) throw new Error(`Invalid characters in app name: "${name}"`);
  return name.trim();
}

function validateLabel(str, fieldName = 'label') {
  if (typeof str !== 'string') throw new Error(`${fieldName} must be a string`);
  if (str.length > 500) throw new Error(`${fieldName} too long`);
  return str;
}

function validateCoord(val, name) {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number`);
  if (n < -10000 || n > 50000) throw new Error(`${name} out of range: ${n}`);
  return Math.round(n);
}

// ════════════════════════════════════════════════
//  Safe shell wrappers — execFileSync, no shell interpretation
// ════════════════════════════════════════════════

function osascript(script, opts = {}) {
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf-8',
    timeout: opts.timeout || 10000,
    ...opts,
  }).trim();
}

function jxa(script, opts = {}) {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf-8',
    timeout: opts.timeout || 15000,
    ...opts,
  }).trim();
}

function powershell(script, opts = {}) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    timeout: opts.timeout || 15000,
    ...opts,
  }).trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ════════════════════════════════════════════════
//  Retry primitive
// ════════════════════════════════════════════════

async function withRetry(fn, { retries = 1, delay = 500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries) await sleep(delay);
    }
  }
  throw lastErr;
}

// ════════════════════════════════════════════════
//  Direct AX bridge — bypasses System Events for SwiftUI / hidden apps.
//  Calls desktop-agent/ax-bridge.py via execFileSync (shell-safe).
// ════════════════════════════════════════════════

const AX_BRIDGE = path.join(__dirname, 'ax-bridge.py');

function axBridge(verb, ...args) {
  const out = execFileSync('python3', [AX_BRIDGE, verb, ...args.map(String)], {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  if (!out) return null;
  return JSON.parse(out);
}

// ════════════════════════════════════════════════
//  Label disambiguation — handles duplicate labels in the UI tree
// ════════════════════════════════════════════════

/**
 * Append " (n)" to elements whose label appears more than once.
 * The first occurrence becomes "Label (1)", second "Label (2)", etc.
 * Preserves the original label as `originalLabel` for callers that want it.
 */
function disambiguateLabels(elements) {
  if (!Array.isArray(elements)) return elements;
  const counts = {};
  for (const e of elements) {
    if (e && e.label) counts[e.label] = (counts[e.label] || 0) + 1;
  }
  const seen = {};
  for (const e of elements) {
    if (!e || !e.label || counts[e.label] <= 1) continue;
    seen[e.label] = (seen[e.label] || 0) + 1;
    e.originalLabel = e.label;
    e.duplicateIndex = seen[e.label];
    e.duplicateCount = counts[e.label];
    e.label = `${e.label} (${seen[e.label]})`;
  }
  return elements;
}

/** Parse a label that may carry a "Label (N)" disambiguator. */
function parseLabelIndex(label) {
  if (typeof label !== 'string') return { label, index: 1 };
  const m = label.match(/^(.*) \((\d+)\)$/);
  if (!m) return { label, index: 1 };
  return { label: m[1], index: parseInt(m[2], 10) };
}

// ════════════════════════════════════════════════
//  macOS — AppleScript / JXA Accessibility Bridge
// ════════════════════════════════════════════════

const mac = {
  /** Probe macOS Accessibility permission. Returns { ok, hint? }. */
  checkPermissions() {
    try {
      const out = jxa(`
        ObjC.import('ApplicationServices');
        JSON.stringify({ trusted: $.AXIsProcessTrusted() });
      `, { timeout: 3000 });
      const { trusted } = JSON.parse(out);
      if (trusted) return { ok: true };
      return {
        ok: false,
        hint: 'Grant Accessibility permission: System Settings > Privacy & Security > Accessibility — add the app running this script (Terminal, iTerm, Node, etc.).',
      };
    } catch (e) {
      return { ok: false, error: e.message, hint: 'osascript unavailable. Are you on macOS?' };
    }
  },

  /** Check whether `appName` is running. Fast probe (~100ms). */
  isRunning(appName) {
    const name = validateAppName(appName);
    try {
      // .whose returns an empty list (length 0) instead of throwing when no match.
      const out = jxa(`Application("System Events").processes.whose({name: "${sanitizeAS(name)}"}).length`, { timeout: 2000 });
      return parseInt(out, 10) > 0;
    } catch {
      return false;
    }
  },

  /** Detect the UI framework. Returns 'electron' | 'java' | 'native' | 'unknown'.
   *  Used to set agent expectations: Electron exposes only partial AX trees for web content.
   *  ('native' covers both AppKit and Catalyst — distinguishing them needs Info.plist parsing.) */
  detectFramework(appName) {
    const name = validateAppName(appName);
    let bundlePath = null;
    // Try standard install locations first — fast, no osascript invocation.
    const candidates = [
      `/Applications/${name}.app`,
      `/System/Applications/${name}.app`,
      path.join(os.homedir(), 'Applications', `${name}.app`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { bundlePath = p; break; }
    }
    // Fallback: ask LaunchServices via osascript, suppressing stderr noise on miss.
    if (!bundlePath) {
      try {
        bundlePath = osascript(`POSIX path of (path to application "${sanitizeAS(name)}")`, {
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (!bundlePath || !fs.existsSync(bundlePath)) bundlePath = null;
      } catch {
        bundlePath = null;
      }
    }
    if (!bundlePath) return 'unknown';

    if (fs.existsSync(path.join(bundlePath, 'Contents/Frameworks/Electron Framework.framework'))) return 'electron';
    if (fs.existsSync(path.join(bundlePath, 'Contents/PlugIns/jre.bundle')) ||
        fs.existsSync(path.join(bundlePath, 'Contents/Java'))) return 'java';
    return 'native';
  },

  /** Enumerate displays. Returns [{id, x, y, width, height, primary}]. */
  getDisplays() {
    const py = `
import Quartz
import json
err, ids, count = Quartz.CGGetActiveDisplayList(16, None, None)
out = []
main = Quartz.CGMainDisplayID()
for did in ids:
    b = Quartz.CGDisplayBounds(did)
    out.append({
        "id": int(did),
        "x": int(b.origin.x),
        "y": int(b.origin.y),
        "width": int(b.size.width),
        "height": int(b.size.height),
        "primary": int(did) == int(main),
    })
print(json.dumps(out))
`;
    try {
      const raw = execFileSync('python3', ['-c', py], { encoding: 'utf-8', timeout: 3000 }).trim();
      return JSON.parse(raw);
    } catch (e) {
      return { error: e.message, hint: 'python3 + Quartz required for display enumeration on macOS.' };
    }
  },

  /** Build a structured "app not running" error matching scanApp's failure shape. */
  _notRunningError(name) {
    return { error: 'App not running', app: name, hint: `Call openApp(${JSON.stringify(name)}) first, or start the app manually.` };
  },

  listApps() {
    const script = `
      const se = Application("System Events");
      const procs = se.processes.whose({ backgroundOnly: false });
      const result = [];
      for (let i = 0; i < procs.length; i++) {
        try {
          const p = procs[i];
          const wins = p.windows.length;
          result.push({ name: p.name(), wins, frontmost: p.frontmost() });
        } catch(e) {}
      }
      JSON.stringify(result);
    `;
    try {
      return JSON.parse(jxa(script));
    } catch (e) {
      const perm = this.checkPermissions();
      return { error: e.message, hint: perm.ok ? null : perm.hint };
    }
  },

  /** Bring app to front. */
  activate(appName) {
    const name = validateAppName(appName);
    osascript(`tell application "${sanitizeAS(name)}" to activate`);
    execFileSync('sleep', ['0.3']);
  },

  /** Silent background focus — sets frontmost without visual activation. */
  _silentFocus(appName) {
    const name = validateAppName(appName);
    try {
      jxa(`Application("System Events").processes.byName("${sanitizeAS(name)}").frontmost = true`, { timeout: 3000 });
    } catch {}
  },

  /** Scan an app's UI tree — returns agent-readable structured elements.
   *  Uses the AXUIElement C API directly (via desktop-agent/ax-bridge.py),
   *  not System Events — required for SwiftUI apps on macOS 26 and to see
   *  windows of non-frontmost AppKit apps. */
  scanApp(appName) {
    const name = validateAppName(appName);
    if (!this.isRunning(name)) return this._notRunningError(name);
    try {
      const elements = axBridge('scan', name);
      if (elements && !Array.isArray(elements) && elements.error) {
        const perm = this.checkPermissions();
        return { error: elements.error, hint: perm.ok ? (elements.hint || 'AX tree unavailable for this app.') : perm.hint };
      }
      const framework = this.detectFramework(name);
      const result = disambiguateLabels(elements);
      Object.defineProperty(result, 'framework', { value: framework, enumerable: false });
      if (framework === 'electron') {
        result.unshift({
          type: '_meta',
          label: '__electron_warning__',
          description: 'This is an Electron app. Web content is rendered in Chromium and may expose only partial accessibility data — labels can be missing and roles may not match standard AX roles. Prefer clicking by visible text and re-scanning after navigation.',
          framework: 'electron',
          enabled: true,
          focused: false,
          actions: [],
          path: '__meta__',
        });
      }
      // Empty result on a running app usually means it's hidden — surface a hint.
      if (result.length === 0) {
        return { error: 'AX tree was empty', hint: `App "${name}" has no visible windows or its UI is hidden — call activate("${name}") first or unhide the app.` };
      }
      return result;
    } catch (e) {
      if (!this.isRunning(name)) return this._notRunningError(name);
      const perm = this.checkPermissions();
      return { error: e.message, hint: perm.ok ? 'App is running but its accessibility tree is unavailable.' : perm.hint };
    }
  },

  /** Click a UI element by label — uses AXPress action, no activation.
   *  Accepts disambiguators: "OK (2)" targets the second matching "OK". */
  clickElement(appName, label) {
    const name = validateAppName(appName);
    const lbl = validateLabel(label);
    const { label: bare, index: targetIdx } = parseLabelIndex(lbl);
    if (!this.isRunning(name)) return this._notRunningError(name);
    const result = axBridge('click', name, bare, String(targetIdx));
    // Bridge returns { clicked, method, matched, index, error?, hint? }.
    if (!result.clicked) {
      if (result.matched === 0) {
        result.error = result.error || `No element with label "${bare}" found in "${name}".`;
        result.hint = result.hint || 'Run scanApp() first to inspect available labels. Disambiguate duplicates as "Label (n)".';
      } else if (result.matched < targetIdx) {
        result.error = `Found ${result.matched} match(es) for "${bare}", but index ${targetIdx} requested.`;
        result.hint = `Use a smaller index (1..${result.matched}) or omit the suffix to target the first match.`;
      } else {
        result.error = result.error || `Element "${bare}" matched but AXPress/AXConfirm/AXPick failed.`;
        result.hint = result.hint || 'The element exists but is not invokable. Try activating the app first or clickAt(x,y).';
      }
    }
    return { ...result, app: name, element: bare };
  },

  /** Click at global screen coordinates. Prefers cliclick (CGEvent — multi-display safe). */
  clickAt(x, y) {
    const cx = validateCoord(x, 'x');
    const cy = validateCoord(y, 'y');
    try {
      execFileSync('which', ['cliclick'], { stdio: 'ignore' });
      execFileSync('cliclick', [`c:${cx},${cy}`]);
    } catch {
      // AppleScript fallback uses primary-display coords; may miss on secondary monitors.
      osascript(`tell application "System Events" to click at {${cx}, ${cy}}`);
    }
  },

  /** Type text into the focused field of `appName`. ASCII → keystroke; non-ASCII → clipboard paste. */
  typeText(appName, text) {
    const name = validateAppName(appName);
    const str = typeof text === 'string' ? text : String(text);
    const safeName = sanitizeAS(name);

    // Non-ASCII (emoji, CJK, RTL, accented) — keystroke corrupts; use clipboard paste.
    // Also bypass keystroke for very long strings (>500 chars) since per-char keystroke is slow.
    const needsPaste = !/^[\x20-\x7e\n\r\t]*$/.test(str) || str.length > 500;
    if (needsPaste) {
      mac._pasteText(name, str);
      return;
    }
    const safeText = sanitizeAS(str);
    osascript(`tell application "System Events" to tell process "${safeName}" to keystroke "${safeText}"`);
  },

  /** Internal: paste arbitrary text into the focused field via clipboard. Preserves prior clipboard. */
  _pasteText(appName, text) {
    const name = validateAppName(appName);
    const safeName = sanitizeAS(name);

    // Save current clipboard (best-effort — text only; binary/file clipboards are not preserved).
    let prev = null;
    try { prev = execFileSync('pbpaste', { encoding: 'utf-8' }); } catch {}

    // Write new text to clipboard via stdin (no shell interpretation).
    execFileSync('pbcopy', [], { input: text });

    try {
      // Cmd+V into the target process — no activation required if the field is already focused.
      osascript(`tell application "System Events" to tell process "${safeName}" to keystroke "v" using {command down}`);
      // Give the paste a moment to land before we restore the clipboard.
      execFileSync('sleep', ['0.15']);
    } finally {
      if (prev !== null) {
        try { execFileSync('pbcopy', [], { input: prev }); } catch {}
      }
    }
  },

  /** Type into a specific field by label — uses AXSetValue via the AX bridge.
   *  Accepts disambiguators: "Search (2)" targets the second matching "Search". */
  typeIntoField(appName, fieldLabel, text) {
    const name = validateAppName(appName);
    const lbl = validateLabel(fieldLabel, 'fieldLabel');
    const txt = validateLabel(typeof text === 'string' ? text : String(text), 'text');
    const { label: bare, index: targetIdx } = parseLabelIndex(lbl);
    if (!this.isRunning(name)) return this._notRunningError(name);
    const result = axBridge('type', name, bare, txt, String(targetIdx));
    if (!result.typed) {
      if (result.matched === 0) {
        result.error = result.error || `No text field with label "${bare}" found in "${name}".`;
        result.hint = result.hint || 'Run scanApp() first to find available fields.';
      } else if (result.matched < targetIdx) {
        result.error = `Found ${result.matched} field(s) matching "${bare}", but index ${targetIdx} requested.`;
        result.hint = `Use a smaller index (1..${result.matched}).`;
      }
    }
    return { ...result, app: name };
  },

  /** Press keyboard shortcut — e.g. "cmd+s", "shift+tab". */
  pressKeys(appName, shortcut) {
    if (typeof shortcut !== 'string') throw new Error('shortcut must be a string');
    const parts = shortcut.toLowerCase().split('+').map(s => s.trim());
    const key = parts.pop();
    const mods = new Set(parts);
    const allowedMods = new Set(['cmd','command','shift','alt','option','ctrl','control','fn']);
    for (const m of mods) {
      if (!allowedMods.has(m)) throw new Error(`Unknown modifier: ${m}`);
    }

    const modList = [];
    if (mods.has('cmd') || mods.has('command')) modList.push('command down');
    if (mods.has('shift')) modList.push('shift down');
    if (mods.has('alt') || mods.has('option')) modList.push('option down');
    if (mods.has('ctrl') || mods.has('control')) modList.push('control down');
    const modStr = modList.join(', ');

    const keyMap = { 'enter': 'return', 'esc': 'escape', 'del': 'delete', 'tab': 'tab', 'space': 'space',
      'up': 'up arrow', 'down': 'down arrow', 'left': 'left arrow', 'right': 'right arrow' };
    const mappedKey = keyMap[key] || key;

    if (mappedKey.length === 1) {
      if (!/^[\x20-\x7e]$/.test(mappedKey)) throw new Error(`Invalid key: ${mappedKey}`);
      const safeKey = sanitizeAS(mappedKey);
      const script = modStr
        ? `tell application "System Events" to keystroke "${safeKey}" using {${modStr}}`
        : `tell application "System Events" to keystroke "${safeKey}"`;
      osascript(script);
    } else {
      const keyCodeMap = { 'return': 36, 'escape': 53, 'delete': 51, 'tab': 48, 'space': 49,
        'up arrow': 126, 'down arrow': 125, 'left arrow': 123, 'right arrow': 124,
        'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96 };
      const code = keyCodeMap[mappedKey];
      if (code === undefined) throw new Error(`Unknown key: ${key}`);
      const script = modStr
        ? `tell application "System Events" to key code ${code} using {${modStr}}`
        : `tell application "System Events" to key code ${code}`;
      osascript(script);
    }
  },

  /** Click a menu item: "File > Save As". */
  clickMenu(appName, menuPath) {
    const name = validateAppName(appName);
    if (typeof menuPath !== 'string') throw new Error('menuPath must be a string');
    if (!this.isRunning(name)) return this._notRunningError(name);
    this.activate(name);
    const parts = menuPath.split('>').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return { clicked: false, error: 'menuPath needs at least two segments', hint: 'Format: "Menu > Item" or "Menu > Sub > Item"' };
    for (const p of parts) validateLabel(p, 'menu segment');

    const safeName = sanitizeAS(name);
    let script = `tell application "System Events" to tell process "${safeName}"\n`;
    script += `  click menu item "${sanitizeAS(parts[parts.length - 1])}" of `;
    for (let i = parts.length - 2; i >= 0; i--) {
      const seg = sanitizeAS(parts[i]);
      if (i === 0) script += `menu 1 of menu bar item "${seg}" of menu bar 1\n`;
      else script += `menu 1 of menu item "${seg}" of `;
    }
    script += `end tell`;
    try {
      osascript(script, { timeout: 5000 });
      return { clicked: true };
    } catch (e) {
      // osascript stderr is verbose; trim to first line and add a hint.
      const msg = String(e.message || '').split('\n')[0];
      return {
        clicked: false,
        error: msg,
        hint: 'Check the menu path against scanApp() output. Segment names must match exactly (case-sensitive). Some apps localize menu labels.',
      };
    }
  },

  openApp(appName) {
    const name = validateAppName(appName);
    execFileSync('open', ['-a', name]);
    execFileSync('sleep', ['1']);
  },

  screenshotApp(appName, outputPath) {
    const name = validateAppName(appName);
    if (typeof outputPath !== 'string' || outputPath.length > 1024) throw new Error('Invalid outputPath');
    this.activate(name);
    execFileSync('sleep', ['0.3']);
    try {
      const safeName = sanitizeAS(name);
      const winInfo = jxa(`
        const se = Application("System Events");
        const proc = se.processes.byName("${safeName}");
        const win = proc.windows[0];
        const pos = win.position();
        const sz = win.size();
        JSON.stringify({x: pos[0], y: pos[1], w: sz[0], h: sz[1]});
      `);
      const { x, y, w, h } = JSON.parse(winInfo);
      execFileSync('screencapture', [`-R${x},${y},${w},${h}`, outputPath]);
    } catch {
      execFileSync('screencapture', [outputPath]);
    }
    return outputPath;
  },

  getFrontApp() {
    return osascript(`tell application "System Events" to name of first process whose frontmost is true`);
  },

  moveWindow(appName, x, y, w, h) {
    const name = validateAppName(appName);
    this.activate(name);
    const safeName = sanitizeAS(name);
    let script = `tell application "System Events" to tell process "${safeName}"\n`;
    if (x !== undefined && y !== undefined) {
      script += `  set position of window 1 to {${validateCoord(x,'x')}, ${validateCoord(y,'y')}}\n`;
    }
    if (w !== undefined && h !== undefined) {
      script += `  set size of window 1 to {${validateCoord(w,'w')}, ${validateCoord(h,'h')}}\n`;
    }
    script += `end tell`;
    osascript(script);
  },

  /** Run an arbitrary AppleScript. Caller is responsible for content. */
  runAppleScript(script) {
    if (typeof script !== 'string') throw new Error('script must be a string');
    return osascript(script);
  },

  humanClick(x, y) {
    const cx = validateCoord(x, 'x');
    const cy = validateCoord(y, 'y');
    try {
      execFileSync('which', ['cliclick'], { stdio: 'ignore' });
      execFileSync('cliclick', [`m:${cx},${cy}`, `c:${cx},${cy}`]);
    } catch {
      osascript(`tell application "System Events" to click at {${cx}, ${cy}}`);
    }
  },

  drag(fromX, fromY, toX, toY) {
    const fx = validateCoord(fromX, 'fromX');
    const fy = validateCoord(fromY, 'fromY');
    const tx = validateCoord(toX, 'toX');
    const ty = validateCoord(toY, 'toY');
    try {
      execFileSync('which', ['cliclick'], { stdio: 'ignore' });
      execFileSync('cliclick', [`dd:${fx},${fy}`, `du:${tx},${ty}`]);
    } catch {
      osascript(`tell application "System Events"
        click at {${fx}, ${fy}}
        delay 0.2
        click at {${tx}, ${ty}}
      end tell`);
    }
  },

  scroll(appName, direction = 'down', amount = 5) {
    const name = validateAppName(appName);
    const dir = ['up','down','left','right'].includes(direction) ? direction : 'down';
    const amt = Math.max(1, Math.min(100, Number(amount) || 5));
    this.activate(name);
    const delta = dir === 'up' ? amt : (dir === 'down' ? -amt : 0);
    const py = `
import Quartz
from Quartz import CGEventCreateScrollWheelEvent, kCGScrollEventUnitPixel
import time
for i in range(${Math.ceil(amt / 3)}):
    event = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitPixel, 1, ${delta})
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(0.02)
`;
    try {
      execFileSync('python3', ['-c', py], { timeout: 5000 });
    } catch {
      const keyCode = dir === 'down' ? 125 : dir === 'up' ? 126 : dir === 'left' ? 123 : 124;
      for (let i = 0; i < Math.min(amt, 20); i++) {
        osascript(`tell application "System Events" to key code ${keyCode}`);
      }
    }
  },

  scrollTo(appName, position = 'top') {
    const name = validateAppName(appName);
    this.activate(name);
    if (position === 'top') this.pressKeys(name, 'cmd+up');
    else if (position === 'bottom') this.pressKeys(name, 'cmd+down');
  },
};


// ════════════════════════════════════════════════
//  Windows — PowerShell UI Automation Bridge
// ════════════════════════════════════════════════

const win = {
  /** Probe Windows elevation state. Returns { ok, elevated, hint? }. */
  checkPermissions() {
    try {
      const out = powershell(`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString()`);
      const elevated = out.trim() === 'True';
      return {
        ok: true,
        elevated,
        hint: elevated ? null : 'If the target app is running elevated (as Administrator), this script must also run elevated to interact with it.',
      };
    } catch (e) {
      return { ok: false, error: e.message, hint: 'PowerShell unavailable. Are you on Windows?' };
    }
  },

  /** Check whether `appName` matches any running window title. */
  isRunning(appName) {
    const name = validateAppName(appName);
    const safe = sanitizePS(name);
    try {
      const out = powershell(`(Get-Process | Where-Object {$_.MainWindowTitle -like '*${safe}*'} | Measure-Object).Count`);
      return parseInt(out.trim(), 10) > 0;
    } catch {
      return false;
    }
  },

  /** Enumerate displays. Returns [{id, x, y, width, height, primary}]. */
  getDisplays() {
    try {
      const raw = powershell(`
        Add-Type -AssemblyName System.Windows.Forms
        $screens = [System.Windows.Forms.Screen]::AllScreens
        $out = @()
        for ($i = 0; $i -lt $screens.Length; $i++) {
          $s = $screens[$i]
          $out += @{
            id = $i
            x = $s.Bounds.X
            y = $s.Bounds.Y
            width = $s.Bounds.Width
            height = $s.Bounds.Height
            primary = $s.Primary
          }
        }
        ConvertTo-Json -InputObject $out -Depth 3
      `);
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return { error: e.message, hint: 'Could not enumerate displays via System.Windows.Forms.Screen.' };
    }
  },

  _notRunningError(name) {
    return { error: 'App not running', app: name, hint: `Call openApp(${JSON.stringify(name)}) first, or start the app manually.` };
  },

  listApps() {
    const raw = powershell(`
      Add-Type -AssemblyName UIAutomationClient
      Get-Process | Where-Object {$_.MainWindowTitle -ne ''} |
      Select-Object ProcessName, MainWindowTitle, Id | ConvertTo-Json
    `);
    return JSON.parse(raw || '[]');
  },

  activate(appName) {
    const name = validateAppName(appName);
    const safe = sanitizePS(name);
    powershell(`
      $proc = Get-Process | Where-Object {$_.MainWindowTitle -like '*${safe}*'} | Select-Object -First 1
      if ($proc) {
        Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
        [Native.Win]::SetForegroundWindow($proc.MainWindowHandle)
      }
    `);
  },

  scanApp(appName) {
    const name = validateAppName(appName);
    if (!this.isRunning(name)) return this._notRunningError(name);
    const safe = sanitizePS(name);
    // No activate(): UI Automation reads from RootElement globally — scanning is headless.
    try {
      const raw = powershell(`
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $auto = [System.Windows.Automation.AutomationElement]
        $root = $auto::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${safe}')
        $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if (-not $app) { '[]'; return }
        $all = $app.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $result = @()
        foreach ($el in $all) {
          $n = $el.Current.Name
          $type = $el.Current.ControlType.ProgrammaticName
          $result += @{ role = $type; label = $n }
        }
        $result | ConvertTo-Json -Depth 3
      `);
      const parsed = JSON.parse(raw || '[]');
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return disambiguateLabels(arr);
    } catch (e) {
      return { error: e.message, hint: 'UI Automation tree unavailable for this app.' };
    }
  },

  /** Click a UI element by Name via UI Automation InvokePattern (background, no foregrounding).
   *  Accepts disambiguators: "OK (2)" targets the second matching "OK". */
  clickElement(appName, label) {
    const name = validateAppName(appName);
    const lbl = validateLabel(label);
    const { label: bare, index: targetIdx } = parseLabelIndex(lbl);
    if (!this.isRunning(name)) return this._notRunningError(name);
    const safeName = sanitizePS(name);
    const safeLbl = sanitizePS(bare);
    const raw = powershell(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $auto = [System.Windows.Automation.AutomationElement]
      $root = $auto::RootElement
      $appCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${safeName}')
      $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $appCond)
      if (-not $app) { ConvertTo-Json @{ clicked = $false; error = 'app not found' }; return }
      $lblCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${safeLbl}')
      $matches = $app.FindAll([System.Windows.Automation.TreeScope]::Descendants, $lblCond)
      if ($matches.Count -lt ${targetIdx}) {
        ConvertTo-Json @{ clicked = $false; error = 'element not found'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      $el = $matches[${targetIdx - 1}]
      $invoke = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        ConvertTo-Json @{ clicked = $true; method = 'InvokePattern'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      $toggle = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
        $toggle.Toggle()
        ConvertTo-Json @{ clicked = $true; method = 'TogglePattern'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      $sel = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
        $sel.Select()
        ConvertTo-Json @{ clicked = $true; method = 'SelectionItemPattern'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      ConvertTo-Json @{ clicked = $false; error = 'no invokable pattern'; matched = $matches.Count; index = ${targetIdx} }
    `);
    return JSON.parse(raw || '{}');
  },

  /** Type into a specific field by label via UI Automation ValuePattern.
   *  Accepts disambiguators: "Search (2)" targets the second matching "Search". */
  typeIntoField(appName, fieldLabel, text) {
    const name = validateAppName(appName);
    const lbl = validateLabel(fieldLabel, 'fieldLabel');
    const txt = validateLabel(typeof text === 'string' ? text : String(text), 'text');
    const { label: bare, index: targetIdx } = parseLabelIndex(lbl);
    if (!this.isRunning(name)) return this._notRunningError(name);
    const safeName = sanitizePS(name);
    const safeLbl = sanitizePS(bare);
    const safeTxt = sanitizePS(txt);
    const raw = powershell(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $auto = [System.Windows.Automation.AutomationElement]
      $root = $auto::RootElement
      $appCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${safeName}')
      $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $appCond)
      if (-not $app) { ConvertTo-Json @{ typed = $false; error = 'app not found' }; return }
      $lblCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${safeLbl}')
      $matches = $app.FindAll([System.Windows.Automation.TreeScope]::Descendants, $lblCond)
      if ($matches.Count -lt ${targetIdx}) {
        ConvertTo-Json @{ typed = $false; error = 'field not found'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      $el = $matches[${targetIdx - 1}]
      $val = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$val)) {
        if ($val.Current.IsReadOnly) { ConvertTo-Json @{ typed = $false; error = 'field is read-only'; matched = $matches.Count; index = ${targetIdx} }; return }
        $val.SetValue('${safeTxt}')
        ConvertTo-Json @{ typed = $true; method = 'ValuePattern'; matched = $matches.Count; index = ${targetIdx} }; return
      }
      ConvertTo-Json @{ typed = $false; error = 'field does not support ValuePattern'; matched = $matches.Count; index = ${targetIdx} }
    `);
    return JSON.parse(raw || '{}');
  },

  /** Type text. ASCII without SendKeys-reserved chars → SendKeys; everything else → clipboard paste. */
  typeText(appName, text) {
    const name = validateAppName(appName);
    const str = typeof text === 'string' ? text : String(text);
    this.activate(name);

    // SendKeys interprets +^%~(){}[] as modifiers. Anything Unicode or with those chars → clipboard paste.
    const sendKeysSafe = /^[A-Za-z0-9 \t\r\n\.,?!@#\$&\*\-_=:;'"\/\\<>|]*$/.test(str);
    if (!sendKeysSafe || str.length > 500) {
      win._pasteText(str);
      return;
    }
    powershell(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${sanitizePS(str)}')
    `);
  },

  /** Internal: paste text via clipboard + Ctrl+V. Best-effort restore of prior clipboard. */
  _pasteText(text) {
    const safeTxt = sanitizePS(text);
    powershell(`
      Add-Type -AssemblyName System.Windows.Forms
      $prev = $null
      try { $prev = Get-Clipboard -Raw -ErrorAction Stop } catch {}
      Set-Clipboard -Value '${safeTxt}'
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 150
      if ($prev -ne $null) { Set-Clipboard -Value $prev }
    `);
  },

  pressKeys(appName, shortcut) {
    const name = validateAppName(appName);
    if (typeof shortcut !== 'string') throw new Error('shortcut must be a string');
    this.activate(name);
    const map = { 'ctrl': '^', 'alt': '%', 'shift': '+', 'cmd': '^' };
    const parts = shortcut.split('+').map(s => s.trim());
    const key = parts.pop();
    if (!/^[A-Za-z0-9{}]+$/.test(key)) throw new Error(`Invalid key: ${key}`);
    const prefix = parts.map(p => map[p.toLowerCase()] || '').join('');
    powershell(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${sanitizePS(prefix + key)}')
    `);
  },

  screenshotApp(appName, outputPath) {
    const name = validateAppName(appName);
    if (typeof outputPath !== 'string' || outputPath.length > 1024) throw new Error('Invalid outputPath');
    this.activate(name);
    const safePath = sanitizePS(outputPath);
    powershell(`
      Add-Type -AssemblyName System.Windows.Forms
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen(0, 0, 0, 0, $screen.Size)
      $bitmap.Save('${safePath}')
    `);
    return outputPath;
  },

  openApp(appName) {
    const name = validateAppName(appName);
    powershell(`Start-Process '${sanitizePS(name)}'`);
  },

  /** Click a menu item: "File > Save As" or "Edit > Find > Find Next".
   *  Walks the menubar via UI Automation, expanding intermediate items via
   *  ExpandCollapsePattern and invoking the leaf via InvokePattern. Headless. */
  clickMenu(appName, menuPath) {
    const name = validateAppName(appName);
    if (typeof menuPath !== 'string') return { clicked: false, error: 'menuPath must be a string', hint: 'Format: "Menu > Item" or "Menu > Sub > Item"' };
    if (!this.isRunning(name)) return this._notRunningError(name);
    const parts = menuPath.split('>').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return { clicked: false, error: 'menuPath needs at least two segments', hint: 'Format: "Menu > Item" or "Menu > Sub > Item"' };
    for (const p of parts) validateLabel(p, 'menu segment');

    const safeName = sanitizePS(name);
    const segArr = parts.map(p => `'${sanitizePS(p)}'`).join(', ');
    const raw = powershell(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $auto = [System.Windows.Automation.AutomationElement]
      $segments = @(${segArr})
      $root = $auto::RootElement
      $appCond = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, '${safeName}')
      $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $appCond)
      if (-not $app) { ConvertTo-Json @{ clicked = $false; error = 'app not found' }; return }
      $current = $app
      for ($i = 0; $i -lt $segments.Count; $i++) {
        $segName = $segments[$i]
        $isLast = ($i -eq $segments.Count - 1)
        $cond = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $segName)
        $next = $current.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if (-not $next) {
          ConvertTo-Json @{ clicked = $false; error = "menu segment '$segName' not found"; depth = $i; hint = 'Check the menu path against scanApp() output. Names must match exactly.' }; return
        }
        if ($isLast) {
          $invoke = $null
          if ($next.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            $invoke.Invoke()
            ConvertTo-Json @{ clicked = $true; method = 'InvokePattern' }; return
          }
          ConvertTo-Json @{ clicked = $false; error = "menu item '$segName' is not invokable"; hint = 'Item exists but exposes no InvokePattern — try a child item or open the parent menu first.' }; return
        } else {
          $expand = $null
          if ($next.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
            $expand.Expand()
          }
          $current = $next
        }
      }
      ConvertTo-Json @{ clicked = $false; error = 'unreachable' }
    `);
    return JSON.parse(raw || '{}');
  },

  scroll(appName, direction = 'down', amount = 5) {
    const name = validateAppName(appName);
    const dir = ['up','down','left','right'].includes(direction) ? direction : 'down';
    const amt = Math.max(1, Math.min(100, Number(amount) || 5));
    this.activate(name);
    const key = dir === 'down' ? '{PGDN}' : dir === 'up' ? '{PGUP}' : dir === 'left' ? '{LEFT}' : '{RIGHT}';
    for (let i = 0; i < Math.min(amt, 10); i++) {
      powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')`);
    }
  },

  scrollTo(appName, position = 'top') {
    const name = validateAppName(appName);
    this.activate(name);
    const key = position === 'top' ? '{HOME}' : '{END}';
    powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^${key}')`);
  },
};


// ════════════════════════════════════════════════
//  Unified Desktop Agent API
// ════════════════════════════════════════════════

const desktop = PLATFORM === 'darwin' ? mac : PLATFORM === 'win32' ? win : null;

module.exports = {
  platform: PLATFORM,
  isSupported: !!desktop,

  withRetry,

  /** Probe permissions on the current platform. Call this first on startup. */
  checkPermissions: () => desktop?.checkPermissions?.() || { ok: false, hint: `Platform ${PLATFORM} not supported` },

  /** Check whether `appName` is currently running. */
  isRunning: (app) => desktop?.isRunning?.(app) ?? false,

  /** Enumerate displays. Returns [{id, x, y, width, height, primary}]. */
  getDisplays: () => desktop?.getDisplays?.() || [],

  /** Detect UI framework: 'electron' | 'java' | 'native' | 'unknown'. macOS only. */
  detectFramework: (app) => desktop?.detectFramework?.(app) || 'unknown',

  listApps: () => desktop?.listApps() || [],
  activate: (app) => desktop?.activate(app),
  openApp: (app) => desktop?.openApp(app),
  scanApp: (app) => desktop?.scanApp(app),
  clickElement: (app, label) => desktop?.clickElement?.(app, label),
  clickAt: (x, y) => desktop?.clickAt?.(x, y) ?? desktop?.humanClick?.(x, y),
  typeText: (app, text) => desktop?.typeText(app, text),
  typeIntoField: (app, field, text) => desktop?.typeIntoField?.(app, field, text),
  pressKeys: (app, shortcut) => desktop?.pressKeys(app, shortcut),
  clickMenu: (app, menuPath) => desktop?.clickMenu?.(app, menuPath),
  screenshotApp: (app, output) => desktop?.screenshotApp(app, output || `screenshot_${Date.now()}.png`),
  getFrontApp: () => desktop?.getFrontApp?.() || null,
  moveWindow: (app, x, y, w, h) => desktop?.moveWindow?.(app, x, y, w, h),
  runAppleScript: (script) => desktop?.runAppleScript?.(script),
  scroll: (app, direction, amount) => desktop?.scroll?.(app, direction, amount),
  scrollTo: (app, position) => desktop?.scrollTo?.(app, position),
  drag: (fromX, fromY, toX, toY) => desktop?.drag?.(fromX, fromY, toX, toY),

  synthesizeTools(elements) {
    if (!Array.isArray(elements)) return [];
    const tools = [];
    const buttons = elements.filter(e => e.type === 'button' || e.type === 'menu_item');
    const fields = elements.filter(e => ['text_input', 'text_area', 'search_field', 'combo_box'].includes(e.type));
    const menus = elements.filter(e => e.type === 'menu');

    buttons.forEach(b => {
      if (b.label) {
        const slug = b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (slug) tools.push({ name: `click_${slug}`, kind: 'action', element: b.label, description: b.description || `Click ${b.label}`, actions: b.actions || [] });
      }
    });

    fields.forEach(f => {
      if (f.label) {
        const slug = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (slug) tools.push({ name: `type_${slug}`, kind: 'input', element: f.label, description: f.description || `Type into ${f.label}`, params: { text: 'string' } });
      }
    });

    menus.forEach(m => {
      if (m.label) {
        tools.push({ name: `open_menu_${m.label.toLowerCase()}`, kind: 'menu', element: m.label, description: m.description || `Open ${m.label} menu` });
      }
    });

    return tools;
  },
};
