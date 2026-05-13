/**
 * AgentDOM — Public Library API (Phase 6)
 *
 * Entry point exposed via `require('agentdom')`. Each section maps a
 * subsystem to its module so consumers can pick exactly what they need
 * without reaching into the package's internals.
 *
 *   const { auth, registry, compiler } = require('agentdom');
 *   const config = registry.resolve('github.com');
 *   const token  = await auth.token('github.com');
 *
 * Library exports are lazy-loaded — requiring this file does not pull
 * Puppeteer, keytar, or the MCP SDK until the relevant subtree is
 * accessed.
 */

'use strict';

const lazy = (loader) => {
  let v;
  return () => (v === undefined ? (v = loader()) : v);
};

const exportsMap = {
  // ── Auth ────────────────────────────────────────────────────────────────
  auth:         lazy(() => require('./commands/auth')),
  keychain:     lazy(() => require('./lib/keychain')),
  registry:     lazy(() => require('./lib/oauth-registry')),

  // ── Runtime ─────────────────────────────────────────────────────────────
  runtime:      lazy(() => require('./lib/agent-runtime')),
  planner:      lazy(() => require('./lib/planner')),
  policy:       lazy(() => require('./lib/policy')),
  memory:       lazy(() => require('./lib/memory')),

  // ── Transport ───────────────────────────────────────────────────────────
  resilience:   lazy(() => require('./lib/resilience')),
  connectionPool: lazy(() => require('./lib/connection-pool')),
  tokenCache:   lazy(() => require('./lib/token-cache')),

  // ── Compiler ────────────────────────────────────────────────────────────
  compiler:     lazy(() => require('./compiler')),

  // ── Discovery ───────────────────────────────────────────────────────────
  discover:     lazy(() => require('./discovery')),

  // ── Desktop ─────────────────────────────────────────────────────────────
  platform:     lazy(() => require('./desktop-agent/platform')),
};

const api = {};
for (const [name, loader] of Object.entries(exportsMap)) {
  Object.defineProperty(api, name, {
    enumerable: true,
    get:        loader,
  });
}

/** Read the published version from package.json (best-effort). */
function version() {
  try { return require('./package.json').version; }
  catch { return null; }
}

api.version = version;
api.VERSION = version();

module.exports = api;
