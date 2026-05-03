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

const server = new Server(
  { name: 'agentdom', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Per-session compiled tools (refreshed by scan_app) ──
let currentApp = null;
let currentManifest = null;   // loaded AGENTDOM.md manifest, if any
let dynamicTools = [];        // public-shape tools for tools/list
const dynamicMap = new Map(); // name → full tool object (incl. _internal) for dispatch

function stripInternal(tools) {
  return tools.map(({ _internal, ...rest }) => rest);
}

async function refreshScan(appName) {
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
  const merged = mergeManifestTools(tools, currentManifest, appName);
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
    tools: dynamicTools,
  };
}

// ── Tools: meta + auto-compiled per scan ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_app',
      description: 'Scan a running desktop app and AUTO-GENERATE typed tools (authenticate, click_*, navigate, …). Call this whenever the active app changes or the UI navigates. After it returns, call tools/list again to get the new tool list — or just call the tool by name; the server emits notifications/tools/list_changed.',
      inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name (e.g. "Slack", "Finder")' } }, required: ['app'] },
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
        const result = await refreshScan(args.app);
        if (result.error) {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
        }
        return ok(result);
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
      if (action.click) {
        const label = resolveAlias(action.click, currentManifest);
        const r = desktop.clickElement(currentApp, label);
        if (r && r.error) return r;
        return { dispatched: 'manifest:click', label, source: 'AGENTDOM.md', result: r };
      }
      return { error: `Manifest tool "${tool.name}" has no executable directive (expected a click: field)` };
    }

    if (internal.kind === 'action') {
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
