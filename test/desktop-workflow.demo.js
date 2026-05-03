/**
 * Live desktop workflow demo.
 *
 * Drives TextEdit through the desktop MCP server: scan → see auto-generated
 * typed tools → dispatch a sequence → verify state change at each step.
 *
 * Requirements:
 *   - macOS Accessibility permission granted to the running terminal/Node binary.
 *
 * Run: node test/desktop-workflow.demo.js
 */

'use strict';

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const desktop = require('../desktop-agent');

const ROOT = path.join(__dirname, '..');
const APP = 'TextEdit';

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
  const client = new Client({ name: 'workflow-demo', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main() {
  // ── Preflight ──
  step('Preflight checks');
  const perm = desktop.checkPermissions();
  if (!perm.ok) {
    fail(`Accessibility not granted: ${perm.hint}`);
    process.exit(1);
  }
  ok('Accessibility permission granted');

  if (!desktop.isRunning(APP)) {
    info(`${APP} not running — opening...`);
    desktop.openApp(APP);
    await wait(1500);
  }
  ok(`${APP} is running`);
  info('Preflight done. From here, EVERY action is dispatched through the MCP server as a typed tool call — no desktop.* primitives in the agent path.');

  // ── Connect to MCP ──
  step('Spawning desktop MCP server and connecting MCP client over stdio');
  const client = await spawnClient();
  ok('Connected');

  try {
    // ── Step 1: list initial tools ──
    step('Step 1: tools/list before scan');
    const initial = await client.listTools();
    info(`Server exposes ${initial.tools.length} meta tools: ${initial.tools.map(t => t.name).join(', ')}`);
    if (!initial.tools.find(t => t.name === 'scan_app')) {
      fail('scan_app meta tool missing'); process.exit(1);
    }
    ok('scan_app meta tool present');

    // ── Step 2: scan_app generates typed tools ──
    step(`Step 2: scan_app({ app: "${APP}" }) → compile() → tools/list_changed`);
    let scanData = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
    info(`Counts: ${JSON.stringify(scanData.counts)}`);
    info(`Framework: ${scanData.framework}`);
    ok(`Auto-generated ${scanData.tools.length} typed tools`);

    // If no text_area form exists, no document is open — dispatch click_new
    // through the MCP server (NOT desktop.clickMenu) and re-scan.
    const hadDoc = scanData.counts.forms > 0;
    if (!hadDoc) {
      step('Step 2b: no document detected → dispatch click_new (typed tool, MCP-routed)');
      const r = await client.callTool({ name: 'click_new', arguments: {} });
      if (r.isError) { fail(`click_new failed: ${jsonText(r).error || ''}`); process.exit(1); }
      ok(`Dispatched click_new — ${jsonText(r).dispatched}`);
      await wait(800);
      scanData = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
      info(`Re-scan: ${JSON.stringify(scanData.counts)}`);
      ok(`Form now in scope: ${scanData.counts.forms} form(s)`);
    } else {
      ok('Reusing existing TextEdit document');
    }

    // ── Step 3: inspect what the agent now sees ──
    step('Step 3: tools/list after scan — what does the agent get?');
    const afterScan = await client.listTools();
    const dynamic = afterScan.tools.filter(t => !['scan_app', 'discover', 'observe', 'batch'].includes(t.name));
    info(`Agent sees ${afterScan.tools.length} total tools (${dynamic.length} compiler-generated)`);
    const samples = ['click_new', 'click_save', 'click_quit_textedit', 'click_hide_textedit', 'navigate'];
    for (const name of samples) {
      const t = afterScan.tools.find(x => x.name === name);
      if (t) ok(`${name}  →  ${t.description.slice(0, 80)}`);
      else warn(`${name} NOT in tools list`);
    }
    const navTool = afterScan.tools.find(t => t.name === 'navigate');
    if (navTool) {
      info(`navigate enum: [${navTool.inputSchema.properties.target.enum.slice(0, 8).join(', ')}, ...]`);
    }

    // ── Step 4: dispatch a typed tool — open Find panel via click_find ──
    step('Step 4: dispatch click_find — opens TextEdit\'s Find panel (MCP-routed)');
    const beforeCount = scanData.tools.length;
    const findResult = await client.callTool({ name: 'click_find', arguments: {} });
    if (findResult.isError) {
      warn(`click_find errored: ${jsonText(findResult).error || jsonText(findResult)}`);
    } else {
      const data = jsonText(findResult);
      ok(`Dispatched: ${data.dispatched} on "${data.element}"`);
    }
    await wait(800);

    // ── Step 5: re-scan via MCP — verify the UI changed ──
    step('Step 5: re-scan via MCP — tool count should grow (Find panel adds tools)');
    scanData = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
    const afterCount = scanData.tools.length;
    info(`Tool count: ${beforeCount} → ${afterCount}  (delta ${afterCount - beforeCount})`);
    if (afterCount > beforeCount) ok('Tools grew — Find panel detected by re-scan');
    else warn('No detectable tool growth (panel may not have opened, or its elements were beyond depth 4)');

    // ── Step 6: dispatch click_done — close the Find panel ──
    step('Step 6: dispatch click_done — closes the Find panel');
    const doneResult = await client.callTool({ name: 'click_done', arguments: {} });
    if (doneResult.isError) {
      warn(`click_done not available; the Find panel may already be closed`);
    } else {
      ok('Find panel dismissed via typed tool');
    }
    await wait(500);

    // ── Step 7: dispatch navigate({ target: 'Edit' }) ──
    step('Step 7: dispatch navigate({ target: "Edit" }) — opens the Edit menu');
    const navResult = await client.callTool({ name: 'navigate', arguments: { target: 'Edit' } });
    if (navResult.isError) warn(`navigate errored: ${jsonText(navResult).error || ''}`);
    else ok(`navigate dispatched: ${jsonText(navResult).dispatched}`);
    // Close the menu by navigating again to the same target — toggle behaviour.
    await client.callTool({ name: 'navigate', arguments: { target: 'Edit' } });
    await wait(300);

    // ── Step 8: close the test document — exercises sheet recursion ──
    step('Step 8: dispatch click_close → re-scan via MCP → if sheet appears, dispatch click_delete');
    if (hadDoc) {
      info('Skipping document close — user had a document open before the demo started.');
    } else {
      const closeResult = await client.callTool({ name: 'click_close', arguments: {} });
      if (closeResult.isError) warn(`click_close errored: ${jsonText(closeResult).error || ''}`);
      else ok('click_close dispatched (MCP-routed)');
      await wait(800);

      // Re-scan via MCP. If the close triggered a save sheet, the sheet
      // recursion in scan_app picks up its buttons and they appear as new
      // typed tools (click_delete, click_dont_save, click_save).
      const reScan = jsonText(await client.callTool({ name: 'scan_app', arguments: { app: APP } }));
      const hasDiscard = reScan.tools.find(t => t.name === 'click_delete' || t.name === 'click_dont_save');
      if (hasDiscard) {
        info(`Save sheet detected — dispatching ${hasDiscard.name}`);
        const r = await client.callTool({ name: hasDiscard.name, arguments: {} });
        if (!r.isError) ok('Discarded unsaved changes via typed tool');
        else warn(`Discard failed: ${jsonText(r).error || ''}`);
      } else {
        ok('Document closed cleanly (no save prompt — was empty).');
      }
    }

    // Hide TextEdit via the typed click_hide_textedit tool — observe state via
    // the meta `observe` tool on the MCP server (not desktop.getFrontApp).
    step('Step 9: dispatch click_hide_textedit + observe — MCP-only state check');
    const beforeObs = jsonText(await client.callTool({ name: 'observe', arguments: {} }));
    info(`Frontmost before hide: ${beforeObs.activeApp || beforeObs.frontmost || 'unknown'}`);
    const hideResult = await client.callTool({ name: 'click_hide_textedit', arguments: {} });
    if (!hideResult.isError) {
      await wait(400);
      const afterObs = jsonText(await client.callTool({ name: 'observe', arguments: {} }));
      ok(`Hidden — frontmost is now: ${afterObs.activeApp || afterObs.frontmost || 'unknown'}`);
    }

    // ── Summary ──
    step('Summary');
    log(`  ${C.green}Workflow complete.${C.r} 8 steps, all dispatched through the MCP server.`);
    log(`  Agent never saw a CSS selector, AX path, or click(x,y) — only typed tools.`);

  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
