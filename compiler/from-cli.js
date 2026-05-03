/**
 * Adapter: CLI `--help` text → IR.
 *
 * Parses the most common help formats (Cobra, Click, argparse, GNU getopt):
 *   - Section headers like "Commands:", "Options:", "Flags:", "Subcommands:"
 *   - Subcommand lines:   "  <name>   <description>"
 *   - Flag lines:         "  -s, --long [ARG]   <description>"
 *                         "      --long-only   <description>"
 *                         "  -s                  <description>"
 *
 * The caller is responsible for capturing the help text safely (e.g. via
 * execFileSync). This adapter is pure: text in, IR out.
 */

'use strict';

const { makeIR, makeField, makeAction, makeForm } = require('./ir');

// Section header: any prose containing "...commands", "...options", "...flags", etc.
// followed by ":" with optional non-colon content in between (handles parenthetical
// qualifiers like "Basic Commands (Beginner):").
const SECTION_RE = /^.*?(commands?|options?|flags?|subcommands?|arguments?)[^:\n]*:\s*$/i;
const SUBCOMMAND_RE = /^\s{2,}([a-zA-Z][\w-]*)\s{2,}(.+?)\s*$/;
const FLAG_RE = /^\s{2,}(?:(-[a-zA-Z]),?\s+)?(--[\w-]+)(?:[\s=]([A-Z_<][\w<>\[\]]*))?\s{2,}(.+?)\s*$/;
const SHORT_ONLY_FLAG_RE = /^\s{2,}(-[a-zA-Z])(?:[\s=]([A-Z_<][\w<>\[\]]*))?\s{2,}(.+?)\s*$/;

function parseHelp(text) {
  const lines = String(text || '').split(/\r?\n/);
  const subcommands = [];
  const flags = [];
  let section = null;

  for (const line of lines) {
    if (!line.trim()) { continue; }

    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }

    if (section && /command|subcommand/.test(section)) {
      const m = line.match(SUBCOMMAND_RE);
      if (m) {
        subcommands.push({ name: m[1], description: m[2] });
        continue;
      }
    }

    if (section && /option|flag/.test(section)) {
      const m = line.match(FLAG_RE);
      if (m) {
        flags.push({
          short: m[1] ? m[1].slice(1) : null,
          long: m[2].slice(2),
          arg: m[3] || null,
          description: m[4],
        });
        continue;
      }
      const sm = line.match(SHORT_ONLY_FLAG_RE);
      if (sm) {
        flags.push({
          short: sm[1].slice(1),
          long: null,
          arg: sm[2] || null,
          description: sm[3],
        });
        continue;
      }
    }

    // Section-less heuristic: lines starting with "  --" or "  -X" pick up flags
    // even when the binary doesn't print explicit headers.
    if (!section || section === null) {
      const m = line.match(FLAG_RE);
      if (m) {
        flags.push({
          short: m[1] ? m[1].slice(1) : null,
          long: m[2].slice(2),
          arg: m[3] || null,
          description: m[4],
        });
      }
    }
  }

  return { subcommands, flags };
}

function flagToField(f) {
  const name = f.long || f.short;
  const type = f.arg ? 'string' : 'boolean';
  const selectorTok = f.long ? `--${f.long}` : `-${f.short}`;
  return makeField({
    name,
    type,
    required: false,
    label: f.description || name,
    selector: selectorTok,
  });
}

function fromCLI(helpText, { command = 'cli' } = {}) {
  const { subcommands, flags } = parseHelp(helpText);

  const actions = subcommands.map(sub => makeAction({
    label: sub.name,
    intent: null,
    type: 'button', // 'command' isn't in the makeAction enum — use button to keep IR uniform
    enabled: true,
    visible: true,
    covered: false,
    selector: `${command} ${sub.name}`,
    sideEffects: [],
  }));

  const forms = [];
  if (flags.length > 0) {
    const fields = flags.map(flagToField);
    forms.push(makeForm({
      id: command,
      intent: null,
      fields,
      submitAction: makeAction({
        label: command,
        intent: null,
        type: 'button',
        enabled: true,
        visible: true,
        covered: false,
        selector: command,
        sideEffects: [],
      }),
    }));
  }

  return makeIR({
    meta: { app: command, platform: 'cli' },
    forms,
    actions,
    navigation: [],
    state: [],
  });
}

module.exports = { fromCLI, parseHelp };
