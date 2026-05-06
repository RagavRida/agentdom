/**
 * AgentDOM — Reactive Agent Loop
 *
 * The core protocol engine. Agents understand and operate any UI/software
 * by reading semantic structure — NOT by seeing screenshots.
 *
 * The LLM receives text:
 *   "Available tools: login(email, password), search(query), submit_form(title, body)"
 *   "Previous result: { ok: true, data: { id: '123' } }"
 *
 * The LLM responds with structured JSON:
 *   { "tool": "login", "args": { "email": "alice@corp.com", "password": "$ENV_PASS" } }
 *
 * No screenshots. No coordinates. No vision model required.
 * Works with ANY text LLM (Claude, GPT-4o, Gemini, Llama, Mistral).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Architecture:
 *
 *   ReactiveAgent.run(goal)
 *       │
 *       ├── 1. scan()         → tool catalog (plain text, no images)
 *       │                       "login(email, password) — authenticate user"
 *       │
 *       ├── 2. LLM.decide()   → { tool, args, reasoning, done, result_summary }
 *       │                       LLM reasons over text, picks the right tool
 *       │
 *       ├── 3. execute(tool, args) → structured result { ok, data, error }
 *       │
 *       ├── 4. check goal     → LLM judges if goal is satisfied
 *       │
 *       └── 5. → repeat from step 1 (new scan reflects new state)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this beats vision agents:
 *
 *   Vision agent: screenshot → OCR → "click at (342, 219)" → brittle
 *   AgentDOM:     scan → "login(email, password)" → execute → reliable
 *
 *   - No screenshots = no vision model cost
 *   - No coordinates = no brittle selectors
 *   - Structured results = verifiable, not "did it work?" guessing
 *   - Any LLM = no dependency on multimodal
 *   - Headless-native = works in CI, server, CLI
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *
 *   const { ReactiveAgent } = require('./lib/reactive-agent');
 *
 *   const agent = new ReactiveAgent({
 *     llm:     async (messages) => callLLM(messages),
 *     scan:    async ()         => buildToolCatalog(),
 *     execute: async (tool, args) => dispatch(tool, args),
 *   });
 *
 *   const result = await agent.run("Create a Linear ticket for the login crash bug");
 *   // { ok: true, steps: 3, result: { id: 'RAG-42' }, trace: [...] }
 */

'use strict';

const memory = require('./memory');

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS  = 20;
const DEFAULT_MAX_TOKENS = 2000; // per tool catalog in context

// ── ReactiveAgent ─────────────────────────────────────────────────────────────

class ReactiveAgent {
  /**
   * @param {object}   opts
   * @param {function} opts.llm        — async (messages: [{role,content}]) => string
   * @param {function} opts.scan       — async () => { catalog: string, tools: object[] }
   * @param {function} opts.execute    — async (toolName: string, args: object) => { ok, data?, error? }
   * @param {number}  [opts.maxSteps]  — cap (default 20)
   * @param {boolean} [opts.verbose]   — stream trace to stderr
   * @param {string}  [opts.model]     — LLM model hint (passed through to llm fn)
   */
  constructor(opts = {}) {
    if (!opts.llm)     throw new Error('ReactiveAgent requires opts.llm');
    if (!opts.scan)    throw new Error('ReactiveAgent requires opts.scan');
    if (!opts.execute) throw new Error('ReactiveAgent requires opts.execute');

    this.llm     = opts.llm;
    this.scan    = opts.scan;
    this.execute = opts.execute;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.verbose  = opts.verbose  ?? true;
  }

  _log(msg) {
    if (this.verbose) process.stderr.write(`[ReactiveAgent] ${msg}\n`);
  }

  // ── Core loop ───────────────────────────────────────────────────────────────

  /**
   * Run a goal to completion, fully autonomously.
   *
   * @param {string} goal
   * @returns {{ ok, goal, steps, result, trace, error? }}
   */
  async run(goal) {
    this._log(`Goal: "${goal}"`);

    const trace         = [];  // full execution trace (for inspection/debug)
    let   lastResult    = null;
    let   contextWindow = [];  // rolling context of what happened so far

    for (let step = 1; step <= this.maxSteps; step++) {
      this._log(`── Step ${step}/${this.maxSteps} ──`);

      // ── 1. Scan current state → tool catalog (TEXT, no images) ──────────────
      let catalog, availableTools;
      try {
        const scanResult  = await this.scan();
        catalog           = scanResult.catalog || String(scanResult);
        availableTools    = scanResult.tools    || [];
      } catch (e) {
        this._log(`Scan failed: ${e.message}`);
        catalog        = '(scan failed — no tools available)';
        availableTools = [];
      }

      if (!availableTools.length && step === 1) {
        return { ok: false, goal, steps: 0, error: 'No tools available. Run: agentdom setup <provider>', trace };
      }

      // ── 2. Build LLM context ─────────────────────────────────────────────────
      const systemPrompt = this._buildSystemPrompt(catalog);
      const userMessage  = this._buildUserMessage(goal, contextWindow, lastResult, step);

      // ── 3. LLM decides: which tool to call, with what args ───────────────────
      let decision;
      try {
        const raw = await this.llm([
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ]);
        decision = this._parseDecision(raw);
      } catch (e) {
        this._log(`LLM error: ${e.message}`);
        return { ok: false, goal, steps: step - 1, error: `LLM failed: ${e.message}`, trace };
      }

      this._log(`Decision: ${decision.tool}(${JSON.stringify(decision.args)})`);
      if (decision.reasoning) this._log(`Reasoning: ${decision.reasoning}`);

      // ── 4. Goal already satisfied? ───────────────────────────────────────────
      if (decision.done) {
        this._log(`✓ Goal satisfied: ${decision.result_summary || 'done'}`);
        memory.remember({ type: 'goal_run', goal, outcome: 'success',
          notes: `Completed in ${step - 1} steps: ${decision.result_summary || ''}` });
        return {
          ok:     true,
          goal,
          steps:  step - 1,
          result: lastResult?.data ?? lastResult,
          summary: decision.result_summary,
          trace,
        };
      }

      // ── 5. Validate decision ─────────────────────────────────────────────────
      if (!decision.tool) {
        this._log('No tool selected — treating as done');
        return { ok: false, goal, steps: step, error: 'LLM returned no tool and did not mark done', trace };
      }

      // ── 6. Execute the tool ──────────────────────────────────────────────────
      let result;
      try {
        result = await this.execute(decision.tool, decision.args || {});
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      this._log(`Result: ok=${result.ok} ${result.error || JSON.stringify(result.data || '').slice(0, 80)}`);

      // Record in trace
      const traceEntry = {
        step,
        tool:      decision.tool,
        args:      decision.args,
        reasoning: decision.reasoning,
        result,
      };
      trace.push(traceEntry);
      lastResult = result;

      // Update rolling context
      contextWindow.push({
        tool:   decision.tool,
        args:   decision.args,
        result: this._summarizeResult(result),
      });
      // Keep context window bounded (last 8 steps)
      if (contextWindow.length > 8) contextWindow = contextWindow.slice(-8);

      // ── 7. Persist failure to memory for future planning ─────────────────────
      if (!result.ok) {
        memory.remember({ type: 'failure', goal, intent: decision.tool, outcome: 'failure',
          notes: result.error || 'unknown', tags: ['reactive_loop'] });
      }
    }

    // Max steps reached
    memory.remember({ type: 'goal_run', goal, outcome: 'failure',
      notes: `Reached max steps (${this.maxSteps}) without completing goal` });
    return {
      ok:    false,
      goal,
      steps: this.maxSteps,
      error: `Max steps (${this.maxSteps}) reached without completing goal`,
      trace,
    };
  }

  // ── LLM prompt construction ──────────────────────────────────────────────────

  _buildSystemPrompt(catalog) {
    return `You are an autonomous agent powered by AgentDOM. You operate software by calling semantic tools — NOT by seeing screenshots.

The tools are derived from the real structure of the software (DOM, API, CLI). You reason over text and call tools with typed arguments.

AVAILABLE TOOLS:
${catalog.slice(0, DEFAULT_MAX_TOKENS * 4)}

RESPONSE FORMAT — respond with ONLY valid JSON, no markdown:
{
  "reasoning": "one sentence: why this tool, why these args",
  "tool": "exact_tool_name",
  "args": { "param": "value" },
  "done": false
}

If the goal is already achieved from previous steps, respond with:
{
  "reasoning": "goal is complete because ...",
  "done": true,
  "result_summary": "one sentence summary of what was accomplished"
}

RULES:
- Call EXACTLY ONE tool per response.
- Use only tools from the catalog above.
- Args must match the tool's parameter types exactly.
- If a previous result contains an ID you need, use it directly in args.
- "done": true only when the goal is verifiably complete.`;
  }

  _buildUserMessage(goal, contextWindow, lastResult, step) {
    const lines = [`GOAL: "${goal}"`];

    if (contextWindow.length > 0) {
      lines.push(`\nPREVIOUS STEPS (${contextWindow.length}):`);
      contextWindow.forEach((ctx, i) => {
        lines.push(`  Step ${i + 1}: ${ctx.tool}(${JSON.stringify(ctx.args)}) → ${ctx.result}`);
      });
    }

    if (lastResult) {
      lines.push(`\nLAST RESULT:\n${JSON.stringify(lastResult, null, 2).slice(0, 800)}`);
    }

    lines.push(`\nStep ${step}: What should I do next? (or mark done if goal is achieved)`);
    return lines.join('\n');
  }

  // ── Response parsing ─────────────────────────────────────────────────────────

  _parseDecision(raw) {
    const json = raw.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '');

    try {
      const d = JSON.parse(json);
      return {
        reasoning:      d.reasoning      || '',
        tool:           d.tool           || null,
        args:           d.args           || {},
        done:           d.done           === true,
        result_summary: d.result_summary || '',
      };
    } catch (_) {
      // Fallback: try to extract tool name from malformed response
      const toolMatch = raw.match(/"tool"\s*:\s*"([^"]+)"/);
      const argsMatch = raw.match(/"args"\s*:\s*(\{[^}]*\})/);
      return {
        reasoning: 'parsed from malformed response',
        tool:  toolMatch?.[1]  || null,
        args:  argsMatch ? JSON.parse(argsMatch[1]) : {},
        done:  raw.includes('"done": true') || raw.includes('"done":true'),
      };
    }
  }

  _summarizeResult(result) {
    if (!result) return 'null';
    if (!result.ok) return `ERROR: ${result.error || 'unknown'}`;
    if (result.data) {
      const d = result.data;
      // Extract the most useful single value
      if (d.id)    return `ok, id=${d.id}`;
      if (d.url)   return `ok, url=${d.url}`;
      if (d.count !== undefined) return `ok, count=${d.count}`;
      return `ok, ${Object.keys(d).slice(0, 3).join(',')}`;
    }
    return 'ok';
  }
}

// ── Factory: wire into AgentRuntime ──────────────────────────────────────────

/**
 * Create a ReactiveAgent wired to the AgentDOM runtime.
 * Handles: tool catalog scan, CDP browser dispatch, API dispatch, LLM calls.
 *
 * @param {function} llm          — callLLM already bound to model
 * @param {function} buildCatalog — buildToolCatalog()
 * @param {function} dispatch     — makeDispatcher()
 * @param {object}  [opts]
 * @returns {ReactiveAgent}
 */
function createAgent({ llm, buildCatalog, dispatch, ...opts }) {
  return new ReactiveAgent({
    ...opts,
    llm,

    scan: async () => {
      const { catalog, authedTools } = await buildCatalog();
      return {
        catalog,
        tools: authedTools,
      };
    },

    execute: async (toolName, args) => {
      // Resolve tool → intent + provider
      const { allTools } = await buildCatalog();
      const tool = allTools.find(t => t.intent === toolName || t.name === toolName);
      const intent   = tool?.intent   || toolName;
      const provider = tool?.provider || null;
      return dispatch(intent, args, provider);
    },
  });
}

module.exports = { ReactiveAgent, createAgent };
