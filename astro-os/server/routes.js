const securityRoutes = require('../security/routes');
const emailRoutes = require('../email/index');

function mountRoutes(app) {
    // Mount core features
    app.use('/api/security', securityRoutes);
    app.use('/api/email', emailRoutes);
}

module.exports = { mountRoutes };
