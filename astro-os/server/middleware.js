const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { isTrustedSystemAppRequest } = require('./rate-limit-auth');
const { getRuntimeDataDir } = require('../scripts/runtime-data-dir');

// Signs a raw session id into the connect.sid cookie form express-session
// verifies ('s:<sid>.<hmac>' — express-session adds the s: itself around
// cookie-signature when IT writes the cookie, so the bearer path must match
// that exact form), so the X-Nova-Session bearer header can target a specific
// live session (the session machinery for user switching) without touching the
// browser's single cookie slot.
let signSessionCookie = null;
try {
    const cookieSignature = require('cookie-signature');
    if (typeof cookieSignature.sign === 'function') {
        signSessionCookie = (sid, secret) => `s:${cookieSignature.sign(sid, secret)}`;
    }
} catch (_) { signSessionCookie = null; }
if (!signSessionCookie) {
    // Manual fallback with the identical format: s:<sid>.<hmac-sha256-base64>
    const nodeCrypto = require('crypto');
    signSessionCookie = (sid, secret) =>
        `s:${sid}.${nodeCrypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;
}

// Sessions persist to disk here so they survive server restarts —
// without this, express-session falls back to MemoryStore, which is
// wiped every time the process dies (refresh survives, restart doesn't).
// Uses better-sqlite3 (already a dependency, via the favicon cache) instead
// of session-file-store: SQLite's own locking avoids the Windows EPERM-on-
// rename failures that file-based session storage hit in this project.
const SESSION_DB_DIR = path.join(getRuntimeDataDir(path.resolve(__dirname, '..')), 'data');
const SESSION_DB_PATH = path.join(SESSION_DB_DIR, 'sessions.db');

const EXACT_SKIP_PATHS = new Set([
    '/health',
    '/favicon.ico',
    '/api/favicon',
    '/api/events/stream',
    // The OS UI log mirror (app-sandbox.js POSTs its info/warn/error lines
    // here so they reach the serial console). It must never be rate-limited:
    // the whole OS shares one localhost bucket, OS-internal traffic already
    // exhausts the budget, and a 429 here is swallowed by the mirror's
    // never-throw policy — so limiter starvation silently killed every
    // field-debugging capture before this exemption. The sink is
    // self-throttled at the source (40 lines/5s) and bounded at the sink
    // (50 lines/request, 2000 chars/line), so exempting it does not reopen
    // an abuse hole.
    '/api/os/log',
]);
const PREFIX_SKIP_PATHS = [
    '/js/',
    '/css/',
    '/public/',
    '/assets/',
    // The per-sandbox app-serve surface (register, heartbeat, unregister,
    // and every installed app's content tree: HTML/JS/CSS/icons under
    // /api/apps/serve/<sandbox>/…). App windows load these through
    // navigation and <script>/<link>/<img>/<iframe> tags, which cannot
    // carry custom headers, so they can never be trusted via signature —
    // yet a handful of app launches pulls dozens of requests through here
    // and exhausted the global per-IP budget in the field, 429-ing the
    // whole desktop (default launcher included) for the 15-minute window
    // ("Too many requests from this IP"). This surface is the OS's own
    // installed-app content on localhost; the limiter exists for untrusted
    // remote clients, not for it. OS-UI fetch() traffic is separately
    // trusted via signature (js/platform/security/system-fetch.js +
    // isTrustedSystemAppRequest below).
    '/api/apps/serve/',
    // The auth family carries its own dedicated limiter tier (authLimiter,
    // mounted below) — riding the global one as well would double-count
    // every picker keystroke against the 100/15min shared budget.
    '/api/auth/',
];

function shouldSkipGlobalApiRateLimit(req) {
    if (isTrustedSystemAppRequest(req)) return true;
    // Express removes the mounted `/api/` prefix from req.path. Check both
    // forms so full API routes match without breaking existing mounted-path
    // exemptions.
    const fullPath = (req.originalUrl || req.path).split('?')[0];
    const mountedPath = req.path || fullPath;
    return EXACT_SKIP_PATHS.has(fullPath) ||
        EXACT_SKIP_PATHS.has(mountedPath) ||
        PREFIX_SKIP_PATHS.some(p => fullPath.startsWith(p) || mountedPath.startsWith(p));
}

// This used to work only because favicons.js happened to create ../data
// first and index.js requires favicons.js before setupMiddleware() runs —
// an ordering coincidence, not a guarantee. Ensuring the dir exists here
// too means this file no longer depends on another module having run first.
fs.mkdirSync(SESSION_DB_DIR, { recursive: true });

// Body size limit for express.json/urlencoded. The original had this set to
// '4gb', which meant a single request could buffer up to 4GB in memory
// before parsing even started — one request from anywhere could eat the
// whole heap. Configurable via env for deployments that genuinely need
// large payloads (e.g. bulk import), defaulting to something sane.
const BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT || '10mb';

let sessionDb = null;

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
                scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://localhost:3006', 'https://127.0.0.1:3006'],
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
        originAgentCluster: false,
        // helmet 8 defaults COOP to the strict `same-origin`, and that default
        // is what killed every OAuth popup relay in the field. Serial capture
        // 2026-11-03 22:48: the sandboxed guest opened github.com/login/oauth/
        // authorize, the OS attached the popup into its overlay webview (opener
        // intact), the user signed in through GitHub and Google, and the
        // provider redirected back to the app's own
        // /api/apps/serve/sandbox_<id>/callback.html?code=... — served by THIS
        // server with helmet's `Cross-Origin-Opener-Policy: same-origin`.
        // Chromium's COOP processing then moved the popup into a NEW browsing
        // context group and the callback page executed with `window.opener`
        // null. GitHub's login pages send no COOP at all and accounts.google.com
        // sends COOP report-only — verified live — so our own header was the
        // single ENFORCING response in the whole chain.
        //
        // CORRECTION of the 2026-11-03 23:04 attempt (commit f23df12): switching
        // this global to `same-origin-allow-popups` did NOT fix the field.
        // Serial capture 2026-11-03 23:44 — run against a build whose deployed
        // app-sandbox.js hash (f14b6811) matches this tree — shows the IDENTICAL
        // failure signature: callback fired with opener=ABSENT, relay dropped,
        // "popup closed without a relay message within 500ms". The soap theory
        // was wrong about direction. The HTML spec's "matching opener policy
        // values" algorithm (which governs every non-popup navigation, i.e.
        // every hop INSIDE an existing popup window) requires a group switch
        // whenever the two documents' policies differ and either side is
        // "unsafe-none" — the soap relaxation only applies at POPUP CREATION
        // ("check if popup COOP values ...": opener soap + response unsafe-none
        // stays). A provider page (unsafe-none) navigating to our soap callback
        // therefore switches groups again, opener severed, same failure.
        // Empirically pinned with a headless-Chromium matrix reproducing this
        // exact structure (soap/sandboxed guest iframe -> window.open ->
        // 302 + report-only provider chain -> callback served with the variant
        // under test): opener survives and the postMessage relay arrives ONLY
        // when the callback document itself carries unsafe-none; soap and
        // same-origin both sever for every guest variant.
        //
        // So the global policy stays soap (isolation for OS UI pages that are
        // never popup relay targets), and the app serve surface — the ONLY
        // documents Chromium loads INTO an opener-linked popup window — gets
        // unsafe-none right after this middleware, see the override below.
        crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
    }));

    // The app serve surface must never split the popup's browsing context
    // group. Every document an app registers under /api/apps/serve can be the
    // redirect target of an OAuth/SSO/payment popup — the app chooses its own
    // callback filename, so this cannot be narrowed to "callback.html". An
    // unsafe-none document NEVER requires a group switch (spec: matching is
    // true whenever both sides are unsafe-none, and a provider chain like
    // github.com — no COOP — plus accounts.google.com — report-only — never
    // switches), so the popup stays in the opener's group for its whole life
    // and window.opener is alive when the relay needs it. This override must
    // run AFTER helmet (which stamps soap on everything) and BEFORE the serve
    // routes; headers set later in the chain overwrite earlier ones.
    app.use('/api/apps/serve', (req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
        next();
    });

    // .filter(Boolean) can leave an empty array (e.g. CORS_ORIGIN="," or a
    // stray trailing comma), and `[] || fallback` doesn't trigger since []
    // is truthy — that silently locked out every origin including the dev
    // default. Check length explicitly instead of relying on truthiness.
    const envOrigins = process.env.CORS_ORIGIN?.split(',').map(o => o.trim()).filter(Boolean);
    const corsOrigins = envOrigins?.length ? envOrigins : ['https://localhost:3006', 'https://127.0.0.1:3006'];

    app.use(cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token',
            'X-Nova-System-App', 'X-Nova-System-Time', 'X-Nova-System-Signature',
            'X-Nova-Session',
        ],
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
        skip: shouldSkipGlobalApiRateLimit
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
        skip: isTrustedSystemAppRequest,
    });

    const emailReadLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 1/sec sustained — paging through inbox, searching
        message: { error: 'Too many email requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    const emailWriteLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,   // strict — send, delete, move, batch
        message: { error: 'Too many email write requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    const faviconLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 60 requests/min per IP
        message: { error: 'Too many favicon requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    // The SSE stream is long-lived, but reconnects (tab backgrounding,
    // sleep/wake, brief network blips) mean a fresh connect can happen
    // several times a minute under normal use. Window is short and max
    // is generous specifically so a reconnect burst can never get stuck
    // rate-limited against itself.
    const eventsStreamLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30,   // up to 1 connect attempt every 2 sec, sustained
        message: { error: 'Too many event stream connections, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    // Auth surface tier — its own budget instead of the global one, so the
    // login picker can never be starved by general API traffic (and vice
    // versa: brute force cannot ride the generous global bucket either).
    const authLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30,   // logins/reverify/webauthn attempts per minute per IP
        message: { error: 'Too many authentication attempts, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    app.use('/api/', limiter);
    app.use('/api/auth/', authLimiter);
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
    app.use('/api/events/stream', eventsStreamLimiter);

    app.use(express.json({ limit: BODY_SIZE_LIMIT }));
    app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));
    app.use(cookieParser());

    // Bearer session targeting: the trusted host presents X-Nova-Session with
    // an opaque session id (issued by /api/auth/login) and the chain resolves
    // it to that session BEFORE express-session runs. cookieParser has already
    // materialized req.cookies by this point, so BOTH the header and the parsed
    // cookie map are pointed at the signed form for that sid — rewriting only
    // the header would leave express-session reading the anonymous cookie.
    // The browser cookie jar is single-slot, but user switching needs two live
    // sessions at once — the header is how the departing (suspended) session
    // stays reachable. The token never crosses out of host memory: sandboxed
    // webviews keep their own cookie partitions and never see this header,
    // exactly like the per-launch system-app HMAC headers.
    const NOVA_SESSION_HEADER = 'x-nova-session';
    const SID_RE = /^[A-Za-z0-9_-]{10,128}$/;
    app.use((req, res, next) => {
        const sid = req.get(NOVA_SESSION_HEADER);
        if (sid && SID_RE.test(sid) && process.env.SESSION_SECRET) {
            const signed = signSessionCookie(sid, process.env.SESSION_SECRET);
            req.headers.cookie = `connect.sid=${encodeURIComponent(signed)}`;
            if (req.cookies && typeof req.cookies === 'object') {
                req.cookies['connect.sid'] = signed;
                delete req.signedCookies?.['connect.sid'];
            }
            req.novaBearerSession = sid;
        }
        next();
    });

    // Session middleware (required for CSRF protection)
    sessionDb = new Database(SESSION_DB_PATH);
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

    // Identity resolution: an authenticated session carries uid/role/uname
    // (multi-user accounts, /api/auth/login). Anonymous sessions keep the
    // legacy single-user derivation — adminEnabled grants admin ONLY while
    // no real accounts exist; once users.db has rows the anonymous world is
    // standard-user by construction, so the legacy admin-mode flag can no
    // longer hand out admin authority to every request.
    const { isAdminEnabled } = require('./security/admin-state');
    let usersDbModule = null;
    try { usersDbModule = require('./security/users-db'); } catch (_) { usersDbModule = null; }
    const legacyAdminAllowed = () => {
        if (!usersDbModule) return isAdminEnabled();
        try { return !usersDbModule.hasAccounts() && isAdminEnabled(); }
        catch (_) { return isAdminEnabled(); }
    };
    app.use((req, res, next) => {
        const s = req.session;
        if (s && s.uid && s.uname) {
            const adminRole = s.role === 'owner' || s.role === 'admin';
            req.user = {
                id: s.uid,
                uid: s.uid,
                role: adminRole ? 'admin' : 'user',
                uname: s.uname,
                suspended: !!s.suspended,
                locked: !!s.lockedAt,
            };
        } else {
            req.user = {
                id: req.sessionID,
                role: legacyAdminAllowed() ? 'admin' : 'user'
            };
        }
        // Stamped onto the session itself (not just req.user) so the
        // /api/security/sessions listing — which reads the SQLite session
        // store directly, not live request objects — can show which
        // role/IP/UA each stored session belongs to.
        if (req.session) {
            req.session.user = req.user;
            req.session.lastIp = req.ip;
            req.session.lastUserAgent = req.get('user-agent') || null;
        }
        next();
    });

    // Apply security middleware from security-middleware.js if available.
    // One middleware that loops over all of them and checks the exclusion
    // once, instead of the previous N wrapper layers (one per security
    // middleware, each re-running its own identical exclusion check) —
    // same behavior, fewer middleware hops per request.
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
            const isExcluded = (reqPath) => securityExclusions.some(
                p => reqPath === p || reqPath.endsWith(p) || reqPath.startsWith(p)
            );

            app.use((req, res, next) => {
                if (isExcluded(req.path)) return next();
                const runFrom = (i) => {
                    if (i >= securityMws.length) return next();
                    securityMws[i](req, res, (err) => {
                        if (err) return next(err);
                        runFrom(i + 1);
                    });
                };
                runFrom(0);
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

// Lets index.js close the session DB cleanly during graceful shutdown.
// Note: this closes the DB handle, but the SqliteStore's own internal
// setInterval (its 15-min expired-session sweep) isn't unref'd by that
// library and isn't something this file can reach to fix — it's why
// index.js's shutdown handler still needs its hard-exit timeout fallback.
function closeSessionDb() {
    if (!sessionDb) return;
    try { sessionDb.close(); } catch (_) { /* already closed or never opened */ }
    sessionDb = null;
}

module.exports = { setupMiddleware, closeSessionDb, shouldSkipGlobalApiRateLimit };