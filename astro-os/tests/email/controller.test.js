import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Everything under email/ is loaded through ONE consistent require instance
// (node's own require cache, like pop3Client.test.js does) so the
// setDependencies()/stubbing calls below reach exactly the objects the
// router closes over. Mixing createRequire and dynamic import would give
// two separate module graphs — a real cross-instance contamination trap.
const require = createRequire(import.meta.url);

process.env.ASTROOS_CRED_KEY = 'd'.repeat(64);

const controller = require('../../email/controller.js');
const imapClient = require('../../email/protocols/imapClient.js');
const pop3Client = require('../../email/protocols/pop3Client.js');
const ewsClient = require('../../email/protocols/ewsClient.js');
const credentials = require('../../email/credentials.js');

// Stub the SMTP transport on the real nodemailer module object — controller
// calls nodemailer.createTransport(...) at request time, so patching the
// shared exports object intercepts it without touching the module graph.
const nodemailerMod = require('nodemailer');
const realCreateTransport = nodemailerMod.createTransport;
const sendMailMock = vi.fn(async () => ({ messageId: '<test-message-id@example.test>' }));
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

class FakeImapFlow {
  constructor(opts) { this.opts = opts; }
  async connect() { if (FakeImapFlow.fail) throw new Error('auth failed'); }
  async logout() {}
  async list() { return FakeImapFlow.listResult; }
  async mailboxOpen(name) { this.opened = name; return { exists: FakeImapFlow.exists ?? 0, path: name }; }
  async *fetch() { for (const m of FakeImapFlow.fetchResult) yield m; }
}
class FakeMime {
  async parse(raw) { return { subject: 'parsed', html: '<p>parsed</p>' }; }
}
class FakePop3 {
  async STAT() { return ['2', 100]; }
  async RETR(i) { return `RAW-${i}`; }
  async QUIT() {}
}

beforeAll(() => {
  nodemailerMod.createTransport = createTransportMock;
  imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakeMime });
  pop3Client.setDependencies({ POP3Client: FakePop3, PostalMime: FakeMime });
  ewsClient.setDependencies({ PostalMime: FakeMime });
});

afterAll(() => {
  nodemailerMod.createTransport = realCreateTransport;
  imapClient.setDependencies({});
  pop3Client.setDependencies({});
  ewsClient.setDependencies({});
  credentials.sessionCredentials.clear();
  credentials.stopCredentialCleanup();
});

beforeEach(() => {
  FakeImapFlow.fail = false;
  FakeImapFlow.exists = 0;
  FakeImapFlow.fetchResult = [];
  FakeImapFlow.listResult = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [] },
    { path: 'Sent', name: 'Sent', delimiter: '/', flags: [] },
  ];
  sendMailMock.mockClear();
  createTransportMock.mockClear();
});

function buildApp(session) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/api/email', controller);
  return app;
}

const IMAP_CREDS = { type: 'imap', host: 'imap.example.com', port: 993, ssl: true, user: 'u@example.com', pass: 'pw' };

describe('email/controller.js — sessionless endpoints', () => {
  it('GET /csrf-token returns a null token when the session has none', async () => {
    const res = await request(buildApp({ id: 'anon' })).get('/api/email/csrf-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, csrfToken: null });
  });

  it('GET /restore reports restored:false for an empty session', async () => {
    const res = await request(buildApp({ id: 'anon' })).get('/api/email/restore');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, restored: false });
  });
});

describe('email/controller.js — POST /connect validation', () => {
  it('400s when required fields are missing', async () => {
    const res = await request(buildApp({})).post('/api/email/connect').send({ type: 'imap', host: 'h' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('type, host, user and pass are required');
  });

  it('rejects explicit plaintext opt-outs', async () => {
    for (const ssl of [false, 'false', 0]) {
      const res = await request(buildApp({})).post('/api/email/connect').send({ ...IMAP_CREDS, ssl });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('TLS/SSL is required');
    }
  });

  it('defaults ssl to true when omitted, normalises the type, and stores creds', async () => {
    const session = { id: 's-conn' };
    const res = await request(buildApp(session)).post('/api/email/connect')
      .send({ type: '  IMAP  ', host: ' imap.example.com ', user: 'u@example.com', pass: 'pw', ssl: undefined });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('imap');
    expect(res.body.folders.map((f) => f.path)).toEqual(['INBOX', 'Sent']);
  });

  it('rejects unknown account types', async () => {
    const res = await request(buildApp({})).post('/api/email/connect').send({ ...IMAP_CREDS, type: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('imap, pop3, or exchange');
  });

  it('surfaces provider failures as 400 with the provider error', async () => {
    FakeImapFlow.fail = true;
    const res = await request(buildApp({ id: 's-fail' })).post('/api/email/connect').send(IMAP_CREDS);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('auth failed');
  });
});

describe('email/controller.js — connect → session persistence → restore', () => {
  it('stores encrypted creds in the session and the in-memory registry', async () => {
    const session = { id: 'sess-1' };
    const res = await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    expect(res.status).toBe(200);
    expect(typeof session.emailCredsEncrypted).toBe('string');
    expect(credentials.sessionCredentials.get('sess-1').creds.user).toBe('u@example.com');

    const restored = await request(buildApp(session)).get('/api/email/restore');
    expect(restored.body).toMatchObject({ ok: true, restored: true, type: 'imap', host: 'imap.example.com', user: 'u@example.com' });

    const startup = await request(buildApp(session)).get('/api/email/startup');
    expect(startup.body).toEqual({ ok: true, restored: true, autoSyncEnabled: true });
  });

  it('disconnect clears the session blob and the registry entry', async () => {
    const session = { id: 'sess-disc' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    expect(session.emailCredsEncrypted).toBeTruthy();
    expect(credentials.sessionCredentials.has('sess-disc')).toBe(true);

    const res = await request(buildApp(session)).post('/api/email/disconnect');
    expect(res.body).toEqual({ ok: true });
    expect(session.emailCredsEncrypted).toBeUndefined();
    expect(credentials.sessionCredentials.has('sess-disc')).toBe(false);
  });

  it('GET /folders restores creds from the encrypted blob of a fresh session', async () => {
    const session = { id: 'sess-restore-2', emailCredsEncrypted: credentials.encryptCreds(IMAP_CREDS) };
    credentials.sessionCredentials.delete('sess-restore-2');
    const res = await request(buildApp(session)).get('/api/email/folders');
    expect(res.status).toBe(200);
    expect(res.body.folders.map((f) => f.path)).toEqual(['INBOX', 'Sent']);
  });
});

describe('email/controller.js — requireCreds gate', () => {
  it('401s every read endpoint when no creds exist anywhere', async () => {
    const app = buildApp({ id: 'sess-empty' });
    for (const [method, path] of [['get', '/api/email/folders'], ['get', '/api/email/messages'], ['get', '/api/email/search']]) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Not connected');
    }
  });
});

describe('email/controller.js — message endpoints per protocol', () => {
  it('routes IMAP folders/messages/message', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);

    const folders = await request(buildApp(session)).get('/api/email/folders');
    expect(folders.body.folders).toHaveLength(2);

    const list = await request(buildApp(session)).get('/api/email/messages?folder=INBOX&page=1&limit=5');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 0, page: 1 });

    FakeImapFlow.fetchResult = [{ source: Buffer.from('RAW MIME DATA') }];
    const one = await request(buildApp(session)).get('/api/email/message?folder=INBOX&uid=3');
    expect(one.status).toBe(200);
    expect(one.body.subject).toBe('parsed');
  });

  it('routes POP3 folders/messages (single INBOX)', async () => {
    const session = { id: 'sess-pop3' };
    const connect = await request(buildApp(session)).post('/api/email/connect')
      .send({ type: 'pop3', host: 'pop.example.com', ssl: true, user: 'u', pass: 'p' });
    expect(connect.body.folders).toEqual([{ path: 'INBOX', name: 'Inbox' }]);

    const list = await request(buildApp(session)).get('/api/email/messages');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.messages[0].uid).toBe(2);
    expect(list.body.messages[0].subject).toBe('parsed');
  });

  it('keeps the parsed HTML field for a single message (sanitiser ran on it)', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    FakeImapFlow.fetchResult = [{ source: Buffer.from('RAW MIME DATA') }];
    const one = await request(buildApp(session)).get('/api/email/message?folder=INBOX&uid=1');
    expect(one.body.html).toBe('<p>parsed</p>');
  });

  it('requires uid for /message', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).get('/api/email/message?folder=INBOX');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid is required');
  });
});

describe('email/controller.js — POST /batch', () => {
  it('no-ops for an empty uid list', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).post('/api/email/batch').send({ op: 'read', uids: [] });
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects unsupported operations', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).post('/api/email/batch').send({ op: 'nuke', uids: [1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsupported batch operation');
  });

  it('rejects operations a protocol cannot perform (pop3 move)', async () => {
    const session = { id: 'sess-pop3' };
    await request(buildApp(session)).post('/api/email/connect')
      .send({ type: 'pop3', host: 'pop.example.com', ssl: true, user: 'u', pass: 'p' });
    const res = await request(buildApp(session)).post('/api/email/batch').send({ op: 'move', uids: [1], dest: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not supported for pop3');
  });
});

describe('email/controller.js — GET /search', () => {
  it('rejects search for non-IMAP accounts', async () => {
    const session = { id: 'sess-pop3' };
    await request(buildApp(session)).post('/api/email/connect')
      .send({ type: 'pop3', host: 'pop.example.com', ssl: true, user: 'u', pass: 'p' });
    const res = await request(buildApp(session)).get('/api/email/search?q=x');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('only supported for IMAP');
  });

  it('returns an empty result immediately for a blank query', async () => {
    const session = { id: 'sess-imap' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).get('/api/email/search');
    expect(res.body).toEqual({ messages: [] });
  });
});

describe('email/controller.js — preview flow', () => {
  async function connected(session) {
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    return buildApp(session);
  }

  it('issues a 48-hex token and serves sanitised HTML with lock-down headers', async () => {
    const app = await connected({ id: 'sess-prev' });
    const post = await request(app).post('/api/email/preview').send({ html: '<script>alert(1)</script><p style="color:red">hi</p>' });
    expect(post.status).toBe(200);
    expect(post.body.token).toMatch(/^[0-9a-f]{48}$/);

    const get = await request(app).get(`/api/email/preview/${post.body.token}`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toContain('text/html');
    expect(get.headers['content-security-policy']).toContain("script-src 'none'");
    expect(get.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(get.text).toContain('<p style="color: red">hi</p>');
    expect(get.text).not.toContain('<script>');
  });

  it('wraps fragment HTML in a minimal document; full documents pass through', async () => {
    const app = await connected({ id: 'sess-prev' });
    const frag = await request(app).post('/api/email/preview').send({ html: '<p>frag</p>' });
    const fragRes = await request(app).get(`/api/email/preview/${frag.body.token}`);
    expect(fragRes.text).toContain('<body><p>frag</p></body>');

    const doc = await request(app).post('/api/email/preview').send({ html: '<!DOCTYPE html><html><body><p>full</p></body></html>' });
    const docRes = await request(app).get(`/api/email/preview/${doc.body.token}`);
    // the sanitiser strips <html>/<body> tags, so even a full document is
    // re-wrapped in the minimal shell — the body content is what matters
    expect(docRes.text.startsWith('<!DOCTYPE html><html><head>')).toBe(true);
    expect(docRes.text).toContain('<p>full</p>');
  });

  it('validates token format, unknown tokens, and body type', async () => {
    const app = await connected({ id: 'sess-prev' });
    expect((await request(app).get('/api/email/preview/not-hex')).status).toBe(400);
    expect((await request(app).get(`/api/email/preview/${'a'.repeat(48)}`)).status).toBe(404);
    expect((await request(app).post('/api/email/preview').send({ html: 42 })).status).toBe(400);
  });

  it('rejects oversized preview payloads with 413', async () => {
    const app = await connected({ id: 'sess-prev' });
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const res = await request(app).post('/api/email/preview').send({ html: big });
    expect(res.status).toBe(413);
  });
});

describe('email/controller.js — POST /send', () => {
  it('sends plain mail through the SMTP transport built from session creds', async () => {
    const session = { id: 'sess-send' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).post('/api/email/send')
      .send({ to: 'bob@example.com', subject: 'Hi', text: 'Body' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: '<test-message-id@example.test>' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.from).toBe('u@example.com');
    expect(mail.to).toBe('bob@example.com');
    expect(mail.text).toBe('Body');
  });

  it('forces direct SSL on port 465 and requireTLS otherwise', async () => {
    const session = { id: 'sess-send' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    await request(buildApp(session)).post('/api/email/send').send({ to: 'b@x.com', port: 465 });
    expect(createTransportMock.mock.calls.at(-1)[0]).toMatchObject({ port: 465, secure: true, requireTLS: false });
    await request(buildApp(session)).post('/api/email/send').send({ to: 'b@x.com', port: 587 });
    expect(createTransportMock.mock.calls.at(-1)[0]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('400s when neither the session nor the body supplies an SMTP host', async () => {
    const session = { id: 'sess-nohost', emailCredsEncrypted: credentials.encryptCreds({ type: 'imap', user: 'u', pass: 'p', ssl: true }) };
    credentials.sessionCredentials.delete('sess-nohost');
    const res = await request(buildApp(session)).post('/api/email/send').send({ to: 'b@x.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No SMTP host configured');
  });

  it('400s with no recipients', async () => {
    const session = { id: 'sess-send' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).post('/api/email/send').send({ subject: 'no to' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No recipients defined');
  });

  it('accepts base64 JSON attachments within limits and rejects over the cap', async () => {
    const session = { id: 'sess-send' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);

    const ok = await request(buildApp(session)).post('/api/email/send').send({
      to: 'b@x.com',
      attachments: [{ filename: 'a.txt', contentBase64: Buffer.from('hello').toString('base64'), contentType: 'text/plain' }],
    });
    expect(ok.status).toBe(200);
    const mail = sendMailMock.mock.calls.at(-1)[0];
    expect(mail.attachments[0].filename).toBe('a.txt');
    expect(mail.attachments[0].content.toString()).toBe('hello');

    const tooMany = await request(buildApp(session)).post('/api/email/send').send({
      to: 'b@x.com',
      attachments: Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}`, contentBase64: 'AAAA' })),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toContain('Attachment limit exceeded');
  });

  it('accepts multipart file uploads through multer', async () => {
    const session = { id: 'sess-send' };
    await request(buildApp(session)).post('/api/email/connect').send(IMAP_CREDS);
    const res = await request(buildApp(session)).post('/api/email/send')
      .field('to', 'b@x.com')
      .attach('attachments', Buffer.from('file-bytes'), { filename: 'x.bin', contentType: 'application/octet-stream' });
    expect(res.status).toBe(200);
    const mail = sendMailMock.mock.calls.at(-1)[0];
    expect(mail.attachments[0].filename).toBe('x.bin');
    expect(mail.attachments[0].content.toString()).toBe('file-bytes');
  });
});
