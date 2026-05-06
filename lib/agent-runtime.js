/**
 * AgentDOM — Autonomous Agent Runtime
 *
 * Wires together:
 *   LLM (OpenRouter/Claude/GPT) → Planner → dispatch_intent → secrets → result
 *
 * This is the actual autonomous execution loop. The agent:
 *   1. Receives a natural language goal
 *   2. Discovers available tools (all authenticated providers + their intents)
 *   3. LLM generates a structured plan (steps with intents + args)
 *   4. Each step executes via dispatch_intent (headless — no human)
 *   5. Results flow into working memory for next steps
 *   6. On failure: LLM replans, retries, or gives up with explanation
 *   7. Memory records outcome for future runs
 *
 * Usage:
 *   const runtime = new AgentRuntime({ model: 'claude-sonnet-4-5' });
 *   const result  = await runtime.run('Create a Linear ticket and notify Alice on Slack');
 *
 * Zero human interaction after initial credential setup.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Planner }   = require('./planner');
const secrets       = require('./secrets');
const memory        = require('./memory');
// Priority 2: wire in the compiler for proper manifest → tool schema compilation
const { fromDirectory, toCatalogString } = require('../compiler/from-json-manifest');

const WALLET_FILE = path.join(os.homedir(), '.agentdom', 'wallet.json');

// ── Catalog cache (5-minute TTL) ─────────────────────────────────────────────
let _catalogCache = null;
let _catalogCacheAt = 0;
const CATALOG_TTL_MS = 5 * 60 * 1000;

function invalidateCatalogCache() { _catalogCache = null; }

// ── Tool catalog ──────────────────────────────────────────────────────────────

/**
 * Build the tool catalog from:
 *   1. All authenticated providers (from wallet + env)
 *   2. Their capabilities (from manifests)
 *   3. Built-in tools (memory, policy, etc.)
 *
 * Returns a markdown description for the LLM system prompt.
 */
async function buildToolCatalog() {
  // Return cached catalog if still fresh
  if (_catalogCache && (Date.now() - _catalogCacheAt) < CATALOG_TTL_MS) {
    return _catalogCache;
  }

  const manifestDir = path.join(__dirname, '..', 'manifests');
  const tools = [];

  // ── Built-in tools (always available) ──────────────────────────────────────
  const builtins = [
    { intent: 'wallet.list',     provider: '__builtin__', description: 'List all authenticated providers and their credential source', authed: true, side_effects: ['read'] },
    { intent: 'wallet.status',   provider: '__builtin__', description: 'Check if a specific provider is authenticated. Args: { provider: string }', authed: true, side_effects: ['read'] },
    { intent: 'memory.recall',   provider: '__builtin__', description: 'Recall past agent runs and outcomes. Args: { query?: string }', authed: true, side_effects: ['read'] },
    { intent: 'policy.show',     provider: '__builtin__', description: 'Show current policy rules for intent execution', authed: true, side_effects: ['read'] },
  ];
  tools.push(...builtins);

  // ── Browser tools — available when Chrome CDP is reachable ─────────────────
  // Check for live browser: AGENTDOM_CDP_URL or localhost:9222
  const cdpUrl = process.env.AGENTDOM_CDP_URL || 'http://localhost:9222';
  let browserAvailable = false;
  let browserPages = [];
  try {
    const res = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      browserPages = await res.json();
      browserAvailable = browserPages.some(p => p.type === 'page');
    }
  } catch (_) {}

  if (browserAvailable) {
    const activePage = browserPages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
    const pageLabel  = activePage ? ` (active tab: ${activePage.url.slice(0, 60)})` : '';
    const browserTools = [
      { intent: 'browser.navigate',   provider: '__browser__', description: `Navigate the browser to a URL. Args: { url: string }${pageLabel}`, authed: true, side_effects: ['read'] },
      { intent: 'browser.click',      provider: '__browser__', description: 'Click an element by CSS selector or visible text. Args: { selector?: string, text?: string }', authed: true, side_effects: ['external'] },
      { intent: 'browser.type',       provider: '__browser__', description: 'Type text into an input field. Args: { selector: string, text: string }', authed: true, side_effects: ['external'] },
      { intent: 'browser.fill',       provider: '__browser__', description: 'Fill a form field. Args: { selector: string, value: string }', authed: true, side_effects: ['external'] },
      { intent: 'browser.submit',     provider: '__browser__', description: 'Submit a form by clicking its submit button. Args: { selector?: string }', authed: true, side_effects: ['external'] },
      { intent: 'browser.scan',       provider: '__browser__', description: 'Read the current page content and interactive elements', authed: true, side_effects: ['read'] },
      { intent: 'browser.screenshot', provider: '__browser__', description: 'Take a screenshot of the current browser state', authed: true, side_effects: ['read'] },
      { intent: 'browser.scroll',     provider: '__browser__', description: 'Scroll the page. Args: { direction: "down"|"up"|"to", selector?: string }', authed: true, side_effects: ['read'] },
      { intent: 'browser.read_text',  provider: '__browser__', description: 'Read visible text from a specific element. Args: { selector: string }', authed: true, side_effects: ['read'] },
    ];
    tools.push(...browserTools);
  }

  // ── Load all polyfill manifests via compiler pipeline ─────────────────────
  if (fs.existsSync(manifestDir)) {
    const { tools: compiled, errors } = fromDirectory(manifestDir);
    if (errors.length) {
      errors.forEach(e => process.stderr.write(`[AgentDOM] Manifest error: ${e}\n`));
    }

    // Resolve credentials ONCE per unique provider (not once per tool).
    // GitHub has 817 tools but only 1 provider key — avoiding 817 keychain lookups.
    const uniqueProviders = [...new Set(compiled.map(t => t.provider))];
    const credMap = {};
    await Promise.all(uniqueProviders.map(async p => {
      credMap[p] = !!(await secrets.resolve(p));
    }));

    for (const tool of compiled) {
      tools.push({ ...tool, authed: credMap[tool.provider] ?? false, args: tool.input_schema?.properties || {} });
    }
  }

  // ── Format catalog for LLM ────────────────────────────────────────────────
  const authedTools   = tools.filter(t => t.authed);
  const unauthedTools = tools.filter(t => !t.authed);

  // Cap per-provider tools shown in catalog (prevents 817-endpoint GitHub from
  // overwhelming the LLM context — full list still used by dispatcher)
  const MAX_PER_PROVIDER = 12;

  let catalog = `## Available tools (authenticated — ready to use)\n\n`;

  // Built-in tools
  catalog += `### Built-in tools (always available)\n`;
  catalog += builtins.map(t =>
    `- dispatch_intent("${t.intent}", {}, "__builtin__") — ${t.description}`
  ).join('\n');

  // Browser tools (when Chrome CDP is reachable)
  const browserTools = tools.filter(t => t.provider === '__browser__');
  if (browserTools.length) {
    catalog += `\n\n### Browser tools (live Chrome session — use for web UI tasks)\n`;
    catalog += browserTools.map(t =>
      `- dispatch_intent("${t.intent}", {...}, "__browser__") — ${t.description}`
    ).join('\n');
  }

  // Provider API tools — capped per provider
  const apiTools = authedTools.filter(t => t.provider !== '__builtin__' && t.provider !== '__browser__');
  if (apiTools.length) {
    catalog += `\n\n### Provider API tools (${apiTools.length} total)\n`;
    catalog += toCatalogString(apiTools.slice(0, MAX_PER_PROVIDER * Object.keys(
      apiTools.reduce((g, t) => { g[t.provider] = 1; return g; }, {})
    ).length), { showParams: true });
  } else {
    catalog += '\n\n(No provider API tools authenticated — run `agentdom setup <provider>` to add)';
  }

  if (unauthedTools.length) {
    const unauthedProviders = [...new Set(unauthedTools.map(t => t.provider))];
    catalog += `\n\n### Available but not authenticated (${unauthedProviders.length} providers)\n`;
    catalog += unauthedProviders.map(p => `- ${p} — run \`agentdom setup ${p}\``).join('\n');
  }

  const result = { catalog, authedTools, allTools: tools };
  _catalogCache  = result;
  _catalogCacheAt = Date.now();
  return result;
}

// ── LLM client ────────────────────────────────────────────────────────────────

/**
 * Call an LLM via OpenRouter (supports Claude, GPT, Gemini, Llama — any model).
 * Falls back to OPENAI_API_KEY or ANTHROPIC_API_KEY.
 */
async function callLLM(messages, opts = {}) {
  const model = opts.model || process.env.AGENTDOM_MODEL || 'anthropic/claude-sonnet-4-5';

  // Try OpenRouter first (supports 300+ models)
  const openrouterKey = process.env.OPENROUTER_API_KEY
    || (await secrets.resolve('openrouter.ai'))?.token;

  if (openrouterKey) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://getagentdom.com',
        'X-Title': 'AgentDOM',
      },
      body: JSON.stringify({ model, messages, temperature: 0.1 }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM error (${res.status}): ${err}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
  }

  // Fallback 1: Anthropic direct
  const anthropicKey = process.env.ANTHROPIC_API_KEY
    || (await secrets.resolve('anthropic.com'))?.token;
  if (anthropicKey) {
    const sys = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const anthModel = model.includes('/') ? model.split('/').pop() : model;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: anthModel || 'claude-sonnet-4-5-20251101',
        max_tokens: 4096,
        system: sys?.content || 'You are an autonomous AI agent.',
        messages: rest,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Anthropic error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text;
  }

  // Fallback 2: OpenAI direct
  const openaiKey = process.env.OPENAI_API_KEY
    || (await secrets.resolve('openai.com'))?.token;
  if (openaiKey) {
    const oaiModel = model.includes('/') ? model.split('/').pop() : (model || 'gpt-4o');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: oaiModel, messages, temperature: 0.1 }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  }

  throw new Error(
    'No LLM configured. Set one of:\n' +
    '  OPENROUTER_API_KEY  (300+ models via openrouter.ai)\n' +
    '  ANTHROPIC_API_KEY   (Claude direct)\n' +
    '  OPENAI_API_KEY      (GPT-4o direct)\n' +
    'Or run: agentdom setup openrouter.ai'
  );
}

// ── CDP browser executor (no Puppeteer — uses existing Chrome session) ────────

/**
 * Execute a browser intent against an existing Chrome tab via CDP WebSocket.
 * No new browser launched — attaches to the running session.
 *
 * @param {string} intent  — browser.navigate | browser.click | browser.type | ...
 * @param {object} args    — intent-specific args
 * @param {object} page    — CDP page descriptor { webSocketDebuggerUrl, url, id }
 */
async function cdpBrowserExec(intent, args, page) {
  const { WebSocket } = await (async () => {
    try { return { WebSocket: require('ws') }; } catch (_) {
      // ws not available — use Node 22 built-in WebSocket
      return { WebSocket: globalThis.WebSocket };
    }
  })();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 1;
    const pending = new Map();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP timeout after 15s'));
    }, 15000);

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });

    ws.on('open', async () => {
      try {
        let data = {};

        if (intent === 'browser.navigate' || intent === 'navigate') {
          await send('Page.navigate', { url: args.url });
          await send('Page.enable');
          // Wait for load
          await new Promise(r => setTimeout(r, 2000));
          data = { navigated: true, url: args.url };
        }

        else if (intent === 'browser.scan' || intent === 'scan') {
          const r = await send('Runtime.evaluate', {
            expression: `(function(){
              const els = [];
              document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]').forEach(el => {
                const rect = el.getBoundingClientRect();
                if(rect.width > 0 && rect.height > 0) {
                  els.push({ tag: el.tagName, text: (el.innerText||el.value||el.placeholder||'').slice(0,80), id: el.id, name: el.name, type: el.type, href: el.href });
                }
              });
              return { title: document.title, url: location.href, text: document.body.innerText.slice(0,2000), elements: els.slice(0,50) };
            })()`,
            returnByValue: true,
          });
          data = r.result?.value || {};
        }

        else if (intent === 'browser.click' || intent === 'click') {
          const sel = args.selector || `[text*="${args.text}"], button, a`;
          const r = await send('Runtime.evaluate', {
            expression: `(function(){
              let el = ${args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : 'null'};
              if(!el && ${JSON.stringify(args.text||'')}) {
                const all = document.querySelectorAll('button,a,[role="button"]');
                el = Array.from(all).find(e => e.innerText.trim().includes(${JSON.stringify(args.text||'')}));
              }
              if(el){ el.click(); return { clicked: el.tagName + ' ' + (el.innerText||'').slice(0,40) }; }
              return { error: 'Element not found' };
            })()`,
            returnByValue: true,
          });
          data = r.result?.value || {};
          await new Promise(r2 => setTimeout(r2, 800));
        }

        else if (intent === 'browser.type' || intent === 'browser.fill' || intent === 'type') {
          const r = await send('Runtime.evaluate', {
            expression: `(function(){
              const el = document.querySelector(${JSON.stringify(args.selector || 'input:focus, input[type=text], textarea')});
              if(!el) return { error: 'Input not found' };
              el.focus(); el.value = ''; el.value = ${JSON.stringify(args.text || args.value || '')};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { typed: true, into: el.name || el.id || el.placeholder };
            })()`,
            returnByValue: true,
          });
          data = r.result?.value || {};
        }

        else if (intent === 'browser.submit') {
          const r = await send('Runtime.evaluate', {
            expression: `(function(){
              const btn = document.querySelector(${JSON.stringify(args.selector || 'button[type=submit], input[type=submit], button:last-of-type')});
              if(btn){ btn.click(); return { submitted: true }; }
              return { error: 'Submit button not found' };
            })()`,
            returnByValue: true,
          });
          data = r.result?.value || {};
          await new Promise(r2 => setTimeout(r2, 1500));
        }

        else if (intent === 'browser.scroll') {
          await send('Runtime.evaluate', {
            expression: args.direction === 'up'
              ? 'window.scrollBy(0, -600)'
              : `window.scrollBy(0, ${args.pixels || 600})`,
          });
          data = { scrolled: args.direction || 'down' };
        }

        else if (intent === 'browser.read_text') {
          const r = await send('Runtime.evaluate', {
            expression: `(function(){
              const el = document.querySelector(${JSON.stringify(args.selector || 'body')});
              return el ? el.innerText.slice(0, ${args.max_chars || 2000}) : null;
            })()`,
            returnByValue: true,
          });
          data = { text: r.result?.value || '' };
        }

        else if (intent === 'browser.screenshot') {
          const r = await send('Page.captureScreenshot', { format: 'png', quality: 80 });
          data = { screenshot_base64: r.data?.slice(0, 100) + '...(truncated)', captured: true };
        }

        else {
          data = { error: `Unknown browser intent: ${intent}` };
        }

        clearTimeout(timeout);
        ws.close();
        resolve({ ok: !data.error, data, page_url: page.url });
      } catch (e) {
        clearTimeout(timeout);
        ws.close();
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

// ── dispatch_intent wrapper for planner ──────────────────────────────────────

function makeDispatcher(desktopMCP) {
  return async function dispatch(intent, args, provider) {
    // ── Built-in tools ──────────────────────────────────────────────────────
    if (provider === '__builtin__' || !provider) {
      if (intent === 'wallet.list' || intent === 'providers.list' || intent === 'list_authenticated_providers') {
        const walletFile = path.join(os.homedir(), '.agentdom', 'wallet.json');
        let stored = {};
        try { stored = JSON.parse(fs.readFileSync(walletFile, 'utf-8')).providers || {}; } catch {}
        const fromEnv = [];
        for (const [k, v] of Object.entries(process.env)) {
          const m = k.match(/^AGENTDOM_(.+)_KEY$/);
          if (m) fromEnv.push(m[1].toLowerCase().replace(/_/g, '.'));
        }
        const providers = [
          ...Object.keys(stored).map(p => ({ provider: p, source: 'wallet' })),
          ...fromEnv.map(p => ({ provider: p, source: 'env' })),
        ];
        return { ok: true, data: { providers, count: providers.length } };
      }
      if (intent === 'wallet.status') {
        const p = args?.provider;
        if (!p) return { ok: false, error: 'wallet.status requires args.provider' };
        const cred = await secrets.resolve(p);
        return { ok: true, data: { provider: p, authenticated: !!cred, source: cred?.source || null } };
      }
      if (intent === 'memory.recall') {
        const mem = require('./memory');
        const entries = mem.recall(args?.query || '', 10);
        return { ok: true, data: { entries } };
      }
      if (intent === 'policy.show') {
        const pol = require('./policy');
        const rules = pol.current ? pol.current() : {};
        return { ok: true, data: { rules } };
      }
      return { ok: false, error: `Unknown built-in intent: "${intent}"` };
    }

    // ── Browser tools dispatch (__browser__ provider) ─────────────────────────
    if (provider === '__browser__' || intent.startsWith('browser.')) {
      const cdpUrl  = process.env.AGENTDOM_CDP_URL || 'http://localhost:9222';
      const pageId  = process.env.AGENTDOM_CDP_PAGE_ID;

      try {
        const listRes = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(1000) });
        if (!listRes.ok) throw new Error('CDP not reachable');
        const pages = await listRes.json();
        const page  = pageId
          ? pages.find(p => p.id === pageId)
          : pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://')) || pages[0];
        if (!page?.webSocketDebuggerUrl) throw new Error('No suitable browser page found');

        // Execute via CDP WebSocket
        const result = await cdpBrowserExec(intent, args, page);
        return result;
      } catch (e) {
        return { ok: false, error: `Browser dispatch failed: ${e.message}. Is Chrome running with --remote-debugging-port=9222?` };
      }
    }

    // ── Browser dispatch — attach to existing browser first ───────────────────
    // Priority:
    //  1. AGENTDOM_CDP_URL env var       — explicit debug endpoint
    //  2. localhost:9222                  — Chrome started with --remote-debugging-port
    //  3. AGENTDOM_CDP_PAGE_ID env var    — specific page in existing browser session
    //  4. desktop-mcp-server             — MCP server (launches its own browser)
    //
    // Browser-targeting intents: navigate, click, type, scan, screenshot, goal
    const BROWSER_INTENTS = new Set([
      'browser.navigate', 'browser.click', 'browser.type', 'browser.scan',
      'browser.screenshot', 'browser.goal', 'browser.fill', 'browser.submit',
      'navigate', 'click', 'type', 'scan', 'screenshot', 'goal',
    ]);

    if (BROWSER_INTENTS.has(intent)) {
      // Try to attach to existing Chrome debug session
      const cdpUrl = process.env.AGENTDOM_CDP_URL || 'http://localhost:9222';
      try {
        const listRes = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(1000) });
        if (listRes.ok) {
          const pages = await listRes.json();
          // Find the most relevant open tab (prefer non-devtools pages)
          const targetPageId = process.env.AGENTDOM_CDP_PAGE_ID;
          const page = targetPageId
            ? pages.find(p => p.id === targetPageId)
            : pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://')) || pages[0];

          if (page?.webSocketDebuggerUrl) {
            // Dispatch browser intent via CDP websocket
            const { execBrowserIntent } = require('../integrations/browser-engine');
            if (typeof execBrowserIntent === 'function') {
              return await execBrowserIntent(intent, args, page.webSocketDebuggerUrl);
            }
          }
        }
      } catch (_) { /* no existing browser — fall through to desktop-mcp-server */ }
    }

    // Import the MCP server's dispatchIntent or use direct HTTP
    try {
      const mcp = desktopMCP || require('../desktop-mcp-server');
      if (typeof mcp.dispatchIntent === 'function') {
        return await mcp.dispatchIntent(intent, args, provider);
      }
    } catch {}

    // ── Direct HTTP dispatch via compiled manifests (with auto credential recovery) ──
    const manifestDir = path.join(__dirname, '..', 'manifests');
    if (fs.existsSync(manifestDir)) {
      for (const file of fs.readdirSync(manifestDir)) {
        if (!file.endsWith('.json')) continue;
        let m;
        try { m = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf-8')); } catch { continue; }
        if (!provider || m.host === provider || file === `${provider}.json`) {
          const cap = m.capabilities?.find(c => c.intent === intent);
          if (cap) {
            const makeCall = async (token) => {
              let url = cap.endpoint.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(args[k] ?? ''));
              const authHeader = m.auth?.key_header || 'Authorization';
              const authValue  = (m.auth?.key_format || 'Bearer {token}').replace('{token}', token);
              const bodyArgs   = { ...args };
              (cap.endpoint.match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1)).forEach(p => delete bodyArgs[p]);
              return fetch(url, {
                method:  cap.method || 'GET',
                headers: { [authHeader]: authValue, 'Content-Type': 'application/json' },
                body:    ['POST', 'PUT', 'PATCH'].includes(cap.method) ? JSON.stringify(bodyArgs) : undefined,
                signal:  AbortSignal.timeout(15000),
              });
            };

            let cred = await secrets.resolveOrThrow(m.host);
            let res  = await makeCall(cred.token);

            // ── Auto-recover on 401/403 — no human needed ─────────────────
            if (res.status === 401 || res.status === 403) {
              const fresh = await _autoRefreshCredential(m.host);
              if (fresh) res = await makeCall(fresh.token);
            }

            const body = await res.text();
            let data;
            try { data = JSON.parse(body); } catch { data = { raw: body }; }
            if (!res.ok) data = { error: body };
            return { ok: res.ok, status: res.status, data };
          }
        }
      }
    }
    return { ok: false, error: `No capability found for intent="${intent}" provider="${provider}"` };
  };
}

// ── Autonomous credential recovery ────────────────────────────────────────────
/**
 * Given a provider that returned 401/403, attempt to recover the credential
 * without human intervention:
 *   1. If refresh_token stored → exchange it for new access_token
 *   2. If GitHub device flow configured → kick off device flow (prints code)
 *   3. Otherwise → invalidate stale token, return structured error
 *
 * Returns the new credential { token } or null on failure.
 */
async function _autoRefreshCredential(provider) {
  process.stderr.write(`[AgentDOM] 401 on ${provider} — attempting autonomous credential refresh...\n`);

  const walletFile = path.join(os.homedir(), '.agentdom', 'wallet.json');
  let wallet = {};
  try { wallet = JSON.parse(fs.readFileSync(walletFile, 'utf-8')); } catch {}
  const stored = wallet.providers?.[provider];

  // ── Strategy 1: Use refresh_token ────────────────────────────────────────
  if (stored?.refresh_token) {
    const oauthReg = _getOAuthReg(provider);
    if (oauthReg?.token_url) {
      try {
        const res = await fetch(oauthReg.token_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: stored.refresh_token,
            client_id:     oauthReg.client_id,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.access_token) {
            // Persist refreshed token
            if (!wallet.providers) wallet.providers = {};
            wallet.providers[provider] = {
              ...stored,
              token:         data.access_token,
              refresh_token: data.refresh_token || stored.refresh_token,
              refreshed_at:  new Date().toISOString(),
            };
            fs.mkdirSync(path.dirname(walletFile), { recursive: true });
            fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2));
            invalidateCatalogCache();
            process.stderr.write(`[AgentDOM] ✓ Token refreshed for ${provider}\n`);
            return { token: data.access_token };
          }
        }
      } catch (e) {
        process.stderr.write(`[AgentDOM] refresh_token exchange failed: ${e.message}\n`);
      }
    }
  }

  // ── Strategy 2: GitHub device flow (no browser needed) ───────────────────
  if (provider === 'github.com' || provider === 'github') {
    try {
      const CLIENT_ID = 'Ov23liMxf4J3PjYcS5YK';
      // Step A: request device code
      const codeRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'repo user:email' }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!codeRes.ok) throw new Error('Device code request failed');
      const { device_code, user_code, verification_uri, interval = 5, expires_in = 900 } = await codeRes.json();

      process.stderr.write(`\n[AgentDOM] GitHub needs re-authentication.\n`);
      process.stderr.write(`  → Open: ${verification_uri}\n`);
      process.stderr.write(`  → Enter code: ${user_code}\n`);
      process.stderr.write(`  Polling for authorization (${expires_in}s timeout)...\n\n`);

      // Step B: poll until user authorizes
      const deadline = Date.now() + expires_in * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval * 1000));
        const pollRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: new URLSearchParams({ client_id: CLIENT_ID, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        const poll = await pollRes.json();
        if (poll.access_token) {
          if (!wallet.providers) wallet.providers = {};
          wallet.providers['github.com'] = { token: poll.access_token, refresh_token: poll.refresh_token || null, source: 'device_flow', refreshed_at: new Date().toISOString() };
          fs.mkdirSync(path.dirname(walletFile), { recursive: true });
          fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2));
          invalidateCatalogCache();
          process.stderr.write(`[AgentDOM] ✓ GitHub re-authenticated via device flow\n`);
          return { token: poll.access_token };
        }
        if (poll.error === 'access_denied') break;
        // 'authorization_pending' or 'slow_down' → keep polling
      }
    } catch (e) {
      process.stderr.write(`[AgentDOM] GitHub device flow failed: ${e.message}\n`);
    }
  }

  // ── Strategy 3: Invalidate stale token ───────────────────────────────────
  if (wallet.providers?.[provider]) {
    process.stderr.write(`[AgentDOM] Clearing stale token for ${provider}\n`);
    delete wallet.providers[provider];
    fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2));
    invalidateCatalogCache();
  }

  return null;
}

function _getOAuthReg(provider) {
  try {
    const { OAUTH_REGISTRY } = require('./oauth-pkce');
    return OAUTH_REGISTRY?.[provider] || null;
  } catch { return null; }
}

// ── AgentRuntime ──────────────────────────────────────────────────────────────

class AgentRuntime {
  /**
   * @param {object} opts
   * @param {string}  [opts.model]      — LLM model (default: claude-sonnet-4-5 via OpenRouter)
   * @param {number}  [opts.maxSteps]   — max plan steps (default: 20)
   * @param {boolean} [opts.dryRun]     — plan only, don't execute
   * @param {boolean} [opts.verbose]    — stream step progress to stdout
   * @param {string}  [opts.sessionId]  — resume a previous session
   */
  constructor(opts = {}) {
    this.model     = opts.model    || process.env.AGENTDOM_MODEL || 'anthropic/claude-sonnet-4-5';
    this.maxSteps  = opts.maxSteps || 20;
    this.dryRun    = opts.dryRun   || !!process.env.AGENTDOM_DRY;
    this.verbose   = opts.verbose  ?? true;
    this.sessionId = opts.sessionId || null;
    this.planMode  = opts.planMode  || !!process.env.AGENTDOM_PLAN; // batch plan vs reactive loop
  }

  log(msg) {
    if (this.verbose) process.stderr.write(`[AgentDOM] ${msg}\n`);
  }

  /**
   * Run a goal autonomously.
   * Run a goal autonomously.
   *
   * Default mode: ReactiveAgent — observe → decide → act → repeat
   *   No screenshots. No coordinates. No vision model.
   *   The LLM reads a text tool catalog and calls tools with typed args.
   *
   * Batch mode (--plan): Planner — generate full plan upfront, then execute.
   *   Better for well-defined multi-step API workflows.
   *
   * Returns { ok, goal, steps, result, trace?, error? }
   */
  async run(goal) {
    this.log(`Goal: ${goal}`);

    // 1. Build tool catalog
    const { catalog, authedTools, allTools } = await buildToolCatalog();
    this.log(`${authedTools.length} authenticated tools available`);

    if (authedTools.length === 0) {
      return {
        ok: false,
        error: 'No authenticated providers. Run: agentdom setup <provider>',
        hint: 'Example: agentdom setup linear.app  (OAuth)\n         agentdom setup resend.com   (API key)',
      };
    }

    // 2. Build LLM caller
    const model = this.model;
    const llm = async (messages) => {
      const withSystem = messages[0]?.role === 'system'
        ? messages
        : [{ role: 'system', content: `You are an autonomous AI agent powered by AgentDOM.\n\n${catalog}` }, ...messages];
      return callLLM(withSystem, { model });
    };

    // 3. Build dispatcher
    const dispatcher = makeDispatcher();

    // ── Batch / plan mode ────────────────────────────────────────────────────
    if (this.planMode) {
      const planner = new Planner({
        llm,
        dispatch:       dispatcher,
        maxRetries:     2,
        maxReplanCycles: 3,
        dryRun:         this.dryRun,
        semanticVerify: !this.dryRun,
      });
      const originalLog = console.error;
      console.error = (...a) => { if (this.verbose) process.stderr.write(a.join(' ') + '\n'); };
      let result;
      try {
        result = await planner.run(goal, { sessionId: this.sessionId, maxSteps: this.maxSteps, catalog });
      } finally { console.error = originalLog; }
      return result;
    }

    // ── Reactive mode (default) ──────────────────────────────────────────────
    // The LLM never sees the UI. It reads a text tool catalog and calls tools.
    // Each step: scan() → LLM decides tool → execute() → observe result → repeat.
    const { createAgent } = require('./reactive-agent');
    const agent = createAgent({
      llm,
      buildCatalog:    buildToolCatalog,
      dispatch:        dispatcher,
      prebuiltCatalog: { catalog, authedTools, allTools }, // skip rebuild on each step
      maxSteps:        this.maxSteps,
      verbose:         this.verbose,
    });

    return agent.run(goal);
  }
}

// ── CLI main() — called by cli.js or directly ────────────────────────────────
function main(argv) {
  argv = argv || process.argv.slice(2);
  const goal = argv.filter(a => !a.startsWith('--')).join(' ');
  const opts = {
    model:    (argv.find(a => a.startsWith('--model=')) || '').replace('--model=', '') || undefined,
    dryRun:   argv.includes('--dry'),
    verbose:  !argv.includes('--quiet'),
    maxSteps: parseInt((argv.find(a => a.startsWith('--max-steps=')) || '').replace('--max-steps=', '') || '20', 10),
    sessionId: (argv.find(a => a.startsWith('--session=')) || '').replace('--session=', '') || null,
    planMode:  argv.includes('--plan'),  // use batch Planner instead of reactive loop
  };

  if (!goal) {
    console.log(`
agentdom run "<goal>"  — run any goal autonomously (no screenshots, no UI needed)

Modes:
  (default)         Reactive loop — LLM observes tool catalog, decides, executes, repeats
  --plan            Batch mode — LLM generates full plan upfront, then executes all steps
  --dry             Plan only — show what would happen without executing

Options:
  --model=<model>    LLM model via OpenRouter (default: anthropic/claude-sonnet-4-5)
  --quiet            No progress output
  --max-steps=N      Cap at N steps (default: 20)
  --session=<id>     Resume a previous plan session (--plan mode only)

Examples:
  agentdom run "Create a Linear ticket for login crash, assign to alice@company.com"
  agentdom run "Send a summary email to team@company.com about today's deployments"
  agentdom run "Create a Notion page with Q2 OKRs and share it in the Engineering Slack channel"
  agentdom run --dry "Book a meeting with alice@company.com for tomorrow at 2pm"
  agentdom run --plan "Draft a Slack message about the new release"  # batch mode
  agentdom run --model=openai/gpt-4o "List my open GitHub PRs"

How it works:
  The agent reads a semantic tool catalog (not screenshots) and calls tools with typed args.
  Works with any text LLM. No vision model. No browser needed for API-backed tools.

Requires:
  Credentials:  agentdom setup <provider>   (one-time, per provider)
  LLM access:   agentdom setup openrouter.ai --key=sk-or-v1-xxx
                (or OPENROUTER_API_KEY / ANTHROPIC_API_KEY env vars)
`);
    return;
  }

  const runtime = new AgentRuntime(opts);
  runtime.run(goal).then(result => {
    if (result.ok) {
      console.log(`\n✓ Goal completed in ${result.steps_done} step${result.steps_done === 1 ? '' : 's'}`);
      if (result.result?.data) console.log(JSON.stringify(result.result.data, null, 2));
    } else {
      console.error(`\n✗ ${result.error}`);
      if (result.hint)  console.error(`  Hint: ${result.hint}`);
      if (result.plan)  console.error(`  Steps done: ${result.steps_done || 0}/${result.plan.steps?.length || 0}`);
      if (result.session_id) console.error(`  Resume: agentdom run --session=${result.session_id} "${goal}"`);
      process.exitCode = 1;
    }
  }).catch(e => {
    console.error(`\n✗ Runtime error: ${e.message}`);
    process.exitCode = 1;
  });
}

// Run directly: node lib/agent-runtime.js "<goal>"
if (require.main === module) main();

module.exports = { AgentRuntime, callLLM, buildToolCatalog, main };
