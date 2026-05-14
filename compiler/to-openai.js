/**
 * Codegen: optimized IR → OpenAI function-calling tool list.
 *
 * Each form becomes one tool (e.g. "login" with email/password params).
 * Each top-level action becomes one tool (parameter-less).
 * Navigation links become a single dispatch tool with a `target` enum.
 */

'use strict';

const { slugify } = require('./optimize');

const FIELD_PARAM_TYPE = {
  string: 'string', email: 'string', password: 'string', date: 'string',
  number: 'number', boolean: 'boolean', file: 'string', select: 'string',
};

const OPENAI_NAME_MAX = 64;

function safeName(raw, fallback = 'tool') {
  let n = String(raw || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) n = fallback;
  if (n.length > OPENAI_NAME_MAX) {
    const hash = require('crypto').createHash('sha1').update(n).digest('hex').slice(0, 6);
    n = n.slice(0, OPENAI_NAME_MAX - 7) + '_' + hash;
  }
  return n;
}

function fieldToParam(field) {
  const t = FIELD_PARAM_TYPE[field.type] || 'string';
  const schema = { type: t, description: field.label || field.name };
  if (field.options && field.options.length) {
    schema.enum = field.options;
  }
  return [field.name || slugify(field.label), schema];
}

function formToTool(form, ir) {
  const properties = {};
  const required = [];
  for (const field of form.fields) {
    const [name, schema] = fieldToParam(field);
    if (!name) continue;
    properties[name] = schema;
    if (field.required) required.push(name);
  }
  const intent = form.intent || form.submitAction?.intent;
  const submitSlug = form.submitAction?.label ? slugify(form.submitAction.label) : null;
  // Naming priority: known intent → invoke_<submit-label> → submit_<form-id> → generic.
  const rawName = intent
    ? slugify(intent)
    : submitSlug
      ? `invoke_${submitSlug}`
      : form.id
        ? `submit_${slugify(form.id)}`
        : 'submit_form';
  const name = safeName(rawName, 'submit_form');
  const labelHint = form.submitAction?.label || form.id || 'form';
  return {
    type: 'function',
    function: {
      name,
      description: `Submit "${labelHint}" form on ${ir.meta.app || ir.meta.title || ir.meta.platform}.`,
      parameters: {
        type: 'object',
        properties,
        required,
      },
      _internal: {
        kind: 'form',
        platform: ir.meta.platform,
        submitAction: form.submitAction,
        fields: form.fields,
      },
    },
  };
}

function actionToTool(action, ir) {
  const raw = action.slug || slugify(action.label);
  if (!raw) return null;
  const name = safeName(`click_${raw}`);
  return {
    type: 'function',
    function: {
      name,
      description: `Click "${action.label}" on ${ir.meta.app || ir.meta.title || ir.meta.platform}.`,
      parameters: { type: 'object', properties: {}, required: [] },
      _internal: {
        kind: 'action',
        platform: ir.meta.platform,
        intent: action.intent,
        sideEffects: action.sideEffects,
        selector: action.selector,
        label: action.label,
      },
    },
  };
}

function navigationToTool(navigation, ir) {
  if (!navigation.length) return null;
  const targets = navigation.map(n => n.label).filter(Boolean);
  if (!targets.length) return null;
  return {
    type: 'function',
    function: {
      name: 'navigate',
      description: `Follow a navigation link on ${ir.meta.app || ir.meta.title || ir.meta.platform}.`,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: targets, description: 'Link label to follow' },
        },
        required: ['target'],
      },
      _internal: { kind: 'navigation', platform: ir.meta.platform, links: navigation },
    },
  };
}

function toOpenAI(ir) {
  const tools = [];
  for (const form of ir.forms) tools.push(formToTool(form, ir));
  for (const action of ir.actions) {
    const tool = actionToTool(action, ir);
    if (tool) tools.push(tool);
  }
  const nav = navigationToTool(ir.navigation, ir);
  if (nav) tools.push(nav);

  // Dedupe by name (last write wins is fine; usually identical)
  const seen = new Set();
  return tools.filter(t => {
    const n = t.function.name;
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

module.exports = { toOpenAI };
