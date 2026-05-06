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

// ── Deep auth auto-detection ───────────────────────────────────────────────
// Priority:
//   1. .well-known/agentdom.json  → definitive (manifest says exactly what to do)
//   2. OAUTH_REGISTRY             → pre-registered known providers
//   3. .well-known/oauth-authorization-server → RFC 8414 OAuth metadata
//   4. Common OAuth endpoint probe → /oauth/authorize, /auth/authorize, etc.
//   5. Common API key patterns     → checks docs page for "API key", "Bearer", "x-api-key"
//   6. Fallback                    → prompt user to choose

async function detectAuthMethod(host) {
  const base = `https://${host}`;

  // 1. Check .well-known/agentdom.json (most authoritative)
  try {
    const d = await discover(host).catch(() => null);
    if (d?.manifest?.auth?.method) {
      return { ...d.manifest.auth, _source: 'agentdom.json' };
    }
  } catch {}

  // 2. Pre-registered registry (known top-50 providers)
  try {
    const { OAUTH_REGISTRY } = require('../lib/oauth-pkce');
    if (OAUTH_REGISTRY[host]) {
      const cfg = OAUTH_REGISTRY[host];
      return {
        method: cfg.api_key_alt ? 'api_key'
               : cfg.device_url ? 'device_flow'
               : 'oauth2_pkce',
        ...cfg,
        _source: 'registry',
      };
    }
  } catch {}

  // 3. RFC 8414 — OAuth Authorization Server Metadata
  try {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const meta = await res.json();
      if (meta.authorization_endpoint) {
        return {
          method:    'oauth2_pkce',
          auth_url:  meta.authorization_endpoint,
          token_url: meta.token_endpoint,
          scopes:    meta.scopes_supported || [],
          pkce:      !!meta.code_challenge_methods_supported?.includes('S256'),
          _source:   'rfc8414',
        };
      }
    }
  } catch {}

  // 4. OpenID Connect discovery
  try {
    const res = await fetch(`${base}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const meta = await res.json();
      if (meta.authorization_endpoint) {
        return {
          method:    'oauth2_pkce',
          auth_url:  meta.authorization_endpoint,
          token_url: meta.token_endpoint,
          scopes:    meta.scopes_supported || ['openid', 'profile', 'email'],
          pkce:      true,
          _source:   'oidc',
        };
      }
    }
  } catch {}

  // 5. Probe common OAuth endpoints (heuristic — HEAD request, check status)
  const oauthPaths = [
    '/oauth/authorize', '/oauth2/authorize', '/auth/oauth/authorize',
    '/v1/oauth/authorize', '/api/oauth/authorize', '/connect/authorize',
  ];
  for (const path of oauthPaths) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      // 302/400/401 all indicate the endpoint exists
      if (res.status < 500) {
        return {
          method:    'oauth2_pkce',
          auth_url:  `${base}${path}`,
          token_url: `${base}${path.replace('authorize', 'token')}`,
          scopes:    [],
          pkce:      true,
          _source:   'probe',
        };
      }
    } catch {}
  }

  // 6. Check homepage/docs for API key patterns
  try {
    const res = await fetch(`${base}`, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'text/html' },
    });
    const html = await res.text();
    const lower = html.toLowerCase();
    // Strong API key signals
    if (lower.includes('x-api-key') || lower.includes('api_key') ||
        lower.includes('api-key') || lower.includes('secret key')) {
      return { method: 'api_key', _source: 'html_probe', obtain_url: `${base}/settings/api-keys` };
    }
    // Weak OAuth signals
    if (lower.includes('oauth') || lower.includes('authorize') || lower.includes('client_id')) {
      return { method: 'oauth2_pkce', auth_url: `${base}/oauth/authorize`, token_url: `${base}/oauth/token`, scopes: [], pkce: true, _source: 'html_probe' };
    }
  } catch {}

  // 7. Unknown — we'll ask the user
  return { method: 'unknown', _source: 'fallback' };
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

  // Auto-detect auth method
  process.stdout.write(`  ${C.dim('Detecting auth method...')}`);
  const authInfo = await detectAuthMethod(host);
  const sourceLabel = authInfo._source ? C.dim(` [detected via ${authInfo._source}]`) : '';
  let method = opts.key ? 'api_key' : authInfo.method;

  // Show what we found
  const methodLabel = {
    oauth2_pkce: `${C.cyan('OAuth 2.0 + PKCE')} (browser opens once)`,
    oauth2:      `${C.cyan('OAuth 2.0')} (browser opens once)`,
    device_flow: `${C.cyan('Device Flow')} (enter code at URL)`,
    api_key:     `${C.cyan('API Key')} (paste once)`,
    unknown:     `${C.yellow('Unknown')} (will ask)`,
  }[method] || method;
  console.log(`\r  ${C.green('→')} Auth method: ${methodLabel}${sourceLabel}\n`);

  // ── Unknown: ask user ────────────────────────────────────────────────────
  if (method === 'unknown') {
    const choice = await prompt(
      `  ${C.bold('What auth does')} ${host} ${C.bold('use?')}\n` +
      `    1) OAuth (browser login)\n` +
      `    2) API key (paste a token)\n` +
      `    3) Device code (enter code at URL)\n` +
      `  Enter 1, 2, or 3: `
    );
    method = choice === '2' ? 'api_key' : choice === '3' ? 'device_flow' : 'oauth2_pkce';
    console.log();
  }

  // ── API key ────────────────────────────────────────────────────────────────
  if (method === 'api_key') {
    let key = opts.key;
    if (!key) {
      const obtainUrl = authInfo.obtain_url || `https://${host}/settings/api-keys`;
      console.log(`  ${C.dim(`Get your API key at: ${obtainUrl}`)}\n`);
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
    console.log(`  ${C.dim('Your browser will open — approve access, then return here.')}\n`);
    const entry = await auth({ provider: host, force: opts.force, config: authInfo });
    console.log(`\n${C.green('✓')} Authenticated ${C.bold(host)} ${C.dim('(oauth2 — refresh token stored)')}`);
    printNextSteps(host);
    return entry;
  }

  // ── Device flow ────────────────────────────────────────────────────────────
  if (method === 'device_flow') {
    console.log(`  ${C.dim("You'll get a short code to enter at a URL — no browser redirect needed.")}\n`);
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
