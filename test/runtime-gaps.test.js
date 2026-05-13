/**
 * AgentDOM — Runtime Gap-Closure Tests
 *
 * Coverage:
 *   • Gap 1A — Result threading via {{ intent.path }} interpolation
 *   • Gap 1B — Plan branching via step.on_fail
 *   • Gap 1C — Plan-level goal verification
 *   • Gap 2  — Ambiguity envelope + confidence scoring
 *   • Gap 3  — Episodic memory (rememberEpisode / recallEpisodes / recallHints)
 *
 * Memory tests isolate state by setting AGENTDOM_AGENT_ID before importing
 * lib/memory so episode writes go to a per-test file that we delete on exit.
 */

'use strict';

// Must run BEFORE requiring memory: MEMORY_FILE is resolved at module load.
process.env.AGENTDOM_AGENT_ID = `runtime_gaps_${process.pid}`;

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const { interpolateArgs, planBranch, evaluateVerify } = require('../lib/runtime-helpers');
const { scoreLabel, resolveMatches, buildAmbiguousEnvelope } = require('../lib/ambiguity');
const memory = require('../lib/memory');

// ══════════════════════════════════════════════════════════════════════════
//  Gap 1A — Result threading / {{ intent.path }} interpolation
// ══════════════════════════════════════════════════════════════════════════

describe('Gap 1A — result threading', () => {
  it('replaces a whole-string template with the raw value (preserves type)', () => {
    const memMap = new Map([['contacts.create', { id: 42, email: 'a@b.com' }]]);
    const { value, unresolved } = interpolateArgs({ contactId: '{{ contacts.create.id }}' }, memMap);
    assert.equal(value.contactId, 42);
    assert.equal(typeof value.contactId, 'number');
    assert.deepEqual(unresolved, []);
  });

  it('handles plain-object memory (not just Map)', () => {
    const mem = { 'contacts.create': { id: 42 } };
    const { value } = interpolateArgs({ contactId: '{{ contacts.create.id }}' }, mem);
    assert.equal(value.contactId, 42);
  });

  it('inline templates inside a longer string are stringified', () => {
    const mem = new Map([['user.me', { name: 'Alice' }]]);
    const { value } = interpolateArgs({ greeting: 'Hello, {{ user.me.name }}!' }, mem);
    assert.equal(value.greeting, 'Hello, Alice!');
  });

  it('walks into nested objects and arrays', () => {
    const mem = new Map([['contacts.create', { id: 'c1' }]]);
    const { value } = interpolateArgs(
      { wrapper: { ids: ['{{ contacts.create.id }}', 'static'] } },
      mem,
    );
    assert.deepEqual(value, { wrapper: { ids: ['c1', 'static'] } });
  });

  it('reports unresolved references and leaves the template in place', () => {
    const { value, unresolved } = interpolateArgs(
      { x: '{{ missing.intent.field }}' },
      new Map(),
    );
    assert.equal(value.x, '{{ missing.intent.field }}');
    assert.deepEqual(unresolved, ['missing.intent.field']);
  });

  it('non-string primitives pass through unchanged', () => {
    const { value } = interpolateArgs({ n: 7, b: true, nul: null }, new Map());
    assert.deepEqual(value, { n: 7, b: true, nul: null });
  });

  it('resolves dotted intent names before shorter prefixes', () => {
    const mem = new Map([
      ['contacts',        { id: 'short' }],
      ['contacts.create', { id: 'long'  }],
    ]);
    const { value } = interpolateArgs({ x: '{{ contacts.create.id }}' }, mem);
    assert.equal(value.x, 'long');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Gap 1B — Plan branching via step.on_fail
// ══════════════════════════════════════════════════════════════════════════

describe('Gap 1B — on_fail branching', () => {
  it('shouldBranch=false when the result is ok', () => {
    const step = { intent: 'a', on_fail: { intent: 'b' } };
    const r = planBranch(step, { ok: true, data: 1 });
    assert.equal(r.shouldBranch, false);
  });

  it('shouldBranch=false when step has no on_fail', () => {
    const step = { intent: 'a' };
    const r = planBranch(step, { ok: false, error: 'x' });
    assert.equal(r.shouldBranch, false);
  });

  it('builds a branchStep when primary failed and on_fail.intent is present', () => {
    const step = { id: 's1', intent: 'a', args: { x: 1 }, on_fail: { intent: 'b', args: { y: 2 } } };
    const r = planBranch(step, { ok: false, error: 'kaboom' });
    assert.equal(r.shouldBranch, true);
    assert.equal(r.branchStep.intent, 'b');
    assert.deepEqual(r.branchStep.args, { y: 2 });
    assert.equal(r.branchStep._branched_from, 's1');
    assert.equal(r.branchStep.on_fail, null, 'branch step must clear on_fail to prevent infinite branching');
  });

  it('on_fail without intent does not branch', () => {
    const step = { intent: 'a', on_fail: { args: { y: 2 } } };
    const r = planBranch(step, { ok: false, error: 'x' });
    assert.equal(r.shouldBranch, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Gap 1C — Goal verification
// ══════════════════════════════════════════════════════════════════════════

describe('Gap 1C — plan-level verify', () => {
  it('returns ok=true and skipped=true when verify is missing', () => {
    const r = evaluateVerify(null, { ok: true, data: { id: 9 } });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  it('passes when the expression is truthy', () => {
    const r = evaluateVerify('data.id != null', { ok: true, data: { id: 9 } });
    assert.equal(r.ok, true);
  });

  it('fails with expected/actual when the expression is falsy', () => {
    const r = evaluateVerify('data.id != null', { ok: true, data: { id: null } });
    assert.equal(r.ok, false);
    assert.equal(r.expected, 'data.id != null');
    assert.deepEqual(r.actual, { ok: true, data: { id: null } });
    assert.match(r.error, /Goal verification failed/);
  });

  it('treats expression syntax errors as failures (not throws)', () => {
    const r = evaluateVerify('this is not valid js', { ok: true });
    assert.equal(r.ok, false);
    assert.match(r.detail, /verify expression error/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Gap 2 — Ambiguity & confidence scoring
// ══════════════════════════════════════════════════════════════════════════

describe('Gap 2A/2B — confidence scoring', () => {
  it('scores exact match as 1.0', () => {
    assert.equal(scoreLabel('Save', 'Save'), 1.0);
  });
  it('scores case-insensitive exact match as 0.95', () => {
    assert.equal(scoreLabel('save', 'SAVE'), 0.95);
  });
  it('scores substring as 0.7', () => {
    assert.equal(scoreLabel('save', 'Save changes'), 0.7);
  });
  it('scores small Levenshtein distance as 0.5', () => {
    // "save" vs "sve" → distance 1 → 0.5
    assert.equal(scoreLabel('save', 'sve'), 0.5);
  });
  it('scores wildly different labels as 0', () => {
    assert.equal(scoreLabel('save', 'compile and ship'), 0);
  });
});

describe('Gap 2A — resolveMatches', () => {
  it('auto-selects when one candidate scores ≥ 0.95', () => {
    const matches = [
      { label: 'Save' },
      { label: 'Save changes' },
      { label: 'sve' },
    ];
    const r = resolveMatches(matches, 'Save', { side_effects: ['external'] });
    assert.equal(r.ambiguous, false);
    assert.equal(r.pick.label, 'Save');
    assert.equal(r.pick.score, 1.0);
  });

  it('returns ambiguous=true for risky intents with multiple low-confidence matches', () => {
    const matches = [
      { label: 'Save changes' },
      { label: 'Save draft' },
    ];
    const r = resolveMatches(matches, 'Save', { side_effects: ['external', 'send'] });
    assert.equal(r.ambiguous, true);
    assert.equal(r.matches.length, 2);
    assert.ok(r.matches.every(m => typeof m.score === 'number'));
  });

  it('keeps first-match behaviour for read-only intents', () => {
    const matches = [
      { label: 'Save changes' },
      { label: 'Save draft' },
    ];
    const r = resolveMatches(matches, 'Save', { side_effects: ['read'] });
    assert.equal(r.ambiguous, false);
    assert.ok(r.pick, 'pick should be set');
  });

  it('keeps first-match behaviour when no side_effects are declared', () => {
    const matches = [
      { label: 'Save changes' },
      { label: 'Save draft' },
    ];
    const r = resolveMatches(matches, 'Save', {});
    assert.equal(r.ambiguous, false);
  });

  it('buildAmbiguousEnvelope shapes the response per spec', () => {
    const resolution = resolveMatches(
      [{ label: 'Save changes' }, { label: 'Save draft' }],
      'Save',
      { side_effects: ['delete'] },
    );
    const env = buildAmbiguousEnvelope('Save', resolution);
    assert.equal(env.ok, false);
    assert.equal(env.ambiguous, true);
    assert.equal(env.query, 'Save');
    assert.equal(env.matches.length, 2);
    for (const m of env.matches) {
      for (const k of ['label', 'role', 'index', 'bounds', 'score']) {
        assert.ok(k in m, `match should have ${k}`);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Gap 3 — Episodic memory
// ══════════════════════════════════════════════════════════════════════════

describe('Gap 3 — episodic memory', () => {
  // Each test prepends a unique provider name so it doesn't conflict with
  // others, and the whole AGENT_ID file is removed at the end.

  after(() => {
    try { fs.unlinkSync(memory.MEMORY_FILE); } catch (_) {}
  });

  it('rememberEpisode persists to ~/.agentdom/memory.<agent>.jsonl', () => {
    const host = `rg-test-${Date.now()}.example`;
    const id = memory.rememberEpisode(host, 'contacts.create', 'success', 'first run');
    assert.match(id, /^[0-9a-f]+$/);
    assert.ok(fs.existsSync(memory.MEMORY_FILE), 'memory file should exist after remember');
    assert.ok(memory.MEMORY_FILE.includes('runtime_gaps_'), 'should write to per-test file');
  });

  it('recallEpisodes returns the most recent (host,intent) episodes', () => {
    const host = `rg-test-recall-${Date.now()}.example`;
    memory.rememberEpisode(host, 'tasks.create', 'success', 'one');
    memory.rememberEpisode(host, 'tasks.create', 'failure', 'two');
    memory.rememberEpisode(host, 'tasks.list',   'success', 'unrelated');

    const got = memory.recallEpisodes(host, 'tasks.create', 5);
    assert.equal(got.length, 2);
    assert.equal(got[0].notes, 'two', 'newest first');
    assert.equal(got[1].notes, 'one');
  });

  it('recallHints returns deduped notes for a host (newest first)', () => {
    const host = `rg-test-hints-${Date.now()}.example`;
    memory.rememberEpisode(host, 'tasks.create', 'success', 'scroll to bottom first');
    memory.rememberEpisode(host, 'tasks.update', 'success', 'scroll to bottom first'); // dup
    memory.rememberEpisode(host, 'tasks.delete', 'success', 'use bulk delete for >10');

    const notes = memory.recallHints(host, 10);
    assert.ok(notes.includes('use bulk delete for >10'));
    assert.ok(notes.includes('scroll to bottom first'));
    // Deduped — only 2 unique notes
    assert.equal(notes.length, 2);
    // Newest first
    assert.equal(notes[0], 'use bulk delete for >10');
  });

  it('recallHints scopes to the given host', () => {
    const a = `rg-host-a-${Date.now()}.example`;
    const b = `rg-host-b-${Date.now()}.example`;
    memory.rememberEpisode(a, 'x', 'success', 'note-a');
    memory.rememberEpisode(b, 'x', 'success', 'note-b');
    const aNotes = memory.recallHints(a, 10);
    assert.ok(aNotes.includes('note-a'));
    assert.ok(!aNotes.includes('note-b'));
  });

  it('recallEpisodes returns [] for unknown (host,intent)', () => {
    const got = memory.recallEpisodes(`rg-never-${Date.now()}.example`, 'never.run');
    assert.deepEqual(got, []);
  });
});

console.log('\n🧪 AgentDOM — Runtime Gap Closure Tests\n');
