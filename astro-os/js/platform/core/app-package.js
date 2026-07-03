/**
 * NovaByte - App Package Manager
 * ────────────────────────────────────────────────────────────
 *
 * SECURITY FIXES applied:
 *  [1] verifyPackage() now performs real HMAC-SHA256 verification instead
 *      of just checking that the signature string looks like 64 hex chars.
 *      The package must have been signed with signPackage(pkg, key) and the
 *      same key must be supplied to verifyPackage(pkg, key) / installPackage.
 *  [2] installPackage() rejects packages whose signature fails verification.
 *      The old code accepted any string matching /^[a-f0-9]{64}$/.
 *
 * @module js/app-package
 */

const AppPackage = (() => {
  const NOVAAPP_FORMAT_VERSION = '1.0';
  const _crypto = (typeof window !== 'undefined' ? window.crypto : null)
    || globalThis.crypto
    || require('crypto');

  // ─── Manifest validation (unchanged) ────────────────────────────────────────

  function validateManifest(manifest) {
    const errors = [], warnings = [];
    ['id', 'name', 'version', 'entry'].forEach(f => {
      if (!manifest[f]) errors.push(`Missing required field: ${f}`);
    });
    if (manifest.id && !manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id))
        errors.push(`Invalid app ID "${manifest.id}". Must be reverse domain format.`);
    }
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version))
      warnings.push(`Version "${manifest.version}" doesn't follow semver (x.y.z)`);
    if (manifest.permissions) {
      const valid = Object.values(AppPermissionManager?.PERMISSION_TYPES || {});
      manifest.permissions.forEach(p => {
        if (!valid.includes(p)) warnings.push(`Unknown permission: ${p}`);
      });
    }
    if (manifest.defaultSize &&
        (!Array.isArray(manifest.defaultSize) || manifest.defaultSize.length !== 2))
      errors.push('defaultSize must be [width, height]');
    if (manifest.minSize &&
        (!Array.isArray(manifest.minSize) || manifest.minSize.length !== 2))
      errors.push('minSize must be [width, height]');
    return { valid: errors.length === 0, errors, warnings };
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

  // ─── FIX [1]: Real HMAC-SHA256 signing & verification ───────────────────────

  /**
   * Sign a package with a secret key.
   * @param {object}       pkg - Package object (signature field ignored)
   * @param {string|Uint8Array} key - Raw signing key material
   * @returns {Promise<string>} Hex HMAC-SHA256 signature
   */
  async function signPackage(pkg, key) {
    const payload = new TextEncoder().encode(_signingPayload(pkg));

    if (typeof window !== 'undefined' && _crypto.subtle) {
      const keyMaterial = typeof key === 'string'
        ? new TextEncoder().encode(key)
        : key;
      const cryptoKey = await _crypto.subtle.importKey(
        'raw', keyMaterial,
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
      );
      const sig = await _crypto.subtle.sign('HMAC', cryptoKey, payload);
      return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Node.js fallback
    const crypto = require('crypto');
    return crypto.createHmac('sha256', key).update(payload).digest('hex');
  }

  /**
   * Verify a package signature.
   * FIX [1]: Previously only checked that pkg.signature matched /^[a-f0-9]{64}$/.
   * Now performs constant-time HMAC comparison against the actual key.
   *
   * @param {object}       pkg - Package object with .signature field
   * @param {string|Uint8Array} key - The key used during signPackage()
   * @returns {Promise<boolean>}
   */
  async function verifyPackage(pkg, key) {
    if (!pkg.signature || !key) return false;

    const payload = new TextEncoder().encode(_signingPayload(pkg));

    try {
      if (typeof window !== 'undefined' && _crypto.subtle) {
        const keyMaterial = typeof key === 'string'
          ? new TextEncoder().encode(key)
          : key;
        const cryptoKey = await _crypto.subtle.importKey(
          'raw', keyMaterial,
          { name: 'HMAC', hash: 'SHA-256' },
          false, ['verify']
        );
        const sigBytes = new Uint8Array(
          pkg.signature.match(/.{2}/g).map(b => parseInt(b, 16))
        );
        return await _crypto.subtle.verify('HMAC', cryptoKey, sigBytes, payload);
      }

      // Node.js: constant-time compare via timingSafeEqual
      const crypto   = require('crypto');
      const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(pkg.signature.padEnd(a.length * 2, '0').slice(0, a.length * 2), 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch (_) {
      return false;
    }
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
      compiled_at: new Date().toISOString()
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

    if (options.signingKey) {
      pkg.signature = await signPackage(pkg, options.signingKey);
    }
    return pkg;
  }

  // ─── Install / uninstall ─────────────────────────────────────────────────────

  /**
   * FIX [2]: installPackage now requires a verificationKey when skipVerify is
   * not set. Packages without a valid HMAC signature are rejected outright.
   */
  async function installPackage(pkg, options = {}) {
    if (!options.skipVerify) {
      if (!options.verificationKey) {
        throw new Error('verificationKey is required to install a signed package');
      }
      const valid = await verifyPackage(pkg, options.verificationKey);
      if (!valid) throw new Error('Package signature verification failed');
    }

    const validation = validateManifest(pkg.manifest);
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);

    const existing = AppRegistry?.getApp(pkg.manifest.id);
    if (existing && !options.force) {
      throw new Error(`App ${pkg.manifest.id} is already installed. Use force option to overwrite.`);
    }

    const appConfig = {
      ...pkg.manifest,
      files:         pkg.files,
      signature:     pkg.signature,
      verified:      !options.skipVerify,
      source:        options.source || 'file',
      installedDate: new Date().toISOString()
    };

    const registered = AppRegistry?.registerApp(appConfig);
    return { success: true, app: registered, warnings: validation.warnings };
  }

  function uninstallPackage(appId) {
    return AppRegistry?.unregisterApp(appId) || false;
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
      // NOTE: sync inspection only — call verifyPackage(pkg, key) for real check
      size:         JSON.stringify(pkg).length
    };
  }

  return {
    validateManifest, createPackage, signPackage, verifyPackage,
    installPackage, uninstallPackage, extractPackage, inspectPackage,
    NOVAAPP_FORMAT_VERSION
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AppPackage;