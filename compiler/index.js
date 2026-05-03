/**
 * AgentDOM compiler — public API.
 *
 *   compile(scanResult, { from: 'desktop'|'web', to: 'openai', appName? })
 *
 * Pipeline: source-shape → IR → optimize → codegen.
 */

'use strict';

const { fromDesktop } = require('./from-desktop');
const { fromWeb } = require('./from-web');
const { fromCLI } = require('./from-cli');
const { fromOpenAPI } = require('./from-openapi');
const { optimize } = require('./optimize');
const { toOpenAI } = require('./to-openai');
const { toMCP } = require('./to-mcp');

const ADAPTERS = {
  desktop: fromDesktop,
  web: fromWeb,
  cli: fromCLI,
  api: fromOpenAPI,
};

const TARGETS = {
  openai: toOpenAI,
  mcp: toMCP,
};

function compile(scanResult, { from, to = 'openai', ...adapterOpts } = {}) {
  const adapter = ADAPTERS[from];
  if (!adapter) throw new Error(`Unknown source: ${from}. Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const target = TARGETS[to];
  if (!target) throw new Error(`Unknown target: ${to}. Known: ${Object.keys(TARGETS).join(', ')}`);

  const ir = adapter(scanResult, adapterOpts);
  const optimized = optimize(ir);
  const tools = target(optimized);
  return { ir: optimized, tools };
}

module.exports = {
  compile,
  fromDesktop,
  fromWeb,
  fromCLI,
  fromOpenAPI,
  optimize,
  toOpenAI,
  toMCP,
};
