const rateLimit = require('express-rate-limit');
const { isTrustedSystemAppRequest } = require('./rate-limit-auth');
const dns = require('dns');
const ServerEventLog = require('./core/server-event-log');

// ── Frame-Embed Check Proxy ────────────────────────────────────────────────
// Resolves whether a URL can be embedded in an <iframe> by inspecting the
// response headers server-side (X-Frame-Options / CSP frame-ancestors).
// Doing this client-side is unreliable: cross-origin frames throw on
// contentDocument access (so genuine blocks are never detected) and same-origin
// frames pass through an about:blank state mid-load (so embeddable sites are
// false-positive flagged as blocked).

const frameCheckCache = new Map(); // key: origin → { embeddable, ts }
const FRAME_CHECK_TTL     = 10 * 60 * 1000; // 10 min — XFO/CSP headers rarely change
const FRAME_CHECK_MAX     = 500;
const FRAME_CHECK_TIMEOUT = 5000;

/**
 * Evaluate a frame-ancestors source list against our embedding origin.
 * Returns true if embedding is allowed by THIS directive.
 */
function _frameAncestorsAllows(cspValue, embedOrigin) {
    if (!cspValue) return true;
    // CSP may have multiple frame-ancestors directives; allow if ANY permits.
    const directives = cspValue.split(';');
    let sawDirective = false;
    for (const raw of directives) {
        const parts = raw.trim().split(/\s+/);
        if (parts[0].toLowerCase() !== 'frame-ancestors') continue;
        sawDirective = true;
        const sources = parts.slice(1).map(s => s.toLowerCase());
        if (sources.includes('*')) return true;
        if (sources.includes("'self'") || sources.includes('self')) return true;
        for (const s of sources) {
            if (s === "'none'" || s === 'none') continue;
            if (s === "'self'" || s === 'self') return true;
            // Match 'scheme://host' or 'scheme://host:port' or '*.host' patterns
            try {
                const m = s.match(/^([\w-]+:\/\/)?([^/]+)/);
                if (!m) continue;
                const pattern = m[2];
                if (pattern.startsWith('*.')) {
                    const suffix = pattern.slice(1); // ".example.com"
                    if (embedOrigin.endsWith(suffix)) return true;
                    // also match apex domain itself
                    if (embedOrigin === pattern.slice(2)) return true;
                } else if (embedOrigin === pattern) {
                    return true;
                } else {
                    // host without scheme — compare host:port portion of origin
                    const embedHost = embedOrigin.replace(/^[\w.-]+:\/\//, '');
                    if (embedHost === pattern) return true;
                }
            } catch (_) {}
        }
    }
    // If the page had a frame-ancestors directive at all and none matched, blocked.
    return !sawDirective;
}

function _isBlockedByHeaders(resp, embedOrigin) {
    // X-Frame-Options (case-insensitive). DENY/SAMEORIGIN block cross-origin.
    const xfo = (resp.headers.get('x-frame-options') || '').trim().toLowerCase();
    if (xfo === 'deny') return true;
    if (xfo === 'sameorigin') {
        // We're never same-origin with the framed site (browser origin ≠ target).
        return true;
    }
    if (xfo.startsWith('allow-from')) return true; // legacy; we never match

    // Content-Security-Policy frame-ancestors
    const csp = resp.headers.get('content-security-policy') || resp.headers.get('content-security-policy-report-only');
    if (csp && /frame-ancestors/i.test(csp)) {
        return !_frameAncestorsAllows(csp, embedOrigin.toLowerCase());
    }
    return false;
}

const frameCheckLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many frame-check requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: isTrustedSystemAppRequest,
});

// Fetches targetUrl with manual, per-hop SSRF revalidation + IP pinning
// (redirect: 'follow' would let fetch chase a redirect straight to a
// private/internal address with no revalidation at all — the classic
// SSRF-via-redirect bypass, and worse than the rebinding gap since it
// needs no timing trick, just a 302).
const FRAME_CHECK_MAX_REDIRECTS = 5;
async function _probeFetchValidated(initialUrl, method, signal) {
    let currentUrl = initialUrl;
    const visited = new Set();
    for (let hop = 0; hop <= FRAME_CHECK_MAX_REDIRECTS; hop++) {
        if (visited.has(currentUrl)) throw Object.assign(new Error('Redirect loop'), { code: 'REDIRECT_LOOP' });
        visited.add(currentUrl);

        let urlObj;
        try { urlObj = new URL(currentUrl); } catch { throw Object.assign(new Error('Invalid URL'), { code: 'INVALID_URL' }); }
        if (!['http:', 'https:'].includes(urlObj.protocol)) throw Object.assign(new Error('Bad protocol'), { code: 'BAD_PROTOCOL' });
        if (_isPrivateHost(urlObj.hostname)) throw Object.assign(new Error('Private host'), { code: 'SSRF_BLOCKED' });
        const dnsResult = await _dnsResolvePrivate(urlObj.hostname);
        if (dnsResult.private) throw Object.assign(new Error('Private host (DNS)'), { code: 'SSRF_BLOCKED' });

        const resp = await _pinnedFetch(currentUrl, {
            method,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AstroOS/1.0)' },
            redirect: 'manual',
            signal,
        }, dnsResult);

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            try { resp.body?.cancel(); } catch (_) {}
            if (!loc) throw Object.assign(new Error('Redirect with no Location'), { code: 'BAD_REDIRECT' });
            try { currentUrl = new URL(loc, currentUrl).toString(); }
            catch { throw Object.assign(new Error('Invalid redirect target'), { code: 'BAD_REDIRECT' }); }
            continue;
        }
        return resp;
    }
    throw Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' });
}

async function _probeFrameEmbeddable(targetUrl, embedOrigin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FRAME_CHECK_TIMEOUT);
    try {
        // HEAD first — cheapest; many servers echo the same security headers.
        let resp = await _probeFetchValidated(targetUrl, 'HEAD', controller.signal);
        // Some servers don't send XFO/CSP on HEAD (or reject it). Fall back to GET.
        const hasSecurityHdr = resp.headers.get('x-frame-options') ||
            /frame-ancestors/i.test(resp.headers.get('content-security-policy') || '');
        if (!hasSecurityHdr && resp.ok) {
            // HEAD responses shouldn't have a body per HTTP semantics, but some
            // servers send Content-Length anyway — cancel defensively so undici
            // doesn't hold the connection open waiting for a body we're not reading.
            try { resp.body?.cancel(); } catch (_) {}
            return false;
        }
        if (resp.status === 405 || resp.status === 501 || resp.status === 400 || !resp.ok) {
            // Cancel the HEAD response's body before we discard resp and reassign it —
            // same reasoning as above, this path was previously the only one handled.
            try { resp.body?.cancel(); } catch (_) {}
            resp = await _probeFetchValidated(targetUrl, 'GET', controller.signal);
            // Stream bodies are expensive; we only need headers, so cancel it.
            try { resp.body?.cancel(); } catch (_) {}
        } else {
            // Falls through to _isBlockedByHeaders with the HEAD response still
            // unconsumed — cancel it here too, this was the one path that never did.
            try { resp.body?.cancel(); } catch (_) {}
        }
        return _isBlockedByHeaders(resp, embedOrigin);
    } finally {
        clearTimeout(timer);
    }
}

function setupFrameCheckProxy(app) {
    app.get('/api/frame-check', frameCheckLimiter, requireSession, async (req, res) => {
        const raw = req.query.url;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        let urlObj;
        try { urlObj = new URL(raw); }
        catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }

        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are supported' });
        }

        const isPrivate = await _dnsCheckPrivate(urlObj.hostname);
        if (isPrivate) {
            return res.status(400).json({ error: 'Internal URLs are not permitted' });
        }

        const cacheKey = urlObj.origin; // headers are origin-scoped
        const cached = frameCheckCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < FRAME_CHECK_TTL) {
            return res.json({ embeddable: cached.embeddable, cached: true });
        }

        let blocked;
        try {
            blocked = await _probeFrameEmbeddable(urlObj.toString(), urlObj.origin);
        } catch (_) {
            // Network error / timeout → assume embeddable so we don't false-block.
            blocked = false;
        }

        if (frameCheckCache.size >= FRAME_CHECK_MAX) {
            frameCheckCache.delete(frameCheckCache.keys().next().value);
        }
        frameCheckCache.set(cacheKey, { embeddable: !blocked, ts: Date.now() });

        res.setHeader('Cache-Control', 'private, max-age=300');
        res.json({ embeddable: !blocked });
    });
}
// ── End Frame-Embed Check Proxy ────────────────────────────────────────────

// ── App Network Proxy ──────────────────────────────────────────────────────
// Used by app-sandbox.js handleNetFetch to make outbound requests server-side,
// bypassing browser CORS restrictions for apps with the net:external permission.
//
// Security model:
//   - Only reachable from the same origin (enforced by the sandbox's IPC flow;
//     the sandbox calls /api/proxy, not the iframe directly).
//   - Private/internal IPs blocked (SSRF prevention).
//   - Allowlisted HTTP methods only.
//   - Response size capped to prevent memory exhaustion.
//   - Rate limited per IP.

const APP_PROXY_TIMEOUT    = 30 * 1000;      // 30 s — match IPC timeout
const APP_PROXY_SIZE_CAP   = 10 * 1024 * 1024; // 10 MB
const APP_PROXY_METHODS    = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function requireSession(req, res, next) {
    if (!req.session || !req.session.id) {
        return res.status(401).json({ error: 'Unauthorized — session required' });
    }
    next();
}

const _PRIVATE_EXACT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]', '[::]']);
const _PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', '169.254.', '100.64.', '127.'];

function _isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (_PRIVATE_EXACT.has(h)) return true;
    if (_PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
}

// IPv4-mapped IPv6 (::ffff:a.b.c.d) — pull out the embedded v4 address so it
// hits the same range checks as a plain v4 literal.
function _extractMappedV4(ip) {
    const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
    return m ? m[1] : null;
}

function _isPrivateIpv4(ip) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return false;
    return parts[0] === 10 ||
           parts[0] === 127 ||                                    // loopback 127.0.0.0/8
           parts[0] === 0 ||                                      // "this network" 0.0.0.0/8
           (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
           (parts[0] === 192 && parts[1] === 168) ||
           (parts[0] === 169 && parts[1] === 254) ||               // link-local incl. cloud metadata
           (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127); // CGNAT
}

function _isPrivateIpv6(ip) {
    const h = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;                   // loopback / unspecified
    const mapped = _extractMappedV4(h);
    if (mapped) return _isPrivateIpv4(mapped);
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;                 // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;                 // link-local fe80::/10
    return false;
}

function _isPrivateIpAddr(ip) {
    if (!ip || typeof ip !== 'string') return true; // fail closed
    if (ip.includes(':')) return _isPrivateIpv6(ip);
    return _isPrivateIpv4(ip);
}

const _dnsPrivateCache = new Map();
const _DNS_TTL = 30_000;

// Resolves hostname -> { private, addresses, address, family } and caches the
// result. `addresses` holds every public resolved endpoint (IPv4 entries
// first) so the actual network connection can be pinned to an IP we validated
// (see _pinnedFetch), instead of letting fetch() re-resolve the hostname
// itself. Re-resolving is what opens the DNS-rebinding TOCTOU gap: validation
// lookup returns a public IP, then the fetch's own lookup (attacker-controlled
// DNS, low TTL) returns a private one moments later.
//
// `address`/`family` mirror addresses[0] for backward compatibility with
// callers that only want "the" resolved endpoint.
//
// All-addresses matters in practice: Node's lookup previously returned ONE
// address in OS preference (verbatim) order, which on dual-stack hosts is
// frequently an IPv6 address. On machines without a working IPv6 route the
// pinned connect to that address always throws and every proxied request
// 502s even though the IPv4 path is fine. Resolving everything, validating
// everything, and trying candidates in order keeps the SSRF guarantees while
// surviving single-stack breakage. If ANY resolved address is private the
// host fails closed (multi-address DNS is a known SSRF dodge).
async function _dnsResolvePrivate(hostname) {
    const failClosed = { private: true, address: null, family: null, addresses: [] };
    if (!hostname || typeof hostname !== 'string') return failClosed;
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (_isPrivateHost(h)) return failClosed;

    const cached = _dnsPrivateCache.get(h);
    if (cached && Date.now() - cached.ts < _DNS_TTL) return cached;

    let result;
    try {
        const all = await dns.promises.lookup(h, { all: true, verbatim: true });
        const seen = new Set();
        const uniq = [];
        for (const entry of all) {
            if (!entry || seen.has(entry.address)) continue;
            seen.add(entry.address);
            uniq.push({ address: entry.address, family: entry.family });
        }
        const anyPrivate = uniq.length === 0 || uniq.some((a) => _isPrivateIpAddr(a.address));
        // A blocked host exposes nothing usable — same contract as the other
        // fail-closed paths (empty lookup, DNS error): addresses stays empty.
        const candidates = anyPrivate
            ? []
            : uniq
                .filter((a) => !_isPrivateIpAddr(a.address))
                .sort((a, b) => (a.family === 4 ? -1 : 1) - (b.family === 4 ? -1 : 1));
        result = {
            private: anyPrivate,
            address: candidates[0] ? candidates[0].address : null,
            family: candidates[0] ? candidates[0].family : null,
            addresses: candidates,
            ts: Date.now(),
        };
    } catch {
        result = { ...failClosed, ts: Date.now() }; // fail closed on DNS error
    }

    _dnsPrivateCache.set(h, result);
    if (_dnsPrivateCache.size > 500) {
        const first = _dnsPrivateCache.keys().next().value;
        _dnsPrivateCache.delete(first);
    }
    return result;
}

// Backward-compatible boolean-only wrapper. IMPORTANT: any caller that goes
// on to fetch() the same hostname itself is still exposed to the rebinding
// TOCTOU. Use _dnsResolvePrivate + _pinnedFetch for anything that performs
// a real outbound request; this wrapper is for checks that don't fetch.
async function _dnsCheckPrivate(hostname) {
    const { private: isPrivate } = await _dnsResolvePrivate(hostname);
    return isPrivate;
}

// Fetch pinned to a pre-validated IP, closing the DNS-rebinding TOCTOU: we
// resolve+validate once via _dnsResolvePrivate, then force the TCP
// connection to that exact IP. Host header / TLS SNI still use the original
// hostname (undici handles this automatically — we only override the
// connect-time lookup, not the URL). If dnsResult indicates an
// invalid/private/unresolved address, this throws rather than silently
// falling back to fetch's own resolver.
// Lazy undici access: _pinnedAgent/_pinnedFetch read these off the undici
// module object at CALL time instead of destructuring at module load. Two
// reasons: the module doesn't pay undici's load cost until the first real
// outbound request, and the vitest suite can inject fakes by stubbing
// properties on the shared undici singleton (destructured load-time bindings
// would be impossible to intercept).
let _undici = null;
function undiciModules() {
    if (!_undici) _undici = require('undici');
    return _undici;
}
// Per-attempt connect budget. Keeps a candidate list of 2-3 addresses inside
// the proxy's 30 s total timeout: a dead first candidate costs at most 8 s
// before we fall through to the next validated address.
const PINNED_CONNECT_TIMEOUT_MS = 8000;
function _pinnedAgent(pinnedAddress, family) {
    const { Agent } = undiciModules();
    return new Agent({
        connect: {
            timeout: PINNED_CONNECT_TIMEOUT_MS,
            lookup: (_hostname, _opts, cb) => {
                cb(null, [{ address: pinnedAddress, family: family === 6 ? 6 : 4 }]);
            },
        },
    });
}
// Deliberately not pooled/reused across requests. A pinned agent's lookup
// override always returns whatever IP it was constructed with — reusing one
// across requests would mean a later request to the same host gets served
// from a *stale* pin instead of a fresh DNS check, which is exactly the
// rebinding gap this whole pinning scheme exists to close (validate now,
// connect to something else later). One agent per request, closed right
// after, is the correct trade-off here — not a missed pooling optimization.
async function _pinnedFetch(urlString, opts, dnsResult) {
    if (!dnsResult || dnsResult.private) {
        throw Object.assign(new Error('Refusing to fetch unvalidated/private address'), { code: 'SSRF_BLOCKED' });
    }
    const candidates = Array.isArray(dnsResult.addresses) && dnsResult.addresses.length
        ? dnsResult.addresses
        : (dnsResult.address ? [{ address: dnsResult.address, family: dnsResult.family }] : []);
    if (!candidates.length) {
        throw Object.assign(new Error('Refusing to fetch unvalidated/private address'), { code: 'SSRF_BLOCKED' });
    }
    // Try each validated IP in order (IPv4 first). A pinned connect to one
    // address can still fail (no IPv6 route, firewall, dead edge) — falling
    // through to the next validated address for the SAME host keeps the
    // SSRF pinning guarantee (every candidate came from the same validated
    // lookup) while surviving single-stack breakage.
    //
    // Only connection-setup failures reach this catch: once undici's fetch
    // resolves, mid-read errors throw at body-consumption time in the route
    // handler, never here — so falling through cannot duplicate a request
    // that already reached the wire.
    let lastErr;
    for (const candidate of candidates) {
        const agent = _pinnedAgent(candidate.address, candidate.family);
        try {
            return await undiciModules().fetch(urlString, { ...opts, dispatcher: agent });
        } catch (err) {
            lastErr = err;
        } finally {
            agent.close().catch(() => {});
        }
    }
    throw lastErr;
}

const appProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,  // generous — chat apps can send many messages per minute
    message: { error: 'Too many proxy requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: isTrustedSystemAppRequest,
});

function setupAppNetworkProxy(app) {
    app.post('/api/proxy', appProxyLimiter, requireSession, async (req, res) => {
        const { url: rawUrl, method: rawMethod, headers: reqHeaders, body: reqBody, bodyEncoding = 'utf8' } = req.body ?? {};

        // Validate URL
        if (!rawUrl || typeof rawUrl !== 'string') {
            return res.status(400).json({ error: 'url is required' });
        }
        let urlObj;
        try { urlObj = new URL(rawUrl); }
        catch (_) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are supported' });
        }
        if (_isPrivateHost(urlObj.hostname)) {
            ServerEventLog.log({
                app: 'AppNetworkProxy',
                severity: 'warn',
                message: `Blocked proxy request to private host: ${urlObj.hostname}`,
                data: { hostname: urlObj.hostname, reason: 'private_host' },
            });
            return res.status(403).json({ error: 'Internal URLs are not permitted' });
        }
        // dnsResult carries the resolved IP forward so the eventual fetch can be
        // pinned to it (see loop below) instead of re-resolving the hostname.
        let dnsResult = await _dnsResolvePrivate(urlObj.hostname);
        if (dnsResult.private) {
            ServerEventLog.log({
                app: 'AppNetworkProxy',
                severity: 'warn',
                message: `Blocked proxy request to private host (DNS-resolved): ${urlObj.hostname}`,
                data: { hostname: urlObj.hostname, reason: 'dns_private' },
            });
            return res.status(403).json({ error: 'Internal URLs are not permitted' });
        }

        // Validate method
        const method = (rawMethod || 'GET').toUpperCase();
        if (!APP_PROXY_METHODS.has(method)) {
            return res.status(400).json({ error: `Method not allowed: ${method}` });
        }

        // JSON IPC carries request bodies as UTF-8 strings or explicitly
        // base64-encoded bytes. Decode binary bodies only when the caller marks
        // them as such; do not guess based on payload contents.
        if (reqBody !== undefined && reqBody !== null && typeof reqBody !== 'string') {
            return res.status(400).json({ error: 'body must be a string' });
        }
        let outgoingBody = reqBody ?? null;
        if (bodyEncoding === 'base64') {
            if (typeof reqBody !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reqBody)) {
                return res.status(400).json({ error: 'Invalid base64 request body' });
            }
            outgoingBody = Buffer.from(reqBody, 'base64');
            if (outgoingBody.length > 6 * 1024 * 1024) {
                return res.status(413).json({ error: 'Request body too large' });
            }
        } else if (bodyEncoding !== 'utf8') {
            return res.status(400).json({ error: 'Unsupported request body encoding' });
        }

        // Strip hop-by-hop headers that must not be forwarded
        const HOP_BY_HOP = new Set([
            'host', 'connection', 'keep-alive', 'proxy-authenticate',
            'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade',
        ]);
        const outHeaders = {};
        if (reqHeaders && typeof reqHeaders === 'object') {
            for (const [k, v] of Object.entries(reqHeaders)) {
                if (!HOP_BY_HOP.has(k.toLowerCase())) {
                    outHeaders[k] = v;
                }
            }
        }

        // Follow redirects manually so each hop gets re-validated against the
        // private-host check (mirrors the pattern used by fetchEmailImage above).
        // Without this, a public URL that 302s to an internal/metadata address
        // would sail through the initial check and still reach it via fetch's
        // own automatic redirect handling.
        const MAX_PROXY_REDIRECTS = 5;
        let currentUrl = urlObj.toString();
        const visitedUrls = new Set();
        let resp;

        for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop++) {
            if (visitedUrls.has(currentUrl)) {
                ServerEventLog.log({
                    app: 'AppNetworkProxy',
                    severity: 'warn',
                    message: `Redirect loop detected proxying ${urlObj.hostname}`,
                    data: { hostname: urlObj.hostname },
                });
                return res.status(400).json({ error: 'Redirect loop detected' });
            }
            visitedUrls.add(currentUrl);

            let hopUrlObj;
            try { hopUrlObj = new URL(currentUrl); }
            catch (_) { return res.status(400).json({ error: 'Invalid redirect URL' }); }

            if (!['http:', 'https:'].includes(hopUrlObj.protocol)) {
                return res.status(400).json({ error: 'Only http and https URLs are supported' });
            }
            if (_isPrivateHost(hopUrlObj.hostname)) {
                return res.status(403).json({ error: 'Internal URLs are not permitted' });
            }
            // Re-resolve + re-validate on every hop (redirect targets can point
            // anywhere) and keep the resolved IP so the fetch below is pinned to
            // exactly what we just validated.
            dnsResult = await _dnsResolvePrivate(hopUrlObj.hostname);
            if (dnsResult.private) {
                return res.status(403).json({ error: 'Internal URLs are not permitted' });
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), APP_PROXY_TIMEOUT);

            let hopResp;
            try {
                hopResp = await _pinnedFetch(currentUrl, {
                    method,
                    headers: outHeaders,
                    body: (method === 'GET' || method === 'HEAD') ? undefined : outgoingBody,
                    redirect: 'manual',
                    signal: controller.signal,
                }, dnsResult);
            } catch (err) {
                clearTimeout(timer);
                const errCode = err.code || (err.cause && err.cause.code) || null;
                ServerEventLog.log({
                    app: 'AppNetworkProxy',
                    severity: 'error',
                    message: `Network error proxying ${urlObj.hostname}: ${err.message}`,
                    data: { hostname: urlObj.hostname, error: err.message, code: errCode, url: currentUrl },
                });
                // Surface the underlying cause code so callers (and the app
                // developer's console) can tell a dead IPv6 route from a TLS
                // failure from a timeout without server-side log access.
                return res.status(502).json({ error: `Network error: ${err.message}`, code: errCode });
            } finally {
                clearTimeout(timer);
            }

            if (hopResp.status >= 300 && hopResp.status < 400) {
                const loc = hopResp.headers.get('location');
                // Cancel hopResp's body before chasing the redirect — this response is
                // about to be discarded, not the accumulated resp from a prior hop
                // (resp is still unset on hop 0, which is why this has to check hopResp).
                try { hopResp.body?.cancel(); } catch (_) {}
                if (!loc) return res.status(502).json({ error: 'Redirect with no Location header' });
                try { currentUrl = new URL(loc, currentUrl).toString(); }
                catch (_) { return res.status(400).json({ error: 'Invalid redirect target' }); }
                continue;
            }

            resp = hopResp;
            break;
        }

        if (!resp) {
            return res.status(502).json({ error: 'Too many redirects' });
        }

        // Read response body with size cap
        const chunks = [];
        let total = 0;
        try {
            const reader = resp.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > APP_PROXY_SIZE_CAP) {
                    reader.cancel();
                    return res.status(502).json({ error: 'Response too large' });
                }
                chunks.push(value);
            }
        } catch (err) {
            return res.status(502).json({ error: `Read error: ${err.message}` });
        }

        const bodyBuffer = Buffer.concat(chunks.map(c => Buffer.from(c)));

        // Forward a safe subset of response headers
        const SAFE_RESPONSE_HEADERS = new Set([
            'content-type', 'content-language', 'cache-control',
            'etag', 'last-modified', 'x-request-id',
        ]);
        const outRespHeaders = {};
        for (const [k, v] of resp.headers.entries()) {
            if (SAFE_RESPONSE_HEADERS.has(k.toLowerCase())) {
                outRespHeaders[k] = v;
            }
        }

        const contentType = (outRespHeaders['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const isTextual = contentType.startsWith('text/')
            || contentType === 'application/json'
            || contentType === 'application/javascript'
            || contentType === 'application/xml'
            || contentType === 'application/x-www-form-urlencoded'
            || contentType.endsWith('+json')
            || contentType.endsWith('+xml');
        res.json({
            status:     resp.status,
            statusText: resp.statusText,
            headers:    outRespHeaders,
            body:       isTextual ? bodyBuffer.toString('utf8') : bodyBuffer.toString('base64'),
            bodyEncoding: isTextual ? 'utf8' : 'base64',
        });
    });
}
// ── End App Network Proxy ──────────────────────────────────────────────────

// ── Email Image Proxy (security-only) ───────────────────────────────────────
// Fetches a single email-embedded image server-side so the renderer never
// issues the request directly. This exists ONLY to prevent SSRF via
// attacker-controlled <img src> URLs in email HTML — it does NOT cache
// responses or attempt to defeat sender tracking pixels. Every hop (initial
// URL and any redirect target) is re-validated with the same
// _isPrivateHost / _dnsCheckPrivate checks used by the other proxies above.

const EMAIL_IMG_TIMEOUT  = 5000;
const EMAIL_IMG_SIZE_CAP = 5 * 1024 * 1024; // 5 MB
const EMAIL_IMG_MAX_REDIRECTS = 5;

async function _validateEmailImgHop(rawUrl) {
    let urlObj;
    try { urlObj = new URL(rawUrl); } catch { return null; }
    if (!['http:', 'https:'].includes(urlObj.protocol)) return null;
    if (urlObj.username || urlObj.password) return null;
    if (_isPrivateHost(urlObj.hostname)) return null;
    const dnsResult = await _dnsResolvePrivate(urlObj.hostname);
    if (dnsResult.private) return null;
    return { urlObj, dnsResult };
}

async function _fetchEmailImage(initialUrl) {
    let currentUrl = initialUrl;
    const visited = new Set();

    for (let hop = 0; hop <= EMAIL_IMG_MAX_REDIRECTS; hop++) {
        if (visited.has(currentUrl)) return null; // redirect loop
        visited.add(currentUrl);

        // Re-validate on every hop — a URL can pass the check, then redirect
        // to a private/internal address (classic SSRF-via-redirect bypass).
        const validated = await _validateEmailImgHop(currentUrl);
        if (!validated) return null;
        const { dnsResult } = validated;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMAIL_IMG_TIMEOUT);

        let resp;
        try {
            // Pinned to the IP we just validated — fetch() re-resolving the
            // hostname itself is the DNS-rebinding gap this closes.
            resp = await _pinnedFetch(currentUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AstroOS/1.0)' },
                redirect: 'manual', // never let fetch auto-follow — we must validate each hop ourselves
                signal: controller.signal,
            }, dnsResult);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            try { resp.body?.cancel(); } catch (_) {}
            if (!loc) return null;
            try { currentUrl = new URL(loc, currentUrl).toString(); } catch { return null; }
            continue;
        }

        if (!resp.ok) {
            try { resp.body?.cancel(); } catch (_) {}
            return null;
        }

        const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('image/')) {
            try { resp.body?.cancel(); } catch (_) {}
            return null;
        }

        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > EMAIL_IMG_SIZE_CAP) { reader.cancel(); return null; }
            chunks.push(value);
        }

        const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
        if (buf.length < 1) return null;
        return { buf, mime: contentType };
    }

    return null; // too many redirects
}

const emailImgLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 500, // a single HTML email can have 50+ images; allow rapid inbox browsing
    message: { error: 'Too many image requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: isTrustedSystemAppRequest,
});

// 1×1 transparent PNG returned on any validation/fetch failure — never leak
// *why* a fetch failed (avoids confirming internal-network topology to a
// sender probing which addresses are reachable).
const EMAIL_IMG_FALLBACK = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

function setupEmailImageProxy(app) {
    app.get('/api/email-image', emailImgLimiter, requireSession, async (req, res) => {
        const raw = req.query.url;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        const result = await _fetchEmailImage(raw);
        const buf  = result ? result.buf  : EMAIL_IMG_FALLBACK;
        const mime = result ? result.mime : 'image/png';

        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'no-store'); // no caching layer — security-only proxy
        res.send(buf);
    });
}
// ── End Email Image Proxy ───────────────────────────────────────────────────

module.exports = {
    setupFrameCheckProxy,
    setupAppNetworkProxy,
    setupEmailImageProxy,
    // Test-only access to the SSRF primitives (vitest mocks dns/undici).
    _internal: {
        _isPrivateHost,
        _isPrivateIpAddr,
        _dnsResolvePrivate,
        _pinnedFetch,
        _dnsPrivateCache,
    },
};