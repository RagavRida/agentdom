/**
 * AgentDOM — Runtime Helpers (Phase: gap closure)
 *
 * Small, pure functions extracted so the planner's behaviour is testable
 * without instantiating a full runtime. Three concerns live here:
 *
 *   1. {{ intent.path }} arg interpolation (Gap 1A)
 *   2. on_fail branching helper            (Gap 1B)
 *   3. plan-level verify evaluation       (Gap 1C)
 *
 * The planner already supports `$stepId.path` interpolation keyed by step
 * id. The Phase-gap spec adds a SECOND interpolation form keyed by *intent
 * name* — `{{ contacts.create.id }}` — and stores `result.data` (not the
 * envelope) under that key. Both forms coexist; the existing `$stepId.path`
 * syntax keeps working untouched.
 */

'use strict';

// ── 1A. Result threading via {{ intent.path }} ─────────────────────────────

/**
 * Replace `{{ intent.path }}` references in `args` with values from
 * `workingMemory`. `workingMemory` is a Map (or plain object) keyed by
 * intent name, where each value is the `result.data` stored after a
 * successful dispatch.
 *
 * Rules:
 *   - "{{ intent.path }}" as the ENTIRE string → returns the raw value
 *     (preserves type: numbers stay numbers, objects stay objects).
 *   - "{{ intent.path }}" embedded inside a longer string → stringified
 *     and substituted in place.
 *   - Missing references stay as the original placeholder so the caller
 *     can detect unresolved templates rather than silently dropping them.
 *
 * @param {*} value            — primitive, array, or object to walk
 * @param {Map|object} memory  — intent → data map
 * @returns {{value:*, unresolved:string[]}}
 */
function interpolateArgs(value, memory) {
  const unresolved = [];
  const out = _walk(value, memory, unresolved);
  return { value: out, unresolved };
}

function _walk(value, memory, unresolved) {
  if (value == null) return value;
  if (typeof value === 'string') return _replaceString(value, memory, unresolved);
  if (Array.isArray(value))      return value.map(v => _walk(v, memory, unresolved));
  if (typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = _walk(v, memory, unresolved);
    return o;
  }
  return value;
}

const FULL_TEMPLATE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const ANY_TEMPLATE  = /\{\{\s*([^{}]+?)\s*\}\}/g;

function _replaceString(str, memory, unresolved) {
  // Whole-string template → preserve value type.
  const full = str.match(FULL_TEMPLATE);
  if (full) {
    const got = _resolvePath(full[1], memory);
    if (got === undefined) { unresolved.push(full[1].trim()); return str; }
    return got;
  }
  // Inline template(s) → stringify in place.
  if (!ANY_TEMPLATE.test(str)) return str;
  ANY_TEMPLATE.lastIndex = 0;
  return str.replace(ANY_TEMPLATE, (_, expr) => {
    const got = _resolvePath(expr, memory);
    if (got === undefined) { unresolved.push(expr.trim()); return `{{ ${expr.trim()} }}`; }
    return typeof got === 'object' ? JSON.stringify(got) : String(got);
  });
}

/**
 * Resolve "intent.field.sub" against memory. The first path segment is
 * the intent key; remaining segments walk into the stored data object.
 * Intent names themselves may contain dots ("contacts.create"), so we try
 * progressively longer prefixes until one hits a known intent.
 */
function _resolvePath(expr, memory) {
  const segs = expr.trim().split('.').filter(Boolean);
  if (segs.length === 0) return undefined;
  const get = (key) => (memory instanceof Map ? memory.get(key) : memory[key]);

  // Try increasing prefix lengths so "contacts.create" wins before "contacts".
  for (let n = segs.length; n >= 1; n--) {
    const intent = segs.slice(0, n).join('.');
    const base = get(intent);
    if (base === undefined) continue;
    const rest = segs.slice(n);
    let cur = base;
    for (const k of rest) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  return undefined;
}

// ── 1B. on_fail branching ──────────────────────────────────────────────────

/**
 * Decide what to execute when a step's primary result is a failure.
 *
 * @param {object} step      — the original step (may have on_fail)
 * @param {object} result    — the result envelope from the primary attempt
 * @returns {{shouldBranch:boolean, branchStep?:object}}
 */
function planBranch(step, result) {
  if (!result || result.ok !== false) return { shouldBranch: false };
  if (!step || !step.on_fail || typeof step.on_fail !== 'object') return { shouldBranch: false };
  if (!step.on_fail.intent) return { shouldBranch: false };
  return {
    shouldBranch: true,
    branchStep: {
      // Inherit anything the primary step had; let on_fail override.
      ...step,
      ...step.on_fail,
      id: `${step.id || 'step'}__on_fail`,
      on_fail: null,           // a single layer of branching only
      _branched_from: step.id,
    },
  };
}

// ── 1C. Goal-completion verification ───────────────────────────────────────

/**
 * Evaluate a plan-level `verify` expression against the final result.
 * Returns `{ ok: true }` when the expression is missing (trust the LLM) or
 * evaluates truthy, otherwise `{ ok: false, expected, actual }`.
 *
 * The expression sees three locals: `result`, `data` (= result.data), and
 * `ok` (= result.ok). Errors during eval are returned as failures rather
 * than thrown — verification should never crash a successful run.
 *
 * @param {string|null|undefined} verify  — JS expression string, or falsy
 * @param {object} result                — last step's envelope
 */
function evaluateVerify(verify, result) {
  if (verify == null || verify === '') return { ok: true, skipped: true };
  let passed = false;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('result', 'data', 'ok', `return !!(${verify});`);
    passed = fn(result, result?.data, result?.ok);
  } catch (e) {
    return {
      ok: false,
      error:    'Goal verification failed',
      expected: verify,
      actual:   result,
      detail:   `verify expression error: ${e.message}`,
    };
  }
  if (passed) return { ok: true };
  return {
    ok: false,
    error:    'Goal verification failed',
    expected: verify,
    actual:   result,
  };
}

module.exports = {
  interpolateArgs,
  planBranch,
  evaluateVerify,
};
