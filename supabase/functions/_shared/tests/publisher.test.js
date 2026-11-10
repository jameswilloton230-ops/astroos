import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import '../tests/deno-shim.mjs';
import {
  escapeHtml,
  encodePath,
  queryString,
  signingPayload,
  signPackageWithJwk,
} from '../publisher.ts';
import { ValidationError } from '../validation.js';

function b64UrlToBuffer(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function generateEd25519Jwk() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  // Node exports the private key with d and x; keep x for the pinned identity.
  return {
    jwk,
    publicX: jwk.x,
    rawPublic: publicKey.export({ format: 'jwk' }),
  };
}

function makePackage() {
  return {
    novabyte_app: true,
    manifest: { id: 'com.example.test', name: 'Test', version: '1.0.0', entry: 'index.html' },
    files: {
      'index.html': Buffer.from('<h1>Test</h1>').toString('base64'),
      'app.js': Buffer.from('console.log(1);').toString('base64'),
    },
    compiled_at: '2026-11-08T00:00:00.000Z',
  };
}

// ── escaping and path encoding ──────────────────────────────────────────────

test('escapeHtml is exported from the shared module and quote-safe', () => {
  assert.equal(escapeHtml(`"a" < 'b' & c`), '&quot;a&quot; &lt; &#39;b&#39; &amp; c');
});

test('encodePath URI-encodes each segment without touching separators', () => {
  assert.equal(encodePath('user-uuid/package.novaapp'), 'user-uuid/package.novaapp');
  assert.equal(encodePath('a b/c%20d/e?f.bin'), 'a%20b/c%2520d/e%3Ff.bin');
  // Separators survive by design (storage paths); each segment is encoded.
  assert.equal(encodePath('../escape'), '../escape');
});

test('queryString percent-encodes filter values so PostgREST injection is impossible', () => {
  const query = queryString({ id: 'eq.00000000-0000-0000-0000-000000000000,evil=1', select: '*' });
  assert.equal(query.includes('evil=1'), false, 'raw & / = must not survive encoding');
  assert.equal(query, 'id=eq.00000000-0000-0000-0000-000000000000%2Cevil%3D1&select=*');
});

// ── package signing ─────────────────────────────────────────────────────────

test('signPackageWithJwk signs, self-verifies, and attaches integrity hashes', async () => {
  const { jwk, publicX } = generateEd25519Jwk();
  const pkg = makePackage();
  const signed = await signPackageWithJwk(pkg, jwk, publicX);

  assert.equal(signed.signing.method, 'ed25519');
  assert.equal(signed.signer, 'NovaByte Trusted Signing');
  assert.equal(signed.integrity.method, 'sha512');
  assert.match(signed.signature, /^[0-9a-f]{128}$/);

  // The signature must verify against the canonical payload with WebCrypto.
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicX }, { name: 'Ed25519' }, false, ['verify']);
  const payload = new TextEncoder().encode(signingPayload(signed));
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    b64UrlToBuffer(Buffer.from(signed.signature, 'hex').toString('base64url')),
    payload,
  );
  assert.equal(verified, true);

  // The payload hash must match an independent SHA-512 of the same payload.
  const digest = toHex(await crypto.subtle.digest('SHA-512', payload));
  assert.equal(signed.integrity.payloadHash, digest);

  // Every file hash must match an independent SHA-512 of the decoded bytes.
  for (const [path, expected] of Object.entries(signed.integrity.fileHashes)) {
    const bytes = Uint8Array.from(atob(signed.files[path]), character => character.charCodeAt(0));
    assert.equal(toHex(await crypto.subtle.digest('SHA-512', bytes)), expected, path);
  }
});

test('signPackageWithJwk refuses a key whose public half does not match the pinned identity', async () => {
  const pinned = generateEd25519Jwk();
  const other = generateEd25519Jwk();
  const pkg = makePackage();
  await assert.rejects(
    () => signPackageWithJwk(pkg, other.jwk, pinned.publicX),
    /does not match the trusted NovaByte signing identity/,
  );
});

test('signPackageWithJwk refuses malformed keys and malformed file payloads', async () => {
  const { jwk, publicX } = generateEd25519Jwk();
  const pkg = makePackage();

  await assert.rejects(() => signPackageWithJwk(pkg, { ...jwk, kty: 'EC' }, publicX), /does not match/);
  await assert.rejects(() => signPackageWithJwk(pkg, { ...jwk, d: undefined }, publicX), /does not match/);

  const broken = { ...pkg, files: { 'bad.bin': '!!not base64!!' } };
  await assert.rejects(() => signPackageWithJwk(broken, jwk, publicX), /invalid encoded file/);
});

test('tampering with a signed package invalidates the signature payload', async () => {
  const { jwk, publicX } = generateEd25519Jwk();
  const signed = await signPackageWithJwk(makePackage(), jwk, publicX);

  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicX }, { name: 'Ed25519' }, false, ['verify']);
  const good = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64UrlToBuffer(Buffer.from(signed.signature, 'hex').toString('base64url')), new TextEncoder().encode(signingPayload(signed)));
  assert.equal(good, true);

  const tampered = { ...signed, manifest: { ...signed.manifest, name: 'Evil Twin' } };
  const bad = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64UrlToBuffer(Buffer.from(signed.signature, 'hex').toString('base64url')), new TextEncoder().encode(signingPayload(tampered)));
  assert.equal(bad, false, 'changing signed content must break the signature');
});

test('ValidationError is surfaced with its status by the shared error mapping contract', () => {
  // The edge entry point maps ValidationError to its status code; assert the
  // shape the response layer relies on.
  const error = new ValidationError('nope', 422);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 422);
  assert.equal(error.message, 'nope');
  assert.equal(error.name, 'ValidationError');
});
