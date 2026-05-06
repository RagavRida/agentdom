#!/usr/bin/env node
/**
 * agentdom onboard  ─  Claude‑Code‑style interactive setup wizard.
 * agentdom doctor   ─  Health check.
 */

'use strict';

const readline = require('readline');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── ANSI ──────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const R   = '\x1b[0m';
const clr = {
  bold:    s => `\x1b[1m${s}${R}`,
  dim:     s => `\x1b[2m${s}${R}`,
  orange:  s => `\x1b[38;2;210;118;60m${s}${R}`,
  white:   s => `\x1b[97m${s}${R}`,
  gray:    s => `\x1b[38;2;128;128;148m${s}${R}`,
  green:   s => `\x1b[38;2;80;200;140m${s}${R}`,
  red:     s => `\x1b[38;2;220;60;60m${s}${R}`,
  blue:    s => `\x1b[38;2;90;160;240m${s}${R}`,
  yellow:  s => `\x1b[38;2;220;180;60m${s}${R}`,
  cyan:    s => `\x1b[38;2;60;200;220m${s}${R}`,
  bgDark:  s => `\x1b[48;2;24;24;32m${s}${R}`,
};

const W = process.stdout.columns || 72;

const out   = s => process.stdout.write(s + '\n');
const outr  = s => process.stdout.write(s);
const blank = () => out('');

function rule(char = '─', color = clr.dim) {
  out(color('  ' + char.repeat(Math.min(W - 4, 68))));
}

function box(lines, style = 'single') {
  const width = Math.min(W - 4, 68);
  const tl = '╭', tr = '╮', bl = '╰', br = '╯', h = '─', v = '│';
  out('  ' + clr.dim(tl + h.repeat(width - 2) + tr));
  for (const l of lines) {
    const stripped = l.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = width - 4 - stripped.length;
    out('  ' + clr.dim(v) + '  ' + l + ' '.repeat(Math.max(0, pad)) + '  ' + clr.dim(v));
  }
  out('  ' + clr.dim(bl + h.repeat(width - 2) + br));
}

// ── readline ──────────────────────────────────────────────────────────────
let _rl;
function getRl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
const ask = q => new Promise(res => getRl().question(q, a => res(a.trim())));

async function askSecret(label) {
  outr(`  ${clr.cyan('❯')} ${label}: `);
  return new Promise(res => {
    let val = '';
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const handler = ch => {
      if (ch === '\r' || ch === '\n') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw || false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        out('');
        res(val.trim());
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        if (val.length) { val = val.slice(0, -1); outr('\b \b'); }
      } else {
        val += ch;
        outr(clr.dim('•'));
      }
    };
    process.stdin.on('data', handler);
  });
}

// Key/value status row
function row(label, value, status = 'ok') {
  const icon = status === 'ok'  ? clr.green('✓')
             : status === 'err' ? clr.red('✗')
             : status === 'warn'? clr.yellow('!')
             :                    clr.dim('·');
  const lpad = ' '.repeat(Math.max(0, 16 - label.length));
  out(`  ${icon}  ${clr.dim(label)}${lpad} ${clr.white(value)}`);
}

// Spinner (simple progress dots)
async function withSpinner(msg, fn) {
  outr(`  ${clr.dim('⟳')}  ${clr.dim(msg)}`);
  const interval = setInterval(() => outr(clr.dim('.')), 400);
  try {
    const r = await fn();
    clearInterval(interval);
    out('  ' + clr.green('done'));
    return r;
  } catch (e) {
    clearInterval(interval);
    out('  ' + clr.red('failed'));
    throw e;
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────
const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');
const WALLET_FILE  = path.join(AGENTDOM_DIR, 'wallet.json');
const CONFIG_FILE  = path.join(AGENTDOM_DIR, 'config.json');

function readWallet() { try { return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); } catch { return { providers: {} }; } }
function saveWallet(w) { fs.mkdirSync(AGENTDOM_DIR, { recursive: true }); fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2)); }
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; } }
function saveConfig(c) { fs.mkdirSync(AGENTDOM_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

function storeKey(provider, key, type = 'api_key') {
  const w = readWallet();
  (w.providers = w.providers || {})[provider] = { type, token: key, stored_at: new Date().toISOString() };
  saveWallet(w);
}
function isProviderSet(p) { return !!(readWallet().providers?.[p]?.token); }

async function cdpAvailable() {
  try { return (await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

// ── Banner ────────────────────────────────────────────────────────────────
function banner() {
  // Clear screen for fresh feel
  process.stdout.write('\x1bc'); // soft reset (clears scroll without flicker)
  blank();

  // Logo row — diamond + name (Claude‑Code style)
  out(`  ${clr.orange('◆')}  ${clr.bold(clr.white('AgentDOM'))}  ${clr.dim('v3.5.4')}`);
  blank();

  // Info bar (like Claude's model / cwd line)
  const cwd     = process.cwd().replace(os.homedir(), '~');
  const cfg     = readConfig();
  const model   = cfg.llm?.model ?? clr.dim('no model set');
  const wallet  = readWallet();
  const nprov   = Object.keys(wallet.providers || {}).length;

  out(`  ${clr.dim('model')}  ${clr.cyan(model)}    ${clr.dim('integrations')}  ${clr.cyan(String(nprov))}    ${clr.dim('cwd')}  ${clr.dim(cwd.slice(0, 32))}`);
  rule();
}

// ── Prompt helper ─────────────────────────────────────────────────────────
async function prompt(question, defaultVal = '') {
  const hint = defaultVal ? clr.dim(` (${defaultVal})`) : '';
  const ans  = await ask(`  ${clr.cyan('❯')} ${question}${hint}: `);
  return ans || defaultVal;
}

async function confirmYN(question, def = true) {
  const hint = def ? 'Y/n' : 'y/N';
  const ans  = await ask(`  ${clr.cyan('❯')} ${question} ${clr.dim('[' + hint + ']')}: `);
  return ans === '' ? def : ans.toLowerCase().startsWith('y');
}

async function pickOne(question, items) {
  blank();
  out(`  ${clr.bold(question)}`);
  blank();
  items.forEach((item, i) => {
    const num = clr.orange(`[${i + 1}]`);
    const desc = item.hint ? `  ${clr.dim(item.hint)}` : '';
    out(`     ${num}  ${item.label}${desc}`);
  });
  blank();
  const raw = await ask(`  ${clr.cyan('❯')} Choose${clr.dim(` 1–${items.length}`)}: `);
  const idx = parseInt(raw, 10) - 1;
  return items[Math.min(Math.max(isNaN(idx) ? 0 : idx, 0), items.length - 1)];
}

// ── Step 1: LLM ───────────────────────────────────────────────────────────
async function setupLLM() {
  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◈'))}  ${clr.bold('LLM Provider')}  ${clr.dim('step 1 of 4')}`);
  rule('─');
  blank();
  out(`  ${clr.dim('AgentDOM needs a language model to reason about your goals.')}`);

  const PROVIDERS = [
    { label: 'OpenRouter',  hint: '300+ models, one key — openrouter.ai',       key: 'openrouter', envVar: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys',              model: 'anthropic/claude-sonnet-4-5' },
    { label: 'Anthropic',   hint: 'Claude Sonnet / Haiku — console.anthropic.com', key: 'anthropic', envVar: 'ANTHROPIC_API_KEY',  url: 'https://console.anthropic.com/settings/keys', model: 'claude-3-5-sonnet-20241022' },
    { label: 'OpenAI',      hint: 'GPT-4o / GPT-4-turbo — platform.openai.com', key: 'openai',     envVar: 'OPENAI_API_KEY',      url: 'https://platform.openai.com/api-keys',    model: 'gpt-4o' },
    { label: 'Ollama',      hint: 'local & free — ollama.com',                   key: 'ollama',     envVar: null,                  url: null,                                      model: 'llama3' },
    { label: 'Skip',        hint: 'env vars already set',                         key: 'skip',       envVar: null,                  url: null,                                      model: null },
  ];

  // Detect existing
  const detected = PROVIDERS.find(p => p.envVar && process.env[p.envVar]);
  if (detected) {
    blank();
    row(detected.label, 'already configured', 'ok');
    const keep = await confirmYN('Keep existing key?');
    if (keep) return;
  }

  const choice = await pickOne('Which LLM provider?', PROVIDERS);
  if (choice.key === 'skip') { row('LLM', 'skipped', 'warn'); return; }

  if (choice.key === 'ollama') {
    const model = await prompt('Ollama model name', 'llama3');
    const cfg = readConfig(); cfg.llm = { provider: 'ollama', model, base_url: 'http://localhost:11434' }; saveConfig(cfg);
    row('Ollama', model, 'ok');
    return;
  }

  blank();
  out(`  ${clr.dim('Get your key at')}  ${clr.cyan(choice.url)}`);
  blank();
  const key = await askSecret(`${choice.label} API key`);
  if (!key) { row(choice.label, 'skipped', 'warn'); return; }

  storeKey(`${choice.key}.com`, key);
  process.env[choice.envVar] = key;

  const profile = path.join(os.homedir(), '.zshenv');
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
  if (!existing.includes(choice.envVar)) {
    fs.appendFileSync(profile, `\n# AgentDOM\nexport ${choice.envVar}="${key}"\n`);
  }

  const cfg = readConfig(); cfg.llm = { provider: choice.key, model: choice.model, env_var: choice.envVar }; saveConfig(cfg);
  row(choice.label, `${key.slice(0, 8)}…  saved`, 'ok');
}

// ── Step 2: Integrations ──────────────────────────────────────────────────
const INTEGRATIONS = [
  { label: 'GitHub',  provider: 'github.com',          hint: 'issues · PRs · repos' },
  { label: 'Linear',  provider: 'linear.app',           hint: 'project management' },
  { label: 'Slack',   provider: 'slack.com',            hint: 'messaging · channels' },
  { label: 'Notion',  provider: 'notion.so',            hint: 'docs · databases' },
  { label: 'Resend',  provider: 'resend.com',           hint: 'email sending' },
  { label: 'Jira',    provider: 'jira.atlassian.net',   hint: 'tickets · sprints' },
];

async function setupIntegrations() {
  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◈'))}  ${clr.bold('Integrations')}  ${clr.dim('step 2 of 4')}`);
  rule('─');
  blank();
  out(`  ${clr.dim('Connect the services your agent will act on. Press Enter to skip any.')}`);
  blank();

  const alreadySet = INTEGRATIONS.filter(i => isProviderSet(i.provider));
  if (alreadySet.length) row('configured', alreadySet.map(i => i.label).join('  '), 'ok');
  blank();

  for (const ig of INTEGRATIONS) {
    if (isProviderSet(ig.provider)) continue;
    const yn = await confirmYN(`Set up ${clr.bold(ig.label)}  ${clr.dim(ig.hint)}?`, false);
    if (!yn) { row(ig.label, 'skipped', 'dim'); continue; }
    blank();
    try {
      execSync(`node "${path.join(__dirname, '..', 'cli.js')}" setup "${ig.provider}"`, { stdio: 'inherit', env: process.env });
      row(ig.label, 'configured', 'ok');
    } catch { row(ig.label, 'failed — re-run: agentdom setup ' + ig.provider, 'err'); }
    blank();
  }
}

// ── Step 3: Browser ───────────────────────────────────────────────────────
async function setupBrowser() {
  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◈'))}  ${clr.bold('Browser (Chrome CDP)')}  ${clr.dim('step 3 of 4')}`);
  rule('─');
  blank();
  out(`  ${clr.dim('AgentDOM controls Chrome via CDP for any browser task.')}`);
  blank();

  if (await cdpAvailable()) { row('Chrome CDP', 'running on :9222', 'ok'); return; }
  row('Chrome CDP', 'not detected', 'err');
  blank();

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(fs.existsSync);

  if (!chromePaths.length) {
    out(`  ${clr.dim('Install Chrome from')} ${clr.cyan('https://google.com/chrome')} ${clr.dim('then run:')}`);
    blank();
    out(`  ${clr.dim('/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\')}`);
    out(`  ${clr.dim('  --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile')}`);
    return;
  }

  const launch = await confirmYN('Launch Chrome with CDP now?');
  if (!launch) {
    blank();
    out(`  ${clr.dim('Start manually:')}`);
    out(`  ${clr.cyan(`"${chromePaths[0]}" --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile &`)}`);
    return;
  }

  exec(`"${chromePaths[0]}" --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile`);
  outr(`  ${clr.dim('Starting Chrome')}`);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 500)); outr(clr.dim('.'));
    if (await cdpAvailable()) { out(''); row('Chrome CDP', 'started on :9222', 'ok'); return; }
  }
  out('');
  row('Chrome CDP', 'did not start — try manually', 'err');
}

// ── Step 4: Test run ──────────────────────────────────────────────────────
async function testRun() {
  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◈'))}  ${clr.bold('Smoke Test')}  ${clr.dim('step 4 of 4')}`);
  rule('─');
  blank();
  out(`  ${clr.dim('Runs a real goal to confirm AgentDOM is working end-to-end.')}`);
  blank();

  const goal = 'Go to https://news.ycombinator.com and tell me the title and score of the top story.';
  out(`  ${clr.dim('goal')}  ${clr.white(goal)}`);
  blank();

  const run = await confirmYN('Run this test now?');
  if (!run) { row('smoke test', 'skipped', 'warn'); return; }
  blank();

  try {
    execSync(`node "${path.join(__dirname, '..', 'cli.js')}" run "${goal}"`, { stdio: 'inherit', env: process.env });
    blank();
    row('smoke test', 'passed', 'ok');
  } catch {
    row('smoke test', 'failed — check LLM key / Chrome', 'err');
  }
}

// ── CI export ─────────────────────────────────────────────────────────────
async function exportWallet() {
  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◈'))}  ${clr.bold('Export for CI / Docker')}  ${clr.dim('optional')}`);
  rule('─');
  blank();
  out(`  ${clr.dim('Encodes your wallet as base64 for AGENTDOM_WALLET_B64 env var.')}`);
  blank();

  const yn = await confirmYN('Export wallet now?', false);
  if (!yn) return;

  const w = readWallet();
  if (!Object.keys(w.providers || {}).length) { row('wallet', 'empty — nothing to export', 'warn'); return; }

  const b64 = Buffer.from(JSON.stringify(w)).toString('base64');
  const outFile = path.join(AGENTDOM_DIR, 'wallet.b64');
  fs.writeFileSync(outFile, `AGENTDOM_WALLET_B64=${b64}\n`);

  blank();
  out(`  ${clr.dim('Set this in your CI secret named')} ${clr.bold('AGENTDOM_WALLET_B64')}`);
  blank();
  out(`  ${clr.dim('Saved to:')}  ${clr.cyan(outFile)}`);
  out(`  ${clr.dim('Preview:')}   ${clr.dim(b64.slice(0, 60))}${clr.dim('…')}`);
}

// ── Summary ────────────────────────────────────────────────────────────────
function summary() {
  const w   = readWallet();
  const cfg = readConfig();
  const provs = Object.keys(w.providers || {});

  blank();
  rule('─');
  out(`  ${clr.bold(clr.orange('◆'))}  ${clr.bold('Setup complete')}`);
  rule('─');
  blank();

  if (cfg.llm)    row('model',        `${cfg.llm.provider}/${cfg.llm.model}`, 'ok');
  if (provs.length) row('integrations', provs.join('  '), 'ok');
  row('docs',       'https://docs.getagentdom.com', 'dim');

  blank();
  out(`  ${clr.bold('Quick start')}`);
  blank();
  out(`  ${clr.orange('$')}  ${clr.white('agentdom run')} ${clr.dim('"Create a GitHub issue in my repo about X"')}`);
  out(`  ${clr.orange('$')}  ${clr.white('agentdom run')} ${clr.dim('"Open Notion and create a page titled Hello World"')}`);
  out(`  ${clr.orange('$')}  ${clr.white('agentdom doctor')}          ${clr.dim('# health check')}`);
  out(`  ${clr.orange('$')}  ${clr.white('agentdom wallet export')}   ${clr.dim('# CI export')}`);
  blank();
  rule('─');
  blank();
}

// ── Doctor ────────────────────────────────────────────────────────────────
async function doctor() {
  banner();
  out(`  ${clr.bold('agentdom doctor')}  ${clr.dim('— health check')}`);
  blank();

  const cfg = readConfig();
  const w   = readWallet();

  const hasLLM = !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || cfg.llm?.provider === 'ollama');
  row('LLM',          hasLLM ? (cfg.llm ? `${cfg.llm.provider}/${cfg.llm.model}` : 'env var set') : 'not configured — run: agentdom onboard', hasLLM ? 'ok' : 'err');

  const browser = await cdpAvailable();
  row('Chrome CDP',   browser ? 'running on :9222' : 'not found — start with --remote-debugging-port=9222', browser ? 'ok' : 'err');

  const provs = Object.keys(w.providers || {});
  row('integrations', provs.length ? provs.join('  ') : 'none — run: agentdom onboard', provs.length ? 'ok' : 'warn');

  const nodeOk = parseInt(process.version.slice(1)) >= 20;
  row('Node.js',      process.version, nodeOk ? 'ok' : 'err');

  row('config dir',   AGENTDOM_DIR, 'dim');

  blank();
  if (hasLLM && browser) {
    out(`  ${clr.green('✓')}  ${clr.bold('AgentDOM is ready.')}`);
  } else {
    out(`  ${clr.yellow('!')}  ${clr.dim('Fix the errors above, then run:')}  ${clr.cyan('agentdom run "your goal"')}`);
  }
  blank();
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(args = []) {
  if (args.includes('--doctor') || args.includes('doctor')) {
    await doctor();
    process.exit(0);
  }

  banner();
  out(`  ${clr.dim('First-time setup. Re-run anytime to add integrations.')}`);
  blank();

  const go = await confirmYN('Continue?');
  if (!go) { out('\n  Cancelled. Run again with: agentdom onboard\n'); process.exit(0); }

  await setupLLM();
  await setupIntegrations();
  await setupBrowser();
  await testRun();
  await exportWallet();
  summary();

  if (_rl) _rl.close();
}

module.exports = { main, doctor };

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
}
