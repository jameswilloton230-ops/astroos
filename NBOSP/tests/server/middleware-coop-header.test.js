import { describe, expect, it, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

// middleware.js reads NBOSP_DATA_DIR at import time (the session SQLite db
// lives under it), so the env must be set before the module is imported.
// Static imports would hoist past this assignment — use a dynamic one.
process.env.NBOSP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-coop-test-'));
process.env.SESSION_SECRET = 'c'.repeat(64);

const { setupMiddleware, closeSessionDb } = await import('../../server/middleware.js');

afterAll(() => {
    closeSessionDb();
});

// Real HTTP through node:http — test/setup.js stubs globalThis.fetch with a
// bare vi.fn(), so the global cannot be used for live requests here.
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            res.resume();
            res.on('end', () => resolve(res));
        }).on('error', reject);
    });
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('Cross-Origin-Opener-Policy on OS-served responses', () => {
    // Field evidence, two serial captures, one failure signature each:
    //
    // 2026-11-03 22:48 — callback served with helmet 8's default COOP
    // `same-origin`: popup landed on callback.html with window.opener null.
    //
    // 2026-11-03 23:04 (commit f23df12) switched the global to
    // `same-origin-allow-popups` on the theory that it keeps opener-related
    // documents in one browsing context group. Field capture 2026-11-03 23:44
    // (deployed app-sandbox.js hash f14b6811 matching this tree) shows the
    // IDENTICAL signature: opener=ABSENT, relay dropped. The theory was wrong
    // about direction: the soap relaxation only applies at POPUP CREATION
    // ("check if popup COOP values requires a browsing context group switch",
    // step 2: opener soap + response unsafe-none stays). Every hop INSIDE an
    // existing popup uses the ordinary "matching opener policy values"
    // algorithm, whose step 2 returns false whenever either side is
    // unsafe-none — so a provider page (github.com sends no COOP at all)
    // navigating to our soap callback splits the group just like same-origin
    // did, severing window.opener again.
    //
    // Pinned empirically (headless Chromium, matrix reproducing the OS
    // structure: sandboxed opaque-origin guest iframe -> window.open ->
    // 302 + report-only-COOP provider chain -> callback served with the
    // variant under test): the opener survives and the postMessage relay
    // arrives ONLY with unsafe-none on the callback document — for both
    // soap and unsafe-none guest variants.
    //
    // The app serve surface therefore carries unsafe-none: an unsafe-none
    // document never requires a browsing context group switch, so the popup
    // stays in the opener's group for its whole life. The surface cannot be
    // narrowed to "callback.html": the app chooses its own relay-target
    // filename, and every document served here is a potential popup target.
    it('serves app documents under /api/apps/serve with unsafe-none so opener relays survive', async () => {
        const app = express();
        setupMiddleware(app);
        app.get('/api/apps/serve/sandbox_com.test.githubauth/callback.html',
            (req, res) => res.type('html').send('<html><body>ok</body></html>'));
        app.get('/api/apps/serve/sandbox_com.test.githubauth/index.html',
            (req, res) => res.type('html').send('<html><body>app</body></html>'));

        const server = await listen(app);
        try {
            const callback = await httpGet(
                `http://127.0.0.1:${server.address().port}/api/apps/serve/sandbox_com.test.githubauth/callback.html?code=abc&state=s`);
            expect(callback.statusCode).toBe(200);
            expect(callback.headers['cross-origin-opener-policy']).toBe('unsafe-none');

            const appDoc = await httpGet(
                `http://127.0.0.1:${server.address().port}/api/apps/serve/sandbox_com.test.githubauth/index.html`);
            expect(appDoc.headers['cross-origin-opener-policy']).toBe('unsafe-none');
        } finally {
            await new Promise(r => server.close(r));
        }
    });

    it('keeps same-origin-allow-popups on OS UI pages outside the app serve surface', async () => {
        const app = express();
        setupMiddleware(app);
        app.get('/', (req, res) => res.type('html').send('<html><body>shell</body></html>'));

        const server = await listen(app);
        try {
            const res = await httpGet(`http://127.0.0.1:${server.address().port}/`);
            expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
        } finally {
            await new Promise(r => server.close(r));
        }
    });
});
