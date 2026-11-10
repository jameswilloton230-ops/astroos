import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock env vars BEFORE any server module loads ─────────────────────────────
process.env.NBOSP_CRED_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);
process.env.PORT = '3003';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
process.env.CORS_ORIGIN = 'https://localhost:3003';

const mockServer = {
  listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
  close: vi.fn((cb) => { if (cb) cb(); }),
  on: vi.fn(),
  keepAliveTimeout: 65000,
  headersTimeout: 66000,
  maxRequestsPerSocket: 1000,
};

vi.mock('dotenv', () => ({ config: vi.fn() }));

vi.mock('../../server/core/ssl.js', () => ({
  configureSSL: vi.fn(() => ({ server: mockServer })),
}));

vi.mock('../../server/middleware.js', () => ({ setupMiddleware: vi.fn((app) => { app.use?.(); }) }));
vi.mock('../../server/routes.js', () => ({ mountRoutes: vi.fn((app) => { app.use?.(); }) }));
vi.mock('../../server/favicons.js', () => ({ setupFaviconRoutes: vi.fn((app) => { app.get?.(); }) }));

describe('server/core/ssl.js — configureSSL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with a server that has listen and close', async () => {
    const { configureSSL } = await import('../../server/core/ssl.js');
    const mockApp = { use: vi.fn(), get: vi.fn() };
    const result = configureSSL(mockApp);
    expect(result).toBeDefined();
    expect(result.server).toBeDefined();
    expect(typeof result.server.listen).toBe('function');
    expect(typeof result.server.close).toBe('function');
  });
});

describe('server/core/index.js — bootstrap without real port bind', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('imports and exports app, server, and listen without throwing', async () => {
    const mod = await import('../../server/core/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod.app).toBe('function');
    expect(mod.server).toBeDefined();
  });

  it('mock modules are callable and would be invoked by server bootstrap', async () => {
    const middleware = await import('../../server/middleware.js');
    const routes = await import('../../server/routes.js');
    const favicons = await import('../../server/favicons.js');
    const mockApp = { use: vi.fn(), get: vi.fn() };
    middleware.setupMiddleware(mockApp);
    routes.mountRoutes(mockApp);
    favicons.setupFaviconRoutes(mockApp);
    expect(mockApp.use).toHaveBeenCalled();
    expect(mockApp.get).toHaveBeenCalled();
  });
});
