'use strict';

/**
 * Encode a DER buffer as a PEM string.
 * Uses string slicing to eliminate temporary array allocations.
 *
 * @param {ArrayBuffer|Buffer} der
 * @param {string} type
 * @returns {string}
 */
function toPem(der, type) {
  const cleanType = String(type || 'CERTIFICATE').replace(/[\r\n]/g, '').trim();
  const b64 = Buffer.from(der).toString('base64');

  let pem = `-----BEGIN ${cleanType}-----\n`;
  for (let i = 0; i < b64.length; i += 64) {
    pem += b64.slice(i, i + 64) + '\n';
  }
  pem += `-----END ${cleanType}-----\n`;

  return pem;
}

module.exports = { toPem };