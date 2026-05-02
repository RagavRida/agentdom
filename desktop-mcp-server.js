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

const server = new Server(
  { name: 'agentdom', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Tools: Auto-generated from platform capabilities ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Platform meta-tools
    {
      name: 'discover',
      description: 'Discover all available AgentDOM capabilities. Call this first to see what you can do. Optionally filter by category: app_control, observe, interact, navigate, system, browser, dev.',
      inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'Filter by category' } } },
    },
    {
      name: 'observe',
      description: 'Observe the current state of the desktop: running apps, active app, clipboard, system info, time. Use this to understand what is happening before taking action.',
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
    // All platform capabilities as tools
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

      // All other tools → platform.execute
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
