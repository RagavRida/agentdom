/**
 * Adapter: OpenAPI 3.x spec → IR.
 *
 * Each operation becomes:
 *   - one IR action (clickable / invokable)
 *   - one IR form when the operation has parameters or a JSON request body
 *     (the form's submitAction is the operation itself)
 *
 * The selector is a JSON-stringified `{method, path}` so the executor can
 * dispatch the HTTP call. Path-level $ref resolution is best-effort — only
 * top-level component-schema refs are inlined; deeply nested $ref chains pass
 * through as-is (the executor can resolve them with the spec on hand).
 */

'use strict';

const { makeIR, makeField, makeAction, makeForm } = require('./ir');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const INTENT_BY_METHOD = {
  get: 'search',
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
};

const FIELD_TYPE_FROM_OPENAPI = {
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  string: 'string',
  array: 'string', // serialised; per-item type-checking deferred to executor
  object: 'string',
};

function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = spec;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return null;
  }
  return cur;
}

function resolveSchema(spec, schema) {
  if (!schema) return null;
  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref);
    return resolved || schema;
  }
  return schema;
}

function paramToField(spec, p) {
  const schema = resolveSchema(spec, p.schema) || {};
  const type = FIELD_TYPE_FROM_OPENAPI[schema.type] || 'string';
  return makeField({
    name: p.name,
    type,
    required: !!p.required,
    label: p.description || p.name,
    options: schema.enum || undefined,
    selector: `${p.in}:${p.name}`,
  });
}

function bodyToFields(spec, body) {
  if (!body) return [];
  const content = body.content || {};
  const json = content['application/json'];
  if (!json) return [];
  const schema = resolveSchema(spec, json.schema);
  if (!schema || schema.type !== 'object' || !schema.properties) return [];

  const required = new Set(schema.required || []);
  const fields = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    const ps = resolveSchema(spec, raw) || {};
    const type = FIELD_TYPE_FROM_OPENAPI[ps.type] || 'string';
    fields.push(makeField({
      name,
      type,
      required: required.has(name),
      label: ps.description || name,
      options: ps.enum || undefined,
      selector: `body:${name}`,
    }));
  }
  return fields;
}

function operationLabel(op, method, path) {
  return op.operationId || op.summary || `${method.toUpperCase()} ${path}`;
}

function fromOpenAPI(spec) {
  if (!spec || !spec.paths) {
    throw new Error('from-openapi expects an OpenAPI 3.x document with .paths');
  }

  const actions = [];
  const forms = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;

      const intent = INTENT_BY_METHOD[method];
      const label = operationLabel(op, method, path);
      const selector = JSON.stringify({ method: method.toUpperCase(), path });
      const sideEffects = method === 'get' ? [] : [intent];

      const action = makeAction({
        label,
        intent,
        type: 'button',
        enabled: true,
        visible: true,
        covered: false,
        selector,
        sideEffects,
      });
      actions.push(action);

      const params = (op.parameters || []).filter(p => ['query', 'path', 'header'].includes(p.in));
      const paramFields = params.map(p => paramToField(spec, p));
      const bodyFields = bodyToFields(spec, op.requestBody);
      const fields = [...paramFields, ...bodyFields];

      if (fields.length > 0) {
        forms.push(makeForm({
          id: op.operationId || `${method}_${path}`,
          intent,
          fields,
          submitAction: action,
        }));
      }
    }
  }

  return makeIR({
    meta: {
      title: spec.info?.title || 'API',
      url: spec.servers?.[0]?.url,
      app: spec.info?.title,
      platform: 'api',
      version: spec.info?.version,
    },
    forms,
    actions,
    navigation: [],
    state: [],
  });
}

module.exports = { fromOpenAPI, resolveRef };
