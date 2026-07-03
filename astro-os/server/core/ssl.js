const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function configureSSL(app) {
    let server;
    
    // Resolve absolute paths to the correct 'cert.key' and 'cert.crt' in the root directory
    const keyPath = path.resolve(__dirname, '..', '..', 'cert.key');
    const certPath = path.resolve(__dirname, '..', '..', 'cert.crt');

    try {
        const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ALPNProtocols: ['http/1.1'] // Critical protocol alignment for Chromium
        };
        server = https.createServer(httpsOptions, app);
        console.log('[SSL Core] Secure HTTPS Server successfully running with native cert.key');
    } catch (err) {
        console.warn('[SSL Warning] cert.key/cert.crt not found or failed to load. Falling back to HTTP:', err.message);
        server = http.createServer(app);
    }
    
    return { server };
}

module.exports = { configureSSL };
