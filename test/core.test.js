const { describe, it } = require('node:test');
const assert = require('node:assert');

// Minimal DOM shims for Node.js testing
globalThis.document = {
  title: 'Test Page',
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { textContent: '', innerText: '', appendChild: () => {}, scrollTop: 0 },
  documentElement: { lang: 'en' },
  createElement: (tag) => ({ style: {}, tagName: tag.toUpperCase() }),
  elementFromPoint: () => null,
  activeElement: { id: 'test', tagName: 'INPUT' },
};
globalThis.window = globalThis;
globalThis.location = { href: 'https://test.com', host: 'test.com' };
globalThis.scrollX = 0;
globalThis.scrollY = 0;
globalThis.innerWidth = 1024;
globalThis.innerHeight = 768;
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
globalThis.HTMLInputElement = { prototype: {} };
globalThis.HTMLTextAreaElement = { prototype: {} };
globalThis.MouseEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.PointerEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.KeyboardEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.FocusEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.WheelEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.Touch = class { constructor(o) { Object.assign(this, o); } };
globalThis.TouchEvent = class extends Event { constructor(t, o) { super(t, o); } };
globalThis.history = { back: () => {}, forward: () => {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Now load AgentDOM (uses module.exports in Node)
const AgentDOM = require('../agentdom.js');

describe('AgentDOM Core API', () => {

  it('exports version 3.0.0', () => {
    assert.strictEqual(AgentDOM.version, '3.0.0');
  });

  it('exposes all action methods', () => {
    const actions = ['click', 'type', 'hover', 'scroll', 'select', 'fillForm', 'submitForm', 'waitFor', 'navigate', 'dblClick', 'rightClick', 'pressKey', 'scrollTo', 'drag', 'back', 'forward', 'moveTo', 'check', 'snapshot'];
    for (const action of actions) {
      assert.strictEqual(typeof AgentDOM[action], 'function', `Missing: ${action}`);
    }
  });

  it('exposes schema functions', () => {
    assert.strictEqual(typeof AgentDOM.scan, 'function');
    assert.strictEqual(typeof AgentDOM.synthesizeTools, 'function');
    assert.strictEqual(typeof AgentDOM.scanWithTools, 'function');
    assert.strictEqual(typeof AgentDOM.dump, 'function');
    assert.strictEqual(typeof AgentDOM.dumpTools, 'function');
  });

  it('exposes CLI functions', () => {
    assert.strictEqual(typeof AgentDOM.exec, 'function');
    assert.strictEqual(typeof AgentDOM.run, 'function');
  });

  it('log returns array', () => {
    const log = AgentDOM.log();
    assert.ok(Array.isArray(log));
  });

  it('cursor has show/hide', () => {
    assert.strictEqual(typeof AgentDOM.cursor.show, 'function');
    assert.strictEqual(typeof AgentDOM.cursor.hide, 'function');
  });

  it('scan returns valid schema', () => {
    const schema = AgentDOM.scan();
    assert.strictEqual(schema._aidl, '3.0.0');
    assert.ok(schema.generatedAt);
    assert.ok(schema.page);
    assert.ok(schema.page.meta);
    assert.strictEqual(schema.page.meta.title, 'Test Page');
    assert.strictEqual(schema.page.meta.url, 'https://test.com');
    assert.ok(Array.isArray(schema.page.forms));
    assert.ok(Array.isArray(schema.page.actions));
  });

  it('snapshot returns page state', () => {
    const snap = AgentDOM.snapshot();
    assert.strictEqual(snap.url, 'https://test.com');
    assert.strictEqual(snap.title, 'Test Page');
    assert.ok(snap.viewport);
    assert.strictEqual(snap.viewport.w, 1024);
  });
});

describe('Tool Synthesis — Empty Page', () => {

  it('handles empty schema', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: { meta: {}, forms: [], actions: [] }
    });
    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.length >= 6, 'Should have at least 6 base tools');
  });

  it('classifies empty page as static', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: { meta: { title: 'Hello' }, forms: [], actions: [] }
    });
    assert.strictEqual(result.page_type, 'static');
  });

  it('generates summary with page title', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: { meta: { title: 'My App' }, forms: [], actions: [] }
    });
    assert.ok(result.summary.includes('My App'));
  });

  it('always includes base tools', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: { meta: {}, forms: [], actions: [] }
    });
    const names = result.tools.map(t => t.name);
    assert.ok(names.includes('scan_page'));
    assert.ok(names.includes('take_screenshot'));
    assert.ok(names.includes('read_page_text'));
    assert.ok(names.includes('scroll_page'));
    assert.ok(names.includes('go_to_url'));
    assert.ok(names.includes('press_key'));
  });
});

describe('Tool Synthesis — Login Form', () => {
  const loginSchema = {
    _aidl: '3.0.0',
    page: {
      meta: { title: 'Login' },
      forms: [{
        id: 'login-form', method: 'POST', intent: 'authenticate',
        fields: [
          { name: 'email', type: 'email', required: true, label: 'Email', selector: '#email' },
          { name: 'password', type: 'password', required: true, label: 'Password', selector: '#pass' },
        ],
        submitButton: { selector: '#submit', label: 'Log In' },
      }],
      actions: [],
    }
  };

  it('generates login tool', () => {
    const result = AgentDOM.synthesizeTools(loginSchema);
    const tool = result.tools.find(t => t.name === 'login');
    assert.ok(tool, 'Should create "login" tool from authenticate intent');
  });

  it('login tool has correct parameters', () => {
    const result = AgentDOM.synthesizeTools(loginSchema);
    const tool = result.tools.find(t => t.name === 'login');
    assert.ok(tool.params.email);
    assert.ok(tool.params.password);
    assert.strictEqual(tool.params.email.type, 'string');
    assert.strictEqual(tool.params.email.required, true);
  });

  it('classifies as login page', () => {
    const result = AgentDOM.synthesizeTools(loginSchema);
    assert.strictEqual(result.page_type, 'login');
  });
});

describe('Tool Synthesis — Search Form', () => {
  it('generates search tool', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: { title: 'Search' },
        forms: [{
          id: 'search', intent: 'search',
          fields: [{ name: 'q', type: 'search', required: true, label: 'Search', selector: '#q' }],
          submitButton: { selector: '#go', label: 'Go' },
        }],
        actions: [],
      }
    });
    const tool = result.tools.find(t => t.name === 'search');
    assert.ok(tool);
    assert.ok(tool.params.q);
  });

  it('classifies as search page', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: { title: 'Search' },
        forms: [{ intent: 'search', fields: [{ name: 'q', type: 'text' }], submitButton: null }],
        actions: [],
      }
    });
    assert.strictEqual(result.page_type, 'search');
  });
});

describe('Tool Synthesis — Navigation', () => {
  it('generates navigate_to from links', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: {},
        forms: [],
        actions: [
          { tag: 'a', label: 'About', href: '/about', intent: null, disabled: false, covered: false, selector: '#a' },
          { tag: 'a', label: 'Pricing', href: '/pricing', intent: null, disabled: false, covered: false, selector: '#p' },
        ],
      }
    });
    const tool = result.tools.find(t => t.name === 'navigate_to');
    assert.ok(tool);
    assert.ok(tool.params.destination.enum.includes('About'));
    assert.ok(tool.params.destination.enum.includes('Pricing'));
  });
});

describe('Tool Synthesis — Actions', () => {
  it('skips disabled actions', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: {},
        forms: [],
        actions: [
          { tag: 'button', label: 'Active', intent: 'dismiss', disabled: false, covered: false, selector: '#a' },
          { tag: 'button', label: 'Disabled', intent: 'dismiss', disabled: true, covered: false, selector: '#b' },
        ],
      }
    });
    const tool = result.tools.find(t => t.name === 'dismiss');
    assert.ok(tool);
  });

  it('skips covered actions', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: {},
        forms: [],
        actions: [
          { tag: 'button', label: 'Covered', intent: 'search', disabled: false, covered: true, selector: '#c' },
        ],
      }
    });
    const tool = result.tools.find(t => t.name === 'search');
    assert.ok(!tool, 'Should not create tool for covered button');
  });

  it('deduplicates tools', () => {
    const result = AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: {},
        forms: [],
        actions: [
          { tag: 'button', label: 'Search A', intent: 'search', disabled: false, covered: false, selector: '#a' },
          { tag: 'button', label: 'Search B', intent: 'search', disabled: false, covered: false, selector: '#b' },
        ],
      }
    });
    const searchTools = result.tools.filter(t => t.name === 'search');
    assert.strictEqual(searchTools.length, 1);
  });
});

describe('Tool Synthesis — Page Classification', () => {
  const classify = (intent) => {
    return AgentDOM.synthesizeTools({
      _aidl: '3.0.0',
      page: {
        meta: { title: 'Test' },
        forms: [{ intent, fields: [{ name: 'f', type: 'text' }], submitButton: null }],
        actions: [],
      }
    }).page_type;
  };

  it('classifies authenticate → login', () => assert.strictEqual(classify('authenticate'), 'login'));
  it('classifies register → registration', () => assert.strictEqual(classify('register'), 'registration'));
  it('classifies search → search', () => assert.strictEqual(classify('search'), 'search'));
  it('classifies purchase → checkout', () => assert.strictEqual(classify('purchase'), 'checkout'));
  it('classifies subscribe → subscription', () => assert.strictEqual(classify('subscribe'), 'subscription'));
});

describe('CLI Command Parser', () => {
  it('rejects unknown commands', async () => {
    await assert.rejects(() => AgentDOM.exec('unknowncommand'), /Unknown command/);
  });

  it('rejects malformed type', async () => {
    await assert.rejects(() => AgentDOM.exec('type badformat'), /Usage: type/);
  });

  it('rejects malformed select', async () => {
    await assert.rejects(() => AgentDOM.exec('select badformat'), /Usage: select/);
  });
});

describe('scanWithTools', () => {
  it('returns schema + tools combined', () => {
    const result = AgentDOM.scanWithTools();
    assert.ok(result._aidl);
    assert.ok(result.page);
    assert.ok(result.tools);
    assert.ok(result.page_type);
    assert.ok(result.tool_summary);
  });

  it('tools have no _internal in public output', () => {
    const result = AgentDOM.scanWithTools();
    for (const tool of result.tools) {
      assert.ok(!tool._internal, `Tool ${tool.name} should not expose _internal`);
    }
  });

  it('_tool_internals has full tools', () => {
    const result = AgentDOM.scanWithTools();
    assert.ok(result._tool_internals);
    for (const tool of result._tool_internals) {
      assert.ok(tool._internal, `Internal tool ${tool.name} should have _internal`);
    }
  });
});
