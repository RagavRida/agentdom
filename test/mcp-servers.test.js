/**
 * Live MCP server tests.
 *
 * Spawns each server as a subprocess via @modelcontextprotocol/sdk's
 * StdioClientTransport, then asserts the handshake + scan + dispatch flow.
 *
 * Run: node test/mcp-servers.test.js
 * Exits non-zero on the first failed assertion.
 *
 * Coverage:
 *   - mcp-cli-server.js   : full e2e against `node --help`
 *   - mcp-api-server.js   : full e2e against a local httpd serving a Pet Store spec
 *   - desktop-mcp-server.js: scan_app failure path (Accessibility env-dependent)
 *   - mcp-server.js (web): skipped — Puppeteer is heavyweight; covered by the
 *                          existing 32 web tests.
 */

'use strict';

const path = require('path');
const http = require('http');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.join(__dirname, '..');
let total = 0, failed = 0;

async function test(name, fn) {
  total++;
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`  FAIL ${name}\n    ${e.stack || e.message}\n`); }
}

async function spawnClient(serverPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client({ name: 'agentdom-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => {}) };
}

function jsonText(callResult) {
  // Tool calls return { content: [{ type:'text', text: '...' }] }; parse if JSON.
  const text = callResult.content?.[0]?.text || '';
  try { return JSON.parse(text); } catch { return text; }
}

// ════════════════════════════════════════════════
//  CLI MCP server
// ════════════════════════════════════════════════
async function testCli() {
  const { client, close } = await spawnClient(path.join(ROOT, 'mcp-cli-server.js'));
  try {
    await test('cli: tools/list before scan exposes only scan_cli', async () => {
      const r = await client.listTools();
      assert.strictEqual(r.tools.length, 1);
      assert.strictEqual(r.tools[0].name, 'scan_cli');
    });

    await test('cli: scan_cli({command:"node"}) registers typed tools', async () => {
      const r = await client.callTool({ name: 'scan_cli', arguments: { command: 'node' } });
      assert.ok(!r.isError, 'scan_cli should not error');
      const data = jsonText(r);
      assert.strictEqual(data.command, 'node');
      assert.ok(data.tools.length > 0, 'expected at least one auto-generated tool');
    });

    await test('cli: tools/list grows after scan', async () => {
      const r = await client.listTools();
      assert.ok(r.tools.length > 1, `expected >1 tools, got ${r.tools.length}`);
      assert.ok(r.tools.find(t => t.name === 'scan_cli'));
    });

    await test('cli: rejects unsafe binary names', async () => {
      const r = await client.callTool({ name: 'scan_cli', arguments: { command: 'node;rm -rf /' } });
      assert.ok(r.isError, 'expected error for shell-injection attempt');
    });

    await test('cli: dispatches a flag form to execFileSync', async () => {
      // CLI flag forms are named invoke_<command> by the current codegen.
      await client.callTool({ name: 'scan_cli', arguments: { command: 'node' } });
      const list = await client.listTools();
      const formTool = list.tools.find(t => t.name === 'invoke_node');
      assert.ok(formTool, `expected invoke_node form tool; got: ${list.tools.map(t => t.name).slice(0, 8).join(', ')}`);
      const r = await client.callTool({ name: 'invoke_node', arguments: { version: true } });
      const data = jsonText(r);
      assert.ok(data.argv || data.exitCode !== undefined || data.error, `dispatcher returned: ${JSON.stringify(data).slice(0, 200)}`);
    });
  } finally {
    await close();
  }
}

// ════════════════════════════════════════════════
//  API MCP server
// ════════════════════════════════════════════════
function startStubApi() {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Stub API', version: '1.0' },
    paths: {
      '/echo': {
        post: {
          operationId: 'echo',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
              },
            },
          },
        },
        get: {
          operationId: 'ping',
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        },
      },
    },
  };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(spec));
      }
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          body: body ? safeJson(body) : null,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      // Patch spec.servers so the spec we serve includes the dynamic base.
      spec.servers = [{ url: base }];
      resolve({ server, base });
    });
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function testApi() {
  const { server, base } = await startStubApi();
  const { client, close } = await spawnClient(path.join(ROOT, 'mcp-api-server.js'));
  try {
    await test('api: scan_api against local stub registers tools', async () => {
      const r = await client.callTool({
        name: 'scan_api',
        arguments: { spec: `${base}/openapi.json` },
      });
      assert.ok(!r.isError, JSON.stringify(jsonText(r)));
      const data = jsonText(r);
      assert.strictEqual(data.title, 'Stub API');
      assert.strictEqual(data.base, base);
      assert.ok(data.tools.length > 0);
    });

    await test('api: tools/list shows registered operations', async () => {
      const r = await client.listTools();
      const names = r.tools.map(t => t.name);
      assert.ok(names.includes('scan_api'));
      // operationIds become tool names through the optimizer (slugified).
      assert.ok(names.find(n => n.includes('echo') || n.includes('create')), `tools: ${names.join(', ')}`);
    });

    await test('api: form dispatch to POST sends JSON body', async () => {
      const list = await client.listTools();
      // Find the form tool for echo (createPet-shaped: name=create, then click_echo as fallback)
      const candidate =
        list.tools.find(t => t.name === 'create') ||
        list.tools.find(t => t.name.includes('echo'));
      assert.ok(candidate, `no form tool: ${list.tools.map(t => t.name).join(', ')}`);
      const r = await client.callTool({ name: candidate.name, arguments: { message: 'hello' } });
      const data = jsonText(r);
      assert.ok(data.request, `expected a request envelope, got ${JSON.stringify(data)}`);
      assert.strictEqual(data.status, 200);
      assert.strictEqual(data.body?.method, 'POST');
      assert.deepStrictEqual(data.body?.body, { message: 'hello' });
    });

    await test('api: rejects when spec has no base URL', async () => {
      const r = await client.callTool({
        name: 'scan_api',
        arguments: { spec: JSON.stringify({ openapi: '3.0.0', info: { title: 'No-Base' }, paths: {} }) },
      });
      assert.ok(r.isError);
    });
  } finally {
    await close();
    server.close();
  }
}

// ════════════════════════════════════════════════
//  Desktop MCP server (env-dependent)
// ════════════════════════════════════════════════
async function testDesktop() {
  const { client, close } = await spawnClient(path.join(ROOT, 'desktop-mcp-server.js'));
  try {
    await test('desktop: tools/list exposes scan_app + meta tools', async () => {
      const r = await client.listTools();
      const names = r.tools.map(t => t.name);
      assert.ok(names.includes('scan_app'));
      assert.ok(names.includes('discover'));
      assert.ok(names.includes('observe'));
      assert.ok(names.includes('batch'));
    });

    await test('desktop: scan_app on missing app returns clean error', async () => {
      const r = await client.callTool({
        name: 'scan_app',
        arguments: { app: 'NotARealAppZZZ' },
      });
      assert.ok(r.isError, 'expected isError for non-running app');
      const data = jsonText(r);
      // Either "not running" or a permission error — both are valid clean failures.
      assert.ok(
        data.error?.includes('not running') || data.error?.includes('Permission'),
        `expected clean error, got: ${JSON.stringify(data)}`,
      );
      assert.ok(data.hint, 'error must carry a hint');
    });

    await test('desktop: attach_electron meta-tool is exposed', async () => {
      const r = await client.listTools();
      const t = r.tools.find(x => x.name === 'attach_electron');
      assert.ok(t, 'attach_electron should be listed alongside scan_app');
      assert.ok(t.inputSchema?.properties?.app, 'attach_electron must accept { app }');
      assert.ok(t.inputSchema?.properties?.port, 'attach_electron must accept { port }');
    });

    await test('desktop: attach_electron on missing app returns clean error', async () => {
      const r = await client.callTool({
        name: 'attach_electron',
        arguments: { app: 'NotARealAppZZZ' },
      });
      assert.ok(r.isError, 'expected isError for non-running app');
      const data = jsonText(r);
      assert.ok(data.error, `expected error string, got: ${JSON.stringify(data)}`);
    });

    await test('desktop: discover_surfaces is exposed and returns an envelope', async () => {
      const list = await client.listTools();
      assert.ok(list.tools.find(t => t.name === 'discover_surfaces'), 'discover_surfaces should be listed');

      const r = await client.callTool({ name: 'discover_surfaces', arguments: { skipCDP: true } });
      assert.ok(!r.isError, `discover_surfaces returned error: ${JSON.stringify(jsonText(r))}`);
      const data = jsonText(r);
      assert.ok(data.summary, 'envelope must include a summary');
      assert.ok(Array.isArray(data.desktop_apps) && data.desktop_apps.length > 0, 'desktop_apps should be populated from the bundled registry');
      assert.ok(Array.isArray(data.cli_tools), 'cli_tools must be an array');
      assert.ok(Array.isArray(data.manifests), 'manifests must be an array');
      assert.ok(data.intents && typeof data.intents === 'object', 'intents must be an index object');
    });

    await test('desktop: discover_surfaces intent filter narrows to providers', async () => {
      const r = await client.callTool({
        name: 'discover_surfaces',
        arguments: { intent: 'messaging.send', skipCDP: true },
      });
      assert.ok(!r.isError);
      const data = jsonText(r);
      assert.deepStrictEqual(data.filter, { intent: 'messaging.send' });
      assert.ok(Array.isArray(data.providers), 'providers must be an array');
      assert.ok(data.providers.find(p => p.app === 'Slack'), `expected Slack to provide messaging.send; got ${JSON.stringify(data.providers)}`);
    });

    await test('desktop: discover_surfaces intent filter on unknown intent yields empty + hint', async () => {
      const r = await client.callTool({
        name: 'discover_surfaces',
        arguments: { intent: 'totally.fictional.intent', skipCDP: true },
      });
      assert.ok(!r.isError);
      const data = jsonText(r);
      assert.strictEqual(data.providers.length, 0);
      assert.ok(/Available intents/.test(data.note), `note should list known intents; got: ${data.note}`);
    });

    await test('desktop: wallet_list returns the wallet envelope', async () => {
      const r = await client.callTool({ name: 'wallet_list', arguments: {} });
      assert.ok(!r.isError);
      const data = jsonText(r);
      assert.ok(data.wallet_path && data.wallet_path.endsWith('wallet.json'));
      assert.ok(Array.isArray(data.providers));
    });

    await test('desktop: wallet_revoke on unknown provider returns revoked:false', async () => {
      const r = await client.callTool({ name: 'wallet_revoke', arguments: { provider: 'no-such-provider.example' } });
      assert.ok(!r.isError);
      const data = jsonText(r);
      assert.strictEqual(data.revoked, false);
    });

    await test('desktop: dispatch_intent on unknown intent returns clean error', async () => {
      const r = await client.callTool({ name: 'dispatch_intent', arguments: { intent: 'no.such.intent' } });
      assert.ok(r.isError);
      const data = jsonText(r);
      assert.ok(/No provider found/.test(data.error), `unexpected error: ${data.error}`);
    });
  } finally {
    await close();
  }
}

// ════════════════════════════════════════════════
//  Run
// ════════════════════════════════════════════════
(async () => {
  console.log('=== CLI MCP server ===');
  await testCli();
  console.log('\n=== API MCP server ===');
  await testApi();
  console.log('\n=== Desktop MCP server ===');
  await testDesktop();

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('\nHarness failure:', e);
  process.exit(2);
});
