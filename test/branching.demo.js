/**
 * Branching workflow — observation drives the path.
 *
 * The agent computes a value in Calculator, observes the result, then takes
 * ONE of TWO paths based on what it saw. Both paths produce different
 * verdicts in TextEdit; both are verifiable.
 *
 *   1.  Calculator: compute 49 × 17
 *   2.  Read display
 *   3.  DECISION: does the result match the expected value?
 *           ├── matches    → VERIFIED branch:  write "VERIFIED: 833" to TextEdit
 *           └── mismatch   → MISMATCH branch:  write "MISMATCH: expected X, got Y"
 *   4.  Switch to TextEdit, ensure doc, type the verdict via clipboard paste
 *   5.  Re-scan TextEdit, assert the right verdict appears
 *
 * Default run takes the VERIFIED path (49 × 17 = 833, expected = 833).
 * Run with DEMO_FORCE_FAIL=1 to flip the expected value to "999" and exercise
 * the MISMATCH path — both branches actually run and pass their assertions.
 *
 *   npm run demo:branching                  → VERIFIED path
 *   DEMO_FORCE_FAIL=1 npm run demo:branching → MISMATCH path
 */

'use strict';

const { execFileSync } = require('child_process');
const desktop = require('../desktop-agent');

const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', mag: '\x1b[35m', r: '\x1b[0m' };
const log  = (m, c = '') => console.log(`${c}${m}${C.r}`);
const step = m => log(`\n▸ ${m}`, C.cyan);
const ok   = m => log(`  ${C.green}✓${C.r} ${m}`);
const info = m => log(`  ${C.dim}${m}${C.r}`);
const warn = m => log(`  ${C.yellow}!${C.r} ${m}`);
const fail = m => log(`  ${C.red}✗${C.r} ${m}`);
const choose = m => log(`  ${C.mag}◆${C.r} ${m}`, C.mag);
const wait = ms => new Promise(r => setTimeout(r, ms));

const stripBidi = s => String(s || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();

let passed = 0, failed = 0;
const check = b => { if (b) passed++; else failed++; };

async function press(app, label) {
  const r = desktop.clickElement(app, label);
  if (!r.clicked) { fail(`click "${label}" in ${app} failed: ${r.error || ''}`); return false; }
  await wait(140);
  return true;
}
async function pressSeq(app, seq) {
  for (const lbl of seq) if (!(await press(app, lbl))) return false;
  return true;
}

function calcDisplayValue() {
  const els = desktop.scanApp('Calculator');
  if (els.error) return null;
  const labels = els.filter(e => e.type === 'label' && e.label).map(e => stripBidi(e.label));
  const numeric = labels.filter(l => /^-?[\d,]+(\.\d+)?$/.test(l));
  return numeric[numeric.length - 1] ?? null;
}

function textEditBody() {
  const els = desktop.scanApp('TextEdit');
  if (els.error) return null;
  const ta = els.find(e => e.type === 'text_area');
  return ta ? stripBidi(ta.value || ta.label || '') : null;
}

async function ensureTextEditDoc() {
  let els = desktop.scanApp('TextEdit');
  let hasDoc = !els.error && Array.isArray(els) && els.some(e => e.type === 'text_area');
  if (hasDoc) return true;
  if (!(await press('TextEdit', 'New'))) return false;
  await wait(900);
  els = desktop.scanApp('TextEdit');
  return !els.error && els.some(e => e.type === 'text_area');
}

async function clearTextEdit() {
  // Select all + delete via Cmd+A then Delete — keeps the doc but empties it.
  desktop.pressKeys('TextEdit', 'cmd+a');
  await wait(150);
  desktop.pressKeys('TextEdit', 'delete');
  await wait(200);
}

async function main() {
  step('Preflight');
  const perm = desktop.checkPermissions();
  if (!perm.ok) { fail(`Accessibility not granted: ${perm.hint}`); process.exit(1); }
  if (!desktop.isRunning('Calculator')) { desktop.openApp('Calculator'); await wait(1500); }
  if (!desktop.isRunning('TextEdit'))   { desktop.openApp('TextEdit');   await wait(1500); }

  desktop.activate('Calculator');
  await wait(700);
  ok('Both apps running, AX bridge available');

  const expected = process.env.DEMO_FORCE_FAIL === '1' ? '999' : '833';
  const computation = '49 × 17';
  info(`Goal: compute ${computation} and verify it equals ${expected} (DEMO_FORCE_FAIL=${process.env.DEMO_FORCE_FAIL || '0'})`);

  // ── Step 1+2: compute and read ──
  step(`Step 1: All Clear + compute ${computation}`);
  check(await press('Calculator', 'All Clear'));
  check(await pressSeq('Calculator', ['4', '9', 'Multiply', '1', '7', 'Equals']));
  await wait(300);

  step('Step 2: Read display');
  const observed = calcDisplayValue();
  if (observed) { ok(`observed: ${observed}`); check(true); }
  else { fail('could not read display'); check(false); process.exit(1); }

  // ── Step 3: branching decision ──
  step('Step 3: DECISION POINT — does observed match expected?');
  const matches = observed === expected;
  const branch = matches ? 'VERIFIED' : 'MISMATCH';
  const verdict = matches
    ? `VERIFIED: ${expected}`
    : `MISMATCH: expected ${expected}, got ${observed}`;

  log(`  observed = "${observed}"`, C.dim);
  log(`  expected = "${expected}"`, C.dim);
  choose(`branch chosen: ${branch}`);
  log(`  verdict: ${verdict}`, C.dim);

  // ── Step 4: take the chosen branch — write verdict to TextEdit ──
  step(`Step 4: take the ${branch} path → write verdict to TextEdit`);
  // Clipboard hop carries the verdict — pbcopy writes via stdin (shell-safe).
  execFileSync('pbcopy', [], { input: verdict });
  desktop.activate('TextEdit');
  await wait(800);
  if (!(await ensureTextEditDoc())) { fail('could not ensure TextEdit doc'); process.exit(1); }
  await clearTextEdit();
  check(await press('TextEdit', 'Paste'));
  await wait(500);

  // ── Step 5: verify the right verdict landed ──
  step('Step 5: re-scan TextEdit and verify the verdict');
  const body = textEditBody();
  if (body && body.includes(verdict)) {
    ok(`TextEdit body matches the chosen branch: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`);
    check(true);
  } else {
    fail(`expected body to contain "${verdict}"; got "${body}"`);
    check(false);
  }

  // ── Cross-check: the OTHER branch's verdict must NOT appear ──
  step('Step 6: cross-check — the alternate branch must not have run');
  const altVerdict = matches
    ? `MISMATCH: expected ${expected}, got ${observed}`
    : `VERIFIED: ${expected}`;
  if (body && body.includes(altVerdict)) {
    fail(`alternate verdict "${altVerdict}" leaked into the body`); check(false);
  } else {
    ok('alternate-branch verdict absent — branching was clean');
    check(true);
  }

  // ── Summary ──
  step('Summary');
  const total = passed + failed;
  log(`  ${passed}/${total} assertions passed`, failed === 0 ? C.green : C.yellow);
  log(`  branch taken: ${branch}`);
  if (failed === 0) {
    log(`  ${C.green}Branching workflow handled end-to-end.${C.r}`);
    log(`  Observation drove the route — same script, different paths, both verifiable.`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(2); });
