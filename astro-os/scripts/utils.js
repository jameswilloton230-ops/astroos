'use strict';

/**
 * Encode a DER buffer as a PEM string.
 * Loop-based to avoid the overhead of .match(/.{1,64}/g) on large buffers.
 *
 * @param {ArrayBuffer|Buffer} der
 * @param {string} type  e.g. 'PRIVATE KEY', 'CERTIFICATE'
 * @returns {string}
 */
function toPem(der, type) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

module.exports = { toPem };
