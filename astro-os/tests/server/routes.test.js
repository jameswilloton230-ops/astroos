import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import http from 'node:http';

// One shared require instance for everything (see controller.test.js for why
// mixing createRequire and dynamic import is a cross-instance trap).
const require = createRequire(import.meta.url);

process.env.ASTROOS_CRED_KEY = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(128);

const { mountRoutes } = require('../../server/routes.js');
const ServerEventLog = require('../../server/core/server-event-log.js');

let app;

beforeAll(() => {
  app = express();
  app.use(express.json());
  mountRoutes(app);
});

afterAll(() => {
  ServerEventLog.clear();
});

describe('server/routes.js — mountRoutes', () => {
  it('mounts the email controller under /api/email', async () => {
    const res = await request(app).get('/api/email/csrf-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, csrfToken: null });
  });

  it('mounts the security routes under /api/security', async () => {
    const res = await request(app).get('/api/security/admin-mode');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.adminEnabled).toBe('boolean');
  });

  it('mounts the push routes with their system-trust gate intact', async () => {
    const res = await request(app).post('/api/push/subscribe').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('System trust required');
  });

  it('mounts the events SSE stream (content reaches the client)', async () => {
    ServerEventLog.log({ message: 'routes-mount-proof' });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { headers, body } = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/events/stream' }, (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (c) => { data += c; if (data.includes('routes-mount-proof')) { req.destroy(); resolve({ headers: res.headers, body: data }); } });
        });
        req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
        req.end();
        setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 4000);
      });
      expect(headers['content-type']).toContain('text/event-stream');
      expect(body).toContain('routes-mount-proof');
    } finally {
      server.close();
    }
  });

  it('email connect still validates after mounting (router is live, not a stub)', async () => {
    const res = await request(app).post('/api/email/connect').send({ type: 'imap' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('type, host, user and pass are required');
  });
});
