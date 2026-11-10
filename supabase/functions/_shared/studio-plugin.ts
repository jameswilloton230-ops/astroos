import { valid, validRange } from 'npm:semver@7.8.5';
import { unzipSync, zipSync } from 'npm:fflate@0.8.2';
import { PublisherError, TRUSTED_SIGNING_PUBLIC_X } from './publisher.ts';
import { LISTING_ID_PATTERN } from './validation.js';

const MAX_ENTRIES = 500;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;
// Kept exported for Studio tooling that imports the pattern directly.
export const PLUGIN_ID = LISTING_ID_PATTERN;
const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatePath(value: string) {
  const segments = value.split('/');
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')
    || /^[a-zA-Z]:/.test(value) || segments.some(part =>
      !part || part === '.' || part === '..' || part.includes(':')
      || ['__proto__', 'prototype', 'constructor'].includes(part.toLowerCase()))) {
    throw new PublisherError(`The plugin archive contains an unsafe path: ${value}`);
  }
  return value;
}

function inspectZip(bytes: Uint8Array) {
  if (!bytes.length || bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new PublisherError('The .nbplugin must be between 1 byte and 25 MB.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.byteLength) throw new PublisherError('The .nbplugin is not a valid ZIP archive.');
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || entryCount > MAX_ENTRIES || view.getUint16(eocd + 8, true) !== entryCount
    || centralOffset + centralSize > eocd || eocd + 22 + commentLength !== bytes.byteLength) {
    throw new PublisherError('The plugin ZIP directory is invalid or exceeds the 500-entry limit.');
  }

  const encoderDecoder = new TextDecoder('utf-8', { fatal: true });
  const names = new Set<string>();
  const files = new Set<string>();
  const localOffsets = new Set<number>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let expandedSize = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new PublisherError('The plugin ZIP directory contains an invalid entry.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const creator = view.getUint16(cursor + 4, true) >>> 8;
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > centralOffset + centralSize || (flags & 1) !== 0 || ![0, 8].includes(method)) {
      throw new PublisherError('Encrypted or unsupported ZIP entries are not accepted.');
    }
    const name = encoderDecoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const isDirectory = name.endsWith('/');
    const cleanName = validatePath(isDirectory ? name.slice(0, -1) : name);
    if (names.has(cleanName)) throw new PublisherError(`The plugin archive contains a duplicate path: ${cleanName}`);
    names.add(cleanName);
    if (creator === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw new PublisherError(`The plugin archive contains a symbolic link: ${cleanName}`);
    }
    if (localOffsets.has(localOffset) || localOffset + 30 > centralOffset
      || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new PublisherError(`The plugin ZIP entry has an invalid local header: ${cleanName}`);
    }
    localOffsets.add(localOffset);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const localName = encoderDecoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if ((localFlags & 1) !== 0 || localMethod !== method || localName !== name
      || dataStart + compressedSize > centralOffset) {
      throw new PublisherError(`The plugin ZIP entry is truncated or inconsistent: ${cleanName}`);
    }
    localRanges.push({ start: localOffset, end: dataStart + compressedSize });
    if (!isDirectory) {
      expandedSize += uncompressedSize;
      if (expandedSize > MAX_EXPANDED_BYTES) throw new PublisherError('The plugin archive expands beyond the 100 MB limit.');
      files.add(cleanName);
    } else if (compressedSize !== 0 || uncompressedSize !== 0) {
      throw new PublisherError(`The plugin ZIP directory entry contains data: ${cleanName}`);
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new PublisherError('The plugin ZIP directory has trailing or invalid entries.');
  localRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new PublisherError('The plugin ZIP contains overlapping local entries.');
    }
  }
  return { files, entryCount, expandedSize };
}

function parsePlugin(bytes: Uint8Array) {
  const inspected = inspectZip(bytes);
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch {
    throw new PublisherError('The .nbplugin archive could not be decompressed.');
  }
  const files = new Map<string, Uint8Array>();
  let expandedSize = 0;
  for (const [rawPath, contents] of Object.entries(unzipped)) {
    if (rawPath.endsWith('/')) continue;
    const filename = validatePath(rawPath);
    if (!inspected.files.has(filename) || files.has(filename)) {
      throw new PublisherError(`The plugin archive contains a duplicate or unexpected path: ${filename}`);
    }
    expandedSize += contents.byteLength;
    if (expandedSize > MAX_EXPANDED_BYTES) throw new PublisherError('The plugin archive expands beyond the 100 MB limit.');
    files.set(filename, contents);
  }
  if (files.size !== inspected.files.size) throw new PublisherError('The plugin ZIP file table is incomplete.');
  const manifestBytes = files.get('plugin.json');
  if (!manifestBytes || manifestBytes.byteLength > 256 * 1024) {
    throw new PublisherError('The archive must contain a root plugin.json no larger than 256 KB.');
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(utf8Decoder.decode(manifestBytes));
  } catch {
    throw new PublisherError('plugin.json must contain valid UTF-8 JSON.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || typeof manifest.id !== 'string' || !PLUGIN_ID.test(manifest.id)
    || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 100
    || typeof manifest.version !== 'string' || !valid(manifest.version)
    || typeof manifest.main !== 'string' || !files.has(validatePath(manifest.main))
    || !manifest.engines || typeof manifest.engines !== 'object'
    || typeof (manifest.engines as Record<string, unknown>).studio !== 'string'
    || !validRange((manifest.engines as Record<string, string>).studio)) {
    throw new PublisherError('plugin.json is missing valid id, name, version, main, or engines.studio fields.');
  }
  if (manifest.description !== undefined
    && (typeof manifest.description !== 'string' || manifest.description.length > 500)) {
    throw new PublisherError('Plugin description must be no more than 500 characters.');
  }
  return { files, manifest };
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function arrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function inspectStudioPlugin(bytes: Uint8Array) {
  const { manifest } = parsePlugin(bytes);
  return manifest;
}

// Pure signing core: hashes every plugin file (excluding signature.json),
// signs the canonical hash map with the caller-supplied Ed25519 key, writes
// signature.json, and returns the repacked archive. Exposed so the Node test
// suite can exercise the full signing path with generated keys.
export async function buildSignedPluginArchive(
  files: Map<string, Uint8Array>,
  privateJwk: JsonWebKey,
  publicX: string,
) {
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519'
    || typeof privateJwk.d !== 'string' || privateJwk.x !== publicX) {
    throw new PublisherError('The configured signing key does not match NovaByte Trusted Signing.', 503);
  }
  const hashes: Record<string, string> = {};
  for (const [filename, contents] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (filename === 'signature.json') continue;
    hashes[filename] = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(contents))));
  }
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  const payload = encoder.encode(canonicalJson({ files: hashes }));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, payload));
  const verifyKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: publicX },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, signature, payload)) {
    throw new PublisherError('The signing key failed its self-check; the plugin was not published.', 503);
  }
  files.set('signature.json', encoder.encode(JSON.stringify({
    algorithm: 'Ed25519',
    publicKey: publicX,
    signature: base64Url(signature),
  })));
  const archive = Object.create(null) as Record<string, Uint8Array>;
  for (const [filename, contents] of files) archive[filename] = contents;
  const signedBytes = zipSync(archive, { level: 0 });
  if (signedBytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new PublisherError('The signed .nbplugin exceeds the 25 MB publishing limit.');
  }
  return { bytes: signedBytes, hashes };
}

export async function signStudioPlugin(bytes: Uint8Array) {
  const { files, manifest } = parsePlugin(bytes);
  const privateJwkText = Deno.env.get('NOVABYTE_SIGNING_PRIVATE_JWK');
  if (!privateJwkText) throw new PublisherError('NovaByte trusted signing is not configured. Publishing is disabled.', 503);
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(privateJwkText);
  } catch {
    throw new PublisherError('The trusted signing key configuration is invalid.', 503);
  }
  const { bytes: signedBytes } = await buildSignedPluginArchive(files, privateJwk, TRUSTED_SIGNING_PUBLIC_X);
  return { bytes: signedBytes, manifest };
}
