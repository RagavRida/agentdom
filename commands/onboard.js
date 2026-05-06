#!/usr/bin/env node
/**
 * agentdom onboard  ─  OpenClaw‑style first‑run setup wizard.
 *
 * Guides the user through:
 *   1. LLM provider selection  (OpenAI · Anthropic · OpenRouter · Ollama)
 *   2. Integrations            (GitHub · Linear · Slack · Notion · …)
 *   3. Browser (Chrome CDP)    (auto‑detect or guided launch)
 *   4. Run a first test goal   (smoke‑test that everything works)
 *   5. Export wallet           (optional base64 export for CI)
 *
 * Inspired by OpenClaw's `openclaw setup` + `openclaw onboard` TUI.
 */

'use strict';

const readline = require('readline');
const { execSync, exec } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ── ANSI colours ───────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[38;2;0;212;170m',
  purple: '\x1b[38;2;167;139;250m',
  orange: '\x1b[38;2;251;146;60m',
  blue:   '\x1b[38;2;96;165;250m',
  red:    '\x1b[38;2;239;68;68m',
  gray:   '\x1b[38;2;136;136;160m',
  white:  '\x1b[37m',
  cyan:   '\x1b[38;2;34;211;238m',
  yellow: '\x1b[38;2;250;204;21m',
};

const p = (msg, color = C.white) => process.stdout.write(`${color}${msg}${C.reset}\n`);
const pr = (msg, color = C.white) => process.stdout.write(`${color}${msg}${C.reset}`);
const ok  = msg => p(`  ${C.green}✓${C.reset}  ${msg}`);
const err = msg => p(`  ${C.red}✗${C.reset}  ${msg}`);
const inf = msg => p(`  ${C.blue}→${C.reset}  ${msg}`);
const dim = msg => p(`  ${C.gray}${msg}${C.reset}`);
const nl  = () => p('');

// ── readline helpers ───────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, a => res(a.trim())));

async function choose(prompt, options, defaultIdx = 0) {
  nl();
  p(`  ${C.bold}${prompt}${C.reset}`);
  options.forEach((o, i) => {
    const bullet = i === defaultIdx ? `${C.green}▶${C.reset}` : `${C.gray}•${C.reset}`;
    p(`  ${bullet}  [${i + 1}]  ${o.label}  ${o.hint ? C.gray + o.hint + C.reset : ''}`);
  });
  nl();
  const raw = await ask(`  ${C.cyan}Enter number (default ${defaultIdx + 1}):${C.reset}  `);
  const idx = raw === '' ? defaultIdx : parseInt(raw, 10) - 1;
  return options[Math.min(Math.max(idx, 0), options.length - 1)];
}

async function secret(prompt) {
  return new Promise(res => {
    process.stdout.write(`  ${C.cyan}${prompt}${C.reset}  `);
    let val = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function handler(ch) {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        res(val.trim());
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        val = val.slice(0, -1);
      } else {
        val += ch;
        process.stdout.write('•');
      }
    });
  });
}

// ── Banner ─────────────────────────────────────────────────────────────────
function banner() {
  p('');
  p(`${C.purple}  ┌────────────────────────────────────────────────────┐${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.bold}${C.green}AgentDOM${C.reset}  ${C.gray}—  Universal Runtime for AI Agents${C.reset}   ${C.purple}│${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.dim}Browser · Desktop · REST · MCP · Any LLM${C.reset}       ${C.purple}│${C.reset}`);
  p(`${C.purple}  └────────────────────────────────────────────────────┘${C.reset}`);
  p('');
  p(`  ${C.dim}This wizard sets up AgentDOM in ~2 minutes.${C.reset}`);
  p(`  ${C.dim}Press Ctrl‑C at any time to cancel.${C.reset}`);
  p('');
}

// ── Helpers ────────────────────────────────────────────────────────────────
const WALLET_FILE = path.join(os.homedir(), '.agentdom', 'wallet.json');
const CONFIG_FILE = path.join(os.homedir(), '.agentdom', 'config.json');

function readWallet() {
  try { return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); } catch { return { providers: {} }; }
}
function saveWallet(w) {
  fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
  fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2));
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

function storeKey(provider, key, type = 'api_key') {
  const w = readWallet();
  w.providers = w.providers || {};
  w.providers[provider] = { type, token: key, stored_at: new Date().toISOString() };
  saveWallet(w);
}

function isProviderSet(provider) {
  const w = readWallet();
  return !!(w.providers?.[provider]?.token);
}

async function cdpAvailable() {
  try {
    const r = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

// ── Step 1 — LLM provider ─────────────────────────────────────────────────
async function setupLLM() {
  p(`\n  ${C.bold}${C.yellow}Step 1 of 4 — LLM Provider${C.reset}\n`);
  p(`  ${C.dim}AgentDOM needs a language model to reason about goals.${C.reset}`);

  const providers = [
    { label: 'OpenRouter  (300+ models, single API key)', hint: 'openrouter.ai', key: 'openrouter' },
    { label: 'OpenAI     (GPT‑4o / GPT‑4‑turbo)',         hint: 'platform.openai.com', key: 'openai' },
    { label: 'Anthropic  (Claude Sonnet / Haiku)',         hint: 'console.anthropic.com', key: 'anthropic' },
    { label: 'Ollama     (local, free, private)',          hint: 'ollama.com', key: 'ollama' },
    { label: 'Skip       (I already set env vars)',        hint: '', key: 'skip' },
  ];

  const choice = await choose('Which LLM provider do you want to use?', providers);

  if (choice.key === 'skip') {
    ok('Skipping — will use existing OPENROUTER_API_KEY / OPENAI_API_KEY env vars');
    return;
  }

  if (choice.key === 'ollama') {
    nl();
    inf('Ollama runs locally. Make sure it is running: `ollama serve`');
    const model = await ask(`  ${C.cyan}Ollama model name (default: llama3):${C.reset}  `);
    const cfg = readConfig();
    cfg.llm = { provider: 'ollama', model: model || 'llama3', base_url: 'http://localhost:11434' };
    saveConfig(cfg);
    ok(`Saved: ollama/${model || 'llama3'}`);
    return;
  }

  const keyUrls = {
    openrouter: 'https://openrouter.ai/keys',
    openai:     'https://platform.openai.com/api-keys',
    anthropic:  'https://console.anthropic.com/settings/keys',
  };

  const envVars = {
    openrouter: 'OPENROUTER_API_KEY',
    openai:     'OPENAI_API_KEY',
    anthropic:  'ANTHROPIC_API_KEY',
  };

  nl();
  inf(`Get your API key at: ${C.cyan}${keyUrls[choice.key]}${C.reset}`);
  nl();
  const key = await secret(`Paste your ${choice.label.split(' ')[0]} API key:`);

  if (!key) { err('No key entered — skipping'); return; }

  // Save to wallet AND write to shell profile
  storeKey(choice.hint || `${choice.key}.com`, key, 'api_key');

  const envVar = envVars[choice.key];
  const shellLine = `export ${envVar}="${key}"`;
  const profile = path.join(os.homedir(), '.zshenv');
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
  if (!existing.includes(envVar)) {
    fs.appendFileSync(profile, `\n# AgentDOM — added by agentdom onboard\n${shellLine}\n`);
    inf(`Added to ~/.zshenv: ${envVar}`);
  }

  // Also set for current process
  process.env[envVar] = key;

  // Save model preference
  const modelMap = {
    openrouter: 'anthropic/claude-sonnet-4-5',
    openai:     'gpt-4o',
    anthropic:  'claude-3-5-sonnet-20241022',
  };
  const cfg = readConfig();
  cfg.llm = { provider: choice.key, model: modelMap[choice.key], env_var: envVar };
  saveConfig(cfg);

  ok(`${choice.label.split(' ')[0]} key saved  (${key.slice(0, 8)}…)`);
}

// ── Step 2 — Integrations ─────────────────────────────────────────────────
const INTEGRATIONS = [
  { label: 'GitHub',   provider: 'github.com',   hint: 'Issues, PRs, repos' },
  { label: 'Linear',   provider: 'linear.app',   hint: 'Project management' },
  { label: 'Slack',    provider: 'slack.com',     hint: 'Messaging / channels' },
  { label: 'Notion',   provider: 'notion.so',     hint: 'Docs and databases' },
  { label: 'Jira',     provider: 'jira.atlassian.net', hint: 'Tickets and sprints' },
  { label: 'Resend',   provider: 'resend.com',    hint: 'Email sending' },
  { label: 'Stripe',   provider: 'stripe.com',    hint: 'Payments' },
];

async function setupIntegrations() {
  p(`\n  ${C.bold}${C.yellow}Step 2 of 4 — Integrations${C.reset}\n`);
  p(`  ${C.dim}Connect the tools your agent will act on. Press Enter to skip any.${C.reset}`);
  nl();

  const alreadySet = INTEGRATIONS.filter(i => isProviderSet(i.provider));
  if (alreadySet.length) {
    ok(`Already set up: ${alreadySet.map(i => i.label).join(', ')}`);
  }

  for (const integration of INTEGRATIONS) {
    if (isProviderSet(integration.provider)) continue;

    const yn = await ask(
      `  ${C.bold}${integration.label}${C.reset} ${C.gray}(${integration.hint})${C.reset}  ${C.cyan}Set up? [y/N]:${C.reset}  `
    );
    if (!yn.toLowerCase().startsWith('y')) {
      dim(`  Skipped ${integration.label}`);
      continue;
    }

    nl();
    inf(`Running: agentdom setup ${integration.provider}`);

    try {
      // Spawn the existing setup command
      const setupCmd = path.join(__dirname, '..', 'cli.js');
      execSync(`node "${setupCmd}" setup "${integration.provider}" 2>&1`, {
        stdio: 'inherit',
        env: process.env,
      });
    } catch (e) {
      err(`Setup failed for ${integration.label}: ${e.message.slice(0, 60)}`);
    }
    nl();
  }
}

// ── Step 3 — Browser (Chrome CDP) ─────────────────────────────────────────
async function setupBrowser() {
  p(`\n  ${C.bold}${C.yellow}Step 3 of 4 — Browser (Chrome CDP)${C.reset}\n`);
  p(`  ${C.dim}AgentDOM controls Chrome via CDP for browser actions.${C.reset}`);
  nl();

  const available = await cdpAvailable();

  if (available) {
    ok('Chrome CDP already running on localhost:9222');
    return;
  }

  err('Chrome not detected on localhost:9222');
  nl();

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(fs.existsSync);

  if (chromePaths.length === 0) {
    err('No Chrome / Chromium found. Install from https://google.com/chrome');
    inf('Once installed, start it with:');
    p(`  ${C.cyan}/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\${C.reset}`);
    p(`  ${C.cyan}  --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile${C.reset}`);
    return;
  }

  const choice = await choose(
    'Start Chrome for AgentDOM now?',
    [
      { label: 'Yes — launch Chrome with CDP (port 9222)', hint: '' },
      { label: 'No  — I\'ll start it manually',            hint: '' },
    ]
  );

  if (choice.label.startsWith('No')) {
    nl();
    inf('Start Chrome manually with:');
    p(`  ${C.cyan}"${chromePaths[0]}" --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile &${C.reset}`);
    return;
  }

  nl();
  inf(`Launching Chrome from: ${chromePaths[0]}`);
  exec(`"${chromePaths[0]}" --remote-debugging-port=9222 --user-data-dir=/tmp/agentdom-profile`);

  // Wait for CDP to come up
  pr(`  ${C.gray}Waiting for Chrome`, C.gray);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 500));
    pr('.', C.gray);
    if (await cdpAvailable()) { nl(); ok('Chrome started on :9222'); return; }
  }
  nl();
  err('Chrome did not start in time — try manually');
}

// ── Step 4 — Test run ─────────────────────────────────────────────────────
async function testRun() {
  p(`\n  ${C.bold}${C.yellow}Step 4 of 4 — Smoke Test${C.reset}\n`);
  p(`  ${C.dim}Running a quick goal to confirm everything works.${C.reset}`);
  nl();

  const goal = 'Go to https://news.ycombinator.com and tell me the title and score of the top story.';

  inf(`Goal: "${goal}"`);
  nl();

  const yn = await ask(`  ${C.cyan}Run this test now? [Y/n]:${C.reset}  `);
  if (yn.toLowerCase().startsWith('n')) {
    dim('Skipped test — you can run it later with: agentdom run "..."');
    return;
  }

  nl();
  const cliPath = path.join(__dirname, '..', 'cli.js');
  try {
    execSync(`node "${cliPath}" run "${goal}"`, { stdio: 'inherit', env: process.env });
  } catch (e) {
    err(`Test run failed: ${e.message.slice(0, 80)}`);
    inf('If you see an LLM error, check your API key. If browser fails, re-run step 3.');
  }
}

// ── Export wallet for CI ───────────────────────────────────────────────────
async function exportWallet() {
  nl();
  p(`  ${C.bold}${C.purple}Optional — Export wallet for CI/Docker${C.reset}\n`);

  const yn = await ask(`  ${C.cyan}Export wallet as base64 (for CI env vars)? [y/N]:${C.reset}  `);
  if (!yn.toLowerCase().startsWith('y')) return;

  const wallet = readWallet();
  const providers = Object.keys(wallet.providers || {});
  if (!providers.length) { dim('No providers in wallet to export'); return; }

  const b64 = Buffer.from(JSON.stringify(wallet)).toString('base64');
  nl();
  p(`  ${C.bold}Copy this into your CI secret named AGENTDOM_WALLET_B64:${C.reset}`);
  nl();
  p(`  ${C.green}${b64.slice(0, 80)}…${C.reset}  ${C.gray}(${b64.length} chars total)${C.reset}`);
  nl();

  // Write to file
  const outFile = path.join(os.homedir(), '.agentdom', 'wallet.b64');
  fs.writeFileSync(outFile, `AGENTDOM_WALLET_B64=${b64}\n`);
  ok(`Full base64 saved to: ${outFile}`);
  inf('Add it as a repo secret at: https://github.com/settings/tokens');
  nl();
}

// ── Summary ────────────────────────────────────────────────────────────────
function summary() {
  const w = readWallet();
  const cfg = readConfig();
  const providers = Object.keys(w.providers || {});

  nl();
  p(`${C.purple}  ┌──────────────── Setup Complete ──────────────────┐${C.reset}`);
  p(`${C.purple}  │${C.reset}`);

  if (cfg.llm) {
    p(`${C.purple}  │${C.reset}  ${C.green}✓${C.reset}  LLM: ${C.bold}${cfg.llm.provider}/${cfg.llm.model}${C.reset}`);
  }
  if (providers.length) {
    p(`${C.purple}  │${C.reset}  ${C.green}✓${C.reset}  Integrations: ${C.bold}${providers.join(', ')}${C.reset}`);
  }

  p(`${C.purple}  │${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.bold}Quick start:${C.reset}`);
  p(`${C.purple}  │${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.cyan}agentdom run "Open Notion and create a page titled Hello World"${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.cyan}agentdom run "Create a GitHub issue in my repo about X"${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.cyan}agentdom doctor${C.reset}              ${C.gray}# health check${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.cyan}agentdom wallet export --base64${C.reset} ${C.gray}# for CI${C.reset}`);
  p(`${C.purple}  │${C.reset}`);
  p(`${C.purple}  │${C.reset}  ${C.dim}Docs: https://docs.getagentdom.com${C.reset}`);
  p(`${C.purple}  └──────────────────────────────────────────────────┘${C.reset}`);
  nl();
}

// ── Doctor command ─────────────────────────────────────────────────────────
async function doctor() {
  banner();
  p(`  ${C.bold}${C.yellow}agentdom doctor  —  Health Check${C.reset}\n`);

  // LLM
  const cfg = readConfig();
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasOpenAI     = !!process.env.OPENAI_API_KEY;
  const hasAnthropic  = !!process.env.ANTHROPIC_API_KEY;
  const hasLLM        = hasOpenRouter || hasOpenAI || hasAnthropic || cfg.llm?.provider === 'ollama';
  hasLLM ? ok('LLM configured') : err('No LLM key found — run: agentdom onboard');

  // Chrome
  const browser = await cdpAvailable();
  browser ? ok('Chrome CDP running on :9222') : err('Chrome CDP not found — start Chrome with --remote-debugging-port=9222');

  // Wallet
  const w = readWallet();
  const providers = Object.keys(w.providers || {});
  providers.length
    ? ok(`Wallet: ${providers.join(', ')}`)
    : inf('No integrations set up — run: agentdom onboard');

  // Node version
  const nodeVer = parseInt(process.version.slice(1));
  nodeVer >= 20 ? ok(`Node ${process.version}`) : err(`Node ${process.version} is old — upgrade to v20+`);

  nl();
  if (!hasLLM || !browser) {
    inf('Fix issues above, then run: agentdom run "goal: ..."');
  } else {
    ok('All checks passed — AgentDOM is ready!');
  }
  nl();
}

// ── Main entry ─────────────────────────────────────────────────────────────
async function main(args = []) {
  if (args.includes('doctor') || args.includes('--doctor')) {
    await doctor();
    rl.close();
    return;
  }

  banner();
  p(`  ${C.dim}This is a one‑time setup. Re‑run anytime to add more integrations.${C.reset}`);
  nl();

  const yn = await ask(`  ${C.cyan}Ready to get started? [Y/n]:${C.reset}  `);
  if (yn.toLowerCase().startsWith('n')) {
    p('\n  Cancelled. Run again anytime with: agentdom onboard\n');
    rl.close();
    return;
  }

  await setupLLM();
  await setupIntegrations();
  await setupBrowser();
  await testRun();
  await exportWallet();
  summary();

  rl.close();
}

module.exports = { main, doctor };

// Run directly
if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
