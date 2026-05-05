/**
 * AgentDOM — Policy Engine
 *
 * Enforces per-effect permissions before any dispatch executes.
 * Config lives at ~/.agentdom/policy.json (user-editable).
 *
 * Side-effect classes (from least to most dangerous):
 *   read        — GET-only reads, scan, list
 *   write_local — modify files, local state
 *   send        — send a message/email/notification
 *   external    — call a 3rd-party API with side effects
 *   delete      — destroy data (irreversible)
 *   payment     — charge money
 *
 * Decision values:
 *   allow  — proceed silently
 *   prompt — write to pending.json, wait up to PROMPT_TIMEOUT_MS for
 *            `agentdom approve <id>` or `agentdom deny <id>`
 *   deny   — reject immediately with a clean error
 *
 * Default policy (safe for most users):
 *   read → allow, write_local → allow, send → prompt,
 *   external → prompt, delete → deny, payment → deny
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./resilience');

const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');
const POLICY_FILE  = path.join(AGENTDOM_DIR, 'policy.json');
const PENDING_FILE = path.join(AGENTDOM_DIR, 'pending.json');
const AUDIT_FILE   = path.join(AGENTDOM_DIR, 'audit.log');

const PROMPT_TIMEOUT_MS = 60_000; // 1 min to approve/deny

// ── Side-effect ordering (ascending danger) ─────────────────────────────────
const EFFECT_ORDER = ['read', 'write_local', 'send', 'external', 'delete', 'payment'];

const DEFAULT_POLICY = {
  default: 'prompt',
  per_class: {
    read:        'allow',
    write_local: 'allow',
    send:        'prompt',
    external:    'prompt',
    delete:      'deny',
    payment:     'deny',
  },
  per_provider: {},   // e.g. { "hubspot.com": { "send": "allow" } }
  per_intent:   {},   // e.g. { "contacts.create": "allow" }
};

// ── Policy loading ───────────────────────────────────────────────────────────

let _cached = null;
let _mtime  = 0;

function loadPolicy() {
  if (!fs.existsSync(POLICY_FILE)) {
    ensureDir();
    atomicWrite(POLICY_FILE, DEFAULT_POLICY);
    return DEFAULT_POLICY;
  }
  const stat = fs.statSync(POLICY_FILE);
  if (_cached && stat.mtimeMs === _mtime) return _cached;
  try {
    _cached = { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf-8')) };
    _mtime  = stat.mtimeMs;
    return _cached;
  } catch {
    return DEFAULT_POLICY;
  }
}

function ensureDir() {
  if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive: true, mode: 0o700 });
}

// ── Decision resolution (most specific wins) ─────────────────────────────────

/**
 * Resolve the policy decision for one effect class in this context.
 *
 * Priority: per_intent > per_provider > per_class > default
 *
 * @param {string} effectClass  — one of EFFECT_ORDER
 * @param {object} ctx          — { intent?, provider? }
 * @returns {'allow'|'prompt'|'deny'}
 */
function resolve(effectClass, ctx = {}) {
  const p = loadPolicy();
  if (ctx.intent && p.per_intent?.[ctx.intent]) return p.per_intent[ctx.intent];
  if (ctx.provider && p.per_provider?.[ctx.provider]?.[effectClass]) {
    return p.per_provider[ctx.provider][effectClass];
  }
  return p.per_class?.[effectClass] ?? p.default ?? 'prompt';
}

// ── Audit log ────────────────────────────────────────────────────────────────

function appendAudit(entry) {
  ensureDir();
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch (_) {}
}

// ── Pending approvals ────────────────────────────────────────────────────────

function readPending() {
  if (!fs.existsSync(PENDING_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')); } catch { return {}; }
}

function writePending(map) {
  ensureDir();
  atomicWrite(PENDING_FILE, map, { mode: 0o600 });
}

// ── Core: check before dispatch ──────────────────────────────────────────────

/**
 * Check whether the given side-effects are allowed.
 *
 * @param {string[]} effects   — e.g. ['read', 'external']
 * @param {object}   ctx       — { intent?, provider?, args? }
 * @returns {{ decision: 'allow'|'prompt'|'deny', blocked_by?, id? }}
 *
 * Returns immediately for allow/deny. For prompt, creates a pending
 * entry and polls up to PROMPT_TIMEOUT_MS for approval.
 */
async function check(effects = [], ctx = {}) {
  if (process.env.AGENTDOM_DRY) {
    // Dry-run: allow reads, block writes silently
    const hasWrite = effects.some(e => e !== 'read');
    return hasWrite
      ? { decision: 'allow', dry_run: true, would_have_prompted: true }
      : { decision: 'allow', dry_run: true };
  }

  // Find the most dangerous effect that requires a non-allow decision
  let worstDecision = 'allow';
  let worstEffect   = null;
  for (const eff of effects) {
    const d = resolve(eff, ctx);
    if (d === 'deny') {
      appendAudit({ event: 'denied', effects, intent: ctx.intent, provider: ctx.provider });
      return { decision: 'deny', blocked_by: eff, error: `Policy denies effect class "${eff}"`, hint: `Edit ~/.agentdom/policy.json to change this.` };
    }
    if (d === 'prompt' && worstDecision !== 'deny') {
      worstDecision = 'prompt';
      worstEffect   = eff;
    }
  }

  if (worstDecision === 'allow') {
    appendAudit({ event: 'allowed', effects, intent: ctx.intent, provider: ctx.provider });
    return { decision: 'allow' };
  }

  // Prompt — create pending entry, wait for human approval
  const id      = crypto.randomBytes(6).toString('hex');
  const pending = readPending();
  pending[id]   = {
    id,
    created: Date.now(),
    effects,
    intent:   ctx.intent   || null,
    provider: ctx.provider || null,
    status:   'pending',
  };
  writePending(pending);

  console.error(`\n[AgentDOM Policy] Action requires approval.`);
  console.error(`  Effects:  ${effects.join(', ')}`);
  console.error(`  Intent:   ${ctx.intent || '—'}`);
  console.error(`  Provider: ${ctx.provider || '—'}`);
  console.error(`  Run:  agentdom approve ${id}   (or: agentdom deny ${id})`);
  console.error(`  Auto-expires in ${PROMPT_TIMEOUT_MS / 1000}s.\n`);

  // Poll for decision
  const start = Date.now();
  while (Date.now() - start < PROMPT_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 1000));
    const map = readPending();
    const entry = map[id];
    if (!entry) break; // deleted = approved
    if (entry.status === 'approved') {
      delete map[id];
      writePending(map);
      appendAudit({ event: 'approved', id, effects, intent: ctx.intent, provider: ctx.provider });
      return { decision: 'allow', approved_by: 'human', id };
    }
    if (entry.status === 'denied') {
      delete map[id];
      writePending(map);
      appendAudit({ event: 'denied_by_human', id, effects, intent: ctx.intent, provider: ctx.provider });
      return { decision: 'deny', denied_by: 'human', id, error: 'User denied this action.', hint: `Run agentdom approve ${id} to allow.` };
    }
  }

  // Timeout — treat as deny
  const map = readPending();
  if (map[id]) { map[id].status = 'timeout'; writePending(map); }
  appendAudit({ event: 'timeout', id, effects, intent: ctx.intent, provider: ctx.provider });
  return { decision: 'deny', error: `Approval timed out after ${PROMPT_TIMEOUT_MS / 1000}s.`, id, hint: 'Run `agentdom approve <id>` before the next dispatch.' };
}

// ── CLI helpers (used by commands/policy.js) ─────────────────────────────────

function approve(id) {
  const map = readPending();
  if (!map[id]) return { ok: false, error: `No pending action with id "${id}".` };
  map[id].status = 'approved';
  writePending(map);
  return { ok: true, id, action: 'approved' };
}

function deny(id) {
  const map = readPending();
  if (!map[id]) return { ok: false, error: `No pending action with id "${id}".` };
  map[id].status = 'denied';
  writePending(map);
  return { ok: true, id, action: 'denied' };
}

function listPending() {
  return Object.values(readPending());
}

function getPolicy() {
  return loadPolicy();
}

function setPolicy(patch) {
  const current = loadPolicy();
  const updated  = { ...current, ...patch };
  atomicWrite(POLICY_FILE, updated);
  _cached = null; // invalidate cache
  return updated;
}

module.exports = {
  check,
  approve,
  deny,
  listPending,
  getPolicy,
  setPolicy,
  EFFECT_ORDER,
  DEFAULT_POLICY,
  POLICY_FILE,
  PENDING_FILE,
  AUDIT_FILE,
};
