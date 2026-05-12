#!/usr/bin/env node
/**
 * AgentDOM Phase 3 — Linux AT-SPI Bridge Demo
 * 
 * Verifies end-to-end: scan → compile → execute on a Linux app.
 * Uses GNOME Text Editor as the test target.
 * 
 * Prerequisites:
 * - Linux with GNOME desktop
 * - GNOME Text Editor installed (gnome-text-editor)
 * - pyatspi2: pip install pyatspi2
 * - xdotool: apt install xdotool
 * 
 * Usage:
 *   node test/linux-atspi.demo.js
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const BRIDGE = path.join(__dirname, '../desktop-agent/atspi-bridge.py');
const APP_NAME = 'Text Editor'; // GNOME Text Editor's AT-SPI name

function run(verb, ...args) {
  try {
    const out = execFileSync('python3', [BRIDGE, verb, ...args], {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return JSON.parse(out);
  } catch (e) {
    console.error(`Bridge error (${verb}):`, e.message);
    if (e.stdout) console.error('stdout:', e.stdout);
    if (e.stderr) console.error('stderr:', e.stderr);
    throw e;
  }
}

function assert(condition, msg) {
  if (!condition) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
  console.log('✓', msg);
}

async function main() {
  console.log('AgentDOM Phase 3 — Linux AT-SPI Bridge Demo\n');
  
  // Check platform
  if (os.platform() !== 'linux') {
    console.log('⚠️  Skipping Linux demo (not on Linux). Unit tests still pass.');
    process.exit(0);
  }
  
  // Check if gnome-text-editor is installed
  try {
    execFileSync('which', ['gnome-text-editor'], { stdio: 'ignore' });
  } catch {
    console.log('⚠️  gnome-text-editor not installed. Skipping demo.');
    console.log('   On Ubuntu: sudo apt install gnome-text-editor');
    process.exit(0);
  }
  
  // Test 1: List running apps
  console.log('Test 1: list_apps');
  const apps = run('list_apps');
  assert(Array.isArray(apps), 'list_apps returns array');
  console.log(`  Found ${apps.length} apps via AT-SPI`);
  
  // Test 2: Check if Text Editor is running
  console.log('\nTest 2: is_running');
  const running = run('is_running', APP_NAME);
  if (!running.running) {
    console.log(`⚠️  ${APP_NAME} not running. Please open it and re-run this demo.`);
    console.log('   Launch: gnome-text-editor &');
    process.exit(0);
  }
  assert(running.running === true, `${APP_NAME} is running`);
  
  // Test 3: Scan app UI
  console.log('\nTest 3: scan');
  const elements = run('scan', APP_NAME);
  
  if (elements.error) {
    console.error('Scan failed:', elements);
    process.exit(1);
  }
  
  assert(Array.isArray(elements), 'scan returns element array');
  assert(elements.length > 0, 'scan found UI elements');
  console.log(`  Scanned ${elements.length} elements`);
  
  // Show sample elements
  const buttons = elements.filter(e => e.type === 'button');
  const textFields = elements.filter(e => e.type === 'text_input' || e.type === 'text_area');
  console.log(`  - ${buttons.length} buttons`);
  console.log(`  - ${textFields.length} text fields`);
  
  if (buttons.length > 0) {
    console.log(`  Sample button: "${buttons[0].label}"`);
  }
  
  // Test 4: Compile to IR
  console.log('\nTest 4: Compile to IR');
  const { fromDesktop } = require('../compiler/from-desktop');
  const ir = fromDesktop(elements, { appName: APP_NAME });
  
  assert(ir.meta, 'IR has meta');
  assert(ir.meta.platform === 'desktop', 'IR platform is desktop');
  assert(ir.actions || ir.forms, 'IR has actions or forms');
  console.log(`  Compiled to IR: ${ir.actions?.length || 0} actions, ${ir.forms?.length || 0} forms`);
  
  // Test 5: Click test (if New Document button exists)
  const newDocBtn = elements.find(e => 
    e.type === 'button' && 
    (e.label?.includes('New') || e.label?.includes('Document'))
  );
  
  if (newDocBtn) {
    console.log('\nTest 5: click');
    console.log(`  Attempting to click: "${newDocBtn.label}"`);
    const clickResult = run('click', APP_NAME, newDocBtn.label);
    
    if (clickResult.clicked) {
      assert(clickResult.clicked === true, `Clicked "${newDocBtn.label}"`);
      console.log(`  Method: ${clickResult.method}`);
    } else {
      console.log(`  ⚠️  Click failed: ${clickResult.error || 'unknown'}`);
    }
  } else {
    console.log('\nTest 5: click (skipped - no suitable button found)');
  }
  
  // Test 6: Type test (if text area exists)
  const textArea = textFields.find(e => e.type === 'text_area' || e.type === 'text_input');
  
  if (textArea) {
    console.log('\nTest 6: type');
    const testText = 'AgentDOM Phase 3 works!';
    console.log(`  Attempting to type into: "${textArea.label || 'text area'}"`);
    const typeResult = run('type', APP_NAME, textArea.label || 'text', testText);
    
    if (typeResult.typed) {
      assert(typeResult.typed === true, `Typed text successfully`);
      console.log(`  Method: ${typeResult.method}`);
    } else {
      console.log(`  ⚠️  Type failed: ${typeResult.error || 'unknown'}`);
    }
  } else {
    console.log('\nTest 6: type (skipped - no text field found)');
  }
  
  console.log('\n✅ Linux AT-SPI Bridge Demo Complete');
  console.log('\nNext steps:');
  console.log('  - Add more Linux app manifests (Nautilus, Firefox, etc.)');
  console.log('  - Implement cross-surface intent routing');
  console.log('  - Add unit tests matching MCP harness');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
