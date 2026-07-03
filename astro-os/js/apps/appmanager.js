registerApp({
  id: 'app-manager',
  name: 'App Manager',
  icon: 'package',
  description: 'Install, manage, and customise .novaapp packages and web apps',
  defaultSize: [980, 640],
  minSize: [720, 480],
  async init(content) {
    // ── NovaByte runtime guard — refuses to launch without AppDirs ──
    if (!window.AppDirs?.getVFSDir('com.nbosp.appmanager', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">\u26A0\uFE0F</div><div style="font-size:14px;text-align:center"><b>com.nbosp.appmanager</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    const APPS_KEY = 'nova_installed_apps';
    const LOG_KEY = 'nova_appmanager_log';

    // ── AbortController for clean teardown of all listeners ──
    const ac = new AbortController();
    const listenerOpts = { signal: ac.signal };

    // ── Helpers ────────────────────────────────────────────────────
    const PackageStore = window.NovaAppPackageStore || null;

    // Builds the CSP injected into sandboxed app HTML. Only the webapp
    // template needs frame-src — everything else gets none, since no other
    // template embeds external content. We validate appData.url rather than
    // trusting it outright: it's written by the app's own creator (or by
    // hand-editing manifest.json), not vetted, so a malformed or javascript:
    // value here must not end up unescaped inside an HTML attribute.
    function buildSandboxCSP(appData) {
      const base = "default-src 'self' blob: data: 'unsafe-inline' 'unsafe-eval'; " +
        "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline' blob: data:; " +
        "img-src 'self' blob: data: https:; " +
        "font-src 'self' blob: data:; " +
        "connect-src 'self' http://localhost:* https://localhost:*";

      let frameSrc = '';
      if (appData?.url) {
        try {
          const parsed = new URL(appData.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            // Scope to exactly this app's declared origin — not a wildcard —
            // so one app can't use this allowance to frame arbitrary sites.
            frameSrc = '; frame-src ' + parsed.origin;
          } else {
            console.warn('[AppManager] app declares non-http(s) url, ignoring for frame-src:', appData.url);
          }
        } catch (e) {
          console.warn('[AppManager] app declares invalid url, ignoring for frame-src:', appData.url);
        }
      }

      const escaped = (base + frameSrc).replace(/"/g, '&quot;');
      return '<meta http-equiv="Content-Security-Policy" content="' + escaped + '">\n';
    }

    function resolveIcon(app) {
      if (!app?.icon || typeof app.icon !== 'string') return null;
      if (/^data:|^https?:\/\//i.test(app.icon)) return app.icon;
      const files = app.files || app._files || {};
      const encoded = files[app.icon];
      if (encoded && typeof encoded === 'string') {
        const ext = (app.icon.split('.').pop() || '').toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'ico' ? 'image/x-icon'
          : 'image/png';
        return `data:${mime};base64,${encoded}`;
      }
      return null;
    }

    async function getStoredApps() {
      try {
        const list = PackageStore?.loadRegistry
          ? PackageStore.loadRegistry()
          : JSON.parse(localStorage.getItem(APPS_KEY) || '[]');
        return PackageStore?.hydrateApps ? await PackageStore.hydrateApps(list) : list;
      } catch (e) {
        console.warn('[AppManager] Failed to load installed packages:', e);
        return [];
      }
    }

    function saveStoredApps(list) {
      try {
        if (PackageStore?.saveRegistry) {
          PackageStore.saveRegistry(list);
        } else {
          localStorage.setItem(APPS_KEY, JSON.stringify(list));
        }
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
          console.warn('[AppManager] localStorage quota exceeded while saving app metadata.');
        } else {
          console.warn('[AppManager] Failed to save installed app metadata:', e);
        }
      }
    }

    function getLog() {
      try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); }
      catch { return []; }
    }

    function pushLog(entry) {
      const log = getLog();
      log.unshift({ ...entry, ts: Date.now() });
      if (log.length > 200) log.length = 200;
      try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }
      catch { /* quota — discard oldest silently */ }
    }

    function getPinned() { return OS.settings.get('pinnedApps') || []; }
    function getDisabled() {
      try {
        const raw = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
        return raw.map(x => typeof x === 'string' ? x : x?.id).filter(Boolean);
      }
      catch { return []; }
    }
    function setDisabled(list) {
      try { localStorage.setItem('nova_disabled_apps', JSON.stringify(list)); }
      catch { /* quota */ }
    }
    function getBootApps() {
      try { return JSON.parse(localStorage.getItem('nova_boot_apps') || '[]'); }
      catch { return []; }
    }
    function setBootApps(list) {
      try { localStorage.setItem('nova_boot_apps', JSON.stringify(list)); }
      catch { /* quota */ }
    }

    // ── Text sanitisation: avoid innerHTML with user-controlled strings ──
    function escapeHtml(str) {
      const el = document.createElement('span');
      el.textContent = str;
      return el.innerHTML;
    }

    // ── URL host extraction (cached per URL string) ──
    const hostCache = new Map();
    function extractHost(urlStr) {
      if (hostCache.has(urlStr)) return hostCache.get(urlStr);
      let host = urlStr;
      try { host = new URL(urlStr).host; } catch { /* not a valid URL */ }
      hostCache.set(urlStr, host);
      return host;
    }

    // ── Debounced search input ──
    function debounce(fn, ms) {
      let timer = 0;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
      };
    }

    function buildNovaAppConfig(appData) {
      const appId = appData.id;

      function ensureAppVFS() {
        try {
          const vfsDir = window.AppDirs?.getVFSDir(appId, 'files');
          if (!vfsDir) console.warn('[AppManager] VFS dir missing for', appId, '— app will have no private storage');
          return vfsDir;
        } catch (e) {
          console.warn('[AppManager] VFS bootstrap failed for', appId, e);
          return null;
        }
      }

      return {
        id: appId,
        name: appData.name,
        icon: appData.icon || 'box',
        description: appData.description || '',
        defaultSize: appData.defaultSize || [800, 560],
        minSize: appData.minSize || [400, 300],
        minSecurityPatch: appData.minSecurityPatch || null,
        permissions: appData.permissions || [],
        optionalPermissions: appData.optionalPermissions || [],
        entry: appData.entry || 'index.html',
        files: appData.files || {},
        sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
        type: appData.type || 'package',

        async init(contentEl, state, options) {
          ensureAppVFS();
          console.log('[AM.init]', appId, 'AppSandbox?', typeof AppSandbox, 'FrameSecurity?', typeof FrameSecurity);

          // ── Permission gate (parent-side, before iframe loads) ──
          const requiredPerms = appData.permissions || [];
          const optionalPerms = appData.optionalPermissions || [];
          const allDangerous = [...requiredPerms, ...optionalPerms];

          if (allDangerous.length > 0 && typeof AppPermissionManager !== 'undefined') {
            const mgr = AppPermissionManager;
            // Only skip permissions that are already granted.
            // Denied permissions are intentionally NOT filtered here — requestPermission()
            // returns false for them immediately without re-prompting, which causes
            // requestAll() to return false, which blocks the app launch correctly.
            // Previously filtering out isDenied() here meant apps silently launched
            // with external network permission denied, then failed at fetch time.
            const missing = allDangerous.filter(p => !mgr.isGranted(p, appId));
            if (missing.length > 0) {
              const ok = await mgr.requestAll(missing, appId, appData.name || appId);
              if (!ok) {
                contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:var(--font-ui,sans-serif);color:var(--text-muted);font-size:13px;text-align:center;padding:24px;">\uD83D\uDD12<br><br>This app requires additional permissions to run.<br>Grant them in Settings \u2192 Apps and try again.</div>';
                return null;
              }
            }
          }

          if (typeof AppSandbox !== 'undefined' && typeof AppSandbox.launch === 'function') {
            const sandboxApp = {
              id: appId,
              name: appData.name,
              entry: appData.entry || 'index.html',
              files: appData.files || {},
              sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
              permissions: appData.permissions || [],
              optionalPermissions: appData.optionalPermissions || [],
              type: appData.type || 'package',
            };
            return AppSandbox.launch(sandboxApp, contentEl, state || {}, options || {});
          }

          // ── Private data shim injected into iframe ────────────
          const vfsDir = ensureAppVFS();
          const safeAppId = JSON.stringify(appId);
          const safeVfsDir = JSON.stringify(vfsDir);

          const bridgeScript = `(function(){
            try{
              if(!window.__novaPrivateStore) window.__novaPrivateStore={};
              var s=window.__novaPrivateStore;
              s.appId=${safeAppId};
              s.vfsDir=${safeVfsDir};
              s.getVFSDir=function(){return ${safeVfsDir}};
              s.lsKey=function(k){return'nova_app_'+${safeAppId}+'_'+k};
              s.get=function(k){try{var v=localStorage.getItem(this.lsKey(k));return v?JSON.parse(v):null}catch{return null}};
              s.set=function(k,v){try{localStorage.setItem(this.lsKey(k),JSON.stringify(v))}catch{/*quota*/}};
              s.del=function(k){localStorage.removeItem(this.lsKey(k))};
            }catch(e){console.warn('[NovaAppBridge] init failed:',e)}
          })();`;

          const bridgeStyle = '<style>#nv-bridge-shim{display:none}</style>';
          const bridgeScriptTag = '<script id="nv-bridge-shim">' + bridgeScript + '<\/script>';

          const entryKey = appData.entry || 'index.html';
          const entryB64 = appData.files?.[entryKey];

          if (!entryB64) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>';
            return;
          }

          // ── Blob URL tracking for memory cleanup ──
          let blobUrl = null;

          try {
            let html = decodeURIComponent(escape(atob(entryB64)));
            let pkgData = null;

            // ── SECURITY: Removed require('vm').runInThisContext() — this executes
            //    arbitrary untrusted code in the main context, equivalent to eval().
            //    Obfuscated packages that aren't valid JSON are now rejected outright. ──
            if (appData.verified === false || appData._wasObfuscated) {
              console.warn('[AppManager] Obfuscated/unverified package detected — skipping unsafe VM execution for', appId);
              pkgData = null;
            }

            if (pkgData && !appData.manifest) {
              appData.manifest = pkgData;
              appData.name = appData.name || pkgData.name || appData.id;
              appData.description = appData.description || pkgData.description || '';
              appData.icon = appData.icon || pkgData.icon || 'box';
              appData.defaultSize = appData.defaultSize || pkgData.defaultSize || [800, 560];
              appData.minSize = appData.minSize || pkgData.minSize || [400, 300];
            }

            const sandboxId = 'sandbox_' + appId.replace(/\./g, '_') + '_' + Date.now();

            // ── Attempt sandboxed serve via API ──
            let serveFailed = false;
            try {
              const shimmedFiles = Object.assign({}, appData.files);
              let serveHtml = html;
              const relaxed = buildSandboxCSP(appData);
              const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
              if (!/<head[\s>]/i.test(serveHtml)) {
                serveHtml = inline + '\n' + relaxed + '\n' + serveHtml;
              } else {
                serveHtml = serveHtml.replace(/<head(\s[^>]*)?>/i, function(m){return m+"\n"+relaxed+inline});
              }
              console.log('[AppManager] shim injected, len now:', serveHtml.length, 'has shim marker:', serveHtml.includes('__novaPrivateStore'));
              shimmedFiles[entryKey] = btoa(
                encodeURIComponent(serveHtml).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
              );

              const regRes = await fetch('/api/apps/serve/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sandboxId, files: shimmedFiles })
              });

              if (regRes.ok) {
                const regData = await regRes.json();
                console.log('[AppManager] serve registered, baseUrl:', regData.baseUrl);
                const webview = createEl('webview', {
                  src: window.location.origin + regData.baseUrl + '/' + entryKey,
                  style: 'width:100%;height:100%;border:none;display:block;'
                });

                if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
                  FrameSecurity.securifyFrame(webview);
                }

                contentEl.style.padding = '0';
                contentEl.appendChild(webview);

                webview.addEventListener('load', () => {
                  if (pkgData) {
                    try {
                      // SECURITY: Use specific origin instead of '*' for postMessage
                      const origin = new URL(webview.src).origin;
                      webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                    } catch (_e) { /* cross-origin — expected */ }
                  }
                }, { once: true, signal: ac.signal });

                return;
              }
              serveFailed = true;
            } catch (_regErr) {
              serveFailed = true;
            }

            // ── Fallback: inline HTML with blob URL ──
            console.log('[AppManager] serve failed, falling back to blob URL');
            let wrappedHtml = html
              .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
              .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '');

            for (const [relPath, raw] of Object.entries(appData.files)) {
              if (relPath === entryKey || !raw || typeof raw !== 'string') continue;
              const lower = relPath.toLowerCase();
              let tag = null;
              if (lower.endsWith('.css')) {
                tag = '<style data-ninline>\n' + raw + '\n</style>';
              } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
                tag = '<script data-ninline>\n' + raw + '\n<\/script>';
              }
              if (!tag) continue;
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + tag);
            }

            const relaxed = buildSandboxCSP(appData);
            const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
            if (!/<head[\s>]/i.test(wrappedHtml)) {
              wrappedHtml = inline + '\n' + relaxed + '\n' + wrappedHtml;
            } else {
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + inline);
            }
            wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + bridgeScriptTag);

            const blob = new Blob([wrappedHtml], { type: 'text/html' });
            blobUrl = URL.createObjectURL(blob);
            const webview = createEl('webview', {
              src: blobUrl,
              style: 'width:100%;height:100%;border:none;display:block;'
            });

            if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
              FrameSecurity.securifyFrame(webview);
            }

            contentEl.style.padding = '0';
            contentEl.appendChild(webview);

            // ── Revoke blob URL after load to free memory ──
            webview.addEventListener('load', () => {
              if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
              if (pkgData) {
                try {
                  const origin = new URL(webview.src).origin;
                  webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                } catch (_e) { /* cross-origin */ }
              }
            }, { once: true, signal: ac.signal });

          } catch (e) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ' + escapeHtml(e.message) + '</div>';
          }
        }
      };
    }

    function registerNovaApp(appData) {
      if (!appData?.files) {
        console.warn('[AppManager] Package files missing for', appData?.id, '- app was not registered');
        return;
      }

      if (appData.icon && !/^data:|^https?:\/\//i.test(appData.icon) && appData.files[appData.icon]) {
        const encoded = appData.files[appData.icon];
        const ext = (appData.icon.split('.').pop() || '').toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'ico' ? 'image/x-icon'
          : 'image/png';
        appData = { ...appData, icon: `data:${mime};base64,${encoded}` };
      }

      const cfg = buildNovaAppConfig(appData);
      OS.apps[appData.id] = cfg;
      const ri = APP_REGISTRY.findIndex(a => a.id === appData.id);
      if (ri > -1) APP_REGISTRY[ri] = cfg;
      else APP_REGISTRY.push(cfg);
    }

    let installedApps = await getStoredApps();
    installedApps.forEach(a => registerNovaApp(a));

    // ── Shared state ───────────────────────────────────────────────
    let activeTab = 'packages';
    let selectedPkgId = null;

    // ── Root layout ────────────────────────────────────────────────
    content.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;height:100%;';

    // ── Tab bar ────────────────────────────────────────────────────
    const tabBar = createEl('div', {
      style: 'display:flex;align-items:center;gap:2px;padding:10px 14px 0;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
    });

    const TABS = [
      { id: 'packages', label: 'Packages', icon: 'package' },
      { id: 'webapps', label: 'Web Apps', icon: 'globe' }
    ];
    const tabBtns = {};

    TABS.forEach(t => {
      const btn = createEl('button', {
        style: 'display:flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:10px 10px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.12s;background:none;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-1px;'
      });
      btn.innerHTML = svgIcon(t.icon, 13) + ' ' + t.label;
      btn.dataset.tab = t.id;
      btn.addEventListener('click', () => switchTab(t.id), listenerOpts);
      tabBar.appendChild(btn);
      tabBtns[t.id] = btn;
    });
    content.appendChild(tabBar);

    function refreshTabStyles() {
      for (const btn of Object.values(tabBtns)) {
        const active = btn.dataset.tab === activeTab;
        btn.style.color = active ? 'var(--text-primary)' : 'var(--text-muted)';
        btn.style.background = active ? 'var(--bg-elevated)' : 'none';
        btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
      }
    }

    const body = createEl('div', { style: 'flex:1;display:flex;overflow:hidden;' });
    content.appendChild(body);

    function switchTab(id) {
      activeTab = id;
      refreshTabStyles();
      body.innerHTML = '';
      if (id === 'packages') renderPackagesPanel();
      else renderWebAppsPanel();
    }

    // ══════════════════════════════════════════════════════════════
    // PACKAGES PANEL
    // ══════════════════════════════════════════════════════════════
    function renderPackagesPanel() {
      const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

      // ── Sidebar ────────────────────────────────────────────────
      const sidebar = createEl('div', {
        style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
      });

      // Toolbar: search + install
      const toolbar = createEl('div', { style: 'padding:10px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
      const searchEl = createEl('input', {
        type: 'text', id: 'app-installer-search-input', name: 'app-installer-search',
        placeholder: 'Search\u2026',
        style: 'flex:1;padding:5px 9px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;'
      });
      const installBtn = createEl('button', {
        style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;'
      });
      installBtn.innerHTML = svgIcon('plus', 12) + ' Install';
      toolbar.append(searchEl, installBtn);
      sidebar.appendChild(toolbar);

      const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:6px;' });
      sidebar.appendChild(listEl);

      // ── Detail panel ───────────────────────────────────────────
      const detail = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

      // Hidden file input
      const fileInput = createEl('input', {
        type: 'file', accept: '.novaapp', id: 'app-install-input', name: 'app-install', style: 'display:none;'
      });
      fileInput.addEventListener('change', e => {
        if (e.target.files[0]) processFile(e.target.files[0]);
        fileInput.value = '';
      }, listenerOpts);
      root.appendChild(fileInput);
      installBtn.addEventListener('click', () => fileInput.click(), listenerOpts);

      // ── Use disabled Set for O(1) lookups instead of Array.includes ──
      function renderList() {
        listEl.innerHTML = '';
        const q = searchEl.value.trim().toLowerCase();
        const disabledSet = new Set(getDisabled());
        let visible = installedApps;

        if (q) {
          visible = visible.filter(a =>
            a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
          );
        }

        // Sort only visible items (not the source array)
        const sorted = [...visible].sort((a, b) => a.name.localeCompare(b.name));

        if (!sorted.length) {
          const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.8;' });
          msg.innerHTML = q
            ? '<div style="font-size:13px;">No apps match.</div>'
            : '<div style="font-size:32px;margin-bottom:10px;">\uD83D\uDCE6</div><div style="font-size:12px;">No packages installed.<br>Click <strong style="color:var(--text-primary);">Install</strong> or drop a <code style="color:var(--accent);">.novaapp</code> file.</div>';
          listEl.appendChild(msg);
          return;
        }

        // ── Build list with DocumentFragment for batch DOM write ──
        const fragment = document.createDocumentFragment();

        sorted.forEach(app => {
          const isSel = app.id === selectedPkgId;
          const isDis = disabledSet.has(app.id);
          const item = createEl('div', {
            style: `display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}`
          });
          const iconWrap = createEl('div', {
            style: `width:34px;height:34px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};`
          });
          const iconSrc = resolveIcon(app);
          if (iconSrc) {
            const _img = createEl('img', { src: iconSrc, draggable: 'false', style: 'width:100%;height:100%;object-fit:cover;border-radius:8px;pointer-events:none;' });
            _img.onerror = () => { iconWrap.innerHTML = svgIcon('box', 17); };
            iconWrap.appendChild(_img);
          } else {
            iconWrap.innerHTML = svgIcon(app.icon || 'box', 17);
          }
          const meta = createEl('div', { style: 'flex:1;min-width:0;' });
          // SECURITY: Use escapeHtml for user-controlled app.name
          meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${isDis ? 'var(--text-muted)' : 'var(--text-primary)'};">${escapeHtml(app.name)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">v${escapeHtml(app.version || '1.0.0')}${isDis ? ' \u00B7 disabled' : ''}</div>`;
          item.append(iconWrap, meta);

          item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; }, listenerOpts);
          item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; }, listenerOpts);
          item.addEventListener('click', () => { selectedPkgId = app.id; renderList(); renderDetail(); }, listenerOpts);

          fragment.appendChild(item);
        });

        listEl.appendChild(fragment);
      }

      function renderDetail() {
        detail.innerHTML = '';
        const app = installedApps.find(a => a.id === selectedPkgId);

        if (!app) {
          const drop = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text-muted);padding:40px;' });
          const dropBox = createEl('div', { style: 'width:110px;height:110px;border:2px dashed var(--border-default);border-radius:24px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;' });
          dropBox.innerHTML = svgIcon('package', 44);
          const dropLabel = createEl('div', { style: 'text-align:center;line-height:1.9;' });
          dropLabel.innerHTML = '<div style="font-size:16px;font-weight:600;color:var(--text-secondary);">Install a .novaapp Package</div><div style="font-size:12px;margin-top:4px;">Drop a <code style="color:var(--accent);">.novaapp</code> file here,<br>or click <strong style="color:var(--text-primary);">Install</strong>.</div>';
          drop.append(dropBox, dropLabel);

          drop.addEventListener('dragover', e => {
            e.preventDefault();
            dropBox.style.borderColor = 'var(--accent)';
            dropBox.style.background = 'var(--accent-muted)';
          }, listenerOpts);
          drop.addEventListener('dragleave', () => {
            dropBox.style.borderColor = 'var(--border-default)';
            dropBox.style.background = '';
          }, listenerOpts);
          drop.addEventListener('drop', e => {
            e.preventDefault();
            dropBox.style.borderColor = 'var(--border-default)';
            dropBox.style.background = '';
            if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
          }, listenerOpts);

          detail.appendChild(drop);
          return;
        }

        const disabledSet = new Set(getDisabled());
        const isDis = disabledSet.has(app.id);

        // ── Header ─────────────────────────────────────────────
        const header = createEl('div', {
          style: 'padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:14px;flex-shrink:0;'
        });
        const hIcon = createEl('div', {
          style: `width:56px;height:56px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};`
        });
        const iconSrc = resolveIcon(app);
        if (iconSrc) {
          const _img = createEl('img', { src: iconSrc, draggable: 'false', style: 'width:100%;height:100%;object-fit:cover;border-radius:13px;pointer-events:none;' });
          _img.onerror = () => { hIcon.innerHTML = svgIcon('box', 28); };
          hIcon.appendChild(_img);
        } else {
          hIcon.innerHTML = svgIcon(app.icon || 'box', 28);
        }
        const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
        // SECURITY: escapeHtml for app.name and app.author (user-controlled)
        hMeta.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text-primary);">${escapeHtml(app.name)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">v${escapeHtml(app.version || '1.0.0')} \u00B7 ${escapeHtml(app.author || 'Unknown')}</div>`;
        header.append(hIcon, hMeta);
        detail.appendChild(header);

        // ── Actions ─────────────────────────────────────────────
        const actionBar = createEl('div', {
          style: 'padding:10px 20px;border-bottom:1px solid var(--border-subtle);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--bg-sunken);'
        });

        function makeActionBtn(label, iconName, style, onClick) {
          const btn = createEl('button', {
            style: `display:flex;align-items:center;gap:6px;padding:6px 13px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s;${style}`
          });
          btn.innerHTML = svgIcon(iconName, 12) + ' ' + label;
          btn.addEventListener('click', onClick, listenerOpts);
          return btn;
        }

        const launchBtn = makeActionBtn(
          isDis ? 'Disabled' : 'Launch', 'play',
          isDis
            ? 'background:var(--bg-elevated);border:1px solid var(--border-default);color:var(--text-muted);cursor:not-allowed;'
            : 'background:var(--accent);border:1px solid transparent;color:#fff;',
          () => { if (!isDis) WM.createWindow(app.id); }
        );

        const toggleBtn = makeActionBtn(
          isDis ? 'Enable' : 'Disable',
          isDis ? 'done' : 'no-entry',
          isDis
            ? 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:var(--text-success);'
            : 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:var(--text-warning);',
          () => {
            const d = getDisabled();
            setDisabled(isDis ? d.filter(id => id !== app.id) : [...d, app.id]);
            selectedPkgId = app.id;
            renderList();
            renderDetail();
            Notify.show({
              title: isDis ? 'App Enabled' : 'App Disabled',
              body: `${app.name} ${isDis ? 'enabled' : 'disabled'}`,
              type: 'success', appName: 'App Manager'
            });
          }
        );

        const uninstBtn = makeActionBtn(
          'Uninstall', 'trash',
          'background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#f85149;',
          () => doUninstall(app.id)
        );

        actionBar.append(launchBtn, toggleBtn, uninstBtn);
        detail.appendChild(actionBar);

        // ── Info ────────────────────────────────────────────────
        const bodyEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px;' });
        if (app.description) {
          bodyEl.appendChild(createEl('div', {
            style: 'color:var(--text-secondary);line-height:1.65;font-size:13px;',
            textContent: app.description // textContent — safe, no HTML injection
          }));
        }

        // Permissions
        const allPerms = [
          ...(app.permissions || []).map(p => ({ p, req: true })),
          ...(app.optionalPermissions || []).map(p => ({ p, req: false }))
        ];

        if (allPerms.length) {
          const s = createEl('div');
          s.innerHTML = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px;">Permissions</div>';
          const row = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' });

          function permStyle(p) {
            if (['fs:delete', 'admin:system'].includes(p)) {
              return 'background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.35);color:#f85149;';
            }
            if (['fs:write', 'device:geolocation', 'system:settings'].includes(p)) {
              return 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:#d29922;';
            }
            return 'background:var(--accent-muted);border:1px solid rgba(88,166,255,0.3);color:var(--accent);';
          }

          allPerms.forEach(({ p, req }) => {
            const t = createEl('span', { style: `font-size:11px;padding:3px 9px;border-radius:6px;${permStyle(p)}` });
            t.textContent = p + (req ? '' : ' (opt)');
            row.appendChild(t);
          });
          s.appendChild(row);
          bodyEl.appendChild(s);
        }

        detail.appendChild(bodyEl);
      }

      function processFile(file) {
        if (!file.name.endsWith('.novaapp')) {
          Notify.show({ title: 'Invalid File', body: 'Please select a valid .novaapp package.', type: 'error', appName: 'App Manager' });
          return;
        }

        const reader = new FileReader();
        reader.onload = async ev => {
          try {
            const raw = ev.target.result;
            let pkg;

            try {
              pkg = JSON.parse(raw);
            } catch (_) {
              // SECURITY: Removed require('vm').runInThisContext() — this was executing
              // arbitrary untrusted code in the main context (equivalent to eval()).
              // Obfuscated packages must now be in valid JSON format.
              throw new Error('Package is not valid JSON. Obfuscated .novaapp files are no longer supported for security reasons.');
            }

            if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) {
              throw new Error('Missing required manifest fields (id, name, version).');
            }

            // ── Signature verification ──
            let verified = false;
            try {
              if (typeof AppPackage !== 'undefined' && typeof AppPackage.verifyPackage === 'function') {
                verified = await AppPackage.verifyPackage(pkg, null);
              }
            } catch (_) { verified = false; }

            if (!verified) {
              try {
                const payload = JSON.stringify({
                  novabyte_app: pkg.novabyte_app,
                  manifest: pkg.manifest,
                  files: pkg.files,
                  compiled_at: pkg.compiled_at
                });
                const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
                const hashArray = new Uint8Array(hashBuf);
                // Use ES2026 Uint8Array.toHex() when available, fallback to manual
                const hashHex = typeof hashArray.toHex === 'function'
                  ? hashArray.toHex()
                  : Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
                verified = hashHex === pkg.signature;
              } catch (_) { verified = false; }
            }

            if (!verified && !confirm(`\u26A0 Signature check failed for "${pkg.manifest.name}".\n\nInstall anyway?`)) return;

            // ── Handle replacement of existing install ──
            const idx = installedApps.findIndex(a => a.id === pkg.manifest.id);
            if (idx > -1) {
              if (!confirm(`"${pkg.manifest.name}" is already installed (v${installedApps[idx].version}).\n\nReplace with v${pkg.manifest.version}?`)) return;
              delete OS.apps[pkg.manifest.id];
              const ri = APP_REGISTRY.findIndex(a => a.id === pkg.manifest.id);
              if (ri > -1) APP_REGISTRY.splice(ri, 1);
              if (PackageStore?.removeApp) await PackageStore.removeApp(pkg.manifest.id, { updateRegistry: false });
              installedApps.splice(idx, 1);
            }

            // ── Inline bundle CSS/JS into HTML for offline-ready blob ──
            const entryKey = pkg.manifest.entry || 'index.html';
            try {
              const entryB64 = pkg.files[entryKey];
              if (entryB64 && typeof entryB64 === 'string') {
                let html = decodeURIComponent(escape(atob(entryB64)));
                html = html
                  .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
                  .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '');

                for (const [relPath, rawB64] of Object.entries(pkg.files)) {
                  if (relPath === entryKey || !rawB64 || typeof rawB64 !== 'string') continue;
                  const lower = relPath.toLowerCase();
                  let tag = null;
                  if (lower.endsWith('.css')) {
                    const css = decodeURIComponent(escape(atob(rawB64)));
                    tag = '<style data-ninline>\n' + css + '\n</style>';
                  } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
                    const js = decodeURIComponent(escape(atob(rawB64)));
                    tag = '<script data-ninline>\n' + js + '\n<\/script>';
                  }
                  if (!tag) continue;
                  if (/<head(\s[^>]*)?>/i.test(html)) {
                    html = html.replace(/<head(\s[^>]*)?>/i, (m) => m + '\n' + tag);
                  } else {
                    html = tag + '\n' + html;
                  }
                }
                pkg.files[entryKey] = btoa(unescape(encodeURIComponent(html)));
              }
            } catch (inlineErr) {
              console.warn('[AppManager] Inline bundling failed, using original files:', inlineErr);
            }

            const appData = {
              ...pkg.manifest,
              files: pkg.files,
              verified,
              source: 'file',
              installedAt: Date.now()
            };
            if (PackageStore?.installApp) {
              Object.assign(appData, await PackageStore.installApp(appData));
            }
            installedApps.push(appData);
            saveStoredApps(installedApps);
            registerNovaApp(appData);
            pushLog({ action: 'install', appId: appData.id, label: `${appData.name} v${appData.version} installed` });
            selectedPkgId = appData.id;
            renderList();
            renderDetail();
            Notify.show({ title: 'App Installed', body: `${appData.name} v${appData.version} installed successfully.`, type: 'success', appName: 'App Manager' });
          } catch (err) {
            Notify.show({ title: 'Install Failed', body: String(err.message || err), type: 'error', appName: 'App Manager' });
          }
        };
        reader.readAsText(file);
      }

      async function doUninstall(appId) {
        const app = installedApps.find(a => a.id === appId);
        if (!app || !confirm(`Uninstall "${app.name}" v${app.version}?\n\nThis cannot be undone.`)) return;

        pushLog({ action: 'uninstall', appId: app.id, label: `${app.name} v${app.version} uninstalled` });
        try {
          if (PackageStore?.removeApp) await PackageStore.removeApp(appId, { updateRegistry: false });
        } catch (e) {
          console.warn('[AppManager] Failed to remove stored package files for', appId, e);
        }
        installedApps = installedApps.filter(a => a.id !== appId);
        saveStoredApps(installedApps);
        delete OS.apps[appId];
        const ri = APP_REGISTRY.findIndex(a => a.id === appId);
        if (ri > -1) APP_REGISTRY.splice(ri, 1);

        // Remove from pinned, boot, disabled
        OS.settings.set('pinnedApps', getPinned().filter(id => id !== appId));
        setDisabled(getDisabled().filter(id => id !== appId));
        setBootApps(getBootApps().filter(id => id !== appId));

        // Remove any desktop shortcut (.lnk) files pointing to this app
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
        } catch (e) {
          console.warn('[AppManager] Failed to clean up desktop shortcuts for', appId, e);
        }

        if (WM.updateTaskbar) WM.updateTaskbar();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
        selectedPkgId = null;
        renderList();
        renderDetail();
        if (typeof refreshStats === 'function') refreshStats();
        Notify.show({ title: 'App Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'App Manager' });
      }

      // ── Debounced search to avoid excessive re-renders ──
      searchEl.addEventListener('input', debounce(renderList, 150), listenerOpts);
      root.addEventListener('dragover', e => e.preventDefault(), listenerOpts);
      root.addEventListener('drop', e => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) processFile(f);
      }, listenerOpts);

      root.append(sidebar, detail);
      body.appendChild(root);
      renderList();
      renderDetail();
    }

    // ══════════════════════════════════════════════════════════════
    // WEB APPS PANEL
    // ══════════════════════════════════════════════════════════════
    function renderWebAppsPanel() {
      const wam = typeof WebAppManager !== 'undefined' ? WebAppManager : null;

      function getAllWebApps() { return wam ? wam.getAllApps() : []; }

      const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

      // ── Sidebar ──────────────────────────────────────────────────
      const sidebar = createEl('div', {
        style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
      });

      const toolbar = createEl('div', { style: 'padding:9px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
      const searchEl = createEl('input', {
        type: 'text', id: 'notes-tasks-search-input', name: 'notes-tasks-search',
        placeholder: 'Search\u2026',
        style: 'flex:1;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;min-width:0;'
      });
      const addBtn = createEl('button', {
        style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;'
      });
      addBtn.innerHTML = svgIcon('plus', 12) + ' Add';
      toolbar.append(searchEl, addBtn);
      sidebar.appendChild(toolbar);

      const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:5px;' });
      sidebar.appendChild(listEl);

      // ── Right panel ──────────────────────────────────────────────
      const right = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

      let selectedWebId = null;

      function launchWebApp(wa) {
        const tempId = 'webapp_' + wa.id;
        const wW = 900;
        const wH = 640;

        if (!OS.apps[tempId]) {
          OS.apps[tempId] = {
            name: wa.name,
            icon: wa.icon,
            defaultSize: [wW, wH],
            minSize: [400, 300],
            init(c) {
              const wrapper = document.createElement('div');
              wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;';
              const urlBar = document.createElement('div');
              urlBar.style.cssText = 'background:rgba(0,0,0,0.22);border-bottom:1px solid rgba(255,255,255,0.07);padding:5px 12px;font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;flex-shrink:0;';
              urlBar.textContent = '\uD83D\uDD12 ' + extractHost(wa.url);
              const iframe = document.createElement('webview');
              iframe.style.cssText = 'flex:1;border:none;background:#fff;';
              iframe.src = wa.url;
              wrapper.append(urlBar, iframe);
              c.style.padding = '0';
              c.appendChild(wrapper);
            }
          };
        }
        WM.createWindow(tempId);
      }

      function renderList() {
        listEl.innerHTML = '';
        const q = searchEl.value.trim().toLowerCase();
        let apps = getAllWebApps();
        if (q) apps = apps.filter(a =>
          a.name.toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q)
        );

        if (!apps.length) {
          const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.9;' });
          msg.innerHTML = q
            ? '<div style="font-size:13px;">No matches found.</div>'
            : '<div style="font-size:34px;margin-bottom:10px;">\uD83C\uDF10</div><div style="font-size:12px;">No web apps yet.<br>Click <strong style="color:var(--text-primary);">+ Add</strong> to get started.</div>';
          listEl.appendChild(msg);
          return;
        }

        // ── Batch DOM write with DocumentFragment ──
        const fragment = document.createDocumentFragment();

        apps.forEach(wa => {
          const isSel = wa.id === selectedWebId;
          const host = extractHost(wa.url);
          const item = createEl('div', {
            style: `display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}`
          });
          const iconEl = createEl('div', {
            style: 'width:32px;height:32px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;'
          });
          if (wa.icon) {
            if (/^data:|^https?:\/\//i.test(wa.icon)) {
              const img = createEl('img', { src: wa.icon, style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:9px;', draggable: 'false' });
              img.onerror = () => { iconEl.innerHTML = svgIcon('globe', 16); };
              iconEl.appendChild(img);
            } else {
              iconEl.textContent = wa.icon;
            }
          } else {
            iconEl.innerHTML = svgIcon('globe', 16);
          }
          const meta = createEl('div', { style: 'flex:1;min-width:0;' });
          // SECURITY: escapeHtml for user-controlled wa.name
          meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);font-size:12px;">${escapeHtml(wa.name)}</div><div style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(host)}</div>`;
          item.append(iconEl, meta);

          item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; }, listenerOpts);
          item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; }, listenerOpts);
          item.addEventListener('click', () => { selectedWebId = wa.id; renderList(); renderDetail(); }, listenerOpts);

          fragment.appendChild(item);
        });

        listEl.appendChild(fragment);
      }

      function renderDetail() {
        right.innerHTML = '';
        const wa = getAllWebApps().find(a => a.id === selectedWebId);

        if (!wa) {
          // ── Add form ────────────────────────────────────────────
          const wrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px;display:flex;align-items:flex-start;justify-content:center;' });
          const card = createEl('div', { style: 'width:100%;max-width:420px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:14px;overflow:hidden;' });
          const hdr = createEl('div', { style: 'padding:16px 18px;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);' });
          hdr.innerHTML = `<div style="font-size:14px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;">${svgIcon('plus', 15)} Add Web App</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Pin any website as an app.</div>`;
          card.appendChild(hdr);

          const cbody = createEl('div', { style: 'padding:16px 18px;display:flex;flex-direction:column;gap:12px;' });

          function mkField(label, type, ph, fieldId, fieldName) {
            const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
            const labelEl = createEl('label', {
              style: 'font-size:11px;font-weight:600;color:var(--text-muted);',
              textContent: label // textContent — safe
            });
            w.appendChild(labelEl);
            const inp = createEl('input', {
              type, id: fieldId, name: fieldName, placeholder: ph,
              style: 'padding:8px 10px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;width:100%;transition:border-color 0.15s;'
            });
            inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)', listenerOpts);
            inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)', listenerOpts);
            w.appendChild(inp);
            return { w, inp };
          }

          const { w: wUrl, inp: urlInp } = mkField('URL *', 'url', 'https://example.com', 'web-app-url-input', 'web-app-url');
          const { w: wName, inp: nameInp } = mkField('Name *', 'text', 'My App', 'web-app-name-input', 'web-app-name');

          const errEl = createEl('div', { style: 'font-size:11px;color:var(--text-danger);min-height:14px;' });
          const saveBtn = createEl('button', {
            style: 'padding:10px;background:var(--accent);color:#fff;border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:7px;'
          });
          saveBtn.innerHTML = svgIcon('plus', 13) + ' Add Web App';
          saveBtn.addEventListener('click', () => {
            const url = urlInp.value.trim();
            const name = nameInp.value.trim();
            errEl.textContent = '';

            if (!url) { errEl.textContent = 'URL is required.'; return; }
            try { new URL(url); } catch { errEl.textContent = 'Please enter a valid URL.'; return; }
            if (!name) { errEl.textContent = 'Name is required.'; return; }

            const addedApp = wam ? wam.addApp({ name, url }) : null;
            if (addedApp) {
              Notify.show({ title: 'App Added', body: `"${name}" is now available.`, type: 'success', appName: 'App Manager' });
              selectedWebId = addedApp.id;
              renderList();
              renderDetail();
            }
          }, listenerOpts);

          cbody.append(wUrl, wName, errEl, saveBtn);
          card.appendChild(cbody);
          wrap.appendChild(card);
          right.appendChild(wrap);
          return;
        }

        // ── Detail view ─────────────────────────────────────────
        const host = extractHost(wa.url);

        const hdr = createEl('div', {
          style: 'padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--bg-sunken);'
        });
        const hIcon = createEl('div', {
          style: 'width:48px;height:48px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;'
        });
        if (wa.icon) {
          if (/^data:|^https?:\/\//i.test(wa.icon)) {
            const img = createEl('img', { src: wa.icon, style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:13px;', draggable: 'false', crossorigin: 'anonymous' });
            img.onerror = () => { hIcon.innerHTML = svgIcon('globe', 24); };
            hIcon.appendChild(img);
          } else {
            hIcon.textContent = wa.icon;
          }
        } else {
          hIcon.innerHTML = svgIcon('globe', 24);
        }
        const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
        // SECURITY: escapeHtml for user-controlled wa.name and host
        hMeta.innerHTML = `<div style="font-size:16px;font-weight:700;color:var(--text-primary);">${escapeHtml(wa.name)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(host)}</div>`;
        hdr.append(hIcon, hMeta);
        right.appendChild(hdr);

        const abar = createEl('div', {
          style: 'padding:9px 18px;border-bottom:1px solid var(--border-subtle);display:flex;gap:7px;flex-shrink:0;'
        });

        function mkBtn(label, icon, sty, fn) {
          const b = createEl('button', {
            style: `display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;${sty}`
          });
          b.innerHTML = svgIcon(icon, 12) + ' ' + label;
          b.addEventListener('click', fn, listenerOpts);
          abar.appendChild(b);
          return b;
        }

        mkBtn('Open', 'external-link', 'background:var(--accent);border:1px solid transparent;color:#fff;', () => launchWebApp(wa));
        mkBtn('Remove', 'trash', 'background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.25);color:#f85149;', () => {
          if (!confirm(`Remove "${wa.name}"?`)) return;
          if (wam) wam.removeApp(wa.id);
          selectedWebId = null;
          renderList();
          renderDetail();
          Notify.show({ title: 'Removed', body: `"${wa.name}" removed`, type: 'success', appName: 'App Manager' });
        });

        right.appendChild(abar);
      }

      addBtn.addEventListener('click', () => { selectedWebId = null; renderList(); renderDetail(); }, listenerOpts);
      searchEl.addEventListener('input', debounce(renderList, 150), listenerOpts);
      root.append(sidebar, right);
      body.appendChild(root);
      renderList();
      renderDetail();
    }

    // ── Boot ────────────────────────────────────────────────────────
    refreshTabStyles();
    switchTab('packages');
  }
});

/* ── Background services: Clock + Email ───────────────────────────────── */
(function () {
  'use strict';

  const bgRoot = window.__NBOSP_BG = window.__NBOSP_BG || {};

  // ── Shared AudioContext (reused instead of creating new one per beep) ──
  let sharedAudioCtx = null;

  function getAudioContext() {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      try {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch { return null; }
    }
    // Resume if suspended (browser autoplay policy)
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }

  function bgBeep(freq, dur) {
    try {
      const actx = getAudioContext();
      if (!actx) return;
      const osc = actx.createOscillator();
      const gn = actx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq || 880;
      gn.gain.setValueAtTime(0.25, actx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (dur || 1.0));
      osc.connect(gn);
      gn.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + (dur || 1.0));
      // No setTimeout to close — we reuse the AudioContext
    } catch { /* audio not available */ }
  }

  function safeJSONParse(raw, fallback) {
    try { return JSON.parse(raw); }
    catch { return fallback; }
  }

  /* ---------------------------- Clock service ---------------------------- */
  if (!bgRoot.clock) {
    const STATE_KEY = 'nbosp_clock_state_v2';
    const ALARMS_KEY = 'nbosp_clock_v1';

    const defaults = () => ({
      timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
      stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
      lastAlarmMinute: ''
    });

    let state = safeJSONParse(localStorage.getItem(STATE_KEY), null) || defaults();

    function normaliseState() {
      state.timer = state.timer || {};
      state.stopwatch = state.stopwatch || {};
      state.timer.running = !!state.timer.running;
      state.timer.done = !!state.timer.done;
      state.timer.presetMs = Math.max(0, Number(state.timer.presetMs) || 0);
      state.timer.remainingMs = Math.max(0, Number(state.timer.remainingMs) || 0);
      state.timer.endAt = Math.max(0, Number(state.timer.endAt) || 0);

      state.stopwatch.running = !!state.stopwatch.running;
      state.stopwatch.elapsedMs = Math.max(0, Number(state.stopwatch.elapsedMs) || 0);
      state.stopwatch.startedAt = Math.max(0, Number(state.stopwatch.startedAt) || 0);
      state.stopwatch.laps = Array.isArray(state.stopwatch.laps)
        ? state.stopwatch.laps.filter(n => Number.isFinite(n) && n >= 0).map(n => Math.floor(n))
        : [];
      state.lastAlarmMinute = typeof state.lastAlarmMinute === 'string' ? state.lastAlarmMinute : '';
    }

    function persist() {
      normaliseState();
      lsSave(STATE_KEY, state);
    }

    function loadAlarms() {
      const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
      const alarms = Array.isArray(raw?.alarms) ? raw.alarms : [];
      return alarms
        .map(al => ({
          id: al?.id ?? Date.now().toString(36),
          time: typeof al?.time === 'string' ? al.time : '07:00',
          label: typeof al?.label === 'string' ? al.label : '',
          days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
          enabled: al?.enabled !== false
        }))
        .filter(al => /^\d{2}:\d{2}$/.test(al.time));
    }

    function saveAlarms(alarms) {
      const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
      raw.alarms = alarms;
      lsSave(ALARMS_KEY, raw);
    }

    function nowMs() { return Date.now(); }

    function timerMs() {
      normaliseState();
      if (state.timer.running && state.timer.endAt) {
        const rem = Math.max(0, state.timer.endAt - nowMs());
        if (rem <= 0) {
          state.timer.running = false;
          state.timer.done = true;
          state.timer.remainingMs = 0;
          state.timer.endAt = 0;
          persist();
          bgBeep(880, 0.7);
          setTimeout(() => bgBeep(1047, 0.7), 350);
          setTimeout(() => bgBeep(1319, 1.0), 700);
          return 0;
        }
        return rem;
      }
      return state.timer.remainingMs || 0;
    }

    function stopwatchMs() {
      normaliseState();
      return state.stopwatch.running
        ? state.stopwatch.elapsedMs + Math.max(0, nowMs() - state.stopwatch.startedAt)
        : state.stopwatch.elapsedMs;
    }

    bgRoot.clock = {
      state,
      persist,
      loadAlarms,
      saveAlarms,
      timerMs,
      stopwatchMs,

      startTimer(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      pauseTimer() {
        state.timer.remainingMs = timerMs();
        state.timer.running = false;
        state.timer.done = false;
        state.timer.endAt = 0;
        persist();
      },

      resetTimer() {
        state.timer.running = false;
        state.timer.done = false;
        state.timer.remainingMs = state.timer.presetMs || 0;
        state.timer.endAt = 0;
        persist();
      },

      restartTimer() {
        const amount = state.timer.presetMs || state.timer.remainingMs || 0;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      setTimerPreset(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        if (!state.timer.running) state.timer.remainingMs = amount;
        persist();
      },

      startStopwatch() {
        if (!state.stopwatch.running) {
          state.stopwatch.startedAt = nowMs();
          state.stopwatch.running = true;
          persist();
        }
      },

      pauseStopwatch() {
        if (state.stopwatch.running) {
          state.stopwatch.elapsedMs = stopwatchMs();
          state.stopwatch.running = false;
          state.stopwatch.startedAt = 0;
          persist();
        }
      },

      resetStopwatch() {
        state.stopwatch.running = false;
        state.stopwatch.elapsedMs = 0;
        state.stopwatch.startedAt = 0;
        state.stopwatch.laps = [];
        persist();
      },

      lapStopwatch() {
        const current = Math.floor(stopwatchMs());
        const laps = state.stopwatch.laps;
        if (!laps.length || laps[laps.length - 1] !== current) {
          laps.push(current);
          persist();
        }
        return current;
      },

      getStopwatchLaps() {
        normaliseState();
        return state.stopwatch.laps.slice();
      },

      alarmTick(checkFn) {
        const now = new Date();
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
        if (state.lastAlarmMinute === minuteKey) return;
        const seconds = now.getSeconds();
        const ms = now.getMilliseconds();
        if (seconds !== 0 || ms > 1400) return;
        state.lastAlarmMinute = minuteKey;
        persist();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dow = now.getDay();
        const alarms = loadAlarms();
        alarms.forEach((al, i) => {
          if (!al.enabled || al.time !== timeStr) return;
          if (al.days.length > 0 && !al.days.includes(dow)) return;
          if (typeof checkFn === 'function') {
            try { checkFn(al, i); } catch { /* observer error — don't block */ }
          }
          bgBeep(880, 0.8);
          setTimeout(() => bgBeep(1047, 0.8), 400);
          setTimeout(() => bgBeep(1319, 1.2), 800);
          if (al.days.length === 0) {
            al.enabled = false;
            saveAlarms(alarms);
          }
        });
      },

      ensureBooted() { return true; },

      // ── Cleanup method for clock interval ──
      destroy() {
        if (bgRoot._clockTimer) {
          clearInterval(bgRoot._clockTimer);
          bgRoot._clockTimer = null;
        }
        if (sharedAudioCtx) {
          sharedAudioCtx.close().catch(() => {});
          sharedAudioCtx = null;
        }
      }
    };

    normaliseState();
    persist();

    if (!bgRoot._clockTimer) {
      bgRoot._clockTimer = setInterval(() => {
        timerMs();
        bgRoot.clock.alarmTick();
      }, 250);
    }
  }

  /* ---------------------------- Email service ---------------------------- */
  if (!bgRoot.email) {
    const ACCTS_KEY = 'nbosp_email_accts_v2';

    const state = {
      started: false,
      accounts: [],
      syncTimers: {},
      onChange: null,
      lastBootAt: 0
    };

    const rawLoad = () => {
      try { return JSON.parse(localStorage.getItem(ACCTS_KEY) || '[]'); }
      catch { return []; }
    };

    function saveAccounts() {
      lsSave(ACCTS_KEY, state.accounts);
    }

    function clearTimers() {
      for (const id of Object.keys(state.syncTimers)) {
        clearInterval(state.syncTimers[id]);
        delete state.syncTimers[id];
      }
    }

    async function api(path, opts) {
      const r = await fetch('/api/email' + path, Object.assign({ credentials: 'include' }, opts || {}));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }

    async function connectAccount(acct) {
      if (!acct || !acct.host || !acct.user || !acct.pass) return;
      await api('/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: acct.type, host: acct.host, port: acct.port,
          ssl: acct.ssl, user: acct.user, pass: acct.pass
        })
      });
    }

    function renderHook() {
      if (typeof state.onChange === 'function') {
        try { state.onChange(); } catch { /* observer error */ }
      }
    }

    // ── AbortController for cancelling in-flight sync requests ──
    let syncAbortController = null;

    async function syncAccount(acct) {
      // ── Create per-sync abort signal ──
      const localAc = new AbortController();

      try {
        await connectAccount(acct);
        const d = await api('/messages?folder=INBOX&page=1&limit=10', { method: 'GET', signal: localAc.signal });
        const unread = (d.messages || []).filter(m => !m.seen).length;
        acct._unread = unread;
        acct._lastSync = Date.now();
        state.accounts = rawLoad();
        const target = state.accounts.find(a => a.id === acct.id);
        if (target) {
          target._unread = unread;
          target._lastSync = acct._lastSync;
          saveAccounts();
        }
        if (unread > 0 && window.Notify?.show) {
          Notify.show({ title: 'Email', body: `${unread} new in ${acct.name || acct.email || 'Email'}`, type: 'info', appName: 'Email' });
        }
        renderHook();
      } catch {
        // Network error or abort — silently handled
      }
    }

    function schedule() {
      clearTimers();
      state.accounts = rawLoad();
      state.accounts.forEach(acct => {
        const mins = parseInt(acct.syncInterval) || 0;
        if (!mins) return;
        state.syncTimers[acct.id] = setInterval(() => { syncAccount(acct); }, mins * 60000);
      });
    }

    bgRoot.email = {
      state,

      ensureBooted() {
        if (state.started) return;
        state.started = true;
        state.lastBootAt = Date.now();
        state.accounts = rawLoad();
        schedule();
        state.accounts.forEach(acct => {
          const mins = parseInt(acct.syncInterval) || 0;
          if (mins) syncAccount(acct);
        });
      },

      refreshAccounts: schedule,

      getAccounts() {
        state.accounts = rawLoad();
        return state.accounts.slice();
      },

      saveAccounts,

      setAccounts(next) {
        state.accounts = Array.isArray(next) ? next : [];
        saveAccounts();
        schedule();
        renderHook();
      },

      syncNow(acctId) {
        const list = rawLoad();
        if (acctId) {
          const acct = list.find(a => a.id === acctId);
          if (acct) return syncAccount(acct);
          return Promise.resolve();
        }
        return Promise.allSettled(list.map(acct => syncAccount(acct)));
      },

      stop() {
        clearTimers();
        // ── Cancel any in-flight sync requests ──
        if (syncAbortController) {
          syncAbortController.abort();
          syncAbortController = null;
        }
        state.started = false;
      }
    };
  }
})();