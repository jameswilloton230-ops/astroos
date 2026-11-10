/**
 * NovaByte - Trust Store
 * ────────────────────────────────────────────────────────────
 * A small, explicit list of public keys NBOSP trusts to vouch for app
 * packages, analogous to a browser's shipped root CA list. Each entry
 * holds ONLY a public key — never a secret — so shipping this file to
 * every install is safe: it lets installs *verify* signatures, it can
 * never let anyone *forge* one.
 *
 * Where entries come from:
 *  - "NovaByte Trusted Signing" is the built-in signing authority run by
 *    NovaByte. Developers who want the "Trusted" badge submit their
 *    package to that authority (see NovaPack Studio's signing flow),
 *    which reviews it and signs it with a private key ONLY NovaByte
 *    holds, offline. This file ships the matching public key.
 *  - Additional partner/enterprise CAs can be appended the same way if
 *    NovaByte ever delegates trust to other signing authorities.
 *  - Individual developers can still self-sign (createPackage with a
 *    signingKey) for their own testing, but self-signed packages will
 *    not match anything in this trust store, so they'll always surface
 *    as "Unverified" to end users — which is correct: nobody but the
 *    developer themselves vouches for a self-signed app.
 *
 * NOTE on the key below: this is a real public key, not a placeholder.
 * It corresponds to NovaByte's own private signing key, held offline
 * and never distributed to developers — that's what the "Verified"
 * badge means for a stock/NovaByte-signed install (see the README's
 * Security section).
 *
 * Swapping it out: if your fork isn't licensed for NovaByte Services,
 * this key is yours to replace like any other trust store entry —
 * point it at your own offline signing key and your fork's "Verified"
 * badge will mean packages reviewed and signed by you instead. The
 * key only has to stay as-is (unmodified, unremoved, still checked)
 * if your fork is NovaByte Services-licensed — see below.
 *
 * This file is part of NBOSP itself (Apache 2.0) — it's bundled in
 * every clone and fork, no separate license needed to have it or fork
 * it as-is.
 *
 * The one condition: if your fork wants a NovaByte Services license
 * (see the README's Licensing section — this covers Nova Core
 * Services, NovaBridge, Sentinel, and the other bundled components),
 * this check — verifying package signatures against the trust store —
 * has to stay intact: not removed, not bypassed, not turned into a
 * no-op, and the NovaByte key above has to stay the one it verifies
 * against. We won't issue a NovaByte Services license to a fork where
 * this has been altered, because a fork that hands out "Trusted"
 * badges to unreviewed/unsigned packages breaks verification for
 * users and for us. Forking NBOSP without a NovaByte Services license
 * is unaffected either way — do what you want with your fork,
 * including swapping this key for your own; this condition only bites
 * if you also want that license.
 *
 * Revocation:
 *  - A signature can be individually revoked without touching the signing
 *    key itself or any other package ever signed. Revocation is keyed by
 *    the exact signature string on the package (pkg.signature), not by
 *    app id/name/version — those are dev-controlled fields a bad actor
 *    could reuse or spoof; the signature is a fixed, unforgeable value
 *    produced once at sign time, so it's the only safe revocation key.
 *  - Revoking a signature does NOT revoke the signing key. Every other
 *    package ever signed with that key remains trusted. This is
 *    deliberately narrow — the whole point is to avoid "one bad app means
 *    distrust everything NovaByte has ever signed."
 *  - If the signing key itself is compromised (the actual key leaks),
 *    revoking individual signatures here is NOT sufficient — that
 *    scenario requires removing/replacing the trust store entry itself
 *    (see `list()`/`add()`) and re-signing everything with a new key.
 *    Revocation here only covers "this one specific app turned out bad,"
 *    not "the key itself is no longer trustworthy."
 *
 * @module js/platform/security/trust-store
 */

const TrustStore = (() => {
  // Grab this the moment the IIFE starts running, not lazily later —
  // document.currentScript is only valid while THIS script is
  // synchronously executing. By the time revoke() or isRevoked() gets
  // called from a click handler or a later require(), the script has
  // long finished loading and currentScript has reset to null. See
  // _resolveOwnDirectory() below for why this is the fix and
  // process.cwd() wasn't.
  const OWN_SCRIPT_ELEMENT =
    typeof document !== 'undefined' ? document.currentScript : null;

  // Real public key, matching NovaByte's own offline private signing
  // key (see the module-level comment above — swappable for your own
  // if this fork isn't NovaByte Services-licensed).
  const NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY',
  };

  // System-signer key is intentionally separate from the general trusted-
  // signing key above. A package verified against THIS entry is eligible
  // for the "System" badge in the App Manager package —
  // that's a stronger claim than ordinary "Verified", so it gets its own
  // signer identity rather than reusing NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK.
  // Replace this JWK with your own Ed25519 public key before relying on
  // the System badge for anything — as committed, this is a non-functional
  // placeholder (no matching private key exists for it), so nothing will
  // verify against it until you swap it out.
  const NOVABYTE_SYSTEM_SIGNING_PUBLIC_JWK = {
  "kty": "OKP",
  "crv": "Ed25519",
  "x": "vAglEORayg7_dzvIe1hJ6_RJrLKlEin_77IFWa-8k_o"
};

  const entries = [
    {
      name: 'NovaByte Trusted Signing',
      id: 'novabyte-trusted-signing-v1',
      publicKey: NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK,
      // Shown in the "More Info" panel of the untrusted-app dialog.
      description: 'Reviewed and signed by NovaByte\u2019s trusted signing authority.',
    },
    {
      name: 'NovaByte System',
      id: 'novabyte-system-signing-v1',
      publicKey: NOVABYTE_SYSTEM_SIGNING_PUBLIC_JWK,
      // installPackage() in app-package.js checks signer === 'NovaByte System'
      // to set appConfig.system — keep this `name` in sync with that check
      // if it's ever renamed.
      description: 'Signed by the NovaByte System key. Packages signed by this key may show a System badge; System status does not prevent user-initiated uninstall.',
    },
    // Additional trusted CAs / partners can be appended here.
  ];

  // ── Node/browser interop ──────────────────────────────────────────────
  // This file is loaded as a plain <script src> tag (see index.html), not
  // require()'d as a CommonJS module — but NW.js still gives script-tag
  // code real require() access to Node's fs/path. What it does NOT give
  // that code is __dirname/__filename: those are only set for modules
  // actually loaded through require(), and NW.js's own docs confirm a
  // script tag's code stays in "webkit context" regardless (see the
  // module doc comment above for how that bit us before).
  //
  // Split into two questions on purpose, unlike the previous version's
  // single catch-and-ignore: "is fs unavailable" and "did require() fail
  // for some other reason" want different responses. The first is
  // routine (a sandboxed browser tab with no Node integration) and
  // should fall back quietly. The second — fs existing but require()
  // itself throwing something unexpected — is worth a console line,
  // since silently eating it looks identical to case one and could hide
  // a real environment problem.
  let _fs = null;
  let _path = null;
  if (typeof require === 'function') {
    try {
      _fs = require('fs');
      _path = require('path');
    } catch (err) {
      console.error(
        `[TrustStore] require('fs'/'path') is available but threw unexpectedly: ${err.message}. Falling back to in-memory-only revocation (no persistence).`
      );
    }
  }
  // No `require` at all just means a plain sandboxed browser tab — the
  // expected, unremarkable case. No fs, no persistence, nothing to log.

  const REVOCATION_FILENAME = 'revoked-signatures.json';

  /**
   * Figure out the directory this file actually lives in, so
   * revoked-signatures.json is read from next to trust-store.js — not
   * from wherever the NBOSP process happened to be launched from.
   *
   * Preferred: document.currentScript.src, captured above while this
   * script was still synchronously executing. That's the actual DOM
   * script element for THIS file, so its resolved `src` is the real
   * answer regardless of what launched the process or which directory
   * it started in.
   *
   * Fallback: process.cwd(). Only reached if currentScript wasn't
   * available when this module loaded (e.g. genuine plain-Node require(),
   * as opposed to NW.js's script-tag-with-require hybrid). This is the
   * same value the old code fell back into by accident via an
   * undeclared __dirname — kept as a last resort, not silently, so
   * anyone hitting it sees why.
   */
  function _resolveOwnDirectory() {
    if (OWN_SCRIPT_ELEMENT && OWN_SCRIPT_ELEMENT.src) {
      try {
        return _path.dirname(new URL(OWN_SCRIPT_ELEMENT.src).pathname);
      } catch (err) {
        console.warn(
          `[TrustStore] Couldn't parse currentScript.src (${OWN_SCRIPT_ELEMENT.src}): ${err.message}. Falling back to process.cwd(), which may not be this file's actual directory.`
        );
      }
    }
    return process.cwd();
  }

  function _revocationFilePath() {
    return _path.join(_resolveOwnDirectory(), REVOCATION_FILENAME);
  }

  function _loadRevokedFromDisk() {
    if (!_fs) return [];
    try {
      const raw = _fs.readFileSync(_revocationFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return []; // no revocations yet — normal on first run
      // A corrupt file is a real risk worth surfacing, not silently
      // swallowing — same reasoning as submission-queue.js's _readRaw().
      console.error(
        `[TrustStore] revoked-signatures.json exists but couldn't be read/parsed: ${err.message}. Revocation list may be incomplete until this is fixed.`
      );
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'TrustStore',
          category: 'security',
          severity: 'error',
          message: `Revocation list corrupt/unreadable: ${err.message}. List may be incomplete.`,
        });
      }
      return [];
    }
  }

  function _saveRevokedToDisk(list) {
    if (!_fs) return; // no persistence available; caller already has the in-memory update
    try {
      _fs.writeFileSync(_revocationFilePath(), JSON.stringify(list, null, 2));
    } catch (err) {
      console.error(
        `[TrustStore] Failed to write revoked-signatures.json: ${err.message}. Revocation was applied in memory but will NOT survive a restart until this is fixed.`
      );
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'TrustStore',
          category: 'security',
          severity: 'error',
          message: `Failed to persist revocation list: ${err.message}. In-memory only, will not survive restart.`,
        });
      }
    }
  }

  // Loaded once at module init. If persistence isn't available, starts
  // empty and stays in-memory-only for this session (see revoke() below).
  //
  // Single-machine persistence, not multi-machine sync: if this file
  // ever gets read from a Drive-synced (or similar) shared copy instead
  // of a local one, the same read-modify-write race that applies to
  // submission-queue.js's shared submissions.json would apply here too —
  // two processes could both load, both revoke different signatures,
  // and the second write would clobber the first's. For a normal local
  // install reading its own local file, there's only ever one writer at
  // a time, so this isn't a live concern; it would only become one if
  // the deployment model changes to share this file across machines.
  const revoked = _loadRevokedFromDisk();

  // Signature string → revocation record. isRevoked()/getRevocation()
  // used to do a linear .some()/.find() over `revoked` on every call —
  // fine when the list is small, but this file gets consulted on every
  // single app install and launch, so a revocation list with any real
  // size turns into a scan on every one of those checks. A Map keeps
  // every lookup O(1) regardless of how long the list gets, at the cost
  // of keeping both the array and the index in sync on every mutation.
  const revokedIndex = new Map(revoked.map((record) => [record.signature, record]));

  function list() {
    return entries.slice();
  }

  /**
   * Basic shape check for a JWK — enough to catch "someone passed the
   * wrong object" or a typo'd field name at add() time, rather than
   * letting a malformed key sit in the trust store until the first
   * verification attempt fails in a confusing way. This is a shape
   * check, not a cryptographic validity check — it doesn't confirm the
   * key material itself is well-formed, only that it looks like a JWK.
   */
  function _isPlausibleJwk(key) {
    return (
      key !== null &&
      typeof key === 'object' &&
      typeof key.kty === 'string' &&
      key.kty.length > 0
    );
  }

  function add(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Trust store entries need at least {name, publicKey}');
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new Error('Trust store entries need at least {name, publicKey}');
    }
    if (!_isPlausibleJwk(entry.publicKey)) {
      throw new Error(
        `Trust store entry "${entry.name}" has a publicKey that doesn't look like a JWK (expected an object with at least a "kty" field)`
      );
    }
    entries.push(entry);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'TrustStore',
        category: 'security',
        severity: 'warn',
        message: `Added trusted signing authority: ${entry.name}`,
        data: { name: entry.name, id: entry.id },
      });
    }
  }

  /**
   * Revoke a specific signed package by its exact signature string.
   * Idempotent — revoking an already-revoked signature just updates the
   * reason/timestamp rather than adding a duplicate entry. Persists to
   * revoked-signatures.json immediately if filesystem access is
   * available; if not (e.g. a sandboxed browser context with no Node
   * integration), the revocation still applies for THIS process's
   * lifetime, but will not survive a restart or be visible to other
   * processes — check the console warning if that happens.
   * @param {string} signature - the exact pkg.signature hex string
   * @param {string} [reason]
   * @returns {object} the revocation record
   */
  function revoke(signature, reason) {
    if (!signature || typeof signature !== 'string') {
      throw new Error('revoke() requires the exact pkg.signature string of the package being revoked');
    }
    const existing = revokedIndex.get(signature);
    let record;
    if (existing) {
      existing.reason = reason || existing.reason;
      existing.revokedAt = Date.now();
      record = existing;
    } else {
      record = { signature, reason: reason || null, revokedAt: Date.now() };
      revoked.push(record);
      revokedIndex.set(signature, record);
    }
    if (!_fs) {
      console.warn(
        '[TrustStore] No filesystem access in this context — revocation applied for this session only and will NOT persist. Run this from an NW.js/Node context with fs access for it to stick.'
      );
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'TrustStore',
          category: 'security',
          severity: 'warn',
          message: 'Revocation applied in-memory only (no fs access) — will not persist across restart',
        });
      }
    } else {
      _saveRevokedToDisk(revoked);
    }
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'TrustStore',
        category: 'security',
        severity: 'warn',
        message: `Revoked signature${reason ? ': ' + reason : ''}`,
        data: { signature, reason: reason || null },
      });
    }
    return record;
  }

  /**
   * Remove a signature from the revocation list (un-revoke). Rare, but
   * needed if a revocation was applied by mistake.
   */
  function unrevoke(signature) {
    if (!revokedIndex.has(signature)) return false;
    const idx = revoked.findIndex((r) => r.signature === signature);
    // idx can't be -1 here — revokedIndex and revoked are kept in sync
    // on every mutation (revoke/unrevoke), so a hit in one means a hit
    // in the other.
    revoked.splice(idx, 1);
    revokedIndex.delete(signature);
    _saveRevokedToDisk(revoked);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'TrustStore',
        category: 'security',
        severity: 'warn',
        message: 'Un-revoked a previously revoked signature',
        data: { signature },
      });
    }
    return true;
  }

  function isRevoked(signature) {
    if (!signature) return false;
    return revokedIndex.has(signature);
  }

  /**
   * Look up the full revocation record for a signature (reason,
   * revokedAt), or null if it isn't revoked. Kept separate from
   * isRevoked() so existing callers that treat it as a plain boolean
   * predicate (e.g. verifyAgainstTrustStore) aren't affected.
   */
  function getRevocation(signature) {
    if (!signature) return null;
    return revokedIndex.get(signature) || null;
  }

  function listRevoked() {
    return revoked.slice();
  }

  return { list, add, revoke, unrevoke, isRevoked, getRevocation, listRevoked };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrustStore;
if (typeof window !== 'undefined') window.TrustStore = TrustStore;