import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const readWorkspaceFile = path => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  'utf8'
);

describe('built-in service boundaries', () => {
  it('declares a matching trusted entry for every bundled system service', () => {
    const appDirectory = fileURLToPath(new URL('../../../js/apps', import.meta.url));
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const sourceManifests = readdirSync(appDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        try {
          return [JSON.parse(readFileSync(path.join(appDirectory, entry.name, 'manifest.json'), 'utf8'))];
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      });

    for (const service of runtimeServices) {
      const manifest = sourceManifests.find(candidate => candidate.id === service.id);
      expect(manifest, `${service.id} must have a source manifest`).toBeDefined();
      expect(manifest.systemService, `${service.id} must declare systemService`).toBe(true);
      expect(manifest.unrestrictedEntry, `${service.id} trusted entry`).toBe(service.entry);
      expect(manifest.entry, `${service.id} app entry`).toBe(service.entry);
    }
  });

  it('lists each extracted service in both runtime manifests', () => {
    const serviceIds = [
      'com.astroos.service.app-loader-optimiser',
      'com.astroos.service.astro-system',
      'com.astroos.service.wallpaper',
      'com.astroos.service.lock-screen',
      'com.astroos.service.tray',
      'com.astroos.service.screenshots',
      'com.astroos.service.network-activity-log',
      'com.astroos.service.debug-overlay',
      'com.astroos.service.system-webview',
      'com.astroos.service.easteregg',
      'com.astroos.service.search-index',
      'com.astroos.service.media-store',
      'com.astroos.service.downloads-history',
    ];
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const packageManifest = JSON.parse(readWorkspaceFile('../../../js/apps/novaapp-manifest.json'));
    const systemEventsIndex = runtimeServices.findIndex(service => service.id === 'com.astroos.service.system-events');

    for (const id of serviceIds) {
      expect(runtimeServices).toContainEqual(expect.objectContaining({ id, entry: 'service.js' }));
      expect(runtimeServices.findIndex(service => service.id === id)).toBeLessThan(systemEventsIndex);
      expect(packageManifest).toContainEqual(expect.objectContaining({
        id,
        file: `js/apps/${id}.novaapp`,
      }));
    }
    expect(packageManifest.every(bundle => /^[a-f0-9]{64}$/.test(bundle.cacheKey || ''))).toBe(true);
  });

  it('stamps systemService on every service bundle so the loader accepts them in dev builds too', () => {
    // SystemServiceLoader.loadService() rejects a bundle entry without
    // systemService: true — the production build (build.mjs) stamps it from
    // each package manifest, and dev builds (build-apps.mjs) must match:
    // a dev manifest without the flags fails ALL 26 services silently.
    // Regression guard for the dev-build manifest generator.
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const packageManifest = JSON.parse(readWorkspaceFile('../../../js/apps/novaapp-manifest.json'));
    const byId = new Map(packageManifest.map(bundle => [bundle.id, bundle]));

    for (const service of runtimeServices) {
      const bundle = byId.get(service.id);
      expect(bundle, `${service.id} must be in the first-party manifest`).toBeDefined();
      expect(bundle.systemService, `${service.id} bundle must declare systemService: true`).toBe(true);
      expect(bundle.cacheKey, `${service.id} bundle must carry a cacheKey`).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('registers the AstroOS Setup app as a first-party system package', () => {
    // The first-boot wizard is a .novaapp, not lock-screen code: it must be
    // in the build manifest (with the system flags the reconcile pass
    // requires) and carry both entries — index.html for the sandboxed
    // fallback and app.js for the trusted host launch.
    const packageManifest = JSON.parse(readWorkspaceFile('../../../js/apps/novaapp-manifest.json'));
    expect(packageManifest).toContainEqual(expect.objectContaining({
      id: 'com.astroos.setup',
      file: 'js/apps/com.astroos.setup.novaapp',
    }));
    const setupManifest = JSON.parse(readWorkspaceFile('../../../js/apps/setup/manifest.json'));
    expect(setupManifest.system).toBe(true);
    expect(setupManifest.entry).toBe('index.html');
    expect(setupManifest.unrestrictedEntry).toBe('app.js');
  });

  it('preserves the system tray across launcher re-renders (log off → log back in)', () => {
    // Contract: #system-tray-root carries the tray service's listeners and
    // gets moved INSIDE the launcher's taskbar; re-running the launcher
    // (per-account mount) replaces the launcher DOM with innerHTML, so
    // boot.js must park the tray node on the body BEFORE that wipe and the
    // launcher must re-parent it (display:contents) afterwards. Regression
    // guard for the "tray items missing after log off + log back in" bug.
    const bootSource = readWorkspaceFile('../../../js/core/core/boot.js');
    const launcherSource = readWorkspaceFile('../../../js/apps/launcher/app.js');

    const parkAt = bootSource.indexOf("document.getElementById('system-tray-root')");
    const wipeAt = bootSource.indexOf('root.innerHTML = readPackageText(');
    expect(parkAt).toBeGreaterThan(-1);
    expect(wipeAt).toBeGreaterThan(parkAt); // park BEFORE the wipe
    expect(bootSource).toContain('root.contains(trayRoot)');
    expect(bootSource).toContain("trayRoot.style.display = 'none'");

    // The launcher re-parents the parked node into the fresh taskbar and
    // flips its display back to contents, and its settings listener is
    // wired once (never stacked across re-runs).
    expect(launcherSource).toContain("document.getElementById('system-tray-root')");
    expect(launcherSource).toContain("systemTray.style.display = 'contents'");
    expect(launcherSource).toContain('__launcherSettingsWired');
  });

  it('boots Astro System as the owner of Settings preferences', () => {
    const appId = 'com.astroos.service.astro-system';
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const packageManifest = JSON.parse(readWorkspaceFile('../../../js/apps/novaapp-manifest.json'));
    const settingsSource = readWorkspaceFile('../../../js/apps/settings/app.js');
    const shellDesktopSource = readWorkspaceFile('../../../js/apps/shell-ui/desktop.js');
    const shellWindowManagerSource = readWorkspaceFile('../../../js/apps/shell-ui/wm.js');
    const launcherSource = readWorkspaceFile('../../../js/apps/launcher/app.js');
    const traySource = readWorkspaceFile('../../../js/apps/tray/service.js');
    const sourceManifest = JSON.parse(readWorkspaceFile('../../../js/apps/astro-system/manifest.json'));

    expect(runtimeServices).toContainEqual({ id: appId, entry: 'service.js' });
    expect(packageManifest).toContainEqual(expect.objectContaining({
      id: appId,
      file: `js/apps/${appId}.novaapp`,
    }));
    expect(sourceManifest.name).toBe('Astro System');
    expect(sourceManifest.systemService).toBe(true);
    expect(settingsSource).toContain('window.AstroOSSystem?.settings');
    expect(settingsSource).not.toMatch(/OS\.settings\.(?:get|set)\(/);
    expect(shellDesktopSource).toContain('window.AstroOSSystem?.settings');
    expect(shellDesktopSource).not.toMatch(/OS\.settings(?:\.get|\._cache)/);
    expect(shellWindowManagerSource).toContain('window.AstroOSSystem?.settings');
    expect(shellWindowManagerSource).not.toContain('OS.settings.get(');
    expect(traySource).toContain('window.AstroOSSystem?.hardware?.power');
    expect(launcherSource).not.toContain('hardware?.power');
    expect(launcherSource).toContain('window.AstroOSSystem?.developer?.setRootAccess');
    expect(launcherSource).not.toMatch(/OS\.settings\.(?:get|set)\(['"](?:devMode|rootAccessEnabled)['"]/);
    expect(launcherSource).not.toContain("execFile('/usr/bin/astroos-power'");
    expect(traySource).not.toContain("execFile('/usr/bin/astroos-power'");
  });

  it('keeps core service dependencies ordered before boot', () => {
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const bootSource = readWorkspaceFile('../../../js/core/core/boot.js');
    const notificationsIndex = runtimeServices.findIndex(service =>
      service.id === 'com.astroos.service.notifications'
    );
    const systemEventsIndex = runtimeServices.findIndex(service =>
      service.id === 'com.astroos.service.system-events'
    );
    const defaultAppsIndex = runtimeServices.findIndex(service =>
      service.id === 'com.astroos.service.default-apps'
    );
    const lockScreenIndex = runtimeServices.findIndex(service =>
      service.id === 'com.astroos.service.lock-screen'
    );

    expect(runtimeServices[defaultAppsIndex]).toEqual({
      id: 'com.astroos.service.default-apps',
      entry: 'service.js',
    });
    expect(runtimeServices[notificationsIndex]).toEqual({
      id: 'com.astroos.service.notifications',
      entry: 'service.js',
    });
    expect(runtimeServices[systemEventsIndex]).toEqual({
      id: 'com.astroos.service.system-events',
      entry: 'service.js',
    });
    expect(defaultAppsIndex).toBeLessThan(systemEventsIndex);
    expect(notificationsIndex).toBeLessThan(systemEventsIndex);
    expect(runtimeServices[lockScreenIndex]).toEqual({
      id: 'com.astroos.service.lock-screen',
      entry: 'service.js',
    });
    expect(lockScreenIndex).toBeLessThan(systemEventsIndex);
    expect(bootSource).toContain('Boot.startServices()');
  });

  it('packages the Snake Easter egg as a trusted overlay service', () => {
    const runtimeServices = JSON.parse(readWorkspaceFile('../../../js/apps/system-service-manifest.json'));
    const packageManifest = JSON.parse(readWorkspaceFile('../../../js/apps/novaapp-manifest.json'));
    const sourceManifest = JSON.parse(readWorkspaceFile('../../../js/apps/easter-egg/manifest.json'));
    const serviceSource = readWorkspaceFile('../../../js/apps/easter-egg/service.js');
    const settingsSource = readWorkspaceFile('../../../js/apps/settings/app.js');
    const systemEventsSource = readWorkspaceFile('../../../js/apps/system-events/service.js');

    expect(sourceManifest.id).toBe('com.astroos.service.easteregg');
    expect(sourceManifest.systemService).toBe(true);
    expect(sourceManifest.headless).toBe(true);
    expect(runtimeServices).toContainEqual({ id: sourceManifest.id, entry: 'service.js' });
    expect(packageManifest).toContainEqual(expect.objectContaining({
      id: sourceManifest.id,
      file: `js/apps/${sourceManifest.id}.novaapp`,
    }));
    expect(packageManifest).not.toContainEqual(expect.objectContaining({ id: 'com.astroos.easter-egg' }));
    // AstroOS keeps its own About-page easter egg (Asteroid Dodger) inside
    // the Settings sandbox: a plain DOM overlay launched by
    // launchAsteroidGame(), never a window-manager window.
    expect(settingsSource).toContain('function launchAsteroidGame()');
    expect(settingsSource).not.toContain('WM.createWindow(\'com.astroos.easter-egg\')');
    expect(serviceSource).toContain('id: \'snake-game-overlay\'');
    expect(serviceSource).toContain('window.AstroOSEasterEgg = Object.freeze({ launch: launchSnakeGame });');
    expect(serviceSource).not.toContain('WM.createWindow');
    expect(systemEventsSource).not.toContain('launchSnakeGame');
  });

  it('applies preset and custom wallpapers through the wallpaper service', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/wallpaper/service.js');
    const wallpaperStyle = {};
    const desktopStyle = {};
    const elements = {
      wallpaper: { style: wallpaperStyle },
      desktop: { style: desktopStyle },
    };
    const context = {
      document: { getElementById: id => elements[id] || null },
      window: {},
    };
    runInNewContext(serviceSource, context);

    const service = context.window.WallpaperService;
    const settings = { wallpaperId: 'stock-teal', customWallpaper: null };
    const get = key => settings[key];

    expect(service.getPresets()).toHaveLength(8);
    expect(service.apply(get)).toBe(true);
    expect(wallpaperStyle.backgroundImage).toContain('linear-gradient');
    expect(desktopStyle.backgroundImage).toBe(wallpaperStyle.backgroundImage);

    settings.customWallpaper = 'data:image/png;base64,abc';
    expect(service.apply(get)).toBe(true);
    expect(wallpaperStyle.backgroundImage).toContain('data:image/png;base64,abc');
    expect(desktopStyle.backgroundSize).toBe('cover');
  });

  it('loads extracted services before System Events without global declaration collisions', () => {
    const document = {
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
    };
    const window = {
      addEventListener() {},
      removeEventListener() {},
    };
    const storage = new Map();
    const context = {
      window,
      document,
      localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      OS: {
        windows: new Map(),
        settings: { _cache: {}, defaults: {}, get: () => null, set() {} },
        events: { on() {}, emit() {} },
      },
      require: moduleName => {
        if (moduleName === 'fs') return {};
        if (moduleName === 'os') return {};
        if (moduleName === 'path') return { basename: value => value.split('/').pop() };
        throw new Error(`Unexpected module request: ${moduleName}`);
      },
      Notify: {
        loadPersisted() {},
        renderPanel() {},
        updateBadge() {},
        togglePanel() {},
      },
      EventLog: { log() {} },
      navigator: { getBattery: async () => null },
      throttleRAF: callback => callback,
      setInterval: () => 1,
      clearInterval() {},
      requestAnimationFrame() {},
      TextEncoder,
      TextDecoder,
      Uint8Array,
      atob,
      console,
    };
    const servicePaths = [
      '../../../js/apps/app-loader-optimiser/service.js',
      '../../../js/apps/astro-system/service.js',
      '../../../js/apps/wallpaper/service.js',
      '../../../js/apps/lock-screen/service.js',
      '../../../js/apps/tray/service.js',
      '../../../js/apps/screenshots/service.js',
      '../../../js/apps/network-activity-log/service.js',
      '../../../js/apps/debug-overlay/service.js',
      '../../../js/apps/search-index/service.js',
      '../../../js/apps/media-store/service.js',
      '../../../js/apps/downloads-history/service.js',
      '../../../js/apps/system-webview/service.js',
      '../../../js/apps/system-events/service.js',
    ];

    for (const servicePath of servicePaths) {
      runInNewContext(readWorkspaceFile(servicePath), context);
    }

    expect(window.WallpaperService).toBeDefined();
    expect(window.LockScreenService).toBeDefined();
    expect(window.TrayService).toBeDefined();
    expect(window.ScreenshotService).toBeDefined();
    expect(window.DebugOverlay).toBeDefined();
    expect(window.NetworkLog).toBeDefined();
    expect(window.SearchIndex).toBeDefined();
    expect(window.AstroOSMediaStore).toBeDefined();
    expect(window.Downloads).toBeDefined();
    expect(window.AppLoaderOptimizer).toBeDefined();
    expect(window.NovaSystemWebview).toBeDefined();
  });

  it('exposes indexed media metadata through the existing scoped filesystem permissions', () => {
    const sandboxSource = readWorkspaceFile('../../../js/platform/security/app-sandbox.js');
    expect(sandboxSource).toContain("'nova:media:query': handleMediaQuery");
    expect(sandboxSource).toContain("'nova:media:query': null");
    expect(sandboxSource).toContain("AppPermissionManager.isGranted('fs:metadata', app.id)");
    expect(sandboxSource).toContain('canReadMetadata(node, app.id, sandbox)');
    expect(sandboxSource).toContain("ipc('nova:media:query', options || {})");
  });

  it('keeps the network activity log bounded and observable outside the Browser app', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/network-activity-log/service.js');
    const window = {};
    runInNewContext(serviceSource, { window });

    const rendered = [];
    window.NetworkLog._renderFn = () => rendered.push(window.NetworkLog.entries.length);
    for (let i = 0; i < 501; i++) {
      window.NetworkLog.push({ url: `https://example.test/${i}` });
    }

    expect(window.NetworkLog.entries).toHaveLength(500);
    expect(window.NetworkLog.getAll()[0].url).toBe('https://example.test/500');
    expect(rendered).toHaveLength(501);
    window.NetworkLog.clear();
    expect(window.NetworkLog.getAll()).toHaveLength(0);
    expect(rendered.at(-1)).toBe(0);
  });

  it('provides reusable trigram indexes with short-query fallback and storage watchers', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/search-index/service.js');
    const values = new Map();
    const storageListeners = new Map();
    const window = {
      addEventListener: (type, listener) => storageListeners.set(type, listener),
    };
    const localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    runInNewContext(serviceSource, { window, localStorage, console });

    const items = [
      { name: 'AstroOS Search' },
      { name: 'Search Index' },
      { name: 'Calendar' },
    ];
    const index = window.SearchIndex.build(items, item => item.name);

    expect(window.SearchIndex.search(index, 'SEARCH', (item, query) =>
      item.name.toLowerCase().includes(query)
    )).toEqual(items.slice(0, 2));
    expect(window.SearchIndex.search(index, 'ca', (item, query) =>
      item.name.toLowerCase().includes(query)
    )).toEqual([items[2]]);

    const observed = [];
    const unsubscribe = window.SearchIndex.watchStorage(['nova_contacts'], key => observed.push(key));
    localStorage.setItem('nova_contacts', '[]');
    localStorage.setItem('other', 'value');
    storageListeners.get('storage')({ key: 'nova_contacts' });
    expect(observed).toEqual(['nova_contacts', 'nova_contacts']);
    unsubscribe();
    localStorage.setItem('nova_contacts', '[{}]');
    expect(observed).toHaveLength(2);
  });

  it('collects files recursively from the visible tree and app-data root', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/search-index/service.js');
    const window = { addEventListener() {} };
    const localStorage = { getItem: () => null, setItem() {} };
    runInNewContext(serviceSource, { window, localStorage, console });
    const tree = {
      rootId: '/home/user',
      specialFolders: { data: '/home/user/.local/appdata' },
      files: new Map(),
      listDir: id => ({
        '/home/user': [
          { id: '/home/user/Documents', name: 'Documents', type: 'folder' },
          { id: '/home/user/.cache', name: '.cache', type: 'folder' },
        ],
        '/home/user/Documents': [
          { id: '/home/user/Documents/notes.txt', name: 'notes.txt', type: 'file' },
        ],
        '/home/user/.local/appdata': [
          { id: '/home/user/.local/appdata/app.json', name: 'app.json', type: 'file' },
        ],
      })[id] || [],
    };

    expect(window.SearchIndex.collectFiles(tree).map(file => file.id)).toEqual([
      '/home/user/.local/appdata/app.json',
      '/home/user/Documents/notes.txt',
    ]);
  });

  it('owns download history mutations and notifies subscribers', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/downloads-history/service.js');
    const values = new Map();
    const storageListeners = new Map();
    const window = {
      addEventListener: (type, listener) => storageListeners.set(type, listener),
    };
    const localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    runInNewContext(serviceSource, {
      window,
      localStorage,
      crypto: { randomUUID: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })() },
      URL,
      chrome: {},
      Uint8Array,
      Date,
      console,
    });

    const changes = [];
    const unsubscribe = window.Downloads.subscribe((items, change) => changes.push([items, change]));
    const done = window.Downloads.add('report.pdf', 'https://example.test/report.pdf', 42, 'application/pdf');
    const active = window.Downloads.add('image.png', '', 0, 'image/png');
    expect(window.Downloads.getAll().map(item => item.name)).toEqual(['image.png', 'report.pdf']);
    expect(window.Downloads.setStatus(active.id, 'downloading', 5)).toBe(true);
    window.Downloads.add('temporary.zip', 'https://example.test/temporary.zip', 10, 'application/zip');
    expect(window.Downloads.remove(done.id)).toBe(true);
    expect(window.Downloads.clearCompleted()).toBe(true);
    expect(window.Downloads.getAll().map(item => item.id)).toEqual([active.id]);
    expect(changes.map(([, change]) => change)).toEqual(['add', 'add', 'status', 'add', 'remove', 'clear-completed']);

    storageListeners.get('storage')({ key: 'nova_downloads' });
    expect(changes.at(-1)[1]).toBe('storage');
    unsubscribe();
    window.Downloads.add('later.txt', '', 1, 'text/plain');
    expect(changes).toHaveLength(7);
  });

  it('saves native browser downloads and reflects their progress in Downloads', () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/downloads-history/service.js');
    const values = new Map();
    const listeners = { created: null, changed: null, filename: null };
    const event = key => ({
      addListener: listener => { listeners[key] = listener; },
    });
    const window = { addEventListener() {} };
    const chrome = {
      downloads: {
        onCreated: event('created'),
        onChanged: event('changed'),
        onDeterminingFilename: event('filename'),
      },
    };
    runInNewContext(readWorkspaceFile('../../../js/apps/downloads-history/service.js'), {
      window,
      localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      crypto: { randomUUID: () => 'download-1' },
      chrome,
      URL,
      Date,
      console,
    });

    const suggestion = {};
    listeners.filename({
      filename: '/home/astroos/Downloads/unsafe?.pdf',
      url: 'https://example.test/file',
    }, value => Object.assign(suggestion, value));
    expect(suggestion).toEqual({
      filename: 'unsafe_.pdf',
      conflictAction: 'uniquify',
    });

    listeners.created({
      id: 7,
      filename: '/home/astroos/Downloads/report.pdf',
      url: 'https://example.test/report.pdf',
      totalBytes: -1,
      mime: 'application/pdf',
      state: 'in_progress',
    });
    expect(window.Downloads.getAll()).toMatchObject([{
      name: 'report.pdf',
      url: 'https://example.test/report.pdf',
      mimeType: 'application/pdf',
      status: 'downloading',
    }]);

    listeners.changed({ bytesReceived: { current: 42 } }, 7);
    expect(window.Downloads.getAll()[0].size).toBe(42);
    listeners.changed({ state: { current: 'complete' }, totalBytes: { current: 42 } }, 7);
    expect(window.Downloads.getAll()[0]).toMatchObject({ status: 'done', size: 42 });
  });

  it('prefetches package bundles concurrently, reuses requests, and releases cached packages', async () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/app-loader-optimiser/service.js');
    const requests = new Map();
    const requestOptions = [];
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    const window = {};
    const context = {
      window,
      fetch: async (file, options) => {
        requests.set(file, (requests.get(file) || 0) + 1);
        requestOptions.push(options);
        activeRequests++;
        maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
        await Promise.resolve();
        activeRequests--;
        return { ok: true, json: async () => ({ file }) };
      },
      Date,
      Promise,
      Map,
      TypeError,
      Error,
    };
    runInNewContext(serviceSource, context);

    const bundles = [
      { id: 'com.astroos.shell-ui', file: 'shell.novaapp' },
      { id: 'com.astroos.service.app-loader-optimiser', file: 'optimizer.novaapp' },
      { id: 'com.astroos.app-a', file: 'app-a.novaapp' },
      { id: 'com.astroos.app-b', file: 'app-b.novaapp' },
      { id: 'com.astroos.service.a', file: 'service-a.novaapp' },
    ];
    const stats = await window.AppLoaderOptimizer.start(bundles);

    expect(stats.packages).toBe(4);
    expect(maximumConcurrentRequests).toBe(4);
    expect(requestOptions).toHaveLength(4);
    expect(requestOptions.every(options => options.cache === 'no-cache')).toBe(true);
    await window.AppLoaderOptimizer.getPackage('app-a.novaapp');
    expect(requests.get('app-a.novaapp')).toBe(1);
    window.AppLoaderOptimizer.clear();
    await window.AppLoaderOptimizer.getPackage('app-a.novaapp');
    expect(requests.get('app-a.novaapp')).toBe(2);
  });

  it('restores persisted packages after a full process restart when the server is unavailable', async () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/app-loader-optimiser/service.js');
    const records = new Map();
    let storeCreated = false;
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          const db = {
            objectStoreNames: { contains: () => storeCreated },
            createObjectStore() { storeCreated = true; },
            transaction() {
              let transaction;
              const store = {
                get: key => {
                  const result = {};
                  queueMicrotask(() => {
                    result.onsuccess?.({ target: { result: records.get(key) } });
                  });
                  return result;
                },
                put: value => {
                  records.set(value.file, value);
                  queueMicrotask(() => transaction.oncomplete?.());
                },
              };
              transaction = {
                objectStore: () => store,
                oncomplete: null,
                onerror: null,
                onabort: null,
              };
              return transaction;
            },
          };
          request.result = db;
          if (!storeCreated) request.onupgradeneeded?.({ target: { result: db } });
          request.onsuccess?.({ target: { result: db } });
        });
        return request;
      },
    };
    const pkg = { manifest: { id: 'com.astroos.app-a', version: '1.0.0' } };
    const cacheKey = 'stable-content-fingerprint';
    let firstFetches = 0;
    const firstWindow = {};
    runInNewContext(serviceSource, {
      window: firstWindow,
      indexedDB,
      fetch: async () => {
        firstFetches++;
        return { ok: true, json: async () => pkg };
      },
    });
    await firstWindow.AppLoaderOptimizer.getPackage('app-a.novaapp', cacheKey);
    expect(firstFetches).toBe(1);
    expect(records.get('app-a.novaapp').pkg).toEqual(pkg);

    const restartedWindow = {};
    runInNewContext(serviceSource, {
      window: restartedWindow,
      indexedDB,
      fetch: async () => { throw new Error('server unavailable'); },
    });
    await expect(restartedWindow.AppLoaderOptimizer.getPackage('app-a.novaapp', cacheKey))
      .resolves.toEqual(pkg);

    const changedWindow = {};
    let changedFetches = 0;
    runInNewContext(serviceSource, {
      window: changedWindow,
      indexedDB,
      fetch: async () => {
        changedFetches++;
        return { ok: true, json: async () => ({ manifest: { version: '2.0.0' } }) };
      },
    });
    await changedWindow.AppLoaderOptimizer.getPackage('app-a.novaapp', 'new-content-fingerprint');
    expect(changedFetches).toBe(1);

    const missingWindow = {};
    runInNewContext(serviceSource, {
      window: missingWindow,
      indexedDB,
      fetch: async () => ({ ok: false, status: 404 }),
    });
    await expect(missingWindow.AppLoaderOptimizer.getPackage('app-a.novaapp', cacheKey))
      .rejects.toMatchObject({ status: 404 });
  });

  it('uses the existing Scanner API for executable and active-content checks', async () => {
    const serviceSource = readWorkspaceFile('../../../js/apps/scanner/service.js');
    const context = {
      TextEncoder,
      TextDecoder,
      Uint8Array,
      atob,
      window: {},
    };
    runInNewContext(serviceSource, context);

    const scanner = context.window.Scanner;
    await expect(scanner.scanText('payload.exe', '')).resolves.toMatchObject({ safe: false });
    await expect(scanner.scanText('page.html', '<script>alert(1)</script>'))
      .resolves.toMatchObject({ safe: false });
    await expect(scanner.scanText('notes.txt', 'A normal plain-text note.'))
      .resolves.toMatchObject({ safe: true });
  });
});
