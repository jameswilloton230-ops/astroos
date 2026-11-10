import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodeCrypto from 'node:crypto';

// ── system-fetch.js — trust-header-signing fetch wrapper for the OS UI ──────
// Window-attach script with no module.exports: it wraps window.fetch once and
// stamps HMAC trust headers onto same-origin /api/ requests. tests/setup.js
// provides globalThis.window === globalThis and a vi.fn() fetch; each test
// resets window.fetch back to a controllable mock before requiring the module.

const SF_PATH = '../../../js/platform/security/system-fetch.js';
const SECRET = 'unit-test-rate-limit-secret';

let originalFetch;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function loadSystemFetch() {
  requireFresh(SF_PATH);
  return window.fetch;
}

describe('system-fetch (js/platform/security/system-fetch.js)', () => {
  beforeEach(() => {
    // Same-origin anchor the wrapper resolves relative URLs against.
    window.location = { href: 'https://localhost/index.html', origin: 'https://localhost' };
    originalFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    window.fetch = originalFetch;
    delete window.__novaSystemFetchInstalled;
    delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
  });

  afterEach(() => {
    delete window.location;
    delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    // Leave the global fetch as setup.js's plain mock for other suites.
    window.fetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  describe('installation', () => {
    it('wraps window.fetch exactly once and marks itself installed', () => {
      const wrapped = loadSystemFetch();
      expect(window.__novaSystemFetchInstalled).toBe(true);
      expect(window.fetch).not.toBe(originalFetch);

      // Re-evaluating the script must not double-wrap (guard flag).
      const before = window.fetch;
      loadSystemFetch();
      expect(window.fetch).toBe(before);
      expect(wrapped).toBe(before);
    });
  });

  describe('trust-header signing', () => {
    it('signs same-origin /api/ requests with a verifiable HMAC and preserves caller headers', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      await wrapped('/api/apps/list', { headers: { 'X-Custom': 'keep-me' } });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      const [input, init] = originalFetch.mock.calls[0];
      expect(input).toBe('/api/apps/list');

      const headers = init.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect(headers.get('X-Custom')).toBe('keep-me');
      expect(headers.get('X-Nova-System-App')).toBe('com.astroos.os-shell');

      const timestamp = headers.get('X-Nova-System-Time');
      expect(timestamp).toMatch(/^\d+$/);
      const expectedSig = nodeCrypto
        .createHmac('sha256', SECRET)
        .update(`${timestamp}\ncom.astroos.os-shell`)
        .digest('hex');
      expect(headers.get('X-Nova-System-Signature')).toBe(expectedSig);
    });

    it('signs relative paths and URL objects against window.location', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      await wrapped('/api/settings/get');
      let [, init] = originalFetch.mock.calls[0];
      expect(init.headers.get('X-Nova-System-App')).toBe('com.astroos.os-shell');

      await wrapped(new URL('https://localhost/api/apps/serve/register'));
      [, init] = originalFetch.mock.calls[1];
      expect(init.headers.get('X-Nova-System-Signature')).toBeTypeOf('string');
    });
  });

  describe('what is NOT signed (the untrusted bucket)', () => {
    it('leaves requests unsigned when no rate-limit secret is available', async () => {
      // No ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET in the environment.
      const wrapped = loadSystemFetch();
      const init = { headers: { 'X-Plain': '1' } };

      await wrapped('/api/apps/list', init);

      const [, passedInit] = originalFetch.mock.calls[0];
      expect(passedInit).toBe(init); // untouched, not even copied
      expect(passedInit.headers['X-Plain']).toBe('1');
      expect(passedInit.headers['X-Nova-System-App']).toBeUndefined();
    });

    it('never signs non-/api/ paths', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      await wrapped('https://localhost/other/page', { headers: new Headers({ 'X-App': '1' }) });

      const [, init] = originalFetch.mock.calls[0];
      expect(init.headers.get('X-Nova-System-App')).toBeNull();
      expect(init.headers.get('X-App')).toBe('1');
    });

    it('never signs cross-origin /api/ requests', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      await wrapped('https://evil.example/api/steal', { headers: new Headers() });

      const [, init] = originalFetch.mock.calls[0];
      expect(init.headers.get('X-Nova-System-App')).toBeNull();
      expect(init.headers.get('X-Nova-System-Signature')).toBeNull();
    });
  });

  describe('defensive contract', () => {
    it('never overwrites caller-supplied trust headers (caller wins)', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      await wrapped('/api/apps/list', { headers: { 'X-Nova-System-App': 'spoofed-app' } });

      const [, init] = originalFetch.mock.calls[0];
      expect(init.headers.get('X-Nova-System-App')).toBe('spoofed-app');
    });

    it('passes Request objects (and other non-string/URL inputs) through untouched', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();

      const requestLike = { url: 'https://localhost/api/apps/list' };
      const init = { method: 'POST' };
      await wrapped(requestLike, init);

      const [passedInput, passedInit] = originalFetch.mock.calls[0];
      expect(passedInput).toBe(requestLike);
      expect(passedInit).toBe(init);
    });

    it('still delivers the response through the original fetch', async () => {
      process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
      const wrapped = loadSystemFetch();
      const result = await wrapped('/api/apps/list');
      expect(result).toEqual({ ok: true, json: expect.any(Function) });
    });
  });
});
