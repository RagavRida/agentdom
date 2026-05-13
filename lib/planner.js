/**
 * AgentDOM — Autonomous Agent Planner Runtime v2
 *
 * The core execution engine for fully autonomous, human-out-of-the-loop agent runs.
 *
 * Implements all 5 hard runtime problems:
 *
 *  1. GOAL DECOMPOSITION & CLARIFICATION
 *     Before planning, detects ambiguous/underspecified goals and either:
 *     - Auto-resolves with a safe assumption (logged to memory)
 *     - Decomposes complex goals into focused sub-goals
 *     - Only blocks if truly impossible to proceed safely
 *
 *  2. SEMANTIC PLANNING LOOP
 *     - LLM generates a full structured plan with typed steps
 *     - Each step declares: intent, args, side_effects, verify expression
 *     - Steps reference previous results via $stepId.path interpolation
 *     - Plan is serialized to disk (resumes after crash)
 *
 *  3. RESULT VALIDATION (not just ok:true)
 *     Three-layer validation per step:
 *       a. Envelope check   — result.ok !== false
 *       b. Shape check      — verify expression (LLM-generated JS)
 *       c. Semantic check   — LLM judges whether result actually satisfies the step
 *
 *  4. INTELLIGENT REPLANNING
 *     On failure: LLM receives full context (what failed, why, what was tried)
 *     and produces revised steps — NOT a blind retry.
 *     Adaptive backoff: 500ms → 1s → 2s per attempt.
 *     Max replan cycles before giving up: configurable (default 3).
 *
 *  5. WORKING MEMORY & CROSS-STEP CONTEXT
 *     - $stepId.path arg interpolation
 *     - Structured working_memory per session
 *     - Long-term memory (failures + hints) injected into every plan prompt
 *     - Session checkpoint: crash-safe, resumable
 */

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { atomicWrite }    = require('./resilience');
const { check: policyCheck } = require('./policy');
const memory = require('./memory');
const { interpolateArgs, planBranch, evaluateVerify } = require('./runtime-helpers');

const SESSIONS_DIR  = path.join(os.homedir(), '.agentdom', 'sessions');
const MAX_REPLAN_CYCLES = 3;

// ── Planner class ─────────────────────────────────────────────────────────────

class Planner {
  /**
   * @param {object} opts
   * @param {function} opts.llm          — async (messages: [{role,content}]) => string
   * @param {function} opts.dispatch     — async (intent, args, provider) => envelope
   * @param {function} [opts.toolCall]   — async (toolName, args) => any  (MCP fallback)
   * @param {number}   [opts.maxRetries] — retries per step before replanning (default 2)
   * @param {number}   [opts.maxReplanCycles] — max replan loops before giving up (default 3)
   * @param {boolean}  [opts.dryRun]     — plan only, skip execution
   * @param {boolean}  [opts.semanticVerify] — use LLM for result validation (default true)
   */
  constructor(opts = {}) {
    this.llm            = opts.llm       || null;
    this.dispatch       = opts.dispatch  || null;
    this.toolCall       = opts.toolCall  || null;
    this.maxRetries     = opts.maxRetries     ?? 2;
    this.maxReplanCycles = opts.maxReplanCycles ?? MAX_REPLAN_CYCLES;
    this.dryRun         = opts.dryRun    || !!process.env.AGENTDOM_DRY;
    this.semanticVerify = opts.semanticVerify ?? true;
  }

  // ── Session management ──────────────────────────────────────────────────────

  _sessionPath(id) {
    if (!fs.existsSync(SESSIONS_DIR))
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    return path.join(SESSIONS_DIR, `${id}.json`);
  }

  _save(plan) {
    atomicWrite(this._sessionPath(plan.id), plan, { mode: 0o600 });
  }

  _load(sessionId) {
    const f = this._sessionPath(sessionId);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
  }

  // ── 1. Goal clarification & decomposition ───────────────────────────────────

  /**
   * Detects ambiguous or underspecified goals.
   * Returns { clear: true } if the goal is actionable.
   * Returns { clear: false, assumption, clarified_goal } if auto-resolved.
   * Returns { blocked: true, reason } only if fundamentally unresolvable.
   */
  async _clarifyGoal(goal, catalog) {
    if (!this.llm) return { clear: true };

    const prompt = `You are an autonomous agent planner. Analyze this goal for actionability.

GOAL: "${goal}"

AVAILABLE TOOLS:
${catalog}

Respond with ONLY valid JSON (no markdown):
{
  "actionable": true|false,
  "ambiguities": [],          // list of ambiguous parts (empty if none)
  "assumption": null,          // if ambiguous, what safe assumption resolves it?
  "clarified_goal": null,      // rewritten goal after applying assumption
  "sub_goals": null,           // if goal is complex, array of focused sub-goals
  "blocked_reason": null       // only set if truly impossible (missing auth, etc.)
}

Rules:
- PREFER to resolve ambiguity with a safe assumption rather than blocking.
- Only set blocked_reason if the goal literally cannot be done with available tools.
- If goal is simple and clear, return { "actionable": true, "ambiguities": [] }.`;

    try {
      const raw = await this.llm([{ role: 'user', content: prompt }]);
      const json = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
      const r = JSON.parse(json);
      if (r.blocked_reason) return { blocked: true, reason: r.blocked_reason };
      if (!r.actionable && r.assumption) {
        console.error(`[Planner] Ambiguity resolved: ${r.assumption}`);
        memory.remember({ type: 'hint', goal, outcome: 'partial', notes: `Auto-assumption: ${r.assumption}`, tags: ['clarification'] });
        return { clear: false, assumption: r.assumption, clarified_goal: r.clarified_goal || goal, sub_goals: r.sub_goals };
      }
      if (r.sub_goals && r.sub_goals.length > 1) {
        return { clear: true, sub_goals: r.sub_goals };
      }
    } catch (_) {}
    return { clear: true };
  }

  // ── 2. Plan generation ──────────────────────────────────────────────────────

  /**
   * Ask the LLM to produce a structured execution plan.
   * Injects long-term memory (failures + hints) for informed planning.
   */
  async _generatePlan(goal, opts = {}) {
    if (!this.llm) throw new Error('Planner requires an `llm` function.');

    const memCtx = memory.promptContext(opts.provider || null, null);

    const prompt = `You are an AgentDOM autonomous plan generator.

GOAL: ${goal}
${memCtx ? '\n' + memCtx + '\n' : ''}
AVAILABLE TOOLS (use dispatch_intent for these):
${opts.catalog || '(see system prompt)'}

Produce a JSON execution plan. Respond with ONLY valid JSON (no markdown fences):
{
  "steps": [
    {
      "id": "s1",
      "description": "one-sentence explanation of what this step does",
      "intent": "contacts.create",
      "provider": "hubspot.com",
      "tool": null,
      "args": { "email": "x@y.com", "name": "Alice" },
      "side_effects": ["external"],
      "verify": "result.ok === true && result.data?.id != null",
      "fallback_intent": null
    }
  ]
}

Rules:
- Each step does exactly ONE atomic action.
- intent is the semantic name (preferred). tool is a raw MCP tool name (fallback).
- fallback_intent: alternative intent if primary fails (optional).
- side_effects must be accurate: read | write_local | send | external | delete | payment
- verify: JS expression evaluated with { result, ok } in scope.
  Write expressions that check the actual data shape, not just ok===true.
  Example: "result.data?.id && result.data.status !== 'error'"
- Args can reference previous step results: "$s1.data.id"
- Order steps so each has all dependencies satisfied by prior steps.`;

    const raw    = await this.llm([{ role: 'user', content: prompt }]);
    const json   = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(json);

    if (!Array.isArray(parsed.steps)) throw new Error('LLM returned plan without steps array.');
    if (parsed.steps.length === 0)    throw new Error('LLM returned empty plan.');

    const id = opts.sessionId || crypto.randomBytes(8).toString('hex');
    return {
      id,
      goal,
      created:  new Date().toISOString(),
      status:   'pending',
      replan_cycles: 0,
      steps: parsed.steps.map((s, i) => ({
        id:           s.id           || `s${i + 1}`,
        intent:       s.intent       || null,
        provider:     s.provider     || null,
        tool:         s.tool         || null,
        fallback_intent: s.fallback_intent || null,
        args:         s.args         || {},
        description:  s.description  || '',
        side_effects: s.side_effects || ['read'],
        verify:       s.verify       || null,
        status:       'pending',
        result:       null,
        error:        null,
        attempts:     0,
      })),
      working_memory: {},
      // Gap 1A: parallel index keyed by intent name (stores result.data).
      working_memory_by_intent: {},
      // Gap 1C: plan-level verify expression (optional). When set, evaluated
      // against the last step's result after all steps succeed.
      verify: parsed.verify || null,
      completed: -1,
    };
  }

  // ── 3. Pre-execution validation ─────────────────────────────────────────────

  async _validatePlan(plan) {
    const issues = [];
    for (const step of plan.steps) {
      if (!step.intent && !step.tool)
        issues.push(`Step ${step.id}: must have intent or tool.`);
      const policyResult = await policyCheck(step.side_effects || [], { intent: step.intent });
      if (policyResult.decision === 'deny')
        issues.push(`Step ${step.id}: policy denies effect "${policyResult.blocked_by}".`);
    }
    return { valid: issues.length === 0, issues };
  }

  // ── Working memory arg resolution ───────────────────────────────────────────

  /**
   * Resolve $stepId.path references from working_memory.
   * Handles nested paths: $s1.data.contact.id
   * Falls through gracefully if reference not found.
   */
  _resolveArgs(args, workingMemory) {
    const resolveValue = (v) => {
      if (typeof v !== 'string') return v;
      // Full replacement if entire value is a reference
      if (/^\$(\w+)\.([\w.]+)$/.test(v)) {
        const [, stepId, keyPath] = v.match(/^\$(\w+)\.([\w.]+)$/);
        const base = workingMemory[stepId];
        if (!base) return v;
        const val = keyPath.split('.').reduce((o, k) => o?.[k], base);
        return val !== undefined ? val : v;
      }
      // Inline replacement within a string template
      return v.replace(/\$(\w+)\.([\w.]+)/g, (_, stepId, keyPath) => {
        const base = workingMemory[stepId];
        if (!base) return _;
        const val = keyPath.split('.').reduce((o, k) => o?.[k], base);
        return val !== undefined ? String(val) : _;
      });
    };
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = (typeof v === 'object' && v !== null)
        ? this._resolveArgs(v, workingMemory)
        : resolveValue(v);
    }
    return out;
  }

  // ── 4. Three-layer result validation ────────────────────────────────────────

  /**
   * Layer 1: Envelope check (ok !== false)
   * Layer 2: Verify expression (LLM-generated JS)
   * Layer 3: Semantic check (LLM judges whether result satisfies step)
   *
   * Returns { passed: bool, layer: string, reason?: string }
   */
  async _validate(step, goal) {
    const result = step.result;

    // Layer 1: envelope
    if (result?.ok === false) {
      return { passed: false, layer: 'envelope', reason: result.error || 'Step returned ok:false' };
    }
    if (result?.dry_run) return { passed: false, layer: 'dry_run', reason: 'dry_run — verification skipped' };

    // Layer 2: verify expression
    if (step.verify && result) {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('result', 'ok', `return !!(${step.verify});`);
        const passed = fn(result, result?.ok);
        if (!passed) {
          return { passed: false, layer: 'expression', reason: `Verification failed: ${step.verify}` };
        }
      } catch (e) {
        return { passed: false, layer: 'expression', reason: `verify expression error: ${e.message}` };
      }
    }

    // Layer 3: semantic check (only for non-read steps, when LLM available)
    if (this.semanticVerify && this.llm && step.side_effects?.some(e => e !== 'read')) {
      try {
        const check = await this.llm([{
          role: 'user',
          content: `Did this step succeed in advancing the goal?

GOAL: "${goal}"
STEP: "${step.description}" (intent: ${step.intent || step.tool})
RESULT: ${JSON.stringify(result?.data ?? result, null, 2).slice(0, 800)}

Respond with ONLY JSON: { "ok": true|false, "reason": "one sentence" }`,
        }]);
        const parsed = JSON.parse(check.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''));
        if (parsed.ok === false) {
          return { passed: false, layer: 'semantic', reason: parsed.reason || 'LLM judged step as failed' };
        }
      } catch (_) { /* semantic check is best-effort */ }
    }

    return { passed: true, layer: 'all' };
  }

  // ── Disambiguation ──────────────────────────────────────────────────────────

  _handleAmbiguity(result) {
    if (!result?.ambiguous) return null;
    return {
      ambiguous:  true,
      candidates: result.candidates || [],
      default:    result.candidates?.[0] || null,
      reason:     result.reason || 'Multiple matches found.',
      hint:       'Specify a more precise identifier or select a candidate by id.',
    };
  }

  // ── 5. Intelligent replanning ────────────────────────────────────────────────

  /**
   * Generate revised steps when a step fails.
   * Passes the full failure context to the LLM — not a blind retry.
   * Returns { revised_steps } | { give_up, reason } | null
   */
  async _replan(plan, failedStep, failureContext) {
    if (!this.llm || plan.replan_cycles >= this.maxReplanCycles) {
      return { give_up: true, reason: `Max replan cycles (${this.maxReplanCycles}) reached.` };
    }

    const completedSteps = plan.steps
      .slice(0, plan.completed + 1)
      .map(s => ({ id: s.id, intent: s.intent, status: s.status, description: s.description }));

    const prompt = `An AgentDOM plan step failed. Generate revised steps to still achieve the goal.

ORIGINAL GOAL: "${plan.goal}"
COMPLETED SO FAR: ${JSON.stringify(completedSteps)}
WORKING MEMORY: ${JSON.stringify(Object.keys(plan.working_memory))} (${Object.keys(plan.working_memory).length} results stored)
FAILED STEP: ${JSON.stringify({ id: failedStep.id, intent: failedStep.intent, args: failedStep.args, description: failedStep.description })}
FAILURE REASON: "${failureContext}"
REPLAN CYCLE: ${plan.replan_cycles + 1}/${this.maxReplanCycles}

Options:
1. Retry with different args or a different intent
2. Add a prerequisite step (e.g. look up an ID before using it)
3. Use a fallback_intent
4. Give up if truly impossible

Respond with ONLY JSON (no markdown):
{ "revised_steps": [ ...same step schema... ] }
OR
{ "give_up": true, "reason": "why it's impossible" }`;

    try {
      const raw    = await this.llm([{ role: 'user', content: prompt }]);
      const json   = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(json);
      if (parsed.give_up)           return { give_up: true, reason: parsed.reason };
      if (parsed.revised_steps?.length) return { revised_steps: parsed.revised_steps };
    } catch (_) {}
    return null;
  }

  // ── Step execution ──────────────────────────────────────────────────────────

  async _executeStep(step, plan) {
    // Step 1: existing $stepId.path interpolation (keyed by step id).
    let resolvedArgs = this._resolveArgs(step.args, plan.working_memory);
    // Step 2 (Gap 1A): {{ intent.path }} interpolation (keyed by intent name).
    // Falls through silently when the second pass finds nothing to do.
    const intentMem = plan.working_memory_by_intent || {};
    const interp = interpolateArgs(resolvedArgs, intentMem);
    resolvedArgs = interp.value;
    if (interp.unresolved && interp.unresolved.length) {
      step._unresolved_refs = interp.unresolved;
    }

    // Policy gate
    const policy = await policyCheck(step.side_effects || [], { intent: step.intent });
    if (policy.decision === 'deny') {
      return { ok: false, error: policy.error, policy_blocked: true, hint: policy.hint };
    }
    if (policy.decision === 'prompt') {
      // In headless mode, record this and skip (don't block the agent)
      memory.remember({ type: 'hint', goal: plan.goal, intent: step.intent, outcome: 'partial',
        notes: `Step skipped — policy requires approval for effect: ${policy.blocked_by}`, tags: ['policy'] });
      return { ok: false, error: `Policy requires approval for: ${policy.blocked_by}`, policy_pending: true };
    }

    if (this.dryRun) {
      return { ok: true, dry_run: true, would_have_called: { intent: step.intent, tool: step.tool, args: resolvedArgs } };
    }

    // Execute with optional fallback
    const tryExecute = async (intent, tool) => {
      if (intent && this.dispatch) return this.dispatch(intent, resolvedArgs, step.provider);
      if (tool && this.toolCall)   return { ok: true, data: await this.toolCall(tool, resolvedArgs) };
      return { ok: false, error: `No executor for intent="${intent}" tool="${tool}"` };
    };

    let result = await tryExecute(step.intent, step.tool);

    // Try fallback intent if primary failed and fallback is specified
    if (result?.ok === false && step.fallback_intent) {
      console.error(`[Planner] Step ${step.id} primary failed, trying fallback: ${step.fallback_intent}`);
      result = await tryExecute(step.fallback_intent, null);
      if (result?.ok !== false) {
        step.used_fallback = step.fallback_intent;
      }
    }

    // Gap 1B: structured on_fail branch. Independent of fallback_intent —
    // on_fail carries full {intent, args} so the branch can target a
    // different provider or use different args entirely.
    if (result?.ok === false) {
      const branch = planBranch(step, result);
      if (branch.shouldBranch) {
        console.error(`[Planner] Step ${step.id} primary failed, executing on_fail branch: ${branch.branchStep.intent}`);
        // Resolve the branch's args using the same two-pass interpolation.
        let branchArgs = this._resolveArgs(branch.branchStep.args || {}, plan.working_memory);
        branchArgs = interpolateArgs(branchArgs, intentMem).value;
        const branchProvider = branch.branchStep.provider || step.provider;
        const branchResult = (branch.branchStep.intent && this.dispatch)
          ? await this.dispatch(branch.branchStep.intent, branchArgs, branchProvider)
          : { ok: false, error: 'on_fail has no executable intent' };
        step.used_on_fail = branch.branchStep.intent;
        if (branchResult?.ok !== false) return branchResult;
        // Both attempts failed — surface the on_fail error and mark.
        return {
          ...branchResult,
          ok: false,
          primary_error: result.error,
          on_fail_error: branchResult.error,
        };
      }
    }

    return result;
  }

  // ── Main run loop ───────────────────────────────────────────────────────────

  /**
   * Execute a goal fully autonomously.
   * No human interaction required after credential setup.
   *
   * @param {string} goal
   * @param {object} [opts]
   * @param {string}  [opts.sessionId]    — resume existing session
   * @param {number}  [opts.maxSteps]     — cap (default 20)
   * @param {string}  [opts.provider]     — force a specific provider
   * @param {string}  [opts.catalog]      — tool catalog string for LLM context
   * @param {boolean} [opts.validateOnly] — plan + validate but don't execute
   * @returns {object} { ok, goal, plan, result?, error?, steps_done, session_id }
   */
  async run(goal, opts = {}) {
    const maxSteps = opts.maxSteps ?? 20;
    let plan;

    // ── Resume or create session ───────────────────────────────────────────
    if (opts.sessionId) {
      plan = this._load(opts.sessionId);
      if (!plan) return { ok: false, error: `Session "${opts.sessionId}" not found.` };
      console.error(`[Planner] Resuming session ${opts.sessionId} (${plan.completed + 1}/${plan.steps.length} done)`);
    } else {
      // ── Goal clarification ─────────────────────────────────────────────
      const clarity = await this._clarifyGoal(goal, opts.catalog || '');
      if (clarity.blocked) {
        memory.remember({ type: 'goal_run', goal, outcome: 'failure', notes: `Blocked: ${clarity.reason}` });
        return { ok: false, error: clarity.reason, blocked: true };
      }
      // Use clarified goal and auto-assumption if needed
      const effectiveGoal = clarity.clarified_goal || goal;

      // ── Handle multi-step goal decomposition ───────────────────────────
      if (clarity.sub_goals?.length > 1) {
        console.error(`[Planner] Goal decomposed into ${clarity.sub_goals.length} sub-goals`);
        const results = [];
        for (const sub of clarity.sub_goals) {
          console.error(`[Planner] Sub-goal: ${sub}`);
          const subResult = await this.run(sub, { ...opts, sessionId: null });
          results.push(subResult);
          if (!subResult.ok) {
            memory.remember({ type: 'goal_run', goal, outcome: 'failure', notes: `Sub-goal failed: ${sub}` });
            return { ok: false, goal, error: `Sub-goal failed: "${sub}" — ${subResult.error}`, sub_results: results };
          }
        }
        memory.remember({ type: 'goal_run', goal, outcome: 'success', notes: `Completed ${clarity.sub_goals.length} sub-goals` });
        return { ok: true, goal, sub_results: results, steps_done: results.reduce((n, r) => n + (r.steps_done || 0), 0) };
      }

      plan = await this._generatePlan(effectiveGoal, opts);
      console.error(`[Planner] Generated plan with ${plan.steps.length} steps (session: ${plan.id})`);
    }

    // ── Pre-validate ───────────────────────────────────────────────────────
    const validation = await this._validatePlan(plan);
    if (!validation.valid) {
      memory.remember({ type: 'goal_run', goal, outcome: 'failure',
        notes: `Plan validation failed: ${validation.issues.join('; ')}` });
      return { ok: false, error: 'Plan validation failed.', issues: validation.issues, plan };
    }

    if (opts.validateOnly) {
      return { ok: true, plan, validated: true };
    }

    plan.status = 'running';
    this._save(plan);

    // ── Execution loop ─────────────────────────────────────────────────────
    let lastResult = null;

    for (let i = plan.completed + 1; i < Math.min(plan.steps.length, maxSteps); i++) {
      const step = plan.steps[i];
      step.status   = 'running';
      step.attempts = (step.attempts || 0) + 1;
      console.error(`[Planner] Step ${i + 1}/${plan.steps.length}: ${step.description || step.intent || step.tool}`);

      let result = null;
      let lastError = null;

      // Retry loop with exponential backoff
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          result    = await this._executeStep(step, plan);
          lastError = result?.ok === false ? result.error : null;
          if (result?.ok !== false) break;
        } catch (e) {
          lastError = e.message;
          result    = { ok: false, error: e.message };
        }
        if (attempt < this.maxRetries) {
          const delay = 500 * Math.pow(2, attempt);
          console.error(`[Planner] Step ${step.id} attempt ${attempt + 1} failed: ${lastError} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      step.result = result;
      lastResult  = result;

      // Disambiguation check
      const ambig = this._handleAmbiguity(result);
      if (ambig) {
        step.status = 'failed';
        plan.status = 'needs_clarification';
        this._save(plan);
        memory.remember({ type: 'goal_run', goal, outcome: 'partial',
          notes: `Ambiguous at step ${step.id}: ${ambig.reason}`, tags: ['ambiguity'] });
        return { ok: false, plan, ambiguity: ambig, steps_done: i, session_id: plan.id };
      }

      // Three-layer validation
      const vr = await this._validate(step, goal);
      if (!vr.passed) {
        step.error  = vr.reason;
        step.status = 'failed';
        console.error(`[Planner] Verification failed [${vr.layer}]: ${step.error}`);
        memory.remember({ type: 'failure', goal, intent: step.intent, outcome: 'failure',
          notes: `[${vr.layer}] ${step.error}`, tags: ['verify_failed'] });

        // Intelligent replan
        const replanResult = await this._replan(plan, step, step.error);
        plan.replan_cycles = (plan.replan_cycles || 0) + 1;

        if (replanResult?.give_up) {
          plan.status = 'failed';
          plan.error  = replanResult.reason;
          this._save(plan);
          memory.remember({ type: 'goal_run', goal, outcome: 'failure',
            notes: `Gave up: ${replanResult.reason}` });
          return { ok: false, error: replanResult.reason, plan, steps_done: i, session_id: plan.id };
        }

        if (replanResult?.revised_steps?.length) {
          console.error(`[Planner] Replanning (cycle ${plan.replan_cycles}/${this.maxReplanCycles}) with ${replanResult.revised_steps.length} revised steps`);
          plan.steps = [
            ...plan.steps.slice(0, i + 1),
            ...replanResult.revised_steps.map((s, j) => ({
              id: s.id || `r${plan.replan_cycles}_${j + 1}`,
              intent:       s.intent       || null,
              provider:     s.provider     || null,
              tool:         s.tool         || null,
              fallback_intent: s.fallback_intent || null,
              args:         s.args         || {},
              description:  s.description  || '',
              side_effects: s.side_effects || ['read'],
              verify:       s.verify       || null,
              status:       'pending',
              result:       null, error: null, attempts: 0,
            })),
          ];
        }

        this._save(plan);
        continue;
      }

      // Step done
      step.status = 'done';
      plan.completed = i;
      plan.working_memory[step.id] = result;
      // Gap 1A: also key by intent name → result.data so subsequent steps
      // can reference {{ intent.field }} without knowing step ids.
      if (!plan.working_memory_by_intent) plan.working_memory_by_intent = {};
      if (step.intent) {
        plan.working_memory_by_intent[step.intent] = result?.data ?? result;
      }
      this._save(plan);
      console.error(`[Planner] ✓ Step ${step.id} done`);
    }

    // ── Goal completion ────────────────────────────────────────────────────
    const allDone = plan.steps.every(s => s.status === 'done' || s.status === 'skipped');
    plan.status   = allDone ? 'done' : 'failed';
    plan.error    = allDone ? undefined : 'Not all steps completed.';

    // Gap 1C: plan-level verify against the final result. Only checked
    // when every step succeeded — a failed plan has its own error path.
    if (allDone && plan.verify) {
      const ver = evaluateVerify(plan.verify, lastResult);
      if (!ver.ok) {
        plan.status = 'failed';
        plan.error  = ver.error;
        this._save(plan);
        memory.remember({ type: 'goal_run', goal, outcome: 'failure',
          notes: `Plan verify failed: ${plan.verify}`, tags: ['verify_failed'] });
        return {
          ok:        false,
          goal,
          plan,
          result:    lastResult,
          steps_done: plan.completed + 1,
          session_id: plan.id,
          error:     ver.error,
          expected:  ver.expected,
          actual:    ver.actual,
        };
      }
    }

    this._save(plan);

    memory.remember({
      type:    'goal_run',
      goal,
      outcome: allDone ? 'success' : 'failure',
      notes:   `${plan.completed + 1}/${plan.steps.length} steps completed (${plan.replan_cycles} replan cycles)`,
    });

    return {
      ok:         allDone,
      goal,
      plan,
      result:     lastResult,
      steps_done: plan.completed + 1,
      session_id: plan.id,
      ...(plan.error ? { error: plan.error } : {}),
    };
  }
}

module.exports = { Planner };
