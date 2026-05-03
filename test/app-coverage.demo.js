/**
 * App-coverage probe — scans every running app on the system and reports
 * what the AX bridge actually sees: framework, element count by type,
 * whether the scan was empty, hints when limitations apply.
 *
 * No clicking, no state mutation — pure read-only audit.  Tells the truth
 * about which surfaces work today and which need follow-up.
 *
 * Run: npm run demo:coverage
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const desktop = require('../desktop-agent');

function listAllRunningApps() {
  // Use the AX bridge's list_apps verb — uses NSWorkspace directly,
  // which sees apps that listApps() (via System Events) miscounts.
  const bridge = path.join(__dirname, '..', 'desktop-agent', 'ax-bridge.py');
  const raw = execFileSync('python3', [bridge, 'list_apps'], { encoding: 'utf-8', timeout: 5000 });
  return JSON.parse(raw);
}

const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', mag: '\x1b[35m', r: '\x1b[0m' };
const colorize = {
  full:    C.green + '▰▰▰▰' + C.r,
  good:    C.green + '▰▰▰' + C.dim + '▱' + C.r,
  partial: C.yellow + '▰▰' + C.dim + '▱▱' + C.r,
  thin:    C.yellow + '▰' + C.dim + '▱▱▱' + C.r,
  empty:   C.red + '▱▱▱▱' + C.r,
};

function classify(stats, frameworkOverride) {
  const total = stats.total || 0;
  if (total === 0) return 'empty';
  const interactive = (stats.button || 0) + (stats.text_input || 0) + (stats.text_area || 0) + (stats.search_field || 0) + (stats.checkbox || 0) + (stats.menu_item || 0);
  if (frameworkOverride === 'electron' && interactive < 10) return 'partial';
  if (interactive >= 30) return 'full';
  if (interactive >= 10) return 'good';
  if (interactive >= 3) return 'partial';
  return 'thin';
}

function statsOf(elements) {
  const by = {};
  for (const e of elements) by[e.type] = (by[e.type] || 0) + 1;
  by.total = elements.length;
  return by;
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function main() {
  const perm = desktop.checkPermissions();
  if (!perm.ok) { console.log('Accessibility not granted:', perm.hint); process.exit(1); }

  console.log(`${C.cyan}▸ Discovering running apps via NSWorkspace${C.r}`);
  const apps = listAllRunningApps()
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`  ${apps.length} regular (UI-bearing) apps running\n`);

  console.log(`${C.dim}coverage  app                          framework   elements  btn  field  menu  notes${C.r}`);
  console.log(`${C.dim}─${'─'.repeat(95)}${C.r}`);

  const summary = { full: 0, good: 0, partial: 0, thin: 0, empty: 0, errored: 0 };

  for (const app of apps) {
    let framework = 'unknown';
    let elements;
    let note = '';
    try { framework = desktop.detectFramework(app.name); } catch {}

    try {
      elements = desktop.scanApp(app.name);
    } catch (e) {
      summary.errored++;
      console.log(`  ${C.red}✗ ERR${C.r}     ${pad(app.name, 28)} ${pad(framework, 11)} ${C.red}scan threw: ${e.message.slice(0, 40)}${C.r}`);
      continue;
    }

    if (elements && !Array.isArray(elements) && elements.error) {
      summary.empty++;
      const tag = app.hidden ? 'hidden' : (elements.hint?.split(/\.|—/)[0] || elements.error);
      console.log(`  ${colorize.empty}  ${pad(app.name, 28)} ${pad(framework, 11)} ${C.dim}-          -    -      -     ${tag.slice(0, 30)}${C.r}`);
      continue;
    }

    const s = statsOf(elements);
    const fields = (s.text_input || 0) + (s.text_area || 0) + (s.search_field || 0);
    const cls = classify(s, framework);
    summary[cls]++;

    if (framework === 'electron') note = 'web content via CDP — TODO';
    else if (s.total > 0 && (s.button || 0) === 0 && (s.menu_item || 0) > 30) note = 'menubar only — depth/SwiftUI?';

    console.log(
      `  ${colorize[cls]}  ${pad(app.name, 28)} ${pad(framework, 11)} ${pad(s.total, 9)} ${pad(s.button || 0, 4)} ${pad(fields, 6)} ${pad(s.menu || 0, 5)} ${C.dim}${note}${C.r}`,
    );
  }

  // ── Summary ──
  console.log(`\n${C.cyan}▸ Coverage summary${C.r}`);
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  const fmt = (label, n, color) => `  ${color}${pad(label, 18)}${C.r} ${n}/${total} ${C.dim}(${Math.round(100 * n / total)}%)${C.r}`;
  console.log(fmt('full coverage', summary.full, C.green));
  console.log(fmt('good coverage', summary.good, C.green));
  console.log(fmt('partial', summary.partial, C.yellow));
  console.log(fmt('thin (chrome only)', summary.thin, C.yellow));
  console.log(fmt('empty / hidden', summary.empty, C.red));
  if (summary.errored) console.log(fmt('scan errored', summary.errored, C.red));

  // Honest takeaway
  console.log(`\n${C.dim}Notes on limitations the audit confirms:${C.r}`);
  console.log(`  ${C.dim}• Electron apps: scan sees the Chromium chrome (menus, toolbar) but not page content.`);
  console.log(`    The web MCP server handles those via Puppeteer + injected agentdom.js — different surface.${C.r}`);
  console.log(`  ${C.dim}• Hidden apps: AXWindows is empty. The bridge auto-activates on click/type, but pure scan${C.r}`);
  console.log(`  ${C.dim}  is read-only and won't focus-steal.${C.r}`);
  console.log(`  ${C.dim}• "menubar only" rows usually mean the app is hidden or its windows are off-screen.${C.r}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
