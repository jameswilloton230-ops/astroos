import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

// users.db resolves its data dir at require time — isolate it.
const dataDir = mkdtempSync(join(tmpdir(), 'nova-auth-routes-'));
process.env.ASTROOS_DATA_DIR = dataDir;
process.env.ASTROOS_CRED_KEY = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(128);

const require = createRequire(import.meta.url);
const usersDb = require('../../server/security/users-db.js');

// Minimal express-session stand-in: a sid-keyed store, cookie issuance on
// session creation, and X-Nova-Session bearer resolution — the two ways the
// real middleware identifies a session. Regeneration happens IN PLACE so
// the route's held reference stays valid (express-session semantics).
function fakeSessionMiddleware(app) {
  const sessions = new Map();
  let counter = 0;
  app.use((req, res, next) => {
    let sid = req.get('x-nova-session') || (req.headers.cookie || '').match(/connect\.sid=([^;]+)/)?.[1];
    if (sid) sid = decodeURIComponent(sid);
    if (!sid || !sessions.has(sid)) {
      counter += 1;
      sid = `sid-${counter}`;
      sessions.set(sid, {});
      res.setHeader('Set-Cookie', `connect.sid=${encodeURIComponent(sid)}; Path=/`);
    }
    const store = sessions.get(sid);
    const attach = (target) => {
      target.save = (cb) => cb && cb();
      target.regenerate = (cb) => {
        counter += 1;
        const fresh = `sid-${counter}`;
        sessions.delete(sid);
        sessions.set(fresh, target);
        sid = fresh;
        req.sessionID = fresh;
        res.setHeader('Set-Cookie', `connect.sid=${encodeURIComponent(fresh)}; Path=/`);
        for (const key of Object.keys(target)) { if (key !== 'save' && key !== 'regenerate' && key !== 'destroy') delete target[key]; }
        cb();
      };
      target.destroy = (cb) => { sessions.delete(sid); cb && cb(); };
      return target;
    };
    attach(store);
    req.sessionID = sid;
    req.session = store;
    next();
  });
}

let app;
let ownerSession; // { token, csrf } from the setup wizard
let helperSession;

beforeAll(() => {
  const { mountRoutes } = require('../../server/routes.js');
  app = express();
  app.use(express.json());
  fakeSessionMiddleware(app);
  mountRoutes(app);
});

afterAll(() => {
  usersDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function authHeaders(sessionInfo) {
  const headers = {};
  if (sessionInfo?.token) headers['X-Nova-Session'] = sessionInfo.token;
  if (sessionInfo?.csrf) headers['X-CSRF-Token'] = sessionInfo.csrf;
  return headers;
}

describe('server/security/auth-routes.js — /api/auth family', () => {
  it('GET /users lists public-safe accounts (empty on a fresh machine)', async () => {
    const res = await request(app).get('/api/auth/users');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.users).toEqual([]);
    expect(res.body.data.policies).toMatchObject({ guestAccess: false, showUsernames: false });
  });

  it('POST /setup creates the owner and establishes a session; a second setup is refused', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      displayName: 'Ada', username: 'ada', pin: '123456', passphrase: 'long-enough-pass',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ username: 'ada', role: 'owner', roleLabel: 'Owner' });
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.data.csrfToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('pin_hash');
    ownerSession = { token: res.body.data.sessionId, csrf: res.body.data.csrfToken };

    const again = await request(app).post('/api/auth/setup').send({ username: 'x', pin: '1234' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_SET_UP');
  });

  it('POST /login verifies the PIN server-side; a bad secret is a normal outcome (200 + code), not an HTTP error', async () => {
    const users = (await request(app).get('/api/auth/users')).body.data.users;
    const owner = users.find(u => u.username === 'ada');

    const bad = await request(app).post('/api/auth/login').send({ uid: owner.uid, secret: '999999' });
    // Credential outcomes ride HTTP 200 with success:false + a machine code —
    // non-2xx statuses make the browser log "Failed to load resource: 401"
    // on the lock screen even when the client handles them, which is the
    // exact console noise this contract removes (see /api/auth/session's
    // authenticated:false precedent).
    expect(bad.status).toBe(200);
    expect(bad.body.success).toBe(false);
    expect(bad.body.code).toBe('BAD_CREDENTIAL');

    const good = await request(app).post('/api/auth/login').send({ uid: owner.uid, secret: '123456' });
    expect(good.status).toBe(200);
    expect(good.body.data.user.username).toBe('ada');
    expect(good.body.data.via).toBe('pin');
    expect(good.body.data.sessionId).not.toBe(ownerSession.token); // regenerated, fresh sid
  });

  it('admin routes demand an admin-role session — anonymous and standard sessions are refused', async () => {
    const anon = await request(app).get('/api/auth/admin/users');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('AUTH_REQUIRED');

    // Create a standard account as the owner, log in, and try the admin family.
    const created = await request(app).post('/api/auth/admin/users')
      .set(authHeaders(ownerSession))
      .send({ username: 'sam', displayName: 'Sam', pin: '4321', role: 'standard' });
    expect(created.status).toBe(200);
    expect(created.body.data.user.role).toBe('standard');

    const login = await request(app).post('/api/auth/login').send({ username: 'sam', secret: '4321' });
    helperSession = { token: login.body.data.sessionId, csrf: login.body.data.csrfToken };
    const asStandard = await request(app).get('/api/auth/admin/users').set(authHeaders(helperSession));
    expect(asStandard.status).toBe(403);
    expect(asStandard.body.code).toBe('ADMIN_REQUIRED');
  });

  it('the picker list never leaks usernames of credential material; admin list carries lifecycle fields', async () => {
    const pub = (await request(app).get('/api/auth/users')).body.data.users;
    for (const user of pub) {
      expect(user).not.toHaveProperty('pin_hash');
      expect(user).not.toHaveProperty('lastLoginAt');
    }
    const admin = (await request(app).get('/api/auth/admin/users').set(authHeaders(ownerSession))).body.data.users;
    expect(admin.some(u => u.username === 'sam')).toBe(true);
    expect(admin.every(u => 'lastLoginAt' in u && 'quotaBytes' in u)).toBe(true);
  });

  it('POST /lock + /reverify: unlock requires the secret again; wrong secret stays locked', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'sam', secret: '4321' });
    const session = { token: login.body.data.sessionId, csrf: login.body.data.csrfToken };

    const lock = await request(app).post('/api/auth/lock').set(authHeaders(session));
    expect(lock.status).toBe(200);

    const wrong = await request(app).post('/api/auth/reverify').set(authHeaders(session)).send({ secret: '0000' });
    expect(wrong.status).toBe(200);
    expect(wrong.body.success).toBe(false);
    expect(wrong.body.code).toBe('BAD_CREDENTIAL');

    const right = await request(app).post('/api/auth/reverify').set(authHeaders(session)).send({ secret: '4321' });
    expect(right.status).toBe(200);
    expect(right.body.data.user.username).toBe('sam');
    expect(right.body.data.csrfToken).toBeTruthy();
  });

  it('suspend + reverify round-trip: a suspended session resumes after re-verification', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'sam', secret: '4321' });
    const session = { token: login.body.data.sessionId, csrf: login.body.data.csrfToken };
    const suspended = await request(app).post('/api/auth/suspend').set(authHeaders(session));
    expect(suspended.status).toBe(200);

    const res = await request(app).post('/api/auth/reverify').set(authHeaders(session)).send({ secret: '4321' });
    expect(res.status).toBe(200);
  });

  it('force-logout revokes a user\u2019s sessions from the express-session store', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'sam', secret: '4321' });
    const users = (await request(app).get('/api/auth/users')).body.data.users;
    const sam = users.find(u => u.username === 'sam');
    const sid = login.body.data.sessionId;

    // The real revoker deletes express-session rows from sessions.db —
    // seed the store the way server/middleware.js owns it and prove the row
    // dies with the account's session map.
    const Database = require('better-sqlite3');
    const sessionDb = new Database(join(dataDir, 'data', 'sessions.db'));
    sessionDb.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER)');
    sessionDb.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)').run(sid, '{}', Date.now() + 3600000);

    const forced = await request(app).post(`/api/auth/admin/users/${sam.uid}/force-logout`).set(authHeaders(ownerSession));
    expect(forced.status).toBe(200);
    expect(forced.body.data.revokedSessions).toBeGreaterThan(0);

    const row = sessionDb.prepare('SELECT sid FROM sessions WHERE sid = ?').get(sid);
    expect(row).toBeUndefined();
    sessionDb.close();
  });

  it('credential reset: temporary PIN authenticates once, forces mustChangePin; change-pin clears it', async () => {
    const users = (await request(app).get('/api/auth/users')).body.data.users;
    const sam = users.find(u => u.username === 'sam');
    const reset = await request(app).post(`/api/auth/admin/users/${sam.uid}/reset-credential`).set(authHeaders(ownerSession));
    expect(reset.status).toBe(200);
    const temporaryPin = reset.body.data.temporaryPin;
    expect(temporaryPin).toMatch(/^\d{6}$/);

    const login = await request(app).post('/api/auth/login').send({ uid: sam.uid, secret: temporaryPin });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePin).toBe(true);
    const session = { token: login.body.data.sessionId, csrf: login.body.data.csrfToken };

    const change = await request(app).post('/api/auth/change-pin').set(authHeaders(session)).send({ newPin: '5678' });
    expect(change.status).toBe(200);
    const relogin = await request(app).post('/api/auth/login').send({ uid: sam.uid, secret: '5678' });
    expect(relogin.body.data.mustChangePin).toBe(false);
  });

  it('a legacy-imported account whose 3.0.2 PIN is not digit-only can still log in', async () => {
    // The auto-detect used to only try the PIN branch for 4–6 digit secrets,
    // so a migrated machine with an alphanumeric lock PIN failed every login
    // with BAD_CREDENTIAL/401 (the secret fell through to the passphrase
    // branch, which legacy imports never have). Any non-empty secret is a
    // PIN candidate for PBKDF2 rows now; the first success re-hashes to scrypt.
    const crypto = require('crypto');
    const secret = 'nova-legacy!';
    const salt = crypto.randomBytes(16).toString('hex');
    const legacyPinHash = crypto
      .pbkdf2Sync(secret, Buffer.from(salt, 'hex'), 100000, 32, 'sha256')
      .toString('hex');

    const created = await request(app).post('/api/auth/admin/users')
      .set(authHeaders(ownerSession))
      .send({ username: 'legacyuser', displayName: 'Legacy User', pin: '1234', role: 'standard' });
    expect(created.status).toBe(200);
    const uid = created.body.data.user.uid;
    // Swap the freshly-scrypt PIN for the 3.0.2 PBKDF2 shape (the state
    // migrate-legacy leaves the account in).
    usersDb.importLegacyPin(uid, legacyPinHash, salt);

    // Wrong secret → normal outcome (200 + code), correct secret → session.
    const wrong = await request(app).post('/api/auth/login').send({ uid, secret: 'not-the-pin' });
    expect(wrong.status).toBe(200);
    expect(wrong.body.code).toBe('BAD_CREDENTIAL');

    const good = await request(app).post('/api/auth/login').send({ uid, secret });
    expect(good.status).toBe(200);
    expect(good.body.success).toBe(true);
    expect(good.body.data.user.username).toBe('legacyuser');
    expect(good.body.data.via).toBe('pin');

    // The successful verification upgraded the account off the legacy KDF.
    const upgraded = usersDb.getUser(uid);
    expect(JSON.parse(upgraded.pin_kdf).alg).toBe('scrypt');
  });

  it('policies: read defaults, write a patch, invalid keys refused', async () => {
    const before = await request(app).get('/api/auth/admin/policies').set(authHeaders(ownerSession));
    expect(before.body.data.policies.guestAccess).toBe(false);
    const write = await request(app).put('/api/auth/admin/policies').set(authHeaders(ownerSession)).send({ guestAccess: true });
    expect(write.status).toBe(200);
    expect(write.body.data.policies.guestAccess).toBe(true);
    const invalid = await request(app).put('/api/auth/admin/policies').set(authHeaders(ownerSession)).send({ nonsense: 1 });
    expect(invalid.status).toBe(400);
  });

  it('events feed + admin role gates are audited', async () => {
    const events = await request(app).get('/api/auth/admin/events?limit=50').set(authHeaders(ownerSession));
    expect(events.status).toBe(200);
    expect(events.body.data.events.some(e => e.action === 'admin.denied' || e.action === 'account.create')).toBe(true);
  });

  it('delete guards over HTTP: owner refused, archive mode for a standard account works', async () => {
    const users = (await request(app).get('/api/auth/admin/users').set(authHeaders(ownerSession))).body.data.users;
    const owner = users.find(u => u.username === 'ada');
    const sam = users.find(u => u.username === 'sam');
    const ownerDelete = await request(app).delete(`/api/auth/admin/users/${owner.uid}`).set(authHeaders(ownerSession)).send({ mode: 'wipe' });
    expect(ownerDelete.status).toBe(403);
    expect(ownerDelete.body.code).toBe('OWNER_PROTECTED');

    const samDelete = await request(app).delete(`/api/auth/admin/users/${sam.uid}`).set(authHeaders(ownerSession)).send({ mode: 'archive' });
    expect(samDelete.status).toBe(200);
    const after = (await request(app).get('/api/auth/users')).body.data.users;
    expect(after.some(u => u.username === 'sam')).toBe(false);
  });

  it('migrate-legacy is refused once accounts exist (idempotence)', async () => {
    const res = await request(app).post('/api/auth/migrate-legacy').send({
      username: 'legacy', legacyPinHash: 'abc', legacyPinSalt: 'def',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_MIGRATED');
  });

  it('logout ends the session; the bearer token no longer authenticates', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'ada', secret: '123456' });
    const session = { token: login.body.data.sessionId, csrf: login.body.data.csrfToken };
    const out = await request(app).post('/api/auth/logout').set(authHeaders(session));
    expect(out.status).toBe(200);
    const probe = await request(app).get('/api/auth/session').set(authHeaders(session));
    expect(probe.body.data.authenticated).toBe(false);
  });
});
