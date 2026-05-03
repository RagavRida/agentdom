/**
 * Adapter: desktop scanApp() output → IR.
 *
 * Input shape (from desktop-agent/index.js):
 *   [{ type, label, description, value, enabled, focused, actions, path, position, size,
 *      originalLabel?, duplicateIndex?, duplicateCount?, framework? }]
 *   plus an optional leading {type:'_meta', framework:'electron', ...} marker.
 */

'use strict';

const { makeIR, makeField, makeAction, makeForm } = require('./ir');

function slugifyName(s) {
  const slug = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return slug || 'field';
}

const FIELD_TYPES_FROM_DESKTOP = {
  text_input: 'string',
  text_area: 'string',
  search_field: 'string',
  combo_box: 'select',
};

const ACTION_TYPES_FROM_DESKTOP = {
  button: 'button',
  menu_item: 'menu',
  menu: 'menu',
  link: 'link',
  tab: 'button',
  dropdown: 'button',
  checkbox: 'button',
  radio: 'button',
};

const NAV_TYPES = new Set(['link', 'tab', 'menu']);
const STATE_TYPES = new Set(['checkbox', 'radio']);

function inferIntentFromLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/log\s?in|sign\s?in/.test(l)) return 'authenticate';
  if (/sign\s?up|register|join/.test(l)) return 'register';
  if (/search|find|lookup/.test(l)) return 'search';
  if (/submit|send|post/.test(l)) return 'create';
  if (/^(create|new)\b/.test(l)) return 'create';
  if (/delete|remove|trash/.test(l)) return 'delete';
  if (/^save\b/.test(l)) return 'save';
  if (/buy|purchase|checkout/.test(l)) return 'purchase';
  if (/subscribe/.test(l)) return 'subscribe';
  if (/^(next|continue)\b/.test(l)) return 'navigate-forward';
  if (/^(back|previous)\b/.test(l)) return 'navigate-back';
  if (/^(close|dismiss|cancel|✕|×)\b|^(close|dismiss|cancel)$/.test(l)) return 'dismiss';
  if (/download/.test(l)) return 'download';
  if (/upload|attach/.test(l)) return 'upload';
  if (/share/.test(l)) return 'share';
  if (/refresh|reload/.test(l)) return 'refresh';
  return null;
}

function fromDesktop(scan, { appName = '' } = {}) {
  if (!Array.isArray(scan)) {
    throw new Error('from-desktop expects scanApp() array output');
  }
  const elements = scan.filter(e => e && e.type !== '_meta');
  const metaMarker = scan.find(e => e && e.type === '_meta');

  const fields = [];
  const actions = [];
  const navigation = [];
  const state = [];

  for (const el of elements) {
    if (!el.label) continue;
    const selector = el.path || '';

    if (FIELD_TYPES_FROM_DESKTOP[el.type]) {
      fields.push(makeField({
        // Slug the param name (agent-facing) while preserving the original AX
        // label in `label` for dispatch via desktop.typeIntoField(label, value).
        name: slugifyName(el.label),
        type: FIELD_TYPES_FROM_DESKTOP[el.type],
        required: false,
        label: el.label,
        value: el.value ?? null,
        selector,
      }));
      continue;
    }

    if (STATE_TYPES.has(el.type)) {
      state.push({ name: el.label, type: 'boolean', value: !!el.value });
      continue;
    }

    if (NAV_TYPES.has(el.type)) {
      navigation.push({
        label: el.label,
        target: el.value || el.path || null,
        intent: inferIntentFromLabel(el.label),
      });
      continue;
    }

    if (ACTION_TYPES_FROM_DESKTOP[el.type]) {
      actions.push(makeAction({
        label: el.label,
        intent: inferIntentFromLabel(el.label),
        type: ACTION_TYPES_FROM_DESKTOP[el.type],
        enabled: el.enabled !== false,
        visible: true,
        covered: false,
        selector,
        sideEffects: [],
      }));
    }
  }

  // Form-grouping heuristic v1: if any fields exist, group them all into a single
  // synthetic form, attach the most likely submit action (first 'create'/'authenticate'
  // /'register'/'search' action, falling back to the first enabled action).
  const forms = [];
  if (fields.length > 0) {
    const submitIntents = ['authenticate', 'register', 'create', 'search', 'save', 'subscribe', 'purchase'];
    const submit =
      actions.find(a => submitIntents.includes(a.intent) && a.enabled) ||
      actions.find(a => a.enabled) ||
      null;
    forms.push(makeForm({
      id: 'main',
      intent: submit?.intent || null,
      fields,
      submitAction: submit,
    }));
  }

  return makeIR({
    meta: {
      app: appName || (metaMarker?.app ?? null),
      platform: 'desktop',
      framework: metaMarker?.framework || 'native',
    },
    forms,
    actions,
    navigation,
    state,
  });
}

module.exports = { fromDesktop, inferIntentFromLabel };
