#!/usr/bin/env node
/**
 * AgentDOM — OpenAPI → .well-known/agentdom.json Compiler
 *
 * Transforms any OpenAPI 3.x spec into an AgentDOM manifest.
 * Output is compatible with the .well-known/agentdom protocol.
 *
 * Usage:
 *   node tools/gen-manifest.js <openapi-url-or-file> [--host=domain.com] [--out=path.json]
 *
 * Examples:
 *   node tools/gen-manifest.js https://api.linear.app/graphql --host=linear.app
 *   node tools/gen-manifest.js ./openapi.json --host=myapp.com --out=manifests/myapp.com.json
 *
 * Intent naming convention:
 *   tags[0] + operationId  →  "contacts.create"
 *   e.g. tag "CRM Contacts" + op "createContact"  →  "contacts.create"
 *        tag "Issues"       + op "listIssues"      →  "issues.list"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Intent naming ─────────────────────────────────────────────────────────

// Map common HTTP method + path patterns to intent verbs
const METHOD_VERB = {
  get:    { list: 'list', single: 'get' },
  post:   'create',
  put:    'update',
  patch:  'update',
  delete: 'delete',
};

// Tag → intent namespace
function tagToNamespace(tag) {
  // Tags can be objects (GitHub), arrays, or strings
  if (Array.isArray(tag)) tag = tag[0];
  if (typeof tag === 'object' && tag !== null) tag = tag.name || JSON.stringify(tag).slice(0, 20);
  if (!tag) return 'misc';
  return String(tag)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    // Common clean-ups
    .replace(/^crm_/, '')
    .replace(/_api$/, '')
    .replace(/_v\d+$/, '')
    // Singular form heuristics
    .replace(/ies$/, 'y')
    .replace(/ses$/, 's');
}


function operationToVerb(operationId, method, pathStr) {
  if (!operationId) {
    // Infer from method + path shape
    const hasId = /\{[^}]+\}/.test(pathStr);
    if (method === 'get') return hasId ? 'get' : 'list';
    return METHOD_VERB[method] || method;
  }
  const id = operationId.toLowerCase();
  if (/^(list|get_all|find_all|search)/.test(id)) return 'list';
  if (/^(get|fetch|retrieve|show|read)/.test(id))  return 'get';
  if (/^(create|add|new|post)/.test(id))           return 'create';
  if (/^(update|edit|patch|modify|put)/.test(id))  return 'update';
  if (/^(delete|remove|destroy|purge)/.test(id))   return 'delete';
  if (/^(send|email|notify|push)/.test(id))        return 'send';
  if (/^(search|query|filter|find)/.test(id))      return 'search';
  if (/^(import|export|sync)/.test(id))            return id.split('_')[0] || method;
  if (/(list|s)$/.test(id) && method === 'get')    return 'list';
  return METHOD_VERB[method] || 'call';
}

function buildIntentId(tag, verb) {
  const ns = tagToNamespace(tag);
  return `${ns}.${verb}`;
}

// ── Side effects ──────────────────────────────────────────────────────────

function inferSideEffects(method) {
  switch (method) {
    case 'get':    return ['read'];
    case 'delete': return ['delete', 'external'];
    case 'post':   return ['external', 'write_local'];
    case 'put':
    case 'patch':  return ['external'];
    default:       return ['external'];
  }
}

// ── Auth detection ────────────────────────────────────────────────────────

function detectAuth(spec) {
  const securitySchemes = spec.components?.securitySchemes || {};
  for (const [, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'oauth2') {
      const flows = scheme.flows || {};
      const authUrl   = flows.authorizationCode?.authorizationUrl || flows.implicit?.authorizationUrl || null;
      const tokenUrl  = flows.authorizationCode?.tokenUrl || flows.clientCredentials?.tokenUrl || null;
      const allScopes = Object.keys({
        ...flows.authorizationCode?.scopes,
        ...flows.clientCredentials?.scopes,
        ...flows.implicit?.scopes,
      });
      return {
        method:    'oauth2',
        auth_url:  authUrl,
        token_url: tokenUrl,
        scopes:    allScopes.slice(0, 20), // cap for readability
      };
    }
    if (scheme.type === 'apiKey' || scheme.type === 'http') {
      return {
        method:     'api_key',
        key_header: scheme.name || 'Authorization',
        key_format: scheme.scheme === 'bearer' ? 'Bearer {token}' : '{token}',
      };
    }
  }
  // Check global security requirement
  if (spec.security?.some(s => Object.keys(s).length)) {
    return { method: 'api_key', key_header: 'Authorization', key_format: 'Bearer {token}' };
  }
  return { method: 'none' };
}

// ── Schema → args ─────────────────────────────────────────────────────────

function extractArgs(operation, pathStr) {
  const args = {};
  // Path parameters
  const pathParams = (operation.parameters || []).filter(p => p.in === 'path');
  pathParams.forEach(p => {
    args[p.name] = { type: p.schema?.type || 'string', required: true, description: p.description || '' };
  });
  // Query parameters (top 5 most useful)
  const queryParams = (operation.parameters || []).filter(p => p.in === 'query').slice(0, 5);
  queryParams.forEach(p => {
    args[p.name] = { type: p.schema?.type || 'string', required: !!p.required, description: p.description || '' };
  });
  // Request body
  const body = operation.requestBody;
  if (body) {
    const schema = body.content?.['application/json']?.schema;
    if (schema?.properties) {
      const required = schema.required || [];
      Object.entries(schema.properties).slice(0, 10).forEach(([k, v]) => {
        args[k] = { type: v.type || 'string', required: required.includes(k), description: v.description || '' };
      });
    } else {
      args['body'] = { type: 'object', required: false, description: 'Request body' };
    }
  }
  return args;
}

// ── Path → endpoint template ──────────────────────────────────────────────

function buildEndpoint(baseUrl, pathStr) {
  // Convert OpenAPI {param} to {param} (same format, for clarity)
  return `${baseUrl}${pathStr}`;
}

// ── Compiler ──────────────────────────────────────────────────────────────

function compile(spec, host) {
  const info    = spec.info || {};
  const baseUrl = (() => {
    const server = spec.servers?.[0]?.url || `https://${host}`;
    return server.replace(/\/$/, '');
  })();
  const auth = detectAuth(spec);

  const capabilities = [];
  const intentCount  = new Map(); // deduplicate: intent → count

  const paths = spec.paths || {};
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op) continue;
      if (op['x-internal'] || op.deprecated) continue;

      const tag  = (op.tags || [])[0] || info.title || host;
      const verb = operationToVerb(op.operationId, method, pathStr);
      let intentId = buildIntentId(tag, verb);

      // Deduplicate: if "contacts.create" already exists, skip or number it
      if (intentCount.has(intentId)) {
        const n = intentCount.get(intentId) + 1;
        intentCount.set(intentId, n);
        intentId = `${intentId}_${n}`;
      } else {
        intentCount.set(intentId, 1);
      }

      const capability = {
        intent:       intentId,
        description:  op.summary || op.description || `${method.toUpperCase()} ${pathStr}`,
        transport:    'api',
        method:       method.toUpperCase(),
        endpoint:     buildEndpoint(baseUrl, pathStr),
        args:         extractArgs(op, pathStr),
        side_effects: inferSideEffects(method),
        cost:         1,
        tags:         op.tags || [],
        operation_id: op.operationId || null,
      };

      capabilities.push(capability);
    }
  }

  return {
    version:    '1.0',
    host,
    name:       info.title  || host,
    description: info.description || `AgentDOM manifest for ${host}`,
    generated_at: new Date().toISOString(),
    generated_by: 'agentdom/gen-manifest',
    source:     'polyfill',   // vs "vendor-native"
    auth,
    capabilities,
    meta: {
      total_operations: capabilities.length,
      openapi_version:  spec.openapi || spec.swagger || 'unknown',
      base_url:         baseUrl,
    },
  };
}

// ── Fetcher ───────────────────────────────────────────────────────────────

function fetchSpec(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'Accept': 'application/json, application/yaml, */*', 'User-Agent': 'agentdom-gen-manifest/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchSpec(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) {
          // Try YAML (basic)
          reject(new Error(`Could not parse spec from ${url} — ensure it returns JSON`));
        }
      });
    }).on('error', reject);
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const input  = args.find(a => !a.startsWith('--'));
  const hostArg = args.find(a => a.startsWith('--host='))?.split('=')[1];
  const outArg  = args.find(a => a.startsWith('--out='))?.split('=')[1];
  const dryRun  = args.includes('--dry');

  if (!input) {
    console.error('Usage: node tools/gen-manifest.js <openapi-url-or-file> [--host=domain.com] [--out=path.json] [--dry]');
    process.exit(1);
  }

  // Load spec
  let spec;
  if (input.startsWith('http')) {
    console.error(`Fetching ${input}...`);
    spec = await fetchSpec(input);
  } else {
    spec = JSON.parse(fs.readFileSync(input, 'utf-8'));
  }

  // Determine host
  const host = hostArg
    || new URL(spec.servers?.[0]?.url || `https://${input.replace(/https?:\/\//, '').split('/')[0]}`).hostname
    || path.basename(input, path.extname(input));

  console.error(`Compiling ${spec.paths ? Object.keys(spec.paths).length : 0} paths for ${host}...`);
  const manifest = compile(spec, host);

  if (dryRun) {
    console.error(`Dry run: ${manifest.capabilities.length} capabilities generated`);
    manifest.capabilities.slice(0, 10).forEach(c => {
      console.error(`  ${c.intent.padEnd(35)} ${c.method.padEnd(7)} ${c.endpoint.slice(0, 60)}`);
    });
    if (manifest.capabilities.length > 10) console.error(`  ... and ${manifest.capabilities.length - 10} more`);
    return;
  }

  // Write output
  const output = JSON.stringify(manifest, null, 2);
  if (outArg) {
    const dir = path.dirname(outArg);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outArg, output, 'utf-8');
    console.error(`Written to ${outArg}`);
    console.log(`✓ ${host}: ${manifest.capabilities.length} capabilities → ${outArg}`);
  } else {
    process.stdout.write(output + '\n');
  }
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });

// Export for use in other scripts
module.exports = { compile, detectAuth, buildIntentId, tagToNamespace };
