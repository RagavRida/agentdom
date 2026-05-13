#!/usr/bin/env node
/**
 * AgentDOM — Manifest Validator (Phase 3)
 *
 * Validates a .well-known/agentdom.json manifest against the spec.
 * Used for:
 *   - CI: validate all bundled polyfills before publish
 *   - Vendor CLI: npx agentdom-vendor validate .well-known/agentdom.json
 *   - Runtime: quick sanity check on fetched manifests
 *
 * Usage:
 *   node tools/validate-manifest.js manifests/resend.com.json
 *   node tools/validate-manifest.js manifests/        # validate all in dir
 *   node tools/validate-manifest.js --all             # validate all bundled
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Validation rules ──────────────────────────────────────────────────────

const VALID_AUTH_METHODS = [
  'none', 'api_key', 'oauth2', 'oauth2_pkce', 'oauth2_cc',
  'oauth2_device', 'device_flow', 'session_cookie',
];

const VALID_TRANSPORTS = ['api', 'cli', 'ui'];
const VALID_METHODS    = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const VALID_SIDE_EFFECTS = ['read', 'write_local', 'external', 'send', 'delete'];

function validate(manifest, filePath = '<inline>') {
  const errors   = [];
  const warnings = [];

  const e = (msg) => errors.push({ file: filePath, message: msg });
  const w = (msg) => warnings.push({ file: filePath, message: msg });

  // ── Required fields ─────────────────────────────────────────────────

  if (!manifest) {
    e('Manifest is null or empty');
    return { valid: false, errors, warnings };
  }

  if (!manifest.version && !manifest.agentdom) {
    w('Missing "version" or "agentdom" field — should be "1.0" or "0.1"');
  }

  if (!manifest.host && !manifest.name) {
    e('Missing both "host" and "name" — at least one is required');
  }

  if (!manifest.capabilities || !Array.isArray(manifest.capabilities)) {
    e('Missing or invalid "capabilities" array');
    return { valid: errors.length === 0, errors, warnings };
  }

  if (manifest.capabilities.length === 0) {
    w('Empty capabilities array — manifest provides no intents');
  }

  // ── Auth validation ─────────────────────────────────────────────────

  if (manifest.auth) {
    const auth = manifest.auth;
    if (!auth.method) {
      e('auth block has no "method" field');
    } else if (!VALID_AUTH_METHODS.includes(auth.method)) {
      w(`Unknown auth method: "${auth.method}" — expected one of: ${VALID_AUTH_METHODS.join(', ')}`);
    }

    if (auth.method === 'oauth2' || auth.method === 'oauth2_pkce') {
      if (!auth.auth_url && !auth.authorize_url) {
        e(`OAuth auth requires "auth_url" or "authorize_url"`);
      }
      if (!auth.token_url) {
        e('OAuth auth requires "token_url"');
      }
    }

    if (auth.method === 'api_key') {
      if (!auth.key_header && !auth.header) {
        w('API key auth should specify "key_header" or "header"');
      }
    }
  }

  // ── Capabilities validation ─────────────────────────────────────────

  const intentIds = new Set();

  for (let i = 0; i < manifest.capabilities.length; i++) {
    const cap = manifest.capabilities[i];
    const prefix = `capabilities[${i}]`;

    // Intent ID
    if (!cap.intent) {
      e(`${prefix}: missing "intent" field`);
    } else {
      if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*(_\d+)?$/.test(cap.intent)) {
        w(`${prefix}: intent "${cap.intent}" — should use dotted.lowercase format (e.g. "contacts.create")`);
      }
      if (intentIds.has(cap.intent)) {
        w(`${prefix}: duplicate intent "${cap.intent}"`);
      }
      intentIds.add(cap.intent);
    }

    // Transport
    if (!cap.transport) {
      w(`${prefix}: missing "transport" — defaulting to "api"`);
    } else if (!VALID_TRANSPORTS.includes(cap.transport)) {
      e(`${prefix}: invalid transport "${cap.transport}" — expected: ${VALID_TRANSPORTS.join(', ')}`);
    }

    // API-specific
    if (cap.transport === 'api') {
      if (!cap.method) {
        e(`${prefix}: API transport requires "method" (GET, POST, etc.)`);
      } else if (!VALID_METHODS.includes(cap.method.toUpperCase())) {
        w(`${prefix}: unusual HTTP method "${cap.method}"`);
      }

      if (!cap.endpoint) {
        e(`${prefix}: API transport requires "endpoint" URL`);
      } else if (!cap.endpoint.startsWith('http')) {
        w(`${prefix}: endpoint "${cap.endpoint}" doesn't look like an absolute URL`);
      }
    }

    // CLI-specific
    if (cap.transport === 'cli') {
      if (!cap.binary) {
        w(`${prefix}: CLI transport should specify "binary" name`);
      }
    }

    // UI-specific
    if (cap.transport === 'ui') {
      if (!cap.url) {
        w(`${prefix}: UI transport should specify "url"`);
      }
    }

    // Side effects
    if (cap.side_effects && Array.isArray(cap.side_effects)) {
      for (const se of cap.side_effects) {
        if (!VALID_SIDE_EFFECTS.includes(se)) {
          w(`${prefix}: unknown side_effect "${se}"`);
        }
      }
    }

    // Description
    if (!cap.description) {
      w(`${prefix}: missing "description" — agents use this for intent routing`);
    }

    // Cost
    if (cap.cost !== undefined && (typeof cap.cost !== 'number' || cap.cost < 0)) {
      w(`${prefix}: "cost" should be a non-negative number`);
    }
  }

  // ── Meta validation ─────────────────────────────────────────────────

  if (manifest.meta) {
    if (!manifest.meta.base_url) {
      w('meta.base_url is missing — useful for agent context');
    }
  }

  return {
    valid:    errors.length === 0,
    errors,
    warnings,
    stats: {
      capabilities: manifest.capabilities.length,
      intents:      intentIds.size,
      authMethod:   manifest.auth?.method || 'none',
      host:         manifest.host || manifest.name || '<unknown>',
    },
  };
}

// ── Validate a file or directory ──────────────────────────────────────────

function validateFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [{ file: filePath, message: `Invalid JSON: ${err.message}` }],
      warnings: [],
      stats: { host: path.basename(filePath) },
    };
  }
  return validate(manifest, filePath);
}

function validateDir(dirPath) {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  const results = [];
  for (const f of files) {
    results.push(validateFile(path.join(dirPath, f)));
  }
  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────

const C = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', cyan: '\x1b[36m', r: '\x1b[0m', bold: '\x1b[1m' };

function printResult(result) {
  const icon = result.valid ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`;
  const host = result.stats?.host || '<unknown>';
  const caps = result.stats?.capabilities || 0;
  const auth = result.stats?.authMethod || '?';

  process.stdout.write(`${icon} ${host.padEnd(30)} ${String(caps).padStart(3)} intents  ${auth.padEnd(12)}`);

  if (result.errors.length) {
    process.stdout.write(`  ${C.red}${result.errors.length} error(s)${C.r}`);
  }
  if (result.warnings.length) {
    process.stdout.write(`  ${C.yellow}${result.warnings.length} warning(s)${C.r}`);
  }
  process.stdout.write('\n');

  // Detail
  for (const e of result.errors) {
    process.stderr.write(`    ${C.red}ERROR:${C.r} ${e.message}\n`);
  }
  for (const w of result.warnings) {
    process.stderr.write(`    ${C.yellow}WARN:${C.r} ${w.message}\n`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
${C.bold}agentdom validate-manifest${C.r} — validate .well-known/agentdom.json manifests

Usage:
  node tools/validate-manifest.js <file.json>     Validate a single manifest
  node tools/validate-manifest.js <directory/>     Validate all .json files in dir
  node tools/validate-manifest.js --all            Validate all bundled polyfills

Options:
  --strict    Treat warnings as errors (exit 1 on any warning)
  --json      Output validation results as JSON
`);
    process.exit(0);
  }

  const strict = args.includes('--strict');
  const json   = args.includes('--json');
  const all    = args.includes('--all');

  const input  = all
    ? path.join(__dirname, '..', 'manifests')
    : args.find(a => !a.startsWith('--'));

  if (!input || !fs.existsSync(input)) {
    console.error(`File or directory not found: ${input}`);
    process.exit(1);
  }

  const isDir = fs.statSync(input).isDirectory();
  const results = isDir ? validateDir(input) : [validateFile(input)];

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n${C.bold}${C.cyan}AgentDOM Manifest Validation${C.r}\n`);
    let totalErrors = 0, totalWarnings = 0;
    for (const r of results) {
      printResult(r);
      totalErrors   += r.errors.length;
      totalWarnings += r.warnings.length;
    }
    console.log(`\n${results.length} manifest(s) checked. ${C.green}${results.filter(r => r.valid).length} valid${C.r}, ${C.red}${results.filter(r => !r.valid).length} invalid${C.r}, ${totalWarnings} warnings.\n`);

    if (totalErrors > 0 || (strict && totalWarnings > 0)) {
      process.exit(1);
    }
  }
}

module.exports = { validate, validateFile, validateDir };
