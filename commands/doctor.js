/**
 * AgentDOM — `agentdom doctor`
 *
 * One-screen health check. Each probe returns `{ name, ok, detail }`.
 * Output is a tidy table by default, or JSON with `--json`. Exit code
 * is 0 when every CRITICAL probe passes, 1 otherwise — non-critical
 * probes (python3 on macOS, optional manifests count) report status
 * but never fail the run.
 */

'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');

const C = {
  ok:   '\x1b[32m✅\x1b[0m',
  warn: '\x1b[33m⚠\x1b[0m',
  bad:  '\x1b[31m❌\x1b[0m',
  bold: '\x1b[1m',
  dim:  '\x1b[90m',
  r:    '\x1b[0m',
};

// ── Probes ─────────────────────────────────────────────────────────────────

function checkNode() {
  const v = process.version.replace(/^v/, '');
  const major = parseInt(v.split('.')[0], 10);
  return {
    name:     'Node.js',
    ok:       major >= 18,
    critical: true,
    detail:   `${process.version}${major >= 18 ? '' : ' (need ≥ 18)'}`,
  };
}

function checkPython() {
  try {
    const res = spawnSync('python3', ['--version'], { encoding: 'utf-8', timeout: 3000 });
    const out = (res.stdout || res.stderr || '').trim();
    return {
      name:     'python3',
      ok:       res.status === 0,
      critical: false, // only required for Linux/Windows bridges
      detail:   out || 'not found',
    };
  } catch (e) {
    return { name: 'python3', ok: false, critical: false, detail: e.message };
  }
}

function checkKeytar() {
  try {
    const k = require('keytar');
    return {
      name:     'keytar (OS keychain)',
      ok:       !!k && typeof k.setPassword === 'function',
      critical: false, // encrypted file fallback exists
      detail:   'loadable',
    };
  } catch (e) {
    return { name: 'keytar (OS keychain)', ok: false, critical: false,
             detail: 'unavailable — falling back to encrypted file' };
  }
}

function checkAgentdomDir() {
  const exists = fs.existsSync(AGENTDOM_DIR);
  let stat = null;
  if (exists) {
    try { stat = fs.statSync(AGENTDOM_DIR); } catch (_) {}
  }
  return {
    name:     '~/.agentdom directory',
    ok:       exists,
    critical: false,
    detail:   exists ? `${AGENTDOM_DIR}${stat?.mode != null ? ` (mode ${(stat.mode & 0o777).toString(8)})` : ''}` : 'missing (will be created on first auth)',
  };
}

async function checkProviders() {
  try {
    const auth = require(path.join(ROOT, 'commands/auth.js'));
    const list = await auth.tokens();
    return {
      name:     'Authenticated providers',
      ok:       true,
      critical: false,
      detail:   `${list.length} provider(s)${list.length ? ' — ' + list.slice(0, 4).map(t => t.provider).join(', ') + (list.length > 4 ? ', …' : '') : ''}`,
    };
  } catch (e) {
    return { name: 'Authenticated providers', ok: false, critical: false, detail: e.message };
  }
}

function checkManifests() {
  const dir = path.join(ROOT, 'manifests');
  if (!fs.existsSync(dir)) {
    return { name: 'Bundled manifests', ok: false, critical: false, detail: 'manifests/ missing' };
  }
  const json = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return {
    name:     'Bundled manifests',
    ok:       json.length > 0,
    critical: false,
    detail:   `${json.length} manifest(s)`,
  };
}

function checkBin() {
  const bin = path.join(ROOT, 'bin', 'agentdom.js');
  const ok  = fs.existsSync(bin);
  return {
    name:     'CLI entry (bin/agentdom.js)',
    ok,
    critical: true,
    detail:   ok ? bin : 'not found — npm install -g agentdom may not register the binary',
  };
}

/**
 * Run every probe and either print a table or return JSON.
 * @param {{json?:boolean}} [opts]
 * @returns {Promise<number>} exit code (0 when all critical probes pass)
 */
async function runDoctor(opts = {}) {
  const probes = [
    checkNode(),
    checkBin(),
    checkPython(),
    checkKeytar(),
    checkAgentdomDir(),
    checkManifests(),
    await checkProviders(),
  ];

  if (opts.json) {
    process.stdout.write(JSON.stringify({ probes }, null, 2) + '\n');
  } else {
    process.stdout.write(`\n${C.bold}agentdom doctor${C.r}\n\n`);
    for (const p of probes) {
      const icon = p.ok ? C.ok : (p.critical ? C.bad : C.warn);
      const name = p.name.padEnd(34);
      process.stdout.write(`  ${icon}  ${name} ${C.dim}${p.detail}${C.r}\n`);
    }
    const criticalFailed = probes.filter(p => !p.ok && p.critical).length;
    process.stdout.write(`\n${criticalFailed ? `${C.bad} ${criticalFailed} critical issue(s)` : `${C.ok} all critical checks pass`}\n\n`);
  }

  return probes.some(p => !p.ok && p.critical) ? 1 : 0;
}

module.exports = {
  runDoctor,
  // Exported so tests can assert individual probes without a full run.
  _probes: {
    checkNode,
    checkPython,
    checkKeytar,
    checkAgentdomDir,
    checkProviders,
    checkManifests,
    checkBin,
  },
};
