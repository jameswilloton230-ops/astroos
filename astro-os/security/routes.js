/**
 * AstroOS - Security Routes
 * API endpoints for security management, audit logs, sessions, and settings
 */

const express = require('express');
const router = express.Router();

// Import services
const securityMiddleware = require('./middleware');
const ServerEventLog = require('../server/core/server-event-log');
const adminState = require('../server/security/admin-state');

// In-memory failed login attempt tracking for rate limiting (SEC3)
const failedLoginAttempts = new Map(); // ip -> { count, lastAttempt, lockedUntil }

// auditService.log now forwards into ServerEventLog so the entries these
// routes were already producing (login attempts, suspicious activity,
// settings changes) actually show up somewhere — the v3 audit store this
// was originally built against was stripped, leaving `log` a no-op.
// query/getStatistics/etc. stay stubs: those read back from that same
// stripped v3 store and have no equivalent here yet; ServerEventLog is a
// live ring buffer for the Events app timeline, not a queryable audit DB.
const auditService = {
    // query/getStatistics now read the real ServerEventLog ring buffer
    // (500 most-recent server-side events) instead of the stripped v3
    // audit store's always-empty stub. This is a live in-memory buffer,
    // not a persisted audit trail — see server-event-log.js's own header
    // comment — so results reset on server restart and only cover recent
    // activity, not full history. That's an honest limitation to surface
    // via admin:audit rather than silently pretend this is a real DB.
    query: (filters = {}) => {
        let logs = ServerEventLog.getAll();
        if (filters.userId) logs = logs.filter(e => e.data?.userId === filters.userId);
        if (filters.action) logs = logs.filter(e => e.data?.action === filters.action);
        if (filters.resource) logs = logs.filter(e => e.data?.resource === filters.resource);
        if (filters.level) logs = logs.filter(e => e.severity === filters.level);
        if (typeof filters.success === 'boolean') logs = logs.filter(e => e.data?.success === filters.success);
        if (filters.startDate) logs = logs.filter(e => e.timestamp >= new Date(filters.startDate).getTime());
        if (filters.endDate) logs = logs.filter(e => e.timestamp <= new Date(filters.endDate).getTime());
        // Newest first, matches the ring buffer's natural read pattern for a log viewer
        logs = logs.slice().reverse();
        const offset = filters.offset || 0;
        const limit = filters.limit || 100;
        return logs.slice(offset, offset + limit);
    },
    getStatistics: () => {
        const logs = ServerEventLog.getAll();
        const stats = { total: logs.length, bySeverity: {}, byApp: {} };
        for (const e of logs) {
            stats.bySeverity[e.severity] = (stats.bySeverity[e.severity] || 0) + 1;
            stats.byApp[e.app] = (stats.byApp[e.app] || 0) + 1;
        }
        return stats;
    },
    log: (entry) => {
        ServerEventLog.log({
            app: 'SecurityRoutes',
            severity: entry.success === false ? 'warn' : 'info',
            message: `${entry.resource || entry.action || 'security_event'}${entry.success === false ? ' — failed' : ''}`,
            data: entry,
        });
    },
    getFailedLoginAttempts: (ipAddress) => {
        const record = failedLoginAttempts.get(ipAddress);
        if (!record) return [];
        return [{
            ip: ipAddress,
            attempts: record.count,
            lastAttempt: record.lastAttempt,
            lockedUntil: record.lockedUntil
        }];
    },
    recordFailedLogin: (ipAddress) => {
        const record = failedLoginAttempts.get(ipAddress) || { count: 0, lastAttempt: 0 };
        record.count++;
        record.lastAttempt = Date.now();
        // Lock after 5 failures for 15 minutes
        if (record.count >= securitySettings.maxLoginAttempts) {
            record.lockedUntil = Date.now() + securitySettings.lockoutDuration;
        }
        failedLoginAttempts.set(ipAddress, record);
        return record;
    },
    resetFailedLogins: (ipAddress) => {
        failedLoginAttempts.delete(ipAddress);
    },
    isLoginLocked: (ipAddress) => {
        const record = failedLoginAttempts.get(ipAddress);
        if (!record || !record.lockedUntil) return false;
        if (record.lockedUntil <= Date.now()) {
            // Lock expired, reset
            failedLoginAttempts.delete(ipAddress);
            return false;
        }
        return true;
    },
    getSuspiciousActivities: (filters) => [],
    updateSuspiciousActivity: (id, status, notes) => null,
    exportLogs: (format, filters = {}) => {
        const logs = auditService.query(filters);
        if (format === 'csv') {
            const header = 'id,timestamp,app,severity,message\n';
            // SECURITY (2026-11-12 audit, finding L2): neutralize spreadsheet
            // formula execution (=, +, -, @, TAB, CR prefixes) in exported
            // cells so opening the CSV in Excel/LibreOffice cannot run a
            // formula smuggled in through log text.
            const escapeCell = (value) => {
                const text = value === null || value === undefined ? '' : String(value);
                const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
                return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
            };
            const rows = logs.map(e => [
                e.id, new Date(e.timestamp).toISOString(), e.app, e.severity,
                JSON.stringify(e.message || '')
            ].map(escapeCell).join(','));
            return header + rows.join('\n');
        }
        return JSON.stringify(logs, null, 2);
    }
};

/**
 * GET/POST /api/security/admin-mode - read/toggle the local admin flag.
 *
 * This is the one thing in this file that ISN'T gated by req.user.role
 * === 'admin' — that would be a lock-out (you can't turn admin mode on
 * if turning it on requires already being admin). Instead it relies on
 * two things that are already true for every route in this file:
 *   1. Guest .novaapp webviews run in a separate NW.js partition
 *      (persist:app_<id>) with their own cookie jar, so they can't reach
 *      this endpoint with the host shell's session cookie even if they
 *      fetch() the same-origin path directly.
 *   2. Global CSRF protection (createSecurityMiddleware, wired in
 *      server/middleware.js) rejects state-changing requests without a
 *      valid token, which only the host shell's own rendered page has
 *      access to.
 * So this is reachable only from the host shell itself (Settings app),
 * not from a sandboxed app pretending to be it.
 */
router.get('/admin-mode', async (req, res) => {
    try {
        res.json({ success: true, adminEnabled: adminState.isAdminEnabled() });
    } catch (error) {
        console.error('[Security Routes] Error reading admin mode:', error);
        res.status(500).json({ error: 'Internal Server Error', message: 'Failed to read admin mode' });
    }
});

router.post('/admin-mode',
    securityMiddleware.validateRequest({
        body: { enabled: { type: 'boolean', required: true } }
    }),
    async (req, res) => {
        try {
            // SECURITY (2026-11-12 audit, finding L1): in the multi-user
            // era the legacy single-user admin flag must not be flippable
            // by a standard-tier session. While the machine still has no
            // accounts (true single-user/first-boot), the toggle keeps its
            // original self-service semantics. Once users.db has rows,
            // only owner/admin roles may touch it.
            let accountsExist = false;
            try {
                const usersDb = require('./security/users-db');
                accountsExist = usersDb.hasAccounts();
            } catch (_) { /* users-db unavailable: keep legacy behaviour */ }
            if (accountsExist) {
                const isAdmin = req.user?.role === 'admin';
                const isRealAccount = !!(req.session && req.session.uid);
                if (!isAdmin || !isRealAccount) {
                    auditService.log({
                        action: 'security_event',
                        userId: req.user?.id,
                        resource: 'admin_mode',
                        success: false,
                        metadata: { reason: 'role_required', path: req.path }
                    });
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'An administrator account is required to change admin mode on a multi-user machine',
                        code: 'ADMIN_REQUIRED'
                    });
                }
            }
            const state = adminState.setAdminEnabled(req.body.enabled);
            auditService.log({
                action: 'config_change',
                userId: req.user?.id,
                resource: 'admin_mode',
                success: true,
                metadata: { adminEnabled: state.adminEnabled }
            });
            res.json({ success: true, adminEnabled: state.adminEnabled });
        } catch (error) {
            console.error('[Security Routes] Error setting admin mode:', error);
            res.status(500).json({ error: 'Internal Server Error', message: 'Failed to set admin mode' });
        }
    }
);


// Cleanup expired login locks every 5 minutes. unref()'d: this is background
// maintenance and must not keep the process (or a test runner) alive on its
// own — same contract as the credential-cleanup tick in email/credentials.js.
setInterval(() => {
    for (const [ip, record] of failedLoginAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil <= Date.now()) {
            failedLoginAttempts.delete(ip);
        }
    }
}, 5 * 60 * 1000).unref();

// The in-memory `sessions` Map this used to be was dead code — its only
// writer, registerSession() below, was exported but never called from
// anywhere in the app, so /sessions and DELETE /sessions/:id always saw an
// empty Map / 404'd on every id. The real session store already exists:
// middleware.js persists Express sessions to a SQLite `sessions` table
// (via better-sqlite3-session-store) at astro-os/data/sessions.db. This reads
// that table directly instead of maintaining a second, parallel, never-
// synced copy of the same data.
const path = require('path');
const Database = require('better-sqlite3');
const SESSION_DB_PATH = path.join(__dirname, '..', 'data', 'sessions.db');
let sessionDb = null;
function getSessionDb() {
    // Lazy-opened: this file loads before middleware.js has necessarily
    // created the DB/table on first run, so open on first actual read
    // rather than at module-load time.
    if (!sessionDb) {
        sessionDb = new Database(SESSION_DB_PATH, { fileMustExist: false });
        sessionDb.pragma('journal_mode = WAL');
    }
    return sessionDb;
}
// Reads all non-expired rows and parses each `sess` JSON blob. sess.user is
// what our own req.user middleware assigns — id (the sid itself, since
// there's no separate account system) and role. Rows from *before* that
// middleware existed, or sessions that never got a request routed through
// it, won't have a `user` key; those are surfaced with userId: null rather
// than dropped, since they're still real active sessions.
function listActiveSessions() {
    try {
        const db = getSessionDb();
        const rows = db.prepare(
            `SELECT sid, sess, expire FROM sessions WHERE datetime('now') < datetime(expire)`
        ).all();
        return rows.map(row => {
            let sess = {};
            try { sess = JSON.parse(row.sess); } catch (_) { /* corrupt row, skip parsing */ }
            return {
                id: row.sid,
                userId: sess.user?.id ?? null,
                role: sess.user?.role ?? null,
                createdAt: sess.cookie?.originalMaxAge ? undefined : undefined, // not tracked by this store; omitted rather than fabricated
                expiresAt: row.expire,
                ipAddress: sess.lastIp ?? null,
                userAgent: sess.lastUserAgent ?? null
            };
        });
    } catch (e) {
        // DB not created yet (fresh install, no requests served) — empty
        // is the correct answer, not an error.
        return [];
    }
}
function revokeSession(sid) {
    const db = getSessionDb();
    const result = db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
    return result.changes > 0;
}

// Security settings (would be database in production)
let securitySettings = {
    // Authentication settings
    passwordMinLength: 8,
    passwordRequireUppercase: true,
    passwordRequireLowercase: true,
    passwordRequireNumbers: true,
    passwordRequireSpecial: true,
    maxLoginAttempts: 5,
    lockoutDuration: 15 * 60 * 1000, // 15 minutes
    
    // Session settings
    sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
    maxConcurrentSessions: 5,
    requireReauthForSensitive: true,
    
    // IP settings
    enableIPBlocking: true,
    enableIPWhitelist: false,
    trustedProxies: ['127.0.0.1', '::1'],
    
    // Rate limiting
    rateLimitEnabled: true,
    rateLimitWindow: 15 * 60 * 1000, // 15 minutes
    rateLimitMax: 100,
    
    // Audit settings
    auditRetentionDays: 90,
    auditLogApiCalls: true,
    auditLogDataAccess: true,
    enableSuspiciousDetection: true,
    
    // CSRF settings
    csrfEnabled: true,
    
    // Two-factor authentication
    tfaRequired: false,
    tfaMethods: ['totp', 'email']
};

/**
 * GET /api/security/audit - Query audit logs (admin only)
 */
router.get('/audit', 
    // limit/offset arrive as query-string values, always strings — but
    // this app runs on Express 5, where req.query is a read-only getter
    // recomputed from the URL on every access. Assigning req.query[k] =
    // Number(...) (an earlier attempt at this fix) silently does nothing
    // in Express 5 — no error, the value just never changes — so
    // validateRequest's type:'number' check could never pass regardless.
    // Confirmed via a direct test against this exact express version.
    // Fix: validate limit/offset as numeric *strings* here (a pattern
    // check, not typeof), and let the handler's existing parseInt(...) ||
    // default calls do the real numeric coercion, same as it already did
    // for every other case (missing/invalid values falling back to
    // defaults).
    (req, res, next) => {
        for (const k of ['limit', 'offset']) {
            const v = req.query[k];
            if (v !== undefined && !/^\d+$/.test(String(v))) {
                return res.status(400).json({
                    error: 'Validation Failed',
                    message: 'Request validation failed',
                    details: [{ field: k, location: 'query', message: `${k} must be a non-negative integer` }]
                });
            }
        }
        next();
    },
    securityMiddleware.validateRequest({
        query: {
            userId: { type: 'string' },
            action: { type: 'string' },
            resource: { type: 'string' },
            ipAddress: { type: 'string' },
            success: { type: 'string' },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            level: { type: 'string' }
            // limit/offset intentionally NOT declared here anymore — see
            // the numeric-string check above, which replaces them. They
            // can never be type:'number' against a real Express 5
            // req.query, whose values are always strings.
        }
    }),
    async (req, res) => {
        try {
            // Check admin permissions (would verify with actual auth system)
            const isAdmin = req.user?.role === 'admin' || req.user?.permissions?.includes('admin:audit');
            
            if (!isAdmin) {
                // Non-admins can only see their own logs
                req.query.userId = req.user?.id;
            }

            const filters = {
                userId: req.query.userId,
                action: req.query.action,
                resource: req.query.resource,
                ipAddress: req.query.ipAddress,
                success: req.query.success === 'true' ? true : req.query.success === 'false' ? false : undefined,
                startDate: req.query.startDate,
                endDate: req.query.endDate,
                level: req.query.level,
                limit: Math.min(1000, Math.max(1, parseInt(req.query.limit) || 100)),
                offset: Math.max(0, parseInt(req.query.offset) || 0)
            };

            const logs = auditService.query(filters);
            const stats = auditService.getStatistics();

            auditService.log({
                action: 'security_event',
                userId: req.user?.id,
                resource: 'audit_logs',
                success: true,
                metadata: { action: 'query_audit_logs', filters: { ...filters, userId: undefined } }
            });

            res.json({
                success: true,
                data: logs,
                pagination: {
                    limit: filters.limit,
                    offset: filters.offset,
                    total: logs.length
                },
                statistics: stats
            });
        } catch (error) {
            console.error('[Security Routes] Error querying audit logs:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to query audit logs'
            });
        }
    }
);

/**
 * GET /api/security/sessions - List active sessions
 */
router.get('/sessions', async (req, res) => {
    try {
        const userId = req.user?.id;
        
        if (!userId) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Authentication required'
            });
        }

        const all = listActiveSessions();
        const isAdmin = req.user?.role === 'admin';

        if (isAdmin) {
            const allSessions = all.map(s => ({ ...s, current: s.id === req.sessionID }));
            return res.json({
                success: true,
                data: allSessions,
                count: allSessions.length
            });
        }

        // Non-admins only see their own session — in this single-user OS
        // "their own" means the current browser session itself, since
        // there's no separate account system distinguishing sessions by
        // user beyond the session id.
        const userSessions = all
            .filter(s => s.id === req.sessionID)
            .map(s => ({ ...s, current: true }));

        res.json({
            success: true,
            data: userSessions,
            count: userSessions.length
        });
    } catch (error) {
        console.error('[Security Routes] Error listing sessions:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to list sessions'
        });
    }
});

/**
 * DELETE /api/security/sessions/:id - Revoke session
 */
router.delete('/sessions/:id', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const userId = req.user?.id;
        
        if (!userId) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Authentication required'
            });
        }

        const all = listActiveSessions();
        const session = all.find(s => s.id === sessionId);

        if (!session) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Session not found'
            });
        }

        // Users can only revoke their own sessions unless admin
        const isAdmin = req.user?.role === 'admin';
        if (session.id !== req.sessionID && !isAdmin) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Cannot revoke other user sessions'
            });
        }

        // Revoke the session — actually deletes the row from the SQLite
        // store (which is what express-session/SqliteStore checks on
        // every request), not a status flag on a detached copy, so this
        // takes effect immediately rather than silently doing nothing.
        const revoked = revokeSession(sessionId);
        if (!revoked) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Session not found'
            });
        }

        auditService.log({
            action: 'session_revoke',
            userId,
            resource: 'session',
            resourceId: sessionId,
            success: true,
            metadata: { revokedSessionUser: session.userId, revokedSelf: session.id === req.sessionID }
        });

        res.json({
            success: true,
            message: 'Session revoked successfully'
        });
    } catch (error) {
        console.error('[Security Routes] Error revoking session:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to revoke session'
        });
    }
});

/**
 * POST /api/security/report - Report suspicious activity
 */
router.post('/report',
    securityMiddleware.validateRequest({
        body: {
            type: { type: 'string', required: true, enum: ['suspicious_login', 'phishing', 'malware', 'data_breach', 'other'] },
            description: { type: 'string', required: true, minLength: 10, maxLength: 2000 },
            evidence: { type: 'object' },
            ipAddress: { type: 'string' },
            timestamp: { type: 'string' }
        }
    }),
    async (req, res) => {
        try {
            const { type, description, evidence, ipAddress, timestamp } = req.body;
            const userId = req.user?.id;

            // Log the report
            const report = {
                id: require('uuid').v4(),
                type,
                description,
                evidence: evidence || {},
                reportedBy: userId,
                ipAddress: ipAddress || securityMiddleware.getClientIP(req),
                timestamp: timestamp || new Date().toISOString(),
                status: 'pending',
                createdAt: new Date().toISOString()
            };

            auditService.log({
                action: 'security_event',
                userId,
                resource: 'security_report',
                resourceId: report.id,
                success: true,
                metadata: { reportType: type }
            });

            // Check for suspicious patterns and potentially block IP
            if (type === 'suspicious_login' && ipAddress) {
                const attempts = auditService.getFailedLoginAttempts(ipAddress);
                // Record this failed login attempt
                auditService.recordFailedLogin(ipAddress);
                const updatedRecord = auditService.getFailedLoginAttempts(ipAddress)[0];
                
                // Block IP if too many attempts
                if (updatedRecord && updatedRecord.attempts >= securitySettings.maxLoginAttempts) {
                    securityMiddleware.blockIP(ipAddress, `Multiple failed login attempts (${updatedRecord.attempts})`);
                }
            }

            res.status(201).json({
                success: true,
                message: 'Report submitted successfully',
                reportId: report.id
            });
        } catch (error) {
            console.error('[Security Routes] Error reporting suspicious activity:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to submit report'
            });
        }
    }
);

/**
 * GET /api/security/settings - Get security settings
 */
router.get('/settings', async (req, res) => {
    try {
        const userId = req.user?.id;
        const isAdmin = req.user?.role === 'admin';

        if (!isAdmin) {
            // Non-admins get limited settings
            return res.json({
                success: true,
                data: {
                    tfaRequired: securitySettings.tfaRequired,
                    sessionTimeout: securitySettings.sessionTimeout,
                    maxConcurrentSessions: securitySettings.maxConcurrentSessions
                }
            });
        }

        // Admins get full settings (except secrets)
        const adminSettings = {
            ...securitySettings,
            // Mask sensitive data
            _meta: {
                editable: [
                    'passwordMinLength',
                    'passwordRequireUppercase',
                    'passwordRequireLowercase',
                    'passwordRequireNumbers',
                    'passwordRequireSpecial',
                    'maxLoginAttempts',
                    'lockoutDuration',
                    'sessionTimeout',
                    'maxConcurrentSessions',
                    'enableIPBlocking',
                    'rateLimitEnabled',
                    'rateLimitWindow',
                    'rateLimitMax',
                    'auditRetentionDays',
                    'auditLogApiCalls',
                    'enableSuspiciousDetection',
                    'csrfEnabled',
                    'tfaRequired'
                ]
            }
        };

        res.json({
            success: true,
            data: adminSettings
        });
    } catch (error) {
        console.error('[Security Routes] Error getting security settings:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to get security settings'
        });
    }
});

/**
 * PUT /api/security/settings - Update security settings
 */
router.put('/settings',
    securityMiddleware.validateRequest({
        body: {
            passwordMinLength: { type: 'number', min: 8, max: 128 },
            passwordRequireUppercase: { type: 'boolean' },
            passwordRequireLowercase: { type: 'boolean' },
            passwordRequireNumbers: { type: 'boolean' },
            passwordRequireSpecial: { type: 'boolean' },
            maxLoginAttempts: { type: 'number', min: 3, max: 10 },
            lockoutDuration: { type: 'number', min: 60000 },
            sessionTimeout: { type: 'number', min: 3600000 },
            maxConcurrentSessions: { type: 'number', min: 1, max: 10 },
            enableIPBlocking: { type: 'boolean' },
            rateLimitEnabled: { type: 'boolean' },
            rateLimitWindow: { type: 'number', min: 60000 },
            rateLimitMax: { type: 'number', min: 10 },
            auditRetentionDays: { type: 'number', min: 7, max: 365 },
            auditLogApiCalls: { type: 'boolean' },
            enableSuspiciousDetection: { type: 'boolean' },
            csrfEnabled: { type: 'boolean' },
            tfaRequired: { type: 'boolean' }
        }
    }),
    async (req, res) => {
        try {
            const isAdmin = req.user?.role === 'admin';

            if (!isAdmin) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Admin access required to modify security settings'
                });
            }

            const updates = req.body;
            const editableFields = securitySettings._meta?.editable || [];

            const allowedUpdates = {};
            for (const [key, value] of Object.entries(updates)) {
                // Check if field is editable
                if (editableFields.length > 0 && !editableFields.includes(key)) {
                    continue;
                }
                allowedUpdates[key] = value;
            }

            // Update settings
            securitySettings = { ...securitySettings, ...allowedUpdates };

            // Apply some settings immediately
            if (allowedUpdates.enableIPBlocking !== undefined) {
                securityMiddleware.configure({ enableIpBlocking: allowedUpdates.enableIPBlocking });
            }

            auditService.log({
                action: 'config_change',
                userId: req.user.id,
                resource: 'security_settings',
                success: true,
                metadata: { changes: Object.keys(allowedUpdates) }
            });

            res.json({
                success: true,
                message: 'Security settings updated successfully',
                updated: Object.keys(allowedUpdates)
            });
        } catch (error) {
            console.error('[Security Routes] Error updating security settings:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to update security settings'
            });
        }
    }
);

/**
 * GET /api/security/blocked-ips - Get blocked IPs (admin only)
 */
router.get('/blocked-ips', async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'admin';
        
        if (!isAdmin) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Admin access required'
            });
        }

        const blockedIPs = securityMiddleware.getBlockedIPs();
        
        res.json({
            success: true,
            data: blockedIPs,
            count: blockedIPs.length
        });
    } catch (error) {
        console.error('[Security Routes] Error getting blocked IPs:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to get blocked IPs'
        });
    }
});

/**
 * POST /api/security/blocked-ips - Block an IP (admin only)
 */
router.post('/blocked-ips',
    securityMiddleware.validateRequest({
        body: {
            ip: { type: 'string', required: true },
            reason: { type: 'string', maxLength: 500 }
        }
    }),
    async (req, res) => {
        try {
            const isAdmin = req.user?.role === 'admin';
            
            if (!isAdmin) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Admin access required'
                });
            }

            const { ip, reason } = req.body;
            
            if (securityMiddleware.isIPBlocked(ip)) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: 'IP already blocked'
                });
            }

            securityMiddleware.blockIP(ip, reason);

            res.status(201).json({
                success: true,
                message: `IP ${ip} blocked successfully`
            });
        } catch (error) {
            console.error('[Security Routes] Error blocking IP:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to block IP'
            });
        }
    }
);

/**
 * DELETE /api/security/blocked-ips/:ip - Unblock an IP (admin only)
 */
router.delete('/blocked-ips/:ip', async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'admin';
        
        if (!isAdmin) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Admin access required'
            });
        }

        const ip = req.params.ip;
        
        if (!securityMiddleware.isIPBlocked(ip)) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'IP not found in blocklist'
            });
        }

        securityMiddleware.unblockIP(ip);

        res.json({
            success: true,
            message: `IP ${ip} unblocked successfully`
        });
    } catch (error) {
        console.error('[Security Routes] Error unblocking IP:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to unblock IP'
        });
    }
});

/**
 * GET /api/security/suspicious - Get suspicious activities (admin only)
 */
router.get('/suspicious', async (req, res) => {
    try {
        const isAdmin = req.user?.role === 'admin';
        
        if (!isAdmin) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Admin access required'
            });
        }

        const filters = {
            status: req.query.status,
            type: req.query.type,
            userId: req.query.userId
        };

        const activities = auditService.getSuspiciousActivities(filters);

        res.json({
            success: true,
            data: activities,
            count: activities.length
        });
    } catch (error) {
        console.error('[Security Routes] Error getting suspicious activities:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to get suspicious activities'
        });
    }
});

/**
 * PATCH /api/security/suspicious/:id - Update suspicious activity status (admin only)
 */
router.patch('/suspicious/:id',
    securityMiddleware.validateRequest({
        body: {
            status: { type: 'string', required: true, enum: ['investigating', 'confirmed', 'false_positive', 'resolved'] },
            notes: { type: 'string', maxLength: 2000 }
        }
    }),
    async (req, res) => {
        try {
            const isAdmin = req.user?.role === 'admin';
            
            if (!isAdmin) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Admin access required'
                });
            }

            const { status, notes } = req.body;
            const activity = auditService.updateSuspiciousActivity(req.params.id, status, notes);

            if (!activity) {
                return res.status(404).json({
                    error: 'Not Found',
                    message: 'Suspicious activity not found'
                });
            }

            auditService.log({
                action: 'security_event',
                userId: req.user.id,
                resource: 'suspicious_activity',
                resourceId: req.params.id,
                success: true,
                metadata: { status, notes: notes?.substring(0, 100) }
            });

            res.json({
                success: true,
                message: 'Suspicious activity updated',
                data: activity
            });
        } catch (error) {
            console.error('[Security Routes] Error updating suspicious activity:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to update suspicious activity'
            });
        }
    }
);

/**
 * POST /api/security/export - Export audit logs (admin only)
 */
router.post('/export',
    securityMiddleware.validateRequest({
        body: {
            format: { type: 'string', required: true, enum: ['json', 'csv'] },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            userId: { type: 'string' }
        }
    }),
    async (req, res) => {
        try {
            const isAdmin = req.user?.role === 'admin';
            
            if (!isAdmin) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Admin access required'
                });
            }

            const { format, startDate, endDate, userId } = req.body;

            const filters = {
                startDate,
                endDate,
                userId
            };

            const data = auditService.exportLogs(format, filters);

            auditService.log({
                action: 'security_event',
                userId: req.user.id,
                resource: 'audit_export',
                success: true,
                metadata: { format, filters: { ...filters, userId: undefined } }
            });

            res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.${format}"`);
            res.send(data);
        } catch (error) {
            console.error('[Security Routes] Error exporting audit logs:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to export audit logs'
            });
        }
    }
);


module.exports = router;