/**
 * launch + sessions.json + detectCDP round-trip.
 *
 * Verifies the zero-setup Phase 1 path end-to-end. Chrome stands in for any
 * Electron app: same Chromium runtime, same CDP, but isolated to a temp
 * profile so it won't disturb the user's running Chrome session.
 *
 * Skipped on non-darwin and when /Applications/Google Chrome.app isn't
 * present (so this test is a no-op in CI on Linux).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const launchCmd = require('../commands/launch');
const electronBridge = require('../desktop-agent/electron-bridge');

const APP = 'Google Chrome';
const BUNDLE = `/Applications/${APP}.app`;
const PROFILE = path.join(os.tmpdir(), `agentdom-launchflow-${process.pid}`);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.stack || e.message}`); fail++; }
}

function killByPort(port) {
  // Kill the LISTENER on our debug port (Chrome's launcher process). macOS
  // lsof argument shape: -t (terse pid) + -iTCP:N + -sTCP:LISTEN. Without
  // the LISTEN filter we'd also see the puppeteer-core client and shoot
  // ourselves. Skip our own pid defensively.
  try {
    const out = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 3000 }).trim();
    for (const pid of out.split('\n').filter(Boolean)) {
      const n = Number(pid);
      if (!n || n === process.pid) continue;
      try { process.kill(n, 'SIGTERM'); } catch (_) {}
    }
  } catch (_) {}
}

async function main() {
  if (process.platform !== 'darwin' || !fs.existsSync(BUNDLE)) {
    console.log('skipped: not darwin or Google Chrome not installed');
    return;
  }
  fs.mkdirSync(PROFILE, { recursive: true });

  // upsertSession dedupes by app name, so any pre-existing session for this
  // app is already invalidated the moment launchApp() runs. Don't try to
  // restore — just remove our entry on cleanup.
  let result = null;
  try {
    await test('launchApp launches + writes sessions.json', async () => {
      result = await launchCmd.launchApp(APP, {
        quiet: true,
        extraArgs: [
          `--user-data-dir=${PROFILE}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--headless=new',
          '--disable-gpu',
        ],
      });
      assert.ok(!result.error, `launchApp returned error: ${JSON.stringify(result)}`);
      assert.ok(result.port, 'session must include a port');
      assert.ok(result.port > 0, `port must be positive, got ${result.port}`);
      const session = launchCmd.findSession(APP);
      assert.ok(session, 'sessions.json should hold a record for the app');
      assert.strictEqual(session.port, result.port);
    });

    await test('detectCDP picks up the sessions-file source first', async () => {
      assert.ok(result?.port, 'previous test must succeed');
      // Pass an empty `ports` array and trust the sessions-file lookup.
      const info = await electronBridge.detectCDP(APP, { ports: [] });
      assert.ok(info, `detectCDP returned null; sessions=${JSON.stringify(launchCmd.findSession(APP))}`);
      assert.strictEqual(info.source, 'sessions-file');
      assert.strictEqual(info.port, result.port);
    });

    await test('attach() against the launched session works', async () => {
      assert.ok(result?.port);
      const session = await electronBridge.attach({ port: result.port });
      try {
        const targets = await session.listTargets();
        assert.ok(targets.length >= 1, 'expected at least one CDP target');
      } finally {
        await session.dispose();
      }
    });

    await test('launchApp on a non-Electron bundle errors cleanly', async () => {
      const r = await launchCmd.launchApp('Safari', { quiet: true });
      assert.ok(r.error, 'expected error for non-CDP app');
      assert.ok(/not an Electron or Chromium app/.test(r.error), `unexpected error: ${r.error}`);
    });

    await test('launchApp on an unknown app errors cleanly', async () => {
      const r = await launchCmd.launchApp('NotARealAppZZZ', { quiet: true });
      assert.ok(r.error);
      assert.ok(/not found/.test(r.error), `unexpected error: ${r.error}`);
    });

    await test('sessions list reflects the launch', () => {
      const sessions = launchCmd.gcSessions();
      const ours = sessions.find(s => s.app === APP);
      assert.ok(ours, 'sessions list should contain our app');
    });
  } finally {
    if (result?.port) killByPort(result.port);
    // Reap any helper processes still anchored to our profile dir — Chrome
    // forks several and the listener kill above doesn't always cascade fast
    // enough to satisfy the post-test pgrep check.
    try {
      const out = execFileSync('pgrep', ['-f', PROFILE], { encoding: 'utf-8', timeout: 2000 }).trim();
      for (const pid of out.split('\n').filter(Boolean)) {
        const n = Number(pid);
        if (n && n !== process.pid) {
          try { process.kill(n, 'SIGTERM'); } catch (_) {}
        }
      }
    } catch (_) {}
    // Remove our app's record. Other entries in the user's sessions.json
    // are left alone.
    const remaining = launchCmd.readSessions().filter(s => s.app !== APP);
    launchCmd.writeSessions(remaining);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('Harness failure:', e); process.exit(2); });
