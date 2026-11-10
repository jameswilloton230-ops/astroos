// tests/apps/scanner.test.js — service app: static-heuristic file gate.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

// Duck-typed File stand-in: Scanner only needs name/size/slice().arrayBuffer().
function fakeFile(name, bytes) {
  const buf = Uint8Array.from(bytes);
  return {
    name,
    size: buf.length,
    slice: (start, end) => ({
      arrayBuffer: async () => buf.slice(start, end).buffer,
    }),
  };
}

describe('Scanner service (js/apps/scanner)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches Scanner and the DropScanner alias (same object, not frozen)', async () => {
    const { window } = await loadServiceApp('scanner');
    const svc = window.Scanner;
    expect(svc).toBeTruthy();
    expect(window.DropScanner).toBe(svc);
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['scan', 'scanText', 'scanBase64']) expect(typeof svc[m]).toBe('function');
  });

  it('rejects invalid file objects with an unsafe verdict', async () => {
    const { window } = await loadServiceApp('scanner');
    await expect(window.Scanner.scan(null)).resolves.toEqual({ safe: false, reason: 'Invalid file object.', warnings: [] });
    await expect(window.Scanner.scan(42)).resolves.toMatchObject({ safe: false, reason: 'Invalid file object.' });
  });

  it('blocks executable extensions and double-extension disguises', async () => {
    const { window } = await loadServiceApp('scanner');
    const bat = await window.Scanner.scanText('setup.bat', 'hello');
    expect(bat.safe).toBe(false);
    expect(bat.reason).toContain('.bat');

    const disguise = await window.Scanner.scanText('invoice.pdf.exe', 'MZ');
    expect(disguise.safe).toBe(false);
    expect(disguise.reason).toContain('disguises an executable');
    expect(disguise.reason).toContain('.exe');
  });

  it('flags magic-byte mismatches: a .png that is really a Windows PE', async () => {
    const { window } = await loadServiceApp('scanner');
    const verdict = await window.Scanner.scan(fakeFile('photo.png', [0x4d, 0x5a, 0x90, 0x00]));
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('Windows PE executable (MZ header)');

    const clean = await window.Scanner.scan(fakeFile('photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    expect(clean).toEqual({ safe: true, warnings: [] });
  });

  it('blocks active content in SVG/XML but allows a standard .novaapp index.html script ref', async () => {
    const { window } = await loadServiceApp('scanner');
    const svg = await window.Scanner.scanText('icon.svg', '<svg><script>alert(1)</script></svg>');
    expect(svg.safe).toBe(false);
    expect(svg.reason).toContain('embedded <script> tag');

    const localRef = await window.Scanner.scanText('index.html', '<html><head><script src="app.js"></script></head><body></body></html>');
    expect(localRef.safe).toBe(true);

    const inline = await window.Scanner.scanText('index.html', '<html><body><script>var x = 1;</script></body></html>');
    expect(inline.safe).toBe(false);
    expect(inline.reason).toContain('inline <script>...</script> content');

    const remote = await window.Scanner.scanText('index.html', '<html><head><script src="https://evil.example/x.js"></script></head></html>');
    expect(remote.safe).toBe(false);
    expect(remote.reason).toContain('non-local or unsafe src');

    const traversal = await window.Scanner.scanText('index.html', '<script src="../../outside.js"></script>');
    expect(traversal.safe).toBe(false);
  });

  it('scopes javascript:/on*= checks to real tags for .md, keeping prose false-positive-free', async () => {
    const { window } = await loadServiceApp('scanner');
    const prose = await window.Scanner.scanText('tutorial.md', 'Plain prose: the onclick= attribute and javascript: URLs are worth documenting.');
    expect(prose.safe).toBe(true);

    const realHandler = await window.Scanner.scanText('post.md', 'See <a href="/x" onclick="steal()">link</a>.');
    expect(realHandler.safe).toBe(false);
    expect(realHandler.reason).toContain('inline event handler (on*=)');

    // .html keeps the blanket check: mentioning javascript: anywhere is a hit.
    const htmlMention = await window.Scanner.scanText('notes.html', 'A document about javascript: URLs.');
    expect(htmlMention.safe).toBe(false);
  });

  it('flags obfuscated code (innerHTML + fromCharCode chain) in script-ish text', async () => {
    const { window } = await loadServiceApp('scanner');
    const verdict = await window.Scanner.scanText('widget.js', 'el.innerHTML = String.fromCharCode(60, 115, 62);');
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('obfuscated code');
    expect(verdict.reason).toContain('fromCharCode');

    // .txt skips markup patterns but still gets the obfuscation + entropy tripwires.
    const txtEval = await window.Scanner.scanText('notes.txt', 'call eval(x) here');
    expect(txtEval.safe).toBe(false);
    expect(txtEval.reason).toContain('eval(...) call');
  });

  it('rejects high-entropy payloads disguised as text', async () => {
    const { window } = await loadServiceApp('scanner');
    const bytes = new Uint8Array(2048);
    globalThis.crypto.getRandomValues(bytes);
    const verdict = await window.Scanner.scan(fakeFile('blob.txt', bytes));
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('high-entropy');
  });

  it('scanBase64() fingerprints raw bytes and reports undecodable input', async () => {
    const { window } = await loadServiceApp('scanner');
    const mzB64 = Buffer.from([0x4d, 0x5a]).toString('base64'); // 'TVo='
    const pe = await window.Scanner.scanBase64('icon.png', mzB64);
    expect(pe.safe).toBe(false);
    expect(pe.reason).toContain('Windows PE executable');

    const bad = await window.Scanner.scanBase64('icon.png', '!!!not-base64!!!');
    expect(bad.safe).toBe(false);
    expect(bad.reason).toContain('not valid base64');

    const empty = await window.Scanner.scanBase64('empty.dat', '');
    expect(empty.safe).toBe(true);
  });

  it('reports unreadable files as unsafe instead of throwing', async () => {
    const { window } = await loadServiceApp('scanner');
    const broken = {
      name: 'locked.pdf',
      size: 10,
      slice: () => ({ arrayBuffer: async () => { throw new Error('denied'); } }),
    };
    const verdict = await window.Scanner.scan(broken);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain('Could not read "locked.pdf"');
  });
});
