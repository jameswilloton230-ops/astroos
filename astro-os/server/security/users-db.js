'use strict';

/**
 * AstroOS — Multi-user account database (users.db)
 *
 * First-class server-side identity store: accounts, roles, per-user
 * credential hashes (scrypt, with legacy 3.0.2 PBKDF2 import support),
 * the per-account lockout ladder, WebAuthn descriptors, a persistent
 * user_events audit trail and machine account policies.
 *
 * Sits beside sessions.db under the runtime data directory and follows the
 * same synchronous better-sqlite3 discipline the other stores use.
 * No credential material ever leaves this module except as hashes.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { getRuntimeDataDir } = require('../../scripts/runtime-data-dir');

const DATA_DIR = path.join(getRuntimeDataDir(path.resolve(__dirname, '..', '..')), 'data');
const USERS_DB_PATH = path.join(DATA_DIR, 'users.db');

// ── KDF parameters ─────────────────────────────────────────────────────────

// New accounts: scrypt (Node built-in), ~100 ms on the target hardware.
const SCRYPT_PARAMS = Object.freeze({ n: 32768, r: 8, p: 1, keylen: 32 });
// Legacy 3.0.2 import: the client crypto worker's PBKDF2-SHA256/100k shape.
const LEGACY_PBKDF2_PARAMS = Object.freeze({ alg: 'pbkdf2', hash: 'sha256', iterations: 100000, keylen: 32 });

const ROLES = Object.freeze(['owner', 'admin', 'standard']);
const ADMIN_ROLES = Object.freeze(new Set(['owner', 'admin']));
const STATUSES = Object.freeze(['active', 'disabled']);

const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Machine account policies (the Users app "Policies" tab surface).
const DEFAULT_POLICIES = Object.freeze({
    guestAccess: false,
    showUsernamesOnPicker: false,
    closeAppsOnSwitch: true,
    maxSuspendedSessionsPerAccount: 1,
    lockoutThresholds: { warn: 3, short: 6, lock: 10 }, // 3→30s, 6→150s, 10→admin unlock
    lockoutShortMs: 30000,
    lockoutExtendedMs: 150000,
    singleAccountWipe: false, // retired behaviour, off by default
    defaultUserQuotaBytes: DEFAULT_USER_QUOTA_BYTES,
    idleLockMaxMinutes: 60,
});

// ── Hashing ────────────────────────────────────────────────────────────────

function scryptHex(secret, saltHex, params = SCRYPT_PARAMS) {
    return crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'),
        params.keylen, { N: params.n, r: params.r, p: params.p, maxmem: 1024 * 1024 * 1024 })
        .toString('hex');
}

function pbkdf2Hex(secret, saltHex, params) {
    return crypto.pbkdf2Sync(String(secret), Buffer.from(saltHex, 'hex'),
        params.iterations, params.keylen, params.hash).toString('hex');
}

function newSalt() {
    return crypto.randomBytes(16).toString('hex');
}

/** Constant-time hex comparison. */
function safeEqualHex(aHex, bHex) {
    const a = Buffer.from(String(aHex || ''), 'hex');
    const b = Buffer.from(String(bHex || ''), 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a secret against a stored credential row.
 * Supports scrypt (new) and the legacy PBKDF2 shape (3.0.2 imports);
 * returns { ok, upgrade } — upgrade=true means the row is legacy and the
 * caller should re-hash to scrypt at the next credential change.
 */
function verifyHash(secret, stored) {
    if (!stored || typeof stored !== 'object') return { ok: false, upgrade: false };
    try {
        if (stored.kdf && stored.kdf.alg === 'scrypt') {
            const candidate = scryptHex(secret, stored.salt, stored.kdf);
            return { ok: safeEqualHex(candidate, stored.hash), upgrade: false };
        }
        if (stored.kdf && stored.kdf.alg === 'pbkdf2') {
            const params = {
                iterations: stored.kdf.iterations || LEGACY_PBKDF2_PARAMS.iterations,
                keylen: stored.kdf.keylen || LEGACY_PBKDF2_PARAMS.keylen,
                hash: stored.kdf.hash || 'sha256',
            };
            const candidate = pbkdf2Hex(secret, stored.salt, params);
            return { ok: safeEqualHex(candidate, stored.hash), upgrade: true };
        }
    } catch (_) { /* fall through to deny */ }
    return { ok: false, upgrade: false };
}

function makeCredential(secret) {
    const salt = newSalt();
    return { hash: scryptHex(secret, salt), salt, kdf: { alg: 'scrypt', ...SCRYPT_PARAMS } };
}

// ── Lockout ladder (in-memory, per uid) ─────────────────────────────────────

const lockoutState = new Map(); // uid -> { count, lockedUntil }

function getLockoutPolicies() {
    const p = getPolicyBlock();
    return {
        warn: p.lockoutThresholds?.warn ?? 3,
        short: p.lockoutThresholds?.short ?? 6,
        lock: p.lockoutThresholds?.lock ?? 10,
        shortMs: p.lockoutShortMs ?? 30000,
        extendedMs: p.lockoutExtendedMs ?? 150000,
    };
}

/** Records a failed attempt; returns the ladder outcome for this attempt. */
function recordAuthFailure(uid) {
    const thresholds = getLockoutPolicies();
    const record = lockoutState.get(uid) || { count: 0, lockedUntil: 0 };
    record.count += 1;
    record.lastAttempt = Date.now();
    lockoutState.set(uid, record);

    if (record.count >= thresholds.lock) {
        return { tier: 'lock', count: record.count, message: 'Account locked — an administrator must unlock it' };
    }
    if (record.count >= thresholds.short) {
        return { tier: 'extended', count: record.count, ms: thresholds.extendedMs, message: 'Too many attempts' };
    }
    if (record.count >= thresholds.warn) {
        return { tier: 'short', count: record.count, ms: thresholds.shortMs, message: 'Too many attempts' };
    }
    return { tier: 'none', count: record.count, message: 'Incorrect PIN' };
}

/** True while a temporary lockout window is active for an account. */
function isTemporarilyLocked(uid) {
    const record = lockoutState.get(uid);
    if (!record || !record.lockedUntil) return false;
    if (Date.now() >= record.lockedUntil) { record.lockedUntil = 0; return false; }
    return true;
}

function remainingLockoutMs(uid) {
    const record = lockoutState.get(uid);
    if (!record || !record.lockedUntil) return 0;
    return Math.max(0, record.lockedUntil - Date.now());
}

function resetAuthFailures(uid) {
    lockoutState.delete(uid);
}

// Sweeps stale counters so the map cannot grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [uid, record] of lockoutState) {
        if (record.lockedUntil && now >= record.lockedUntil) record.lockedUntil = 0;
        if (!record.lockedUntil && now - (record.lastAttempt || 0) > 15 * 60 * 1000) {
            lockoutState.delete(uid);
        }
    }
}, 5 * 60 * 1000).unref();

// ── Database lifecycle ──────────────────────────────────────────────────────

let db = null;
let policyCache = null;

function getDb() {
    if (db) return db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(USERS_DB_PATH);
    db.pragma('journal_mode = WAL');
    migrate(db);
    return db;
}

function migrate(database) {
    const version = database.pragma('user_version', { simple: true });
    if (version >= 1) return;
    database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      uid            TEXT PRIMARY KEY,
      username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name   TEXT NOT NULL,
      avatar         TEXT,
      role           TEXT NOT NULL CHECK (role IN ('owner','admin','standard')),
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      locked         INTEGER NOT NULL DEFAULT 0,
      pin_hash       TEXT NOT NULL,
      pin_salt       TEXT NOT NULL,
      pin_kdf        TEXT NOT NULL,
      pin_len        INTEGER NOT NULL DEFAULT 4 CHECK (pin_len BETWEEN 4 AND 6),
      pass_hash      TEXT,
      pass_salt      TEXT,
      pass_kdf       TEXT,
      quota_bytes    INTEGER NOT NULL DEFAULT ${DEFAULT_USER_QUOTA_BYTES},
      must_change_pin INTEGER NOT NULL DEFAULT 0,
      temp_pin_hash  TEXT,
      temp_pin_salt  TEXT,
      temp_pin_kdf   TEXT,
      temp_pin_expires INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_login_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      cred_id      TEXT PRIMARY KEY,
      uid          TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      public_key   TEXT NOT NULL,
      alg          INTEGER NOT NULL,
      label        TEXT,
      sign_count   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_uid ON webauthn_credentials(uid);
    CREATE TABLE IF NOT EXISTS user_events (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      actor_uid TEXT,
      actor    TEXT,
      action   TEXT NOT NULL,
      target   TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      detail   TEXT,
      ip       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_events_ts ON user_events(ts);
    CREATE INDEX IF NOT EXISTS idx_user_events_actor ON user_events(actor_uid, ts);
    CREATE TABLE IF NOT EXISTS session_map (
      sid TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_map_uid ON session_map(uid);
    CREATE TABLE IF NOT EXISTS policies (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `);
    database.pragma('user_version = 1');
}

// ── Policies ───────────────────────────────────────────────────────────────

function getPolicyBlock() {
    if (policyCache) return policyCache;
    const database = getDb();
    const rows = database.prepare('SELECT key, value FROM policies').all();
    const merged = { ...DEFAULT_POLICIES };
    for (const row of rows) {
        try {
            merged[row.key] = JSON.parse(row.value);
        } catch (_) { /* corrupted row: default wins */ }
    }
    policyCache = merged;
    return merged;
}

function setPolicies(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid policy patch');
    const database = getDb();
    const apply = database.transaction((entries) => {
        const upsert = database.prepare(
            'INSERT INTO policies (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [key, value] of entries) {
            if (!(key in DEFAULT_POLICIES)) throw new Error(`Unknown account policy '${key}'`);
            upsert.run(key, JSON.stringify(value));
        }
    });
    apply(Object.entries(patch));
    policyCache = null; // invalidate cache
    return getPolicyBlock();
}

function resetPolicies() {
    const database = getDb();
    database.exec('DELETE FROM policies');
    policyCache = null;
    return getPolicyBlock();
}

// ── Validation helpers ──────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PIN_RE = /^\d{4,6}$/;
const PASSPHRASE_MIN = 8;

function assertUsername(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username.toLowerCase())) {
        throw new Error('Username must be 3–32 chars: letters, digits, dot, dash, underscore');
    }
    return username.toLowerCase();
}

function assertPin(pin) {
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        throw new Error('PIN must be 4 to 6 digits');
    }
    return pin;
}

function assertPassphrase(passphrase, currentPolicies) {
    const minLength = currentPolicies?.passwordMinLength ?? PASSPHRASE_MIN;
    if (typeof passphrase !== 'string' || passphrase.length < minLength) {
        throw new Error(`Passphrase must be at least ${minLength} characters`);
    }
    return passphrase;
}

function sanitizeText(value, maxLength) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error('Invalid text value');
    const trimmed = value.trim().slice(0, maxLength);
    return trimmed.length ? trimmed : null;
}

function toCredentialJson(cred) {
    return JSON.stringify({ hash: cred.hash, salt: cred.salt, kdf: cred.kdf });
}

// ── Account lifecycle ──────────────────────────────────────────────────────

function userCount() {
    return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function hasAccounts() {
    return userCount() > 0;
}

function getUser(uid) {
    if (typeof uid !== 'string' || !uid) return null;
    return getDb().prepare('SELECT * FROM users WHERE uid = ?').get(uid) || null;
}

function getUserByUsername(username) {
    if (typeof username !== 'string' || !username) return null;
    return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;
}

function roleLabel(row) {
    if (row.role === 'owner') return 'Owner';
    return row.role === 'admin' ? 'Admin' : 'Standard';
}

/** Public-safe projection for the login picker: no credential material. */
function toPublicUser(row) {
    if (!row) return null;
    return {
        uid: row.uid,
        displayName: row.display_name,
        username: row.username,
        avatar: row.avatar,
        role: row.role,
        roleLabel: roleLabel(row),
        status: row.status,
        locked: !!row.locked,
        pinLength: row.pin_len,
        hasPassphrase: !!row.pass_hash,
        hasBiometric: webauthnCount(row.uid) > 0,
        mustChangePin: !!row.must_change_pin,
    };
}

/** Admin projection: everything except hashes. */
function toAdminUser(row) {
    if (!row) return null;
    const database = getDb();
    const suspendedSessions = database.prepare(
        'SELECT COUNT(*) AS n FROM session_map WHERE uid = ?').get(row.uid).n;
    return {
        ...toPublicUser(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at,
        quotaBytes: row.quota_bytes,
        credentialKdf: row.pin_kdf ? (JSON.parse(row.pin_kdf).alg === 'scrypt' ? 'scrypt' : 'pbkdf2(legacy)') : null,
        trackedSessions: suspendedSessions,
    };
}

function listPublicUsers() {
    return getDb().prepare('SELECT * FROM users ORDER BY created_at ASC').all()
        .filter(row => row.status === 'active')
        .map(toPublicUser);
}

function listAdminUsers() {
    return getDb().prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(toAdminUser);
}

/**
 * Creates the owner account. Only legal while the users table is empty —
 * the first-boot setup wizard is the only surface that can call this.
 */
function createOwner({ displayName, username, pin, passphrase, avatar }) {
    const database = getDb();
    if (userCount() > 0) {
        const error = new Error('Owner already exists');
        error.code = 'OWNER_EXISTS';
        throw error;
    }
    assertPin(pin);
    const uname = assertUsername(username);
    const pinCred = makeCredential(pin);
    const passCred = passphrase ? makeCredential(assertPassphrase(passphrase, getPolicyBlock())) : null;
    const uid = randomUUID();
    const now = Date.now();
    database.prepare(`INSERT INTO users
        (uid, username, display_name, avatar, role, status, pin_hash, pin_salt, pin_kdf, pin_len,
         pass_hash, pass_salt, pass_kdf, quota_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, uname, displayName || username, sanitizeText(avatar, 512) || null,
            pinCred.hash, pinCred.salt, JSON.stringify(pinCred.kdf), pin.length,
            passCred ? passCred.hash : null, passCred ? passCred.salt : null,
            passCred ? JSON.stringify(passCred.kdf) : null, DEFAULT_USER_QUOTA_BYTES, now, now);
    logEvent(uid, 'account.create.owner', uname, 'info', { displayName: displayName || username });
    return getUser(uid);
}

/** Admin-only account creation (Users app wizard). */
function createUser({ displayName, username, pin, passphrase, role, avatar, quotaBytes }, actorUid) {
    if (role === 'owner') {
        const error = new Error('The owner role cannot be assigned');
        error.code = 'ROLE_FORBIDDEN';
        throw error;
    }
    if (role !== 'admin' && role !== 'standard') {
        throw new Error("Role must be 'admin' or 'standard'");
    }
    assertPin(pin);
    const uname = assertUsername(username);
    const pinCred = makeCredential(pin);
    const passCred = passphrase ? makeCredential(assertPassphrase(passphrase, getPolicyBlock())) : null;
    const database = getDb();
    if (getUserByUsername(uname)) {
        const error = new Error(`Username '${uname}' is already taken`);
        error.code = 'USERNAME_TAKEN';
        throw error;
    }
    const uid = randomUUID();
    const now = Date.now();
    const quota = Number.isFinite(quotaBytes) && quotaBytes > 0
        ? Math.min(Math.trunc(quotaBytes), 32 * 1024 * 1024 * 1024)
        : (getPolicyBlock().defaultUserQuotaBytes ?? DEFAULT_USER_QUOTA_BYTES);
    database.prepare(`INSERT INTO users
        (uid, username, display_name, avatar, role, status, pin_hash, pin_salt, pin_kdf, pin_len,
         pass_hash, pass_salt, pass_kdf, quota_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, uname, displayName || username, sanitizeText(avatar, 512) || null, role,
            pinCred.hash, pinCred.salt, JSON.stringify(pinCred.kdf), pin.length,
            passCred ? passCred.hash : null, passCred ? passCred.salt : null,
            passCred ? JSON.stringify(passCred.kdf) : null, quota, now, now);
    logEvent(actorUid, 'account.create', uname, 'info', { role, displayName: displayName || username });
    return getUser(uid);
}

/**
 * Deletion with the transactional last-guard rules: the owner is undeletable,
 * and the last active admin cannot be removed. mode = 'archive' | 'wipe'
 * decides what happens to storage; the caller performs the file work using
 * the returned storage paths while this transaction guards the rows.
 */
function deleteUser(uid, mode, actorUid) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    if (row.role === 'owner') {
        const error = new Error('The owner account cannot be deleted');
        error.code = 'OWNER_PROTECTED';
        throw error;
    }
    const activeAdmins = database.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','admin') AND status = 'active'").get().n;
    const isLastAdmin = (row.role === 'admin' && activeAdmins <= 1);
    if (isLastAdmin) {
        const error = new Error('Cannot delete the last active administrator');
        error.code = 'LAST_ADMIN';
        throw error;
    }
    if (mode !== 'archive' && mode !== 'wipe') {
        throw new Error("Deletion mode must be 'archive' or 'wipe'");
    }
    const target = { uid, username: row.username, mode };
    const tx = database.transaction(() => {
        database.prepare('DELETE FROM webauthn_credentials WHERE uid = ?').run(uid);
        database.prepare('DELETE FROM session_map WHERE uid = ?').run(uid);
        database.prepare('DELETE FROM users WHERE uid = ?').run(uid);
        resetAuthFailures(uid);
    });
    tx();
    logEvent(actorUid, 'account.delete', row.username, 'warn', target);
    return target;
}

/** Legacy import: creates the owner from the 3.0.2 single-user state. */
function importLegacyOwner({ username, displayName, legacyPinHash, legacyPinSalt, pinLen, adminEnabled }) {
    const database = getDb();
    if (userCount() > 0) {
        const error = new Error('Migration refused: accounts already exist');
        error.code = 'ALREADY_MIGRATED';
        throw error;
    }
    const uname = assertUsername(username || 'user');
    const now = Date.now();
    const uid = randomUUID();
    const kdf = JSON.stringify({ ...LEGACY_PBKDF2_PARAMS });
    database.prepare(`INSERT INTO users
        (uid, username, display_name, role, status, pin_hash, pin_salt, pin_kdf, pin_len, quota_bytes, created_at, updated_at)
        VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, uname, displayName || uname,
            String(legacyPinHash || ''), String(legacyPinSalt || ''), kdf,
            Math.min(Math.max(Number(pinLen) || 4, 4), 6), DEFAULT_USER_QUOTA_BYTES, now, now);
    logEvent(uid, 'account.migrate.legacy', uname, 'info', { adminEnabled: !!adminEnabled, legacyImport: true });
    return getUser(uid);
}

function updateUser(uid, patch, actorUid) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    const sets = [];
    const args = [];
    if (patch.displayName !== undefined) {
        const value = sanitizeText(patch.displayName, 64);
        if (!value) throw new Error('Display name cannot be empty');
        sets.push('display_name = ?'); args.push(value);
    }
    if (patch.avatar !== undefined) {
        sets.push('avatar = ?'); args.push(sanitizeText(patch.avatar, 512));
    }
    if (patch.quotaBytes !== undefined) {
        const quota = Math.trunc(Number(patch.quotaBytes));
        if (!Number.isFinite(quota) || quota < 1024 * 1024) throw new Error('Invalid quota');
        sets.push('quota_bytes = ?'); args.push(Math.min(quota, 32 * 1024 * 1024 * 1024));
    }
    if (patch.role !== undefined && patch.role !== row.role) {
        if (row.role === 'owner') {
            const error = new Error('The owner role cannot be changed');
            error.code = 'OWNER_PROTECTED';
            throw error;
        }
        if (patch.role === 'owner') {
            const error = new Error('The owner role cannot be assigned');
            error.code = 'ROLE_FORBIDDEN';
            throw error;
        }
        if (!ROLES.includes(patch.role)) throw new Error('Unknown role');
        // Demoting the last active admin is refused.
        if (row.role === 'admin' && patch.role === 'standard') {
            const activeAdmins = database.prepare(
                "SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','admin') AND status = 'active'").get().n;
            if (activeAdmins <= 1) {
                const error = new Error('Cannot demote the last active administrator');
                error.code = 'LAST_ADMIN';
                throw error;
            }
        }
        sets.push('role = ?'); args.push(patch.role);
    }
    if (!sets.length) return getUser(uid);
    sets.push('updated_at = ?'); args.push(Date.now());
    args.push(uid);
    database.prepare(`UPDATE users SET ${sets.join(', ')} WHERE uid = ?`).run(...args);
    logEvent(actorUid, 'account.update', row.username, 'info', { fields: Object.keys(patch) });
    return getUser(uid);
}

function setStatus(uid, status, actorUid) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    if (!STATUSES.includes(status)) throw new Error('Unknown status');
    if (status === 'disabled' && row.role !== 'standard') {
        const activeAdmins = database.prepare(
            "SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','admin') AND status = 'active'").get().n;
        const wouldRemain = activeAdmins - (row.status === 'active' ? 1 : 0);
        if (wouldRemain < 1) {
            const error = new Error('Cannot disable the last active administrator');
            error.code = 'LAST_ADMIN';
            throw error;
        }
    }
    database.prepare('UPDATE users SET status = ?, updated_at = ? WHERE uid = ?').run(status, Date.now(), uid);
    if (status === 'disabled') {
        revokeSessionsForUser(uid);
        resetAuthFailures(uid);
    }
    logEvent(actorUid, status === 'disabled' ? 'account.disable' : 'account.enable', row.username, 'warn', null);
    return getUser(uid);
}

function setLocked(uid, locked, actorUid) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    database.prepare('UPDATE users SET locked = ?, updated_at = ? WHERE uid = ?')
        .run(locked ? 1 : 0, Date.now(), uid);
    if (locked) {
        revokeSessionsForUser(uid);
    } else {
        resetAuthFailures(uid);
    }
    logEvent(actorUid, locked ? 'account.lock' : 'account.unlock', row.username, 'warn', null);
    return getUser(uid);
}

// ── Credentials ────────────────────────────────────────────────────────────

/** Sets a new PIN (or passphrase). Re-hashes legacy rows to scrypt. */
function setCredential(uid, kind, secret) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    if (kind === 'pin') {
        assertPin(secret);
        const cred = makeCredential(secret);
        database.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, pin_kdf = ?, pin_len = ?,
            must_change_pin = 0, temp_pin_hash = NULL, temp_pin_salt = NULL, temp_pin_kdf = NULL,
            temp_pin_expires = 0, updated_at = ? WHERE uid = ?`)
            .run(cred.hash, cred.salt, JSON.stringify(cred.kdf), secret.length, Date.now(), uid);
        resetAuthFailures(uid);
        logEvent(uid, 'account.credential.set', row.username, 'info', { kind: 'pin', kdf: 'scrypt' });
        return getUser(uid);
    }
    if (kind === 'passphrase') {
        if (secret === null) {
            database.prepare(`UPDATE users SET pass_hash = NULL, pass_salt = NULL, pass_kdf = NULL, updated_at = ? WHERE uid = ?`)
                .run(Date.now(), uid);
            logEvent(uid, 'account.credential.clear', row.username, 'info', { kind: 'passphrase' });
            return getUser(uid);
        }
        assertPassphrase(secret, getPolicyBlock());
        const cred = makeCredential(secret);
        database.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_kdf = ?, updated_at = ? WHERE uid = ?')
            .run(cred.hash, cred.salt, JSON.stringify(cred.kdf), Date.now(), uid);
        logEvent(uid, 'account.credential.set', row.username, 'info', { kind: 'passphrase', kdf: 'scrypt' });
        return getUser(uid);
    }
    throw new Error(`Unknown credential kind '${kind}'`);
}

/** Import a legacy 3.0.2 PBKDF2 pin hash for an existing account. */
function importLegacyPin(uid, legacyHash, legacySalt) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) throw new Error('No such account');
    database.prepare('UPDATE users SET pin_hash = ?, pin_salt = ?, pin_kdf = ?, updated_at = ? WHERE uid = ?')
        .run(String(legacyHash || ''), String(legacySalt || ''),
            JSON.stringify({ ...LEGACY_PBKDF2_PARAMS }), Date.now(), uid);
    return getUser(uid);
}

/**
 * Admin credential reset: writes a temporary PIN that is valid for a short
 * window and forces a new-PIN sheet at next login. The temporary PIN is
 * returned exactly once — the caller shows it to the admin immediately.
 */
function resetCredential(uid, actorUid) {
    const database = getDb();
    const row = getUser(uid);
    if (!row) {
        const error = new Error('No such account');
        error.code = 'NOT_FOUND';
        throw error;
    }
    const tempPin = String(crypto.randomInt(100000, 1000000)); // 6 digits
    const cred = makeCredential(tempPin);
    const expires = Date.now() + 15 * 60 * 1000; // 15-minute window
    database.prepare(`UPDATE users SET temp_pin_hash = ?, temp_pin_salt = ?, temp_pin_kdf = ?,
        temp_pin_expires = ?, must_change_pin = 1, locked = 0, updated_at = ? WHERE uid = ?`)
        .run(cred.hash, cred.salt, JSON.stringify(cred.kdf), expires, Date.now(), uid);
    revokeSessionsForUser(uid);
    resetAuthFailures(uid);
    logEvent(actorUid, 'account.credential.reset', row.username, 'warn', { temporaryUntil: expires });
    return { uid, username: row.username, temporaryPin: tempPin, expiresAt: expires };
}

/**
 * The authentication core. Verifies pin or passphrase against an account
 * (honouring the temporary-PIN window and the lockout ladder), returning a
 * structured result. Never returns hashes. Also performs the account-state
 * gates (disabled / hard-locked / temporary lockout).
 */
function verifyCredential(uid, secret, { kind = 'auto' } = {}) {
    const row = getUser(uid);
    if (!row) return { ok: false, code: 'UNKNOWN_ACCOUNT', message: 'Unknown account' };

    if (row.status === 'disabled') {
        logEvent(null, 'auth.denied', row.username, 'warn', { reason: 'disabled' });
        return { ok: false, code: 'ACCOUNT_DISABLED', message: 'This account is disabled' };
    }
    if (row.locked) {
        return { ok: false, code: 'ACCOUNT_LOCKED', message: 'Account locked — an administrator must unlock it' };
    }
    if (isTemporarilyLocked(uid)) {
        // Attempts during an active lockout window still COUNT — otherwise
        // the ladder could never escalate to the hard-lock tier, and a
        // patient attacker would just outwait each short window.
        const escalated = recordAuthFailure(uid);
        if (escalated.tier === 'lock') {
            getDb().prepare('UPDATE users SET locked = 1, updated_at = ? WHERE uid = ?').run(Date.now(), uid);
            revokeSessionsForUser(uid);
            return { ok: false, code: 'ACCOUNT_LOCKED', message: escalated.message };
        }
        if (escalated.tier === 'extended') {
            const record = lockoutState.get(uid);
            record.lockedUntil = Math.max(record.lockedUntil, Date.now() + escalated.ms);
        }
        const remaining = Math.ceil(remainingLockoutMs(uid) / 1000);
        return { ok: false, code: 'LOCKOUT', message: `Too many attempts — try again in ${remaining}s`, retryAfterMs: remainingLockoutMs(uid) };
    }

    let result = { ok: false, upgrade: false };
    let usedKind = null;

    // Temporary credential window (admin reset flow) — checked first, and
    // success through it still lands on the forced new-PIN sheet.
    const tempCred = (row.temp_pin_hash && row.temp_pin_expires > Date.now())
        ? { hash: row.temp_pin_hash, salt: row.temp_pin_salt, kdf: JSON.parse(row.temp_pin_kdf || '{}') }
        : null;

    const wantsPass = kind === 'passphrase' || kind === 'auto';

    // 3.0.2 imports carry the legacy PBKDF2 lock PIN, whose shape was never
    // digit-only — the old lock screen accepted whatever string the user set.
    // The auto-detect below only recognises 4–6 digit PINs, so a migrated
    // machine whose PIN contains letters or symbols could NEVER verify (the
    // secret fell through to the passphrase branch, which legacy imports
    // never have) and every login failed with BAD_CREDENTIAL / 401. For
    // legacy rows, any non-empty secret is therefore a PIN candidate; the
    // first successful verification upgrades the row to scrypt with the
    // SAME secret, so the account keeps working and tightens its shape.
    const pinKdf = (() => { try { return JSON.parse(row.pin_kdf || '{}'); } catch (_) { return {}; } })();
    const legacyPinRow = !!row.pin_hash && pinKdf.alg === 'pbkdf2';
    const isDigitSecret = /^\d{4,6}$/.test(String(secret));
    const wantsPin = kind === 'pin' ||
        (kind === 'auto' && (isDigitSecret || (legacyPinRow && !row.pass_hash)));

    if (tempCred && wantsPin) {
        const tempCheck = verifyHash(secret, tempCred);
        if (tempCheck.ok) {
            resetAuthFailures(uid);
            touchLogin(uid);
            logEvent(uid, 'auth.success', row.username, 'info', { via: 'temporary-pin' });
            return { ok: true, uid, role: row.role, username: row.username, mustChangePin: true, via: 'temporary-pin' };
        }
    }

    if (wantsPin && (isDigitSecret || legacyPinRow)) {
        const stored = { hash: row.pin_hash, salt: row.pin_salt, kdf: pinKdf };
        const check = verifyHash(secret, stored);
        if (check.ok) result = { ok: true, upgrade: check.upgrade };
        usedKind = 'pin';
    }

    if (!result.ok && wantsPass && row.pass_hash) {
        const stored = { hash: row.pass_hash, salt: row.pass_salt, kdf: JSON.parse(row.pass_kdf || '{}') };
        const check = verifyHash(String(secret), stored);
        if (check.ok) { result = { ok: true, upgrade: check.upgrade }; usedKind = 'passphrase'; }
        if (!result.ok && kind === 'auto' && (isDigitSecret || legacyPinRow)) usedKind = 'pin';
    }

    if (!result.ok) {
        const outcome = recordAuthFailure(uid);
        logEvent(uid, 'auth.failure', row.username, 'warn',
            { count: outcome.count, tier: outcome.tier, via: usedKind || kind });
        if (outcome.tier === 'lock') {
            // Hard lock: the account needs an administrator from here.
            const database = getDb();
            database.prepare('UPDATE users SET locked = 1, updated_at = ? WHERE uid = ?').run(Date.now(), uid);
            revokeSessionsForUser(uid);
            return { ok: false, code: 'ACCOUNT_LOCKED', message: outcome.message };
        }
        if (outcome.tier === 'extended' || outcome.tier === 'short') {
            const record = lockoutState.get(uid);
            record.lockedUntil = Date.now() + outcome.ms;
            return { ok: false, code: 'LOCKOUT', message: outcome.message, retryAfterMs: outcome.ms };
        }
        return { ok: false, code: 'BAD_CREDENTIAL', message: outcome.message };
    }

    resetAuthFailures(uid);
    touchLogin(uid);
    // A successful login through a legacy-imported PIN upgrades the account
    // to scrypt transparently (the design's first-change-re-hash rule, done
    // at first successful verification so nothing is lost if the import was
    // wrong — the upgrade only runs once the old secret still verifies).
    if (result.upgrade) {
        // Re-hash the still-verifying secret to scrypt, in place, WITHOUT
        // touching must_change_pin or the temporary-credential window —
        // this is a KDF upgrade of the same secret, not a credential change.
        try {
            const cred = makeCredential(String(secret));
            getDb().prepare('UPDATE users SET pin_hash = ?, pin_salt = ?, pin_kdf = ?, updated_at = ? WHERE uid = ?')
                .run(cred.hash, cred.salt, JSON.stringify(cred.kdf), Date.now(), uid);
            logEvent(uid, 'account.credential.upgrade', row.username, 'info', { from: 'pbkdf2', to: 'scrypt' });
        } catch (_) { /* non-fatal: legacy hash stays valid */ }
    }
    logEvent(uid, 'auth.success', row.username, 'info', { via: usedKind });
    return {
        ok: true,
        uid, role: row.role, username: row.username,
        mustChangePin: !!row.must_change_pin,
        via: usedKind,
    };
}

function touchLogin(uid) {
    getDb().prepare('UPDATE users SET last_login_at = ? WHERE uid = ?').run(Date.now(), uid);
}

// ── Session map (sid ↔ uid) ────────────────────────────────────────

// The express-session rows live in sessions.db (a different SQLite file),
// so actual session-row destruction is injected by the auth routes via
// setSessionRevoker(). users.db only owns the sid ↔ uid map.
let sessionRevoker = null;

function setSessionRevoker(fn) {
    if (typeof fn === 'function') sessionRevoker = fn;
}

function registerSessionSid(sid, uid) {
    getDb().prepare('INSERT OR REPLACE INTO session_map (sid, uid, created_at) VALUES (?, ?, ?)')
        .run(String(sid), String(uid), Date.now());
}

function unregisterSessionSid(sid) {
    try { getDb().prepare('DELETE FROM session_map WHERE sid = ?').run(String(sid)); } catch (_) { }
}

function sessionsForUser(uid) {
    return getDb().prepare('SELECT sid FROM session_map WHERE uid = ?').all(uid).map(row => row.sid);
}

function revokeSessionsForUser(uid) {
    const sids = sessionsForUser(uid);
    const database = getDb();
    if (sessionRevoker && sids.length) {
        try { sessionRevoker(sids); } catch (_) { /* best-effort */ }
    }
    const dropRows = database.prepare('DELETE FROM session_map WHERE sid = ?');
    for (const sid of sids) {
        try { dropRows.run(sid); } catch (_) { }
    }
    return sids.length;
}

// ── WebAuthn ───────────────────────────────────────────────────────────────

function webauthnCount(uid) {
    try {
        return getDb().prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE uid = ?').get(uid).n;
    } catch (_) { return 0; }
}

function listWebauthnCredentials(uid) {
    return getDb().prepare('SELECT cred_id, alg, label, sign_count, created_at, last_used_at FROM webauthn_credentials WHERE uid = ?')
        .all(uid);
}

function addWebauthnCredential(uid, credentialIdB64u, publicKeyB64, alg, label) {
    const database = getDb();
    if (!getUser(uid)) throw new Error('No such account');
    const existing = database.prepare('SELECT uid FROM webauthn_credentials WHERE cred_id = ?')
        .get(credentialIdB64u);
    if (existing && existing.uid !== uid) {
        const error = new Error('This authenticator is already enrolled to another account');
        error.code = 'CRED_TAKEN';
        throw error;
    }
    database.prepare(`INSERT INTO webauthn_credentials (cred_id, uid, public_key, alg, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(cred_id) DO UPDATE SET public_key = excluded.public_key, alg = excluded.alg, label = excluded.label`)
        .run(credentialIdB64u, uid, publicKeyB64, alg, sanitizeText(label, 64) || null, Date.now());
    logEvent(uid, 'account.webauthn.enroll', getUser(uid).username, 'info', { credentialId: credentialIdB64u.slice(0, 12) + '…' });
}

function removeWebauthnCredential(uid, credentialIdB64u, actorUid) {
    const database = getDb();
    const info = database.prepare('DELETE FROM webauthn_credentials WHERE cred_id = ? AND uid = ?')
        .run(credentialIdB64u, uid);
    if (info.changes > 0) {
        logEvent(actorUid, 'account.webauthn.remove', getUser(uid)?.username || uid, 'info', null);
    }
    return info.changes > 0;
}

function getWebauthnCredential(credentialIdB64u) {
    return getDb().prepare('SELECT * FROM webauthn_credentials WHERE cred_id = ?').get(credentialIdB64u) || null;
}

function touchWebauthnUse(credentialIdB64u, signCount) {
    getDb().prepare('UPDATE webauthn_credentials SET last_used_at = ?, sign_count = ? WHERE cred_id = ?')
        .run(Date.now(), Number(signCount) || 0, credentialIdB64u);
}

/** allowCredentials list scoped to one account — deliberately non-discoverable. */
function allowCredentialsForUser(uid) {
    return listWebauthnCredentials(uid).map(row => row.cred_id);
}

// ── Audit events ───────────────────────────────────────────────────────────

function logEvent(actorUid, action, actor, severity, detail, ip) {
    try {
        getDb().prepare(`INSERT INTO user_events (ts, actor_uid, actor, action, target, severity, detail, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(Date.now(), actorUid || null, actor || null, String(action),
                (typeof detail === 'object' && detail) ? (detail.username || detail.target || null) : (detail || null),
                String(severity || 'info'),
                (detail && typeof detail === 'object') ? JSON.stringify(detail).slice(0, 2000) : null,
                ip || null);
    } catch (_) { /* audit must never break the operation */ }
}

function queryEvents({ uid, severity, action, limit = 100, offset = 0 } = {}) {
    const conditions = [];
    const args = [];
    if (uid) { conditions.push('actor_uid = ?'); args.push(uid); }
    if (severity) { conditions.push('severity = ?'); args.push(severity); }
    if (action) { conditions.push('action = ?'); args.push(action); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const database = getDb();
    const rows = database.prepare(
        `SELECT * FROM user_events ${where} ORDER BY ts DESC, seq DESC LIMIT ? OFFSET ?`)
        .all(...args, safeLimit, safeOffset);
    const total = database.prepare(`SELECT COUNT(*) AS n FROM user_events ${where}`).get(...args).n;
    return { events: rows.map(toEventView), total, limit: safeLimit, offset: safeOffset };
}

function toEventView(row) {
    return {
        seq: row.seq,
        ts: row.ts,
        actorUid: row.actor_uid,
        actor: row.actor,
        action: row.action,
        target: row.target,
        severity: row.severity,
        detail: row.detail ? safeJsonParse(row.detail) : null,
        ip: row.ip,
    };
}

function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return text; }
}

function eventsToCsv({ uid, severity, action } = {}) {
    const { events } = queryEvents({ uid, severity, action, limit: 1000, offset: 0 });
    const escapeCell = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        // SECURITY (2026-11-12 audit, finding L2): neutralize spreadsheet
        // formula execution — a cell beginning with =, +, -, @ (or a
        // TAB/CR control char) is executed as a formula when an admin
        // opens the export in Excel/LibreOffice. Prefix such cells with a
        // single quote so they render as inert text.
        const needsFormulaNeutralizer = /^[=+\-@\t\r]/.test(text);
        const guarded = needsFormulaNeutralizer ? `'${text}` : text;
        return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
    };
    const header = 'ts,actor,action,target,severity,detail,ip';
    const lines = events.map(event => [
        new Date(event.ts).toISOString(),
        event.actor || event.actorUid || '',
        event.action,
        event.target || '',
        event.severity,
        event.detail ? JSON.stringify(event.detail) : '',
        event.ip || '',
    ].map(escapeCell).join(','));
    return [header, ...lines].join('\n');
}

// ── Maintenance ───────────────────────────────────────────────────────────

/** Full teardown for factory reset / recovery: drops every account row. */
function wipeAll(actorUid) {
    const database = getDb();
    const tx = database.transaction(() => {
        database.exec('DELETE FROM webauthn_credentials; DELETE FROM user_events; DELETE FROM session_map; DELETE FROM policies; DELETE FROM users;');
    });
    tx();
    lockoutState.clear();
    policyCache = null;
    // Deliberately no wipe event: the store returns to first-boot (zero
    // rows), and the factory-reset action itself is logged by the caller.
}

/** Recovers the owner PIN from the recovery environment: writes a temp PIN. */
function resetOwnerCredentialRecovery() {
    const database = getDb();
    const owner = database.prepare("SELECT * FROM users WHERE role = 'owner'").get();
    if (!owner) {
        const error = new Error('No owner account exists');
        error.code = 'NO_OWNER';
        throw error;
    }
    return resetCredential(owner.uid, null);
}

function close() {
    if (!db) return;
    try { db.close(); } catch (_) { }
    db = null;
    policyCache = null;
}

function dbPath() {
    return USERS_DB_PATH;
}

module.exports = {
    // lifecycle
    getDb, close, dbPath, migrate,
    // roles / policies
    ROLES, ADMIN_ROLES, DEFAULT_POLICIES,
    getPolicyBlock, setPolicies, resetPolicies,
    // lookups
    hasAccounts, userCount, getUser, getUserByUsername,
    listPublicUsers, listAdminUsers, toPublicUser, toAdminUser,
    // account lifecycle
    createOwner, createUser, updateUser, deleteUser, importLegacyOwner,
    setStatus, setLocked,
    // credentials
    setCredential, importLegacyPin, resetCredential, verifyCredential,
    // lockout ladder
    recordAuthFailure, isTemporarilyLocked, remainingLockoutMs, resetAuthFailures,
    // sessions
    registerSessionSid, unregisterSessionSid, sessionsForUser, revokeSessionsForUser,
    setSessionRevoker,
    // webauthn
    listWebauthnCredentials, addWebauthnCredential, removeWebauthnCredential,
    getWebauthnCredential, touchWebauthnUse, allowCredentialsForUser, webauthnCount,
    // audit
    logEvent, queryEvents, eventsToCsv,
    // maintenance
    wipeAll, resetOwnerCredentialRecovery,
    // hashing helpers (exported for tests)
    _test: { scryptHex, pbkdf2Hex, makeCredential, verifyHash, safeEqualHex, assertPin, assertUsername, LEGACY_PBKDF2_PARAMS, SCRYPT_PARAMS, DATA_DIR },
};
