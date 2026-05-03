/**
 * Compiler smoke test — exercises every adapter through the full pipeline.
 * Run: node compiler/__test__.js
 * Exits non-zero on the first failed assertion.
 */

'use strict';

const assert = require('assert');
const { compile } = require('./index');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
}

// ─── desktop ───────────────────────────────────────────────────────────────
test('desktop: empty scan → empty IR', () => {
  const { ir, tools } = compile([], { from: 'desktop', appName: 'X' });
  assert.deepStrictEqual(ir.actions, []);
  assert.deepStrictEqual(ir.forms, []);
  assert.deepStrictEqual(tools, []);
});

test('desktop: auth form synthesis + intent inference + slugged params', () => {
  const scan = [
    { type: 'text_input', label: 'Email Address', enabled: true, path: 'w/0' },
    { type: 'text_input', label: 'Password', enabled: true, path: 'w/1' },
    { type: 'button', label: 'Sign In', enabled: true, path: 'w/2' },
  ];
  const { ir, tools } = compile(scan, { from: 'desktop', appName: 'TestApp' });
  assert.strictEqual(ir.forms.length, 1, 'one form');
  assert.strictEqual(ir.forms[0].intent, 'authenticate');
  assert.strictEqual(ir.forms[0].fields.length, 2);
  // Names are slugged for agent-friendly identifiers; labels keep originals for AX dispatch.
  assert.deepStrictEqual(ir.forms[0].fields.map(f => f.name).sort(), ['email_address', 'password']);
  assert.deepStrictEqual(ir.forms[0].fields.map(f => f.label).sort(), ['Email Address', 'Password']);
  const auth = tools.find(t => t.function.name === 'authenticate');
  assert.ok(auth, 'authenticate tool emitted');
  assert.deepStrictEqual(Object.keys(auth.function.parameters.properties).sort(), ['email_address', 'password']);
});

test('codegen: form without intent uses invoke_<submit-label>', () => {
  const help = `
Flags:
  -v, --verbose         Be loud
`;
  const { tools } = compile(help, { from: 'cli', command: 'mycli' });
  // CLI form has no intent, submit label = command name → invoke_mycli.
  assert.ok(tools.find(t => t.function.name === 'invoke_mycli'), `tools: ${tools.map(t => t.function.name).join(', ')}`);
});

test('desktop: dead elements stripped (disabled, empty-label)', () => {
  const scan = [
    { type: 'button', label: 'OK', enabled: true, path: 'p1' },
    { type: 'button', label: '', enabled: true, path: 'p2' },
    { type: 'button', label: 'Disabled', enabled: false, path: 'p3' },
  ];
  const { ir } = compile(scan, { from: 'desktop', appName: 'X' });
  assert.strictEqual(ir.actions.length, 1);
  assert.strictEqual(ir.actions[0].label, 'OK');
});

test('desktop: state extracted from checkboxes', () => {
  const scan = [{ type: 'checkbox', label: 'Remember me', enabled: true, value: false, path: 'p' }];
  const { ir } = compile(scan, { from: 'desktop', appName: 'X' });
  assert.strictEqual(ir.state.length, 1);
  assert.strictEqual(ir.state[0].name, 'Remember me');
});

test('desktop: links + menus routed to navigation', () => {
  const scan = [
    { type: 'link', label: 'Forgot?', value: 'https://x', enabled: true, path: 'p' },
    { type: 'menu', label: 'File', enabled: true, path: 'm' },
  ];
  const { ir, tools } = compile(scan, { from: 'desktop', appName: 'X' });
  assert.strictEqual(ir.navigation.length, 2);
  assert.ok(tools.find(t => t.function.name === 'navigate'));
});

test('desktop: _meta marker stripped from actions but preserved in meta', () => {
  const scan = [
    { type: '_meta', framework: 'electron', label: '__electron_warning__' },
    { type: 'button', label: 'OK', enabled: true, path: 'p' },
  ];
  const { ir } = compile(scan, { from: 'desktop', appName: 'X' });
  assert.strictEqual(ir.meta.framework, 'electron');
  assert.ok(!ir.actions.find(a => a.type === '_meta'));
});

// ─── web ───────────────────────────────────────────────────────────────────
test('web: scanPage shape → IR', () => {
  const scan = {
    page: {
      meta: { title: 'Login', url: 'https://x.com/login' },
      forms: [{
        id: 'login',
        method: 'POST',
        intent: 'authenticate',
        fields: [
          { name: 'email', type: 'email', required: true, label: 'Email', value: '', selector: '#e' },
          { name: 'pw', type: 'password', required: true, label: 'Password', value: '', selector: '#p' },
        ],
        submitButton: { selector: '#submit', label: 'Sign In' },
      }],
      actions: [{ label: 'Forgot?', selector: '#f', tag: 'a', href: 'https://x.com/forgot', intent: null, disabled: false, covered: false }],
    },
  };
  const { ir, tools } = compile(scan, { from: 'web' });
  assert.strictEqual(ir.meta.platform, 'web');
  assert.strictEqual(ir.forms.length, 1);
  assert.deepStrictEqual(ir.forms[0].submitAction.sideEffects, ['create']);
  assert.strictEqual(ir.navigation.length, 1, 'a[href] → navigation');
  assert.ok(tools.find(t => t.function.name === 'authenticate'));
});

// ─── cli ───────────────────────────────────────────────────────────────────
test('cli: Cobra-style help → subcommands + flags', () => {
  const help = `
Available Commands:
  add         Add a file
  list        List files

Flags:
  -v, --verbose         Enable verbose output
  -c, --config FILE     Config file path
      --color WHEN      Colorize output
`;
  const { ir, tools } = compile(help, { from: 'cli', command: 'mycli' });
  assert.strictEqual(ir.actions.length, 2, 'add + list');
  assert.strictEqual(ir.forms[0].fields.length, 3, 'verbose + config + color');
  const flagNames = ir.forms[0].fields.map(f => f.name).sort();
  assert.deepStrictEqual(flagNames, ['color', 'config', 'verbose']);
  assert.ok(tools.length >= 2);
});

test('cli: section header variations match', () => {
  const help = `
Basic Commands (Beginner):
  run         Run something

Global Flags:
  -h, --help            Show help
`;
  const { ir } = compile(help, { from: 'cli', command: 'k' });
  assert.strictEqual(ir.actions.length, 1);
  assert.strictEqual(ir.forms[0].fields.length, 1);
});

// ─── api ───────────────────────────────────────────────────────────────────
test('api: OpenAPI 3.x → operations + intents', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Pet Store', version: '1.0' },
    paths: {
      '/pets': {
        get: { operationId: 'listPets', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] },
        post: {
          operationId: 'createPet',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer' } } } } } },
        },
      },
      '/pets/{id}': {
        delete: { operationId: 'deletePet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
      },
    },
  };
  const { ir, tools } = compile(spec, { from: 'api' });
  assert.strictEqual(ir.actions.length, 3);
  const intents = ir.actions.map(a => a.intent).sort();
  assert.deepStrictEqual(intents, ['create', 'delete', 'search']);

  const createForm = ir.forms.find(f => f.id === 'createPet');
  assert.ok(createForm);
  const nameField = createForm.fields.find(f => f.name === 'name');
  assert.ok(nameField.required);
  assert.strictEqual(nameField.type, 'string');
  const ageField = createForm.fields.find(f => f.name === 'age');
  assert.strictEqual(ageField.type, 'number');

  // GET should have no side-effects, others should
  const getOp = ir.actions.find(a => a.label === 'listPets');
  assert.deepStrictEqual(getOp.sideEffects, []);
  const postOp = ir.actions.find(a => a.label === 'createPet');
  assert.deepStrictEqual(postOp.sideEffects, ['create']);
});

test('api: $ref body schemas resolve', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'X' },
    components: { schemas: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        },
      },
    },
  };
  const { ir } = compile(spec, { from: 'api' });
  const form = ir.forms[0];
  assert.ok(form.fields.find(f => f.name === 'name' && f.required));
});

// ─── codegen targets ───────────────────────────────────────────────────────
test('mcp target: emits MCP-shape tools (inputSchema, no function wrapper)', () => {
  const scan = [
    { type: 'text_input', label: 'Email', enabled: true, path: 'p1' },
    { type: 'button', label: 'Sign In', enabled: true, path: 'p2' },
  ];
  const { tools } = compile(scan, { from: 'desktop', to: 'mcp', appName: 'X' });
  assert.ok(tools.length > 0);
  for (const t of tools) {
    assert.ok(t.name, 'has name');
    assert.ok(t.description, 'has description');
    assert.ok(t.inputSchema, 'has inputSchema');
    assert.strictEqual(t.inputSchema.type, 'object');
    assert.ok(!t.function, 'no function wrapper');
    assert.ok(!t.parameters, 'no top-level parameters key');
  }
});

test('mcp target: same tool count as openai target', () => {
  const spec = {
    openapi: '3.0.0', info: { title: 'X' },
    paths: { '/x': { get: { operationId: 'getX' }, post: { operationId: 'createX' } } },
  };
  const a = compile(spec, { from: 'api', to: 'openai' });
  const b = compile(spec, { from: 'api', to: 'mcp' });
  assert.strictEqual(a.tools.length, b.tools.length);
  assert.deepStrictEqual(
    a.tools.map(t => t.function.name).sort(),
    b.tools.map(t => t.name).sort(),
  );
});

// ─── invalid input ─────────────────────────────────────────────────────────
test('compile: unknown source rejected', () => {
  assert.throws(() => compile([], { from: 'unicorn' }), /Unknown source/);
});

test('compile: unknown target rejected', () => {
  assert.throws(() => compile([], { from: 'desktop', to: 'cobol' }), /Unknown target/);
});

// ─── summary ───────────────────────────────────────────────────────────────
process.stdout.write(`\n${n - failed}/${n} passed\n`);
process.exit(failed > 0 ? 1 : 0);
