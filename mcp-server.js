#!/usr/bin/env node
/**
 * AgentDOM MCP Server
 * Exposes browser automation as MCP tools for Claude, Cursor, Windsurf, or any MCP-compatible agent.
 *
 * Tools exposed:
 *   - browse       → Navigate to a URL and get page info
 *   - scan         → Read page schema (forms, actions, links)
 *   - click        → Click an element
 *   - type         → Type text into an input
 *   - fill_form    → Fill an entire form from JSON
 *   - screenshot   → Take a screenshot
 *   - analyze      → AI-powered page analysis
 *   - ask_page     → Ask a question about page content
 *   - execute      → Run raw AgentDOM commands
 *   - read_text    → Get text content of an element
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteerExtra.use(StealthPlugin());

const AGENTDOM_SCRIPT = fs.readFileSync(path.join(__dirname, 'agentdom.js'), 'utf-8');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const { ToolSynthesizer } = require('./integrations/tool-synthesizer');
const { ToolExecutor } = require('./integrations/tool-executor');

// ── Browser State ──
let browser = null;
let page = null;

async function ensureBrowser() {
  if (!browser) {
    browser = await puppeteerExtra.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();
    await page.evaluateOnNewDocument(AGENTDOM_SCRIPT);
  }
  return page;
}

async function aiChat(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agentdom.dev',
      'X-Title': 'AgentDOM MCP',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Input Validation ──
const MAX_URL_LENGTH = 2048;
const MAX_TEXT_LENGTH = 10000;
const MAX_SELECTOR_LENGTH = 500;
const TOOL_TIMEOUTS = {
  browse: 45000,
  scan: 15000,
  scan_with_tools: 15000,
  click: 10000,
  type_text: 10000,
  fill_form: 20000,
  submit_form: 30000,
  read_text: 10000,
  screenshot: 15000,
  scroll: 5000,
  hover: 5000,
  press_key: 5000,
  wait: 30000,
  analyze: 60000,
  ask_page: 60000,
  execute: 15000,
};

function validateString(val, name, maxLen = 500) {
  if (val === undefined || val === null) return;
  if (typeof val !== 'string') throw new Error(`${name} must be a string, got ${typeof val}`);
  if (val.length > maxLen) throw new Error(`${name} exceeds max length (${maxLen} chars)`);
  return val;
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
  if (url.length > MAX_URL_LENGTH) throw new Error(`URL exceeds max length (${MAX_URL_LENGTH} chars)`);
  const normalized = url.startsWith('http') ? url : `https://${url}`;
  try { new URL(normalized); } catch { throw new Error(`Invalid URL: ${url}`); }
  // Block file:// and javascript: protocols
  if (/^(file|javascript|data):/i.test(normalized)) throw new Error(`Blocked URL protocol: ${normalized.split(':')[0]}`);
  return normalized;
}

function validateSelector(sel) {
  return validateString(sel, 'selector', MAX_SELECTOR_LENGTH);
}

async function evalSafe(fn, args = [], timeout = 15000) {
  const p = await ensureBrowser();
  return Promise.race([
    p.evaluate(fn, ...args),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Operation timed out after ${timeout}ms`)), timeout)),
  ]);
}

// ── MCP Server ──
const server = new Server(
  {
    name: 'agentdom',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Dynamic tool state
const synthesizer = new ToolSynthesizer();
let currentDynamicTools = []; // Synthesized from page schema
let currentDynamicToolDefs = []; // Full defs with _internal

async function refreshDynamicTools() {
  try {
    const schema = await evalSafe(() => AgentDOM.scan());
    const result = synthesizer.synthesize(schema);
    currentDynamicToolDefs = result.tools.filter(t => t._internal.type !== 'base');
    currentDynamicTools = synthesizer.toMCPFormat(currentDynamicToolDefs);
    // Notify clients that tools changed
    try { server.notification({ method: 'notifications/tools/list_changed' }); } catch (_) {}
  } catch (_) {
    currentDynamicTools = [];
    currentDynamicToolDefs = [];
  }
}

// ── Tool Definitions ──
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // === Static tools (always available) ===
      {
        name: 'browse',
        description: 'Navigate to a URL and return page info + auto-discover page-specific tools.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] },
      },
      {
        name: 'scan',
        description: 'Read the current page schema with all forms, actions, and links.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'scan_with_tools',
        description: 'Scan page AND return auto-generated tools. Use this to discover what page-specific tools are available.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'click',
        description: 'Click an element using CSS selector (fallback when no page-specific tool is available).',
        inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector' } }, required: ['selector'] },
      },
      {
        name: 'type_text',
        description: 'Type text into an input field (fallback).',
        inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector' }, text: { type: 'string', description: 'Text to type' } }, required: ['selector', 'text'] },
      },
      {
        name: 'fill_form',
        description: 'Fill a form with data (fallback).',
        inputSchema: { type: 'object', properties: { form_selector: { type: 'string' }, data: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['form_selector', 'data'] },
      },
      {
        name: 'submit_form',
        description: 'Submit a form.',
        inputSchema: { type: 'object', properties: { form_selector: { type: 'string' } }, required: ['form_selector'] },
      },
      {
        name: 'read_text',
        description: 'Get visible text content of an element or full page.',
        inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector (default: body)' } } },
      },
      {
        name: 'screenshot',
        description: 'Take a screenshot. Returns base64 PNG.',
        inputSchema: { type: 'object', properties: { full_page: { type: 'boolean' } } },
      },
      {
        name: 'scroll',
        description: 'Scroll the page.',
        inputSchema: { type: 'object', properties: { pixels: { type: 'number' }, to_selector: { type: 'string' } } },
      },
      {
        name: 'hover',
        description: 'Hover over an element.',
        inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
      },
      {
        name: 'press_key',
        description: 'Press a keyboard key.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      },
      {
        name: 'wait',
        description: 'Wait for element or text to appear.',
        inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'number' } } },
      },
      {
        name: 'analyze',
        description: 'AI-powered page analysis. Requires OPENROUTER_API_KEY.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'ask_page',
        description: 'Ask a question about the page. Requires OPENROUTER_API_KEY.',
        inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      },
      {
        name: 'execute',
        description: 'Run a raw AgentDOM CLI command.',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      // === Dynamic tools (page-specific, auto-generated) ===
      ...currentDynamicTools,
    ],
  };
});

// ── Tool Execution ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const timeout = TOOL_TIMEOUTS[name] || 15000;

  // Wrap entire execution with per-tool timeout
  const executeWithTimeout = async () => {
    switch (name) {

      case 'browse': {
        const url = validateUrl(args.url);
        const p = await ensureBrowser();
        await p.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const schema = await evalSafe(() => AgentDOM.scan());
        await refreshDynamicTools();
        const result = synthesizer.synthesize(schema);
        const summary = `Navigated to: ${schema.page.meta.title}\nURL: ${schema.page.meta.url}\nForms: ${schema.page.forms.length}\nActions: ${schema.page.actions.length}\n\nAuto-generated tools: ${result.tools.filter(t => t._internal.type !== 'base').map(t => t.name).join(', ') || 'none'}`;
        return { content: [{ type: 'text', text: summary }] };
      }

      case 'scan': {
        const schema = await evalSafe(() => AgentDOM.scan());
        return { content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }] };
      }

      case 'scan_with_tools': {
        const schema = await evalSafe(() => AgentDOM.scan());
        const result = synthesizer.synthesize(schema);
        await refreshDynamicTools();
        const output = { ...schema, tools: synthesizer.toPublicFormat(result.tools), page_type: result.page_type, summary: result.summary };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      }

      case 'click': {
        const sel = validateSelector(args.selector);
        if (!sel) throw new Error('selector is required');
        await evalSafe(async (sel) => await AgentDOM.click(sel), [sel]);
        const p = await ensureBrowser();
        await p.waitForNetworkIdle({ timeout: 2000 }).catch(() => {});
        const title = await p.title();
        return { content: [{ type: 'text', text: `Clicked "${sel}". Current page: ${title} (${p.url()})` }] };
      }

      case 'type_text': {
        const sel = validateSelector(args.selector);
        const text = validateString(args.text, 'text', MAX_TEXT_LENGTH);
        if (!sel) throw new Error('selector is required');
        if (!text) throw new Error('text is required');
        await evalSafe(async (s, t) => await AgentDOM.type(s, t), [sel, text]);
        return { content: [{ type: 'text', text: `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" into ${sel}` }] };
      }

      case 'fill_form': {
        const formSel = validateSelector(args.form_selector);
        if (!formSel) throw new Error('form_selector is required');
        if (!args.data || typeof args.data !== 'object') throw new Error('data must be an object');
        const dataKeys = Object.keys(args.data);
        if (dataKeys.length === 0) throw new Error('data must have at least one field');
        if (dataKeys.length > 50) throw new Error('data exceeds maximum of 50 fields');
        await evalSafe(async (s, d) => await AgentDOM.fillForm(s, d), [formSel, args.data]);
        return { content: [{ type: 'text', text: `Filled form ${formSel} with ${dataKeys.length} field(s): ${JSON.stringify(args.data)}` }] };
      }

      case 'submit_form': {
        const formSel = validateSelector(args.form_selector);
        if (!formSel) throw new Error('form_selector is required');
        await evalSafe(async (s) => await AgentDOM.submitForm(s), [formSel]);
        const p = await ensureBrowser();
        await p.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
        return { content: [{ type: 'text', text: `Submitted form ${formSel}. Current page: ${await p.title()}` }] };
      }

      case 'read_text': {
        const sel = validateSelector(args.selector) || 'body';
        const text = await evalSafe((s) => {
          const el = document.querySelector(s);
          return el ? el.innerText.slice(0, 5000) : 'Element not found';
        }, [sel]);
        return { content: [{ type: 'text', text }] };
      }

      case 'screenshot': {
        const p = await ensureBrowser();
        const buf = await p.screenshot({ fullPage: !!args.full_page, encoding: 'base64' });
        return { content: [{ type: 'image', data: buf, mimeType: 'image/png' }] };
      }

      case 'scroll': {
        if (args.to_selector) {
          const sel = validateSelector(args.to_selector);
          await evalSafe(async (s) => await AgentDOM.scrollTo(s), [sel]);
          return { content: [{ type: 'text', text: `Scrolled to ${sel}` }] };
        }
        const px = Math.min(Math.max(Number(args.pixels) || 500, -10000), 10000);
        await evalSafe(async (n) => await AgentDOM.scroll({ by: n }), [px]);
        return { content: [{ type: 'text', text: `Scrolled ${px}px` }] };
      }

      case 'hover': {
        const sel = validateSelector(args.selector);
        if (!sel) throw new Error('selector is required');
        await evalSafe(async (s) => await AgentDOM.hover(s, 800), [sel]);
        return { content: [{ type: 'text', text: `Hovered over ${sel}` }] };
      }

      case 'press_key': {
        const key = validateString(args.key, 'key', 50);
        if (!key) throw new Error('key is required');
        const p = await ensureBrowser();
        await p.keyboard.press(key);
        return { content: [{ type: 'text', text: `Pressed ${key}` }] };
      }

      case 'wait': {
        const p = await ensureBrowser();
        const waitTimeout = Math.min(Number(args.timeout) || 10000, 30000);
        if (args.text) {
          validateString(args.text, 'text', 1000);
          await p.waitForFunction((t) => document.body.textContent.includes(t), { timeout: waitTimeout }, args.text);
          return { content: [{ type: 'text', text: `Found text: "${args.text}"` }] };
        }
        if (args.selector) {
          validateSelector(args.selector);
          await p.waitForSelector(args.selector, { visible: true, timeout: waitTimeout });
          return { content: [{ type: 'text', text: `Found element: ${args.selector}` }] };
        }
        return { content: [{ type: 'text', text: 'No selector or text provided to wait for' }] };
      }

      case 'analyze': {
        const snapshot = await evalSafe(() => ({
          title: document.title, url: location.href,
          text: document.body.innerText.slice(0, 3000),
          forms: AgentDOM.scan().page.forms.length,
          actions: AgentDOM.scan().page.actions.length,
        }));
        const prompt = `Analyze this webpage for an AI agent.\nTitle: ${snapshot.title}\nURL: ${snapshot.url}\nForms: ${snapshot.forms}, Actions: ${snapshot.actions}\nText:\n${snapshot.text}\n\nRespond with JSON: { "purpose", "capabilities": [], "suggestedFlow": [], "warnings": [] }`;
        const resp = await aiChat(prompt);
        if (!resp) return { content: [{ type: 'text', text: 'AI not available. Set OPENROUTER_API_KEY env var.' }] };
        return { content: [{ type: 'text', text: resp }] };
      }

      case 'ask_page': {
        validateString(args.question, 'question', 2000);
        if (!args.question) throw new Error('question is required');
        const p = await ensureBrowser();
        const pageText = await p.evaluate(() => document.body.innerText.slice(0, 4000));
        const prompt = `Page: ${await p.title()} (${p.url()})\nContent: ${pageText}\n\nQuestion: ${args.question}\n\nAnswer concisely:`;
        const resp = await aiChat(prompt);
        if (!resp) return { content: [{ type: 'text', text: 'AI not available. Set OPENROUTER_API_KEY env var.' }] };
        return { content: [{ type: 'text', text: resp }] };
      }

      case 'execute': {
        validateString(args.command, 'command', 1000);
        if (!args.command) throw new Error('command is required');
        const result = await evalSafe(async (cmd) => await AgentDOM.exec(cmd), [args.command]);
        return { content: [{ type: 'text', text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result || 'Done') }] };
      }

      default: {
        // Check if it's a dynamic (auto-generated) tool
        const dynTool = currentDynamicToolDefs.find(t => t.name === name);
        if (dynTool) {
          const p = await ensureBrowser();
          const sessionProxy = {
            page: p,
            async scan() { return await evalSafe(() => AgentDOM.scan()); },
            async click(sel) { await evalSafe(async s => await AgentDOM.click(s), [sel]); await p.waitForNetworkIdle({ timeout: 2000 }).catch(() => {}); return { clicked: sel, url: p.url(), title: await p.title() }; },
            async type(sel, text) { await evalSafe(async (s, t) => await AgentDOM.type(s, t), [sel, text]); return { typed: text, into: sel }; },
            async browse(url) { const u = validateUrl(url); await p.goto(u, { waitUntil: 'networkidle2', timeout: 30000 }); return await evalSafe(() => AgentDOM.scan()); },
            async scroll(px) { await evalSafe(async n => await AgentDOM.scroll({ by: n }), [px]); return { scrolled: px }; },
            async readText(sel) { return await evalSafe(s => document.querySelector(s)?.innerText?.slice(0, 5000) || 'Not found', [sel || 'body']); },
            async screenshot(full) { return await p.screenshot({ fullPage: full, encoding: 'base64' }); },
            async pressKey(key) { await p.keyboard.press(key); return { pressed: key }; },
          };
          const executor = new ToolExecutor(sessionProxy);
          const result = await executor.execute(dynTool, args || {});
          await refreshDynamicTools();
          const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
          return { content: [{ type: 'text', text: resultStr }] };
        }
        return { content: [{ type: 'text', text: `Unknown tool: ${name}. Use scan_with_tools to discover available tools.` }], isError: true };
      }
    }
  };

  try {
    // Per-tool timeout wrapper
    return await Promise.race([
      executeWithTimeout(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Tool '${name}' timed out after ${timeout}ms`)), timeout)),
    ]);
  } catch (error) {
    const msg = error.message || String(error);
    console.error(`[AgentDOM MCP] Tool '${name}' failed: ${msg}`);
    return { content: [{ type: 'text', text: `Error in '${name}': ${msg}` }], isError: true };
  }
});

// ── Graceful Shutdown ──
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[AgentDOM MCP] ${signal} received, shutting down...`);
  try {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }
    await server.close().catch(() => {});
  } catch (e) {
    console.error('[AgentDOM MCP] Cleanup error:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[AgentDOM MCP] Uncaught exception:', e.message);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (e) => {
  console.error('[AgentDOM MCP] Unhandled rejection:', e);
});

// ── Start ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[AgentDOM MCP] Server running on stdio');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
