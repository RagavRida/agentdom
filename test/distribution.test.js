/**
 * AgentDOM — Distribution Tests (Phase 7)
 *
 * Covers the ship-readiness surface introduced in Phase 7:
 *   • GitHub Actions workflows are valid YAML and exercise the Phase 7 test list
 *   • install.sh / install.ps1 exist with correct shebangs and Node-version check
 *   • .npmignore excludes dev/CI/website/test directories
 *   • `agentdom mcp-config` emits valid JSON/snippets for every known target
 *   • package.json has prepublishOnly, postinstall, engines.node >= 18
 *   • bin/agentdom.js shebang is present
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PHASE7_TEST_FILES = [
  'test/core.test.js',
  'test/wallet-auth.test.js',
  'test/transport-perf.test.js',
  'test/platform-bridge.test.js',
  'test/runtime-gaps.test.js',
  'test/cli-packaging.test.js',
  'test/distribution.test.js',
];

// ──────────────────────────────────────────────────────────────────────
//  GitHub Actions workflows
// ──────────────────────────────────────────────────────────────────────

describe('.github/workflows/ci.yml', () => {
  const ciPath = path.join(ROOT, '.github/workflows/ci.yml');
  let raw;

  it('exists', () => {
    assert.ok(fs.existsSync(ciPath), 'ci.yml must exist');
    raw = fs.readFileSync(ciPath, 'utf-8');
    assert.ok(raw.length > 0);
  });

  it('declares the Phase 7 Node matrix (18, 20, 22)', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    for (const v of ['18', '20', '22']) {
      assert.ok(
        raw.includes(`'${v}'`) || raw.includes(`"${v}"`) || new RegExp(`\\b${v}\\b`).test(raw),
        `expected Node ${v} in CI matrix`,
      );
    }
  });

  it('runs on both ubuntu-latest and macos-latest', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    assert.ok(raw.includes('ubuntu-latest'), 'expected ubuntu-latest runner');
    assert.ok(raw.includes('macos-latest'),  'expected macos-latest runner');
  });

  it('runs the Phase 7 test files explicitly', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    for (const f of PHASE7_TEST_FILES) {
      assert.ok(raw.includes(f), `CI should run ${f}`);
    }
  });

  it('triggers on push to main and pull_request to main', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    assert.ok(/push:\s*[\s\S]*?branches:\s*\[main\]/.test(raw), 'expected push trigger on main');
    assert.ok(/pull_request:\s*[\s\S]*?branches:\s*\[main\]/.test(raw), 'expected pull_request trigger on main');
  });

  it('uploads test results as an artifact', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    assert.ok(/upload-artifact/.test(raw), 'expected upload-artifact step');
  });

  it('verifies bin/agentdom.js is executable via --help', () => {
    raw = raw || fs.readFileSync(ciPath, 'utf-8');
    assert.ok(/bin\/agentdom\.js --help/.test(raw), 'expected CLI --help verification step');
  });
});

describe('.github/workflows/publish.yml', () => {
  const publishPath = path.join(ROOT, '.github/workflows/publish.yml');

  it('exists', () => {
    assert.ok(fs.existsSync(publishPath), 'publish.yml must exist');
  });

  it('triggers on v* tags and runs publish + release steps', () => {
    const raw = fs.readFileSync(publishPath, 'utf-8');
    assert.ok(/tags:\s*[\s\S]*?'v\*'/.test(raw), "expected 'v*' tag trigger");
    assert.ok(/npm publish/.test(raw), 'expected npm publish step');
    assert.ok(/action-gh-release|generate_release_notes|gh release create/.test(raw), 'expected GitHub Release step');
    assert.ok(/NPM_TOKEN/.test(raw), 'expected NPM_TOKEN secret reference');
  });
});

// ──────────────────────────────────────────────────────────────────────
//  Installers
// ──────────────────────────────────────────────────────────────────────

describe('website/public/install.sh', () => {
  const shPath = path.join(ROOT, 'website/public/install.sh');

  it('exists', () => {
    assert.ok(fs.existsSync(shPath), 'install.sh must exist');
  });

  it('begins with the bash shebang', () => {
    const head = fs.readFileSync(shPath, 'utf-8').split('\n', 1)[0];
    assert.equal(head, '#!/bin/bash');
  });

  it('checks for Node.js and Node 18+', () => {
    const raw = fs.readFileSync(shPath, 'utf-8');
    assert.ok(/command -v node/.test(raw), 'expected node presence check');
    assert.ok(/-lt 18/.test(raw),           'expected Node 18+ version check');
  });

  it('installs agentdom@latest globally and runs doctor', () => {
    const raw = fs.readFileSync(shPath, 'utf-8');
    assert.ok(/npm install -g agentdom/.test(raw), 'expected npm install -g agentdom');
    assert.ok(/agentdom doctor/.test(raw),         'expected post-install doctor run');
  });
});

describe('website/public/install.ps1', () => {
  const ps1Path = path.join(ROOT, 'website/public/install.ps1');

  it('exists and references Node 18 + agentdom install', () => {
    assert.ok(fs.existsSync(ps1Path), 'install.ps1 must exist');
    const raw = fs.readFileSync(ps1Path, 'utf-8');
    assert.ok(/node -v/.test(raw),                 'expected node version probe');
    assert.ok(/-lt 18/.test(raw),                  'expected Node 18+ check');
    assert.ok(/npm install -g agentdom/.test(raw), 'expected global install');
    assert.ok(/agentdom doctor/.test(raw),         'expected doctor invocation');
  });
});

// ──────────────────────────────────────────────────────────────────────
//  .npmignore
// ──────────────────────────────────────────────────────────────────────

describe('.npmignore', () => {
  const ignorePath = path.join(ROOT, '.npmignore');
  const raw = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf-8') : '';

  it('excludes dev/CI/website/test directories', () => {
    for (const entry of ['test/', '.github/', 'aws/', 'website/']) {
      assert.ok(
        raw.split('\n').some(line => line.trim() === entry),
        `expected ${entry} in .npmignore`,
      );
    }
  });

  it('keeps README/LICENSE/CHANGELOG via negation', () => {
    assert.ok(/!README\.md/.test(raw),    'expected !README.md');
    assert.ok(/!LICENSE/.test(raw),       'expected !LICENSE');
    assert.ok(/!CHANGELOG\.md/.test(raw), 'expected !CHANGELOG.md');
  });
});

// ──────────────────────────────────────────────────────────────────────
//  mcp-config command
// ──────────────────────────────────────────────────────────────────────

describe('commands/mcp-config.js', () => {
  const mod = require(path.join(ROOT, 'commands/mcp-config.js'));

  it('exposes generate, run, and a target list', () => {
    assert.equal(typeof mod.generate, 'function');
    assert.equal(typeof mod.run,      'function');
    assert.ok(Array.isArray(mod.TARGETS));
    for (const t of ['claude-desktop', 'claude-code', 'cursor', 'vscode']) {
      assert.ok(mod.TARGETS.includes(t), `missing target ${t}`);
    }
  });

  it('emits valid JSON for claude-desktop with the agentdom MCP server', () => {
    const out = mod.generate('claude-desktop');
    const parsed = JSON.parse(out);
    assert.ok(parsed.mcpServers && parsed.mcpServers.agentdom, 'expected mcpServers.agentdom');
    assert.equal(parsed.mcpServers.agentdom.command, 'agentdom');
    assert.deepEqual(parsed.mcpServers.agentdom.args, ['serve']);
  });

  it('emits the claude mcp add command for claude-code', () => {
    const out = mod.generate('claude-code');
    assert.ok(/claude mcp add agentdom/.test(out));
    assert.ok(/agentdom serve/.test(out));
  });

  it('emits valid JSON for cursor and vscode', () => {
    const cursor = JSON.parse(mod.generate('cursor'));
    assert.ok(cursor.mcpServers && cursor.mcpServers.agentdom);
    const vscode = JSON.parse(mod.generate('vscode'));
    assert.ok(vscode.mcp && vscode.mcp.servers && vscode.mcp.servers.agentdom);
  });

  it('rejects unknown targets and lists available ones', () => {
    assert.throws(() => mod.generate('emacs'), /Unknown target/);

    // Capture stderr for run()
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
      const code = mod.run('emacs');
      assert.equal(code, 1);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(/Available targets/.test(captured));
    for (const t of ['claude-desktop', 'claude-code', 'cursor', 'vscode']) {
      assert.ok(captured.includes(t), `expected ${t} in target list`);
    }
  });

  it('is registered as a subcommand on the CLI', () => {
    const { Command } = require('commander');
    const { registerCommands } = require(path.join(ROOT, 'bin/agentdom.js'));
    const program = new Command();
    registerCommands(program);
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('mcp-config'), `mcp-config not registered (got ${names.join(', ')})`);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  package.json
// ──────────────────────────────────────────────────────────────────────

describe('package.json', () => {
  const pkg = require(path.join(ROOT, 'package.json'));

  it('has a prepublishOnly script that runs the Phase 7 test list', () => {
    assert.equal(typeof pkg.scripts.prepublishOnly, 'string');
    for (const f of PHASE7_TEST_FILES) {
      assert.ok(pkg.scripts.prepublishOnly.includes(f), `prepublishOnly missing ${f}`);
    }
    assert.ok(/validate-manifest\.js --all/.test(pkg.scripts.prepublishOnly), 'expected manifest validation in prepublishOnly');
  });

  it('has a postinstall hook that warms keytar', () => {
    assert.equal(typeof pkg.scripts.postinstall, 'string');
    assert.ok(/require\('\.\/lib\/keychain'\)/.test(pkg.scripts.postinstall));
  });

  it('declares engines.node >= 18', () => {
    assert.ok(pkg.engines && pkg.engines.node, 'expected engines.node');
    // Accept any range that requires ≥ 18
    assert.ok(/(>=\s*18)/.test(pkg.engines.node), `engines.node should be >= 18 (got ${pkg.engines.node})`);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  bin/agentdom.js
// ──────────────────────────────────────────────────────────────────────

describe('bin/agentdom.js shebang', () => {
  it('starts with #!/usr/bin/env node', () => {
    const head = fs.readFileSync(path.join(ROOT, 'bin/agentdom.js'), 'utf-8').split('\n', 1)[0];
    assert.equal(head, '#!/usr/bin/env node');
  });
});
