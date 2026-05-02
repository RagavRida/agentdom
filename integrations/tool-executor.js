/**
 * AgentDOM — Tool Executor
 * Maps high-level, auto-generated tool calls back to low-level browser actions.
 *
 * When the agent calls: login(email: "user@gmail.com", password: "pass123")
 * The executor:
 *   1. Looks up the internal selector map
 *   2. Types into each field using the browser session
 *   3. Clicks the submit button
 *   4. Returns the result
 *
 * The agent never knows about CSS selectors.
 */

'use strict';

class ToolExecutor {
  /**
   * @param {BrowserSession} session — from browser-engine.js
   */
  constructor(session) {
    this.session = session;
  }

  /**
   * Execute a synthesized tool.
   *
   * @param {object} tool — tool definition from ToolSynthesizer (includes _internal)
   * @param {object} args — arguments provided by the agent
   * @returns {object} execution result
   */
  async execute(tool, args = {}) {
    const internal = tool._internal;

    switch (internal.type) {
      case 'form':
        return await this._executeForm(tool, internal, args);
      case 'action':
        return await this._executeAction(tool, internal, args);
      case 'navigation':
        return await this._executeNavigation(tool, internal, args);
      case 'base':
        return await this._executeBase(internal, args);
      default:
        throw new Error(`Unknown tool type: ${internal.type}`);
    }
  }

  // ── Form execution ──
  // Fills each field using the stored selector map, then submits

  async _executeForm(tool, internal, args) {
    const filled = [];
    const errors = [];

    // Fill each field
    for (const [paramName, value] of Object.entries(args)) {
      const selector = internal.fieldMap[paramName];
      if (!selector) {
        errors.push(`Unknown field: ${paramName}`);
        continue;
      }

      try {
        await this.session.type(selector, String(value));
        filled.push(paramName);
      } catch (e) {
        errors.push(`Failed to fill ${paramName}: ${e.message}`);
      }
    }

    // Auto-submit if submit button is known
    let submitted = false;
    let pageAfter = {};

    if (internal.submitSelector) {
      try {
        const result = await this.session.click(internal.submitSelector);
        submitted = true;
        pageAfter = result;
      } catch (e) {
        errors.push(`Failed to submit: ${e.message}`);
      }
    }

    // Re-scan after submission for fresh context
    let newSchema = null;
    if (submitted) {
      try {
        // Small delay for page transition
        await new Promise(r => setTimeout(r, 800));
        newSchema = await this.session.scan();
      } catch (_) { /* page may have navigated */ }
    }

    return {
      success: errors.length === 0,
      tool: tool.name,
      filled,
      submitted,
      errors: errors.length > 0 ? errors : undefined,
      page: {
        url: this.session.page?.url?.() || null,
        title: pageAfter.title || null,
      },
      ...(newSchema ? { hint: `Page changed. ${newSchema.page?.forms?.length || 0} forms and ${newSchema.page?.actions?.length || 0} actions now available.` } : {}),
    };
  }

  // ── Action execution ──
  // Clicks a button, optionally picking from multiple by label

  async _executeAction(tool, internal, args) {
    let target;

    if (internal.actions.length === 1) {
      // Single action — just click it
      target = internal.actions[0];
    } else if (args.which) {
      // Multiple actions — find by label (fuzzy match)
      const query = args.which.toLowerCase();
      target = internal.actions.find(a =>
        a.label && a.label.toLowerCase().includes(query)
      );
      if (!target) {
        // Try exact match
        target = internal.actions.find(a =>
          a.label && a.label.toLowerCase() === query
        );
      }
      if (!target) {
        return {
          success: false,
          tool: tool.name,
          error: `No matching option for "${args.which}". Available: ${internal.actions.map(a => a.label).join(', ')}`,
        };
      }
    } else {
      // No selection, default to first
      target = internal.actions[0];
    }

    try {
      const result = await this.session.click(target.selector);
      return {
        success: true,
        tool: tool.name,
        clicked: target.label || target.selector,
        page: {
          url: result.url || null,
          title: result.title || null,
        },
      };
    } catch (e) {
      return {
        success: false,
        tool: tool.name,
        error: `Failed to click "${target.label}": ${e.message}`,
      };
    }
  }

  // ── Navigation execution ──
  // Clicks a link by destination label

  async _executeNavigation(tool, internal, args) {
    const destination = args.destination;
    if (!destination) {
      return {
        success: false,
        tool: tool.name,
        error: `No destination provided. Available: ${Object.keys(internal.linkMap).join(', ')}`,
      };
    }

    // Try exact match first
    let link = internal.linkMap[destination];

    // Fuzzy match fallback
    if (!link) {
      const query = destination.toLowerCase();
      const match = Object.entries(internal.linkMap).find(([label]) =>
        label.toLowerCase().includes(query)
      );
      if (match) link = match[1];
    }

    if (!link) {
      return {
        success: false,
        tool: tool.name,
        error: `Destination "${destination}" not found. Available: ${Object.keys(internal.linkMap).join(', ')}`,
      };
    }

    try {
      // Use href directly if available (more reliable than selector click for links)
      if (link.href && !link.href.startsWith('javascript:')) {
        const result = await this.session.browse(link.href);
        return {
          success: true,
          tool: tool.name,
          navigatedTo: destination,
          page: {
            url: result?.page?.meta?.url || link.href,
            title: result?.page?.meta?.title || null,
          },
        };
      } else {
        const result = await this.session.click(link.selector);
        return {
          success: true,
          tool: tool.name,
          navigatedTo: destination,
          page: {
            url: result.url || null,
            title: result.title || null,
          },
        };
      }
    } catch (e) {
      return {
        success: false,
        tool: tool.name,
        error: `Failed to navigate to "${destination}": ${e.message}`,
      };
    }
  }

  // ── Base tool execution ──
  // Handles always-available tools (scan, screenshot, read, scroll, browse, press_key)

  async _executeBase(internal, args) {
    switch (internal.action) {
      case 'scan':
        return await this.session.scan();

      case 'screenshot': {
        const img = await this.session.screenshot(args.full_page || false);
        return { image: img, mimeType: 'image/png' };
      }

      case 'read_text': {
        // If section provided, try to find a matching element
        const selector = args.section ? this._sectionToSelector(args.section) : 'body';
        return await this.session.readText(selector);
      }

      case 'scroll': {
        const direction = args.direction || 'down';
        const px = args.amount || 500;
        const signed = direction === 'up' ? -px : px;
        return await this.session.scroll(signed);
      }

      case 'browse':
        return await this.session.browse(args.url);

      case 'press_key':
        return await this.session.pressKey(args.key);

      default:
        throw new Error(`Unknown base action: ${internal.action}`);
    }
  }

  // ── Helpers ──

  _sectionToSelector(section) {
    // Try common patterns: heading text, section id, aria-label
    const normalized = section.toLowerCase().replace(/\s+/g, '-');
    const candidates = [
      `#${normalized}`,
      `[aria-label="${section}"]`,
      `section:has(h1:contains("${section}"))`,
      `section:has(h2:contains("${section}"))`,
      `main`,
      'body',
    ];
    return candidates[0]; // In practice, would try each — simplified for now
  }
}


/**
 * Create a ToolExecutor + ToolSynthesizer pair for a session.
 * Convenience factory.
 */
function createToolRuntime(session) {
  const { ToolSynthesizer } = require('./tool-synthesizer');
  const synthesizer = new ToolSynthesizer();
  const executor = new ToolExecutor(session);

  return {
    synthesizer,
    executor,

    /**
     * Scan the page and return synthesized tools.
     */
    async discover() {
      const schema = await session.scan();
      return synthesizer.synthesize(schema);
    },

    /**
     * Execute a tool by name.
     * First re-synthesizes to get the latest tool definitions.
     *
     * @param {string} toolName — name of the tool to execute
     * @param {object} args — arguments for the tool
     */
    async run(toolName, args = {}) {
      const schema = await session.scan();
      const { tools } = synthesizer.synthesize(schema);
      const tool = tools.find(t => t.name === toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not available on this page. Available: ${tools.map(t => t.name).join(', ')}`);
      }
      return await executor.execute(tool, args);
    },
  };
}


module.exports = { ToolExecutor, createToolRuntime };
