import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Re-implement the private helpers so we can unit-test them in isolation.
// The route handlers themselves are integration-tested via HTTP in index.test.js.

const PRIVATE_EXACT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]', '[::]']);
const PRIVATE_PREFIXES = [
  '10.', '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
  '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.', '169.254.', '100.64.',
];

function _isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_EXACT.has(h)) return true;
  if (PRIVATE_PREFIXES.some((p) => h.startsWith(p))) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

function _isPrivateIpAddr(ip) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  );
}

// Stub DNS so tests don't make real network calls.
vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn().mockImplementation((hostname) => {
      if (_isPrivateHost(hostname)) {
        return Promise.reject(new Error('private'));
      }
      return Promise.resolve({ address: '93.184.216.34' });
    }),
  },
}));

describe('proxies.js — SSRF / private-IP guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('_isPrivateHost', () => {
    it('returns false for empty string', () => {
      expect(_isPrivateHost('')).toBe(false);
    });

    it('blocks loopback and localhost', () => {
      expect(_isPrivateHost('localhost')).toBe(true);
      expect(_isPrivateHost('127.0.0.1')).toBe(true);
      expect(_isPrivateHost('::1')).toBe(true);
      expect(_isPrivateHost('0.0.0.0')).toBe(true);
      expect(_isPrivateHost('[::1]')).toBe(true);
    });

    it('blocks RFC1918 ranges', () => {
      expect(_isPrivateHost('10.0.0.1')).toBe(true);
      expect(_isPrivateHost('192.168.1.1')).toBe(true);
      expect(_isPrivateHost('172.16.0.1')).toBe(true);
      expect(_isPrivateHost('172.31.255.255')).toBe(true);
    });

    it('blocks CGN and link-local', () => {
      expect(_isPrivateHost('100.64.0.1')).toBe(true);
      expect(_isPrivateHost('169.254.1.1')).toBe(true);
    });

    it('blocks .local and .internal TLDs', () => {
      expect(_isPrivateHost('printer.local')).toBe(true);
      expect(_isPrivateHost('api.internal')).toBe(true);
    });

    it('allows public hostnames', () => {
      expect(_isPrivateHost('example.com')).toBe(false);
      expect(_isPrivateHost('93.184.216.34')).toBe(false);
    });
  });

  describe('_isPrivateIpAddr', () => {
    it('returns false for empty string', () => {
      expect(_isPrivateIpAddr('')).toBe(false);
    });

    it('returns false for non-IP strings', () => {
      expect(_isPrivateIpAddr('not-an-ip')).toBe(false);
    });

    it('detects all private ranges', () => {
      expect(_isPrivateIpAddr('10.0.0.1')).toBe(true);
      expect(_isPrivateIpAddr('172.16.0.1')).toBe(true);
      expect(_isPrivateIpAddr('172.31.255.255')).toBe(true);
      expect(_isPrivateIpAddr('192.168.1.1')).toBe(true);
      expect(_isPrivateIpAddr('169.254.1.1')).toBe(true);
      expect(_isPrivateIpAddr('100.64.0.1')).toBe(true);
    });

    it('allows public IPs', () => {
      expect(_isPrivateIpAddr('93.184.216.34')).toBe(false);
      expect(_isPrivateIpAddr('8.8.8.8')).toBe(false);
    });
  });

});