/**
 * NovaByte - Security Middleware
 * Express security middleware for request validation, CSRF protection,
 * XSS prevention, IP blocking/throttling, and input sanitization
 */

const crypto = require('crypto');

// auditService stub — logs security events to console.
// Replace with a real audit logger if needed.
const auditService = { log: (e) => console.log('[Audit]', JSON.stringify(e)) };

// Configuration
let config = {
    csrfSecret: crypto.randomBytes(32).toString('hex'),
    csrfTokenLength: 32,
    enableCsrfProtection: true,
    enableIpBlocking: true,
    enableRequestValidation: true,
    enableInputSanitization: true,
    maxRequestSize: '10mb',
    blockedIPs: new Set(),
    trustedProxies: ['127.0.0.1', '::1'],
    rateLimitOverride: null,
    // CSRF exempt paths - endpoints that don't require CSRF tokens
    csrfExempt: [
        // Health checks
        '/health',
        '/api/health',
        '/api/info',

        // Browser proxy service
        '/api/security/strip-tracking',

        // Packaged .novaapp files are registered by the local shell before
        // launching a sandboxed webview; the route validates sandbox ids.
        '/api/apps/serve',

        // Email API — already session-protected via requireCreds; CSRF here
        // causes Invalid CSRF Token errors due to session/cookie timing in NW.js
        '/api/email',
    ],
};

// In-memory IP blocking (would be database in production)
const ipBlockList = new Set();
const ipThrottle = new Map();

/**
 * Get client IP from request
 * @param {object} req - Express request object
 * @returns {string}
 */
function getClientIP(req) {
    // Check for trusted proxy headers
    const trusted = config.trustedProxies.includes(req.ip) ||
        config.trustedProxies.includes(req.socket.remoteAddress);

    if (trusted) {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            return forwarded.split(',')[0].trim();
        }
    }

    return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Configure security middleware
 * @param {object} options - Configuration options
 */
function configure(options) {
    config = { ...config, ...options };
    if (options.blockedIPs) {
        options.blockedIPs.forEach(ip => ipBlockList.add(ip));
    }
}

/**
 * IP Blocking middleware
 */
function ipBlocking(req, res, next) {
    if (!config.enableIpBlocking) {
        return next();
    }

    const clientIP = getClientIP(req);

    if (ipBlockList.has(clientIP)) {
        auditService.log({
            action: 'security_event',
            ipAddress: clientIP,
            resource: 'ip_block',
            success: false,
            metadata: { reason: 'blocked_ip', path: req.path }
        });

        return res.status(403).json({
            error: 'Access Denied',
            message: 'Your IP address has been blocked',
            code: 'IP_BLOCKED'
        });
    }

    next();
}

/**
 * IP Throttling middleware (stricter than general rate limiting)
 */
function ipThrottleMiddleware(req, res, next) {
    // Exclude static assets and Process Inspector polling from strict throttling
    if (
        req.path.startsWith('/assets/') ||
        req.path.startsWith('/js/') ||
        req.path.startsWith('/css/') ||
        req.path.startsWith('/public/') ||
        /^\/(api\/)?(sysinfo|processes)/.test(req.path)
    ) {
        return next();
    }
    // Email API is already session-protected; don't throttle folder switching
    if (req.path.startsWith('/api/email/')) {
        return next();
    }
    // Email image proxy — localhost-only, fires once per inline image per email;
    // a single HTML email can have 20+ images, easily blowing past 30/min
    if (req.path.startsWith('/api/email-image')) {
        return next();
    }
    // Search suggest proxy — fires on every keystroke (debounced to ~120ms);
    // has its own dedicated suggestLimiter (120/min) in server.js
    if (req.path.startsWith('/api/suggest')) {
        return next();
    }
    // Favicon proxy — has its own dedicated faviconLimiter in server.js
    if (req.path.startsWith('/api/favicon')) {
        return next();
    }

    const clientIP = getClientIP(req);
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = 30;

    if (!ipThrottle.has(clientIP)) {
        ipThrottle.set(clientIP, { count: 1, resetTime: now + windowMs });
        return next();
    }

    const throttleData = ipThrottle.get(clientIP);

    // Reset window
    if (now > throttleData.resetTime) {
        ipThrottle.set(clientIP, { count: 1, resetTime: now + windowMs });
        return next();
    }

    // Check limit
    if (throttleData.count >= maxRequests) {
        auditService.log({
            action: 'security_event',
            ipAddress: clientIP,
            resource: 'rate_limit',
            success: false,
            metadata: {
                path: req.path,
                method: req.method,
                exceeded: true
            }
        });

        return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            retryAfter: Math.ceil((throttleData.resetTime - now) / 1000)
        });
    }

    throttleData.count++;
    next();
}

/**
 * Generate CSRF token
 * @returns {string}
 */
function generateCSRFToken() {
    const token = crypto.randomBytes(config.csrfTokenLength).toString('hex');
    return token;
}

/**
 * CSRF Protection middleware
 */
function csrfProtection(req, res, next) {
    if (!config.enableCsrfProtection) {
        return next();
    }

    // Skip for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Check if path is exempt from CSRF protection
    // Support exact-match and prefix-match (e.g. '/api/email' covers all sub-paths)
    if (config.csrfExempt && config.csrfExempt.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        return next();
    }
    // Ultraviolet bare server proxy — never has CSRF tokens
    if (req.path.startsWith('/bare/')) {
        return next();
    }

    // Driver installation API — part of first-time OS setup, no CSRF tokens available yet
    if (req.path.startsWith('/api/drivers/')) {
        req.csrfSkip = true;
        return next();
    }

    // Check for CSRF token
    const token = req.headers['x-csrf-token'] ||
        req.body._csrf ||
        req.query._csrf;

    if (!token) {
        auditService.log({
            action: 'security_event',
            userId: req.user?.id,
            ipAddress: getClientIP(req),
            resource: 'csrf',
            success: false,
            metadata: { reason: 'missing_token', path: req.path }
        });

        return res.status(403).json({
            error: 'CSRF Token Required',
            message: 'Missing CSRF token',
            code: 'CSRF_MISSING'
        });
    }

    // Verify token using constant-time comparison to prevent timing attacks
    const sessionToken = req.session?.csrfToken;

    // Check if session token exists
    if (!sessionToken) {
        return res.status(403).json({
            error: 'Invalid CSRF Token',
            message: 'CSRF token validation failed - no session',
            code: 'CSRF_INVALID'
        });
    }

    // Check token length before comparison to avoid buffer length error
    if (token.length !== sessionToken.length) {
        return res.status(403).json({
            error: 'Invalid CSRF Token',
            message: 'CSRF token validation failed - length mismatch',
            code: 'CSRF_INVALID'
        });
    }

    // Safe comparison
    const tokenBuffer = Buffer.from(token);
    const sessionBuffer = Buffer.from(sessionToken);

    if (!crypto.timingSafeEqual(tokenBuffer, sessionBuffer)) {
        // Log failed verification
        auditService.log({
            action: 'security_event',
            userId: req.user?.id,
            ipAddress: getClientIP(req),
            resource: 'csrf',
            success: false,
            metadata: { reason: 'invalid_token', path: req.path }
        });

        return res.status(403).json({
            error: 'Invalid CSRF Token',
            message: 'CSRF token validation failed',
            code: 'CSRF_INVALID'
        });
    }


    next();
}

/**
 * Add CSRF token to response locals
 */
function csrfTokenMiddleware(req, res, next) {
    if (!req.session) {
        req.session = {};
    }

    if (!req.session.csrfToken) {
        req.session.csrfToken = generateCSRFToken();
        // Force-save the session immediately so the token persists even when
        // saveUninitialized is false (i.e. on a brand-new session with no prior data).
        // IMPORTANT: next() must wait for this save to finish — calling it
        // immediately marks the session as already-saved for this request,
        // so later mutations (e.g. emailCredsEncrypted set further down the
        // chain) can silently fail to persist once the response ends.
        if (typeof req.session.save === 'function') {
            return req.session.save(() => {
                res.locals.csrfToken = req.session.csrfToken;
                next();
            });
        }
    }

    res.locals.csrfToken = req.session.csrfToken;
    next();
}

/**
 * Input sanitization middleware
 */
function inputSanitization(req, res, next) {
    if (!config.enableInputSanitization) return next();
    if (req.path.startsWith('/api/repair/')) return next();

    // Optional: skip backups too (they can contain raw file data)
    if (req.path.startsWith('/api/backups/')) return next();

    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeObject(req.body);
    }

    if (req.query && typeof req.query === 'object') {
        req.query = sanitizeObject(req.query);
    }

    next();
}

/**
 * Recursively sanitize object values
 * @param {any} obj - Object to sanitize
 * @returns {any} Sanitized object
 */
function sanitizeObject(obj) {
    if (typeof obj === 'string') {
        return sanitizeString(obj);
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
    }

    if (obj && typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            sanitized[key] = sanitizeObject(value);
        }
        return sanitized;
    }

    return obj;
}

/**
 * Sanitize string to prevent XSS
 * @param {string} str - String to sanitize
 * @returns {string}
 */
function sanitizeString(str) {
    if (typeof str !== 'string') return str;

    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * Request validation middleware factory
 * @param {object} schema - Validation schema
 * @returns {function} Validation middleware
 */
function validateRequest(schema) {
    return (req, res, next) => {
        if (!config.enableRequestValidation) {
            return next();
        }

        const errors = [];

        // Validate body
        if (schema.body && req.body) {
            const bodyErrors = validateAgainstSchema(req.body, schema.body);
            errors.push(...bodyErrors.map(e => ({ location: 'body', ...e })));
        }

        // Validate query
        if (schema.query && req.query) {
            const queryErrors = validateAgainstSchema(req.query, schema.query);
            errors.push(...queryErrors.map(e => ({ location: 'query', ...e })));
        }

        // Validate params
        if (schema.params && req.params) {
            const paramErrors = validateAgainstSchema(req.params, schema.params);
            errors.push(...paramErrors.map(e => ({ location: 'params', ...e })));
        }

        if (errors.length > 0) {
            auditService.log({
                action: 'security_event',
                userId: req.user?.id,
                ipAddress: getClientIP(req),
                resource: 'validation',
                success: false,
                metadata: { errors, path: req.path }
            });

            return res.status(400).json({
                error: 'Validation Failed',
                message: 'Request validation failed',
                details: errors
            });
        }

        next();
    };
}

/**
 * Validate data against schema
 * @param {object} data - Data to validate
 * @param {object} schema - Validation schema
 * @returns {array} Array of errors
 */
function validateAgainstSchema(data, schema) {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
        const value = data[field];

        // Required check
        if (rules.required && (value === undefined || value === null || value === '')) {
            errors.push({ field, message: `${field} is required` });
            continue;
        }

        // Skip further validation if not present and not required
        if (value === undefined || value === null) {
            continue;
        }

        // Type check
        if (rules.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            if (actualType !== rules.type) {
                errors.push({ field, message: `${field} must be of type ${rules.type}` });
                continue;
            }
        }

        // String validations
        if (typeof value === 'string') {
            if (rules.minLength && value.length < rules.minLength) {
                errors.push({ field, message: `${field} must be at least ${rules.minLength} characters` });
            }
            if (rules.maxLength && value.length > rules.maxLength) {
                errors.push({ field, message: `${field} must be at most ${rules.maxLength} characters` });
            }
            if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
                errors.push({ field, message: `${field} has invalid format` });
            }
        }

        // Number validations
        if (typeof value === 'number') {
            if (rules.min !== undefined && value < rules.min) {
                errors.push({ field, message: `${field} must be at least ${rules.min}` });
            }
            if (rules.max !== undefined && value > rules.max) {
                errors.push({ field, message: `${field} must be at most ${rules.max}` });
            }
        }

        // Enum check
        if (rules.enum && !rules.enum.includes(value)) {
            errors.push({ field, message: `${field} must be one of: ${rules.enum.join(', ')}` });
        }
    }

    return errors;
}

/**
 * Security headers middleware (additional to Helmet)
 */
function securityHeaders(req, res, next) {
    // Prevent clickjacking — SAMEORIGIN allows same-origin iframes (e.g. app sandbox).
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions Policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // Origin-Agent-Cluster — set uniformly on every response to avoid the
    // browser warning about site-keyed vs origin-keyed agent clusters.
    // Helmet's own header is disabled via originAgentCluster: false in server.js.
    res.setHeader('Origin-Agent-Cluster', '?1');

    // Cache control for sensitive data
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }

    next();
}

/**
 * Block an IP address
 * @param {string} ip - IP address to block
 * @param {string} reason - Reason for blocking
 */
function blockIP(ip, reason = '') {
    ipBlockList.add(ip);

    auditService.log({
        action: 'security_event',
        resource: 'ip_block',
        success: true,
        metadata: { ip, reason, action: 'block' }
    });
}

/**
 * Unblock an IP address
 * @param {string} ip - IP address to unblock
 */
function unblockIP(ip) {
    ipBlockList.delete(ip);

    auditService.log({
        action: 'security_event',
        resource: 'ip_block',
        success: true,
        metadata: { ip, action: 'unblock' }
    });
}

/**
 * Check if IP is blocked
 * @param {string} ip - IP address
 * @returns {boolean}
 */
function isIPBlocked(ip) {
    return ipBlockList.has(ip);
}

/**
 * Get blocked IPs list
 * @returns {array}
 */
function getBlockedIPs() {
    return Array.from(ipBlockList);
}

/**
 * Request size limiting middleware
 */
function requestSizeLimit(maxSize = '10mb') {
    return (req, res, next) => {
        if (req.path === '/api/apps/serve/register') {
            return next();
        }

        const contentLength = parseInt(req.headers['content-length'] || '0');
        const maxBytes = parseSize(maxSize);

        if (contentLength > maxBytes) {
            return res.status(413).json({
                error: 'Payload Too Large',
                message: 'Request body too large',
                maxSize
            });
        }

        next();
    };
}

/**
 * Parse size string to bytes
 * @param {string} size - Size string (e.g., '10mb')
 * @returns {number}
 */
function parseSize(size) {
    const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
    const match = size.toLowerCase().match(/^(\d+)(b|kb|mb|gb)?$/);
    if (!match) return 10 * 1024 * 1024;
    return parseInt(match[1]) * (units[match[2] || 'b']);
}

/**
 * Method validation middleware
 */
function validateMethod(allowedMethods = ['GET', 'POST', 'PUT', 'DELETE']) {
    return (req, res, next) => {
        if (!allowedMethods.includes(req.method)) {
            return res.status(405).json({
                error: 'Method Not Allowed',
                message: `Method ${req.method} not allowed`,
                allowedMethods
            });
        }
        next();
    };
}

/**
 * URL validation middleware
 */
function validateURL(req, res, next) {
    // High-performance shortcut: skip validation entirely for standard local assets
    if (req.path.startsWith('/assets/')) {
        return next();
    }

    try {
        const pathOnly = req.path;
        
        // Fast-path index checking instead of heavy loop processing
        if (pathOnly.indexOf('..') !== -1) {
            const decodedPath = decodeURIComponent(pathOnly);
            if (decodedPath.includes('../') || decodedPath.includes('..\\')) {
                console.warn(`Potential path traversal blocked: ${decodedPath}`);
                return res.status(400).json({ error: 'Invalid Request', message: 'URL validation failed' });
            }
        }
        next();
    } catch (error) {
        next(); // Maintain stability over failure crashes
    }
}

/**
 * Create comprehensive security middleware
 * @param {object} options - Middleware options
 * @returns {array} Array of middleware functions
 */
function createSecurityMiddleware(options = {}) {
    configure(options);

    return [
        // Basic security
        securityHeaders,
        ipBlocking,
        //ipThrottleMiddleware,
        validateURL,
        inputSanitization,
        requestSizeLimit(config.maxRequestSize),
        csrfTokenMiddleware,
        csrfProtection
    ];
}

// Export middleware functions
module.exports = {
    configure,
    createSecurityMiddleware,

    // Middleware
    ipBlocking,
    ipThrottleMiddleware,
    csrfProtection,
    csrfTokenMiddleware,
    inputSanitization,
    securityHeaders,
    requestSizeLimit,
    validateMethod,
    validateURL,
    validateRequest,

    // Utility functions
    getClientIP,
    generateCSRFToken,
    sanitizeString,
    sanitizeObject,

    // IP management
    blockIP,
    unblockIP,
    isIPBlocked,
    getBlockedIPs,

    // CSRF management
    get csrfExempt() { return config.csrfExempt; },
    set csrfExempt(val) { config.csrfExempt = val; }
};