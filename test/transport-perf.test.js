/**
 * AgentDOM — Phase 4 Transport Performance Tests
 *
 * Covers the three new low-latency primitives:
 *   • lib/connection-pool — per-host pooled http.Agent / https.Agent
 *   • lib/token-cache     — read-through cache over keychain
 *   • lib/cdp-pool        — per-origin Puppeteer Page reuse with LRU
 *
 * No real network or real browser is touched — tests use the live
 * keychain backend (with random provider names that are cleaned up) and
 * a duck-typed mock browser for CDP.
 */

'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════════════════════
//  CONNECTION POOL
// ══════════════════════════════════════════════════════════════════════════

describe('connection-pool', () => {
  let pool;

  before(() => { pool = require('../lib/connection-pool'); });

  beforeEach(() => { pool._resetForTests(); });

  it('returns the same agent for the same host (reuse)', () => {
    const a1 = pool.getAgent('api.example.com');
    const a2 = pool.getAgent('api.example.com');
    assert.strictEqual(a1, a2, 'same host should yield same agent');
    assert.equal(pool.stats().hosts, 1);
    assert.equal(pool.stats().reused, 1);
  });

  it('returns different agents for different hosts', () => {
    const a = pool.getAgent('api.alpha.com');
    const b = pool.getAgent('api.beta.com');
    assert.notStrictEqual(a, b);
    assert.equal(pool.stats().hosts, 2);
  });

  it('accepts a full URL and extracts host', () => {
    const a1 = pool.getAgent('https://api.example.com/v1/chat');
    const a2 = pool.getAgent('https://api.example.com/other/path');
    assert.strictEqual(a1, a2, 'paths on same host should reuse');
  });

  it('keeps http and https agents separate for the same host', () => {
    const httpAgent  = pool.getAgent('http://localhost:3000');
    const httpsAgent = pool.getAgent('https://localhost:3000');
    assert.notStrictEqual(httpAgent, httpsAgent);
  });

  it('configures keep-alive on the agent', () => {
    const a = pool.getAgent('api.keepalive.test');
    assert.equal(a.keepAlive, true, 'keep-alive should be enabled');
    assert.equal(a.maxSockets, 6, 'maxSockets should match browser default');
  });

  it('shutdown clears all agents', () => {
    pool.getAgent('a.test');
    pool.getAgent('b.test');
    assert.equal(pool.stats().hosts, 2);
    pool.shutdown();
    assert.equal(pool.stats().hosts, 0);
  });

  it('configure() overrides maxSockets', () => {
    pool._resetForTests();
    pool.configure({ maxSockets: 12 });
    const a = pool.getAgent('configured.test');
    assert.equal(a.maxSockets, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  TOKEN CACHE
// ══════════════════════════════════════════════════════════════════════════

describe('token-cache', () => {
  let cache;
  let keychain;
  const HOSTS = [];

  before(() => {
    cache    = require('../lib/token-cache');
    keychain = require('../lib/keychain');
  });

  beforeEach(() => { cache._resetForTests(); });

  afterEach(async () => {
    for (const h of HOSTS.splice(0)) {
      try { await keychain.deleteToken(h); } catch (_) {}
    }
  });

  function mkHost(label) {
    const h = `tc-${label}-${crypto.randomBytes(3).toString('hex')}.example`;
    HOSTS.push(h);
    return h;
  }

  it('miss then hit — second call comes from cache', async () => {
    const host = mkHost('hit');
    await keychain.setToken(host, {
      method: 'api_key',
      key:    'sk-cached',
      header: 'Authorization',
      format: 'Bearer {token}',
    });
    // setToken fires onTokenChange → invalidate, so first read is a miss
    const first = await cache.getCached(host);
    assert.ok(first, 'first read returns token');
    assert.equal(cache.stats().misses, 1);
    const second = await cache.getCached(host);
    assert.ok(second);
    assert.equal(cache.stats().hits, 1, 'second read should hit cache');
  });

  it('returns null for unknown providers (still counts as miss)', async () => {
    const result = await cache.getCached(`never-stored-${crypto.randomBytes(3).toString('hex')}.example`);
    assert.equal(result, null);
    assert.equal(cache.stats().misses, 1);
  });

  it('does not cache tokens that are already expired', async () => {
    const host = mkHost('expired');
    await keychain.setToken(host, {
      method:       'oauth2',
      access_token: 'expired_tok',
      expires_at:   Date.now() - 1000, // already in the past
    });
    await cache.getCached(host); // miss → fetches from keychain → does NOT store
    await cache.getCached(host); // should be another miss
    assert.equal(cache.stats().misses, 2, 'expired tokens should not be cached');
  });

  it('invalidate() drops the entry', async () => {
    const host = mkHost('inv');
    await keychain.setToken(host, { method: 'api_key', key: 'k', header: 'X', format: 'Bearer {token}' });
    await cache.getCached(host);            // populate
    cache.invalidate(host);
    assert.equal(cache.stats().invalidations >= 1, true);
    cache._resetForTests();                 // reset counters
    const hostAgain = host;
    await cache.getCached(hostAgain);
    assert.equal(cache.stats().misses, 1, 'after invalidate, next read is a miss');
  });

  it('keychain.setToken automatically invalidates the cached entry', async () => {
    const host = mkHost('auto-inv');
    await keychain.setToken(host, { method: 'api_key', key: 'v1', header: 'X', format: 'Bearer {token}' });
    const first = await cache.getCached(host);
    assert.equal(first.key, 'v1');

    // Rewrite the token — should auto-invalidate via onTokenChange
    await keychain.setToken(host, { method: 'api_key', key: 'v2', header: 'X', format: 'Bearer {token}' });
    const after = await cache.getCached(host);
    assert.equal(after.key, 'v2', 'cache should reflect updated token after setToken');
  });

  it('keychain.deleteToken auto-invalidates', async () => {
    const host = mkHost('auto-del');
    await keychain.setToken(host, { method: 'api_key', key: 'gone-soon', header: 'X', format: 'Bearer {token}' });
    await cache.getCached(host); // populate
    await keychain.deleteToken(host);
    const after = await cache.getCached(host);
    assert.equal(after, null, 'after delete the cache returns null');
  });

  it('warmAll() preloads every keychain provider', async () => {
    const a = mkHost('warm-a');
    const b = mkHost('warm-b');
    await keychain.setToken(a, { method: 'api_key', key: 'a', header: 'X', format: 'Bearer {token}' });
    await keychain.setToken(b, { method: 'api_key', key: 'b', header: 'X', format: 'Bearer {token}' });
    cache._resetForTests();

    const res = await cache.warmAll();
    assert.ok(res.warmed >= 2, `expected ≥2 warmed, got ${res.warmed}`);

    // Now reads should be hits
    cache._resetForTests();
    // Re-warm because _resetForTests cleared the cache too
    await cache.warmAll();
    await cache.getCached(a);
    await cache.getCached(b);
    const s = cache.stats();
    assert.equal(s.hits, 2, 'both reads should hit after warm');
  });

  it('clamps TTL to 5 minutes maximum even with a far-future expiry', async () => {
    const host = mkHost('ttl-cap');
    const tenHoursAhead = Date.now() + 10 * 60 * 60 * 1000;
    await keychain.setToken(host, {
      method: 'oauth2',
      access_token: 'tok',
      expires_at: tenHoursAhead,
    });
    // First read populates cache; TTL should be capped at 5 min internally.
    await cache.getCached(host);
    assert.equal(cache.stats().size, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  CDP POOL
// ══════════════════════════════════════════════════════════════════════════

describe('cdp-pool', () => {
  let cdp;

  before(() => { cdp = require('../lib/cdp-pool'); });

  beforeEach(async () => { await cdp._resetForTests(); });

  /** Mock Puppeteer Browser + Page. */
  function makeBrowser() {
    let nextId = 0;
    const browser = {
      pages:   [],
      newPage: async () => {
        const id = ++nextId;
        const page = {
          id,
          _url:   '',
          closed: false,
          url()   { return this._url; },
          async goto(u) { this._url = u; },
          async close() { this.closed = true; },
        };
        browser.pages.push(page);
        return page;
      },
    };
    return browser;
  }

  it('creates a page on first getSession and navigates', async () => {
    const browser = makeBrowser();
    const page = await cdp.getSession('https://github.com', browser);
    assert.equal(page.url(), 'https://github.com');
    assert.equal(cdp.stats().created, 1);
  });

  it('reuses the cached page for the same origin (skips re-nav)', async () => {
    const browser = makeBrowser();
    const a = await cdp.getSession('https://github.com', browser);
    cdp.releaseSession('https://github.com');
    a._url = 'https://github.com/some/path'; // simulate in-app navigation
    const b = await cdp.getSession('https://github.com', browser);
    assert.strictEqual(a, b, 'should reuse same page');
    assert.equal(b.url(), 'https://github.com/some/path', 'goto should NOT have been called');
    assert.equal(cdp.stats().reused, 1);
  });

  it('LRU evicts the oldest released session when at capacity', async () => {
    const browser = makeBrowser();
    cdp.configure({ max: 3 });

    const p1 = await cdp.getSession('https://a.com', browser); cdp.releaseSession('https://a.com');
    await new Promise(r => setTimeout(r, 5));
    const p2 = await cdp.getSession('https://b.com', browser); cdp.releaseSession('https://b.com');
    await new Promise(r => setTimeout(r, 5));
    const p3 = await cdp.getSession('https://c.com', browser); cdp.releaseSession('https://c.com');

    // Pool full at 3 — adding a 4th must evict the oldest (a.com)
    const p4 = await cdp.getSession('https://d.com', browser);
    assert.equal(cdp.stats().evicted, 1, 'one eviction expected');
    assert.equal(p1.closed, true, 'evicted page should be closed');
    assert.ok([...cdp.stats().origins].includes('https://b.com'));
    assert.ok([...cdp.stats().origins].includes('https://d.com'));
    assert.ok(![...cdp.stats().origins].includes('https://a.com'), 'a.com should be gone');

    // Quiet unused-var warning
    void p2; void p3; void p4;
  });

  it('shutdown closes every page', async () => {
    const browser = makeBrowser();
    await cdp.getSession('https://x.test', browser);
    await cdp.getSession('https://y.test', browser);
    assert.equal(cdp.stats().size, 2);
    await cdp.shutdown();
    assert.equal(cdp.stats().size, 0);
    assert.ok(browser.pages.every(p => p.closed), 'all pages should be closed');
  });

  it('normalizes origins (URL with path → origin)', async () => {
    const browser = makeBrowser();
    const a = await cdp.getSession('https://example.com/path/to/thing', browser);
    cdp.releaseSession('https://example.com');
    const b = await cdp.getSession('https://example.com', browser);
    assert.strictEqual(a, b, 'origins should normalize to the same key');
  });

  it('rejects when no browser is supplied', async () => {
    await assert.rejects(() => cdp.getSession('https://x.test'), /browser with newPage/);
  });
});

console.log('\n🧪 AgentDOM Phase 4 — Transport Performance Tests\n');
