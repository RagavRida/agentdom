#!/usr/bin/env node
/**
 * AgentDOM CLI MCP Server
 *
 * Agent calls scan_cli({ command: 'docker' })
 *   → runs <command> --help
 *   → compile() turns it into typed tools (click_run, click_build, ..., docker(flags))
 *   → tools/list_changed fires
 * Agent then calls e.g. click_run() or docker({ verbose: true, config: '/path' })
 *   → server invokes the binary with the right argv and returns stdout/stderr.
 */

'use strict';

const { execFileSync } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { compile } = require('./compiler');
const { loadManifest, mergeManifestTools } = require('./compiler/from-manifest');

const HELP_TIMEOUT = 10000;
const RUN_TIMEOUT = 30000;
const COMMAND_RE = /^[a-zA-Z][\w.-]{0,63}$/;

const server = new Server(
  { name: 'agentdom-cli', version: '3.1.0' },
  { capabilities: { tools: {} } },
);

let currentCommand = null;
let currentManifest = null;
let dynamicTools = [];
const dynamicMap = new Map();

function strip(tools) { return tools.map(({ _internal, ...rest }) => rest); }
function ok(data) { return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }; }
function err(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: true }; }

function validateCommand(cmd) {
  if (typeof cmd !== 'string' || !COMMAND_RE.test(cmd)) {
    throw new Error(`Invalid command name "${cmd}" (allowed: alphanumerics, dot, underscore, hyphen).`);
  }
  return cmd;
}

async function refreshScan(command) {
  const cmd = validateCommand(command);
  let helpText;
  try {
    helpText = execFileSync(cmd, ['--help'], { encoding: 'utf-8', timeout: HELP_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Some tools print --help to stderr or exit non-zero. Try -h, then capture stderr.
    try {
      helpText = execFileSync(cmd, ['-h'], { encoding: 'utf-8', timeout: HELP_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e2) {
      const stderr = (e.stderr || e2.stderr || '').toString();
      if (stderr) helpText = stderr;
      else return { error: `Could not run "${cmd} --help"`, hint: 'Is the binary on PATH? Try a different command name.' };
    }
  }

  const { ir, tools } = compile(helpText, { from: 'cli', to: 'mcp', command: cmd });
  currentCommand = cmd;
  currentManifest = loadManifest(cmd);
  const merged = mergeManifestTools(tools, currentManifest, cmd);
  dynamicTools = strip(merged);
  dynamicMap.clear();
  for (const t of merged) dynamicMap.set(t.name, t);
  try { server.notification({ method: 'notifications/tools/list_changed' }); } catch (_) {}

  return {
    command: cmd,
    counts: { actions: ir.actions.length, forms: ir.forms.length, fields: ir.forms[0]?.fields.length || 0 },
    manifest: currentManifest
      ? { source: currentManifest.sourcePath, tools: currentManifest.tools.length, notes: currentManifest.notes }
      : null,
    tools: dynamicTools,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_cli',
      description: 'Parse a binary\'s --help output and AUTO-GENERATE typed tools (click_<subcommand>, <command>(--flags)). Call this once per binary; tools/list_changed fires automatically.',
      inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'Binary name on PATH (e.g. "docker", "kubectl")' } }, required: ['command'] },
    },
    ...dynamicTools,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'scan_cli') {
      if (!args?.command) return err({ error: 'scan_cli requires { command }' });
      const r = await refreshScan(args.command);
      if (r.error) return err(r);
      return ok(r);
    }

    if (dynamicMap.has(name)) {
      const tool = dynamicMap.get(name);
      const r = await dispatch(tool, args || {});
      if (r && r.error) return err(r);
      return ok(r);
    }

    return err({ error: `Unknown tool "${name}". Call scan_cli first.` });
  } catch (e) {
    return err({ error: e.message });
  }
});

function subst(s, args) {
  return typeof s === 'string'
    ? s.replace(/\$\{(\w+)\}/g, (_, k) => (args[k] === undefined || args[k] === null ? '' : String(args[k])))
    : s;
}

async function runCliSteps(action, callArgs) {
  const trace = [];
  let lastRun = { stdout: '', stderr: '', exitCode: null };
  let lastRead = null;

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    if (step.run !== undefined) {
      const cmdline = subst(step.run, callArgs);
      const argv = cmdline.split(/\s+/).filter(Boolean);
      if (!argv.length) { trace.push({ step: i, run: cmdline, error: 'empty command' }); continue; }
      const [bin, ...args] = argv;
      if (!COMMAND_RE.test(bin)) {
        return { error: `unsafe binary "${bin}" in step ${i}`, trace };
      }
      try {
        const out = execFileSync(bin, args, {
          encoding: 'utf-8', timeout: RUN_TIMEOUT,
          stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
        });
        lastRun = { stdout: out, stderr: '', exitCode: 0 };
        trace.push({ step: i, run: cmdline, exitCode: 0, bytes: out.length });
      } catch (e) {
        lastRun = {
          stdout: e.stdout?.toString() || '',
          stderr: (e.stderr?.toString() || e.message || '').slice(0, 4000),
          exitCode: e.status ?? null,
        };
        trace.push({ step: i, run: cmdline, exitCode: lastRun.exitCode, error: lastRun.stderr.slice(0, 200) });
        return { error: `step ${i} run "${cmdline}" failed`, exitCode: lastRun.exitCode, stderr: lastRun.stderr, trace };
      }
    } else if (step.read !== undefined) {
      const target = subst(step.read, callArgs);
      if (target === 'stdout') lastRead = lastRun.stdout;
      else if (target === 'stderr') lastRead = lastRun.stderr;
      else if (target === 'exit_code' || target === 'exitCode') lastRead = lastRun.exitCode;
      else lastRead = null;
      trace.push({ step: i, read: target, length: typeof lastRead === 'string' ? lastRead.length : null });
    } else if (step.wait !== undefined) {
      await new Promise(r => setTimeout(r, Number(step.wait) || 0));
      trace.push({ step: i, waited: step.wait });
    } else {
      trace.push({ step: i, skipped: 'unrecognized', step_obj: step });
    }
  }

  return { ok: true, dispatched: 'manifest:cli-steps', trace, result: lastRead };
}

async function dispatch(tool, callArgs) {
  if (!currentCommand) return { error: 'No active command. Call scan_cli({ command }) first.' };
  const internal = tool._internal || {};

  if (internal.kind === 'manifest') {
    const action = internal.manifest_action || {};
    if (Array.isArray(action.steps) && action.steps.length > 0) {
      return runCliSteps(action, callArgs);
    }
    if (action.run) {
      // Single-shot run shorthand.
      return runCliSteps({ steps: [{ run: action.run }, { read: 'stdout' }] }, callArgs);
    }
    return { error: `Manifest tool "${tool.name}" has no executable directive (run: or steps:)` };
  }

  if (internal.kind === 'action') {
    // selector format: "<command> <subcommand>"
    const sel = internal.selector || '';
    const parts = sel.split(/\s+/).filter(Boolean);
    if (parts.length < 1) return { error: 'No subcommand selector' };
    const [bin, ...sub] = parts;
    if (!COMMAND_RE.test(bin)) return { error: `Refusing to run unsafe binary "${bin}"` };
    return runBin(bin, sub);
  }

  if (internal.kind === 'form') {
    const argv = [];
    const fieldByName = new Map((internal.fields || []).map(f => [f.name, f]));
    for (const [argName, value] of Object.entries(callArgs)) {
      const field = fieldByName.get(argName);
      if (!field) continue;
      const flag = field.selector || `--${field.name}`;
      if (field.type === 'boolean') {
        if (value) argv.push(flag);
      } else if (value !== null && value !== undefined && value !== '') {
        argv.push(flag, String(value));
      }
    }
    return runBin(currentCommand, argv);
  }

  return { error: `Unknown _internal.kind: ${internal.kind}` };
}

function runBin(bin, argv) {
  try {
    const out = execFileSync(bin, argv, {
      encoding: 'utf-8',
      timeout: RUN_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: out, argv: [bin, ...argv] };
  } catch (e) {
    return {
      error: `"${bin} ${argv.join(' ')}" failed`,
      exitCode: e.status ?? null,
      stdout: e.stdout?.toString() || '',
      stderr: (e.stderr?.toString() || e.message || '').slice(0, 4000),
    };
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[AgentDOM CLI MCP] ${signal} received, shutting down...`);
  try { await server.close().catch(() => {}); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentDOM CLI MCP Server v3.1.0 — call scan_cli({ command }) to begin.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
