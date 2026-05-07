/**
 * agentdom/express — Express.js middleware
 *
 * Embeds AgentDOM into any Express app in ~10 lines.
 * Serves /.well-known/agentdom.json and routes agent intents.
 *
 * Usage:
 *   const { agentdom } = require('agentdom/express');
 *   app.use(agentdom({
 *     host: 'api.myapp.com',
 *     capabilities: [{
 *       intent: 'todos.create',
 *       description: 'Create a todo',
 *       args: { title: { type: 'string', required: true } },
 *       handler: async (req, body) => db.create(body)
 *     }]
 *   }));
 */
'use strict';

function buildManifest({ host, name, description, auth, capabilities = [], apiBasePath = '/api/agentdom' }) {
  return {
    version: '1.0', host, name: name || host,
    description: description || `AgentDOM manifest for ${host}`,
    generated_at: new Date().toISOString(),
    generated_by: 'agentdom-express',
    auth: auth || { method: 'none' },
    capabilities: capabilities.map(cap => ({
      intent: cap.intent, description: cap.description || '',
      transport: 'api', method: cap.method || 'POST',
      endpoint: `https://${host}${apiBasePath}/${cap.intent}`,
      args: cap.args || {}, side_effects: cap.side_effects || ['write_local'],
    })),
  };
}

function agentdom(options = {}) {
  if (!options.host) throw new Error('agentdom/express: host is required');
  const manifest = buildManifest(options);
  const { capabilities = [], apiBasePath = '/api/agentdom' } = options;
  const capMap = Object.fromEntries(capabilities.map(c => [c.intent, c]));

  return function agentdomMiddleware(req, res, next) {
    // Serve manifest
    if (req.method === 'GET' && req.path === '/.well-known/agentdom.json') {
      return res.json(manifest);
    }
    // Route intents
    if (req.method === 'POST' && req.path.startsWith(apiBasePath + '/')) {
      const intent = req.path.slice(apiBasePath.length + 1);
      const cap = capMap[intent];
      if (!cap) return res.status(404).json({ error: `Intent "${intent}" not found`, available: Object.keys(capMap) });
      if (typeof cap.handler !== 'function') return res.status(501).json({ error: 'No handler' });
      Promise.resolve(cap.handler(req, req.body || {}))
        .then(result => { if (!res.headersSent) res.json({ success: true, result }); })
        .catch(err  => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      return;
    }
    next();
  };
}

module.exports = { agentdom, buildManifest };
