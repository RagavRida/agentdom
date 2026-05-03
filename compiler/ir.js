/**
 * AgentDOM IR — universal UI graph that all scanners normalize to.
 *
 * Shape:
 *   {
 *     meta:       { title, url?, app?, platform },
 *     forms:      [{ id, intent, fields: [Field], submitAction: Action|null }],
 *     actions:    [Action],
 *     navigation: [{ label, target, intent }],
 *     state:      [{ name, type, value }],
 *   }
 *
 * Field:  { name, type, required, label, value, options?, constraints?, selector }
 * Action: { label, intent, type, enabled, visible, covered, selector, sideEffects }
 *
 * `selector` is opaque to the IR — callers store whatever the source emitter
 * needs (CSS path for web, AX path for desktop, command for CLI, etc.).
 */

'use strict';

const PLATFORMS = ['web', 'desktop', 'mobile', 'cli', 'api'];

const KNOWN_INTENTS = [
  'authenticate', 'register', 'search', 'create', 'delete',
  'save', 'purchase', 'subscribe', 'navigate-forward', 'navigate-back',
  'dismiss', 'download', 'upload', 'update', 'share', 'toggle',
  'sort', 'filter', 'refresh', 'copy', 'paste', 'undo', 'redo',
];

const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'email', 'password', 'file', 'select'];

function makeIR({ meta = {}, forms = [], actions = [], navigation = [], state = [] } = {}) {
  if (!PLATFORMS.includes(meta.platform)) {
    throw new Error(`IR.meta.platform must be one of: ${PLATFORMS.join(', ')}`);
  }
  return { meta, forms, actions, navigation, state };
}

function makeField({ name, type = 'string', required = false, label = '', value = null, options, constraints, selector = '' }) {
  if (!FIELD_TYPES.includes(type)) type = 'string';
  return { name, type, required, label, value, options, constraints, selector };
}

function makeAction({ label, intent = null, type = 'button', enabled = true, visible = true, covered = false, selector = '', sideEffects = [] }) {
  return { label, intent, type, enabled, visible, covered, selector, sideEffects };
}

function makeForm({ id = null, intent = null, fields = [], submitAction = null }) {
  return { id, intent, fields, submitAction };
}

module.exports = { makeIR, makeField, makeAction, makeForm, PLATFORMS, KNOWN_INTENTS, FIELD_TYPES };
