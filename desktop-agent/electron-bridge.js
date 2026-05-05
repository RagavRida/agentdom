#!/usr/bin/env node
/**
 * AgentDOM Electron Bridge — DOM access for Electron apps via CDP.
 *
 * macOS AX trees only expose Electron menubars; the rendered web content lives
 * in a Chromium renderer. When the app is launched with --remote-debugging-port=N,
 * Chromium exposes CDP on http://localhost:N. This module attaches via
 * puppeteer-core and runs the same agentdom.js scanner that the web MCP uses,
 * so the same compiler pipeline (from-web → optimize → to-mcp) produces typed
 * tools for any Electron surface.
 *
 * Public surface mirrors the AX bridge: detect, attach, listTargets, scanWindow,
 * click, type, eval, dispose.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENTDOM_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'agentdom.js'), 'utf-8');

const DEFAULT_PROBE_PORTS = [9222, 9229, 9223, 9224, 9225];
const PROBE_TIMEOUT_MS = 600;

// Lazy require to avoid a circular import: launch.js requires this file via
// nothing (it doesn't), but keeping the lazy load means a fresh install
// without the commands/ dir wouldn't crash on import.
function loadLaunchModule() {
  try { return require('../commands/launch'); } catch { return null; }
}

let _puppeteer = null;
function loadPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try {
    _puppeteer = require('puppeteer-core');
  } catch {
    try { _puppeteer = require('puppeteer'); }
    catch {
      throw new Error('puppeteer-core (or puppeteer) is required for Electron CDP. Install: npm i puppeteer-core');
    }
  }
  return _puppeteer;
}

// ── CDP discovery ───────────────────────────────────────────────────────────

/** Probe one port for a CDP endpoint. Returns the /json/version body or null. */
async function probePort(port, { hostname = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${hostname}:${port}/json/version`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json();
    return { port, hostname, ...body };
  } catch {
    return null;
  }
}

/** Look at the running process list and pick out --remote-debugging-port=N
 *  flags belonging to a process whose command line mentions appName.
 *  Returns [{ port, pid, command }]. macOS-only; relies on ps -A. */
function discoverPortsFromProcessList(appName) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  let raw = '';
  try {
    raw = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf-8', timeout: 3000 });
  } catch {
    return [];
  }
  const out = [];
  const wanted = appName ? appName.toLowerCase() : null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (wanted && !cmd.toLowerCase().includes(wanted)) continue;
    const portMatch = cmd.match(/--remote-debugging-port[= ](\d+)/);
    if (!portMatch) continue;
    out.push({ port: Number(portMatch[1]), pid: Number(pid), command: cmd.slice(0, 200) });
  }
  return out;
}

/** Find a usable CDP endpoint for an app.
 *  Order: ~/.agentdom/sessions.json (set by `agentdom launch`) → process-list
 *  match → caller-supplied probe ports → default ports.
 *  Returns { port, hostname, browser, version, source } or null. */
async function detectCDP(appName, opts = {}) {
  const tried = new Set();

  // 1. Sessions file written by `agentdom launch` — the trustworthy fast path.
  if (opts.useSessions !== false) {
    const launchMod = loadLaunchModule();
    if (launchMod) {
      const session = launchMod.findSession(appName);
      if (session && session.port) {
        tried.add(session.port);
        const r = await probePort(session.port, { hostname: session.hostname, ...opts });
        if (r) return { ...r, source: 'sessions-file', sessionPid: session.pid };
      }
    }
  }

  // 2. Process-list scan — catches users who launched Chrome/Electron with
  //    --remote-debugging-port without going through `agentdom launch`.
  const fromProcs = discoverPortsFromProcessList(appName);
  for (const { port } of fromProcs) {
    if (tried.has(port)) continue;
    tried.add(port);
    const r = await probePort(port, opts);
    if (r) return { ...r, source: 'process-list' };
  }

  // 3. Caller hints + well-known defaults.
  const candidates = [...(opts.ports || []), ...DEFAULT_PROBE_PORTS];
  for (const port of candidates) {
    if (tried.has(port)) continue;
    tried.add(port);
    const r = await probePort(port, opts);
    if (r) return { ...r, source: 'probe' };
  }
  return null;
}

// ── Attach + scan ───────────────────────────────────────────────────────────

class ElectronSession {
  constructor(browser, info) {
    this.browser = browser;
    this.info = info;
    this._injected = new WeakSet();
  }

  async listTargets() {
    const targets = await this.browser.targets();
    return targets
      .filter(t => t.type() === 'page' || t.type() === 'webview')
      .map(t => ({ id: t._targetId || t.url(), type: t.type(), url: t.url(), title: tryTitle(t) }));
  }

  async _activePage({ targetId, urlIncludes } = {}) {
    const targets = await this.browser.targets();
    let match = null;
    for (const t of targets) {
      if (t.type() !== 'page' && t.type() !== 'webview') continue;
      if (targetId && (t._targetId === targetId || t.url() === targetId)) { match = t; break; }
      if (urlIncludes && t.url().includes(urlIncludes)) { match = t; break; }
      if (!targetId && !urlIncludes && !match) match = t;
    }
    if (!match) throw new Error('No CDP target matched. Try listTargets().');
    const page = await match.page();
    if (!page) throw new Error('Target has no page (likely a service worker or shared worker).');
    if (!this._injected.has(page)) {
      try { await page.evaluate(AGENTDOM_SCRIPT); } catch (_) {}
      this._injected.add(page);
    }
    return page;
  }

  /** Scan one renderer's DOM via the injected agentdom.js scanner.
   *  Output shape matches what from-web.js expects, so compile({ from: 'web' })
   *  produces typed tools straight away. */
  async scanWindow(opts = {}) {
    const page = await this._activePage(opts);
    // Re-inject defensively — page may have navigated since the last call.
    await page.evaluate(AGENTDOM_SCRIPT);
    const schema = await page.evaluate(() => globalThis.AgentDOM?.scan?.() || null);
    if (!schema) throw new Error('agentdom.js did not expose AgentDOM.scan after injection.');
    return schema;
  }

  /** Click an element by visible text (anchor/button/role=button). Walks
   *  every frame + shadow root. Returns first match. */
  async clickByText(text, opts = {}) {
    const page = await this._activePage(opts);
    let totalMatches = 0;
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate((needle) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const target = norm(needle);
          const deepAll = (root, sel) => {
            const out = [...root.querySelectorAll(sel)];
            root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, sel)); });
            return out;
          };
          const candidates = deepAll(document,
            'a, button, [role="button"], [role="menuitem"], [role="tab"], input[type="button"], input[type="submit"]');
          // innerText is empty for unrendered elements in headless Chrome — fall
          // back to textContent so the matcher stays correct off-screen.
          const textOf = el => el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '';
          const matches = candidates.filter(el => norm(textOf(el)).includes(target));
          if (!matches.length) return { matched: 0 };
          const el = matches[0];
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { clicked: true, matched: matches.length, tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 120) };
        }, text);
        if (r && r.clicked) return { ...r, frame: frame.url().slice(0, 80) };
        totalMatches += r?.matched || 0;
      } catch (_) {}
    }
    return { clicked: false, matched: totalMatches, frames_checked: page.frames().length };
  }

  /** Click by CSS selector. Searches main frame first, then every nested
   *  iframe (including cross-origin) via Puppeteer's frame tree. */
  async clickBySelector(selector, opts = {}) {
    const page = await this._activePage(opts);
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { clicked: true, matched: 1, selector: sel, tag: el.tagName.toLowerCase() };
        }, selector);
        if (r) return { ...r, frame: frame.url().slice(0, 80) };
      } catch (_) { /* frame detached or eval failed; try next */ }
    }
    return { clicked: false, matched: 0, selector, frames_checked: page.frames().length };
  }

  /** Type into an input/textarea/contenteditable. Searches main frame +
   *  every iframe. Uses the native HTMLInputElement.prototype.value setter
   *  so React/Vue/Lit/Svelte controlled components register the change
   *  (plain `el.value=` is silently dropped by React's value tracker).
   *  Also walks shadow roots when looking up by label. */
  async typeIntoField({ selector, label, text }, opts = {}) {
    const page = await this._activePage(opts);
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate(({ selector, label, text }) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          // Walk shadow DOM when looking up by label (matches agentdom.js deepQueryAll).
          const deepAll = (root, sel) => {
            const out = [...root.querySelectorAll(sel)];
            root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, sel)); });
            return out;
          };
          let el = null;
          if (selector) el = deepAll(document, selector)[0];
          if (!el && label) {
            const target = norm(label);
            el = deepAll(document, 'input, textarea, [contenteditable="true"]').find(node => {
              const aria = node.getAttribute('aria-label');
              const placeholder = node.getAttribute('placeholder');
              const id = node.getAttribute('id');
              const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
              const labelText = lbl ? lbl.innerText : '';
              return [aria, placeholder, labelText].some(s => s && norm(s).includes(target));
            });
          }
          if (!el) return null;
          el.focus();
          if (el.isContentEditable) {
            el.innerText = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, text); else el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { typed: true, matched: 1, tag: el.tagName.toLowerCase() };
        }, { selector, label, text });
        if (r) return { ...r, frame: frame.url().slice(0, 80) };
      } catch (_) { /* try next frame */ }
    }
    return { typed: false, matched: 0, frames_checked: page.frames().length };
  }

  /** Read text content of one element by selector. Walks all frames. */
  async readBySelector(selector, opts = {}) {
    const page = await this._activePage(opts);
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return (el.innerText || el.textContent || '').trim();
        }, selector);
        if (r != null) return r;
      } catch (_) { /* try next frame */ }
    }
    return null;
  }

  /** Run an arbitrary expression in the renderer. Use sparingly — the manifest
   *  step kinds above cover the common cases without dropping to raw JS. */
  async evalJS(expr, opts = {}) {
    const page = await this._activePage(opts);
    return page.evaluate((src) => {
      try { return { ok: true, value: Function(`"use strict"; return (${src});`)() }; }
      catch (e) { return { ok: false, error: String(e) }; }
    }, expr);
  }

  /** Navigate the attached page to a new URL. Waits for `load` so the
   *  next scanWindow sees the destination DOM, not the in-flight page. */
  async navigate(url, opts = {}) {
    const page = await this._activePage(opts);
    await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs || 30000 });
    return { navigated: url, title: await page.title().catch(() => ''), finalUrl: page.url() };
  }

  /** Press a single key chord — e.g. "Meta+Shift+P" to open VS Code's
   *  command palette. Routed through CDP's keyboard, so it lands in the
   *  renderer regardless of OS focus. */
  async pressKey(chord, opts = {}) {
    const page = await this._activePage(opts);
    const parts = chord.split('+').map(p => p.trim()).filter(Boolean);
    const key = parts.pop();
    const modifiers = parts;
    for (const m of modifiers) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
    return { pressed: chord };
  }

  async dispose() {
    try { await this.browser.disconnect(); } catch (_) {}
  }
}

function tryTitle(target) {
  try { return target._targetInfo?.title || target.url(); } catch { return target.url(); }
}

/** Attach to a CDP endpoint by port (preferred) or browserURL.
 *  Returns an ElectronSession ready for scanWindow / click / type calls. */
async function attach({ port, hostname = '127.0.0.1', browserURL, browserWSEndpoint, app } = {}) {
  const puppeteer = loadPuppeteer();
  let info = null;
  if (!browserURL && !browserWSEndpoint) {
    if (port == null) throw new Error('attach() needs { port } or { browserURL } or { browserWSEndpoint }.');
    info = await probePort(port, { hostname });
    if (!info) throw new Error(`No CDP endpoint on http://${hostname}:${port}.`);
    browserURL = `http://${hostname}:${port}`;
  }
  const browser = await puppeteer.connect(browserWSEndpoint
    ? { browserWSEndpoint, defaultViewport: null }
    : { browserURL, defaultViewport: null });
  return new ElectronSession(browser, { port, hostname, browserURL, app, ...(info || {}) });
}

module.exports = {
  detectCDP,
  probePort,
  discoverPortsFromProcessList,
  attach,
  ElectronSession,
};
