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
  if (authedTools.length) {
    catalog += authedTools.map(t =>
      `- dispatch_intent("${t.intent}", {...}, "${t.provider}") — ${t.description}`
    ).join('\n');
  } else {
    catalog += '(none — run `agentdom setup <provider>` to authenticate)';
  }

  if (unauthedTools.length) {
    catalog += `\n\n## Additional tools (need credentials)\n\n`;
    catalog += unauthedTools.map(t =>
      `- ${t.intent} @ ${t.provider} — run \`agentdom setup ${t.provider}\` first`
    ).join('\n');
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

  // Fallback: Anthropic direct
  const anthropicKey = process.env.ANTHROPIC_API_KEY
    || (await secrets.resolve('anthropic.com'))?.token;
  if (anthropicKey) {
    const sys = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.replace('anthropic/', '') || 'claude-sonnet-4-5-20251101',
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

  throw new Error(
    'No LLM configured.\n' +
    'Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, ' +
    'or run: agentdom setup openrouter.ai'
  );
}

// ── dispatch_intent wrapper for planner ──────────────────────────────────────

function makeDispatcher(desktopMCP) {
  return async function dispatch(intent, args, provider) {
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

// ── CLI entry ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const goal = argv.filter(a => !a.startsWith('--')).join(' ');
  const opts = {
    model:    (argv.find(a => a.startsWith('--model=')) || '').replace('--model=', '') || undefined,
    dryRun:   argv.includes('--dry'),
    verbose:  !argv.includes('--quiet'),
    maxSteps: parseInt((argv.find(a => a.startsWith('--max-steps=')) || '').replace('--max-steps=', '') || '20', 10),
  };

  if (!goal) {
    console.log(`
agentdom run "<goal>"  — run any goal autonomously

Options:
  --model=claude-sonnet-4-5    LLM model via OpenRouter (default)
  --dry                        Plan only, don't execute
  --quiet                      No progress output
  --max-steps=N                Cap at N steps (default: 20)

Examples:
  agentdom run "Create a Linear ticket for login crash, assign to alice@company.com"
  agentdom run "Send a summary email to team@company.com about today's deployments"
  agentdom run "Create a Notion page with Q2 OKRs and share it in the Engineering Slack channel"
  agentdom run --dry "Book a meeting with alice@company.com for tomorrow at 2pm"

Requires:
  1. Credentials set up: agentdom setup <provider>
  2. LLM access: agentdom setup openrouter.ai --key=sk-or-v1-xxx
     (or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, etc.)
`);
    process.exit(0);
  }

  const runtime = new AgentRuntime(opts);
  runtime.run(goal).then(result => {
    if (result.ok) {
      console.log(`\n✓ Goal completed (${result.steps_done} steps)`);
      if (result.result) console.log(JSON.stringify(result.result, null, 2));
    } else {
      console.error(`\n✗ Goal failed: ${result.error}`);
      if (result.hint) console.error(`  Hint: ${result.hint}`);
      if (result.plan) {
        console.error(`  Steps completed: ${result.steps_done || 0}/${result.plan.steps?.length || 0}`);
        console.error(`  Session ID: ${result.session_id} (use --session=${result.session_id} to resume)`);
      }
      process.exit(1);
    }
  }).catch(e => {
    console.error(`\n✗ Runtime error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { AgentRuntime, callLLM, buildToolCatalog };
