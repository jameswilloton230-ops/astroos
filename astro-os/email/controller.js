'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');

// Import modules
const { encryptCreds, decryptCreds, sessionCredentials, restoreCredsFromSession, requireCreds } = require('./credentials');
const imapClient = require('./protocols/imapClient');
const pop3Client = require('./protocols/pop3Client');
const ewsClient = require('./protocols/ewsClient');
const { msgShape, rewriteEmailImages, sanitizeEmailHtml } = require('./helpers');

// Optional dependencies
let nodemailer, ImapFlow, POP3Client, PostalMime;
try { ({ ImapFlow } = require('imapflow')); } catch (e) { ImapFlow = null; }
try { POP3Client = require('node-pop3'); } catch (e) { POP3Client = null; }
try { PostalMime = require('postal-mime'); } catch (e) { PostalMime = null; }
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

// Initialize client modules with optional dependencies
imapClient.setDependencies({ ImapFlow, PostalMime });
pop3Client.setDependencies({ POP3Client, PostalMime });
ewsClient.setDependencies({ PostalMime });

// ── Preview cache ──────────────────────────────────────────────────────────────
const previewCache = new Map();
const PREVIEW_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanPreviewCache() {
  const cutoff = Date.now() - PREVIEW_CACHE_TTL;
  for (const [token, entry] of previewCache.entries()) {
    if (entry.ts < cutoff) previewCache.delete(token);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/email/csrf-token
 */
router.get('/csrf-token', (req, res) => {
  try {
    const token = req.session?.csrfToken || res.locals.csrfToken || null;
    res.json({ ok: true, csrfToken: token });
  } catch (err) {
    res.status(500).json({ ok: false, csrfToken: null, error: err.message });
  }
});

/**
 * GET /api/email/restore
 */
router.get('/restore', (req, res) => {
  try {
    if (req.session?.id && sessionCredentials.has(req.session.id)) {
      const entry = sessionCredentials.get(req.session.id);
      if (entry?.creds) {
        const creds = entry.creds;
        req.emailCreds = creds;
        return res.json({ ok: true, restored: true, type: creds.type, host: creds.host, user: creds.user });
      }
    }

    if (req.session?.emailCredsEncrypted) {
      try {
        const creds = decryptCreds(req.session.emailCredsEncrypted);
        req.emailCreds = creds;
        if (req.session.id) {
          sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
        }
        return res.json({ ok: true, restored: true, type: creds.type, host: creds.host, user: creds.user });
      } catch (e) {
        console.warn('[Email] Failed to decrypt restored credentials:', e.message);
      }
    }

    res.json({ ok: true, restored: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/email/startup
 */
router.get('/startup', async (req, res) => {
  try {
    if (!req.emailCreds && req.session?.emailCredsEncrypted) {
      try {
        const creds = decryptCreds(req.session.emailCredsEncrypted);
        req.emailCreds = creds;
        if (req.session.id) {
          sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
        }
      } catch (e) {
        console.warn('[Email] Startup restore failed:', e.message);
      }
    }

    const restored = Boolean(req.emailCreds);
    res.json({ ok: true, restored, autoSyncEnabled: restored });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/email/connect
 */
router.post('/connect', async (req, res) => {
  const { type, host, port, ssl, user, pass } = req.body;
  if (!type || !host || !user || !pass) {
    return res.status(400).json({ error: 'type, host, user and pass are required' });
  }
  const creds = { type, host, port, ssl: ssl === true || ssl === 'true' || ssl === 1, user, pass };
  try {
    let folders;
    if (type === 'imap') folders = await imapClient.imapFolders(creds);
    else if (type === 'pop3') folders = [{ path: 'INBOX', name: 'Inbox' }];
    else if (type === 'exchange') folders = await ewsClient.ewsFolders(creds);
    else return res.status(400).json({ error: 'type must be imap, pop3, or exchange' });

    // Plaintext creds intentionally NOT written to req.session — only the
    // encrypted blob is durable. requireCreds derives req.emailCreds fresh
    // from emailCredsEncrypted on each request, so it never round-trips
    // through the session store (and therefore never lands on disk).
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

    res.json({ ok: true, type, user, host, folders });
  } catch (err) {
    console.error('[Email] connect:', err.message);
    res.status(400).json({ error: err.message || 'Connection failed' });
  }
});

/**
 * GET /api/email/folders
 */
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

/**
 * GET /api/email/messages?folder=INBOX&page=1&limit=20
 */
router.get('/messages', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const folder = req.query.folder || 'INBOX';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
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

/**
 * GET /api/email/message?folder=INBOX&uid=123
 */
router.get('/message', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const { folder = 'INBOX', uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid is required' });
  try {
    let msg;
    if (c.type === 'imap') msg = await imapClient.imapMessage(c, folder, uid, msgShape);
    else if (c.type === 'pop3') msg = await pop3Client.pop3Message(c, uid, msgShape);
    else msg = await ewsClient.ewsMessage(c, uid, msgShape);
    if (msg.html) {
      msg.html = sanitizeEmailHtml(rewriteEmailImages(msg.html));
    }
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/disconnect
 */
router.post('/disconnect', (req, res) => {
  delete req.session.emailCredsEncrypted;
  
  if (req.session?.id) {
    sessionCredentials.delete(req.session.id);
  }
  
  res.json({ ok: true });
});

/**
 * POST /api/email/batch
 */
router.post('/batch', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const { op, uids = [], folder = 'INBOX', dest } = req.body;
  if (!uids.length) return res.json({ ok: true });
  try {
    if (c.type === 'imap') {
      await imapClient.imapBatch(c, op, uids, folder, dest);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/send
 */
router.post('/send', requireCreds, async (req, res) => {
  if (!nodemailer) return res.status(500).json({ error: 'Missing dependency: run "npm install nodemailer"' });
  const sess = req.emailCreds;
  const smtpHost = req.body.host || sess.smtpHost || sess.host;
  const smtpPort = parseInt(req.body.port) || sess.smtpPort || 587;
  const useDirectSsl = smtpPort === 465;
  const user = req.body.user || sess.user;
  const pass = req.body.pass || sess.pass;
  if (!smtpHost) return res.status(400).json({ error: 'No SMTP host configured for this account' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort,
      secure: useDirectSsl,
      requireTLS: !useDirectSsl,
      auth: { user, pass }, tls: { rejectUnauthorized: true }
    });
    const { to, cc, bcc, subject, text, body, html } = req.body;
    if (!to) return res.status(400).json({ error: 'No recipients defined' });
    const info = await transporter.sendMail({
      from: user, to, cc: cc || undefined, bcc: bcc || undefined, subject,
      text: text || body || '', html: html || undefined
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/email/search
 */
router.get('/search', requireCreds, async (req, res) => {
  const c = req.emailCreds;
  const q = (req.query.q || '').trim();
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

/**
 * POST /api/email/preview
 */
router.post('/preview', requireCreds, (req, res) => {
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });

  const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
  if (html.length > MAX_PREVIEW_BYTES) {
    return res.status(413).json({ error: 'Email HTML exceeds 2MB limit' });
  }

  cleanPreviewCache();
  const token = crypto.randomBytes(24).toString('hex');
  const safeHtml = sanitizeEmailHtml(rewriteEmailImages(html));
  previewCache.set(token, { html: safeHtml, ts: Date.now() });

  if (req.session) {
    if (!req.session.emailPreviewTokens) req.session.emailPreviewTokens = [];
    req.session.emailPreviewTokens.push(token);
    if (req.session.emailPreviewTokens.length > 10) {
      req.session.emailPreviewTokens = req.session.emailPreviewTokens.slice(-10);
    }
  }

  res.json({ token });
});

/**
 * GET /api/email/preview/:token
 */
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