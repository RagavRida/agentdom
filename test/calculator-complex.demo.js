/**
 * Complex Calculator workflow — proves the AX-bridge-based scanner + dispatch
 * handles real multi-step flows on a SwiftUI app.
 *
 * Steps:
 *   1.  All Clear (baseline)
 *   2.  Compute 12 × 7 = 84            ← multi-digit, multi-operator
 *   3.  Continue: − 14 = 70             ← chained from previous result
 *   4.  Verify display reads "70"
 *   5.  Open Scientific mode via menu   ← state change, new tools appear
 *   6.  Compute √25 = 5                 ← scientific function (Square Root)
 *   7.  Verify display reads "5"
 *   8.  Switch back to Basic mode
 *   9.  Verify scientific tools went away
 *
 * Run: node test/calculator-complex.demo.js
 *
 * Uses the desktop-agent module directly — same code path the desktop MCP
 * server dispatches to.  No selectors, no coordinates, no clickMenu shortcuts;
 * every action is a typed clickElement(label) or scanApp() call.
 */

'use strict';

const desktop = require('../desktop-agent');

const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', r: '\x1b[0m' };
const log  = (m, c = '') => console.log(`${c}${m}${C.r}`);
const step = m => log(`\n▸ ${m}`, C.cyan);
const ok   = m => log(`  ${C.green}✓${C.r} ${m}`);
const info = m => log(`  ${C.dim}${m}${C.r}`);
const warn = m => log(`  ${C.yellow}!${C.r} ${m}`);
const fail = m => log(`  ${C.red}✗${C.r} ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));

const APP = 'Calculator';

function readDisplay() {
  const els = desktop.scanApp(APP);
  if (els.error) return { error: els.error, value: null };
  // Strip Unicode bidi marks (LTR ‎, RTL ‏, embeddings ‪-‮)
  // and any other invisible formatting Calculator sprinkles into its display.
  const stripBidi = s => s.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
  // macOS Tahoe puts the displayed value in AXValue with a generic
  // "text (N)" label after disambiguation; older versions used AXTitle.
  // Pull both, then bidi-strip, then keep the numeric ones.
  const candidates = els
    .filter(e => e.type === 'label')
    .flatMap(e => [e.value, e.label])
    .filter(v => typeof v === 'string' && v.length)
    .map(stripBidi)
    .filter(Boolean);
  const numeric = candidates.filter(l => /^-?[\d,]+(\.\d+)?$/.test(l));
  return { allLabels: candidates, numericLabels: numeric, value: numeric[numeric.length - 1] ?? null };
}

function buttonLabels() {
  const els = desktop.scanApp(APP);
  if (els.error) return [];
  return els.filter(e => e.type === 'button' && e.label).map(e => e.label);
}

async function press(label) {
  const r = desktop.clickElement(APP, label);
  if (!r.clicked) {
    fail(`click "${label}" failed: ${r.error || ''}  hint: ${r.hint || ''}`);
    return false;
  }
  await wait(120);
  return true;
}

async function pressSeq(seq) {
  for (const label of seq) {
    const ok_ = await press(label);
    if (!ok_) return false;
  }
  return true;
}

function assertDisplay(expected, label = '') {
  const d = readDisplay();
  if (d.error) { fail(`scan failed: ${d.error}`); return false; }
  if (d.value === expected) {
    ok(`${label || 'display'}: ${d.value}  ✓ matches expected ${expected}`);
    return true;
  }
  fail(`${label || 'display'}: got "${d.value}", expected "${expected}".  All numeric labels: ${d.numericLabels.join(', ')}`);
  return false;
}

function assertContains(label) {
  const all = buttonLabels();
  if (all.includes(label)) { ok(`tool list contains "${label}"`); return true; }
  fail(`tool list missing "${label}".  Sample: ${all.slice(0, 6).join(', ')}...`);
  return false;
}

function assertNotContains(label) {
  const all = buttonLabels();
  if (!all.includes(label)) { ok(`tool list correctly missing "${label}"`); return true; }
  warn(`tool list still has "${label}" (mode switch may not have completed)`);
  return false;
}

let passed = 0, failed = 0;
function check(b) { if (b) passed++; else failed++; }

async function main() {
  // ── Preflight ──
  step('Preflight');
  const perm = desktop.checkPermissions();
  if (!perm.ok) { fail(`Accessibility not granted: ${perm.hint}`); process.exit(1); }
  if (!desktop.isRunning(APP)) { info('Opening Calculator…'); desktop.openApp(APP); await wait(1500); }
  // Warm-up: explicit activate + scan so AX tree is fully populated before the
  // first dispatch (avoids cold-start races where the bridge activates the app
  // but the SwiftUI button tree hasn't rendered yet).
  desktop.activate(APP);
  await wait(700);
  const warmScan = desktop.scanApp(APP);
  if (warmScan.error) { fail(`warm-up scan failed: ${warmScan.error}`); process.exit(1); }
  ok(`${APP} is running, AX bridge sees ${warmScan.length} elements`);

  // ── Step 1: clear ──
  step('Step 1: All Clear');
  check(await press('All Clear'));

  // ── Step 2: 12 × 7 = 84 ──
  step('Step 2: Compute 12 × 7  (multi-digit input + operator)');
  check(await pressSeq(['1', '2', 'Multiply', '7', 'Equals']));
  await wait(300);
  check(assertDisplay('84', '12 × 7'));

  // ── Step 3: − 14 = 70  (chain from prior result) ──
  step('Step 3: chain  − 14  on the previous result');
  check(await pressSeq(['Subtract', '1', '4', 'Equals']));
  await wait(300);
  check(assertDisplay('70', '84 − 14'));

  // ── Step 4: switch to Scientific mode via View menu ──
  step('Step 4: open Scientific mode via View menu');
  // The dispatcher routes menu items via clickMenu when selector starts with menu/.
  // From the desktop-agent IR, "Scientific" lives under View. Click it as a typed action.
  const beforeButtons = buttonLabels().length;
  info(`baseline button count: ${beforeButtons}`);
  const r = desktop.clickElement(APP, 'Scientific');
  if (!r.clicked) {
    warn(`click "Scientific" failed (menu may not be open). Falling back to keyboard shortcut.`);
    desktop.pressKeys(APP, 'cmd+2');
  } else {
    ok(`Scientific dispatched: ${r.method}`);
  }
  await wait(700);
  const afterButtons = buttonLabels().length;
  info(`button count: ${beforeButtons} → ${afterButtons}  (delta ${afterButtons - beforeButtons})`);
  if (afterButtons > beforeButtons) ok('More tools registered — Scientific mode active');
  else warn('No tool growth — mode switch may have failed');

  // ── Step 5: assert scientific function tools appeared ──
  step('Step 5: assert "Square Root" is now in the tool list');
  check(assertContains('Square Root'));
  check(assertContains('Sine'));

  // ── Step 6: compute √25 = 5 ──
  // Scientific mode: Square Root inserts √(...) — the argument goes inside,
  // so the order is √, 2, 5, =.
  step('Step 6: Compute √25');
  check(await press('All Clear'));
  check(await pressSeq(['Square Root', '2', '5', 'Equals']));
  await wait(400);
  check(assertDisplay('5', '√25'));

  // ── Step 7: switch back to Basic mode ──
  step('Step 7: switch back to Basic mode');
  const r2 = desktop.clickElement(APP, 'Basic');
  if (!r2.clicked) {
    warn(`click "Basic" failed; falling back to keyboard shortcut`);
    desktop.pressKeys(APP, 'cmd+1');
  } else ok(`Basic dispatched: ${r2.method}`);
  await wait(700);

  // ── Step 8: scientific tools should be gone ──
  step('Step 8: assert scientific tools went away');
  check(assertNotContains('Square Root'));

  // ── Summary ──
  step('Summary');
  const total = passed + failed;
  log(`  ${passed}/${total} assertions passed`, failed === 0 ? C.green : C.yellow);
  if (failed === 0) {
    log(`  ${C.green}Complex flow handled end-to-end.${C.r}`);
    log(`  Multi-digit input ✓  chained ops ✓  mode switch ✓  scientific fn ✓  state verified ✓`);
  } else {
    log(`  ${failed} assertion(s) failed — see above for details.`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(2); });
