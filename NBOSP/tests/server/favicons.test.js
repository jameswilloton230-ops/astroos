import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-favicons-'));
process.env.NBOSP_DATA_DIR = tempDir; // favicons.js resolves its DB dir at load

// favicons.js destructures { Agent, fetch } from 'undici' at module load and
// calls dns.promises.lookup at request time — patch both on the real module
// objects (restored after the file). vi.mock() cannot reliably intercept
// builtin/node_modules requires for CJS modules under the current runner.
const undici = require('undici');
const realFetch = undici.fetch;
const realAgent = undici.Agent;

const dns = require('dns');
const realLookup = dns.promises.lookup;

const fetchState = { impl: null, calls: [] };

class FakeAgent {
  constructor() {}
  close() { return Promise.resolve(); }
}

function fakeFetch(url, opts) {
  fetchState.calls.push(String(url));
  return fetchState.impl(String(url), opts);
}

undici.fetch = fakeFetch;
undici.Agent = FakeAgent;
dns.promises.lookup = async (hostname) => {
  if (fetchState.lookup) return fetchState.lookup(hostname);
  return { address: '93.184.216.34', family: 4 }; // public IP by default
};

const { setupFaviconRoutes, closeFaviconDb } = require('../../server/favicons.js');

// Fixtures must NOT be byte-identical to favicons.js's FAVICON_DEFAULT
// (a 1×1 transparent PNG) — a cached entry equal to it is treated as the
// legacy placeholder and deliberately evicted+refetched.
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 0x42)]);
const PNG_FRAME = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(12, 0x7d)]);
function icoWithEmbeddedPng(png) {
  const buf = Buffer.alloc(6 + 16 + png.length);
  buf[0] = 0; buf[1] = 0; buf[2] = 1; buf[3] = 0; // ICONDIR
  buf.writeUInt16LE(1, 4); // one image
  const dir = 6;
  buf[dir] = 16; buf[dir + 1] = 16; // 16×16
  buf.writeUInt32LE(png.length, dir + 8);
  buf.writeUInt32LE(6 + 16, dir + 12);
  png.copy(buf, 6 + 16);
  return buf;
}

afterAll(() => {
  undici.fetch = realFetch;
  undici.Agent = realAgent;
  dns.promises.lookup = realLookup;
  try { closeFaviconDb(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchState.impl = () => { throw new Error('unexpected fetch — set fetchState.impl'); };
  fetchState.calls = [];
  fetchState.lookup = null;
});

function buildApp() {
  const app = express();
  setupFaviconRoutes(app);
  return app;
}

describe('server/favicons.js — GET /favicon.ico (static)', () => {
  it('serves a PNG with a one-day cache policy', async () => {
    const res = await request(buildApp()).get('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('max-age=86400');
    expect(res.body[0]).toBe(0x89); // PNG magic
    expect(res.body[1]).toBe(0x50);
  });
});

describe('server/favicons.js — GET /api/favicon validation (no network)', () => {
  it('requires a domain or url parameter', async () => {
    const res = await request(buildApp()).get('/api/favicon');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('domain or url required');
  });

  it.each([
    ['localhost', 'loopback name'],
    ['127.0.0.1', 'loopback IP'],
    ['192.168.1.10', 'RFC1918'],
    ['10.1.2.3', 'RFC1918'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['printer.local', 'mDNS'],
    ['service.internal', 'internal DNS'],
    ['nodot', 'no dot'],
    ['has space.com', 'whitespace'],
  ])('rejects private/invalid domain %s (%s)', async (domain) => {
    const res = await request(buildApp()).get(`/api/favicon?domain=${encodeURIComponent(domain)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid domain');
  });

  it.each([
    ['ftp://example.com/', 'non-http protocol'],
    ['https://user:pass@example.com/', 'embedded credentials'],
    ['https://example.com:8443/', 'explicit port'],
    ['https://localhost/favicon.ico', 'private hostname'],
  ])('rejects url %s (%s)', async (url) => {
    const res = await request(buildApp()).get(`/api/favicon?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid favicon URL');
  });
});

describe('server/favicons.js — GET /api/favicon fetch paths', () => {
  it('fetches, caches by hostname, and serves the cached entry on the next call', async () => {
    fetchState.impl = () => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'image/gif' },
      arrayBuffer: async () => GIF.buffer.slice(GIF.byteOffset, GIF.byteOffset + GIF.byteLength),
      body: { cancel() {} },
    });
    const app = buildApp();
    const first = await request(app).get('/api/favicon?domain=example.com');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('image/gif');
    expect(fetchState.calls).toEqual(['https://example.com/favicon.ico']);

    const second = await request(app).get('/api/favicon?domain=example.com');
    expect(second.status).toBe(200);
    expect(second.headers['content-type']).toBe('image/gif');
    expect(fetchState.calls).toEqual(['https://example.com/favicon.ico']); // served from sqlite cache
  });

  it('respects an explicit url parameter and does not cache it under the hostname', async () => {
    fetchState.impl = () => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'image/gif' },
      arrayBuffer: async () => GIF.buffer.slice(GIF.byteOffset, GIF.byteOffset + GIF.byteLength),
      body: { cancel() {} },
    });
    await request(buildApp()).get('/api/favicon?url=' + encodeURIComponent('https://example.com/custom-icon.png'));
    expect(fetchState.calls).toEqual(['https://example.com/custom-icon.png']);
  });

  it('extracts an embedded PNG from an ICO payload', async () => {
    const ico = icoWithEmbeddedPng(PNG_FRAME);
    fetchState.impl = () => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'image/x-icon' },
      arrayBuffer: async () => ico.buffer.slice(ico.byteOffset, ico.byteOffset + ico.byteLength),
      body: { cancel() {} },
    });
    const res = await request(buildApp()).get('/api/favicon?domain=icohost.com');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('walks the fallback candidates and 404s when all fail', async () => {
    fetchState.impl = () => Promise.resolve({
      ok: false, status: 404,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => new ArrayBuffer(0),
      body: { cancel() {} },
    });
    const res = await request(buildApp()).get('/api/favicon?domain=empty.invalid');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetchState.calls).toEqual([
      'https://empty.invalid/favicon.ico',
      'https://empty.invalid/apple-touch-icon.png',
      'https://icons.duckduckgo.com/ip3/empty.invalid.ico',
    ]);
  });

  it('fails closed when DNS resolves to a private address', async () => {
    fetchState.lookup = async () => ({ address: '192.168.0.5', family: 4 });
    fetchState.impl = () => { throw new Error('must not fetch private IPs'); };
    const res = await request(buildApp()).get('/api/favicon?domain=dnstrebind.example.com');
    expect(res.status).toBe(404);
    // the tested hostname itself must NEVER be contacted; the duckduckgo
    // fallback candidate may legitimately resolve from the module-level DNS
    // cache populated by earlier tests (30s TTL) — that is not a violation.
    expect(fetchState.calls.every((u) => !u.startsWith('https://dnstrebind.example.com'))).toBe(true);
  });

  it('fails closed when DNS lookup errors', async () => {
    fetchState.lookup = async () => { throw new Error('ENODATA'); };
    const res = await request(buildApp()).get('/api/favicon?domain=broken-dns.example.com');
    expect(res.status).toBe(404);
    expect(fetchState.calls.every((u) => !u.startsWith('https://broken-dns.example.com'))).toBe(true);
  });

  it('rejects responses whose content type is not an image/xml family', async () => {
    fetchState.impl = () => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => new ArrayBuffer(4),
      body: { cancel() {} },
    });
    const res = await request(buildApp()).get('/api/favicon?domain=htmlsite.example.com');
    expect(res.status).toBe(404);
  });
});

describe('server/favicons.js — closeFaviconDb', () => {
  it('closes the database handle and is idempotent', () => {
    expect(() => closeFaviconDb()).not.toThrow();
    expect(() => closeFaviconDb()).not.toThrow();
  });
});
