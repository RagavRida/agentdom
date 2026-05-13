/**
 * AgentDOM — Phase 5 Platform Bridge Tests
 *
 * Validates:
 *   • platform.getBridge() returns the correct module per process.platform
 *   • Every platform bridge exposes the unified Phase 5 surface
 *   • JSON stdin/stdout protocol round-trip with the Python helpers
 *   • Helpful failure when python3 is missing (ENOENT path)
 *
 * No real Python is invoked — tests inject a `spawnSync` mock via the
 * bridge's `_setRunner` test seam.
 */

'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

// ── helper for swapping process.platform ──────────────────────────────────

function withPlatform(name, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try { return fn(); }
  finally { Object.defineProperty(process, 'platform', desc); }
}

// ══════════════════════════════════════════════════════════════════════════
//  Platform dispatcher
// ══════════════════════════════════════════════════════════════════════════

describe('platform dispatcher', () => {
  let plat;
  before(() => { plat = require('../desktop-agent/platform'); });
  beforeEach(() => plat._reset());

  it('returns the macOS bridge on darwin', () => {
    withPlatform('darwin', () => {
      const b = plat.getBridge();
      assert.ok(b, 'bridge should exist');
      // macOS bridge exposes `platform: 'darwin'` (or undefined — index.js sets PLATFORM)
      assert.equal(typeof b.scanApp, 'function');
      assert.equal(typeof b.clickElement, 'function');
    });
  });

  it('returns the Linux AT-SPI bridge on linux', () => {
    withPlatform('linux', () => {
      const b = plat.getBridge();
      assert.equal(b.platform, 'linux');
      assert.equal(typeof b.runHelper, 'function');
    });
  });

  it('returns the Windows UIA bridge on win32', () => {
    withPlatform('win32', () => {
      const b = plat.getBridge();
      assert.equal(b.platform, 'win32');
      assert.equal(typeof b.runHelper, 'function');
    });
  });

  it('returns a stub on unsupported platforms', () => {
    withPlatform('freebsd', () => {
      const b = plat.getBridge();
      assert.equal(b.isSupported, false);
      const r = b.clickElement('whatever', 'btn');
      assert.equal(r.clicked, false);
      assert.match(r.error, /not supported/);
    });
  });

  it('caches the bridge between calls within the same platform', () => {
    withPlatform('linux', () => {
      const a = plat.getBridge();
      const b = plat.getBridge();
      assert.strictEqual(a, b, 'should return the same singleton');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Unified interface parity
// ══════════════════════════════════════════════════════════════════════════

describe('unified interface parity', () => {
  // The methods every bridge MUST expose so the dispatch router stays
  // platform-agnostic. Drawn from desktop-mcp-server.js usage + the Phase 5
  // spec.
  const REQUIRED = [
    'listWindows', 'getAccessibilityTree',
    'clickElement', 'typeIntoField',
    'pressKey',     'readElement',
    'clickInWindow','getWindowFrame',
    // Parity with index.js so existing MCP tools work unchanged
    'isRunning', 'checkPermissions', 'listApps', 'scanApp',
    'pressKeys', 'clickMenu', 'typeText',
  ];

  for (const name of ['linux', 'win32']) {
    it(`${name} bridge exposes every required method`, () => {
      const mod = name === 'linux'
        ? require('../desktop-agent/linux-atspi')
        : require('../desktop-agent/win-uia');
      for (const m of REQUIRED) {
        assert.equal(typeof mod[m], 'function', `${name}.${m} should be a function`);
      }
    });
  }

  it('macOS bridge keeps its existing methods exported (no regression)', () => {
    const mac = require('../desktop-agent/index');
    for (const m of ['scanApp', 'clickElement', 'typeIntoField', 'pressKeys', 'clickMenu', 'isRunning']) {
      assert.equal(typeof mac[m], 'function', `mac.${m} should be a function`);
    }
  });

  it('stub bridge exposes every required method too', () => {
    const stub = require('../desktop-agent/platform')._makeStub('beos');
    for (const m of [
      'listWindows','getAccessibilityTree','clickElement','typeIntoField',
      'pressKey','readElement','clickInWindow','getWindowFrame',
    ]) {
      assert.equal(typeof stub[m], 'function', `stub.${m} missing`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  JSON protocol — stdin/stdout round-trip
// ══════════════════════════════════════════════════════════════════════════

describe('helper JSON protocol', () => {
  let linux;
  before(() => { linux = require('../desktop-agent/linux-atspi'); });
  afterEach(() => linux._resetRunner());

  function fakeSpawn({ status = 0, stdout = '', stderr = '', code } = {}) {
    const fn = (_python, _argv, opts) => {
      fn.lastInput = opts && opts.input;
      const ret = { status, stdout, stderr, pid: 1234 };
      if (code) ret.error = Object.assign(new Error('spawn failed'), { code });
      return ret;
    };
    return fn;
  }

  it('encodes {cmd,args} as JSON on stdin', () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ ok: true, data: [] }) });
    linux._setRunner({ spawnSync: spawn });
    linux.runHelper('list_windows', { foo: 'bar' });
    const parsed = JSON.parse(spawn.lastInput);
    assert.deepEqual(parsed, { cmd: 'list_windows', args: { foo: 'bar' } });
  });

  it('decodes envelope from helper stdout', () => {
    linux._setRunner({
      spawnSync: fakeSpawn({ stdout: JSON.stringify({ ok: true, data: { hello: 'world' } }) }),
    });
    const env = linux.runHelper('get_tree', { app: 'gedit' });
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { hello: 'world' });
  });

  it('flattens get_tree output into a list (scanApp surface)', () => {
    linux._setRunner({
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({ ok: true, data: {
          role: 'application', name: 'gedit', children: [
            { role: 'window', name: 'untitled', children: [
              { role: 'push button', name: 'Save' },
              { role: 'push button', name: 'Cancel' },
            ]},
          ],
        }}),
      }),
    });
    const arr = linux.scanApp('gedit');
    assert.ok(Array.isArray(arr));
    const labels = arr.map(e => e.label);
    assert.ok(labels.includes('gedit'));
    assert.ok(labels.includes('Save'));
    assert.ok(labels.includes('Cancel'));
  });

  it('parses label disambiguation suffix in clickElement', () => {
    let receivedArgs = null;
    linux._setRunner({
      spawnSync: (_p, _a, opts) => {
        const msg = JSON.parse(opts.input);
        receivedArgs = msg.args;
        return { status: 0, stdout: JSON.stringify({ ok: true, data: { clicked: true, matched: 2, index: 2 } }) };
      },
    });
    const r = linux.clickElement('myapp', 'OK (2)');
    assert.equal(r.clicked, true);
    assert.equal(receivedArgs.label, 'OK');
    assert.equal(receivedArgs.index, 2);
  });

  it('surfaces helper failure envelopes through clickElement', () => {
    linux._setRunner({
      spawnSync: fakeSpawn({ stdout: JSON.stringify({
        ok: false, error: 'no element with label "Save"', matched: 0,
      })}),
    });
    const r = linux.clickElement('myapp', 'Save');
    assert.equal(r.clicked, false);
    assert.match(r.error, /no element/);
    assert.equal(r.matched, 0);
  });

  it('handles malformed JSON from the helper gracefully', () => {
    linux._setRunner({
      spawnSync: fakeSpawn({ stdout: 'not actually json' }),
    });
    const env = linux.runHelper('list_windows');
    assert.equal(env.ok, false);
    assert.match(env.error, /bad helper JSON/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Python-missing fallback
// ══════════════════════════════════════════════════════════════════════════

describe('Python-missing fallback', () => {
  let linux, win;
  before(() => {
    linux = require('../desktop-agent/linux-atspi');
    win   = require('../desktop-agent/win-uia');
  });
  afterEach(() => { linux._resetRunner(); win._resetRunner(); });

  function spawnEnoent() {
    return () => ({ error: Object.assign(new Error('python3 not found'), { code: 'ENOENT' }) });
  }

  it('linux bridge returns actionable error when python3 is missing', () => {
    linux._setRunner({ spawnSync: spawnEnoent() });
    const env = linux.runHelper('list_windows');
    assert.equal(env.ok, false);
    assert.match(env.error, /python3 not found/);
    assert.match(env.hint, /python3-atspi|pygobject/);
  });

  it('windows bridge returns actionable error when python3 is missing', () => {
    win._setRunner({ spawnSync: spawnEnoent() });
    const env = win.runHelper('list_windows');
    assert.equal(env.ok, false);
    assert.match(env.error, /python3 not found/);
    assert.match(env.hint, /Python 3/);
  });

  it('linux bridge surfaces helper exit code 2 as missing-deps error', () => {
    linux._setRunner({
      spawnSync: () => ({ status: 2, stdout: '', stderr: 'no atspi' }),
    });
    const env = linux.runHelper('list_windows');
    assert.equal(env.ok, false);
    assert.match(env.error, /unavailable/);
  });

  it('isRunning returns false (not throws) when the helper fails', () => {
    linux._setRunner({ spawnSync: spawnEnoent() });
    const r = linux.isRunning('gedit');
    assert.equal(r, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Python helpers — surface checks (no execution)
// ══════════════════════════════════════════════════════════════════════════

describe('Python helper files', () => {
  const fs = require('fs');

  it('atspi-bridge.py exists with correct shebang and verb list', () => {
    const p = path.join(__dirname, '..', 'desktop-agent', 'helpers', 'atspi-bridge.py');
    const src = fs.readFileSync(p, 'utf-8');
    assert.match(src, /^#!\/usr\/bin\/env python3/);
    for (const verb of ['list_windows', 'get_tree', 'click', 'type', 'press_key', 'read']) {
      assert.ok(src.includes(`"${verb}"`), `verb ${verb} should be declared`);
    }
    assert.ok(src.includes('gi.repository') || src.includes('Atspi'), 'should reference Atspi');
  });

  it('uia-bridge.py exists with correct shebang and verb list', () => {
    const p = path.join(__dirname, '..', 'desktop-agent', 'helpers', 'uia-bridge.py');
    const src = fs.readFileSync(p, 'utf-8');
    assert.match(src, /^#!\/usr\/bin\/env python3/);
    for (const verb of ['list_windows', 'get_tree', 'click', 'type', 'press_key', 'read']) {
      assert.ok(src.includes(`"${verb}"`), `verb ${verb} should be declared`);
    }
    assert.ok(src.includes('uiautomation'), 'should reference uiautomation');
  });
});

console.log('\n🧪 AgentDOM Phase 5 — Platform Bridge Tests\n');
