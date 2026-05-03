/**
 * Optimizer — reduces IR to the useful, callable subset.
 *
 * Pass 1: dead-element elimination (disabled, covered, empty-label)
 * Pass 2: deduplication by (label, type) on actions
 * Pass 3: name normalization on action labels (slug for tool naming)
 * Pass 4: side-effect tagging from intent
 * Pass 5: priority ranking (intent-based)
 *
 * Operates on IR and returns IR — no shape change.
 */

'use strict';

const SIDE_EFFECT_BY_INTENT = {
  delete: ['delete'],
  create: ['create'],
  register: ['create'],
  authenticate: ['authenticate'],
  purchase: ['payment', 'create'],
  save: ['update'],
  update: ['update'],
  upload: ['upload'],
  download: ['download'],
  'navigate-forward': ['navigate'],
  'navigate-back': ['navigate'],
};

const PRIORITY_BY_INTENT = {
  authenticate: 1, register: 1, purchase: 1, create: 1, delete: 1, save: 1,
  search: 2, update: 2, upload: 2, download: 2,
  share: 3, subscribe: 3, toggle: 3,
  'navigate-forward': 3, 'navigate-back': 3,
  dismiss: 4, refresh: 4,
};

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isDead(action) {
  if (!action) return true;
  if (!action.label || !action.label.trim()) return true;
  if (action.enabled === false) return true;
  if (action.covered === true) return true;
  if (action.visible === false) return true;
  return false;
}

function dedupeActions(actions) {
  const seen = new Map();
  const out = [];
  for (const a of actions) {
    const key = `${a.type}::${a.label}::${a.selector}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    out.push(a);
  }
  return out;
}

function annotate(action) {
  const sideEffects = action.sideEffects && action.sideEffects.length
    ? action.sideEffects
    : (SIDE_EFFECT_BY_INTENT[action.intent] || []);
  const priority = PRIORITY_BY_INTENT[action.intent] || 5;
  const slug = slugify(action.label);
  return { ...action, sideEffects, priority, slug };
}

function optimize(ir) {
  const liveActions = ir.actions.filter(a => !isDead(a));
  const deduped = dedupeActions(liveActions);
  const annotated = deduped.map(annotate).sort((a, b) => a.priority - b.priority);

  const liveForms = ir.forms.map(f => ({
    ...f,
    fields: f.fields.filter(field => field.label || field.name),
    submitAction: f.submitAction && !isDead(f.submitAction) ? annotate(f.submitAction) : null,
  })).filter(f => f.fields.length > 0);

  const liveNav = ir.navigation.filter(n => n.label && n.target);

  return {
    ...ir,
    forms: liveForms,
    actions: annotated,
    navigation: liveNav,
  };
}

module.exports = { optimize, slugify, isDead };
