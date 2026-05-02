#!/usr/bin/env node
/**
 * AgentDOM — OpenAI Integration
 * Works with GPT-4, GPT-4o, and any OpenAI-compatible model via OpenRouter.
 *
 * Usage: OPENROUTER_API_KEY=sk-... node integrations/openai.js "Sign up on strollr.app"
 */

const { SessionPool, TOOL_DEFS } = require('./browser-engine');
const { ToolSynthesizer } = require('./tool-synthesizer');
const { ToolExecutor } = require('./tool-executor');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

const pool = new SessionPool(3);

// Convert AgentDOM tools → OpenAI Function Calling format
function createOpenAITools() {
  return TOOL_DEFS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, {
            type: v.type || 'string',
            description: v.desc || k,
          }])
        ),
        required: Object.entries(tool.params).filter(([, v]) => v.required).map(([k]) => k),
      },
    },
  }));
}

// Execute a tool call
async function handleToolCall(session, name, args) {
  switch (name) {
    case 'browse': return await session.browse(args.url);
    case 'scan': return await session.scan();
    case 'click': return await session.click(args.selector);
    case 'type_text': return await session.type(args.selector, args.text);
    case 'fill_form': return await session.fillForm(args.form_selector, args.data);
    case 'submit_form': return await session.submitForm(args.form_selector);
    case 'read_text': return await session.readText(args.selector || 'body');
    case 'screenshot': return { image: '(base64 screenshot taken)', mimeType: 'image/png' };
    case 'scroll': return args.to_selector ? await session.scrollTo(args.to_selector) : await session.scroll(args.pixels || 500);
    case 'hover': return await session.hover(args.selector);
    case 'press_key': return await session.pressKey(args.key);
    case 'wait': return args.text ? await session.waitForText(args.text) : await session.waitFor(args.selector);
    case 'goal': return { info: 'Use the other tools to accomplish the goal step by step.' };
    default: return { error: `Unknown tool: ${name}` };
  }
}

// Full agentic loop with DYNAMIC tools — tools change per page
async function runConversation(userPrompt, maxTurns = 20) {
  if (!API_KEY) throw new Error('Set OPENROUTER_API_KEY');

  const session = await pool.get('openai-agent');
  const synthesizer = new ToolSynthesizer();
  const executor = new ToolExecutor(session);

  // Start with static tools until first browse
  let currentTools = createOpenAITools();
  let currentToolDefs = null; // Full tool defs with _internal

  const messages = [
    { role: 'system', content: `You are an AI agent that can browse and interact with websites. After browsing a URL, your available tools will automatically update to match the page — you'll get specific tools like login(email, password) or search(query) instead of generic selectors. Use go_to_url first, then use the page-specific tools that appear. When done, respond with a summary.` },
    { role: 'user', content: userPrompt },
  ];

  console.log(`\n  🤖 OpenAI Agent — Model: ${MODEL}`);
  console.log(`  📋 Goal: ${userPrompt}`);
  console.log(`  🔧 Dynamic tools: enabled\n`);

  for (let turn = 0; turn < maxTurns; turn++) {
    // Re-synthesize tools if we have a page loaded
    try {
      const schema = await session.scan();
      const result = synthesizer.synthesize(schema);
      currentToolDefs = result.tools;
      currentTools = synthesizer.toOpenAIFormat(result.tools);
      if (turn === 0 || turn % 3 === 0) {
        console.log(`  [Turn ${turn + 1}] 📄 Page: ${result.summary}`);
      }
    } catch (_) {
      // No page loaded yet, use static tools
      currentTools = createOpenAITools();
      currentToolDefs = null;
    }

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://agentdom.dev',
        'X-Title': 'AgentDOM OpenAI',
      },
      body: JSON.stringify({ model: MODEL, messages, tools: currentTools, tool_choice: 'auto' }),
    });

    if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`  ✅ Agent response:\n  ${msg.content}\n`);
      await pool.closeAll();
      return { success: true, response: msg.content, turns: turn + 1 };
    }

    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      let fnArgs;
      try { fnArgs = JSON.parse(tc.function.arguments); } catch { fnArgs = {}; }

      console.log(`  [Turn ${turn + 1}] 🔧 ${fnName}(${JSON.stringify(fnArgs).slice(0, 80)})`);

      let result;
      try {
        // Try dynamic tool first
        const dynTool = currentToolDefs?.find(t => t.name === fnName);
        if (dynTool) {
          result = await executor.execute(dynTool, fnArgs);
        } else {
          // Fallback to static handler
          result = await handleToolCall(session, fnName, fnArgs);
        }
      } catch (e) {
        result = { error: e.message };
      }

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result).slice(0, 3000);
      console.log(`           → ${resultStr.slice(0, 100)}...`);

      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
    }
  }

  await pool.closeAll();
  return { success: false, reason: 'Max turns reached' };
}

// Export for programmatic use
module.exports = { createOpenAITools, handleToolCall, runConversation };

// CLI mode
if (require.main === module) {
  const goal = process.argv.slice(2).join(' ');
  if (!goal) {
    console.log('Usage: OPENROUTER_API_KEY=sk-... node integrations/openai.js "Sign up on example.com"');
    process.exit(1);
  }
  runConversation(goal)
    .then(r => { console.log('\nResult:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}
