(function () {
  const BROWSER_APP_ID = 'com.nbosp.browser';
  const packageFiles = window.__novaUnrestrictedPackage?.files || {};
  const osSvgIcon = window.svgIcon;

  function svgIcon(name, size = 16) {
    if (name === 'unlock') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
    }

    if (typeof osSvgIcon !== 'function') {
      throw new Error('NovaByte icon renderer is unavailable');
    }

    return osSvgIcon(name, size).replace(/src="\/assets\/([^"]+)"/g, (attribute, fileName) => {
      const encoded = packageFiles[`icons/${fileName}`];
      if (!encoded) {
        throw new Error(`Browser package is missing icon asset icons/${fileName}`);
      }
      return `src="data:image/png;base64,${encoded}"`;
    });
  }

registerApp({
  id: BROWSER_APP_ID, name: 'Browser', icon: 'globe',
  version: '3.0.2',
  description: 'Web Browser',
  defaultSize: [900, 600], minSize: [500, 350],

  onClose(state) {
    // Flush any debounced localStorage writes so data isn't lost on rapid close.
    // _flushPendingSaves is attached to `state` from inside init() because it
    // closes over per-app caches; calling it via state bridges the scope gap.
    try {
      if (typeof state._flushPendingSaves === 'function') state._flushPendingSaves();
    } catch (err) {
      console.warn('[NB Browser] flush-on-close failed:', err);
    }

    // Tear down every tracked cleanup (intervals, listeners, abort controllers).
    if (Array.isArray(state.cleanups)) {
      for (const fn of state.cleanups) {
        try { fn(); } catch (err) { console.error('[NB Browser] cleanup failed:', err); }
      }
      state.cleanups.length = 0;
    }

    // Tell the OS shell to close every browser window.
    if (window.ipc?.postMessage) {
      try {
        window.ipc.postMessage(JSON.stringify({ type: 'browser:closeAll', source: 'browser-app' }));
      } catch (err) {
        console.error('[NB Browser] IPC close message failed:', err);
      }
    }
  },

  init(content, state, options) {
    'use strict';

    const linuxNative = typeof process !== 'undefined' && process.platform === 'linux';
    if (!linuxNative && !window.AppDirs?.getAppDataPath(BROWSER_APP_ID, 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center">' +
        '<b>com.nbosp.browser</b><br>App data directory missing.<br>This app requires NovaByte OS.' +
        '</div>';
      return;
    }

    // Constants
    const BK_KEY              = 'nbosp_browser_bookmarks';
    const HX_KEY              = 'nbosp_browser_history';
    const ST_KEY              = 'nbosp_browser_settings';
    const BOOKMARK_MAX        = 500;
    const HISTORY_MAX         = 1000;
    const URL_MAX_LEN         = 2000;
    const TITLE_MAX_LEN       = 300;
    const FAVICON_DATAURI_MAX = 2048;
    const FAVICON_CACHE_MAX   = 256;    // bounded favicon normaliser cache
    const URL_POLL_MS         = 500;
    const DEBOUNCE_MS         = 300;
    const MOBILE_W            = 390;
    const MIN_ZOOM            = 0.25;
    const MAX_ZOOM            = 3;
    const ZOOM_STEP           = 0.1;
    const OMNI_DEBOUNCE_MS    = 120;
    const OMNI_BLUR_CLOSE_MS  = 150;
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

    // DOM root
    const container = createEl('div', { className: 'browser-container' });
    const tabsBar   = createEl('div', { className: 'browser-tabs-bar', role: 'tablist' });
    const viewport  = createEl('div', {
      className: 'browser-viewport',
      style: { display: 'flex', flexDirection: 'column', position: 'relative' }
    });

    // Tab state
    let tabs        = [{ id: 1, title: 'New Tab', url: '', favicon: '', incognito: false }];
    let activeTabId = 1;
    let nextTabId   = 2;

    const tabWebviews     = new Map();  // tabId → <webview>
    const tabIframes      = new Map();  // tabId → <iframe>
    const tabSourcePages  = new Map();  // tabId → rendered page source
    const tabViewMode     = new Map();  // tabId → 'webview' | 'iframe'
    const tabZoom         = new Map();  // tabId → number
    const tabCleanups     = new Map();  // tabId → Array<() => void>
    const tabUnresponsive = new Set();  // tabIds currently flagged unresponsive
    let browserChromeHidden = false;
    let browserChromeHideTimer = null;
    let quickControlFeedbackTimer = null;
    const sitePermissionDecisions = new Map();
    const pendingSitePermissionPrompts = new Map();
    const pendingLoginUsernames = new Map();
    const BROWSER_BEHAVIOR_MARKER = '__NBOSP_BROWSER_BEHAVIOR__:';
    const BROWSER_QUICK_DIAGNOSTIC_MARKER = '__NBOSP_BROWSER_QUICK_DIAGNOSTIC__:';
    const BROWSER_LOGIN_MARKER = '__NBOSP_LOGIN_CAPTURE__:';

    // App-wide teardown: one AbortController backs every listener that doesn't
    // need finer-grained lifecycle control. Cheaper than tracking each
    // listener separately, and a single abort() call tears everything down.
    const appAbort = new AbortController();
    state.cleanups = state.cleanups || [];
    state.cleanups.push(() => appAbort.abort());

    // Convenience accessor for the currently-active tab object.
    const activeTab = () => tabs.find(t => t.id === activeTabId);

    // Favicon normaliser — memoised with a bounded cache. Without a cap a
    // long session visiting thousands of distinct sites would grow this
    // without end; the simple oldest-first eviction below keeps it bounded
    // while preserving good hit-rate for the working set.
    const _faviconCache = new Map();
    function normFavicon(favicon, siteUrl = '') {
      if (!favicon) return '';
      const cacheKey = favicon + '\u0000' + siteUrl;
      const hit = _faviconCache.get(cacheKey);
      if (hit !== undefined) return hit;

      let result = favicon;
      // Already a proxy URL — use as-is.
      if (favicon.startsWith('/api/favicon')) {
        _faviconCache.set(cacheKey, favicon);
        return favicon;
      }
      // Old Google favicon URL — extract the domain and re-proxy.
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
      } catch { /* not a URL */ }
      // Resolve relative paths into absolute URLs using the guest tab's current domain.
      if (!/^https?:\/\//i.test(favicon) && siteUrl) {
        try { favicon = new URL(favicon, siteUrl).href; }
        catch { /* leave as-is */ }
      }
      // Any other external URL — proxy it via the favicon endpoint using the URL's hostname.
      if (/^https?:\/\//i.test(favicon)) {
        try {
          const domain = new URL(favicon).hostname;
          result = '/api/favicon?domain=' + encodeURIComponent(domain);
        } catch (err) {
          console.debug('[NB Browser] favicon domain extract failed:', favicon, err);
          result = favicon;
        }
      }
      // Bounded eviction: drop the oldest entry once we hit the cap.
      if (_faviconCache.size >= FAVICON_CACHE_MAX) {
        const firstKey = _faviconCache.keys().next().value;
        if (firstKey !== undefined) _faviconCache.delete(firstKey);
      }
      _faviconCache.set(cacheKey, result);
      return result;
    }

    // Settings storage — write-through cache + debounced persist.
    // Settings live in the NovaByte Registry (HKNA/com.nbosp.browser/settings)
    // via NovaAppConfig; the localStorage key is adopted once + kept as the
    // fail-soft fallback. Bookmarks/history stay app data (localStorage).
    let _settingsCache = null;
    let _settingsSaveTimer = null;

    function persistSettings(settings) {
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          window.NovaAppConfig.set('com.nbosp.browser', 'settings', settings, { legacyKey: ST_KEY });
          return;
        } catch (_) { /* fall through to legacy */ }
      }
      try { localStorage.setItem(ST_KEY, JSON.stringify(settings)); }
      catch (err) { console.warn('[NB Browser] Failed to save settings:', err); }
    }

    function loadSettings() {
      if (_settingsCache) return _settingsCache;
      try {
        if (typeof window !== 'undefined' && window.NovaAppConfig) {
          const fromRegistry = window.NovaAppConfig.get('com.nbosp.browser', 'settings', { legacyKey: ST_KEY, fallback: null });
          _settingsCache = fromRegistry && typeof fromRegistry === 'object' && !Array.isArray(fromRegistry) ? fromRegistry : {};
        } else {
          _settingsCache = JSON.parse(localStorage.getItem(ST_KEY) || '{}');
        }
        let migrated = false;
        if ('double_tap_zoom' in _settingsCache) {
          delete _settingsCache.double_tap_zoom;
          migrated = true;
        }
        if ('force_userscalable' in _settingsCache) {
          delete _settingsCache.force_userscalable;
          migrated = true;
        }
        for (const key of ['preload_when', 'link_prefetch_when']) {
          if (_settingsCache[key] === 'WIFI_ONLY') {
            _settingsCache[key] = 'NEVER';
            migrated = true;
          }
        }
        if (migrated) {
          persistSettings(_settingsCache);
        }
      } catch (err) {
        console.error('[NB Browser] Settings cache corrupted, resetting:', err);
        _settingsCache = {};
        try { localStorage.removeItem(ST_KEY); } catch { /* ignore */ }
      }
      return _settingsCache;
    }

    function saveSetting(key, val) {
      const s = loadSettings();
      s[key] = val;
      _settingsCache = s;
      clearTimeout(_settingsSaveTimer);
      _settingsSaveTimer = setTimeout(() => persistSettings(s), DEBOUNCE_MS);
    }

    const getSetting = (key, def) => {
      const v = loadSettings()[key];
      return v !== undefined ? v : def;
    };

    const PASSWORD_VAULT_FILE = 'browser-password-vault.json';
    const passwordVaultPath = linuxNative
      ? require('path').join(require('os').homedir(), '.config', 'novabyte', PASSWORD_VAULT_FILE)
      : null;
    const passwordVaultDir = linuxNative ? null : AppDirs.getAppDataPath(BROWSER_APP_ID, 'files');
    let passwordVaultKey = null;
    let passwordVaultEntries = null;
    let passwordVaultLastUsed = 0;
    let passwordVaultLockTimer = null;
    let passwordVaultFileId = null;

    function lockPasswordVault() {
      clearTimeout(passwordVaultLockTimer);
      passwordVaultLockTimer = null;
      passwordVaultKey?.fill(0);
      passwordVaultKey = null;
      passwordVaultEntries = null;
      passwordVaultSalt = null;
      container.querySelectorAll('.browser-password-manager').forEach(overlay => overlay.remove());
    }

    state.cleanups.push(lockPasswordVault);

    function armPasswordVaultLock() {
      clearTimeout(passwordVaultLockTimer);
      passwordVaultLastUsed = Date.now();
      passwordVaultLockTimer = setTimeout(lockPasswordVault, 5 * 60 * 1000);
    }

    function findPasswordVaultFile() {
      if (linuxNative) {
        const fs = require('fs');
        try {
          const stat = fs.lstatSync(passwordVaultPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Password vault path is not a regular file.');
          return { path: passwordVaultPath, content: fs.readFileSync(passwordVaultPath, 'utf8') };
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      }
      if (passwordVaultFileId && FS.files.has(passwordVaultFileId)) return FS.files.get(passwordVaultFileId);
      const node = FS.listDir(passwordVaultDir).find(file => file.type === 'file' && file.name === PASSWORD_VAULT_FILE);
      passwordVaultFileId = node?.id || null;
      return node || null;
    }

    function promptPasswordFields(title, message, fields, submitLabel) {
      return new Promise(resolve => {
        const overlay = createEl('div', {
          style: 'position:absolute;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px;'
        });
        const dialog = createEl('form', {
          style: 'width:min(420px,100%);padding:22px;border-radius:12px;background:var(--bg-elevated,#141a28);border:1px solid var(--border-default,rgba(255,255,255,.14));box-shadow:0 24px 70px rgba(0,0,0,.6);'
        });
        dialog.append(
          createEl('h2', { textContent: title, style: 'margin:0 0 8px;font-size:17px;color:var(--text-primary,#e6edf3);' }),
          createEl('p', { textContent: message, style: 'margin:0 0 16px;font-size:12px;line-height:1.5;color:var(--text-secondary,#8b949e);' })
        );
        const inputs = [];
        for (const field of fields) {
          dialog.appendChild(createEl('label', {
            textContent: field.label,
            style: 'display:block;margin:10px 0 5px;font-size:12px;color:var(--text-secondary,#8b949e);'
          }));
          const input = createEl('input', {
            type: field.type || 'text',
            autocomplete: field.autocomplete || 'off',
            placeholder: field.placeholder || '',
            required: field.required !== false,
            style: 'box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--border-default,rgba(255,255,255,.14));border-radius:7px;background:var(--bg-sunken,#080c14);color:var(--text-primary,#e6edf3);font-size:13px;'
          });
          dialog.appendChild(input);
          inputs.push(input);
        }
        const actions = createEl('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;' });
        const cancel = createEl('button', {
          type: 'button', textContent: 'Cancel',
          style: 'padding:8px 14px;border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer;'
        });
        const submit = createEl('button', {
          type: 'submit', textContent: submitLabel,
          style: 'padding:8px 14px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;'
        });
        actions.append(cancel, submit);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        container.appendChild(overlay);
        const finish = value => {
          overlay.remove();
          resolve(value);
        };
        cancel.addEventListener('click', () => finish(null));
        overlay.addEventListener('pointerdown', event => {
          if (event.target === overlay) finish(null);
        });
        dialog.addEventListener('submit', event => {
          event.preventDefault();
          finish(inputs.map(input => input.value));
        });
        inputs[0]?.focus();
      });
    }

    async function derivePasswordVaultKey(password, salt) {
      const nodeCrypto = require('crypto');
      return new Promise((resolve, reject) => {
        nodeCrypto.scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
          if (err) reject(err);
          else resolve(key);
        });
      });
    }

    async function encryptPasswordVault(entries, key, salt) {
      const nodeCrypto = require('crypto');
      const iv = nodeCrypto.randomBytes(12);
      const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(entries), 'utf8'),
        cipher.final()
      ]);
      return JSON.stringify({
        version: 1,
        kdf: 'scrypt-32768-8-1',
        cipher: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64')
      });
    }

    async function persistPasswordVault() {
      if (!passwordVaultKey || !passwordVaultEntries) throw new Error('Password vault is locked');
      const fileContent = await encryptPasswordVault(passwordVaultEntries, passwordVaultKey, passwordVaultSalt);
      if (linuxNative) {
        const fs = require('fs').promises;
        const path = require('path');
        await fs.mkdir(path.dirname(passwordVaultPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(passwordVaultPath, fileContent, { encoding: 'utf8', mode: 0o600 });
        return;
      }
      const existing = findPasswordVaultFile();
      if (existing) {
        await FS.writeFile(existing.id, fileContent);
      } else {
        const node = await FS.createFile(passwordVaultDir, PASSWORD_VAULT_FILE, fileContent, 'application/json');
        passwordVaultFileId = node.id;
      }
    }

    let passwordVaultSalt = null;

    async function unlockPasswordVault() {
      if (passwordVaultKey && Date.now() - passwordVaultLastUsed < 5 * 60 * 1000) {
        armPasswordVaultLock();
        return true;
      }
      lockPasswordVault();

      const file = findPasswordVaultFile();
      if (!file) {
        const values = await promptPasswordFields(
          'Create Password Vault',
          'Choose a master password of at least 10 characters. It encrypts saved logins and cannot be recovered if forgotten.',
          [
            { label: 'Master password', type: 'password', autocomplete: 'new-password' },
            { label: 'Confirm master password', type: 'password', autocomplete: 'new-password' }
          ],
          'Create vault'
        );
        if (!values) return false;
        if (values[0].length < 10 || values[0] !== values[1]) {
          Notify.show({ title: 'Password vault', body: 'Passwords must match and contain at least 10 characters.', type: 'error', appName: 'Browser' });
          return false;
        }
        const nodeCrypto = require('crypto');
        passwordVaultSalt = nodeCrypto.randomBytes(16);
        passwordVaultKey = await derivePasswordVaultKey(values[0], passwordVaultSalt);
        passwordVaultEntries = [];
        armPasswordVaultLock();
        await persistPasswordVault();
        return true;
      }

      let envelope;
      try {
        envelope = JSON.parse(typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content));
        if (envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm' || envelope.kdf !== 'scrypt-32768-8-1') {
          throw new Error('Unsupported password vault format');
        }
      } catch (err) {
        throw new Error('Password vault is unreadable: ' + err.message);
      }
      const [masterPassword] = await promptPasswordFields(
        'Unlock Password Vault',
        'Enter the master password to unlock saved logins. The vault locks automatically after five minutes.',
        [{ label: 'Master password', type: 'password', autocomplete: 'current-password' }],
        'Unlock'
      ) || [];
      if (masterPassword == null) return false;
      const nodeCrypto = require('crypto');
      const salt = Buffer.from(envelope.salt, 'base64');
      const key = await derivePasswordVaultKey(masterPassword, salt);
      try {
        const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final()
        ]).toString('utf8');
        const entries = JSON.parse(plain);
        if (!Array.isArray(entries) || entries.some(entry =>
          typeof entry?.origin !== 'string' || typeof entry?.username !== 'string' || typeof entry?.password !== 'string'
        )) throw new Error('Invalid vault entries');
        passwordVaultKey = key;
        passwordVaultSalt = salt;
        passwordVaultEntries = entries;
        armPasswordVaultLock();
        for (const wv of tabWebviews.values()) fillSavedLogin(wv);
        return true;
      } catch {
        key.fill(0);
        Notify.show({ title: 'Password vault', body: 'Incorrect master password or damaged vault.', type: 'error', appName: 'Browser' });
        return false;
      }
    }

    function fillSavedLogin(wv) {
      if (passwordVaultKey && Date.now() - passwordVaultLastUsed >= 5 * 60 * 1000) lockPasswordVault();
      if (!getSetting('autofill_enabled', true) || !passwordVaultEntries || !wv) return;
      const tabId = wv._nbTabId;
      if (tabs.find(tab => tab.id === tabId)?.incognito) return;
      armPasswordVaultLock();
      try {
        wv.executeScript({ code: 'location.origin' }, result => {
          const origin = Array.isArray(result) ? result[0] : '';
          const entry = passwordVaultEntries?.find(item => item.origin === origin);
          if (!entry) return;
          const payload = JSON.stringify({ username: entry.username, password: entry.password });
          try {
            wv.executeScript({ code: `(() => {
              const saved = ${payload};
              const passwordFields = Array.from(document.querySelectorAll('input[type="password"]'));
              const password = passwordFields.find(field => field.autocomplete === 'current-password') ||
                (passwordFields.length === 1 && passwordFields[0].autocomplete !== 'new-password' ? passwordFields[0] : null);
              if (!password || password.value) return;
              const form = password.form || document;
              const user = form.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[type="text"]');
              if (user && !user.value) {
                user.value = saved.username;
                user.dispatchEvent(new Event('input', { bubbles: true }));
                user.dispatchEvent(new Event('change', { bubbles: true }));
              }
              password.value = saved.password;
              password.dispatchEvent(new Event('input', { bubbles: true }));
              password.dispatchEvent(new Event('change', { bubbles: true }));
            })()` });
          } catch (err) {
            console.error('[NB Browser] Password autofill failed:', err);
          }
        });
      } catch (err) {
        console.error('[NB Browser] Could not inspect page origin for password autofill:', err);
      }
    }

    async function offerSaveLogin(login, tabId) {
      if (!getSetting('remember_passwords', true) || tabs.find(tab => tab.id === tabId)?.incognito) return;
      if (!login || typeof login.origin !== 'string' || typeof login.username !== 'string' || typeof login.password !== 'string') return;
      let origin;
      try {
        const parsed = new URL(login.origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== login.origin) return;
        origin = parsed.origin;
      } catch { return; }
      try {
        const shouldSave = await showModal(
          'Save password?',
          `Save this login for ${origin}? Passwords are encrypted with your master password.`,
          [{ label: 'Save', value: true }, { label: 'Not now', value: false }]
        );
        if (!shouldSave || !await unlockPasswordVault()) return;
        const existing = passwordVaultEntries.findIndex(item => item.origin === origin && item.username === login.username);
        const entry = { origin, username: login.username, password: login.password, updatedAt: Date.now() };
        if (existing >= 0) passwordVaultEntries[existing] = entry;
        else passwordVaultEntries.push(entry);
        await persistPasswordVault();
        Notify.show({ title: 'Password saved', body: `Encrypted login saved for ${origin}.`, type: 'success', appName: 'Browser' });
      } catch (err) {
        console.error('[NB Browser] Failed to save encrypted password:', err);
        Notify.show({ title: 'Password not saved', body: err.message || 'Could not save the encrypted login.', type: 'error', appName: 'Browser' });
      }
    }

    async function clearPasswordVault() {
      const file = findPasswordVaultFile();
      if (file) {
        const nodeCrypto = require('crypto');
        const oldContent = typeof file.content === 'string' ? file.content : '';
        if (linuxNative) {
          const fs = require('fs').promises;
          if (oldContent) await fs.writeFile(file.path, nodeCrypto.randomBytes(Buffer.byteLength(oldContent)).toString('hex'), { mode: 0o600 });
          await fs.unlink(file.path);
        } else {
          if (oldContent) await FS.writeFile(file.id, nodeCrypto.randomBytes(Buffer.byteLength(oldContent)).toString('hex'));
          await FS.permanentDelete(file.id);
        }
      }
      passwordVaultFileId = null;
      lockPasswordVault();
    }

    function showPasswordManager() {
      unlockPasswordVault().then(unlocked => {
        if (!unlocked) return;
        const overlay = createEl('div', {
          className: 'browser-password-manager',
          style: 'position:absolute;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px;'
        });
        const dialog = createEl('div', {
          style: 'width:min(620px,100%);max-height:85%;overflow:auto;padding:22px;border-radius:12px;background:var(--bg-elevated,#141a28);border:1px solid var(--border-default,rgba(255,255,255,.14));box-shadow:0 24px 70px rgba(0,0,0,.6);'
        });
        const header = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;' });
        const heading = createEl('h2', { textContent: 'Saved Passwords', style: 'margin:0;font-size:17px;color:var(--text-primary,#e6edf3);' });
        const actions = createEl('div', { style: 'display:flex;gap:6px;' });
        const add = createEl('button', { textContent: 'Add login', style: 'padding:7px 12px;border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer;' });
        const changeMaster = createEl('button', { textContent: 'Change master password', style: 'padding:7px 12px;border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer;' });
        const lock = createEl('button', { textContent: 'Lock', style: 'padding:7px 12px;border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer;' });
        const close = createEl('button', { textContent: 'Close', style: 'padding:7px 12px;border:1px solid var(--border-default);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer;' });
        actions.append(add, changeMaster, lock, close);
        header.append(heading, actions);
        close.addEventListener('click', () => overlay.remove());
        lock.addEventListener('click', () => {
          lockPasswordVault();
          overlay.remove();
        });
        changeMaster.addEventListener('click', async () => {
          armPasswordVaultLock();
          const values = await promptPasswordFields('Change Master Password', 'Choose a new master password. Your saved logins will be re-encrypted.', [
            { label: 'New master password', type: 'password', autocomplete: 'new-password' },
            { label: 'Confirm new master password', type: 'password', autocomplete: 'new-password' }
          ], 'Change password');
          if (!values) return;
          if (!passwordVaultKey || !passwordVaultEntries) return;
          if (values[0].length < 10 || values[0] !== values[1]) {
            Notify.show({ title: 'Password vault', body: 'Passwords must match and contain at least 10 characters.', type: 'error', appName: 'Browser' });
            return;
          }
          const nodeCrypto = require('crypto');
          const oldKey = passwordVaultKey;
          const oldSalt = passwordVaultSalt;
          try {
            passwordVaultSalt = nodeCrypto.randomBytes(16);
            passwordVaultKey = await derivePasswordVaultKey(values[0], passwordVaultSalt);
            await persistPasswordVault();
            oldKey?.fill(0);
            armPasswordVaultLock();
            Notify.show({ title: 'Master password changed', body: 'Saved logins were re-encrypted with the new master password.', type: 'success', appName: 'Browser' });
          } catch (err) {
            if (passwordVaultKey && passwordVaultKey !== oldKey) passwordVaultKey.fill(0);
            passwordVaultKey = oldKey;
            passwordVaultSalt = oldSalt;
            console.error('[NB Browser] Failed to change password vault master password:', err);
            Notify.show({ title: 'Master password not changed', body: 'Could not re-encrypt the password vault.', type: 'error', appName: 'Browser' });
          }
        });
        add.addEventListener('click', async () => {
          armPasswordVaultLock();
          const values = await promptPasswordFields('Add Login', 'Add a credential to the encrypted password vault.', [
            { label: 'Website URL', type: 'url', placeholder: 'https://example.com' },
            { label: 'Username', autocomplete: 'username' },
            { label: 'Password', type: 'password', autocomplete: 'new-password' }
          ], 'Save login');
          if (!values) return;
          if (!passwordVaultKey || !passwordVaultEntries) return;
          let origin;
          try {
            const parsed = new URL(values[0]);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
            origin = parsed.origin;
          } catch {
            Notify.show({ title: 'Invalid website', body: 'Enter a valid HTTP or HTTPS URL without embedded credentials.', type: 'error', appName: 'Browser' });
            return;
          }
          const existingIndex = passwordVaultEntries.findIndex(entry => entry.origin === origin && entry.username === values[1]);
          const entry = { origin, username: values[1], password: values[2], updatedAt: Date.now() };
          if (existingIndex >= 0) passwordVaultEntries[existingIndex] = entry;
          else passwordVaultEntries.push(entry);
          try {
            await persistPasswordVault();
            overlay.remove();
            showPasswordManager();
          } catch (err) {
            console.error('[NB Browser] Failed to save manual login:', err);
            Notify.show({ title: 'Login not saved', body: 'Could not update the encrypted vault.', type: 'error', appName: 'Browser' });
          }
        });
        dialog.appendChild(header);
        if (!passwordVaultEntries.length) {
          dialog.appendChild(createEl('p', { textContent: 'No saved logins yet. When you sign in to a site, Browser can offer to save the login here.', style: 'color:var(--text-secondary);font-size:12px;' }));
        }
        const entries = passwordVaultEntries.map((entry, index) => {
          const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border-subtle);' });
          const info = createEl('div', { style: 'flex:1;min-width:0;' });
          info.append(
            createEl('div', { textContent: entry.origin, style: 'font-size:12px;overflow-wrap:anywhere;color:var(--text-primary);' }),
            createEl('div', { textContent: entry.username, style: 'font-size:11px;color:var(--text-secondary);margin-top:3px;' })
          );
          const remove = createEl('button', { textContent: 'Delete', style: 'padding:6px 10px;border:1px solid var(--text-danger);border-radius:6px;background:transparent;color:var(--text-danger);cursor:pointer;' });
          remove.addEventListener('click', async () => {
            if (!passwordVaultKey || !passwordVaultEntries) return;
            armPasswordVaultLock();
            passwordVaultEntries.splice(index, 1);
            try {
              await persistPasswordVault();
              overlay.remove();
              showPasswordManager();
            } catch (err) {
              console.error('[NB Browser] Failed to delete saved login:', err);
              Notify.show({ title: 'Password not deleted', body: 'Could not update the encrypted vault.', type: 'error', appName: 'Browser' });
            }
          });
          row.append(info, remove);
          return row;
        });
        dialog.append(...entries);
        overlay.appendChild(dialog);
        overlay.addEventListener('pointerdown', event => {
          if (event.target === overlay) overlay.remove();
        });
        container.appendChild(overlay);
      }).catch(err => {
        console.error('[NB Browser] Password vault error:', err);
        Notify.show({ title: 'Password vault unavailable', body: err.message, type: 'error', appName: 'Browser' });
      });
    }

    const getSearchUrl = (q) => {
      const eng = getSetting('searchEngine', 'brave');
      const base = SEARCH_ENGINES[eng]?.url || SEARCH_ENGINES.brave.url;
      return base + encodeURIComponent(q);
    };

    // Bookmarks storage
    let _bookmarksCache = null;
    let _bookmarksSaveTimer = null;

    function loadBookmarks() {
      if (_bookmarksCache) return _bookmarksCache;
      try {
        _bookmarksCache = JSON.parse(localStorage.getItem(BK_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] Bookmarks cache corrupted, resetting:', err);
        _bookmarksCache = [];
        try { localStorage.removeItem(BK_KEY); } catch { /* ignore */ }
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

    // History storage
    let _historyCache = null;
    let _historySaveTimer = null;

    function loadHistory() {
      if (_historyCache) return _historyCache;
      try {
        _historyCache = JSON.parse(localStorage.getItem(HX_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] History cache corrupted, resetting:', err);
        _historyCache = [];
        try { localStorage.removeItem(HX_KEY); } catch { /* ignore */ }
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

    // Flush every debounced save immediately. Used by onClose so a rapid
    // window close doesn't lose data sitting in a pending timer.
    function _flushPendingSaves() {
      clearTimeout(_settingsSaveTimer);
      clearTimeout(_bookmarksSaveTimer);
      clearTimeout(_historySaveTimer);
      try {
        if (_settingsCache) persistSettings(_settingsCache);
        if (_bookmarksCache) localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache));
        if (_historyCache)   localStorage.setItem(HX_KEY, JSON.stringify(_historyCache));
      } catch (err) {
        console.warn('[NB Browser] Flush-on-close failed:', err);
      }
    }
    // Exposed for onClose, which runs in a slightly different scope.
    state._flushPendingSaves = _flushPendingSaves;

    // Bookmark helpers — cached membership check via a Set so the address-bar
    // star toggle is O(1) instead of scanning the bookmarks array each time.
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

    // Panel state — tracked so addHistory can live-refresh the History panel
    // when it's the currently-visible panel.
    let _panelType = null;

    function addHistory(originTabId, url, title, favicon) {
      const tab = tabs.find(t => t.id === originTabId);
      if (!tab || tab.incognito || tab.isPopup) return;

      try {
        // Drop oversized Base64 data-URIs before they can exhaust the 5 MB
        // localStorage quota — a single 100KB favicon would otherwise waste
        // 100KB of quota per visit.
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
        // Live-refresh history panel if it's open.
        if (_panelType === 'history' && panel.style.display !== 'none') showPanel('history');
      } catch (err) {
        console.warn('[NB Browser] addHistory failed:', err);
      }
    }

    // Tabs bar — event-delegated, so there are zero per-tab listeners.
    // Click routing is decided by which element the click landed on.
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

    // Right-click a tab → Chromium-style tab strip context menu.
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
      // Use a DocumentFragment to batch DOM writes — avoids N reflows.
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
        if (tab.favicon && !tab.url?.startsWith('browser://')) {
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
      // Re-bind the "+" button — the delegated handler above can't distinguish
      // it without a class, and adding one would change the visual styling.
      newTabBtn.addEventListener('click', createNewTab, { signal: appAbort.signal });
    }

    // Update only the title text of an existing tab — avoids a full re-render
    // on every URL change in an SPA.
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
        // Counter-scale the iframe's intrinsic size so the visible box stays
        // the same dimensions while page content scales by 1/z.
        const pct = (100 / z).toFixed(4) + '%';
        ifr.style.width = pct;
        ifr.style.height = pct;
        ifr.style.transformOrigin = 'top left';
        ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
      }
    }

    function applyZoomToWebview(wv, z) {
      try { wv.setZoom(z); } catch { /* webview not ready */ }
    }

    function toggleUserAgent() {
      const tab = activeTab();
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
        // Reload so the page re-renders inside the new frame dimensions.
        try { ifr.contentWindow.location.reload(); }
        catch {
          const src = ifr.src; ifr.src = ''; ifr.src = src;
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        const UA = goingMobile
          ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        try { wv.setUserAgentOverride(UA); } catch { /* webview not ready */ }
        applyMobileViewportFrame(wv, goingMobile);
        if (tab.url) {
          if (goingMobile) {
            // Inject a viewport meta so mobile pages render at device-width.
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
              } catch { /* ignore */ }
            };
            wv.addEventListener('loadstop', onMobileLoad);
          }
          try { wv.reload(); } catch { /* ignore */ }
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
        const tab = activeTab();
        applyZoomToIframe(ifr, tab?.userAgent === 'mobile', z);
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        applyZoomToWebview(wv, z);
      }
    }

    function registerTabCleanup(tabId, fn) {
      // Map.getOrInsert (Baseline 2026) avoids the verbose has-check pattern.
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
        try { URL.revokeObjectURL(closedTab.activeBlobUrl); } catch { /* ignore */ }
        closedTab.activeBlobUrl = null;
      }

      tabs = tabs.filter(t => t.id !== tabId);

      // Run per-tab cleanups (cancels poll timers, etc.) before removing the webview.
      const cleanups = tabCleanups.get(tabId);
      if (cleanups) {
        for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
        tabCleanups.delete(tabId);
      }

      // Remove DOM elements BEFORE checking tabs.length — prevents zombie
      // viewport elements lingering in the DOM.
      const closedWv = tabWebviews.get(tabId);
      if (closedWv) { closedWv._nbTrusted?.destroy(); closedWv.remove(); tabWebviews.delete(tabId); }
      const closedIfr = tabIframes.get(tabId);
      if (closedIfr) { closedIfr.remove(); tabIframes.delete(tabId); }
      const closedSource = tabSourcePages.get(tabId);
      if (closedSource) { closedSource.remove(); tabSourcePages.delete(tabId); }
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

    // Tab actions shared by the toolbar button and the context menus.
    function reloadTab(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      if (tabSourcePages.has(tabId)) return;
      if (getTabMode(tabId) === 'iframe') {
        const ifr = tabIframes.get(tabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch { const s = ifr.src; ifr.src = ''; ifr.src = s; }
          return;
        }
      } else {
        const wv = tabWebviews.get(tabId);
        if (wv) { try { wv.reload(); } catch { /* ignore */ } return; }
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
      // keep this one active so closeTab doesn't reshuffle
      switchToTab(keepTabId);
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

    // Speed dial — the new-tab page.
    function renderSpeedDial() {
      setBrowserChromeHidden(false);
      updateUrlIcon('');
      requestAnimationFrame(() => {
        for (const wv of tabWebviews.values()) {
          wv.style.visibility = 'hidden';
          wv.style.pointerEvents = 'none';
        }
      });
      const old = viewport.querySelector('.speed-dial');
      if (old) old.remove();

      const tab = activeTab();
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
        for (const hEntry of hist) {
          const row = createEl('div', {
            style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;'
          });
          row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.innerHTML = svgIcon('clock', 13) + '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"></span>';
          const span = row.querySelector('span');
          if (span) span.textContent = hEntry.title || hEntry.url;
          row.addEventListener('click', () => { sd.remove(); navigate(hEntry.url); }, { signal: appAbort.signal });
          sec.appendChild(row);
        }
        sd.appendChild(sec);
      }
      viewport.appendChild(sd);
    }

    function switchToTab(tabId) {
      const currentSettingsPage = viewport.querySelector('.browser-settings-page');
      const currentTab = activeTab();
      if (currentSettingsPage && currentTab?.url === 'browser://settings') {
        currentTab.settingsCategory = currentSettingsPage.dataset.category || currentTab.settingsCategory || 'general';
        currentTab.settingsScrollTop = currentSettingsPage.querySelector('[data-settings-panel]')?.scrollTop || 0;
      }
      activeTabId = tabId;
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        urlBar.value = stripHttps(tab.url || '');
        currentUrl = tab.url || '';
        updateUrlIcon(tab.url || '');
        setBrowserChromeHidden(getSetting('fullscreen', false));
        const bkd = tab.url ? isBookmarked(tab.url) : false;
        starBtn.style.color = bkd ? 'var(--accent)' : '';
        starBtn.innerHTML = svgIcon(bkd ? 'star-filled' : 'star', 16);
        updateModeBtn();
        if (tabSourcePages.has(tabId)) {
          updateUrlIcon(tab.url);
          const sourcePage = tabSourcePages.get(tabId);
          if (!sourcePage.parentNode) viewport.appendChild(sourcePage);
          showViewForTab(tabId);
          const sd = viewport.querySelector('.speed-dial');
          if (sd) sd.remove();
        } else if (tab.url === 'browser://settings') {
          renderSettingsPage(tab.settingsCategory || 'general');
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

    // Toolbar
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
    const urlWarning = createEl('span', {
      className: 'browser-security-warning',
      textContent: 'Not secure',
      style: 'display:none;flex-shrink:0;font-size:11px;font-weight:600;color:var(--text-warning);white-space:nowrap;'
    });
    urlBarWrap.append(urlBar, urlIcon, urlWarning);

    function updateUrlIcon(url) {
      if (/^https:\/\//i.test(url || '')) {
        urlIcon.innerHTML = svgIcon('lock', 14);
        urlIcon.style.color = 'var(--text-success)';
        urlIcon.title = 'Secure connection';
        urlIcon.setAttribute('aria-label', 'Secure connection');
        urlWarning.style.display = 'none';
      } else if (/^http:\/\//i.test(url || '')) {
        if (getSetting('show_security_warnings', true)) {
          urlIcon.innerHTML = svgIcon('unlock', 14);
          urlIcon.style.color = 'var(--text-warning)';
          urlIcon.title = 'Not secure: this connection is not encrypted';
          urlIcon.setAttribute('aria-label', 'Not secure connection');
          urlWarning.style.display = 'inline';
        } else {
          urlIcon.innerHTML = svgIcon('globe', 14);
          urlIcon.style.color = '';
          urlIcon.title = '';
          urlIcon.setAttribute('aria-label', 'Website');
          urlWarning.style.display = 'none';
        }
      } else {
        urlIcon.innerHTML = svgIcon('search', 14);
        urlIcon.style.color = '';
        urlIcon.title = '';
        urlIcon.setAttribute('aria-label', 'Search or internal page');
        urlWarning.style.display = 'none';
      }
    }

    // Star bookmark button
    const starBtn = createEl('button', {
      className: 'browser-nav-btn',
      'aria-label': 'Bookmark', title: 'Bookmark this page'
    });
    starBtn.innerHTML = svgIcon('star', 16);
    starBtn.addEventListener('click', () => {
      if (!currentUrl || currentUrl.startsWith('novabyte:')) return;
      const tab = activeTab();
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

    // Menu button — Chromium-style overflow menu.
    const menuBtn = createEl('button', {
      className: 'browser-nav-btn', 'aria-label': 'Menu', title: 'Browser menu'
    });
    menuBtn.innerHTML = svgIcon('menu', 16);
    menuBtn.addEventListener('click', (e) => {
      const tab = activeTab();
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
            const t = activeTab();
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

    // View-mode toggle (Webview ↔ iFrame).
    // DEV ONLY — DO NOT SHIP BUTTON TO PRODUCTION.
    // Dev/debug utility: lets a dev building on this app switch a tab
    // between <webview> and <iframe> rendering — useful when <webview>
    // isn't viable (e.g. missing nodeintegration/manifest flags) or
    // when comparing how a tag behaves across the two modes.
    // REMOVE or HIDE this button element before deploying to production,
    // as non-technical/consumer people do not need this interface.
    // The underlying toggle logic is safe to leave in for devs.
    const modeBtn = createEl('button', {
      className: 'browser-mode-btn',
      title: 'Switch to iframe mode',
      'aria-pressed': 'false'
    });
    modeBtn.innerHTML = svgIcon('monitor', 14) + ' <span>Webview</span>';
    modeBtn.addEventListener('click', () => {
      const current = getTabMode(activeTabId);
      const next = current === 'webview' ? 'iframe' : 'webview';
      setTabMode(activeTabId, next);
      const tab = activeTab();
      if (tab?.url && tab.url !== 'browser://settings') navigate(tab.url);
      updateModeBtn();
    }, { signal: appAbort.signal });
    toolbar.appendChild(modeBtn);

    // Find bar
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

    let findBarOpen = false;
    const openFindBar = () => {
      if (browserChromeHidden) setBrowserChromeHidden(false);
      findBarOpen = true;
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    };

    // iframe find helpers — RegExp.escape (ES2025) makes the query safe
    // even when the user types regex metacharacters.
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

      // Clear previous highlights then NORMALIZE to merge fragmented text nodes
      // back together — otherwise splitting marks leaves the DOM in a messy
      // state that breaks subsequent searches.
      doc.querySelectorAll('.__nb_highlight').forEach(el => {
        el.replaceWith(doc.createTextNode(el.textContent));
      });
      doc.body.normalize();
      _iframeFinds = [];

      if (!text) { findCount.textContent = ''; return; }

      const re = buildFindRegex(text);
      if (!re) return;

      // Walk text nodes, skipping script/style so we don't break page JS.
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
          // font:inherit preserves every font property so highlights don't
          // reflow text or break custom fonts.
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
      } catch { /* cross-origin — expected, ignore */ }
      _iframeFinds = [];
      _iframeFindIdx = 0;
    }

    function closeFindBar() {
      findBarOpen = false;
      findBar.style.display = 'none';
      findCount.textContent = '';
      if (getTabMode(activeTabId) === 'iframe') {
        iframeFindClear();
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.stopFinding('clear'); } catch { /* ignore */ }
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
      } catch { /* ignore */ }
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

    // Panel (Bookmarks / History) — event-delegated, so there's a single
    // click listener for the whole list regardless of how many rows render.
    const panel = createEl('div', {
      style: 'display:none;position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);z-index:100;flex-direction:column;overflow:hidden;'
    });

    function showPanel(type) {
      _panelType = type;
      if (!panel.parentNode) viewport.appendChild(panel);
      panel.style.display = 'flex';
      panel.replaceChildren();

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

      // Event delegation for row clicks & delete buttons — one listener
      // for the whole list, regardless of how many rows there are.
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
    const quickControlFeedback = createEl('div', {
      className: 'browser-quick-control-feedback',
      'aria-hidden': 'true'
    });
    const quickControlArrow = createEl('span', { className: 'browser-quick-control-arrow' });
    const quickControlLabel = createEl('span');
    quickControlFeedback.append(quickControlArrow, quickControlLabel);
    viewport.appendChild(quickControlFeedback);
    function showQuickControlFeedback(direction) {
      clearTimeout(quickControlFeedbackTimer);
      quickControlArrow.innerHTML = svgIcon(direction === 'back' ? 'chevron-left' : 'chevron-right', 22);
      quickControlLabel.textContent = direction === 'back' ? 'Back' : 'Forward';
      quickControlFeedback.classList.toggle('is-forward', direction === 'forward');
      quickControlFeedback.classList.remove('is-visible');
      void quickControlFeedback.offsetWidth;
      quickControlFeedback.classList.add('is-visible');
      quickControlFeedbackTimer = setTimeout(() => quickControlFeedback.classList.remove('is-visible'), 650);
    }
    state.cleanups.push(() => clearTimeout(quickControlFeedbackTimer));
    container.addEventListener('pointermove', event => {
      const top = container.getBoundingClientRect().top;
      if (browserChromeHidden && event.clientY <= top + 18) {
        setBrowserChromeHidden(false);
      } else if (!browserChromeHidden && event.clientY > top + 120) {
        scheduleBrowserChromeHide();
      }
    }, { signal: appAbort.signal, passive: true });
    for (const chromeElement of [tabsBar, toolbar, findBar]) {
      chromeElement.addEventListener('pointerenter', () => {
        clearTimeout(browserChromeHideTimer);
        browserChromeHideTimer = null;
      }, { signal: appAbort.signal, passive: true });
      chromeElement.addEventListener('pointerleave', scheduleBrowserChromeHide, {
        signal: appAbort.signal, passive: true
      });
    }

    // Popup mode — when opened via window.open() from another app, the
    // browser chrome is stripped down to just the URL bar (read-only) +
    // a "Popup" badge.
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

    const getTabMode = (tabId) => tabViewMode.get(tabId) || 'webview';

    function dispatchQuickControl(direction, tabId, webview = tabWebviews.get(tabId)) {
      if (tabId !== activeTabId) return;
      showQuickControlFeedback(direction);
      try {
        if (getTabMode(tabId) === 'iframe') {
          const frame = tabIframes.get(tabId);
          if (direction === 'back') frame?.contentWindow?.history.back();
          else frame?.contentWindow?.history.forward();
        } else if (direction === 'back') {
          webview?.back();
        } else {
          webview?.forward();
        }
      } catch (err) {
        console.warn('[NB Browser] Quick-control navigation failed:', err);
      }
    }

    function attachHostQuickControlWheel(webview, tabId) {
      let deltaX = 0;
      let timer = null;
      let diagnosticSent = false;
      webview.addEventListener('wheel', event => {
        if (!getSetting('enable_quick_controls', false) || event.ctrlKey ||
            event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
        const horizontal = event.deltaX || (event.shiftKey ? event.deltaY : 0);
        const vertical = event.shiftKey ? 0 : event.deltaY;
        if (Math.abs(horizontal) < Math.abs(vertical) * 1.2 || Math.abs(horizontal) < 8) return;
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerWidth : 1;
        deltaX += horizontal * scale;
        if (window.__NBOSP_BROWSER_QUICK_CONTROL_DEBUG__ === true && !diagnosticSent) {
          diagnosticSent = true;
          console.info('[NB Browser] Quick-control wheel reached the host webview:', {
            deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, shiftKey: event.shiftKey
          }, { tabId });
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          const total = deltaX;
          deltaX = 0;
          if (Math.abs(total) < 40) return;
          dispatchQuickControl(total > 0 ? 'forward' : 'back', tabId, webview);
        }, 250);
      }, { passive: true });
      state.cleanups.push(() => clearTimeout(timer));
    }

    // Stable browser session ID. Persisted across launches so cookies,
    // localStorage, etc. inside the webview survive a browser restart.
    // Generated once per OS profile and stored in OS.settings.
    let _bpid = OS.settings.get('browserPartitionId');
    if (!_bpid) {
      _bpid = 'b' + Math.random().toString(36).slice(2, 12);
      OS.settings.set('browserPartitionId', _bpid);
    }
    const BROWSER_PARTITION = 'persist:' + _bpid;

    // URL tracking — syncUrlForTab is hoisted to outer scope (not nested
    // in getOrCreateWebview) because both the per-tab webview listeners
    // AND the shared poll timer below need to call it, and it doesn't
    // depend on any per-tab closure state.
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

    // Shared single-timer URL poller.
    // Instead of N intervals (one per webview), use ONE interval that polls
    // only the currently-active webview. Reduces timer overhead and
    // executeScript calls from O(tabs) to O(1) per tick.
    const _lastPolledUrls = new Map(); // tabId → string
    const _urlPollTimer = setInterval(() => {
      const wv = tabWebviews.get(activeTabId);
      if (!wv) return;
      try {
        const polledTabId = activeTabId;
        wv.executeScript({ code: `(() => {
          return { url: location.href };
        })()` }, results => {
          if (chrome.runtime?.lastError) return;
          const result = Array.isArray(results) ? results[0] : results;
          const url = result?.url;
          if (typeof url !== 'string' || url === 'about:blank') return;
          if (url === _lastPolledUrls.get(polledTabId)) return;
          _lastPolledUrls.set(polledTabId, url);
          syncUrlForTab(url, polledTabId, 'poll');
        });
      } catch (err) {
        console.warn('[NB Browser] URL poll executeScript failed:', err);
      }
    }, URL_POLL_MS);
    state.cleanups.push(() => clearInterval(_urlPollTimer));

    // Info bar — for unresponsive pages, certificate warnings, etc.
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
        // Bind to appAbort so a teardown cleans these up even if dismissInfoBar
        // is never explicitly called.
        b.addEventListener('click', a.action, { signal: appAbort.signal });
        bar.appendChild(b);
      }
      viewport.insertBefore(bar, viewport.firstChild);
    }
    function dismissInfoBar(tabId) {
      const existing = viewport.querySelector(`.browser-info-bar[data-tab="${tabId}"]`);
      if (existing) existing.remove();
    }

    // Sanitise a filename for saving to disk: strip path separators, control
    // characters, and truncate to MAX_DL_NAME_LEN. Returns a non-empty name.
    function sanitizeDownloadName(rawName) {
      const base = (() => {
        try {
          const parsed = new URL(rawName);
          if (!['http:', 'https:'].includes(parsed.protocol)) return '';
          return decodeURIComponent(parsed.pathname.split('/').pop());
        } catch {
          return String(rawName || '').split(/[\\/]/).pop();
        }
      })() || ('download_' + Date.now());
      const cleaned = base.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || ('download_' + Date.now());
      return cleaned.length > MAX_DL_NAME_LEN ? cleaned.slice(0, MAX_DL_NAME_LEN) : cleaned;
    }

    // Pick a non-colliding filename in the downloads folder by appending
    // " (N)" before the extension if the proposed name already exists.
    function pickUniqueDownloadName(folderId, name, ext) {
      const existing = FS.listDir(folderId).map(f => f.name);
      if (!existing.includes(name + ext)) return name;
      const prefixCount = existing.filter(n => n.startsWith(name)).length;
      return name.replace(/(\.\w+)?$/, ' (' + prefixCount + ')$1');
    }

    // Streams a URL to disk with Node's http(s), so there's no CORS and no
    // whole-file buffer in memory. Uses captured image request headers to
    // preserve hotlink/session access and only forwards credentials to the
    // original origin when following redirects.
    function streamUrlToFile(url, destPath, requestHeaders = {}, redirectsLeft = 5) {
      return new Promise((resolve, reject) => {
        const fs = require('fs');
        const client = /^https:/i.test(url) ? require('https') : require('http');
        const req = client.get(url, { headers: requestHeaders }, res => {
          const { statusCode, headers } = res;
          if (statusCode >= 300 && statusCode < 400 && headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            const next = new URL(headers.location, url).href;
            if (!/^https?:/i.test(next)) return reject(new Error('Unsupported redirect'));
            const nextHeaders = { ...requestHeaders };
            if (new URL(url).origin !== new URL(next).origin) {
              for (const name of Object.keys(nextHeaders)) {
                if (['authorization', 'cookie', 'cookie2', 'host', 'proxy-authorization'].includes(name.toLowerCase())) {
                  delete nextHeaders[name];
                } else if (name.toLowerCase() === 'referer') {
                  try { nextHeaders[name] = new URL(nextHeaders[name]).origin + '/'; }
                  catch { delete nextHeaders[name]; }
                }
              }
            }
            return streamUrlToFile(next, destPath, nextHeaders, redirectsLeft - 1).then(resolve, reject);
          }
          if (statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + statusCode));
          }
          const partPath = destPath + '.part';
          const out = fs.createWriteStream(partPath);
          let received = 0;
          let failed = false;
          const fail = err => {
            if (failed) return;
            failed = true;
            out.destroy();
            req.destroy();
            fs.rm(partPath, { force: true }, () => reject(err));
          };
          res.on('data', chunk => { received += chunk.length; });
          res.on('error', fail);
          out.on('error', fail);
          out.on('finish', () => {
            if (failed) return;
            fs.rename(partPath, destPath, err => (err ? fail(err) : resolve(received)));
          });
          res.pipe(out);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Connection timed out')));
      });
    }

    function normalizeRequestUrl(url) {
      try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.href;
      } catch {
        return url;
      }
    }

    function getImageRequestHeaders(wv, url, pageUrl) {
      const savedHeaders = wv?._nbImageRequestHeaders?.get(normalizeRequestUrl(url)) || {};
      const requestHeaders = { ...savedHeaders };
      if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'referer') && pageUrl) {
        try {
          const referer = new URL(pageUrl);
          if (['http:', 'https:'].includes(referer.protocol)) {
            referer.username = '';
            referer.password = '';
            requestHeaders.Referer = referer.href;
          }
        } catch { /* ignore invalid page URLs */ }
      }
      if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'user-agent') &&
          typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
        requestHeaders['User-Agent'] = navigator.userAgent;
      }
      return requestHeaders;
    }

    // Chromium's own download would open the host's native chooser, so the
    // permission handler denies it and routes the URL here for the OS Save As.
    async function saveDownloadViaDialog(url, requestedName, title = 'Save As', requestHeaders = {}) {
      const isDataImage = /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(url || '');
      if (!url || (!/^https?:\/\//i.test(url) && !isDataImage)) {
        Notify.show({ title: 'Download failed', body: 'This image URL cannot be saved directly.', type: 'error', appName: 'Downloads' });
        return;
      }
      const rawName = sanitizeDownloadName(requestedName || url);
      const suggestedName = rawName.includes('.') ? rawName : rawName + '.bin';
      const picked = await SystemDialogs.save({ title, suggestedName });
      if (!picked) return;
      if (!picked.path) {
        Notify.show({ title: 'Download failed', body: 'Save As did not return a file path.', type: 'error', appName: 'Downloads' });
        return;
      }
      const entry = window.Downloads?.add(picked.name, isDataImage ? '' : url, 0, '');
      if (entry) window.Downloads.setStatus(entry.id, 'downloading');
      try {
        let bytes;
        if (isDataImage) {
          const comma = url.indexOf(',');
          const metadata = url.slice(5, comma);
          const payload = url.slice(comma + 1);
          const data = /;base64/i.test(metadata)
            ? Buffer.from(payload, 'base64')
            : Buffer.from(decodeURIComponent(payload), 'utf8');
          await require('fs').promises.writeFile(picked.path, data);
          bytes = data.length;
        } else {
          bytes = await streamUrlToFile(url, picked.path, requestHeaders);
        }
        if (entry) window.Downloads.setStatus(entry.id, 'done', bytes);
        Notify.show({ title: 'Download complete', body: picked.name, type: 'success', appName: 'Downloads' });
      } catch (err) {
        if (entry) window.Downloads.setStatus(entry.id, 'failed');
        Notify.show({ title: 'Download failed', body: String(err?.message || err), type: 'error', appName: 'Downloads' });
      }
    }

    // There is no native file chooser in this OS, so the guest cancels clicks
    // on <input type="file"> and reports them here, and the host answers with
    // SystemDialogs. The page only ever sees the result: a File set on the
    // input, then 'input' and 'change' events, same as a native pick.
    const FILE_PICK_MARKER = '__NBOSP_FILEPICK__:';
    const FILE_CHUNK_BYTES = 2 * 1024 * 1024;

    // Runs in the guest's isolated world, so it can cancel the click but
    // can't patch window.showOpenFilePicker for the page's own scripts. The
    // nonce stops a page's console.log from faking a request. Files arrive
    // in chunks and are appended to a Blob, which Chromium keeps out of the
    // JS heap.
    function buildGuestFileScript(nonce) {
      return `
        (function () {
          if (window.__nbosp_file) return;
          var pending = {};
          var seq = 0;
          document.addEventListener('click', function (e) {
            var el = e.composedPath ? e.composedPath()[0] : e.target;
            if (!el || el.tagName !== 'INPUT' || el.type !== 'file' || el.disabled) return;
            e.preventDefault();
            var id = 'f' + (++seq);
            pending[id] = { input: el, files: [], cur: null };
            try {
              console.log('${FILE_PICK_MARKER}${nonce}:' + JSON.stringify({
                id: id, multiple: !!el.multiple, accept: el.accept || '', directory: !!el.webkitdirectory
              }));
            } catch (_e) {}
          }, true);
          window.__nbosp_file = {
            begin: function (id, name, type) {
              var p = pending[id];
              if (!p) return false;
              p.cur = { name: name, type: type, blob: new Blob([]) };
              return true;
            },
            chunk: function (id, b64) {
              var p = pending[id];
              if (!p || !p.cur) return false;
              var bin = atob(b64);
              var bytes = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              p.cur.blob = new Blob([p.cur.blob, bytes]);
              return true;
            },
            endFile: function (id) {
              var p = pending[id];
              if (!p || !p.cur) return false;
              p.files.push(new File([p.cur.blob], p.cur.name, { type: p.cur.type }));
              p.cur = null;
              return true;
            },
            finish: function (id) {
              var p = pending[id];
              if (!p) return false;
              delete pending[id];
              try {
                var dt = new DataTransfer();
                p.files.forEach(function (f) { dt.items.add(f); });
                p.input.files = dt.files;
                p.input.dispatchEvent(new Event('input', { bubbles: true }));
                p.input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              } catch (_e) { return false; }
            },
            cancel: function (id) {
              var p = pending[id];
              if (!p) return false;
              delete pending[id];
              p.input.dispatchEvent(new Event('cancel', { bubbles: true }));
              return true;
            }
          };
        })();
      `;
    }

    function guestFileCall(method, ...args) {
      return '(window.__nbosp_file && window.__nbosp_file.' + method + '(' + args.map(a => JSON.stringify(a)).join(',') + '))';
    }

    // Reads a picked file from disk and feeds it to the guest chunk by chunk.
    async function sendFileToGuest(runInGuest, id, picked) {
      const fs = require('fs');
      const expectTrue = async call => {
        if ((await runInGuest(call)) !== true) throw new Error('The page stopped waiting for ' + picked.name);
      };
      await expectTrue(guestFileCall('begin', id, picked.name, picked.mimeType || ''));
      const handle = await fs.promises.open(picked.path, 'r');
      try {
        const buf = Buffer.alloc(FILE_CHUNK_BYTES);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          await expectTrue(guestFileCall('chunk', id, buf.toString('base64', 0, bytesRead)));
        }
      } finally {
        await handle.close();
      }
      await expectTrue(guestFileCall('endFile', id));
    }

    // Webview factory — creates or returns the <webview> element for a tab.
    // Attaches all event listeners (load, error, fullscreen, permission,
    // download, new-window, context-menu) exactly once per webview.
    function getOrCreateWebview(tabId) {
      const existing = tabWebviews.get(tabId);
      if (existing) return existing;

      const tab = tabs.find(t => t.id === tabId);
      const GUEST_STYLE = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;';
      // The System Webview service owns guest creation for first-party apps.
      // Fall back to building it here if the service isn't loaded.
      const trusted = typeof window.NovaSystemWebview?.createTrustedGuest === 'function'
        ? window.NovaSystemWebview.createTrustedGuest(
            { id: 'com.nbosp.browser', system: true },
            { parent: viewport, guestId: tabId, incognito: !!tab?.incognito, partition: BROWSER_PARTITION, style: GUEST_STYLE }
          )
        : null;
      let wv = trusted?.element;
      if (!wv) {
        wv = document.createElement('webview');
        wv.setAttribute('partition', tab?.incognito ? ('incognito_' + tabId) : BROWSER_PARTITION);
        wv.setAttribute('allowfullscreen', 'true');
        wv.setAttribute('nodeintegration', 'false');
        wv.setAttribute('enableremotemodule', 'false');
        wv.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
        wv.style.cssText = GUEST_STYLE;
      }
      wv._nbTrusted = trusted;
      // Stash the tabId directly on the element. NW.js's webRequest event
      // system doesn't reliably retain a closure over the local `tabId`
      // parameter (confirmed by the pre-existing onBeforeRequest listener
      // already avoiding outer-local refs for the same reason). The element
      // itself is what the listener closure captures, and property reads on
      // it always work.
      wv._nbTabId = tabId;
      wv._nbImageRequestHeaders = new Map();

      wv.addEventListener('loadcommit', e => {
        if (e.isTopLevel) wv._nbImageRequestHeaders.clear();
        if (e.isTopLevel && e.url) syncUrlForTab(e.url, tabId, 'loadcommit');
      });

      wv.addEventListener('loadstop', () => {
        // Sync URL via executeScript (NW.js has no did-navigate event).
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
            } catch { /* ignore */ }
            if (url && !url.startsWith('novabyte:') && !url.startsWith('file://')) {
              addHistory(tabId, url, title || url, tab.favicon);
            }
          });
        } catch { /* ignore */ }
      });

      wv.addEventListener('contentload', () => {
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'contentload+executeScript');
          });
        } catch { /* ignore */ }
        // New page load — apply the current system volume to whatever
        // <audio>/<video> it just created, instead of leaving them at
        // the page's own default until the tray slider is next touched.
        if (typeof OS !== 'undefined' && typeof OS.applyVolumeToWebviews === 'function') {
          OS.applyVolumeToWebviews(Number.isFinite(OS.volume) ? OS.volume : 80, wv);
        }
      });

      // Network / certificate error handling — render a custom error page
      // inside the webview instead of leaving the user staring at a blank box.
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

        // Build the error page. The <script> tag uses data-attributes +
        // addEventListener (no inline handlers — CSP-safe). All user-
        // controlled strings (failedUrl, hint) are HTML-escaped before
        // being interpolated into the markup.
        const escapeHtml = (s) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const safeHint = escapeHtml(hint);
        const safeUrl  = escapeHtml(failedUrl);

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
          // JSON.stringify the whole HTML string so it survives being
          // embedded inside a JS template literal executed via executeScript.
          const htmlStr = JSON.stringify(errorHtml);
          wv.executeScript({
            code: `requestAnimationFrame(() => { document.documentElement.innerHTML = ${htmlStr}; });`
          }, () => {});
        } catch { /* ignore */ }
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
        } catch { /* ignore */ }
      });

      // Fullscreen support for web content — when a page requests
      // element fullscreen, expand the webview to cover the whole OS
      // window and ask the OS shell to enter fullscreen too.
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
          try { nw.Window.get().enterFullscreen(); } catch { /* ignore */ }
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
          try { nw.Window.get().leaveFullscreen(); } catch { /* ignore */ }
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

      // Process status monitoring — show an info bar offering Wait/Reload
      // when a page becomes unresponsive.
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

      // Popup / new-window support (NW.js Chrome Apps webview API).
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
          } catch { /* ignore */ }
          return false;
        }

        if (getSetting('block_popup_windows', true) && e.windowOpenDisposition === 'new_popup' && !isAuthPopup(url)) {
          try { if (e.window?.discard) e.window.discard(); } catch { /* ignore */ }
          return;
        }

        const disposition = e.windowOpenDisposition;

        if (disposition === 'new_popup') {
          // Inline popup overlay — e.window.attach() preserves the opener
          // link so window.close() works inside the popup.
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
            } catch { /* ignore */ }
            if (typeof OS !== 'undefined' && typeof OS.applyVolumeToWebviews === 'function') {
              OS.applyVolumeToWebviews(Number.isFinite(OS.volume) ? OS.volume : 80, popWv);
            }
          });
          popWv.addEventListener('close', closePopup);
          e.window.attach(popWv);
        } else {
          // For tabs: discard the NW native window, open as a new tab instead.
          try { if (e.window?.discard) e.window.discard(); } catch { /* ignore */ }
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
              // Trusted built-in Browser loads external pages without an app-level permission gate.
              bgWv.src = url;
            }
          } else {
            switchToTab(newTab.id);
            navigate(url);
          }
        }
      });

      // window.close() inside guest content closes the host tab.
      wv.addEventListener('close', () => closeTab(tabId));

      tabWebviews.set(tabId, wv);
      attachHostQuickControlWheel(wv, tabId);
      applyWebviewSettings(wv);
      return wv;
    }

    // iframe mode helpers — iframe mode is the fallback when <webview> is
    // unavailable (e.g. in a plain browser without NW.js). It uses a
    // sandboxed <iframe> with most of the same plumbing.
    function getOrCreateIframe(tabId) {
      const existing = tabIframes.get(tabId);
      if (existing) return existing;

      const ifr = document.createElement('iframe');
      ifr.setAttribute('allowfullscreen', 'true');
      ifr.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
      // allow-same-origin intentionally ABSENT — combining it with
      // allow-scripts enables a known sandbox escape (framed doc can
      // call frameElement.removeAttribute('sandbox')).
      ifr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
      ifr.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;background:#fff;';

      // NOTE: blocking is detected server-side via /api/frame-check before
      // the iframe is ever shown (see navigateFrameMode). The old heuristic
      // here (checking ifr.contentDocument.URL === 'about:blank') was wrong
      // both ways: embeddable sites pass through about:blank mid-load (false
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
        } catch { /* cross-origin — title sync not possible, expected */ }
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

    // Per-tab frame-check generation guard. Bumped before each
    // /api/frame-check so a slow response from a previous navigation can't
    // show/hide the iframe of a newer one.
    const _frameCheckGen = new Map(); // tabId → number

    // Server-side frame-embed check. Returns true if the URL may be loaded
    // in an <iframe> (no XFO/CSP frame-ancestors blocking it). On any error
    // or timeout we optimistically return true so we never false-block a
    // legitimate page — the iframe will just show its normal content.
    // Returns null when superseded by a newer call (caller should bail).
    async function checkFrameEmbeddable(tabId, url) {
      const gen = (_frameCheckGen.get(tabId) || 0) + 1;
      _frameCheckGen.set(tabId, gen);
      try {
        // AbortSignal.timeout caps the wait so a hanging server can't leave
        // the iframe stuck on about:blank forever.
        const r = await fetch('/api/frame-check?url=' + encodeURIComponent(url),
          { signal: AbortSignal.timeout(8000) });
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        if (!r.ok) return true; // fail open
        const j = await r.json();
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        return j.embeddable !== false;
      } catch {
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
      modeBtn.setAttribute('aria-pressed', mode === 'iframe' ? 'true' : 'false');
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
        const sourcePage = tabSourcePages.get(tabId);
        if (sourcePage) {
          for (const [, wv] of tabWebviews) {
            wv.style.position = 'absolute';
            wv.style.visibility = 'hidden';
            wv.style.pointerEvents = 'none';
            wv.style.zIndex = '0';
          }
          for (const [, ifr] of tabIframes) {
            ifr.style.position = 'absolute';
            ifr.style.visibility = 'hidden';
            ifr.style.pointerEvents = 'none';
            ifr.style.zIndex = '0';
          }
          viewport.querySelectorAll('.browser-iframe-blocked').forEach(n => n.remove());
          for (const [id, page] of tabSourcePages) {
            page.style.display = id === tabId ? 'block' : 'none';
          }
          return;
        }
        for (const [, page] of tabSourcePages) page.style.display = 'none';

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
          // position:relative + flex:1 would claim half the viewport and
          // show through as a black bar under the active webview.
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

    function setBrowserChromeHidden(hidden) {
      const tab = tabs.find(item => item.id === activeTabId);
      const canHide = getSetting('fullscreen', false) &&
        /^https?:\/\//i.test(tab?.url || '') &&
        !tabSourcePages.has(activeTabId);
      clearTimeout(browserChromeHideTimer);
      browserChromeHideTimer = null;
      browserChromeHidden = Boolean(hidden) && canHide;
      tabsBar.style.display = browserChromeHidden ? 'none' : '';
      toolbar.style.display = browserChromeHidden ? 'none' : '';
      findBar.style.display = browserChromeHidden || !findBarOpen ? 'none' : 'flex';
    }
    state.cleanups.push(() => clearTimeout(browserChromeHideTimer));

    function scheduleBrowserChromeHide() {
      clearTimeout(browserChromeHideTimer);
      if (!browserChromeHidden && getSetting('fullscreen', false)) {
        browserChromeHideTimer = setTimeout(() => setBrowserChromeHidden(true), 700);
      }
    }

    function applyPageAccessibility(wv) {
      if (!wv) return;
      const css = [
        getSetting('inverted', false)
          ? 'html{filter:invert(1) hue-rotate(180deg)!important}img,video,canvas{filter:invert(1) hue-rotate(180deg)!important}'
          : '',
        Number(getSetting('min_font_size', 0)) > 0
          ? `body,body *{font-size:max(${Number(getSetting('min_font_size', 0))}px,1em)!important}`
          : '',
        Number(getSetting('text_zoom', 10)) !== 10
          ? `body{zoom:${Number(getSetting('text_zoom', 10)) / 10}!important}`
          : ''
      ].filter(Boolean).join('\n');
      const payload = JSON.stringify(css);
      try {
        wv.executeScript({ code: `(() => {
          let style = document.getElementById('__nbosp_accessibility_styles');
          if (!style) {
            style = document.createElement('style');
            style.id = '__nbosp_accessibility_styles';
            (document.head || document.documentElement).appendChild(style);
          }
          style.textContent = ${payload};
        })()` });
      } catch (err) {
        console.warn('[NB Browser] Could not apply page accessibility settings:', err);
      }
    }

    function applyGeolocationGate(wv) {
      if (!wv) return;
      const code = getSetting('enable_geolocation', false)
        ? `(() => {
            const current = navigator.geolocation;
            if (current?.__nbospGeolocationBlocked) delete navigator.geolocation;
          })()`
        : `(() => {
            const denied = {
              __nbospGeolocationBlocked: true,
              getCurrentPosition(success, error) {
                if (typeof error === 'function') setTimeout(() => error({ code: 1, message: 'Location is blocked by Browser settings.' }), 0);
              },
              watchPosition(success, error) {
                if (typeof error === 'function') setTimeout(() => error({ code: 1, message: 'Location is blocked by Browser settings.' }), 0);
                return 0;
              },
              clearWatch() {}
            };
            Object.defineProperty(navigator, 'geolocation', { configurable: true, value: denied });
          })()`;
      try {
        wv.executeScript({ code });
      } catch (err) {
        console.warn('[NB Browser] Could not apply geolocation restriction:', err);
      }
    }

    function getSitePermissionStates(rawUrl) {
      let origin;
      try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        origin = url.origin;
      } catch {
        return null;
      }

      const getState = (permission, enabled) => {
        if (!enabled) return 'denied';
        const decision = sitePermissionDecisions.get(permission + ':' + origin);
        return decision === undefined ? 'prompt' : decision ? 'granted' : 'denied';
      };
      const geo = getState('geolocation', getSetting('enable_geolocation', false));
      const media = getState('media', getSetting('enable_media', false));
      return { geolocation: geo, camera: media, microphone: media };
    }

    function applySitePermissionStates(wv, rawUrl) {
      if (!wv) return;
      const states = getSitePermissionStates(rawUrl);
      if (!states) return;
      const payload = JSON.stringify(states);
      try {
        wv.executeScript({ code: `(() => {
          if (!navigator.permissions?.query || typeof PermissionStatus === 'undefined') return;
          const supported = new Set(['geolocation', 'camera', 'microphone']);
          if (!window.__nbosp_permission_state_shim) {
            const permissions = navigator.permissions;
            const originalQuery = permissions.query.bind(permissions);
            const statusObjects = new Map();
            window.__nbosp_permission_states = {};
            const nativeState = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state');
            if (!nativeState?.get || !nativeState.configurable) return;
            Object.defineProperty(PermissionStatus.prototype, 'state', {
              configurable: true,
              enumerable: nativeState.enumerable,
              get() {
                const name = statusObjects.get(this);
                const state = name && window.__nbosp_permission_states[name];
                return state || nativeState.get.call(this);
              }
            });
            Object.defineProperty(permissions, 'query', {
              configurable: true,
              value: async descriptor => {
                const status = await originalQuery(descriptor);
                if (supported.has(descriptor?.name)) statusObjects.set(status, descriptor.name);
                return status;
              }
            });
            window.__nbosp_set_permission_states = nextStates => {
              const changed = [];
              for (const [name, state] of Object.entries(nextStates)) {
                if (window.__nbosp_permission_states[name] !== state) {
                  window.__nbosp_permission_states[name] = state;
                  changed.push(name);
                }
              }
              for (const [status, name] of statusObjects) {
                if (changed.includes(name)) status.dispatchEvent(new Event('change'));
              }
            };
            window.__nbosp_permission_state_shim = true;
          }
          window.__nbosp_set_permission_states(${payload});
        })()` });
      } catch (err) {
        console.warn('[NB Browser] Could not synchronize site permission status:', err);
      }
    }

    async function requestSitePermission(permission, rawUrl) {
      let origin;
      try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          console.warn('[NB Browser] Denied a site permission request without a valid HTTP(S) origin:', permission);
          return false;
        }
        if (permission === 'geolocation' && url.protocol !== 'https:') {
          Notify.show({
            title: 'Location requires a secure connection',
            body: `${url.origin} cannot access location over HTTP. Open the HTTPS version of this site and try again.`,
            type: 'error', appName: 'Browser'
          });
          return false;
        }
        origin = url.origin;
      } catch {
        console.warn('[NB Browser] Denied a site permission request without a valid HTTP(S) origin:', permission);
        return false;
      }

      const key = permission + ':' + origin;
      if (sitePermissionDecisions.has(key)) return sitePermissionDecisions.get(key);
      if (pendingSitePermissionPrompts.has(key)) return pendingSitePermissionPrompts.get(key);

      const prompt = (async () => {
        try {
          const subject = permission === 'geolocation' ? 'your location' : 'your camera or microphone';
          const allowed = await showModal(
            permission === 'geolocation' ? 'Location access' : 'Camera or microphone access',
            `Allow ${origin} to access ${subject}? Your choice lasts until Browser closes.`,
            [{ label: 'Block', value: false }, { label: 'Allow', value: true, primary: true }]
          );
          const decision = allowed === true;
          sitePermissionDecisions.set(key, decision);
          return decision;
        } catch (err) {
          console.error('[NB Browser] Could not show the site permission prompt:', err);
          return false;
        } finally {
          pendingSitePermissionPrompts.delete(key);
        }
      })();
      pendingSitePermissionPrompts.set(key, prompt);
      return prompt;
    }

    function clearSitePermissionDecisions(permission) {
      for (const key of sitePermissionDecisions.keys()) {
        if (key.startsWith(permission + ':')) sitePermissionDecisions.delete(key);
      }
    }

    function updateGeolocationAccess(enabled) {
      for (const [tabId, wv] of tabWebviews) {
        applyGeolocationGate(wv);
        const tab = tabs.find(item => item.id === tabId);
        applySitePermissionStates(wv, tab?.url || '');
        if (/^https?:\/\//i.test(tab?.url || '')) {
          try { wv.reload(); }
          catch (err) { console.warn('[NB Browser] Could not reload a page after changing location access:', err); }
        }
      }
    }

    function updateMediaAccess() {
      for (const [tabId, wv] of tabWebviews) {
        const tab = tabs.find(item => item.id === tabId);
        if (/^https?:\/\//i.test(tab?.url || '')) {
          try { wv.reload(); }
          catch (err) { console.warn('[NB Browser] Could not reload a page after updating media access:', err); }
        }
      }
    }

    function applyGuestBrowserFeatures(wv) {
      if (!wv) return;
      const prefs = {
        quickControls: getSetting('enable_quick_controls', false),
        quickControlDiagnostics: window.__NBOSP_BROWSER_QUICK_CONTROL_DEBUG__ === true,
        fullscreen: getSetting('fullscreen', false),
        preload: getSetting('preload_when', 'NEVER'),
        linkPrefetch: getSetting('link_prefetch_when', 'NEVER'),
      };
      const config = JSON.stringify(prefs);
      const marker = JSON.stringify(BROWSER_BEHAVIOR_MARKER);
      try {
        wv.executeScript({ code: `(() => {
          const prefs = ${config};
          window.__nbosp_browser_prefs = prefs;
          const send = action => { try { console.log(${marker} + action); } catch (_) {} };
          const sendQuickDiagnostic = data => {
            if (!window.__nbosp_browser_prefs.quickControlDiagnostics) return;
            try { console.log(${JSON.stringify(BROWSER_QUICK_DIAGNOSTIC_MARKER)} + JSON.stringify(data)); } catch (_) {}
          };
          if (window.__nbosp_browser_features_installed) {
            window.__nbosp_refresh_preloads?.();
            return;
          }
          window.__nbosp_browser_features_installed = true;
          const scrollPositions = new WeakMap();
          if (document.scrollingElement) scrollPositions.set(document.scrollingElement, window.scrollY || 0);
          let lastScrollSignal = 0;
          let lastChromeRevealSignal = 0;
          let gestureStart = null;
          let quickWheelDelta = 0;
          let quickWheelTimer = null;
          let lastQuickWheelAt = 0;
          let quickWheelDiagnosticsSent = { any: false, horizontal: false };
          let chromePointerNearTop = false;
          let lastChromeAwaySignal = 0;
          document.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) { gestureStart = null; return; }
            gestureStart = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              interactive: Boolean(event.target.closest?.('a,button,input,textarea,select,[contenteditable="true"],[draggable="true"]'))
            };
          }, { capture: true, passive: true });
          document.addEventListener('pointerup', event => {
            if (!gestureStart || gestureStart.id !== event.pointerId) return;
            const start = gestureStart;
            gestureStart = null;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (!window.__nbosp_browser_prefs.quickControls ||
                start.interactive ||
                event.target.closest?.('input,textarea,select,[contenteditable="true"]') ||
                Math.abs(dx) < 90 || Math.abs(dy) > 60) return;
            if (start.x < 28 && dx > 0) send('back');
            else if (start.x > innerWidth - 28 && dx < 0) send('forward');
          }, { capture: true, passive: true });
          document.addEventListener('pointercancel', () => { gestureStart = null; }, true);
          document.addEventListener('wheel', event => {
            const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
            const verticalDelta = event.shiftKey ? 0 : event.deltaY;
            const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerWidth : 1;
            if (window.__nbosp_browser_prefs.quickControlDiagnostics) {
              const diagnostic = {
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                deltaMode: event.deltaMode,
                shiftKey: event.shiftKey,
                normalizedDeltaX: horizontalDelta * deltaScale,
                quickControlsEnabled: window.__nbosp_browser_prefs.quickControls
              };
              if (!quickWheelDiagnosticsSent.any) {
                quickWheelDiagnosticsSent.any = true;
                sendQuickDiagnostic({ type: 'first-wheel', ...diagnostic });
              }
              if (!quickWheelDiagnosticsSent.horizontal && (event.deltaX !== 0 || event.shiftKey)) {
                quickWheelDiagnosticsSent.horizontal = true;
                sendQuickDiagnostic({ type: 'first-horizontal-wheel', ...diagnostic });
              }
            }
            if (!window.__nbosp_browser_prefs.quickControls ||
                event.ctrlKey ||
                Math.abs(horizontalDelta) < Math.abs(verticalDelta) * 1.2 ||
                Math.abs(horizontalDelta * deltaScale) < 8 ||
                event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
            quickWheelDelta += horizontalDelta * deltaScale;
            clearTimeout(quickWheelTimer);
            quickWheelTimer = setTimeout(() => {
              const delta = quickWheelDelta;
              quickWheelDelta = 0;
              if (!window.__nbosp_browser_prefs.quickControls ||
                  Math.abs(delta) < 40 ||
                  Date.now() - lastQuickWheelAt < 700) return;
              lastQuickWheelAt = Date.now();
              send(delta > 0 ? 'forward' : 'back');
            }, 250);
          }, { capture: true, passive: true });
          document.addEventListener('pointermove', event => {
            if (!window.__nbosp_browser_prefs.fullscreen) {
              chromePointerNearTop = false;
              return;
            }
            const nearTop = event.clientY <= 20;
            if (nearTop && !chromePointerNearTop) {
              const now = Date.now();
              if (now - lastChromeRevealSignal >= 500) {
                lastChromeRevealSignal = now;
                send('reveal-chrome');
              }
            } else if (!nearTop) {
              const now = Date.now();
              if (now - lastChromeAwaySignal >= 300) {
                lastChromeAwaySignal = now;
                send('chrome-pointer-away');
              }
            }
            chromePointerNearTop = nearTop;
          }, { capture: true, passive: true });
          document.addEventListener('pointerleave', () => {
            if (window.__nbosp_browser_prefs.fullscreen) {
              chromePointerNearTop = false;
              send('chrome-pointer-away');
            }
          }, { capture: true, passive: true });
          document.addEventListener('scroll', event => {
            const target = event.target === document ? document.scrollingElement : event.target;
            if (!target || typeof target.scrollTop !== 'number') return;
            const y = target.scrollTop;
            const previousY = scrollPositions.get(target) || 0;
            const diff = y - previousY;
            scrollPositions.set(target, y);
            if (!window.__nbosp_browser_prefs.fullscreen || Math.abs(diff) < 12) return;
            const now = Date.now();
            if (now - lastScrollSignal < 160) return;
            lastScrollSignal = now;
            send(diff > 0 ? 'scroll-down' : 'scroll-up');
          }, true);
          const shouldPrefetch = mode => {
            const value = mode === 'next'
              ? window.__nbosp_browser_prefs.preload
              : window.__nbosp_browser_prefs.linkPrefetch;
            return value === 'ALWAYS';
          };
          const prefetched = window.__nbosp_prefetched_urls || (window.__nbosp_prefetched_urls = new Set());
          const prefetch = (url, mode) => {
            if (!shouldPrefetch(mode) || prefetched.size >= 12) return;
            try {
              const target = new URL(url, location.href);
              if (target.origin !== location.origin || target.protocol !== 'http:' && target.protocol !== 'https:' || prefetched.has(target.href)) return;
              prefetched.add(target.href);
              const link = document.createElement('link');
              link.rel = 'prefetch';
              link.href = target.href;
              document.head.appendChild(link);
            } catch (_) {}
          };
          const preloadNext = () => {
            if (!shouldPrefetch('next')) return;
            document.querySelectorAll('link[rel~="next"][href]').forEach(link => prefetch(link.href, 'next'));
          };
          window.__nbosp_refresh_preloads = preloadNext;
          preloadNext();
          new MutationObserver(preloadNext).observe(document.documentElement, { childList: true, subtree: true });
          document.addEventListener('pointerover', event => {
            if (!event.isTrusted || !shouldPrefetch('link')) return;
            const anchor = event.target.closest && event.target.closest('a[href]');
            if (anchor) prefetch(anchor.href, 'link');
          }, { passive: true });
        })()` });
      } catch (err) {
        console.warn('[NB Browser] Could not apply guest browser features:', err);
      }
    }

    // Apply user prefs (zoom mode, per-page CSS overrides, permission
    // gating, request listeners for the Network tab) to a webview.
    // Called once when the webview is created.
    function applyWebviewSettings(wv) {
      const zoomMap = { FAR: 0.75, MEDIUM: 1.0, CLOSE: 1.25 };
      const decidedPermissionRequests = new WeakSet();

      wv.addEventListener('loadstop', () => {
        // Use the stashed _nbTabId instead of doing an O(n) reverse
        // lookup of the webview inside tabWebviews.
        const tabId = wv._nbTabId;
        if (tabId != null && !tabZoom.has(tabId)) {
          try { wv.setZoom(zoomMap[getSetting('default_zoom', 'MEDIUM')] || 1.0); } catch { /* ignore */ }
        }
      });

      wv.addEventListener('loadcommit', () => {
        try { wv.setZoomMode('per-origin'); } catch { /* ignore */ }
      });

      wv.addEventListener('permissionrequest', e => {
        if (!e.request || decidedPermissionRequests.has(e.request)) return;
        const decide = allowed => {
          if (!e.request || decidedPermissionRequests.has(e.request)) return false;
          decidedPermissionRequests.add(e.request);
          try {
            if (allowed) e.request.allow();
            else e.request.deny();
            return true;
          } catch (err) {
            console.warn('[NB Browser] Could not resolve a site permission request:', err);
            return false;
          }
        };
        const tab = tabs.find(item => item.id === wv._nbTabId);
        const requestUrl = e.request.url || e.url || tab?.url || '';
        const askSite = permission => {
          requestSitePermission(permission, requestUrl)
            .then(allowed => {
              if (decide(allowed)) applySitePermissionStates(wv, requestUrl);
            })
            .catch(err => {
              console.error('[NB Browser] Site permission request failed:', err);
              decide(false);
            });
        };
        if (e.permission === 'geolocation') {
          if (!getSetting('enable_geolocation', false)) {
            decide(false);
            return;
          }
          askSite('geolocation');
        } else if (e.permission === 'media') {
          if (!getSetting('enable_media', false)) {
            decide(false);
            return;
          }
          askSite('media');
        } else if (e.permission === 'pointerLock') {
          decide(true);
        } else if (e.permission === 'download') {
          // Deny Chromium's own download (it opens the host's native
          // chooser) and save through the OS Save As dialog instead.
          decide(false);
          saveDownloadViaDialog(e.request.url || e.url).catch(err => {
            console.warn('[NB Browser] Download failed to start:', err);
          });
        } else {
          decide(false);
        }
      });

      // webRequest listeners — attach once per webview.
      let _requestListenersAttached = false;
      function _attachRequestListeners() {
        if (_requestListenersAttached) return;
        if (!wv.request) return;
        _requestListenersAttached = true;
        try {
          wv.request.onBeforeRequest.addListener(
            () => ({ cancel: !getSetting('load_images', true) }),
            { urls: ['<all_urls>'], types: ['image', 'media'] },
            ['blocking']
          );
          wv.request.onBeforeSendHeaders.addListener(details => {
            const requestHeaders = getSetting('accept_cookies', true)
              ? (details.requestHeaders || [])
              : (details.requestHeaders || []).filter(header =>
                !['cookie', 'cookie2'].includes(header.name?.toLowerCase())
              );
            if (details.type === 'image' && typeof details.url === 'string') {
              const captured = {};
              const allowedHeaders = new Set([
                'accept', 'accept-language', 'authorization', 'cookie', 'cookie2',
                'referer', 'user-agent',
              ]);
              for (const header of requestHeaders) {
                const name = header.name?.toLowerCase();
                if (allowedHeaders.has(name) && typeof header.value === 'string') {
                  captured[header.name] = header.value;
                }
              }
              if (wv._nbImageRequestHeaders.size >= 256) {
                const oldestUrl = wv._nbImageRequestHeaders.keys().next().value;
                wv._nbImageRequestHeaders.delete(oldestUrl);
              }
              wv._nbImageRequestHeaders.set(normalizeRequestUrl(details.url), captured);
            }
            return { requestHeaders };
          }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders', 'extraHeaders']);
          wv.request.onHeadersReceived.addListener(details => {
            let responseHeaders = details.responseHeaders || [];
            if (!getSetting('accept_cookies', true)) {
              responseHeaders = responseHeaders.filter(header =>
                !['set-cookie', 'set-cookie2'].includes(header.name?.toLowerCase())
              );
            }
            const blockedFeatures = [];
            if (!getSetting('enable_geolocation', false)) blockedFeatures.push('geolocation');
            if (!getSetting('enable_media', false)) blockedFeatures.push('camera', 'microphone');
            if (blockedFeatures.length) {
              const policies = responseHeaders.filter(header => header.name?.toLowerCase() === 'permissions-policy');
              if (policies.length) {
                const otherDirectives = policies.flatMap(header => (header.value || '').split(','))
                  .map(directive => directive.trim())
                  .filter(directive => directive &&
                    !blockedFeatures.includes(directive.split('=', 1)[0].trim().toLowerCase()));
                const replacement = {
                  ...policies[0],
                  value: [...otherDirectives, ...blockedFeatures.map(feature => feature + '=()')].join(', ')
                };
                let replaced = false;
                responseHeaders = responseHeaders.filter(header => {
                  if (header.name?.toLowerCase() !== 'permissions-policy') return true;
                  if (replaced) return false;
                  replaced = true;
                  return true;
                }).map(header => {
                  if (header.name?.toLowerCase() !== 'permissions-policy') return header;
                  if (header === policies[0]) return replacement;
                  return header;
                });
              } else {
                responseHeaders.push({ name: 'Permissions-Policy', value: blockedFeatures.map(feature => feature + '=()').join(', ') });
              }
            }
            return { responseHeaders };
          }, { urls: ['<all_urls>'] }, ['blocking', 'responseHeaders', 'extraHeaders']);
        } catch (err) {
          _requestListenersAttached = false;
          console.error('[NB Browser] Failed to attach webRequest privacy rules:', err);
          return;
        }

        // Feed Perf Monitor's Network tab. wv.request lives per-<webview>
        // (a genuinely separate NW.js/Chromium process from this document),
        // so this is the only point in the codebase with visibility into
        // Browser tab traffic — perf.js cannot reach it directly and reads
        // from window.NetworkLog instead, same pattern as gallery.js's
        // window.Downloads. onCompleted/onErrorOccurred give method, URL,
        // status, type and timing — NOT response bodies; that requires
        // CDP Network.getResponseBody, which nothing here wires up, so
        // Browser-tab rows in the log intentionally never carry a body.
        try {
          wv.request.onCompleted.addListener(
            (details) => {
              const _tabId = wv._nbTabId;
              const tab = tabs.find(t => t.id === _tabId);
              window.NetworkLog?.push({
                source: 'browser',
                tabId: _tabId,
                tabTitle: tab?.title || 'Tab ' + _tabId,
                method: details.method,
                url: details.url,
                type: details.type,
                statusCode: details.statusCode,
                error: null,
                // fromCache/timeStamp are what NW.js's webRequest actually
                // provides; there is no per-request start time exposed on
                // this event, so duration can't be computed honestly here —
                // unlike the OS-level fetch/XHR patch in perf.js, which
                // times its own requests directly.
                fromCache: !!details.fromCache,
                time: details.timeStamp || Date.now(),
              });
            },
            { urls: ['<all_urls>'] }
          );
          wv.request.onErrorOccurred.addListener(
            (details) => {
              const _tabId = wv._nbTabId;
              const tab = tabs.find(t => t.id === _tabId);
              window.NetworkLog?.push({
                source: 'browser',
                tabId: _tabId,
                tabTitle: tab?.title || 'Tab ' + _tabId,
                method: details.method,
                url: details.url,
                type: details.type,
                statusCode: null,
                error: details.error || 'unknown error',
                fromCache: false,
                time: details.timeStamp || Date.now(),
              });
            },
            { urls: ['<all_urls>'] }
          );
        } catch { /* wv.request not ready yet */ }
      }
      wv.addEventListener('contentload', _attachRequestListeners);
      wv.addEventListener('loadcommit', _attachRequestListeners);
      wv.addEventListener('dom-ready', _attachRequestListeners);
      _attachRequestListeners();

      wv.addEventListener('loadstop', () => {
        applyPageAccessibility(wv);
        applyGeolocationGate(wv);
        applyGuestBrowserFeatures(wv);
        const currentUrl = typeof wv.getURL === 'function'
          ? wv.getURL()
          : tabs.find(item => item.id === wv._nbTabId)?.url || '';
        applySitePermissionStates(wv, currentUrl);
        fillSavedLogin(wv);
        try {
          const loginMarker = JSON.stringify(BROWSER_LOGIN_MARKER);
          wv.executeScript({ code: `(() => {
            if (window.__nbosp_login_capture_installed) return;
            window.__nbosp_login_capture_installed = true;
            let lastLogin = '';
            let lastLoginAt = 0;
            const capture = form => {
              if (!form || !form.querySelector) return;
              const passwordFields = Array.from(form.querySelectorAll('input[type="password"]'));
              const password = passwordFields.find(field => field.autocomplete === 'current-password') ||
                (passwordFields.length === 1 && passwordFields[0].autocomplete !== 'new-password' ? passwordFields[0] : null);
              const user = form.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="email" i],input[type="text"]');
              const username = user ? String(user.value).slice(0, 512) : '';
              const passwordValue = password ? String(password.value).slice(0, 4096) : '';
              if (!passwordValue && !username) return;
              if (!passwordValue && password) return;
              const login = {
                origin: location.origin,
                username,
                password: passwordValue
              };
              const serialized = JSON.stringify(login);
              const now = Date.now();
              if (serialized === lastLogin && now - lastLoginAt < 1500) return;
              lastLogin = serialized;
              lastLoginAt = now;
              try { console.log(${loginMarker} + serialized); } catch (_) {}
            };
            document.addEventListener('submit', event => capture(event.target), true);
            document.addEventListener('click', event => {
              const submitter = event.target.closest?.('button,input[type="submit"],input[type="button"],[role="button"]');
              const form = submitter?.form || submitter?.closest('form');
              if (form) capture(form);
            }, true);
            document.addEventListener('keydown', event => {
              if (event.key !== 'Enter') return;
              const field = event.target;
              if (field?.matches?.('input[type="password"]') && field.form) capture(field.form);
            }, true);
          })()` });
        } catch (err) {
          console.warn('[NB Browser] Could not install login capture:', err);
        }
      });

      // Webview viewport right-click menu.
      // NW.js does NOT forward arbitrary DOM events from guest content to
      // the host — 'contextmenu' on the <webview> element never fires
      // (confirmed dead since nw.js 0.29.3; guest content runs in its own
      // process, so host-side listeners for events outside the small
      // documented set just don't see it). So instead:
      //   1. Inject a script into the guest (on every loadstop, for SPA nav)
      //      that listens for 'contextmenu' INSIDE the guest's own document
      //      — the only place that can actually preventDefault() the native
      //      Chromium menu for that content — and reports the click target +
      //      position to the host via console.log, tagged with a marker.
      //   2. Host listens for 'consolemessage' on the <webview> (this one
      //      reliably bubbles), recognizes the tagged payload, converts the
      //      guest-relative click position into host-page coordinates using
      //      the webview's own bounding rect, and shows our ContextMenu.
      const _CTX_MARKER = '__NBOSP_CTXMENU__:';
      const _CTX_DISMISS_MARKER = '__NBOSP_CTXMENU_DISMISS__';
      const _CTX_SCROLL_MARKER = '__NBOSP_CTXMENU_SCROLL__';
      const _GUEST_CTX_SCRIPT = `
        (function () {
          if (window.__nbosp_ctx_injected) return;
          window.__nbosp_ctx_injected = true;
          document.addEventListener('pointerdown', function () {
            try { console.log('${_CTX_DISMISS_MARKER}'); } catch (_e) {}
          }, true);
          document.addEventListener('scroll', function () {
            try { console.log('${_CTX_SCROLL_MARKER}'); } catch (_e) {}
          }, true);
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
              viewportWidth:  window.innerWidth,
              viewportHeight: window.innerHeight,
              linkHref:     link ? (link.href  || '') : '',
              linkText:     link ? (link.textContent || '').trim().slice(0, 120) : '',
              imgSrc:       img  ? (img.currentSrc || img.src || '') : '',
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
        try { wv.executeScript({ code: _GUEST_CTX_SCRIPT }); } catch { /* ignore */ }
      });

      // File inputs: answer the guest's cancelled click with the OS Open dialog.
      const fileNonce = crypto.randomUUID();
      const fileRequestPrefix = FILE_PICK_MARKER + fileNonce + ':';
      const guestFileScript = buildGuestFileScript(fileNonce);
      let filePickOpen = false;

      const runInGuest = code => new Promise((resolve, reject) => {
        wv.executeScript({ code }, result => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(result?.[0]);
        });
      });

      async function answerGuestFilePick(request) {
        const id = String(request.id);
        if (filePickOpen || request.directory) {
          if (request.directory) {
            Notify.show({ title: 'Folder upload unavailable', body: "Browser can't upload whole folders yet.", type: 'info', appName: 'Browser' });
          }
          await runInGuest(guestFileCall('cancel', id));
          return;
        }
        filePickOpen = true;
        try {
          const result = await SystemDialogs.open({
            title: request.multiple ? 'Choose Files to Upload' : 'Choose File to Upload',
            multiple: request.multiple === true,
            accept: request.accept,
            pathOnly: true,
          });
          const picks = result ? [].concat(result) : [];
          if (!picks.length) {
            await runInGuest(guestFileCall('cancel', id));
            return;
          }
          for (const picked of picks) await sendFileToGuest(runInGuest, id, picked);
          if ((await runInGuest(guestFileCall('finish', id))) !== true) throw new Error('The page did not accept the file');
        } catch (err) {
          Notify.show({ title: 'Upload failed', body: String(err?.message || err), type: 'error', appName: 'Browser' });
          await runInGuest(guestFileCall('cancel', id)).catch(() => {});
        } finally {
          filePickOpen = false;
        }
      }

      wv.addEventListener('consolemessage', e => {
        const msg = e?.message;
        if (typeof msg !== 'string' || !msg.startsWith(fileRequestPrefix)) return;
        let request;
        try { request = JSON.parse(msg.slice(fileRequestPrefix.length)); } catch { return; }
        answerGuestFilePick(request).catch(err => console.warn('[NB Browser] File picker bridge failed:', err));
      });

      wv.addEventListener('loadstop', () => {
        try { wv.executeScript({ code: guestFileScript }); } catch { /* ignore */ }
      });

      // Open a URL in a new tab (inherits incognito state from the source tab).
      function _ctxOpenInNewTab(url) {
        const _ctxTabId = wv._nbTabId;
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const t = { id: nextTabId++, title: 'New Tab', url, favicon: '', incognito: _ctxTab?.incognito || false };
        tabs.push(t);
        switchToTab(t.id);
        navigate(url);
      }

      function _ctxSaveImageAs(ctx) {
        const src = ctx?.imgSrc || '';
        if (!src) return;
        let imageName = ctx.imgAlt;
        if (!imageName && !src.startsWith('data:image/')) {
          try { imageName = decodeURIComponent(new URL(src).pathname.split('/').pop()); }
          catch { imageName = ''; }
        }
        if (!/\.[a-z\d]{2,8}$/i.test(imageName || '')) {
          const extension = (() => {
            try { return new URL(src).pathname.split('.').pop().match(/^[a-z\d]{2,8}$/i)?.[0]; }
            catch { return null; }
          })();
          const dataExtension = /^data:image\/(jpeg|png|gif|webp|bmp|svg\+xml)(?:;|,)/i.exec(src)?.[1]
            ?.replace('jpeg', 'jpg').replace('svg+xml', 'svg');
          imageName = (imageName || 'image') + '.' + (extension || dataExtension || 'png');
        }
        saveDownloadViaDialog(
          src,
          imageName,
          'Save Image As',
          getImageRequestHeaders(wv, src, ctx.pageUrl)
        ).catch(error => {
          console.error('[NB Browser] Could not save image:', error);
          Notify.show({ title: 'Image save failed', body: error?.message || 'Could not save this image.', type: 'error', appName: 'Browser' });
        });
      }

      function _ctxOpenSourceInNewTab(sourceUrl, sourceText) {
        const sourceTabId = nextTabId++;
        const sourcePage = createEl('div', {
          className: 'browser-source-page',
          style: {
            position: 'absolute',
            inset: '0',
            zIndex: '2',
            overflow: 'auto',
            background: '#0b0f17',
            color: '#d8dee9',
            fontFamily: 'var(--font-mono, Consolas, monospace)',
            userSelect: 'text',
            webkitUserSelect: 'text',
            touchAction: 'auto',
            cursor: 'text',
          },
        });
        const sourceHeader = createEl('div', {
          textContent: sourceUrl,
          style: {
            position: 'sticky',
            top: '0',
            padding: '10px 16px',
            background: '#111827',
            borderBottom: '1px solid rgba(255,255,255,.12)',
            color: '#9aa7b8',
            font: '12px var(--font-ui, sans-serif)',
            overflowWrap: 'anywhere',
          },
        });
        const sourcePre = createEl('pre', {
          textContent: sourceText,
          style: {
            margin: '0',
            padding: '16px',
            font: '12px/1.55 var(--font-mono, Consolas, monospace)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            tabSize: '2',
            userSelect: 'text',
            webkitUserSelect: 'text',
            cursor: 'text',
          },
        });
        sourcePage.append(sourceHeader, sourcePre);
        tabSourcePages.set(sourceTabId, sourcePage);

        const sourceHost = new URL(sourceUrl).hostname;
        tabs.push({
          id: sourceTabId,
          title: 'Source: ' + sourceHost,
          url: 'view-source:' + sourceUrl,
          favicon: '',
          incognito: Boolean(tabs.find(t => t.id === wv._nbTabId)?.incognito),
        });
        switchToTab(sourceTabId);
      }

      // Best-effort clipboard write — try the async Clipboard API first,
      // fall back to the deprecated execCommand path for non-secure
      // contexts where navigator.clipboard is unavailable.
      function _ctxCopyText(text) {
        try {
          navigator.clipboard.writeText(text);
        } catch {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          } catch { /* ignore */ }
        }
      }

      function _ctxSavePageAs(webview, pageUrl) {
        const sourceTab = tabs.find(tab => tab.id === webview._nbTabId);
        let baseName = (sourceTab?.title || '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim();
        if (!baseName) {
          try { baseName = new URL(pageUrl).hostname; } catch { baseName = 'page'; }
        }
        baseName = baseName.slice(0, MAX_DL_NAME_LEN) || 'page';
        const filename = /\.html?$/i.test(baseName) ? baseName : baseName + '.html';
        const notifyResult = (message, type) => {
          if (message) {
            Notify.show({ title: type === 'success' ? 'Page saved' : 'Save page failed', body: message, type, appName: 'Browser' });
          }
        };

        SystemDialogs.save({ title: 'Save Page As', suggestedName: filename }).then(picked => {
          if (!picked) return;
          const savePath = picked.path;
          try {
            webview.executeScript({
              code: 'document.documentElement ? document.documentElement.outerHTML : null'
            }, results => {
              if (chrome.runtime?.lastError) {
                notifyResult('Could not read the page content: ' + chrome.runtime.lastError.message, 'error');
                return;
              }
              const html = Array.isArray(results) ? results[0] : null;
              if (typeof html !== 'string' || !html) {
                notifyResult('The page has no HTML content to save.', 'error');
                return;
              }
              let fs;
              try { fs = require('fs'); } catch (error) {
                notifyResult('Could not access the file system: ' + (error?.message || error), 'error');
                return;
              }
              const content = html.startsWith('<!doctype') || html.startsWith('<!DOCTYPE')
                ? html
                : '<!doctype html>\n' + html;
              fs.writeFile(savePath, content, 'utf8', error => {
                if (error) {
                  notifyResult('Could not write the file: ' + error.message, 'error');
                  return;
                }
                notifyResult(picked.name + ' was saved.', 'success');
              });
            });
          } catch (error) {
            notifyResult('Could not read the page content: ' + (error?.message || error), 'error');
          }
        }).catch(error => notifyResult('Save dialog failed: ' + (error?.message || error), 'error'));
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
          items.push({ label: 'Save Image As\u2026', action: () => _ctxSaveImageAs(ctx) });
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
        items.push({ label: 'Back',    action: () => { try { wv.back();    } catch { /* ignore */ } } });
        items.push({ label: 'Forward', action: () => { try { wv.forward(); } catch { /* ignore */ } } });
        items.push({ label: 'Reload',  action: () => { try { wv.reload();  } catch { /* ignore */ } } });
        items.push({ separator: true });
        if (pageUrl && /^https?:/i.test(pageUrl)) {
          items.push({ label: 'Copy Page URL', action: () => _ctxCopyText(pageUrl) });
        }
        items.push({ label: 'Save Page As\u2026', action: () => _ctxSavePageAs(wv, pageUrl) });
        items.push({ label: 'Print\u2026', action: () => {
          try { wv.executeScript({ code: 'window.print()' }); } catch { /* ignore */ }
        }});
        items.push({ separator: true });
        items.push({ label: 'View Page Source', action: () => {
          try {
            wv.executeScript({ code: '[location.href, document.documentElement ? document.documentElement.outerHTML : ""]' }, r => {
              const result = Array.isArray(r) ? r[0] : null;
              const url = result?.[0] || pageUrl;
              const sourceText = result?.[1];
              if (typeof sourceText !== 'string' || sourceText.length === 0) {
                Notify.show({
                  title: 'Browser',
                  body: 'Could not read the page source.',
                  type: 'error', appName: 'Browser'
                });
                return;
              }
              try {
                _ctxOpenSourceInNewTab(url, sourceText);
              } catch (err) {
                console.error('[NB Browser] Failed to open page source:', err);
                Notify.show({
                  title: 'Browser',
                  body: 'Could not open the page source.',
                  type: 'error', appName: 'Browser'
                });
              }
            });
          } catch (err) {
            console.error('[NB Browser] Failed to retrieve page source:', err);
            Notify.show({
              title: 'Browser',
              body: 'Could not retrieve the page source.',
              type: 'error', appName: 'Browser'
            });
          }
        }});
        items.push({ label: 'Inspect', action: () => {
          try { wv.showDevTools(true); } catch {
            try { nw.Window.get().showDevTools(); } catch { /* ignore */ }
          }
        }});

        return items;
      }

      // The guest reports right-clicks here, tagged with _CTX_MARKER so we
      // never mistake an ordinary page's own console.log for our signal.
      wv.addEventListener('consolemessage', (e) => {
        const msg = e?.message;
        if (typeof msg === 'string' && msg.startsWith(BROWSER_LOGIN_MARKER)) {
          try {
            const login = JSON.parse(msg.slice(BROWSER_LOGIN_MARKER.length));
            const guestUrl = typeof wv.getURL === 'function'
              ? wv.getURL()
              : tabs.find(item => item.id === wv._nbTabId)?.url || '';
            const reportedOrigin = new URL(login.origin);
            const pageOrigin = new URL(guestUrl).origin;
            if (!['http:', 'https:'].includes(reportedOrigin.protocol) || reportedOrigin.origin !== pageOrigin) return;
            const origin = reportedOrigin.origin;
            const sourceTab = tabs.find(item => item.id === wv._nbTabId);
            if (!getSetting('remember_passwords', true) || sourceTab?.incognito) {
              pendingLoginUsernames.delete(origin);
              return;
            }
            if (!login.password && typeof login.username === 'string' && login.username) {
              pendingLoginUsernames.set(origin, { username: login.username, capturedAt: Date.now() });
              return;
            }
            if (login.password && !login.username) {
              const pending = pendingLoginUsernames.get(origin);
              if (pending && Date.now() - pending.capturedAt < 15 * 60 * 1000) login.username = pending.username;
              pendingLoginUsernames.delete(origin);
            }
            offerSaveLogin(login, wv._nbTabId).catch(err => {
              console.error('[NB Browser] Password save prompt failed:', err);
            });
          } catch (err) {
            console.error('[NB Browser] Invalid login capture from page:', err);
          }
          return;
        }
        if (typeof msg === 'string' && msg.startsWith(BROWSER_BEHAVIOR_MARKER)) {
          const action = msg.slice(BROWSER_BEHAVIOR_MARKER.length);
          if (window.__NBOSP_BROWSER_QUICK_CONTROL_DEBUG__ === true &&
              (action === 'back' || action === 'forward')) {
            console.info('[NB Browser] Quick-control command reached the host:', action, { tabId });
          }
          if (action === 'back') {
            dispatchQuickControl('back', tabId, wv);
          } else if (action === 'forward') {
            dispatchQuickControl('forward', tabId, wv);
          } else if (action === 'scroll-down' && tabId === activeTabId && getSetting('fullscreen', false)) {
            setBrowserChromeHidden(true);
          } else if (action === 'scroll-up' && tabId === activeTabId) {
            if (getSetting('fullscreen', false)) setBrowserChromeHidden(false);
          } else if (action === 'reveal-chrome' && tabId === activeTabId && getSetting('fullscreen', false)) {
            setBrowserChromeHidden(false);
          } else if (action === 'chrome-pointer-away' && tabId === activeTabId && getSetting('fullscreen', false)) {
            scheduleBrowserChromeHide();
          }
          return;
        }
        if (typeof msg === 'string' && msg.startsWith(BROWSER_QUICK_DIAGNOSTIC_MARKER)) {
          if (window.__NBOSP_BROWSER_QUICK_CONTROL_DEBUG__ === true) {
            console.info('[NB Browser] Quick-control input diagnostic:', msg.slice(BROWSER_QUICK_DIAGNOSTIC_MARKER.length), { tabId });
          }
          return;
        }
        if (msg === _CTX_DISMISS_MARKER) {
          ContextMenu.hide();
          return;
        }
        if (msg === _CTX_SCROLL_MARKER) {
          ContextMenu.hide();
          return;
        }
        if (typeof msg !== 'string' || !msg.startsWith(_CTX_MARKER)) return;
        let ctx = null;
        try { ctx = JSON.parse(msg.slice(_CTX_MARKER.length)); } catch { return; }

        const _ctxTabId = wv._nbTabId;
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const pageUrl    = ctx.pageUrl || _ctxTab?.url || currentUrl || '';

        // Guest coords are relative to the guest viewport; translate into
        // host-page coords using where the <webview> box actually sits.
        const rect  = wv.getBoundingClientRect();
        const scaleX = ctx.viewportWidth > 0 ? rect.width / ctx.viewportWidth : 1;
        const scaleY = ctx.viewportHeight > 0 ? rect.height / ctx.viewportHeight : 1;
        const hostX = rect.left + (ctx.clientX || 0) * scaleX;
        const hostY = rect.top + (ctx.clientY || 0) * scaleY;

        ContextMenu.show(hostX, hostY, _buildWebviewMenu(ctx, pageUrl));
      });
    }

    async function clearWebviewData(types, title, body) {
      try {
        const supportedTypes = new Set(['appcache', 'cache', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'webSQL']);
        const unsupportedTypes = Object.keys(types).filter(type => types[type] && !supportedTypes.has(type));
        if (unsupportedTypes.length) throw new Error('Unsupported browser data type: ' + unsupportedTypes.join(', '));
        const dataTypes = Object.fromEntries(Object.entries(types).filter(([type, enabled]) => enabled && supportedTypes.has(type)));
        if (!Object.keys(dataTypes).length) throw new Error('No supported browser data types were requested');

        const partitions = [...new Set([
          BROWSER_PARTITION,
          ...[...tabWebviews.values()].map(wv => wv.getAttribute('partition')).filter(Boolean)
        ])];
        const sandboxId = 'sandbox_browser_clear_' + require('crypto').randomUUID();
        let registered = false;
        try {
          const registerResponse = await fetch('/api/apps/serve/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sandboxId,
              files: { 'index.html': Buffer.from('<!doctype html><html><body></body></html>').toString('base64') }
            })
          });
          if (!registerResponse.ok) throw new Error('Could not prepare the browser-data clearing page (' + registerResponse.status + ')');
          registered = true;
          const registration = await registerResponse.json();
          if (typeof registration.baseUrl !== 'string') throw new Error('The browser-data clearing page returned no URL');
          const primerUrl = new URL(registration.baseUrl + '/index.html', window.location.origin).href;

          const results = await Promise.allSettled(partitions.map(partition => new Promise((resolve, reject) => {
            const wv = document.createElement('webview');
            wv.setAttribute('partition', partition);
            wv.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;z-index:-1;';
            let finished = false;
            let clearTimer = null;
            const loadTimer = setTimeout(() => finish(new Error('Timed out while preparing browser data storage')), 20000);
            const finish = error => {
              if (finished) return;
              finished = true;
              clearTimeout(loadTimer);
              clearTimeout(clearTimer);
              wv.remove();
              if (error) reject(error);
              else resolve();
            };
            wv.addEventListener('loadstop', () => {
              if (clearTimer || finished) return;
              clearTimer = setTimeout(() => finish(new Error('Timed out while clearing browser data')), 15000);
              try {
                wv.clearData({}, dataTypes, () => {
                  const error = globalThis.chrome?.runtime?.lastError;
                  if (error) finish(new Error(error.message || 'Chromium could not clear browser data'));
                  else finish();
                });
              } catch (err) {
                finish(err);
              }
            });
            wv.addEventListener('loadabort', event => {
              finish(new Error('Could not load browser-data clearing page: ' + (event.reason || 'navigation aborted')));
            });
            wv.addEventListener('loaderror', event => {
              finish(new Error('Could not load browser-data clearing page: ' + (event.errorDescription || 'navigation failed')));
            });
            viewport.appendChild(wv);
            wv.src = primerUrl;
          })));
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        } finally {
          if (registered) {
            try {
              const unregisterResponse = await fetch('/api/apps/serve/unregister/' + encodeURIComponent(sandboxId), { method: 'DELETE' });
              if (!unregisterResponse.ok) {
                console.error('[NB Browser] Could not unregister temporary data-clearing page:', unregisterResponse.status);
              }
            } catch (err) {
              console.error('[NB Browser] Could not unregister temporary data-clearing page:', err);
            }
          }
        }
        Notify.show({ title, body, type: 'success', appName: 'Browser' });
      } catch (err) {
        console.error('[NB Browser] Failed to clear webview data:', err);
        Notify.show({
          title: 'Could not clear browser data',
          body: err.message || 'Chromium did not confirm that the requested data was cleared.',
          type: 'error', appName: 'Browser'
        });
      }
    }

    const showWebviewForTab = (tabId) => showViewForTab(tabId);

    // Settings page — built entirely via DOM APIs (no template literals
    // with user-controlled content). Re-renders on category switch.
    function renderSettingsPage(activeCategory) {
      const settingsTab = activeTab();
      activeCategory = activeCategory || settingsTab?.settingsCategory || 'general';
      if (settingsTab?.url === 'browser://settings') {
        settingsTab.settingsCategory = activeCategory;
      }
      updateUrlIcon('browser://settings');
      setBrowserChromeHidden(false);
      const eng = getSetting('searchEngine', 'brave');
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      requestAnimationFrame(() => {
        for (const [, wv] of tabWebviews) wv.style.visibility = 'hidden';
      });
      const old = viewport.querySelector('.browser-settings-page');
      if (old) old.remove();

      const page = createEl('div', { className: 'browser-settings-page' });
      page.dataset.category = activeCategory;
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

      function mkSelect(key, def, options, onChange) {
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
        sel.addEventListener('change', () => {
          setBPref(key, sel.value);
          onChange?.(sel.value);
        });
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

      function mkSliderRow(label, key, def, min, max, suffix, onChange) {
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
          onChange?.(Number(slider.value));
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
        btn.addEventListener('click', () => {
          if (settingsTab) settingsTab.settingsScrollTop = 0;
          renderSettingsPage(id);
        });
        sidebar.appendChild(btn);
      }

      const panelEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px 32px;' });
      panelEl.dataset.settingsPanel = 'true';
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
        panelInner.appendChild(mkRow('Autofill saved logins', 'Fill saved credentials for the current site after unlocking the password vault',
          mkToggle('autofill_enabled', true, enabled => {
            if (enabled && passwordVaultEntries) for (const wv of tabWebviews.values()) fillSavedLogin(wv);
          })));

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
        panelTitle('Privacy & Security', 'Control cookies, passwords, location, camera/microphone and browsing data.');
        panelInner.appendChild(mkRow('Show security warnings', 'Show a visible “Not secure” label for HTTP pages',
          mkToggle('show_security_warnings', true, () => updateUrlIcon(currentUrl))));

        panelInner.appendChild(mkSubHdr('Cookies'));
        panelInner.appendChild(mkRow('Accept cookies', 'Allow sites to save cookies. Disabling clears existing cookies and blocks new ones via webRequest',
          mkToggle('accept_cookies', true, (v) => {
            if (!v) clearWebviewData({ cookies: true }, 'Cookies blocked', 'Existing cookies cleared. New cookies will be blocked.');
          })));
        panelInner.appendChild(mkRow('Clear cookies', '', mkClearBtn('Clear Cookies', () => clearWebviewData({ cookies: true }, 'Cookies cleared', 'All cookies have been deleted.'))));

        panelInner.appendChild(mkSubHdr('Form Data & Site Storage'));
        panelInner.appendChild(mkRow('Clear form and site data', 'Clear website storage. NW.js does not expose Chromium’s separate form-autocomplete history.',
          mkClearBtn('Clear Form & Site Data', () => clearWebviewData(
            { fileSystems: true, indexedDB: true, localStorage: true, webSQL: true },
            'Site data cleared', 'Supported website storage was cleared. Chromium form-autocomplete history is not exposed by this webview.'
          ))));

        panelInner.appendChild(mkSubHdr('Location'));
        panelInner.appendChild(mkRow('Enable location', 'Ask before allowing websites to use your location. Your choice lasts until Browser closes.',
          mkToggle('enable_geolocation', false, enabled => {
            clearSitePermissionDecisions('geolocation');
            updateGeolocationAccess(enabled);
            if (enabled) Notify.show({ title: 'Location enabled', body: 'Open pages were reloaded to apply the location policy.', type: 'info', appName: 'Browser' });
            else Notify.show({ title: 'Location blocked', body: 'Open sites were reloaded to stop active geolocation requests. Sites may still estimate your area from your IP address.', type: 'success', appName: 'Browser' });
          })));
        panelInner.appendChild(mkRow('Enable camera & microphone', 'Ask before allowing websites to use your camera and microphone. Changing this reloads open pages.',
          mkToggle('enable_media', false, () => {
            clearSitePermissionDecisions('media');
            updateMediaAccess();
          })));
        panelInner.appendChild(mkRow('Block location requests', 'Immediately block future location requests from all sites',
          mkClearBtn('Block Location', () => {
            saveSetting('enable_geolocation', false);
            clearSitePermissionDecisions('geolocation');
            updateGeolocationAccess(false);
            renderSettingsPage('privacy');
            Notify.show({ title: 'Location blocked', body: 'Open sites were reloaded to stop active geolocation requests. Sites may still estimate your area from your IP address.', type: 'success', appName: 'Browser' });
          })));

        panelInner.appendChild(mkSubHdr('Passwords'));
        panelInner.appendChild(mkRow('Remember passwords', 'Ask before saving logins in the encrypted, master-password-protected vault',
          mkToggle('remember_passwords', true)));
        panelInner.appendChild(mkRow('Password vault', 'Unlock, inspect, and delete saved logins',
          mkClearBtn('Manage Passwords', showPasswordManager)));
        panelInner.appendChild(mkRow('Clear saved passwords', 'Permanently remove saved logins from the encrypted Browser password vault',
          mkClearBtn('Clear Passwords', async () => {
            try {
              await clearPasswordVault();
              Notify.show({ title: 'Passwords cleared', body: 'Saved logins in the encrypted Browser vault were removed.', type: 'success', appName: 'Browser' });
            } catch (err) {
              console.error('[NB Browser] Failed to clear passwords:', err);
              Notify.show({ title: 'Passwords not cleared', body: err.message, type: 'error', appName: 'Browser' });
            }
          })));

        panelInner.appendChild(mkSubHdr('Browsing Data'));
        const dataRow = createEl('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;padding:12px 0;' });
        dataRow.append(
          mkClearBtn('Clear Cache', () => clearWebviewData({ cache: true, appcache: true }, 'Cache cleared', 'Cached data has been deleted.')),
          mkClearBtn('Clear History', () => {
            try {
              localStorage.removeItem(HX_KEY);
              _historyCache = [];
              Notify.show({ title: 'History cleared', body: 'Browsing history has been deleted.', type: 'success', appName: 'Browser' });
            } catch (err) {
              console.error('[NB Browser] Failed to clear history:', err);
              Notify.show({ title: 'History not cleared', body: err.message, type: 'error', appName: 'Browser' });
            }
          }),
          mkClearBtn('Clear Bookmarks', () => {
            try {
              localStorage.removeItem(BK_KEY);
              _bookmarksCache = [];
              refreshBookmarkSet();
              Notify.show({ title: 'Bookmarks cleared', body: 'All bookmarks have been deleted.', type: 'success', appName: 'Browser' });
            } catch (err) {
              console.error('[NB Browser] Failed to clear bookmarks:', err);
              Notify.show({ title: 'Bookmarks not cleared', body: err.message, type: 'error', appName: 'Browser' });
            }
          })
        );
        panelInner.appendChild(dataRow);

      } else if (activeCategory === 'content') {
        panelTitle('Content', 'Control how web pages are loaded and displayed.');
        panelInner.appendChild(mkRow('Block pop-up windows', 'Prevent sites from opening new windows', mkToggle('block_popup_windows', true)));
        panelInner.appendChild(mkRow('Open links in background', 'New tabs open without switching to them', mkToggle('open_in_background', false)));
        panelInner.appendChild(mkRow('Default zoom', 'Initial page zoom for new tabs', mkSelect('default_zoom', 'MEDIUM', [['FAR', 'Far (75%)'], ['MEDIUM', 'Medium (100%)'], ['CLOSE', 'Close (125%)']], value => {
          const zoomMap = { FAR: 0.75, MEDIUM: 1, CLOSE: 1.25 };
          for (const [tabId, wv] of tabWebviews) {
            if (!tabZoom.has(tabId)) {
              try { wv.setZoom(zoomMap[value] || 1); } catch (err) { console.warn('[NB Browser] Could not update default zoom:', err); }
            }
          }
        })));

      } else if (activeCategory === 'bandwidth') {
        panelTitle('Bandwidth', 'Manage how much data the browser downloads.');
        panelInner.appendChild(mkRow('Load images and media', 'Allow image, audio, and video requests from web pages', mkToggle('load_images', true)));
        panelInner.appendChild(mkRow('Preload next page', 'Prefetch same-origin pages explicitly marked as the next page',
          mkSelect('preload_when', 'NEVER', [['ALWAYS', 'Always'], ['NEVER', 'Never']], () => {
            for (const wv of tabWebviews.values()) applyGuestBrowserFeatures(wv);
          })));
        panelInner.appendChild(mkRow('Link prefetch', 'Prefetch a same-origin link when hovered. Always may use extra data.',
          mkSelect('link_prefetch_when', 'NEVER', [['ALWAYS', 'Always'], ['NEVER', 'Never']], () => {
            for (const wv of tabWebviews.values()) applyGuestBrowserFeatures(wv);
          })));

      } else if (activeCategory === 'accessibility') {
        panelTitle('Accessibility', 'Adjust display and interaction settings.');
        panelInner.appendChild(mkRow('Inverted colours', 'Invert page colours while keeping images and video natural', mkToggle('inverted', false, () => {
          for (const wv of tabWebviews.values()) applyPageAccessibility(wv);
        })));
        panelInner.appendChild(mkSliderRow('Text zoom', 'text_zoom', 10, 1, 30, '0%', () => {
          for (const wv of tabWebviews.values()) applyPageAccessibility(wv);
        }));
        panelInner.appendChild(mkSliderRow('Minimum font size', 'min_font_size', 0, 0, 32, 'px', () => {
          for (const wv of tabWebviews.values()) applyPageAccessibility(wv);
        }));

      } else if (activeCategory === 'labs') {
        panelTitle('Labs', 'Experimental features — may be unstable.');
        panelInner.appendChild(mkRow('Quick controls', 'Drag inward from a page edge or swipe horizontally on your touchpad to go back or forward', mkToggle('enable_quick_controls', false, () => {
          for (const wv of tabWebviews.values()) applyGuestBrowserFeatures(wv);
        })));
        panelInner.appendChild(mkRow('Fullscreen mode', 'Hide controls on websites; reveal them by scrolling up or moving to the top edge, then move away to hide them again', mkToggle('fullscreen', false, enabled => {
          if (enabled) closeFindBar();
          setBrowserChromeHidden(enabled && getSetting('fullscreen', false));
          for (const wv of tabWebviews.values()) applyGuestBrowserFeatures(wv);
        })));

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
            clearTimeout(_settingsSaveTimer);
            _settingsSaveTimer = null;
            try {
              if (typeof window !== 'undefined' && window.NovaAppConfig) {
                window.NovaAppConfig.remove('com.nbosp.browser', 'settings', { legacyKey: ST_KEY });
              } else {
                localStorage.removeItem(ST_KEY);
              }
              _settingsCache = null;
            } catch (err) {
              console.error('[NB Browser] Failed to reset settings:', err);
              Notify.show({ title: 'Settings not reset', body: err.message, type: 'error', appName: 'Browser' });
              return;
            }
            _settingsCache = {};
            updateGeolocationAccess(false);
            setBrowserChromeHidden(false);
            for (const wv of tabWebviews.values()) {
              applyPageAccessibility(wv);
              applyGuestBrowserFeatures(wv);
              try { wv.setZoomMode('per-origin'); }
              catch (err) { console.warn('[NB Browser] Could not reset page zoom mode:', err); }
            }
            updateUrlIcon(currentUrl);
            renderSettingsPage('general');
            Notify.show({ title: 'Settings reset', body: 'All browser settings restored to defaults.', type: 'success', appName: 'Browser' });
          });
        });
        panelInner.appendChild(resetBtn);
      }

      panelEl.appendChild(panelInner);
      page.append(sidebar, panelEl);
      viewport.appendChild(page);
      if (settingsTab?.id === activeTabId && settingsTab.url === 'browser://settings') {
        requestAnimationFrame(() => {
          if (page.isConnected) panelEl.scrollTop = settingsTab.settingsScrollTop || 0;
        });
      }
    }

    // Local-address guard — blocks navigation to RFC-1918 / loopback /
    // link-local hosts to prevent SSRF-style attacks from guest content.
    // Memoised: hostname → boolean so repeated checks are O(1).
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

    // Path-traversal guard — validates that filePath resolves inside basePath.
    // Returns the resolved path on success, null on traversal attempt.
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

    // Navigate the active tab to a URL. Handles all URL schemes the browser
    // supports: browser://, vault:, http/https, plus search-query fallback
    // for inputs that aren't URLs.
    function navigate(rawUrl) {
      if (!rawUrl) return;
      let url = rawUrl.trim();
      const isViewSource = /^view-source:/i.test(url);
      const addressToCheck = isViewSource ? url.slice('view-source:'.length) : url;
      // Canonicalize: strip ALL control chars before scheme checks.
      // Chromium strips \x09, \x0a, \x0d internally; mirror that here so
      // a "java\nscript:" URL can't sneak past the scheme blocklist.
      const _canonicalUrl = addressToCheck.toLowerCase()
        .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
        .trim();
      if (/^(javascript|data|vbscript|about):/i.test(_canonicalUrl)) return;
      if (isViewSource && !/^https?:\/\//i.test(addressToCheck)) {
        Notify.show({
          title: 'Browser',
          body: 'Page source is only available for HTTP and HTTPS pages.',
          type: 'error', appName: 'Browser'
        });
        return;
      }

      if (isLocalAddress(addressToCheck)) {
        Notify.show({
          title: 'Browser',
          body: 'Navigation to local or private network addresses is not allowed.',
          type: 'error', appName: 'Browser'
        });
        return;
      }

      const previousSourcePage = tabSourcePages.get(activeTabId);
      if (previousSourcePage) {
        previousSourcePage.remove();
        tabSourcePages.delete(activeTabId);
      }

      // browser://settings — internal page, no network fetch.
      if (url === 'browser://settings') {
        urlBar.value = 'browser://settings';
        currentUrl = 'browser://settings';
        updateUrlIcon(url);
        setBrowserChromeHidden(false);
        const activeT = activeTab();
        if (activeT) {
          activeT.url = url;
          activeT.title = 'Settings';
          activeT.favicon = '';
        }
        renderTabs();
        renderSettingsPage();
        return;
      }

      const settingsPage = viewport.querySelector('.browser-settings-page');
      if (settingsPage) settingsPage.remove();

      // vault:// URL handling — open a file from the OS virtual filesystem.
      if (url.startsWith('vault:')) {
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
          const activeT = activeTab();
          if (activeT) { activeT.url = url; activeT.title = targetNode.name; }
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
            // Write sibling files alongside the target so relative resource
            // references inside the HTML resolve correctly.
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
            // Fallback: use a blob URL instead of file:// to avoid sandbox issues.
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

      // Not a URL and not a known scheme — treat as a search query unless
      // it looks like a domain (has a dot, no spaces).
      if (!isViewSource && !url.match(/^https?:\/\//i) && !url.startsWith('blob:') && !url.startsWith('file://') && !url.startsWith('data:')) {
        url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : getSearchUrl(url);
      }

      // External navigation is a core built-in Browser capability; third-party apps
      // remain subject to the normal net:external permission controls.

      urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
      const activeT = activeTab();
      if (activeT) {
        activeT.url = url;
        try { activeT.title = new URL(url).hostname; } catch { /* ignore */ }
      }
      setBrowserChromeHidden(getSetting('fullscreen', false));
      renderTabs();
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      const oldNotice = viewport.querySelector(`.browser-iframe-blocked[data-tab="${activeTabId}"]`);
      if (oldNotice) oldNotice.remove();
      const mode = isViewSource ? 'webview' : getTabMode(activeTabId);
      if (mode === 'iframe') {
        const ifr = getOrCreateIframe(activeTabId);
        if (!ifr.parentNode) viewport.appendChild(ifr);
        showViewForTab(activeTabId);
        // Server-side embed check BEFORE setting src. If the site blocks
        // framing (XFO / CSP frame-ancestors), keep the iframe hidden and
        // show our custom notice instead of letting Chromium render
        // "refused to connect".
        ifr.style.visibility = 'hidden';
        ifr.style.pointerEvents = 'none';
        // Abort any previous in-flight navigation by resetting src.
        ifr.setAttribute('src', 'about:blank');
        checkFrameEmbeddable(activeTabId, url).then(result => {
          // Stale? Another navigation / mode switch superseded this tab.
          if (result === null) return;
          if (getTabMode(activeTabId) !== 'iframe') return;
          const curTab = activeTab();
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

    // Omnibox dropdown — appears below the URL bar with bookmark/history
    // matches as the user types.
    const omniDrop = createEl('div', { className: 'omnibox-dropdown' });
    omniDrop.setAttribute('role', 'listbox');
    container.appendChild(omniDrop);

    let omniItems = [];
    let omniIdx = -1;
    let omniTimer = null;
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
        // mousedown (not click) so the URL bar doesn't lose focus before
        // we can read which suggestion was picked.
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

    async function omniQuery(raw) {
      const q = raw.trim();
      if (!q) { omniClose(); return; }

      // Capture this query's generation; any newer query (or omniClose)
      // bumps omniGen, so a stale fetch result will bail before rendering.
      const gen = (++omniGen);

      // Local sources — instant. Filters run on the cached arrays so no
      // localStorage reads happen on every keystroke.
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
    }

    // URL bar events
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

    // Clean up omnibox timer on app teardown.
    state.cleanups.push(() => clearTimeout(omniTimer));

    // Global keyboard shortcuts
    const _onBrowserKeydown = e => {
      if (e.key === 'F12') {
        e.preventDefault();
        try { nw.Window.get().showDevTools(); } catch { /* ignore */ }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'J') {
        e.preventDefault();
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.showDevTools(true); } catch { /* ignore */ }
      }
    };
    document.addEventListener('keydown', _onBrowserKeydown);
    state.cleanups.push(() => document.removeEventListener('keydown', _onBrowserKeydown));

    // Navigation button handlers
    backBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.back(); } catch { /* ignore */ }
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.back(); } catch { /* ignore */ }
      }
    });
    fwdBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.forward(); } catch { /* ignore */ }
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.forward(); } catch { /* ignore */ }
      }
    });
    refreshBtn.addEventListener('click', () => {
      const _mode = getTabMode(activeTabId);
      if (_mode === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch { const _s = ifr.src; ifr.src = ''; ifr.src = _s; }
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.reload(); } catch { /* ignore */ }
        else if (currentUrl) navigate(currentUrl);
      }
    });

    // Open HTML file from vault — triggered when the browser is launched
    // with options.fileId (e.g. double-clicking an HTML file in Files app).
    if (options?.fileId) {
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
          // Write sibling files alongside the target so relative resource
          // references inside the HTML resolve correctly.
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
          // Fallback: blob URL when the file:// approach fails (e.g. sandbox
          // restrictions). Uses the already-decoded htmlContent string.
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

    // Open URL passed from OS.openUrl() — launched with options.url.
    if (options?.url) {
      renderTabs();
      setBrowserChromeHidden(getSetting('fullscreen', false));
      navigate(options.url);
      return;
    }

    // Initial render
    renderTabs();
    setBrowserChromeHidden(getSetting('fullscreen', false));
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
})();
