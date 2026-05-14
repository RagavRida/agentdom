#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SKILL_NAME = 'agentdom';
const WORKSPACE = process.env.OPENCLAW_WORKSPACE
  || path.join(os.homedir(), '.openclaw', 'workspace');
const TARGET_DIR = path.join(WORKSPACE, 'skills', SKILL_NAME);
const SOURCE_DIR = path.join(__dirname, 'skill');

function ensureAgentdom() {
  try {
    require.resolve('agentdom');
    return true;
  } catch {
    return false;
  }
}

function copySkill() {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  for (const entry of fs.readdirSync(SOURCE_DIR)) {
    const src = path.join(SOURCE_DIR, entry);
    const dst = path.join(TARGET_DIR, entry);
    fs.copyFileSync(src, dst);
  }
}

function main() {
  const sub = process.argv[2] || 'install';

  if (sub === 'install') {
    if (!fs.existsSync(WORKSPACE)) {
      console.error(`OpenClaw workspace not found at ${WORKSPACE}.`);
      console.error('Run `openclaw onboard` first, then re-run this installer.');
      process.exit(1);
    }
    if (!ensureAgentdom()) {
      console.error('agentdom is not installed. Install it first:');
      console.error('  npm install -g agentdom');
      process.exit(1);
    }
    copySkill();
    console.log(`Installed AgentDOM skill at ${TARGET_DIR}`);
    console.log('Restart OpenClaw, then call: dispatch_intent("<intent>", { ... }, "<provider>")');
    return;
  }

  if (sub === 'uninstall') {
    if (!fs.existsSync(TARGET_DIR)) {
      console.log('AgentDOM skill is not installed; nothing to do.');
      return;
    }
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    console.log(`Removed ${TARGET_DIR}`);
    return;
  }

  if (sub === 'doctor') {
    console.log('OpenClaw workspace :', fs.existsSync(WORKSPACE) ? 'OK' : 'MISSING');
    console.log('agentdom installed :', ensureAgentdom() ? 'OK' : 'MISSING');
    console.log('skill installed    :', fs.existsSync(TARGET_DIR) ? 'OK' : 'MISSING');
    try {
      const v = execSync('agentdom --version', { encoding: 'utf8' }).trim();
      console.log('agentdom version   :', v);
    } catch {
      console.log('agentdom version   : (could not invoke `agentdom`)');
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error('Usage: agentdom-openclaw [install|uninstall|doctor]');
  process.exit(1);
}

main();
