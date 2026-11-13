'use strict';

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const { ensureEnv }                              = require('./env');
const { ensureCerts }                            = require('./certs');
const { createLogStream, createConout, makeTee } = require('./logger');
const { getRuntimeDataDir } = require('./runtime-data-dir');

// Window reference module-scoped so it is accessible to global hotkey handlers
let win = null;

function createServerEnv(nodeBin = process.env.NODE_BIN_PATH || 'node') {
  // Share an unguessable, per-launch credential with the host renderer and
  // server child so verified system-app API calls can authenticate.
  process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = crypto.randomBytes(32).toString('hex');

  const rawHeap = process.env.SERVER_HEAP_MB;
  // Sanitize heap flag to prevent flag injection vulnerabilities
  const heapMb = /^\d+$/.test(rawHeap) ? rawHeap : '1024';
  const nodeOptions = [`--max-old-space-size=${heapMb}`, '--expose-gc'];
  const serverEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...nodeOptions].filter(Boolean).join(' '),
  };
  if (nodeBin !== 'node') serverEnv.NWJS_RUN_AS_NODE = '1';
  return serverEnv;
}

/**
 * Full application startup sequence.
 *
 * @param {string} appDir Absolute path to the AstroOS directory
 */
async function bootstrap(appDir) {
  // Parallel initialization of environment and SSL certificates
  await Promise.all([ensureEnv(appDir), ensureCerts(appDir)]);

  if (process.env.HTTPS !== 'true') {
    const envPath = path.join(getRuntimeDataDir(appDir), '.env');
    try {
      const content = await fs.promises.readFile(envPath, 'utf8');
      if (!/^HTTPS=.*$/m.test(content)) {
        await fs.promises.appendFile(envPath, '\nHTTPS=true\n');
      }
    } catch (_) {
      // Best effort fallback if .env is missing or unreadable
    }
    process.env.HTTPS = 'true';
  }

  // Validate port input to avoid NaN or invalid range URLs
  const rawPort = parseInt(process.env.PORT, 10);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3006;
  const appUrl = `https://localhost:${port}`;

  // Global rejection safety net with full stack trace observability
  process.on('unhandledRejection', (reason) => {
    const detail = Error.isError(reason) ? (reason.stack || reason.message) : String(reason);
    console.error('[AstroOS] Unhandled rejection:', detail);
  });

  // Server spawn setup
  const logStream = createLogStream(appDir);
  const conout    = createConout();
  const tee       = makeTee(logStream, conout);

  const nodeBin = process.env.NODE_BIN_PATH || 'node';
  const serverEnv = createServerEnv(nodeBin);

  const serverScript = path.join(appDir, 'server', 'core', 'index.js');
  const server = spawn(
    nodeBin,
    [serverScript],
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: serverEnv,
    }
  );

  let opened = false;
  let fallbackTimer = null;

  function openWindow() {
    if (opened) return;
    opened = true;

    // Clear fallback timer immediately once window is triggered
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    nw.Window.open(appUrl, { title: 'AstroOS', width: 1280, height: 720 }, (createdWindow) => {
      if (!createdWindow) return;
      win = createdWindow;

      win.on('close', function () {
        // In the kiosk image, Alt+F4 / any WM close request aimed at the
        // AstroOS app itself is ignored: the OS exposes its own close and
        // shutdown flows. Only auxiliary windows (DevTools and other X11
        // clients) are closable by the window manager. A programmatic exit
        // can still force this by setting win.__astroosForceClose = true
        // before calling win.close().
        if (process.env.ASTROOS_KIOSK === '1' && !this.__astroosForceClose) {
          console.warn('[AstroOS] Kiosk close request ignored (Alt+F4 is disabled for the AstroOS app).');
          return; // not calling close(true) cancels the close
        }
        if (server && !server.killed) {
          server.kill();
        }
        this.close(true);
        nw.App.quit();
      });
    });
  }

  server.on('error', (err) => {
    tee(`[AstroOS] Server spawn error: ${err.message}\n`, true);
  });

  server.on('exit', (code, signal) => {
    // Prevent fallback timer from opening a window to a dead server if process exits early
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    tee(`[AstroOS] Server exited (code=${code}, signal=${signal})\n`, false);
    logStream.end();
    if (conout) {
      try { conout.end(); } catch (_) {}
    }
  });

  // Inspect server output to detect readiness using a rolling buffer to catch chunk-split tokens
  let stdoutBuffer = '';

  server.stdout.on('data', (chunk) => {
    tee(chunk, false);

    if (!opened) {
      stdoutBuffer += chunk.toString('utf8');
      if (
        stdoutBuffer.includes('Listening') ||
        stdoutBuffer.includes('https://localhost') ||
        stdoutBuffer.includes('Address')
      ) {
        stdoutBuffer = ''; // Release memory after trigger
        openWindow();
      } else if (stdoutBuffer.length > 4096) {
        // Keep a rolling tail buffer to avoid unbounded memory growth
        stdoutBuffer = stdoutBuffer.slice(-2048);
      }
    }
  });

  server.stderr.on('data', (chunk) => tee(chunk, true));

  // Fallback: open window after 8s if server signal isn't detected
  fallbackTimer = setTimeout(openWindow, 8_000);

  // Quit handler to terminate server process when NW.js exits
  nw.App.on('quit', () => {
    if (server && !server.killed) {
      server.kill();
    }
  });

  // No global (system-wide) hotkeys are registered on purpose: every OS
  // shortcut lives strictly inside the app (see js/apps/system-events/service.js
  // and ui-init.js). F11 fullscreen and F12 devtools are handled in-page, so
  // nothing fires when the AstroOS window is unfocused.
}

module.exports = { bootstrap, createServerEnv };