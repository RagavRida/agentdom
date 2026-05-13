/**
 * AgentDOM — Keychain Integration
 *
 * Secure token storage using OS-native credential stores:
 *   macOS   → Keychain (via keytar)
 *   Windows → DPAPI Credential Manager (via keytar)
 *   Linux   → libsecret / GNOME Keyring / KWallet (via keytar)
 *   Fallback → AES-256-GCM encrypted wallet.json
 *
 * All wallet tokens flow through here. Plain-text wallet.json
 * is used ONLY as a last resort on systems without a credential store.
 *
 * Service name in Keychain: "agentdom"
 * Account name: the provider host, e.g. "hubspot.com"
 * Password:     JSON-serialized token object (access_token, refresh_token, expiry…)
 */

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./resilience');

const AGENTDOM_DIR   = path.join(os.homedir(), '.agentdom');
const WALLET_FILE    = path.join(AGENTDOM_DIR, 'wallet.json');
const KEYCHAIN_SVC   = 'agentdom';

// ── Change notification (Phase 4 — token-cache invalidation hook) ─────────

const _changeListeners = [];

/**
 * Register a callback fired whenever a token is written or deleted.
 * Used by lib/token-cache to invalidate stale entries.
 *
 * @param {(provider:string, op:'set'|'delete') => void} fn
 */
function onTokenChange(fn) {
  if (typeof fn === 'function') _changeListeners.push(fn);
}

function _notifyChange(provider, op) {
  for (const fn of _changeListeners) {
    try { fn(provider, op); } catch (_) { /* swallow */ }
  }
}

// ── Keytar lazy-load (optional dep, graceful fallback) ────────────────────

let _keytar = null;
let _keytarAvailable = null;

function getKeytar() {
  if (_keytarAvailable === false) return null;
  if (_keytar) return _keytar;
  try {
    _keytar = require('keytar');
    _keytarAvailable = true;
    return _keytar;
  } catch (_) {
    _keytarAvailable = false;
    return null;
  }
}

// ── Encrypted fallback (when Keychain unavailable) ────────────────────────
//
// Key derived from machine-unique entropy so the file is useless if copied.
// NOT a replacement for Keychain — just better than plaintext.

function _machineKey() {
  const seed = `${os.hostname()}::${os.userInfo().username}::agentdom`;
  return crypto.createHash('sha256').update(seed).digest();
}

function _encrypt(obj) {
  const iv  = crypto.randomBytes(12);
  const key = _machineKey();
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') });
}

function _decrypt(raw) {
  try {
    const { v, iv, tag, data } = JSON.parse(raw);
    if (v !== 1) throw new Error('unknown version');
    const key = _machineKey();
    const d   = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8'));
  } catch { return null; }
}

// ── Fallback file wallet ───────────────────────────────────────────────────

function _ensureDir() {
  if (!fs.existsSync(AGENTDOM_DIR)) fs.mkdirSync(AGENTDOM_DIR, { recursive: true, mode: 0o700 });
}

function _readFile() {
  if (!fs.existsSync(WALLET_FILE)) return {};
  try {
    const raw = fs.readFileSync(WALLET_FILE, 'utf-8');
    // Support both encrypted and legacy plain-JSON format
    try {
      const enc = JSON.parse(raw);
      if (enc.v === 1 && enc.iv) {
        // Encrypted format
        return _decrypt(raw) || {};
      }
    } catch (_) {}
    // Legacy plain JSON
    return JSON.parse(raw);
  } catch { return {}; }
}

function _writeFile(map) {
  _ensureDir();
  const encrypted = _encrypt(map);
  // Atomic write: write to tmp file first, then rename
  const tmpFile = WALLET_FILE + '.tmp';
  fs.writeFileSync(tmpFile, encrypted, { mode: 0o600 });
  fs.renameSync(tmpFile, WALLET_FILE);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Store a token for a provider.
 *
 * @param {string} provider   — e.g. "hubspot.com"
 * @param {object} tokenData  — { access_token, refresh_token?, expires_at?, method, ... }
 */
async function setToken(provider, tokenData) {
  _ensureDir();
  const keytar = getKeytar();
  const payload = JSON.stringify(tokenData);

  if (keytar) {
    try {
      await keytar.setPassword(KEYCHAIN_SVC, provider, payload);
      _notifyChange(provider, 'set');
      return { ok: true, storage: 'keychain' };
    } catch (e) {
      console.error(`[keychain] write failed for ${provider}: ${e.message} — falling back to encrypted file`);
    }
  }

  // Fallback: encrypted file
  const map = _readFile();
  map[provider] = tokenData;
  _writeFile(map);
  _notifyChange(provider, 'set');
  return { ok: true, storage: 'encrypted-file' };
}

/**
 * Retrieve a token for a provider.
 *
 * @param {string} provider
 * @returns {object|null} token data or null if not found
 */
async function getToken(provider) {
  const keytar = getKeytar();

  if (keytar) {
    try {
      const raw = await keytar.getPassword(KEYCHAIN_SVC, provider);
      if (raw) {
        try { return JSON.parse(raw); } catch { return null; }
      }
    } catch (e) {
      console.error(`[keychain] read failed for ${provider}: ${e.message} — trying file`);
    }
  }

  // Fallback: encrypted file
  const map = _readFile();
  return map[provider] || null;
}

/**
 * Delete a token (logout).
 *
 * @param {string} provider
 */
async function deleteToken(provider) {
  const keytar = getKeytar();
  let deleted = false;

  if (keytar) {
    try {
      deleted = await keytar.deletePassword(KEYCHAIN_SVC, provider);
    } catch (_) {}
  }

  // Also clean file fallback
  const map = _readFile();
  if (map[provider]) { delete map[provider]; _writeFile(map); deleted = true; }

  if (deleted) _notifyChange(provider, 'delete');
  return { ok: deleted, provider };
}

/**
 * List all providers with stored tokens.
 *
 * @returns {string[]} provider host names
 */
async function listProviders() {
  const keytar = getKeytar();
  const providers = new Set();

  if (keytar) {
    try {
      const creds = await keytar.findCredentials(KEYCHAIN_SVC);
      creds.forEach(c => providers.add(c.account));
    } catch (_) {}
  }

  // Merge with file
  const map = _readFile();
  Object.keys(map).forEach(k => providers.add(k));

  return [...providers];
}

/**
 * Check if a token is expired (or expiring within `bufferMs`).
 *
 * @param {object} tokenData
 * @param {number} bufferMs — grace period (default 5 min)
 */
function isExpired(tokenData, bufferMs = 5 * 60 * 1000) {
  if (!tokenData?.expires_at) return false; // no expiry = assume valid
  return Date.now() + bufferMs >= tokenData.expires_at;
}

/**
 * Get storage backend being used.
 * Useful for diagnostics / `agentdom doctor`.
 */
function storageBackend() {
  if (getKeytar()) return 'keychain';
  return 'encrypted-file';
}

/**
 * Migrate legacy plaintext wallet.json to encrypted/keychain format.
 * Run once on upgrade.
 */
async function migrate() {
  if (!fs.existsSync(WALLET_FILE)) return { migrated: 0 };

  let raw;
  try { raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8')); } catch { return { migrated: 0 }; }

  // Already encrypted?
  if (raw.v === 1 && raw.iv) return { migrated: 0, already_encrypted: true };

  let count = 0;
  for (const [provider, token] of Object.entries(raw)) {
    if (token && typeof token === 'object') {
      await setToken(provider, token);
      count++;
    }
  }

  return { migrated: count };
}

module.exports = {
  setToken,
  getToken,
  deleteToken,
  listProviders,
  isExpired,
  storageBackend,
  migrate,
  onTokenChange,
  KEYCHAIN_SVC,
  WALLET_FILE,
};
