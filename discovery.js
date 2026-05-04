/**
 * AgentDOM surface discovery — Phase 2 of the autonomy roadmap.
 *
 * Returns one envelope listing every surface an agent could drive on this
 * machine right now: running desktop apps, CLI binaries with manifests, CDP
 * endpoints (sessions.json + process scan), plus an inverted intent index
 * grouping capabilities across apps.
 *
 * Used by the desktop-mcp-server's `discover_surfaces` meta-tool. Pure
 * read-only — never spawns processes or attaches to anything.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const desktop = require('./desktop-agent');
const electronBridge = require('./desktop-agent/electron-bridge');
const { listManifests, loadManifest } = require('./compiler/from-manifest');
const launchCmd = require('./commands/launch');

// ── Helpers ─────────────────────────────────────────────────────────────────

function commandOnPath(name) {
  // Prefer `which -a` so we get every match in $PATH; first wins.
  try {
    const out = execFileSync('which', [name], { encoding: 'utf-8', timeout: 1500 }).trim();
    return out || null;
  } catch { return null; }
}

function isAppRunning(name) {
  // Mirror commands/launch.js — pgrep of the bundle's executable path.
  try {
    const out = execFileSync('pgrep', ['-fl', `${name}.app/Contents/MacOS`], { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch { return false; }
}

// ── Discovery sources ───────────────────────────────────────────────────────

/** Index manifests by stem name for cross-referencing. */
function indexManifests() {
  const all = listManifests();
  const byStem = new Map();
  const byApp = new Map();
  for (const m of all) {
    byStem.set(m.stem.toLowerCase(), m);
    byApp.set(m.app.toLowerCase(), m);
  }
  return { all, byStem, byApp };
}

/** Desktop apps: every manifested desktop app, plus its running/framework state. */
function discoverDesktopApps(manifestIdx) {
  const out = [];
  for (const m of manifestIdx.all) {
    if (m.platform && m.platform !== 'desktop') continue;
    const running = isAppRunning(m.app);
    let framework = m.framework || null;
    if (running && !framework) {
      try { framework = desktop.detectFramework(m.app); } catch (_) {}
    }
    out.push({
      name: m.app,
      running,
      framework,
      manifest: { tools: m.toolCount, intents: m.intents, sourcePath: m.sourcePath, override: m.override },
    });
  }
  return out;
}

/** CLI tools: every manifested CLI plus whether the binary exists in $PATH. */
function discoverCliTools(manifestIdx) {
  const out = [];
  for (const m of manifestIdx.all) {
    if (m.platform !== 'cli') continue;
    const where = commandOnPath(m.stem) || commandOnPath(m.app);
    out.push({
      name: m.app,
      installed: !!where,
      path: where,
      manifest: { tools: m.toolCount, intents: m.intents, sourcePath: m.sourcePath, override: m.override },
    });
  }
  return out;
}

/** CDP endpoints: persisted sessions (from sessions.json) + process-list scan
 *  for any --remote-debugging-port=N flags AgentDOM didn't launch. */
async function discoverCDPEndpoints(manifestIdx) {
  const seen = new Map();
  // 1. Persisted by `agentdom launch`.
  for (const s of launchCmd.gcSessions()) {
    seen.set(s.port, {
      port: s.port,
      hostname: s.hostname || '127.0.0.1',
      source: 'sessions-file',
      app: s.app,
      pid: s.pid,
      launched_at: s.launched_at,
      cdp: s.cdp || null,
      manifested: manifestIdx.byApp.has(s.app.toLowerCase()),
    });
  }
  // 2. Process-list scan — catches manual launches.
  let procs = [];
  try { procs = electronBridge.discoverPortsFromProcessList(''); } catch (_) {}
  for (const { port, pid, command } of procs) {
    if (seen.has(port)) continue;
    let appGuess = null;
    const m = command.match(/\/Applications\/([^/]+?)\.app\//);
    if (m) appGuess = m[1];
    seen.set(port, {
      port,
      hostname: '127.0.0.1',
      source: 'process-list',
      pid,
      app: appGuess,
      manifested: appGuess ? manifestIdx.byApp.has(appGuess.toLowerCase()) : false,
    });
  }
  // 3. Liveness probe (non-blocking) — best-effort, ~600ms each.
  const live = [];
  for (const ep of seen.values()) {
    let info = null;
    try { info = await electronBridge.probePort(ep.port, { hostname: ep.hostname }); } catch (_) {}
    live.push({ ...ep, alive: !!info, browser: info?.Browser || ep.cdp?.Browser || null });
  }
  return live;
}

/** Group every manifested intent by its name → list of providing apps. */
function buildIntentIndex(manifestIdx) {
  const out = {};
  for (const m of manifestIdx.all) {
    for (const intent of m.intents) {
      (out[intent] = out[intent] || []).push({
        app: m.app,
        platform: m.platform,
        manifestPath: m.sourcePath,
      });
    }
  }
  return out;
}

/** Build human-readable hints for the agent: actionable next steps based on
 *  what's installed but not yet running, what's running but not attached,
 *  and any mismatches. */
function buildHints({ desktopApps, cliTools, cdpEndpoints }) {
  const hints = [];
  for (const a of desktopApps) {
    if (!a.running) {
      const next = a.framework === 'electron'
        ? `Call launch_electron({ app: "${a.name}" }) — picks a free port, exposes CDP, and registers DOM tools in one step.`
        : `Call scan_app({ app: "${a.name}" }) after opening it (the AX bridge covers SwiftUI/AppKit natively).`;
      hints.push(`${a.name} is not running. ${next}`);
      continue;
    }
    if (a.framework === 'electron' && !cdpEndpoints.some(e => e.app === a.name && e.alive)) {
      hints.push(`${a.name} is running but no CDP endpoint is exposed. Call launch_electron({ app: "${a.name}", force: true }) to relaunch with the flag (unsaved state may be lost), or attach_electron({ app, port }) if you launched it manually.`);
    }
  }
  for (const c of cliTools) {
    if (!c.installed) hints.push(`${c.name} CLI manifest is bundled but the binary is not on $PATH. Install ${c.name} to enable these tools.`);
  }
  for (const e of cdpEndpoints) {
    if (e.alive && e.app && !e.manifested) {
      hints.push(`${e.app} exposes CDP on port ${e.port} but no manifest is bundled. Call attach_electron({ app: "${e.app}", port: ${e.port} }) and the auto-scanner will produce DOM tools from the live page.`);
    }
  }
  return hints;
}

// ── Public ──────────────────────────────────────────────────────────────────

/** One-shot discovery. Returns:
 *    {
 *      desktop_apps: [{ name, running, framework, manifest }],
 *      cli_tools:    [{ name, installed, path, manifest }],
 *      cdp_endpoints:[{ port, app, source, alive, ... }],
 *      manifests:    [{ app, platform, framework, toolCount, intents, sourcePath }],
 *      intents:      { 'messaging.send': [{ app, platform, ... }, ...], ... },
 *      hints:        [string]
 *    }
 */
async function discover(opts = {}) {
  const manifestIdx = indexManifests();
  const desktopApps = discoverDesktopApps(manifestIdx);
  const cliTools = discoverCliTools(manifestIdx);
  const cdpEndpoints = opts.skipCDP ? [] : await discoverCDPEndpoints(manifestIdx);
  const intents = buildIntentIndex(manifestIdx);
  const hints = buildHints({ desktopApps, cliTools, cdpEndpoints });
  return {
    summary: {
      desktop_apps: desktopApps.length,
      desktop_running: desktopApps.filter(a => a.running).length,
      cli_tools: cliTools.length,
      cli_installed: cliTools.filter(c => c.installed).length,
      cdp_endpoints: cdpEndpoints.length,
      cdp_alive: cdpEndpoints.filter(e => e.alive).length,
      intents: Object.keys(intents).length,
      manifests: manifestIdx.all.length,
    },
    desktop_apps: desktopApps,
    cli_tools: cliTools,
    cdp_endpoints: cdpEndpoints,
    manifests: manifestIdx.all,
    intents,
    hints,
  };
}

module.exports = { discover };
