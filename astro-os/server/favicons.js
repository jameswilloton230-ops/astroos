'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const FAVICON_TTL = 24 * 60 * 60 * 1000; // 24 hours
const FAVICON_MAX = 500; // max cached entries
const FAVICON_FETCH_TIMEOUT = 4000; // 4s per attempt

// Persistent favicon cache
const FAVICON_DB_DIR = path.join(__dirname, '..', 'data');
const FAVICON_DB_PATH = path.join(FAVICON_DB_DIR, 'favicons.db');
fs.mkdirSync(FAVICON_DB_DIR, { recursive: true });

const faviconDb = new Database(FAVICON_DB_PATH);
faviconDb.exec(`CREATE TABLE IF NOT EXISTS favicons (
    hostname TEXT PRIMARY KEY,
    buf      BLOB NOT NULL,
    mime     TEXT NOT NULL,
    ts       INTEGER NOT NULL
)`);

const _fav = {
    get:   faviconDb.prepare('SELECT buf, mime, ts FROM favicons WHERE hostname = ?'),
    set:   faviconDb.prepare('INSERT OR REPLACE INTO favicons (hostname, buf, mime, ts) VALUES (?, ?, ?, ?)'),
    count: faviconDb.prepare('SELECT COUNT(*) as n FROM favicons').pluck(),
    evict: faviconDb.prepare('DELETE FROM favicons WHERE hostname = (SELECT hostname FROM favicons ORDER BY ts ASC LIMIT 1)'),
    clean: faviconDb.prepare('DELETE FROM favicons WHERE ts < ?'),
};

// Clean stale entries
_fav.clean.run(Date.now() - FAVICON_TTL);
console.log('[Favicon] Persistent cache:', FAVICON_DB_PATH);

const FAVICON_DEFAULT = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

const PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', '169.254.', '100.64.'];
const PRIVATE_EXACT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0',
    '[::1]', '[::]']);

function isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (PRIVATE_EXACT.has(h)) return true;
    if (PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
}

function validateFaviconDomain(raw) {
    let host = raw.trim().toLowerCase();
    host = host.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0];
    if (!host) return null;
    if (isPrivateHost(host)) return null;
    if (!host.includes('.') || /\s/.test(host)) return null;
    return host;
}

async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timer);
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

async function fetchIconUrl(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (isPrivateHost(parsed.hostname)) return null;
        const resp = await fetchWithTimeout(url, { headers: CLEAN_HEADERS, redirect: 'follow' });
        if (!resp.ok) return null;
        try {
            const finalHost = new URL(resp.url).hostname;
            if (isPrivateHost(finalHost)) return null;
        } catch (_) { return null; }
        
        const contentType = resp.headers.get('content-type') || '';
        if (contentType && !contentType.startsWith('image/') &&
            !contentType.includes('text/xml') && !contentType.includes('application/xml')) {
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
    } catch (_) { return null; }
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
        const domain = req.query.domain;
        if (!domain) return res.status(400).json({ error: 'domain required' });

        const hostname = validateFaviconDomain(domain);
        if (!hostname) return res.status(400).json({ error: 'Invalid domain' });

        // Check cache
        const cached = _fav.get.get(hostname);
        if (cached && cached.ts > Date.now() - FAVICON_TTL) {
            res.setHeader('Content-Type', cached.mime);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(cached.buf);
        }

        // Try to fetch
        let icon = await fetchIconUrl(`https://${hostname}/favicon.ico`);
        
        // Try common locations
        if (!icon) {
            icon = await fetchIconUrl(`https://${hostname}/apple-touch-icon.png`);
        }

        // Try DuckDuckGo as fallback
        if (!icon) {
            icon = await fetchIconUrl(`https://icons.duckduckgo.com/ip3/${hostname}.ico`);
        }

        if (!icon) {
            icon = { buf: FAVICON_DEFAULT, mime: 'image/png' };
        }

        // Cache it
        try {
            _fav.set.run(hostname, icon.buf, icon.mime, Date.now());
            if (_fav.count.get() > FAVICON_MAX) {
                _fav.evict.run();
            }
        } catch (_) { /* cache failure is non-fatal */ }

        res.setHeader('Content-Type', icon.mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(icon.buf);
    });
}

module.exports = { setupFaviconRoutes };
