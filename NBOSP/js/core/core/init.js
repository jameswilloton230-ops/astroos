// Frame-busting guard for clickjacking resistance.
// Fix CVE-NB-2026-009-H1: this used to clear document.body.innerHTML on
// failure, which is itself an XSS sink. Hiding via style does the same job
// visually without touching innerHTML.
if (window.top !== window.self) {
  try {
    window.top.location = window.self.location.href;
  } catch (e) {
    // cross-origin frame, can't navigate the parent — just hide our content
    const hide = () => { if (document.body) document.body.style.display = 'none'; };
    document.addEventListener('DOMContentLoaded', hide);
    hide(); // in case DOMContentLoaded already fired before this ran
  }
}

// Make sure localStorage always exists, even in sandboxed/private contexts
// where it can be missing entirely or present-but-throwing on write.
if (typeof localStorage === 'undefined') {
  const memStore = new Map();
  window.localStorage = {
    getItem: (key) => memStore.get(key) ?? null,
    setItem: (key, value) => { memStore.set(key, String(value)); },
    removeItem: (key) => { memStore.delete(key); },
    clear: () => { memStore.clear(); },
    key: (index) => Array.from(memStore.keys())[index] ?? null,
    get length() { return memStore.size; }
  };
} else {
  // localStorage can exist but still throw on write (Safari private mode,
  // some sandboxed iframes) — actually test it instead of assuming.
  try {
    const testKey = '__novabyte_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
  } catch (e) {
    const originalLS = localStorage;
    const memStore = new Map();
    window.localStorage = {
      getItem: (key) => {
        try {
          return originalLS.getItem(key) ?? memStore.get(key) ?? null;
        } catch (err) {
          return memStore.get(key) ?? null;
        }
      },
      setItem: (key, value) => {
        try {
          originalLS.setItem(key, String(value));
        } catch (err) {
          // real storage is blocked, memory fallback below still gets written
        }
        memStore.set(key, String(value));
      },
      removeItem: (key) => {
        try {
          originalLS.removeItem(key);
        } catch (err) { }
        memStore.delete(key);
      },
      clear: () => {
        try {
          originalLS.clear();
        } catch (err) { }
        memStore.clear();
      },
      key: (index) => Array.from(memStore.keys())[index] ?? null,
      get length() { return memStore.size; }
    };
  }
}

// Fix CVE-NB-2026-009-M3: block writes of actual credenital material to
// localStorage, since it's readable by any XSS payload on the page. The
// regex targets patterns that are almost always secrets — password, private
// key, API key — and deliberately skips overloaded terms like "session" or
// "token" that also show up in non-secret internal state (counters, expiry
// flags, recovery ids).
(function () {
  const SECRET = /^.*(password|private.?key|secret.?key|apikey|api_key|credential).*$/i;
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    if (SECRET.test(key)) {
      const msg = `[NovaByte] SECURITY: Refusing to store key "${key}" in localStorage (XSS-readable). Use a server-side session instead.`;
      console.error(msg);
      throw new Error(msg);
    }
    return realSet(key, value);
  };
})();

// Fix CVE-NB-2026-009-L2: swapped 36 inline onclick= attributes for
// data-fn + delegated click handling. Dynamic onclick= inside JS template
// literals elsewhere in the app are tracked separately, this only covers
// the static markup.
document.addEventListener('DOMContentLoaded', function () {
  document.addEventListener('click', function (e) {
    const target = e.target.closest('[data-fn]');
    if (!target?.dataset.fn) return;
    const fn = window[target.dataset.fn];
    if (typeof fn === 'function') fn();
  });
});

// Fix CVE-NB-2026-009-H6: mute console output in production so DevTools
// doesn't leak internal paths, state, or API endpoints to anyone poking
// around. console.error stays on — errors need to surface regardless.
// Set window.__NOVA_DEBUG = true before this script runs to turn it back on.
(function () {
  if (!window.__NOVA_DEBUG) {
    const noop = () => { };
    ['log', 'info', 'warn', 'debug', 'group', 'groupEnd', 'groupCollapsed', 'table', 'dir'].forEach((method) => {
      try { console[method] = noop; } catch (e) { }
    });
  }
})();

// Early boot guard. Loads before the rest of the OS on purpose: if a core
// script has a syntax error, nothing after this file runs, so this is the one
// place that can still get the machine into recovery.
//
// Recovery itself is the Linux environment (/usr/sbin/nbosp-recovery), not a
// web page. The desktop runs as the kiosk user inside cage and can't show a
// text console, so it leaves a one-shot request file for /etc/init.d/S99nbosp
// and restarts; the next boot comes up in the recovery menu.
(function () {
  const RECOVERY_FORCE_KEY  = 'nova_force_recovery';
  const MANUAL_RECOVERY_KEY = 'nova_manual_recovery';
  const BOOT_ATTEMPTS_KEY   = 'nova_boot_attempts';
  const BOOT_TIMEOUT_MS     = 15000;
  const REQUEST_FILE        = '/home/nbosp/.config/novabyte/recovery-request';
  const POWER_HELPER        = '/usr/bin/nbosp-power';

  function isNbospLinux() {
    try {
      return typeof require === 'function'
        && process.platform === 'linux'
        && require('os').homedir() === '/home/nbosp'
        && require('fs').existsSync(POWER_HELPER);
    } catch (e) { return false; }
  }

  function showBootFailure(reason, detail) {
    console.error('[BOOT] Could not enter recovery:', detail);
    const screenEl = document.getElementById('boot-screen');
    if (!screenEl) return;
    const note = document.createElement('pre');
    note.style.cssText = 'color:#ff6b6b;font:14px monospace;padding:24px;white-space:pre-wrap';
    note.textContent = 'NovaByte failed to start (' + reason + ').\n' + detail;
    screenEl.replaceChildren(note);
    screenEl.style.display = 'flex';
  }

  let requested = false;
  function requestRecovery(reason) {
    if (requested) return;
    requested = true;
    reason = reason || 'requested';
    try {
      [MANUAL_RECOVERY_KEY, RECOVERY_FORCE_KEY, BOOT_ATTEMPTS_KEY, 'nova_show_recovery']
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* storage unavailable: carry on, the request file is what matters */ }

    // Also clear the registry copies (HKNS/system/boot/*) so a stale flag
    // can't route the NEXT boot into recovery after this one handled it.
    // Best-effort: this guard has to work even when the registry engine
    // never came up — a broken registry is exactly what recovery is for.
    try {
      if (typeof RegistryBootState !== 'undefined') {
        RegistryBootState.clearFlags('manualRecovery', 'forceRecovery', 'showRecovery', 'attempts', 'safeMode');
      }
    } catch (e) { /* registry unavailable: the request file is what matters */ }

    // Off NBOSP Linux (dev in a browser or plain NW.js) there is nothing to
    // hand off to. Say so instead of reloading in a loop.
    if (!isNbospLinux()) {
      showBootFailure(reason, 'Recovery is only available on NovaByte OS. Clear site data and reload to try again.');
      requested = false;
      return;
    }
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(REQUEST_FILE), { recursive: true });
      fs.writeFileSync(REQUEST_FILE, reason + '\n');
    } catch (e) {
      showBootFailure(reason, 'Could not write the recovery request: ' + e.message);
      requested = false;
      return;
    }
    require('child_process').execFile(POWER_HELPER, ['restart'], function (err) {
      if (err) {
        showBootFailure(reason, 'Could not restart into recovery: ' + err.message);
        requested = false;
      }
    });
  }

  window.NovaRecovery = Object.freeze({ isAvailable: isNbospLinux, request: requestRecovery });

  // Left behind by the previous session: Settings > "Boot to Recovery", or a
  // boot the watchdog below / the main script gave up on. These reads use the
  // legacy localStorage keys ON PURPOSE — this guard runs before any core
  // script can be trusted, so it must not depend on the registry engine (the
  // authoritative copies live in HKNS/system/boot and are also consumed by
  // boot() step 2 through RegistryBootState, which keeps both strata in step).
  const manual = localStorage.getItem(MANUAL_RECOVERY_KEY) === '1';
  if (manual || localStorage.getItem(RECOVERY_FORCE_KEY) === '1') {
    requestRecovery(manual ? 'manual' : 'boot_failure');
    return;
  }

  // Track which app broke so it can be disabled instead of taking the
  // whole OS down. Keyed by id, not appended blindly: a flaky app that
  // fails every boot should update its one entry, not pile up duplicates.
  function disableAppByPath(src) {
    try {
      const id = src.split('/js/apps/').pop().split('.')[0];
      // Only classic developer-tool scripts still load from js/apps/*.js.
      // Migrated first-party apps are loaded from their signed .novaapp packages.
      const map = { console: 'devconsole' };
      const appId = id ? (map[id] || id) : null;
      if (!appId) return;

      const existing = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps)
        ? RegistryPrefs.disabledApps()
        : [];
      const withoutThisApp = existing.filter((entry) => entry.id !== appId);
      const nextList = [
        ...withoutThisApp,
        { id: appId, reason: 'broken: ' + src, ts: Date.now() }
      ];
      // Registry-backed (HKNU/apps/disabled) — RegistryPrefs keeps the
      // { id, reason, ts } entry shape the App Manager UI renders.
      if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setDisabledApps) {
        RegistryPrefs.setDisabledApps(nextList);
      }
    } catch (e) { }
  }

  window.addEventListener('error', function (e) {
    const msg = e.message || '';
    if (!msg.includes('SyntaxError') && !msg.includes('Unexpected token')) return;

    const src = e.filename || e.target?.src || '';
    if (src.includes('/js/apps/')) {
      console.warn('[AppLoader] Skipping broken app file:', src, msg);
      disableAppByPath(src);
      return;
    }
    console.error('[CRITICAL] Syntax error in core file:', src, msg);
    requestRecovery('syntax_error');
  });

  // If boot() hasn't finished within BOOT_TIMEOUT_MS, assume it's stuck. The
  // interval stops on both outcomes so it doesn't poll for the rest of the
  // window's life.
  window._bootStartTime = Date.now();
  const watchdog = setInterval(function () {
    if (document.body.classList.contains('os-booted')) {
      clearInterval(watchdog);
      return;
    }
    if (Date.now() - window._bootStartTime > BOOT_TIMEOUT_MS && document.getElementById('boot-screen')) {
      clearInterval(watchdog);
      console.error('[CRITICAL] Boot timeout - stuck detection');
      requestRecovery('boot_timeout');
    }
  }, 2000);
})();
