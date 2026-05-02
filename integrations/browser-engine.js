/**
 * AgentDOM — Shared Browser Engine
 * Reusable Puppeteer session manager for all integrations.
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteerExtra.use(StealthPlugin());

const AGENTDOM_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'agentdom.js'), 'utf-8');

class BrowserSession {
  constructor(id, opts = {}) {
    this.id = id;
    this.browser = null;
    this.page = null;
    this.opts = { headless: true, viewport: { width: 1280, height: 800 }, ...opts };
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
  }

  async init() {
    this.browser = await puppeteerExtra.launch({
      headless: this.opts.headless,
      defaultViewport: this.opts.viewport,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.page = await this.browser.newPage();
    await this.page.evaluateOnNewDocument(AGENTDOM_SCRIPT);
    return this;
  }

  touch() { this.lastUsed = Date.now(); }

  async eval(fn, args = [], timeout = 15000) {
    this.touch();
    return Promise.race([
      this.page.evaluate(fn, ...args),
      new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), timeout)),
    ]);
  }

  async browse(url) {
    this.touch();
    const target = url.startsWith('http') ? url : `https://${url}`;
    await this.page.goto(target, { waitUntil: 'networkidle2', timeout: 30000 });
    return this.eval(() => AgentDOM.scan());
  }

  async scan() { return this.eval(() => AgentDOM.scan()); }

  async click(sel) {
    await this.eval(async s => await AgentDOM.click(s), [sel]);
    await this.page.waitForNetworkIdle({ timeout: 2000 }).catch(() => {});
    return { clicked: sel, url: this.page.url(), title: await this.page.title() };
  }

  async type(sel, text) {
    await this.eval(async (s, t) => await AgentDOM.type(s, t), [sel, text]);
    return { typed: text, into: sel };
  }

  async fillForm(formSel, data) {
    const sel = /^[a-zA-Z_][\w-]*$/.test(formSel) ? '#' + formSel : formSel;
    await this.eval(async (s, d) => await AgentDOM.fillForm(s, d), [sel, data]);
    return { filled: sel, fields: Object.keys(data).length };
  }

  async submitForm(formSel) {
    const sel = /^[a-zA-Z_][\w-]*$/.test(formSel) ? '#' + formSel : formSel;
    await this.eval(async s => await AgentDOM.submitForm(s), [sel]);
    await this.page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
    return { submitted: sel, url: this.page.url(), title: await this.page.title() };
  }

  async readText(sel = 'body') {
    return this.eval(s => document.querySelector(s)?.innerText?.slice(0, 5000) || 'Not found', [sel]);
  }

  async screenshot(fullPage = false) {
    this.touch();
    return this.page.screenshot({ fullPage, encoding: 'base64' });
  }

  async scroll(px) {
    await this.eval(async n => await AgentDOM.scroll({ by: n }), [px]);
    return { scrolled: px };
  }

  async scrollTo(sel) {
    await this.eval(async s => await AgentDOM.scrollTo(s), [sel]);
    return { scrolledTo: sel };
  }

  async hover(sel) {
    await this.eval(async s => await AgentDOM.hover(s, 500), [sel]);
    return { hovered: sel };
  }

  async pressKey(key) {
    await this.page.keyboard.press(key);
    return { pressed: key };
  }

  async waitFor(sel, timeout = 10000) {
    await this.page.waitForSelector(sel, { visible: true, timeout });
    return { found: sel };
  }

  async waitForText(text, timeout = 10000) {
    await this.page.waitForFunction(t => document.body.textContent.includes(t), { timeout }, text);
    return { found: text };
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }

  info() {
    return {
      id: this.id,
      url: this.page?.url() || null,
      createdAt: this.createdAt,
      lastUsed: this.lastUsed,
    };
  }
}

// Session pool
class SessionPool {
  constructor(maxSessions = 5) {
    this.sessions = new Map();
    this.max = maxSessions;
  }

  async get(id, opts) {
    if (this.sessions.has(id)) {
      const s = this.sessions.get(id);
      s.touch();
      return s;
    }
    if (this.sessions.size >= this.max) {
      // Evict oldest
      let oldest = null;
      for (const [k, v] of this.sessions) {
        if (!oldest || v.lastUsed < oldest.lastUsed) oldest = v;
      }
      if (oldest) { await oldest.close(); this.sessions.delete(oldest.id); }
    }
    const session = await new BrowserSession(id, opts).init();
    this.sessions.set(id, session);
    return session;
  }

  async remove(id) {
    const s = this.sessions.get(id);
    if (s) { await s.close(); this.sessions.delete(id); }
  }

  async closeAll() {
    for (const [, s] of this.sessions) await s.close();
    this.sessions.clear();
  }

  list() {
    return [...this.sessions.values()].map(s => s.info());
  }
}

// Tool definitions in a platform-agnostic format
const TOOL_DEFS = [
  { name: 'browse', desc: 'Navigate to a URL and return the page schema with all interactive elements (forms, buttons, links).', params: { url: { type: 'string', desc: 'URL to navigate to', required: true } } },
  { name: 'scan', desc: 'Read the current page and return a structured schema of all forms, actions, and links.', params: {} },
  { name: 'click', desc: 'Click an element using its CSS selector. Simulates human-like mouse events.', params: { selector: { type: 'string', desc: 'CSS selector of element to click', required: true } } },
  { name: 'type_text', desc: 'Type text into an input field with realistic keystroke timing.', params: { selector: { type: 'string', desc: 'CSS selector of the input', required: true }, text: { type: 'string', desc: 'Text to type', required: true } } },
  { name: 'fill_form', desc: 'Fill an entire form with data. Handles inputs, selects, checkboxes.', params: { form_selector: { type: 'string', desc: 'CSS selector of the form', required: true }, data: { type: 'object', desc: 'Field name to value mapping', required: true } } },
  { name: 'submit_form', desc: 'Submit a form by clicking its submit button.', params: { form_selector: { type: 'string', desc: 'CSS selector of the form', required: true } } },
  { name: 'read_text', desc: 'Get visible text content of an element or full page.', params: { selector: { type: 'string', desc: 'CSS selector (default: body)' } } },
  { name: 'screenshot', desc: 'Take a screenshot of the current page. Returns base64 PNG.', params: { full_page: { type: 'boolean', desc: 'Capture full scrollable page' } } },
  { name: 'scroll', desc: 'Scroll the page by pixels or to a specific element.', params: { pixels: { type: 'number', desc: 'Pixels to scroll (positive=down)' }, to_selector: { type: 'string', desc: 'CSS selector to scroll to' } } },
  { name: 'hover', desc: 'Hover over an element to trigger tooltips or dropdowns.', params: { selector: { type: 'string', desc: 'CSS selector to hover', required: true } } },
  { name: 'press_key', desc: 'Press a keyboard key (Enter, Tab, Escape, etc).', params: { key: { type: 'string', desc: 'Key name', required: true } } },
  { name: 'wait', desc: 'Wait for an element or text to appear on the page.', params: { selector: { type: 'string', desc: 'CSS selector to wait for' }, text: { type: 'string', desc: 'Text to wait for' }, timeout: { type: 'number', desc: 'Max wait ms (default 10000)' } } },
  { name: 'goal', desc: 'Autonomous mode: give a natural language goal and the AI plans and executes all steps automatically.', params: { objective: { type: 'string', desc: 'What you want to achieve', required: true }, url: { type: 'string', desc: 'Starting URL (optional if already browsing)' } } },
];

module.exports = { BrowserSession, SessionPool, TOOL_DEFS, AGENTDOM_SCRIPT };
