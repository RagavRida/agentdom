/**
 * AgentDOM — Wallet Bootstrap
 *
 * One-shot startup routine that should run before any process touches
 * provider tokens. Responsibilities:
 *
 *   1. Migrate any legacy plaintext ~/.agentdom/wallet.json into Keychain
 *      (or the encrypted-file fallback when Keychain is unavailable).
 *   2. Register every stored token with the token-lifecycle manager so
 *      auto-refresh timers fire across process restarts — not just for
 *      tokens authed within the current process lifetime.
 *
 * Idempotent: safe to call multiple times. Returns a summary so callers
 * (CLI / MCP servers) can surface the result during init logging.
 */

'use strict';

const fs       = require('fs');
const keychain = require('./keychain');
const lifecycle = require('./token-lifecycle');
const registry  = require('./oauth-registry');

let _bootstrapped = false;

/**
 * Run migration + lifecycle registration.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent]  — suppress log output
 * @returns {Promise<{migrated:number, tracked:number, backend:string, alreadyDone:boolean}>}
 */
async function bootstrap(opts = {}) {
  if (_bootstrapped) {
    return { migrated: 0, tracked: 0, backend: keychain.storageBackend(), alreadyDone: true };
  }
  _bootstrapped = true;

  const log = opts.silent ? () => {} : (m) => console.error(`[wallet] ${m}`);

  // 1. Migrate legacy plaintext wallet.json (no-op if already encrypted/migrated).
  // AgentDOM's wallet shape is { wallet: "0.x", providers: { host: {...}, ... } }
  // — keychain.migrate() expects a flat map, so we handle both forms here.
  let migrated = 0;
  try {
    if (fs.existsSync(keychain.WALLET_FILE)) {
      const raw = fs.readFileSync(keychain.WALLET_FILE, 'utf-8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }

      // Skip if already encrypted (envelope format from keychain._encrypt)
      const isEncrypted = parsed && parsed.v === 1 && parsed.iv;
      const isPostMigration = parsed && parsed.wallet === '0.2' && parsed.migrated_at;

      if (parsed && !isEncrypted && !isPostMigration) {
        const providers = parsed.providers && typeof parsed.providers === 'object'
          ? parsed.providers                                  // AgentDOM shape
          : parsed;                                           // flat map shape
        for (const [host, entry] of Object.entries(providers)) {
          if (entry && typeof entry === 'object' && (entry.access_token || entry.token || entry.key || entry.method)) {
            // Existing wallet may store API keys under `token` — normalize to `key`.
            // Legacy entries also used `key_header` / `key_format`; the runtime
            // schema is `header` / `format` — without this, token() returns
            // undefined for those fields on migrated API keys.
            const normalized = { ...entry };
            if (normalized.method === 'api_key' && normalized.token && !normalized.key) {
              normalized.key = normalized.token;
              delete normalized.token;
            }
            if (normalized.key_header && !normalized.header) {
              normalized.header = normalized.key_header;
            }
            delete normalized.key_header;
            if (normalized.key_format && !normalized.format) {
              normalized.format = normalized.key_format;
            }
            delete normalized.key_format;
            await keychain.setToken(host, normalized);
            migrated++;
          }
        }
        if (migrated > 0) {
          log(`migrated ${migrated} provider${migrated === 1 ? '' : 's'} from plaintext wallet.json → ${keychain.storageBackend()}`);
          // Zero out the plaintext file. We leave the file in place (rather than
          // unlinking) so legacy readers find a well-formed empty wallet.
          try {
            fs.writeFileSync(
              keychain.WALLET_FILE,
              JSON.stringify({ wallet: '0.2', providers: {}, migrated_at: new Date().toISOString() }, null, 2),
              { mode: 0o600 }
            );
          } catch (e) {
            log(`warning: could not zero plaintext wallet.json: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    log(`migration failed: ${e.message}`);
  }

  // 2. Re-write any Keychain entries still using legacy field names (carry-over
  // from migrations done before the normalizer was added). Idempotent — only
  // touches entries where a legacy field is present.
  // 3. Register every stored token for auto-refresh.
  let tracked = 0;
  try {
    const providers = await keychain.listProviders();
    for (const host of providers) {
      try {
        let token = await keychain.getToken(host);
        if (!token) continue;
        const needsRewrite =
          (token.token && !token.key && token.method === 'api_key') ||
          (token.key_header && !token.header) ||
          (token.key_format && !token.format) ||
          ('key_header' in token) || ('key_format' in token);
        if (needsRewrite) {
          const fixed = { ...token };
          if (fixed.method === 'api_key' && fixed.token && !fixed.key) {
            fixed.key = fixed.token;
            delete fixed.token;
          }
          if (fixed.key_header && !fixed.header) fixed.header = fixed.key_header;
          delete fixed.key_header;
          if (fixed.key_format && !fixed.format) fixed.format = fixed.key_format;
          delete fixed.key_format;
          await keychain.setToken(host, fixed);
          token = fixed;
          log(`normalized legacy fields for ${host}`);
        }
        const config = registry.resolve(host);
        if (!config) continue;          // unknown provider — no refresh route
        if (!token.refresh_token) continue; // nothing to refresh (api_key, etc.)
        lifecycle.track(host, token, config);
        tracked++;
      } catch (e) {
        log(`could not track ${host}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`lifecycle bootstrap failed: ${e.message}`);
  }

  return {
    migrated,
    tracked,
    backend: keychain.storageBackend(),
    alreadyDone: false,
  };
}

/**
 * Tear down lifecycle timers. Call on process exit.
 */
function shutdown() {
  try { lifecycle.shutdown(); } catch (_) {}
  _bootstrapped = false;
}

/**
 * Reset internal state — exposed for tests only.
 */
function _resetForTests() {
  _bootstrapped = false;
}

module.exports = {
  bootstrap,
  shutdown,
  _resetForTests,
};
