#!/usr/bin/env node
/**
 * AgentDOM — Google A2A (Agent-to-Agent) Protocol Server
 * Implements the A2A spec so other agents can delegate web browsing tasks.
 *
 * Spec: https://google.github.io/A2A/
 * Usage: OPENROUTER_API_KEY=sk-... node integrations/a2a.js
 */

const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const { SessionPool } = require('./browser-engine');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new SessionPool(5);
const tasks = new Map();
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

// ── A2A Agent Card ──
const AGENT_CARD = {
  name: 'AgentDOM',
  description: 'An AI-native web browsing agent that can navigate, interact with, and extract information from any website. Delegate web tasks like form filling, data extraction, and multi-step workflows.',
  url: null, // Set dynamically
  version: '3.0.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  skills: [
    {
      id: 'web-browse',
      name: 'Web Browsing',
      description: 'Navigate to any URL and return structured page schema.',
      tags: ['web', 'browse', 'navigate'],
      examples: ['Browse https://example.com and tell me what it offers'],
    },
    {
      id: 'web-interact',
      name: 'Web Interaction',
      description: 'Click buttons, fill forms, type text, and interact with any website like a human.',
      tags: ['web', 'form', 'click', 'type'],
      examples: ['Sign up on strollr.app with email test@ai.com'],
    },
    {
      id: 'web-extract',
      name: 'Data Extraction',
      description: 'Extract text, prices, product info, or any data from a webpage.',
      tags: ['web', 'scrape', 'extract', 'data'],
      examples: ['Find the pricing on stripe.com', 'Get all product names from this page'],
    },
    {
      id: 'web-autonomous',
      name: 'Autonomous Web Task',
      description: 'Give a natural language goal and the agent completes all steps autonomously.',
      tags: ['autonomous', 'agent', 'goal'],
      examples: ['Go to github.com and find the trending repositories'],
    },
  ],
};

// ── Agent Card Discovery ──
app.get('/.well-known/agent.json', (req, res) => {
  const card = { ...AGENT_CARD, url: `http://${req.headers.host}` };
  res.json(card);
});

// ── AI Helper ──
async function aiChat(prompt) {
  if (!OPENROUTER_KEY) return null;
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agentdom.dev',
      'X-Title': 'AgentDOM A2A',
    },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Execute Task (autonomous web browsing) ──
async function executeTask(taskId, message) {
  const task = tasks.get(taskId);
  task.status = { state: 'working' };

  try {
    const session = await pool.get(`a2a-${taskId}`);
    const userText = message.parts.map(p => p.text || '').join(' ').trim();

    // Extract URL from text if present
    const urlMatch = userText.match(/https?:\/\/\S+/);
    if (urlMatch) await session.browse(urlMatch[0]);

    // Use AI to accomplish the goal
    const history = [];
    const maxSteps = 10;

    for (let step = 0; step < maxSteps; step++) {
      let schema, pageText;
      try {
        schema = await session.scan();
        pageText = await session.readText('body');
      } catch {
        schema = { page: { meta: { title: 'Unknown', url: 'about:blank' }, forms: [], actions: [] } };
        pageText = '';
      }

      const prompt = `You are a web browsing agent. Complete this task: "${userText}"

Current page: ${schema.page.meta.title} (${schema.page.meta.url})
Forms: ${JSON.stringify(schema.page.forms).slice(0, 1000)}
Actions: ${JSON.stringify(schema.page.actions.slice(0, 15)).slice(0, 1000)}
Text: ${pageText.slice(0, 1500)}

Previous: ${history.map(h => `${h.action} → ${h.result}`).join('; ') || 'None'}

Respond JSON: { "action": "browse|click|type|fill|submit|done|failed", "params": {...}, "summary": "..." }`;

      const resp = (await aiChat(prompt))?.replace(/```json\n?|\n?```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(resp); } catch { parsed = { action: 'done', summary: resp || 'Task processed' }; }

      if (parsed.action === 'done' || parsed.action === 'failed') {
        task.status = { state: 'completed' };
        task.artifacts = [{ parts: [{ type: 'text', text: parsed.summary }] }];
        break;
      }

      try {
        const p = parsed.params || {};
        switch (parsed.action) {
          case 'browse': await session.browse(p.url); break;
          case 'click': await session.click(p.selector); break;
          case 'type': await session.type(p.selector, p.text); break;
          case 'fill': await session.fillForm(p.form_selector, p.data); break;
          case 'submit': await session.submitForm(p.form_selector); break;
        }
        history.push({ action: parsed.action, result: 'OK' });
      } catch (e) {
        history.push({ action: parsed.action, result: e.message });
      }

      await new Promise(r => setTimeout(r, 500));
    }

    if (task.status.state !== 'completed') {
      task.status = { state: 'completed' };
      task.artifacts = [{ parts: [{ type: 'text', text: 'Task completed (max steps reached).' }] }];
    }

    await pool.remove(`a2a-${taskId}`);
  } catch (e) {
    task.status = { state: 'failed', message: { parts: [{ type: 'text', text: e.message }] } };
  }
}

// ── A2A Endpoints ──

// Send a task
app.post('/tasks/send', async (req, res) => {
  const { message, id } = req.body;
  const taskId = id || uuid();

  const task = {
    id: taskId,
    status: { state: 'submitted' },
    artifacts: [],
    history: [message],
  };
  tasks.set(taskId, task);

  // Start async execution
  executeTask(taskId, message);

  res.json({
    id: taskId,
    status: task.status,
    artifacts: task.artifacts,
  });
});

// Get task status
app.post('/tasks/get', (req, res) => {
  const task = tasks.get(req.body.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({
    id: task.id,
    status: task.status,
    artifacts: task.artifacts,
  });
});

// Cancel task
app.post('/tasks/cancel', async (req, res) => {
  const task = tasks.get(req.body.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  task.status = { state: 'canceled' };
  await pool.remove(`a2a-${task.id}`);
  res.json({ id: task.id, status: task.status });
});

// ── Start ──
const PORT = process.env.A2A_PORT || 3800;
app.listen(PORT, () => {
  console.log(`\n  🔗 AgentDOM A2A Server`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Agent Card: http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`  → Skills: ${AGENT_CARD.skills.map(s => s.id).join(', ')}\n`);
});
