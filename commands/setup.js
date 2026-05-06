/**
 * agentdom setup <provider> — one-time interactive credential setup.
 *
 * This is the ONLY command that requires a human.
 * Run it once per provider, then agents operate headlessly forever.
 *
 * Usage:
 *   agentdom setup linear.app           — OAuth PKCE (opens browser)
 *   agentdom setup github.com           — Device flow (enter code at URL)
 *   agentdom setup resend.com           — API key prompt (paste once)
 *   agentdom setup openrouter.ai --key=sk-or-v1-xxx   — non-interactive (CI)
 *   agentdom setup --list               — show what's already set up
 *
 * After setup:
 *   agentdom wallet export --base64 --providers=linear.app
 *   → AGENTDOM_WALLET_B64=... (give this to your agent)
 */

'use strict';

const readline = require('readline');
const { auth, discover } = require('./auth');
const secrets  = require('../lib/secrets');

const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  orange: s => `\x1b[38;5;208m${s}\x1b[0m`,
};

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// Determine what type of auth a provider needs
async function detectAuthMethod(host) {
  const d = await discover(host).catch(() => null);
  if (d?.manifest?.auth?.method) return d.manifest.auth;

  // Check oauth-pkce registry
  try {
    const { OAUTH_REGISTRY } = require('../lib/oauth-pkce');
    if (OAUTH_REGISTRY[host]) return { method: 'oauth2_pkce', ...OAUTH_REGISTRY[host] };
  } catch {}

  return { method: 'unknown' };
}

async function runSetup(host, opts = {}) {
  console.log(`\n${C.bold('AgentDOM Setup')} — one-time credential setup for ${C.cyan(host)}\n`);

  // Already set up?
  const existing = await secrets.resolve(host);
  if (existing && !opts.force) {
    console.log(`${C.green('✓')} ${host} is already set up ${C.dim(`(source: ${existing.source})`)}`);
    console.log(C.dim(`  Run with --force to re-authenticate\n`));
    return { skipped: true, provider: host, source: existing.source };
  }

  const authInfo = await detectAuthMethod(host);
  const method   = opts.key ? 'api_key' : authInfo.method;

  // ── API key ────────────────────────────────────────────────────────────────
  if (method === 'api_key' || method === 'unknown') {
    let key = opts.key;
    if (!key) {
      const obtainUrl = authInfo.obtain_url || `https://${host}/settings/api-keys`;
      console.log(`${C.yellow('→')} ${host} uses API key authentication.`);
      console.log(`${C.dim(`  Get your key at: ${obtainUrl}`)}\n`);
      key = await prompt(`  Paste your ${host} API key: `);
      if (!key) { console.error('No key provided.'); process.exit(1); }
    }
    const entry = await auth({ provider: host, key, force: opts.force });
    console.log(`\n${C.green('✓')} Authenticated ${C.bold(host)} ${C.dim('(api_key)')}`);
    printNextSteps(host);
    return entry;
  }

  // ── OAuth PKCE ─────────────────────────────────────────────────────────────
  if (method === 'oauth2_pkce' || method === 'oauth2') {
    console.log(`${C.yellow('→')} ${host} uses OAuth. Your browser will open for authorization.`);
    console.log(`${C.dim('  This is the only time you\'ll need to do this.')}\n`);
    const entry = await auth({ provider: host, force: opts.force });
    console.log(`\n${C.green('✓')} Authenticated ${C.bold(host)} ${C.dim('(oauth2 — refresh token stored)')}`);
    printNextSteps(host);
    return entry;
  }

  // ── Device flow ────────────────────────────────────────────────────────────
  if (method === 'device_flow') {
    console.log(`${C.yellow('→')} ${host} uses device flow.`);
    console.log(`${C.dim('  You\'ll be given a code to enter at a URL — no browser redirect needed.')}\n`);
    const entry = await auth({ provider: host, force: opts.force });
    console.log(`\n${C.green('✓')} Authenticated ${C.bold(host)} ${C.dim('(device_flow)')}`);
    printNextSteps(host);
    return entry;
  }

  console.error(`Unknown auth method for ${host}: ${method}`);
  process.exit(1);
}

function printNextSteps(host) {
  console.log(`\n${C.dim('─'.repeat(60))}`);
  console.log(`${C.bold('\nNext steps — give this credential to your agent:\n')}`);
  console.log(`  ${C.cyan('Option 1')} — Base64 wallet (Docker / serverless / CI):`);
  console.log(`    ${C.dim('agentdom wallet export --base64 --providers=' + host)}`);
  console.log(`    ${C.dim('→ copy the AGENTDOM_WALLET_B64=... line into your agent env\n')}`);
  console.log(`  ${C.cyan('Option 2')} — Env var (12-factor apps):`);
  const envVar = 'AGENTDOM_' + host.toUpperCase().replace(/[^A-Z0-9]/g,'_') + '_KEY';
  console.log(`    ${C.dim('agentdom wallet env --providers=' + host)}`);
  console.log(`    ${C.dim('→ export ' + envVar + '=...\n')}`);
  console.log(`  ${C.cyan('Option 3')} — File (local / server):`);
  console.log(`    ${C.dim('agentdom wallet create --agent=my-agent --providers=' + host)}`);
  console.log(`    ${C.dim('→ AGENTDOM_WALLET_PATH=~/.agentdom/my-agent.wallet.json\n')}`);
  console.log(`${C.green('✓')} After this, your agent runs headlessly — no more human steps.\n`);
}

// ── Multi-provider setup ──────────────────────────────────────────────────────
async function runBatchSetup(hosts, opts) {
  console.log(`\n${C.bold('AgentDOM Setup')} — setting up ${hosts.length} provider(s)\n`);
  const results = [];
  for (const host of hosts) {
    try {
      const r = await runSetup(host, opts);
      results.push({ host, ok: true, ...r });
    } catch (e) {
      console.error(`  ${host}: ${e.message}`);
      results.push({ host, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Show setup status ─────────────────────────────────────────────────────────
async function showStatus() {
  const known = await secrets.list();
  const byHost = {};
  for (const e of known) {
    if (!byHost[e.host]) byHost[e.host] = [];
    byHost[e.host].push(e);
  }

  const hosts = Object.keys(byHost);
  if (!hosts.length) {
    console.log(`\n${C.yellow('No providers set up yet.')}`);
    console.log(`Run: ${C.cyan('agentdom setup <provider>')} to add one.\n`);
    console.log(`Supported providers:`);
    console.log(`  linear.app, hubspot.com, vercel.com, slack.com, notion.so`);
    console.log(`  supabase.com, resend.com, cal.com, openrouter.ai, stripe.com`);
    console.log(`  github.com, anthropic.com, openai.com\n`);
    return;
  }

  console.log(`\n${C.bold('AgentDOM Setup Status')}\n`);
  for (const host of hosts) {
    const entries = byHost[host];
    const sources = entries.map(e => e.source).join(', ');
    const method  = entries[0].method || 'api_key';
    console.log(`  ${C.green('✓')} ${host.padEnd(30)} ${C.dim(method + ' — ' + sources)}`);
  }
  console.log();
  console.log(C.dim(`  Run 'agentdom wallet export --base64' to package for an agent.`));
  console.log();
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(`
${C.bold('agentdom setup')} — one-time credential setup (the ONLY human step)

${C.yellow('Usage:')}
  agentdom setup <provider>               Interactive setup
  agentdom setup <provider> --key=<val>   Non-interactive (for scripts)
  agentdom setup <provider> --force       Re-authenticate even if set up
  agentdom setup --list                   Show what's already set up
  agentdom setup linear.app resend.com    Set up multiple providers

${C.yellow('Examples:')}
  agentdom setup linear.app              OAuth — browser opens once
  agentdom setup github.com              Device flow — enter code at URL
  agentdom setup resend.com              API key — paste once
  agentdom setup openrouter.ai --key=sk-or-v1-xxx

${C.yellow('After setup — give credentials to your agent (no human needed):')}
  agentdom wallet export --base64 --providers=linear.app
  → AGENTDOM_WALLET_B64=eyJ...  (single env var for Docker/CI/serverless)
`);
    return;
  }

  if (argv[0] === '--list' || argv[0] === 'list') {
    await showStatus();
    return;
  }

  const opts = {
    force: argv.includes('--force'),
    key:   (argv.find(a => a.startsWith('--key=')) || '').replace('--key=', '') || null,
  };
  const hosts = argv.filter(a => !a.startsWith('--'));

  if (hosts.length === 1) {
    await runSetup(hosts[0], opts);
  } else {
    await runBatchSetup(hosts, opts);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { runSetup, showStatus };
