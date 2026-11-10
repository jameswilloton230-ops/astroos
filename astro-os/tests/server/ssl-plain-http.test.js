import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

// Real configureSSL (ssl.test.js mocks it for the bootstrap tests) + real
// certs from the shared openssl seeder, so the plaintext-into-TLS-port
// behavior is exercised against an actual https.Server, not a mock.
import { configureSSL, isPlainHttpRequestToTlsPort, respondPlainHttpOverRawSocket } from '../../server/core/ssl.js';
import { seedCerts } from './helpers/seed-certs.js';

describe('server/core/ssl.js — plain HTTP request on the HTTPS port', () => {
  let dataDir;
  let server;
  let baseUrl;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function boot() {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astroos-ssl-plain-http-'));
    await seedCerts(dataDir);
    process.env.ASTROOS_DATA_DIR = dataDir;
    ({ server } = configureSSL((req, res) => res.end('ok-https')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `127.0.0.1:${port}`;
  }

  function rawRequest(requestLine) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.connect(Number(baseUrl.split(':')[1]), '127.0.0.1');
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out waiting for response')); }, 5000);
      socket.on('data', (c) => chunks.push(c));
      socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('connect', () => {
        socket.end(`${requestLine}\r\nHost: ${baseUrl}\r\nConnection: close\r\n\r\n`);
      });
    });
  }

  it('answers a plaintext HTTP request with an explicit 400 instead of an empty response', async () => {
    await boot();
    const raw = await rawRequest('GET /api/apps/serve/sandbox_com.example.myapp/callback.html?code=abc HTTP/1.1');
    expect(raw.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('HTTPS required');
    expect(raw).toContain('https://localhost:3003');
  });

  it('keeps Node\'s silent destroy for TLS handshake failures that are not plaintext HTTP', async () => {
    await boot();
    // Garbage that is neither a TLS record nor an HTTP request line.
    const raw = await rawRequest('ZZZZ-not-tls-not-http ZZZZ');
    expect(raw).toBe('');
  });

  it('serves normal HTTPS traffic unchanged', async () => {
    await boot();
    const body = await new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1',
        port: Number(baseUrl.split(':')[1]),
        path: '/',
        rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body.status).toBe(200);
    expect(body.body).toBe('ok-https');
  });
});

describe('server/core/ssl.js — responder helpers (unit)', () => {
  it('isPlainHttpRequestToTlsPort matches only the plaintext-HTTP-on-TLS condition', () => {
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_HTTP_REQUEST' })).toBe(true);
    expect(isPlainHttpRequestToTlsPort({
      message: 'error:0A00009C:SSL routines::tls_validate_record_header:http req',
    })).toBe(true);
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).toBe(false);
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_CERT_SIGNATURE_FAILURE' })).toBe(false);
    expect(isPlainHttpRequestToTlsPort(null)).toBe(false);
    expect(isPlainHttpRequestToTlsPort(undefined)).toBe(false);
  });

  function fakeSocket() {
    const writes = [];
    return {
      destroyed: false,
      writable: true,
      writes,
      ended: false,
      destroyCalls: 0,
      listeners: {},
      on(event, fn) { (this.listeners[event] ||= []).push(fn); },
      end(payload) { this.ended = true; if (payload) writes.push(payload); },
      destroy() { this.destroyCalls += 1; },
      emitError(err) { (this.listeners.error || []).forEach((fn) => fn(err)); },
    };
  }

  it('respondPlainHttpOverRawSocket writes one well-formed 400 and ends the socket', () => {
    const socket = fakeSocket();
    expect(respondPlainHttpOverRawSocket(socket)).toBe(true);
    expect(socket.ended).toBe(true);
    expect(socket.writes).toHaveLength(1);
    const response = socket.writes[0];
    expect(response.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(response).toContain('Content-Length:');
    expect(response).toContain('Connection: close');
    // Content-Length must match the actual body length — a mismatch here
    // would just trade ERR_EMPTY_RESPONSE for ERR_CONTENT_LENGTH_MISMATCH.
    const body = response.split('\r\n\r\n')[1];
    const declared = Number(response.match(/Content-Length: (\d+)/)[1]);
    expect(declared).toBe(Buffer.byteLength(body));
    // The error listener must be attached before the write (client may RST).
    expect(socket.listeners.error).toBeDefined();
  });

  it('respondPlainHttpOverRawSocket refuses destroyed or non-writable sockets', () => {
    const destroyed = fakeSocket();
    destroyed.destroyed = true;
    expect(respondPlainHttpOverRawSocket(destroyed)).toBe(false);
    expect(destroyed.ended).toBe(false);

    const notWritable = fakeSocket();
    notWritable.writable = false;
    expect(respondPlainHttpOverRawSocket(notWritable)).toBe(false);
    expect(notWritable.ended).toBe(false);

    expect(respondPlainHttpOverRawSocket(null)).toBe(false);
  });
});
