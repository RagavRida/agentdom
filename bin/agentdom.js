#!/usr/bin/env node
/**
 * AgentDOM — Unified CLI (Phase 6)
 *
 * One entry point for every command. Each subcommand delegates to an
 * existing module so this file stays a thin router. Subcommands are
 * registered in {@link registerCommands} so tests can introspect the
 * full surface without spawning a child process.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { Command } = require('commander');

// Resolve the package root once. The CLI is always at `<root>/bin/agentdom.js`.
const ROOT = path.resolve(__dirname, '..');

function pkgVersion() {
  try { return require(path.join(ROOT, 'package.json')).version; }
  catch { return '0.0.0'; }
}

/**
 * Register every subcommand on the supplied commander program. Returns
 * the same program so callers can `.parse()` it.
 *
 * Exported separately from `main()` so tests can assert the command
 * surface without invoking the CLI.
 *
 * @param {Command} program
 * @returns {Command}
 */
function registerCommands(program) {
  program
    .name('agentdom')
    .description('Universal agent-to-software runtime.')
    .version(pkgVersion(), '-v, --version', 'print the agentdom version');

  // ── auth ───────────────────────────────────────────────────────────────
  program
    .command('auth <provider>')
    .description('Run OAuth/API-key setup for a provider')
    .option('--key <key>',            'API key (skips browser flow)')
    .option('--client-id <id>',       'OAuth client id override')
    .option('--client-secret <secret>','OAuth client secret override')
    .option('-f, --force',            'Force re-auth even if a valid token exists')
    .action(async (provider, opts) => {
      const auth = require(path.join(ROOT, 'commands/auth.js'));
      const argv = [provider];
      if (opts.key)          argv.push('--key',           opts.key);
      if (opts.clientId)     argv.push('--client-id',     opts.clientId);
      if (opts.clientSecret) argv.push('--client-secret', opts.clientSecret);
      if (opts.force)        argv.push('--force');
      await auth.run(argv);
    });

  // ── token ──────────────────────────────────────────────────────────────
  program
    .command('token <provider>')
    .description('Print the active token for a provider (no secrets logged elsewhere)')
    .action(async (provider) => {
      const auth = require(path.join(ROOT, 'commands/auth.js'));
      const t = await auth.token(provider);
      process.stdout.write(JSON.stringify(t, null, 2) + '\n');
    });

  // ── tokens ─────────────────────────────────────────────────────────────
  program
    .command('tokens')
    .description('List all authenticated providers (sanitized — no secrets)')
    .action(async () => {
      const auth = require(path.join(ROOT, 'commands/auth.js'));
      await auth.run(['list']);
    });

  // ── revoke ─────────────────────────────────────────────────────────────
  program
    .command('revoke <provider>')
    .description("Remove a provider's stored credentials")
    .action(async (provider) => {
      const auth = require(path.join(ROOT, 'commands/auth.js'));
      await auth.run(['revoke', provider]);
    });

  // ── discover ───────────────────────────────────────────────────────────
  program
    .command('discover <host>')
    .description("Fetch and display a host's .well-known/agentdom.json")
    .option('--no-cache', 'Skip the in-process 5-minute cache')
    .action(async (host, opts) => {
      const auth = require(path.join(ROOT, 'commands/auth.js'));
      const result = await auth.discover(host, { noCache: opts.cache === false });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });

  // ── scan ───────────────────────────────────────────────────────────────
  program
    .command('scan <url>')
    .description('Scan a URL and emit the structured intent representation')
    .action(async (url) => {
      // agentdom.js exposes a `scan(url)` runtime; fall back to the
      // compiler if not available so the command is always reachable.
      try {
        const ag = require(path.join(ROOT, 'agentdom.js'));
        if (typeof ag.scan === 'function') {
          const r = await ag.scan(url);
          process.stdout.write(JSON.stringify(r, null, 2) + '\n');
          return;
        }
      } catch (_) { /* fall through */ }
      console.error('scan requires the agentdom runtime (agentdom.js scan API).');
      process.exitCode = 1;
    });

  // ── generate ───────────────────────────────────────────────────────────
  program
    .command('generate')
    .description('Generate a manifest from an OpenAPI spec URL or file')
    .requiredOption('--openapi <urlOrPath>', 'OpenAPI spec URL or local path')
    .requiredOption('--host <host>',         'Target provider host (e.g. example.com)')
    .option('--out <path>',                  'Write manifest to this path')
    .action(async (opts) => {
      const gen = require(path.join(ROOT, 'tools/gen-manifest.js'));
      const fn  = gen.run || gen.main || gen.generate || gen.default;
      if (typeof fn !== 'function') {
        console.error('tools/gen-manifest.js does not expose a callable entry point.');
        process.exitCode = 1; return;
      }
      await fn({ openapi: opts.openapi, host: opts.host, out: opts.out });
    });

  // ── validate ───────────────────────────────────────────────────────────
  program
    .command('validate [pathOrFile]')
    .description('Validate a manifest file or directory (--all for the bundled set)')
    .option('--all',    'Validate every bundled polyfill manifest')
    .option('--strict', 'Treat warnings as errors')
    .option('--json',   'Emit results as JSON')
    .action(async (target, opts) => {
      const v = require(path.join(ROOT, 'tools/validate-manifest.js'));
      let input;
      if (opts.all) input = path.join(ROOT, 'manifests');
      else if (target) input = target;
      else { console.error('Provide a file/dir or pass --all.'); process.exitCode = 1; return; }
      if (!fs.existsSync(input)) { console.error(`Not found: ${input}`); process.exitCode = 1; return; }
      const results = fs.statSync(input).isDirectory()
        ? v.validateDir(input)
        : [v.validateFile(input)];
      if (opts.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      } else {
        const invalid = results.filter(r => !r.valid).length;
        const warns   = results.reduce((n, r) => n + r.warnings.length, 0);
        process.stdout.write(`${results.length} manifest(s) — ${results.length - invalid} valid, ${invalid} invalid, ${warns} warnings\n`);
        for (const r of results) {
          const icon = r.valid ? '✓' : '✗';
          process.stdout.write(`  ${icon} ${r.stats?.host || ''} (${r.stats?.capabilities || 0} intents)\n`);
        }
      }
      if (results.some(r => !r.valid)) process.exitCode = 1;
      if (opts.strict && warns) process.exitCode = 1;
    });

  // ── status ─────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show wallet + token-lifecycle status')
    .action(async () => {
      const keychain  = require(path.join(ROOT, 'lib/keychain.js'));
      const lifecycle = require(path.join(ROOT, 'lib/token-lifecycle.js'));
      const auth      = require(path.join(ROOT, 'commands/auth.js'));
      const providers = await keychain.listProviders();
      const tokens    = await auth.tokens();
      const tracked   = lifecycle.getAllStatus ? lifecycle.getAllStatus() : [];
      process.stdout.write(JSON.stringify({
        backend:  keychain.storageBackend(),
        providers,
        tokens,
        tracked,
      }, null, 2) + '\n');
    });

  // ── doctor ─────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description('Check Node version, python3, keytar, wallet dir, manifests, auth status')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (opts) => {
      const { runDoctor } = require(path.join(ROOT, 'commands/doctor.js'));
      const code = await runDoctor({ json: !!opts.json });
      process.exitCode = code;
    });

  // ── mcp-config ─────────────────────────────────────────────────────────
  program
    .command('mcp-config <target>')
    .description('Print the MCP client config snippet for a target (claude-desktop, claude-code, cursor, vscode)')
    .action((target) => {
      const cfg = require(path.join(ROOT, 'commands/mcp-config.js'));
      process.exitCode = cfg.run(target);
    });

  // ── serve ──────────────────────────────────────────────────────────────
  program
    .command('serve')
    .description('Start the MCP server (stdio by default; --http starts the HTTP API server)')
    .option('--http',         'Start the HTTP API server instead of the stdio MCP server')
    .option('--port <port>',  'HTTP port', '3000')
    .action(async (opts) => {
      const file = opts.http
        ? path.join(ROOT, 'mcp-api-server.js')
        : path.join(ROOT, 'desktop-mcp-server.js');
      if (!fs.existsSync(file)) {
        console.error(`serve target not found: ${file}`);
        process.exitCode = 1; return;
      }
      if (opts.http) process.env.PORT = process.env.PORT || opts.port;
      require(file); // delegate to the server's own main()
    });

  return program;
}

/**
 * CLI entry point. Wraps registerCommands + parse.
 */
async function main(argv) {
  const program = new Command();
  registerCommands(program);
  await program.parseAsync(argv || process.argv);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`agentdom: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { main, registerCommands };
