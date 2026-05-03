#!/usr/bin/env node
/**
 * AgentDOM API MCP Server
 *
 * Agent calls scan_api({ spec: 'https://petstore.example.com/openapi.json' })
 *   → fetches the OpenAPI 3.x spec
 *   → compile() turns each operation into a typed tool (search, create, delete,
 *     plus per-operation click_<operationId>)
 *   → tools/list_changed fires
 * Agent then calls e.g. create({ name: 'Rex', species: 'dog' })
 *   → server makes the HTTP request to the spec's server URL with the right
 *     method, path, query/path/header params, and JSON body.
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { compile } = require('./compiler');
const { loadManifest, mergeManifestTools } = require('./compiler/from-manifest');

const FETCH_TIMEOUT = 30000;

const server = new Server(
  { name: 'agentdom-api', version: '3.1.0' },
  { capabilities: { tools: {} } },
);

let currentBaseUrl = null;
let currentSpecTitle = null;
let currentManifest = null;
let dynamicTools = [];
const dynamicMap = new Map();

function strip(tools) { return tools.map(({ _internal, ...rest }) => rest); }
function ok(data) { return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }; }
function err(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: true }; }

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

async function loadSpec(input) {
  // Accept: string URL, parsed object, or JSON string.
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') throw new Error('spec must be a URL, JSON string, or parsed object');
  if (isHttpUrl(input)) {
    const res = await fetchWithTimeout(input, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText}`);
    const text = await res.text();
    return JSON.parse(text);
  }
  // Treat as JSON literal.
  return JSON.parse(input);
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function refreshScan(specInput, baseOverride) {
  let spec;
  try { spec = await loadSpec(specInput); }
  catch (e) { return { error: `Could not load spec: ${e.message}` }; }
  if (!spec.paths) return { error: 'Spec is missing .paths — not an OpenAPI 3.x document?' };

  const base = baseOverride || spec.servers?.[0]?.url;
  if (!base || !isHttpUrl(base)) {
    return { error: 'No usable base URL', hint: 'Pass { base: "https://..." } or include servers[].url in the spec.' };
  }

  const { ir, tools } = compile(spec, { from: 'api', to: 'mcp' });
  currentBaseUrl = base.replace(/\/+$/, '');
  currentSpecTitle = spec.info?.title || 'API';
  currentManifest = loadManifest(currentSpecTitle);
  const merged = mergeManifestTools(tools, currentManifest, currentSpecTitle);
  dynamicTools = strip(merged);
  dynamicMap.clear();
  for (const t of merged) dynamicMap.set(t.name, t);
  try { server.notification({ method: 'notifications/tools/list_changed' }); } catch (_) {}

  return {
    title: currentSpecTitle,
    base: currentBaseUrl,
    counts: { operations: ir.actions.length, forms: ir.forms.length },
    manifest: currentManifest
      ? { source: currentManifest.sourcePath, tools: currentManifest.tools.length, notes: currentManifest.notes }
      : null,
    tools: dynamicTools,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_api',
      description: 'Load an OpenAPI 3.x spec and AUTO-GENERATE typed tools per operation. Call this once per API; tools/list_changed fires automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'URL to OpenAPI JSON, or the JSON literal itself.' },
          base: { type: 'string', description: 'Override the base URL (otherwise taken from servers[0].url).' },
        },
        required: ['spec'],
      },
    },
    ...dynamicTools,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'scan_api') {
      if (!args?.spec) return err({ error: 'scan_api requires { spec }' });
      const r = await refreshScan(args.spec, args.base);
      if (r.error) return err(r);
      return ok(r);
    }

    if (dynamicMap.has(name)) {
      const tool = dynamicMap.get(name);
      const r = await dispatch(tool, args || {});
      if (r && r.error) return err(r);
      return ok(r);
    }

    return err({ error: `Unknown tool "${name}". Call scan_api first.` });
  } catch (e) {
    return err({ error: e.message });
  }
});

function subst(s, args) {
  return typeof s === 'string'
    ? s.replace(/\$\{(\w+)\}/g, (_, k) => (args[k] === undefined || args[k] === null ? '' : String(args[k])))
    : s;
}

function substDeep(value, args) {
  if (typeof value === 'string') return subst(value, args);
  if (Array.isArray(value)) return value.map(v => substDeep(v, args));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substDeep(v, args);
    return out;
  }
  return value;
}

async function runApiSteps(action, callArgs) {
  const trace = [];
  let lastResponse = null;
  let lastRead = null;

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    if (step.request) {
      const method = (subst(step.request.method, callArgs) || 'GET').toUpperCase();
      const path = subst(step.request.path, callArgs);
      const body = step.request.body !== undefined ? substDeep(step.request.body, callArgs) : null;
      const url = currentBaseUrl + path;
      const init = { method, headers: { 'Accept': 'application/json' } };
      if (body !== null && method !== 'GET' && method !== 'HEAD') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      try {
        const res = await fetchWithTimeout(url, init);
        const text = await res.text();
        let parsed = text;
        const ctype = res.headers.get('content-type') || '';
        if (ctype.includes('application/json') && text) {
          try { parsed = JSON.parse(text); } catch (_) {}
        }
        lastResponse = { status: res.status, body: parsed, ok: res.ok };
        trace.push({ step: i, request: { method, url }, status: res.status });
      } catch (e) {
        return { error: `step ${i} request failed: ${e.message}`, trace };
      }
    } else if (step.read !== undefined) {
      const target = subst(step.read, callArgs);
      if (target === 'body' || target === 'response') lastRead = lastResponse?.body;
      else if (target === 'status') lastRead = lastResponse?.status;
      else if (target.startsWith('body.')) {
        const path = target.slice(5).split('.');
        let v = lastResponse?.body;
        for (const k of path) v = v?.[k];
        lastRead = v;
      } else lastRead = null;
      trace.push({ step: i, read: target });
    } else if (step.wait !== undefined) {
      await new Promise(r => setTimeout(r, Number(step.wait) || 0));
      trace.push({ step: i, waited: step.wait });
    } else {
      trace.push({ step: i, skipped: 'unrecognized', step_obj: step });
    }
  }

  return { ok: true, dispatched: 'manifest:api-steps', trace, result: lastRead };
}

async function dispatch(tool, callArgs) {
  if (!currentBaseUrl) return { error: 'No active API. Call scan_api({ spec }) first.' };
  const internal = tool._internal || {};

  if (internal.kind === 'manifest') {
    const action = internal.manifest_action || {};
    if (Array.isArray(action.steps) && action.steps.length > 0) {
      return runApiSteps(action, callArgs);
    }
    return { error: `Manifest tool "${tool.name}" has no steps:` };
  }

  // Action and form both have a selector that encodes {method, path}.
  const selector = internal.kind === 'form'
    ? internal.submitAction?.selector
    : internal.selector;
  if (!selector) return { error: 'No HTTP selector on tool' };

  let methodPath;
  try { methodPath = JSON.parse(selector); } catch { return { error: 'Selector is not valid JSON {method, path}' }; }
  const { method, path: rawPath } = methodPath;
  if (!method || !rawPath) return { error: 'Selector missing method/path' };

  // Split args by where they live (path / query / header / body) using field selectors.
  const queryParams = [];
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const bodyObj = {};
  let resolvedPath = rawPath;

  const fields = internal.kind === 'form' ? (internal.fields || []) : [];
  const fieldByName = new Map(fields.map(f => [f.name, f]));

  for (const [argName, value] of Object.entries(callArgs)) {
    const field = fieldByName.get(argName);
    const sel = field?.selector || '';
    if (sel.startsWith('path:')) {
      resolvedPath = resolvedPath.replace(`{${argName}}`, encodeURIComponent(String(value)));
    } else if (sel.startsWith('query:')) {
      queryParams.push([argName, String(value)]);
    } else if (sel.startsWith('header:')) {
      headers[argName] = String(value);
    } else if (sel.startsWith('body:')) {
      bodyObj[argName] = value;
    } else {
      // No metadata — assume body.
      bodyObj[argName] = value;
    }
  }

  const url = new URL(currentBaseUrl + resolvedPath);
  for (const [k, v] of queryParams) url.searchParams.append(k, v);

  const init = { method, headers };
  if (Object.keys(bodyObj).length > 0 && method !== 'GET' && method !== 'DELETE') {
    init.body = JSON.stringify(bodyObj);
  }

  let res;
  try { res = await fetchWithTimeout(url.toString(), init); }
  catch (e) { return { error: `HTTP request failed: ${e.message}`, url: url.toString(), method }; }

  const text = await res.text().catch(() => '');
  let body = text;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json') && text) {
    try { body = JSON.parse(text); } catch (_) {}
  }
  return {
    request: { method, url: url.toString() },
    status: res.status,
    statusText: res.statusText,
    body,
  };
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[AgentDOM API MCP] ${signal} received, shutting down...`);
  try { await server.close().catch(() => {}); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentDOM API MCP Server v3.1.0 — call scan_api({ spec }) to begin.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
