/**
 * NovaByte - Security Routes
 * API endpoints for security management, audit logs, sessions, and settings
 */

const express = require('express');
const router = express.Router();

// Import services
const securityMiddleware = require('./middleware');

// No-op audit service stub (v3 audit logging service was stripped)
// In-memory failed login attempt tracking for rate limiting (SEC3)
const failedLoginAttempts = new Map(); // ip -> { count, lastAttempt, lockedUntil }

const auditService = {
    query: (filters) => [],
    getStatistics: () => ({}),
    log: (entry) => { /* no-op */ },
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
    exportLogs: (format, filters) => ''
};

// Cleanup expired login locks every 5 minutes
setInterval(() => {
    for (const [ip, record] of failedLoginAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil <= Date.now()) {
            failedLoginAttempts.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// In-memory session storage (would be database in production)
const sessions = new Map();

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
    securityMiddleware.validateRequest({
        query: {
            userId: { type: 'string' },
            action: { type: 'string' },
            resource: { type: 'string' },
            ipAddress: { type: 'string' },
            success: { type: 'string' },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            level: { type: 'string' },
            limit: { type: 'number', min: 1, max: 1000 },
            offset: { type: 'number', min: 0 }
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
                limit: parseInt(req.query.limit) || 100,
                offset: parseInt(req.query.offset) || 0
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

        // Get user's sessions
        const userSessions = Array.from(sessions.values())
            .filter(s => s.userId === userId && s.status === 'active')
            .map(s => ({
                id: s.id,
                createdAt: s.createdAt,
                lastActivity: s.lastActivity,
                ipAddress: s.ipAddress,
                userAgent: s.userAgent,
                current: s.id === req.sessionID
            }));

        // Admin can see all sessions
        const isAdmin = req.user?.role === 'admin';
        if (isAdmin) {
            const allSessions = Array.from(sessions.values())
                .filter(s => s.status === 'active')
                .map(s => ({
                    id: s.id,
                    userId: s.userId,
                    createdAt: s.createdAt,
                    lastActivity: s.lastActivity,
                    ipAddress: s.ipAddress,
                    userAgent: s.userAgent
                }));

            return res.json({
                success: true,
                data: allSessions,
                count: allSessions.length
            });
        }

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

        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Session not found'
            });
        }

        // Users can only revoke their own sessions unless admin
        const isAdmin = req.user?.role === 'admin';
        if (session.userId !== userId && !isAdmin) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Cannot revoke other user sessions'
            });
        }

        // Revoke the session
        session.status = 'revoked';
        session.revokedAt = new Date().toISOString();
        session.revokedBy = userId;

        auditService.log({
            action: 'session_revoke',
            userId,
            resource: 'session',
            resourceId: sessionId,
            success: true,
            metadata: { revokedSessionUser: session.userId }
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

// Helper function to register a session
function registerSession(sessionData) {
    sessions.set(sessionData.id, {
        ...sessionData,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString()
    });
}

// Helper function to update session activity
function updateSessionActivity(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.lastActivity = new Date().toISOString();
    }
}

module.exports = router;
module.exports.registerSession = registerSession;
module.exports.updateSessionActivity = updateSessionActivity;