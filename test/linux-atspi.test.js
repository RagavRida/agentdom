#!/usr/bin/env node
/**
 * AgentDOM Phase 3 — Linux AT-SPI Bridge Unit Tests
 * 
 * Mirrors the 13-case MCP harness for Linux-specific scenarios.
 * Tests the atspi-bridge.py interface without requiring a running app.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const BRIDGE = path.join(__dirname, '../desktop-agent/atspi-bridge.py');

function run(verb, ...args) {
  try {
    const out = execFileSync('python3', [BRIDGE, verb, ...args], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return JSON.parse(out);
  } catch (e) {
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout.trim());
      } catch {}
    }
    throw e;
  }
}

function test(name, fn) {
  try {
    fn();
    console.log('✓', name);
    return true;
  } catch (e) {
    console.error('✗', name);
    console.error('  ', e.message);
    return false;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function main() {
  console.log('AgentDOM Phase 3 — Linux AT-SPI Bridge Unit Tests\n');
  
  if (os.platform() !== 'linux') {
    console.log('⚠️  Skipping Linux unit tests (not on Linux).');
    console.log('   These tests require AT-SPI daemon running.');
    process.exit(0);
  }
  
  // Check if AT-SPI daemon is available
  try {
    run('list_apps');
  } catch (e) {
    if (e.message?.includes('AT-SPI2 daemon')) {
      console.log('⚠️  AT-SPI2 daemon not running. Skipping tests.');
      console.log('   On Ubuntu: sudo systemctl start at-spi-dbus-bus.service');
      process.exit(0);
    }
    // Other errors should fail the test
  }
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: list_apps returns array
  if (test('list_apps returns array', () => {
    const result = run('list_apps');
    assert(Array.isArray(result), 'Expected array');
    assert(result.length >= 0, 'Expected non-negative length');
  })) passed++; else failed++;
  
  // Test 2: list_apps includes name and pid
  if (test('list_apps includes name and pid', () => {
    const result = run('list_apps');
    if (result.length > 0) {
      const app = result[0];
      assert(typeof app.name === 'string', 'Expected name to be string');
      assert('pid' in app, 'Expected pid field');
    }
  })) passed++; else failed++;
  
  // Test 3: is_running with non-existent app
  if (test('is_running returns false for non-existent app', () => {
    const result = run('is_running', 'NonExistentApp12345');
    assertEqual(result.running, false, 'Expected running=false');
  })) passed++; else failed++;
  
  // Test 4: scan non-existent app returns error
  if (test('scan non-existent app returns error', () => {
    const result = run('scan', 'NonExistentApp12345');
    assert(result.error, 'Expected error field');
    assert(result.error.includes('not running'), 'Expected "not running" message');
  })) passed++; else failed++;
  
  // Test 5: click non-existent app returns error
  if (test('click non-existent app returns error', () => {
    const result = run('click', 'NonExistentApp12345', 'Button');
    assertEqual(result.clicked, false, 'Expected clicked=false');
    assert(result.error, 'Expected error field');
  })) passed++; else failed++;
  
  // Test 6: type non-existent app returns error
  if (test('type non-existent app returns error', () => {
    const result = run('type', 'NonExistentApp12345', 'Field', 'text');
    assertEqual(result.typed, false, 'Expected typed=false');
    assert(result.error, 'Expected error field');
  })) passed++; else failed++;
  
  // Test 7: scan missing argument
  if (test('scan without app name returns error', () => {
    const result = run('scan');
    assert(result.error, 'Expected error field');
  })) passed++; else failed++;
  
  // Test 8: click missing arguments
  if (test('click without label returns error', () => {
    const result = run('click', 'SomeApp');
    assert(result.error, 'Expected error field');
  })) passed++; else failed++;
  
  // Test 9: type missing arguments
  if (test('type without text returns error', () => {
    const result = run('type', 'SomeApp', 'Field');
    assert(result.error, 'Expected error field');
  })) passed++; else failed++;
  
  // Test 10: unknown verb
  if (test('unknown verb returns error', () => {
    const result = run('unknown_verb');
    assert(result.error, 'Expected error field');
    assert(result.error.includes('Unknown verb'), 'Expected "Unknown verb" message');
  })) passed++; else failed++;
  
  // Test 11: click with index parameter
  if (test('click accepts index parameter', () => {
    const result = run('click', 'NonExistentApp', 'Button', '2');
    assertEqual(result.clicked, false, 'Expected clicked=false');
    assertEqual(result.index, 2, 'Expected index=2');
  })) passed++; else failed++;
  
  // Test 12: type with index parameter
  if (test('type accepts index parameter', () => {
    const result = run('type', 'NonExistentApp', 'Field', 'text', '3');
    assertEqual(result.typed, false, 'Expected typed=false');
    assertEqual(result.index, 3, 'Expected index=3');
  })) passed++; else failed++;
  
  // Test 13: Bridge outputs valid JSON
  if (test('All commands output valid JSON', () => {
    const verbs = [
      ['list_apps'],
      ['is_running', 'Test'],
      ['scan', 'Test'],
      ['click', 'Test', 'Button'],
      ['type', 'Test', 'Field', 'text'],
    ];
    
    for (const args of verbs) {
      const result = run(...args);
      assert(typeof result === 'object', `Expected object for ${args[0]}`);
    }
  })) passed++; else failed++;
  
  console.log(`\n${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main();
