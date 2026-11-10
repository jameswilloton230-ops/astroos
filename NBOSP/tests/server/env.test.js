import { describe, it, expect, beforeEach, vi } from 'vitest';

const originalConsoleError = console.error;
const originalConsoleLog = console.log;

describe('server/core/env.js — validateEnvironment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    console.error = vi.fn();
    console.log = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  function runValidation(envOverrides = {}) {
    // Save original env
    const originalEnv = { ...process.env };

    // Build a completely fresh env object
    const freshEnv = {};
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value !== null && value !== undefined) {
        freshEnv[key] = value;
      }
    }
    process.env = freshEnv;

    // Clear ALL require caches to ensure fresh module load
    for (const key of Object.keys(require.cache)) {
      if (key.includes('server/core/env') || key.includes('server/core/index')) {
        delete require.cache[key];
      }
    }

    let threw = false;
    let error = null;
    try {
      const { validateEnvironment } = require('../../server/core/env.js');
      validateEnvironment();
    } catch (e) {
      threw = true;
      error = e;
    }

    process.env = originalEnv;
    return { threw, error };
  }

  it('passes when all required env vars are set correctly', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(false);
  });

  it('throws when NBOSP_CRED_KEY is missing', () => {
    // Don't include NBOSP_CRED_KEY at all - it will be missing from process.env
    const result = runValidation({
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('NBOSP_CRED_KEY');
  });

  it('throws when SESSION_SECRET is empty', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: '',
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('SESSION_SECRET');
  });

  it('throws when secrets are too short', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'short',
      SESSION_SECRET: 'short',
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('hex string');
  });

  it('throws when PORT is below minimum', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '0',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('PORT');
  });

  it('throws when PORT exceeds maximum', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '99999',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('PORT');
  });

  it('throws when RATE_LIMIT_WINDOW_MS is not a number', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: 'abc',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('RATE_LIMIT_WINDOW_MS');
  });

  it('throws when CORS_ORIGIN lacks https://', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'http://insecure.example.com',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('CORS_ORIGIN');
  });

  it('throws when RATE_LIMIT_WINDOW_MS is negative', () => {
    const result = runValidation({
      NBOSP_CRED_KEY: 'a'.repeat(64),
      SESSION_SECRET: 'b'.repeat(64),
      PORT: '3003',
      RATE_LIMIT_WINDOW_MS: '-1',
      RATE_LIMIT_MAX_REQUESTS: '100',
      CORS_ORIGIN: 'https://localhost:3003',
    });
    expect(result.threw).toBe(true);
    expect(result.error.message).toContain('RATE_LIMIT_WINDOW_MS');
  });
});
