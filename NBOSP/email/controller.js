'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { encryptCreds, decryptCreds, sessionCredentials, requireCreds } = require('./credentials');
const imapClient = require('./protocols/imapClient');
const pop3Client = require('./protocols/pop3Client');
const ewsClient = require('./protocols/ewsClient');
const { msgShape, sanitizeEmailHtml } = require('./helpers');
const ServerEventLog = require('../server/core/server-event-log');

let nodemailer, ImapFlow, PostalMime, multer;
try { ({ ImapFlow } = require('imapflow')); } catch { ImapFlow = null; }
// postal-mime ships the class as the CommonJS module.exports itself (with a
// .default mirror on the ESM build) — there is NO named `PostalMime` export.
// Destructuring `const { PostalMime } = require('postal-mime')` therefore
// yielded undefined, which silently disabled IMAP/POP3/EWS full-message
// fetching (lists still worked off ENVELOPE, so subjects rendered while the
// reader failed with "Missing dependency: npm install postal-mime").
try {
  const postalMimeModule = require('postal-mime');
  PostalMime = postalMimeModule?.PostalMime || postalMimeModule?.default
    || (typeof postalMimeModule === 'function' ? postalMimeModule : null);
} catch { PostalMime = null; }
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
try { multer = require('multer'); } catch { multer = null; }

// Attachments are held in memory only (not written to disk) and handed
// straight to nodemailer as Buffers — this process already treats mail
// bodies as ephemeral per-request data, so attachments follow the same
// lifecycle rather than introducing a temp-file cleanup problem.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB total, matches common provider limits
const upload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 },
    })
  : null;
// No-op passthrough when multer isn't installed, so the route can still
// give a clear "missing dependency" error instead of crashing on
// undefined.single/.array at require time.
const uploadAttachments = upload ? upload.array('attachments', 10) : (req, res, next) => next();

imapClient.setDependencies({ ImapFlow, PostalMime });
pop3Client.setDependencies({ PostalMime });
ewsClient.setDependencies({ PostalMime });

// preview cache configuration and eviction
const previewCache = new Map();
const PREVIEW_CACHE_TTL = 5 * 60 * 1000;
const MAX_PREVIEW_CACHE_SIZE = 100;

function cleanPreviewCache() {
  const cutoff = Date.now() - PREVIEW_CACHE_TTL;
  for (const [token, entry] of previewCache.entries()) {
    if (entry.ts < cutoff) previewCache.delete(token);
  }
  while (previewCache.size > MAX_PREVIEW_CACHE_SIZE) {
    const oldestKey = previewCache.keys().next().value;
    previewCache.delete(oldestKey);
  }
}

// helper to restore email credentials from active session or encrypted payload
function tryRestoreCreds(req) {
  if (req.emailCreds) return true;

  if (req.session?.id && sessionCredentials.has(req.session.id)) {
    const entry = sessionCredentials.get(req.session.id);
    if (entry?.creds) {
      req.emailCreds = entry.creds;
      return true;
    }
  }

  if (req.session?.emailCredsEncrypted) {
    try {
      const creds = decryptCreds(req.session.emailCredsEncrypted);
      req.emailCreds = creds;
      if (req.session.id) {
        sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
      }
      return true;
    } catch (e) {
      console.warn('[Email] Failed to decrypt restored credentials:', e.message);
    }
  }

  return false;
}

// routes

router.get('/csrf-token', (req, res) => {
  try {
    const token = req.session?.csrfToken || res.locals.csrfToken || null;
    res.json({ ok: true, csrfToken: token });
  } catch (err) {
    res.status(500).json({ ok: false, csrfToken: null, error: err.message });
  }
});

router.get('/restore', (req, res) => {
  try {
    const restored = tryRestoreCreds(req);
    if (restored && req.emailCreds) {
      const { type, host, user } = req.emailCreds;
      return res.json({ ok: true, restored: true, type, host, user });
    }
    res.json({ ok: true, restored: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/startup', (req, res) => {
  try {
    const restored = tryRestoreCreds(req);
    res.json({ ok: true, restored, autoSyncEnabled: restored });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/connect', async (req, res) => {
  const { type, host, port, ssl, user, pass } = req.body || {};
  if (!type || !host || !user || !pass) {
    return res.status(400).json({ error: 'type, host, user and pass are required' });
  }

  const cleanType = String(type).trim().toLowerCase();
  // Default to TLS on. Previously this defaulted to false, so a request
  // that simply didn't include `ssl` (rather than actively opting out)
  // would silently connect in plaintext. TLS is now mandatory for every
  // protocol client (see imapClient/pop3Client/ewsClient), so an explicit
  // opt-out is rejected here with a clear message instead of failing
  // deeper in the stack.
  const sslRequested = ssl === undefined ? true : (ssl === true || ssl === 'true' || ssl === 1);
  if (!sslRequested) {
    return res.status(400).json({ error: 'Plaintext connections are not supported — TLS/SSL is required for all mail protocols' });
  }
  const creds = {
    type: cleanType,
    host: String(host).trim(),
    port: parseInt(port, 10) || undefined,
    ssl: true,
    user: String(user).trim(),
    pass: String(pass)
  };

  try {
    let folders;
    if (cleanType === 'imap') folders = await imapClient.imapFolders(creds);
    else if (cleanType === 'pop3') folders = [{ path: 'INBOX', name: 'Inbox' }];
    else if (cleanType === 'exchange') folders = await ewsClient.ewsFolders(creds);
    else return res.status(400).json({ error: 'type must be imap, pop3, or exchange' });

    req.emailCreds = creds;

    if (req.session?.id) {
      try {
        const encrypted = encryptCreds(creds);
        req.session.emailCredsEncrypted = encrypted;
        sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
      } catch (e) {
        console.warn('[Email] Failed to persist credentials:', e.message);
      }
    }

    ServerEventLog.log({
      app: 'EmailController',
      severity: 'info',
      message: `Connected ${cleanType} account (${creds.host})`,
      data: { type: cleanType, host: creds.host, user: creds.user },
    });

    res.json({ ok: true, type: cleanType, user: creds.user, host: creds.host, folders });
  } catch (err) {
    console.error('[Email] connect:', err.message);
    ServerEventLog.log({
      app: 'EmailController',
      severity: 'error',
      message: `Connect failed (${cleanType} ${creds.host}): ${err.message}`,
      data: { type: cleanType, host: creds.host, user: creds.user, error: err.message },
    });
    res.status(400).json({ error: err.message || 'Connection failed' });
  }
});

router.get('/folders', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  try {
    let folders;
    if (c.type === 'imap') folders = await imapClient.imapFolders(c);
    else if (c.type === 'pop3') folders = [{ path: 'INBOX', name: 'Inbox' }];
    else folders = await ewsClient.ewsFolders(c);
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/messages', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const folder = req.query.folder || 'INBOX';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 20));

  try {
    let result;
    if (c.type === 'imap') result = await imapClient.imapMessages(c, folder, page, limit, msgShape);
    else if (c.type === 'pop3') result = await pop3Client.pop3Messages(c, limit, msgShape);
    else result = await ewsClient.ewsMessages(c, folder, page, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/message', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const { folder = 'INBOX', uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  try {
    let msg;
    if (c.type === 'imap') msg = await imapClient.imapMessage(c, folder, uid, msgShape);
    else if (c.type === 'pop3') msg = await pop3Client.pop3Message(c, uid, msgShape);
    else msg = await ewsClient.ewsMessage(c, uid, msgShape);

    if (msg && msg.html) {
      msg.html = sanitizeEmailHtml(msg.html);
    }
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', (req, res) => {
  if (req.session) {
    delete req.session.emailCredsEncrypted;
    if (req.session.id) sessionCredentials.delete(req.session.id);
  }

  ServerEventLog.log({
    app: 'EmailController',
    severity: 'info',
    message: 'Disconnected email account',
  });

  res.json({ ok: true });
});

router.post('/batch', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const { op, uids = [], folder = 'INBOX', dest } = req.body || {};
  if (!Array.isArray(uids) || !uids.length) return res.json({ ok: true });
  if (!['read', 'delete', 'move'].includes(op)) {
    return res.status(400).json({ error: 'Unsupported batch operation' });
  }

  try {
    if (c.type === 'imap') {
      await imapClient.imapBatch(c, op, uids, folder, dest);
    } else if (c.type === 'exchange' && op === 'read') {
      await ewsClient.ewsMarkRead(c, uids);
    } else {
      return res.status(400).json({ error: `Batch ${op} is not supported for ${c.type} accounts` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send', requireCreds, uploadAttachments, async (req, res) => {
  if (!nodemailer) {
    return res.status(500).json({ error: 'Missing dependency: run "npm install nodemailer"' });
  }
  if (!multer) {
    // Attachments silently wouldn't be parsed without multer — if the
    // request actually carries files, fail loudly instead of sending a
    // mail that's missing what the user attached.
    if ((req.headers['content-type'] || '').startsWith('multipart/')) {
      return res.status(500).json({ error: 'Missing dependency: run "npm install multer" to send attachments' });
    }
  }

  // sess is guaranteed non-null by requireCreds, but it can legitimately
  // be a sparse object (e.g. an IMAP-only account that was never given a
  // separate SMTP host) — optional-chain every field read from it so a
  // thin session degrades to the 400 below instead of throwing a 500.
  const sess = req.emailCreds;
  const smtpHost = req.body.host || sess?.smtpHost || sess?.host;
  const smtpPort = parseInt(req.body.port, 10) || sess?.smtpPort || 587;
  const useDirectSsl = smtpPort === 465;
  const user = req.body.user || sess?.user;
  const pass = req.body.pass || sess?.pass;

  if (!smtpHost) return res.status(400).json({ error: 'No SMTP host configured for this account' });

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: useDirectSsl,
      requireTLS: !useDirectSsl,
      auth: { user, pass },
      tls: { rejectUnauthorized: true }
    });

    const { to, cc, bcc, subject, text, body, html } = req.body || {};
    if (!to) return res.status(400).json({ error: 'No recipients defined' });

    // Multipart uploads keep the original path for browser clients. Packaged
    // NovaApps use the authenticated host IPC bridge, which serializes small
    // attachments as base64 JSON so credentials and files never cross into an
    // unrestricted renderer fetch path. The same 25MB total / 10-file limit is
    // enforced for both representations.
    const multipartAttachments = (req.files || []).map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype || 'application/octet-stream',
    }));
    let jsonAttachments = [];
    if (Array.isArray(req.body?.attachments)) {
      const total = req.body.attachments.reduce((sum, a) => {
        try { return sum + Buffer.byteLength(String(a?.contentBase64 || ''), 'base64'); } catch { return sum; }
      }, 0);
      if (req.body.attachments.length > 10 || total > MAX_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: 'Attachment limit exceeded (max 10 files / 25MB total)' });
      }
      try {
        jsonAttachments = req.body.attachments.map(a => ({
          filename: String(a?.filename || 'attachment'),
          content: Buffer.from(String(a?.contentBase64 || ''), 'base64'),
          contentType: String(a?.contentType || 'application/octet-stream'),
        }));
      } catch {
        return res.status(400).json({ error: 'Invalid attachment encoding' });
      }
    }
    const attachments = multipartAttachments.length ? multipartAttachments : jsonAttachments;

    const info = await transporter.sendMail({
      from: user,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject,
      text: text || body || '',
      html: html || undefined,
      attachments: attachments.length ? attachments : undefined,
    });

    ServerEventLog.log({
      app: 'EmailController',
      severity: 'info',
      message: 'Sent message via SMTP',
      data: { smtpHost, recipientCount: [to, cc, bcc].filter(Boolean).length, attachmentCount: attachments.length },
    });

    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    ServerEventLog.log({
      app: 'EmailController',
      severity: 'error',
      message: `Send failed: ${err.message}`,
      data: { smtpHost },
    });
    res.status(500).json({ error: err.message });
  }
});

router.get('/search', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const q = String(req.query.q || '').trim();
  const folder = req.query.folder || 'INBOX';

  if (!q) return res.json({ messages: [] });
  if (c.type !== 'imap') return res.status(400).json({ error: 'Search is only supported for IMAP accounts' });

  try {
    const messages = await imapClient.imapSearch(c, q, folder);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/preview', requireCreds, (req, res) => {
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });

  const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
  if (Buffer.byteLength(html, 'utf8') > MAX_PREVIEW_BYTES) {
    return res.status(413).json({ error: 'Email HTML exceeds 2MB limit' });
  }

  cleanPreviewCache();
  const token = crypto.randomBytes(24).toString('hex');
  const safeHtml = sanitizeEmailHtml(html);
  previewCache.set(token, { html: safeHtml, ts: Date.now() });

  if (req.session) {
    if (!Array.isArray(req.session.emailPreviewTokens)) {
      req.session.emailPreviewTokens = [];
    }
    req.session.emailPreviewTokens.push(token);
    if (req.session.emailPreviewTokens.length > 10) {
      req.session.emailPreviewTokens = req.session.emailPreviewTokens.slice(-10);
    }
  }

  res.json({ token });
});

router.get('/preview/:token', (req, res) => {
  const token = req.params.token;
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return res.status(400).send('Invalid token.');
  }

  const entry = previewCache.get(token);
  if (!entry) return res.status(404).send('Preview expired or not found. Please reopen the email.');

  const html = entry.html;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const trimmed = html.trimStart();
  const hasFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);

  if (hasFullDoc) {
    res.send(trimmed);
  } else {
    res.send(
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<style>*{box-sizing:border-box}body{margin:0;padding:0;word-wrap:break-word;-webkit-text-size-adjust:100%}</style>' +
      '</head><body>' + trimmed + '</body></html>'
    );
  }
});

module.exports = router;

// Test-only access to the resolved protocol dependencies. The postal-mime
// export shape changed in v4 (class on module.exports, no named export) —
// this lets the suite assert the resolution logic stays working without
// standing up a real IMAP/POP3/EWS server.
module.exports._internal = {
  getPostalMime: () => PostalMime,
  getImapFlow: () => ImapFlow,
};