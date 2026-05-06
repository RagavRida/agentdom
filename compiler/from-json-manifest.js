/**
 * AgentDOM compiler — JSON API manifest → typed tool schema
 *
 * Converts manifests/*.json (the AgentDOM provider format) into properly
 * typed tool descriptors with full parameter schemas. This replaces the
 * ad-hoc hand-parsing in buildToolCatalog() and makeDispatcher().
 *
 * Input (manifests/hubspot.com.json shape):
 *   {
 *     host: "hubspot.com",
 *     version: "1",
 *     auth: { method, header, format, ... },
 *     capabilities: [
 *       {
 *         intent:      "contacts.create",
 *         description: "Create a new contact",
 *         method:      "POST",
 *         endpoint:    "https://api.hubspot.com/crm/v3/objects/contacts",
 *         side_effects: ["external"],
 *         params: {
 *           email:      { type: "string", required: true,  description: "..." },
 *           first_name: { type: "string", required: false, description: "..." },
 *         }
 *       }
 *     ]
 *   }
 *
 * Output per capability:
 *   {
 *     intent:      "contacts.create",
 *     provider:    "hubspot.com",
 *     description: "Create a new contact",
 *     side_effects: ["external"],
 *     input_schema: { type: "object", properties: {...}, required: [...] },
 *     endpoint:    "https://api.hubspot.com/crm/v3/objects/contacts",
 *     method:      "POST",
 *     auth:        { method, header, format },
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Type coercion ─────────────────────────────────────────────────────────────

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function normalizeType(t) {
  if (!t) return 'string';
  const lower = String(t).toLowerCase();
  if (lower === 'int') return 'integer';
  if (lower === 'float' || lower === 'double') return 'number';
  if (lower === 'bool') return 'boolean';
  if (lower === 'list') return 'array';
  if (lower === 'map' || lower === 'dict') return 'object';
  return JSON_SCHEMA_TYPES.has(lower) ? lower : 'string';
}

// ── Param map → JSON Schema ───────────────────────────────────────────────────

/**
 * Convert a capability's `params` map into a proper JSON Schema object.
 * Handles both:
 *   - Object notation:  { email: { type, required, description } }
 *   - Array notation:   [{ name, type, required, description }]
 *   - Bare strings:     { email: "Contact email" }
 */
function paramsToSchema(params) {
  if (!params) return { type: 'object', properties: {}, required: [] };

  const properties = {};
  const required   = [];

  const entries = Array.isArray(params)
    ? params.map(p => [p.name, p])
    : Object.entries(params);

  for (const [name, spec] of entries) {
    if (!name) continue;

    if (typeof spec === 'string') {
      // Bare string = description only
      properties[name] = { type: 'string', description: spec };
      continue;
    }

    const type = normalizeType(spec.type);
    const prop = { type, description: spec.description || name };

    if (spec.enum)    prop.enum    = spec.enum;
    if (spec.default !== undefined) prop.default = spec.default;
    if (type === 'array' && spec.items) prop.items = { type: normalizeType(spec.items) };

    properties[name] = prop;
    if (spec.required === true || spec.required === 'true') required.push(name);
  }

  return { type: 'object', properties, required };
}

// ── Single manifest → tool descriptors ───────────────────────────────────────

/**
 * Compile one JSON manifest object into an array of tool descriptors.
 * Does NOT read the filesystem — accepts the parsed manifest directly.
 *
 * @param {object} manifest  — parsed manifest JSON
 * @returns {object[]}  array of tool descriptors
 */
function fromManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.capabilities)) return [];
  const host = manifest.host || 'unknown';
  const auth = manifest.auth || {};

  return manifest.capabilities.map(cap => {
    const schema = paramsToSchema(cap.params || cap.args);
    return {
      intent:       cap.intent,
      provider:     host,
      description:  cap.description || cap.intent,
      side_effects: cap.side_effects || ['external'],
      input_schema: schema,
      // Execution metadata (used by dispatcher)
      endpoint:     cap.endpoint,
      method:       (cap.method || 'GET').toUpperCase(),
      auth,
      // URL template params (e.g. { id } in "/contacts/{id}")
      path_params:  extractPathParams(cap.endpoint),
    };
  });
}

/** Extract {param} names from a URL template. */
function extractPathParams(url) {
  if (!url) return [];
  return (url.match(/\{(\w+)\}/g) || []).map(m => m.slice(1, -1));
}

// ── Filesystem loader ─────────────────────────────────────────────────────────

/**
 * Load and compile all manifests from a directory.
 *
 * @param {string} dir  — absolute path to manifests directory
 * @returns {{ tools: object[], errors: string[] }}
 */
function fromDirectory(dir) {
  const tools  = [];
  const errors = [];

  if (!fs.existsSync(dir)) return { tools, errors };

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(dir, file);
    try {
      const raw      = fs.readFileSync(fullPath, 'utf-8');
      const manifest = JSON.parse(raw);
      const compiled = fromManifest(manifest);
      tools.push(...compiled);
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }

  return { tools, errors };
}

/**
 * Format compiled tools as a markdown catalog section for LLM prompts.
 * Groups by provider, shows intent + description + required params.
 */
function toCatalogString(tools, { showParams = true } = {}) {
  if (!tools.length) return '(no provider tools)';

  // Group by provider
  const byProvider = {};
  for (const t of tools) {
    if (!byProvider[t.provider]) byProvider[t.provider] = [];
    byProvider[t.provider].push(t);
  }

  const lines = [];
  for (const [provider, pts] of Object.entries(byProvider)) {
    lines.push(`\n**${provider}** (${pts.length} intents):`);
    for (const t of pts.slice(0, 8)) {
      const required = t.input_schema.required;
      const paramStr = required.length
        ? ` — required: ${required.join(', ')}`
        : '';
      lines.push(`  · dispatch_intent("${t.intent}", {...}, "${provider}") — ${t.description}${paramStr}`);
    }
    if (pts.length > 8) lines.push(`  ... and ${pts.length - 8} more`);
  }
  return lines.join('\n');
}

module.exports = { fromManifest, fromDirectory, paramsToSchema, toCatalogString };
