import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isTrustedSystemAppRequest } from '../../server/rate-limit-auth.js';

const MODULE_CODE = fs.readFileSync(
  path.resolve(__dirname, '../../js/platform/security/system-fetch.js'),
  'utf8'
);

/* Loads the client-side system-fetch signing module (a plain browser script)
   inside a sandboxed context. `recorder` replaces the underlying fetch BEFORE
   the module loads, so the installed wrapper is what the test drives and
   `captured` receives exactly what the wrapper handed to the real fetch. */
function loadSystemFetch(recorder) {
  const captured = { input: undefined, init: undefined };
  const window = {
    fetch: async (input, init) => {
      captured.input = input;
      captured.init = init;
      return 'original-fetch-result';
    },
    location: { href: 'https://localhost:3003/desktop', origin: 'https://localhost:3003' },
  };
  if (recorder) window.fetch = recorder;
  const sandbox = { window, URL, Headers, require, process, location: window.location };
  vm.runInNewContext(MODULE_CODE, sandbox, { filename: 'system-fetch.js' });
  return { sandbox, window, captured };
}

function fakeReq(headers) {
  const map = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map[name.toLowerCase()] };
}

function trustHeadersFrom(init) {
  const names = ['X-Nova-System-App', 'X-Nova-System-Time', 'X-Nova-System-Signature'];
  return Object.fromEntries(names.map((n) => [n, init.headers.get(n)]));
}

describe('system-fetch signing (OS UI ↔ server rate-limit trust contract)', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = 'unit-test-secret';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    else process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = savedEnv;
  });

  it('stamps same-origin /api/ fetches with headers the server validator accepts', async () => {
    const { window, captured } = loadSystemFetch();
    expect(window.__novaSystemFetchInstalled).toBe(true); // wrapper installed
    await window.fetch('/api/apps/list', { method: 'GET' });
    expect(captured.init).toBeTruthy();
    const stamped = trustHeadersFrom(captured.init);
    expect(stamped['X-Nova-System-App']).toBe('com.astroos.os-shell');
    /* The whole point: what the OS UI signs must satisfy the server's
       trust check, i.e. escape the untrusted per-IP bucket. */
    expect(isTrustedSystemAppRequest(fakeReq(stamped))).toBe(true);
  });

  it('leaves non-API and cross-origin URLs unsigned', async () => {
    const { window, captured } = loadSystemFetch();
    await window.fetch('/js/apps/novaapp-manifest.json');
    expect(captured.init?.headers).toBeUndefined();
    await window.fetch('https://evil.example.com/api/apps/list');
    expect(captured.init?.headers).toBeUndefined();
  });

  it('never overwrites caller-supplied trust headers', async () => {
    const { window, captured } = loadSystemFetch();
    await window.fetch('/api/apps/list', {
      headers: { 'X-Nova-System-App': 'com.custom.override' },
    });
    expect(captured.init.headers.get('X-Nova-System-App')).toBe('com.custom.override');
  });

  it('preserves caller init (method/body survive the wrap)', async () => {
    const { window, captured } = loadSystemFetch();
    await window.fetch('/api/os/log', { method: 'POST', body: '{"lines":[]}' });
    expect(captured.init.method).toBe('POST');
    expect(captured.init.body).toBe('{"lines":[]}');
  });

  it('degrades to plain fetch when the launch secret is unavailable', async () => {
    delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    const { window, captured } = loadSystemFetch();
    await window.fetch('/api/apps/list');
    expect(captured.init?.headers).toBeUndefined();
  });

  it('is idempotent — a second load does not double-wrap', () => {
    const { window } = loadSystemFetch();
    const wrapper = window.fetch;
    /* Same window object, module re-evaluated in a fresh context: the
       install guard must keep the wrapper identical instead of wrapping
       the wrapper. */
    const sandbox2 = { window, URL, Headers, require, process, location: window.location };
    vm.runInNewContext(MODULE_CODE, sandbox2, { filename: 'system-fetch.js' });
    expect(window.fetch).toBe(wrapper);
  });

  it('passes non-string input through untouched', async () => {
    const { window, captured } = loadSystemFetch();
    const requestObj = { url: '/api/apps/list' }; // stand-in for a Request object
    await window.fetch(requestObj);
    expect(captured.input).toBe(requestObj);
    expect(captured.init).toBeUndefined();
  });
});
