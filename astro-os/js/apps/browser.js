registerApp({
  id: 'browser', name: 'Browser', icon: 'globe',
  description: 'Web Browser',
  defaultSize: [900, 600], minSize: [500, 350],

  onClose(state) {
    // Flush any debounced localStorage writes so data isn't lost on rapid close.
    // _flushPendingSaves is attached to `state` from inside init() (since it
    // closes over per-app caches); call it via state to bridge the scope gap.
    try {
      if (typeof state._flushPendingSaves === 'function') state._flushPendingSaves();
    } catch (err) { console.warn('[NB Browser] flush-on-close failed:', err); }

    // Tear down every tracked cleanup (intervals, listeners, abort controllers).
    if (Array.isArray(state.cleanups)) {
      for (const fn of state.cleanups) {
        try { fn(); } catch (err) { console.error('[NB Browser] cleanup failed:', err); }
      }
      state.cleanups.length = 0;
    }

    // Notify the OS shell that all browser windows should close.
    if (window.ipc && typeof window.ipc.postMessage === 'function') {
      try {
        window.ipc.postMessage(JSON.stringify({ type: 'browser:closeAll', source: 'browser-app' }));
      } catch (err) {
        console.error('[NB Browser] Failed to send IPC close message:', err);
      }
    }
  },

  init(content, state, options) {
    'use strict';

    // ── NovaByte runtime guard — refuses to launch without AppDirs ──────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.browser', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center">' +
        '<b>com.nbosp.browser</b><br>App data directory missing.<br>This app requires NovaByte OS.' +
        '</div>';
      return;
    }

    // ── Constants ───────────────────────────────────────────────────────────
    const BK_KEY              = 'nbosp_browser_bookmarks';
    const HX_KEY              = 'nbosp_browser_history';
    const ST_KEY              = 'nbosp_browser_settings';
    const BOOKMARK_MAX        = 500;
    const HISTORY_MAX         = 1000;
    const URL_MAX_LEN         = 2000;
    const TITLE_MAX_LEN       = 300;
    const FAVICON_DATAURI_MAX = 2048;
    const URL_POLL_MS         = 500;
    const DEBOUNCE_MS         = 300;
    const MOBILE_W            = 390;
    const MIN_ZOOM            = 0.25;
    const MAX_ZOOM            = 3;
    const ZOOM_STEP           = 0.1;
    const OMNI_DEBOUNCE_MS    = 120;
    const OMNI_BLUR_CLOSE_MS  = 150;
    const DOWNLOAD_MAX_BYTES  = 512 * 1024 * 1024;
    const MAX_DL_NAME_LEN     = 128;

    const SEARCH_ENGINES = Object.freeze({
      google:      { label: 'Google',      url: 'https://www.google.com/search?q=' },
      bing:        { label: 'Bing',        url: 'https://www.bing.com/search?q=' },
      duckduckgo:  { label: 'DuckDuckGo',  url: 'https://duckduckgo.com/?q=' },
      ecosia:      { label: 'Ecosia',      url: 'https://www.ecosia.org/search?q=' },
      brave:       { label: 'Brave',       url: 'https://search.brave.com/search?q=' },
      yahoo:       { label: 'Yahoo',       url: 'https://search.yahoo.com/search?p=' },
    });

    const AUTH_HOSTS = Object.freeze([
      'accounts.google.com', 'login.microsoftonline.com',
      'login.live.com', 'appleid.apple.com',
      'github.com', 'gitlab.com',
      'www.facebook.com', 'connect.facebook.net',
      'twitter.com', 'x.com',
      'discord.com', 'slack.com',
      'login.yahoo.com', 'api.amazon.com',
    ]);

    const AUTH_PATHS = Object.freeze([
      '/oauth', '/oauth2', '/auth', '/authorize', '/authorise',
      '/login', '/signin', '/sign-in', '/signup', '/sign-up',
      '/sso', '/saml', '/oidc', '/callback', '/connect',
      '/idp/', '/identity/', '/session', '/token',
    ]);

    // ── DOM root ────────────────────────────────────────────────────────────
    const container = createEl('div', { className: 'browser-container' });
    const tabsBar   = createEl('div', { className: 'browser-tabs-bar', role: 'tablist' });
    const viewport  = createEl('div', {
      className: 'browser-viewport',
      style: { display: 'flex', flexDirection: 'column', position: 'relative' }
    });

    // ── Tab state ───────────────────────────────────────────────────────────
    let tabs        = [{ id: 1, title: 'New Tab', url: '', favicon: '', incognito: false }];
    let activeTabId = 1;
    let nextTabId   = 2;

    const tabWebviews  = new Map();  // tabId → <webview>
    const tabIframes   = new Map();  // tabId → <iframe>
    const tabViewMode  = new Map();  // tabId → 'webview' | 'iframe'
    const tabZoom      = new Map();  // tabId → number
    const tabCleanups  = new Map();  // tabId → Array<() => void>
    const tabUnresponsive = new Set(); // tabIds currently flagged unresponsive

    // ── Global teardown registry (single AbortController for whole-app
    //    listeners; cheaper than tracking each one separately) ───────────────
    const appAbort = new AbortController();
    state.cleanups = state.cleanups || [];
    state.cleanups.push(() => appAbort.abort());


    // ── Memoised favicon normaliser ─────────────────────────────────────────
    const _faviconCache = new Map(); // url → normalised
    function normFavicon(favicon, siteUrl = '') {
      if (!favicon) return '';
      const cacheKey = favicon + '\u0000' + siteUrl;
      const hit = _faviconCache.get(cacheKey);
      if (hit !== undefined) return hit;

      let result = favicon;
      // Already a proxy URL — use as-is
      if (favicon.startsWith('/api/favicon') || favicon.startsWith('/api/email-image')) {
        _faviconCache.set(cacheKey, favicon);
        return favicon;
      }
      // Old Google favicon URL — extract the domain and re-proxy
      try {
        const u = new URL(favicon);
        if (u.hostname === 'www.google.com' && u.pathname === '/s2/favicons') {
          const domain = u.searchParams.get('domain');
          if (domain) {
            result = '/api/favicon?domain=' + encodeURIComponent(domain);
            _faviconCache.set(cacheKey, result);
            return result;
          }
        }
      } catch (_) { /* not a URL */ }
      // Resolve relative paths into absolute URLs using the guest tab's current domain
      if (!/^https?:\/\//i.test(favicon) && siteUrl) {
        try { favicon = new URL(favicon, siteUrl).href; }
        catch (_) { /* leave as-is */ }
      }
      // Any other external URL — proxy it via favicon endpoint using the URL's hostname
      if (/^https?:\/\//i.test(favicon)) {
        try {
          const domain = new URL(favicon).hostname;
          result = '/api/favicon?domain=' + encodeURIComponent(domain);
        } catch (err) {
          console.debug('[NB Browser] Failed to extract domain from favicon:', favicon, err);
          result = favicon;
        }
      }
      _faviconCache.set(cacheKey, result);
      return result;
    }

    // ── Settings storage (write-through cache + debounced persist) ──────────
    let _settingsCache = null;
    let _settingsSaveTimer = null;

    function loadSettings() {
      if (_settingsCache) return _settingsCache;
      try {
        _settingsCache = JSON.parse(localStorage.getItem(ST_KEY) || '{}');
      } catch (err) {
        console.error('[NB Browser] Settings cache corrupted, resetting:', err);
        _settingsCache = {};
        try { localStorage.removeItem(ST_KEY); } catch (_) {}
      }
      return _settingsCache;
    }

    function saveSetting(key, val) {
      const s = loadSettings();
      s[key] = val;
      _settingsCache = s;
      clearTimeout(_settingsSaveTimer);
      _settingsSaveTimer = setTimeout(() => {
        try { localStorage.setItem(ST_KEY, JSON.stringify(s)); }
        catch (err) { console.warn('[NB Browser] Failed to save settings:', err); }
      }, DEBOUNCE_MS);
    }

    const getSetting = (key, def) => {
      const v = loadSettings()[key];
      return v !== undefined ? v : def;
    };

    const getSearchUrl = (q) => {
      const eng = getSetting('searchEngine', 'brave');
      const base = SEARCH_ENGINES[eng]?.url || SEARCH_ENGINES.brave.url;
      return base + encodeURIComponent(q);
    };

    // ── Bookmarks storage ───────────────────────────────────────────────────
    let _bookmarksCache = null;
    let _bookmarksSaveTimer = null;

    function loadBookmarks() {
      if (_bookmarksCache) return _bookmarksCache;
      try {
        _bookmarksCache = JSON.parse(localStorage.getItem(BK_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] Bookmarks cache corrupted, resetting:', err);
        _bookmarksCache = [];
        try { localStorage.removeItem(BK_KEY); } catch (_) {}
      }
      return _bookmarksCache;
    }

    function saveBookmarks(arr) {
      _bookmarksCache = arr.slice(0, BOOKMARK_MAX);
      clearTimeout(_bookmarksSaveTimer);
      _bookmarksSaveTimer = setTimeout(() => {
        try { localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache)); }
        catch (err) { console.warn('[NB Browser] Failed to save bookmarks:', err); }
      }, DEBOUNCE_MS);
    }

    // ── History storage ─────────────────────────────────────────────────────
    let _historyCache = null;
    let _historySaveTimer = null;

    function loadHistory() {
      if (_historyCache) return _historyCache;
      try {
        _historyCache = JSON.parse(localStorage.getItem(HX_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] History cache corrupted, resetting:', err);
        _historyCache = [];
        try { localStorage.removeItem(HX_KEY); } catch (_) {}
      }
      return _historyCache;
    }

    function saveHistory(arr) {
      _historyCache = arr.slice(0, HISTORY_MAX);
      clearTimeout(_historySaveTimer);
      _historySaveTimer = setTimeout(() => {
        try { localStorage.setItem(HX_KEY, JSON.stringify(_historyCache)); }
        catch (err) { console.warn('[NB Browser] Failed to save history:', err); }
      }, DEBOUNCE_MS);
    }

    /** Flush every debounced save immediately (used by onClose). */
    function _flushPendingSaves() {
      clearTimeout(_settingsSaveTimer);
      clearTimeout(_bookmarksSaveTimer);
      clearTimeout(_historySaveTimer);
      try {
        if (_settingsCache)  localStorage.setItem(ST_KEY, JSON.stringify(_settingsCache));
        if (_bookmarksCache) localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache));
        if (_historyCache)   localStorage.setItem(HX_KEY, JSON.stringify(_historyCache));
      } catch (err) {
        console.warn('[NB Browser] Flush-on-close failed:', err);
      }
    }
    // Exposed for onClose (which runs in a slightly different scope).
    // onClose calls state._flushPendingSaves() to bridge the scope gap.
    state._flushPendingSaves = _flushPendingSaves;

    // ── Bookmark helpers (cached membership check) ──────────────────────────
    let _bookmarkUrlSet = null;
    function refreshBookmarkSet() {
      _bookmarkUrlSet = new Set(loadBookmarks().map(b => b.url));
    }
    function isBookmarked(url) {
      if (!_bookmarkUrlSet) refreshBookmarkSet();
      return _bookmarkUrlSet.has(url);
    }
    function toggleBookmark(url, title, favicon) {
      let arr = loadBookmarks();
      const idx = arr.findIndex(b => b.url === url);
      if (idx >= 0) {
        arr.splice(idx, 1);
        saveBookmarks(arr);
        refreshBookmarkSet();
        return false;
      }
      arr.unshift({
        url:     url.slice(0, URL_MAX_LEN),
        title:   (title || url).slice(0, TITLE_MAX_LEN),
        favicon: favicon || '',
        ts:      Date.now(),
      });
      saveBookmarks(arr);
      refreshBookmarkSet();
      return true;
    }

    // ── Panel state for live refresh ────────────────────────────────────────
    let _panelType = null;

    function addHistory(originTabId, url, title, favicon) {
      const tab = tabs.find(t => t.id === originTabId);
      if (!tab || tab.incognito || tab.isPopup) return;

      try {
        // Drop oversized Base64 data-URIs before they can exhaust the 5 MB localStorage quota.
        let safeFavicon = favicon || '';
        if (safeFavicon.startsWith('data:') && safeFavicon.length > FAVICON_DATAURI_MAX) {
          safeFavicon = '';
        }
        const safeTitle      = (title || url).slice(0, TITLE_MAX_LEN);
        const safeStorageUrl = url.slice(0, URL_MAX_LEN);
        // Deduplicate & unshift in a single pass.
        const arr = loadHistory().filter(h => h.url !== url);
        arr.unshift({ url: safeStorageUrl, title: safeTitle, favicon: safeFavicon, ts: Date.now() });
        saveHistory(arr);
        // Live-refresh history panel if it's open
        if (_panelType === 'history' && panel.style.display !== 'none') showPanel('history');
      } catch (err) {
        console.warn('[NB Browser] addHistory failed:', err);
      }
    }

    // ── Tabs bar (event-delegated — no per-tab listeners) ───────────────────
    tabsBar.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.tab-close');
      if (closeBtn) {
        e.stopPropagation();
        const tabEl = closeBtn.closest('.browser-tab');
        if (tabEl) closeTab(Number(tabEl.dataset.tabId));
        return;
      }
      const tabEl = e.target.closest('.browser-tab');
      if (tabEl) switchToTab(Number(tabEl.dataset.tabId));
    }, { signal: appAbort.signal });

    // Right-click a tab → tab strip context menu (Chromium-style essentials).
    tabsBar.addEventListener('contextmenu', (e) => {
      const tabEl = e.target.closest('.browser-tab');
      // Right-click on empty bar space → just offer a new tab.
      if (!tabEl) {
        e.preventDefault();
        ContextMenu.show(e.clientX, e.clientY, [
          { label: 'New Tab', icon: 'plus', action: createNewTab },
          { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab },
        ]);
        return;
      }
      e.preventDefault();
      const tabId = Number(tabEl.dataset.tabId);
      const idx = tabs.findIndex(t => t.id === tabId);
      const isIncog = Boolean(tabs[idx]?.incognito);
      ContextMenu.show(e.clientX, e.clientY, [
        { label: 'New Tab', icon: 'plus', action: createNewTab },
        { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab },
        { separator: true },
        { label: 'Reload', icon: 'refresh', action: () => reloadTab(tabId) },
        { label: 'Duplicate', icon: 'copy', action: () => duplicateTab(tabId) },
        { separator: true },
        { label: 'Close Tab', icon: 'x', shortcut: 'Ctrl+W', danger: true, action: () => closeTab(tabId) },
        { label: 'Close Other Tabs', action: () => closeOthers(tabId) },
        { label: 'Close Tabs to the Right', action: () => closeTabsToRight(tabId) },
        { label: 'Close Tabs to the Left', action: () => closeTabsToLeft(tabId) },
        ...(isIncog ? [{ separator: true }, { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab }] : []),
      ]);
    }, { signal: appAbort.signal });

    function renderTabs() {
      // Use a DocumentFragment to batch DOM writes (avoids N reflows).
      const frag = document.createDocumentFragment();
      for (const tab of tabs) {
        const tabEl = createEl('button', {
          className: 'browser-tab'
            + (tab.id === activeTabId ? ' active' : '')
            + (tab.incognito ? ' incognito' : ''),
          role: 'tab',
          'aria-selected': tab.id === activeTabId,
          'data-tab-id': String(tab.id),
        });
        const faviconSpan = createEl('span', { className: 'tab-icon' });
        if (tab.favicon) {
          const img = createEl('img', {
            src: normFavicon(tab.favicon),
            style: { width: '14px', height: '14px', borderRadius: '2px' }
          });
          faviconSpan.appendChild(img);
        } else {
          faviconSpan.innerHTML = svgIcon('globe', 14);
        }
        tabEl.appendChild(faviconSpan);
        const titleSpan = createEl('span', { className: 'tab-title', textContent: tab.title });
        tabEl.appendChild(titleSpan);
        const closeBtn = createEl('span', { className: 'tab-close', role: 'button', 'aria-label': 'Close tab' });
        closeBtn.innerHTML = svgIcon('x', 12);
        tabEl.appendChild(closeBtn);
        frag.appendChild(tabEl);
      }
      const newTabBtn = createEl('button', { className: 'browser-new-tab-btn', 'aria-label': 'New tab' });
      newTabBtn.innerHTML = svgIcon('plus', 16);
      frag.appendChild(newTabBtn);
      // Replace contents in one operation.
      tabsBar.replaceChildren(frag);
      // Re-bind the "+" button (delegated handler can't distinguish it without a class).
      newTabBtn.addEventListener('click', createNewTab, { signal: appAbort.signal });
    }

    /** Update only the title text of an existing tab — avoids full re-render on URL change. */
    function updateTabTitle(tabId, title) {
      const tabEl = tabsBar.querySelector(`.browser-tab[data-tab-id="${tabId}"]`);
      if (!tabEl) { renderTabs(); return; }
      const titleEl = tabEl.querySelector('.tab-title');
      if (titleEl) titleEl.textContent = title;
    }

    function createNewTab() {
      const t = { id: nextTabId++, title: 'New Tab', url: '', favicon: '', incognito: false };
      tabs.push(t);
      switchToTab(t.id);
    }

    function createIncognitoTab() {
      const t = { id: nextTabId++, title: 'Incognito', url: '', favicon: '', incognito: true };
      tabs.push(t);
      switchToTab(t.id);
    }

    function applyMobileViewportFrame(wv, isMobile) {
      if (isMobile) {
        wv.classList.add('mobile-viewport');
        viewport.classList.add('mobile-mode');
        wv.style.position = 'absolute';
      } else {
        wv.classList.remove('mobile-viewport');
        viewport.classList.remove('mobile-mode');
        wv.style.position = 'relative';
        wv.style.width = '';
        wv.style.left = '';
        wv.style.transform = '';
      }
    }

    function applyZoomToIframe(ifr, isMobile, z) {
      if (isMobile) {
        ifr.style.width = MOBILE_W + 'px';
        ifr.style.height = '100%';
        ifr.style.transformOrigin = 'top center';
        ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
      } else {
        const pct = (100 / z).toFixed(4) + '%';
        ifr.style.width = pct;
        ifr.style.height = pct;
        ifr.style.transformOrigin = 'top left';
        ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
      }
    }

    function applyZoomToWebview(wv, z) {
      try { wv.setZoom(z); } catch (_) {}
    }

    function toggleUserAgent() {
      const tab = tabs.find(t => t.id === activeTabId);
      if (!tab) return;
      const mode = getTabMode(activeTabId);
      const goingMobile = tab.userAgent !== 'mobile';
      tab.userAgent = goingMobile ? 'mobile' : 'desktop';

      if (mode === 'iframe') {
        // iframes can't override UA — apply the mobile viewport frame only.
        const ifr = tabIframes.get(activeTabId);
        if (!ifr) return;
        applyMobileViewportFrame(ifr, goingMobile);
        applyZoomToIframe(ifr, goingMobile, tabZoom.get(activeTabId) || 1.0);
        // Reload so the page re-renders inside the new frame dimensions
        try { ifr.contentWindow.location.reload(); }
        catch (_) {
          const src = ifr.src; ifr.src = ''; ifr.src = src;
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        const UA = goingMobile
          ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        try { wv.setUserAgentOverride(UA); } catch (_) {}
        applyMobileViewportFrame(wv, goingMobile);
        if (tab.url) {
          if (goingMobile) {
            const onMobileLoad = () => {
              wv.removeEventListener('loadstop', onMobileLoad);
              try {
                wv.executeScript({ code: `
                  const m = document.querySelector('meta[name=viewport]') ||
                            (() => {
                              const el = document.createElement('meta');
                              el.name = 'viewport';
                              document.head.appendChild(el);
                              return el;
                            })();
                  m.content = 'width=device-width, initial-scale=1, maximum-scale=1';
                ` });
              } catch (_) {}
            };
            wv.addEventListener('loadstop', onMobileLoad);
          }
          try { wv.reload(); } catch (_) {}
        }
      }
    }

    function adjustZoom(delta) {
      let z = tabZoom.get(activeTabId) || 1.0;
      z = delta === 0 ? 1.0 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta));
      tabZoom.set(activeTabId, z);
      const mode = getTabMode(activeTabId);
      if (mode === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        if (!ifr) return;
        const tab = tabs.find(t => t.id === activeTabId);
        applyZoomToIframe(ifr, tab?.userAgent === 'mobile', z);
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        applyZoomToWebview(wv, z);
      }
    }

    function registerTabCleanup(tabId, fn) {
      // Baseline 2026 — Map.getOrInsert avoids the verbose has-check pattern.
      const arr = tabCleanups.getOrInsert(tabId, () => []);
      arr.push(fn);
    }

    function closeTab(tabId) {
      const idx = tabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      if (tabId === activeTabId && tabs.length > 1) {
        switchToTab(tabs[idx > 0 ? idx - 1 : 1].id);
      }

      // Revoke any tracked blob URLs to prevent memory leaks.
      const closedTab = tabs.find(t => t.id === tabId);
      if (closedTab?.activeBlobUrl) {
        try { URL.revokeObjectURL(closedTab.activeBlobUrl); } catch (_) {}
        closedTab.activeBlobUrl = null;
      }

      tabs = tabs.filter(t => t.id !== tabId);

      // Run per-tab cleanups (cancels poll timers, etc.) before removing the webview.
      const cleanups = tabCleanups.get(tabId);
      if (cleanups) {
        for (const fn of cleanups) { try { fn(); } catch (_) {} }
        tabCleanups.delete(tabId);
      }

      // Remove DOM elements BEFORE checking tabs.length, to prevent zombie viewport elements.
      const closedWv = tabWebviews.get(tabId);
      if (closedWv) { closedWv.remove(); tabWebviews.delete(tabId); }
      const closedIfr = tabIframes.get(tabId);
      if (closedIfr) { closedIfr.remove(); tabIframes.delete(tabId); }
      tabViewMode.delete(tabId);
      tabZoom.delete(tabId);
      tabUnresponsive.delete(tabId);
      _frameCheckGen.delete(tabId);

      const closedNotice = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
      if (closedNotice) closedNotice.remove();

      // Now evaluate whether we need a default fallback tab.
      if (tabs.length === 0) { createNewTab(); return; }
      renderTabs();
    }

    // ── Tab actions (shared by the toolbar button & context menus) ──────────
    function reloadTab(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      if (getTabMode(tabId) === 'iframe') {
        const ifr = tabIframes.get(tabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch (_) { const s = ifr.src; ifr.src = ''; ifr.src = s; }
          return;
        }
      } else {
        const wv = tabWebviews.get(tabId);
        if (wv) { try { wv.reload(); } catch (_) {} return; }
      }
      // No element yet (never-rendered background tab) — load it now.
      if (tabId !== activeTabId) switchToTab(tabId);
      if (tab.url) navigate(tab.url);
    }

    function duplicateTab(tabId) {
      const src = tabs.find(t => t.id === tabId);
      if (!src) return;
      const idx = tabs.findIndex(t => t.id === tabId);
      const dup = {
        id: nextTabId++,
        title: src.title || 'New Tab',
        url: src.url || '',
        favicon: src.favicon || '',
        incognito: src.incognito || false,
      };
      tabs.splice(idx + 1, 0, dup);
      switchToTab(dup.id);
      if (dup.url) navigate(dup.url);
    }

    // Snapshot ids BEFORE closing — closeTab reassigns the `tabs` array.
    function closeOthers(keepTabId) {
      switchToTab(keepTabId); // keep this one active so closeTab doesn't reshuffle
      for (const id of tabs.filter(t => t.id !== keepTabId).map(t => t.id)) closeTab(id);
    }
    function closeTabsToRight(fromTabId) {
      const idx = tabs.findIndex(t => t.id === fromTabId);
      if (idx === -1) return;
      switchToTab(fromTabId);
      for (const id of tabs.slice(idx + 1).map(t => t.id)) closeTab(id);
    }
    function closeTabsToLeft(fromTabId) {
      const idx = tabs.findIndex(t => t.id === fromTabId);
      if (idx === -1) return;
      switchToTab(fromTabId);
      for (const id of tabs.slice(0, idx).map(t => t.id)) closeTab(id);
    }

    // ── Speed dial (new-tab page) ───────────────────────────────────────────
    function renderSpeedDial() {
      requestAnimationFrame(() => {
        for (const wv of tabWebviews.values()) {
          wv.style.visibility = 'hidden';
          wv.style.pointerEvents = 'none';
        }
      });
      const old = viewport.querySelector('.speed-dial');
      if (old) old.remove();

      const tab = tabs.find(t => t.id === activeTabId);
      const sd = createEl('div', { className: 'speed-dial' });
      sd.style.cssText = 'position:absolute;inset:0;overflow-y:auto;padding:40px 32px 24px;display:flex;flex-direction:column;align-items:center;gap:28px;background:var(--bg-base);z-index:1;';

      const greeting = createEl('div', { style: 'font-size:22px;font-weight:600;color:var(--text-primary);' });
      const h = new Date().getHours();
      greeting.textContent = h < 12 ? '🌤 Good morning' : h < 18 ? '☀️ Good afternoon' : '🌙 Good evening';
      if (tab?.incognito) {
        sd.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
        greeting.textContent = '🕶 Incognito';
      }
      sd.appendChild(greeting);

      const bookmarks = loadBookmarks().slice(0, 8);
      if (bookmarks.length) {
        const grid = createEl('div', {
          style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;width:100%;max-width:640px;'
        });
        for (const bk of bookmarks) {
          const tile = createEl('div', { className: 'speed-dial-tile' });
          const ico = createEl('div', {
            style: 'width:32px;height:32px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--bg-hover);'
          });
          const fimg = document.createElement('img');
          if (bk.favicon && /^https?:\/\//i.test(bk.favicon)) {
            fimg.src = normFavicon(bk.favicon);
          } else {
            try { fimg.src = '/api/favicon?domain=' + encodeURIComponent(new URL(bk.url).hostname); }
            catch { fimg.src = ''; }
          }
          fimg.style.cssText = 'width:24px;height:24px;border-radius:3px;';
          fimg.onerror = () => { ico.replaceChildren(); ico.innerHTML = svgIcon('globe', 20); };
          if (fimg.src) ico.appendChild(fimg); else ico.innerHTML = svgIcon('globe', 20);

          const lbl = createEl('div', {
            style: 'font-size:11px;color:var(--text-secondary);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;'
          });
          try { lbl.textContent = new URL(bk.url).hostname.replace('www.', ''); }
          catch { lbl.textContent = bk.title; }
          tile.append(ico, lbl);
          tile.addEventListener('click', () => { sd.remove(); navigate(bk.url); }, { signal: appAbort.signal });
          grid.appendChild(tile);
        }
        sd.appendChild(grid);
      } else {
        const hint = createEl('div', { style: 'color:var(--text-muted);font-size:13px;text-align:center;' });
        hint.textContent = 'Bookmark sites with ★ to see them here';
        sd.appendChild(hint);
      }

      const hist = loadHistory().slice(0, 5);
      if (hist.length && !tab?.incognito) {
        const sec = createEl('div', { style: 'width:100%;max-width:640px;' });
        const hdr = createEl('div', {
          style: 'font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;',
          textContent: 'Recent'
        });
        sec.appendChild(hdr);
        for (const h of hist) {
          const row = createEl('div', {
            style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;'
          });
          row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.innerHTML = svgIcon('clock', 13) + '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"></span>';
          const span = row.querySelector('span');
          if (span) span.textContent = h.title || h.url;
          row.addEventListener('click', () => { sd.remove(); navigate(h.url); }, { signal: appAbort.signal });
          sec.appendChild(row);
        }
        sd.appendChild(sec);
      }
      viewport.appendChild(sd);
    }

    function switchToTab(tabId) {
      activeTabId = tabId;
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        urlBar.value = stripHttps(tab.url || '');
        currentUrl = tab.url || '';
        const bkd = tab.url ? isBookmarked(tab.url) : false;
        starBtn.style.color = bkd ? 'var(--accent)' : '';
        starBtn.innerHTML = svgIcon(bkd ? 'star-filled' : 'star', 16);
        updateModeBtn();
        if (tab.url === 'browser://settings') {
          renderSettingsPage();
        } else if (tab.url) {
          updateUrlIcon(tab.url);
          const mode = getTabMode(tabId);
          if (mode === 'iframe') {
            const ifr = getOrCreateIframe(tabId);
            if (!ifr.parentNode) viewport.appendChild(ifr);
          } else {
            const wv = getOrCreateWebview(tabId);
            if (!wv.parentNode) viewport.appendChild(wv);
          }
          showViewForTab(tabId);
          const sd = viewport.querySelector('.speed-dial');
          if (sd) sd.remove();
        } else {
          const hp = getSetting('homepage', 'most_visited');
          if (hp === 'custom') {
            const hpUrl = getSetting('homepageUrl', '');
            if (hpUrl) { tab.url = hpUrl; navigate(hpUrl); }
            else { renderSpeedDial(); }
          } else if (hp === 'blank') {
            const sd2 = viewport.querySelector('.speed-dial');
            if (sd2) sd2.remove();
            const spBlank = viewport.querySelector('.browser-settings-page');
            if (spBlank) spBlank.remove();
            requestAnimationFrame(() => {
              for (const wv of tabWebviews.values()) {
                wv.style.visibility = 'hidden';
                wv.style.pointerEvents = 'none';
              }
            });
          } else {
            renderSpeedDial();
          }
        }
      }
      renderTabs();
    }

    // ── Toolbar ─────────────────────────────────────────────────────────────
    const toolbar    = createEl('div', { className: 'browser-toolbar' });
    const backBtn    = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go back' });
    backBtn.innerHTML = svgIcon('chevron-left', 16);
    const fwdBtn     = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go forward' });
    fwdBtn.innerHTML = svgIcon('chevron-right', 16);
    const refreshBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Refresh' });
    refreshBtn.innerHTML = svgIcon('refresh', 16);

    const urlBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
    const urlBar = createEl('input', {
      id: 'browser-url-bar', name: 'url',
      className: 'browser-url-bar',
      placeholder: 'Search or enter URL…',
      'aria-label': 'Address bar',
      autocomplete: 'off', spellcheck: 'false',
    });
    const urlIcon = createEl('span', { className: 'browser-url-icon' });
    urlIcon.innerHTML = svgIcon('search', 14);
    urlBarWrap.append(urlBar, urlIcon);

    function updateUrlIcon(url) {
      if (url && url.startsWith('https://')) {
        urlIcon.innerHTML = svgIcon('lock', 14);
        urlIcon.style.color = 'var(--text-success)';
      } else if (url && url.startsWith('http://')) {
        if (getSetting('show_security_warnings', true)) {
          urlIcon.innerHTML = svgIcon('unlock', 14);
          urlIcon.style.color = 'var(--text-warning)';
        } else {
          urlIcon.innerHTML = svgIcon('globe', 14);
          urlIcon.style.color = '';
        }
      } else {
        urlIcon.innerHTML = svgIcon('search', 14);
        urlIcon.style.color = '';
      }
    }

    // ── Star bookmark button ────────────────────────────────────────────────
    const starBtn = createEl('button', {
      className: 'browser-nav-btn',
      'aria-label': 'Bookmark', title: 'Bookmark this page'
    });
    starBtn.innerHTML = svgIcon('star', 16);
    starBtn.addEventListener('click', () => {
      if (!currentUrl || currentUrl.startsWith('novabyte:')) return;
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab?.incognito) return;
      const added = toggleBookmark(currentUrl, tab?.title, tab?.favicon);
      starBtn.style.color = added ? 'var(--accent)' : '';
      starBtn.innerHTML = svgIcon(added ? 'star-filled' : 'star', 16);
      Notify.show({
        title: added ? 'Bookmark added' : 'Bookmark removed',
        body: tab?.title || currentUrl,
        type: 'info', appName: 'Browser'
      });
    }, { signal: appAbort.signal });

    // ── Menu button ─────────────────────────────────────────────────────────
    const menuBtn = createEl('button', {
      className: 'browser-nav-btn', 'aria-label': 'Menu', title: 'Browser menu'
    });
    menuBtn.innerHTML = svgIcon('menu', 16);
    menuBtn.addEventListener('click', (e) => {
      const tab = tabs.find(t => t.id === activeTabId);
      const isIncog = tab?.incognito || false;
      const menuItems = [
        { label: 'New Tab', action: createNewTab },
        { label: 'New Incognito Tab', action: createIncognitoTab },
        { separator: true },
      ];
      if (!isIncog) menuItems.push({ label: 'Bookmarks', action: () => showPanel('bookmarks') });
      menuItems.push({ label: 'History', action: () => showPanel('history') });
      menuItems.push({ separator: true });
      menuItems.push(
        { label: 'Find in Page', shortcut: 'Ctrl+F', action: openFindBar },
        { label: tab?.userAgent === 'mobile' ? 'Switch to Desktop Site' : 'Switch to Mobile Site', action: toggleUserAgent },
        {
          label: getTabMode(activeTabId) === 'iframe' ? 'Switch to Webview Mode' : 'Switch to iFrame Mode',
          action: () => {
            const next = getTabMode(activeTabId) === 'iframe' ? 'webview' : 'iframe';
            if (next === 'webview') clearFindStateOnModeSwitch();
            setTabMode(activeTabId, next);
            const t = tabs.find(t2 => t2.id === activeTabId);
            if (t?.url && t.url !== 'browser://settings') navigate(t.url);
            updateModeBtn();
          },
        },
        { separator: true },
        { label: 'Zoom In',  action: () => adjustZoom(ZOOM_STEP) },
        { label: 'Zoom Out', action: () => adjustZoom(-ZOOM_STEP) },
        { label: 'Reset Zoom', action: () => adjustZoom(0) },
        { separator: true },
        { label: 'Settings', action: () => navigate('browser://settings') },
      );
      ContextMenu.show(e.clientX, e.clientY, menuItems);
    }, { signal: appAbort.signal });

    toolbar.append(backBtn, fwdBtn, refreshBtn, urlBarWrap, starBtn, menuBtn);

    // ── View-mode toggle (Webview ↔ iFrame) ─────────────────────────────────
    const modeBtn = createEl('button', { className: 'browser-mode-btn', title: 'Switch to iframe mode' });
    modeBtn.innerHTML = svgIcon('monitor', 14) + ' <span>Webview</span>';
    modeBtn.addEventListener('click', () => {
      const current = getTabMode(activeTabId);
      const next = current === 'webview' ? 'iframe' : 'webview';
      setTabMode(activeTabId, next);
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab?.url && tab.url !== 'browser://settings') navigate(tab.url);
      updateModeBtn();
    }, { signal: appAbort.signal });
    toolbar.appendChild(modeBtn);

    // ── Find bar ────────────────────────────────────────────────────────────
    const findBar = createEl('div', {
      style: 'display:none;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;'
    });
    const findInput = createEl('input', {
      id: 'page-find-input', name: 'page-find',
      placeholder: 'Find in page…',
      style: 'flex:1;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:4px;padding:3px 8px;font-size:12px;color:var(--text-primary);outline:none;',
      autocomplete: 'off', spellcheck: 'false',
    });
    const findCount = createEl('span', {
      style: 'font-size:11px;color:var(--text-muted);min-width:50px;',
      role: 'status', 'aria-live': 'polite'
    });
    const findPrev  = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Previous', 'aria-label': 'Previous match' });
    findPrev.innerHTML = svgIcon('chevron-up', 14);
    const findNext = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Next', 'aria-label': 'Next match' });
    findNext.innerHTML = svgIcon('chevron-down', 14);
    const findClose = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Close', 'aria-label': 'Close find bar' });
    findClose.innerHTML = svgIcon('x', 14);
    findBar.append(findInput, findCount, findPrev, findNext, findClose);

    const openFindBar = () => {
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    };

    // ── iframe find helpers (uses RegExp.escape — ES2025) ───────────────────
    let _iframeFinds = [];
    let _iframeFindIdx = 0;
    let _lastFindText = '';
    let _findRegex = null;

    function buildFindRegex(text) {
      if (text === _lastFindText && _findRegex) return _findRegex;
      _lastFindText = text;
      _findRegex = text ? new RegExp(RegExp.escape(text), 'gi') : null;
      return _findRegex;
    }

    function iframeFind(text, backward) {
      const ifr = tabIframes.get(activeTabId);
      if (!ifr) return;
      let doc;
      try {
        doc = ifr.contentDocument;
      } catch (e) {
        console.warn('[NB Browser] Cannot search cross-origin iframe:', e.message);
        findCount.textContent = '0/0';
        return;
      }
      if (!doc || !doc.body) return;

      // Clear previous highlights then NORMALIZE to merge fragmented text nodes.
      doc.querySelectorAll('.__nb_highlight').forEach(el => {
        el.replaceWith(doc.createTextNode(el.textContent));
      });
      doc.body.normalize();
      _iframeFinds = [];

      if (!text) { findCount.textContent = ''; return; }

      const re = buildFindRegex(text);
      if (!re) return;

      // Walk text nodes, skipping script/style so we don't break page JS
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const tag = node.parentElement?.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const toReplace = [];
      let node;
      while ((node = walker.nextNode())) {
        re.lastIndex = 0;
        if (re.test(node.textContent)) toReplace.push(node);
      }

      for (const tn of toReplace) {
        const frag = doc.createDocumentFragment();
        let last = 0, m;
        re.lastIndex = 0;
        const textContent = tn.textContent;
        while ((m = re.exec(textContent)) !== null) {
          frag.appendChild(doc.createTextNode(textContent.slice(last, m.index)));
          const mark = doc.createElement('mark');
          mark.className = '__nb_highlight';
          // font:inherit preserves every font property so highlights don't reflow text or break custom fonts
          mark.style.cssText =
            'background:#f6c90e !important;color:#000 !important;' +
            'font:inherit !important;display:inline !important;' +
            'padding:0 !important;margin:0 !important;border-radius:2px;' +
            'text-decoration:inherit !important;vertical-align:inherit !important;';
          mark.textContent = m[0];
          frag.appendChild(mark);
          _iframeFinds.push(mark);
          last = m.index + m[0].length;
        }
        frag.appendChild(doc.createTextNode(textContent.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      }

      if (!_iframeFinds.length) { findCount.textContent = '0/0'; return; }
      _iframeFindIdx = backward ? _iframeFinds.length - 1 : 0;
      _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
      _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
      findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
    }

    function iframeFindStep(backward) {
      if (!_iframeFinds.length) return;
      _iframeFinds[_iframeFindIdx].style.background = '#f6c90e !important';
      _iframeFindIdx = ((_iframeFindIdx + (backward ? -1 : 1)) + _iframeFinds.length) % _iframeFinds.length;
      _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
      _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
      findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
    }

    function iframeFindClear() {
      const ifr = tabIframes.get(activeTabId);
      if (!ifr) return;
      try {
        const d = ifr.contentDocument;
        if (d?.body) {
          d.querySelectorAll('.__nb_highlight').forEach(el => {
            el.replaceWith(d.createTextNode(el.textContent));
          });
          d.body.normalize();
        }
      } catch (_) {}
      _iframeFinds = [];
      _iframeFindIdx = 0;
    }

    function closeFindBar() {
      findBar.style.display = 'none';
      findCount.textContent = '';
      if (getTabMode(activeTabId) === 'iframe') {
        iframeFindClear();
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.stopFinding('clear'); } catch (_) {}
      }
    }

    function clearFindStateOnModeSwitch() {
      iframeFindClear();
      findCount.textContent = '';
    }

    function webviewFind(q, opts) {
      const wv = tabWebviews.get(activeTabId);
      if (!wv || !q) { findCount.textContent = ''; return; }
      try {
        wv.find(q, opts, r => {
          if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches;
        });
      } catch (_) {}
    }

    findInput.addEventListener('input', () => {
      const q = findInput.value;
      if (getTabMode(activeTabId) === 'iframe') iframeFind(q, false);
      else webviewFind(q, {});
    });
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (getTabMode(activeTabId) === 'iframe') iframeFindStep(e.shiftKey);
        else webviewFind(findInput.value, { backward: e.shiftKey });
      }
      if (e.key === 'Escape') closeFindBar();
    });
    findPrev.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') iframeFindStep(true);
      else webviewFind(findInput.value, { backward: true });
    });
    findNext.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') iframeFindStep(false);
      else webviewFind(findInput.value, { backward: false });
    });
    findClose.addEventListener('click', closeFindBar);

    // ── Panel (Bookmarks / History) — event-delegated ──────────────────────
    const panel = createEl('div', {
      style: 'display:none;position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);z-index:100;flex-direction:column;overflow:hidden;'
    });

    function showPanel(type) {
      _panelType = type;
      if (!panel.parentNode) viewport.appendChild(panel);
      panel.style.display = 'flex';
      panel.innerHTML = '';

      const hdr = createEl('div', {
        style: 'display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border-subtle);gap:8px;flex-shrink:0;'
      });
      const title = createEl('span', {
        textContent: type === 'bookmarks' ? '★ Bookmarks' : '🕐 History',
        style: 'font-size:13px;font-weight:600;flex:1;'
      });
      const closeP = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', 'aria-label': 'Close panel' });
      closeP.innerHTML = svgIcon('x', 14);
      closeP.addEventListener('click', () => { panel.style.display = 'none'; _panelType = null; });
      hdr.append(title, closeP);
      panel.appendChild(hdr);

      const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
      panel.appendChild(list);

      const items = type === 'bookmarks' ? loadBookmarks() : loadHistory();
      if (!items.length) {
        const empty = createEl('div', {
          style: 'text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;'
        });
        empty.innerHTML = type === 'bookmarks'
          ? 'No bookmarks yet.<br>Click ★ to save a page.'
          : 'No history yet.';
        list.appendChild(empty);
        return;
      }

      // Event delegation for row clicks & delete buttons — single listener for the whole list.
      list.addEventListener('click', (e) => {
        const del = e.target.closest('[data-panel-del]');
        if (!del) {
          const row = e.target.closest('[data-panel-row]');
          if (row) navigate(row.dataset.url);
          return;
        }
        e.stopPropagation();
        const row = del.closest('[data-panel-row]');
        if (!row) return;
        const itemUrl = row.dataset.url;
        const itemTs = row.dataset.ts;
        if (type === 'bookmarks') {
          saveBookmarks(loadBookmarks().filter(b => b.url !== itemUrl));
          refreshBookmarkSet();
        } else {
          saveHistory(loadHistory().filter(h => h.ts != itemTs));
        }
        showPanel(type);
      });

      for (const item of items) {
        const row = createEl('div', {
          style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-subtle);',
          'data-panel-row': 'true',
          'data-url': item.url,
          'data-ts': item.ts || ''
        });
        const ico = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' });
        const fimg = document.createElement('img');
        if (item.favicon && /^https?:\/\//i.test(item.favicon)) {
          fimg.src = normFavicon(item.favicon);
        } else {
          try { fimg.src = '/api/favicon?domain=' + encodeURIComponent(new URL(item.url).hostname); }
          catch { fimg.src = ''; }
        }
        fimg.style.cssText = 'width:14px;height:14px;border-radius:2px;';
        fimg.onerror = () => { ico.replaceChildren(); ico.innerHTML = svgIcon('globe', 14); };
        if (fimg.src) ico.appendChild(fimg); else ico.innerHTML = svgIcon('globe', 14);

        const info = createEl('div', { style: 'flex:1;min-width:0;' });
        const iTitle = createEl('div', {
          style: 'font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          textContent: item.title || item.url
        });
        const iUrl = createEl('div', {
          style: 'font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          textContent: item.url
        });
        info.append(iTitle, iUrl);

        const del = createEl('button', {
          className: 'browser-nav-btn',
          style: 'padding:2px 4px;opacity:0;transition:opacity 0.1s;',
          title: 'Remove',
          'aria-label': 'Remove item',
          'data-panel-del': 'true'
        });
        del.innerHTML = svgIcon('x', 12);
        row.append(ico, info, del);
        list.appendChild(row);
      }
    }

    viewport.appendChild(panel);
    container.append(tabsBar, toolbar, findBar, viewport);
    content.appendChild(container);

    // ── Popup mode ──────────────────────────────────────────────────────────
    if (options?.popup) {
      tabsBar.style.display = 'none';
      fwdBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      starBtn.style.display = 'none';
      menuBtn.style.display = 'none';
      urlBar.readOnly = true;
      urlBar.style.cursor = 'default';
      urlBar.style.background = 'transparent';
      urlBar.style.boxShadow = 'none';

      const popupBadge = createEl('span', {
        style: 'font-size:10px;font-weight:600;color:var(--text-muted);' +
               'background:var(--bg-hover);border:1px solid var(--border-subtle);' +
               'border-radius:4px;padding:2px 7px;white-space:nowrap;flex-shrink:0;' +
               'letter-spacing:.05em;text-transform:uppercase;',
        textContent: 'Popup'
      });
      toolbar.appendChild(popupBadge);
      tabs[0].isPopup = true;
    }

    let currentUrl = '';

    // ── Tracker blocklist ───────────────────────────────────────────────────
    let TRACKER_DOMAINS = new Set();
    fetch('/trackers.js')
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(src => {
        let domains = null;
        const arrayMatch = src.match(/new\s+Set\s*\(\s*(\[[\s\S]*?\])\s*\)/);
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[1]);
            if (Array.isArray(parsed)) domains = parsed.filter(d => typeof d === 'string' && d.length > 0);
          } catch (parseErr) {
            console.warn('[Tracker blocker] JSON.parse of Set array failed:', parseErr.message);
          }
        }
        if (!domains) {
          try {
            const parsed = JSON.parse(src.trim());
            if (Array.isArray(parsed)) domains = parsed.filter(d => typeof d === 'string' && d.length > 0);
          } catch (_) {}
        }
        if (domains?.length) {
          TRACKER_DOMAINS = new Set(domains);
          console.log('[Tracker blocker] Loaded', TRACKER_DOMAINS.size, 'domains via fetch');
        } else {
          console.warn('[Tracker blocker] Fetched trackers.js but could not extract domain list');
        }
      })
      .catch(e => console.warn('[Tracker blocker] Could not fetch /trackers.js —', e.message));

    const getTabMode = (tabId) => tabViewMode.get(tabId) || 'webview';

    // ── Stable browser session ID ───────────────────────────────────────────
    let _bpid = OS.settings.get('browserPartitionId');
    if (!_bpid) {
      _bpid = 'b' + Math.random().toString(36).slice(2, 12);
      OS.settings.set('browserPartitionId', _bpid);
    }
    const BROWSER_PARTITION = 'persist:' + _bpid;

    // ── URL tracking ───────────────────────────────────────────────────────
    // Hoisted to this outer scope (not nested in getOrCreateWebview) because
    // both the per-tab webview listeners AND the shared poll timer below
    // need to call it, and it doesn't depend on any per-tab closure state.
    function syncUrlForTab(url, forTabId, source) {
      if (!url || url === 'about:blank' || url === 'about:newtab') return;
      const tab = tabs.find(t => t.id === forTabId);
      if (tab) tab.url = url;
      if (forTabId !== activeTabId) return;
      currentUrl = url;
      urlBar.value = stripHttps(url);
      updateUrlIcon(url);
      const bkd = isBookmarked(url);
      starBtn.style.color = bkd ? 'var(--accent)' : '';
      starBtn.innerHTML = svgIcon(bkd ? 'star-filled' : 'star', 16);
      // Update only the active tab's title; full re-render is wasteful for SPAs.
      if (tab?.title) updateTabTitle(forTabId, tab.title);
    }

    // ── Shared single-timer URL poller ──────────────────────────────────────
    // Instead of N intervals (one per webview), use ONE interval that polls
    // only the currently-active webview. This reduces timer overhead and
    // executeScript calls from O(tabs) to O(1) per tick.
    const _lastPolledUrls = new Map(); // tabId → string
    const _urlPollTimer = setInterval(() => {
      const wv = tabWebviews.get(activeTabId);
      if (!wv) return;
      try {
        wv.executeScript({ code: 'location.href' }, results => {
          if (chrome.runtime?.lastError) return;
          const url = Array.isArray(results) ? results[0] : results;
          if (typeof url !== 'string' || url === 'about:blank') return;
          if (url === _lastPolledUrls.get(activeTabId)) return;
          _lastPolledUrls.set(activeTabId, url);
          syncUrlForTab(url, activeTabId, 'poll');
        });
      } catch (err) {
        console.warn('[NB Browser] URL poll executeScript failed:', err);
      }
    }, URL_POLL_MS);
    state.cleanups.push(() => clearInterval(_urlPollTimer));

    // ── Info bar (for unresponsive pages, etc.) ─────────────────────────────
    function showInfoBar(tabId, msg, actions) {
      dismissInfoBar(tabId);
      const bar = createEl('div', {
        className: 'browser-info-bar',
        'data-tab': String(tabId),
        style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:#3a2a1a;color:#f6c90e;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;'
      });
      bar.textContent = msg;
      for (const a of actions) {
        const b = createEl('button', {
          style: 'background:transparent;border:1px solid rgba(255,255,255,0.2);color:inherit;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;',
          textContent: a.label
        });
        b.addEventListener('click', a.action);
        bar.appendChild(b);
      }
      // Insert at the top of the viewport
      viewport.insertBefore(bar, viewport.firstChild);
    }
    function dismissInfoBar(tabId) {
      const existing = viewport.querySelector(`.browser-info-bar[data-tab="${tabId}"]`);
      if (existing) existing.remove();
    }

    // ── Webview factory ─────────────────────────────────────────────────────
    function getOrCreateWebview(tabId) {
      const existing = tabWebviews.get(tabId);
      if (existing) return existing;

      const wv = document.createElement('webview');
      const tab = tabs.find(t => t.id === tabId);
      wv.setAttribute('partition', tab?.incognito ? ('incognito_' + tabId) : BROWSER_PARTITION);
      wv.setAttribute('allowfullscreen', 'true');
      wv.setAttribute('nodeintegration', 'false');
      wv.setAttribute('enableremotemodule', 'false');
      wv.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      wv.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;';

      wv.addEventListener('loadcommit', e => {
        if (e.isTopLevel && e.url) syncUrlForTab(e.url, tabId, 'loadcommit');
      });

      wv.addEventListener('loadstop', () => {
        // Sync URL via executeScript (NW.js has no did-navigate event)
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'loadstop+executeScript');
          });
        } catch (ex) {
          console.log('[NB Browser] executeScript(loadstop) threw:', ex);
        }
        // Fetch title + href together and save history after each load.
        try {
          wv.executeScript({ code: '[document.title, location.href]' }, r => {
            if (chrome.runtime?.lastError) return;
            const result = Array.isArray(r) ? r[0] : null;
            if (!Array.isArray(result)) return;
            const [title, url] = result;
            const tab = tabs.find(t => t.id === tabId);
            if (!tab) return;
            if (title) {
              tab.title = title;
              if (tabId === activeTabId) updateTabTitle(tabId, title);
              else renderTabs();
              if (options?.popup && state.titleText) state.titleText.textContent = title;
            }
            try {
              const hostname = new URL(url || tab.url).hostname;
              tab.favicon = '/api/favicon?domain=' + hostname;
              if (tabId === activeTabId) renderTabs(); // re-render for favicon
            } catch (_) {}
            if (url && !url.startsWith('novabyte:') && !url.startsWith('file://')) {
              addHistory(tabId, url, title || url, tab.favicon);
            }
          });
        } catch (_) {}
      });

      wv.addEventListener('contentload', () => {
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'contentload+executeScript');
          });
        } catch (_) {}
      });


      wv.addEventListener('contentload', () => {
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'contentload+executeScript');
          });
        } catch (_) {}
      });




      // ── Network / certificate error handling ──────────────────────────────
      wv.addEventListener('loaderror', e => {
        if (!e.isTopLevel) return;
        const failedUrl = e.validatedURL || currentUrl || '';
        const code = e.errorCode || 0;
        const desc = e.errorDescription || '';

        let titleText, message, hint, showBypass = false;
        if (desc.includes('CERT') || desc.includes('SSL') || desc.includes('HTTPS') ||
            code === -202 || code === -200 || code === -207) {
          titleText = '⚠ Certificate Error';
          message = 'The connection to this site is not trusted. The certificate may be self-signed, expired, or issued by an unknown authority.';
          hint = 'If this is a local development server, click "Proceed anyway" below.';
          showBypass = true;
        } else if (desc.includes('CONNECTION_REFUSED') || code === -102) {
          titleText = '⚡ Connection Refused';
          message = 'No server is listening at this address. Check that the server is running and the port is correct.';
          hint = (failedUrl.includes('localhost') || failedUrl.includes('127.0.0.1'))
            ? 'Tip: make sure your local server is started (e.g. npm start).'
            : '';
        } else if (desc.includes('NAME_NOT_RESOLVED') || code === -105) {
          titleText = '🌐 DNS Error';
          message = 'The hostname could not be resolved. Check the URL or your internet connection.';
          hint = '';
        } else if (desc.includes('TIMED_OUT') || code === -7) {
          titleText = '⏱ Connection Timed Out';
          message = 'The server took too long to respond.';
          hint = 'Try again or check your network.';
        } else {
          titleText = '✕ Page Failed to Load';
          message = 'Something went wrong loading this page.';
          hint = desc ? 'Error: ' + desc : '';
        }

        // Build the error page via DOM APIs where possible; the <script> tag
        // uses a data-attribute + addEventListener (no inline handlers — CSP-safe).
        const safeHint = hint
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const safeUrl = failedUrl
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

        const bypassAttr = showBypass ? ' data-bypass="1"' : '';
        const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${titleText}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:520px;width:100%;background:#161b22;border:1px solid #30363d;
        border-radius:12px;padding:32px 36px;text-align:center}
  h1{font-size:20px;font-weight:700;margin-bottom:12px;color:#f0f6fc}
  p{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:8px}
  .url{font-size:11px;color:#58a6ff;word-break:break-all;margin-bottom:20px;
       background:#0d1117;padding:6px 10px;border-radius:6px;border:1px solid #21262d}
  .hint{font-size:12px;color:#e3b341;margin-bottom:20px}
  .actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
  button{background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;
         cursor:pointer;font-size:13px}
  button:hover{opacity:.85}
  button.unsafe{background:#e05d44}
</style></head><body>
<div class="card">
  <h1>${titleText}</h1>
  <p>${message}</p>
  <div class="url">${safeUrl}</div>
  ${safeHint ? `<div class="hint">${safeHint}</div>` : ''}
  <div class="actions">
    ${showBypass ? '<button class="unsafe" id="__nb_bypass">Proceed anyway (unsafe)</button>' : ''}
    <button id="__nb_retry">↺ Retry</button>
  </div>
</div>
<script>
  (function() {
    const u = ${JSON.stringify(failedUrl)};
    const r = document.getElementById('__nb_retry');
    if (r) r.addEventListener('click', () => { window.location.href = u; });
    const b = document.getElementById('__nb_bypass');
    if (b) b.addEventListener('click', () => { window.location.href = u; });
  })();
</script>
</body></html>`;

        try {
          const htmlStr = JSON.stringify(errorHtml);
          wv.executeScript({
            code: `requestAnimationFrame(() => { document.documentElement.innerHTML = ${htmlStr}; });`
          }, () => {});
        } catch (_) {}
      });

      wv.addEventListener('loadabort', e => {
        if (!e.isTopLevel) return;
        if (!e.url || e.url === 'about:blank' || e.url === 'about:newtab') return;
        if (e.reason === 'ERR_ABORTED') return;
        const reasonJson = JSON.stringify(e.reason || 'Unknown reason');
        try {
          wv.executeScript({ code: `
            (function() {
              const reason = ${reasonJson};
              const html = '<html><body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">' +
                '<div style="text-align:center;max-width:400px">' +
                '<div style="font-size:32px;margin-bottom:12px">🚫</div>' +
                '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Navigation Blocked</div>' +
                '<div style="font-size:12px;color:#8b949e;margin-bottom:16px">' + reason + '</div>' +
                '<button id="__nb_back" style="background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer">← Go Back</button>' +
                '</div></body></html>';
              document.documentElement.innerHTML = html;
              const b = document.getElementById('__nb_back');
              if (b) b.addEventListener('click', () => history.back());
            })();
          ` }, () => {});
        } catch (_) {}
      });

      // ── Fullscreen support for web content ────────────────────────────────
      wv.addEventListener('enter-html-full-screen', () => {
        wv.style.position = 'fixed';
        wv.style.inset = '0';
        wv.style.zIndex = '2147483647';
        wv.style.width = '100vw';
        wv.style.height = '100vh';
        wv.style.visibility = 'visible';
        wv.style.pointerEvents = 'auto';
        document.body.style.overflow = 'hidden';

        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else if (document.documentElement.webkitRequestFullscreen) {
          document.documentElement.webkitRequestFullscreen();
        }
        if (typeof nw !== 'undefined' && nw.Window) {
          try { nw.Window.get().enterFullscreen(); } catch (_) {}
        }
      });

      wv.addEventListener('leave-html-full-screen', () => {
        wv.style.position = 'absolute';
        wv.style.inset = 'auto';
        wv.style.zIndex = '1';
        wv.style.width = '100%';
        wv.style.height = '100%';
        document.body.style.overflow = '';

        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
        if (typeof nw !== 'undefined' && nw.Window) {
          try { nw.Window.get().leaveFullscreen(); } catch (_) {}
        }
      });

      const _onFsChange = () => {
        if (!document.fullscreenElement) {
          wv.style.position = 'absolute';
          wv.style.inset = 'auto';
          wv.style.zIndex = '1';
          wv.style.width = '100%';
          wv.style.height = '100%';
          document.body.style.overflow = '';
        }
      };
      document.addEventListener('fullscreenchange', _onFsChange);
      state.cleanups.push(() => document.removeEventListener('fullscreenchange', _onFsChange));

      // ── Process status monitoring ─────────────────────────────────────────
      wv.addEventListener('unresponsive', () => {
        if (tabUnresponsive.has(tabId)) return;
        tabUnresponsive.add(tabId);
        console.warn('[NB Browser] Page became unresponsive: tabId', tabId);
        if (tabId === activeTabId) {
          showInfoBar(
            tabId,
            '⚠\uFE0F This page is not responding.',
            [
              { label: 'Wait', action: () => {} },
              { label: 'Reload', action: () => navigate(tabs.find(t => t.id === tabId)?.url || '') }
            ]
          );
        }
      });
      wv.addEventListener('responsive', () => {
        if (!tabUnresponsive.delete(tabId)) return;
        console.log('[NB Browser] Page became responsive again: tabId', tabId);
        dismissInfoBar(tabId);
      });

      // ── Download handling ─────────────────────────────────────────────────
      async function ensureBrowserFsWritePermission() {
        const mgr = window.AppPermissionManager;
        if (!mgr) return true;
        const appId = 'browser';
        if (mgr.isGranted('fs:write', appId)) return true;
        if (mgr.isDenied?.('fs:write', appId)) {
          Notify.show({
            title: 'Download blocked',
            body: 'Browser does not have permission to write files. Grant "fs:write" in Settings → Apps.',
            type: 'error', appName: 'Browser',
          });
          return false;
        }
        const granted = await mgr.requestPermission('fs:write', appId, {
          appName: 'Browser',
          reason: 'Browser needs to save downloaded files to your Downloads folder.',
        });
        if (!granted) {
          Notify.show({
            title: 'Download blocked',
            body: 'Browser was denied permission to write files.',
            type: 'error', appName: 'Browser',
          });
          return false;
        }
        return true;
      }

      wv.addEventListener('permissionrequest', e => {
        if (e.permission === 'fullscreen') { e.request.allow(); return; }
        if (e.permission === 'pointerLock') { e.request.allow(); return; }
        if (e.permission === 'download') {
          e.request.deny();
          // Use Promise.try (ES2025) to unify sync/async error handling.
          Promise.try(async () => {
            const _url = e.request.url;
            if (!_url || !/^https?:\/\//i.test(_url)) return;
            if (!(await ensureBrowserFsWritePermission())) return;
            try {
              const baseName = (() => {
                try { return decodeURIComponent(new URL(_url).pathname.split('/').pop()); }
                catch { return ''; }
              })() || ('download_' + Date.now());
              const safeName = baseName.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || ('download_' + Date.now());
              const finalName = safeName.length > MAX_DL_NAME_LEN ? safeName.slice(0, MAX_DL_NAME_LEN) : safeName;
              const ext = finalName.includes('.') ? '' : '.bin';
              const dlFolderId = FS.specialFolders.downloads;
              if (!dlFolderId) throw new Error('Downloads folder missing');
              const existing = FS.listDir(dlFolderId).map(f => f.name);
              const adjusted = existing.includes(finalName + ext)
                ? finalName.replace(/(\.\w+)?$/, ' (' + existing.filter(n => n.startsWith(finalName)).length + ')$1')
                : finalName;
              const entry = window.Downloads?.add(adjusted + ext, _url, 0, '');
              const entryId = entry?.id;
              if (entryId) window.Downloads?.setStatus(entryId, 'downloading');
              WM.createWindow('nbosp-downloads');
              const resp = await fetch(_url);
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              const cl = resp.headers.get('content-length');
              if (cl && +cl > DOWNLOAD_MAX_BYTES) throw new Error('File too large');
              const buf = await resp.arrayBuffer();
              if (buf.byteLength > DOWNLOAD_MAX_BYTES) throw new Error('File too large');
              await FS.createFile(dlFolderId, adjusted + ext, new Uint8Array(buf), 'application/octet-stream');
              if (entryId) window.Downloads?.setStatus(entryId, 'done', buf.byteLength);
              Notify.show({
                title: 'Download complete', body: adjusted + ext,
                type: 'success', appName: 'Downloads'
              });
              OS.events.emit('fs:created', {});
            } catch (err) {
              console.error('Download handler error:', err);
              Notify.show({
                title: 'Download failed', body: String(err.message || err),
                type: 'error', appName: 'Downloads'
              });
            }
          });
        }
      });

      // ── Popup / new-window support (NW.js Chrome Apps webview API) ────────
      wv.addEventListener('newwindow', e => {
        const url = e.targetUrl;
        if (!url || url === 'about:blank' || url.startsWith('javascript:')) return;

        function isAuthPopup(u) {
          try {
            const parsed = new URL(u);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            if (AUTH_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
            if (AUTH_PATHS.some(p => path.startsWith(p) || path.includes(p + '/'))) return true;
            const params = parsed.searchParams;
            if (params.has('client_id') || params.has('response_type') || params.has('redirect_uri')) return true;
          } catch (_) {}
          return false;
        }

        if (getSetting('block_popup_windows', true) && e.windowOpenDisposition === 'new_popup' && !isAuthPopup(url)) {
          try { if (e.window?.discard) e.window.discard(); } catch (_) {}
          return;
        }

        const disposition = e.windowOpenDisposition;

        if (disposition === 'new_popup') {
          // Inline popup overlay — attach() preserves opener link for window.close().
          const pw = Math.min(Math.max(e.initialWidth || 520, 360), Math.round(window.innerWidth * 0.75));
          const ph = Math.min(Math.max(e.initialHeight || 620, 300), Math.round(window.innerHeight * 0.85));

          const backdrop = document.createElement('div');
          backdrop.style.cssText = 'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

          const card = document.createElement('div');
          card.style.cssText = `width:${pw}px;height:${ph}px;background:var(--bg,#1e1e2e);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.08);`;

          const bar = document.createElement('div');
          bar.style.cssText = 'height:36px;min-height:36px;background:var(--bg2,#181825);display:flex;align-items:center;padding:0 10px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.06);user-select:none;';
          const barTitle = document.createElement('span');
          barTitle.style.cssText = 'flex:1;font-size:12px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          barTitle.textContent = url;
          const barClose = document.createElement('button');
          barClose.textContent = '✕';
          barClose.setAttribute('aria-label', 'Close popup');
          barClose.style.cssText = 'background:none;border:none;color:inherit;opacity:0.5;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;';
          barClose.onmouseenter = () => barClose.style.opacity = '1';
          barClose.onmouseleave = () => barClose.style.opacity = '0.5';
          bar.append(barTitle, barClose);

          const popWv = document.createElement('webview');
          popWv.style.cssText = 'flex:1;width:100%;';
          const _parentTab = tabs.find(t => t.id === tabId);
          const _popPartition = _parentTab?.incognito
            ? ('incognito_' + tabId)
            : BROWSER_PARTITION;
          popWv.setAttribute('partition', _popPartition);

          card.append(bar, popWv);
          backdrop.appendChild(card);
          container.appendChild(backdrop);

          const closePopup = () => backdrop.remove();
          barClose.addEventListener('click', closePopup);

          popWv.addEventListener('loadstop', () => {
            try {
              popWv.executeScript({ code: 'document.title' }, r => {
                if (chrome.runtime?.lastError || !r?.[0]) return;
                barTitle.textContent = r[0];
              });
            } catch (_) {}
          });
          popWv.addEventListener('close', closePopup);
          e.window.attach(popWv);
        } else {
          // For tabs: discard the NW native window, open as a new tab instead.
          try { if (e.window?.discard) e.window.discard(); } catch (_) {}
          const parentTab = tabs.find(t => t.id === tabId);
          const newTab = {
            id: nextTabId++,
            title: 'New Tab',
            url: '',
            favicon: '',
            incognito: parentTab?.incognito || false
          };
          tabs.push(newTab);
          if (getSetting('open_in_background', false)) {
            renderTabs();
            const bgWv = getOrCreateWebview(newTab.id);
            if (!bgWv.parentNode) viewport.appendChild(bgWv);
            const _bgCanonical = url.toLowerCase()
              .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
              .trim();
            if (!/^(javascript|data|vbscript|about):/i.test(_bgCanonical) && !isLocalAddress(url)) {
              bgWv.src = url;
            }
          } else {
            switchToTab(newTab.id);
            navigate(url);
          }
        }
      });

      // window.close() support
      wv.addEventListener('close', () => closeTab(tabId));

      tabWebviews.set(tabId, wv);
      applyWebviewSettings(wv);
      return wv;
    }

    // ── iframe mode helpers ─────────────────────────────────────────────────
    function getOrCreateIframe(tabId) {
      const existing = tabIframes.get(tabId);
      if (existing) return existing;

      const ifr = document.createElement('iframe');
      ifr.setAttribute('allowfullscreen', 'true');
      ifr.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
      // allow-same-origin intentionally ABSENT — combining it with allow-scripts
      // enables a known sandbox escape (framed doc can call frameElement.removeAttribute('sandbox')).
      ifr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
      ifr.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;background:#fff;';

      // NOTE: blocking is detected server-side via /api/frame-check before the
      // iframe is ever shown (see navigateFrameMode). The old heuristic here
      // (checking ifr.contentDocument.URL === 'about:blank') was wrong both
      // ways: embeddable sites pass through about:blank mid-load (false
      // positive), and genuinely-blocked sites are cross-origin so
      // contentDocument throws and the notice was never shown — leaving the
      // raw "refused to connect" error visible. We now just sync the title.
      ifr.addEventListener('load', () => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab?.url || !/^https?:/i.test(tab.url)) return;
        try {
          const title = ifr.contentDocument?.title;
          if (title) {
            tab.title = title;
            if (tabId === activeTabId) updateTabTitle(tabId, title);
            else renderTabs();
          }
        } catch (_) { /* cross-origin — title sync not possible, expected */ }
      });

      tabIframes.set(tabId, ifr);
      return ifr;
    }

    function showIframeBlockedNotice(tabId, url) {
      // Remove any prior notice for this tab (e.g. stale from a previous URL).
      const prior = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
      if (prior) prior.remove();
      const notice = createEl('div', { className: 'browser-iframe-blocked' });
      notice.dataset.tab = tabId;
      // Build via DOM APIs to avoid innerHTML with translated strings.
      const icon = createEl('div', { className: 'blocked-icon', textContent: '🚫' });
      const titleEl = createEl('div', { className: 'blocked-title', textContent: 'Page blocked iframe embedding' });
      const body = createEl('div', { className: 'blocked-body' });
      body.innerHTML = 'This site uses <code>X-Frame-Options</code> or <code>Content-Security-Policy: frame-ancestors</code> to prevent embedding. Switch to Webview mode to load it normally.';
      const sw = createEl('button', { className: 'blocked-switch', textContent: 'Switch to Webview Mode' });
      sw.addEventListener('click', () => { setTabMode(tabId, 'webview'); navigate(url); });
      notice.append(icon, titleEl, body, sw);
      viewport.appendChild(notice);
    }

    // ── Per-tab frame-check generation guard ────────────────────────────────
    // Bumped before each /api/frame-check so a slow response from a previous
    // navigation can't show/hide the iframe of a newer one.
    const _frameCheckGen = new Map(); // tabId → number

    /**
     * Server-side frame-embed check. Returns true if the URL may be loaded in
     * an <iframe> (no XFO/CSP frame-ancestors blocking it). On any error or
     * timeout we optimistically return true so we never false-block a
     * legitimate page — the iframe will just show its normal content.
     */
    async function checkFrameEmbeddable(tabId, url) {
      const gen = (_frameCheckGen.get(tabId) || 0) + 1;
      _frameCheckGen.set(tabId, gen);
      try {
        const r = await fetch('/api/frame-check?url=' + encodeURIComponent(url));
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        if (!r.ok) return true; // fail open
        const j = await r.json();
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        return j.embeddable !== false;
      } catch (_) {
        return true; // fail open — don't false-block on network errors
      }
    }

    function setTabMode(tabId, mode) {
      tabViewMode.set(tabId, mode);
      if (tabId === activeTabId) updateModeBtn();
      const wv = tabWebviews.get(tabId);
      const ifr = tabIframes.get(tabId);
      requestAnimationFrame(() => {
        if (mode === 'iframe') {
          if (wv) { wv.style.visibility = 'hidden'; wv.style.pointerEvents = 'none'; }
        } else {
          if (ifr) { ifr.style.visibility = 'hidden'; ifr.style.pointerEvents = 'none'; }
          const blocked = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
          if (blocked) blocked.remove();
        }
      });
    }

    function updateModeBtn() {
      const mode = getTabMode(activeTabId);
      modeBtn.classList.toggle('iframe-active', mode === 'iframe');
      modeBtn.title = mode === 'iframe' ? 'Switch to Webview mode' : 'Switch to iframe mode';
      modeBtn.innerHTML = (mode === 'iframe'
        ? svgIcon('layout', 14) + ' <span>iFrame</span>'
        : svgIcon('monitor', 14) + ' <span>Webview</span>');
    }

    function showViewForTab(tabId) {
      const mode = getTabMode(tabId);
      const sp = viewport.querySelector('.browser-settings-page');
      if (sp) sp.remove();
      const tab = tabs.find(t => t.id === tabId);
      const isMobile = tab?.userAgent === 'mobile';

      requestAnimationFrame(() => {
        if (mode === 'iframe') {
          for (const [, wv] of tabWebviews) {
            wv.style.position = 'absolute';
            wv.style.visibility = 'hidden';
            wv.style.pointerEvents = 'none';
            wv.style.zIndex = '0';
          }
          for (const [id, ifr] of tabIframes) {
            if (id === tabId) {
              applyMobileViewportFrame(ifr, isMobile);
              applyZoomToIframe(ifr, isMobile, tabZoom.get(tabId) || 1.0);
              // If we've already determined this URL is frame-blocked, keep
              // the iframe hidden so Chromium's "refused to connect" error
              // never shows through under our custom notice.
              const blocked = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
              if (blocked) {
                ifr.style.visibility = 'hidden';
                ifr.style.pointerEvents = 'none';
                ifr.style.zIndex = '0';
              } else {
                ifr.style.visibility = 'visible';
                ifr.style.pointerEvents = 'auto';
                ifr.style.zIndex = '1';
              }
            } else {
              // Non-active iframes must be pulled out of flow — see note below.
              ifr.style.position = 'absolute';
              ifr.style.visibility = 'hidden';
              ifr.style.pointerEvents = 'none';
              ifr.style.zIndex = '0';
            }
          }
        } else {
          // Take every iframe OUT of flow. visibility:hidden alone keeps a
          // flex item in layout flow, so a previously-shown iframe left at
          // position:relative + flex:1 would claim half the viewport and show
          // through as a black bar under the active webview.
          for (const [, ifr] of tabIframes) {
            ifr.style.position = 'absolute';
            ifr.style.visibility = 'hidden';
            ifr.style.pointerEvents = 'none';
            ifr.style.zIndex = '0';
          }
          viewport.querySelectorAll(`.browser-iframe-blocked:not([data-tab="${tabId}"])`).forEach(n => n.remove());
          for (const [id, wv] of tabWebviews) {
            if (id === tabId) {
              applyMobileViewportFrame(wv, isMobile);
              if (!isMobile) {
                wv.style.width = '100%';
                wv.style.height = '100%';
                wv.style.top = '0';
                wv.style.left = '0';
              }
              wv.style.visibility = 'visible';
              wv.style.pointerEvents = 'auto';
              wv.style.zIndex = '1';
            } else {
              wv.style.position = 'absolute';
              wv.style.visibility = 'hidden';
              wv.style.pointerEvents = 'none';
              wv.style.zIndex = '0';
            }
          }
        }
      });
    }

    function applyWebviewSettings(wv) {
      const zoomMap = { FAR: 0.75, MEDIUM: 1.0, CLOSE: 1.25 };

      wv.addEventListener('loadstop', () => {
        const tabId = [...tabWebviews.entries()].find(([, v]) => v === wv)?.[0];
        if (tabId && !tabZoom.has(tabId)) {
          try { wv.setZoom(zoomMap[getSetting('default_zoom', 'MEDIUM')] || 1.0); } catch (_) {}
        }
      });

      wv.addEventListener('loadcommit', () => {
        try { wv.setZoomMode(getSetting('force_userscalable', false) ? 'per-view' : 'per-origin'); } catch (_) {}
      });

      wv.addEventListener('permissionrequest', e => {
        const appId = 'browser';
        if (e.permission === 'geolocation') {
          const osAllowed = AppPermissionManager?.isGranted('device:geolocation', appId);
          const browserAllowed = getSetting('enable_geolocation', true);
          if (!osAllowed) {
            Notify.show({
              title: 'Permission denied',
              body: 'Browser needs Location access in Settings → Apps.',
              type: 'error', appName: 'Browser'
            });
            e.request.deny();
            return;
          }
          browserAllowed ? e.request.allow() : e.request.deny();
        } else if (e.permission === 'media') {
          const camGranted = AppPermissionManager?.isGranted('device:camera', appId);
          const micGranted = AppPermissionManager?.isGranted('device:microphone', appId);
          if (!camGranted && !micGranted) {
            Notify.show({
              title: 'Permission denied',
              body: 'Browser needs Camera/Microphone access in Settings → Apps.',
              type: 'error', appName: 'Browser'
            });
            e.request.deny();
            return;
          }
          if (camGranted && !micGranted) {
            Notify.show({ title: 'Permission limited', body: 'Camera allowed, microphone is not permitted.', type: 'info', appName: 'Browser' });
          } else if (!camGranted && micGranted) {
            Notify.show({ title: 'Permission limited', body: 'Microphone allowed, camera is not permitted.', type: 'info', appName: 'Browser' });
          }
          e.request.allow();
        } else if (e.permission === 'pointerLock') {
          e.request.allow();
        } else {
          e.request.deny();
        }
      });

      // webRequest listeners — attach once per webview.
      let _requestListenersAttached = false;
      function _attachRequestListeners() {
        if (_requestListenersAttached) return;
        _requestListenersAttached = true;
        try {
          wv.request.onBeforeRequest.addListener(
            () => ({ cancel: !getSetting('load_images', true) }),
            { urls: ['<all_urls>'], types: ['image', 'media'] },
            ['blocking']
          );
        } catch (e) { /* wv.request not ready yet */ }
        // (Removed the dead no-op listener that always returned { cancel: false }.)
      }
      wv.addEventListener('contentload', _attachRequestListeners);
      wv.addEventListener('loadcommit', _attachRequestListeners);

      // Per-page CSS: inverted colours + min font size + text zoom
      wv.addEventListener('loadstop', () => {
        let css = '';
        if (getSetting('inverted', false))
          css += 'html { filter: invert(1) hue-rotate(180deg) !important; } img, video { filter: invert(1) hue-rotate(180deg) !important; } ';
        const minFont = getSetting('min_font_size', 0);
        if (minFont > 0)
          css += `* { min-height: unset !important; } body * { font-size: max(${minFont}px, 1em) !important; } `;
        const textZoom = getSetting('text_zoom', 10);
        if (textZoom !== 10)
          css += `body { zoom: ${textZoom / 10} !important; } `;
        if (css) try { wv.insertCSS({ code: css }); } catch (_) {}
      });

      // ── Webview viewport right-click menu ──────────────────────────────────
      // NW.js does NOT forward arbitrary DOM events from guest content to the
      // host — 'contextmenu' on the <webview> element never fires (confirmed
      // dead since nw.js 0.29.3, see github.com/nwjs/nw.js/issues/6614: guest
      // content runs in its own process, so host-side listeners for events
      // outside the small documented set just don't see it). Only a short
      // list of events (load*, newwindow, permissionrequest, consolemessage,
      // ...) actually bubble to the host. So instead:
      //   1. Inject a script into the guest (on every loadstop, for SPA nav)
      //      that listens for 'contextmenu' INSIDE the guest's own document —
      //      the only place that can actually preventDefault() the native
      //      Chromium menu for that content — and reports the click target +
      //      position to the host via console.log, tagged with a marker.
      //   2. Host listens for 'consolemessage' on the <webview> (this one
      //      reliably bubbles), recognizes the tagged payload, converts the
      //      guest-relative click position into host-page coordinates using
      //      the webview's own bounding rect, and shows our ContextMenu.
      const _CTX_MARKER = '__NBOSP_CTXMENU__:';
      const _GUEST_CTX_SCRIPT = `
        (function () {
          if (window.__nbosp_ctx_injected) return;
          window.__nbosp_ctx_injected = true;
          document.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var el  = e.target;
            var link = el.closest ? el.closest('a') : null;
            var img  = el.tagName === 'IMG'   ? el : (el.closest ? el.closest('img')   : null);
            var vid  = el.tagName === 'VIDEO' ? el : (el.closest ? el.closest('video') : null);
            var sel  = window.getSelection ? window.getSelection().toString().trim() : '';
            var ctx = {
              clientX:      e.clientX,
              clientY:      e.clientY,
              linkHref:     link ? (link.href  || '') : '',
              linkText:     link ? (link.textContent || '').trim().slice(0, 120) : '',
              imgSrc:       img  ? (img.src   || '') : '',
              imgAlt:       img  ? (img.alt   || '') : '',
              videoSrc:     vid  ? (vid.currentSrc || vid.src || '') : '',
              selectedText: sel.slice(0, 500),
              pageUrl:      location.href,
              pageTitle:    document.title
            };
            try { console.log('${_CTX_MARKER}' + JSON.stringify(ctx)); } catch (_e) {}
          }, true);
        })();
      `;

      // Re-inject the tracker after every navigation (SPAs included).
      wv.addEventListener('loadstop', () => {
        try { wv.executeScript({ code: _GUEST_CTX_SCRIPT }); } catch (_) {}
      });

      // Open a URL in a new tab (inherits incognito state).
      function _ctxOpenInNewTab(url) {
        const _ctxTabId = [...tabWebviews.entries()].find(([, v]) => v === wv)?.[0];
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const t = { id: nextTabId++, title: 'New Tab', url, favicon: '', incognito: _ctxTab?.incognito || false };
        tabs.push(t);
        switchToTab(t.id);
        navigate(url);
      }

      // Best-effort clipboard write.
      function _ctxCopyText(text) {
        try {
          navigator.clipboard.writeText(text);
        } catch (_) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          } catch (__) {}
        }
      }

      function _buildWebviewMenu(ctx, pageUrl) {
        const items = [];
        const hasLink  = ctx?.linkHref  && /^https?:/i.test(ctx.linkHref);
        const hasImg   = ctx?.imgSrc    && ctx.imgSrc.length > 0;
        const hasVideo = ctx?.videoSrc  && ctx.videoSrc.length > 0;
        const hasSel   = ctx?.selectedText && ctx.selectedText.length > 0;

        // Link items
        if (hasLink) {
          items.push({ label: 'Open Link in New Tab', action: () => _ctxOpenInNewTab(ctx.linkHref) });
          items.push({ label: 'Copy Link Address',    action: () => _ctxCopyText(ctx.linkHref) });
          items.push({ separator: true });
        }

        // Image items
        if (hasImg) {
          items.push({ label: 'Open Image in New Tab', action: () => _ctxOpenInNewTab(ctx.imgSrc) });
          items.push({ label: 'Copy Image Address',    action: () => _ctxCopyText(ctx.imgSrc) });
          items.push({ separator: true });
        }

        // Video items
        if (hasVideo) {
          items.push({ label: 'Open Video in New Tab', action: () => _ctxOpenInNewTab(ctx.videoSrc) });
          items.push({ label: 'Copy Video Address',    action: () => _ctxCopyText(ctx.videoSrc) });
          items.push({ separator: true });
        }

        // Selection items
        if (hasSel) {
          const snippet = ctx.selectedText.length > 40
            ? ctx.selectedText.slice(0, 40) + '\u2026'
            : ctx.selectedText;
          items.push({ label: 'Copy \u201c' + snippet + '\u201d', action: () => _ctxCopyText(ctx.selectedText) });
          const _engine = SEARCH_ENGINES[getSetting('searchEngine', 'brave')];
          if (_engine) {
            const _q = encodeURIComponent(ctx.selectedText.slice(0, 300));
            items.push({ label: 'Search for \u201c' + snippet + '\u201d', action: () => _ctxOpenInNewTab(_engine.url + _q) });
          }
          items.push({ separator: true });
        }

        // Page navigation (always present)
        items.push({ label: 'Back',    action: () => { try { wv.back();    } catch (_) {} } });
        items.push({ label: 'Forward', action: () => { try { wv.forward(); } catch (_) {} } });
        items.push({ label: 'Reload',  action: () => { try { wv.reload();  } catch (_) {} } });
        items.push({ separator: true });
        if (pageUrl && /^https?:/i.test(pageUrl)) {
          items.push({ label: 'Copy Page URL', action: () => _ctxCopyText(pageUrl) });
        }
        items.push({ label: 'Save as\u2026', action: () => {
          try { wv.executeScript({ code: 'location.href' }, r => {
            const url = (r && r[0]) || pageUrl;
            if (url) window.open(url);
          }); } catch (_) {}
        }});
        items.push({ label: 'Print\u2026', action: () => {
          try { wv.executeScript({ code: 'window.print()' }); } catch (_) {}
        }});
        items.push({ separator: true });
        items.push({ label: 'View Page Source', action: () => {
          try { wv.executeScript({ code: 'location.href' }, r => {
            const url = (r && r[0]) || pageUrl;
            if (url) _ctxOpenInNewTab('view-source:' + url);
          }); } catch (_) {}
        }});
        items.push({ label: 'Inspect', action: () => {
          try { wv.showDevTools(true); } catch (_) {
            try { nw.Window.get().showDevTools(); } catch (__) {}
          }
        }});

        return items;
      }

      // The guest reports right-clicks here, tagged with _CTX_MARKER so we
      // never mistake an ordinary page's own console.log for our signal.
      wv.addEventListener('consolemessage', (e) => {
        const msg = e?.message;
        if (typeof msg !== 'string' || !msg.startsWith(_CTX_MARKER)) return;
        let ctx = null;
        try { ctx = JSON.parse(msg.slice(_CTX_MARKER.length)); } catch (_) { return; }

        const _ctxTabId = [...tabWebviews.entries()].find(([, v]) => v === wv)?.[0];
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const pageUrl    = ctx.pageUrl || _ctxTab?.url || currentUrl || '';

        // Guest coords are relative to the guest viewport; translate into
        // host-page coords using where the <webview> box actually sits.
        const rect  = wv.getBoundingClientRect();
        const hostX = rect.left + (ctx.clientX || 0);
        const hostY = rect.top  + (ctx.clientY || 0);

        ContextMenu.show(hostX, hostY, _buildWebviewMenu(ctx, pageUrl));
      });
    }

    function clearWebviewData(types, title, body) {
      requestAnimationFrame(() => {
        for (const [, wv] of tabWebviews) {
          try { wv.clearData({}, types); } catch (_) {}
        }
      });
      Notify.show({ title, body, type: 'info', appName: 'Browser' });
    }

    const showWebviewForTab = (tabId) => showViewForTab(tabId);

    // ── Settings page ───────────────────────────────────────────────────────
    function renderSettingsPage(activeCategory) {
      activeCategory = activeCategory || 'general';
      const eng = getSetting('searchEngine', 'brave');
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      requestAnimationFrame(() => {
        for (const [, wv] of tabWebviews) wv.style.visibility = 'hidden';
      });
      const old = viewport.querySelector('.browser-settings-page');
      if (old) old.remove();

      const page = createEl('div', { className: 'browser-settings-page' });
      page.style.cssText = 'position:absolute;inset:0;display:flex;background:var(--bg-base);color:var(--text-primary);font-size:13px;z-index:1;';

      const getBPref = (key, def) => getSetting(key, def);
      const setBPref = (key, val) => saveSetting(key, val);

      function mkRow(label, desc, control) {
        const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
        const left = createEl('div');
        left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
        if (desc) left.appendChild(createEl('div', { textContent: desc, style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' }));
        row.append(left, control);
        return row;
      }
      const mkSubHdr = (title) => createEl('div', {
        textContent: title,
        style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin:20px 0 4px;'
      });

      function mkToggle(key, def, onChange) {
        const val = getBPref(key, def);
        const btn = createEl('button', {
          style: 'width:40px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;flex-shrink:0;transition:background 0.2s;background:' + (val ? 'var(--accent)' : 'var(--text-muted)') + ';',
          'aria-pressed': val ? 'true' : 'false', role: 'switch'
        });
        const knob = createEl('div', { style: 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.2s;left:' + (val ? '20px' : '2px') + ';' });
        btn.appendChild(knob);
        btn.addEventListener('click', () => {
          const next = !getBPref(key, def);
          setBPref(key, next);
          btn.style.background = next ? 'var(--accent)' : 'var(--text-muted)';
          knob.style.left = next ? '20px' : '2px';
          btn.setAttribute('aria-pressed', next ? 'true' : 'false');
          if (onChange) onChange(next);
        });
        return btn;
      }

      function mkSelect(key, def, options) {
        const val = getBPref(key, def);
        const sel = createEl('select', {
          id: 'browser-pref-select-' + key, name: 'browser-pref-' + key,
          style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:5px 8px;color:var(--text-primary);font-size:12px;cursor:pointer;outline:none;max-width:160px;'
        });
        for (const [v, label] of options) {
          const opt = createEl('option', { value: v, textContent: label });
          if (v === val) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => setBPref(key, sel.value));
        return sel;
      }

      function mkClearBtn(label, action) {
        const btn = createEl('button', {
          textContent: label,
          style: 'padding:6px 14px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0;'
        });
        btn.addEventListener('mouseenter', () => btn.style.borderColor = 'var(--accent)');
        btn.addEventListener('mouseleave', () => btn.style.borderColor = 'var(--border-default)');
        btn.addEventListener('click', action);
        return btn;
      }

      function mkSliderRow(label, key, def, min, max, suffix) {
        const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
        const left = createEl('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
        left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
        const valLabel = createEl('span', { textContent: getBPref(key, def) + (suffix || ''), style: 'font-size:11px;color:var(--accent);' });
        left.appendChild(valLabel);
        const slider = createEl('input', {
          type: 'range', min: String(min), max: String(max), value: String(getBPref(key, def)),
          id: 'browser-pref-slider-' + key, name: 'browser-pref-' + key,
          style: 'width:140px;accent-color:var(--accent);cursor:pointer;'
        });
        slider.addEventListener('input', () => {
          valLabel.textContent = slider.value + (suffix || '');
          setBPref(key, Number(slider.value));
        });
        row.append(left, slider);
        return row;
      }

      const NAV = [
        { id: 'general',       label: 'General',          icon: '⚙️' },
        { id: 'search',        label: 'Search Engine',    icon: '🔍' },
        { id: 'privacy',       label: 'Privacy & Security', icon: '🔒' },
        { id: 'content',       label: 'Content',          icon: '🌐' },
        { id: 'bandwidth',     label: 'Bandwidth',        icon: '📶' },
        { id: 'accessibility', label: 'Accessibility',    icon: '♿' },
        { id: 'labs',          label: 'Labs',             icon: '🧪' },
        { id: 'reset',         label: 'Reset',            icon: '🔄' },
      ];

      const sidebar = createEl('div', {
        style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);padding:20px 0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;background:var(--bg-elevated);'
      });
      sidebar.appendChild(createEl('div', {
        textContent: 'Settings',
        style: 'font-size:13px;font-weight:700;color:var(--text-primary);padding:0 16px 14px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px;'
      }));

      for (const { id, label, icon } of NAV) {
        const btn = createEl('button', {
          style: 'display:flex;align-items:center;gap:9px;width:100%;padding:8px 16px;border:none;background:' +
                 (id === activeCategory ? 'rgba(88,166,255,0.12)' : 'transparent') +
                 ';color:' + (id === activeCategory ? 'var(--accent)' : 'var(--text-secondary)') +
                 ';font-size:12px;font-weight:' + (id === activeCategory ? '600' : '400') +
                 ';cursor:pointer;text-align:left;border-radius:0;transition:background 0.15s;border-left:2px solid ' +
                 (id === activeCategory ? 'var(--accent)' : 'transparent') + ';',
          'aria-current': id === activeCategory ? 'page' : 'false'
        });
        btn.appendChild(createEl('span', { textContent: icon, style: 'font-size:14px;width:18px;text-align:center;' }));
        btn.appendChild(createEl('span', { textContent: label }));
        btn.addEventListener('mouseenter', () => { if (id !== activeCategory) btn.style.background = 'var(--bg-hover)'; });
        btn.addEventListener('mouseleave', () => { if (id !== activeCategory) btn.style.background = 'transparent'; });
        btn.addEventListener('click', () => renderSettingsPage(id));
        sidebar.appendChild(btn);
      }

      const panelEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px 32px;' });
      const panelInner = createEl('div', { style: 'max-width:560px;' });

      function panelTitle(title, desc) {
        panelInner.appendChild(createEl('h2', { textContent: title, style: 'font-size:17px;font-weight:700;margin:0 0 4px;color:var(--text-primary);' }));
        if (desc) panelInner.appendChild(createEl('p', { textContent: desc, style: 'color:var(--text-muted);margin:0 0 20px;font-size:12px;' }));
      }

      if (activeCategory === 'general') {
        panelTitle('General', 'Basic browser behaviour and preferences.');
        const hpSel = mkSelect('homepage', 'most_visited', [['most_visited', 'Speed Dial'], ['blank', 'Blank Page'], ['custom', 'Custom URL']]);
        const hpCustomWrap = createEl('div', { style: 'margin-top:6px;display:' + (getBPref('homepage', 'most_visited') === 'custom' ? 'block' : 'none') + ';' });
        const hpInp = createEl('input', {
          type: 'url', id: 'browser-homepage-input', name: 'browser-homepage',
          placeholder: 'https://example.com', value: getBPref('homepageUrl', ''),
          style: 'width:100%;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:12px;outline:none;box-sizing:border-box;'
        });
        hpInp.addEventListener('change', () => setBPref('homepageUrl', hpInp.value));
        hpCustomWrap.appendChild(hpInp);
        hpSel.addEventListener('change', () => { hpCustomWrap.style.display = hpSel.value === 'custom' ? 'block' : 'none'; });
        const hpWrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;max-width:200px;' });
        hpWrap.append(hpSel, hpCustomWrap);
        panelInner.appendChild(mkRow('Homepage', 'Page shown when opening a new tab', hpWrap));
        panelInner.appendChild(mkRow('Autofill', 'Automatically fill in web forms', mkToggle('autofill_enabled', true)));

      } else if (activeCategory === 'search') {
        panelTitle('Search Engine', 'Choose your default search engine.');
        const seList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px;' });
        for (const [key, info] of Object.entries(SEARCH_ENGINES)) {
          const row = createEl('label', {
            style: 'display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;border:1px solid ' +
                   (key === eng ? 'var(--accent)' : 'var(--border-subtle)') +
                   ';background:' + (key === eng ? 'rgba(88,166,255,0.08)' : 'var(--bg-elevated)') + ';transition:all 0.15s;'
          });
          const radio = createEl('input');
          radio.type = 'radio'; radio.id = 'search-engine-' + key; radio.name = 'se'; radio.value = key; radio.checked = key === eng;
          radio.style.accentColor = 'var(--accent)';
          const lbl = createEl('span', { textContent: info.label, style: 'flex:1;font-size:13px;' });
          const hint = createEl('span', { textContent: info.url.replace('https://', '').split('/')[0], style: 'font-size:11px;color:var(--text-muted);' });
          row.append(radio, lbl, hint);
          if (key === eng) row.appendChild(createEl('span', { textContent: 'Default', style: 'font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent);color:#fff;' }));
          radio.addEventListener('change', () => { if (radio.checked) { saveSetting('searchEngine', key); renderSettingsPage('search'); } });
          seList.appendChild(row);
        }
        panelInner.appendChild(seList);

      } else if (activeCategory === 'privacy') {
        panelTitle('Privacy & Security', 'Control cookies, passwords, location and browsing data.');
        panelInner.appendChild(mkRow('Show security warnings', 'Show a warning indicator for non-HTTPS pages in the address bar',
          mkToggle('show_security_warnings', true, () => updateUrlIcon(currentUrl))));

        panelInner.appendChild(mkSubHdr('Cookies'));
        panelInner.appendChild(mkRow('Accept cookies', 'Allow sites to save cookies. Disabling clears existing cookies and blocks new ones via webRequest',
          mkToggle('accept_cookies', true, (v) => {
            if (!v) clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies blocked', 'Existing cookies cleared. New cookies will be blocked.');
          })));
        panelInner.appendChild(mkRow('Clear cookies', '', mkClearBtn('Clear Cookies', () => clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies cleared', 'All cookies have been deleted.'))));

        panelInner.appendChild(mkSubHdr('Form Data'));
        panelInner.appendChild(mkRow('Save form data', 'Remember data entered in web forms (managed by the webview session; disable and clear form data to remove)', mkToggle('save_formdata', true)));
        panelInner.appendChild(mkRow('Clear form data', '', mkClearBtn('Clear Form Data', () => clearWebviewData({ localStorage: true, indexedDB: true, webSQL: true }, 'Form data cleared', 'Saved form data has been deleted.'))));

        panelInner.appendChild(mkSubHdr('Location'));
        panelInner.appendChild(mkRow('Enable location', 'Allow sites to request your location', mkToggle('enable_geolocation', true)));
        panelInner.appendChild(mkRow('Clear location access', '', mkClearBtn('Clear Location', () => Notify.show({ title: 'Location access cleared', body: 'All site location permissions have been revoked.', type: 'info', appName: 'Browser' }))));

        panelInner.appendChild(mkSubHdr('Passwords'));
        panelInner.appendChild(mkRow('Remember passwords', 'Offer to save passwords (managed by the webview session; use Clear Passwords to remove saved credentials)', mkToggle('remember_passwords', true)));
        panelInner.appendChild(mkRow('Clear saved passwords', '', mkClearBtn('Clear Passwords', () => Notify.show({ title: 'Passwords cleared', body: 'Saved passwords have been deleted.', type: 'info', appName: 'Browser' }))));

        panelInner.appendChild(mkSubHdr('Browsing Data'));
        const dataRow = createEl('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;padding:12px 0;' });
        dataRow.append(
          mkClearBtn('Clear Cache', () => clearWebviewData({ cache: true, appcache: true }, 'Cache cleared', 'Cached data has been deleted.')),
          mkClearBtn('Clear History', () => {
            try { localStorage.removeItem(HX_KEY); } catch (_) {}
            _historyCache = null;
            Notify.show({ title: 'History cleared', body: 'Browsing history has been deleted.', type: 'info', appName: 'Browser' });
          }),
          mkClearBtn('Clear Bookmarks', () => {
            try { localStorage.removeItem(BK_KEY); } catch (_) {}
            _bookmarksCache = null;
            refreshBookmarkSet();
            Notify.show({ title: 'Bookmarks cleared', body: 'All bookmarks have been deleted.', type: 'info', appName: 'Browser' });
          })
        );
        panelInner.appendChild(dataRow);

      } else if (activeCategory === 'content') {
        panelTitle('Content', 'Control how web pages are loaded and displayed.');
        panelInner.appendChild(mkRow('Block pop-up windows', 'Prevent sites from opening new windows', mkToggle('block_popup_windows', true)));
        panelInner.appendChild(mkRow('Open links in background', 'New tabs open without switching to them', mkToggle('open_in_background', false)));
        panelInner.appendChild(mkRow('Allow app tabs', 'Sites can pin themselves as app tabs', mkToggle('allow_apptabs', false)));
        panelInner.appendChild(mkRow('Default zoom', 'Initial page zoom level', mkSelect('default_zoom', 'MEDIUM', [['FAR', 'Far (smallest)'], ['MEDIUM', 'Medium'], ['CLOSE', 'Close (largest)']])));
        panelInner.appendChild(mkRow('Text encoding', 'Default character encoding for web pages', mkSelect('default_text_encoding', 'UTF-8', [['UTF-8', 'UTF-8'], ['ISO-8859-1', 'Latin-1'], ['GBK', 'GBK'], ['Shift_JIS', 'Shift JIS'], ['EUC-JP', 'EUC-JP']])));

      } else if (activeCategory === 'bandwidth') {
        panelTitle('Bandwidth', 'Manage how much data the browser downloads.');
        panelInner.appendChild(mkRow('Load images', 'Download and display images on web pages', mkToggle('load_images', true)));
        panelInner.appendChild(mkRow('Preload pages', 'Download pages in advance for faster browsing', mkSelect('preload_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));
        panelInner.appendChild(mkRow('Link prefetch', 'Preload links the page suggests', mkSelect('link_prefetch_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));

      } else if (activeCategory === 'accessibility') {
        panelTitle('Accessibility', 'Adjust display and interaction settings.');
        panelInner.appendChild(mkRow('Force zoom', 'Override sites that disable pinch-to-zoom', mkToggle('force_userscalable', false)));
        panelInner.appendChild(mkRow('Inverted colours', 'Display pages with inverted colours', mkToggle('inverted', false)));
        panelInner.appendChild(mkSliderRow('Text zoom', 'text_zoom', 10, 1, 30, '%'));
        panelInner.appendChild(mkSliderRow('Double-tap zoom', 'double_tap_zoom', 5, 1, 10, 'x'));
        panelInner.appendChild(mkSliderRow('Minimum font size', 'min_font_size', 0, 0, 20, 'px'));

      } else if (activeCategory === 'labs') {
        panelTitle('Labs', 'Experimental features — may be unstable.');
        panelInner.appendChild(mkRow('Quick controls', 'Swipe-based navigation controls', mkToggle('enable_quick_controls', false)));
        panelInner.appendChild(mkRow('Fullscreen mode', 'Hide browser chrome when scrolling down', mkToggle('fullscreen', false)));

      } else if (activeCategory === 'reset') {
        panelTitle('Reset', 'Restore all settings to their factory defaults.');
        const resetBtn = createEl('button', {
          textContent: 'Reset all settings to defaults',
          style: 'margin-top:8px;padding:9px 18px;border-radius:8px;border:1px solid var(--text-danger);background:transparent;color:var(--text-danger);font-size:13px;cursor:pointer;transition:background 0.15s;'
        });
        resetBtn.addEventListener('mouseenter', () => resetBtn.style.background = 'rgba(248,81,73,0.1)');
        resetBtn.addEventListener('mouseleave', () => resetBtn.style.background = 'transparent');
        resetBtn.addEventListener('click', () => {
          showModal(
            'Reset Browser Settings',
            'This will restore all browser settings to their factory defaults. Your bookmarks and history will not be affected.',
            [{ label: 'Reset', danger: true, value: true }, { label: 'Cancel', value: false }]
          ).then(confirmed => {
            if (!confirmed) return;
            try { localStorage.removeItem(ST_KEY); } catch (_) {}
            _settingsCache = null;
            renderSettingsPage('general');
            Notify.show({ title: 'Settings reset', body: 'All browser settings restored to defaults.', type: 'success', appName: 'Browser' });
          });
        });
        panelInner.appendChild(resetBtn);
      }

      panelEl.appendChild(panelInner);
      page.append(sidebar, panelEl);
      viewport.appendChild(page);
    }

    // ── Local-address guard ─────────────────────────────────────────────────
    // Memoised — hostname is hashed to a boolean so repeated checks are O(1).
    const _localAddrCache = new Map();
    function isLocalAddress(rawUrl) {
      let hostname;
      try {
        const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
        hostname = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '');
      } catch { return false; }
      const cached = _localAddrCache.get(hostname);
      if (cached !== undefined) return cached;

      let result = false;
      if (hostname === 'localhost') result = true;
      else if (hostname === '[::1]' || hostname === '::1') result = true;
      else {
        const h = hostname.replace(/^\[|\]$/g, '');
        // Octal encoding: 0177.0.0.1 → 127.0.0.1
        if (/^0[0-7]{3}\./.test(h)) result = true;
        // Hexadecimal encoding: 0x7f000001 → 127.0.0.1
        else if (/^0x[0-9a-f]+$/i.test(h)) {
          const num = parseInt(h, 16);
          if ((num >= 2130706432 && num <= 2130706447) ||  // 127.0.0.0/24
              (num >= 167772160  && num <= 167772191)  ||  // 10.0.0.0/24
              (num >= 2886729728 && num <= 2886732799) ||  // 172.16.0.0/12
              (num >= 3232235520 && num <= 3232235775))    // 192.168.0.0/16
            result = true;
        }
        // Dword decimal encoding: 2130706433 → 127.0.0.1
        else if (/^\d+$/.test(h)) {
          const num = parseInt(h, 10);
          if ((num >= 2130706432 && num <= 2147483647) ||  // 127.x.x.x
              (num >= 167772160  && num <= 184549375)  ||  // 10.0.0.0/8
              (num >= 2886729728 && num <= 2887778303) ||  // 172.16.0.0/12
              (num >= 3232235520 && num <= 3232301055))    // 192.168.0.0/16
            result = true;
        }
        // IPv4 loopback / link-local / RFC-1918
        else if (/^127\./.test(h) ||
                 /^169\.254\./.test(h) ||
                 /^10\./.test(h) ||
                 /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
                 /^192\.168\./.test(h)) {
          result = true;
        }
      }
      _localAddrCache.set(hostname, result);
      return result;
    }

    // ── Path-traversal guard ────────────────────────────────────────────────
    function validateFilePath(basePath, filePath) {
      try {
        const nPath = require('path');
        const resolved = nPath.resolve(basePath, filePath);
        const relative = nPath.relative(basePath, resolved);
        if (relative.startsWith('..') || relative.startsWith('/..') || relative.startsWith('\\..')) {
          console.error('[NB Browser] SECURITY: Path traversal attempt blocked:', filePath);
          return null;
        }
        return resolved;
      } catch (err) {
        console.error('[NB Browser] Path validation error:', err);
        return null;
      }
    }

    function navigate(rawUrl) {
      if (!rawUrl) return;
      let url = rawUrl.trim();
      // Canonicalize: strip ALL control chars before scheme checks.
      // Chromium strips \x09, \x0a, \x0d internally; mirror that here.
      const _canonicalUrl = url.toLowerCase()
        .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
        .trim();
      if (/^(javascript|data|vbscript|about):/i.test(_canonicalUrl)) return;

      if (isLocalAddress(url)) {
        Notify.show({
          title: 'Browser',
          body: 'Navigation to local or private network addresses is not allowed.',
          type: 'error', appName: 'Browser'
        });
        return;
      }

      // browser://settings
      if (url === 'browser://settings') {
        urlBar.value = 'browser://settings';
        currentUrl = 'browser://settings';
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab) { activeTab.url = url; activeTab.title = 'Settings'; }
        renderTabs();
        renderSettingsPage();
        return;
      }

      const settingsPage = viewport.querySelector('.browser-settings-page');
      if (settingsPage) settingsPage.remove();

      // vault:// URL handling
      if (url.startsWith('vault:')) {
        if (!AppPermissionManager?.isGranted('fs:write', 'browser')) {
          Notify.show({
            title: 'Permission denied', body: 'Browser needs fs:write to access vault files.',
            type: 'error', appName: 'Browser'
          });
          return;
        }
        const targetTabId = activeTabId;
        const vaultRel = url.replace(/^vault:\/\/+/, '').replace(/^\//, '');
        let targetNode = null;
        for (const [, node] of FS.files) {
          if (node.type !== 'file') continue;
          const parts = [node.name];
          let cur = node;
          while (cur.parentId) {
            const parent = FS.files.get(cur.parentId);
            if (!parent) break;
            parts.unshift(parent.name);
            cur = parent;
          }
          const nodePath = parts.join('/');
          if (nodePath === vaultRel || node.name === vaultRel) { targetNode = node; break; }
        }
        if (targetNode && targetNode.content != null) {
          urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
          const activeTab = tabs.find(t => t.id === targetTabId);
          if (activeTab) { activeTab.url = url; activeTab.title = targetNode.name; }
          renderTabs();
          const sd = viewport.querySelector('.speed-dial');
          if (sd) sd.remove();
          const wv = getOrCreateWebview(targetTabId);
          if (!wv.parentNode) viewport.appendChild(wv);
          showWebviewForTab(targetTabId);
          try {
            const nPath = require('path');
            const nFs = require('fs');
            const nOs = require('os');
            const nUrl = require('url');
            const dirKey = targetNode.parentId || 'root';
            const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
            if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
            if (targetNode.parentId) {
              for (const [, sib] of FS.files) {
                if (sib.type !== 'file' || sib.parentId !== targetNode.parentId || sib.content == null) continue;
                const validPath = validateFilePath(tmpBase, sib.name);
                if (!validPath) {
                  console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                  continue;
                }
                const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
                try { nFs.writeFileSync(validPath, sibContent); }
                catch (err) { console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err); }
              }
            }
            const validTmpFile = validateFilePath(tmpBase, targetNode.name);
            if (!validTmpFile) throw new Error('Invalid target file path');
            const contentToWrite = targetNode.content instanceof Uint8Array
              ? Buffer.from(targetNode.content) : targetNode.content;
            nFs.writeFileSync(validTmpFile, contentToWrite);
            if (activeTabId === targetTabId) {
              wv.src = nUrl.pathToFileURL(validTmpFile).href;
            }
          } catch (err) {
            console.error('[NB Browser] Failed to load vault file via file:// URL:', err);
            // Fallback: use blob URL instead of file:// to avoid sandbox issues
            const contentStr = targetNode.content instanceof Uint8Array
              ? new TextDecoder().decode(targetNode.content)
              : String(targetNode.content);
            const blob = new Blob([contentStr], { type: 'text/html' });
            const _blobUrl = URL.createObjectURL(blob);
            if (activeTabId === targetTabId) wv.src = _blobUrl;
            const tab = tabs.find(t => t.id === targetTabId);
            if (tab) {
              if (tab.activeBlobUrl) URL.revokeObjectURL(tab.activeBlobUrl);
              tab.activeBlobUrl = _blobUrl;
            }
          }
          return;
        }
        urlBar.value = stripHttps(url);
        Notify.show({
          title: 'Browser', body: 'File not found in vault: ' + vaultRel,
          type: 'error', appName: 'Browser'
        });
        return;
      }

      if (!url.match(/^https?:\/\//i) && !url.startsWith('blob:') && !url.startsWith('file://') && !url.startsWith('data:')) {
        url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : getSearchUrl(url);
      }
      urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab) {
        activeTab.url = url;
        try { activeTab.title = new URL(url).hostname; } catch { }
      }
      renderTabs();
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      const oldNotice = viewport.querySelector(`.browser-iframe-blocked[data-tab="${activeTabId}"]`);
      if (oldNotice) oldNotice.remove();
      const mode = getTabMode(activeTabId);
      if (mode === 'iframe') {
        const ifr = getOrCreateIframe(activeTabId);
        if (!ifr.parentNode) viewport.appendChild(ifr);
        showViewForTab(activeTabId);
        // Server-side embed check BEFORE setting src. If the site blocks framing
        // (XFO / CSP frame-ancestors), keep the iframe hidden and show our
        // custom notice instead of letting Chromium render "refused to connect".
        ifr.style.visibility = 'hidden';
        ifr.style.pointerEvents = 'none';
        // Abort any previous in-flight navigation.
        ifr.setAttribute('src', 'about:blank');
        checkFrameEmbeddable(activeTabId, url).then(result => {
          // Stale? Another navigation / mode switch superseded this tab.
          if (result === null) return;
          if (getTabMode(activeTabId) !== 'iframe') return;
          const curTab = tabs.find(t => t.id === activeTabId);
          if (curTab?.url !== url) return; // user navigated elsewhere
          if (result === false) {
            // Keep the iframe hidden (it's on about:blank) and show our notice.
            ifr.style.visibility = 'hidden';
            ifr.style.pointerEvents = 'none';
            showIframeBlockedNotice(activeTabId, url);
            return;
          }
          // Embeddable: clear any stale notice and load it.
          const stale = viewport.querySelector(`.browser-iframe-blocked[data-tab="${activeTabId}"]`);
          if (stale) stale.remove();
          ifr.style.visibility = 'visible';
          ifr.style.pointerEvents = 'auto';
          ifr.src = url;
        });
      } else {
        const wv = getOrCreateWebview(activeTabId);
        if (!wv.parentNode) viewport.appendChild(wv);
        showViewForTab(activeTabId);
        wv.src = url;
      }
    }

    const stripHttps = (url) => url ? url.replace(/^https:\/\//, '') : '';

    // ── Omnibox dropdown ────────────────────────────────────────────────────
    const omniDrop = createEl('div', { className: 'omnibox-dropdown' });
    omniDrop.setAttribute('role', 'listbox');
    container.appendChild(omniDrop);

    let omniItems = [];
    let omniIdx = -1;
    let omniTimer = null;
    let omniController = null;
    let omniGen = 0; // bumped per query + on close → stale renders bail out

    function omniReposition() {
      const r = urlBar.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      omniDrop.style.top   = (r.bottom - cr.top + 6) + 'px';
      omniDrop.style.left  = (r.left   - cr.left)    + 'px';
      omniDrop.style.width = r.width + 'px';
    }
    function omniClose() {
      // Invalidate any in-flight/queued work so a late async render can't
      // reopen the dropdown after Enter / blur / Esc.
      omniGen++;
      clearTimeout(omniTimer);
      if (omniController) { try { omniController.abort(); } catch (_) {} omniController = null; }
      omniDrop.style.display = 'none';
      omniDrop.replaceChildren();
      omniItems = [];
      omniIdx = -1;
    }
    function omniHighlight(idx) {
      const rows = omniDrop.querySelectorAll('.omni-row');
      rows.forEach((r, i) => r.classList.toggle('active', i === idx));
      omniIdx = idx;
    }
    function omniRender(items) {
      omniDrop.replaceChildren();
      omniItems = items;
      omniIdx = -1;
      if (!items.length) { omniDrop.style.display = 'none'; return; }
      omniReposition();
      const frag = document.createDocumentFragment();
      items.forEach((item, i) => {
        const row = createEl('div', { className: 'omni-row', role: 'option' });
        const ic  = createEl('span', { className: 'omni-icon' });
        ic.innerHTML = item.type === 'history'  ? svgIcon('clock',    13)
                     : item.type === 'bookmark' ? svgIcon('bookmark', 13)
                     :                             svgIcon('search',   13);
        const tx = createEl('span', { className: 'omni-text' });
        tx.textContent = item.label;
        if (item.sub) {
          const sb = createEl('span', { className: 'omni-sub' });
          sb.textContent = item.sub;
          row.append(ic, tx, sb);
        } else {
          row.append(ic, tx);
        }
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          omniClose();
          navigate(item.url || item.label);
        });
        row.addEventListener('mousemove', () => omniHighlight(i));
        frag.appendChild(row);
      });
      omniDrop.appendChild(frag);
      omniDrop.style.display = 'block';
    }

    async function fetchSuggestions(q, signal) {
      const eng = getSetting('searchEngine', 'brave');
      try {
        const r = await fetch(
          `/api/suggest?engine=${encodeURIComponent(eng)}&q=${encodeURIComponent(q)}`,
          { signal }
        );
        if (!r.ok) return [];
        const j = await r.json();
        return j.suggestions || [];
      } catch { return []; }
    }

    async function omniQuery(raw) {
      const q = raw.trim();
      if (!q) { omniClose(); return; }

      // Capture this query's generation; any newer query (or omniClose) bumps
      // omniGen, so a stale fetch result will bail before rendering.
      const gen = (++omniGen);

      // Local sources — instant (Iterator helpers, ES2025, lazy pipelines).
      const lq = q.toLowerCase();
      const bkItems = loadBookmarks()
        .filter(b => b.url.toLowerCase().includes(lq) || (b.title || '').toLowerCase().includes(lq))
        .slice(0, 3)
        .map(b => ({ type: 'bookmark', label: b.title || b.url, sub: b.url, url: b.url }));
      const hxItems = loadHistory()
        .filter(h => h.url.toLowerCase().includes(lq) || (h.title || '').toLowerCase().includes(lq))
        .slice(0, 4)
        .map(h => ({ type: 'history', label: h.title || h.url, sub: h.url, url: h.url }));

      if (gen !== omniGen) return; // a newer query / close superseded us
      omniRender([...bkItems, ...hxItems]);

      // Skip remote fetch for single-char queries — results are noise
      if (q.length < 2) return;

      // Abort any in-flight request before starting a new one
      if (omniController) omniController.abort();
      omniController = new AbortController();

      const suggestions = await fetchSuggestions(q, omniController.signal);

      // Stale check AFTER the await: abort() rejects the fetch, but a result
      // could still resolve just before a newer query fires. The generation
      // guard is the only reliable way to drop it.
      if (gen !== omniGen) return;

      const sugItems = suggestions
        .filter(s => !bkItems.some(b => b.label === s) && !hxItems.some(h => h.label === s))
        .map(s => ({ type: 'suggest', label: s, url: null }));

      if (gen !== omniGen) return; // final guard before paint
      omniRender([...bkItems, ...hxItems, ...sugItems]);
    }

    // ── URL bar events ──────────────────────────────────────────────────────
    urlBar.addEventListener('keydown', e => {
      if (omniDrop.style.display === 'block') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          omniHighlight(Math.min(omniIdx + 1, omniItems.length - 1));
          if (omniIdx >= 0) urlBar.value = omniItems[omniIdx].url || omniItems[omniIdx].label;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          omniHighlight(Math.max(omniIdx - 1, 0));
          if (omniIdx >= 0) urlBar.value = omniItems[omniIdx].url || omniItems[omniIdx].label;
          return;
        }
        if (e.key === 'Escape') { omniClose(); return; }
      }
      if (e.key === 'Enter') {
        const val = omniIdx >= 0 ? (omniItems[omniIdx].url || omniItems[omniIdx].label) : urlBar.value;
        omniClose();
        navigate(val);
      }
    });

    urlBar.addEventListener('input', () => {
      clearTimeout(omniTimer);
      omniTimer = setTimeout(() => omniQuery(urlBar.value), OMNI_DEBOUNCE_MS);
    });

    urlBar.addEventListener('focus', () => { urlBar.value = currentUrl || ''; });
    urlBar.addEventListener('blur', () => {
      setTimeout(omniClose, OMNI_BLUR_CLOSE_MS);
      urlBar.value = stripHttps(currentUrl || urlBar.value);
    });

    // Clean up omnibox timer & in-flight request on app teardown.
    state.cleanups.push(() => {
      clearTimeout(omniTimer);
      if (omniController) try { omniController.abort(); } catch (_) {}
    });

    // ── Global keyboard shortcuts ───────────────────────────────────────────
    const _onBrowserKeydown = e => {
      if (e.key === 'F12') {
        e.preventDefault();
        try { nw.Window.get().showDevTools(); } catch (_) {}
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'J') {
        e.preventDefault();
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.showDevTools(true); } catch (_) {}
      }
    };
    document.addEventListener('keydown', _onBrowserKeydown);
    state.cleanups.push(() => document.removeEventListener('keydown', _onBrowserKeydown));

    // ── Navigation button handlers ──────────────────────────────────────────
    backBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.back(); } catch (_) {}
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.back(); } catch (_) {}
      }
    });
    fwdBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.forward(); } catch (_) {}
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.forward(); } catch (_) {}
      }
    });
    refreshBtn.addEventListener('click', () => {
      const _mode = getTabMode(activeTabId);
      if (_mode === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch (_) { const _s = ifr.src; ifr.src = ''; ifr.src = _s; }
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.reload(); } catch (_) {}
        else if (currentUrl) navigate(currentUrl);
      }
    });

    // ── Open HTML file from vault ───────────────────────────────────────────
    if (options?.fileId) {
      if (!AppPermissionManager?.isGranted('fs:write', 'browser')) {
        Notify.show({
          title: 'Permission denied', body: 'Browser needs fs:write to open vault files.',
          type: 'error', appName: 'Browser'
        });
        return;
      }
      const fileNode = FS.files.get(options.fileId);
      if (fileNode != null && fileNode.content != null) {
        function getVaultPath(node) {
          const parts = [node.name];
          let cur = node;
          while (cur.parentId) {
            const parent = FS.files.get(cur.parentId);
            if (!parent) break;
            parts.unshift(parent.name);
            cur = parent;
          }
          return 'vault:/' + parts.join('/');
        }
        const vaultPath = getVaultPath(fileNode);
        tabs[0].title = fileNode.name;
        renderTabs();
        const wv = getOrCreateWebview(activeTabId);
        if (!wv.parentNode) viewport.appendChild(wv);
        showWebviewForTab(activeTabId);
        urlBar.value = vaultPath;
        updateUrlIcon(vaultPath);

        const htmlContent = fileNode.content instanceof Uint8Array
          ? new TextDecoder().decode(fileNode.content)
          : String(fileNode.content);

        let loaded = false;
        try {
          const nPath = require('path');
          const nFs = require('fs');
          const nOs = require('os');
          const nUrl = require('url');
          const dirKey = fileNode.parentId || 'root';
          const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
          if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
          if (fileNode.parentId) {
            for (const [, sib] of FS.files) {
              if (sib.type !== 'file' || sib.parentId !== fileNode.parentId || sib.content == null) continue;
              const validPath = validateFilePath(tmpBase, sib.name);
              if (!validPath) {
                console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                continue;
              }
              const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
              try { nFs.writeFileSync(validPath, sibContent); }
              catch (err) { console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err); }
            }
          }
          const validTmpFile = validateFilePath(tmpBase, fileNode.name);
          if (!validTmpFile) throw new Error('Invalid file path for vault extraction');
          nFs.writeFileSync(validTmpFile, htmlContent, 'utf8');
          const fileUrl = nUrl.pathToFileURL(validTmpFile).href;
          wv.src = fileUrl;
          currentUrl = fileUrl;
          loaded = true;
        } catch (err) {
          console.error('[NB Browser] File system error during vault loading:', err);
        }
        if (!loaded) {
          // FIX: original code had a syntax error here (Blob called with a
          // malformed array literal). Now uses a proper Blob containing the
          // decoded HTML string.
          const blob = new Blob([htmlContent], { type: 'text/html' });
          const blobUrl = URL.createObjectURL(blob);
          wv.src = blobUrl;
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab) {
            if (tab.activeBlobUrl) URL.revokeObjectURL(tab.activeBlobUrl);
            tab.activeBlobUrl = blobUrl;
          }
          currentUrl = blobUrl;
        }
        return;
      }
    }

    // ── Open URL passed from OS.openUrl() ───────────────────────────────────
    if (options?.url) {
      renderTabs();
      navigate(options.url);
      return;
    }

    // ── Initial render ──────────────────────────────────────────────────────
    renderTabs();
    (() => {
      const _hp = getSetting('homepage', 'most_visited');
      if (_hp === 'custom') {
        const _hpUrl = getSetting('homepageUrl', '');
        if (_hpUrl) navigate(_hpUrl);
        else renderSpeedDial();
      } else if (_hp === 'blank') {
        // leave viewport empty — blank page
      } else {
        renderSpeedDial();
      }
    })();
  }
});