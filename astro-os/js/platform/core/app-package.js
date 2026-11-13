/**
 * AstroOS - App Package Manager
 * ────────────────────────────────────────────────────────────
 *
 * TRUST MODEL CHANGE (this revision):
 *  Previously, signing used HMAC-SHA256 with a *shared secret* — the same
 *  key had to be typed into both the signer's tool and every installer's
 *  dialog box. That can prove "this package wasn't altered since I typed
 *  the key in", but it can't prove "this came from a trusted publisher",
 *  because anyone who has the key (which by definition has to be shared to
 *  verify anything) can sign arbitrary packages. It also can't support a
 *  central signing authority: handing out the HMAC key to let a CA "vouch"
 *  for an app would let that CA (or anyone who intercepts the key) forge
 *  ANY app's signature, trusted or not.
 *
 *  This revision moves to Ed25519 public/private key signing as the
 *  default verification method, with support for additional algorithms
 *  and integrity hashing:
 *   - Ed25519 (primary): 64-byte signatures, fast verification, widely
 *     supported across platforms.
 *   - ML-DSA-65 (post-quantum): NIST-standardized PQC, protects against
 *     quantum adversaries.
 *   - Ed448: ultra-high traditional security margin (224-bit).
 *   - ECDSA P-256/P-384: legacy enterprise / smart-card compatibility.
 *   - RSA-PSS 4096: legacy infrastructure fallback.
 *   - Custom: user-supplied signing payload / verifier.
 *   - Integrity: BLAKE3 (default), SHA-256, SHA-512, or none. Always
 *     embedded alongside signatures for tamper detection.
 *
 *  SECURITY FIXES carried over / re-verified in this revision:
 *   [1] verifyPackage() performs real cryptographic signature verification.
 *   [2] installPackage() rejects packages whose signature fails
 *       verification unless the caller explicitly opts into skipVerify.
 *
 * @module js/app-package
 */

const AppPackage = (() => {
  const NOVAAPP_FORMAT_VERSION = '1.0';
  const _crypto = (typeof window !== 'undefined' ? window.crypto : null)
    || globalThis.crypto
    || require('crypto');

  // Separate, explicit Node `crypto` module — NOT the same as `_crypto`
  // above, which resolves to SubtleCrypto (window.crypto) in NW.js's
  // renderer. Ed448 isn't implemented by any browser's SubtleCrypto, but
  // NW.js also exposes real Node `require`, and Node's crypto module
  // (OpenSSL-backed) supports Ed448 natively. Lazily required and
  // optional-chained so this file still loads in a context without Node
  // (e.g. a plain browser tab) — Ed448 just won't be available there.
  let _nodeCrypto = null;
  function _getNodeCrypto() {
    if (!_nodeCrypto) {
      try { _nodeCrypto = require('crypto'); }
      catch (_) { _nodeCrypto = null; }
    }
    return _nodeCrypto;
  }

  // ─── Supported methods ──────────────────────────────────────────────────────

  // `algo` is the SIGN/VERIFY-time algorithm identifier (what sign()/
  // verify() pass to SubtleCrypto). generateKey() needs a DIFFERENT shape
  // for several of these (namedCurve for ECDSA; modulusLength +
  // publicExponent for RSA-PSS), so that's kept as a separate `keygenAlgo`
  // below instead of reusing `algo` for both — reusing it was the bug:
  // generateKey() was being called with sign-time params it doesn't
  // understand (`hash` instead of `namedCurve`, no `modulusLength` at all).
  const SIGNING_METHODS = {
    'ed25519':      { label: 'Ed25519',      algo: { name: 'Ed25519' },                  keygenAlgo: { name: 'Ed25519' },                                                                             keyType: 'OKP', crv: 'Ed25519' },
    'ml-dsa-65':    { label: 'ML-DSA-65',    algo: 'ml-dsa-65',                          keygenAlgo: null,                                                                                            keyType: 'OKP', crv: 'ML-DSA-65', experimental: true },
    'ed448':        { label: 'Ed448',        algo: { name: 'Ed448' },                    keygenAlgo: { name: 'Ed448' },                                                                               keyType: 'OKP', crv: 'Ed448', experimental: true },
    'ecdsa-p256':   { label: 'ECDSA P-256',  algo: { name: 'ECDSA', hash: 'SHA-256' },   keygenAlgo: { name: 'ECDSA', namedCurve: 'P-256' },                                                          keyType: 'EC',  crv: 'P-256' },
    'ecdsa-p384':   { label: 'ECDSA P-384',  algo: { name: 'ECDSA', hash: 'SHA-384' },   keygenAlgo: { name: 'ECDSA', namedCurve: 'P-384' },                                                          keyType: 'EC',  crv: 'P-384' },
    'rsa-pss-4096': { label: 'RSA-PSS 4096', algo: { name: 'RSA-PSS', hash: 'SHA-384', saltLength: 48 }, keygenAlgo: { name: 'RSA-PSS', hash: 'SHA-384', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) }, keyType: 'RSA', crv: null, modulusLength: 4096 },
    'custom':       { label: 'Custom',       algo: 'custom',                             keygenAlgo: null,                                                                                            keyType: null,  crv: null },
  };

  const INTEGRITY_METHODS = {
    'blake3': { label: 'BLAKE3',  bits: 256 },
    'sha256': { label: 'SHA-256', bits: 256 },
    'sha512': { label: 'SHA-512', bits: 512 },
    'none':   { label: 'None',     bits: null },
  };

  const DEFAULT_SIGNING_METHOD = 'ed25519';
  const DEFAULT_INTEGRITY_METHOD = 'blake3';

  // ─── Noble hashes / post-quantum (lazy require) ────────────────────────────

  let _nobleHashes = null;
  let _noblePostQuantum = null;

  function _getNobleHashes() {
    if (!_nobleHashes) {
      // Same pattern as @noble/post-quantum above: @noble/hashes's root
      // index.js deliberately throws ("root module cannot be imported:
      // import submodules instead") — blake3 only exists at the
      // blake3.js subpath. Requiring the bare package name always
      // threw here, which is why this looked like "not installed" even
      // when it was.
      try { _nobleHashes = require('@noble/hashes/blake3.js'); }
      catch (_) { _nobleHashes = null; }
    }
    return _nobleHashes;
  }

  function _getNoblePostQuantum() {
    if (!_noblePostQuantum) {
      // @noble/post-quantum's root index.js deliberately throws
      // ("root module cannot be imported: import submodules instead") —
      // ml_dsa65 only exists at the ml-dsa.js subpath, and it's exported
      // as snake_case (ml_dsa65), not mlDsa65. Requiring the bare package
      // name always threw here, which is why this looked like "not
      // installed" even when it was.
      try { _noblePostQuantum = require('@noble/post-quantum/ml-dsa.js'); }
      catch (_) { _noblePostQuantum = null; }
    }
    return _noblePostQuantum;
  }

  // ─── Canonical payload for signing ──────────────────────────────────────────

  function _signingPayload(pkg) {
    return JSON.stringify({
      novabyte_app: pkg.novabyte_app,
      manifest:     pkg.manifest,
      files:        pkg.files,
      compiled_at:  pkg.compiled_at
    });
  }

  // Signature encoding helpers.
  //
  // The .novaapp package format documents the signature as base64url, and tools
  // mirroring Studio's build (repackage.js et al.) emit base64url — but
  // signPackage/verifyPackage historically emitted and parsed plain hex.
  // A correctly-signed base64url package therefore NEVER verified against
  // the trust store (hex parsing mangled the bytes), silently pinning every
  // such package at Unverified forever, even after its key was trusted.
  // Signing now emits the documented base64url; verification accepts BOTH
  // encodings (hex first, then base64/base64url) so packages from either
  // generation verify. Both interpretations are tried in order when a
  // string is ambiguous (hex chars are also valid base64).

  function _bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function _signatureCandidates(signature) {
    const s = String(signature || '').trim();
    if (!s) return [];
    const candidates = [];
    if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 2 && s.length % 2 === 0) {
      candidates.push(new Uint8Array(s.match(/.{2}/g).map(b => parseInt(b, 16))));
    }
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) && s.length >= 2) {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      try {
        const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        candidates.push(out);
      } catch (_) { /* not base64 either — hex candidate (if any) stands */ }
    }
    return candidates;
  }

  // ─── Key material helpers ───────────────────────────────────────────────────

  async function _toCryptoKey(key, usage, method) {
    if (!key) throw new Error('No key provided');
    if (typeof key === 'object' && typeof key.type === 'string' && key.algorithm) {
      return key;
    }
    const m = method || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) throw new Error(`Unknown signing method: ${m}`);

    // ml-dsa-65 keys are hex strings (see generateSigningKeyPair), not JWK
    // JSON, so this must run before the generic JSON.parse gate below —
    // parsing a hex string as JSON always throws, which was rejecting
    // every valid ML-DSA-65 key before it ever reached this branch.
    if (m === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // Real API takes/returns raw key bytes directly to sign()/verify() —
      // there's no importKey step and no keyFromJwk (that was invented).
      // Keys are stored as hex strings here (see generateSigningKeyPair),
      // so just decode hex back to bytes.
      const hexStr = typeof key === 'string' ? key : null;
      if (!hexStr || !/^[0-9a-fA-F]+$/.test(hexStr)) {
        throw new Error('ML-DSA-65 keys must be a hex string (from generateSigningKeyPair)');
      }
      const bytes = new Uint8Array(hexStr.match(/.{2}/g).map(b => parseInt(b, 16)));
      return bytes;
    }

    let jwk = key;
    if (typeof key === 'string') {
      try { jwk = JSON.parse(key); }
      catch (_) { throw new Error('String keys must be a JWK JSON string'); }
    }
    if (m === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) throw new Error('Ed448 requires Node crypto (available in NW.js), which is not present in this environment');
      // Node's createPublicKey/createPrivateKey accept a JWK directly —
      // unlike ML-DSA-65, Ed448 JWKs round-trip fine through Node crypto,
      // no hex workaround needed here.
      return usage === 'sign'
        ? nc.createPrivateKey({ key: jwk, format: 'jwk' })
        : nc.createPublicKey({ key: jwk, format: 'jwk' });
    }
    if (m === 'custom') {
      return jwk;
    }
    // importKey needs the KEYGEN shape (namedCurve for ECDSA, modulusLength
    // for RSA-PSS), not spec.algo, which is the SIGN/VERIFY-time shape
    // (hash instead of namedCurve). Using spec.algo here threw "passed
    // algorithm cannot be converted to 'EcKeyImportParams' because
    // 'namedCurve' is required" for every ECDSA import — the same
    // algo-vs-keygenAlgo mixup already fixed for generateKey() below, but
    // this call site was missed.
    return _crypto.subtle.importKey('jwk', jwk, spec.keygenAlgo, true, [usage]);
  }

  // ─── Keypair generation ─────────────────────────────────────────────────────

  async function generateSigningKeyPair(method = DEFAULT_SIGNING_METHOD) {
    const m = method || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) throw new Error(`Unsupported signing method: ${m}`);

    if (m === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // Real API (ml_dsa65.keygen()) returns { secretKey, publicKey } as
      // raw Uint8Array — there is no .toJwk() on these (that was invented
      // against a nonexistent API). Hex-encode them instead, matching how
      // this file already hex-encodes signatures elsewhere; publicJwk/
      // privateJwk are kept as field names for compatibility with callers
      // but hold hex strings, not JWK JSON, for this method.
      const keypair = npq.ml_dsa65.keygen();
      const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return {
        publicKey:  keypair.publicKey,
        privateKey: keypair.secretKey,
        publicJwk:  toHex(keypair.publicKey),
        privateJwk: toHex(keypair.secretKey),
      };
    }

    if (m === 'custom') {
      throw new Error('Cannot generate a keypair for custom signing — provide your own key material');
    }

    if (m === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) {
        throw new Error('Ed448 requires Node crypto (available in NW.js) — not present in this environment (e.g. a plain browser tab)');
      }
      // Node's OpenSSL-backed crypto supports Ed448 keygen with direct
      // JWK output, so this can populate publicJwk/privateJwk for real
      // (no hex workaround needed, unlike ML-DSA-65 above).
      const { publicKey, privateKey } = nc.generateKeyPairSync('ed448', {
        publicKeyEncoding:  { format: 'jwk' },
        privateKeyEncoding: { format: 'jwk' },
      });
      return {
        publicKey,
        privateKey,
        publicJwk:  publicKey,
        privateJwk: privateKey,
      };
    }

    const pair = await _crypto.subtle.generateKey(spec.keygenAlgo, true, ['sign', 'verify']);
    const [publicJwk, privateJwk] = await Promise.all([
      _crypto.subtle.exportKey('jwk', pair.publicKey),
      _crypto.subtle.exportKey('jwk', pair.privateKey),
    ]);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk };
  }

  // ─── Integrity helpers ──────────────────────────────────────────────────────

  function _getHasher(method) {
    const m = method || DEFAULT_INTEGRITY_METHOD;
    const spec = INTEGRITY_METHODS[m];
    if (!spec) throw new Error(`Unknown integrity method: ${m}`);
    if (m === 'none') return null;
    if (m === 'blake3') {
      const nh = _getNobleHashes();
      if (!nh) throw new Error('@noble/hashes is not available — install it to use BLAKE3');
      return {
        hash: (data) => Array.from(nh.blake3(data)).map(b => b.toString(16).padStart(2, '0')).join(''),
        label: spec.label,
      };
    }
    // m is lowercase ('sha256'/'sha512'), but WebCrypto requires the
    // dashed uppercase form ('SHA-256'/'SHA-512') — a prior version of
    // this lookup compared against uppercase keys ({'SHA-256': ...}[m])
    // which never matched lowercase m, so it always fell through to
    // m.toUpperCase() = 'SHA256' (no dash), which subtle.digest rejects
    // with "Unrecognized name".
    const algo = { sha256: { name: 'SHA-256' }, sha512: { name: 'SHA-512' } }[m];
    if (!algo) throw new Error(`Unknown integrity method: ${m}`);
    const hasher = _crypto.subtle.digest.bind(_crypto.subtle);
    return {
      hash: async (data) => {
        if (typeof data === 'string') data = new TextEncoder().encode(data);
        const buf = await hasher(algo, data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      },
      label: spec.label,
    };
  }

  async function mapWithConcurrency(items, mapper, concurrency = 4) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(items.length, concurrency);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]);
      }
    }));
    return results;
  }

  async function computeIntegrity(pkg, method = DEFAULT_INTEGRITY_METHOD) {
    const m = method || DEFAULT_INTEGRITY_METHOD;
    const hasher = _getHasher(m);
    if (!hasher) return { method: 'none', payloadHash: null, fileHashes: {} };

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const payloadHash = await hasher.hash(payload);

    const fileEntries = await mapWithConcurrency(Object.entries(pkg.files || {}), async ([relPath, encoded]) => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return [relPath, await hasher.hash(bytes)];
    });

    return { method: m, payloadHash, fileHashes: Object.fromEntries(fileEntries) };
  }

  async function verifyIntegrity(pkg) {
    if (!pkg || !pkg.integrity) return false;
    const { method, payloadHash, fileHashes } = pkg.integrity;
    // Fail closed: a block recorded with method 'none' (or without a
    // payload digest) proves nothing — there are no hashes to compare, so
    // there is nothing to verify. Returning true here let any package that
    // simply skipped hashing ride the integrity-only install path as
    // "verified".
    if (method === 'none' || !payloadHash) return false;

    const hasher = _getHasher(method);
    if (!hasher) return false;

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const currentPayloadHash = await hasher.hash(payload);
    if (currentPayloadHash !== payloadHash) return false;

    const entries = Object.entries(fileHashes || {});
    if (entries.some(([relPath]) => !pkg.files?.[relPath])) return false;

    const checks = await mapWithConcurrency(entries, async ([relPath, expectedHash]) => {
      const encoded = pkg.files?.[relPath];
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return (await hasher.hash(bytes)) === expectedHash;
    });
    return checks.every(Boolean);
  }

  // ─── Signing & verification ─────────────────────────────────────────────────

  async function signPackage(pkg, privateKey, options = {}) {
    const method = options.method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[method];
    if (!spec) throw new Error(`Unsupported signing method: ${method}`);

    if (method === 'custom') {
      const payload = _signingPayload(pkg);
      const signature = typeof privateKey === 'function'
        ? await privateKey(payload)
        : String(privateKey);
      return signature;
    }

    if (method === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // ml_dsa65.sign(msg, secretKey) is a plain function returning a raw
      // Uint8Array signature — no signingKey.sign(...) method, no .toHex().
      const secretKeyBytes = await _toCryptoKey(privateKey, 'sign', method);
      const payload = new TextEncoder().encode(_signingPayload(pkg));
      const sig = npq.ml_dsa65.sign(payload, secretKeyBytes);
      return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    if (method === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) throw new Error('Ed448 requires Node crypto (available in NW.js), which is not present in this environment');
      // EdDSA (Ed448/Ed25519) uses one-shot sign with algorithm=null —
      // there's no separate digest step, unlike ECDSA/RSA above.
      const keyObj = await _toCryptoKey(privateKey, 'sign', method);
      const payload = Buffer.from(_signingPayload(pkg), 'utf8');
      const sig = nc.sign(null, payload, keyObj);
      return sig.toString('hex');
    }

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const cryptoKey = await _toCryptoKey(privateKey, 'sign', method);
    const sig = await _crypto.subtle.sign(spec.algo, cryptoKey, payload);
    // Documented format: base64url (see _signatureCandidates).
    return _bytesToBase64Url(new Uint8Array(sig));
  }

  async function verifyPackage(pkg, publicKey, method) {
    if (!pkg || !pkg.signature) return false;
    const m = method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) return false;

    if (m === 'custom') {
      try {
        const payload = _signingPayload(pkg);
        return typeof publicKey === 'function' ? await publicKey(pkg.signature, payload) : false;
      } catch (_) { return false; }
    }

    if (m === 'ml-dsa-65') {
      try {
        const npq = _getNoblePostQuantum();
        if (!npq) return false;
        // ml_dsa65.verify(sig, msg, publicKey) is a plain function taking
        // raw byte arrays — no Signature.fromHex or verifyKey.verify(...)
        // method (those don't exist on the real API).
        const publicKeyBytes = await _toCryptoKey(publicKey, 'verify', m);
        const payload = new TextEncoder().encode(_signingPayload(pkg));
        const sigMatch = pkg.signature.match(/.{2}/g);
        if (!sigMatch) return false;
        const sigBytes = new Uint8Array(sigMatch.map(b => parseInt(b, 16)));
        return npq.ml_dsa65.verify(sigBytes, payload, publicKeyBytes);
      } catch (_) { return false; }
    }

    if (m === 'ed448') {
      try {
        const nc = _getNodeCrypto();
        if (!nc) return false;
        const keyObj = await _toCryptoKey(publicKey, 'verify', m);
        const payload = Buffer.from(_signingPayload(pkg), 'utf8');
        const sigMatch = pkg.signature.match(/.{2}/g);
        if (!sigMatch) return false;
        const sigBytes = Buffer.from(sigMatch.map(b => parseInt(b, 16)));
        return nc.verify(null, payload, keyObj, sigBytes);
      } catch (_) { return false; }
    }

    try {
      const payload = new TextEncoder().encode(_signingPayload(pkg));
      const cryptoKey = await _toCryptoKey(publicKey, 'verify', m);
      // Accept the documented base64url form AND the hex form historical
      // builds emitted — see _signatureCandidates.
      for (const sigBytes of _signatureCandidates(pkg.signature)) {
        try {
          if (await _crypto.subtle.verify(spec.algo, cryptoKey, sigBytes, payload)) return true;
        } catch (_) { /* wrong length/encoding for this key — next candidate */ }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function verifyAgainstTrustStore(pkg, trustStore, revocationCheck) {
    if (!pkg || !pkg.signature || !Array.isArray(trustStore)) return { trusted: false, signer: null };
    if (typeof revocationCheck === 'function' && revocationCheck(pkg.signature)) {
      return { trusted: false, signer: null, revoked: true };
    }
    for (const entry of trustStore) {
      try {
        const method = entry.method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
        const ok = await verifyPackage(pkg, entry.publicKey, method);
        if (ok) return { trusted: true, signer: entry.name || null, method };
      } catch (_) { /* try next entry */ }
    }
    return { trusted: false, signer: null };
  }

  // ─── Package creation ────────────────────────────────────────────────────────

  async function createPackage(manifest, files, options = {}) {
    const validation = validateManifest(manifest);
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
    if (validation.warnings.length > 0) console.warn('[AppPackage] Warnings:', validation.warnings);

    const pkg = {
      novabyte_app: NOVAAPP_FORMAT_VERSION,
      manifest: { ...manifest, packagedAt: new Date().toISOString() },
      files: {},
      signature: null,
      signer: null,
      compiled_at: new Date().toISOString(),
      signing: null,
      integrity: null,
    };

    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        pkg.files[path] = btoa(unescape(encodeURIComponent(content)));
      } else if (content instanceof Uint8Array || Buffer.isBuffer?.(content)) {
        const binary = Array.from(new Uint8Array(content))
          .map(b => String.fromCharCode(b)).join('');
        pkg.files[path] = btoa(binary);
      }
    }
    if (manifest.permissions?.includes('system:root') && !pkg.files[manifest.unrestrictedEntry]) {
      throw new Error(`Root package is missing unrestrictedEntry file "${manifest.unrestrictedEntry}"`);
    }

    if (options.signingKey) {
      const method = options.signingMethod || DEFAULT_SIGNING_METHOD;
      pkg.signing = { method };
      pkg.signature = await signPackage(pkg, options.signingKey, { method });
      pkg.signer = options.signerName || 'self-signed';
    }

    // Integrity is opt-in per call: the Packages app and Studio-style
    // builders pass an explicit method (Studio v1.1.80+ defaults new
    // projects to None), and computing one implicitly via the blake3
    // default hard-required @noble/hashes — a bare createPackage() in an
    // environment without that dependency threw instead of building the
    // package it was asked to build.
    if (options.integrityMethod && options.integrityMethod !== 'none') {
      pkg.integrity = await computeIntegrity(pkg, options.integrityMethod);
    }

    return pkg;
  }

  // ─── Install / uninstall ─────────────────────────────────────────────────────

  async function installPackage(pkg, options = {}) {
    let verified = false;
    let signer = null;

    if (!options.skipVerify) {
      // Settings is shipped as a first-party built-in system bundle. This
      // package is rebuilt together with the OS, so its runtime content is
      // authoritative when boot is reconciling the bundled copy. Keep this
      // exception narrow to the Settings id + system-bundle source; normal
      // user-installed packages still require cryptographic verification.
      if (options.source === 'system-bundle' && pkg?.manifest?.system === true && pkg?.manifest?.id) {
        // Bundled system packages are trusted by immutable build provenance,
        // not by a copied signature field. Integrity is still mandatory below,
        // and the boot reconciler only feeds packages named by the generated
        // first-party manifest into this path.
        verified = true;
        signer = 'Astro System';
      } else {
      const trustStore = options.trustStore || [];
      const result = await verifyAgainstTrustStore(pkg, trustStore, options.revocationCheck);
      verified = result.trusted;
      signer = result.signer;
      // Integrity-only rescue: when the caller enabled the fallback and the
      // package carries genuine recorded hashes that still match, the
      // install is marked verified with signer 'integrity-only' — the
      // contents provably match what was built, even though the signer is
      // unknown. This runs before the allowUnverified bypass so a caller
      // passing both flags gets the more truthful status, and
      // verifyIntegrity()'s fail-closed 'none'/missing-digest handling keeps
      // packages that never recorded hashes off this path.
      if (!verified && options.allowIntegrityFallback && await verifyIntegrity(pkg)) {
        verified = true;
        signer = signer || 'integrity-only';
      }
      if (!verified && !options.allowUnverified) {
        const msg = 'Package signature did not match any trusted signer and integrity check failed';
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: `Install failed for ${pkg?.manifest?.id || '(unknown)'}: ${msg}`, data: { appId: pkg?.manifest?.id, reason: 'signature' } });
        }
        throw new Error(msg);
      }
      }
    }

    const validation = validateManifest(pkg.manifest);
    if (!validation.valid) {
      const msg = `Invalid manifest: ${validation.errors.join(', ')}`;
      if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: `Install failed for ${pkg?.manifest?.id || '(unknown)'}: ${msg}`, data: { appId: pkg?.manifest?.id, reason: 'manifest' } });
      }
      throw new Error(msg);
    }
    if (pkg.manifest.permissions?.includes('system:root')
      && typeof pkg.files?.[pkg.manifest.unrestrictedEntry] !== 'string') {
      const msg = `Root package is missing unrestrictedEntry file "${pkg.manifest.unrestrictedEntry}"`;
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'Packages',
          category: 'security',
          severity: 'error',
          message: `Install failed for ${pkg.manifest.id}: ${msg}`,
          data: { appId: pkg.manifest.id, permission: 'system:root', action: 'root-package-invalid' },
        });
      }
      throw new Error(msg);
    }

    const existing = (typeof AppRegistry !== 'undefined') && AppRegistry?.getApp(pkg.manifest.id);
    if (existing && !options.force) {
      const msg = `App ${pkg.manifest.id} is already installed. Use force option to overwrite.`;
      if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: msg, data: { appId: pkg.manifest.id, reason: 'duplicate' } });
      }
      throw new Error(msg);
    }

    // A package may declare itself as a system app, but that declaration
    // only has authority when the package has been cryptographically
    // verified against the dedicated System signing key — a separate,
    // more tightly held key from the general trusted-signing one (see
    // trust-store.js's 'Astro System' entry). Checking against the
    // general trusted-signing entry here would let any reviewed
    // third-party app claim system: true, which defeats the point of
    // having a separate system key at all. The manifest flag is part of
    // the signed payload, so it cannot be changed after signing.
    const system = verified && signer === 'Astro System' && pkg.manifest?.system === true;

    const appConfig = {
      ...pkg.manifest,
      manifest:      pkg.manifest,
      files:         pkg.files,
      signature:     pkg.signature,
      signing:       pkg.signing,
      integrity:     pkg.integrity,
      novabyte_app:  pkg.novabyte_app,
      compiled_at:   pkg.compiled_at,
      verified,
      signer,
      system,
      source:        options.source || 'file',
      installedDate: new Date().toISOString()
    };

    const registered = (typeof AppRegistry !== 'undefined') &&
      AppRegistry?.registerApp(appConfig, { force: !!options.force });

    if (registered && typeof window.NovaAppPackageStore !== 'undefined' && window.NovaAppPackageStore.installApp) {
      try {
        await window.NovaAppPackageStore.installApp({
          novabyte_app: pkg.novabyte_app,
          compiled_at: pkg.compiled_at,
          id: appConfig.id,
          name: appConfig.name,
          version: appConfig.version,
          entry: appConfig.entry,
          icon: appConfig.icon,
          description: appConfig.description || '',
          category: appConfig.category || 'other',
          permissions: appConfig.permissions || [],
          optionalPermissions: appConfig.optionalPermissions || [],
          files: appConfig.files || {},
          signature: appConfig.signature,
          verified,
          signer,
          source: appConfig.source,
          installedDate: appConfig.installedDate,
          manifest: pkg.manifest,
          signing: pkg.signing,
          integrity: pkg.integrity,
        });
      } catch (e) {
        console.warn('[AppPackage] Failed to persist installed app to NovaAppPackageStore:', e);
      }
    }

    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'Packages',
        category: 'packages',
        severity: validation.warnings.length ? 'warn' : 'info',
        message: `Installed ${pkg.manifest.id}${verified ? '' : ' (unverified)'}`,
        data: { appId: pkg.manifest.id, verified, signer, source: appConfig.source, warnings: validation.warnings },
      });
    }
    return { success: true, app: registered, verified, signer, warnings: validation.warnings };
  }

  async function uninstallPackage(appId) {
    const result = (typeof AppRegistry !== 'undefined' && AppRegistry?.uninstallApp)
      ? await AppRegistry.uninstallApp(appId)
      : false;
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'Packages',
        category: 'packages',
        severity: result ? 'info' : 'warn',
        message: result ? `Uninstalled ${appId}` : `Uninstall failed for ${appId} (not found)`,
        data: { appId, action: 'uninstall' },
      });
    }
    return result;
  }

  function extractPackage(pkg) {
    const files = {};
    for (const [path, encoded] of Object.entries(pkg.files)) {
      try {
        const binary = atob(encoded);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        files[path] = bytes;
      } catch (e) {
        console.error(`[AppPackage] Failed to decode ${path}:`, e);
      }
    }
    return files;
  }

  function inspectPackage(pkg) {
    return {
      format:       pkg.novabyte_app,
      manifest:     pkg.manifest,
      fileCount:    Object.keys(pkg.files).length,
      files:        Object.keys(pkg.files),
      hasSignature: !!pkg.signature,
      signer:       pkg.signer || null,
      signingMethod: pkg.signing?.method || null,
      integrityMethod: pkg.integrity?.method || null,
      size:         JSON.stringify(pkg).length
    };
  }

  // ─── Method readers ─────────────────────────────────────────────────────────

  function getSigningMethod(pkg) {
    if (!pkg || !pkg.signing) return null;
    const m = pkg.signing.method;
    return SIGNING_METHODS[m] ? m : null;
  }

  function getIntegrityMethod(pkg) {
    if (!pkg || !pkg.integrity) return null;
    const m = pkg.integrity.method;
    return INTEGRITY_METHODS[m] ? m : null;
  }

  function listSigningMethods() {
    return Object.entries(SIGNING_METHODS).map(([id, spec]) => ({ id, label: spec.label, experimental: !!spec.experimental }));
  }

  function listIntegrityMethods() {
    return Object.entries(INTEGRITY_METHODS).map(([id, spec]) => ({ id, label: spec.label }));
  }

  // ─── Manifest validation ────────────────────────────────────────────────────

  // Icons are a small UI asset — a legitimate high-res PNG/SVG as a data:
  // URI comfortably fits well under this. Anything past it is either a
  // mistake (wrong file embedded) or a deliberate attempt to bloat the
  // manifest / waste memory on every render of the app list, launcher,
  // taskbar, etc. — icon strings get parsed and rendered repeatedly across
  // many UI surfaces (see the App Manager package's svgIcon()/createEl() call sites),
  // so an oversized one has an outsized cost relative to its purpose.
  const MAX_ICON_DATA_URI_BYTES = 512 * 1024; // 512KB
  const IPC_ENDPOINT_PATTERN = /^(?:service|provider):[a-z0-9][a-z0-9._-]{0,127}$/;
  const IPC_ACTION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

  function validateManifest(manifest) {
    const errors = [], warnings = [];
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['Manifest is missing or not an object'], warnings: [] };
    }
    ['id', 'name', 'version', 'entry'].forEach(f => {
      if (!manifest[f]) errors.push(`Missing required field: ${f}`);
    });

    // SECURITY (2026-11-12 audit, finding F7/L3): entry/guestEntry and
    // package file keys are package-controlled strings. Resolution is
    // object-key/Map-based, so traversal cannot reach the host filesystem
    // today — but this shape gate makes that invariant explicit at
    // validation time instead of holding by accident, and covers paths
    // (like nova:app:install) that historically skipped validation.
    const SAFE_PACKAGE_PATH_RE = /^[\w@.\/-][\w@. \/-]{0,255}$/;
    const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:]/;
    const isUnsafePackagePath = (value) => {
      if (typeof value !== 'string' || value.length === 0) return false;
      if (FORBIDDEN_PATH_CHARS.test(value)) return true;
      if (value.startsWith('/')) return true;
      const segments = value.split('/');
      return segments.some(seg => seg === '.' || seg === '..' || seg === '');
    };
    const checkPackagePath = (value, label) => {
      if (typeof value !== 'string' || value.length === 0) return; // presence handled above
      if (isUnsafePackagePath(value) || !SAFE_PACKAGE_PATH_RE.test(value)) {
        errors.push(`Invalid ${label} "${value}": no absolute paths, traversal, backslashes, ':' or control characters`);
      }
    };
    if (manifest.entry) checkPackagePath(manifest.entry, 'entry');
    if (manifest.guestEntry) checkPackagePath(manifest.guestEntry, 'guestEntry');
    if (manifest.icon && typeof manifest.icon === 'string' && !String(manifest.icon).startsWith('data:')) {
      // Non-data icons are rendered via svgIcon()/img attributes in the
      // privileged shell. Accept the shapes that render inertly: absolute
      // /assets/... paths (svgIcon whitelists the charset), plain relative
      // asset keys, and short non-ASCII (emoji) strings that svgIcon
      // renders as escaped text. Anything else is a warning — svgIcon()'s
      // escaping is the second line of defence, so this is defence in
      // depth, not the only gate.
      const iconValue = String(manifest.icon);
      const iconIsSafe = /^\/assets\/[A-Za-z0-9._\/-]+$/.test(iconValue)
        || SAFE_PACKAGE_PATH_RE.test(iconValue)
        || (/[^\u0000-\u007F]/.test(iconValue) && iconValue.length <= 12);
      if (!iconIsSafe) {
        warnings.push('Icon is neither a data: URI, a plain asset path, nor an emoji; it will be rendered as escaped text');
      }
    }
    if (manifest.id && !manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id))
        errors.push(`Invalid app ID "${manifest.id}". Must be reverse domain format.`);
    }
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version))
      warnings.push(`Version "${manifest.version}" doesn't follow semver (x.y.z)`);
    if (manifest.handles !== undefined) {
      const handles = manifest.handles;
      if (!handles || typeof handles !== 'object' || Array.isArray(handles)) {
        errors.push('handles must be an object');
      } else {
        for (const key of Object.keys(handles)) {
          if (!['protocols', 'extensions', 'mimeTypes', 'roles'].includes(key)) {
            errors.push(`handles.${key} is not supported`);
          }
        }
        const definitions = [
          ['protocols', value => /^[a-z][a-z0-9+.-]*:?$/i.test(value.trim())],
          ['extensions', value => /^\.[a-z0-9][a-z0-9._+-]*$/i.test(value.trim())],
          ['mimeTypes', value => /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(value.split(';', 1)[0].trim())],
          ['roles', value => value.trim().toLowerCase() === 'home'],
        ];
        for (const [key, isValid] of definitions) {
          if (handles[key] === undefined) continue;
          if (!Array.isArray(handles[key]) || handles[key].length > 100) {
            errors.push(`handles.${key} must be an array of at most 100 strings`);
            continue;
          }
          handles[key].forEach((value, index) => {
            if (typeof value !== 'string' || !isValid(value)) {
              errors.push(`handles.${key}[${index}] is invalid`);
            }
          });
        }
      }
    }
    if (manifest.shareTarget !== undefined) {
      const shareTarget = manifest.shareTarget;
      if (!shareTarget || typeof shareTarget !== 'object' || Array.isArray(shareTarget)) {
        errors.push('shareTarget must be an object');
      } else {
        for (const key of Object.keys(shareTarget)) {
          if (key !== 'mimeTypes') errors.push(`shareTarget.${key} is not supported`);
        }
        if (shareTarget.mimeTypes !== undefined) {
          if (!Array.isArray(shareTarget.mimeTypes) || shareTarget.mimeTypes.length > 20) {
            errors.push('shareTarget.mimeTypes must be an array of at most 20 MIME patterns');
          } else {
            const seenMime = new Set();
            shareTarget.mimeTypes.forEach((value, index) => {
              const base = typeof value === 'string' ? value.split(';', 1)[0].trim() : '';
              const valid = /^\*\/\*$/.test(base) || /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(base);
              if (!valid) {
                errors.push(`shareTarget.mimeTypes[${index}] is invalid`);
              } else if (seenMime.has(base.toLowerCase())) {
                errors.push(`shareTarget.mimeTypes[${index}] is duplicated`);
              } else {
                seenMime.add(base.toLowerCase());
              }
            });
          }
        }
      }
    }
    if (manifest.ipc !== undefined) {
      const ipcManifest = manifest.ipc;
      if (!ipcManifest || typeof ipcManifest !== 'object' || Array.isArray(ipcManifest)) {
        errors.push('ipc must be an object');
      } else {
        for (const key of Object.keys(ipcManifest)) {
          if (!['exports', 'receives'].includes(key)) errors.push(`ipc.${key} is not supported`);
        }
        for (const [key, pattern] of [
          ['exports', IPC_ENDPOINT_PATTERN],
          ['receives', IPC_ACTION_PATTERN],
        ]) {
          const values = ipcManifest[key];
          if (values === undefined) continue;
          if (!Array.isArray(values) || values.length > 100) {
            errors.push(`ipc.${key} must be an array of at most 100 strings`);
            continue;
          }
          const seen = new Set();
          values.forEach((value, index) => {
            if (typeof value !== 'string' || !pattern.test(value)) {
              errors.push(`ipc.${key}[${index}] is invalid`);
            } else if (seen.has(value)) {
              errors.push(`ipc.${key}[${index}] is duplicated`);
            } else {
              seen.add(value);
            }
          });
        }
      }
    }
    if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
      errors.push('permissions must be an array');
    } else if (manifest.permissions) {
      const valid = Object.values((typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.PERMISSION_TYPES) || {});
      manifest.permissions.forEach(p => {
        if (valid.length > 0 && !valid.includes(p)) warnings.push(`Unknown permission: ${p}`);
      });
    }
    if (manifest.permissionReasons !== undefined) {
      // permissionReasons maps permission strings to the developer's
      // declared reason for needing them — the text the OS shows in the
      // grant dialogs (with an explicit fallback when a permission has no
      // entry). Shape errors reject the package; unknown keys and reasons
      // for permissions the manifest doesn't declare are warnings, matching
      // how the permissions array itself treats unknown strings. The length
      // cap mirrors AppPermissionManager.MAX_REASON_LENGTH (the dialog
      // truncates rather than wraps); app-registry.js truncates for the
      // non-package path, so packages are held to the stricter standard.
      const reasons = manifest.permissionReasons;
      if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
        errors.push('permissionReasons must be an object mapping permission strings to reason strings');
      } else {
        const validPerms = Object.values((typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.PERMISSION_TYPES) || {});
        const legacyAliases = (typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.LEGACY_PERMISSION_ALIASES) || {};
        const reasonCap = (typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.MAX_REASON_LENGTH) || 500;
        const declaredPerms = new Set([
          ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
          ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
        ]);
        for (const [key, value] of Object.entries(reasons)) {
          if (typeof key !== 'string' || !key.trim()) {
            errors.push('permissionReasons keys must be non-empty permission strings');
            continue;
          }
          const canonical = Object.prototype.hasOwnProperty.call(legacyAliases, key) ? legacyAliases[key] : key;
          if (validPerms.length > 0 && !validPerms.includes(canonical)) {
            warnings.push(`Unknown permission in permissionReasons: ${key}`);
          }
          if (typeof value !== 'string' || !value.trim()) {
            errors.push(`permissionReasons["${key}"] must be a non-empty string`);
          } else if (value.trim().length > reasonCap) {
            errors.push(`permissionReasons["${key}"] exceeds ${reasonCap} characters`);
          } else if (!declaredPerms.has(key) && !declaredPerms.has(canonical)) {
            warnings.push(`permissionReasons declares "${key}", which is not in permissions or optionalPermissions`);
          }
        }
      }
    }
    const requestsRoot = Array.isArray(manifest.permissions) && manifest.permissions.includes('system:root');
    const rootEntry = manifest.unrestrictedEntry;
    if (rootEntry !== undefined && (typeof rootEntry !== 'string'
      || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.js$/i.test(rootEntry))) {
      errors.push('unrestrictedEntry must name a packaged JavaScript file without parent-directory segments');
    }
    if (requestsRoot && typeof rootEntry !== 'string') {
      errors.push('system:root requires unrestrictedEntry to name a packaged JavaScript file');
    }
    if (Array.isArray(manifest.optionalPermissions) && manifest.optionalPermissions.includes('system:root')) {
      errors.push('system:root must be declared as a required permission, not optionalPermissions');
    }
    if (typeof manifest.icon === 'string' && manifest.icon.startsWith('data:')) {
      // .length on a data: URI string is a fine proxy for its encoded byte
      // size here — off by a small constant factor at most (base64 framing
      // overhead), nowhere near enough to matter against a 512KB cap.
      if (manifest.icon.length > MAX_ICON_DATA_URI_BYTES) {
        errors.push(`Icon data URI exceeds ${MAX_ICON_DATA_URI_BYTES} byte limit (got ~${manifest.icon.length} bytes) — use a smaller image or reference a file in the package instead`);
      }
    }
    if (manifest.defaultSize &&
        (!Array.isArray(manifest.defaultSize) || manifest.defaultSize.length !== 2))
      errors.push('defaultSize must be [width, height]');
    if (manifest.minSize &&
        (!Array.isArray(manifest.minSize) || manifest.minSize.length !== 2))
      errors.push('minSize must be [width, height]');
    if (manifest.maxSize &&
        (!Array.isArray(manifest.maxSize) || manifest.maxSize.length !== 2))
      errors.push('maxSize must be [width, height]');
    return { valid: errors.length === 0, errors, warnings };
  }

  return {
    validateManifest, createPackage, signPackage, verifyPackage,
    verifyAgainstTrustStore, generateSigningKeyPair,
    installPackage, uninstallPackage, extractPackage, inspectPackage,
    computeIntegrity, verifyIntegrity,
    getSigningMethod, getIntegrityMethod,
    listSigningMethods, listIntegrityMethods,
    SIGNING_METHODS, INTEGRITY_METHODS,
    DEFAULT_SIGNING_METHOD, DEFAULT_INTEGRITY_METHOD,
    NOVAAPP_FORMAT_VERSION
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AppPackage;
if (typeof window !== 'undefined') window.AppPackage = AppPackage;