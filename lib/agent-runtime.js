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

const WALLET_FILE = path.join(os.homedir(), '.agentdom', 'wallet.json');

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

  // Load all polyfill manifests
  if (fs.existsSync(manifestDir)) {
    for (const file of fs.readdirSync(manifestDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf-8'));
        if (!m.capabilities?.length) continue;

        // Check if we have credentials for this provider
        const cred = await secrets.resolve(m.host);
        const authed = !!cred;

        for (const cap of m.capabilities) {
          tools.push({
            intent:      cap.intent,
            provider:    m.host,
            description: cap.description || cap.intent,
            args:        cap.params || cap.args || {},
            authed,
            side_effects: cap.side_effects || ['external'],
          });
        }
      } catch {}
    }
  }

  // Format for LLM
  const authedTools = tools.filter(t => t.authed);
  const unauthedTools = tools.filter(t => !t.authed);

  let catalog = `## Available tools (authenticated — can use now)\n\n`;

  // Always show built-ins first
  catalog += `### Built-in tools (always available)\n`;
  catalog += builtins.map(t =>
    `- dispatch_intent("${t.intent}", {}, "__builtin__") — ${t.description}`
  ).join('\n');

  const providerTools = authedTools.filter(t => t.provider !== '__builtin__');
  if (providerTools.length) {
    // Group by provider for readability
    const byProvider = {};
    for (const t of providerTools) {
      if (!byProvider[t.provider]) byProvider[t.provider] = [];
      byProvider[t.provider].push(t);
    }
    catalog += `\n\n### Provider tools (${providerTools.length} total)\n`;
    for (const [provider, pts] of Object.entries(byProvider)) {
      catalog += `\n**${provider}** (${pts.length} intents):\n`;
      // Show first 5 per provider to keep prompt size manageable
      catalog += pts.slice(0, 5).map(t =>
        `  - dispatch_intent("${t.intent}", {...}, "${provider}") — ${t.description}`
      ).join('\n');
      if (pts.length > 5) catalog += `\n  ... and ${pts.length - 5} more`;
    }
  } else {
    catalog += '\n\n(No provider tools authenticated — run `agentdom setup <provider>` to add)';
  }

  if (unauthedTools.length) {
    const unauthedProviders = [...new Set(unauthedTools.map(t => t.provider))];
    catalog += `\n\n### Available but not authenticated (${unauthedProviders.length} providers)\n`;
    catalog += unauthedProviders.map(p => `- ${p} — run \`agentdom setup ${p}\``).join('\n');
  }

  return { catalog, authedTools, allTools: tools };
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

    // Import the MCP server's dispatchIntent or use direct HTTP
    try {
      const mcp = desktopMCP || require('../desktop-mcp-server');
      if (typeof mcp.dispatchIntent === 'function') {
        return await mcp.dispatchIntent(intent, args, provider);
      }
    } catch {}

    // Fallback: direct HTTP dispatch via manifest
    const manifestDir = path.join(__dirname, '..', 'manifests');
    for (const file of fs.readdirSync(manifestDir)) {
      if (!file.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf-8'));
      if (!provider || m.host === provider || file === `${provider}.json`) {
        const cap = m.capabilities?.find(c => c.intent === intent);
        if (cap) {
          const cred = await secrets.resolveOrThrow(m.host);
          let url = cap.endpoint;
          url = url.replace(/\{(\w+)\}/g, (_, k) => args[k] || '');
          const authHeader = m.auth?.key_header || 'Authorization';
          const authValue = (m.auth?.key_format || 'Bearer {token}').replace('{token}', cred.token);
          const res = await fetch(url, {
            method: cap.method || 'GET',
            headers: { [authHeader]: authValue, 'Content-Type': 'application/json' },
            body: ['POST','PUT','PATCH'].includes(cap.method) ? JSON.stringify(args) : undefined,
            signal: AbortSignal.timeout(15000),
          });
          const data = res.ok ? await res.json() : { error: await res.text() };
          return { ok: res.ok, status: res.status, data };
        }
      }
    }
    return { ok: false, error: `No capability found for intent="${intent}" provider="${provider}"` };
  };
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
    this.model    = opts.model    || process.env.AGENTDOM_MODEL || 'anthropic/claude-sonnet-4-5';
    this.maxSteps = opts.maxSteps || 20;
    this.dryRun   = opts.dryRun   || !!process.env.AGENTDOM_DRY;
    this.verbose  = opts.verbose  ?? true;
    this.sessionId = opts.sessionId || null;
  }

  log(msg) {
    if (this.verbose) process.stderr.write(`[AgentDOM] ${msg}\n`);
  }

  /**
   * Run a goal autonomously.
   * Returns { ok, goal, plan, steps_done, result, error?, session_id }
   */
  async run(goal) {
    this.log(`Goal: ${goal}`);

    // 1. Build tool catalog
    const { catalog, authedTools } = await buildToolCatalog();
    this.log(`${authedTools.length} authenticated tools available`);

    if (authedTools.length === 0) {
      return {
        ok: false,
        error: 'No authenticated providers. Run: agentdom setup <provider>',
        hint: 'Example: agentdom setup linear.app  (OAuth)\n         agentdom setup resend.com   (API key)',
      };
    }

    // 2. Build LLM function for planner
    const model = this.model;
    const llm = async (prompt) => {
      const messages = [
        {
          role: 'system',
          content: `You are an autonomous AI agent powered by AgentDOM. You execute goals by composing dispatch_intent calls.\n\n${catalog}`,
        },
        { role: 'user', content: prompt },
      ];
      return callLLM(messages, { model });
    };

    // 3. Build dispatcher
    const dispatcher = makeDispatcher();

    // 4. Create planner and run
    const planner = new Planner({
      llm,
      dispatch:   dispatcher,
      maxRetries: 2,
      dryRun:     this.dryRun,
    });

    // Stream step progress
    const originalLog = console.error;
    console.error = (...args) => {
      if (this.verbose) process.stderr.write(args.join(' ') + '\n');
    };

    let result;
    try {
      result = await planner.run(goal, {
        sessionId: this.sessionId,
        maxSteps:  this.maxSteps,
      });
    } finally {
      console.error = originalLog;
    }

    return result;
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
  };

  if (!goal) {
    console.log(`
agentdom run "<goal>"  — run any goal autonomously

Options:
  --model=<model>    LLM model via OpenRouter (default: anthropic/claude-sonnet-4-5)
  --dry              Plan only — don't execute any steps
  --quiet            No progress output
  --max-steps=N      Cap at N steps (default: 20)
  --session=<id>     Resume a previous session

Examples:
  agentdom run "Create a Linear ticket for login crash, assign to alice@company.com"
  agentdom run "Send a summary email to team@company.com about today's deployments"
  agentdom run "Create a Notion page with Q2 OKRs and share it in the Engineering Slack channel"
  agentdom run --dry "Book a meeting with alice@company.com for tomorrow at 2pm"
  agentdom run --model=openai/gpt-4o "Draft a Slack message about the new release"

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
