import { describe, expect, it } from 'vitest';
import middleware from '../../server/middleware.js';

const { shouldSkipGlobalApiRateLimit } = middleware;

function request(originalUrl, path) {
  return {
    originalUrl,
    path,
    get: () => undefined,
  };
}

describe('global API rate-limit exclusions', () => {
  it('excludes app registration using the full route despite Express mount stripping', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/register?retry=1', '/apps/serve/register')
    )).toBe(true);
  });

  it('excludes the per-sandbox app-serve liveness heartbeat', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/heartbeat', '/apps/serve/heartbeat')
    )).toBe(true);
  });

  it('keeps mounted-path exclusions and does not skip ordinary API requests', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/unregister/sandbox_a', '/apps/serve/unregister/sandbox_a')
    )).toBe(true);
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/list', '/apps/list')
    )).toBe(false);
  });

  it('excludes the whole per-sandbox app-serve content surface', () => {
    // App windows load their content tree (HTML/JS/CSS/icons) through
    // /api/apps/serve/<sandbox>/… via navigation and <script>/<link>/<img>
    // tags that cannot carry trust headers. Field failure before this
    // exemption: a few app launches exhausted the global per-IP budget and
    // 429'd the whole desktop — default launcher included — for 15 minutes.
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/asset', '/apps/serve/asset')
    )).toBe(true);
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/sandbox_abc/index.html', '/apps/serve/sandbox_abc/index.html')
    )).toBe(true);
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/sandbox_abc/icon.png', '/apps/serve/sandbox_abc/icon.png')
    )).toBe(true);
  });

  it('still limits non-serve API surfaces that unsigned guests can reach', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/security/sessions', '/security/sessions')
    )).toBe(false);
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/settings', '/settings')
    )).toBe(false);
  });
});
