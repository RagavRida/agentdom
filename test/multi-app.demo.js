/**
 * Multi-app workflow — Calculator → TextEdit pipeline through typed tools.
 *
 *   1.  Calculator: All Clear
 *   2.  Calculator: compute 49 × 17 = 833 (multi-digit, multi-step)
 *   3.  Read Calculator's display (AXStaticText) and assert "833"
 *   4.  Calculator: dispatch click_copy → result on the system clipboard
 *   5.  Verify clipboard contains "833" via pbpaste
 *   6.  Switch to TextEdit
 *   7.  Ensure a document is open (dispatch click_new if not)
 *   8.  Dispatch click_paste in TextEdit
 *   9.  Re-scan TextEdit, read the text_area's AXValue, assert it contains "833"
 *
 *  Two apps. One clipboard hop. Eleven typed clicks. Five assertions.
 *  No selectors, no AppleScript, no human in the loop.
 *
 *  Run: npm run demo:multi-app
 */

'use strict';

const { execFileSync } = require('child_process');
const desktop = require('../desktop-agent');

const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', r: '\x1b[0m' };
const log  = (m, c = '') => console.log(`${c}${m}${C.r}`);
const step = m => log(`\n▸ ${m}`, C.cyan);
const ok   = m => log(`  ${C.green}✓${C.r} ${m}`);
const info = m => log(`  ${C.dim}${m}${C.r}`);
const warn = m => log(`  ${C.yellow}!${C.r} ${m}`);
const fail = m => log(`  ${C.red}✗${C.r} ${m}`);
const wait = ms => new Promise(r => setTimeout(r, ms));

const stripBidi = s => String(s || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();

let passed = 0, failed = 0;
const check = b => { if (b) passed++; else failed++; };

function readClipboard() {
  try { return execFileSync('pbpaste', { encoding: 'utf-8' }); }
  catch { return ''; }
}

function calcDisplay() {
  const els = desktop.scanApp('Calculator');
  if (els.error) return { error: els.error };
  const labels = els.filter(e => e.type === 'label' && e.label).map(e => stripBidi(e.label));
  const numeric = labels.filter(l => /^-?[\d,]+(\.\d+)?$/.test(l));
  return { labels, value: numeric[numeric.length - 1] ?? null };
}

function textEditBody() {
  const els = desktop.scanApp('TextEdit');
  if (els.error) return { error: els.error };
  const ta = els.find(e => e.type === 'text_area');
  return { value: ta ? stripBidi(ta.value || ta.label || '') : null };
}

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

async function main() {
  step('Preflight');
  const perm = desktop.checkPermissions();
  if (!perm.ok) { fail(`Accessibility not granted: ${perm.hint}`); process.exit(1); }
  if (!desktop.isRunning('Calculator')) { desktop.openApp('Calculator'); await wait(1500); }
  if (!desktop.isRunning('TextEdit')) { desktop.openApp('TextEdit'); await wait(1500); }
  ok('Both apps running, AX bridge available');

  // Warm up Calculator so its SwiftUI tree is fully populated
  desktop.activate('Calculator');
  await wait(700);
  const warm = desktop.scanApp('Calculator');
  if (warm.error) { fail(`Calculator warm-up scan failed: ${warm.error}`); process.exit(1); }
  ok(`Calculator warm — bridge sees ${warm.length} elements`);

  // ── Step 1: clear Calculator ──
  step('Step 1: All Clear in Calculator');
  check(await press('Calculator', 'All Clear'));

  // ── Step 2: compute 49 × 17 ──
  step('Step 2: Compute 49 × 17 (multi-digit, multi-step)');
  check(await pressSeq('Calculator', ['4', '9', 'Multiply', '1', '7', 'Equals']));
  await wait(300);

  // ── Step 3: assert display ──
  step('Step 3: Read Calculator display');
  const disp = calcDisplay();
  if (disp.error) { fail(`scan: ${disp.error}`); check(false); }
  else if (disp.value === '833') { ok(`display reads 833`); check(true); }
  else { fail(`display reads "${disp.value}"; labels: ${(disp.labels || []).join(', ')}`); check(false); }
  const calcResult = disp.value || '';

  // ── Step 4: copy via Edit > Copy ──
  step('Step 4: dispatch click_copy → clipboard');
  // Empty the clipboard first so we know our copy is what populated it.
  try { execFileSync('pbcopy', [], { input: '' }); } catch {}
  check(await press('Calculator', 'Copy'));
  await wait(300);

  // ── Step 5: verify clipboard ──
  step('Step 5: read clipboard via pbpaste — should contain the result');
  const clip = stripBidi(readClipboard());
  if (clip === calcResult) { ok(`clipboard: "${clip}"`); check(true); }
  else { fail(`clipboard: "${clip}", expected "${calcResult}"`); check(false); }

  // ── Step 6: switch to TextEdit ──
  step('Step 6: switch focus to TextEdit');
  desktop.activate('TextEdit');
  await wait(800);
  ok('TextEdit activated');

  // ── Step 7: ensure a document is open ──
  step('Step 7: ensure a TextEdit document is open');
  let teScan = desktop.scanApp('TextEdit');
  let hadDoc = !teScan.error && Array.isArray(teScan) && teScan.some(e => e.type === 'text_area');
  if (!hadDoc) {
    info('No text_area visible — dispatch click_new');
    if (!(await press('TextEdit', 'New'))) { check(false); }
    else { check(true); }
    await wait(900);
    teScan = desktop.scanApp('TextEdit');
  } else {
    ok('Reusing existing document');
    check(true);
  }
  if (teScan.error || !teScan.find(e => e.type === 'text_area')) {
    fail(`TextEdit scan has no text_area after ensuring doc: ${teScan.error || 'no field'}`);
    check(false);
    process.exit(1);
  }

  // ── Step 8: paste via Edit > Paste ──
  step('Step 8: dispatch click_paste in TextEdit');
  check(await press('TextEdit', 'Paste'));
  await wait(500);

  // ── Step 9: verify text_area now contains the calculator's result ──
  step('Step 9: read TextEdit body and verify it contains the calculator result');
  const body = textEditBody();
  if (body.error) { fail(`scan: ${body.error}`); check(false); }
  else if (body.value && body.value.includes(calcResult)) {
    ok(`TextEdit body contains "${calcResult}" — full body preview: "${body.value.slice(0, 80)}${body.value.length > 80 ? '…' : ''}"`);
    check(true);
  } else {
    fail(`TextEdit body did not contain "${calcResult}"; body was "${body.value}"`);
    check(false);
  }

  // ── Summary ──
  step('Summary');
  const total = passed + failed;
  log(`  ${passed}/${total} assertions passed`, failed === 0 ? C.green : C.yellow);
  if (failed === 0) {
    log(`  ${C.green}Multi-app workflow handled end-to-end.${C.r}`);
    log(`  Calculator → clipboard → TextEdit. Two apps. One agent. Zero selectors.`);
  } else {
    log(`  ${failed} assertion(s) failed — see above for details.`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(2); });
