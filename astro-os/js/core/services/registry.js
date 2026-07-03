
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
        APP_REGISTRY.push(config);
      }

      // ── Global URL opener — routes all links to com.nbosp.browser ──────
      OS.openUrl = function (url) {
        if (!url) return;
        if (/^(javascript|data|vbscript):/i.test(url.trim())) return;
        // Block localhost / private / loopback addresses at the OS level too
        if (typeof isLocalAddress === 'function' && isLocalAddress(url)) return;
        WM.createWindow('browser', { url });
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
        WM.createWindow('nbosp-email', { compose: parseMailto(url) });
      };

      // Intercept <a> clicks anywhere in the NovaByte UI
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



/* Exposed to Global Scope for Flat-Module Architecture */


