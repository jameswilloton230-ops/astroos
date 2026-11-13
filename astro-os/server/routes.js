'use strict';

const securityRoutes        = require('../security/routes');
const authRoutes           = require('./security/auth-routes');
const emailRoutes           = require('../email/index');
const { setupEventsRoutes } = require('./core/events-routes');
const { setupPushRoutes }   = require('./core/push-routes');

function mountRoutes(app) {
  if (securityRoutes) {
    app.use('/api/security', securityRoutes);
  }
  if (authRoutes) {
    // Multi-user authentication family: login picker, PIN/passphrase/
    // WebAuthn login, session lifecycle, and the role-gated admin family.
    app.use('/api/auth', authRoutes);
  }
  if (emailRoutes) {
    app.use('/api/email', emailRoutes);
  }
  setupEventsRoutes(app);
  setupPushRoutes(app);
}

module.exports = { mountRoutes };