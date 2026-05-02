/**
 * AgentDOM — Tool Synthesizer
 * Converts page schemas into high-level, domain-specific tools.
 *
 * Instead of generic: click("#login-form > button:nth-child(3)")
 * Generates:          login(email, password)
 *
 * The agent never sees CSS selectors. It calls named functions
 * with typed parameters. The executor maps them back to low-level actions.
 */

'use strict';

// ── Intent → Tool Name mapping ──
const INTENT_TOOL_NAMES = {
  authenticate: 'login',
  register: 'create_account',
  search: 'search',
  create: 'submit_content',
  delete: 'delete_item',
  save: 'save_changes',
  purchase: 'checkout',
  subscribe: 'subscribe',
  'navigate-forward': 'go_next',
  'navigate-back': 'go_back',
  dismiss: 'dismiss',
  download: 'download',
  upload: 'upload_file',
  update: 'update_info',
  share: 'share',
  toggle: 'toggle_setting',
};

// ── Intent → human-readable verb ──
const INTENT_VERBS = {
  authenticate: 'Log in',
  register: 'Create a new account',
  search: 'Search',
  create: 'Submit content',
  delete: 'Delete',
  save: 'Save',
  purchase: 'Complete purchase',
  subscribe: 'Subscribe',
  'navigate-forward': 'Go to next page',
  'navigate-back': 'Go to previous page',
  dismiss: 'Dismiss / close',
  download: 'Download',
  upload: 'Upload a file',
  update: 'Update information',
  share: 'Share',
  toggle: 'Toggle setting',
};

// ── Field type → param type ──
const FIELD_TYPE_MAP = {
  text: 'string',
  email: 'string',
  password: 'string',
  number: 'number',
  tel: 'string',
  url: 'string',
  search: 'string',
  date: 'string',
  'datetime-local': 'string',
  time: 'string',
  month: 'string',
  week: 'string',
  color: 'string',
  range: 'number',
  file: 'string',
  hidden: 'string',
  checkbox: 'boolean',
  radio: 'string',
  select: 'string',
  textarea: 'string',
  richtext: 'string',
};

// ── Base tools that are always available ──
const BASE_TOOLS = [
  {
    name: 'scan_page',
    description: 'Re-scan the current page to discover new tools and updated content.',
    params: {},
    _internal: { type: 'base', action: 'scan' },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the current page.',
    params: {
      full_page: { type: 'boolean', description: 'Capture the full scrollable page', required: false },
    },
    _internal: { type: 'base', action: 'screenshot' },
  },
  {
    name: 'read_page_text',
    description: 'Read the visible text content of the page or a specific section.',
    params: {
      section: { type: 'string', description: 'Section name or description (optional, reads full page if omitted)', required: false },
    },
    _internal: { type: 'base', action: 'read_text' },
  },
  {
    name: 'scroll_page',
    description: 'Scroll the page up or down.',
    params: {
      direction: { type: 'string', description: '"up" or "down"', required: false },
      amount: { type: 'number', description: 'Pixels to scroll (default: 500)', required: false },
    },
    _internal: { type: 'base', action: 'scroll' },
  },
  {
    name: 'go_to_url',
    description: 'Navigate to a specific URL.',
    params: {
      url: { type: 'string', description: 'The URL to navigate to', required: true },
    },
    _internal: { type: 'base', action: 'browse' },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (Enter, Tab, Escape, etc.).',
    params: {
      key: { type: 'string', description: 'Key name (e.g. "Enter", "Tab", "Escape")', required: true },
    },
    _internal: { type: 'base', action: 'press_key' },
  },
];


class ToolSynthesizer {

  /**
   * Main entry point: given a page schema, produce an array of tools.
   * Each tool has: name, description, params, _internal (hidden from agent).
   *
   * @param {object} schema - Output of AgentDOM.scan()
   * @returns {object} { tools: [...], page_type: string, summary: string }
   */
  synthesize(schema) {
    if (!schema || !schema.page) {
      return { tools: [...BASE_TOOLS], page_type: 'unknown', summary: 'No schema available' };
    }

    const tools = [];
    const meta = schema.page.meta || {};
    const forms = schema.page.forms || [];
    const actions = schema.page.actions || [];

    // 1. Forms → high-level action tools
    for (const form of forms) {
      const tool = this._formToTool(form);
      if (tool) tools.push(tool);
    }

    // 2. Grouped action buttons → semantic tools
    tools.push(...this._actionsToTools(actions));

    // 3. Navigation links → navigate_to tool
    tools.push(...this._linksToTools(actions));

    // 4. Always include base tools
    tools.push(...BASE_TOOLS);

    // Deduplicate by name
    const deduped = this._deduplicate(tools);

    // Classify the page
    const page_type = this._classifyPage(meta, forms, actions);

    // Generate summary
    const formTools = deduped.filter(t => t._internal.type === 'form');
    const actionTools = deduped.filter(t => t._internal.type === 'action');
    const navTools = deduped.filter(t => t._internal.type === 'navigation');

    const summary = [
      `Page: "${meta.title || 'Untitled'}" (${page_type})`,
      formTools.length ? `Forms: ${formTools.map(t => t.name).join(', ')}` : null,
      actionTools.length ? `Actions: ${actionTools.map(t => t.name).join(', ')}` : null,
      navTools.length ? `Navigation: ${navTools.length} destinations` : null,
      `Base tools: ${BASE_TOOLS.length} always available`,
    ].filter(Boolean).join('\n');

    return { tools: deduped, page_type, summary };
  }

  // ── Form → Tool ──

  _formToTool(form) {
    if (!form.fields || form.fields.length === 0) return null;

    const toolName = this._nameFromForm(form);
    const params = {};
    const fieldMap = {};

    for (const field of form.fields) {
      // Skip hidden fields and fields without names
      if (field.type === 'hidden') continue;

      const paramName = this._normalizeParamName(field.name || field.label || `field_${Object.keys(params).length}`);

      // Avoid duplicate param names
      let finalName = paramName;
      let counter = 2;
      while (params[finalName]) {
        finalName = `${paramName}_${counter++}`;
      }

      params[finalName] = {
        type: FIELD_TYPE_MAP[field.type] || 'string',
        description: field.label || field.name || finalName,
        required: field.required || false,
      };
      fieldMap[finalName] = field.selector;
    }

    // Don't create a tool for forms with no visible params
    if (Object.keys(params).length === 0) return null;

    const intent = form.intent || 'submit';
    const verb = INTENT_VERBS[intent] || 'Submit';

    return {
      name: toolName,
      description: `${verb} using the ${intent} form on this page. Fields: ${Object.keys(params).join(', ')}`,
      params,
      _internal: {
        type: 'form',
        intent,
        formId: form.id || null,
        fieldMap,
        submitSelector: form.submitButton?.selector || null,
        submitLabel: form.submitButton?.label || null,
      },
    };
  }

  _nameFromForm(form) {
    // Use intent mapping first
    if (form.intent && INTENT_TOOL_NAMES[form.intent]) {
      return INTENT_TOOL_NAMES[form.intent];
    }

    // Fall back to form ID
    if (form.id) {
      return this._normalizeParamName(form.id);
    }

    // Fall back to first field name
    const firstField = form.fields?.[0];
    if (firstField?.name) {
      return `submit_${this._normalizeParamName(firstField.name)}`;
    }

    return 'submit_form';
  }

  // ── Action Buttons → Tools ──

  _actionsToTools(actions) {
    const tools = [];

    // Group by intent
    const grouped = {};
    for (const action of actions) {
      if (!action.intent) continue;
      if (action.disabled || action.covered) continue;
      if (action.tag === 'a') continue; // Links handled separately

      if (!grouped[action.intent]) grouped[action.intent] = [];
      grouped[action.intent].push(action);
    }

    for (const [intent, items] of Object.entries(grouped)) {
      const toolName = INTENT_TOOL_NAMES[intent] || `do_${this._normalizeParamName(intent)}`;
      const verb = INTENT_VERBS[intent] || intent;

      if (items.length === 1) {
        // Single action → simple tool, no params needed
        tools.push({
          name: toolName,
          description: `${verb}. Button: "${items[0].label || intent}"`,
          params: {},
          _internal: {
            type: 'action',
            intent,
            actions: items.map(i => ({ selector: i.selector, label: i.label })),
          },
        });
      } else {
        // Multiple actions with same intent → parameterized tool
        const labels = items.map(i => i.label).filter(Boolean);
        tools.push({
          name: toolName,
          description: `${verb}. ${items.length} option(s): ${labels.join(', ') || 'multiple'}`,
          params: {
            which: {
              type: 'string',
              description: `Which one to ${intent}? Options: ${labels.join(', ')}`,
              required: true,
              enum: labels.length > 0 ? labels : undefined,
            },
          },
          _internal: {
            type: 'action',
            intent,
            actions: items.map(i => ({ selector: i.selector, label: i.label })),
          },
        });
      }
    }

    // Also surface high-prominence standalone buttons (no intent, but visible and labeled)
    const standalone = actions.filter(a =>
      !a.intent && !a.disabled && !a.covered && a.tag !== 'a' && a.label
    );

    // Group standalone buttons that look actionable
    for (const btn of standalone.slice(0, 5)) {
      const name = `click_${this._normalizeParamName(btn.label)}`;
      if (tools.some(t => t.name === name)) continue;

      tools.push({
        name,
        description: `Click the "${btn.label}" button`,
        params: {},
        _internal: {
          type: 'action',
          intent: null,
          actions: [{ selector: btn.selector, label: btn.label }],
        },
      });
    }

    return tools;
  }

  // ── Navigation Links → Tool ──

  _linksToTools(actions) {
    const navLinks = actions.filter(a => a.tag === 'a' && a.href && a.label && !a.disabled && !a.covered);

    if (navLinks.length === 0) return [];

    // Deduplicate links by label
    const seen = new Set();
    const unique = [];
    for (const link of navLinks) {
      const key = link.label.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(link);
    }

    if (unique.length === 0) return [];

    const displayed = unique.slice(0, 15); // Cap at 15 for readability

    return [{
      name: 'navigate_to',
      description: `Navigate to a page or section. Available destinations: ${displayed.map(l => l.label).join(', ')}${unique.length > 15 ? ` (+${unique.length - 15} more)` : ''}`,
      params: {
        destination: {
          type: 'string',
          description: 'Name of the page/section to navigate to',
          required: true,
          enum: displayed.map(l => l.label),
        },
      },
      _internal: {
        type: 'navigation',
        linkMap: Object.fromEntries(displayed.map(l => [l.label, { selector: l.selector, href: l.href }])),
      },
    }];
  }

  // ── Page Classification ──

  _classifyPage(meta, forms, actions) {
    const title = (meta.title || '').toLowerCase();
    const url = (meta.url || '').toLowerCase();
    const intents = new Set(forms.map(f => f.intent).concat(actions.map(a => a.intent)).filter(Boolean));

    if (intents.has('authenticate')) return 'login';
    if (intents.has('register')) return 'registration';
    if (intents.has('search') && forms.length <= 2) return 'search';
    if (intents.has('purchase')) return 'checkout';
    if (intents.has('subscribe')) return 'subscription';
    if (/dashboard|admin|panel/i.test(title + url)) return 'dashboard';
    if (/settings|preferences|config/i.test(title + url)) return 'settings';
    if (/article|blog|post|news/i.test(title + url)) return 'article';
    if (forms.length > 3) return 'multi-form';
    if (forms.length === 0 && actions.length < 5) return 'static';
    if (actions.length > 20) return 'interactive';
    return 'general';
  }

  // ── Helpers ──

  _normalizeParamName(raw) {
    if (!raw) return 'field';
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30)
      || 'field';
  }

  _deduplicate(tools) {
    const seen = new Map();
    for (const tool of tools) {
      if (!seen.has(tool.name)) {
        seen.set(tool.name, tool);
      } else {
        // If duplicate, keep the one with more params (richer)
        const existing = seen.get(tool.name);
        if (Object.keys(tool.params).length > Object.keys(existing.params).length) {
          seen.set(tool.name, tool);
        }
      }
    }
    return [...seen.values()];
  }

  // ── Format converters for different platforms ──

  /**
   * Convert synthesized tools to OpenAI function-calling format.
   */
  toOpenAIFormat(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.params).map(([k, v]) => [k, {
              type: v.type || 'string',
              description: v.description || k,
              ...(v.enum ? { enum: v.enum } : {}),
            }])
          ),
          required: Object.entries(tool.params).filter(([, v]) => v.required).map(([k]) => k),
        },
      },
    }));
  }

  /**
   * Convert synthesized tools to Gemini functionDeclarations format.
   */
  toGeminiFormat(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, {
            type: (v.type || 'string').toUpperCase(),
            description: v.description || k,
            ...(v.enum ? { enum: v.enum } : {}),
          }])
        ),
        required: Object.entries(tool.params).filter(([, v]) => v.required).map(([k]) => k),
      },
    }));
  }

  /**
   * Convert synthesized tools to MCP tool format.
   */
  toMCPFormat(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, {
            type: v.type || 'string',
            description: v.description || k,
            ...(v.enum ? { enum: v.enum } : {}),
          }])
        ),
        required: Object.entries(tool.params).filter(([, v]) => v.required).map(([k]) => k),
      },
    }));
  }

  /**
   * Strip _internal metadata for client-facing output.
   * Returns tools safe to expose over API.
   */
  toPublicFormat(tools) {
    return tools.map(({ _internal, ...rest }) => rest);
  }
}


module.exports = { ToolSynthesizer, BASE_TOOLS, INTENT_TOOL_NAMES, INTENT_VERBS };
