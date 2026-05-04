#!/usr/bin/env node
/**
 * Electron bridge — end-to-end demo.
 *
 * Spawns Google Chrome with --remote-debugging-port so the bridge has the
 * same CDP surface it would see attached to an Electron app launched with
 * the equivalent flag (Electron and Chrome speak identical CDP). Verifies:
 *   1. detectCDP() finds the port from the process list.
 *   2. attach() returns a usable ElectronSession.
 *   3. scanWindow() returns an agentdom.js schema, which the compiler turns
 *      into typed tools via from-web.
 *   4. clickByText / clickBySelector / typeIntoField land in the renderer.
 *   5. Manifest-style dom_click / dom_read steps work end-to-end.
 *
 * Run: node test/electron-bridge.demo.js
 *
 * Pre-req: Google Chrome at /Applications/Google Chrome.app (or set CHROME=
 * to a binary path). The demo isolates state into a temp profile dir so it
 * never touches the user's main browser session.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const electronBridge = require('../desktop-agent/electron-bridge');
const { compile } = require('../compiler');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT) || 19222;
const PROFILE = path.join(os.tmpdir(), `agentdom-cdp-${process.pid}`);
const FIXTURE = path.join(__dirname, 'fixtures', 'electron-fixture.html');
const PAGE = process.env.TEST_PAGE || `file://${FIXTURE}`;

function pass(name, extra) { console.log(`  ok  ${name}${extra ? ' ' + extra : ''}`); }
function fail(name, why) { console.error(`  FAIL ${name}: ${why}`); process.exitCode = 1; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(check, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}. Set CHROME= to override.`);
    process.exit(2);
  }
  fs.mkdirSync(PROFILE, { recursive: true });

  console.error(`Spawning Chrome (port ${PORT}, profile ${PROFILE})…`);
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    PAGE,
  ], { stdio: 'ignore', detached: false });

  let session = null;
  let exitCode = 0;

  const cleanup = async () => {
    try { if (session) await session.dispose(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    // 1. detectCDP picks up the new port.
    const info = await waitFor(() => electronBridge.detectCDP('Google Chrome', { ports: [PORT] }));
    if (!info) throw new Error('detectCDP timed out — Chrome did not expose CDP.');
    if (info.port !== PORT) fail('detectCDP returned unexpected port', String(info.port));
    pass('detectCDP found CDP endpoint', `(port=${info.port}, source=${info.source})`);

    // 2. attach() returns a session.
    session = await electronBridge.attach({ port: info.port });
    pass('attach() returned ElectronSession');

    const targets = await session.listTargets();
    if (!targets.length) throw new Error('No CDP page targets visible.');
    pass('listTargets sees at least one renderer', `(${targets.length})`);

    // Pin the fixture renderer; headless Chrome spawns helper targets too.
    const target = { urlIncludes: 'electron-fixture' };

    // 3. scanWindow returns an agentdom-shaped schema with real content.
    const schema = await waitFor(async () => {
      try {
        const s = await session.scanWindow(target);
        const url = s?.page?.meta?.url || '';
        const hasContent = (s?.page?.actions?.length || 0) + (s?.page?.forms?.length || 0) > 0;
        if (s && s.page && !url.startsWith('about:') && hasContent) return s;
        return null;
      } catch { return null; }
    }, { timeoutMs: 15000, intervalMs: 400 });
    if (!schema) throw new Error('scanWindow returned no populated schema after 15s.');
    pass('scanWindow returned agentdom schema',
      `(actions=${schema.page.actions?.length ?? 0}, forms=${schema.page.forms?.length ?? 0})`);

    // 4. compile via from-web → MCP tools (auth/search form + click + nav).
    const compiled = compile(schema, { from: 'web', to: 'mcp', appName: 'Fixture' });
    if (!compiled.tools.length) throw new Error('compile produced no tools.');
    pass('compile(from:web) produced tools', `(${compiled.tools.length})`);

    // 5. clickByText: increment the counter button.
    const click1 = await session.clickByText('Increment', target);
    if (!click1.clicked) throw new Error(`clickByText("Increment") failed: ${JSON.stringify(click1)}`);
    const click2 = await session.clickByText('Increment', target);
    if (!click2.clicked) throw new Error('second clickByText("Increment") failed');
    pass('clickByText incremented the counter twice');

    // 6. readBySelector reads the live counter.
    const counter = await session.readBySelector('#counter-out', target);
    if (counter !== '2') throw new Error(`counter expected "2", got "${counter}"`);
    pass('readBySelector saw counter=2');

    // 7. typeIntoField fills the search input by selector + label.
    const t1 = await session.typeIntoField({ selector: '#q', text: 'agentdom-electron' }, target);
    if (!t1.typed) throw new Error(`typeIntoField (selector) failed: ${JSON.stringify(t1)}`);
    const inputValue = await session.evalJS('document.getElementById("q").value', target);
    if (inputValue.value !== 'agentdom-electron') {
      throw new Error(`input value expected "agentdom-electron", got "${inputValue.value}"`);
    }
    pass('typeIntoField wrote to <input>', `(value="${inputValue.value}")`);

    // 8. clickBySelector follows an in-page anchor; rescan sees the revealed section.
    const linkClick = await session.clickBySelector('#more-link', target);
    if (!linkClick.clicked) throw new Error('clickBySelector(#more-link) failed');
    await sleep(200);
    const detailText = await session.readBySelector('#detail-text', target);
    if (!/arrived at detail/.test(detailText || '')) {
      throw new Error(`detail-text expected "arrived…", got "${detailText}"`);
    }
    pass('clickBySelector triggered hashchange + reveal', `(detail="${detailText}")`);

    // 9. evalJS round-trips a value from the same renderer.
    const evalRes = await session.evalJS('document.querySelectorAll("a, button").length', target);
    if (!evalRes.ok) throw new Error(`evalJS failed: ${evalRes.error}`);
    pass('evalJS returned a value', `(controls=${evalRes.value})`);

    console.log('\n9/9 passed');
  } catch (e) {
    exitCode = 1;
    console.error('\nFAILED:', e.message);
    if (e.stack) console.error(e.stack);
  } finally {
    await cleanup();
    process.exit(exitCode || (process.exitCode || 0));
  }
}

main();
