import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock env vars BEFORE any server module loads ─────────────────────────────
process.env.NBOSP_CRED_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);
process.env.PORT = '3003';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
process.env.CORS_ORIGIN = 'https://localhost:3003';

const mockServer = {
  listen: vi.fn((port, host, cb) => {
    if (cb) cb();
  }),
  close: vi.fn((cb) => { if (cb) cb(); }),
  on: vi.fn(),
  keepAliveTimeout: 65000,
  headersTimeout: 66000,
  maxRequestsPerSocket: 1000,
};

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

vi.mock('https', () => ({
  createServer: vi.fn(() => mockServer),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => Buffer.from('mock-cert')),
    watch: vi.fn(),
  };
});

vi.mock('../../server/core/ssl.js', () => ({
  configureSSL: vi.fn(() => ({ server: mockServer })),
}));

vi.mock('../../server/middleware.js', async () => {
  const expressModule = await vi.importActual('express');
  const express = expressModule.default || expressModule;
  return {
    setupMiddleware: vi.fn(app => app.use(express.json())),
  };
});

vi.mock('../../server/routes.js', () => ({
  mountRoutes: vi.fn(),
}));

vi.mock('../../server/favicons.js', () => ({
  setupFaviconRoutes: vi.fn(),
}));

vi.mock('../../server/proxies.js', () => ({
  setupFrameCheckProxy: vi.fn(),
  setupAppNetworkProxy: vi.fn(),
}));

describe('server/core/index.js — server bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('imports and exports app, server, and listen without throwing', async () => {
    const mod = await import('../../server/core/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod.app).toBe('function');
    expect(mod.server).toBeDefined();
  });

  it('serves third-party package files whose stored paths use relative or Windows separators', async () => {
    const { app } = await import('../../server/core/index.js');
    const request = (await import('supertest')).default;
    const sandboxId = 'sandbox_local.vaultcraft.app_1440c7ca-a2fd-44f8-8b0c-eaa319937f03';
    const script = 'window.passwordStrength = true;';

    await request(app)
      .post('/api/apps/serve/register')
      .send({
        sandboxId,
        files: {
          './password-strength.js': btoa(script),
          'scripts\\helper.js': btoa('window.helper = true;'),
        },
      })
      .expect(200);

    const scriptResponse = await request(app)
      .get(`/api/apps/serve/${sandboxId}/password-strength.js`)
      .expect(200);
    expect(scriptResponse.headers['content-type']).toMatch(/^application\/javascript/);
    expect(scriptResponse.text).toBe(script);

    const nestedScriptResponse = await request(app)
      .get(`/api/apps/serve/${sandboxId}/scripts/helper.js`)
      .expect(200);
    expect(nestedScriptResponse.headers['content-type']).toMatch(/^application\/javascript/);
    expect(nestedScriptResponse.text).toBe('window.helper = true;');
  });

  it('serves the same files at the stable sandbox_<appId> alias and reports both base URLs', async () => {
    const { app } = await import('../../server/core/index.js');
    const request = (await import('supertest')).default;
    const appId = 'com.test.popuptest';
    const sandboxId = `sandbox_${appId}_e5be8755-c430-4f3f-802b-56b23abc3999`;
    const callbackBody = '<html><body>oauth callback</body></html>';

    const registerResponse = await request(app)
      .post('/api/apps/serve/register')
      .send({
        sandboxId,
        appId,
        files: {
          'index.html': btoa('<html><body>main</body></html>'),
          'callback.html': btoa(callbackBody),
        },
      })
      .expect(200);

    expect(registerResponse.body).toMatchObject({
      ok: true,
      baseUrl: `/api/apps/serve/${sandboxId}`,
      stableBaseUrl: `/api/apps/serve/sandbox_${appId}`,
    });

    // Session path (per-launch) and stable alias (survives relaunches) serve
    // the same bytes.
    const viaSession = await request(app)
      .get(`/api/apps/serve/${sandboxId}/callback.html`)
      .expect(200);
    expect(viaSession.text).toBe(callbackBody);

    const viaStable = await request(app)
      .get(`/api/apps/serve/sandbox_${appId}/callback.html`)
      .expect(200);
    expect(viaStable.text).toBe(callbackBody);
    expect(viaStable.headers['content-type']).toMatch(/^text\/html/);
  });

  it('rejects stable alias requests with malformed app ids or unbound sandbox ids', async () => {
    const { app } = await import('../../server/core/index.js');
    const request = (await import('supertest')).default;

    // Not one of the platform's app-id shapes (uppercase, no dot).
    await request(app)
      .post('/api/apps/serve/register')
      .send({ sandboxId: 'sandbox_BadApp_1', appId: 'BadApp', files: { 'index.html': btoa('x') } })
      .expect(400);
    // sandbox_-prefixed id without a UUID suffix would blur session vs alias.
    await request(app)
      .post('/api/apps/serve/register')
      .send({ sandboxId: 'sandbox_nodot_1', appId: 'nodot', files: { 'index.html': btoa('x') } })
      .expect(400);
    // Session key embeds a different app id than the alias claims.
    await request(app)
      .post('/api/apps/serve/register')
      .send({
        sandboxId: 'sandbox_com.other.app_1440c7ca-a2fd-44f8-8b0c-eaa319937f03',
        appId: 'com.victim.app',
        files: { 'index.html': btoa('x') },
      })
      .expect(400);
  });

  it('keeps the alias owned by the most recent launch: older-session unregister preserves it, owner unregister drops it', async () => {
    const { app } = await import('../../server/core/index.js');
    const request = (await import('supertest')).default;
    const appId = 'com.test.multilaunch';
    const stableUrl = `/api/apps/serve/sandbox_${appId}`;

    const first = `sandbox_${appId}_11111111-1111-4111-8111-111111111111`;
    const second = `sandbox_${appId}_22222222-2222-4222-8222-222222222222`;
    const firstBody = btoa('<html>first launch</html>');
    const secondBody = btoa('<html>second launch</html>');

    await request(app)
      .post('/api/apps/serve/register')
      .send({ sandboxId: first, appId, files: { 'index.html': firstBody } })
      .expect(200);
    // Relaunch: same app id, new session key — the alias now resolves to the
    // newest launch while the first launch's session path keeps its own copy.
    await request(app)
      .post('/api/apps/serve/register')
      .send({ sandboxId: second, appId, files: { 'index.html': secondBody } })
      .expect(200);

    expect((await request(app).get(`${stableUrl}/index.html`).expect(200)).text)
      .toBe('<html>second launch</html>');
    expect((await request(app).get(`/api/apps/serve/${first}/index.html`).expect(200)).text)
      .toBe('<html>first launch</html>');

    // First (older) window closes — must NOT evict the newer launch's alias.
    await request(app).delete(`/api/apps/serve/unregister/${first}`).expect(200);
    expect((await request(app).get(`${stableUrl}/index.html`).expect(200)).text)
      .toBe('<html>second launch</html>');

    // Last window closes — the app is gone, so the stable URL stops serving.
    await request(app).delete(`/api/apps/serve/unregister/${second}`).expect(200);
    await request(app).get(`${stableUrl}/index.html`).expect(404);
    await request(app).get(`/api/apps/serve/${second}/index.html`).expect(404);
  });

  it('keeps a live sandbox registered past the idle TTL via heartbeat, and prunes silent ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const BASE = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(BASE);
      const { app } = await import('../../server/core/index.js');
      const request = (await import('supertest')).default;

      const quiet = 'sandbox_com.test.quiet_33333333-3333-4333-8333-333333333333';
      const lively = 'sandbox_com.test.lively_44444444-4444-4444-8444-444444444444';
      await request(app)
        .post('/api/apps/serve/register')
        .send({ sandboxId: quiet, files: { 'index.html': btoa('quiet') } })
        .expect(200);
      await request(app)
        .post('/api/apps/serve/register')
        .send({ sandboxId: lively, appId: 'com.test.lively', files: { 'index.html': btoa('lively') } })
        .expect(200);

      // A live sandbox keeps beating past the 30-minute idle TTL...
      vi.setSystemTime(BASE + 25 * 60 * 1000);
      await request(app).post('/api/apps/serve/heartbeat').send({ sandboxId: lively }).expect(200);
      // ...while heartbeats for unknown ids are a harmless 404.
      await request(app)
        .post('/api/apps/serve/heartbeat')
        .send({ sandboxId: 'sandbox_com.test.ghost_55555555-5555-4555-8555-555555555555' })
        .expect(404);

      // Registering another app runs the idle prune: the sandbox that never
      // beat (or got served) is gone, the heartbeat-kept one survives.
      vi.setSystemTime(BASE + 40 * 60 * 1000);
      await request(app)
        .post('/api/apps/serve/register')
        .send({ sandboxId: 'sandbox_com.test.later_66666666-6666-4666-8666-666666666666', files: { 'index.html': btoa('later') } })
        .expect(200);

      await request(app).get(`/api/apps/serve/${quiet}/index.html`).expect(404);
      const livelyResponse = await request(app)
        .get('/api/apps/serve/sandbox_com.test.lively/index.html')
        .expect(200);
      expect(livelyResponse.text).toBe('lively');
    } finally {
      vi.useRealTimers();
    }
  });

  it('mocks are correctly wired for ssl, middleware, routes, and favicons', async () => {
    const ssl = await import('../../server/core/ssl.js');
    const middleware = await import('../../server/middleware.js');
    const routes = await import('../../server/routes.js');
    const favicons = await import('../../server/favicons.js');

    const mockApp = { use: vi.fn(), get: vi.fn() };
    ssl.configureSSL(mockApp);
    middleware.setupMiddleware(mockApp);
    routes.mountRoutes(mockApp);
    favicons.setupFaviconRoutes(mockApp);

    expect(ssl.configureSSL).toHaveBeenCalled();
    expect(middleware.setupMiddleware).toHaveBeenCalled();
    expect(routes.mountRoutes).toHaveBeenCalled();
    expect(favicons.setupFaviconRoutes).toHaveBeenCalled();
  });
});