/**
 * AgentDOM Next.js SDK
 *
 * Adds AI-agent accessibility to any Next.js app in ~10 lines.
 * Works with both App Router (app/) and Pages Router (pages/).
 *
 * ── App Router (app/api/agentdom/[...intent]/route.js) ──────────────────────
 *   import { AgentDOM } from 'agentdom/nextjs';
 *   export const { GET, POST } = AgentDOM({ host: 'myapp.com', capabilities: [...] });
 *
 * ── Pages Router (pages/api/agentdom/[[...intent]].js) ──────────────────────
 *   import { agentdomApiHandler } from 'agentdom/nextjs';
 *   export default agentdomApiHandler({ host: 'myapp.com', capabilities: [...] });
 *
 * ── Middleware (middleware.js, serves /.well-known/agentdom.json) ───────────
 *   export { agentdomMiddleware as middleware } from 'agentdom/nextjs';
 *   export const config = { matcher: ['/.well-known/agentdom.json', '/api/agentdom/:path*'] };
 */

'use strict';

function buildManifest({ host, name, description, auth, capabilities = [], apiBasePath = '/api/agentdom' }) {
  return {
    version: '1.0',
    host,
    name: name || host,
    description: description || `AgentDOM manifest for ${host}`,
    generated_at: new Date().toISOString(),
    generated_by: 'agentdom-nextjs-sdk',
    auth: auth || { method: 'none' },
    capabilities: capabilities.map(cap => ({
      intent: cap.intent,
      description: cap.description || '',
      transport: 'api',
      method: cap.method || 'POST',
      endpoint: `https://${host}${apiBasePath}/${cap.intent}`,
      args: cap.args || {},
      side_effects: cap.side_effects || ['write_local'],
    })),
  };
}

// ── App Router handler factory ─────────────────────────────────────────────
function AgentDOM(options = {}) {
  const manifest = buildManifest(options);
  const { capabilities = [], apiBasePath = '/api/agentdom' } = options;

  async function GET(req, { params } = {}) {
    const { NextResponse } = await import('next/server');
    const url = new URL(req.url);

    // Serve manifest at /api/agentdom (no intent segment)
    if (!params?.intent?.length) {
      return NextResponse.json(manifest);
    }
    return NextResponse.json({ error: 'Use POST to dispatch an intent' }, { status: 405 });
  }

  async function POST(req, { params } = {}) {
    const { NextResponse } = await import('next/server');
    const intentParts = params?.intent || [];
    const intentName = intentParts.join('.');

    const cap = capabilities.find(c => c.intent === intentName);
    if (!cap) {
      return NextResponse.json(
        { error: `Intent "${intentName}" not found`, available: capabilities.map(c => c.intent) },
        { status: 404 }
      );
    }
    if (typeof cap.handler !== 'function') {
      return NextResponse.json({ error: `Intent "${intentName}" has no handler` }, { status: 501 });
    }

    let body = {};
    try { body = await req.json(); } catch {}

    try {
      const result = await cap.handler(req, body);
      return NextResponse.json({ success: true, result });
    } catch (err) {
      return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
  }

  return { GET, POST };
}

// ── Pages Router handler ───────────────────────────────────────────────────
function agentdomApiHandler(options = {}) {
  const manifest = buildManifest(options);
  const { capabilities = [] } = options;

  return async function handler(req, res) {
    const intentSegments = req.query.intent || [];
    const intentName = Array.isArray(intentSegments) ? intentSegments.join('.') : intentSegments;

    if (req.method === 'GET' && !intentName) {
      return res.json(manifest);
    }

    if (req.method === 'POST' && intentName) {
      const cap = capabilities.find(c => c.intent === intentName);
      if (!cap) return res.status(404).json({ error: `Intent "${intentName}" not found` });
      if (typeof cap.handler !== 'function') return res.status(501).json({ error: 'No handler' });

      try {
        const result = await cap.handler(req, req.body || {});
        return res.json({ success: true, result });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    res.status(405).json({ error: 'Method not allowed' });
  };
}

// ── Edge Middleware (serves /.well-known/agentdom.json) ────────────────────
function createAgentdomMiddleware(options = {}) {
  const manifest = buildManifest(options);

  return async function agentdomMiddleware(req) {
    const { NextResponse } = await import('next/server');
    const url = new URL(req.url);

    if (url.pathname === '/.well-known/agentdom.json') {
      return NextResponse.json(manifest, {
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return NextResponse.next();
  };
}

module.exports = { AgentDOM, agentdomApiHandler, createAgentdomMiddleware, buildManifest };
