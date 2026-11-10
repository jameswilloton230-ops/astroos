'use strict';

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const Database = require('better-sqlite3');
const { Agent, fetch: undiciFetch } = require('undici');
const { getRuntimeDataDir } = require('../scripts/runtime-data-dir');

const FAVICON_TTL = 24 * 60 * 60 * 1000; // 24 hours
const FAVICON_MAX = 500; // max cached entries
const FAVICON_FETCH_TIMEOUT = 4000; // 4s per attempt
const FAVICON_MAX_REDIRECTS = 5;

// Persistent favicon cache
const FAVICON_DB_DIR = path.join(getRuntimeDataDir(path.resolve(__dirname, '..')), 'data');
const FAVICON_DB_PATH = path.join(FAVICON_DB_DIR, 'favicons.db');
fs.mkdirSync(FAVICON_DB_DIR, { recursive: true });

const faviconDb = new Database(FAVICON_DB_PATH);
// WAL lets a read (cache hit) and a write (new entry landing) proceed without
// blocking each other — matters once favicon lookups start overlapping under load.
faviconDb.pragma('journal_mode = WAL');
faviconDb.exec(`CREATE TABLE IF NOT EXISTS favicons (
    hostname TEXT PRIMARY KEY,
    buf      BLOB NOT NULL,
    mime     TEXT NOT NULL,
    ts       INTEGER NOT NULL
)`);

const _fav = {
    get:   faviconDb.prepare('SELECT buf, mime, ts FROM favicons WHERE hostname = ?'),
    set:   faviconDb.prepare('INSERT OR REPLACE INTO favicons (hostname, buf, mime, ts) VALUES (?, ?, ?, ?)'),
    delete: faviconDb.prepare('DELETE FROM favicons WHERE hostname = ?'),
    count: faviconDb.prepare('SELECT COUNT(*) as n FROM favicons').pluck(),
    evict: faviconDb.prepare('DELETE FROM favicons WHERE hostname = (SELECT hostname FROM favicons ORDER BY ts ASC LIMIT 1)'),
    clean: faviconDb.prepare('DELETE FROM favicons WHERE ts < ?'),
};

// Clean stale entries on boot
_fav.clean.run(Date.now() - FAVICON_TTL);

function log(level, message, context = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: 'favicon', message, ...context });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
log('info', 'Persistent cache ready', { path: FAVICON_DB_PATH });

const FAVICON_DEFAULT = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

const PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', '169.254.', '100.64.', '127.'];
const PRIVATE_EXACT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0',
    '[::1]', '[::]']);

function isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (PRIVATE_EXACT.has(h)) return true;
    if (PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
}

function isPrivateIpv4(ip) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return false;
    return parts[0] === 10 ||
           parts[0] === 127 ||
           parts[0] === 0 ||
           (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
           (parts[0] === 192 && parts[1] === 168) ||
           (parts[0] === 169 && parts[1] === 254) ||
           (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function extractMappedV4(ip) {
    const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
    return m ? m[1] : null;
}

function isPrivateIpv6(ip) {
    const h = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;
    const mapped = extractMappedV4(h);
    if (mapped) return isPrivateIpv4(mapped);
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
    return false;
}

function isPrivateIpAddr(ip) {
    if (!ip || typeof ip !== 'string') return true; // fail closed
    return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

// hostname -> { private, address, family, ts }. Same shape and TTL as the
// resolver in proxies.js — kept here as its own cache since favicons.js has
// no dependency on that module and duplicating ~15 lines is cheaper than
// wiring up a shared import for a one-off cache.
const dnsPrivateCache = new Map();
const DNS_TTL = 30_000;

async function dnsResolvePrivate(hostname) {
    if (!hostname || typeof hostname !== 'string') return { private: true, address: null, family: null };
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isPrivateHost(h)) return { private: true, address: null, family: null };

    const cached = dnsPrivateCache.get(h);
    if (cached && Date.now() - cached.ts < DNS_TTL) return cached;

    let result;
    try {
        const { address, family } = await dns.promises.lookup(h);
        result = { private: isPrivateIpAddr(address), address, family, ts: Date.now() };
    } catch {
        result = { private: true, address: null, family: null, ts: Date.now() }; // fail closed on DNS error
    }

    dnsPrivateCache.set(h, result);
    if (dnsPrivateCache.size > 500) {
        dnsPrivateCache.delete(dnsPrivateCache.keys().next().value);
    }
    return result;
}

function validateFaviconDomain(raw) {
    let host = raw.trim().toLowerCase();
    host = host.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0];
    if (!host) return null;
    if (isPrivateHost(host)) return null;
    if (!host.includes('.') || /\s/.test(host)) return null;
    return host;
}

// Pins the TCP connection to the exact IP dnsResolvePrivate already validated.
// Without this, fetch() re-resolves the hostname itself at connect time —
// that second lookup is the DNS-rebinding gap: validation sees a public IP,
// then a low-TTL attacker-controlled record flips to a private one before
// the actual request goes out. Host header / TLS SNI still use the original
// hostname; only the connect-time lookup is overridden.
function pinnedAgent(pinnedAddress, family) {
    return new Agent({
        connect: {
            lookup: (_hostname, _opts, cb) => {
                cb(null, [{ address: pinnedAddress, family: family === 6 ? 6 : 4 }]);
            },
        },
    });
}

async function pinnedFetch(urlString, opts, dnsResult) {
    if (!dnsResult || dnsResult.private || !dnsResult.address) {
        throw Object.assign(new Error('Refusing to fetch unvalidated/private address'), { code: 'SSRF_BLOCKED' });
    }
    const agent = pinnedAgent(dnsResult.address, dnsResult.family);
    try {
        return await undiciFetch(urlString, { ...opts, dispatcher: agent });
    } finally {
        agent.close().catch(() => {});
    }
}

const CLEAN_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)',
    'Accept':     'image/avif,image/png,image/x-icon,image/svg+xml,image/*,*/*;q=0.8',
};

function normaliseFaviconMime(buf, headerMime) {
    if (buf.length >= 4) {
        // PNG: \x89PNG
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
        // GIF: GIF8
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
        // JPEG: \xff\xd8\xff
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
        // WebP: RIFF????WEBP
        if (buf.length >= 12 &&
            buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
            buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
        // AVIF/AVIS
        if (buf.length >= 12 &&
            buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
            const brand = buf.slice(8, 12).toString('ascii');
            if (brand === 'avif' || brand === 'avis') return 'image/avif';
        }
        // ICO: \x00\x00\x01\x00
        if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
        // SVG
        const head = buf.slice(0, 256).toString('utf8');
        if (/<svg[\s>]/i.test(head) || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) return 'image/svg+xml';
    }
    if (headerMime && headerMime.startsWith('image/')) return headerMime;
    return null;
}

function extractBestIcoImage(icoBuf) {
    try {
        if (icoBuf.length < 6) return null;
        if (icoBuf[0] !== 0x00 || icoBuf[1] !== 0x00 ||
            icoBuf[2] !== 0x01 || icoBuf[3] !== 0x00) return null;
        const count = icoBuf.readUInt16LE(4);
        if (count === 0 || count > 256 || icoBuf.length < 6 + count * 16) return null;

        let best = null;
        for (let i = 0; i < count; i++) {
            const dir = 6 + i * 16;
            const w = icoBuf[dir] || 256;
            const h = icoBuf[dir + 1] || 256;
            const imageSize = icoBuf.readUInt32LE(dir + 8);
            const imageOffset = icoBuf.readUInt32LE(dir + 12);
            if (imageOffset + imageSize > icoBuf.length) continue;
            if (!best || w * h > best.area) {
                best = { area: w * h, imageOffset, imageSize };
            }
        }
        if (!best) return null;

        const frame = icoBuf.slice(best.imageOffset, best.imageOffset + best.imageSize);
        const isPng = frame[0] === 0x89 && frame[1] === 0x50 &&
                      frame[2] === 0x4e && frame[3] === 0x47;
        return isPng ? { buf: frame, mime: 'image/png' } : null;
    } catch (_) { return null; }
}

// Fetches a candidate icon URL with per-hop SSRF revalidation and IP pinning.
// redirect: 'manual' + our own loop replaces the old redirect: 'follow' +
// after-the-fact hostname check — by the time you can inspect resp.url with
// 'follow', fetch already connected to every hop along the way, so a private
// IP on hop 2 would already have been hit before you ever get to reject it.
async function fetchIconUrl(initialUrl) {
    let currentUrl = initialUrl;
    const visited = new Set();

    for (let hop = 0; hop <= FAVICON_MAX_REDIRECTS; hop++) {
        if (visited.has(currentUrl)) return null; // redirect loop
        visited.add(currentUrl);

        let urlObj;
        try { urlObj = new URL(currentUrl); } catch { return null; }
        if (!['http:', 'https:'].includes(urlObj.protocol)) return null;

        const dnsResult = await dnsResolvePrivate(urlObj.hostname);
        if (dnsResult.private) return null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT);

        let resp;
        try {
            resp = await pinnedFetch(currentUrl, {
                headers: CLEAN_HEADERS,
                redirect: 'manual',
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

        const contentType = resp.headers.get('content-type') || '';
        if (contentType && !contentType.startsWith('image/') &&
            !contentType.includes('text/xml') && !contentType.includes('application/xml')) {
            try { resp.body?.cancel(); } catch (_) {}
            return null;
        }

        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > 1024 * 1024) return null;

        const bufNode = Buffer.from(buf);
        const mime = normaliseFaviconMime(bufNode, contentType);
        if (!mime) return null;

        // Try to extract PNG from ICO if embedded
        if (mime === 'image/x-icon') {
            const extracted = extractBestIcoImage(bufNode);
            if (extracted) return extracted;
        }

        return { buf: bufNode, mime };
    }

    return null; // too many redirects
}

function setupFaviconRoutes(app) {
    // Static favicon
    app.get('/favicon.ico', (req, res) => {
        const favicon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADklEQVQ4T2NkGAWjgHoAAAJ6AAFhyv0xAAAAAElFTkSuQmCC', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(favicon);
    });

    // Favicon proxy
    app.get('/api/favicon', async (req, res) => {
        const requestedUrl = req.query.url;
        let hostname;
        let iconUrl = null;
        if (requestedUrl) {
            try {
                const parsed = new URL(requestedUrl);
                hostname = validateFaviconDomain(parsed.hostname);
                if (!['http:', 'https:'].includes(parsed.protocol) || !hostname
                    || parsed.username || parsed.password || parsed.port) {
                    return res.status(400).json({ error: 'Invalid favicon URL' });
                }
                iconUrl = parsed.href;
            } catch (_) {
                return res.status(400).json({ error: 'Invalid favicon URL' });
            }
        } else {
            const domain = req.query.domain;
            if (!domain) return res.status(400).json({ error: 'domain or url required' });
            hostname = validateFaviconDomain(domain);
        }
        if (!hostname) return res.status(400).json({ error: 'Invalid domain' });

        // URL-specific icons cannot share the hostname cache because a site
        // may declare several distinct icon paths.
        const cached = iconUrl ? null : _fav.get.get(hostname);
        if (cached && cached.ts > Date.now() - FAVICON_TTL) {
            if (!cached.buf.equals(FAVICON_DEFAULT)) {
                res.setHeader('Content-Type', cached.mime);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(cached.buf);
            }
            // Older versions cached the transparent placeholder as if it
            // were a real icon, making a temporary fetch failure last a day.
            _fav.delete.run(hostname);
        }

        let icon = iconUrl ? await fetchIconUrl(iconUrl) : null;
        if (!icon) icon = await fetchIconUrl(`https://${hostname}/favicon.ico`);

        // Try common locations
        if (!icon) {
            icon = await fetchIconUrl(`https://${hostname}/apple-touch-icon.png`);
        }

        // Try DuckDuckGo as fallback
        if (!icon) {
            icon = await fetchIconUrl(`https://icons.duckduckgo.com/ip3/${hostname}.ico`);
        }

        if (!icon) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).json({ error: 'Favicon not found' });
        }

        if (!iconUrl) {
            try {
                _fav.set.run(hostname, icon.buf, icon.mime, Date.now());
                if (_fav.count.get() > FAVICON_MAX) {
                    _fav.evict.run();
                }
            } catch (err) {
                log('warn', 'Cache write failed (non-fatal)', { hostname, error: err.message });
            }
        }

        res.setHeader('Content-Type', icon.mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(icon.buf);
    });
}

// Lets index.js close the DB handle cleanly on graceful shutdown, same as
// the session DB in middleware.js — nothing was calling this before.
function closeFaviconDb() {
    try { faviconDb.close(); } catch (_) { /* already closed or never opened */ }
}

module.exports = { setupFaviconRoutes, closeFaviconDb };