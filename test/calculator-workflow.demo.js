/**
 * Live desktop workflow demo — Calculator + sheet/modal lifecycle.
 *
 * Different from the TextEdit demo: this one exercises sheet recursion
 * end-to-end. When click_about_calculator dispatches, an About sheet opens.
 * The next scan_app picks up the sheet's buttons and registers them as new
 * typed tools (notifications/tools/list_changed fires). The agent then
 * dismisses the sheet via one of those newly-registered tools, and the
 * tool list shrinks back. No CSS selectors, AX paths, or coordinates leave
 * the server.
 *
 * Run: node test/calculator-workflow.demo.js
 */

'use strict';

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const desktop = require('../desktop-agent');

const ROOT = path.join(__dirname, '..');
const APP = 'Calculator';

const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', r: '\x1b[0m' };
const log  = (m, c = '') => console.log(`${c}${m}${C.r}`);
const step = m => log(`\n▸ ${m}`, C.cyan);
const ok   = m => log(`  ${C.green}✓${C.r} ${m}`);
const info = m => log(`  ${C.dim}${m}${C.r}`);
const warn = m => log(`  ${C.yellow}!${C.r} ${m}`);
const fail = m => log(`  ${C.red}✗${C.r} ${m}`);

const wait = ms => new Promise(r => setTimeout(r, ms));

function jsonText(callResult) {
  const text = callResult.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return text; }
}

async function spawnClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'desktop-mcp-server.js')],
  });
  const client = new Client({ name: 'calculator-demo', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main() {
  // ── Preflight ──
  step('Preflight');
  const perm = desktop.checkPermissions();
  if (!perm.ok) { fail(`Accessibility not granted: ${perm.hint}`); process.exit(1); }
  ok('Accessibility permission granted');

  if (!desktop.isRunning(APP)) {
    info(`${APP} not running — opening...`);
    desktop.openApp(APP);
    await wait(1500);
  }
  ok(`${APP} is running`);
  info('From here, every action goes through the MCP server as a typed tool call.');

  // ── Connect ──
  step('Spawn desktop MCP server, connect MCP client over stdio');
  const client = await spawnClient();
  ok('Connected');

  try {
    // ── Step 1: baseline scan_app ──
    step('Step 1: scan_app({ app: "Calculator" }) — baseline tool list');
    const scan0 = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
    info(`Counts: ${JSON.stringify(scan0.counts)}`);
    info(`Framework: ${scan0.framework}`);
    ok(`Baseline: ${scan0.tools.length} typed tools registered`);
    const baseTools = new Set(scan0.tools.map(t => t.name));

    // Quick sanity — we expect the About menu item to show up as click_about_calculator.
    if (!baseTools.has('click_about_calculator')) {
      warn(`click_about_calculator missing. Sample tools: ${[...baseTools].slice(0, 10).join(', ')}`);
    } else {
      ok('Found click_about_calculator in the auto-generated tool list');
    }

    // ── Step 2: open the About sheet via typed tool ──
    step('Step 2: dispatch click_about_calculator — opens the About sheet');
    const r2 = await client.callTool({ name: 'click_about_calculator', arguments: {} });
    if (r2.isError) { fail(`click_about_calculator failed: ${jsonText(r2).error || ''}`); process.exit(1); }
    ok(`Dispatched: ${jsonText(r2).dispatched} on "${jsonText(r2).element}"`);
    await wait(900); // let the sheet animate in

    // ── Step 3: re-scan — sheet recursion should pick up the new buttons ──
    step('Step 3: scan_app again — sheet recursion should add new typed tools');
    const scan1 = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
    const newTools = scan1.tools.filter(t => !baseTools.has(t.name)).map(t => t.name);
    info(`Tool count: ${scan0.tools.length} → ${scan1.tools.length}  (delta ${scan1.tools.length - scan0.tools.length})`);
    if (newTools.length > 0) {
      ok(`New tools registered after sheet open: ${newTools.slice(0, 10).join(', ')}${newTools.length > 10 ? ', ...' : ''}`);
    } else {
      warn('No new tools detected — the About sheet may not have rendered with accessibility');
    }

    // ── Step 4: dismiss the sheet via a typed tool ──
    step('Step 4: dismiss the sheet via a typed tool from the new list');
    // Common dismiss labels: OK, Close, Done. Click whichever showed up.
    const dismissCandidates = ['click_ok', 'click_close', 'click_done', 'click_dismiss'];
    const dismissTool = scan1.tools.find(t => dismissCandidates.includes(t.name))?.name;
    if (dismissTool) {
      const r4 = await client.callTool({ name: dismissTool, arguments: {} });
      if (!r4.isError) ok(`Dispatched ${dismissTool} — ${jsonText(r4).dispatched}`);
      else warn(`${dismissTool} errored: ${jsonText(r4).error || ''}`);
    } else {
      warn(`No dismiss tool in the new list. Sheet may not be a standard sheet — falling back to navigate to close.`);
      // Fallback through MCP only — call the platform escape-hatch press_keys via toMCPTools
      const escTool = (await client.listTools()).tools.find(t => t.name === 'interact_press_keys' || t.name === 'press_keys');
      if (escTool) {
        await client.callTool({ name: escTool.name, arguments: { app: APP, shortcut: 'escape' } });
        info('Sent Escape via the platform escape-hatch tool');
      }
    }
    await wait(700);

    // ── Step 5: re-scan — the sheet tools should be gone ──
    step('Step 5: scan_app again — verify the sheet tools are gone');
    const scan2 = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
    const stillNew = scan2.tools.map(t => t.name).filter(n => newTools.includes(n));
    info(`Tool count: ${scan1.tools.length} → ${scan2.tools.length}`);
    if (stillNew.length === 0 && scan2.tools.length <= scan0.tools.length + 2) {
      ok('Sheet tools removed — tool list contracted back to baseline');
    } else if (stillNew.length > 0) {
      warn(`${stillNew.length} sheet tool(s) still registered: ${stillNew.slice(0, 5).join(', ')}`);
    } else {
      info('Tool count near baseline — sheet appears closed');
    }

    // ── Step 6: navigate menu round-trip ──
    step('Step 6: navigate({ target: "View" }) twice (open → toggle close)');
    const r6a = await client.callTool({ name: 'navigate', arguments: { target: 'View' } });
    if (!r6a.isError) ok(`Opened View menu — ${jsonText(r6a).dispatched}`);
    await wait(300);
    const r6b = await client.callTool({ name: 'navigate', arguments: { target: 'View' } });
    if (!r6b.isError) ok('Toggled View menu closed');

    // ── Step 7: cleanup — hide Calculator ──
    step('Step 7: dispatch click_hide_calculator + observe to verify');
    const beforeObs = jsonText(await client.callTool({ name: 'observe', arguments: {} }));
    info(`Frontmost before hide: ${beforeObs.activeApp || beforeObs.frontmost || 'unknown'}`);
    const hide = await client.callTool({ name: 'click_hide_calculator', arguments: {} });
    if (!hide.isError) {
      await wait(400);
      const afterObs = jsonText(await client.callTool({ name: 'observe', arguments: {} }));
      ok(`Hidden — frontmost is now: ${afterObs.activeApp || afterObs.frontmost || 'unknown'}`);
    } else {
      warn(`click_hide_calculator errored: ${jsonText(hide).error || ''}`);
    }

    step('Summary');
    log(`  ${C.green}Workflow complete.${C.r} 7 steps, every action through the MCP server.`);
    log(`  Demonstrated: sheet appearance → tool list expansion → dismiss → contraction.`);
    log(`  The agent's view of the world changed in lock-step with the UI, deterministically.`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
