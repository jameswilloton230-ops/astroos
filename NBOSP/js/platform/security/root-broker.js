/**
 * NovaRoot — real root access broker for system:root apps
 * ─────────────────────────────────────────────────────────────────────────
 * Makes `system:root` mean what it says: an approved app can perform
 * privileged (unix root) operations after the user confirms in NovaByte's
 * own UI — never inside the app.
 *
 * No password is asked. NovaByte OS account passwords are stored by
 * NovaByte itself, not by Linux, so they cannot be validated by sudo —
 * asking for one would be theater. Instead:
 *
 * How it works
 *   1. Caller gate  — the requesting app must be executing in the OS page
 *                     (host/unrestricted), with Developer Mode + Root Access
 *                     enabled AND a live `system:root` grant. Re-checked on
 *                     every call; a revoked package loses access instantly.
 *                     The caller is identified from its injected
 *                     `novaapp:<id>` sourceURL stack marker, an explicit
 *                     appId (cross-checked against that marker), or the
 *                     transient unrestricted-package global during init.
 *   2. Confirmation — the OS renders its own confirmation prompt
 *                     (NovaByte-styled, above all app windows). Confirming
 *                     opens a root session, cached polkit-style until it
 *                     expires. No password prompt, no password handling.
 *   3. Operations   — privileged operations run as argv arrays through
 *                     `sudo -n -- <argv…>` (no shell, nothing to inject).
 *                     This requires the OS user account to allow
 *                     passwordless sudo (NOPASSWD); accounts that need a
 *                     sudo password get a clear, actionable error instead
 *                     of a useless prompt.
 *   4. Audit        — every grant, denial and operation is written to
 *                     EventLog with the app id and argv.
 *
 * Public API (window.NovaRoot)
 *   status()                       → { available, rootMode, appId, sessionActive, sessionUntil }
 *   requestSession({ appId?, reason? }) → Promise<{ granted, reason? }>  — shows the prompt
 *   run({ appId?, argv, inputB64?, inputText?, timeoutMs? }) → Promise<{ code, stdoutB64, stderrB64 }>
 *   rm(path) cp(src,dst) mkdirp(path) writeFile(path, textOrB64) readFile(path)
 *   endSession()                   → invalidate the cached sudo timestamp
 */
(() => {
  'use strict';

  if (typeof require !== 'function') { window.NovaRoot = null; return; }

  let cpMod, fsMod, pathMod;
  try {
    cpMod = require('child_process');
    fsMod = require('fs');
    pathMod = require('path');
  } catch (e) { window.NovaRoot = null; return; }

  const SUDO_CANDIDATES = ['sudo', '/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo'];
  let sudoBin = null;
  let sudoChecked = false;

  const SESSION_SOFT_TTL_MS = 15 * 60 * 1000; // display hint only; sudo enforces the real one

  let lastAuthAt = 0;
  let activePrompt = null;   // Promise while the OS prompt is open
  let inFlightSession = null; // coalesce concurrent requestSession() calls

  /* ── sudo resolution ───────────────────────────────────────────── */

  function resolveSudo() {
    if (sudoChecked) return sudoBin;
    sudoChecked = true;
    for (const candidate of SUDO_CANDIDATES) {
      try {
        cpMod.execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
        sudoBin = candidate;
        return sudoBin;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function sudoErrText(stderr) {
    return String(stderr || '').toLowerCase();
  }

  function sudoUnavailableMessage() {
    return 'Root operations are unavailable because sudo is missing from this NovaByte OS image. ' +
      'Rebuild and install the OS image with BR2_PACKAGE_SUDO enabled.';
  }

  function needsPasswordErr(stderr) {
    const t = sudoErrText(stderr);
    return t.includes('a password is required') || (t.includes('no tty present') && t.includes('askpass'));
  }

  function notInSudoersErr(stderr) {
    return sudoErrText(stderr).includes('not in the sudoers file');
  }

  // Actionable explanation when sudo itself cannot run root ops on this
  // account. Root operations are passwordless by design (see header), so
  // these are environment setup problems, not user errors.
  function sudoSetupMessage(stderr) {
    if (needsPasswordErr(stderr)) {
      return 'Root operations need passwordless sudo (NOPASSWD) for this OS account — it currently requires a password. ' +
        'Fix once with: sudo visudo, then add a rule like "novauser ALL=(ALL) NOPASSWD: ALL".';
    }
    if (notInSudoersErr(stderr)) {
      return 'This OS account is not allowed to use sudo. Fix once with: sudo visudo, then add a rule like "novauser ALL=(ALL) NOPASSWD: ALL".';
    }
    return null;
  }

  /* ── caller gate ───────────────────────────────────────────────── */

  // The nearest `novaapp:<id>/` frame in the call stack is the app whose
  // code is calling into the broker. app-sandbox.js injects
  // `//# sourceURL=novaapp:<appId>/<entry>` into every unrestricted entry,
  // so this works at call time — long after the transient
  // __novaUnrestrictedPackage global has been restored.
  function stackAppId() {
    try {
      const st = new Error().stack || '';
      const m = st.match(/novaapp:([A-Za-z0-9_.-]+)\//);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function globalAppId() {
    try {
      const pkg = window.__novaUnrestrictedPackage;
      if (pkg && typeof pkg.id === 'string') return pkg.id;
    } catch (e) { /* ignore */ }
    return null;
  }

  function focusedRootAppId() {
    if (typeof OS === 'undefined' || typeof OS.windows?.get !== 'function') return null;
    const appId = OS.windows.get(OS.focusedWindowId)?.appId;
    if (typeof appId !== 'string'
      || !callerHasRootGrant(appId)
      || typeof AppSandbox?.isRootExecutionApp !== 'function'
      || AppSandbox.isRootExecutionApp(appId) !== true) {
      return null;
    }
    return appId;
  }

  function resolveCallerId(explicit) {
    const stackId = stackAppId();
    if (explicit) {
      if (stackId) return stackId === explicit ? explicit : null;
      const activeId = globalAppId() || focusedRootAppId();
      return activeId === explicit ? explicit : null;
    }
    return stackId || globalAppId() || focusedRootAppId();
  }

  function rootModeEnabled() {
    try {
      return typeof OS !== 'undefined' &&
        OS.settings?.get?.('devMode') === true &&
        OS.settings?.get?.('rootAccessEnabled') === true;
    } catch (e) { return false; }
  }

  function callerHasRootGrant(appId) {
    if (!appId) return false;
    try {
      return typeof AppPermissionManager !== 'undefined' &&
        AppPermissionManager.isGranted?.('system:root', appId) === true;
    } catch (e) { return false; }
  }

  function audit(severity, message, data) {
    try {
      if (typeof EventLog !== 'undefined' && EventLog.log) {
        EventLog.log({
          app: 'NovaRoot',
          category: 'security',
          severity,
          message,
          data: data || {}
        });
      }
    } catch (e) { /* audit channel unavailable */ }
  }

  /* ── low-level sudo runner ─────────────────────────────────────── */

  function sudoRun(argv, { input = null, timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const bin = resolveSudo();
      if (!bin) {
        const error = new Error(sudoUnavailableMessage());
        error.code = 'NOVA_SUDO_UNAVAILABLE';
        reject(error);
        return;
      }
      let child;
      try {
        child = cpMod.execFile(bin, argv, {
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true
        }, (err, stdout, stderr) => {
          const code = child.exitCode;
          if (err && code == null) { reject(err); return; } // spawn/timeout failure
          resolve({ code: code == null ? 1 : code, stdout: stdout || '', stderr: stderr || '' });
        });
      } catch (e) { reject(e); return; }
      if (input != null && child.stdin) {
        child.stdin.end(input);
      }
    });
  }

  function rootRunCached(argv, opts = {}) {
    return sudoRun(['-n', '--', ...argv], opts);
  }

  /* ── the OS-side confirmation prompt (no password) ─────────────── */

  const Z_TOP = '2147483600'; // above system-modal-root (2147483000) and everything app-side

  function requestPrompt({ appName, reason }) {
    if (activePrompt) return activePrompt;

    activePrompt = new Promise((resolve) => {
      let settled = false;
      const finish = (granted) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        activePrompt = null;
        resolve(granted);
      };

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.cssText = `position:fixed;inset:0;z-index:${Z_TOP};`;

      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.style.cssText = 'max-width:420px;width:calc(100vw - 48px);';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = 'Root access confirmation';
      dialog.appendChild(title);

      const body = document.createElement('div');
      body.style.cssText = 'padding:4px 20px 16px;font:13px/1.55 var(--font-ui,system-ui,sans-serif);color:var(--text-primary,#e6edf3);';

      const shield = document.createElement('div');
      shield.style.cssText = 'font-size:26px;text-align:center;margin-bottom:8px;';
      shield.textContent = '🛡️';
      body.appendChild(shield);

      const line1 = document.createElement('div');
      line1.style.cssText = 'margin-bottom:6px;';
      const strong = document.createElement('b');
      strong.textContent = appName || 'An application';
      line1.appendChild(strong);
      line1.appendChild(document.createTextNode(' wants to run operations with real administrator (root) privileges.'));
      body.appendChild(line1);

      if (reason) {
        const reasonEl = document.createElement('div');
        reasonEl.style.cssText = 'color:var(--text-secondary,#8b949e);margin-bottom:10px;word-break:break-word;';
        reasonEl.textContent = reason;
        body.appendChild(reasonEl);
      }

      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-secondary,#8b949e);margin-bottom:12px;';
      note.textContent = 'No password is required. Only continue if you trust this app — every privileged operation is written to the security log.';
      body.appendChild(note);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:10px;';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid var(--border-color,#30363d);' +
        'background:transparent;color:var(--text-primary,#e6edf3);cursor:pointer;font-size:13px;';
      const ok = document.createElement('button');
      ok.textContent = 'Allow';
      ok.style.cssText = 'padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;' +
        'background:var(--danger-color,#d29922);color:#fff;';
      ok.style.background = 'var(--accent-color,#238636)';
      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      body.appendChild(btnRow);

      dialog.appendChild(body);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      }
      document.addEventListener('keydown', onKey, true);

      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
      setTimeout(() => ok.focus(), 40);
    });

    return activePrompt;
  }

  /* ── session orchestration ─────────────────────────────────────── */

  function sessionActive() {
    return lastAuthAt > 0 && (Date.now() - lastAuthAt) < SESSION_SOFT_TTL_MS;
  }

  async function ensureAuthorized(appId, reason) {
    if (!rootModeEnabled()) {
      return { granted: false, reason: 'Root Access is disabled (needs Developer Mode + Root Access in Settings).' };
    }
    if (!callerHasRootGrant(appId)) {
      return {
        granted: false,
        reason: 'The calling app does not hold a system:root grant' +
          (appId ? '.' : ' (the caller could not be identified).')
      };
    }
    if (!resolveSudo()) {
      const unavailable = sudoUnavailableMessage();
      audit('error', `Root session request for ${appId} failed — ${unavailable}`, { appId });
      return { granted: false, reason: unavailable };
    }
    if (sessionActive()) return { granted: true };

    const verdict = await requestPrompt({ appName: appId, reason });
    if (verdict === true) {
      lastAuthAt = Date.now();
      audit('warn', `Root session granted for ${appId}`, { appId });
      return { granted: true };
    }
    audit('info', `Root session request cancelled by user for ${appId}`, { appId });
    return { granted: false, reason: 'Cancelled by user.' };
  }

  /* ── public API ────────────────────────────────────────────────── */

  async function requestSession(opts = {}) {
    const appId = resolveCallerId(opts.appId);
    if (inFlightSession) return inFlightSession;
    inFlightSession = (async () => {
      return ensureAuthorized(appId, opts.reason || '');
    })().finally(() => { inFlightSession = null; });
    return inFlightSession;
  }

  async function run({ appId: explicitAppId, argv, inputB64 = null, inputText = null, timeoutMs = 30000, maxBuffer } = {}) {
    if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) {
      throw new Error('NovaRoot.run needs an argv array of strings (no shell).');
    }
    const appId = resolveCallerId(explicitAppId);
    const authorization = await requestSession({
      appId,
      reason: 'An application requested a privileged system operation.'
    });
    if (!authorization.granted) {
      const e = new Error('NovaRoot: ' + authorization.reason);
      e.code = 'NOVA_ROOT_DENIED';
      e.reason = authorization.reason;
      audit('warn', `Root op denied for ${appId || 'unknown caller'} — ${authorization.reason}`, { appId, argv });
      throw e;
    }

    const res = await rootRunCached(argv, {
      input: inputB64 != null ? Buffer.from(inputB64, 'base64') : (inputText != null ? inputText : null),
      timeoutMs, maxBuffer
    });

    if (res.code !== 0) {
      const setup = sudoSetupMessage(res.stderr);
      if (setup) {
        const e = new Error(setup);
        e.code = 'NOVA_SUDO_SETUP';
        e.stderr = res.stderr;
        audit('error', `Root op by ${appId} failed — sudo is not configured for passwordless use`, { appId, argv });
        throw e;
      }
      const e = new Error(`Root command failed (exit ${res.code}): ${(res.stderr || '').trim() || argv.join(' ')}`);
      e.code = res.code;
      e.stdout = res.stdout;
      e.stderr = res.stderr;
      audit('warn', `Root op by ${appId}: ${argv.join(' ')} → exit ${res.code}`, { appId, argv, exit: res.code });
      throw e;
    }

    audit('info', `Root op by ${appId}: ${argv.join(' ')} → exit 0`, { appId, argv, exit: 0 });
    return {
      code: res.code,
      stdoutB64: Buffer.from(res.stdout, 'utf8').toString('base64'),
      stderrB64: Buffer.from(res.stderr, 'utf8').toString('base64')
    };
  }

  /* Convenience wrappers — all argv-based, no shell. */

  function rm(p) { return run({ argv: ['rm', '-f', '--', String(p)] }); }
  function cp(src, dst) { return run({ argv: ['cp', '-f', '--', String(src), String(dst)] }); }
  function mkdirp(p) { return run({ argv: ['mkdir', '-p', '--', String(p)] }); }

  async function writeFile(dst, content) {
    // Write to a user-owned temp file first, then place it as root with cp.
    const tmp = pathMod.join((require('os').tmpdir() || '/tmp'), `nova-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const b64 = typeof content === 'string' ? Buffer.from(content, 'utf8').toString('base64') : String(content);
    fsMod.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    try {
      await mkdirp(pathMod.dirname(dst));
      await cp(tmp, dst);
    } finally {
      try { fsMod.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
    return { code: 0, stdoutB64: '', stderrB64: '' };
  }

  async function readFile(p) {
    const res = await run({ argv: ['cat', '--', String(p)] });
    return Buffer.from(res.stdoutB64, 'base64').toString('utf8');
  }

  async function endSession() {
    lastAuthAt = 0;
    try { await sudoRun(['-k'], { timeoutMs: 10000 }); } catch (e) { /* best effort */ }
    audit('info', 'Root session ended (timestamp invalidated)', {});
    return true;
  }

  function status() {
    return {
      available: !!resolveSudo(),
      rootMode: rootModeEnabled(),
      appId: resolveCallerId(),
      sessionActive: sessionActive(),
      sessionUntil: lastAuthAt ? new Date(lastAuthAt + SESSION_SOFT_TTL_MS).toISOString() : null
    };
  }

  window.NovaRoot = Object.freeze({
    status,
    requestSession,
    run,
    rm,
    cp,
    mkdirp,
    writeFile,
    readFile,
    endSession
  });

  console.info('[NovaRoot] Root access broker ready — window.NovaRoot (confirm-only, passwordless sudo)');
})();
