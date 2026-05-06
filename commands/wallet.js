#!/usr/bin/env node
/**
 * agentdom wallet — provision, export, and import agent wallets
 *
 * Commands:
 *   agentdom wallet list                          — show all stored credentials
 *   agentdom wallet export [--providers=a,b,c]    — export scoped wallet JSON
 *   agentdom wallet export --base64               — export as single env-injectable string
 *   agentdom wallet import <wallet.json|base64>   — load a wallet into local store
 *   agentdom wallet create --agent=<id> --providers=a,b  — create scoped wallet file
 *   agentdom wallet token <provider>              — print the raw token for a provider
 *   agentdom wallet env [--providers=a,b,c]       — print export ENV=VALUE lines for shell
 *
 * How agents receive wallets:
 *
 *   1. File path  — AGENTDOM_WALLET_PATH=/tmp/agent.wallet.json
 *   2. Base64     — AGENTDOM_WALLET_B64=eyJ3YWxsZXQiOiIwLjEiLCAi...
 *   3. Env vars   — AGENTDOM_RESEND_COM_KEY=re_xxx AGENTDOM_LINEAR_APP_KEY=lin_xxx
 *   4. Auto       — ~/.agentdom/wallet.json (local / MCP server context)
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const WALLET_FILE = path.join(os.homedir(), '.agentdom', 'wallet.json');
const AGENTDOM_DIR = path.join(os.homedir(), '.agentdom');

// ── Wallet read/write ─────────────────────────────────────────────────────────
function readWallet() {
  // Priority: AGENTDOM_WALLET_PATH > AGENTDOM_WALLET_B64 > ~/.agentdom/wallet.json
  if (process.env.AGENTDOM_WALLET_PATH) {
    try {
      return JSON.parse(fs.readFileSync(process.env.AGENTDOM_WALLET_PATH, 'utf-8'));
    } catch (e) {
      console.error(`[wallet] AGENTDOM_WALLET_PATH invalid: ${e.message}`);
    }
  }
  if (process.env.AGENTDOM_WALLET_B64) {
    try {
      return JSON.parse(Buffer.from(process.env.AGENTDOM_WALLET_B64, 'base64').toString('utf-8'));
    } catch (e) {
      console.error(`[wallet] AGENTDOM_WALLET_B64 invalid: ${e.message}`);
    }
  }
  if (!fs.existsSync(WALLET_FILE)) return { wallet: '0.1', providers: {} };
  try { return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); }
  catch { return { wallet: '0.1', providers: {} }; }
}

function writeWallet(w) {
  if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive: true });
  fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2), { mode: 0o600 });
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdList() {
  const w = readWallet();
  const providers = Object.keys(w.providers || {});
  if (!providers.length) {
    console.log('No credentials stored. Run: agentdom setup <provider>');
    return;
  }
  console.log(`\n🔑 AgentDOM Wallet — ${providers.length} provider(s)\n`);
  for (const host of providers) {
    const e = w.providers[host];
    const expires = e.expires_at ? ` (expires ${new Date(e.expires_at).toLocaleDateString()})` : '';
    const hasRefresh = e.refresh_token ? ' ↻' : '';
    console.log(`  ${host.padEnd(30)} ${e.method}${expires}${hasRefresh}`);
  }
  console.log();
}

function cmdExport(argv) {
  const base64 = argv.includes('--base64');
  const provArg = argv.find(a => a.startsWith('--providers='));
  const filter  = provArg ? provArg.replace('--providers=', '').split(',') : null;

  const w = readWallet();
  const scoped = { wallet: w.wallet || '0.1', providers: {} };
  for (const [host, entry] of Object.entries(w.providers || {})) {
    if (!filter || filter.includes(host)) {
      // Strip internal fields, keep only what agent needs
      scoped.providers[host] = {
        method:        entry.method,
        token:         entry.token || entry.key,
        key_header:    entry.key_header,
        key_format:    entry.key_format,
        refresh_token: entry.refresh_token,
        expires_at:    entry.expires_at,
        token_url:     entry.token_url,
        client_id:     entry.client_id,
      };
      // Remove undefined keys
      for (const k of Object.keys(scoped.providers[host])) {
        if (scoped.providers[host][k] == null) delete scoped.providers[host][k];
      }
    }
  }

  if (base64) {
    const b64 = Buffer.from(JSON.stringify(scoped)).toString('base64');
    console.log('\n# Inject into agent as single env var:');
    console.log(`export AGENTDOM_WALLET_B64=${b64}\n`);
    console.log('# Or in Docker:');
    console.log(`docker run -e AGENTDOM_WALLET_B64=${b64} your-agent\n`);
  } else {
    console.log(JSON.stringify(scoped, null, 2));
  }
}

function cmdImport(argv) {
  const input = argv[0];
  if (!input) { console.error('Usage: agentdom wallet import <file.json or base64>'); process.exit(1); }

  let data;
  if (fs.existsSync(input)) {
    data = JSON.parse(fs.readFileSync(input, 'utf-8'));
  } else {
    try { data = JSON.parse(Buffer.from(input, 'base64').toString('utf-8')); }
    catch { data = JSON.parse(input); }
  }

  const w = readWallet();
  if (!w.providers) w.providers = {};
  let count = 0;
  for (const [host, entry] of Object.entries(data.providers || {})) {
    w.providers[host] = { ...entry, imported_at: new Date().toISOString() };
    count++;
  }
  writeWallet(w);
  console.log(`✓ Imported ${count} provider(s) into wallet`);
}

function cmdCreate(argv) {
  const agentArg    = argv.find(a => a.startsWith('--agent='));
  const provArg     = argv.find(a => a.startsWith('--providers='));
  const agentId     = agentArg?.replace('--agent=', '') || `agent-${Date.now()}`;
  const filter      = provArg ? provArg.replace('--providers=', '').split(',') : null;

  const w = readWallet();
  const scoped = { wallet: '0.1', agent_id: agentId, created_at: new Date().toISOString(), providers: {} };

  for (const [host, entry] of Object.entries(w.providers || {})) {
    if (!filter || filter.includes(host)) {
      scoped.providers[host] = {
        method:     entry.method,
        token:      entry.token || entry.key,
        key_header: entry.key_header,
        key_format: entry.key_format,
      };
      for (const k of Object.keys(scoped.providers[host])) {
        if (scoped.providers[host][k] == null) delete scoped.providers[host][k];
      }
    }
  }

  const outFile = path.join(AGENTDOM_DIR, `${agentId}.wallet.json`);
  fs.writeFileSync(outFile, JSON.stringify(scoped, null, 2), { mode: 0o600 });

  console.log(`\n✓ Created scoped wallet: ${outFile}`);
  console.log(`\n# Give to agent via file path:`);
  console.log(`  AGENTDOM_WALLET_PATH=${outFile} agentdom goal "..."\n`);
  console.log(`# Or as base64 (works anywhere — Docker, serverless, CI):`);
  const b64 = Buffer.from(JSON.stringify(scoped)).toString('base64');
  console.log(`  AGENTDOM_WALLET_B64=${b64.slice(0, 60)}...\n`);
  console.log(`# Providers scoped to this agent:`);
  Object.keys(scoped.providers).forEach(h => console.log(`  • ${h}`));
  console.log();
}

function cmdToken(argv) {
  const host = argv[0];
  if (!host) { console.error('Usage: agentdom wallet token <provider>'); process.exit(1); }
  const w = readWallet();
  const entry = (w.providers || {})[host];
  if (!entry) {
    // Check env var
    const envVal = process.env[`AGENTDOM_${host.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_KEY`];
    if (envVal) { console.log(envVal); return; }
    console.error(`No token for ${host}`);
    process.exit(1);
  }
  console.log(entry.token || entry.key || '');
}

function cmdEnv(argv) {
  const provArg = argv.find(a => a.startsWith('--providers='));
  const filter  = provArg ? provArg.replace('--providers=', '').split(',') : null;

  const w = readWallet();
  console.log('\n# Paste these into your shell, CI/CD secrets, or Dockerfile:\n');
  for (const [host, entry] of Object.entries(w.providers || {})) {
    if (filter && !filter.includes(host)) continue;
    const token = entry.token || entry.key;
    if (!token) continue;
    const envVar = 'AGENTDOM_' + host.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
    console.log(`export ${envVar}=${token}`);
  }
  console.log();
}

// ── Entry point ───────────────────────────────────────────────────────────────
const [,, subcmd, ...rest] = process.argv;

switch (subcmd) {
  case 'list':   cmdList();        break;
  case 'export': cmdExport(rest);  break;
  case 'import': cmdImport(rest);  break;
  case 'create': cmdCreate(rest);  break;
  case 'token':  cmdToken(rest);   break;
  case 'env':    cmdEnv(rest);     break;
  default:
    console.log(`
agentdom wallet — provision agent credentials

Commands:
  list                              Show all stored credentials
  export [--providers=a,b] [--base64]  Export wallet (scoped, portable)
  import <file.json or base64>      Load a wallet into local store  
  create --agent=<id> [--providers=a,b]  Create scoped wallet file for an agent
  token <provider>                  Print raw token for a provider
  env [--providers=a,b]             Print shell export lines for CI/CD

How to give a wallet to an agent:

  Option 1 — File (local/server):
    AGENTDOM_WALLET_PATH=/path/to/agent.wallet.json agentdom goal "..."

  Option 2 — Base64 (Docker/serverless/CI):
    AGENTDOM_WALLET_B64=$(agentdom wallet export --base64 --providers=resend.com)
    docker run -e AGENTDOM_WALLET_B64=$AGENTDOM_WALLET_B64 your-agent

  Option 3 — Env vars (12-factor apps):
    AGENTDOM_RESEND_COM_KEY=re_xxx agentdom goal "..."

  Option 4 — Auto (local MCP / Claude Desktop):
    ~/.agentdom/wallet.json is read automatically — nothing to do
`);
}

module.exports = { readWallet, writeWallet };
