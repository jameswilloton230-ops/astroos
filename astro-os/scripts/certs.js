'use strict';

const fs   = require('fs');
const path = require('path');

// NW.js's wrapResolveFilename hook breaks named require() from subdirectories.
// Absolute paths bypass it — Node loads the file directly without NW.js's hook.
const _appDir = path.resolve(__dirname, '..');  // NBOSP/ from scripts/
require(path.join(_appDir, 'node_modules', 'reflect-metadata'));
const x509 = require(path.join(_appDir, 'node_modules', '@peculiar', 'x509'));

const crypto = require('crypto');

const { toPem }        = require('./utils');
const { installCaTrust } = require('./ca-trust');

// ── Constants ─────────────────────────────────────────────────────────────────

const CERT_MAX_AGE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

function certPaths(appDir) {
  return {
    CA_KEY:          path.join(appDir, 'ca.key'),
    CA_CRT:          path.join(appDir, 'ca.crt'),
    CERT_KEY:        path.join(appDir, 'cert.key'),
    CERT_CRT:        path.join(appDir, 'cert.crt'),
    CA_TRUSTED_FLAG: path.join(appDir, 'ca.trusted'),
  };
}

// ── Freshness check ───────────────────────────────────────────────────────────

async function certsAreFresh(paths) {
  try {
    await Promise.all(
      [paths.CA_KEY, paths.CA_CRT, paths.CERT_KEY, paths.CERT_CRT].map(f => fs.promises.access(f))
    );
    const stat = await fs.promises.stat(paths.CERT_CRT);
    return (Date.now() - stat.mtimeMs) < CERT_MAX_AGE_MS;
  } catch (_) { return false; }
}

// ── Certificate generation ────────────────────────────────────────────────────

async function generateCerts() {
  const subtle    = crypto.subtle;
  const keyParams = {
    name:           'RSASSA-PKCS1-v1_5',
    modulusLength:  2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash:           'SHA-256',
  };
  const notBefore = new Date();
  const notAfter  = new Date(Date.now() + CERT_MAX_AGE_MS);

  // 1. CA key pair + self-signed CA cert
  const caKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name:         'CN=NovaByte Local CA',
    notBefore, notAfter,
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  // 2. Server key pair + cert signed by CA
  const serverKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const serverCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject:      'CN=localhost',
    issuer:       caCert.subject,
    notBefore, notAfter,
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    publicKey:   serverKeys.publicKey,
    signingKey:  caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip',  value: '127.0.0.1' },
      ]),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
      ),
    ],
  });

  // 3. Export to PEM
  const [caKeyDer, serverKeyDer] = await Promise.all([
    subtle.exportKey('pkcs8', caKeys.privateKey),
    subtle.exportKey('pkcs8', serverKeys.privateKey),
  ]);

  return {
    caCertPem:     caCert.toString('pem'),
    caKeyPem:      toPem(caKeyDer,     'PRIVATE KEY'),
    serverCertPem: serverCert.toString('pem'),
    serverKeyPem:  toPem(serverKeyDer, 'PRIVATE KEY'),
  };
}

// ── package.json cleanup ──────────────────────────────────────────────────────

async function stripSpkiFromPackageJson(appDir) {
  try {
    const pkgPath = path.join(appDir, 'package.json');
    const parsed  = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    if (!parsed.window) return;

    const args    = parsed.window['chromium-args'] || '';
    const cleaned = args
      .replace(/--ignore-certificate-errors(?!-spki)\s*/g, '')
      .replace(/--allow-insecure-localhost\s*/g, '')
      .replace(/--ignore-certificate-errors-spki-list=\S*\s*/g, '')
      .trim();

    if (cleaned !== args) {
      parsed.window['chromium-args'] = cleaned;
      await fs.promises.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log('[NovaByte] Cleaned stale SPKI flags from package.json.');
    }
  } catch (e) {
    console.error('[NovaByte] Failed to clean package.json:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure certs exist and are fresh, generate them if not, and install the CA
 * into the OS trust store if needed.
 *
 * @param {string} appDir
 * @returns {Promise<boolean>} true if HTTPS is ready, false if falling back to HTTP
 */
async function ensureCerts(appDir) {
  const paths   = certPaths(appDir);
  const fresh   = await certsAreFresh(paths);
  let   trusted = false;
  try { await fs.promises.access(paths.CA_TRUSTED_FLAG); trusted = true; } catch (_) {}

  if (fresh && trusted) {
    console.log('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
    await stripSpkiFromPackageJson(appDir);
    return true;
  }

  if (!fresh) {
    console.log('[NovaByte] Generating CA and server certificate...');
    try {
      const { caCertPem, caKeyPem, serverCertPem, serverKeyPem } = await generateCerts();

      // Write all four files in parallel
      await Promise.all([
        fs.promises.writeFile(paths.CA_CRT,   caCertPem,     { encoding: 'utf8', mode: 0o644 }),
        fs.promises.writeFile(paths.CA_KEY,   caKeyPem,      { encoding: 'utf8', mode: 0o600 }),
        fs.promises.writeFile(paths.CERT_CRT, serverCertPem, { encoding: 'utf8', mode: 0o644 }),
        fs.promises.writeFile(paths.CERT_KEY, serverKeyPem,  { encoding: 'utf8', mode: 0o600 }),
      ]);

      // New CA → invalidate trust flag so we re-install below
      try { await fs.promises.unlink(paths.CA_TRUSTED_FLAG); } catch (_) {}
      console.log('[NovaByte] Certificates generated.');
    } catch (err) {
      console.error('[NovaByte] Certificate generation failed:', err.message);
      return false;
    }
  }

  console.log('[NovaByte] Installing CA into OS trust store...');
  const ok = installCaTrust(paths.CA_CRT);

  if (ok) {
    await fs.promises.writeFile(paths.CA_TRUSTED_FLAG, new Date().toISOString(), 'utf8');
    console.log('[NovaByte] CA trusted. HTTPS will work natively from now on.');
    await stripSpkiFromPackageJson(appDir);
    return true;
  }

  console.warn('[NovaByte] CA trust install failed — falling back to HTTP.');
  return false;
}

module.exports = { ensureCerts };