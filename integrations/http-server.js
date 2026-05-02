#!/usr/bin/env node
/**
 * AgentDOM HTTP API Server
 * Universal REST gateway — any platform, any language can call this.
 *
 * Usage: OPENROUTER_API_KEY=sk-... node integrations/http-server.js
 * Endpoints:
 *   POST /browse     { url }                    → page schema
 *   POST /scan       {}                         → current page schema
 *   POST /click      { selector }               → click result
 *   POST /type       { selector, text }          → type result
 *   POST /fill       { form_selector, data }     → fill result
 *   POST /submit     { form_selector }           → submit result
 *   POST /read       { selector? }               → text content
 *   POST /screenshot { full_page? }              → base64 image
 *   POST /scroll     { pixels?, to_selector? }   → scroll result
 *   POST /hover      { selector }                → hover result
 *   POST /press      { key }                     → press result
 *   POST /wait       { selector?, text?, timeout? } → wait result
 *   POST /goal       { objective, url? }          → autonomous result
 *   GET  /sessions                               → list sessions
 *   DELETE /sessions/:id                         → close session
 *   GET  /health                                 → health check
 */

const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const { SessionPool, TOOL_DEFS } = require('./browser-engine');
const { ToolSynthesizer } = require('./tool-synthesizer');
const { ToolExecutor } = require('./tool-executor');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new SessionPool(10);
const API_KEY = process.env.AGENTDOM_API_KEY || null;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || null;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

// Auth middleware
function auth(req, res, next) {
  if (!API_KEY) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

app.use(auth);

// Session middleware — get or create session
async function getSession(req) {
  const sid = req.headers['x-session-id'] || req.body?.session_id || 'default';
  return pool.get(sid);
}

// AI chat for autonomous mode
async function aiChat(prompt) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agentdom.dev',
      'X-Title': 'AgentDOM API',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`AI error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Endpoints ──

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', sessions: pool.list().length, tools: TOOL_DEFS.length });
});

app.get('/tools', (req, res) => res.json({ tools: TOOL_DEFS }));

app.get('/sessions', (req, res) => res.json({ sessions: pool.list() }));

app.delete('/sessions/:id', async (req, res) => {
  await pool.remove(req.params.id);
  res.json({ closed: req.params.id });
});

app.post('/browse', async (req, res) => {
  try {
    const s = await getSession(req);
    const schema = await s.browse(req.body.url);
    res.json({ success: true, schema });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/scan', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, schema: await s.scan() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/click', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.click(req.body.selector) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/type', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.type(req.body.selector, req.body.text) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/fill', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.fillForm(req.body.form_selector, req.body.data) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submit', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.submitForm(req.body.form_selector) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/read', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, text: await s.readText(req.body.selector || 'body') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/screenshot', async (req, res) => {
  try {
    const s = await getSession(req);
    const img = await s.screenshot(req.body.full_page || false);
    res.json({ success: true, image: img, mimeType: 'image/png' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/scroll', async (req, res) => {
  try {
    const s = await getSession(req);
    if (req.body.to_selector) res.json({ success: true, result: await s.scrollTo(req.body.to_selector) });
    else res.json({ success: true, result: await s.scroll(req.body.pixels || 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/hover', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.hover(req.body.selector) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/press', async (req, res) => {
  try {
    const s = await getSession(req);
    res.json({ success: true, result: await s.pressKey(req.body.key) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/wait', async (req, res) => {
  try {
    const s = await getSession(req);
    const timeout = req.body.timeout || 10000;
    if (req.body.text) res.json({ success: true, result: await s.waitForText(req.body.text, timeout) });
    else if (req.body.selector) res.json({ success: true, result: await s.waitFor(req.body.selector, timeout) });
    else res.status(400).json({ error: 'Provide selector or text' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Autonomous Goal ──
app.post('/goal', async (req, res) => {
  try {
    const s = await getSession(req);
    const { objective, url, max_steps = 15 } = req.body;
    if (!objective) return res.status(400).json({ error: 'objective is required' });

    if (url) await s.browse(url);

    const history = [];

    for (let step = 1; step <= max_steps; step++) {
      const schema = await s.scan();
      const pageText = await s.readText('body');

      const prompt = `You are an autonomous AI agent operating a web browser to complete a goal.

GOAL: ${objective}

CURRENT PAGE:
- Title: ${schema.page.meta.title}
- URL: ${schema.page.meta.url}
- Forms: ${JSON.stringify(schema.page.forms)}
- Actions: ${JSON.stringify(schema.page.actions.slice(0, 20))}
- Visible text (first 2000 chars): ${pageText.slice(0, 2000)}

PREVIOUS STEPS:
${history.map((h, i) => `${i + 1}. ${h.action} → ${h.result}`).join('\n') || 'None'}

Respond with a JSON object: { "action": "browse|click|type|fill|submit|scroll|press|done|failed", "params": {...}, "reason": "brief explanation" }
For done: { "action": "done", "params": {}, "reason": "what was accomplished" }
For failed: { "action": "failed", "params": {}, "reason": "why it's impossible" }`;

      const aiResp = (await aiChat(prompt)).replace(/```json\n?|\n?```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(aiResp); } catch { parsed = { action: 'failed', reason: 'AI returned invalid JSON' }; }

      if (parsed.action === 'done') {
        return res.json({ success: true, completed: true, steps: step, reason: parsed.reason, history });
      }
      if (parsed.action === 'failed') {
        return res.json({ success: false, completed: false, steps: step, reason: parsed.reason, history });
      }

      let result = 'OK';
      try {
        const p = parsed.params || {};
        switch (parsed.action) {
          case 'browse': result = JSON.stringify(await s.browse(p.url)); break;
          case 'click': result = JSON.stringify(await s.click(p.selector)); break;
          case 'type': result = JSON.stringify(await s.type(p.selector, p.text)); break;
          case 'fill': result = JSON.stringify(await s.fillForm(p.form_selector, p.data)); break;
          case 'submit': result = JSON.stringify(await s.submitForm(p.form_selector)); break;
          case 'scroll': result = JSON.stringify(await s.scroll(p.pixels || 500)); break;
          case 'press': result = JSON.stringify(await s.pressKey(p.key)); break;
          default: result = 'Unknown action';
        }
      } catch (e) { result = `Error: ${e.message}`; }

      history.push({ step, action: `${parsed.action} ${JSON.stringify(parsed.params)}`, result, reason: parsed.reason });
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ success: false, completed: false, steps: max_steps, reason: 'max steps reached', history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dynamic Tool Discovery ──
const synthesizer = new ToolSynthesizer();

app.post('/tools/discover', async (req, res) => {
  try {
    const s = await getSession(req);
    if (req.body.url) await s.browse(req.body.url);
    const schema = await s.scan();
    const result = synthesizer.synthesize(schema);
    res.json({
      success: true,
      page_type: result.page_type,
      summary: result.summary,
      tools: synthesizer.toPublicFormat(result.tools),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/tools/execute', async (req, res) => {
  try {
    const { tool: toolName, args = {} } = req.body;
    if (!toolName) return res.status(400).json({ error: 'tool name is required' });
    const s = await getSession(req);
    const schema = await s.scan();
    const { tools } = synthesizer.synthesize(schema);
    const tool = tools.find(t => t.name === toolName);
    if (!tool) return res.status(404).json({ error: `Tool "${toolName}" not available`, available: tools.map(t => t.name) });
    const executor = new ToolExecutor(s);
    const result = await executor.execute(tool, args);
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OpenAPI spec for Custom GPTs ──
app.get('/openapi.json', (req, res) => {
  const host = req.headers.host || 'localhost:3700';
  const spec = {
    openapi: '3.1.0',
    info: { title: 'AgentDOM API', version: '3.0.0', description: 'AI-native runtime for operating any website' },
    servers: [{ url: `http://${host}` }],
    paths: {},
  };
  const endpoints = [
    { path: '/browse', method: 'post', body: { url: 'string' } },
    { path: '/scan', method: 'post', body: {} },
    { path: '/click', method: 'post', body: { selector: 'string' } },
    { path: '/type', method: 'post', body: { selector: 'string', text: 'string' } },
    { path: '/fill', method: 'post', body: { form_selector: 'string', data: 'object' } },
    { path: '/submit', method: 'post', body: { form_selector: 'string' } },
    { path: '/read', method: 'post', body: { selector: 'string' } },
    { path: '/screenshot', method: 'post', body: { full_page: 'boolean' } },
    { path: '/goal', method: 'post', body: { objective: 'string', url: 'string' } },
  ];
  endpoints.forEach(ep => {
    const props = {};
    Object.entries(ep.body).forEach(([k, v]) => { props[k] = { type: v }; });
    spec.paths[ep.path] = {
      [ep.method]: {
        operationId: ep.path.slice(1),
        summary: TOOL_DEFS.find(t => t.name === ep.path.slice(1))?.desc || '',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: props } } } },
        responses: { '200': { description: 'Success' } },
      },
    };
  });
  res.json(spec);
});

// ── Start ──
const PORT = process.env.PORT || 3700;
app.listen(PORT, () => {
  console.log(`\n  ⚡ AgentDOM API Server v3.0.0`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → ${TOOL_DEFS.length} tools available`);
  console.log(`  → OpenAPI spec: http://localhost:${PORT}/openapi.json`);
  console.log(`  → AI: ${OPENROUTER_KEY ? 'enabled' : 'disabled (set OPENROUTER_API_KEY)'}`);
  console.log(`  → Auth: ${API_KEY ? 'enabled' : 'disabled (set AGENTDOM_API_KEY)'}\n`);
});

process.on('SIGINT', async () => { await pool.closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.closeAll(); process.exit(0); });
