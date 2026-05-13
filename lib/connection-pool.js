/**
 * AgentDOM — HTTP Connection Pool (Phase 4)
 *
 * Per-host keep-alive agents so every outbound dispatch reuses TCP/TLS
 * sessions instead of paying the connect+handshake cost on each call.
 *
 *   • One http.Agent + one https.Agent per host (lazy)
 *   • keepAlive: true, maxSockets: 6 (matches browser default)
 *   • Idle timeout: 30s — connections beyond that are destroyed by the agent
 *
 * Singleton. Use `shutdown()` on process exit.
 *
 * Usage:
 *   const pool = require('./connection-pool');
 *   const agent = pool.getAgent('api.openai.com');           // host string
 *   const agent = pool.getAgent('https://api.openai.com/v1'); // full URL also ok
 */

'use strict';

const http  = require('http');
const https = require('https');

const DEFAULT_MAX_SOCKETS    = 6;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;

const _agents = new Map(); // key: `${protocol}//${host}` → http.Agent | https.Agent
const _stats  = { created: 0, reused: 0, hosts: 0 };

let _maxSockets = DEFAULT_MAX_SOCKETS;
let _idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

/**
 * Configure pool defaults (call before first getAgent).
 * @param {{maxSockets?:number, idleTimeoutMs?:number}} opts
 */
function configure(opts = {}) {
  if (typeof opts.maxSockets === 'number') _maxSockets = opts.maxSockets;
  if (typeof opts.idleTimeoutMs === 'number') _idleTimeoutMs = opts.idleTimeoutMs;
}

/**
 * Get (or lazily create) the pooled agent for a host.
 *
 * @param {string} hostOrUrl — bare host ("api.example.com") or full URL
 * @returns {http.Agent | https.Agent}
 */
function getAgent(hostOrUrl) {
  const { protocol, host } = _resolve(hostOrUrl);
  const key = `${protocol}//${host}`;
  const existing = _agents.get(key);
  if (existing) {
    _stats.reused++;
    return existing;
  }

  const AgentCtor = protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new AgentCtor({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: _maxSockets,
    maxFreeSockets: _maxSockets,
    timeout: _idleTimeoutMs,
  });
  _agents.set(key, agent);
  _stats.created++;
  _stats.hosts = _agents.size;
  return agent;
}

/**
 * Return current pool stats.
 * @returns {{created:number, reused:number, hosts:number, hostList:string[]}}
 */
function stats() {
  return {
    created:  _stats.created,
    reused:   _stats.reused,
    hosts:    _agents.size,
    hostList: [..._agents.keys()],
  };
}

/**
 * Destroy all pooled agents. Call on process exit.
 */
function shutdown() {
  for (const agent of _agents.values()) {
    try { agent.destroy(); } catch (_) {}
  }
  _agents.clear();
  _stats.created = 0;
  _stats.reused  = 0;
  _stats.hosts   = 0;
}

// ── Internals ───────────────────────────────────────────────────────────────

function _resolve(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('connection-pool.getAgent: host/URL required');
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const u = new URL(s);
    return { protocol: u.protocol, host: u.host };
  }
  // Bare host — assume https (every modern API surface)
  return { protocol: 'https:', host: s.toLowerCase() };
}

/** Expose for testing only. */
function _resetForTests() {
  shutdown();
  _maxSockets = DEFAULT_MAX_SOCKETS;
  _idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
}

module.exports = {
  getAgent,
  shutdown,
  stats,
  configure,
  _resetForTests,
};
