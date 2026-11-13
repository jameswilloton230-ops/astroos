import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { installCaTrust } = require('../../scripts/ca-trust.js');

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
});

describe('scripts/ca-trust.js — installCaTrust', () => {
  it('degrades gracefully to false on linux when no trust tooling exists', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = installCaTrust('/nonexistent/ca.crt');
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled(); // "certutil not found" guidance
    err.mockRestore();
    warn.mockRestore();
  });

  it('reports false on a faked win32 host where certutil is unavailable', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(installCaTrust('/nonexistent/ca.crt')).toBe(false);
    expect(err).toHaveBeenCalled(); // Windows CA install failure logged
  });

  it('reports false on a faked darwin host where osascript is unavailable', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(installCaTrust('/nonexistent/ca.crt')).toBe(false);
    expect(err).toHaveBeenCalled(); // macOS CA install failure logged
  });

  it('never throws regardless of the certificate path', () => {
    expect(() => installCaTrust('')).not.toThrow();
    expect(() => installCaTrust('/proc/0/impossible')).not.toThrow();
  });
});
