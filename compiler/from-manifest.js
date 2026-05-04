/**
 * AGENTDOM.md manifest loader.
 *
 * App owners ship a single markdown file describing their app's agent
 * surface — semantic intent names, label aliases, workflow notes. The
 * scanner provides the raw element list; the manifest gives the *meaning*.
 * Same idea as OpenAPI for HTTP APIs or llms.txt for sites.
 *
 * File format (see docs/MANIFEST-SPEC.md):
 *
 *   ---
 *   app: Calculator
 *   platform: desktop
 *   framework: swiftui
 *   aliases:
 *     "+": Add
 *     "-": Subtract
 *   notes:
 *     - Display value is in AXValue, not AXTitle.
 *     - Run All Clear before any new computation.
 *   tools:
 *     - name: clear
 *       description: Reset the display
 *       click: All Clear
 *     - name: copy_result
 *       description: Copy the current result to the clipboard
 *       click: Copy
 *   ---
 *
 *   # Free-form documentation below the frontmatter ...
 *
 * The loader is dependency-free — parses the YAML-ish frontmatter with a
 * small handwritten parser (object + list + scalar; no nested mappings).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_DIRS = [
  path.join(process.env.HOME || '', '.agentdom', 'manifests'),    // user override
  path.join(__dirname, '..', 'manifests'),                         // bundled
];

/** Read manifest content for `appName`, or null if none found. */
function findManifestFile(appName) {
  const candidates = [appName, appName.replace(/\s+/g, '_'), appName.toLowerCase()];
  for (const dir of MANIFEST_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const c of candidates) {
      const p = path.join(dir, `${c}.md`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Extract the `---\n...\n---` YAML frontmatter block from markdown source. */
function extractFrontmatter(source) {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

/**
 * Indent-driven YAML-ish parser. Handles:
 *   key: scalar
 *   key:
 *     - listitem
 *     - listitem
 *   key:
 *     subkey: scalar
 *     "quoted key": scalar
 *   list:
 *     - inline_key: inline_value
 *       continued_key: continued_value
 * No multi-line strings, no anchors, no flow style. Quotes stripped from
 * keys/values. Comments (#) ignored.
 */
function parseYamlIsh(text) {
  const stripQuotes = s => {
    if (typeof s !== 'string') return s;
    const m = s.match(/^(["'])(.*)\1$/);
    return m ? m[2] : s;
  };
  const splitColon = line => {
    const i = line.indexOf(':');
    return i === -1 ? null : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  };

  // Tokenize: indent + trimmed line, dropping blanks/comments.
  const tokens = text.split(/\r?\n/)
    .map(raw => ({ indent: raw.match(/^ */)[0].length, line: raw.trim() }))
    .filter(t => t.line && !t.line.startsWith('#'));

  let pos = 0;

  function parseBlock(parentIndent) {
    // Decide container shape from first child line: starts with "- " → list, else map.
    if (pos >= tokens.length || tokens[pos].indent <= parentIndent) return null;
    const isList = tokens[pos].line.startsWith('- ');
    const block = isList ? [] : {};

    while (pos < tokens.length && tokens[pos].indent > parentIndent) {
      const cur = tokens[pos];
      if (cur.indent <= parentIndent) break;

      if (cur.line.startsWith('- ')) {
        // List item.
        const rest = cur.line.slice(2).trim();
        const itemIndent = cur.indent;
        pos++;

        if (!rest) {
          // Bare "- " followed by indented children: parse as nested.
          const child = parseBlock(itemIndent);
          block.push(child ?? null);
          continue;
        }

        const kv = splitColon(rest);
        if (kv && /^[A-Za-z_][\w "'-]*$/.test(kv[0])) {
          // Inline mapping in list item: "- name: foo" plus optional sibling keys
          // at greater indent than itemIndent.
          const obj = {};
          if (kv[1]) obj[stripQuotes(kv[0])] = stripQuotes(kv[1]);
          else obj[stripQuotes(kv[0])] = parseBlock(itemIndent + 2 - 1);
          // Continued mapping fields at column > itemIndent + 2 (matching " - " width).
          while (pos < tokens.length && tokens[pos].indent > itemIndent && !tokens[pos].line.startsWith('- ')) {
            const sub = tokens[pos];
            const skv = splitColon(sub.line);
            if (!skv) { pos++; continue; }
            const subKey = stripQuotes(skv[0]);
            pos++;
            if (skv[1]) obj[subKey] = stripQuotes(skv[1]);
            else obj[subKey] = parseBlock(sub.indent);
          }
          block.push(obj);
        } else {
          // Plain scalar list item.
          block.push(stripQuotes(rest));
        }
        continue;
      }

      // Mapping entry "key: value" or "key:".
      const kv = splitColon(cur.line);
      if (!kv) { pos++; continue; }
      const key = stripQuotes(kv[0]);
      pos++;
      if (kv[1]) {
        block[key] = stripQuotes(kv[1]);
      } else {
        block[key] = parseBlock(cur.indent) ?? {};
      }
    }
    return block;
  }

  return parseBlock(-1) || {};
}

/**
 * Load and parse an AGENTDOM.md manifest for `appName`. Returns:
 *   { app, platform?, framework?, aliases: {label:label}, notes: [string], tools: [{name, description, click?}] }
 * or null if no manifest exists.
 */
function loadManifest(appName) {
  const file = findManifestFile(appName);
  if (!file) return null;
  const source = fs.readFileSync(file, 'utf-8');
  const fmText = extractFrontmatter(source);
  if (!fmText) return null;
  const data = parseYamlIsh(fmText);

  const aliases = (data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases))
    ? data.aliases
    : {};
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const tools = Array.isArray(data.tools) ? data.tools.filter(t => t && t.name) : [];

  // Intent index: every tool may declare `intent: <dotted.id>` so cross-app
  // discovery can group capabilities (e.g. messaging.send → Slack + Discord).
  // Map: intent → list of tool names that provide it inside this manifest.
  const intents = {};
  for (const t of tools) {
    if (typeof t.intent === 'string' && t.intent.trim()) {
      const id = t.intent.trim();
      (intents[id] = intents[id] || []).push(t.name);
    }
  }

  return {
    app: data.app || appName,
    platform: data.platform,
    framework: data.framework,
    version: data.version,
    aliases,
    notes,
    tools,
    intents,
    sourcePath: file,
  };
}

/** Enumerate every manifest in the registry (user override + bundled).
 *  Returns a lightweight summary per file — used by discover_surfaces. */
function listManifests() {
  const seen = new Set();
  const out = [];
  for (const dir of MANIFEST_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir)) {
      if (!ent.endsWith('.md') || ent === 'README.md') continue;
      const file = path.join(dir, ent);
      const stem = ent.replace(/\.md$/, '');
      const key = stem.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const m = loadManifest(stem);
        if (!m) continue;
        out.push({
          app: m.app,
          stem,
          platform: m.platform,
          framework: m.framework,
          version: m.version,
          toolCount: m.tools.length,
          intents: Object.keys(m.intents || {}),
          sourcePath: file,
          override: dir.includes(path.join('.agentdom', 'manifests')),
        });
      } catch (_) { /* skip malformed */ }
    }
  }
  return out;
}

/** Resolve a label through manifest aliases. Returns the canonical label. */
function resolveAlias(label, manifest) {
  if (!manifest || !manifest.aliases) return label;
  return manifest.aliases[label] || label;
}

/** Convert a manifest tool's `params:` map into JSON-schema properties +
 *  required list, suitable for an MCP inputSchema. */
function paramsToSchema(params) {
  if (!params || typeof params !== 'object') return { properties: {}, required: [] };
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object') {
      properties[name] = { type: 'string' };
      continue;
    }
    properties[name] = {
      type: spec.type || 'string',
      description: spec.description || name,
    };
    if (spec.required === true || spec.required === 'true') required.push(name);
  }
  return { properties, required };
}

/** Augment a list of compiler-emitted MCP tools with manifest-declared tools.
 *  Manifest tools take priority on name collision. */
function mergeManifestTools(autoTools, manifest, app) {
  if (!manifest || !manifest.tools.length) return autoTools;
  const manifestTools = manifest.tools.map(t => {
    const { properties, required } = paramsToSchema(t.params);
    return {
      name: t.name,
      description: t.description || `Manifest tool "${t.name}" for ${app}`,
      inputSchema: { type: 'object', properties, required },
      _internal: {
        kind: 'manifest',
        app,
        manifest_action: t,
      },
    };
  });
  const seen = new Set(manifestTools.map(t => t.name));
  const merged = [...manifestTools];
  for (const t of autoTools) {
    if (!seen.has(t.name)) merged.push(t);
  }
  return merged;
}

module.exports = {
  loadManifest,
  listManifests,
  resolveAlias,
  mergeManifestTools,
  findManifestFile,
  extractFrontmatter,
  parseYamlIsh,
};
