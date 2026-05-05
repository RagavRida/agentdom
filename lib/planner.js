/**
 * AgentDOM — Agent Planner Runtime
 *
 * Closes the core runtime gaps:
 *   1. Explicit plan object (not greedy step-by-step)
 *   2. Pre-execution validation (all intents resolvable? all auth present?)
 *   3. Step-by-step verification (did it actually work?)
 *   4. Backtracking / replanning on failure
 *   5. Disambiguation surface (multiple matches → structured candidates)
 *   6. Working memory (structured state, survives crash via checkpoint)
 *
 * Usage:
 *   const { Planner } = require('./lib/planner');
 *   const planner = new Planner({ wallet, discovery, dispatcher });
 *   const result  = await planner.run(goal, { sessionId, maxSteps: 10 });
 *
 * Compatible with the existing dispatch_intent + wallet infrastructure.
 * The LLM integration point is pluggable — pass a `llm` function that
 * takes a prompt string and returns a string.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite }  = require('./resilience');
const { check: policyCheck } = require('./policy');
const memory = require('./memory');

const SESSIONS_DIR = path.join(os.homedir(), '.agentdom', 'sessions');

// ── Plan schema ──────────────────────────────────────────────────────────────
//
// {
//   id:       string,
//   goal:     string,
//   created:  ISO timestamp,
//   status:   'pending'|'running'|'done'|'failed'|'needs_approval',
//   steps: [
//     {
//       id:            string,
//       intent?:       string,        // dispatch_intent id
//       tool?:         string,        // raw MCP tool name (fallback)
//       args:          object,
//       description:   string,        // human-readable what this step does
//       side_effects:  string[],      // e.g. ['external', 'send']
//       verify?:       string,        // JS expression or intent to verify success
//       status:        'pending'|'running'|'done'|'failed'|'skipped',
//       result?:       object,
//       error?:        string,
//       attempts:      number,
//     }
//   ],
//   working_memory: object,   // { [key]: value } — flows between steps
//   completed:      number,   // index of last completed step
//   error?:         string,
// }

// ── Planner class ────────────────────────────────────────────────────────────

class Planner {
  /**
   * @param {object} opts
   * @param {function} opts.llm          — async (prompt: string) => string
   * @param {function} opts.dispatch     — async (intent, args, provider) => envelope
   * @param {function} [opts.toolCall]   — async (toolName, args) => any  (MCP fallback)
   * @param {object}  [opts.wallet]      — authWallet module (for pre-validation)
   * @param {object}  [opts.discovery]   — discovery module (for intent resolution)
   * @param {number}  [opts.maxRetries]  — retries per step (default 2)
   * @param {boolean} [opts.dryRun]      — if true, skip execution (plan only)
   */
  constructor(opts = {}) {
    this.llm       = opts.llm       || null;
    this.dispatch  = opts.dispatch  || null;
    this.toolCall  = opts.toolCall  || null;
    this.wallet    = opts.wallet    || null;
    this.discovery = opts.discovery || null;
    this.maxRetries = opts.maxRetries ?? 2;
    this.dryRun    = opts.dryRun    || !!process.env.AGENTDOM_DRY;
  }

  // ── Session management ─────────────────────────────────────────────────────

  _sessionPath(id) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
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

  // ── Planning (LLM call) ────────────────────────────────────────────────────

  /**
   * Ask the LLM to produce a structured plan for `goal`.
   * Returns a parsed plan object or throws.
   */
  async _generatePlan(goal, opts = {}) {
    if (!this.llm) throw new Error('Planner requires an `llm` function to generate plans.');

    const memCtx = opts.provider
      ? memory.promptContext(opts.provider, null)
      : '';

    const prompt = `You are an AgentDOM plan generator. Given a goal, produce a JSON plan.

GOAL: ${goal}
${memCtx ? '\n' + memCtx + '\n' : ''}
Available transports: dispatch_intent(intent, args, provider?), tool(name, args).

Respond with ONLY valid JSON (no markdown fences):
{
  "steps": [
    {
      "id": "s1",
      "description": "what this does",
      "intent": "contacts.create",          // or omit if using tool
      "tool": null,                          // tool name fallback
      "args": { "email": "x@y.com" },
      "side_effects": ["external"],          // read|write_local|send|external|delete|payment
      "verify": "result.data.id != null"    // optional JS expression on result
    }
  ]
}

Rules:
- Each step does exactly ONE action.
- Use intent when possible (cheaper + semantic), tool as fallback.
- side_effects must be accurate — they gate policy enforcement.
- verify is a JS expression evaluated with { result } in scope. Omit if not checkable.
- Args can reference previous step results with $s1.data.id syntax.`;

    const raw  = await this.llm(prompt);
    const json = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(json);

    if (!Array.isArray(parsed.steps)) throw new Error('Plan missing steps array.');

    const id = opts.sessionId || crypto.randomBytes(8).toString('hex');
    return {
      id,
      goal,
      created: new Date().toISOString(),
      status: 'pending',
      steps: parsed.steps.map((s, i) => ({
        id: s.id || `s${i + 1}`,
        intent:       s.intent       || null,
        tool:         s.tool         || null,
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
      completed: -1,
    };
  }

  // ── Plan validation ────────────────────────────────────────────────────────

  /**
   * Pre-validate the plan before execution:
   *   - All intents are resolvable (provider authed)
   *   - All required args present
   *   - Policy would allow the declared side-effects
   *
   * Returns { valid: bool, issues: string[] }
   */
  async _validatePlan(plan) {
    const issues = [];

    for (const step of plan.steps) {
      if (!step.intent && !step.tool) {
        issues.push(`Step ${step.id}: must have intent or tool.`);
        continue;
      }

      // Check policy for all declared effects
      const policyResult = await policyCheck(
        step.side_effects || [],
        { intent: step.intent }
      );
      if (policyResult.decision === 'deny') {
        issues.push(`Step ${step.id}: policy denies effect "${policyResult.blocked_by}".`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  // ── Arg resolution (template substitution) ─────────────────────────────────

  /**
   * Resolve $stepId.path references in args from working_memory.
   * e.g. { contact_id: "$s1.data.id" } → { contact_id: "abc123" }
   */
  _resolveArgs(args, workingMemory) {
    const resolve = (v) => {
      if (typeof v !== 'string') return v;
      return v.replace(/\$(\w+)\.([\w.]+)/g, (_, stepId, keyPath) => {
        const base = workingMemory[stepId];
        if (!base) return v;
        const val = keyPath.split('.').reduce((o, k) => o?.[k], base);
        return val !== undefined ? val : v;
      });
    };
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = typeof v === 'object' && v !== null
        ? this._resolveArgs(v, workingMemory)
        : resolve(v);
    }
    return out;
  }

  // ── Verification ───────────────────────────────────────────────────────────

  /**
   * Evaluate a step's verify expression against its result.
   * Expression runs in a sandbox with { result, ok } in scope.
   * Returns { passed: bool, reason?: string }
   */
  _verify(step) {
    if (!step.verify || !step.result) return { passed: true };
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('result', 'ok', `return (${step.verify});`);
      const passed = !!fn(step.result, step.result?.ok);
      return { passed, expression: step.verify };
    } catch (e) {
      return { passed: false, reason: `verify expression error: ${e.message}` };
    }
  }

  // ── Disambiguation ─────────────────────────────────────────────────────────

  /**
   * When a step's result signals ambiguity (multiple matches), surface
   * structured candidates to the caller rather than silently picking one.
   *
   * @returns {{ ambiguous: true, candidates, default, reason }}
   */
  _handleAmbiguity(result) {
    if (!result?.ambiguous) return null;
    return {
      ambiguous: true,
      candidates: result.candidates || [],
      default:    result.candidates?.[0] || null,
      reason:     result.reason || 'Multiple matches found.',
      hint:       'Specify a more precise identifier in the goal, or select a candidate by id.',
    };
  }

  // ── Step execution ─────────────────────────────────────────────────────────

  async _executeStep(step, plan) {
    const resolvedArgs = this._resolveArgs(step.args, plan.working_memory);

    // Policy check
    const policy = await policyCheck(step.side_effects || [], { intent: step.intent });
    if (policy.decision === 'deny') {
      return { ok: false, error: policy.error, hint: policy.hint, policy_blocked: true };
    }

    if (this.dryRun) {
      return { ok: true, dry_run: true, would_have_called: { intent: step.intent, tool: step.tool, args: resolvedArgs } };
    }

    // Execute
    let result;
    if (step.intent && this.dispatch) {
      result = await this.dispatch(step.intent, resolvedArgs);
    } else if (step.tool && this.toolCall) {
      const raw = await this.toolCall(step.tool, resolvedArgs);
      result = { ok: true, data: raw };
    } else {
      return { ok: false, error: `Step ${step.id}: no executor for intent="${step.intent}" tool="${step.tool}".` };
    }

    return result;
  }

  // ── Replanning ─────────────────────────────────────────────────────────────

  async _replan(plan, failedStep, failureContext) {
    if (!this.llm) return null;

    const prompt = `A step in an AgentDOM plan failed. Suggest a revised approach.

ORIGINAL GOAL: ${plan.goal}
FAILED STEP: ${JSON.stringify(failedStep, null, 2)}
FAILURE: ${failureContext}
COMPLETED SO FAR: ${JSON.stringify(plan.steps.slice(0, plan.completed + 1).map(s => ({ id: s.id, intent: s.intent, status: s.status })))}

Respond with JSON { "revised_steps": [...] } using the same step schema, covering only the remaining work.
Or respond with { "give_up": true, "reason": "..." } if the goal is unachievable.`;

    try {
      const raw = await this.llm(prompt);
      const json = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(json);
      if (parsed.give_up) return { give_up: true, reason: parsed.reason };
      if (Array.isArray(parsed.revised_steps)) return { revised_steps: parsed.revised_steps };
    } catch (_) {}
    return null;
  }

  // ── Main run loop ──────────────────────────────────────────────────────────

  /**
   * Execute a goal end-to-end.
   *
   * @param {string} goal
   * @param {object} [opts]
   * @param {string}  [opts.sessionId]   — resume existing session
   * @param {number}  [opts.maxSteps]    — cap (default 20)
   * @param {string}  [opts.provider]    — force a specific provider
   * @param {boolean} [opts.validateOnly]— plan + validate but don't execute
   * @returns {object} { ok, goal, plan, result?, error?, steps_done }
   */
  async run(goal, opts = {}) {
    const maxSteps = opts.maxSteps ?? 20;
    let plan;

    // Resume or create session
    if (opts.sessionId) {
      plan = this._load(opts.sessionId);
      if (!plan) return { ok: false, error: `Session "${opts.sessionId}" not found.` };
      console.error(`[Planner] Resuming session ${opts.sessionId} (${plan.completed + 1}/${plan.steps.length} done)`);
    } else {
      plan = await this._generatePlan(goal, opts);
      console.error(`[Planner] Generated plan with ${plan.steps.length} steps (session: ${plan.id})`);
    }

    // Pre-validate
    const validation = await this._validatePlan(plan);
    if (!validation.valid) {
      memory.remember({ type: 'goal_run', goal, outcome: 'failure', notes: `Plan validation failed: ${validation.issues.join('; ')}` });
      return { ok: false, error: 'Plan validation failed.', issues: validation.issues, plan };
    }

    if (opts.validateOnly) {
      return { ok: true, plan, validated: true, message: 'Plan is valid. Pass executeOnly to run.' };
    }

    plan.status = 'running';
    this._save(plan);

    // Execute steps
    let lastResult = null;
    for (let i = plan.completed + 1; i < Math.min(plan.steps.length, maxSteps); i++) {
      const step = plan.steps[i];
      step.status   = 'running';
      step.attempts = (step.attempts || 0) + 1;
      console.error(`[Planner] Step ${i + 1}/${plan.steps.length}: ${step.description || step.intent || step.tool}`);

      let result = null;
      let lastError = null;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          result = await this._executeStep(step, plan);
          if (result?.ok !== false) break;
          lastError = result.error;
        } catch (e) {
          lastError = e.message;
          result = { ok: false, error: e.message };
        }
        if (attempt < this.maxRetries) {
          const delay = 500 * Math.pow(2, attempt);
          console.error(`[Planner] Step ${step.id} attempt ${attempt + 1} failed: ${lastError} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      step.result = result;
      lastResult  = result;

      // Disambiguation
      const ambig = this._handleAmbiguity(result);
      if (ambig) {
        step.status = 'failed';
        plan.status = 'needs_clarification';
        plan.error  = `Ambiguous result at step ${step.id}.`;
        this._save(plan);
        memory.remember({ type: 'goal_run', goal, outcome: 'partial', notes: `Ambiguous: ${ambig.reason}`, tags: ['ambiguity'] });
        return { ok: false, plan, ambiguity: ambig, steps_done: i, session_id: plan.id };
      }

      // Verify
      const vr = this._verify(step);
      if (!vr.passed) {
        step.error  = vr.reason || `Verification failed: ${step.verify}`;
        step.status = 'failed';
        console.error(`[Planner] Verification failed: ${step.error}`);

        // Replan
        const replanResult = await this._replan(plan, step, step.error);
        if (replanResult?.give_up) {
          plan.status = 'failed';
          plan.error  = replanResult.reason;
          this._save(plan);
          memory.remember({ type: 'goal_run', goal, outcome: 'failure', notes: `Gave up at step ${step.id}: ${replanResult.reason}` });
          return { ok: false, error: replanResult.reason, plan, steps_done: i, session_id: plan.id };
        }
        if (replanResult?.revised_steps) {
          console.error(`[Planner] Replanning with ${replanResult.revised_steps.length} revised steps`);
          plan.steps = [...plan.steps.slice(0, i + 1), ...replanResult.revised_steps.map((s, j) => ({
            id: s.id || `r${j + 1}`, intent: s.intent || null, tool: s.tool || null,
            args: s.args || {}, description: s.description || '', side_effects: s.side_effects || ['read'],
            verify: s.verify || null, status: 'pending', result: null, error: null, attempts: 0,
          }))];
          this._save(plan);
        }

        memory.remember({ type: 'failure', goal, intent: step.intent, outcome: 'failure', notes: step.error, tags: ['verify_failed'] });
        this._save(plan);
        continue; // try next (replanned) step
      }

      // Success
      step.status = 'done';
      plan.completed = i;
      plan.working_memory[step.id] = result;
      this._save(plan);
      console.error(`[Planner] ✓ Step ${step.id} done`);
    }

    // Goal complete?
    const allDone = plan.steps.every(s => s.status === 'done' || s.status === 'skipped');
    plan.status = allDone ? 'done' : 'failed';
    plan.error  = allDone ? undefined : 'Not all steps completed.';
    this._save(plan);

    memory.remember({
      type:    'goal_run',
      goal,
      outcome: allDone ? 'success' : 'failure',
      notes:   `${plan.completed + 1}/${plan.steps.length} steps completed`,
    });

    return {
      ok:        allDone,
      goal,
      plan,
      result:    lastResult,
      steps_done: plan.completed + 1,
      session_id: plan.id,
      ...(plan.error ? { error: plan.error } : {}),
    };
  }
}

module.exports = { Planner };
