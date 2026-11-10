import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toPem } = require('../../scripts/utils.js');

describe('scripts/utils.js — toPem', () => {
  it('wraps DER bytes in a PEM armoured block', () => {
    const der = Buffer.from('test-der-body');
    const pem = toPem(der, 'CERTIFICATE');
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(pem.endsWith('-----END CERTIFICATE-----\n')).toBe(true);
    const body = pem.split('\n').filter((l) => l && !l.startsWith('-----'));
    expect(body.join('')).toBe(der.toString('base64'));
  });

  it('wraps base64 at 64 characters per line (RFC 7468)', () => {
    const der = Buffer.alloc(100, 0xab); // 100 bytes → 136 base64 chars → 3 lines
    const pem = toPem(der, 'CERTIFICATE');
    const lines = pem.split('\n').filter((l) => l && !l.startsWith('-----'));
    expect(lines).toHaveLength(3);
    expect(lines[0].length).toBe(64);
    expect(lines[1].length).toBe(64);
    expect(lines[2].length).toBe(136 - 128);
  });

  it('defaults the label to CERTIFICATE and strips CR/LF from it', () => {
    expect(toPem(Buffer.alloc(3)).startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
    const sneaky = toPem(Buffer.alloc(3), 'PRIVATE\r\nKEY--x');
    expect(sneaky.startsWith('-----BEGIN PRIVATEKEY--x-----')).toBe(true);
    expect(sneaky).not.toContain('\r');
  });

  it('handles empty buffers and ArrayBuffer inputs', () => {
    expect(toPem(Buffer.alloc(0), 'X')).toBe('-----BEGIN X-----\n-----END X-----\n');
    const ab = new Uint8Array([1, 2, 3]).buffer;
    expect(toPem(ab, 'KEY')).toContain(Buffer.from(ab).toString('base64'));
  });
});
