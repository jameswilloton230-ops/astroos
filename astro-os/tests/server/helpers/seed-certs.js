import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const x509 = require('@peculiar/x509');
const { toPem } = require('../../../scripts/utils.js');

export async function seedCerts(dir) {
  x509.cryptoProvider.set(x509.CryptoProvider.DEFAULT, crypto.webcrypto);
  const keyParams = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  };
  const notBefore = new Date();
  const notAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const signingAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

  const caKeys = await crypto.subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomBytes(8).toString('hex'),
    name: 'CN=Test CA',
    notBefore,
    notAfter,
    signingAlgorithm,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const serverKeys = await crypto.subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const serverCert = await x509.X509CertificateGenerator.create({
    serialNumber: crypto.randomBytes(8).toString('hex'),
    subject: 'CN=localhost',
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm,
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
      ),
    ],
  });

  const [caKey, serverKey] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', caKeys.privateKey),
    crypto.subtle.exportKey('pkcs8', serverKeys.privateKey),
  ]);
  const files = {
    'ca.key': toPem(caKey, 'PRIVATE KEY'),
    'ca.crt': caCert.toString('pem'),
    'cert.key': toPem(serverKey, 'PRIVATE KEY'),
    'cert.crt': serverCert.toString('pem'),
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      fs.writeFile(path.join(dir, name), contents),
    ),
  );
}
