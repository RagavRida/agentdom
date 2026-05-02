#!/usr/bin/env node
/**
 * AgentDOM — Agent-Native Platform SDK
 * 
 * A unified runtime that any AI agent can plug into.
 * Combines web + desktop + system into one discoverable, composable API.
 * 
 * Architecture:
 *   Agent → AgentPlatform.discover() → capabilities[]
 *   Agent → AgentPlatform.execute(action) → result
 *   Agent → AgentPlatform.observe() → current state
 *   Agent → AgentPlatform.plan(goal) → action[]
 */

'use strict';

const desktop = require('./desktop-agent');
const instant = require('./desktop-agent/instant');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ══════════════════════════════════════════
//  Agent Session — tracks state across calls
// ══════════════════════════════════════════

class AgentSession {
  constructor(id) {
    this.id = id || `session_${Date.now()}`;
    this.activeApp = null;
    this.history = [];
    this.state = {};
    this.startedAt = new Date().toISOString();
    try { this.activeApp = desktop.getFrontApp(); } catch {}
  }

  log(action, result) {
    this.history.push({ ts: Date.now(), action, result: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 200) });
    if (this.history.length > 100) this.history.shift();
  }

  getContext() {
    return {
      sessionId: this.id,
      activeApp: this.activeApp,
      platform: os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux',
      stepCount: this.history.length,
      lastActions: this.history.slice(-5).map(h => h.action),
    };
  }
}

// ══════════════════════════════════════════
//  Capability Registry
// ══════════════════════════════════════════

const CAPABILITIES = {
  // ── App Control ──
  list_apps: {
    category: 'app_control', description: 'List all running applications',
    params: {},
    execute: (_, session) => { const apps = desktop.listApps(); return { apps: apps.filter(a => a.wins > 0) }; },
  },
  open_app: {
    category: 'app_control', description: 'Launch an application by name',
    params: { app: { type: 'string', required: true, description: 'App name (e.g., Safari, Slack)' } },
    execute: ({ app }, session) => { desktop.openApp(app); session.activeApp = app; return { opened: app }; },
  },
  focus_app: {
    category: 'app_control', description: 'Switch to an application (background, no visual activation)',
    params: { app: { type: 'string', required: true } },
    execute: ({ app }, session) => { desktop.activate(app); session.activeApp = app; return { focused: app }; },
  },

  // ── Observe (Read UI) ──
  scan: {
    category: 'observe', description: 'Scan an app to discover all interactive UI elements',
    params: { app: { type: 'string', description: 'App name. Uses active app if omitted.' } },
    execute: ({ app }, session) => {
      const target = app || session.activeApp;
      const elements = desktop.scanApp(target);
      if (elements.error) return elements;
      return {
        app: target,
        elements: elements.length,
        buttons: elements.filter(e => e.type === 'button').map(e => ({ label: e.label, description: e.description })),
        inputs: elements.filter(e => ['text_input','text_area','search_field','combo_box'].includes(e.type)).map(e => ({ label: e.label, description: e.description, value: e.value })),
        menus: elements.filter(e => e.type === 'menu').map(e => e.label),
        menuItems: elements.filter(e => e.type === 'menu_item').map(e => ({ label: e.label, description: e.description })).slice(0, 50),
        checkboxes: elements.filter(e => e.type === 'checkbox').map(e => ({ label: e.label, checked: !!e.value })),
        _raw: elements,
      };
    },
  },
  get_tools: {
    category: 'observe', description: 'Auto-synthesize callable tools from an app\'s UI',
    params: { app: { type: 'string' } },
    execute: ({ app }, session) => {
      const elements = desktop.scanApp(app || session.activeApp);
      return { tools: desktop.synthesizeTools(elements) };
    },
  },

  // ── Interact ──
  click: {
    category: 'interact', description: 'Click a button or element by its label (silent, via accessibility API)',
    params: { label: { type: 'string', required: true }, app: { type: 'string' } },
    execute: ({ label, app }, session) => desktop.clickElement(app || session.activeApp, label),
  },
  click_at: {
    category: 'interact', description: 'Click at screen coordinates',
    params: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
    execute: ({ x, y }) => { desktop.clickAt(x, y); return { clicked: true, x, y }; },
  },
  type: {
    category: 'interact', description: 'Type text into the currently focused field',
    params: { text: { type: 'string', required: true }, app: { type: 'string' } },
    execute: ({ text, app }, session) => { desktop.typeText(app || session.activeApp, text); return { typed: text }; },
  },
  type_field: {
    category: 'interact', description: 'Type text into a specific named field (silent, via AXSetValue)',
    params: { field: { type: 'string', required: true }, text: { type: 'string', required: true }, app: { type: 'string' } },
    execute: ({ field, text, app }, session) => desktop.typeIntoField(app || session.activeApp, field, text),
  },
  press: {
    category: 'interact', description: 'Press a keyboard shortcut (e.g., cmd+s, enter, tab)',
    params: { shortcut: { type: 'string', required: true }, app: { type: 'string' } },
    execute: ({ shortcut, app }, session) => { desktop.pressKeys(app || session.activeApp, shortcut); return { pressed: shortcut }; },
  },
  menu: {
    category: 'interact', description: 'Click a menu item (e.g., "File > Save As")',
    params: { path: { type: 'string', required: true }, app: { type: 'string' } },
    execute: ({ path: p, app }, session) => desktop.clickMenu(app || session.activeApp, p),
  },

  // ── Navigate ──
  scroll: {
    category: 'navigate', description: 'Scroll in an app window',
    params: { direction: { type: 'string', required: true, enum: ['up','down','left','right'] }, amount: { type: 'number' }, app: { type: 'string' } },
    execute: ({ direction, amount, app }, session) => { desktop.scroll(app || session.activeApp, direction, amount || 5); return { scrolled: direction }; },
  },
  scroll_to: {
    category: 'navigate', description: 'Scroll to top or bottom',
    params: { position: { type: 'string', required: true, enum: ['top','bottom'] }, app: { type: 'string' } },
    execute: ({ position, app }, session) => { desktop.scrollTo(app || session.activeApp, position); return { scrolled_to: position }; },
  },
  drag: {
    category: 'navigate', description: 'Drag from one point to another',
    params: { fromX: { type: 'number', required: true }, fromY: { type: 'number', required: true }, toX: { type: 'number', required: true }, toY: { type: 'number', required: true } },
    execute: ({ fromX, fromY, toX, toY }) => { desktop.drag(fromX, fromY, toX, toY); return { dragged: true }; },
  },

  // ── System (Instant/Headless) ──
  exec: {
    category: 'system', description: 'Execute a shell command and return output',
    params: { command: { type: 'string', required: true } },
    execute: ({ command }) => instant.exec(command),
  },
  read_file: {
    category: 'system', description: 'Read a file\'s contents',
    params: { path: { type: 'string', required: true } },
    execute: ({ path: p }) => ({ content: instant.readFile(p) }),
  },
  write_file: {
    category: 'system', description: 'Write content to a file',
    params: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    execute: ({ path: p, content }) => instant.writeFile(p, content),
  },
  list_dir: {
    category: 'system', description: 'List directory contents',
    params: { path: { type: 'string' } },
    execute: ({ path: p }) => ({ entries: instant.listDir(p || os.homedir()) }),
  },
  search: {
    category: 'system', description: 'Search for files by pattern',
    params: { path: { type: 'string', required: true }, pattern: { type: 'string', required: true } },
    execute: ({ path: p, pattern }) => ({ results: instant.search(p, pattern) }),
  },
  clipboard_read: {
    category: 'system', description: 'Read clipboard contents',
    params: {},
    execute: () => ({ text: instant.getClipboard() }),
  },
  clipboard_write: {
    category: 'system', description: 'Write to clipboard',
    params: { text: { type: 'string', required: true } },
    execute: ({ text }) => { instant.setClipboard(text); return { copied: true }; },
  },
  system_info: {
    category: 'system', description: 'Get system information',
    params: {},
    execute: () => instant.systemInfo(),
  },
  open_url: {
    category: 'system', description: 'Open a URL in default browser',
    params: { url: { type: 'string', required: true } },
    execute: ({ url }) => instant.openUrl(url),
  },
  notify: {
    category: 'system', description: 'Send a desktop notification',
    params: { title: { type: 'string', required: true }, message: { type: 'string', required: true } },
    execute: ({ title, message }) => { instant.notify(title, message); return { sent: true }; },
  },
  speak: {
    category: 'system', description: 'Text-to-speech',
    params: { text: { type: 'string', required: true } },
    execute: ({ text }) => { instant.speak(text); return { spoken: true }; },
  },
  screenshot: {
    category: 'system', description: 'Take a screenshot of an app',
    params: { app: { type: 'string' }, filename: { type: 'string' } },
    execute: ({ app, filename }, session) => {
      const fp = path.resolve(filename || `screenshot_${Date.now()}.png`);
      desktop.screenshotApp(app || session.activeApp, fp);
      return { path: fp };
    },
  },
  create_note: {
    category: 'system', description: 'Create a note in Apple Notes',
    params: { title: { type: 'string', required: true }, body: { type: 'string', required: true } },
    execute: ({ title, body }) => { instant.createNote(title, body); return { created: true }; },
  },
  create_reminder: {
    category: 'system', description: 'Create a reminder',
    params: { title: { type: 'string', required: true }, due: { type: 'string' } },
    execute: ({ title, due }) => { instant.createReminder(title, due); return { created: true }; },
  },
  datetime: {
    category: 'system', description: 'Get current date and time',
    params: {},
    execute: () => instant.getDateTime(),
  },

  // ── Browser (Headless Safari Scripting) ──
  safari_open: {
    category: 'browser', description: 'Open URL in Safari via scripting API',
    params: { url: { type: 'string', required: true } },
    execute: ({ url }) => instant.safariOpenUrl(url),
  },
  safari_url: {
    category: 'browser', description: 'Get current Safari URL',
    params: {},
    execute: () => ({ url: instant.safariGetUrl() }),
  },
  safari_js: {
    category: 'browser', description: 'Execute JavaScript in Safari tab',
    params: { code: { type: 'string', required: true } },
    execute: ({ code }) => ({ result: instant.safariRunJs(code) }),
  },

  // ── Git ──
  git_status: {
    category: 'dev', description: 'Get git status of a repository',
    params: { path: { type: 'string', required: true } },
    execute: ({ path: p }) => instant.gitStatus(p),
  },
};

// ══════════════════════════════════════════
//  Agent Platform — Main API
// ══════════════════════════════════════════

class AgentPlatform {
  constructor() {
    this.sessions = new Map();
    this.capabilities = CAPABILITIES;
  }

  /** Create or get a session */
  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, new AgentSession(id));
    return this.sessions.get(id);
  }

  /** Discover all available capabilities — agent calls this first */
  discover(category) {
    const caps = Object.entries(this.capabilities);
    const filtered = category ? caps.filter(([_, c]) => c.category === category) : caps;
    return {
      platform: 'AgentDOM',
      version: '3.0.0',
      runtime: os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux',
      categories: [...new Set(Object.values(this.capabilities).map(c => c.category))],
      capabilities: filtered.map(([name, cap]) => ({
        name,
        category: cap.category,
        description: cap.description,
        params: cap.params,
      })),
    };
  }

  /** Execute a single action */
  execute(actionName, params = {}, sessionId = 'default') {
    const cap = this.capabilities[actionName];
    if (!cap) return { error: `Unknown action: ${actionName}`, available: Object.keys(this.capabilities) };

    // Validate required params
    for (const [key, schema] of Object.entries(cap.params)) {
      if (schema.required && !(key in params)) {
        return { error: `Missing required param: ${key}`, schema: cap.params };
      }
    }

    const session = this.session(sessionId);
    try {
      const result = cap.execute(params, session);
      session.log(actionName, result);
      return { success: true, action: actionName, result };
    } catch (e) {
      session.log(actionName, `ERROR: ${e.message}`);
      return { success: false, action: actionName, error: e.message };
    }
  }

  /** Observe current state — what the agent "sees" */
  observe(sessionId = 'default') {
    const session = this.session(sessionId);
    const info = instant.systemInfo();
    const apps = desktop.listApps().filter(a => a.wins > 0);

    return {
      context: session.getContext(),
      system: { hostname: info.hostname, memory: info.memory, uptime: info.uptime },
      apps: apps.map(a => ({ name: a.name, windows: a.wins, active: a.frontmost })),
      clipboard: instant.getClipboard()?.slice(0, 200) || null,
      time: instant.getDateTime(),
    };
  }

  /** Execute a sequence of actions (composable) */
  async batch(actions, sessionId = 'default') {
    const results = [];
    for (const action of actions) {
      const result = this.execute(action.name, action.params, sessionId);
      results.push(result);
      if (!result.success && action.stopOnError !== false) break;
      if (action.delay) await new Promise(r => setTimeout(r, action.delay));
    }
    return { results, completed: results.length, total: actions.length };
  }

  /** Export as OpenAI-compatible function definitions */
  toOpenAITools() {
    return Object.entries(this.capabilities).map(([name, cap]) => ({
      type: 'function',
      function: {
        name: `agentdom_${name}`,
        description: cap.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(cap.params).map(([k, v]) => [k, { type: v.type || 'string', description: v.description || k }])),
          required: Object.entries(cap.params).filter(([_, v]) => v.required).map(([k]) => k),
        },
      },
    }));
  }

  /** Export as MCP tool definitions */
  toMCPTools() {
    return Object.entries(this.capabilities).map(([name, cap]) => ({
      name,
      description: cap.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(cap.params).map(([k, v]) => [k, { type: v.type || 'string', description: v.description || k, ...(v.enum ? { enum: v.enum } : {}) }])),
        required: Object.entries(cap.params).filter(([_, v]) => v.required).map(([k]) => k),
      },
    }));
  }
}

// Singleton
const platform = new AgentPlatform();

module.exports = { AgentPlatform, AgentSession, platform, CAPABILITIES };
