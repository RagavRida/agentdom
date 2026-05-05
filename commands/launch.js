/**
 * `agentdom launch <App>` — relaunch an Electron app with CDP exposed.
 *
 * Closes the one-time setup gap that otherwise blocks Slack / VS Code /
 * Cursor / Notion / Antigravity from being driven by AgentDOM. Allocates a
 * free port, runs `open -a "App" --args --remote-debugging-port=<port>`,
 * waits for the CDP endpoint to respond, and persists the session to
 * ~/.agentdom/sessions.json so subsequent scan_app calls auto-attach
 * without process-list scanning.
 *
 * Refuses to relaunch an app that's already running without --force, since
 * killing live windows would clobber the user's state.
 *
 * Programmatic API: `require('./commands/launch').run(['App Name'])` resolves
 * to { ok, app, port, pid } or { error, hint }.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { atomicWrite } = require('../lib/resilience');

const SESSIONS_DIR = path.join(os.homedir(), '.agentdom');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');

const C = { green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m', r: '\x1b[0m' };
const ok = m => process.stdout.write(`  ${C.green}✓${C.r} ${m}\n`);
const fail = m => process.stderr.write(`  ${C.red}✗${C.r} ${m}\n`);
const info = m => process.stdout.write(`  ${C.cyan}→${C.r} ${m}\n`);
const dim = m => process.stdout.write(`  ${C.gray}${m}${C.r}\n`);

// ── Sessions file ───────────────────────────────────────────────────────────

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

function readSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeSessions(list) {
  ensureSessionsDir();
  atomicWrite(SESSIONS_FILE, list, { mode: 0o600 });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Drop entries whose pid is gone. Used everywhere that reads sessions. */
function gcSessions(list = readSessions()) {
  const live = list.filter(s => s.pid && pidAlive(s.pid));
  if (live.length !== list.length) writeSessions(live);
  return live;
}

function upsertSession(entry) {
  const list = gcSessions();
  const filtered = list.filter(s => s.app !== entry.app);
  filtered.push(entry);
  writeSessions(filtered);
}

function findSession(app) {
  return gcSessions().find(s => s.app === app) || null;
}

// ── App + port discovery ────────────────────────────────────────────────────

function bundlePathFor(appName) {
  const candidates = [
    `/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
    path.join(os.homedir(), 'Applications', `${appName}.app`),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // Fallback: ask LaunchServices. stderr suppressed because the typical miss
  // case prints "execution error: Can't get application…" which scares users.
  try {
    const out = execFileSync('osascript', ['-e', `POSIX path of (path to application "${appName.replace(/"/g, '\\"')}")`], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}
  return null;
}

/** Returns the framework family this bundle ships, or null if it can't host
 *  a CDP endpoint. Both Electron and Chromium-based browsers (Chrome, Edge,
 *  Brave, Arc, etc.) speak identical CDP — the launcher works for both. */
function detectCdpFramework(bundlePath) {
  const fwDir = path.join(bundlePath, 'Contents/Frameworks');
  if (!fs.existsSync(fwDir)) return null;
  if (fs.existsSync(path.join(fwDir, 'Electron Framework.framework'))) return 'electron';
  // Chromium browsers ship a "<Vendor> Framework.framework" alongside Helpers.
  // Match any *.framework that has a Helpers/<*_crashpad_handler> binary —
  // that's the Chromium tell that's stable across Chrome/Edge/Brave/Arc.
  for (const ent of fs.readdirSync(fwDir)) {
    if (!ent.endsWith('.framework')) continue;
    const helpers = path.join(fwDir, ent, 'Helpers');
    if (!fs.existsSync(helpers)) continue;
    if (fs.readdirSync(helpers).some(f => f.endsWith('crashpad_handler'))) return 'chromium';
  }
  return null;
}

function isElectronBundle(bundlePath) {
  return detectCdpFramework(bundlePath) !== null;
}

function isAppRunning(appName) {
  try {
    const out = execFileSync('pgrep', ['-fl', `${appName}.app/Contents/MacOS`], { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0 ? out.trim().split('\n').map(l => Number(l.split(/\s+/)[0])).filter(Boolean) : [];
  } catch { return []; }
}

function isAppRunningWithFlag(appName, port) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf-8', timeout: 3000 });
    const needle = `${appName}.app/Contents/MacOS`;
    const flag = `--remote-debugging-port=${port}`;
    for (const line of out.split('\n')) {
      if (line.includes(needle) && line.includes(flag)) {
        const m = line.match(/^\s*(\d+)/);
        if (m) return Number(m[1]);
      }
    }
  } catch (_) {}
  return null;
}

/** Find a free TCP port by binding ephemeral and reading the OS-assigned one.
 *  Caveat: tiny race between close() and the actual launch picking it up. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function probeCDP(port, hostname = '127.0.0.1', timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://${hostname}:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function waitForCDP(port, { totalMs = 15000, stepMs = 300 } = {}) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const info = await probeCDP(port);
    if (info) return info;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return null;
}

// ── Quitting (only when --force) ────────────────────────────────────────────

function quitAppGracefully(appName) {
  try {
    execFileSync('osascript', ['-e', `tell application "${appName.replace(/"/g, '\\"')}" to quit`], { timeout: 5000 });
    // Wait up to 6s for it to exit.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (isAppRunning(appName).length === 0) return true;
      execFileSync('sleep', ['0.3']);
    }
  } catch (_) {}
  return isAppRunning(appName).length === 0;
}

// ── Public ──────────────────────────────────────────────────────────────────

/** Launch an Electron app with CDP exposed. Returns a session record on
 *  success, an error envelope on failure. Never throws synchronously. */
async function launchApp(appName, opts = {}) {
  const { force = false, port: requestedPort = null, quiet = false, extraArgs = [] } = opts;
  const log = quiet ? { ok: () => {}, fail: () => {}, info: () => {}, dim: () => {} } : { ok, fail, info, dim };

  if (!appName || typeof appName !== 'string') {
    return { error: 'launch requires an app name', hint: 'Usage: agentdom launch "Visual Studio Code"' };
  }

  const bundlePath = bundlePathFor(appName);
  if (!bundlePath) {
    return { error: `App "${appName}" not found`, hint: 'Check the spelling — it must match the bundle name (e.g. "Visual Studio Code", not "vscode").' };
  }
  const framework = detectCdpFramework(bundlePath);
  if (!framework) {
    return { error: `${appName} is not an Electron or Chromium app`, hint: 'AgentDOM\'s native AX bridge already covers AppKit/SwiftUI apps. The CDP launch path is for Electron and Chromium-based browsers.' };
  }
  log.info(`Bundle: ${bundlePath} (${framework})`);

  // Already-running checks.
  const port = requestedPort || await pickFreePort();
  const existingFlagged = isAppRunningWithFlag(appName, port);
  if (existingFlagged) {
    const verify = await probeCDP(port);
    if (verify) {
      const session = { app: appName, bundlePath, pid: existingFlagged, port, hostname: '127.0.0.1', launched_at: new Date().toISOString(), source: 'reused' };
      upsertSession(session);
      log.ok(`${appName} already running with CDP on ${port} — reused`);
      return { ok: true, ...session, reused: true };
    }
  }

  // A caller-supplied --user-data-dir means we're spawning a parallel
  // instance against a fresh profile, so the running-app guard doesn't
  // apply — the existing instance and ours won't share state.
  const isParallelInstance = extraArgs.some(a => typeof a === 'string' && a.startsWith('--user-data-dir='));

  const runningPids = isAppRunning(appName);
  if (runningPids.length > 0 && !force && !isParallelInstance) {
    return {
      error: `${appName} is already running without --remote-debugging-port`,
      hint: 'Quit it manually and re-run, or pass --force to relaunch (this WILL close existing windows; unsaved state may be lost).',
      pids: runningPids,
    };
  }
  if (runningPids.length > 0 && force) {
    log.info(`Quitting existing ${appName} (force)…`);
    if (!quitAppGracefully(appName)) {
      return { error: `Could not quit ${appName}`, hint: 'Quit it manually and retry.' };
    }
    log.ok(`${appName} quit cleanly`);
  }

  // Launch via `open -na` so we get a fresh process and `--args` are forwarded.
  log.info(`Launching with --remote-debugging-port=${port}…`);
  const args = ['-na', appName, '--args', `--remote-debugging-port=${port}`, ...extraArgs];
  try {
    execFileSync('open', args, { encoding: 'utf-8', timeout: 5000 });
  } catch (e) {
    return { error: `open(1) failed: ${e.message}`, hint: 'Try launching from Terminal directly: open -na "<App>" --args --remote-debugging-port=<port>' };
  }

  // Wait for CDP to come up.
  const cdp = await waitForCDP(port);
  if (!cdp) {
    return {
      error: `${appName} launched but CDP never came up on port ${port}`,
      hint: 'Some hardened Electron builds strip Chromium debug flags. Check manifest.notes for known-incompatible apps.',
    };
  }
  log.ok(`CDP ready: ${cdp.Browser || 'Electron'} on port ${port}`);

  // Find the new pid via process-list (open -na fork+execs the bundle).
  const newPids = isAppRunning(appName);
  const pid = newPids[newPids.length - 1] || null;

  const session = {
    app: appName,
    bundlePath,
    pid,
    port,
    hostname: '127.0.0.1',
    launched_at: new Date().toISOString(),
    cdp: { Browser: cdp.Browser, Protocol: cdp['Protocol-Version'] },
  };
  upsertSession(session);
  log.ok(`Session saved: ${SESSIONS_FILE}`);
  return { ok: true, ...session };
}

// ── CLI entry ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { force: false, port: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  return { opts, appName: rest.join(' ').trim() };
}

function help() {
  process.stdout.write(`
${C.cyan}agentdom launch${C.r} <App> [--force] [--port N]

Relaunch an Electron app with Chrome DevTools Protocol exposed so AgentDOM
can drive its workbench (DOM, not just menubar).

Arguments:
  <App>          Bundle name, e.g. "Visual Studio Code", "Slack", "Cursor".
                 Must match /Applications/<App>.app exactly.

Options:
  --force, -f    Quit the app if it's already running without the flag
                 (unsaved state may be lost).
  --port N       Pin a specific debug port (default: random free port).

Output: writes ~/.agentdom/sessions.json so future scan_app calls auto-attach.

Examples:
  agentdom launch "Visual Studio Code"
  agentdom launch Slack --force
  agentdom launch Cursor --port 9222
`);
}

async function run(argv = []) {
  const { opts, appName } = parseArgs(argv);
  if (opts.help || !appName) { help(); process.exit(opts.help ? 0 : 1); }
  const result = await launchApp(appName, opts);
  if (result.error) {
    fail(result.error);
    if (result.hint) dim(result.hint);
    process.exit(2);
  }
  ok(`${result.app} ready on CDP port ${result.port} (pid ${result.pid ?? 'unknown'})`);
  dim(`Now any agent connected to the desktop MCP can call scan_app({ app: "${result.app}" }) and the bridge auto-attaches.`);
}

module.exports = {
  run,
  launchApp,
  // Exported for sessions.js + electron-bridge:
  readSessions,
  writeSessions,
  gcSessions,
  findSession,
  upsertSession,
  SESSIONS_FILE,
  SESSIONS_DIR,
};
