#!/usr/bin/env node
/**
 * agentdom-publisher — Publisher CLI
 * 
 * Usage:
 *   npx agentdom-publisher init --openapi=./openapi.json --host=api.myapp.com
 *   npx agentdom-publisher validate --manifest=./.well-known/agentdom.json
 *   npx agentdom-publisher test --host=api.myapp.com --token=sk-...
 *   npx agentdom-publisher verify --host=api.myapp.com   # live HTTP check
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createServer } from 'http';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0';
const AGENTDOM_REGISTRY = 'https://agentdom.dev/manifests';

// ── ANSI colors ──────────────────────────────────────────────────────────────
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue:   (s) => `\x1b[34m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
};

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];
const flags = {};
args.slice(1).forEach(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  if (m) flags[m[1]] = m[2] || true;
});

// ── Manifest schema validator ─────────────────────────────────────────────────
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  // Required top-level fields
  if (!manifest.version) errors.push('Missing required field: version');
  if (!manifest.host) errors.push('Missing required field: host');
  if (!manifest.capabilities) errors.push('Missing required field: capabilities');
  if (!Array.isArray(manifest.capabilities)) errors.push('capabilities must be an array');

  // Auth validation
  if (!manifest.auth) {
    warnings.push('No auth block defined — your API may be public or require manual setup');
  } else {
    const method = manifest.auth.method;
    if (!['api_key', 'oauth2', 'oauth2_pkce', 'device_flow', 'none'].includes(method)) {
      errors.push(`Unknown auth method: ${method}. Must be: api_key, oauth2, oauth2_pkce, device_flow, none`);
    }
    if (method === 'oauth2' || method === 'oauth2_pkce') {
      if (!manifest.auth.auth_url) errors.push('OAuth auth requires auth_url');
      if (!manifest.auth.token_url) errors.push('OAuth auth requires token_url');
    }
    if (method === 'api_key') {
      if (!manifest.auth.key_header) warnings.push('api_key auth should define key_header (e.g. Authorization)');
    }
  }

  // Capability validation
  const VALID_TRANSPORTS = ['api', 'graphql', 'cli', 'browser', 'desktop'];
  const VALID_EFFECTS = ['read', 'write_local', 'send', 'external', 'delete', 'payment', 'execute', 'stream'];
  const intentIds = new Set();

  (manifest.capabilities || []).forEach((cap, i) => {
    const prefix = `capabilities[${i}] (${cap.intent || 'unnamed'})`;

    if (!cap.intent) errors.push(`${prefix}: Missing required field: intent`);
    if (!cap.transport) errors.push(`${prefix}: Missing required field: transport`);
    if (!cap.endpoint) errors.push(`${prefix}: Missing required field: endpoint`);
    if (!cap.side_effects || !cap.side_effects.length) {
      warnings.push(`${prefix}: No side_effects defined — agents may guess incorrectly`);
    }

    if (cap.transport && !VALID_TRANSPORTS.includes(cap.transport)) {
      errors.push(`${prefix}: Unknown transport: ${cap.transport}. Must be one of: ${VALID_TRANSPORTS.join(', ')}`);
    }

    (cap.side_effects || []).forEach(e => {
      if (!VALID_EFFECTS.includes(e)) {
        errors.push(`${prefix}: Unknown side_effect: ${e}. Must be one of: ${VALID_EFFECTS.join(', ')}`);
      }
    });

    if (cap.intent && intentIds.has(cap.intent)) {
      errors.push(`${prefix}: Duplicate intent ID: ${cap.intent}. All intent IDs must be unique.`);
    }
    if (cap.intent) intentIds.add(cap.intent);

    // Check endpoint template vars match args
    const templateVars = (cap.endpoint || '').match(/\{(\w+)\}/g) || [];
    templateVars.forEach(v => {
      const key = v.slice(1, -1);
      if (!cap.args || !cap.args[key]) {
        errors.push(`${prefix}: Endpoint uses {${key}} but no matching arg defined`);
      }
    });
  });

  return { errors, warnings, capCount: (manifest.capabilities || []).length };
}

// ── OpenAPI → AgentDOM compiler (same as gen-manifest.js) ────────────────────
async function compileFromOpenAPI(openapiPath, host) {
  const raw = JSON.parse(readFileSync(openapiPath, 'utf-8'));
  const capabilities = [];
  const paths = raw.paths || {};

  const METHOD_EFFECTS = {
    get: ['read'], head: ['read'], options: ['read'],
    post: ['external'], put: ['external'], patch: ['external'],
    delete: ['external', 'delete'],
  };

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (['parameters', 'summary', 'description'].includes(method)) continue;
      const opId = op.operationId || `${method}_${path.replace(/\W+/g, '_')}`;
      const tags = op.tags || ['default'];
      const tag = tags[0].toLowerCase().replace(/\s+/g, '_');
      const intent = `${tag}.${opId}`;

      const args = {};
      (op.parameters || []).forEach(p => {
        args[p.name] = {
          type: p.schema?.type || 'string',
          required: !!p.required,
          description: p.description || '',
          in: p.in,
        };
      });

      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body?.properties) {
        Object.entries(body.properties).forEach(([k, v]) => {
          if (!args[k]) args[k] = {
            type: v.type || 'string',
            required: (body.required || []).includes(k),
            description: v.description || '',
          };
        });
      }

      const baseUrl = raw.servers?.[0]?.url || `https://${host}`;

      capabilities.push({
        intent,
        description: op.summary || op.description || '',
        transport: 'api',
        method: method.toUpperCase(),
        endpoint: `${baseUrl}${path}`,
        args,
        side_effects: METHOD_EFFECTS[method] || ['external'],
        cost: 1,
      });
    }
  }

  const info = raw.info || {};
  const authSchemes = Object.values(raw.components?.securitySchemes || {});
  let auth = { method: 'api_key', key_header: 'Authorization', key_format: 'Bearer {token}' };

  if (authSchemes.length) {
    const scheme = authSchemes[0];
    if (scheme.type === 'oauth2') {
      const flow = Object.values(scheme.flows || {})[0];
      auth = {
        method: 'oauth2',
        auth_url: flow?.authorizationUrl || '',
        token_url: flow?.tokenUrl || '',
        scopes: Object.keys(flow?.scopes || {}),
      };
    } else if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      auth = { method: 'api_key', key_header: 'Authorization', key_format: 'Bearer {token}' };
    } else if (scheme.in === 'header') {
      auth = { method: 'api_key', key_header: scheme.name, key_format: '{token}' };
    }
  }

  return {
    version: VERSION,
    host,
    name: info.title || host,
    description: info.description || `AgentDOM manifest for ${host}`,
    generated_at: new Date().toISOString(),
    generated_by: 'agentdom-publisher/1.0',
    source: 'openapi',
    auth,
    capabilities,
    meta: {
      total_operations: capabilities.length,
      api_version: info.version,
      docs: raw.externalDocs?.url || '',
    },
  };
}

// ── Live verification: fetches the deployed manifest ─────────────────────────
async function verifyLive(host) {
  const url = `https://${host}/.well-known/agentdom.json`;
  console.log(c.dim(`\nFetching ${url}...`));

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(c.red(`✗ HTTP ${res.status} — manifest not found at ${url}`));
      console.log(c.yellow('\nTo fix: deploy your manifest to: https://' + host + '/.well-known/agentdom.json'));
      process.exit(1);
    }
    const manifest = await res.json();
    const { errors, warnings, capCount } = validateManifest(manifest);

    console.log(c.green(`✓ Manifest found at ${url}`));
    console.log(c.green(`✓ ${capCount} capabilities declared`));
    console.log(c.green(`✓ Auth method: ${manifest.auth?.method || 'none'}`));

    if (warnings.length) {
      console.log(c.yellow(`\n⚠ ${warnings.length} warning(s):`));
      warnings.forEach(w => console.log(c.yellow(`  · ${w}`)));
    }

    if (errors.length) {
      console.log(c.red(`\n✗ ${errors.length} error(s):`));
      errors.forEach(e => console.log(c.red(`  · ${e}`)));
      process.exit(1);
    }

    console.log(c.green('\n✓ Manifest is valid and ready for AgentDOM agents!'));
    console.log(c.cyan(`\n→ Test a live dispatch:`));
    const firstCap = manifest.capabilities?.[0];
    if (firstCap) {
      console.log(c.dim(`  npx agentdom intent ${firstCap.intent} --provider=${host}`));
    }
    console.log(c.cyan(`\n→ Submit to registry:`));
    console.log(c.dim(`  npx agentdom-publisher submit --host=${host}`));

  } catch (err) {
    console.log(c.red(`✗ Failed to fetch manifest: ${err.message}`));
    process.exit(1);
  }
}

// ── Dispatch test ─────────────────────────────────────────────────────────────
async function runTest(host, token, intent, args) {
  const manifestUrl = `https://${host}/.well-known/agentdom.json`;
  console.log(c.dim(`\nLoading manifest from ${manifestUrl}...`));

  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Manifest not found at ${manifestUrl}`);
  const manifest = await res.json();

  const cap = manifest.capabilities.find(c => c.intent === intent);
  if (!cap) {
    console.log(c.red(`✗ Intent "${intent}" not found in manifest`));
    console.log(c.dim('Available: ' + manifest.capabilities.slice(0, 10).map(c => c.intent).join(', ')));
    process.exit(1);
  }

  // Build endpoint with path params
  let url = cap.endpoint;
  const parsedArgs = args ? JSON.parse(args) : {};
  Object.entries(parsedArgs).forEach(([k, v]) => {
    url = url.replace(`{${k}}`, encodeURIComponent(v));
  });

  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    const fmt = manifest.auth?.key_format || 'Bearer {token}';
    const hdr = manifest.auth?.key_header || 'Authorization';
    headers[hdr] = fmt.replace('{token}', token);
  }

  const isWrite = ['POST', 'PUT', 'PATCH'].includes(cap.method.toUpperCase());
  console.log(c.dim(`\n${cap.method} ${url}`));

  const fetchOpts = {
    method: cap.method.toUpperCase(),
    headers,
  };
  if (isWrite) fetchOpts.body = JSON.stringify(parsedArgs);

  const response = await fetch(url, fetchOpts);
  const body = await response.text();

  if (response.ok) {
    console.log(c.green(`✓ ${response.status} OK`));
    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.log(body);
    }
  } else {
    console.log(c.red(`✗ ${response.status} ${response.statusText}`));
    console.log(body);
    process.exit(1);
  }
}

// ── Submit to registry ────────────────────────────────────────────────────────
async function submit(host) {
  const submitUrl = 'https://agentdom.dev/api/registry/submit';
  console.log(c.dim(`\nSubmitting ${host} to AgentDOM Registry...`));
  try {
    const res = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host }),
    });
    if (res.ok) {
      console.log(c.green(`\n✓ Submitted! ${host} will appear in the registry within 24 hours.`));
      console.log(c.dim(`  Registry: https://agentdom.dev/manifests/${host}.json`));
    } else {
      const t = await res.text();
      console.log(c.yellow(`⚠ Submission returned ${res.status}: ${t}`));
    }
  } catch (err) {
    console.log(c.yellow(`⚠ Could not reach registry: ${err.message}`));
    console.log(c.dim('  Your manifest will still work — just not listed publicly yet.'));
  }
}

// ── Scaffold well-known directory ─────────────────────────────────────────────
function scaffoldWellKnown(manifest, cwd) {
  const dir = resolve(cwd, '.well-known');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, 'agentdom.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c.bold('\n🤖 AgentDOM Publisher SDK v1.0'));
  console.log(c.dim('   The standard for machine-readable software\n'));

  if (!command || command === 'help' || command === '--help') {
    console.log(`${c.bold('Commands:')}\n
  ${c.cyan('init')}       Generate .well-known/agentdom.json from your OpenAPI spec
              ${c.dim('--openapi=./openapi.json  --host=api.myapp.com  [--out=./]')}

  ${c.cyan('validate')}   Validate an existing manifest without deploying
              ${c.dim('--manifest=./.well-known/agentdom.json')}

  ${c.cyan('verify')}     Live HTTP check: fetch & validate your deployed manifest
              ${c.dim('--host=api.myapp.com')}

  ${c.cyan('test')}       Dispatch a real API call to verify end-to-end
              ${c.dim('--host=api.myapp.com  --token=sk-...  --intent=contacts.list  [--args=\'{"limit":5}\']')}

  ${c.cyan('submit')}     Register your host in the AgentDOM public registry
              ${c.dim('--host=api.myapp.com')}

  ${c.cyan('mcpuse')}     Generate a mcp-use server scaffold from a manifest
              ${c.dim('--host=github.com  [--lang=typescript|python]  [--out=./my-server]  [--port=3000]')}
              ${c.dim('--manifest=./.well-known/agentdom.json  (local file alternative)')}

${c.bold('Example workflow:')}
  npx agentdom-publisher init --openapi=./openapi.json --host=api.myapp.com
  # → Deploy .well-known/agentdom.json to your server
  npx agentdom-publisher verify --host=api.myapp.com
  npx agentdom-publisher test  --host=api.myapp.com --token=sk-... --intent=contacts.list
  npx agentdom-publisher submit --host=api.myapp.com
  npx agentdom-publisher mcpuse --host=api.myapp.com --out=./my-mcp-server
`);
    return;
  }

  // ── init ──────────────────────────────────────────────────────────────────
  if (command === 'init') {
    const openapiPath = flags.openapi;
    const host = flags.host;
    if (!openapiPath) { console.log(c.red('✗ --openapi is required')); process.exit(1); }
    if (!host) { console.log(c.red('✗ --host is required')); process.exit(1); }

    console.log(c.dim(`Compiling OpenAPI spec: ${openapiPath}`));
    const manifest = await compileFromOpenAPI(resolve(process.cwd(), openapiPath), host);

    const { errors, warnings, capCount } = validateManifest(manifest);
    console.log(c.green(`✓ Compiled ${capCount} capabilities`));
    if (warnings.length) warnings.forEach(w => console.log(c.yellow(`  ⚠ ${w}`)));
    if (errors.length) { errors.forEach(e => console.log(c.red(`  ✗ ${e}`))); process.exit(1); }

    const outDir = flags.out ? resolve(process.cwd(), flags.out) : process.cwd();
    const dir = resolve(outDir, '.well-known');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const outPath = resolve(dir, 'agentdom.json');
    writeFileSync(outPath, JSON.stringify(manifest, null, 2));

    console.log(c.green(`\n✓ Written to: ${outPath}`));
    console.log(`\n${c.bold('Next steps:')}`);
    console.log(`  1. ${c.cyan('Deploy')} .well-known/agentdom.json to your server`);
    console.log(`     ${c.dim(`Must be accessible at: https://${host}/.well-known/agentdom.json`)}`);
    console.log(`\n  2. ${c.cyan('Verify')} the deployment:`);
    console.log(`     ${c.dim(`npx agentdom-publisher verify --host=${host}`)}`);
    console.log(`\n  3. ${c.cyan('Test')} a real dispatch:`);
    const first = manifest.capabilities[0];
    if (first) {
      console.log(`     ${c.dim(`npx agentdom-publisher test --host=${host} --token=YOUR_TOKEN --intent=${first.intent}`)}`);
    }
    console.log(`\n  4. ${c.cyan('Submit')} to the AgentDOM public registry:`);
    console.log(`     ${c.dim(`npx agentdom-publisher submit --host=${host}`)}`);
    return;
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (command === 'validate') {
    const manifestPath = flags.manifest || '.well-known/agentdom.json';
    const full = resolve(process.cwd(), manifestPath);
    if (!existsSync(full)) { console.log(c.red(`✗ File not found: ${full}`)); process.exit(1); }

    const manifest = JSON.parse(readFileSync(full, 'utf-8'));
    const { errors, warnings, capCount } = validateManifest(manifest);

    console.log(c.bold(`Validating: ${full}`));
    console.log(c.dim(`  Host:         ${manifest.host || '—'}`));
    console.log(c.dim(`  Version:      ${manifest.version || '—'}`));
    console.log(c.dim(`  Capabilities: ${capCount}`));
    console.log(c.dim(`  Auth:         ${manifest.auth?.method || '—'}`));

    if (warnings.length) {
      console.log(c.yellow(`\n⚠ ${warnings.length} warning(s):`));
      warnings.forEach(w => console.log(c.yellow(`  · ${w}`)));
    }
    if (errors.length) {
      console.log(c.red(`\n✗ ${errors.length} error(s):`));
      errors.forEach(e => console.log(c.red(`  · ${e}`)));
      process.exit(1);
    }
    console.log(c.green(`\n✓ Manifest is valid (${capCount} capabilities, 0 errors)`));
    return;
  }

  // ── verify ────────────────────────────────────────────────────────────────
  if (command === 'verify') {
    if (!flags.host) { console.log(c.red('✗ --host is required')); process.exit(1); }
    await verifyLive(flags.host);
    return;
  }

  // ── test ──────────────────────────────────────────────────────────────────
  if (command === 'test') {
    if (!flags.host) { console.log(c.red('✗ --host is required')); process.exit(1); }
    if (!flags.intent) { console.log(c.red('✗ --intent is required')); process.exit(1); }
    await runTest(flags.host, flags.token, flags.intent, flags.args);
    return;
  }

  // ── submit ────────────────────────────────────────────────────────────────
  if (command === 'submit') {
    if (!flags.host) { console.log(c.red('✗ --host is required')); process.exit(1); }
    await submit(flags.host);
    return;
  }

  // ── mcpuse ───────────────────────────────────────────────────────────────
  if (command === 'mcpuse') {
    const lang    = flags.lang || 'typescript';
    const outDir  = flags.out  ? resolve(process.cwd(), flags.out) : resolve(process.cwd(), `mcpuse-${flags.host || 'server'}`);
    const port    = parseInt(flags.port || (lang === 'python' ? '8000' : '3000'), 10);
    const agentdomApi = flags.api || 'http://localhost:3700';

    let manifest;
    if (flags.manifest) {
      // Load from local file
      const mPath = resolve(process.cwd(), flags.manifest);
      if (!existsSync(mPath)) { console.log(c.red(`✗ Manifest not found: ${mPath}`)); process.exit(1); }
      manifest = JSON.parse(readFileSync(mPath, 'utf-8'));
    } else if (flags.host) {
      // Fetch from live URL
      const url = `https://${flags.host}/.well-known/agentdom.json`;
      console.log(c.dim(`\nFetching manifest from ${url}...`));
      const res = await fetch(url);
      if (!res.ok) { console.log(c.red(`✗ Could not fetch manifest (${res.status})`)); process.exit(1); }
      manifest = await res.json();
    } else {
      console.log(c.red('✗ Provide --host=api.myapp.com or --manifest=./path/to/agentdom.json'));
      process.exit(1);
    }

    const capCount = manifest.capabilities?.length || 0;
    console.log(c.green(`✓ Loaded manifest: ${capCount} capabilities for ${manifest.host}`));

    // Dynamic import the compiler (CJS from ESM)
    const { scaffold } = _require('../compiler/to-mcpuse.js');
    const { files, dir } = scaffold(manifest, { outDir, lang, agentdomApi, port });

    console.log(c.green(`\n✓ Generated ${lang} mcp-use server → ${dir}`));
    files.forEach(f => console.log(c.dim(`  ${f}`)));

    console.log(`\n${c.bold('Next steps:')}`);
    if (lang === 'python') {
      console.log(`  ${c.cyan('cd')} ${outDir}`);
      console.log(`  ${c.cyan('pip install')} -r requirements.txt`);
      console.log(`  ${c.cyan('python')} server.py`);
    } else {
      console.log(`  ${c.cyan('cd')} ${outDir}`);
      console.log(`  ${c.cyan('npm install')}`);
      console.log(`  ${c.cyan('npm start')}`);
    }
    console.log(`  ${c.dim(`Inspector → http://localhost:${port}/inspector`)}`);
    console.log(`  ${c.dim('Connect this URL to Claude Desktop or any MCP client')}`);
    return;
  }

  console.log(c.red(`Unknown command: ${command}`));
  console.log(c.dim('Run: npx agentdom-publisher help'));
  process.exit(1);
}

main().catch(err => {
  console.error(c.red('Fatal: ' + err.message));
  process.exit(1);
});
