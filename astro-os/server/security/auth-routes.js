'use strict';

/**
 * AstroOS — Multi-user authentication routes (/api/auth)
 *
 * Public family: picker account list, login (PIN / passphrase / WebAuthn),
 * session introspection, first-boot setup, lock/reverify/suspend lifecycle.
 * Admin family: account CRUD, credential reset, policies, per-user audit
 * events — every admin route re-checks the session role, never a client
 * claim. Login/setup/reverify are CSRF-exempt by design: they are the
 * identity-establishing verbs (and WebAuthn challenges cannot carry a
 * pre-session token); every other route runs the standard CSRF chain.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const usersDb = require('./users-db');
const securityMiddleware = require('../../security/middleware');

const router = express.Router();

// ── Session revoker: users.db owns the sid↔uid map; the actual express-session
// rows live in sessions.db, so deletion is injected here (same data-dir
// resolution as server/middleware.js — NOT the hard-coded path the legacy
// security routes suffer from).
(function registerSessionRevoker() {
    try {
        const path = require('path');
        const Database = require('better-sqlite3');
        const { getRuntimeDataDir } = require('../../scripts/runtime-data-dir');
        const sessionsDbPath = path.join(getRuntimeDataDir(path.resolve(__dirname, '..', '..')), 'data', 'sessions.db');
        let handle = null;
        usersDb.setSessionRevoker((sids) => {
            if (!Array.isArray(sids) || !sids.length) return;
            if (!handle) {
                handle = new Database(sessionsDbPath, { fileMustExist: false });
                handle.pragma('journal_mode = WAL');
            }
            const del = handle.prepare('DELETE FROM sessions WHERE sid = ?');
            for (const sid of sids) {
                try { del.run(String(sid)); } catch (_) { }
            }
        });
    } catch (_) { /* revocation degrades to map-only when sqlite is unavailable */ }
})();

// ── CSRF exemptions for the identity-establishing verbs ────────────────────

(function exemptIdentityVerbs() {
    const paths = [
        '/api/auth/login',
        '/api/auth/setup',
        '/api/auth/reverify',
        '/api/auth/webauthn/login/options',
        '/api/auth/webauthn/login/finish',
    ];
    try {
        for (const p of paths) {
            if (!securityMiddleware.csrfExempt.includes(p)) {
                securityMiddleware.csrfExempt.push(p);
            }
        }
    } catch (_) { /* csrfExempt not exported — the routes still work with tokens */ }
})();

// ── Session identity helpers ───────────────────────────────────────────────

const { generateCSRFToken } = securityMiddleware;

function sessionUserView(session) {
    const admin = usersDb.ADMIN_ROLES.has(session.role);
    return {
        uid: session.uid,
        username: session.uname,
        role: session.role,
        admin,
        loginAt: session.loginAt,
    };
}

/**
 * Establishes an authenticated session: regenerates the session id (session
 * fixation defence), stamps uid/role/uname/loginAt, registers the sid in the
 * users.db session map and returns the bearer token + CSRF token the host
 * SessionManager keeps in memory.
 */
function establishSession(req, res, account, cb) {
    req.session.regenerate((err) => {
        if (err) return cb(err);
        const s = req.session;
        s.uid = account.uid;
        s.uname = account.username;
        s.role = account.role;
        s.loginAt = Date.now();
        s.suspended = false;
        s.lockedAt = null;
        s.user = {
            id: account.uid,
            uid: account.uid,
            role: usersDb.ADMIN_ROLES.has(account.role) ? 'admin' : 'user',
            uname: account.username,
        };
        s.lastIp = req.ip;
        s.lastUserAgent = req.get('user-agent') || null;
        // Forced new-PIN state (admin reset / temporary PIN): the change-pin
        // route honours it — no current secret required while it is set.
        s.mustChangePin = !!account.must_change_pin;
        if (!s.csrfToken) s.csrfToken = generateCSRFToken();
        s.save(() => {
            usersDb.registerSessionSid(req.sessionID, account.uid);
            cb(null, {
                sessionId: req.sessionID,
                csrfToken: s.csrfToken,
                user: usersDb.toPublicUser(usersDb.getUser(account.uid)),
            });
        });
    });
}

/** Role gate for the admin family — re-checked on every route. */
function requireAdminRole(req, res, next) {
    const s = req.session || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in with an administrator account' });
    }
    if (s.suspended) {
        return res.status(403).json({ success: false, code: 'SESSION_SUSPENDED', message: 'This session is suspended — resume it first' });
    }
    if (s.lockedAt) {
        return res.status(403).json({ success: false, code: 'SESSION_LOCKED', message: 'This session is locked — unlock it first' });
    }
    if (!usersDb.ADMIN_ROLES.has(s.role)) {
        usersDb.logEvent(s.uid, 'admin.denied', s.uname, 'warn', { path: req.originalUrl });
        return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', message: 'An administrator account is required' });
    }
    next();
}

function requireOwnerRole(req, res, next) {
    const s = req.session || {};
    if (!s.uid || s.role !== 'owner') {
        return res.status(403).json({ success: false, code: 'OWNER_REQUIRED', message: 'The owner account is required' });
    }
    next();
}

function actorUid(req) {
    return req.session?.uid || null;
}

// ── Public routes ──────────────────────────────────────────────────────────

// Picker account list: public-safe fields only — no credential material,
// no last-login, no quota. Tiles render from this.
router.get('/users', (req, res) => {
    const policies = usersDb.getPolicyBlock();
    res.json({
        success: true,
        data: {
            users: usersDb.listPublicUsers(),
            policies: {
                guestAccess: !!policies.guestAccess,
                showUsernames: !!policies.showUsernamesOnPicker,
            },
        },
    });
});

router.get('/policies', (req, res) => {
    const policies = usersDb.getPolicyBlock();
    res.json({
        success: true,
        data: {
            guestAccess: !!policies.guestAccess,
            showUsernames: !!policies.showUsernamesOnPicker,
            closeAppsOnSwitch: !!policies.closeAppsOnSwitch,
            idleLockMaxMinutes: policies.idleLockMaxMinutes,
        },
    });
});

// Session introspection — the host SessionManager polls this at boot.
router.get('/session', (req, res) => {
    const s = req.session || {};
    if (!s.uid) {
        return res.json({ success: true, data: { authenticated: false } });
    }
    const user = usersDb.toPublicUser(usersDb.getUser(s.uid));
    res.json({
        success: true,
        data: {
            authenticated: true,
            sessionId: req.sessionID,
            suspended: !!s.suspended,
            locked: !!s.lockedAt,
            loginAt: s.loginAt,
            user: user || { uid: s.uid, username: s.uname, role: s.role, status: 'gone' },
        },
    });
});

// Login: pin or passphrase for a picked account. The host always calls this
// with credentials:'omit' so the browser's single cookie slot keeps pointing
// at the anonymous page session; the returned bearer token (sessionId) is
// what the SessionManager presents as X-Nova-Session thereafter.
router.post('/login', (req, res) => {
    const { uid, username, secret, kind } = req.body || {};
    const targetUid = typeof uid === 'string' && uid ? uid
        : (typeof username === 'string' && username ? usersDb.getUserByUsername(username)?.uid : null);
    if (!targetUid || typeof secret !== 'string' || !secret) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'uid and secret are required' });
    }
    const result = usersDb.verifyCredential(targetUid, secret, { kind: kind === 'pin' || kind === 'passphrase' ? kind : 'auto' });
    if (!result.ok) {
        // A wrong PIN / lockout / disabled account is a NORMAL outcome of the
        // login form, not a protocol error — and every non-2xx response makes
        // the browser itself log "Failed to load resource … 401" in the console
        // (the exact noise reported on the lock screen), no matter how well the
        // client handles it. Same policy /api/auth/session already follows for
        // {authenticated:false}: HTTP 200 with success:false + a machine code
        // the sheet renders. The lockout ladder still runs server-side and the
        // retryAfterMs rides along; monitoring keeps the users.db event log.
        res.status(200);
        return res.json({ success: false, code: result.code, message: result.message, retryAfterMs: result.retryAfterMs || undefined });
    }
    establishSession(req, res, usersDb.getUser(result.uid), (err, payload) => {
        if (err) {
            return res.status(500).json({ success: false, code: 'SESSION_ERROR', message: 'Could not establish session' });
        }
        res.json({
            success: true,
            data: {
                ...payload,
                mustChangePin: !!result.mustChangePin,
                via: result.via,
            },
        });
    });
});

// First-boot setup: the only surface that can create the owner, and it is
// legal only while the users table is empty.
router.post('/setup', (req, res) => {
    const { displayName, username, pin, passphrase, avatar } = req.body || {};
    if (usersDb.hasAccounts()) {
        return res.status(409).json({ success: false, code: 'ALREADY_SET_UP', message: 'This machine already has accounts' });
    }
    let owner;
    try {
        owner = usersDb.createOwner({ displayName, username, pin, passphrase, avatar });
    } catch (err) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: err.message });
    }
    establishSession(req, res, owner, (err, payload) => {
        if (err) {
            return res.status(500).json({ success: false, code: 'SESSION_ERROR', message: 'Could not establish session' });
        }
        res.json({ success: true, data: payload });
    });
});

/**
 * The 3.0.2 single-user → accounts import. Only legal while users.db is
 * empty, which makes it idempotent by construction: a second call after a
 * successful migration hits ALREADY_MIGRATED. The legacy PBKDF2-SHA256/100k
 * hash + salt are imported verbatim; the first successful PIN verification
 * re-hashes the account to scrypt server-side.
 */
router.post('/migrate-legacy', (req, res) => {
    if (usersDb.hasAccounts()) {
        return res.status(409).json({ success: false, code: 'ALREADY_MIGRATED', message: 'This machine already has accounts' });
    }
    const { username, displayName, legacyPinHash, legacyPinSalt, pinLen, adminEnabled } = req.body || {};
    if (typeof legacyPinHash !== 'string' || !legacyPinHash || typeof legacyPinSalt !== 'string' || !legacyPinSalt) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'legacyPinHash and legacyPinSalt are required' });
    }
    let owner;
    try {
        owner = usersDb.importLegacyOwner({
            username,
            displayName,
            legacyPinHash,
            legacyPinSalt,
            pinLen,
            adminEnabled,
        });
    } catch (err) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: err.message });
    }
    // Legacy adminEnabled=true maps to the owner (the owner IS an admin).
    if (adminEnabled === true) {
        try {
            const { setAdminEnabled } = require('./admin-state');
            setAdminEnabled(false); // superseded by account roles from here on
        } catch (_) { }
    }
    usersDb.logEvent(owner.uid, 'account.migrate.legacy', owner.username, 'info', { adminEnabled: !!adminEnabled });
    res.json({ success: true, data: { uid: owner.uid, username: owner.username, role: owner.role } });
});

// Sign out: ends the server session, flushes state, returns to the picker.
router.post('/logout', (req, res) => {
    const s = req.session || {};
    const uid = s.uid || null;
    const uname = s.uname || null;
    usersDb.unregisterSessionSid(req.sessionID);
    req.session.destroy(() => {
        if (uid) usersDb.logEvent(uid, 'auth.logout', uname, 'info', null);
        res.clearCookie('connect.sid');
        res.json({ success: true, data: { signedOut: true } });
    });
});

// Lock: the session stays alive server-side; privileged routes refuse it
// until reverify succeeds. Called by the lock screen for the ACTIVE session.
router.post('/lock', (req, res) => {
    const s = req.session || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'No active session to lock' });
    }
    s.lockedAt = Date.now();
    s.save(() => {
        usersDb.logEvent(s.uid, 'session.lock', s.uname, 'info', null);
        res.json({ success: true, data: { locked: true } });
    });
});

// Suspend: marks the DEPARTING session suspended during a user switch.
// Targeted via X-Nova-Session so the active session is untouched.
router.post('/suspend', (req, res) => {
    const s = req.session || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'No session to suspend' });
    }
    const policies = usersDb.getPolicyBlock();
    const maxSuspended = policies.maxSuspendedSessionsPerAccount ?? 1;
    const existing = usersDb.sessionsForUser(s.uid).filter(sid => sid !== req.sessionID);
    if (existing.length >= maxSuspended + 1) {
        // One active + at most N suspended per account: switching cannot
        // pyramid sessions. Revoke the oldest extras before granting another.
        usersDb.revokeSessionsForUser(s.uid);
        usersDb.registerSessionSid(req.sessionID, s.uid);
    }
    s.suspended = true;
    s.save(() => {
        usersDb.logEvent(s.uid, 'session.suspend', s.uname, 'info', null);
        res.json({ success: true, data: { suspended: true } });
    });
});

// Reverify: unlock / switch-resume. Verifies the secret against the
// targeted session's account, then clears locked/suspended state. This is
// the gate a remotely-revoked session cannot pass — the account row is gone.
router.post('/reverify', (req, res) => {
    const s = req.session || {};
    const { secret } = req.body || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'No session to re-verify' });
    }
    if (typeof secret !== 'string' || !secret) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'secret is required' });
    }
    const result = usersDb.verifyCredential(s.uid, secret, { kind: 'auto' });
    if (!result.ok) {
        // Same policy as /login: a wrong secret at the unlock sheet is a normal
        // form outcome, so it rides HTTP 200 with success:false + code (and the
        // lockout retryAfterMs) instead of lighting the console up with
        // "Failed to load resource … 401" on every mistyped unlock.
        res.status(200);
        return res.json({ success: false, code: result.code, message: result.message, retryAfterMs: result.retryAfterMs || undefined });
    }
    s.suspended = false;
    s.lockedAt = null;
    if (!s.csrfToken) s.csrfToken = generateCSRFToken();
    s.save(() => {
        usersDb.logEvent(s.uid, 'session.resume', s.uname, 'info', { via: result.via });
        res.json({
            success: true,
            data: {
                sessionId: req.sessionID,
                csrfToken: s.csrfToken,
                user: usersDb.toPublicUser(usersDb.getUser(s.uid)),
                mustChangePin: !!result.mustChangePin,
            },
        });
    });
});

// Change own PIN (also the forced new-PIN sheet after an admin reset or
// first-login-after-temporary-PIN).
router.post('/change-pin', (req, res) => {
    const s = req.session || {};
    const { currentSecret, newPin } = req.body || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });
    }
    if (typeof newPin !== 'string') {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'newPin is required' });
    }
    // The current secret is required unless the session is in the
    // forced-change state (temporary PIN already verified at login).
    if (!s.mustChangePin) {
        const check = typeof currentSecret === 'string' && currentSecret
            ? usersDb.verifyCredential(s.uid, currentSecret, { kind: 'auto' })
            : { ok: false };
        if (!check.ok) {
            // Wrong current secret on a settings form — normal outcome, HTTP 200
            // + success:false like the rest of the credential family (see /login).
            return res.json({ success: false, code: 'BAD_CREDENTIAL', message: 'Current PIN is incorrect' });
        }
    }
    try {
        usersDb.setCredential(s.uid, 'pin', newPin);
    } catch (err) {
        return res.status(400).json({ success: false, code: 'INVALID_PIN', message: err.message });
    }
    s.mustChangePin = false;
    s.save(() => res.json({ success: true, data: { changed: true } }));
});

// Change own passphrase.
router.post('/change-passphrase', (req, res) => {
    const s = req.session || {};
    const { currentSecret, passphrase } = req.body || {};
    if (!s.uid) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });
    }
    const check = typeof currentSecret === 'string' && currentSecret
        ? usersDb.verifyCredential(s.uid, currentSecret, { kind: 'auto' })
        : { ok: false };
    if (!check.ok) {
        // Wrong current secret on a settings form — normal outcome, HTTP 200
        // + success:false like the rest of the credential family (see /login).
        return res.json({ success: false, code: 'BAD_CREDENTIAL', message: 'Current secret is incorrect' });
    }
    try {
        usersDb.setCredential(s.uid, 'passphrase', passphrase === null || passphrase === undefined ? passphrase : String(passphrase));
    } catch (err) {
        return res.status(400).json({ success: false, code: 'INVALID_PASSPHRASE', message: err.message });
    }
    res.json({ success: true, data: { changed: true } });
});

// ── WebAuthn ───────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
    `https://localhost:${process.env.PORT || 3003}`,
    `https://127.0.0.1:${process.env.PORT || 3003}`,
    `http://localhost:${process.env.PORT || 3003}`,
    `http://127.0.0.1:${process.env.PORT || 3003}`,
]);

const webauthnChallenges = new Map(); // challengeB64u -> { uid, purpose, expires, credentialId? }

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of webauthnChallenges) {
        if (entry.expires < now) webauthnChallenges.delete(key);
    }
}, 60 * 1000).unref();

function b64u(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

function challengeEntry(purpose, uid, credentialId) {
    const challenge = b64u(crypto.randomBytes(32));
    webauthnChallenges.set(challenge, { purpose, uid, credentialId: credentialId || null, expires: Date.now() + 5 * 60 * 1000 });
    return challenge;
}

function takeChallenge(challengeB64u, purpose) {
    const entry = webauthnChallenges.get(challengeB64u);
    if (!entry || entry.purpose !== purpose || entry.expires < Date.now()) return null;
    webauthnChallenges.delete(challengeB64u);
    return entry;
}

function parseClientDataJSON(b64uText) {
    try {
        const json = JSON.parse(Buffer.from(String(b64uText), 'base64url').toString('utf8'));
        if (!json || typeof json !== 'object') return null;
        return json;
    } catch (_) { return null; }
}

function clientDataOk(json, expectedChallenge, expectedType) {
    if (!json) return false;
    if (json.type !== expectedType) return false;
    // The challenge is validated against the server-issued entry via
    // takeChallenge() below; when expectedChallenge is null it is skipped
    // here (register/finish flow).
    if (expectedChallenge && json.challenge !== expectedChallenge) return false;
    if (!ALLOWED_ORIGINS.has(json.origin)) return false;
    return true;
}

/** COSE key map (as produced by getPublicKey() → Array) → JWK. */
function coseToJwk(coseKey) {
    if (!Array.isArray(coseKey)) return null;
    const map = {};
    for (let i = 0; i + 1 < coseKey.length; i += 2) map[coseKey[i]] = coseKey[i + 1];
    const kty = map[1]; // 2 = EC2, 3 = RSA, 6 = OKP
    const alg = map[3];
    if (kty === 2) {
        const crv = map[-1];
        if (crv !== 1) return null; // P-256 only (ES256)
        return { kty: 'EC', crv: 'P-256', x: map[-2], y: map[-3], alg: alg || -7 };
    }
    if (kty === 3) {
        return { kty: 'RSA', n: map[-1], e: map[-2], alg: alg || -257 };
    }
    if (kty === 6) {
        const crv = map[-1];
        if (crv !== 6) return null; // Ed25519
        return { kty: 'OKP', crv: 'Ed25519', x: map[-2], alg: alg || -8 };
    }
    return null;
}

/** WebAuthn ECDSA signatures arrive as raw r||s; convert to DER for Node. */
function rawSignatureToDer(raw) {
    const buf = Buffer.from(raw);
    if (buf.length !== 64) return buf; // already DER (interop cases)
    const toInt = (half) => {
        let start = 0;
        while (start < half.length && half[start] === 0) start++;
        const stripped = half.subarray(start);
        const high = stripped.length > 0 && stripped[0] > 0x7f;
        const out = Buffer.alloc(stripped.length + (high ? 1 : 0));
        if (high) { out[0] = 0; stripped.copy(out, 1); } else if (stripped.length) stripped.copy(out, 0);
        return out;
    };
    const r = toInt(buf.subarray(0, 32));
    const s = toInt(buf.subarray(32, 64));
    // SEQUENCE { INTEGER r, INTEGER s } — for P-256, r and s are each
    // at most 33 bytes, so short-form lengths always apply.
    const body = 2 + r.length + 2 + s.length;
    const der = Buffer.alloc(2 + body);
    let offset = 0;
    der[offset++] = 0x30;
    der[offset++] = body;
    der[offset++] = 0x02; der[offset++] = r.length; r.copy(der, offset); offset += r.length;
    der[offset++] = 0x02; der[offset++] = s.length; s.copy(der, offset);
    return der;
}

const COSE_ALGS = { '-7': 'ES256', '-257': 'RS256', '-8': 'EdDSA' };

function verifyAssertionSignature({ alg, publicKeyJwk, authenticatorDataB64u, clientDataJSONB64u, signatureB64u }) {
    try {
        const key = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
        const message = Buffer.concat([
            Buffer.from(String(authenticatorDataB64u), 'base64url'),
            crypto.createHash('sha256').update(Buffer.from(String(clientDataJSONB64u), 'base64url')).digest(),
        ]);
        let signature = Buffer.from(String(signatureB64u), 'base64url');
        const hashAlg = COSE_ALGS[String(alg)] || 'RS256';
        if (hashAlg === 'ES256') signature = rawSignatureToDer(signature);
        if (hashAlg === 'EdDSA') return crypto.verify(null, message, key, signature);
        return crypto.verify('sha256', message, key, signature);
    } catch (_) {
        return false;
    }
}

// Registration, step 1: challenge + user entity + policy.
router.post('/webauthn/register/options', requireAdminRole, (req, res) => {
    // Admins may enroll on behalf of another account; self-enrollment for
    // standard users is their own uid.
    let targetUid = req.session.uid;
    if (typeof req.body?.uid === 'string' && req.body.uid && usersDb.ADMIN_ROLES.has(req.session.role)) {
        targetUid = req.body.uid;
    }
    const user = usersDb.getUser(targetUid);
    if (!user) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No such account' });
    const challenge = challengeEntry('register', user.uid);
    res.json({
        success: true,
        data: {
            challenge,
            user: {
                id: b64u(user.uid),
                name: user.username,
                displayName: user.display_name,
            },
            rp: { id: 'localhost', name: 'AstroOS' },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
                { type: 'public-key', alg: -8 },
            ],
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'discouraged',
            },
            timeout: 60000,
            attestation: 'none',
            excludeCredentials: usersDb.allowCredentialsForUser(user.uid).map(id => ({ type: 'public-key', id })),
        },
    });
});

// Registration, step 2: verify clientData + store the public key.
router.post('/webauthn/register/finish', requireAdminRole, (req, res) => {
    const { credentialId, publicKey, alg, clientDataJSON, label } = req.body || {};
    if (typeof credentialId !== 'string' || !credentialId || !Array.isArray(publicKey) || typeof clientDataJSON !== 'string') {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'credentialId, publicKey and clientDataJSON are required' });
    }
    const json = parseClientDataJSON(clientDataJSON);
    if (!clientDataOk(json, null, 'webauthn.create')) {
        return res.status(400).json({ success: false, code: 'WEBAUTHN_INVALID', message: 'Client data failed verification' });
    }
    const entry = takeChallenge(json.challenge, 'register');
    if (!entry) {
        return res.status(400).json({ success: false, code: 'WEBAUTHN_INVALID', message: 'Unknown or expired challenge' });
    }
    const jwk = coseToJwk(publicKey);
    if (!jwk) {
        return res.status(400).json({ success: false, code: 'WEBAUTHN_UNSUPPORTED', message: 'Only ES256, RS256 and Ed25519 credentials are supported' });
    }
    const algId = Number(alg) || jwk.alg;
    try {
        usersDb.addWebauthnCredential(entry.uid, credentialId, JSON.stringify(jwk), algId, label);
    } catch (err) {
        return res.status(400).json({ success: false, code: err.code || 'WEBAUTHN_ERROR', message: err.message });
    }
    res.json({ success: true, data: { enrolled: true } });
});

// Assertion, step 1: allowCredentials is scoped to ONE account — the picked
// one. Deliberately non-discoverable: a stolen authenticator cannot probe
// which accounts exist.
router.post('/webauthn/login/options', (req, res) => {
    const { uid } = req.body || {};
    if (typeof uid !== 'string' || !uid) {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'uid is required' });
    }
    const user = usersDb.getUser(uid);
    if (!user) {
        return res.status(404).json({ success: false, code: 'UNKNOWN_ACCOUNT', message: 'Unknown account' });
    }
    if (user.status === 'disabled') {
        return res.status(423).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account is disabled' });
    }
    if (user.locked) {
        return res.status(423).json({ success: false, code: 'ACCOUNT_LOCKED', message: 'Account locked — an administrator must unlock it' });
    }
    if (usersDb.isTemporarilyLocked(uid)) {
        return res.status(429).json({ success: false, code: 'LOCKOUT', message: 'Too many attempts — try again soon', retryAfterMs: usersDb.remainingLockoutMs(uid) });
    }
    const allow = usersDb.allowCredentialsForUser(uid);
    if (!allow.length) {
        return res.status(400).json({ success: false, code: 'NO_CREDENTIAL', message: 'This account has no enrolled authenticator' });
    }
    const challenge = challengeEntry('login', uid);
    res.json({
        success: true,
        data: {
            challenge,
            allowCredentials: allow.map(id => ({ type: 'public-key', id })),
            rpId: 'localhost',
            timeout: 60000,
            userVerification: 'required',
        },
    });
});

// Assertion, step 2: verify the signature server-side and establish session.
router.post('/webauthn/login/finish', (req, res) => {
    const { uid, credentialId, authenticatorData, clientDataJSON, signature } = req.body || {};
    if (typeof uid !== 'string' || typeof credentialId !== 'string' ||
        typeof authenticatorData !== 'string' || typeof clientDataJSON !== 'string' || typeof signature !== 'string') {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'uid, credentialId, authenticatorData, clientDataJSON and signature are required' });
    }
    const json = parseClientDataJSON(clientDataJSON);
    if (!clientDataOk(json, null, 'webauthn.get')) {
        return res.status(400).json({ success: false, code: 'WEBAUTHN_INVALID', message: 'Client data failed verification' });
    }
    const entry = takeChallenge(json.challenge, 'login');
    if (!entry || entry.uid !== uid) {
        return res.status(400).json({ success: false, code: 'WEBAUTHN_INVALID', message: 'Unknown, expired or cross-account challenge' });
    }
    const credential = usersDb.getWebauthnCredential(credentialId);
    if (!credential || credential.uid !== uid) {
        usersDb.recordAuthFailure(uid);
        return res.status(401).json({ success: false, code: 'WEBAUTHN_INVALID', message: 'Credential does not match this account' });
    }
    let publicKeyJwk;
    try { publicKeyJwk = JSON.parse(credential.public_key); } catch (_) { publicKeyJwk = null; }
    if (!publicKeyJwk) {
        return res.status(500).json({ success: false, code: 'WEBAUTHN_STORE', message: 'Stored credential is unreadable' });
    }
    const okSignature = verifyAssertionSignature({
        alg: credential.alg,
        publicKeyJwk,
        authenticatorDataB64u: authenticatorData,
        clientDataJSONB64u: clientDataJSON,
        signatureB64u: signature,
    });
    if (!okSignature) {
        const outcome = usersDb.recordAuthFailure(uid);
        usersDb.logEvent(uid, 'auth.failure', usersDb.getUser(uid)?.username || uid, 'warn', { via: 'webauthn', tier: outcome.tier });
        return res.status(401).json({ success: false, code: 'WEBAUTHN_SIGNATURE', message: 'Signature verification failed' });
    }
    // Sign counter: monotonic per credential — a regression means a clone.
    const authData = Buffer.from(authenticatorData, 'base64url');
    const counter = authData.length >= 37 ? authData.readUInt32BE(authData.length - 4) : 0;
    if (counter > 0 && counter <= (credential.sign_count || 0)) {
        usersDb.logEvent(uid, 'auth.webauthn.clone', usersDb.getUser(uid)?.username || uid, 'error', { credentialId: credentialId.slice(0, 12) + '…' });
        return res.status(401).json({ success: false, code: 'WEBAUTHN_CLONE', message: 'Authenticator signature counter regressed' });
    }
    usersDb.touchWebauthnUse(credentialId, counter);
    usersDb.resetAuthFailures(uid);
    usersDb.touchLogin(uid);
    const user = usersDb.getUser(uid);
    usersDb.logEvent(uid, 'auth.success', user.username, 'info', { via: 'webauthn' });
    establishSession(req, res, user, (err, payload) => {
        if (err) {
            return res.status(500).json({ success: false, code: 'SESSION_ERROR', message: 'Could not establish session' });
        }
        res.json({ success: true, data: { ...payload, via: 'webauthn' } });
    });
});

// Self-service: list own enrolled authenticators (Settings → Accounts).
router.get('/webauthn/credentials', (req, res) => {
    const s = req.session || {};
    if (!s.uid) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });
    res.json({ success: true, data: { credentials: usersDb.listWebauthnCredentials(s.uid) } });
});

router.delete('/webauthn/credentials/:credId', (req, res) => {
    const s = req.session || {};
    if (!s.uid) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });
    const removed = usersDb.removeWebauthnCredential(s.uid, req.params.credId, s.uid);
    if (!removed) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No such credential for this account' });
    res.json({ success: true, data: { removed: true } });
});

// ── Storage roots (server-side file work for archive/wipe/usage) ──────────

function usersStorageRoot() {
    // Accounts live as real, separated trees at <machine home>/users/
    // (users/<username>/ is the account's filesystem root).
    return path.join(os.homedir(), 'users');
}

function legacyUsersStorageRoot() {
    // The pre-flat layout: accounts nested under hidden machine state
    // (~/.local/share/novabyte/users/<name|uid>/…). Machines that have not
    // logged in since the layout upgrade still carry data here.
    return path.join(os.homedir(), '.local', 'share', 'novabyte', 'users');
}

function userStorageDirs(user) {
    // Every on-disk home this account may still occupy: the current
    // ~/users/<username> tree first, then the legacy nested-layout
    // locations (username- and uid-keyed). Archive/wipe/usage cover them all
    // so no bytes survive an account removal by hiding in an old root.
    const name = String(user?.username || '');
    const uid = String(user?.uid || '');
    const dirs = [];
    if (name) dirs.push(path.join(usersStorageRoot(), name));
    if (name || uid) {
        const base = legacyUsersStorageRoot();
        for (const seg of [name, uid]) {
            if (!seg) continue;
            const dir = path.join(base, seg);
            if (!dirs.includes(dir)) dirs.push(dir);
        }
    }
    return dirs;
}

function sharedRoot() {
    return path.join(os.homedir(), '.local', 'share', 'novabyte', 'shared');
}

function dirSizeBytes(target, depthBudget = 12) {
    let total = 0;
    const stack = [[target, depthBudget]];
    while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth < 0) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            try {
                if (entry.isDirectory()) stack.push([full, depth - 1]);
                else total += fs.statSync(full).size;
            } catch (_) { }
        }
    }
    return total;
}

// ── Admin family ───────────────────────────────────────────────────────────

router.get('/admin/users', requireAdminRole, (req, res) => {
    res.json({ success: true, data: { users: usersDb.listAdminUsers() } });
});

router.post('/admin/users', requireAdminRole, (req, res) => {
    const { displayName, username, pin, passphrase, role, avatar, quotaBytes } = req.body || {};
    if (typeof username !== 'string' || typeof pin !== 'string') {
        return res.status(400).json({ success: false, code: 'INVALID_ARGS', message: 'username and pin are required' });
    }
    if (role !== 'admin' && role !== 'standard') {
        return res.status(400).json({ success: false, code: 'INVALID_ROLE', message: "role must be 'admin' or 'standard'" });
    }
    try {
        const created = usersDb.createUser({ displayName, username, pin, passphrase, role, avatar, quotaBytes }, actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(created) } });
    } catch (err) {
        res.status(err.code === 'USERNAME_TAKEN' ? 409 : 400);
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.patch('/admin/users/:uid', requireAdminRole, (req, res) => {
    const patch = req.body || {};
    try {
        const updated = usersDb.updateUser(req.params.uid, patch, actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : (err.code === 'LAST_ADMIN' || err.code === 'OWNER_PROTECTED' ? 403 : 400));
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.post('/admin/users/:uid/disable', requireAdminRole, (req, res) => {
    try {
        const updated = usersDb.setStatus(req.params.uid, 'disabled', actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : (err.code === 'LAST_ADMIN' ? 403 : 400));
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.post('/admin/users/:uid/enable', requireAdminRole, (req, res) => {
    try {
        const updated = usersDb.setStatus(req.params.uid, 'active', actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.post('/admin/users/:uid/lock', requireAdminRole, (req, res) => {
    try {
        const updated = usersDb.setLocked(req.params.uid, true, actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.post('/admin/users/:uid/unlock', requireAdminRole, (req, res) => {
    try {
        const updated = usersDb.setLocked(req.params.uid, false, actorUid(req));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.post('/admin/users/:uid/force-logout', requireAdminRole, (req, res) => {
    const user = usersDb.getUser(req.params.uid);
    if (!user) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No such account' });
    const revoked = usersDb.revokeSessionsForUser(user.uid);
    usersDb.logEvent(actorUid(req), 'session.forceLogout', user.username, 'warn', { revokedSessions: revoked });
    res.json({ success: true, data: { revokedSessions: revoked } });
});

// Credential reset: issues a temporary PIN shown exactly once. The account's
// next login lands on a forced new-PIN sheet.
router.post('/admin/users/:uid/reset-credential', requireAdminRole, (req, res) => {
    try {
        const result = usersDb.resetCredential(req.params.uid, actorUid(req));
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

// Admin setting a PIN directly (front-desk provisioning).
router.post('/admin/users/:uid/credentials/pin', requireAdminRole, (req, res) => {
    const { pin } = req.body || {};
    try {
        const updated = usersDb.setCredential(req.params.uid, 'pin', String(pin ?? ''));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_PIN', message: err.message });
    }
});

router.post('/admin/users/:uid/credentials/passphrase', requireAdminRole, (req, res) => {
    const { passphrase } = req.body || {};
    try {
        const updated = usersDb.setCredential(req.params.uid, 'passphrase',
            passphrase === null || passphrase === undefined ? passphrase : String(passphrase));
        res.json({ success: true, data: { user: usersDb.toAdminUser(updated) } });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : 400);
        res.json({ success: false, code: err.code || 'INVALID_PASSPHRASE', message: err.message });
    }
});

router.get('/admin/users/:uid/webauthn', requireAdminRole, (req, res) => {
    const user = usersDb.getUser(req.params.uid);
    if (!user) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No such account' });
    res.json({ success: true, data: { credentials: usersDb.listWebauthnCredentials(user.uid) } });
});

router.delete('/admin/users/:uid/webauthn/:credId', requireAdminRole, (req, res) => {
    const removed = usersDb.removeWebauthnCredential(req.params.uid, req.params.credId, actorUid(req));
    if (!removed) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No such credential' });
    res.json({ success: true, data: { removed: true } });
});

// Deletion: archive copies the account's tree into the shared admin-backups
// folder; wipe removes the storage strata outright. Both refused for the
// owner and for the last active admin (transactional guard in users-db).
router.delete('/admin/users/:uid', requireAdminRole, (req, res) => {
    const mode = req.body?.mode === 'wipe' ? 'wipe' : (req.query.mode === 'wipe' ? 'wipe' : 'archive');
    let user;
    try {
        user = usersDb.getUser(req.params.uid);
        if (!user) throw Object.assign(new Error('No such account'), { code: 'NOT_FOUND' });
        const result = usersDb.deleteUser(req.params.uid, mode, actorUid(req));
        // Row-level guards passed — perform the file work for every on-disk
        // tree the account occupies (current ~/users/<name> + any legacy
        // nested-layout roots still holding bytes).
        const storageDirs = userStorageDirs(user).filter(dir => fs.existsSync(dir));
        const backupDir = path.join(sharedRoot(), 'admin-backups');
        if (mode === 'archive' && storageDirs.length) {
            fs.mkdirSync(backupDir, { recursive: true });
            const stamp = new Date().toISOString().slice(0, 10);
            const baseName = `${user.username}-${stamp}-${String(user.uid).slice(0, 8)}`;
            const archived = [];
            try {
                let suffix = 0;
                for (const dir of storageDirs) {
                    const target = suffix === 0
                        ? path.join(backupDir, baseName)
                        : path.join(backupDir, `${baseName}-legacy-${suffix}`);
                    suffix++;
                    fs.cpSync(dir, target, { recursive: true });
                    fs.rmSync(dir, { recursive: true, force: true });
                    archived.push(target);
                }
                result.archivedTo = archived.length === 1 ? archived[0] : archived;
            } catch (err) {
                result.archiveError = err.message;
            }
        } else if (mode === 'wipe' && storageDirs.length) {
            for (const dir of storageDirs) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
            }
        }
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(err.code === 'NOT_FOUND' ? 404 : (err.code === 'OWNER_PROTECTED' || err.code === 'LAST_ADMIN' ? 403 : 400));
        res.json({ success: false, code: err.code || 'INVALID_ARGS', message: err.message });
    }
});

router.get('/admin/policies', requireAdminRole, (req, res) => {
    res.json({ success: true, data: { policies: usersDb.getPolicyBlock() } });
});

router.put('/admin/policies', requireAdminRole, (req, res) => {
    try {
        const policies = usersDb.setPolicies(req.body || {});
        res.json({ success: true, data: { policies } });
    } catch (err) {
        res.status(400).json({ success: false, code: 'INVALID_POLICY', message: err.message });
    }
});

router.get('/admin/events', requireAdminRole, (req, res) => {
    const { uid, severity, action, limit, offset } = req.query || {};
    res.json({ success: true, data: usersDb.queryEvents({ uid, severity, action, limit, offset }) });
});

router.get('/admin/events/export', requireAdminRole, (req, res) => {
    const { uid, severity, action } = req.query || {};
    const csv = usersDb.eventsToCsv({ uid, severity, action });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="novabyte-account-events.csv"');
    res.send(csv);
});

// Per-account usage: the native tree byte count against the account quota.
// Counts every on-disk root the account occupies (current layout + legacy).
router.get('/admin/usage', requireAdminRole, (req, res) => {
    const users = usersDb.listAdminUsers();
    const data = users.map(user => ({
        uid: user.uid,
        username: user.username,
        quotaBytes: user.quotaBytes,
        usageBytes: userStorageDirs(user)
            .filter(dir => fs.existsSync(dir))
            .reduce((total, dir) => total + dirSizeBytes(dir), 0),
    }));
    res.json({ success: true, data: { usage: data } });
});

// Full account-store teardown — factory reset support. Owner only.
router.post('/admin/wipe', requireOwnerRole, (req, res) => {
    usersDb.wipeAll(req.session.uid);
    // Also drop every per-user storage root — the account trees and the
    // legacy nested roots — so the machine returns to first-boot state.
    try {
        for (const root of [usersStorageRoot(), legacyUsersStorageRoot()]) {
            if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
        }
    } catch (_) { }
    res.json({ success: true, data: { wiped: true } });
});

module.exports = router;
