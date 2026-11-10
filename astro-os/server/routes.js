'use strict';

const securityRoutes        = require('../security/routes');
const emailRoutes           = require('../email/index');
const { setupEventsRoutes } = require('./core/events-routes');
const { setupPushRoutes }   = require('./core/push-routes');

function mountRoutes(app) {
  if (securityRoutes) {
    app.use('/api/security', securityRoutes);
  }
  if (emailRoutes) {
    app.use('/api/email', emailRoutes);
  }
  setupEventsRoutes(app);
  setupPushRoutes(app);
}

module.exports = { mountRoutes };