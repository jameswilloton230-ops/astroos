'use strict';

/**
 * NBOSP Email Routes
 * Handles IMAP, POP3, and Microsoft Exchange (EWS) connections.
 * Credentials are stored in the Express session after a successful connect —
 * the password is never sent again after the initial POST /connect.
 *
 * Routes:
 *   GET  /api/email/csrf-token    — fetch a fresh CSRF token (call on app init / relaunch)
 *   POST /api/email/connect       — connect and store creds in session
 *   GET  /api/email/folders       — list folders / mailboxes
 *   GET  /api/email/messages      — list messages (?folder=&page=&limit=)
 *   GET  /api/email/message       — fetch a single message (?folder=&uid=)
 *   POST /api/email/disconnect    — clear session credentials
 */

const controller = require('./controller');

module.exports = controller;
