import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';
import { setupPushRoutes } from '../../server/core/push-routes.js';
import securityMiddleware from '../../security/middleware.js';

// Load the bus through CJS require() — the SAME module instance the
// routes' own require('./push-bus') resolves to. A bare ESM import of a
// CJS file gets a second, separate instance under vite-node, and then
// _reset() in tests would clear the wrong copy while the routes keep
// their own state (a real cross-test contamination).
const pushBus = createRequire(import.meta.url)('../../server/core/push-bus.js');

// The push service's trust gate is the same system-app HMAC the rest of
// the /api/ surface uses — sign requests exactly like the OS host's
// system-fetch wrapper does. Raw HTTP goes through a tiny node:http
// helper because test/setup.js replaces globalThis.fetch with a stub.
const SECRET = 'test-push-secret';
const DEVICE = 'device-0123456789abcdef';
const APP_ID = 'com.push.app';

function trustedHeaders(path = '/api/push/subscribe') {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}\n${path}`)
    .digest('hex');
  return {
    'x-nova-system-app': path,
    'x-nova-system-time': timestamp,
    'x-nova-system-signature': signature,
  };
}

const TOKEN = 'nps_' + crypto.randomBytes(16).toString('hex');
const TOKEN2 = 'nps_' + crypto.randomBytes(16).toString('hex');
const TOKEN3 = 'nps_' + crypto.randomBytes(16).toString('hex');

function makeApp() {
  const app = express();
  app.use(express.json());
  setupPushRoutes(app);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Minimal node:http JSON request: resolves { status, body }.
function httpJson(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { /* SSE or empty */ }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Opens the device stream on a live server and returns a frame reader.
function openStream(server, deviceId = DEVICE) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        path: `/api/push/stream?deviceId=${deviceId}`,
        headers: trustedHeaders('/api/push/stream'),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('stream rejected with ' + res.statusCode));
        }
        res.setEncoding('utf8');
        let buffer = '';
        const frames = [];
        res.on('data', (chunk) => {
          buffer += chunk;
          let sep;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) frames.push(JSON.parse(line.slice(6)));
          }
        });
        resolve({
          frames,
          nextFrame(timeoutMs = 2000) {
            const started = Date.now();
            return new Promise((res2, rej2) => {
              const poll = () => {
                if (frames.length) return res2(frames.shift());
                if (Date.now() - started > timeoutMs) return res2(null);
                setTimeout(poll, 20);
              };
              poll();
              setTimeout(() => res2(null), timeoutMs + 100);
              req.on('error', rej2);
            });
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('push service — bus', () => {
  beforeEach(() => {
    process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
    pushBus._reset();
  });
  afterEach(() => {
    delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    pushBus._reset();
  });

  it('subscribe maps valid { token, appId } entries and drops malformed ones', () => {
    const n = pushBus.subscribe(DEVICE, [
      { token: TOKEN, appId: APP_ID },
      { token: 'not-a-token', appId: APP_ID },
      { token: TOKEN2, appId: 'not an app id!' },
      42,
    ]);
    expect(n).toBe(1);
  });

  it('re-subscribing prunes the device\u2019s previous token set', () => {
    pushBus.subscribe(DEVICE, [{ token: TOKEN, appId: APP_ID }]);
    expect(pushBus.publish(TOKEN, { data: {} }).reason).toBe('device-offline');
    pushBus.subscribe(DEVICE, [{ token: TOKEN2, appId: APP_ID }]); // full replacement, not a merge
    expect(pushBus.publish(TOKEN, { data: {} }).reason).toBe('unknown-token');
    expect(pushBus.publish(TOKEN2, { data: {} }).reason).toBe('device-offline');
  });

  it('publish derives appId from the trusted mapping and writes an SSE frame', () => {
    pushBus.subscribe(DEVICE, [{ token: TOKEN, appId: APP_ID }]);
    const frames = [];
    const detach = pushBus.attachStream(DEVICE, { write: (frame) => frames.push(frame) });
    const result = pushBus.publish(TOKEN, { title: 'Hello', data: { n: 1 } });
    expect(result.delivered).toBe(true);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0].replace(/^data: /, '').trim());
    expect(parsed).toMatchObject({ appId: APP_ID, title: 'Hello', data: { n: 1 } });
    expect(typeof parsed.sentAt).toBe('string');
    detach();
  });

  it('backlog replays exactly once on the next drain', () => {
    pushBus.subscribe(DEVICE, [{ token: TOKEN, appId: APP_ID }]);
    pushBus.publish(TOKEN, { id: 'm1', data: { seq: 1 } });
    pushBus.publish(TOKEN, { id: 'm2', data: { seq: 2 } });
    const frames = [];
    const sent = pushBus.drainForDevice(DEVICE, (frame) => frames.push(frame));
    expect(sent).toBe(2);
    expect(JSON.parse(frames[0].replace(/^data: /, '').trim()).id).toBe('m1');
    // Drained — a second drain sends nothing (at-most-once per entry).
    expect(pushBus.drainForDevice(DEVICE, () => {})).toBe(0);
  });
});

describe('push service — routes', () => {
  let app, server;

  beforeEach(() => {
    process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
    pushBus._reset();
    app = makeApp();
  });
  afterEach(async () => {
    delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    pushBus._reset();
    if (server) await new Promise((r) => server.close(r));
    server = null;
  });

  it('subscribe and stream require the system trust signature', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).post('/api/push/subscribe').send({ deviceId: DEVICE, subscriptions: [] });
    expect(res.status).toBe(403);
    const resStream = await request(app).get(`/api/push/stream?deviceId=${DEVICE}`);
    expect(resStream.status).toBe(403);
  });

  it('trusted host subscription passes CSRF middleware and maps the token', async () => {
    const securedApp = express();
    securedApp.use(express.json());
    securedApp.use(securityMiddleware.csrfProtection);
    setupPushRoutes(securedApp);
    const request = (await import('supertest')).default;
    const res = await request(securedApp)
      .post('/api/push/subscribe')
      .set(trustedHeaders())
      .send({ deviceId: DEVICE, subscriptions: [{ token: TOKEN, appId: APP_ID }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, subscribed: 1 });
    expect(pushBus.publish(TOKEN, { data: {} }).reason).toBe('device-offline');
  });

  it('subscribe validates deviceId and subscription shape', async () => {
    const request = (await import('supertest')).default;
    const bad = await request(app)
      .post('/api/push/subscribe')
      .set(trustedHeaders())
      .send({ deviceId: 'short', subscriptions: [{ token: TOKEN, appId: APP_ID }] });
    expect(bad.status).toBe(400);
    const badSubs = await request(app)
      .post('/api/push/subscribe')
      .set(trustedHeaders())
      .send({ deviceId: DEVICE, subscriptions: 'not-an-array' });
    expect(badSubs.status).toBe(400);
    const ok = await request(app)
      .post('/api/push/subscribe')
      .set(trustedHeaders())
      .send({ deviceId: DEVICE, subscriptions: [{ token: TOKEN, appId: APP_ID }, { token: 'junk', appId: APP_ID }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, subscribed: 1 });
  });

  it('publish rejects malformed messages before touching the bus', async () => {
    const request = (await import('supertest')).default;
    const cases = [
      [{ token: 'junk' }, 'invalid-token'],
      [{ token: TOKEN, title: 5 }, 'invalid-title'],
      [{ token: TOKEN, body: 'x'.repeat(3000) }, 'invalid-body'],
      [{ token: TOKEN, data: [1, 2] }, 'invalid-data'],
      [{ token: TOKEN, data: { big: 'x'.repeat(5000) } }, 'data-too-large'],
    ];
    for (const [body, reason] of cases) {
      const res = await request(app).post('/api/push/publish').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ delivered: false, reason });
    }
  });

  it('publish to an unmapped token is 404 unknown-token', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).post('/api/push/publish').send({ token: TOKEN3, data: {} });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ delivered: false, reason: 'unknown-token' });
  });

  it('end-to-end: subscribe \u2192 stream \u2192 publish lands as an SSE frame with the mapped appId', async () => {
    server = await listen(app);
    const port = server.address().port;

    const sub = await httpJson(port, 'POST', '/api/push/subscribe', {
      headers: trustedHeaders(),
      body: { deviceId: DEVICE, subscriptions: [{ token: TOKEN, appId: APP_ID }] },
    });
    expect(sub.body.subscribed).toBe(1);

    const stream = await openStream(server);
    const pub = await httpJson(port, 'POST', '/api/push/publish', {
      body: { token: TOKEN, title: 'Hi', body: 'there', data: { n: 7 } },
    });
    expect(pub.status).toBe(200);
    expect(pub.body.delivered).toBe(true);
    const frame = await stream.nextFrame();
    expect(frame).toMatchObject({ appId: APP_ID, title: 'Hi', body: 'there', data: { n: 7 } });
    stream.close();
  });

  it('offline publish is 202 + backlog, replayed on the next connect, once', async () => {
    server = await listen(app);
    const port = server.address().port;

    // Token mapped but no stream attached → device-offline, backlogged.
    const sub = await httpJson(port, 'POST', '/api/push/subscribe', {
      headers: trustedHeaders(),
      body: { deviceId: DEVICE, subscriptions: [{ token: TOKEN, appId: APP_ID }] },
    });
    expect(sub.status).toBe(200);
    const off = await httpJson(port, 'POST', '/api/push/publish', {
      body: { token: TOKEN, id: 'backlog-1', data: { n: 1 } },
    });
    expect(off.status).toBe(202);
    expect(off.body).toEqual({ delivered: false, reason: 'device-offline' });

    // Device reconnects: the drained backlog arrives as a data frame.
    const stream = await openStream(server);
    const frame = await stream.nextFrame();
    expect(frame && frame.id).toBe('backlog-1');
    stream.close();
  });
});
