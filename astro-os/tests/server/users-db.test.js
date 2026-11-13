import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// users.db resolves its data directory at require time — point it at a
// throwaway temp dir BEFORE the module loads.
const dataDir = mkdtempSync(join(tmpdir(), 'nova-users-db-'));
process.env.ASTROOS_DATA_DIR = dataDir;

const require = createRequire(import.meta.url);
const usersDb = require('../../server/security/users-db.js');

function expectCode(fn, code) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown && thrown.code).toBe(code);
}

afterAll(() => {
  usersDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  usersDb.wipeAll(null);
});

describe('users.db — account database (multi-user core)', () => {
  it('starts empty and reports no accounts', () => {
    expect(usersDb.hasAccounts()).toBe(false);
    expect(usersDb.userCount()).toBe(0);
    expect(usersDb.listPublicUsers()).toEqual([]);
  });

  it('creates the owner exactly once — second createOwner is refused', () => {
    const owner = usersDb.createOwner({ displayName: 'Ada', username: 'ada', pin: '123456' });
    expect(owner.username).toBe('ada');
    expect(owner.role).toBe('owner');
    expect(usersDb.hasAccounts()).toBe(true);
    expectCode(() => usersDb.createOwner({ displayName: 'X', username: 'xxx', pin: '1234' }), 'OWNER_EXISTS');
  });

  it('hashes with scrypt: the stored row never carries the plaintext', () => {
    const owner = usersDb.createOwner({ displayName: 'Ada', username: 'ada', pin: '4321' });
    const row = usersDb.getUser(owner.uid);
    expect(row.pin_hash).not.toContain('4321');
    expect(JSON.parse(row.pin_kdf).alg).toBe('scrypt');
    expect(usersDb.toPublicUser(row)).not.toHaveProperty('pin_hash');
    expect(usersDb.toPublicUser(row)).not.toHaveProperty('pin_salt');
  });

  it('verifies the PIN and the passphrase; a wrong secret fails closed', () => {
    const owner = usersDb.createOwner({
      displayName: 'Ada', username: 'ada', pin: '1234', passphrase: 'correct horse battery staple',
    });
    expect(usersDb.verifyCredential(owner.uid, '1234').ok).toBe(true);
    expect(usersDb.verifyCredential(owner.uid, 'correct horse battery staple').ok).toBe(true);
    expect(usersDb.verifyCredential(owner.uid, '9999').ok).toBe(false);
    expect(usersDb.verifyCredential(owner.uid, '').ok).toBe(false);
  });

  it('imports the legacy 3.0.2 PBKDF2 hash and verifies it; upgrade path stays valid', () => {
    const legacyHash = usersDb._test.pbkdf2Hex('1111', 'legacy-salt-hex', usersDb._test.LEGACY_PBKDF2_PARAMS);
    const owner = usersDb.importLegacyOwner({
      username: 'legacy', displayName: 'Legacy', legacyPinHash: legacyHash,
      legacyPinSalt: 'legacy-salt-hex', pinLen: 4, adminEnabled: true,
    });
    expect(owner.role).toBe('owner');
    const result = usersDb.verifyCredential(owner.uid, '1111');
    expect(result.ok).toBe(true);
    // The legacy row upgrades to scrypt after the first successful verify.
    expect(JSON.parse(usersDb.getUser(owner.uid).pin_kdf).alg).toBe('scrypt');
    // And it still verifies afterwards.
    expect(usersDb.verifyCredential(owner.uid, '1111').ok).toBe(true);
  });

  it('per-account lockout ladder: warn → short → extended → hard lock', () => {
    const owner = usersDb.createOwner({ displayName: 'A', username: 'ada', pin: '1234' });
    const attempts = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(usersDb.verifyCredential(owner.uid, '0000'));
    }
    // 1-2: plain denial; 3-5: short window; 6-9: extended; 10: hard lock.
    expect(attempts[0].code).toBe('BAD_CREDENTIAL');
    expect(attempts[2].code).toBe('LOCKOUT');
    expect(attempts[2].retryAfterMs).toBeGreaterThan(0);
    expect(attempts[5].retryAfterMs).toBeGreaterThan(attempts[2].retryAfterMs);
    expect(attempts[9].code).toBe('ACCOUNT_LOCKED');
    // Locked account: even the correct PIN is refused until an admin unlocks.
    expect(usersDb.verifyCredential(owner.uid, '1234').code).toBe('ACCOUNT_LOCKED');
    usersDb.setLocked(owner.uid, false, null);
    expect(usersDb.verifyCredential(owner.uid, '1234').ok).toBe(true);
  });

  it('a successful login resets the lockout counters', () => {
    const owner = usersDb.createOwner({ displayName: 'A', username: 'ada', pin: '1234' });
    usersDb.verifyCredential(owner.uid, '0000');
    usersDb.verifyCredential(owner.uid, '0000');
    expect(usersDb.verifyCredential(owner.uid, '1234').ok).toBe(true);
    expect(usersDb.verifyCredential(owner.uid, '0000').code).toBe('BAD_CREDENTIAL'); // counter restarted
  });

  it('lifecycle guards: owner undeletable, last active admin protected, transactional role checks', () => {
    const owner = usersDb.createOwner({ displayName: 'O', username: 'owner', pin: '1234' });
    const admin = usersDb.createUser({ displayName: 'B', username: 'boss', pin: '1234', role: 'admin' }, owner.uid);
    const standard = usersDb.createUser({ displayName: 'S', username: 'sam', pin: '1234', role: 'standard' }, owner.uid);

    expectCode(() => usersDb.deleteUser(owner.uid, 'wipe', owner.uid), 'OWNER_PROTECTED');
    expectCode(() => usersDb.updateUser(owner.uid, { role: 'standard' }, owner.uid), 'OWNER_PROTECTED');
    // With another admin alive, demotion and deletion are allowed.
    const admin2 = usersDb.createUser({ displayName: 'B2', username: 'boss2', pin: '1234', role: 'admin' }, owner.uid);
    expect(usersDb.updateUser(admin.uid, { role: 'standard' }, owner.uid).role).toBe('standard');
    expect(usersDb.deleteUser(admin2.uid, 'archive', owner.uid).mode).toBe('archive');
    // Last-active-admin protection: with the owner disabled, one active
    // admin left cannot be demoted, deleted or disabled.
    const admin3 = usersDb.createUser({ displayName: 'B3', username: 'boss3', pin: '1234', role: 'admin' }, owner.uid);
    expect(usersDb.setStatus(owner.uid, 'disabled', owner.uid).status).toBe('disabled');
    expectCode(() => usersDb.updateUser(admin3.uid, { role: 'standard' }, owner.uid), 'LAST_ADMIN');
    expectCode(() => usersDb.deleteUser(admin3.uid, 'wipe', owner.uid), 'LAST_ADMIN');
    expectCode(() => usersDb.setStatus(admin3.uid, 'disabled', owner.uid), 'LAST_ADMIN');
    usersDb.setStatus(owner.uid, 'active', owner.uid);
    // Standard accounts delete freely.
    expect(usersDb.deleteUser(standard.uid, 'wipe', owner.uid).uid).toBe(standard.uid);
  });

  it('disabling revokes sessions and blocks login; enabling restores it', () => {
    const owner = usersDb.createOwner({ displayName: 'O', username: 'ova', pin: '1234' });
    const user = usersDb.createUser({ displayName: 'S', username: 'sam', pin: '1234', role: 'standard' }, owner.uid);
    usersDb.registerSessionSid('sid-1', user.uid);
    usersDb.setSessionRevoker((sids) => { revoked.push(...sids); });
    const revoked = [];
    usersDb.setStatus(user.uid, 'disabled', owner.uid);
    expect(revoked).toContain('sid-1');
    expect(usersDb.verifyCredential(user.uid, '1234').code).toBe('ACCOUNT_DISABLED');
    usersDb.setStatus(user.uid, 'active', owner.uid);
    expect(usersDb.verifyCredential(user.uid, '1234').ok).toBe(true);
  });

  it('admin credential reset issues a temporary PIN shown once and forces a change', () => {
    const owner = usersDb.createOwner({ displayName: 'O', username: 'ova', pin: '1234' });
    const user = usersDb.createUser({ displayName: 'S', username: 'sam', pin: '1234', role: 'standard' }, owner.uid);
    const reset = usersDb.resetCredential(user.uid, owner.uid);
    expect(reset.temporaryPin).toMatch(/^\d{6}$/);
    expect(usersDb.getUser(user.uid).must_change_pin).toBe(1);
    // The temporary PIN authenticates (landing on the forced new-PIN sheet)…
    const viaTemp = usersDb.verifyCredential(user.uid, reset.temporaryPin);
    expect(viaTemp.ok).toBe(true);
    expect(viaTemp.mustChangePin).toBe(true);
    // …and a credential change clears the forced flag.
    usersDb.setCredential(user.uid, 'pin', '5678');
    expect(usersDb.getUser(user.uid).must_change_pin).toBe(0);
    expect(usersDb.verifyCredential(user.uid, '5678').ok).toBe(true);
  });

  it('public projections never leak credential material', () => {
    const owner = usersDb.createOwner({ displayName: 'O', username: 'ova', pin: '1234' });
    const pub = usersDb.listPublicUsers()[0];
    expect(pub).toMatchObject({ username: 'ova', role: 'owner', roleLabel: 'Owner', status: 'active' });
    const json = JSON.stringify(pub);
    expect(json).not.toContain('pin_hash');
    expect(json).not.toContain('hash');
    expect(json).not.toContain('salt');
  });

  it('user_events: login failures and lifecycle actions are recorded, filterable and exportable', () => {
    const owner = usersDb.createOwner({ displayName: 'O', username: 'ova', pin: '1234' });
    const user = usersDb.createUser({ displayName: 'S', username: 'sam', pin: '1234', role: 'standard' }, owner.uid);
    usersDb.verifyCredential(user.uid, '0000');
    usersDb.setStatus(user.uid, 'disabled', owner.uid);
    const all = usersDb.queryEvents({ limit: 100 });
    expect(all.events.length).toBeGreaterThan(3);
    expect(all.events.some(e => e.action === 'auth.failure')).toBe(true);
    expect(all.events.some(e => e.action === 'account.disable')).toBe(true);
    const forUser = usersDb.queryEvents({ uid: user.uid });
    expect(forUser.events.every(e => e.actorUid === user.uid)).toBe(true);
    const csv = usersDb.eventsToCsv({});
    expect(csv.split('\n')[0]).toBe('ts,actor,action,target,severity,detail,ip');
    expect(csv).toContain('auth.failure');
  });

  it('machine policies default, persist and validate keys', () => {
    const base = usersDb.getPolicyBlock();
    expect(base.guestAccess).toBe(false);
    expect(base.closeAppsOnSwitch).toBe(true);
    const next = usersDb.setPolicies({ guestAccess: true, showUsernamesOnPicker: true });
    expect(next.guestAccess).toBe(true);
    expect(() => usersDb.setPolicies({ nonsensePolicy: 1 })).toThrow();
    usersDb.resetPolicies();
    expect(usersDb.getPolicyBlock().guestAccess).toBe(false);
  });

  it('wipeAll returns the store to first-boot', () => {
    usersDb.createOwner({ displayName: 'O', username: 'ova', pin: '1234' });
    usersDb.wipeAll(null);
    expect(usersDb.userCount()).toBe(0);
    expect(usersDb.queryEvents({}).total).toBe(0);
  });
});
