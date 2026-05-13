/**
 * AgentDOM — CLI & Packaging Tests (Phase 6)
 *
 * Verifies the developer-facing surface introduced in Phase 6:
 *   • bin/agentdom.js exists, is executable, has the correct shebang
 *   • All subcommands are registered on the commander program
 *   • Root index.js exports every documented module (lazy)
 *   • package.json has the right name, version, bin, main, engines, files
 *   • commands/doctor.js probes return the expected shape
 *
 * No real Python is invoked, no real network is touched.
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs    = require('fs');
const path  = require('path');

const ROOT = path.resolve(__dirname, '..');

// ══════════════════════════════════════════════════════════════════════════
//  bin/agentdom.js
// ══════════════════════════════════════════════════════════════════════════

describe('bin/agentdom.js', () => {
  const binPath = path.join(ROOT, 'bin', 'agentdom.js');

  it('exists at bin/agentdom.js', () => {
    assert.ok(fs.existsSync(binPath), 'bin/agentdom.js must exist');
  });

  it('starts with the node shebang', () => {
    const head = fs.readFileSync(binPath, 'utf-8').split('\n', 1)[0];
    assert.equal(head, '#!/usr/bin/env node');
  });

  it('is marked executable (owner)', () => {
    const mode = fs.statSync(binPath).mode & 0o777;
    assert.ok((mode & 0o100) !== 0, `expected owner exec bit, got mode ${mode.toString(8)}`);
  });

  it('exports registerCommands + main', () => {
    const mod = require(binPath);
    assert.equal(typeof mod.registerCommands, 'function');
    assert.equal(typeof mod.main, 'function');
  });

  it('registers every required subcommand', () => {
    const { Command } = require('commander');
    const { registerCommands } = require(binPath);
    const program = new Command();
    registerCommands(program);
    const names = program.commands.map(c => c.name());
    for (const expected of [
      'auth', 'token', 'tokens', 'revoke', 'discover',
      'scan', 'generate', 'validate', 'status', 'doctor', 'serve',
    ]) {
      assert.ok(names.includes(expected), `subcommand "${expected}" should be registered (got ${names.join(', ')})`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Root index.js library exports
// ══════════════════════════════════════════════════════════════════════════

describe('index.js library exports', () => {
  let api;
  before(() => { api = require(path.join(ROOT, 'index.js')); });

  it('exposes every documented top-level key (lazy)', () => {
    const required = [
      'auth', 'keychain', 'registry',
      'runtime', 'planner', 'policy', 'memory',
      'resilience', 'connectionPool', 'tokenCache',
      'compiler', 'discover', 'platform',
    ];
    for (const k of required) {
      const v = api[k];
      assert.ok(v, `index.js should expose .${k}`);
    }
  });

  it('auth.token is a function (lazy module loaded on access)', () => {
    assert.equal(typeof api.auth.token, 'function');
  });

  it('platform.getBridge returns the same bridge as direct require', () => {
    const direct = require(path.join(ROOT, 'desktop-agent/platform'));
    assert.strictEqual(api.platform, direct);
  });

  it('exposes a VERSION string matching package.json', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    assert.equal(api.VERSION, pkg.version);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  package.json
// ══════════════════════════════════════════════════════════════════════════

describe('package.json', () => {
  const pkg = require(path.join(ROOT, 'package.json'));

  it('has name "agentdom"', () => {
    assert.equal(pkg.name, 'agentdom');
  });

  it('bin maps "agentdom" to ./bin/agentdom.js', () => {
    assert.equal(pkg.bin.agentdom, './bin/agentdom.js');
  });

  it('main points to ./index.js', () => {
    assert.equal(pkg.main, './index.js');
  });

  it('engines.node requires Node 18+', () => {
    assert.ok(/^[>=]+\s*18/.test(String(pkg.engines?.node || '')),
      `expected engines.node to require ≥18, got "${pkg.engines?.node}"`);
  });

  it('files list includes bin/, lib/, commands/, manifests/, index.js', () => {
    for (const f of ['bin/', 'lib/', 'commands/', 'manifests/', 'index.js']) {
      assert.ok(pkg.files.includes(f), `files should include "${f}"`);
    }
  });

  it('declares commander as a runtime dependency', () => {
    assert.ok(pkg.dependencies && pkg.dependencies.commander,
      'commander must be a dependency for the CLI to run when installed');
  });

  it('keywords include agentdom and mcp', () => {
    assert.ok((pkg.keywords || []).includes('agentdom'));
    assert.ok((pkg.keywords || []).includes('mcp'));
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  commands/doctor.js
// ══════════════════════════════════════════════════════════════════════════

describe('commands/doctor', () => {
  let doctor;
  before(() => { doctor = require(path.join(ROOT, 'commands/doctor.js')); });

  it('exports runDoctor + individual probes', () => {
    assert.equal(typeof doctor.runDoctor, 'function');
    assert.equal(typeof doctor._probes,   'object');
    for (const k of ['checkNode', 'checkPython', 'checkKeytar', 'checkAgentdomDir', 'checkManifests', 'checkBin']) {
      assert.equal(typeof doctor._probes[k], 'function', `_probes.${k} should be a function`);
    }
  });

  it('checkNode passes on Node ≥ 18 (this test runner)', () => {
    const r = doctor._probes.checkNode();
    assert.equal(r.name, 'Node.js');
    assert.equal(r.critical, true);
    assert.equal(r.ok, true, `expected ok=true on Node ${process.version}`);
  });

  it('checkBin reports the CLI as present after Phase 6', () => {
    const r = doctor._probes.checkBin();
    assert.equal(r.ok, true);
    assert.match(r.detail, /agentdom\.js$/);
  });

  it('checkManifests counts the bundled JSON manifests', () => {
    const r = doctor._probes.checkManifests();
    assert.equal(r.ok, true);
    assert.match(r.detail, /\d+ manifest/);
  });

  it('runDoctor --json returns exit code 0 when critical probes pass', async () => {
    // Intercepting process.stdout.write clashes with node:test's own TAP
    // output, so redirect the doctor's writes to /dev/null via a temp fd.
    const fd = fs.openSync(require('os').devNull, 'w');
    const origFd1 = process.stdout.fd;
    // Easier: just swap process.stdout temporarily.
    const fakeStream = fs.createWriteStream(require('os').devNull);
    const origStdout = process.stdout;
    Object.defineProperty(process, 'stdout', { value: fakeStream, configurable: true });
    let code;
    try { code = await doctor.runDoctor({ json: true }); }
    finally {
      Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true });
      fs.closeSync(fd);
      try { fakeStream.end(); } catch (_) {}
      void origFd1;
    }
    assert.equal(code, 0);
  });
});

console.log('\n🧪 AgentDOM — Phase 6 CLI & Packaging Tests\n');
