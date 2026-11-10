'use strict';
// AstroOS — package signature encoding contract.
//
// NOVAAPP.md documents the .novaapp `signature` field as "Ed25519 signature,
// base64url", and Studio-mirroring build tools emit base64url — but
// verifyPackage historically parsed signatures as hex only, so a correctly
// signed base64url package could NEVER verify against the trust store. This
// suite pins the fixed contract:
//
//   S1  signPackage emits base64url (the documented format)
//   S2  verifyPackage accepts base64url, base64, and legacy hex signatures
//   S3  verifyAgainstTrustStore marks a base64url-signed package trusted
//       when its key is in the trust store (the exact end-to-end path that
//       was broken)
//   S4  tampered/garbage signatures still fail closed
//   S5  installPackage rejects an untrusted, integrity-failing package and
//       allows the trusted one
//
// Usage: node tests/test_package_signature_encoding.js [--verbose]

const path = require('path');
const AppPackage = require('../../js/platform/core/app-package.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}

async function main() {
  const manifest = {
    id: 'com.test.sigcheck', name: 'Sig Check', version: '1.0.0', entry: 'index.html',
    permissions: [], optionalPermissions: [],
  };
  const files = { 'index.html': '<!doctype html><title>ok</title>' };
  const keypair = await AppPackage.generateSigningKeyPair('ed25519');

  // ── S1: emission format ────────────────────────────────────────────────
  console.log('S1 — signPackage emits the documented base64url');
  const pkg = await AppPackage.createPackage(manifest, files, {
    signingKey: keypair.privateJwk, signingMethod: 'ed25519', signerName: 'sig-check-key',
    integrityMethod: 'sha256',
  });
  check('signature is base64url (no +, /, =, no hex-only charset of 128)',
    typeof pkg.signature === 'string' && /^[A-Za-z0-9_-]+$/.test(pkg.signature),
    pkg.signature && pkg.signature.slice(0, 24));
  check('base64url Ed25519 signature decodes to 64 bytes',
    (() => { const b = pkg.signature.replace(/-/g, '+').replace(/_/g, '/');
      const bin = Buffer.from(b, 'base64'); return bin.length === 64; })(),
    `len=${Buffer.from(pkg.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length}`);

  // ── S2: verify accepts every encoding of the same signature bytes ──────
  console.log('S2 — verifyPackage accepts base64url / base64 / hex');
  const okB64Url = await AppPackage.verifyPackage(pkg, keypair.publicJwk, 'ed25519');
  check('base64url signature verifies', okB64Url === true);

  const sigBytes = Buffer.from(pkg.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const pkgBase64 = { ...pkg, signature: sigBytes.toString('base64') };
  check('standard-base64 signature verifies',
    (await AppPackage.verifyPackage(pkgBase64, keypair.publicJwk, 'ed25519')) === true);

  const pkgHex = { ...pkg, signature: sigBytes.toString('hex') };
  check('legacy hex signature still verifies',
    (await AppPackage.verifyPackage(pkgHex, keypair.publicJwk, 'ed25519')) === true);

  // ── S3: end-to-end trust-store path with a base64url package ───────────
  console.log('S3 — trust store marks base64url-signed package trusted');
  const trustStore = [
    { id: 'sig-check-key', name: 'Sig Check Signing', method: 'ed25519', publicKey: keypair.publicJwk },
  ];
  const trusted = await AppPackage.verifyAgainstTrustStore(pkg, trustStore, null);
  check('trusted via trust store (base64url signature)', trusted.trusted === true && trusted.signer === 'Sig Check Signing',
    JSON.stringify(trusted));

  const legacyTrusted = await AppPackage.verifyAgainstTrustStore(pkgHex, trustStore, null);
  check('trusted via trust store (legacy hex signature)', legacyTrusted.trusted === true);

  // ── S4: failure modes stay closed ──────────────────────────────────────
  console.log('S4 — tampering still fails closed');
  const tampered = { ...pkg, manifest: { ...manifest, name: 'Evil Clone' } };
  check('tampered payload fails verification',
    (await AppPackage.verifyPackage(tampered, keypair.publicJwk, 'ed25519')) === false);
  check('garbage signature fails',
    (await AppPackage.verifyPackage({ ...pkg, signature: 'zz!!not-a-sig' }, keypair.publicJwk, 'ed25519')) === false);
  check('wrong key fails',
    (await AppPackage.verifyPackage(pkg, (await AppPackage.generateSigningKeyPair('ed25519')).publicJwk, 'ed25519')) === false);
  check('integrity digest still verifies for the original package',
    (await AppPackage.verifyIntegrity(pkg)) === true);

  // ── S5: installPackage end-to-end ──────────────────────────────────────
  console.log('S5 — installPackage paths');
  const installed = await AppPackage.installPackage(pkg, { trustStore, force: true });
  check('trusted package installs as verified',
    installed.success === true && installed.verified === true && installed.signer === 'Sig Check Signing',
    JSON.stringify(installed));
  const unverified = await AppPackage.installPackage(pkg, { trustStore: [], allowUnverified: true, force: true });
  check('same package installs unverified without the key in the store',
    unverified.success === true && unverified.verified === false, JSON.stringify(unverified));
  let blockedErr = null;
  try { await AppPackage.installPackage(tampered, { trustStore: [] }); }
  catch (e) { blockedErr = e; }
  check('tampered, untrusted, integrity-failing package is rejected',
    blockedErr && /signature did not match any trusted signer/.test(String(blockedErr.message)),
    String(blockedErr && blockedErr.message));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('failures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
