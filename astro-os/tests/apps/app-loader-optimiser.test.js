// tests/apps/app-loader-optimiser.test.js — service app: package prefetch API.
import { describe, expect, it } from 'vitest';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

function fetchServing(packages) {
  return (file) => {
    const pkg = packages[file];
    if (!pkg) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(pkg) });
  };
}

describe('AppLoaderOptimizer service (js/apps/app-loader-optimiser)', () => {
  it('attaches a frozen AppLoaderOptimizer to window', async () => {
    const { window } = await loadServiceApp('app-loader-optimiser');
    const svc = window.AppLoaderOptimizer;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    for (const m of ['start', 'getPackage', 'getStats', 'clear']) {
      expect(typeof svc[m]).toBe('function');
    }
  });

  it('rejects start() without a bundle array', async () => {
    const { window } = await loadServiceApp('app-loader-optimiser');
    // Cross-realm (jsdom) TypeError — match the message, not the class.
    expect(() => window.AppLoaderOptimizer.start('nope')).toThrow(/must be an array/);
    expect(() => window.AppLoaderOptimizer.start(null)).toThrow(/must be an array/);
  });

  it('prefetches bundles via fetch and reports stats', async () => {
    const pkg = { manifest: { id: 'com.test.a' }, payload: 'x' };
    const { window, window: { nova } } = await loadServiceApp('app-loader-optimiser', {
      stubs: { fetch: fetchServing({ '/apps/a.novaapp': pkg }) },
    });
    const result = await window.AppLoaderOptimizer.start([
      { id: 'com.test.a', file: '/apps/a.novaapp', cacheKey: 'k1' },
      { id: 'com.test.b', file: '/apps/missing.novaapp', cacheKey: 'k2' },
    ]);
    expect(result.packages).toBe(2);
    expect(result.failed).toBe(1); // the 404 bundle is counted, not thrown
    expect(result.finishedAt).toBeGreaterThan(0);
  });

  it('caches getPackage() promises per file+cacheKey and serves the payload', async () => {
    const pkg = { manifest: { id: 'com.test.c' } };
    const { window } = await loadServiceApp('app-loader-optimiser', {
      stubs: { fetch: fetchServing({ '/apps/c.novaapp': pkg }) },
    });
    const p1 = window.AppLoaderOptimizer.getPackage('/apps/c.novaapp', 'k9');
    const p2 = window.AppLoaderOptimizer.getPackage('/apps/c.novaapp', 'k9');
    expect(p1).toBe(p2); // same key -> same inflight promise
    await expect(p1).resolves.toEqual(pkg);
    const other = window.AppLoaderOptimizer.getPackage('/apps/c.novaapp', 'other');
    expect(other).not.toBe(p1);
    await expect(window.AppLoaderOptimizer.getPackage('/apps/c.novaapp', 'other')).resolves.toEqual(pkg);
  });

  it('throws for a missing package path and rejects on failed fetch', async () => {
    const { window } = await loadServiceApp('app-loader-optimiser', {
      stubs: { fetch: fetchServing({}) },
    });
    // Missing path -> rejected promise (async validation), not a sync throw.
    await expect(window.AppLoaderOptimizer.getPackage('', 'k')).rejects.toThrow(/path is required/);
    await expect(window.AppLoaderOptimizer.getPackage('/apps/none.novaapp', 'k')).rejects.toThrow(/HTTP 404/);
  });

  it('clear() resets stats and the promise cache', async () => {
    const pkg = { ok: 1 };
    const { window } = await loadServiceApp('app-loader-optimiser', {
      stubs: { fetch: fetchServing({ '/apps/x.novaapp': pkg }) },
    });
    await window.AppLoaderOptimizer.getPackage('/apps/x.novaapp', 'k');
    await settle();
    window.AppLoaderOptimizer.clear();
    const stats = window.AppLoaderOptimizer.getStats();
    expect(stats).toEqual({ startedAt: null, finishedAt: null, packages: 0, cachedPackages: 0 });
    // Same key now re-fetches instead of returning the cleared promise.
    await expect(window.AppLoaderOptimizer.getPackage('/apps/x.novaapp', 'k')).resolves.toEqual(pkg);
  });
});
