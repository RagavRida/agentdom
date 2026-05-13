/**
 * AgentDOM — Ambiguity Resolver (Gap 2)
 *
 * When a desktop bridge surfaces multiple elements matching the same
 * label, blindly clicking the first one is dangerous for write/external
 * effects. This module:
 *
 *   • Scores each candidate against the requested label.
 *   • Auto-selects when one candidate beats every other by a strong
 *     margin (score ≥ 0.95).
 *   • Otherwise — for side-effectful intents — returns a structured
 *     `{ ok:false, ambiguous:true, matches:[…] }` envelope so the caller
 *     (planner / agent) can disambiguate before any destructive action.
 *
 * Read-only intents (side_effects empty / ['read']) keep first-match
 * behaviour because the cost of a wrong pick is bounded.
 */

'use strict';

// Side-effect tags that make ambiguity dangerous.
const RISKY = new Set(['write_local', 'external', 'send', 'delete']);

/**
 * Score how well `candidate` matches the requested `query`. Returns a
 * value in [0, 1].
 *
 *   1.00 — exact match
 *   0.95 — case-insensitive exact match
 *   0.70 — case-insensitive substring (either direction)
 *   0.50 — Levenshtein distance ≤ 2
 *   0.00 — no relation
 *
 * @param {string} query
 * @param {string} candidate
 */
function scoreLabel(query, candidate) {
  if (typeof query !== 'string' || typeof candidate !== 'string') return 0;
  if (query === candidate) return 1.0;
  const q = query.trim();
  const c = candidate.trim();
  if (!q || !c) return 0;
  if (q === c) return 1.0;
  if (q.toLowerCase() === c.toLowerCase()) return 0.95;
  const ql = q.toLowerCase();
  const cl = c.toLowerCase();
  if (cl.includes(ql) || ql.includes(cl)) return 0.7;
  const d = _levenshtein(ql, cl);
  if (d <= 2 && Math.max(ql.length, cl.length) > 0) return 0.5;
  return 0;
}

/**
 * Decide whether a set of matches is ambiguous for a given intent.
 *
 * @param {Array<object>} matches  — each at least { label } (role/index/bounds optional)
 * @param {string} query           — the label the caller asked for
 * @param {object} [intent]        — { side_effects?: string[] }
 * @returns {object} resolution
 *   { ambiguous:false, pick: <match with score> }  — auto-selected
 *   { ambiguous:true,  matches: [...with score], reason }  — needs caller decision
 */
function resolveMatches(matches, query, intent = {}) {
  const list = Array.isArray(matches) ? matches : [];
  if (list.length === 0) {
    return { ambiguous: false, pick: null, matches: [] };
  }

  const scored = list.map((m, i) => ({
    ...m,
    index: m.index ?? i + 1,
    score: scoreLabel(query, m.label ?? ''),
  }));

  // Sort by score desc (stable on equal score by original order)
  scored.sort((a, b) => (b.score - a.score));

  const best = scored[0];

  // Auto-select on strong match — any number of duplicates is fine when
  // the top one stands out.
  if (best.score >= 0.95) {
    return { ambiguous: false, pick: best, matches: scored };
  }

  // Single match → never "ambiguous", just pick it (callers that demand
  // confirmation can inspect the score themselves).
  if (scored.length === 1) {
    return { ambiguous: false, pick: best, matches: scored };
  }

  // Multiple lower-confidence matches → ambiguous only if the intent has
  // a risky side effect. Read-only intents keep first-match behaviour.
  const sideEffects = Array.isArray(intent.side_effects) ? intent.side_effects : [];
  const risky = sideEffects.some(s => RISKY.has(s));
  if (!risky) {
    return { ambiguous: false, pick: best, matches: scored, reason: 'read-only intent — first match wins' };
  }

  return {
    ambiguous: true,
    matches:   scored,
    reason:    `${scored.length} candidates matched "${query}" — none with score ≥ 0.95`,
  };
}

/**
 * Build the structured "needs disambiguation" envelope returned by the
 * MCP/runtime layer when `resolveMatches` reports ambiguous=true.
 */
function buildAmbiguousEnvelope(query, resolution) {
  return {
    ok:        false,
    ambiguous: true,
    query,
    reason:    resolution.reason,
    matches:   resolution.matches.map(m => ({
      label:  m.label,
      role:   m.role  || null,
      index:  m.index,
      bounds: m.bounds || null,
      score:  m.score,
    })),
    hint: 'Re-issue with the exact label including its disambiguator (e.g. "Save (2)") or pick a candidate from `matches[]`.',
  };
}

// ── Internal: Levenshtein distance (small alphabets only) ─────────────────

function _levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

module.exports = {
  scoreLabel,
  resolveMatches,
  buildAmbiguousEnvelope,
  RISKY,
};
