/**
 * AgentDOM v3 — AI-Powered Agent Runtime
 * Schema (read) + Actions (act) + Events (react) + AI Intent
 * Fixes: React compat, Shadow DOM, null selectors, overlay detection
 */
(function(root) {
  'use strict';
  const VERSION = '3.0.0';

  // ── Utilities ──
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.random() * (b - a) + a;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // ── FIX: Build unique CSS path when element has no ID ──
  function buildCssPath(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`#${cur.id}`); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).filter(c => c && !c.startsWith('_')).slice(0, 2);
        if (cls.length) sel += '.' + cls.join('.');
      }
      // nth-child for uniqueness
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) sel += `:nth-child(${[...parent.children].indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ── FIX: React-compatible input value setter ──
  function setInputValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── FIX: Query across Shadow DOM AND same-origin iframes ──
  function deepQueryAll(root, selector) {
    const results = [...root.querySelectorAll(selector)];
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selector));
      }
    });
    // Same-origin iframes — touching cross-origin throws SecurityError, swallow it.
    const frames = root.querySelectorAll ? root.querySelectorAll('iframe, frame') : [];
    frames.forEach(frame => {
      try {
        const doc = frame.contentDocument;
        if (doc) results.push(...deepQueryAll(doc, selector));
      } catch (_) { /* cross-origin frame, skip */ }
    });
    return results;
  }

  // ── FIX: Detect if element is covered by overlay ──
  function isCovered(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return top && top !== el && !el.contains(top) && !top.contains(el);
  }

  function elCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && el.offsetParent !== null;
  }

  function resolve(target) {
    if (typeof target === 'string') return $(target);
    return target;
  }

  function getText(el) {
    return (el.textContent || '').trim().slice(0, 200);
  }

  // ── Intent Inference ──
  const INTENTS = [
    [/log\s?in|sign\s?in/i, 'authenticate'], [/sign\s?up|register/i, 'register'],
    [/search|find/i, 'search'], [/submit|send|post/i, 'create'],
    [/delete|remove/i, 'delete'], [/save|store/i, 'save'],
    [/buy|purchase|checkout/i, 'purchase'], [/subscribe|join|waitlist/i, 'subscribe'],
    [/next|continue/i, 'navigate-forward'], [/back|previous/i, 'navigate-back'],
    [/close|cancel|dismiss/i, 'dismiss'], [/download|export/i, 'download'],
    [/upload|import/i, 'upload'], [/edit|update/i, 'update'],
    [/share|invite/i, 'share'], [/toggle|switch/i, 'toggle'],
  ];

  function inferIntent(el) {
    const sig = [getText(el), el.getAttribute('aria-label') || '', el.placeholder || '', el.name || '', el.id || ''].join(' ');
    for (const [p, i] of INTENTS) { if (p.test(sig)) return i; }
    return null;
  }

  // ── Human-Like Mouse Path (Bezier curve) ──
  function bezierPath(from, to, steps = 20) {
    const cp1 = { x: from.x + (to.x - from.x) * 0.3 + rand(-40, 40), y: from.y + (to.y - from.y) * 0.1 + rand(-30, 30) };
    const cp2 = { x: from.x + (to.x - from.x) * 0.7 + rand(-40, 40), y: from.y + (to.y - from.y) * 0.9 + rand(-30, 30) };
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      pts.push({
        x: u*u*u*from.x + 3*u*u*t*cp1.x + 3*u*t*t*cp2.x + t*t*t*to.x,
        y: u*u*u*from.y + 3*u*u*t*cp1.y + 3*u*t*t*cp2.y + t*t*t*to.y,
      });
    }
    return pts;
  }

  // ── Virtual Cursor State ──
  let cursor = { x: 0, y: 0 };
  let cursorEl = null;

  function createCursor() {
    if (cursorEl) return;
    cursorEl = document.createElement('div');
    Object.assign(cursorEl.style, {
      position: 'fixed', zIndex: '99999', width: '12px', height: '12px',
      borderRadius: '50%', background: 'rgba(0,212,170,0.6)', border: '2px solid #00d4aa',
      pointerEvents: 'none', transition: 'none', transform: 'translate(-50%,-50%)',
      boxShadow: '0 0 12px rgba(0,212,170,0.4)', left: '0px', top: '0px', display: 'none',
    });
    document.body.appendChild(cursorEl);
  }

  function showCursor(x, y) {
    createCursor();
    cursorEl.style.display = 'block';
    cursorEl.style.left = x + 'px';
    cursorEl.style.top = y + 'px';
    cursor = { x, y };
  }

  function hideCursor() { if (cursorEl) cursorEl.style.display = 'none'; }

  // ── Dispatch real DOM events ──
  function fire(el, type, opts = {}) {
    const rect = el.getBoundingClientRect();
    const cx = opts.clientX || rect.left + rect.width / 2;
    const cy = opts.clientY || rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, ...opts };

    if (type.startsWith('mouse') || type === 'click' || type === 'dblclick' || type === 'contextmenu') {
      el.dispatchEvent(new MouseEvent(type, base));
    } else if (type.startsWith('pointer')) {
      el.dispatchEvent(new PointerEvent(type, base));
    } else if (type.startsWith('key')) {
      el.dispatchEvent(new KeyboardEvent(type, base));
    } else if (type === 'input' || type === 'change') {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    } else if (type.startsWith('touch')) {
      const touch = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
    } else if (type === 'focus' || type === 'blur') {
      el.dispatchEvent(new FocusEvent(type, { bubbles: true }));
    } else if (type === 'wheel' || type === 'scroll') {
      el.dispatchEvent(new WheelEvent(type, { bubbles: true, deltaY: opts.deltaY || 0, ...base }));
    } else {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  }

  // ── Event Log (FIX: bounded to prevent memory leak) ──
  const eventLog = [];
  const MAX_LOG = 500;
  function log(action, detail) {
    const entry = { ts: Date.now(), action, ...detail };
    eventLog.push(entry);
    if (eventLog.length > MAX_LOG) eventLog.splice(0, eventLog.length - MAX_LOG);
    console.log(`%c[AgentDOM] ${action}`, 'color:#00d4aa;font-weight:bold', detail);
    return entry;
  }

  // ═══════════════════════════════════════════════════════════
  //  ACTION ENGINE — Real human-like interactions
  // ═══════════════════════════════════════════════════════════

  const actions = {

    /** Move virtual cursor to element with bezier path */
    async moveTo(target, opts = {}) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      const to = elCenter(el);
      const path = bezierPath(cursor, to, opts.steps || 18);
      createCursor();
      for (const pt of path) {
        showCursor(pt.x, pt.y);
        const elAtPt = document.elementFromPoint(pt.x, pt.y);
        if (elAtPt) fire(elAtPt, 'mousemove', { clientX: pt.x, clientY: pt.y });
        await sleep(rand(6, 18));
      }
      cursor = to;
      log('moveTo', { target: target.toString(), x: to.x, y: to.y });
    },

    /** Click an element — full human sequence: move → hover → mousedown → mouseup → click */
    async click(target, opts = {}) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      if (!isVisible(el)) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); await sleep(400); }
      // FIX: Detect overlays blocking the element
      if (isCovered(el) && !opts.force) {
        log('click:blocked', { target: target.toString(), reason: 'element covered by overlay' });
        throw new Error(`Element ${target} is covered by an overlay. Use {force:true} to click anyway.`);
      }
      await actions.moveTo(el);
      fire(el, 'pointerenter');
      fire(el, 'mouseenter');
      fire(el, 'mouseover');
      await sleep(rand(40, 100));
      fire(el, 'pointerdown');
      fire(el, 'mousedown');
      await sleep(rand(50, 120));
      fire(el, 'pointerup');
      fire(el, 'mouseup');
      fire(el, 'click');
      if (opts.focus !== false) el.focus?.();
      log('click', { target: target.toString(), intent: inferIntent(el) });
      await sleep(rand(80, 200));
    },

    /** Double click */
    async dblClick(target) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      await actions.moveTo(el);
      fire(el, 'mousedown'); fire(el, 'mouseup'); fire(el, 'click');
      await sleep(rand(60, 120));
      fire(el, 'mousedown'); fire(el, 'mouseup'); fire(el, 'click');
      fire(el, 'dblclick');
      log('dblClick', { target: target.toString() });
    },

    /** Right click */
    async rightClick(target) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      await actions.moveTo(el);
      fire(el, 'mousedown', { button: 2 }); fire(el, 'mouseup', { button: 2 });
      fire(el, 'contextmenu', { button: 2 });
      log('rightClick', { target: target.toString() });
    },

    /** Hover over an element */
    async hover(target, duration = 500) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      await actions.moveTo(el);
      fire(el, 'mouseenter'); fire(el, 'mouseover');
      fire(el, 'pointerenter'); fire(el, 'pointerover');
      log('hover', { target: target.toString(), duration });
      await sleep(duration);
      fire(el, 'mouseleave'); fire(el, 'mouseout');
      fire(el, 'pointerleave'); fire(el, 'pointerout');
    },

    /** Type text into an input — realistic keystroke timing */
    async type(target, text, opts = {}) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      if (!isVisible(el)) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); await sleep(300); }
      await actions.click(el);
      // FIX: Support contenteditable divs
      const isContentEditable = el.getAttribute('contenteditable') === 'true';
      if (opts.clear !== false) {
        if (isContentEditable) { el.textContent = ''; }
        else { setInputValue(el, ''); } // FIX: React-compatible clear
      }
      for (const ch of text) {
        fire(el, 'keydown', { key: ch, code: `Key${ch.toUpperCase()}` });
        fire(el, 'keypress', { key: ch, code: `Key${ch.toUpperCase()}` });
        if (isContentEditable) { el.textContent += ch; }
        else { setInputValue(el, (el.value || '') + ch); } // FIX: React-compatible type
        fire(el, 'keyup', { key: ch, code: `Key${ch.toUpperCase()}` });
        await sleep(rand(opts.minDelay || 30, opts.maxDelay || 120));
      }
      fire(el, 'change');
      log('type', { target: target.toString(), text, length: text.length });
    },

    /** Press a special key (Enter, Tab, Escape, etc.) */
    async pressKey(key, target) {
      const el = target ? resolve(target) : document.activeElement || document.body;
      fire(el, 'keydown', { key, code: key });
      fire(el, 'keypress', { key, code: key });
      await sleep(rand(40, 80));
      fire(el, 'keyup', { key, code: key });
      log('pressKey', { key, target: el.tagName });
    },

    /** Scroll the page or an element */
    async scroll(opts = {}) {
      const el = opts.element ? resolve(opts.element) : window;
      const target = opts.to !== undefined ? opts.to : opts.by !== undefined ? (el === window ? window.scrollY : el.scrollTop) + opts.by : 500;
      const dir = opts.direction || 'down';
      const current = el === window ? window.scrollY : el.scrollTop;
      const steps = opts.steps || 15;
      const delta = (target - current) / steps;

      for (let i = 0; i < steps; i++) {
        const next = current + delta * (i + 1);
        if (el === window) { window.scrollTo({ top: next }); } else { el.scrollTop = next; }
        const body = el === window ? document.body : el;
        fire(body, 'wheel', { deltaY: delta });
        fire(body, 'scroll');
        await sleep(rand(15, 40));
      }
      log('scroll', { direction: dir, to: target, element: opts.element || 'window' });
    },

    /** Scroll to a specific element */
    async scrollTo(target) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      const rect = el.getBoundingClientRect();
      const targetY = window.scrollY + rect.top - window.innerHeight / 3;
      await actions.scroll({ to: targetY });
      log('scrollTo', { target: target.toString() });
    },

    /** Select an option from a dropdown */
    async select(target, value) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      await actions.click(el);
      await sleep(100);
      for (const opt of el.options) {
        if (opt.value === value || opt.textContent.trim() === value) {
          el.value = opt.value;
          opt.selected = true;
          fire(el, 'input');
          fire(el, 'change');
          break;
        }
      }
      log('select', { target: target.toString(), value });
    },

    /** Check/uncheck a checkbox or radio */
    async check(target, checked = true) {
      const el = resolve(target);
      if (!el) throw new Error(`Element not found: ${target}`);
      if (el.checked !== checked) { await actions.click(el); el.checked = checked; fire(el, 'change'); }
      log('check', { target: target.toString(), checked });
    },

    /** Drag element from one place to another */
    async drag(fromTarget, toTarget) {
      const from = resolve(fromTarget);
      const to = resolve(toTarget);
      if (!from || !to) throw new Error('Drag elements not found');
      const fromPt = elCenter(from);
      const toPt = elCenter(to);
      await actions.moveTo(from);
      fire(from, 'pointerdown'); fire(from, 'mousedown');
      fire(from, 'dragstart');
      const path = bezierPath(fromPt, toPt, 15);
      for (const pt of path) {
        showCursor(pt.x, pt.y);
        fire(from, 'drag', { clientX: pt.x, clientY: pt.y });
        const target = document.elementFromPoint(pt.x, pt.y);
        if (target) { fire(target, 'dragover', { clientX: pt.x, clientY: pt.y }); }
        await sleep(rand(10, 25));
      }
      fire(to, 'drop'); fire(from, 'dragend');
      fire(to, 'pointerup'); fire(to, 'mouseup');
      log('drag', { from: fromTarget.toString(), to: toTarget.toString() });
    },

    /** Fill an entire form from a data object */
    async fillForm(formTarget, data) {
      const form = resolve(formTarget);
      if (!form) throw new Error(`Form not found: ${formTarget}`);
      log('fillForm:start', { form: formTarget.toString(), fields: Object.keys(data) });
      for (const [name, value] of Object.entries(data)) {
        const field = form.querySelector(`[name="${name}"], #${name}, [aria-label="${name}"]`);
        if (!field) { console.warn(`[AgentDOM] Field not found: ${name}`); continue; }
        const tag = field.tagName.toLowerCase();
        const type = field.type?.toLowerCase();
        if (tag === 'select') { await actions.select(field, value); }
        else if (type === 'checkbox' || type === 'radio') { await actions.check(field, !!value); }
        else { await actions.type(field, String(value)); }
        await sleep(rand(100, 300));
      }
      log('fillForm:done', { form: formTarget.toString() });
    },

    /** Submit a form */
    async submitForm(formTarget) {
      const form = resolve(formTarget);
      if (!form) throw new Error(`Form not found: ${formTarget}`);
      const btn = form.querySelector('[type="submit"], button:not([type="button"])');
      if (btn) { await actions.click(btn); }
      else { fire(form, 'submit'); }
      log('submitForm', { form: formTarget.toString() });
    },

    /** Wait for an element to appear */
    async waitFor(target, opts = {}) {
      const timeout = opts.timeout || 10000;
      const interval = opts.interval || 200;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = resolve(target);
        if (el && isVisible(el)) { log('waitFor:found', { target: target.toString() }); return el; }
        await sleep(interval);
      }
      throw new Error(`Timeout waiting for: ${target}`);
    },

    /** Wait for text to appear on page */
    async waitForText(text, opts = {}) {
      const timeout = opts.timeout || 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (document.body.textContent.includes(text)) { log('waitForText:found', { text }); return true; }
        await sleep(200);
      }
      throw new Error(`Timeout waiting for text: ${text}`);
    },

    /** Navigate to a URL */
    async navigate(url) {
      log('navigate', { url });
      window.location.href = url;
    },

    /** Go back */
    async back() { log('back', {}); history.back(); },

    /** Go forward */
    async forward() { log('forward', {}); history.forward(); },

    /** Take a snapshot of current page state */
    snapshot() {
      return {
        url: location.href,
        title: document.title,
        scroll: { x: scrollX, y: scrollY },
        viewport: { w: innerWidth, h: innerHeight },
        activeElement: document.activeElement?.id || document.activeElement?.tagName,
        forms: $$('form').map(f => ({
          id: f.id || null,
          fields: $$('input,textarea,select', f).map(i => ({ name: i.name, value: i.value, type: i.type })),
        })),
        visibleText: document.body.innerText.slice(0, 2000),
      };
    },
  };

  // ═══════════════════════════════════════════════════════════
  //  SCHEMA ENGINE — Read the UI semantically
  // ═══════════════════════════════════════════════════════════

  function scanPage() {
    const meta = {
      title: document.title, url: location.href,
      description: document.querySelector('meta[name="description"]')?.content || null,
      language: document.documentElement.lang || 'en',
    };
    // FIX: Also scan contenteditable and Shadow DOM inputs
    const formsList = $$('form').map(f => {
      const fields = [...deepQueryAll(f, 'input,textarea,select,[contenteditable="true"]')].map(field => ({
        name: field.name || field.id || null,
        selector: buildCssPath(field), // FIX: never null
        type: field.type || (field.getAttribute('contenteditable') ? 'richtext' : 'text'),
        required: field.required || false,
        label: field.getAttribute('aria-label') || field.placeholder || field.name || null,
        value: field.value !== '' ? field.value : null, // FIX: preserve 0 and empty
      }));
      const submit = f.querySelector('[type="submit"], button:not([type="button"])');
      return {
        id: f.id || null, method: (f.method || 'GET').toUpperCase(),
        intent: inferIntent(f), fields,
        submitButton: submit ? { selector: buildCssPath(submit), label: getText(submit) } : null, // FIX: never null
      };
    });
    const actionsList = deepQueryAll(document, 'button, [role="button"], a[href], input[type="submit"]').filter(isVisible).map(el => ({
      label: getText(el) || el.getAttribute('aria-label') || el.value || null,
      selector: buildCssPath(el), // FIX: never null
      tag: el.tagName.toLowerCase(),
      href: el.href || null,
      intent: inferIntent(el),
      disabled: el.disabled || false,
      covered: isCovered(el), // FIX: tell agent if element is blocked
    }));
    return { _aidl: VERSION, generatedAt: new Date().toISOString(), page: { meta, forms: formsList, actions: actionsList } };
  }

  // ═══════════════════════════════════════════════════════════
  //  TOOL SYNTHESIZER — Auto-generate page-specific tools
  // ═══════════════════════════════════════════════════════════

  const SYNTH_INTENT_NAMES = {
    authenticate: 'login', register: 'create_account', search: 'search',
    create: 'submit_content', delete: 'delete_item', save: 'save_changes',
    purchase: 'checkout', subscribe: 'subscribe', 'navigate-forward': 'go_next',
    'navigate-back': 'go_back', dismiss: 'dismiss', download: 'download',
    upload: 'upload_file', update: 'update_info', share: 'share', toggle: 'toggle_setting',
  };

  const SYNTH_VERBS = {
    authenticate: 'Log in', register: 'Create a new account', search: 'Search',
    create: 'Submit content', delete: 'Delete', save: 'Save',
    purchase: 'Complete purchase', subscribe: 'Subscribe',
    download: 'Download', upload: 'Upload a file', update: 'Update information',
    share: 'Share', toggle: 'Toggle setting',
  };

  const SYNTH_FIELD_TYPES = {
    text:'string', email:'string', password:'string', number:'number', tel:'string',
    url:'string', search:'string', date:'string', checkbox:'boolean', radio:'string',
    select:'string', textarea:'string', richtext:'string', hidden:'string', file:'string',
  };

  function synthNormalize(raw) {
    if (!raw) return 'field';
    return raw.toLowerCase().replace(/[^a-z0-9_\s]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'field';
  }

  function synthFormToTool(form) {
    if (!form.fields || form.fields.length === 0) return null;
    const params = {};
    const fieldMap = {};

    for (const field of form.fields) {
      if (field.type === 'hidden') continue;
      let pname = synthNormalize(field.name || field.label || 'field_' + Object.keys(params).length);
      let final = pname; let c = 2;
      while (params[final]) { final = pname + '_' + (c++); }
      params[final] = { type: SYNTH_FIELD_TYPES[field.type] || 'string', description: field.label || field.name || final, required: field.required || false };
      fieldMap[final] = field.selector;
    }
    if (Object.keys(params).length === 0) return null;

    const intent = form.intent || 'submit';
    const name = (form.intent && SYNTH_INTENT_NAMES[form.intent]) ? SYNTH_INTENT_NAMES[form.intent]
      : form.id ? synthNormalize(form.id)
      : form.fields[0]?.name ? 'submit_' + synthNormalize(form.fields[0].name)
      : 'submit_form';

    return {
      name, description: `${SYNTH_VERBS[intent] || 'Submit'} using the ${intent} form. Fields: ${Object.keys(params).join(', ')}`,
      params,
      _internal: { type:'form', intent, formId: form.id||null, fieldMap, submitSelector: form.submitButton?.selector||null },
    };
  }

  function synthActionsToTools(acts) {
    const tools = [];
    const grouped = {};
    for (const a of acts) {
      if (!a.intent || a.disabled || a.covered || a.tag === 'a') continue;
      if (!grouped[a.intent]) grouped[a.intent] = [];
      grouped[a.intent].push(a);
    }
    for (const [intent, items] of Object.entries(grouped)) {
      const tname = SYNTH_INTENT_NAMES[intent] || 'do_' + synthNormalize(intent);
      const verb = SYNTH_VERBS[intent] || intent;
      const labels = items.map(i => i.label).filter(Boolean);
      tools.push({
        name: tname,
        description: items.length === 1 ? `${verb}. Button: "${items[0].label || intent}"` : `${verb}. ${items.length} options: ${labels.join(', ')}`,
        params: items.length > 1 ? { which: { type:'string', description: `Which one? Options: ${labels.join(', ')}`, required:true } } : {},
        _internal: { type:'action', intent, actions: items.map(i => ({selector:i.selector, label:i.label})) },
      });
    }
    // Top 5 standalone buttons
    const standalone = acts.filter(a => !a.intent && !a.disabled && !a.covered && a.tag !== 'a' && a.label);
    for (const btn of standalone.slice(0, 5)) {
      const n = 'click_' + synthNormalize(btn.label);
      if (tools.some(t => t.name === n)) continue;
      tools.push({ name: n, description: `Click "${btn.label}"`, params: {}, _internal: { type:'action', intent:null, actions:[{selector:btn.selector, label:btn.label}] } });
    }
    return tools;
  }

  function synthLinksToTools(acts) {
    const seen = new Set();
    const unique = [];
    for (const a of acts.filter(a => a.tag === 'a' && a.href && a.label && !a.disabled && !a.covered)) {
      const k = a.label.trim().toLowerCase();
      if (seen.has(k)) continue; seen.add(k); unique.push(a);
    }
    if (unique.length === 0) return [];
    const displayed = unique.slice(0, 15);
    return [{
      name: 'navigate_to',
      description: `Navigate to: ${displayed.map(l => l.label).join(', ')}${unique.length > 15 ? ' (+' + (unique.length - 15) + ' more)' : ''}`,
      params: { destination: { type:'string', description:'Page/section to navigate to', required:true, enum: displayed.map(l => l.label) } },
      _internal: { type:'navigation', linkMap: Object.fromEntries(displayed.map(l => [l.label, {selector:l.selector, href:l.href}])) },
    }];
  }

  function synthClassifyPage(meta, forms, acts) {
    const sig = ((meta.title || '') + ' ' + (meta.url || '')).toLowerCase();
    const intents = new Set(forms.map(f => f.intent).concat(acts.map(a => a.intent)).filter(Boolean));
    if (intents.has('authenticate')) return 'login';
    if (intents.has('register')) return 'registration';
    if (intents.has('search') && forms.length <= 2) return 'search';
    if (intents.has('purchase')) return 'checkout';
    if (intents.has('subscribe')) return 'subscription';
    if (/dashboard|admin|panel/.test(sig)) return 'dashboard';
    if (/settings|preferences/.test(sig)) return 'settings';
    if (/article|blog|post/.test(sig)) return 'article';
    if (forms.length > 3) return 'multi-form';
    if (forms.length === 0 && acts.length < 5) return 'static';
    return 'general';
  }

  const SYNTH_BASE_TOOLS = [
    { name:'scan_page', description:'Re-scan the page to discover updated tools.', params:{}, _internal:{type:'base', action:'scan'} },
    { name:'take_screenshot', description:'Capture a screenshot.', params:{ full_page:{type:'boolean', description:'Full scrollable page', required:false} }, _internal:{type:'base', action:'screenshot'} },
    { name:'read_page_text', description:'Read visible text of page or section.', params:{ section:{type:'string', description:'Section name (optional)', required:false} }, _internal:{type:'base', action:'read_text'} },
    { name:'scroll_page', description:'Scroll page up or down.', params:{ direction:{type:'string', description:'"up" or "down"', required:false}, amount:{type:'number', description:'Pixels (default 500)', required:false} }, _internal:{type:'base', action:'scroll'} },
    { name:'go_to_url', description:'Navigate to a URL.', params:{ url:{type:'string', description:'URL to navigate to', required:true} }, _internal:{type:'base', action:'browse'} },
    { name:'press_key', description:'Press a keyboard key.', params:{ key:{type:'string', description:'Key name (Enter, Tab, Escape)', required:true} }, _internal:{type:'base', action:'press_key'} },
  ];

  /**
   * Synthesize page-specific tools from the current page schema.
   * Returns: { tools, page_type, summary }
   */
  function synthesizeTools(schema) {
    if (!schema) schema = scanPage();
    const forms = schema.page?.forms || [];
    const acts = schema.page?.actions || [];
    const meta = schema.page?.meta || {};

    const tools = [];
    for (const f of forms) { const t = synthFormToTool(f); if (t) tools.push(t); }
    tools.push(...synthActionsToTools(acts));
    tools.push(...synthLinksToTools(acts));
    tools.push(...SYNTH_BASE_TOOLS);

    // Deduplicate
    const seen = new Map();
    for (const t of tools) { if (!seen.has(t.name) || Object.keys(t.params).length > Object.keys(seen.get(t.name).params).length) seen.set(t.name, t); }
    const deduped = [...seen.values()];

    const pageType = synthClassifyPage(meta, forms, acts);
    const formTools = deduped.filter(t => t._internal.type === 'form');
    const actionTools = deduped.filter(t => t._internal.type === 'action');
    const summary = [
      `Page: "${meta.title || 'Untitled'}" (${pageType})`,
      formTools.length ? `Forms: ${formTools.map(t => t.name).join(', ')}` : null,
      actionTools.length ? `Actions: ${actionTools.map(t => t.name).join(', ')}` : null,
      `${deduped.length} total tools available`,
    ].filter(Boolean).join(' | ');

    return { tools: deduped, page_type: pageType, summary };
  }

  /**
   * Scan page AND return auto-generated tools in one call.
   * The schema becomes self-describing.
   */
  function scanWithTools() {
    const schema = scanPage();
    const { tools, page_type, summary } = synthesizeTools(schema);
    // Strip _internal for public output, keep in a separate map
    const publicTools = tools.map(({ _internal, ...rest }) => rest);
    return {
      ...schema,
      tools: publicTools,
      page_type,
      tool_summary: summary,
      _tool_internals: tools, // Full version for executor use
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  CLI — Text command parser for agents
  // ═══════════════════════════════════════════════════════════

  async function execCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(' ');

    switch (verb) {
      case 'click': return await actions.click(rest);
      case 'dblclick': return await actions.dblClick(rest);
      case 'rightclick': return await actions.rightClick(rest);
      case 'hover': return await actions.hover(rest);
      case 'type': {
        const m = rest.match(/^(\S+)\s+"(.+)"$/);
        if (m) return await actions.type(m[1], m[2]);
        throw new Error('Usage: type <selector> "text"');
      }
      case 'press': return await actions.pressKey(rest);
      case 'scroll': return await actions.scroll({ by: parseInt(rest) || 500 });
      case 'scrollto': return await actions.scrollTo(rest);
      case 'select': {
        const m = rest.match(/^(\S+)\s+"(.+)"$/);
        if (m) return await actions.select(m[1], m[2]);
        throw new Error('Usage: select <selector> "value"');
      }
      case 'check': return await actions.check(rest, true);
      case 'uncheck': return await actions.check(rest, false);
      case 'fill': {
        const m = rest.match(/^(\S+)\s+(.+)$/);
        if (m) return await actions.fillForm(m[1], JSON.parse(m[2]));
        throw new Error('Usage: fill <formSelector> {"field":"value"}');
      }
      case 'submit': return await actions.submitForm(rest);
      case 'wait': return await actions.waitFor(rest);
      case 'waittext': return await actions.waitForText(rest);
      case 'navigate': case 'goto': return await actions.navigate(rest);
      case 'back': return await actions.back();
      case 'forward': return await actions.forward();
      case 'scan': return scanPage();
      case 'snapshot': return actions.snapshot();
      case 'log': return eventLog;
      default: throw new Error(`Unknown command: ${verb}. Available: click, dblclick, rightclick, hover, type, press, scroll, scrollto, select, check, uncheck, fill, submit, wait, waittext, navigate, back, forward, scan, snapshot, log`);
    }
  }

  /** Run a sequence of commands */
  async function execScript(cmds) {
    const results = [];
    const lines = Array.isArray(cmds) ? cmds : cmds.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    for (const cmd of lines) {
      results.push({ cmd, result: await execCommand(cmd) });
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  const AgentDOM = {
    version: VERSION,
    // Action engine
    ...actions,
    // Schema
    scan: scanPage,
    // Tool synthesis
    synthesizeTools,
    scanWithTools,
    // CLI
    exec: execCommand,
    run: execScript,
    // State
    log: () => eventLog,
    cursor: { show: showCursor, hide: hideCursor },
    // Dump
    dump: () => { const s = scanPage(); console.log(JSON.stringify(s, null, 2)); return s; },
    // Dump with tools
    dumpTools: () => { const s = scanWithTools(); console.log(JSON.stringify(s, null, 2)); return s; },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentDOM;
  else root.AgentDOM = AgentDOM;
})(globalThis);
