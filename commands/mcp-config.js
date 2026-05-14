/**
 * AgentDOM — MCP Config Generator (Phase 7)
 *
 * Emits the exact configuration snippet the user needs to paste into each
 * supported MCP client so the `agentdom serve` stdio server is registered.
 *
 * Supported targets:
 *   • claude-desktop — JSON for `claude_desktop_config.json`
 *   • claude-code    — `claude mcp add` command line
 *   • cursor         — `.cursor/mcp.json` snippet
 *   • vscode         — `settings.json` `mcp` snippet
 */

'use strict';

/** @type {Record<string, () => string>} */
const TARGETS = {
  'claude-desktop': claudeDesktop,
  'claude-code':    claudeCode,
  'cursor':         cursor,
  'vscode':         vscode,
};

const TARGET_NAMES = Object.keys(TARGETS);

/**
 * Build the JSON snippet for Claude Desktop's `claude_desktop_config.json`.
 * @returns {string}
 */
function claudeDesktop() {
  const config = {
    mcpServers: {
      agentdom: {
        command: 'agentdom',
        args: ['serve'],
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Build the one-line `claude mcp add` command for Claude Code.
 * @returns {string}
 */
function claudeCode() {
  return 'claude mcp add agentdom -- agentdom serve';
}

/**
 * Build the JSON snippet for Cursor's `.cursor/mcp.json`.
 * @returns {string}
 */
function cursor() {
  const config = {
    mcpServers: {
      agentdom: {
        command: 'agentdom',
        args: ['serve'],
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Build the JSON snippet for VS Code's `settings.json` `mcp` section.
 * @returns {string}
 */
function vscode() {
  const config = {
    mcp: {
      servers: {
        agentdom: {
          command: 'agentdom',
          args: ['serve'],
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Generate the snippet for a target.
 * @param {string} target
 * @returns {string}
 */
function generate(target) {
  const fn = TARGETS[target];
  if (!fn) {
    throw new Error(`Unknown target "${target}". Available: ${TARGET_NAMES.join(', ')}`);
  }
  return fn();
}

/**
 * CLI entry point. Writes the snippet to stdout, or — for unknown
 * targets — the list of available targets to stderr.
 * @param {string} target
 * @returns {number} exit code
 */
function run(target) {
  if (!target) {
    process.stderr.write(`Usage: agentdom mcp-config <target>\nAvailable targets: ${TARGET_NAMES.join(', ')}\n`);
    return 1;
  }
  if (!TARGETS[target]) {
    process.stderr.write(`Unknown target "${target}".\nAvailable targets: ${TARGET_NAMES.join(', ')}\n`);
    return 1;
  }
  process.stdout.write(generate(target) + '\n');
  return 0;
}

module.exports = { generate, run, TARGETS: TARGET_NAMES };

if (require.main === module) {
  process.exitCode = run(process.argv[2]);
}
