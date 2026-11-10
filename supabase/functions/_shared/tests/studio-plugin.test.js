import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import '../tests/deno-shim.mjs';
import {
  buildSignedPluginArchive,
  inspectStudioPlugin,
} from '../studio-plugin.ts';

// ── ZIP construction helpers ────────────────────────────────────────────────
// fflate only produces valid archives, so the hostile cases are written byte
// by byte with a small controllable builder.

function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function localHeader({ name, data = new Uint8Array(), flags = 0, method = 0, crc, compSize, uncompSize }) {
  const nameBytes = strToU8(name);
  crc ??= crc32(data);
  compSize ??= data.byteLength;
  uncompSize ??= data.byteLength;
  const header = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, method, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, compSize, true);
  view.setUint32(22, uncompSize, true);
  view.setUint16(26, nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function centralEntry({ name, flags = 0, method = 0, crc = 0, compSize = 0, uncompSize = 0, localOffset = 0, externalAttributes = 0, creator = 3, comment = '' }) {
  const nameBytes = strToU8(name);
  const commentBytes = strToU8(comment);
  const entry = new Uint8Array(46 + nameBytes.byteLength + commentBytes.byteLength);
  const view = new DataView(entry.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, (creator << 8) | 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, flags, true);
  view.setUint16(10, method, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, compSize, true);
  view.setUint32(24, uncompSize, true);
  view.setUint16(28, nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, commentBytes.byteLength, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, externalAttributes, true);
  view.setUint32(42, localOffset, true);
  entry.set(nameBytes, 46);
  entry.set(commentBytes, 46 + nameBytes.byteLength);
  return entry;
}

function eocd({ entries, cdSize, cdOffset, comment = '' }) {
  const commentBytes = strToU8(comment);
  const record = new Uint8Array(22 + commentBytes.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdOffset, true);
  view.setUint16(20, commentBytes.byteLength, true);
  record.set(commentBytes, 22);
  return record;
}

// Builds an archive from a list of { name, data, flags, method, crc, compSize,
// uncompSize, externalAttributes, localHeaderOverride } entries.
function buildZip(entries, { eocdComment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const local = localHeader({
      name: entry.localName ?? entry.name,
      data,
      flags: entry.flags ?? 0,
      method: entry.method ?? 0,
      crc: entry.crc,
      compSize: entry.compSize,
      uncompSize: entry.uncompSize,
    });
    locals.push(local, data);
    centrals.push(centralEntry({
      name: entry.name,
      flags: entry.flags ?? 0,
      method: entry.method ?? 0,
      crc: entry.crc ?? crc32(data),
      compSize: entry.compSize ?? data.byteLength,
      uncompSize: entry.uncompSize ?? data.byteLength,
      localOffset: entry.localOffset ?? offset,
      externalAttributes: entry.externalAttributes ?? 0,
      creator: entry.creator ?? 3,
    }));
    offset += local.byteLength + data.byteLength;
  }
  const cdOffset = offset;
  const central = Buffer.concat(centrals);
  const eocdRecord = eocd({ entries: entries.length, cdSize: central.byteLength, cdOffset, comment: eocdComment });
  return new Uint8Array(Buffer.concat([...locals, central, eocdRecord]));
}

const PLUGIN_JSON = JSON.stringify({
  id: 'com.example.plugin',
  name: 'Example Plugin',
  version: '1.0.0',
  main: 'main.js',
  engines: { studio: '>=1.0.0 <2.0.0' },
});

function validPluginBytes() {
  return new Uint8Array(zipSync({
    'plugin.json': strToU8(PLUGIN_JSON),
    'main.js': strToU8('export function activate() {}\n'),
  }, { level: 0 }));
}

// ── Valid plugin parsing ────────────────────────────────────────────────────

test('inspectStudioPlugin parses a valid archive and returns the manifest', () => {
  const manifest = inspectStudioPlugin(validPluginBytes());
  assert.equal(manifest.id, 'com.example.plugin');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.main, 'main.js');
});

test('plugin.json must be UTF-8: invalid byte sequences are rejected', () => {
  // 0xff 0xfe is never valid UTF-8; the fatal decoder must reject it instead
  // of silently replacing it with U+FFFD.
  const brokenJson = new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0xff, 0xfe, 0x7d]);
  const manual = buildZip([
    { name: 'plugin.json', data: brokenJson },
    { name: 'main.js', data: strToU8('export function activate() {}\n') },
  ]);
  assert.throws(() => inspectStudioPlugin(manual), /UTF-8/);
});

test('manifest field validation: id pattern, semver, engines range, packaged main', () => {
  const withManifest = manifest => buildZip([
    { name: 'plugin.json', data: strToU8(JSON.stringify(manifest)) },
    { name: 'main.js', data: strToU8('export function activate() {}\n') },
  ]);

  for (const bad of [
    { id: 'a..', name: 'X', version: '1.0.0', main: 'main.js', engines: { studio: '^1' } },
    { id: 'ok.plugin', name: 'X', version: 'not-semver', main: 'main.js', engines: { studio: '^1' } },
    { id: 'ok.plugin', name: 'X', version: '1.0.0', main: 'missing.js', engines: { studio: '^1' } },
    { id: 'ok.plugin', name: 'X', version: '1.0.0', main: 'main.js', engines: { studio: 'banana' } },
    { id: 'ok.plugin', name: 'X', version: '1.0.0', main: 'main.js' },
  ]) {
    assert.throws(() => inspectStudioPlugin(withManifest(bad)), PublisherErrorLike, JSON.stringify(bad));
  }

  const good = { id: 'com.example.plugin', name: 'Example Plugin', version: '1.2.3-rc.1', main: 'main.js', engines: { studio: '>=1.0.0' } };
  assert.equal(inspectStudioPlugin(withManifest(good)).version, '1.2.3-rc.1');
});

// A tiny matcher for the thrown PublisherError shape (avoids importing the
// class across the TS boundary twice).
function PublisherErrorLike(error) {
  return error instanceof Error && error.name === 'PublisherError';
}

// ── Hostile archives ────────────────────────────────────────────────────────

test('rejects path traversal entry names', () => {
  for (const name of ['../evil.js', 'a/../../evil.js', '/absolute.js', 'C:/win.js', 'a/b:c.js', '.hidden.js', 'dir/../ok.js']) {
    const bytes = buildZip([
      { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
      { name, data: strToU8('x') },
    ]);
    assert.throws(() => inspectStudioPlugin(bytes), PublisherErrorLike, name);
  }
});

test('rejects duplicate entry names', () => {
  const bytes = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'main.js', data: strToU8('a') },
    { name: 'main.js', data: strToU8('b'), localOffset: 0 },
  ]);
  assert.throws(() => inspectStudioPlugin(bytes), PublisherErrorLike);
});

test('rejects symlink entries', () => {
  const symlinkAttribute = 0xa1ff << 16;
  const bytes = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'link.js', data: strToU8('../../target'), externalAttributes: symlinkAttribute, creator: 3 },
  ]);
  assert.throws(() => inspectStudioPlugin(bytes), /symbolic link/);
});

test('rejects encrypted and unsupported-compression entries', () => {
  const encrypted = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON), flags: 1 },
    { name: 'main.js', data: strToU8('x') },
  ]);
  assert.throws(() => inspectStudioPlugin(encrypted), /Encrypted or unsupported/);

  const exotic = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'main.js', data: strToU8('x'), method: 12 },
  ]);
  assert.throws(() => inspectStudioPlugin(exotic), /Encrypted or unsupported/);
});

test('rejects zip bombs that expand past the 100 MB cap', () => {
  const bytes = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'bomb.bin', data: new Uint8Array(4), uncompSize: 200 * 1024 * 1024 },
  ]);
  assert.throws(() => inspectStudioPlugin(bytes), /100 MB/);
});

test('rejects more than 500 entries', () => {
  const entries = [{ name: 'plugin.json', data: strToU8(PLUGIN_JSON) }, { name: 'main.js', data: strToU8('x') }];
  for (let i = 0; i < 501; i++) entries.push({ name: `f/${i}.txt`, data: strToU8('x') });
  assert.throws(() => inspectStudioPlugin(buildZip(entries)), /500-entry/);
});

test('rejects mismatched local headers and overlapping local ranges', () => {
  // Central directory points at a local header with a different name.
  const mismatched = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'main.js', data: strToU8('x'), localName: 'other.js' },
  ]);
  assert.throws(() => inspectStudioPlugin(mismatched), /invalid local header|truncated or inconsistent/);

  // Two entries whose local ranges overlap (both claim offset 0).
  const overlapping = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'main.js', data: strToU8('x') },
    { name: 'second.js', data: strToU8('y'), localOffset: 0 },
  ]);
  assert.throws(() => inspectStudioPlugin(overlapping), /invalid local header|duplicate/);
});

test('rejects corrupted end-of-central-directory records', () => {
  const valid = validPluginBytes();
  const truncated = valid.slice(0, valid.byteLength - 2);
  assert.throws(() => inspectStudioPlugin(truncated), /not a valid ZIP/);

  const complete = buildZip([
    { name: 'plugin.json', data: strToU8(PLUGIN_JSON) },
    { name: 'main.js', data: strToU8('x') },
  ]);
  const trailingJunk = new Uint8Array([...complete, 0x50, 0x4b, 0x05, 0x06, 0x00, 0x00]);
  assert.throws(() => inspectStudioPlugin(trailingJunk), /ZIP directory is invalid|not a valid ZIP/);
});

test('rejects a plugin.json larger than 256 KB or missing entirely', () => {
  const huge = buildZip([
    { name: 'plugin.json', data: strToU8(`{"pad":"${'x'.repeat(300 * 1024)}"}`) },
    { name: 'main.js', data: strToU8('x') },
  ]);
  assert.throws(() => inspectStudioPlugin(huge), /256 KB/);

  const missing = buildZip([{ name: 'main.js', data: strToU8('x') }]);
  assert.throws(() => inspectStudioPlugin(missing), /plugin\.json/);
});

// ── Signing roundtrip ───────────────────────────────────────────────────────

test('buildSignedPluginArchive signs a file map and produces a verifiable signature.json', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const publicX = jwk.x;

  const files = new Map([
    ['plugin.json', strToU8(PLUGIN_JSON)],
    ['main.js', strToU8('export function activate() {}\n')],
  ]);
  const { bytes } = await buildSignedPluginArchive(files, jwk, publicX);

  const unpacked = unzipSync(bytes);
  assert.ok(unpacked['signature.json'], 'signature.json added');
  const signatureRecord = JSON.parse(new TextDecoder().decode(unpacked['signature.json']));
  assert.equal(signatureRecord.algorithm, 'Ed25519');
  assert.equal(signatureRecord.publicKey, publicX);

  // Recompute the canonical hash payload exactly as the verifier does.
  const hashes = {};
  for (const [name, data] of Object.entries(unpacked)) {
    if (name === 'signature.json') continue;
    hashes[name] = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
  }
  const canonical = JSON.stringify({ files: Object.keys(hashes).sort().reduce((acc, key) => {
    acc[key] = hashes[key];
    return acc;
  }, {}) });

  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicX }, { name: 'Ed25519' }, false, ['verify']);
  const signatureBytes = Buffer.from(signatureRecord.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    signatureBytes,
    new TextEncoder().encode(canonical),
  );
  assert.equal(verified, true, 'signature must verify over the file hash map');
});

test('buildSignedPluginArchive refuses a key that does not match the pinned public x', async () => {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const files = new Map([['plugin.json', strToU8(PLUGIN_JSON)]]);
  await assert.rejects(
    () => buildSignedPluginArchive(files, first.privateKey.export({ format: 'jwk' }), second.privateKey.export({ format: 'jwk' }).x),
    /does not match the trusted NovaByte signing identity|does not match NovaByte Trusted Signing/,
  );
});
