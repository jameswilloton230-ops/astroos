const APP_REGISTRY = [];

      /* ── WebAppManager — persistent web app store ── */
      const WebAppManager = (() => {
        const STORAGE_KEY = 'nova_webapps';
        function load() {
          try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
        }
        function save(apps) { localStorage.setItem(STORAGE_KEY, JSON.stringify(apps)); }
        function genId() { return 'wa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
        return {
          getAllApps() { return load(); },
          getApp(id) { return load().find(a => a.id === id) || null; },
          addApp(data) {
            const apps = load();
            const app = { id: genId(), name: data.name || 'Web App', url: data.url || '', icon: data.icon || '🌐', addedAt: Date.now(), launchCount: 0 };
            apps.push(app); save(apps); return app;
          },
          saveApps(apps) { save(apps); },
          removeApp(id) { save(load().filter(a => a.id !== id)); },
          launchApp(id) {
            const apps = load();
            const idx = apps.findIndex(a => a.id === id);
            if (idx !== -1) { apps[idx].launchCount = (apps[idx].launchCount || 0) + 1; apps[idx].lastUsed = Date.now(); save(apps); }
          }
        };
      })();

      function registerApp(config) {
        OS.apps[config.id] = config;
        // Replace in place if this id is already registered — without this,
        // every hot-reload of an app module (js/apps/modules.js's reloadOne)
        // pushes a brand-new entry alongside the old one. OS.apps stays
        // correct either way (plain object keyed by id), but APP_REGISTRY
        // is what the launchpad/taskbar actually iterate, so duplicates
        // silently pile up there — one extra icon per reload — even though
        // the "live" app object itself was updated correctly.
        const existingIdx = APP_REGISTRY.findIndex(a => a.id === config.id);
        if (existingIdx !== -1) APP_REGISTRY[existingIdx] = config;
        else APP_REGISTRY.push(config);
      }

      /* ── Shared web app launch/removal — single source of truth ──
       * There used to be two independent "launch a web app" implementations
       * (the App Manager package and system-events.js) plus two more code paths that
       * opened a web app window without building one at all (desktop
       * shortcut double-click, taskbar pin click). Only the App Manager package
       * version worked, because WM.createWindow() only renders content for
       * an app if OS.apps[id].init() is defined — the other paths built (or
       * tried to build) the <webview> by hand after the fact, which either
       * never ran again on a later open, or never ran at all. Centralizing
       * on one helper that always sets .init() means every entry point
       * (Open buttons, launchpad click, desktop dblclick, taskbar click,
       * taskbar pin-without-launch) renders correctly.
       */
      function buildWebAppEntry(waData) {
        return {
          name: waData.name,
          icon: waData.icon,
          defaultSize: [900, 640],
          minSize: [400, 300],
          init(c, state) {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;';
            const urlBar = document.createElement('div');
            urlBar.style.cssText = 'background:rgba(0,0,0,0.22);border-bottom:1px solid rgba(255,255,255,0.07);padding:5px 12px;font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;flex-shrink:0;';
            try {
              urlBar.textContent = '\uD83D\uDD12 ' + new URL(waData.url).host;
            } catch {
              urlBar.textContent = 'External Web App';
            }
            wrapper.appendChild(urlBar);
            c.style.padding = '0';
            c.appendChild(wrapper);

            const GUEST_STYLE = 'flex:1;border:none;background:#fff;';
            const service = window.NovaSystemWebview;
            const waKey = typeof waData.id === 'string' && waData.id
              ? waData.id.replace(/[^a-zA-Z0-9_-]/g, '_')
              : null;
            if (waKey && typeof service?.createTrustedGuest === 'function') {
              // Own partition per web app so one site's cookies and storage
              // can't be read by another web app or by the shell itself.
              const guest = service.createTrustedGuest(
                { id: 'com.astroos.service.registry', system: true },
                {
                  parent: wrapper,
                  guestId: waKey,
                  partition: 'persist:webapp_' + waKey,
                  sandbox: null,
                  allowFullscreen: false,
                  style: GUEST_STYLE,
                }
              );
              guest.navigate(waData.url);
              if (Array.isArray(state?.cleanups)) state.cleanups.push(() => guest.destroy());
              return;
            }

            // Service not loaded: keep the old behaviour.
            const iframe = document.createElement('webview');
            iframe.style.cssText = GUEST_STYLE;
            iframe.src = waData.url;
            wrapper.appendChild(iframe);
          }
        };
      }

      // Ensures OS.apps['webapp_'+id] exists (building it from the persisted
      // WebAppManager record if needed — e.g. after a reload, or when a web
      // app was pinned to the taskbar/desktop without ever being launched)
      // and opens a window for it. Returns the window, or null if the web
      // app no longer exists in WebAppManager (e.g. it was removed).
      function openWebApp(waId) {
        const waData = WebAppManager.getApp(waId);
        if (!waData) return null;
        const appId = 'webapp_' + waId;
        OS.apps[appId] = buildWebAppEntry(waData);
        WebAppManager.launchApp(waId);
        return WM.createWindow(appId);
      }

      // Fully removes a web app: persisted record, taskbar pin, in-memory
      // OS.apps entry, and any desktop .lnk shortcut pointing at it. Reused
      // by the Web Apps tab's Remove button, the launchpad right-click
      // "Remove Web App" item, and the desktop shortcut's right-click
      // "Remove Web App" item, so all three clean up identically instead of
      // each doing (or forgetting to do) part of the job.
      async function removeWebApp(waId) {
        const appId = 'webapp_' + waId;
        WebAppManager.removeApp(waId);

        // Close any window still open for this web app before its OS.apps
        // entry and pin/shortcut state are deleted out from under it — same
        // gap as unregisterApp() had for .novaapp packages.
        if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
          const openWindowIds = [];
          for (const [wid, wstate] of OS.windows) {
            if (wstate.appId === appId) openWindowIds.push(wid);
          }
          for (const wid of openWindowIds) WM.closeWindow(wid);
        }

        delete OS.apps[appId];
        OS.settings.set('pinnedApps', (OS.settings.get('pinnedApps') || []).filter(id => id !== appId));
        try {
          const desktopFolder = FS.specialFolders?.desktop;
          if (desktopFolder) {
            const files = FS.listDir(desktopFolder);
            for (const f of files) {
              if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
                try {
                  const data = JSON.parse(f.content || '{}');
                  if (data?.type === 'app-shortcut' && data?.target === appId) {
                    await FS.permanentDelete(f.id);
                  }
                } catch { /* skip invalid shortcuts */ }
              }
            }
          }
        } catch (err) {
          console.warn('[WebApp] Failed to clean up desktop shortcut for', waId, err);
        }
        if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      }

      // ── Global URL opener — routes links through the user's OS default ──
      OS.openUrl = function (rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
        let url;
        try {
          url = new URL(rawUrl);
        } catch {
          return null;
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        // Block localhost / private / loopback addresses at the OS level too.
        if (typeof isLocalAddress === 'function' && isLocalAddress(url.href)) return null;

        const fallbackAppId = 'com.astroos.browser';
        const appId = typeof DefaultApps !== 'undefined' && typeof DefaultApps.resolveHandler === 'function'
          ? DefaultApps.resolveHandler({ protocol: url.protocol.slice(0, -1) }, fallbackAppId)
          : fallbackAppId;
        return WM.createWindow(appId, { url: url.href });
      };

      // ── Parse mailto: URIs into compose-prefill objects ─────────────────
      function parseMailto(url) {
        try {
          const noScheme = url.replace(/^mailto:/i, '');
          const [toRaw = '', queryRaw = ''] = noScheme.split('?');
          const params = new URLSearchParams(queryRaw);
          return {
            to:      decodeURIComponent(toRaw),
            subject: params.get('subject') || '',
            body:    params.get('body')    || '',
            cc:      params.get('cc')      || '',
            bcc:     params.get('bcc')     || '',
          };
        } catch { return {}; }
      }

      // ── Opens email compose — overridden by email app when it is running ──
      OS.openMailto = function (url) {
        if (!url) return;
        WM.createWindow('com.astroos.email', { compose: parseMailto(url) });
      };

      // Intercept <a> clicks anywhere in the AstroOS UI
      document.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        if (/^(javascript|data|vbscript):/i.test(href.trim())) return;
        if (href.match(/^https?:\/\//i)) {
          e.preventDefault();
          e.stopPropagation();
          OS.openUrl(href);
        } else if (/^mailto:/i.test(href.trim())) {
          e.preventDefault();
          e.stopPropagation();
          OS.openMailto(href);
        }
      }, true);

      // Prevent NW.js from opening external links in a new NW.js window
      if (typeof nw !== 'undefined') {
        nw.Window.get().on('new-win-policy', (frame, url, policy) => {
          if (url.match(/^https?:\/\//i)) {
            policy.ignore();
            OS.openUrl(url);
          } else if (/^mailto:/i.test(url)) {
            policy.ignore();
            OS.openMailto(url);
          }
        });
      }


window.APP_REGISTRY = APP_REGISTRY;
window.WebAppManager = WebAppManager;
window.registerApp = registerApp;
window.buildWebAppEntry = buildWebAppEntry;
window.openWebApp = openWebApp;
window.removeWebApp = removeWebApp;



/* Exposed to Global Scope for Flat-Module Architecture */