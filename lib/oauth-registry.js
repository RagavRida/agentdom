/**
 * AgentDOM — OAuth App Registry (Phase 2C)
 *
 * Centralized, extensible registry of OAuth / API-key configurations
 * for every supported SaaS provider. Three resolution layers:
 *
 *   1. Vendor-native:  https://{host}/.well-known/agentdom.json  (vendor publishes)
 *   2. Polyfill:       ./manifests/{host}.json  (we ship bundled)
 *   3. Built-in:       REGISTRY below  (hardcoded defaults)
 *
 * Vendor override: if a host publishes /.well-known/agentdom.json with an
 * `auth` block, that takes priority over everything here. This ensures
 * vendors can always claim control of their own auth surface.
 *
 * All client_ids below are PUBLIC (PKCE / device flow — no secret needed).
 * Providers that require a client_secret are flagged `needs_secret: true`
 * and expect it via env: AGENTDOM_<HOST>_CLIENT_SECRET.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Built-in Registry ─────────────────────────────────────────────────────

const REGISTRY = {
  // ── OAuth PKCE providers ──────────────────────────────────────────────
  'linear.app': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_LINEAR_APP_CLIENT_ID || 'AGENTDOM_LINEAR',
    auth_url:    'https://linear.app/oauth/authorize',
    token_url:   'https://api.linear.app/oauth/token',
    scopes:      ['read', 'write'],
    pkce:        true,
  },
  'vercel.com': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_VERCEL_COM_CLIENT_ID || 'AGENTDOM_VERCEL',
    auth_url:    'https://vercel.com/oauth/authorize',
    token_url:   'https://api.vercel.com/v2/oauth/access_token',
    scopes:      [],
    pkce:        true,
  },
  'supabase.com': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_SUPABASE_COM_CLIENT_ID || 'AGENTDOM_SUPABASE',
    auth_url:    'https://api.supabase.com/v1/oauth/authorize',
    token_url:   'https://api.supabase.com/v1/oauth/token',
    scopes:      ['all'],
    pkce:        true,
  },
  'cal.com': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_CAL_COM_CLIENT_ID || 'AGENTDOM_CALCOM',
    auth_url:    'https://app.cal.com/oauth/authorize',
    token_url:   'https://app.cal.com/oauth/token',
    scopes:      ['DEFAULT'],
    pkce:        true,
  },
  'figma.com': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_FIGMA_COM_CLIENT_ID || 'AGENTDOM_FIGMA',
    auth_url:    'https://www.figma.com/oauth',
    token_url:   'https://www.figma.com/api/oauth/token',
    scopes:      ['file_read'],
    pkce:        true,
  },
  'clickup.com': {
    method:      'oauth2_pkce',
    client_id:   process.env.AGENTDOM_CLICKUP_COM_CLIENT_ID || 'AGENTDOM_CLICKUP',
    auth_url:    'https://app.clickup.com/api',
    token_url:   'https://api.clickup.com/api/v2/oauth/token',
    scopes:      [],
    pkce:        true,
  },

  // ── OAuth standard (client_secret required) ───────────────────────────
  'hubspot.com': {
    method:       'oauth2',
    client_id:    process.env.AGENTDOM_HUBSPOT_COM_CLIENT_ID || 'AGENTDOM_HUBSPOT',
    auth_url:     'https://app.hubspot.com/oauth/authorize',
    token_url:    'https://api.hubspot.com/oauth/v1/token',
    scopes:       ['contacts', 'crm.objects.contacts.read', 'crm.objects.contacts.write'],
    needs_secret: true,
    pkce:         false,
  },
  'notion.so': {
    method:       'oauth2',
    client_id:    process.env.AGENTDOM_NOTION_SO_CLIENT_ID || 'AGENTDOM_NOTION',
    auth_url:     'https://api.notion.com/v1/oauth/authorize',
    token_url:    'https://api.notion.com/v1/oauth/token',
    scopes:       [],
    needs_secret: true,
    pkce:         false,
  },
  'slack.com': {
    method:       'oauth2',
    client_id:    process.env.AGENTDOM_SLACK_COM_CLIENT_ID || 'AGENTDOM_SLACK',
    auth_url:     'https://slack.com/oauth/v2/authorize',
    token_url:    'https://slack.com/api/oauth.v2.access',
    scopes:       ['channels:read', 'chat:write', 'users:read'],
    needs_secret: true,
    pkce:         false,
  },
  'asana.com': {
    method:       'oauth2',
    client_id:    process.env.AGENTDOM_ASANA_COM_CLIENT_ID || 'AGENTDOM_ASANA',
    auth_url:     'https://app.asana.com/-/oauth_authorize',
    token_url:    'https://app.asana.com/-/oauth_token',
    scopes:       ['default'],
    needs_secret: true,
    pkce:         false,
  },
  'atlassian.com': {
    method:       'oauth2',
    client_id:    process.env.AGENTDOM_ATLASSIAN_COM_CLIENT_ID || 'AGENTDOM_ATLASSIAN',
    auth_url:     'https://auth.atlassian.com/authorize',
    token_url:    'https://auth.atlassian.com/oauth/token',
    scopes:       ['read:jira-work', 'write:jira-work', 'read:jira-user'],
    needs_secret: true,
    pkce:         false,
  },

  // ── Device flow (GitHub) ──────────────────────────────────────────────
  'github.com': {
    method:      'device_flow',
    client_id:   process.env.AGENTDOM_GITHUB_COM_CLIENT_ID || 'Ov23liMxf4J3PjYcS5YK',
    device_url:  'https://github.com/login/device/code',
    token_url:   'https://github.com/login/oauth/access_token',
    scopes:      ['repo', 'user:email'],
    pkce:        false,
  },

  // ── API key only (no OAuth) ───────────────────────────────────────────
  'anthropic.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'ANTHROPIC_API_KEY',
    key_header:  'x-api-key',
    key_format:  '{token}',
  },
  'openai.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'OPENAI_API_KEY',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'resend.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'RESEND_API_KEY',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'sendgrid.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'SENDGRID_API_KEY',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'stripe.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'STRIPE_SECRET_KEY',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'datadog.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'DD_API_KEY',
    key_header:  'DD-API-KEY',
    key_format:  '{token}',
  },
  'sentry.io': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'SENTRY_AUTH_TOKEN',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'posthog.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'POSTHOG_API_KEY',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'pinecone.io': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'PINECONE_API_KEY',
    key_header:  'Api-Key',
    key_format:  '{token}',
  },
  'replicate.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'REPLICATE_API_TOKEN',
    key_header:  'Authorization',
    key_format:  'Bearer {token}',
  },
  'twilio.com': {
    method:      'api_key',
    api_key_alt: true,
    key_env:     'TWILIO_AUTH_TOKEN',
    key_header:  'Authorization',
    key_format:  'Basic {token}',  // base64(account_sid:auth_token)
  },
};

// ── Resolution chain ──────────────────────────────────────────────────────

/**
 * Resolve the auth config for a provider host.
 *
 * Priority:
 *   1. .well-known/agentdom.json auth block (if previously fetched/cached)
 *   2. Bundled polyfill manifest auth block
 *   3. Built-in REGISTRY
 *
 * @param {string} host — e.g. "hubspot.com"
 * @param {object} [manifestCache] — optional cached manifest (from discover())
 * @returns {object|null} config or null if unknown
 */
function resolve(host, manifestCache = null) {
  // 1. Manifest auth takes priority (vendor-native or polyfill)
  if (manifestCache?.auth) {
    return _normalizeManifestAuth(host, manifestCache.auth);
  }

  // 2. Check bundled polyfill
  const polyfillPath = path.join(__dirname, '..', 'manifests', `${host}.json`);
  if (fs.existsSync(polyfillPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(polyfillPath, 'utf-8'));
      if (manifest.auth) {
        return _normalizeManifestAuth(host, manifest.auth);
      }
    } catch (_) {}
  }

  // 3. Built-in registry
  return REGISTRY[host] || null;
}

/**
 * Normalize a manifest auth block into the same shape as REGISTRY entries.
 */
function _normalizeManifestAuth(host, auth) {
  const method = auth.method || 'none';
  if (method === 'api_key') {
    return {
      method:      'api_key',
      api_key_alt: true,
      key_env:     auth.key_env   || `AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_KEY`,
      key_header:  auth.header    || 'Authorization',
      key_format:  auth.format    || 'Bearer {token}',
      obtain_url:  auth.obtain_url,
    };
  }
  if (method.startsWith('oauth2') || method === 'device_flow') {
    return {
      method:       auth.method,
      client_id:    auth.client_id || process.env[`AGENTDOM_${host.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}_CLIENT_ID`],
      auth_url:     auth.auth_url || auth.authorize_url,
      token_url:    auth.token_url,
      scopes:       auth.scopes || [],
      pkce:         method === 'oauth2_pkce',
      needs_secret: auth.needs_secret || false,
      device_url:   auth.device_url,
    };
  }
  return { method, ...auth };
}

/**
 * List all known providers (built-in + bundled polyfills).
 * @returns {string[]}
 */
function listKnown() {
  const hosts = new Set(Object.keys(REGISTRY));
  const manifestDir = path.join(__dirname, '..', 'manifests');
  if (fs.existsSync(manifestDir)) {
    for (const f of fs.readdirSync(manifestDir)) {
      if (f.endsWith('.json')) hosts.add(f.replace('.json', ''));
    }
  }
  return [...hosts].sort();
}

/**
 * Check if a provider is in the registry (built-in or polyfill).
 * @param {string} host
 * @returns {boolean}
 */
function isKnown(host) {
  return !!resolve(host);
}

/**
 * Add or override a provider's config at runtime.
 * Used by `agentdom setup` when auto-detecting a provider's auth.
 * @param {string} host
 * @param {object} config
 */
function register(host, config) {
  REGISTRY[host] = config;
}

module.exports = {
  REGISTRY,
  resolve,
  listKnown,
  isKnown,
  register,
};
