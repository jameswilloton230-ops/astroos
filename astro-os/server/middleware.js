const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

// Sessions persist to disk here so they survive server restarts —
// without this, express-session falls back to MemoryStore, which is
// wiped every time the process dies (refresh survives, restart doesn't).
// Uses better-sqlite3 (already a dependency, via the favicon cache) instead
// of session-file-store: SQLite's own locking avoids the Windows EPERM-on-
// rename failures that file-based session storage hit in this project.
const SESSION_DB_PATH = path.join(__dirname, '..', 'data', 'sessions.db');

function setupMiddleware(app) {
    app.use((req, res, next) => {
        res.setHeader('Origin-Agent-Cluster', '?1');
        next();
    });

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
                scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://localhost:3006', 'https://127.0.0.1:3006'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                styleSrcElem: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrcAttr: ["'unsafe-inline'"],
                workerSrc: ["'self'", 'blob:', 'https://localhost:*', 'https://127.0.0.1:*'],
                connectSrc: ["'self'", 'wss:', 'https:', 'ws:', 'http:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'", 'blob:'],
                frameSrc: ["'self'", 'blob:', 'data:', 'https:'],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"]
            },
            setAllHeaders: false,
            disableFloc: true
        },
        crossOriginResourcePolicy: false,
        originAgentCluster: false
    }));

    const corsOrigins = process.env.CORS_ORIGIN?.split(',').filter(Boolean) || ['https://localhost:3006', 'https://127.0.0.1:3006'];

    app.use(cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
        exposedHeaders: ['X-CSRF-Token'],
        maxAge: 86400
    }));

    // Optimize static asset delivery speed with aggressive browser caching
    // In development, use short TTL to allow faster iteration; in production, cache for 24h
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const cacheOptions = {
        maxAge: isDevelopment ? '1m' : '1d', // 1 min in dev, 24 hours in production
        etag: true,
        immutable: !isDevelopment // Only immutable in production
    };
    
    // JS files need no-cache in development for fresh loads
    const jsCacheOptions = {
        maxAge: isDevelopment ? 0 : '1d', // No cache in dev, 24h in production
        etag: true,
        immutable: !isDevelopment
    };

    // Rate limiting
    const limiter = rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
        max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
        message: {
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: process.env.RATE_LIMIT_WINDOW_MS || 900
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            if (req.path === '/health') return true;
            if (req.path.startsWith('/js/')) return true;
            if (req.path.startsWith('/css/')) return true;
            if (req.path.startsWith('/public/')) return true;
            if (req.path.startsWith('/assets/')) return true;
            if (req.path === '/favicon.ico') return true;
            // These have their own dedicated limiters and fire many times per email/page load
            if (req.path === '/api/email-image') return true;
            if (req.path === '/api/favicon') return true;
            // Suggest fires on every keystroke; has its own suggestLimiter (120/min)
            if (req.path === '/api/suggest') return true;
            return false;
        }
    });


    // Tiered email rate limiters — split by frequency of legitimate use:
    //   connect/disconnect/preview: called on every folder switch and email open, needs headroom
    //   messages/search/folders:    moderate — paging and searching
    //   send/batch:                 strict — state-modifying actions, low legitimate frequency

    const emailConnectLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,  // up to 2/sec — covers rapid folder switching and multi-window use
        message: { error: 'Too many connection requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const emailReadLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 1/sec sustained — paging through inbox, searching
        message: { error: 'Too many email requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const emailWriteLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,   // strict — send, delete, move, batch
        message: { error: 'Too many email write requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const faviconLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 60 requests/min per IP
        message: { error: 'Too many favicon requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    app.use('/api/', limiter);
    app.use('/api/email/connect', emailConnectLimiter);
    app.use('/api/email/disconnect', emailConnectLimiter);
    app.use('/api/email/preview', emailConnectLimiter);
    app.use('/api/email/csrf-token', emailConnectLimiter);
    app.use('/api/email/messages', emailReadLimiter);
    app.use('/api/email/message', emailReadLimiter);
    app.use('/api/email/folders', emailReadLimiter);
    app.use('/api/email/search', emailReadLimiter);
    app.use('/api/email/send', emailWriteLimiter);
    app.use('/api/email/batch', emailWriteLimiter);
    app.use('/api/favicon', faviconLimiter);

    app.use(express.json({ limit: '4gb' }));
    app.use(express.urlencoded({ extended: true, limit: '4gb' }));
    app.use(cookieParser());

    // Session middleware (required for CSRF protection)
    const sessionDb = new Database(SESSION_DB_PATH);
    // WAL mode lets reads and writes proceed without blocking each other —
    // matters once multiple requests touch the session table concurrently.
    sessionDb.pragma('journal_mode = WAL');

    app.use(session({
        store: new SqliteStore({
            client: sessionDb,
            expired: {
                clear: true,
                intervalMs: 15 * 60 * 1000 // sweep expired sessions every 15 min
            }
        }),
        secret: (() => {
            if (!process.env.SESSION_SECRET) {
                throw new Error('SESSION_SECRET environment variable is required but not set.');
            }
            return process.env.SESSION_SECRET;
        })(),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.HTTPS === 'true',
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    }));

    // Apply security middleware from security-middleware.js if available
    try {
        const securityMiddleware = require('../security/middleware');
        if (securityMiddleware?.createSecurityMiddleware) {
            const securityMws = securityMiddleware.createSecurityMiddleware({
                enableCsrfProtection: true,
                enableIpBlocking: true,
                enableRequestValidation: true,
                enableInputSanitization: true
            });
            const securityExclusions = ['/bare/'];
            securityMws.forEach(mw => {
                app.use((req, res, next) => {
                    if (securityExclusions.some(p => req.path === p || req.path.endsWith(p) || req.path.startsWith(p))) return next();
                    return mw(req, res, next);
                });
            });
        }
    } catch (e) {
        console.warn('[Middleware] Security middleware not available:', e.message);
    }

    // General security headers
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        if (!res.getHeader('Cross-Origin-Resource-Policy')) {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        }
        next();
    });
}

module.exports = { setupMiddleware };