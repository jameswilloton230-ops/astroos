const path = require('path');
const fs = require('fs');
const express = require('express');

/**
 * AstroOS Modular Server Entry
 */
require('dotenv').config();

const app = express();

const { validateEnvironment } = require('./env');
const { configureSSL } = require('./ssl');
const { setupMiddleware, closeSessionDb } = require('../middleware');
const { mountRoutes } = require('../routes');
const { setupFaviconRoutes, closeFaviconDb } = require('../favicons');
const { setupFrameCheckProxy, setupAppNetworkProxy, setupEmailImageProxy } = require('../proxies');
const { setupEventsRoutes } = require('./events-routes');

// Global error handlers
process.on('uncaughtException', (error) => {
    process.stderr.write(`[uncaughtException] ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason?.stack || reason}\n`);
});

// 1. Env validation
try {
    validateEnvironment();
} catch (e) {
    console.error(e);
    process.exit(1);
}

// 1.5. OS build identity — print WHICH sandbox code this deployment runs.
//
// Field debugging of the sandbox popup path kept dead-ending on the same
// question: a serial capture shows a popup opening, but nothing says which
// app-sandbox.js produced the decision. Kernel timestamps only date the
// (often cache-reused) Buildroot kernel, and package.json's version does
// not move between rebuilds, so two captures from different deployments
// were indistinguishable. process.stdout here IS the serial console (the
// same channel as the [Memory] heartbeat), so hashing the deployed module
// at startup puts an unforgeable identity at the top of every capture: if
// the hash does not match the commit believed to be deployed, the rebuild
// did not take — and the capture says so itself instead of the operator
// having to guess.
(function printOsBuildIdentity() {
    const crypto = require('crypto');
    const identityOf = (label, absPath) => {
        try {
            const stat = fs.statSync(absPath);
            const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0, 8);
            process.stdout.write(`[OS Build] ${label}=${hash} (${stat.size} bytes, mtime ${stat.mtime.toISOString()})\n`);
        } catch (e) {
            process.stdout.write(`[OS Build] ${label} identity unavailable: ${e?.message}\n`);
        }
    };
    identityOf('sandbox', path.join(__dirname, '..', '..', 'js', 'platform', 'security', 'app-sandbox.js'));
    // The middleware half of the identity: the OAuth popup relay fix lives in
    // server/middleware.js (COOP headers), and the 2026-11-03 23:44 capture
    // proved a build can carry a fresh sandbox while its middleware is stale —
    // the two files are rebuilt by different pipeline steps. Print both, so a
    // serial capture can prove or refute deployment of each half on its own.
    identityOf('middleware', path.join(__dirname, '..', 'middleware.js'));
})();

// 2. Setup middleware
setupMiddleware(app);

// 2.2. OS UI log mirror — the serial console's only proven channel is this
// process's stdout (the [OS Build] marker and the [Memory] heartbeat go out
// over it). The OS UI window's own console does NOT reach serial in the
// field: two captures of a failing OAuth popup showed zero of the sandbox's
// popup-decision lines even though app-sandbox.js logs every decision, so it
// now mirrors its info/warn/error lines here and this endpoint writes them
// straight to stdout — i.e. onto the serial console, prefixed [OS UI] so
// they stay distinguishable from the server's own lines.
// Trust model: an operator diagnostics sink, not a security boundary — the
// UI is served same-origin, but sandboxed app guests share that origin and
// could post forged lines; the caps below (50 lines/request, 2000
// chars/line) bound the cost of abuse.
app.post('/api/os/log', (req, res) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    let written = 0;
    for (const line of lines) {
        if (typeof line !== 'string' || line.length === 0) continue;
        if (written >= 50) break;
        process.stdout.write(`[OS UI] ${line.slice(0, 2000)}\n`);
        written += 1;
    }
    res.status(204).end();
});

// 2.5. Index.html caching and nonce injection (MUST come before static middleware)
let _indexHtmlRaw = null;
async function getIndexHtml() {
    if (!_indexHtmlRaw) {
        _indexHtmlRaw = await fs.promises.readFile(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    }
    return _indexHtmlRaw;
}
const _indexHtmlWatcher = fs.watch(path.join(__dirname, '..', '..', 'index.html'), () => { _indexHtmlRaw = null; });

// 2.5b. System signing anchor override (release-keys rotation).
// ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK holds the operator's OFFLINE release key's
// PUBLIC JWK (never the private half). When set and well-formed, it is
// injected into the page as <meta name="nova-system-signing-jwk"> and
// trust-store.js swaps the default AOSP-style test-key anchor for it
// (TrustStore.systemSignatureTier() → 'release-keys'). Unset/invalid →
// the committed test key stays the anchor (test-keys), which is what every
// fresh clone and fork runs on. See astro-os/keys/README.md.
let _systemKeyMetaHtml = '';
try {
    const rawJwk = process.env.ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK;
    if (typeof rawJwk === 'string' && rawJwk.trim().length > 0) {
        const jwk = JSON.parse(rawJwk);
        if (
            jwk && typeof jwk === 'object' &&
            jwk.kty === 'OKP' && jwk.crv === 'Ed25519' &&
            typeof jwk.x === 'string' && jwk.x
        ) {
            // Carry the whole public JWK (the browser's HTML parser decodes
            // the attribute entities back to valid JSON, which trust-store.js
            // JSON.parses — a bare x string would not parse back into a JWK).
            const safe = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x })
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            _systemKeyMetaHtml = `<meta name="nova-system-signing-jwk" content="${safe}">`;
            console.info('[OS] System signing anchor: rotated to the ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK release key (release-keys)');
        } else {
            console.warn('[OS] ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK is set but is not an Ed25519 OKP JWK — keeping the default test-key anchor');
        }
    }
} catch (err) {
    console.warn('[OS] ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK could not be parsed — keeping the default test-key anchor:', err.message);
}

// GET / (MUST come before static middleware!)
app.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let html = await getIndexHtml();

    // Inject CSRF token meta tag — the only runtime injection needed
    const csrfToken = req.session?.csrfToken || res.locals.csrfToken || '';
    html = html.replace('</head>', `<meta name="csrf-token" content="${csrfToken}">${_systemKeyMetaHtml}</head>`);

    res.send(html);
});

// 3. Static asset delivery with caching
const isDevelopment = process.env.NODE_ENV !== 'production';
const cacheOptions = {
    maxAge: isDevelopment ? '1m' : '1d',
    etag: true,
    immutable: !isDevelopment
};

const jsCacheOptions = {
    maxAge: isDevelopment ? 0 : '1d',
    etag: true,
    immutable: !isDevelopment
};

// Serve static assets (but NOT index.html — handled by GET / route above)
app.use(express.static(path.resolve(__dirname, '..', '..'), { ignore: ['index.html'] }));
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets'), cacheOptions));
app.use('/js', express.static(path.join(__dirname, '..', '..', 'js'), jsCacheOptions));
app.use('/css', express.static(path.join(__dirname, '..', '..', 'css'), cacheOptions));

// 4. Setup icon/proxy routes
setupFaviconRoutes(app);
setupFrameCheckProxy(app);
setupAppNetworkProxy(app);
setupEmailImageProxy(app);
setupEventsRoutes(app);

// 5. Manifest and version endpoints
app.get('/manifest.json', (req, res) => {
    res.json({
        name: 'AstroOS',
        short_name: 'AstroOS',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f0f0f',
        theme_color: '#0f0f0f',
        icons: []
    });
});

app.get('/version.json', async (req, res) => {
    const versionPath = path.join(__dirname, '..', '..', 'version.json');
    try {
        await fs.promises.access(versionPath);
        return res.sendFile(versionPath);
    } catch {
        res.status(404).json({ error: 'version.json not found' });
    }
});

// 6. Serve split files from project root
app.get('/app.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'app.js'));
});

app.get('/ui-init.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'ui-init.js'));
});

app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'style.css'));
});

// 7. Memory monitoring
const MEMORY_LOG_INTERVAL_MS = 60_000;
const memoryMonitor = setInterval(() => {
    const m = process.memoryUsage();
    const mb = v => Math.round(v / 1024 / 1024);
    process.stdout.write(
        `[Memory] heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB rss=${mb(m.rss)}MB external=${mb(m.external)}MB\n`
    );
    if (typeof global.gc === 'function' && m.heapUsed / m.heapTotal > 0.85 && m.heapUsed > 100 * 1024 * 1024) {
        global.gc();
        process.stdout.write('[Memory] gc() triggered - heap was above 85%\n');
    }
}, MEMORY_LOG_INTERVAL_MS);
memoryMonitor.unref();

// 8. Health checks
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 11. Strip tracking parameters
app.get('/api/security/strip-tracking', (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url parameter is required' });
    }

    let urlObj;
    try {
        urlObj = new URL(decodeURIComponent(url));
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return res.status(400).json({ error: 'Only http and https URLs are supported' });
    }

    const h = urlObj.hostname.toLowerCase();
    const BLOCKED = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
    const BLOCKED_PREFIXES = ['10.', '192.168.',
        '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
        '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
        '172.28.', '172.29.', '172.30.', '172.31.',
        '169.254.', '100.64.'];
    if (BLOCKED.includes(h) || BLOCKED_PREFIXES.some(p => h.startsWith(p)) || h.endsWith('.local') || h.endsWith('.internal')) {
        return res.status(400).json({ error: 'Internal URLs are not permitted' });
    }

    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
        'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi'];
    let stripped = false;
    trackingParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
            urlObj.searchParams.delete(param);
            stripped = true;
        }
    });
    res.json({ stripped, url: urlObj.toString() });
});

// 12. Mount all API routes
mountRoutes(app);

// 13. Stub API endpoints for prefetch-manager
app.get('/api/apps/list', (req, res) => res.json([]));
app.get('/api/apps/registry', (req, res) => res.json({}));
app.get('/api/apps/permissions', (req, res) => res.json([]));
app.get('/api/security/status', (req, res) => res.json({ ok: true }));
app.get('/api/security/sandbox-check', (req, res) => res.json({ sandboxed: true }));
app.get('/api/user/profile', (req, res) => res.json({}));
app.get('/api/user/preferences', (req, res) => res.json({}));
app.get('/api/user/sessions', (req, res) => res.json([]));
app.get('/api/files/list', (req, res) => res.json([]));
app.get('/api/files/search', (req, res) => res.json([]));
app.get('/api/files/metadata', (req, res) => res.json({}));

// App Serve Registry
// Temporary in-memory store: key → { files: { 'filename': '<base64>' }, created, lastAccess, ... }
// Used by webview sandboxes to serve packaged .novaapp files under their own relaxed CSP.
// Entries auto-expire after 30 minutes of inactivity; explicit cleanup happens when a
// sandbox is destroyed, and live sandboxes keep their entry fresh two ways: every file
// served through the route touches lastAccess, and app-sandbox.js sends a periodic
// /api/apps/serve/heartbeat while the sandbox exists (an app that loads its bundle once
// and then sits idle — a long OAuth consent page in a popup, a dashboard SPA that never
// navigates — would otherwise get its files pruned mid-session and 404 on the next
// navigation, including the OAuth redirect back to its callback URL).
//
// Two key shapes live side by side in this map:
//
//   1. Per-session keys: `sandbox_<appId>_<unique>` — one per launch (generateSandboxId
//      in app-sandbox.js). Unique per launch so concurrent/repeated launches don't
//      collide. This is the URL the app's own webview loads from.
//
//   2. Stable per-app alias keys: `sandbox_<appId>` — NO unique suffix, registered by
//      the same registration call that created the session key, pointing at the exact
//      same entry object. This gives the app's bundled files a URL that survives
//      relaunches, so redirect-based flows (OAuth callbacks, payment providers) can
//      register `https://localhost:3003/api/apps/serve/sandbox_<appId>/callback.html`
//      with a third party ahead of time. When the same app is launched again, the new
//      registration overwrites the alias (last launch wins); the previous launch's
//      session key keeps serving its own copy until its TTL or its destroy(). The alias
//      is dropped when the session that most recently registered it unregisters, so a
//      fully closed app stops serving under its stable URL.
//
// The alias can never collide with a session key: session keys always carry a
// `_<unique>` suffix after the app id, and the app ids accepted here (see
// _APP_SERVE_APP_ID_PATTERN) contain no underscores at all in their reverse-domain
// form, so `sandbox_<appId>` is not a well-formed session key for any app id.
const _appServeRegistry = new Map();
const _APP_SERVE_TTL = 30 * 60 * 1000; // 30 min idle

// App ids eligible for a stable alias. These are exactly the two shapes the
// platform issues: reverse-domain package ids (app-package.js install validation:
// `^[a-z][a-z0-9]*(\.[a-z0-9]+)+$`) and `webapp_` shortcut ids (automated-review.js:
// `^webapp_[a-z0-9._-]+$`). Anything else is rejected — this keeps garbage out of the
// registry and, because reverse-domain ids contain no underscores, guarantees a stable
// key can't be confused with a per-session key or another app's key.
const _APP_SERVE_APP_ID_PATTERN = /^(?:webapp_[a-z0-9._-]{1,112}|[a-z][a-z0-9]*(?:\.[a-z0-9]+)+)$/;

function _normalizeAppServePath(filePath) {
    return String(filePath).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function _pruneAppServeRegistry() {
    const cutoff = Date.now() - _APP_SERVE_TTL;
    for (const [k, v] of _appServeRegistry) {
        if ((v.lastAccess || v.created) < cutoff) _appServeRegistry.delete(k);
    }
}

// Sweep expired sandbox entries on a timer too, not just when a new one gets
// registered — a sandbox that's registered once and never touched again
// (or never explicitly unregistered on destroy) would otherwise sit in the
// map forever, since _pruneAppServeRegistry was previously only ever called
// from inside the register handler.
const _appServeSweepTimer = setInterval(_pruneAppServeRegistry, _APP_SERVE_TTL);
_appServeSweepTimer.unref();

// SECURITY (2026-11-12 audit, finding M2): the app-serve mutation routes
// (register/heartbeat/unregister) are CSRF-exempt by design — <webview>
// subresource loads and the host's own registration fetch cannot always
// carry a CSRF token. That exemption previously left them with NO request-
// origin enforcement at all: any web page in the user's browser could POST
// a file map and have it served at the OS's own origin under the relaxed
// app CSP. Enforce same-origin Origin/Referer on these verbs — the trusted
// host page (and anything in its origin) always sends a matching Origin
// header on POST/DELETE; sandboxed guests cannot reach these routes with
// the OS session cookie anyway (opaque origin + SameSite=lax), and a
// missing/foreign Origin is now rejected outright.
function _isSameOriginAppServeRequest(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3003}`;
    const originHost = (() => { try { return new URL(origin).host; } catch (_) { return null; } })();
    if (originHost === null) return false;
    if (originHost !== host) return false;
    return /^https?:$/.test((() => { try { return new URL(origin).protocol; } catch (_) { return ''; } })());
  }
  // No Origin header: fall back to Referer's authority. The host page's
  // own fetches always carry Origin on POST/DELETE; absence of both means
  // a non-browser or hostile client — reject.
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3003}`;
    try {
      const ref = new URL(referer);
      if (ref.host !== host) return false;
      return /^https?:$/.test(ref.protocol);
    } catch (_) { return false; }
  }
  return false;
}

function requireSameOrigin(req, res, next) {
  if (!_isSameOriginAppServeRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin app-serve request rejected' });
  }
  next();
}

// Register app files for serving (called by app-sandbox.js loadAppContent)
app.post('/api/apps/serve/register', requireSameOrigin, (req, res) => {
    const { sandboxId, files, allowExternalFrames, appId } = req.body || {};
    if (!sandboxId || typeof sandboxId !== 'string' || !files || typeof files !== 'object') {
        return res.status(400).json({ error: 'sandboxId (string) and files (object) are required' });
    }
    // sandboxId must match our internal format to prevent registry pollution.
    // generateSandboxId() (app-sandbox.js) produces `sandbox_${appId}_${unique}`
    // where unique is either a crypto.randomUUID() (hex + hyphens) or the
    // fallback `${Date.now()}_${base36}` (digits + lowercase letters). The old
    // regex required a trailing all-digit group, which neither format reliably
    // ends in, so every registration was rejected. Match the real charset instead.
    if (!/^sandbox_[\w.-]+$/.test(sandboxId)) {
        return res.status(400).json({ error: 'Invalid sandboxId format' });
    }
    // Optional stable alias: when the caller passes the app id, the same entry
    // is ALSO registered under `sandbox_<appId>` (no unique suffix) so bundled
    // files stay reachable at a URL that survives relaunches — the piece that
    // makes pre-registered OAuth/redirect callback URLs possible. Clients only
    // send appId when it matches _APP_SERVE_APP_ID_PATTERN (they degrade to
    // session-only serving otherwise, matching pre-alias behavior), so a 400
    // here means a caller bug worth surfacing, not a launch blocker.
    let aliasKey = null;
    if (appId !== undefined) {
        if (
            typeof appId !== 'string'
            || appId.length > 128
            || !_APP_SERVE_APP_ID_PATTERN.test(appId)
        ) {
            return res.status(400).json({ error: 'Invalid appId format for stable serving alias' });
        }
        // Ownership binding: the session key must embed this app id, so a caller
        // can't accidentally register app A's files under app B's alias. This is
        // a caller-bug guard, not a security boundary — the endpoint is reachable
        // only from the trusted host page (sandboxed guests have fetch/XHR routed
        // through the permission-checked bridge), and a hostile host-context
        // caller could fabricate a matching pair anyway.
        if (!sandboxId.startsWith(`sandbox_${appId}_`)) {
            return res.status(400).json({ error: 'sandboxId does not belong to appId' });
        }
        aliasKey = `sandbox_${appId}`;
    }
    _pruneAppServeRegistry();
    const normalizedFiles = new Map();
    for (const [filePath, fileData] of Object.entries(files)) {
        const normalizedPath = _normalizeAppServePath(filePath);
        if (!normalizedFiles.has(normalizedPath)) normalizedFiles.set(normalizedPath, fileData);
    }
    const now = Date.now();
    const entry = {
        files,
        normalizedFiles,
        allowExternalFrames: allowExternalFrames === true,
        created: now,
        lastAccess: now,
        // Which session key registered this entry (used by unregister to decide
        // whether the alias still belongs to the dying session, and by the
        // heartbeat as the lookup key).
        registeredBy: sandboxId,
        aliasKey
    };
    _appServeRegistry.set(sandboxId, entry);
    if (aliasKey) _appServeRegistry.set(aliasKey, entry);
    res.json({
        ok: true,
        baseUrl: `/api/apps/serve/${sandboxId}`,
        ...(aliasKey ? { stableBaseUrl: `/api/apps/serve/${aliasKey}` } : {})
    });
});

// Liveness heartbeat (called by app-sandbox.js on a per-sandbox interval while
// the sandbox exists). Keeps the registry entry past the idle TTL for apps that
// load their bundle once and then go quiet — see the registry comment above for
// why the TTL alone breaks long-running redirect flows.
app.post('/api/apps/serve/heartbeat', requireSameOrigin, (req, res) => {
    const { sandboxId } = req.body || {};
    if (typeof sandboxId !== 'string' || !sandboxId) {
        return res.status(400).json({ error: 'sandboxId (string) is required' });
    }
    const entry = _appServeRegistry.get(sandboxId);
    // Unknown id (including after a pruned leak) is not an error for the caller
    // — it just means there is nothing to keep alive; the client ignores 404s.
    if (!entry) return res.status(404).json({ error: 'Unknown sandboxId' });
    entry.lastAccess = Date.now();
    res.json({ ok: true });
});

// Unregister (called on sandbox destroy)
app.delete('/api/apps/serve/unregister/:sandboxId', requireSameOrigin, (req, res) => {
    const key = req.params.sandboxId;
    const entry = _appServeRegistry.get(key);
    _appServeRegistry.delete(key);
    // The stable alias belongs to the session that most recently registered it.
    // If THIS session owns the alias (no newer launch has taken it over), drop it
    // so a fully closed app stops serving under its stable URL. An older window
    // of the same app closing must not evict the alias the newer window
    // registered — the identity check makes that explicit.
    if (
        entry
        && entry.aliasKey
        && entry.registeredBy === key
        && _appServeRegistry.get(entry.aliasKey) === entry
    ) {
        _appServeRegistry.delete(entry.aliasKey);
    }
    res.json({ ok: true });
});

const APP_SERVE_MIME = {
    html: 'text/html', js: 'application/javascript', mjs: 'application/javascript',
    css: 'text/css', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    // Compiled C/C++ (Emscripten) output. Without this, .wasm falls back to
    // application/octet-stream below — some browsers refuse
    // WebAssembly.instantiateStreaming() on that MIME type and throw, so this
    // isn't cosmetic for apps bundling native code.
    wasm: 'application/wasm'
};

// Serve app files with a relaxed CSP.
// The webview's separate renderer process provides the real isolation boundary.
// server-sent CSP header takes effect (replaces the main page's strict policy).
app.get('/api/apps/serve/:sandboxId/{*file}', (req, res) => { // <-- Valid stable Express 5 syntax
    const entry = _appServeRegistry.get(req.params.sandboxId);
    if (!entry) return res.status(404).end();
    // Refresh the idle timer: a session (or stable alias) that keeps getting
    // loaded is alive, whatever its age. See the registry comment above.
    entry.lastAccess = Date.now();

    const raw = req.params.file;
    const filePath = Array.isArray(raw) ? raw.join('/') : (raw || 'index.html');

    const hasExactPath = Object.prototype.hasOwnProperty.call(entry.files, filePath);
    const normalizedPath = _normalizeAppServePath(filePath);
    const hasNormalizedPath = entry.normalizedFiles.has(normalizedPath);
    if (!hasExactPath && !hasNormalizedPath) return res.status(404).end();
    const fileData = hasExactPath ? entry.files[filePath] : entry.normalizedFiles.get(normalizedPath);
    if (!fileData && fileData !== '') return res.status(404).end();

    const ext = String(filePath).split('.').pop().toLowerCase();

    // Relaxed CSP for third-party apps — unsafe-inline allowed because apps need
    // inline scripts/styles to function; connect-src is locked to self/blob only.
    // This used to also carve out http(s)://localhost:*, matching the identical
    // string in app-sandbox.js's client-side RELAXED_CSP_META. Removed here for
    // the same reason it was removed there: the IPC bridge (window.nova.ipc /
    // fetch / XHR / WebSocket overrides, injected client-side by loadAppContent
    // before registering with /api/apps/serve/register) never needs raw network
    // access — every real request routes through nova:net:* and is permission-
    // checked host-side. The carve-out only ever served as an escape hatch for
    // whichever client-side override a given app managed to bypass or unshadow.
    // This header is authoritative for anything served through THIS route
    // (server-sent CSP overrides whatever's baked into the served HTML's own
    // meta tag), so both copies needed to change together — fixing only the
    // client-side meta tag would have left this one still granting localhost
    // access to any third-party app hitting /api/apps/serve/:sandboxId directly.
    // unsafe-eval was previously granted here on the theory that the runtime
    // audit hook (nova:audit:eval) was enough of a check. It wasn't — logging
    // after the fact doesn't stop the call. eval/new Function are now blocked
    // outright: removed from both directives below, matching the same fix
    // already applied to the client-side RELAXED_CSP_META in app-sandbox.js.
    // 'wasm-unsafe-eval' added to script-src (same reasoning and same pairing
    // requirement as app-sandbox.js's RELAXED_CSP_META, which this header
    // must match): permits WebAssembly.instantiate()/.compile() for apps
    // bundling compiled C/C++ (Emscripten) output, without reopening
    // eval()/new Function() on arbitrary strings — that stays removed.
    // Since this server-sent header overrides the client-side meta tag for
    // anything served through this route, this is the change that actually
    // takes effect for WASM apps; the app-sandbox.js copy exists so the
    // policy is also correct/consistent for any path that isn't served
    // through here. Update both together.
    const isHtml = ext === 'html';
    if (isHtml) {
        const policy = [
            "default-src 'self' blob: data: 'unsafe-inline'",
            "script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'",
            "style-src 'self' 'unsafe-inline' blob: data:",
            "img-src 'self' blob: data: https:",
            "font-src 'self' blob: data:",
            "connect-src 'self' blob:"
        ];
        if (entry.allowExternalFrames) policy.push('frame-src http: https:');
        res.setHeader('Content-Security-Policy', policy.join('; '));
        // Serial-visible proof of the effective COOP policy per document. This
        // route serves the ONLY OS documents that Chromium loads INTO an
        // opener-linked popup (app callback pages — OAuth/SSO relay targets),
        // so the header value here decides whether window.opener survives;
        // one line per document load puts that value directly into the next
        // serial capture instead of leaving it to be inferred from commits.
        process.stdout.write(`[serve] doc=${req.params.sandboxId}/${filePath} coop=${res.getHeader('Cross-Origin-Opener-Policy') || 'none'}\n`);
    }
    res.setHeader('Content-Type', APP_SERVE_MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    const body = Buffer.from(fileData, 'base64');
    // Note: app-sandbox.js's loadAppContent() already injects the full capability
    // shim (window.nova.ipc, window.fetch override, XHR shim, permission bridge)
    // into entry HTML client-side before calling /api/apps/serve/register. This
    // route used to also inject its own separate, minified shim here as a second
    // safety net — but its dedup check looked for a marker the real shim never
    // writes, so it always fired, double-injecting two competing window.nova
    // implementations and producing malformed <script><script> markup. Removed;
    // the client-side shim from app-sandbox.js is the single source of truth.
    res.send(body);
});

// 14. 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.path}`, timestamp: new Date().toISOString() });
});

// 15. Global error handler
app.use((err, req, res, next) => {
    console.error('[Error]', err);
    // If headers are already sent, the original request already got a response —
    // this error surfaced asynchronously afterward (e.g. a session store write that
    // failed after res.json() already ran). Writing again here is what throws
    // ERR_HTTP_HEADERS_SENT. Just log and hand off to Node's default handling.
    if (res.headersSent) {
        return next(err);
    }
    const message = process.env.NODE_ENV === 'production'
        ? 'An internal server error occurred'
        : err.message;
    res.status(err.status || 500).json({
        error: message || err.message || 'Internal Server Error',
        timestamp: new Date().toISOString()
    });
});

// 16. SSL Configuration
const { server } = configureSSL(app);

const PORT = process.env.PORT || 3006;
const HOST = process.env.HOST || '127.0.0.1';

// 17. Server error handling
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${PORT} is already in use.`);
        console.error(`  Stop the existing process, or set a different port: PORT=3001 npm start`);
    } else {
        console.error('Server error:', error.message);
    }
});

// 18. Graceful shutdown
// Closes what this process opened (favicon DB, session DB, the index.html
// watcher, the app-serve sweep timer) before exiting. None of these were
// being closed before — server.close() only stops accepting new HTTP
// connections, it doesn't know about file handles or DB connections other
// modules opened. The hard-exit timeout stays: better-sqlite3-session-store
// runs its own internal setInterval that this process has no handle to and
// can't unref or clear, so a clean shutdown within 10s isn't guaranteed
// even after everything we CAN close is closed.
const gracefulShutdown = (signal) => {
    console.log(`\n[${signal}] Received. Starting graceful shutdown...`);
    server.close(() => {
        console.log('[HTTP] Server closed');
        try { _indexHtmlWatcher.close(); } catch (_) {}
        clearInterval(_appServeSweepTimer);
        closeFaviconDb();
        closeSessionDb();
        console.log('[Shutdown] Resources closed');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('[Shutdown] Forced exit after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 19. Start server
server.listen(PORT, HOST, () => {
    const isHttps = process.env.HTTPS === 'true';
    const protocol = isHttps ? 'https' : 'http';
    try {
        const pkg = require('../../package.json');
        console.log('');
        console.log(`  AstroOS v${pkg.version}`);
    } catch {
        console.log('');
        console.log(`  AstroOS`);
    }
    console.log('  ──────────────────────────────────');
    console.log(`  ● Address      ${protocol}://${HOST}:${PORT}`);
    console.log(`  ● Environment  ${process.env.NODE_ENV || 'development'}`);
    console.log(`  ● TLS          ${isHttps ? 'enabled (HTTPS)' : 'disabled (HTTP)'}`);
    console.log('  ──────────────────────────────────');
    console.log('');
});

// 20. Performance tuning
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxRequestsPerSocket = 1000;

module.exports = { app, server };