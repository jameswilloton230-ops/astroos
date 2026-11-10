'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');

// ── Plain-HTTP request on the HTTPS port ────────────────────────────────────
//
// The server is TLS-only (there is no plain-HTTP listener anywhere — this
// file throws without certs and always creates an https.Server). When a
// browser follows a link registered with an `http://` scheme — the classic
// case being an OAuth/redirect callback URL like
// `http://localhost:3003/api/apps/serve/sandbox_<appId>/callback.html` — the
// plaintext request bytes hit a TLS socket, the handshake fails, and Node's
// DEFAULT behavior is to destroy the connection without writing anything.
// The browser then reports ERR_EMPTY_RESPONSE ("localhost didn't send any
// data"), which names neither the cause nor the fix.
//
// Answer that one case with an explicit plaintext 400 instead — the same
// thing nginx has always done ("The plain HTTP request was sent to HTTPS
// port"). Browsers render the body, so a developer following a broken
// callback URL sees WHY it failed instead of a cryptic empty reply. Every
// other TLS handshake failure keeps Node's silent default.
//
// The response is written to the RAW socket (tlsSocket._parent): the TLS
// layer already gave up on this connection, so anything written through the
// TLSSocket would be discarded. `_parent` is how the wrapped socket is
// reached in practice; every access is guarded and any unexpected shape
// falls back to the previous destroy-without-response behavior.

const PLAIN_HTTP_RESPONSE_BODY = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><title>NovaByte OS — HTTPS required</title></head>',
  '<body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">',
  '<div style="max-width:560px;padding:24px">',
  '<h1 style="font-size:20px">HTTPS required</h1>',
  '<p>This NovaByte OS server only accepts HTTPS connections on this port. ',
  'The request arrived as plain <code>http://</code>.</p>',
  '<p>If this came from an OAuth or redirect callback, the callback URL was registered with the wrong scheme: ',
  're-register it as <code>https://localhost:3003/&#8230;</code> with the provider, update the app bundle to match, and start the flow again.</p>',
  '</div></body></html>',
].join('\n');

function buildPlainHttpResponse() {
  return [
    'HTTP/1.1 400 Bad Request',
    'Content-Type: text/html; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(PLAIN_HTTP_RESPONSE_BODY)}`,
    'Connection: close',
    '',
    PLAIN_HTTP_RESPONSE_BODY,
  ].join('\r\n');
}

// Node has exposed ERR_SSL_HTTP_REQUEST for "HTTP request on a TLS port"
// since the dedicated record-header check landed; older builds surface the
// same condition only through the openssl message text. Match both, and
// nothing else — every other handshake failure must keep the default
// silent-destroy behavior (scanners and probes get no free response).
function isPlainHttpRequestToTlsPort(err) {
  if (!err) return false;
  if (err.code === 'ERR_SSL_HTTP_REQUEST') return true;
  return /tls_validate_record_header:http req/i.test(String(err.message || ''));
}

function respondPlainHttpOverRawSocket(socket) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  // The client may reset while we are flushing; without this, the write
  // surfaces as an unhandled ECONNRESET.
  socket.on('error', () => {});
  socket.end(buildPlainHttpResponse());
  // end() flushes and FINs, but destroy as a backstop in case the client
  // never closes its side (keeps the FD table clean under repeated probes).
  const backstop = setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 1000);
  if (typeof backstop.unref === 'function') backstop.unref();
  return true;
}

function configureSSL(app) {
  const dataDir = process.env.NBOSP_DATA_DIR || path.resolve(__dirname, '..', '..');
  const keyPath  = path.join(dataDir, 'cert.key');
  const certPath = path.join(dataDir, 'cert.crt');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    throw new Error(
      `[SSL Core] Cannot start server without TLS: cert.key or cert.crt missing.\n` +
      `Expected at:\n  ${keyPath}\n  ${certPath}\n`
    );
  }

  const httpsOptions = {
    key:           fs.readFileSync(keyPath),
    cert:          fs.readFileSync(certPath),
    ALPNProtocols: ['http/1.1'],
  };

  const server = https.createServer(httpsOptions, app);

  // Plain HTTP on the HTTPS port — see the block comment above. Everything
  // else (bad certs, protocol junk, truncated handshakes) still gets Node's
  // default destroy-without-response.
  server.on('tlsClientError', (err, tlsSocket) => {
    if (!isPlainHttpRequestToTlsPort(err)) return;
    const raw = tlsSocket && tlsSocket._parent;
    if (!respondPlainHttpOverRawSocket(raw)) {
      try { if (tlsSocket && typeof tlsSocket.destroy === 'function') tlsSocket.destroy(); } catch (_) {}
    }
  });

  console.log('[SSL Core] Secure HTTPS Server initialized successfully.');

  return { server };
}

module.exports = {
  configureSSL,
  isPlainHttpRequestToTlsPort,
  respondPlainHttpOverRawSocket,
};
