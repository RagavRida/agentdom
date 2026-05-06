/**
 * AgentDOM — Episodic Memory Store
 *
 * Lightweight cross-session memory for agent workflows.
 * Stored at ~/.agentdom/memory.jsonl — one JSON object per line.
 *
 * Each episode:
 *   { id, ts, type, provider?, intent?, goal?, outcome, notes?, tags? }
 *
 * Types:
 *   'goal_run'     — a full goal execution (success/fail)
 *   'intent_exec'  — a single dispatch_intent call
 *   'hint'         — a freeform observation the agent wants to remember
 *   'failure'      — a failure pattern + what was learned
 *
 * Memory is append-only. recall() searches recent episodes by relevance.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AGENTDOM_DIR  = path.join(os.homedir(), '.agentdom');
// Support AGENTDOM_AGENT_ID for multi-agent isolation.
// Each agent gets its own memory file: memory.<id>.jsonl
// Default 'default' keeps single-agent behaviour unchanged.
const AGENT_ID    = (process.env.AGENTDOM_AGENT_ID || 'default').replace(/[^a-z0-9_-]/gi, '_');
const MEMORY_FILE = path.join(AGENTDOM_DIR, `memory${AGENT_ID === 'default' ? '' : '.' + AGENT_ID}.jsonl`);
const MAX_EPISODES  = 2000;   // prune oldest when exceeded
const RECALL_LIMIT  = 20;     // default max results from recall()

// ── Write ────────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Record a new episode to memory.
 *
 * @param {object} episode
 * @param {string} episode.type      — 'goal_run'|'intent_exec'|'hint'|'failure'
 * @param {string} [episode.provider]
 * @param {string} [episode.intent]
 * @param {string} [episode.goal]
 * @param {string} episode.outcome   — 'success'|'failure'|'partial'
 * @param {string} [episode.notes]   — human/agent-readable observation
 * @param {string[]} [episode.tags]
 * @returns {string} episode id
 */
function remember(episode) {
  ensureDir();
  const id = crypto.randomBytes(6).toString('hex');
  const entry = {
    id,
    ts: new Date().toISOString(),
    ...episode,
  };
  try {
    fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (_) {}

  // Prune if oversized (keep newest MAX_EPISODES)
  pruneIfNeeded();
  return id;
}

function pruneIfNeeded() {
  if (!fs.existsSync(MEMORY_FILE)) return;
  try {
    const lines = fs.readFileSync(MEMORY_FILE, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_EPISODES) {
      const kept = lines.slice(lines.length - MAX_EPISODES);
      fs.writeFileSync(MEMORY_FILE, kept.join('\n') + '\n', { mode: 0o600 });
    }
  } catch (_) {}
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Load all episodes from disk. Most recent first.
 */
function loadAll() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse(); // newest first
  } catch { return []; }
}

/**
 * Search memory for relevant episodes.
 *
 * Filters by any combination of: provider, intent, goal substring,
 * type, outcome, tags. Scored by recency + specificity.
 *
 * @param {object} query
 * @param {string}   [query.provider]  — filter by provider host
 * @param {string}   [query.intent]    — filter by intent id
 * @param {string}   [query.goal]      — substring match on goal
 * @param {string}   [query.type]      — episode type filter
 * @param {string}   [query.outcome]   — 'success'|'failure'|'partial'
 * @param {string[]} [query.tags]      — any tag must match
 * @param {number}   [query.limit]     — default RECALL_LIMIT
 * @returns {object[]} matching episodes (newest first, up to limit)
 */
function recall(query = {}) {
  const { provider, intent, goal, type, outcome, tags, limit = RECALL_LIMIT } = query;
  const all = loadAll();
  const results = [];

  for (const ep of all) {
    if (provider && ep.provider !== provider) continue;
    if (intent   && ep.intent   !== intent)   continue;
    if (type     && ep.type     !== type)     continue;
    if (outcome  && ep.outcome  !== outcome)  continue;
    if (goal     && !(ep.goal || '').toLowerCase().includes(goal.toLowerCase())) continue;
    if (tags     && tags.length && !tags.some(t => (ep.tags || []).includes(t))) continue;
    results.push(ep);
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Retrieve the most recent episodes for a provider+intent pair.
 * Useful for "what happened last time I did contacts.create on hubspot?"
 */
function lastN(provider, intent, n = 5) {
  return recall({ provider, intent, limit: n });
}

/**
 * Get all recorded failure patterns for a provider (newest first).
 * Agents use this to pre-empt known failure modes.
 */
function failures(provider, limit = 10) {
  return recall({ provider, outcome: 'failure', limit });
}

/**
 * Get all hints recorded for a provider.
 * e.g. "hubspot.com HubSpot requires scrolling to the bottom before Submit is visible"
 */
function hints(provider, limit = 10) {
  return recall({ provider, type: 'hint', limit });
}

/**
 * Retrieve the full context (failures + hints + recent successes) for a
 * provider+intent pair. Formatted as a short block for inclusion in LLM prompts.
 *
 * @returns {string}  — markdown block, empty string if no memory
 */
function promptContext(provider, intent) {
  const recent   = lastN(provider, intent, 5);
  const allHints = hints(provider, 5);
  const allFails = failures(provider, 5);

  if (!recent.length && !allHints.length && !allFails.length) return '';

  const lines = ['## Memory context'];
  if (allHints.length) {
    lines.push('\n### Hints');
    allHints.forEach(h => lines.push(`- ${h.notes || '(no notes)'} (${h.ts.slice(0, 10)})`));
  }
  if (allFails.length) {
    lines.push('\n### Known failures');
    allFails.forEach(f => lines.push(`- [${f.intent || '—'}] ${f.notes || '—'} (${f.ts.slice(0, 10)})`));
  }
  if (recent.length) {
    lines.push('\n### Recent executions');
    recent.forEach(r => lines.push(`- ${r.outcome} | ${r.intent || r.goal || '—'} (${r.ts.slice(0, 10)}) ${r.notes ? '— ' + r.notes : ''}`));
  }
  return lines.join('\n');
}

// ── Stats ────────────────────────────────────────────────────────────────────

function stats() {
  const all = loadAll();
  const byOutcome = {};
  const byProvider = {};
  for (const ep of all) {
    byOutcome[ep.outcome]   = (byOutcome[ep.outcome]   || 0) + 1;
    byProvider[ep.provider] = (byProvider[ep.provider] || 0) + 1;
  }
  return { total: all.length, by_outcome: byOutcome, by_provider: byProvider, file: MEMORY_FILE };
}

module.exports = {
  remember,
  recall,
  lastN,
  failures,
  hints,
  promptContext,
  stats,
  MEMORY_FILE,
};
