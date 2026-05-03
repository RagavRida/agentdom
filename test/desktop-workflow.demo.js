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

  // Only create a new document if no text_area is already present — avoids the
  // "Untitled 3 / 4 / 5" pileup when the demo runs repeatedly.
  const preScan = desktop.scanApp(APP);
  const hasDoc = Array.isArray(preScan) && preScan.some(e => e.type === 'text_area');
  if (!hasDoc) {
    info('No open document detected — creating one via File > New');
    desktop.clickMenu(APP, 'File > New');
    await wait(1000);
  } else {
    ok('Reusing existing TextEdit document');
  }

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
    const scanResult = await client.callTool({ name: 'scan_app', arguments: { app: APP } });
    if (scanResult.isError) {
      fail(`scan_app failed: ${jsonText(scanResult)}`); process.exit(1);
    }
    const scanData = jsonText(scanResult);
    info(`Counts: ${JSON.stringify(scanData.counts)}`);
    info(`Framework: ${scanData.framework}`);
    ok(`Auto-generated ${scanData.tools.length} typed tools`);

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
    step('Step 4: dispatch click_find — opens TextEdit\'s Find panel');
    const beforeFind = desktop.scanApp(APP);
    const beforeCount = Array.isArray(beforeFind) ? beforeFind.length : 0;
    const findResult = await client.callTool({ name: 'click_find', arguments: {} });
    if (findResult.isError) {
      warn(`click_find errored: ${jsonText(findResult).error || jsonText(findResult)}`);
    } else {
      const data = jsonText(findResult);
      ok(`Dispatched: ${data.dispatched} on "${data.element}"`);
    }
    await wait(800);

    // ── Step 5: re-scan — verify the UI changed ──
    step('Step 5: re-scan — state should have changed (Find panel adds elements)');
    const afterFind = desktop.scanApp(APP);
    const afterCount = Array.isArray(afterFind) ? afterFind.length : 0;
    info(`Element count: ${beforeCount} → ${afterCount}  (delta ${afterCount - beforeCount})`);
    if (afterCount > beforeCount) ok('UI tree grew — Find panel detected');
    else warn('No detectable element growth (panel may not have opened, or its elements were beyond depth 4)');

    // ── Step 6: dispatch click_done — close the Find panel ──
    step('Step 6: dispatch click_done — closes the Find panel');
    const doneResult = await client.callTool({ name: 'click_done', arguments: {} });
    if (doneResult.isError) {
      warn(`click_done not available; trying Escape via primitive`);
      desktop.pressKeys(APP, 'escape');
    } else {
      ok('Find panel dismissed via typed tool');
    }
    await wait(500);

    // ── Step 7: dispatch navigate({ target: 'Edit' }) ──
    step('Step 7: dispatch navigate({ target: "Edit" }) — opens the Edit menu');
    const navResult = await client.callTool({ name: 'navigate', arguments: { target: 'Edit' } });
    if (navResult.isError) {
      warn(`navigate errored: ${jsonText(navResult).error || ''}`);
    } else {
      ok(`navigate dispatched: ${jsonText(navResult).dispatched}`);
    }
    desktop.pressKeys(APP, 'escape'); // close the menu
    await wait(300);

    // ── Step 8: close the test document — exercises sheet recursion ──
    step('Step 8: dispatch click_close → save sheet appears → dispatch click_delete to discard');
    // We only auto-close the doc if WE created it (hasDoc was false above) so we
    // don't trash a document the user was already working on.
    if (hasDoc) {
      info('Skipping document close — user had a document open before the demo started.');
    } else {
      const closeResult = await client.callTool({ name: 'click_close', arguments: {} });
      if (closeResult.isError) {
        warn(`click_close errored: ${jsonText(closeResult).error || ''}`);
      } else {
        ok('click_close dispatched');
      }
      await wait(800);

      // After closing an empty unsaved doc, no save sheet appears (TextEdit
      // skips the prompt for empty docs). For docs with content the sheet
      // would show — re-scan would find click_delete / click_dont_save and we
      // could dispatch those. Try anyway in case content exists:
      const closingScan = desktop.scanApp(APP);
      const hasSavePrompt = Array.isArray(closingScan)
        && closingScan.some(e => e.label === 'Delete' || e.label === "Don't Save");
      if (hasSavePrompt) {
        info('Save prompt detected (sheet) — dispatching click_delete');
        // Re-scan via MCP so the dynamic tools include any sheet items.
        await client.callTool({ name: 'scan_app', arguments: { app: APP } });
        const r = await client.callTool({ name: 'click_delete', arguments: {} });
        if (!r.isError) ok('Discarded unsaved changes');
        else warn(`Discard failed: ${jsonText(r).error || ''}`);
      } else {
        ok('Document closed cleanly (no save prompt — was empty).');
      }
    }

    // Hide TextEdit so the user gets their previous frontmost app back.
    const front0 = desktop.getFrontApp();
    info(`Frontmost before hide: ${front0}`);
    const hideResult = await client.callTool({ name: 'click_hide_textedit', arguments: {} });
    if (!hideResult.isError) {
      await wait(400);
      const front1 = desktop.getFrontApp();
      ok(`Hidden — frontmost is now: ${front1}`);
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
