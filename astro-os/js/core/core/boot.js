// ── Static Configurations & Constants ──────────────────────────────
const BOOT_TIMEOUT_MS = 15000;
const BOOT_THRESHOLD  = 5;

const KEYS = Object.freeze({
  TIMEOUT       : 'nova_boot_timeout_flag',
  FORCE         : 'nova_force_recovery',
  ATTEMPTS      : 'nova_boot_attempts',
  SAFE_MODE     : 'nova_safe_mode',
  MANUAL_REC    : 'nova_manual_recovery',
  SHOW_REC      : 'nova_show_recovery',
  INSTALLED_APPS: 'nova_installed_apps',
  OS_VERSION    : 'novabyte_os_version',
});

const WALLPAPER_PRESETS = Object.freeze({
  'stock-blue'  : '#0f0f0f',
  'stock-dark'  : 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)',
  'stock-light' : 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)',
  'stock-green' : 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)',
  'stock-purple': 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)',
  'stock-red'   : 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)',
  'stock-gray'  : 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)',
  'stock-teal'  : 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)',
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

  /**
   * @private
   * Set up the stuck-boot watchdog timer.
   * @returns {{ complete: Function }} Call complete() when boot finishes normally.
   */
  _setupWatchdog(bootStartTime, uaShort) {
    Storage.set(KEYS.TIMEOUT, { start: bootStartTime, completed: false });

    const id = setTimeout(() => {
      const td = Storage.get(KEYS.TIMEOUT, {});
      if (!td.completed) {
        console.error('[BOOT] Stuck — timeout detected');
        Storage.set(KEYS.TIMEOUT, { start: bootStartTime, completed: false, stuck: true });
        localStorage.setItem(KEYS.FORCE, '1');
        Storage.set(KEYS.ATTEMPTS, [
          { ts: bootStartTime + BOOT_TIMEOUT_MS - 2000, reason: 'boot_timeout_1', ua: uaShort },
          { ts: bootStartTime + BOOT_TIMEOUT_MS,        reason: 'boot_timeout_2', ua: uaShort },
        ]);
        location.reload();
      }
    }, BOOT_TIMEOUT_MS);

    return {
      complete() {
        clearTimeout(id);
        const td = Storage.get(KEYS.TIMEOUT, {});
        td.completed = true;
        Storage.set(KEYS.TIMEOUT, td);
        Storage.remove(KEYS.FORCE);
      },
    };
  },

  /** @private Mirror OS.settings writes to VFS after subsystem init. */
  _patchSettingsSet() {
    const _orig = OS.settings.set.bind(OS.settings);
    let _prefsFileId = null; // cached after first successful lookup
    OS.settings.set = function settingSet(key, value) {
      _orig(key, value);
      const folderId = AppDirs.getVFSDir('com.nbosp.settings', 'shared_prefs');
      if (!folderId) return;
      const content = JSON.stringify(OS.settings._cache, null, 2);
      if (_prefsFileId) {
        FS.writeFile(_prefsFileId, content).catch(() => {});
      } else {
        const existing = FS.listDir(folderId).find(f => f.name === 'prefs.json' && f.type === 'file');
        if (existing) {
          _prefsFileId = existing.id;
          FS.writeFile(_prefsFileId, content).catch(() => {});
        } else {
          FS.createFile(folderId, 'prefs.json', content, 'application/json')
            .then(f => { if (f?.id) _prefsFileId = f.id; })
            .catch(() => {});
        }
      }
    };
  },

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
    OS.workers.fs     = createWorker(FS_WORKER_CODE);
    OS.workers.search = createWorker(SEARCH_WORKER_CODE);
    OS.workers.crypto = createWorker(CRYPTO_WORKER_CODE);

    // fs must init before the rest depend on it
    await OS.workers.fs.call('init');

    await OS.settings.load().then(() => {
      if (isSafeMode && typeof OS.settings.applySafeModeDefaults === 'function') {
        OS.settings.applySafeModeDefaults();
      }
    });

    await FS.init();
    await AppDirs.bootstrap();
    await OPFS.init();

    window.__NB_RUNTIME.ready = true;
    Boot._patchSettingsSet();
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
    const iconSize   = sGet('desktopIconSize');
    const gridSpace  = sGet('desktopGridSpacing');
    const tbSize     = sGet('taskbarSize');
    if (iconSize)  cssBatch.push(['--desktop-icon-size',    iconSize  + 'px']);
    if (gridSpace) cssBatch.push(['--desktop-grid-spacing', gridSpace + 'px']);
    if (tbSize) {
      const h = { compact: '36px', normal: '48px', large: '64px' }[tbSize];
      if (h) cssBatch.push(['--taskbar-height', h]);
    }
    if (sGet('reduceMotion')) cssBatch.push(['--anim-speed', '0.001']);
    if (cssBatch.length) setCSSVars(rootStyle, cssBatch);
  },

  /**
   * Apply desktop wallpaper — custom image or a named preset.
   * @param {Function} sGet
   */
  applyWallpaper(sGet) {
    const { desktop } = Boot._dom;
    if (!desktop) return;

    const customBg = sGet('customWallpaper');
    if (customBg) {
      const s = desktop.style;
      s.backgroundImage    = `url(${customBg})`;
      s.backgroundSize     = 'cover';
      s.backgroundPosition = 'center';
      s.backgroundRepeat   = 'no-repeat';
    } else {
      desktop.style.backgroundImage =
        WALLPAPER_PRESETS[sGet('wallpaperId')] ?? WALLPAPER_PRESETS['stock-blue'];
    }
  },

  /**
   * Apply accessibility settings: high contrast and reduce motion.
   * @param {Function} sGet
   */
  applyAccessibility(sGet) {
    const { rootClasses } = Boot._dom;
    if (sGet('highContrast')) rootClasses.add('no-glass');
    if (sGet('reduceMotion')) {
      rootClasses.add('reduce-motion');
      const wpEl = document.getElementById('wallpaper');
      if (wpEl) wpEl.style.animation = 'none';
    }
  },

  /**
   * Apply cursor size scaling to desktop icons via an injected style tag.
   * @param {Function} sGet
   */
  applyCursorSize(sGet) {
    const cursorSize = sGet('cursorSize');
    if (!cursorSize) return;

    let st = document.getElementById('cursor-custom-styles');
    if (!st) {
      st = document.createElement('style');
      st.id = 'cursor-custom-styles';
      document.head.appendChild(st);
    }
    const t = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
    st.textContent = `#desktop .desktop-icon{transform:${t[cursorSize] ?? t.normal}}`;
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
    const { taskbar } = Boot._dom;
    if (!taskbar) return;

    const tbPos = sGet('taskbarPosition') || 'bottom';

    taskbar.classList.remove('taskbar-top', 'taskbar-left', 'taskbar-right');
    if (tbPos !== 'bottom') {
      taskbar.classList.add('taskbar-' + tbPos);
    }

    if (sGet('taskbarAutoHide')) {
      taskbar.classList.add('taskbar-autohide');
      if (!window.__tbProximityInit) {
        window.__tbProximityInit = true;
        document.addEventListener('mousemove', (e) => {
          if (!taskbar.classList.contains('taskbar-autohide')) return;
          taskbar.classList.toggle('taskbar-ah-shown', e.clientY >= window.innerHeight - 8);
        }, { passive: true });
      }
    }
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
    updateNotificationBadge();

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

  // 1. Watchdog ────────────────────────────────────────────────────
  const forceRecovery = Storage.checkFlag(KEYS.FORCE);
  const watchdog      = Boot._setupWatchdog(bootStartTime, uaShort);

  // 2. Recovery Routing ────────────────────────────────────────────
  const isManualRecovery = Storage.checkFlag(KEYS.MANUAL_REC) || Storage.checkFlag(KEYS.SHOW_REC);
  if (isManualRecovery || forceRecovery) {
    Storage.removeAll(KEYS.MANUAL_REC, KEYS.SHOW_REC, KEYS.FORCE);
    showRecoveryScreen(forceRecovery ? Storage.get(KEYS.ATTEMPTS, []) : []);
    watchdog.complete();
    return;
  }

  // 3. Attempt Tracking ────────────────────────────────────────────
  const priorAttempts = Storage.get(KEYS.ATTEMPTS, []);
  const isSafeMode    = Storage.checkFlag(KEYS.SAFE_MODE);

  if (priorAttempts.length >= BOOT_THRESHOLD && !isSafeMode) {
    showRecoveryScreen(priorAttempts);
    watchdog.complete();
    return;
  }

  // Track this attempt — cleared immediately on subsystem success (not at end of boot)
  // so that rapid dev restarts don't accumulate toward the threshold.
  priorAttempts.push({ ts: Date.now(), ua: uaShort });
  if (priorAttempts.length > 10) priorAttempts.shift();
  Storage.set(KEYS.ATTEMPTS, priorAttempts);

  function markBootSuccess() {
    Storage.removeAll(KEYS.ATTEMPTS, KEYS.FORCE);
    watchdog.complete();
    document.body.classList.add('os-booted');
    document.getElementById('recovery-screen')?.classList.remove('active');
  }

  // 4. Safe Mode ───────────────────────────────────────────────────
  if (isSafeMode) {
    Storage.remove(KEYS.SAFE_MODE);
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

  // Subsystems initialised cleanly — this is not a crash loop. Clear attempts now
  // so a subsequent fast restart doesn't accumulate toward the threshold.
  Storage.remove(KEYS.ATTEMPTS);

  // 7. Settings & UI ───────────────────────────────────────────────
  const sGet = Boot.applyOSVars();
  Boot.applyThemeAndVars(sGet);
  Boot.applyWallpaper(sGet);
  Boot.applyAccessibility(sGet);
  Boot.applyCursorSize(sGet);
  Boot.syncVersion(sGet);
  Boot.configureTaskbar(sGet);
  Boot.initScreenReader();
  Boot.startServices();

  // 8. Deferred Non-Critical Work ──────────────────────────────────
  const scheduleIdle = window.requestIdleCallback
    ? (fn) => requestIdleCallback(fn, { timeout: 3000 })
    : (fn) => setTimeout(fn, 0);
  scheduleIdle(() => {
    loadInstalledNovaApps().catch(e => console.error('[BOOT] Failed to load installed Nova apps:', e));
  });

  // 9. Finalize ────────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 800));
  bootScreen.classList.add('fade-out');

  await new Promise(r => setTimeout(r, 400));
  bootScreen.style.display = 'none';
  markBootSuccess();
  WM.updateTaskbar();

  if (OS.lockPin) {
    lockScreen();
  } else {
    renderDesktopIcons();
  }

  // 10. Post-boot Hooks ────────────────────────────────────────────
  Boot._runHooks('after');
}

// ── App Loader ─────────────────────────────────────────────────────
/**
 * Re-register any .novaapp packages the user has previously installed.
 * Called at idle time after boot — safe to call manually if needed.
 */
  function registerWithFiles(appData) {
    let icon = appData.icon || 'box';
    if (icon && !/^data:|^https?:\/\//i.test(icon) && appData.files?.[icon]) {
      const encoded = appData.files[icon];
      const ext = (icon.split('.').pop() || '').toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : ext === 'ico' ? 'image/x-icon'
        : 'image/png';
      icon = `data:${mime};base64,${encoded}`;
    }

    const cfg = {
      id: appData.id,
      name: appData.name,
      icon,
      description: appData.description || '',
      defaultSize: appData.defaultSize || [800, 560],
      minSize: appData.minSize || [400, 300],
      minSecurityPatch: appData.minSecurityPatch || null,
      permissions: appData.permissions || [],
      optionalPermissions: appData.optionalPermissions || [],
      async init(contentEl) {
        const _requiredPerms = appData.permissions || [];
        const _optionalPerms = appData.optionalPermissions || [];
        const _allDangerous  = [..._requiredPerms, ..._optionalPerms];
        if (_allDangerous.length > 0 && typeof AppPermissionManager !== 'undefined') {
          const _mgr     = AppPermissionManager;
          const _missing = _allDangerous.filter(p =>
            !_mgr.isGranted(p, appData.id) && !(_mgr.isDenied && _mgr.isDenied(p, appData.id))
          );
          if (_missing.length > 0) {
            await _mgr.requestAll(_missing, appData.id, appData.name || appData.id);
          }
        }

        const entryKey = appData.entry || 'index.html';
        const rawEntry = appData.files?.[entryKey];
        if (!rawEntry) {
          contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>';
          return;
        }
        let html;
        try {
          html = decodeURIComponent(
            atob(rawEntry).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
          );
        } catch (e) {
          contentEl.innerHTML = `<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ${e.message}</div>`;
          return;
        }

        if (!appData._cachedHtml) appData._cachedHtml = html;

        const shimmedFiles = Object.assign({}, appData.files);
        shimmedFiles[entryKey] = btoa(
          encodeURIComponent(html).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        );

        const origin = (typeof window.location !== 'undefined' && window.location.origin)
          ? window.location.origin
          : 'http://127.0.0.1:3006';

        const sandboxId = 'sandbox_' + appData.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now();
        let baseUrl = '/api/apps/serve/' + sandboxId + '/';
        let webview;
        try {
          const regRes = await fetch('/api/apps/serve/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sandboxId, files: shimmedFiles })
          });
          if (!regRes.ok) throw new Error('serve register failed: ' + regRes.status);
          const regData = await regRes.json();
          baseUrl = regData.baseUrl || baseUrl;
          const encodedEntry = String(entryKey).split('/').map(encodeURIComponent).join('/');
          const serveBaseUrl = String(baseUrl).replace(/\/+$/, '');
          const url = origin + serveBaseUrl + '/' + encodedEntry;

          webview = createEl('webview', {
            src    : url,
            style  : 'width:100%;height:100%;border:none;display:block;'
          });
          if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
            FrameSecurity.securifyFrame(webview);
          }
          webview.dataset.novaServed = '1';
        } catch (e) {
          console.error('[NovaApp] serve-register failed for', appData.id, 'falling back to blob:', e);
          try {
            const blob = new Blob([html], { type: 'text/html' });
            const blobUrl = URL.createObjectURL(blob);
            webview = createEl('webview', {
              src    : blobUrl,
              style  : 'width:100%;height:100%;border:none;display:block;'
            });
            if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
              FrameSecurity.securifyFrame(webview);
            }
            webview.dataset.novaBlobUrl = blobUrl;
          } catch (blobErr) {
            contentEl.innerHTML = `<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ${blobErr.message}</div>`;
            return;
          }
        }

        webview.addEventListener('did-fail-load', (e) => {
          console.error('[NovaApp] webview load failed', appData.id, (typeof serveBaseUrl === 'string' ? serveBaseUrl : baseUrl) + '/' + (typeof encodedEntry === 'string' ? encodedEntry : entryKey), e);
        });
        webview.addEventListener('did-finish-load', () => {
          console.log('[NovaApp] webview loaded', appData.id);
        });
        contentEl.style.padding = '0';
        contentEl.appendChild(webview);
      },
    };

    OS.apps[appData.id] = cfg;
    const ri = APP_REGISTRY.findIndex(app => app.id === appData.id);
    if (ri > -1) APP_REGISTRY[ri] = cfg;
    else APP_REGISTRY.push(cfg);
  }

  async function loadInstalledNovaApps() {
    const storedApps = Storage.get(KEYS.INSTALLED_APPS, []);
    const apps = window.NovaAppPackageStore?.hydrateApps
      ? await NovaAppPackageStore.hydrateApps(storedApps)
      : storedApps;

    for (let i = 0; i < apps.length; i++) {
      const appData = apps[i];
      if (OS.apps[appData.id]) continue;
      if (!appData.files) {
        console.warn('[BOOT] Installed package files missing for', appData.id);
        continue;
      }
      registerWithFiles(appData);
    }
  }

// ── Global Exports ─────────────────────────────────────────────────
window.boot = boot;
window.Boot = Boot; // expose namespace so plugins/forks can hook in