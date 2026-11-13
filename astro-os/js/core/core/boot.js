// ── Static Configurations & Constants ──────────────────────────────
const BOOT_TIMEOUT_MS = 15000;
const BOOT_THRESHOLD  = 5;

const KEYS = Object.freeze({
  INSTALLED_APPS: 'nova_installed_apps',
  OS_VERSION    : 'novabyte_os_version',
});

// ── Storage Helpers ────────────────────────────────────────────────
const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value)        { localStorage.setItem(key, JSON.stringify(value)); },
  remove(key)            { localStorage.removeItem(key); },
  checkFlag(key)         { return localStorage.getItem(key) === '1'; },
  removeAll(...keys)     { for (let i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]); },
};

// ── Boot-State Helper ──────────────────────────────────────────────
// Boot and recovery flags live in the AstroOS Registry
// (HKNS/system/boot/*) via RegistryBootState — loaded just above this
// file. localStorage remains the fail-soft fallback and the handoff
// channel init.js reads before boot() runs; the module keeps both
// strata in step. The inline stand-in only matters if the platform
// script failed to load entirely.
const LEGACY_FLAG_KEYS = {
  safeMode: 'nova_safe_mode',          forceRecovery: 'nova_force_recovery',
  manualRecovery: 'nova_manual_recovery', showRecovery: 'nova_show_recovery',
  attempts: 'nova_boot_attempts',      timeoutFlag: 'nova_boot_timeout_flag',
  homeLaunchPending: 'nova_home_launch_pending',
};
const BootState = (typeof RegistryBootState !== 'undefined') ? RegistryBootState : {
  flag(n)              { try { return localStorage.getItem(LEGACY_FLAG_KEYS[n]) === '1'; } catch { return false; } },
  setFlag(n, on)       { try { if (on) localStorage.setItem(LEGACY_FLAG_KEYS[n], '1'); else localStorage.removeItem(LEGACY_FLAG_KEYS[n]); } catch {} return false; },
  clearFlag(n)         { try { localStorage.removeItem(LEGACY_FLAG_KEYS[n]); } catch {} return false; },
  clearFlags(...n)     { for (const k of n) { try { localStorage.removeItem(LEGACY_FLAG_KEYS[k]); } catch {} } return false; },
  attempts()           { try { return JSON.parse(localStorage.getItem(LEGACY_FLAG_KEYS.attempts) || '[]'); } catch { return []; } },
  setAttempts(v)       { try { localStorage.setItem(LEGACY_FLAG_KEYS.attempts, JSON.stringify(v)); } catch {} return false; },
  timeoutFlag()        { try { return JSON.parse(localStorage.getItem(LEGACY_FLAG_KEYS.timeoutFlag) || 'null'); } catch { return null; } },
  setTimeoutFlag(v)    { try { localStorage.setItem(LEGACY_FLAG_KEYS.timeoutFlag, JSON.stringify(v)); } catch {} return false; },
  homeLaunchPending()  { try { return localStorage.getItem(LEGACY_FLAG_KEYS.homeLaunchPending); } catch { return null; } },
  setHomeLaunchPending(v) { try { localStorage.setItem(LEGACY_FLAG_KEYS.homeLaunchPending, v); } catch {} return false; },
  clearHomeLaunchPending() { try { localStorage.removeItem(LEGACY_FLAG_KEYS.homeLaunchPending); } catch {} return false; },
};

// ── CSS Custom Property Batch Helper ──────────────────────────────
function setCSSVars(style, pairs) {
  for (let i = 0; i < pairs.length; i++) style.setProperty(pairs[i][0], pairs[i][1]);
}

// ── Boot Namespace ─────────────────────────────────────────────────
/**
 * Boot lifecycle manager. Works out of the box with zero configuration.
 * Extend via Boot.hooks without touching core code.
 *
 * Each public stage method is independently overridable:
 * @example
 * // Override wallpaper logic for a custom fork
 * Boot.applyWallpaper = (sGet) => { myDesktop.setWallpaper(sGet('wallpaperId')); };
 *
 * // Hook into the lifecycle
 * Boot.hooks.before.push(() => analytics.track('boot_start'));
 * Boot.hooks.after.push(() => myPlugin.init());
 * Boot.hooks.onError.push((err, stage) => Sentry.captureException(err, { stage }));
 */
const Boot = {

  /**
   * Lifecycle hooks. Push functions onto these arrays before boot() runs.
   *
   * - `before`  : fires before subsystem init, after recovery check
   * - `after`   : fires after the desktop or lock screen is shown
   * - `onError` : fires if a boot stage throws — receives (error, stageName)
   */
  hooks: {
    before : [],
    after  : [],
    onError: [],
  },

  /**
   * Cached DOM references. Available after boot() begins.
   * Access via Boot._dom inside hooks if needed.
   * @type {{ bootScreen, desktop, taskbar, timeEl, dateEl, vPill, rootStyle, rootClasses }|null}
   */
  _dom: null,

  /** @private Fire all hooks registered under `name`. Never throws — errors are logged. */
  _runHooks(name, ...args) {
    for (const fn of Boot.hooks[name]) {
      try { fn(...args); }
      catch (e) { console.error(`[Boot] Hook "${name}" threw:`, e); }
    }
  },

  /** @private Cache all boot-relevant DOM references once at boot start. */
  _cacheDom() {
    Boot._dom = {
      bootScreen : document.getElementById('boot-screen'),
      desktop    : document.getElementById('desktop'),
      taskbar    : document.getElementById('taskbar'),
      timeEl     : document.getElementById('tray-time'),
      dateEl     : document.getElementById('tray-date'),
      vPill      : document.getElementById('boot-version-pill'),
      rootStyle  : document.documentElement.style,
      rootClasses: document.documentElement.classList,
    };
  },

  _markRuntimeReady() {
    window.__NB_RUNTIME ||= { os: 'AstroOS', layer: 'astroos' };
    window.__NB_RUNTIME.ready = true;
  },

  /**
   * @private
   * Set up the stuck-boot watchdog timer. //TODO: I might remove watchdog entirely or at least improve it; it doesn't work reliably, such as not even syntax error refreshes 2 times.
   * @returns {{ complete: Function }} Call complete() when boot finishes normally.
   */
  _setupWatchdog(bootStartTime, uaShort) {
    BootState.setTimeoutFlag({ start: bootStartTime, completed: false });

    const id = setTimeout(() => {
      const td = BootState.timeoutFlag() || {};
      if (!td.completed) {
        console.error('[BOOT] Stuck — timeout detected');
        BootState.setTimeoutFlag({ start: bootStartTime, completed: false, stuck: true });
        BootState.setFlag('forceRecovery', true);
        BootState.setAttempts([
          { ts: bootStartTime + BOOT_TIMEOUT_MS - 2000, reason: 'boot_timeout_1', ua: uaShort },
          { ts: bootStartTime + BOOT_TIMEOUT_MS,        reason: 'boot_timeout_2', ua: uaShort },
        ]);
        location.reload();
      }
    }, BOOT_TIMEOUT_MS);

    return {
      complete() {
        clearTimeout(id);
        const td = BootState.timeoutFlag() || {};
        td.completed = true;
        BootState.setTimeoutFlag(td);
        BootState.clearFlag('forceRecovery');
      },
    };
  },

  /**
   * @private
   * The engine instance opened for this session, or null. boot() opens it
   * at step 0 — before the watchdog and recovery routing consume the
   * HKNS/system/boot flags — and initSubsystems reuses it, because the
   * engine's init() is not idempotent (it resets the audit ring and
   * re-snapshots the hives).
   * @type {Object|null}
   */
  _registry: null,

  /**
   * @private
   * Initialize the AstroOS Registry exactly once per session.
   * @returns {Object|null} the engine, or null when unavailable
   */
  ensureRegistry() {
    if (Boot._registry) return Boot._registry;
    Boot._registry = Boot.initNovaRegistry();
    return Boot._registry;
  },

  // (The web-build prefs.json mirror was removed: OS.settings persists
  // through the AstroOS Registry now — see settings-shim.js — so a second
  // copy of every setting in the app's shared_prefs would just be a stale
  // shadow of the truth.)

  // ── Public Stage Methods ───────────────────────────────────────
  // Override any of these on the Boot object before boot() is called.
  // Each receives a bound settings getter (sGet) where settings are needed.

  /**
   * Initialize OS workers and all filesystem subsystems in parallel.
   * Throws on failure — caller routes to recovery.
   *
   * @param {boolean} isSafeMode
   */
   async initSubsystems(isSafeMode) {
     const linuxNative = typeof process !== 'undefined' && process.platform === 'linux';
     let migrateLegacyStorage = false;
    if (linuxNative) {
      const path = require('path');
      const home = require('os').homedir();
      migrateLegacyStorage =
        !require('fs').existsSync(path.join(home, '.local', 'share', 'novabyte', 'migration', 'vfs-imported')) ||
        !require('fs').existsSync(path.join(home, '.config', 'novabyte', 'settings.json'));
    }
    if (!linuxNative || migrateLegacyStorage) {
      OS.workers.fs = createWorker(FS_WORKER_CODE, 'fs');
      await OS.workers.fs.call('init');
    }
    OS.workers.search = createWorker(SEARCH_WORKER_CODE, 'search');
    OS.workers.crypto = createWorker(CRYPTO_WORKER_CODE, 'crypto');

    // The AstroOS Registry is the configuration source of truth: open the
    // hives and attach the settings shim BEFORE OS.settings.load(), so the
    // settings cache hydrates from the registry and the legacy settings
    // store is adopted exactly once. Fail-soft — when the registry is
    // unavailable the shim never attaches and OS.settings keeps its
    // original behaviour; when Safe Mode asks for a throwaway session the
    // shim's volatile flag keeps every change out of persistence.
    const reg = Boot.ensureRegistry();
    if (reg && window.NovaSettingsShim) window.NovaSettingsShim.attach(OS, reg);
    OS.settings.volatile = isSafeMode === true;

    await OS.settings.load().then(() => {
      if (isSafeMode && typeof OS.settings.applySafeModeDefaults === 'function') {
        OS.settings.applySafeModeDefaults();
      }
    });

    await window.OPFS?.init?.();
    await FS.init();
    await window.AppDirs?.bootstrap?.();
    if (linuxNative) {
      try {
        const commandLine = require('fs').readFileSync('/proc/cmdline', 'utf8');
        const isLiveBoot = !/(?:^|\s)root=/.test(commandLine);
        if (isLiveBoot) {
          const desktop = FS.specialFolders?.desktop;
          const alreadyPinned = desktop && FS.listDir(desktop).some(file => {
            if (!file.name.endsWith('.lnk')) return false;
            try {
              return JSON.parse(file.content?.toString?.() || file.content || '{}')?.target === 'com.astroos.install';
            } catch {
              return false;
            }
          });
          if (desktop && !alreadyPinned) {
            await FS.createFile(desktop, 'Install AstroOS.lnk', JSON.stringify({
              target: 'com.astroos.install',
              type: 'app-shortcut',
              icon: 'hard-drive'
            }), 'application/x-app-shortcut');
          }
        }
      } catch (error) {
        console.warn('[BOOT] Could not pin Install AstroOS to the live desktop:', error);
      }
    }
    if (linuxNative && OS.workers.fs) {
      OS.workers.fs.terminate?.();
      OS.workers.fs = null;
    }

    Boot._markRuntimeReady();
  },

  migrateLegacyAppIds() {
    const aliases = window.NovaAppIdAliases;
    if (typeof aliases?.migratePersistentReferences !== 'function') return false;
    const changed = aliases.migratePersistentReferences(OS.settings, localStorage);
    if (changed) console.info('[BOOT] Migrated legacy built-in app IDs');
    return changed;
  },

  /**
   * Apply core OS variables from settings.
   * @returns {Function} sGet — bound OS.settings.get, reused by subsequent stages.
   */
  applyOSVars() {
    const sGet     = OS.settings.get.bind(OS.settings);
    OS.username    = sGet('username')  || 'user';
    OS.idleTimeout = (parseInt(sGet('autoLock')) || 10) * 60000;
    OS.lockPin     = sGet('lockPin')   || null;
    // Do Not Disturb (Settings > Notifications). Only suppresses toasts —
    // panel entries and unread badges still land, matching the runtime
    // semantics in notifications/service.js.
    OS.dnd         = sGet('doNotDisturb') === true;
    return sGet;
  },

  /**
   * Apply theme, accent colour, and all CSS custom properties in one pass.
   * @param {Function} sGet
   */
  applyThemeAndVars(sGet) {
    const { rootStyle } = Boot._dom;

    applyTheme(sGet('theme') || 'nova-dark');

    const accent = sGet('accentColor');
    if (accent) {
      setCSSVars(rootStyle, [
        ['--accent',       accent],
        ['--accent-hover', accent + 'dd'],
        ['--accent-muted', accent + '22'],
      ]);
    }

    const cssBatch   = [];
    if (sGet('reduceMotion')) cssBatch.push(['--anim-speed', '0.001']);
    if (cssBatch.length) setCSSVars(rootStyle, cssBatch);
  },

  /**
   * Apply desktop wallpaper — custom image or a named preset.
   * @param {Function} sGet
   */
  applyWallpaper(sGet) {
    return window.WallpaperService?.apply(sGet) ?? false;
  },

  /**
   * Load the AstroOS Registry before anything reads or writes config:
   * open the hives and seed-once the boot defaults. Called from
   * initSubsystems ahead of OS.settings.load() — the settings shim (when
   * present) attaches right after and turns OS.settings into a registry
   * client that also adopts the legacy settings store exactly once. Every
   * step is fail-soft — a missing or broken registry must never block
   * boot; the shell simply keeps the legacy settings behaviour.
   * @returns {Object|null} the engine, or null when unavailable
   */
  initNovaRegistry() {
    const reg = window.NovaRegistry;
    if (!reg || typeof reg.init !== 'function') return null;
    try {
      reg.init({ settings: OS.settings, events: OS.events, logger: OS.logger });
      const seeded = reg.ensureDefaults(reg.BOOT_DEFAULTS);
      if (seeded > 0) console.info(`[BOOT] AstroOS Registry seeded ${seeded} default value(s)`);
      return reg;
    } catch (err) {
      console.warn('[BOOT] AstroOS Registry unavailable:', err);
      return null;
    }
  },

  /**
   * Apply accessibility settings: high contrast and reduce motion.
   * @param {Function} sGet
   */
  applyAccessibility(sGet) {
    const { rootClasses } = Boot._dom;
    const highContrast = !!sGet('highContrast');
    const removeTransparency = !!sGet('removeTransparency');
    const reduceMotion = !!sGet('reduceMotion');

    // This function is called both at boot and from settings:changed. It must
    // be symmetric: the previous version only ever added accessibility
    // classes, so turning a setting back off had no effect until a full reload.
    rootClasses.toggle('no-glass', highContrast);
    rootClasses.toggle('no-transparency', removeTransparency);
    rootClasses.toggle('reduce-motion', reduceMotion);

    const wpEl = document.getElementById('wallpaper');
    if (wpEl) wpEl.style.animation = reduceMotion ? 'none' : '';
  },

  /**
   * Apply cursor size scaling to desktop icons via an injected style tag.
   * @param {Function} sGet
   */
  applyCursorSize(sGet) {
    return window.configureLauncherCursorSize?.(sGet);
  },


  /**
   * Sync OS version between code constant, settings store, and localStorage.
   * Code version always wins.
   * @param {Function} sGet
   */
  syncVersion(sGet) {
    const { vPill } = Boot._dom;
    const codeVer   = OS.version;
    if (sGet('osVersion') !== codeVer) OS.settings.set('osVersion', codeVer);
    try { localStorage.setItem(KEYS.OS_VERSION, codeVer); } catch (_) {}
    if (vPill) vPill.textContent = 'VERSION ' + codeVer;
  },

  /**
   * Configure taskbar position, orientation, size, and auto-hide proximity detection.
   * @param {Function} sGet
   */
  configureTaskbar(sGet) {
    return window.configureLauncherTaskbar?.(sGet);
  },


  /**
   * Initialize the global screen reader announcement helper (window.SR).
   */
  initScreenReader() {
    window.SR = {
      announce(msg) {
        let el = document.getElementById('sr-announcer');
        if (!el) {
          el = document.createElement('div');
          el.id = 'sr-announcer';
          el.setAttribute('aria-live',   'polite');
          el.setAttribute('aria-atomic', 'true');
          el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
          document.body.appendChild(el);
        }
        el.textContent = '';
        requestAnimationFrame(() => { el.textContent = msg; });
      },
    };
  },

  /**
   * Start the window manager, notification badge, and taskbar clock.
   */
  startServices() {
    WM.init();
    if (typeof updateNotificationBadge === 'function') updateNotificationBadge();

    const { timeEl, dateEl } = Boot._dom;
    function updateClock() {
      const now = new Date();
      if (timeEl) timeEl.textContent = formatTime(now);
      if (dateEl) dateEl.textContent = formatDate(now);
    }
    updateClock();
    setInterval(updateClock, 1000);
  },
};

// ── Main Boot Entry Point ──────────────────────────────────────────
/**
 * Main boot sequence. Called once on page load by the HTML entry point.
 * Extend via Boot.hooks — do not call this manually.
 */
async function boot() {
  Boot._cacheDom();
  const { bootScreen } = Boot._dom;
  const bootStartTime  = Date.now();
  const uaShort        = navigator.userAgent.slice(0, 80);

  // 0. Registry ───────────────────────────────────────────
  // Open the hives BEFORE the watchdog and recovery routing: the boot
  // flags both consume live in HKNS/system/boot now, so the engine has
  // to be up first. Fail-soft — when the registry is unavailable the
  // flags fall back to their legacy localStorage keys via BootState.
  Boot.ensureRegistry();

  // 0.5 Multi-user migration ───────────────────────────────────────
  // The one-time 3.0.2 → accounts migration runs BEFORE any hive is
  // mounted for a user and BEFORE the storage schemas stamp owners, so
  // every legacy byte is stamped to the owner it belongs to. Idempotent
  // behind the HKNS/system/migration/v1 marker; multi-user disabled ⇒
  // no-op, byte-identical single-user boot.
  if (typeof MultiUserMigration !== 'undefined' && MultiUserMigration?.run) {
    try {
      await MultiUserMigration.run();
    } catch (e) {
      console.error('[BOOT] Multi-user migration failed — continuing single-user:', e);
    }
  }

  // 1. Watchdog ────────────────────────────────────────────────────
  const forceRecovery = BootState.flag('forceRecovery');
  const watchdog      = Boot._setupWatchdog(bootStartTime, uaShort);

  // 2. Recovery Routing ────────────────────────────────────────────
  const isManualRecovery = BootState.flag('manualRecovery') || BootState.flag('showRecovery');
  if (isManualRecovery || forceRecovery) {
    BootState.clearFlags('manualRecovery', 'showRecovery', 'forceRecovery');
    requestSystemRecovery(forceRecovery ? 'boot_failure' : 'manual');
    watchdog.complete();
    return;
  }

  // 3. Attempt Tracking ────────────────────────────────────────────
  const priorAttempts = BootState.attempts();
  const isSafeMode    = BootState.flag('safeMode') || consumeSafeModeFile();

  if (priorAttempts.length >= BOOT_THRESHOLD && !isSafeMode) {
    requestSystemRecovery('repeated_boot_failure');
    watchdog.complete();
    return;
  }

  // Track this attempt — cleared immediately on subsystem success (not at end of boot)
  // so that rapid dev restarts don't accumulate toward the threshold.
  priorAttempts.push({ ts: Date.now(), ua: uaShort });
  if (priorAttempts.length > 10) priorAttempts.shift();
  BootState.setAttempts(priorAttempts);

  function markBootSuccess() {
    BootState.clearFlags('attempts', 'forceRecovery');
    watchdog.complete();
    document.body.classList.add('os-booted');
  }

  // 4. Safe Mode ───────────────────────────────────────────────────
  if (isSafeMode) {
    BootState.clearFlag('safeMode');
    document.getElementById('safe-mode-banner').style.display = 'block';
    OS._safeModeActive = true;
  }

  // 5. Pre-boot Hooks ──────────────────────────────────────────────
  Boot._runHooks('before');

  // 6. Subsystems ──────────────────────────────────────────────────
  try {
    await Boot.initSubsystems(isSafeMode);
  } catch (e) {
    console.error('[BOOT] Subsystem init failed at stage "initSubsystems":', e);
    Boot._runHooks('onError', e, 'initSubsystems');
    triggerRecovery('worker_init_failed');
    return;
  }

  Boot.migrateLegacyAppIds();

  // Subsystems initialised cleanly — this is not a crash loop. Clear attempts now
  // so a subsequent fast restart doesn't accumulate toward the threshold.
  BootState.clearFlag('attempts');

  // 7. Settings & UI ───────────────────────────────────────────────
  // OS.settings is registry-backed by now (initSubsystems opened the hives
  // and attached the settings shim before load()), so a plain read already
  // serves the live registry value — the entire desktop runs off the
  // AstroOS Registry, and NovaReg edits apply live through the shim's
  // change fan-out.
  const sGet = Boot.applyOSVars();
  Boot.applyThemeAndVars(sGet);
  Boot.applyWallpaper(sGet);
  Boot.applyAccessibility(sGet);
  Boot.applyCursorSize(sGet);
  Boot.syncVersion(sGet);
  Boot.configureTaskbar(sGet);
  Boot.initScreenReader();
  Boot.startServices();

  // 8. NovaApp Reconciliation ─────────────────────────────────────
  // Bundled system packages are source-of-truth content. Reconcile and
  // hydrate them BEFORE the desktop becomes launchable so a stale persisted
  // AppRegistry record can never win the race and launch an older package.
  try {
    await reconcileBundledNovaApps();
    await loadInstalledNovaApps();
  } catch (e) {
    console.error('[BOOT] Failed to reconcile/load Nova apps:', e);
  }

  for (const legacyId of ['com.astroos.quill', 'com.astroos.shell', 'com.astroos.vault']) {
    try {
      if (typeof AppRegistry !== 'undefined' && AppRegistry.getApp?.(legacyId)) {
        await AppRegistry.uninstallApp(legacyId, { force: true });
      }
    } catch (error) {
      console.warn('[BOOT] Failed to remove stale legacy app registration', legacyId, error);
    }
  }

  // Multi-user login gate: while no account session is live, the desktop
  // is NOT brought up — the login picker (or first-boot wizard) is the
  // surface, and the SessionManager mounts the desktop per account after
  // authentication. Single-user machines skip this branch entirely.
  const multiUserGateActive = typeof NovaUserScope !== 'undefined' &&
    NovaUserScope?.enabled?.() &&
    !(typeof SessionManager !== 'undefined' && SessionManager.active?.());

  // Publish the closure-scoped autostart pass for the SessionManager's
  // per-account mount sequence.
  Boot.launchAutostartApps = launchAutostartApps;

  if (!multiUserGateActive) {
    try {
      await startConfiguredHomeApp();
    } catch (e) {
      console.error('[BOOT] Failed to start the trusted launcher in the OS page:', e);
    }

    if (typeof WM !== 'undefined' && typeof WM.updateTaskbar === 'function') WM.updateTaskbar();
    if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
    if (typeof renderLaunchpad === 'function') renderLaunchpad();

    // Apps are now guaranteed to reflect the current bundled package contents.
    launchAutostartApps();
  } else if (typeof WM !== 'undefined' && typeof WM.updateTaskbar === 'function') {
    WM.updateTaskbar();
  }

  if (typeof AppScheduler !== 'undefined') {
    AppScheduler.start();
  }

  // 9. Finalize ────────────────────────────────────────────────────
  bootScreen.classList.add('fade-out');

  await new Promise(r => setTimeout(r, 400));
  bootScreen.style.display = 'none';
  markBootSuccess();
  WM.updateTaskbar();

  if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
    // Multi-user: the login picker (or first-boot setup wizard when
    // users.db is empty) is the gate at every cold boot — the lock screen
    // service owns the surface, the SessionManager owns the verbs.
    try {
      await window.LockScreenService?.showLoginPicker?.();
    } catch (e) {
      console.error('[BOOT] Login picker failed to present:', e);
    }
  } else if (OS.lockPin) {
    window.LockScreenService.lockScreen();
  } else {
    renderDesktopIcons();
  }

  // 10. Post-boot Hooks ────────────────────────────────────────────
  Boot._runHooks('after');

  // 11. Developer Mode / Debug Overlay ───────────────────────────
  if (OS.settings.get('devMode')) {
    const overlayPref = OS.settings.get('debugOverlayVisible');
    if (overlayPref !== false && window.DebugOverlay) {
      window.DebugOverlay.enable();
    }
  }

  // Freeze hooks to prevent post-boot tampering. Any script that tries to push
  // onto Boot.hooks after this point will receive a TypeError.
  try {
    Object.freeze(Boot.hooks.before);
    Object.freeze(Boot.hooks.after);
    Object.freeze(Boot.hooks.onError);
    Object.freeze(Boot.hooks);
  } catch (e) { /* non-fatal */ }
}

// ── App Loader ─────────────────────────────────────────────────────
async function startBundledLauncher() {
  const launcherId = 'com.astroos.launcher';
  const app = OS.apps?.[launcherId];
  if (!app) throw new Error(`Bundled launcher ${launcherId} is not registered`);
  if (!window.UnrestrictedGate?.checkUnrestrictedApp) {
    throw new Error('UnrestrictedGate is unavailable');
  }

  const gate = await window.UnrestrictedGate.checkUnrestrictedApp(app);
  if (!gate.allowed) {
    throw new Error(`UnrestrictedGate rejected ${launcherId}: ${gate.reason}`);
  }

  const readPackageText = (path) => {
    const encoded = app.files?.[path];
    if (typeof encoded !== 'string') throw new Error(`Launcher package is missing ${path}`);
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  const root = document.getElementById('launcher-root');
  if (!root) throw new Error('Launcher root is missing from the OS page');

  // ── Tray preservation across launcher re-renders ───────────────────
  // The launcher moves #system-tray-root (an OS-page element whose tray
  // buttons carry the tray service's listeners — attached once, at boot)
  // INSIDE its taskbar. Re-running the launcher (log off → log back in,
  // user switch, per-account mount) replaces the whole launcher DOM with
  // innerHTML, which would destroy the tray node with it: the fresh
  // launcher then finds no #system-tray-root to re-attach and the tray
  // items vanish until a full page reload. Park the node on the body
  // before the wipe; the launcher script re-parents it into the new
  // taskbar (and flips its display back to 'contents') moments later.
  const trayRoot = document.getElementById('system-tray-root');
  if (trayRoot && root.contains(trayRoot)) {
    trayRoot.style.display = 'none';
    document.body.appendChild(trayRoot);
  }

  root.innerHTML = readPackageText(app.entry || app.manifest?.entry || 'index.html');

  let styles = document.getElementById('launcher-package-styles');
  if (!styles) {
    styles = document.createElement('style');
    styles.id = 'launcher-package-styles';
    document.head.appendChild(styles);
  }
  styles.textContent = readPackageText('style.css');

  const entry = app.unrestrictedEntry || app.manifest?.unrestrictedEntry;
  if (typeof entry !== 'string' || !entry) {
    throw new Error('Launcher package has no unrestrictedEntry');
  }
  const script = document.createElement('script');
  script.textContent = `${readPackageText(entry)}\n//# sourceURL=novaapp:${launcherId}/${entry}\n`;
  document.head.appendChild(script);

  if (typeof window.renderLaunchpad !== 'function' ||
      typeof window.toggleLaunchpad !== 'function' ||
      typeof window.renderDesktopIcons !== 'function' ||
      typeof window.updateTaskbar !== 'function') {
    throw new Error('Launcher entry did not expose the full shell API');
  }

  Boot._cacheDom();
  window.applyLauncherSettings(OS.settings.get.bind(OS.settings));
  WM.attachTaskbar();
  window.renderDesktopIcons();
  window.renderLaunchpad();
  window.updateTaskbar();
}

// A non-bundled Home app that hangs or crashes the page never lets boot reach
// os-booted, and init.js answers that by restarting the machine into recovery.
// Because the choice is persisted, it would do the same on every boot. So the
// attempt is marked before launch and cleared after; a marker found at startup
// means the last attempt never finished, and the default is reset.
// The pending id lives in HKNS/system/boot/homeLaunchPending via BootState
// (legacy nova_home_launch_pending stays as the fail-soft shadow).
const HOME_START_TIMEOUT_MS = 5000; // well under the 15s boot watchdog

function launchWithTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not start within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startConfiguredHomeApp() {
  const bundledLauncherId = 'com.astroos.launcher';
  let selectedId = DefaultApps?.getDefault?.('home') || bundledLauncherId;
  const root = document.getElementById('launcher-root');
  if (!root) throw new Error('Launcher root is missing from the OS page');

  const interruptedId = BootState.homeLaunchPending();
  if (interruptedId) {
    console.error(`[BOOT] Home app "${interruptedId}" never finished starting last time; reverting to ${bundledLauncherId}`);
    BootState.clearHomeLaunchPending();
    if (selectedId !== bundledLauncherId) {
      DefaultApps.setDefault?.('home', null);
      selectedId = bundledLauncherId;
    }
  }

  if (selectedId === bundledLauncherId) {
    window.__NOVA_ACTIVE_HOME_APP_ID__ = bundledLauncherId;
    await startBundledLauncher();
  } else {
    const app = OS.apps?.[selectedId];
    if (!app || !DefaultApps.getAppsForCategory('home').some(candidate => candidate.id === selectedId)) {
      console.error(`[BOOT] Selected Home app "${selectedId}" is unavailable or no longer declares the Home role; using ${bundledLauncherId}`);
      window.__NOVA_ACTIVE_HOME_APP_ID__ = bundledLauncherId;
      await startBundledLauncher();
    } else if ((app.permissions || app.manifest?.permissions || []).includes('system:root')
      && (typeof AppPermissionManager === 'undefined'
        || AppPermissionManager.isGranted('system:root', app.id) !== true)) {
      console.warn(`[BOOT] Selected Home app "${selectedId}" requires unavailable root access; using ${bundledLauncherId}`);
      if (typeof DefaultApps.setDefault === 'function' && !DefaultApps.setDefault('home', null)) {
        console.error(`[BOOT] Could not clear unavailable Home app "${selectedId}" from the default-app settings`);
      }
      window.__NOVA_ACTIVE_HOME_APP_ID__ = bundledLauncherId;
      root.replaceChildren();
      await startBundledLauncher();
    } else if (typeof AppSandbox === 'undefined' || typeof AppSandbox.launchHome !== 'function') {
      throw new Error('AppSandbox Home surface runtime is unavailable');
    } else {
      window.__NOVA_ACTIVE_HOME_APP_ID__ = selectedId;
      root.replaceChildren();
      BootState.setHomeLaunchPending(selectedId);
      try {
        // launchRootApp resolves null on failure (after scheduling its own
        // reload), so a falsy result has to count as a failed start.
        const launched = await launchWithTimeout(AppSandbox.launchHome(app, root), HOME_START_TIMEOUT_MS, `Home app ${selectedId}`);
        if (!launched) throw new Error('launchHome returned no surface');
        BootState.clearHomeLaunchPending();
      } catch (error) {
        console.error(`[BOOT] Failed to start selected Home app "${selectedId}"; falling back to ${bundledLauncherId}:`, error);
        BootState.clearHomeLaunchPending();
        DefaultApps.setDefault?.('home', null);
        window.__NOVA_ACTIVE_HOME_APP_ID__ = bundledLauncherId;
        root.replaceChildren();
        await startBundledLauncher();
      }
    }
  }

  OS.events.on('settings:changed', ({ key }) => {
    if (key !== 'defaultApps') return;
    const nextId = DefaultApps?.getDefault?.('home') || bundledLauncherId;
    if (nextId !== window.__NOVA_ACTIVE_HOME_APP_ID__) location.reload();
  });
}

/**
 * Re-register any .novaapp packages the user has previously installed.
 * Called at idle time after boot — safe to call manually if needed.
 */
  async function reconcileBundledNovaApps() {
    let bundles = [];
    try {
      const response = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const parsed = await response.json();
      bundles = Array.isArray(parsed) ? parsed.filter(x => x && x.id && x.file) : [];
    } catch (e) {
      console.warn('[BOOT] Bundled NovaApp manifest unavailable:', e);
      return;
    }

    const store = window.NovaAppPackageStore;
    if (!store?.loadRegistry || !store?.saveRegistry) return;
    const trustStore = typeof TrustStore !== 'undefined' && typeof TrustStore.list === 'function' ? TrustStore.list() : [];
    const revocationCheck = typeof TrustStore !== 'undefined' && typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
    let registry = store.loadRegistry();
    const bundleIds = new Set(bundles.map(b => b.id));

    const removeBundledSystem = async (id, reason) => {
      const stored = registry.find(a => a.id === id);
      if (!stored) return;
      const isBundledSystem = stored.system === true && (stored.signer === 'Astro System' || stored.source === 'system-bundle' || stored.manifest?.system === true);
      if (!isBundledSystem) return;
      console.warn(`[BOOT] Removing stale bundled system app (${reason}):`, id);
      try {
        if (typeof AppRegistry !== 'undefined' && AppRegistry.uninstallApp) {
          await AppRegistry.uninstallApp(id, { force: true });
        } else if (store.removeApp) {
          await store.removeApp(id, { force: true });
        }
      } catch (e) {
        console.warn('[BOOT] Failed removing stored package', id, e);
      }
      registry = registry.filter(a => a.id !== id);
      store.saveRegistry(registry);
    };

    // Anything previously installed as a bundled system package but no longer
    // present in the current build manifest must disappear from the package
    // registry. This is what makes deleting/moving a .novaapp actually matter.
    for (const stored of registry.slice()) {
      if (stored?.system === true && (stored.signer === 'Astro System' || stored.source === 'system-bundle' || stored.manifest?.system === true) && !bundleIds.has(stored.id)) {
        await removeBundledSystem(stored.id, 'not present in bundled manifest');
      }
    }

    for (const bundle of bundles) {
      if (bundle.systemService === true) continue;

      let pkg;
      try {
        if (typeof window.AppLoaderOptimizer?.getPackage === 'function') {
          pkg = await window.AppLoaderOptimizer.getPackage(bundle.file, bundle.cacheKey);
        } else {
          const response = await fetch(bundle.file, { cache: 'no-cache' });
          if (response.status === 404) {
            await removeBundledSystem(bundle.id, 'source file missing');
            continue;
          }
          if (!response.ok) throw new Error(`package ${response.status}`);
          pkg = await response.json();
        }
      } catch (e) {
        if (e?.status === 404) {
          await removeBundledSystem(bundle.id, 'source file missing');
          continue;
        }
        console.warn('[BOOT] Failed to read bundled NovaApp', bundle.id, e);
        continue;
      }

      if (!pkg?.manifest?.id || pkg.manifest.id !== bundle.id || pkg.manifest.system !== true) {
        console.warn('[BOOT] Ignoring invalid bundled NovaApp manifest:', bundle.file);
        continue;
      }

      const stored = registry.find(a => a.id === bundle.id);
      const samePackage = stored &&
        stored.signature === pkg.signature &&
        stored.version === pkg.manifest.version &&
        stored.compiled_at === pkg.compiled_at &&
        (!pkg.integrity?.payloadHash || stored.integrity?.payloadHash === pkg.integrity.payloadHash);
      if (samePackage) continue;

      try {
        console.log('[BOOT] Reconciling bundled NovaApp:', bundle.id, pkg.manifest.version);
        await AppPackage.installPackage(pkg, { force: true, source: 'system-bundle', trustStore, revocationCheck });

        const runtimeApp = typeof AppRegistry !== 'undefined' && AppRegistry.getApp
          ? AppRegistry.getApp(bundle.id)
          : null;
        const metadata = store.toMetadata(runtimeApp || { ...pkg.manifest, files: pkg.files, signature: pkg.signature, verified: true, signer: 'Astro System', system: true, source: 'system-bundle', manifest: pkg.manifest, novabyte_app: pkg.novabyte_app, compiled_at: pkg.compiled_at });
        registry = registry.filter(a => a.id !== bundle.id);
        registry.push(metadata);
        store.saveRegistry(registry);
      } catch (e) {
        console.error('[BOOT] Failed to reconcile bundled NovaApp', bundle.id, e);
      }
    }

    window.AppLoaderOptimizer?.clear?.();
  }

  function registerWithFiles(appData) {
    if (!appData?.id || !appData.files) return;

    try {
      if (typeof window.buildNovaAppConfig !== 'function') {
        // nova-app-launcher.js loads before boot.js in index.html, so this should
        // never actually happen — but if script order ever changes, fail
        // loudly instead of silently falling back to the old incomplete
        // registration path (which is exactly how this bug shipped once).
        console.error('[BOOT] window.buildNovaAppConfig unavailable — cannot register', appData.id, 'with full launch config. Check that nova-app-launcher.js loads before boot.js.');
        return;
      }

      const cfg = window.buildNovaAppConfig(appData);
      OS.apps[appData.id] = cfg;
      const ri = APP_REGISTRY.findIndex(a => a.id === appData.id);
      if (ri > -1) APP_REGISTRY[ri] = cfg;
      else APP_REGISTRY.push(cfg);

      // Deliberately NOT calling AppRegistry.registerApp() here — it
      // unconditionally rebuilds and overwrites OS.apps[id] with its own
      // config (no files/entry), which would immediately clobber the
      // correct cfg set above. PackageStore's registry (nova_installed_apps)
      // is already the real persisted source of truth for installed apps;
      // AppRegistry's separate cache isn't load-bearing for this path.

      if (window.AppDirs && typeof window.AppDirs.ensureAppDataFolder === 'function') {
        window.AppDirs.ensureAppDataFolder(appData.id).catch(() => {});
      }
    } catch (e) {
      console.warn('[BOOT] Failed to register installed app', appData.id, e);
    }
  }

  async function refreshInstalledAppTrust(appData) {
    if (!appData?.id) return { changed: false, app: appData };
    if (appData.system === true && appData.manifest?.system === true && appData.source === 'system-bundle') {
      // Bundled system packages are re-trusted by provenance, but integrity
      // still has to match the package before the trusted runtime metadata is
      // restored. A modified bundle therefore cannot become unrestricted.
      try {
        const ok = !appData.integrity || await AppPackage.verifyIntegrity({
          novabyte_app: appData.novabyte_app,
          manifest: appData.manifest,
          files: appData.files || {},
          compiled_at: appData.compiled_at,
          integrity: appData.integrity,
        });
        if (ok) {
          appData.verified = true;
          appData.signer = 'Astro System';
          appData.revoked = false;
          appData.tampered = false;
          appData.system = true;
          return { changed: true, app: appData };
        }
      } catch (e) {
        console.warn('[BOOT] Bundled system integrity refresh failed for', appData.id, e);
      }
    }
    if (!appData?.signature) return { changed: false, app: appData };

    // Older App Manager installs persisted only the manifest/files/signature and
    // dropped the two top-level fields that are part of the canonical signed
    // payload (`novabyte_app` and `compiled_at`). Reconstructing a signature
    // without those exact values can never succeed. For AstroOS-bundled first-
    // party packages, recover the missing envelope fields from the bundled
    // signed package, but only when its signature is byte-for-byte identical
    // to the installed record. This is a migration aid, not a trust bypass.
    if (appData.novabyte_app == null || appData.compiled_at == null || !appData.manifest) {
      try {
        const safeId = String(appData.id).replace(/[^a-zA-Z0-9._-]/g, '_');
        const response = await fetch(`js/apps/${safeId}.novaapp`, { cache: 'no-store' });
        if (response.ok) {
          const bundled = await response.json();
          if (bundled?.signature && bundled.signature === appData.signature) {
            if (appData.novabyte_app == null && bundled.novabyte_app != null) appData.novabyte_app = bundled.novabyte_app;
            if (appData.compiled_at == null && bundled.compiled_at != null) appData.compiled_at = bundled.compiled_at;
            if (!appData.manifest && bundled.manifest) appData.manifest = bundled.manifest;
          }
        }
      } catch (e) {
        console.warn('[BOOT] Could not recover legacy package envelope for', appData.id, e);
      }
    }
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyAgainstTrustStore !== 'function' || typeof TrustStore === 'undefined' || typeof TrustStore.list !== 'function') {
      return { changed: false, app: appData };
    }

    try {
      const pkg = {
        novabyte_app: appData.novabyte_app || 1,
        manifest: appData.manifest || {
          id: appData.id, name: appData.name, version: appData.version, entry: appData.entry,
          description: appData.description, author: appData.author, icon: appData.icon,
          type: appData.type, permissions: appData.permissions || [],
          optionalPermissions: appData.optionalPermissions || [],
          defaultSize: appData.defaultSize, minSize: appData.minSize, maxSize: appData.maxSize,
          resizable: appData.resizable, frame: appData.frame, categories: appData.categories,
          handles: appData.handles
        },
        files: appData.files || {},
        signature: appData.signature,
        compiled_at: appData.compiled_at,
        signing: appData.signing || undefined,
        integrity: appData.integrity || null,
      };
      const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
      const result = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
      const verified = !!result.trusted && !result.revoked;
      const signer = verified ? (result.signer || null) : null;
      const system = verified && signer === 'Astro System' && appData?.manifest?.system === true;
      const changed = appData.verified !== verified ||
        (appData.signer || null) !== signer ||
        (!!appData.revoked) !== !!result.revoked ||
        appData.system !== system;
      if (changed) {
        appData.verified = verified;
        appData.signer = signer;
        appData.revoked = !!result.revoked;
        appData.system = system;
        if (verified) appData.tampered = false;
      }
      return { changed, app: appData };
    } catch (e) {
      console.warn('[BOOT] Trust refresh failed for', appData.id, e);
      return { changed: false, app: appData };
    }
  }

  // `userOnly` re-registers just the mounted account's own apps (see
  // reloadUserNovaApps); bundled system packages are machine-wide and were
  // already registered at boot.
  async function loadInstalledNovaApps({ userOnly = false } = {}) {
    // The inventory is registry-backed (HKNS/apps/installed for system
    // packages, the account's HKNU/apps/installed for its own installs, both
    // through the package store); the localStorage key is only the
    // pre-registry fallback.
    const storedApps = window.NovaAppPackageStore?.loadRegistry
      ? NovaAppPackageStore.loadRegistry()
      : Storage.get(KEYS.INSTALLED_APPS, []);
    const isMachineApp = app => window.RegistrySystemState?.isMachineApp?.(app) === true;
    const listed = userOnly ? storedApps.filter(app => !isMachineApp(app)) : storedApps;
    const apps = window.NovaAppPackageStore?.hydrateApps
      ? await NovaAppPackageStore.hydrateApps(listed)
      : listed;

    let trustRegistryChanged = false;
    for (let i = 0; i < apps.length; i++) {
      const appData = apps[i];
      if (!appData.files) {
        console.warn('[BOOT] Installed package files missing for', appData.id);
        continue;
      }

      // Re-evaluate trust at startup instead of blindly trusting the cached
      // `verified` boolean from a previous install. This repairs stale
      // `verified:false` metadata after a correctly signed package is
      // reinstalled, and catches a signature that no longer matches the
      // stored package before the app is exposed as trusted.
      const trust = await refreshInstalledAppTrust(appData);
      trustRegistryChanged = trustRegistryChanged || trust.changed;

      // AppPackage.installPackage() registers a lightweight AppRegistry config
      // before this pass, but that config omits the hydrated package files.
      // Always rebuild from the hydrated package so host launchers and other
      // package consumers receive their complete files and trust metadata.
      registerWithFiles(appData);
    }

    if (trustRegistryChanged && window.NovaAppPackageStore?.saveRegistry) {
      try {
        // A user-only pass must write the whole list back: saving just the
        // account's apps would drop the system packages from the machine list.
        const toSave = userOnly ? [...storedApps.filter(isMachineApp), ...apps] : apps;
        NovaAppPackageStore.saveRegistry(toSave);
      } catch (e) {
        console.warn('[BOOT] Failed to persist refreshed package trust state:', e);
      }
    }

    // ── Post-install revocation re-check ──────────────────────────
    // verifyAgainstTrustStore only ever ran once, at install time. If
    // AstroOS revokes a signature *after* someone already installed
    // that app, nothing previously re-checked it — the app just kept
    // running as "verified" forever, silently. This scan runs on every
    // boot so a newly-revoked app gets surfaced the next time AstroOS
    // starts, regardless of whether App Manager is ever opened.
    scanForRevokedApps(apps).catch(e =>
      console.error('[BOOT] Revocation scan failed:', e));
  }

  /**
   * Account switch: swap the registered third-party .novaapps over to the
   * account that just mounted. Boot registers installed apps once, before
   * anyone is signed in, so without this a second user would keep seeing the
   * previous user's apps (and none of their own) until a reload.
   */
  async function reloadUserNovaApps() {
    const isMachineApp = app => window.RegistrySystemState?.isMachineApp?.(app) === true;
    for (const id of Object.keys(OS.apps)) {
      const cfg = OS.apps[id];
      // Built-in JS apps carry no package files and system packages are
      // machine-wide; what's left is the previous account's installs.
      if (!cfg?.files || isMachineApp(cfg)) continue;
      delete OS.apps[id];
      const index = APP_REGISTRY.findIndex(app => app.id === id);
      if (index > -1) APP_REGISTRY.splice(index, 1);
    }
    await loadInstalledNovaApps({ userOnly: true });
  }

  /**
   * Launch every app the user has opted into "start at boot" (the registry
   * boot list, HKNU/apps/boot via RegistryPrefs — App Manager's boot toggle
   * writes it) AND that separately holds the system:autostart grant.
   *
   * Both conditions matter and neither substitutes for the other:
   *  - the boot list (HKNU/apps/boot via RegistryPrefs) is the user's own
   *    preference ("open this for me"), stored per-app, not a security
   *    boundary — a malicious app can't get itself into this list, only the
   *    user's own App Manager toggle does.
   *  - system:autostart is the permission grant. An app the user asked to
   *    autostart still needs to actually hold the grant, same as any other
   *    permission — a boot-list entry is not itself authorization. This
   *    also protects against the boot list having been populated by some
   *    older/different mechanism before this permission existed; a stale
   *    boot-list entry alone is never enough to launch something.
   *
   * Deliberately skipped if the lock screen is showing (OS.lockPin set):
   * autostart is real, silent app execution with no user present yet to
   * consent to or even see it happening, which is exactly the case
   * system:autostart is supposed to be the bigger, explicit ask for — it
   * shouldn't quietly happen before the user has even unlocked the
   * session. Apps on the list simply launch once the desktop actually
   * shows (lockScreen()'s own unlock flow doesn't currently re-trigger
   * this pass; that's a reasonable follow-up if it becomes an issue, not
   * something silently assumed to be covered here).
   */
  function launchAutostartApps() {
    if (OS.lockPin) return;

    // Both lists are registry-backed (HKNU/apps/boot, HKNU/apps/disabled)
    // via RegistryPrefs — the legacy localStorage keys are adopted once.
    let bootAppIds;
    try {
      bootAppIds = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.bootApps) ? RegistryPrefs.bootApps() : [];
    } catch {
      bootAppIds = [];
    }
    if (!Array.isArray(bootAppIds) || bootAppIds.length === 0) return;

    let disabled;
    try {
      disabled = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : [];
    } catch {
      disabled = [];
    }

    let staleEntryRemoved = false;
    for (const appId of bootAppIds) {
      if (typeof appId !== 'string' || !appId) continue;
      if (disabled.includes(appId)) continue;
      if (!OS.apps[appId]) continue; // not installed (or not yet registered)

      const hasGrant = typeof AppPermissionManager !== 'undefined' &&
        AppPermissionManager.isGranted('system:autostart', appId);
      if (!hasGrant) {
        // The grant was revoked (Permissions section) or expired (30-day
        // unused-app sweep) since this app was added to the boot list.
        // Don't just skip silently forever — drop the stale entry so App
        // Manager's toggle reflects reality next time it's opened, instead
        // of showing "Starts at Boot" for something that will never
        // actually launch again without the user re-granting it.
        bootAppIds = bootAppIds.filter(id => id !== appId);
        staleEntryRemoved = true;
        continue;
      }

      try {
        WM.createWindow(appId);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Boot', category: 'apps', severity: 'info', message: `Autostarted ${appId}`, data: { appId } });
        }
      } catch (err) {
        console.warn('[BOOT] Autostart failed for', appId, err);
      }
    }

    if (staleEntryRemoved) {
      try { if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setBootApps) RegistryPrefs.setBootApps(bootAppIds); } catch { /* quota */ }
    }
  }

  /**
   * Check every installed, signed app against TrustStore.isRevoked and
   * surface a removal dialog for each one currently on the revocation
   * list — every boot, not just the first time it's discovered. Shown
   * sequentially, one at a time, after the desktop is up rather than
   * blocking boot itself.
   */
  async function scanForRevokedApps(apps) {
    if (typeof TrustStore === 'undefined' || typeof TrustStore.isRevoked !== 'function') return;

    // NOTE: deliberately does NOT filter out a.revoked here. revoked is
    // persisted permanently once flagged (see markAppRevokedInStorage,
    // used for the App Manager badge), but the dialog itself must keep
    // firing every boot regardless of that flag — otherwise clicking
    // Cancel once (which sets revoked=true) would silently make this a
    // one-time-only warning, which is exactly the quiet-forever behavior
    // this feature exists to prevent. The only thing that should stop
    // the dialog from reappearing is the app actually being removed.
    const revokedApps = apps.filter(a =>
      a && a.id && a.signature && TrustStore.isRevoked(a.signature));

    if (revokedApps.length === 0) return;

    // Wait for the desktop/boot animation to settle so the dialog
    // doesn't fight with boot-screen fade-out/lock-screen transitions.
    await new Promise(r => setTimeout(r, 1200));

    for (const appData of revokedApps) {
      // Deliberately sequential (await inside loop) — showing several of
      // these stacked at once would be confusing; one decision at a time.
      const revocation = typeof TrustStore.getRevocation === 'function'
        ? TrustStore.getRevocation(appData.signature)
        : null;
      const remove = await showRevokedAppRemovalDialog(appData, revocation);
      if (remove) {
        await removeRevokedApp(appData.id);
      } else {
        // Persist the revoked flag so the rest of the UI (e.g. App
        // Manager's package details panel) can reflect it accurately,
        // WITHOUT suppressing this dialog on future boots — the whole
        // point is this keeps surfacing until the user acts, the same
        // way a browser keeps warning about a disabled/malicious
        // extension rather than mentioning it once and going quiet.
        markAppRevokedInStorage(appData.id);
      }
    }
  }

  function markAppRevokedInStorage(appId) {
    try {
      // Registry-backed inventory first (HKNS/apps/installed); the legacy
      // localStorage key is only touched when the package store is absent.
      if (window.NovaAppPackageStore?.saveRegistry && window.NovaAppPackageStore?.loadRegistry) {
        const reg = NovaAppPackageStore.loadRegistry();
        const ri = reg.findIndex(a => a.id === appId);
        if (ri > -1 && !reg[ri].revoked) {
          reg[ri] = { ...reg[ri], revoked: true };
          NovaAppPackageStore.saveRegistry(reg);
        }
        return;
      }
      const list = Storage.get(KEYS.INSTALLED_APPS, []);
      const idx = list.findIndex(a => a.id === appId);
      if (idx > -1 && !list[idx].revoked) {
        list[idx] = { ...list[idx], revoked: true };
        Storage.set(KEYS.INSTALLED_APPS, list);
      }
    } catch (e) {
      console.warn('[BOOT] Failed to persist revoked flag for', appId, e);
    }
  }

  async function removeRevokedApp(appId) {
    try {
      delete OS.apps[appId];
      const ri = APP_REGISTRY.findIndex(a => a.id === appId);
      if (ri > -1) APP_REGISTRY.splice(ri, 1);
      if (typeof AppRegistry !== 'undefined' && AppRegistry.uninstallApp) {
        await AppRegistry.uninstallApp(appId, { force: true });
      }
      if (window.NovaAppPackageStore?.removeApp) {
        await NovaAppPackageStore.removeApp(appId);
      } else {
        const list = Storage.get(KEYS.INSTALLED_APPS, []).filter(a => a.id !== appId);
        Storage.set(KEYS.INSTALLED_APPS, list);
      }
      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      console.warn('[BOOT] Removed app with revoked signature:', appId);
    } catch (e) {
      console.error('[BOOT] Failed to remove revoked app', appId, e);
    }
  }

  /**
   * Dialog shown when boot discovers an app whose signature has been
   * revoked SINCE it was installed (as opposed to the App Manager's
   * showUntrustedAppDialog, which only ever runs at install time and
   * offers "Cancel" / "Install Anyway"). This one only ever offers
   * "Remove" / "Cancel" — there's no "install anyway" equivalent here,
   * because the app is already installed and running; the only two
   * outcomes that make sense are taking it out, or acknowledging the
   * warning and leaving it for now (which will nag again next boot).
   */
  function showRevokedAppRemovalDialog(appData, revocation) {
    return new Promise(resolve => {
      const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);';

      const box = document.createElement('div');
      box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border,#333);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset;';

      const safeName = escapeHtml(appData.name || appData.id || 'This app');
      const safeId = escapeHtml(appData.id || '');
      const safeVersion = escapeHtml(appData.version || 'unknown');
      // AstroOS's own reason for revoking is genuinely useful context for
      // deciding whether to remove — surface it verbatim when set, rather
      // than only the generic "why re-checks happen at all" explanation.
      const safeReason = escapeHtml(revocation?.reason || '');
      const cautionBorderColor = 'rgba(248,81,73,0.35)';
      const cautionBgColor = 'rgba(248,81,73,0.1)';
      const cautionDotColor = '#f85149';

      box.innerHTML = `
        <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
          <div style="width:44px;height:44px;border-radius:12px;background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid ${cautionBorderColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">An Installed App Was Revoked</div>
            <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
              <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} was already installed and trusted, but its signature has since been pulled from AstroOS's trust list.
              This is different from an install-time warning — this app has actually been running on your system since it was first installed.
            </div>
          </div>
        </div>

        <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:${cautionBgColor};border:1px solid ${cautionBorderColor};border-radius:8px;">
            <div style="width:6px;height:6px;border-radius:50%;background:${cautionDotColor};flex-shrink:0;margin-top:7px;box-shadow:0 0 6px ${cautionDotColor};"></div>
            <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
              <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">Why this happened</div>
              A signature is normally only checked when an app is installed. AstroOS now also re-checks every installed app's signature each time it starts up, so revocations that happen after install — for example if this package was later found to be harmful, deceptive, or non-compliant — can still be caught.
            </div>
          </div>

          <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
            <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">present, but revoked by AstroOS since install</span></div>
              ${safeReason ? `<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Revocation reason</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;">${safeReason}</span></div>` : ''}
            </div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));font-size:12px;color:var(--text-muted,#999);line-height:1.6;">
              If you keep this app installed, AstroOS will show this warning again the next time it starts, until it's removed. Removing it now uninstalls the app and its data folder.
            </div>
          </div>
        </div>

        <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
          <button id="nb-revoked-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
          <button id="nb-revoked-remove-btn" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:700;">Remove App</button>
        </div>
      `;

      const styleEl = document.createElement('style');
      styleEl.textContent = `
        #nb-revoked-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
        #nb-revoked-remove-btn:hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
        #nb-revoked-remove-btn:active, #nb-revoked-cancel-btn:active { transform:scale(0.97); }
      `;
      document.head.appendChild(styleEl);

      overlay.appendChild(backdrop);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const cleanup = () => { overlay.remove(); styleEl.remove(); };

      box.querySelector('#nb-revoked-cancel-btn').addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
      box.querySelector('#nb-revoked-remove-btn').addEventListener('click', () => {
        cleanup();
        resolve(true);
      });
      // Deliberately NOT dismissible by clicking the backdrop — this is a
      // security notice about an app already running on the system, not
      // a casual install prompt; it should require an explicit choice.
    });
  }

// RECOVERY MODE

function triggerRecovery(reason) {
  if (document.body.classList.contains('os-booted')) return false;

  const attempts = BootState.attempts();
  attempts.push({ ts: Date.now(), reason: reason || 'unknown', ua: navigator.userAgent.slice(0, 80) });
  if (attempts.length > 10) attempts.shift();
  BootState.setAttempts(attempts);

  window.EventLog?.log?.({
    app: 'System', category: 'system', severity: 'error',
    message: `Boot failure detected: ${reason || 'unknown'} (attempt ${attempts.length})`,
    data: { reason, attemptCount: attempts.length }
  });

  if (attempts.length >= 2) {
    requestSystemRecovery(reason);
    return true;
  }
  return false;
}

// Listen for syntax errors during boot and route to recovery. Errors from
// scripts under /js/apps/ are skipped — those are loaded lazily and a single
// broken app shouldn't put the whole OS into recovery.
window.addEventListener('error', (e) => {
  if (document.body.classList.contains('os-booted')) return;
  const msg = e.message || '';
  if (!msg.includes('SyntaxError') && !msg.includes('Unexpected token')) return;

  const target = e.target;
  const src = target?.src || e.filename || '';
  if (src.includes('/js/apps/') || src.includes('\\js\\apps\\')) {
    console.warn('[Boot] App syntax error skipped from recovery:', src, msg);
    return;
  }
  console.error('[BOOT] Syntax error detected:', msg);
  triggerRecovery('syntax_error: ' + msg.slice(0, 100));
});

// Recovery is the Linux environment (/usr/sbin/astroos-recovery). init.js owns
// the handoff (NovaRecovery.request) because it has to work even when this
// file is the one that failed to parse; boot() only decides when to call it.
const SAFE_MODE_FILE = '/home/astroos/.config/novabyte/safe-mode';

function requestSystemRecovery(reason) {
  BootState.clearFlags('manualRecovery', 'showRecovery', 'forceRecovery', 'attempts');
  if (!window.NovaRecovery) {
    console.error('[BOOT] NovaRecovery missing; init.js did not load');
    return;
  }
  window.NovaRecovery.request(reason);
}

// recovery's "Start in safe mode" runs before the desktop exists, so all it
// can do is leave a file behind. Fold it into the normal safe-mode flag here.
function consumeSafeModeFile() {
  if (!window.NovaRecovery?.isAvailable()) return false;
  const fs = require('fs');
  if (!fs.existsSync(SAFE_MODE_FILE)) return false;
  try { fs.unlinkSync(SAFE_MODE_FILE); } catch { /* read-only profile: still honour it this boot */ }
  return true;
}

// ── Global Exports ─────────────────────────────────────────────────
window.boot = boot;
window.Boot = Boot; // expose namespace so plugins/forks can hook in

// Per-account desktop helpers: the SessionManager re-runs these after a
// login (mount sequence) so each account gets its launcher, desktop icons
// and autostart pass under its own mounted HKNU. Assigned inside boot()
// as well (launchAutostartApps is a boot() closure), so this stays valid
// whether or not boot() has run yet.
Object.defineProperty(Boot, 'startConfiguredHomeApp', {
  get: () => startConfiguredHomeApp,
  configurable: true,
});
Boot.launchAutostartApps = () => {}; // replaced by boot() with the closure
Object.defineProperty(Boot, 'reloadUserNovaApps', {
  get: () => reloadUserNovaApps,
  configurable: true,
});