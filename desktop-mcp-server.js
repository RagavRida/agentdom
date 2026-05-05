#!/usr/bin/env node
/**
 * AgentDOM — Agent-Native MCP Server
 * 
 * Powered by the AgentPlatform SDK.
 * Auto-discovers and exposes ALL capabilities as MCP tools.
 * No manual tool definitions — the platform generates them.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { platform } = require('./agent-platform');
const desktop = require('./desktop-agent');
const { compile } = require('./compiler');
const { loadManifest, resolveAlias, mergeManifestTools } = require('./compiler/from-manifest');
const electronBridge = require('./desktop-agent/electron-bridge');
const launchCmd = require('./commands/launch');
const discovery = require('./discovery');

const server = new Server(
  { name: 'agentdom', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Per-session compiled tools (refreshed by scan_app) ──
let currentApp = null;
let currentManifest = null;   // loaded AGENTDOM.md manifest, if any
let dynamicTools = [];        // public-shape tools for tools/list
const dynamicMap = new Map(); // name → full tool object (incl. _internal) for dispatch

// ── Per-session Electron CDP attachment ──
// When an Electron app exposes --remote-debugging-port, scan_app attaches via
// puppeteer-core and registers DOM tools alongside the AX menubar tools.
let electronSession = null;
let electronInfo = null;      // { port, browserURL, source, browser, version }

async function disposeElectronSession() {
  if (electronSession) {
    try { await electronSession.dispose(); } catch (_) {}
  }
  electronSession = null;
  electronInfo = null;
}

/** Compile a DOM scan into MCP tools and prefix names with `dom_` so they
 *  don't collide with AX-derived tools (which often share labels for menu
 *  items vs. on-screen buttons). _internal.platform stays 'web' so the
 *  dispatcher can recognise the routing target. */
function compileElectronTools(domScan, appName) {
  if (!domScan) return { tools: [], ir: null };
  const compiled = compile(domScan, { from: 'web', to: 'mcp', appName });
  const tools = compiled.tools.map(t => {
    if (t.name.startsWith('dom_') || t.name === 'navigate') return t;
    return { ...t, name: `dom_${t.name}` };
  });
  return { tools, ir: compiled.ir };
}

function stripInternal(tools) {
  return tools.map(({ _internal, ...rest }) => rest);
}

async function refreshScan(appName, opts = {}) {
  const perm = desktop.checkPermissions();
  if (!perm.ok) {
    return { error: perm.error || 'Permission required', hint: perm.hint };
  }
  if (!desktop.isRunning(appName)) {
    return { error: 'App not running', app: appName, hint: `Open ${appName} or call open_app first.` };
  }
  const scan = desktop.scanApp(appName);
  if (scan && scan.error) return scan;

  const { ir, tools } = compile(scan, { from: 'desktop', to: 'mcp', appName });
  currentApp = appName;
  // Load app's AGENTDOM.md manifest (if shipped). Manifest tools are merged
  // ahead of auto-discovered tools and aliases are honored at dispatch time.
  currentManifest = loadManifest(appName);
  let merged = mergeManifestTools(tools, currentManifest, appName);

  // For Electron apps, also try to attach via CDP and merge DOM tools.
  // Disabled with { electron: false } — tests want the AX-only path.
  let electronReport = null;
  if (opts.electron !== false && (ir.meta.framework === 'electron' || opts.forceElectron)) {
    electronReport = await tryAttachElectron(appName, opts);
    if (electronSession) {
      try {
        const domScan = await electronSession.scanWindow({ urlIncludes: opts.urlIncludes });
        const { tools: domTools, ir: domIR } = compileElectronTools(domScan, appName);
        merged = merged.concat(domTools);
        electronReport = {
          ...electronReport,
          targets: await electronSession.listTargets(),
          dom: { forms: domIR.forms.length, actions: domIR.actions.length, navigation: domIR.navigation.length, tools: domTools.length },
        };
      } catch (e) {
        electronReport = { ...electronReport, scanError: e.message };
      }
    }
  }

  dynamicTools = stripInternal(merged);
  dynamicMap.clear();
  for (const t of merged) dynamicMap.set(t.name, t);

  try { server.notification({ method: 'notifications/tools/list_changed' }); } catch (_) {}

  return {
    app: appName,
    framework: ir.meta.framework,
    counts: { forms: ir.forms.length, actions: ir.actions.length, navigation: ir.navigation.length },
    manifest: currentManifest
      ? { source: currentManifest.sourcePath, tools: currentManifest.tools.length, aliases: Object.keys(currentManifest.aliases).length, notes: currentManifest.notes }
      : null,
    electron: electronReport,
    tools: dynamicTools,
  };
}

/** Probe / attach a CDP endpoint for an Electron app. Stores the session in
 *  module-scope state. Returns a small status object for the scan response. */
async function tryAttachElectron(appName, opts = {}) {
  await disposeElectronSession();
  let info = null;
  if (opts.port) {
    info = await electronBridge.probePort(opts.port);
    if (!info) return { attached: false, reason: `No CDP on port ${opts.port}.`, hint: 'Launch the app with --remote-debugging-port=<n>.' };
  } else {
    info = await electronBridge.detectCDP(appName);
    if (!info) return {
      attached: false,
      reason: 'No CDP endpoint detected.',
      hint: `Relaunch ${appName} with --remote-debugging-port=9222 (or pass { port } to attach_electron).`,
    };
  }
  try {
    electronSession = await electronBridge.attach({ port: info.port, hostname: info.hostname, app: appName });
    electronInfo = { ...info };
    return { attached: true, port: info.port, browser: info.Browser || info.browser, source: info.source };
  } catch (e) {
    electronSession = null;
    electronInfo = null;
    return { attached: false, reason: e.message, hint: 'puppeteer-core required; check it is installed.' };
  }
}

// ── Tools: meta + auto-compiled per scan ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_app',
      description: 'Scan a running desktop app and AUTO-GENERATE typed tools (authenticate, click_*, navigate, …). Call this whenever the active app changes or the UI navigates. For Electron apps launched with --remote-debugging-port, DOM tools (dom_click_*, dom_*) are also registered. After it returns, call tools/list again to get the new tool list — or just call the tool by name; the server emits notifications/tools/list_changed.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App name (e.g. "Slack", "Visual Studio Code")' },
          port: { type: 'number', description: 'Optional: explicit CDP port to attach for an Electron app.' },
          urlIncludes: { type: 'string', description: 'Optional: choose the renderer whose URL contains this substring.' },
        },
        required: ['app'],
      },
    },
    {
      name: 'attach_electron',
      description: 'Attach to a running Electron app via Chrome DevTools Protocol and register DOM tools. Auto-detects --remote-debugging-port from ~/.agentdom/sessions.json (written by launch_electron) or the process list. Pass { port } to override.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App name to attach to.' },
          port: { type: 'number', description: 'Explicit CDP port (e.g. 9222).' },
          urlIncludes: { type: 'string', description: 'Renderer URL substring to target.' },
        },
        required: ['app'],
      },
    },
    {
      name: 'discover_surfaces',
      description: 'Enumerate every surface this machine offers an agent right now: manifested desktop apps (running + framework), CLI tools (installed?), live CDP endpoints (sessions.json + process scan), and an inverted intent index grouping capabilities across apps (e.g. messaging.send → Slack, Discord). Use this BEFORE picking which app to drive — the intent index lets the LLM route by capability, not app name. Returns hints for the next action when something is installed but idle.',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'Optional: filter results to apps that declare this intent (e.g. "messaging.send").' },
          skipCDP: { type: 'boolean', description: 'Skip the CDP probe step (faster). Default false.' },
        },
      },
    },
    {
      name: 'navigate_browser',
      description: 'Navigate the currently-attached Electron/Chromium session to a URL and wait for the page to load. Use this AFTER launch_electron({ app: "Google Chrome" }) (or any Electron app exposing CDP) to drive the renderer to a specific site. Returns the page title and final URL after redirects. The next scan_app({ app }) will reflect the new DOM.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL (must include scheme).' },
          timeoutMs: { type: 'number', description: 'Navigation timeout in ms. Default 30000.' },
          urlIncludes: { type: 'string', description: 'Optional: target a specific renderer when the session has multiple tabs.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'launch_electron',
      description: 'Relaunch an Electron or Chromium app with --remote-debugging-port exposed and attach in one step. ZERO-SETUP path. Refuses to relaunch a running app unless { force: true } OR { parallel: true }. parallel mode auto-allocates a temp --user-data-dir so a second instance can run alongside the user\'s existing one — use this for Chromium browsers (Google Chrome, Edge, Brave) when you want a fresh sandbox without disturbing the user\'s current windows.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App bundle name (e.g. "Visual Studio Code", "Slack", "Cursor", "Google Chrome").' },
          force: { type: 'boolean', description: 'If true and the app is running without the flag, quit it first. Default false. WARNING: closes existing windows.' },
          parallel: { type: 'boolean', description: 'If true, launch a sandboxed second instance using a temp --user-data-dir. Only works for Chromium browsers; Electron apps with hardcoded data dirs will refuse to coexist. Default false.' },
          port: { type: 'number', description: 'Pin a specific CDP port (default: random free port).' },
          urlIncludes: { type: 'string', description: 'After attach, target the renderer whose URL contains this substring.' },
        },
        required: ['app'],
      },
    },
    {
      name: 'discover',
      description: 'Discover all available AgentDOM capabilities. Optionally filter by category: app_control, observe, interact, navigate, system, browser, dev.',
      inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'Filter by category' } } },
    },
    {
      name: 'observe',
      description: 'Observe the current state of the desktop: running apps, active app, clipboard, system info, time.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'batch',
      description: 'Execute multiple actions in sequence. Each action is { name, params, delay?, stopOnError? }.',
      inputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, params: { type: 'object' }, delay: { type: 'number' }, stopOnError: { type: 'boolean' } }, required: ['name'] },
            description: 'Array of actions to execute in sequence',
          },
        },
        required: ['actions'],
      },
    },
    // Auto-compiled tools from the most recent scan_app.
    ...dynamicTools,
    // Low-level platform capabilities (escape hatches — agent rarely needs these directly).
    ...platform.toMCPTools(),
  ],
}));

// ── Tool Execution ──
const DESKTOP_TIMEOUT = 30000; // 30s max per tool

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const execute = async () => {
    // Validate args exist
    if (args && typeof args !== 'object') {
      return { content: [{ type: 'text', text: 'Arguments must be an object' }], isError: true };
    }

    try {
      // Meta-tools
      if (name === 'scan_app') {
        if (!args?.app) {
          return { content: [{ type: 'text', text: 'scan_app requires { app: <name> }' }], isError: true };
        }
        const result = await refreshScan(args.app, { port: args.port, urlIncludes: args.urlIncludes });
        if (result.error) {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
        }
        return ok(result);
      }
      if (name === 'attach_electron') {
        if (!args?.app) {
          return { content: [{ type: 'text', text: 'attach_electron requires { app: <name> }' }], isError: true };
        }
        // forceElectron bypasses the framework=='electron' check so non-bundled
        // Electron apps (e.g. dev builds) still go through the CDP path.
        const result = await refreshScan(args.app, { port: args.port, urlIncludes: args.urlIncludes, forceElectron: true });
        if (result.error) {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
        }
        return ok(result);
      }
      if (name === 'discover_surfaces') {
        const result = await discovery.discover({ skipCDP: !!args?.skipCDP });
        if (args?.intent && typeof args.intent === 'string') {
          const want = args.intent.trim();
          const filtered = result.intents[want] || [];
          return ok({
            filter: { intent: want },
            providers: filtered,
            note: filtered.length === 0
              ? `No manifested app declares intent "${want}". Available intents: ${Object.keys(result.intents).join(', ')}`
              : `${filtered.length} app(s) declare "${want}".`,
          });
        }
        return ok(result);
      }
      if (name === 'navigate_browser') {
        if (!args?.url) {
          return { content: [{ type: 'text', text: 'navigate_browser requires { url }' }], isError: true };
        }
        if (!electronSession) {
          return { content: [{ type: 'text', text: 'No Electron/Chromium session attached. Call launch_electron({ app: "Google Chrome" }) first.' }], isError: true };
        }
        try {
          const r = await electronSession.navigate(args.url, { timeoutMs: args.timeoutMs, urlIncludes: args.urlIncludes });
          return ok(r);
        } catch (e) {
          return { content: [{ type: 'text', text: `navigate failed: ${e.message}` }], isError: true };
        }
      }
      if (name === 'launch_electron') {
        if (!args?.app) {
          return { content: [{ type: 'text', text: 'launch_electron requires { app: <name> }' }], isError: true };
        }
        // parallel:true → inject a temp --user-data-dir so we coexist with the user's instance.
        const extraArgs = [];
        if (args.parallel) {
          const dir = require('path').join(require('os').tmpdir(), `agentdom-parallel-${Date.now()}-${process.pid}`);
          require('fs').mkdirSync(dir, { recursive: true });
          extraArgs.push(`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check');
        }
        // Step 1: launch the app with the CDP flag (or reuse if already running with one).
        const launched = await launchCmd.launchApp(args.app, {
          force: !!args.force,
          port: args.port || null,
          quiet: true,
          extraArgs,
        });
        if (launched.error) {
          return { content: [{ type: 'text', text: JSON.stringify(launched, null, 2) }], isError: true };
        }
        // Step 2: attach + scan. detectCDP will pick up sessions.json on its next call.
        const result = await refreshScan(args.app, {
          port: launched.port,
          urlIncludes: args.urlIncludes,
          forceElectron: true,
        });
        if (result.error) {
          return { content: [{ type: 'text', text: JSON.stringify({ launched, attachError: result }, null, 2) }], isError: true };
        }
        return ok({ launched: { app: launched.app, port: launched.port, pid: launched.pid, reused: !!launched.reused }, ...result });
      }
      if (name === 'discover') {
        return ok(platform.discover(args?.category));
      }
      if (name === 'observe') {
        return ok(platform.observe());
      }
      if (name === 'batch') {
        if (!args?.actions || !Array.isArray(args.actions)) {
          return { content: [{ type: 'text', text: 'batch requires an "actions" array' }], isError: true };
        }
        if (args.actions.length > 50) {
          return { content: [{ type: 'text', text: 'batch limited to 50 actions' }], isError: true };
        }
        const result = await platform.batch(args.actions);
        return ok(result);
      }

      // Compiled tools from the most recent scan_app
      if (dynamicMap.has(name)) {
        const tool = dynamicMap.get(name);
        const result = await dispatchCompiledTool(tool, args || {});
        if (result && result.error) {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
        }
        return ok(result);
      }

      // Fallback: low-level platform capabilities
      const result = platform.execute(name, args || {});
      if (result.success === false) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
      }
      return ok(result.result || result);
    } catch (e) {
      console.error(`[AgentDOM Desktop] Tool '${name}' failed: ${e.message}`);
      return { content: [{ type: 'text', text: `Error in '${name}': ${e.message}` }], isError: true };
    }
  };

  // dispatchCompiledTool: route an auto-generated tool back to desktop primitives.
  async function dispatchCompiledTool(tool, callArgs) {
    if (!currentApp) {
      return { error: 'No active app', hint: 'Call scan_app({ app }) first to register tools.' };
    }
    const internal = tool._internal || {};

    // Manifest-declared tools — owner-supplied semantic intents.
    if (internal.kind === 'manifest') {
      const action = internal.manifest_action || {};
      if (Array.isArray(action.steps) && action.steps.length > 0) {
        return runManifestSteps(action, callArgs);
      }
      if (action.click) {
        const label = resolveAlias(action.click, currentManifest);
        const r = desktop.clickElement(currentApp, label);
        if (r && r.error) return r;
        return { dispatched: 'manifest:click', label, source: 'AGENTDOM.md', result: r };
      }
      return { error: `Manifest tool "${tool.name}" has no executable directive (expected click: or steps:)` };
    }

    if (internal.kind === 'action') {
      // Electron DOM tools — selector is a CSS path, route through the CDP session.
      if (internal.platform === 'web') {
        if (!electronSession) {
          return { error: 'No Electron session attached', hint: 'Call attach_electron({ app, port? }) first.' };
        }
        const r = internal.selector
          ? await electronSession.clickBySelector(internal.selector)
          : await electronSession.clickByText(internal.label);
        if (!r.clicked) return { error: `DOM click failed for "${internal.label}"`, detail: r };
        return { dispatched: 'electron:clickBySelector', selector: internal.selector, label: internal.label, result: r };
      }
      // Menu items have selectors like "menu/Calculator" — route to clickMenu
      // for deterministic dispatch. clickMenu opens the parent menu, then
      // clicks the item — works regardless of menu visibility.
      if (typeof internal.selector === 'string' && internal.selector.startsWith('menu/')) {
        const parent = internal.selector.slice(5);
        if (parent && parent !== 'menubar') {
          const r = desktop.clickMenu(currentApp, `${parent} > ${internal.label}`);
          if (r && r.error) return r;
          if (r && r.clicked === false) return { error: r.error || 'clickMenu reported failure', hint: r.hint };
          return { dispatched: 'clickMenu', menuPath: `${parent} > ${internal.label}`, result: r };
        }
      }
      const r = desktop.clickElement(currentApp, internal.label);
      if (r && r.error) return r;
      return { dispatched: 'clickElement', element: internal.label, result: r };
    }

    if (internal.kind === 'form') {
      // Electron DOM forms — fill via CDP, submit by clicking the form's submit selector.
      if (internal.platform === 'web') {
        if (!electronSession) {
          return { error: 'No Electron session attached', hint: 'Call attach_electron({ app, port? }) first.' };
        }
        const fieldByName = new Map((internal.fields || []).map(f => [f.name, f]));
        const typed = [];
        for (const [argName, value] of Object.entries(callArgs)) {
          const field = fieldByName.get(argName);
          if (!field) continue;
          const r = await electronSession.typeIntoField({
            selector: field.selector,
            label: field.label || field.name,
            text: String(value ?? ''),
          });
          typed.push({ field: field.name, ok: !!r.typed, error: r.error });
          if (!r.typed) return { error: `dom type "${field.name}" failed`, detail: r };
        }
        let submitResult = null;
        if (internal.submitAction?.selector) {
          submitResult = await electronSession.clickBySelector(internal.submitAction.selector);
        } else if (internal.submitAction?.label) {
          submitResult = await electronSession.clickByText(internal.submitAction.label);
        }
        return { dispatched: 'electron:form', typed, submit: submitResult };
      }
      const fieldByName = new Map((internal.fields || []).map(f => [f.name, f]));
      const typed = [];
      for (const [argName, value] of Object.entries(callArgs)) {
        const field = fieldByName.get(argName);
        if (!field) continue;
        const r = desktop.typeIntoField(currentApp, field.label || field.name, String(value ?? ''));
        typed.push({ field: field.name, ok: !!r?.typed, error: r?.error });
        if (r && r.error) return { error: `typeIntoField "${field.name}" failed`, detail: r };
      }
      let submitResult = null;
      if (internal.submitAction && internal.submitAction.label) {
        submitResult = desktop.clickElement(currentApp, internal.submitAction.label);
        if (submitResult && submitResult.error) return submitResult;
      }
      return { dispatched: 'form', typed, submit: submitResult };
    }

    if (internal.kind === 'navigation') {
      if (!callArgs.target) return { error: 'navigate requires { target }' };
      const link = (internal.links || []).find(l => l.label === callArgs.target);
      if (!link) return { error: `Unknown navigation target "${callArgs.target}"`, hint: 'Re-scan: the menu may have changed.' };
      const r = desktop.clickElement(currentApp, link.label);
      if (r && r.error) return r;
      return { dispatched: 'navigation', target: link.label, result: r };
    }

    return { error: `Unknown _internal.kind: ${internal.kind}` };
  }

  // ── Manifest step executor ──
  // Step grammar (v1):
  //   - click: <label-or-${param}>
  //   - type: { field: <label>, text: <text-or-${param}> }
  //   - read: <"display"|"clipboard"|field-label>
  //   - expression_chars: <text-or-${param}>   (split chars, alias-resolve each, click)
  //   - wait: <ms>
  // Step grammar v2 (Electron, requires attach_electron first):
  //   - dom_click: <css-selector>           (click via CDP)
  //   - dom_click_text: <visible-text>      (find by inner text + click)
  //   - dom_type: { selector|label, text }  (focus + dispatch input event)
  //   - dom_read: <css-selector>            (innerText of first match)
  //   - press_keys: "Meta+Shift+P"          (CDP keyboard chord)
  //   - eval: <js-expression>               (raw JS in renderer; sparingly)
  // ${name} substitution: replaced with String(callArgs[name] ?? '').
  // Returns { ok|error, steps: [...trace], result: <last read value> }.

  function subst(value, callArgs) {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{(\w+)\}/g, (_, k) => {
      const v = callArgs[k];
      return v === undefined || v === null ? '' : String(v);
    });
  }

  function stripBidi(s) {
    return typeof s === 'string' ? s.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim() : s;
  }

  function readState(target) {
    if (target === 'clipboard') {
      try { return require('child_process').execFileSync('pbpaste', { encoding: 'utf-8' }); }
      catch { return null; }
    }
    const els = desktop.scanApp(currentApp);
    if (els.error) return null;
    if (target === 'display' || target === 'last_number') {
      // macOS Calculator on Tahoe puts the displayed value in AXValue with a
      // generic "text (N)" label after disambiguation, not in AXTitle. Earlier
      // versions exposed the digits as the label directly. Check both.
      const candidates = els
        .filter(e => e.type === 'label')
        .flatMap(e => [e.value, e.label])
        .filter(v => typeof v === 'string' && v.length)
        .map(stripBidi);
      const numeric = candidates.filter(l => /^-?[\d,]+(\.\d+)?$/.test(l));
      return numeric[numeric.length - 1] ?? null;
    }
    // Otherwise, target is a field/element label — return its value.
    const f = els.find(e => e.label === target);
    return f ? (f.value ?? f.label) : null;
  }

  async function runManifestSteps(action, callArgs) {
    const trace = [];
    let lastRead = null;
    for (let i = 0; i < action.steps.length; i++) {
      const step = action.steps[i];
      if (step.click != null) {
        const label = resolveAlias(subst(step.click, callArgs), currentManifest);
        const r = desktop.clickElement(currentApp, label);
        trace.push({ step: i, click: label, ok: !!r.clicked });
        if (!r.clicked) return { error: `step ${i} click "${label}" failed`, detail: r, trace };
        await new Promise(res => setTimeout(res, 130));
      } else if (step.type) {
        const field = subst(step.type.field, callArgs);
        const text = subst(step.type.text, callArgs);
        const r = desktop.typeIntoField(currentApp, field, text);
        trace.push({ step: i, type: field, ok: !!r.typed });
        if (!r.typed) return { error: `step ${i} type into "${field}" failed`, detail: r, trace };
        await new Promise(res => setTimeout(res, 150));
      } else if (step.read !== undefined) {
        lastRead = readState(subst(step.read, callArgs));
        trace.push({ step: i, read: step.read, value: lastRead });
      } else if (step.expression_chars !== undefined) {
        const text = subst(step.expression_chars, callArgs);
        for (const ch of text) {
          if (ch === ' ') continue;
          const label = resolveAlias(ch, currentManifest);
          const r = desktop.clickElement(currentApp, label);
          if (!r.clicked) {
            trace.push({ step: i, char: ch, label, ok: false });
            return { error: `expression char "${ch}" → "${label}" failed`, detail: r, trace };
          }
          await new Promise(res => setTimeout(res, 90));
        }
        trace.push({ step: i, expression_chars: text, ok: true });
      } else if (step.wait !== undefined) {
        await new Promise(res => setTimeout(res, Number(step.wait) || 0));
        trace.push({ step: i, waited: step.wait });
      } else if (step.dom_click != null) {
        if (!electronSession) return { error: `step ${i} dom_click needs attach_electron first`, trace };
        const selector = subst(step.dom_click, callArgs);
        const r = await electronSession.clickBySelector(selector);
        trace.push({ step: i, dom_click: selector, ok: !!r.clicked });
        if (!r.clicked) return { error: `step ${i} dom_click "${selector}" failed`, detail: r, trace };
        await new Promise(res => setTimeout(res, 130));
      } else if (step.dom_click_text != null) {
        if (!electronSession) return { error: `step ${i} dom_click_text needs attach_electron first`, trace };
        const text = subst(step.dom_click_text, callArgs);
        const r = await electronSession.clickByText(text);
        trace.push({ step: i, dom_click_text: text, ok: !!r.clicked });
        if (!r.clicked) return { error: `step ${i} dom_click_text "${text}" failed`, detail: r, trace };
        await new Promise(res => setTimeout(res, 130));
      } else if (step.dom_type) {
        if (!electronSession) return { error: `step ${i} dom_type needs attach_electron first`, trace };
        const selector = subst(step.dom_type.selector, callArgs);
        const label = subst(step.dom_type.label, callArgs);
        const text = subst(step.dom_type.text, callArgs);
        const r = await electronSession.typeIntoField({ selector, label, text });
        trace.push({ step: i, dom_type: selector || label, ok: !!r.typed });
        if (!r.typed) return { error: `step ${i} dom_type into "${selector || label}" failed`, detail: r, trace };
        await new Promise(res => setTimeout(res, 150));
      } else if (step.dom_read != null) {
        if (!electronSession) return { error: `step ${i} dom_read needs attach_electron first`, trace };
        const selector = subst(step.dom_read, callArgs);
        lastRead = await electronSession.readBySelector(selector);
        trace.push({ step: i, dom_read: selector, value: lastRead });
      } else if (step.press_keys != null) {
        if (!electronSession) return { error: `step ${i} press_keys needs attach_electron first`, trace };
        const chord = subst(step.press_keys, callArgs);
        const r = await electronSession.pressKey(chord);
        trace.push({ step: i, press_keys: chord, ok: true });
        await new Promise(res => setTimeout(res, 120));
      } else if (step.eval != null) {
        if (!electronSession) return { error: `step ${i} eval needs attach_electron first`, trace };
        const expr = subst(step.eval, callArgs);
        const r = await electronSession.evalJS(expr);
        trace.push({ step: i, eval: expr.slice(0, 80), ok: !!r.ok });
        if (!r.ok) return { error: `step ${i} eval failed: ${r.error}`, trace };
        lastRead = r.value;
      } else {
        trace.push({ step: i, skipped: 'unrecognized', step_obj: step });
      }
    }
    return { ok: true, dispatched: 'manifest:steps', source: 'AGENTDOM.md', trace, result: lastRead };
  }

  // Per-tool timeout
  try {
    return await Promise.race([
      execute(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Tool '${name}' timed out after ${DESKTOP_TIMEOUT}ms`)), DESKTOP_TIMEOUT)),
    ]);
  } catch (e) {
    console.error(`[AgentDOM Desktop] Timeout: ${e.message}`);
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
});

// ── Resources: Agent can read platform docs ──
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'agentdom://capabilities', name: 'All Capabilities', description: 'Full list of AgentDOM capabilities with parameters', mimeType: 'application/json' },
    { uri: 'agentdom://state', name: 'Current State', description: 'Current desktop state: apps, clipboard, system info', mimeType: 'application/json' },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'agentdom://capabilities') {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(platform.discover(), null, 2) }] };
  }
  if (uri === 'agentdom://state') {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(platform.observe(), null, 2) }] };
  }
  return { contents: [{ uri, mimeType: 'text/plain', text: 'Unknown resource' }] };
});

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

// ── Graceful Shutdown ──
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[AgentDOM Desktop] ${signal} received, shutting down...`);
  try { await disposeElectronSession(); } catch (_) {}
  try { await server.close().catch(() => {}); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[AgentDOM Desktop] Uncaught exception:', e.message);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (e) => {
  console.error('[AgentDOM Desktop] Unhandled rejection:', e);
});

// ── Start ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const caps = platform.discover();
  console.error(`AgentDOM Platform MCP Server v3.1.0`);
  console.error(`Runtime: ${caps.runtime} | Capabilities: ${caps.capabilities.length}`);
  console.error(`Categories: ${caps.categories.join(', ')}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
