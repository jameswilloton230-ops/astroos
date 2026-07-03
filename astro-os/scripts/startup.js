'use strict';

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const { ensureEnv }                    = require('./env');
const { ensureCerts }                  = require('./certs');
const { createLogStream, createConout, makeTee } = require('./logger');

// ── Window reference ──────────────────────────────────────────────────────────
// Module-scoped so it's available to hotkey handlers registered below.
let win = null;

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Full application startup sequence.
 *
 * @param {string} appDir  Absolute path to the NBOSP directory (client.js's __dirname)
 */
async function bootstrap(appDir) {
  // env and cert setup have no shared state — run in parallel for faster startup.
  // ensureEnv merges into process.env, ensureCerts does file + OS trust work.
  await Promise.all([ensureEnv(appDir), ensureCerts(appDir)]);

  if (process.env.HTTPS !== 'true') {
    const envPath = path.join(appDir, '.env');
    try {
      const content = await fs.promises.readFile(envPath, 'utf8');
      if (!/^HTTPS=.*$/m.test(content)) {
        await fs.promises.appendFile(envPath, '\nHTTPS=true\n');
        process.env.HTTPS = 'true';
      }
    } catch (_) { /* best effort */ }
  }

  const port   = parseInt(process.env.PORT || '3006', 10);
  const appUrl = `https://localhost:${port}`;

  // ── Global rejection safety net ───────────────────────────────────────────
  // Catches any promise rejection that escapes a try/catch — logs it cleanly
  // rather than letting NW.js print an opaque "UnhandledPromiseRejection".
  process.on('unhandledRejection', (reason) => {
    console.error('[NovaByte] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });

  // ── Server spawn ──────────────────────────────────────────────────────────
  const logStream = createLogStream(appDir);
  const conout    = createConout();
  const tee       = makeTee(logStream, conout);

  // Heap: 4096 MB is overkill for a local server process.
  // Default is 1024 MB; override with SERVER_HEAP_MB in .env if needed.
  const nodeBin  = process.env.NODE_BIN_PATH || 'node';
  const heapMb   = process.env.SERVER_HEAP_MB || '1024';

  const server = spawn(
    nodeBin,
    [`--max-old-space-size=${heapMb}`, '--expose-gc', path.join(appDir, 'server', 'core', 'index.js')],
    { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
  );

  server.on('error', err  => tee(Buffer.from(`[NovaByte] Server spawn error: ${err.message}\n`), true));
  server.on('exit', (code, signal) => {
    tee(Buffer.from(`[NovaByte] Server exited (code=${code}, signal=${signal})\n`), false);
    logStream.end();
    if (conout) try { conout.end(); } catch (_) {}
  });

  // ── Window management ─────────────────────────────────────────────────────
  let opened = false;

  function openWindow() {
    if (opened) return;
    opened = true;
    nw.Window.open(appUrl, { title: 'AstroOS', width: 1280, height: 720 }, window => {
      win = window;
      win.on('close', function () {
        server.kill();
        this.close(true);
        nw.App.quit();
      });
    });
  }

  server.stdout.on('data', d => {
    tee(d, false);
    // Short-circuit once open — no point inspecting every chunk forever
    if (!opened) {
      const str = d.toString();
      if (str.includes('Listening') || str.includes('https://localhost') || str.includes('Address')) {
        openWindow();
      }
    }
  });
  server.stderr.on('data', d => tee(d, true));

  // Fallback: open the window after 8 s even if server never signals ready
  setTimeout(openWindow, 8_000);

  // Quit handler: kill server when NW.js quits (not recursive — no nw.App.quit() here)
  nw.App.on('quit', () => server.kill());

  // ── Global hotkeys ────────────────────────────────────────────────────────
  nw.App.registerGlobalHotKey(new nw.Shortcut({ key: 'F11', active: () => win?.toggleFullscreen() }));
  nw.App.registerGlobalHotKey(new nw.Shortcut({ key: 'F12', active: () => win?.showDevTools()    }));
}

module.exports = { bootstrap };