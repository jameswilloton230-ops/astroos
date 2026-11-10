'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRuntimeDataDir } = require('./runtime-data-dir');

// Absolute paths bypass NW.js wrapResolveFilename hook from subdirectories
const _appDir = path.resolve(__dirname, '..');
require(path.join(_appDir, 'node_modules', 'reflect-metadata'));
const x509 = require(path.join(_appDir, 'node_modules', '@peculiar', 'x509'));

const { toPem }          = require('./utils');
const { installCaTrust } = require('./ca-trust');

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

function randomSerial() {
  return crypto.randomBytes(8).toString('hex');
}

// A hard reset mid-write leaves empty or truncated files that still "exist",
// and ssl.js then dies with "PEM routines: no start line" on every boot.
// Parse everything and check the pieces belong together.
async function certFilesAreValid(paths) {
  try {
    const [caKeyPem, caCrtPem, keyPem, crtPem] = await Promise.all(
      [paths.CA_KEY, paths.CA_CRT, paths.CERT_KEY, paths.CERT_CRT]
        .map(f => fs.promises.readFile(f, 'utf8'))
    );
    const caCert     = new crypto.X509Certificate(caCrtPem);
    const serverCert = new crypto.X509Certificate(crtPem);
    return caCert.checkPrivateKey(crypto.createPrivateKey(caKeyPem))
      && serverCert.checkPrivateKey(crypto.createPrivateKey(keyPem))
      && serverCert.verify(caCert.publicKey);
  } catch (_) {
    return false;
  }
}

async function certsAreFresh(paths) {
  try {
    await Promise.all(
      [paths.CA_KEY, paths.CA_CRT, paths.CERT_KEY, paths.CERT_CRT].map(f => fs.promises.access(f))
    );
    const stat = await fs.promises.stat(paths.CERT_CRT);
    if ((Date.now() - stat.mtimeMs) >= CERT_MAX_AGE_MS) return false;
    return await certFilesAreValid(paths);
  } catch (_) {
    return false;
  }
}

// temp file + rename, so a reset leaves the old file or the new one, never half of it
async function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.promises.open(tmp, 'w', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
}

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

  // CA key pair and self-signed CA certificate
  const caKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name:         'CN=NovaByte Local CA',
    notBefore, notAfter,
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  // Server key pair and certificate signed by CA
  const serverKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const serverCert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
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

async function stripSpkiFromPackageJson(appDir) {
  try {
    const pkgPath = path.join(appDir, 'package.json');
    const parsed  = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    if (!parsed.window) return;

    const args    = parsed.window['chromium-args'] || '';
    const cleaned = args
      .replace(/--ignore-certificate-errors(?!-spki)\s*/g, '')
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

/**
 * Ensure certs exist and are fresh, generate them if not, and install the CA
 * into the OS trust store if needed.
 *
 * @param {string} appDir
 * @returns {Promise<boolean>}
 */
async function ensureCerts(appDir, trustInstaller = installCaTrust) {
  const dataDir = getRuntimeDataDir(appDir);
  const paths   = certPaths(dataDir);
  const fresh   = await certsAreFresh(paths);
  let   trusted = false;

  try {
    await fs.promises.access(paths.CA_TRUSTED_FLAG);
    trusted = true;
  } catch (_) {}

  if (fresh && trusted && process.platform !== 'linux') {
    console.log('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
    await stripSpkiFromPackageJson(appDir);
    return true;
  }

  if (!fresh) {
    console.log('[NovaByte] Generating CA and server certificate...');
    try {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const { caCertPem, caKeyPem, serverCertPem, serverKeyPem } = await generateCerts();

      await Promise.all([
        writeFileAtomic(paths.CA_CRT,   caCertPem,     0o644),
        writeFileAtomic(paths.CA_KEY,   caKeyPem,      0o600),
        writeFileAtomic(paths.CERT_CRT, serverCertPem, 0o644),
        writeFileAtomic(paths.CERT_KEY, serverKeyPem,  0o600),
      ]);

      try {
        await fs.promises.unlink(paths.CA_TRUSTED_FLAG);
      } catch (_) {}

      console.log('[NovaByte] Certificates generated.');
    } catch (err) {
      console.error('[NovaByte] Certificate generation failed:', err.message);
      return false;
    }
  }

  console.log('[NovaByte] Installing CA into OS trust store...');
  const ok = trustInstaller(paths.CA_CRT);

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