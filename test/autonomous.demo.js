#!/usr/bin/env node
/**
 * Autonomous agent loop — proves the autonomy claim end-to-end.
 *
 * Spawns desktop-mcp-server, connects an MCP client, exposes the live tool
 * list to a real LLM via OpenRouter (OpenAI-compatible chat completions
 * with tool-calling), and lets the model pick + dispatch tools until the
 * goal completes. NO app-specific code in this runner — same loop drives
 * any goal/app the MCP server exposes.
 *
 * Pre-reqs:
 *   - OPENROUTER_API_KEY in env (sourced from ~/.env or exported).
 *   - The target app exists. Default goal targets Calculator.
 *
 * Usage:
 *   node test/autonomous.demo.js
 *   GOAL="Open TextEdit and type 'hello'" node test/autonomous.demo.js
 *   MODEL="openai/gpt-4o" node test/autonomous.demo.js
 *
 * Exit code:
 *   0 if a verifier regex matches the final assistant text. 1 otherwise.
 */

'use strict';

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.join(__dirname, '..');
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4.6';
const MAX_TURNS = Number(process.env.MAX_TURNS) || 12;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_GOAL = [
  'Compute 49 multiplied by 17 using the macOS Calculator app and report the numeric result.',
  'Calculator is already running. The compute tool on the Calculator manifest takes a single',
  '"expression" string param and returns the displayed result.',
  'Output the final number on its own line.',
].join(' ');
const GOAL = process.env.GOAL || DEFAULT_GOAL;
const VERIFY_RE = process.env.VERIFY_RE ? new RegExp(process.env.VERIFY_RE) : /\b833\b/;

const C = { d: '\x1b[2m', g: '\x1b[32m', r: '\x1b[0m', b: '\x1b[1m', red: '\x1b[31m', cyan: '\x1b[36m' };
const dim = m => console.log(`${C.d}${m}${C.r}`);
const ok = m => console.log(`${C.g}✓ ${m}${C.r}`);
const fail = m => console.error(`${C.red}✗ ${m}${C.r}`);
const turn = (n, body) => console.log(`\n${C.cyan}─── Turn ${n} ${'─'.repeat(60 - String(n).length)}${C.r}\n${body}`);

async function chat(messages, tools) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agentdom.dev',
      'X-Title': 'AgentDOM autonomous demo',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 600)}`);
  }
  return await res.json();
}

function mcpToolToOpenAI(t) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    fail('OPENROUTER_API_KEY not set. Run: set -a; source ~/.env; set +a');
    process.exit(2);
  }

  dim(`Spawning desktop-mcp-server.js (model=${MODEL})…`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'desktop-mcp-server.js')],
  });
  const mcp = new Client({ name: 'agentdom-autonomous-runner', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);
  ok('MCP server up.');

  async function refreshTools() {
    const list = await mcp.listTools();
    return list.tools.map(mcpToolToOpenAI);
  }
  let tools = await refreshTools();
  ok(`Initial tool count: ${tools.length}`);

  const messages = [
    { role: 'system', content: 'You are an autonomous agent driving a desktop machine via MCP tools. Use discover_surfaces and scan_app to learn the surface, then call the right tool. Do NOT ask the user for clarification — just act. Report the final answer in plain text on the last line.' },
    { role: 'user', content: GOAL },
  ];
  console.log(`\n${C.b}Goal:${C.r} ${GOAL}\n`);

  let lastAssistantText = '';
  let totalToolCalls = 0;
  let exitCode = 1;

  for (let i = 1; i <= MAX_TURNS; i++) {
    let res;
    try { res = await chat(messages, tools); }
    catch (e) { fail(`chat failed: ${e.message}`); break; }

    const choice = res.choices?.[0];
    const msg = choice?.message;
    if (!msg) { fail(`No message in response: ${JSON.stringify(res).slice(0, 400)}`); break; }

    const text = (msg.content || '').trim();
    const calls = msg.tool_calls || [];

    turn(i, [
      `finish_reason: ${choice.finish_reason}`,
      text ? `text: ${text.slice(0, 240)}` : null,
      calls.length ? `tool calls: ${calls.map(c => c.function.name).join(', ')}` : null,
    ].filter(Boolean).join('\n'));

    if (text) lastAssistantText = text;
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls.length ? calls : undefined });

    if (!calls.length) break;

    for (const c of calls) {
      totalToolCalls++;
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
      try {
        const r = await mcp.callTool({ name: c.function.name, arguments: args });
        const raw = r.content?.[0]?.text || JSON.stringify(r);
        const truncated = raw.length > 1500 ? raw.slice(0, 1500) + ' …[truncated]' : raw;
        dim(`  → ${c.function.name}(${JSON.stringify(args).slice(0, 80)}) ${r.isError ? '[ERROR]' : '[ok]'}`);
        messages.push({ role: 'tool', tool_call_id: c.id, content: truncated });
      } catch (e) {
        dim(`  → ${c.function.name} threw: ${e.message}`);
        messages.push({ role: 'tool', tool_call_id: c.id, content: `Error: ${e.message}` });
      }
    }

    if (calls.some(c => /^(scan_app|launch_electron|attach_electron|discover_surfaces)$/.test(c.function.name))) {
      const next = await refreshTools();
      if (next.length !== tools.length) {
        dim(`  ↻ tool list grew: ${tools.length} → ${next.length}`);
        tools = next;
      }
    }
  }

  console.log(`\n${C.b}=== Final ===${C.r}`);
  console.log(`Tool calls dispatched: ${totalToolCalls}`);
  console.log(`Last assistant text: ${lastAssistantText || '(none)'}`);

  if (VERIFY_RE.test(lastAssistantText)) {
    ok(`Verifier ${VERIFY_RE} matched.`);
    exitCode = 0;
  } else {
    fail(`Verifier ${VERIFY_RE} did NOT match.`);
  }

  await mcp.close().catch(() => {});
  process.exit(exitCode);
}

main().catch(e => { console.error('Runner failed:', e); process.exit(2); });
