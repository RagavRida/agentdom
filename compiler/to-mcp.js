/**
 * Codegen: optimized IR → MCP (Model Context Protocol) tool list.
 *
 * MCP shape differs from OpenAI's:
 *   { name, description, inputSchema: {type,properties,required} }   (MCP)
 *   { type:'function', function: {name, description, parameters: ...} } (OpenAI)
 *
 * We reuse to-openai's IR walking and reshape on the way out.
 */

'use strict';

const { toOpenAI } = require('./to-openai');

function toMCP(ir) {
  return toOpenAI(ir).map(t => {
    const fn = t.function;
    return {
      name: fn.name,
      description: fn.description,
      inputSchema: fn.parameters,
      _internal: fn._internal,
    };
  });
}

module.exports = { toMCP };
