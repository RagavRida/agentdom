/**
 * `agentdom sessions [list|clear|stop <App>]` — manage CDP sessions written
 * by `agentdom launch`. Pure bookkeeping over ~/.agentdom/sessions.json.
 *
 * - list (default): show live sessions; GCs entries whose pid is gone.
 * - clear: drop the sessions file. Does NOT quit any running app.
 * - stop <App>: drop one app's entry. Optionally `--quit` quits the app too.
 */

'use strict';

const { execFileSync } = require('child_process');
const launch = require('./launch');

const C = { green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m', r: '\x1b[0m' };
const ok = m => process.stdout.write(`  ${C.green}✓${C.r} ${m}\n`);
const fail = m => process.stderr.write(`  ${C.red}✗${C.r} ${m}\n`);
const dim = m => process.stdout.write(`  ${C.gray}${m}${C.r}\n`);

function list() {
  const sessions = launch.gcSessions();
  if (!sessions.length) {
    dim('No active CDP sessions. Run `agentdom launch <App>` to start one.');
    return { sessions: [] };
  }
  process.stdout.write(`\n  ${C.cyan}Active CDP sessions${C.r}\n`);
  for (const s of sessions) {
    process.stdout.write(`  ${C.green}●${C.r} ${s.app}  ${C.gray}port=${s.port}  pid=${s.pid}  launched=${s.launched_at}${C.r}\n`);
  }
  process.stdout.write('\n');
  return { sessions };
}

function clear() {
  launch.writeSessions([]);
  ok(`Cleared ${launch.SESSIONS_FILE}`);
  dim('Running apps were not affected.');
  return { cleared: true };
}

function stop(appName, { quit = false } = {}) {
  if (!appName) {
    fail('stop requires an app name');
    return { error: 'app name required' };
  }
  const before = launch.gcSessions();
  const target = before.find(s => s.app === appName);
  if (!target) {
    fail(`No session for "${appName}"`);
    return { error: 'no such session' };
  }
  const remaining = before.filter(s => s.app !== appName);
  launch.writeSessions(remaining);
  ok(`Removed session for ${appName}`);

  if (quit) {
    try {
      execFileSync('osascript', ['-e', `tell application "${appName.replace(/"/g, '\\"')}" to quit`], { timeout: 5000 });
      ok(`Quit ${appName}`);
    } catch (e) {
      fail(`Could not quit ${appName}: ${e.message}`);
    }
  }
  return { stopped: appName };
}

function help() {
  process.stdout.write(`
${C.cyan}agentdom sessions${C.r} [list | clear | stop <App> [--quit]]

  list                  Show all active CDP sessions (default).
  clear                 Forget every session. App processes are unaffected.
  stop <App>            Remove one app's session record.
  stop <App> --quit     Same, plus quit the app.

Sessions live in ${launch.SESSIONS_FILE}.
`);
}

function run(argv = []) {
  const verb = (argv[0] || 'list').toLowerCase();
  if (verb === '-h' || verb === '--help' || verb === 'help') { help(); return; }
  if (verb === 'list') { list(); return; }
  if (verb === 'clear') { clear(); return; }
  if (verb === 'stop') {
    const rest = argv.slice(1).filter(a => !a.startsWith('--'));
    const flags = argv.slice(1).filter(a => a.startsWith('--'));
    stop(rest.join(' ').trim(), { quit: flags.includes('--quit') });
    return;
  }
  fail(`Unknown sessions verb: ${verb}`);
  help();
  process.exit(1);
}

module.exports = { run, list, clear, stop };
