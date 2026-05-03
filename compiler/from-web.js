/**
 * Adapter: web scanPage() output → IR.
 *
 * Input shape (from agentdom.js):
 *   { _aidl, generatedAt, page: { meta, forms: [...], actions: [...] } }
 */

'use strict';

const { makeIR, makeField, makeAction, makeForm } = require('./ir');

const FIELD_TYPE_MAP = {
  text: 'string', email: 'email', password: 'password', tel: 'string',
  url: 'string', search: 'string', date: 'date', 'datetime-local': 'date',
  time: 'string', month: 'string', week: 'string', color: 'string',
  number: 'number', range: 'number',
  file: 'file', hidden: 'string',
  checkbox: 'boolean', radio: 'string', select: 'select',
  textarea: 'string', richtext: 'string',
};

function fieldTypeFromInput(t) {
  return FIELD_TYPE_MAP[t] || 'string';
}

function fromWeb(scan) {
  if (!scan || !scan.page) {
    throw new Error('from-web expects scanPage() result with .page');
  }
  const { meta = {}, forms = [], actions = [] } = scan.page;

  const irForms = forms.map(f => makeForm({
    id: f.id,
    intent: f.intent,
    fields: (f.fields || []).map(field => makeField({
      name: field.name,
      type: fieldTypeFromInput(field.type),
      required: !!field.required,
      label: field.label || field.name || '',
      value: field.value ?? null,
      selector: field.selector,
    })),
    submitAction: f.submitButton ? makeAction({
      label: f.submitButton.label || 'Submit',
      intent: f.intent,
      type: 'button',
      enabled: true,
      visible: true,
      covered: false,
      selector: f.submitButton.selector,
      sideEffects: f.method === 'POST' ? ['create'] : [],
    }) : null,
  }));

  const irActions = [];
  const irNavigation = [];
  for (const a of actions) {
    if (a.tag === 'a' && a.href) {
      irNavigation.push({
        label: a.label || a.href,
        target: a.href,
        intent: a.intent,
      });
      continue;
    }
    irActions.push(makeAction({
      label: a.label || '',
      intent: a.intent,
      type: a.tag === 'a' ? 'link' : 'button',
      enabled: !a.disabled,
      visible: true,
      covered: !!a.covered,
      selector: a.selector,
      sideEffects: [],
    }));
  }

  return makeIR({
    meta: {
      title: meta.title,
      url: meta.url,
      description: meta.description,
      language: meta.language,
      platform: 'web',
    },
    forms: irForms,
    actions: irActions,
    navigation: irNavigation,
    state: [],
  });
}

module.exports = { fromWeb };
