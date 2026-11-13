/**
 * Loads trusted system-service NovaApps into the OS page before the
 * OS boot sequence.
 */
(() => {
  'use strict';

  let loadPromise = null;
  const loadedServices = [];
  const APP_LOADER_OPTIMIZER_ID = 'com.astroos.service.app-loader-optimiser';

  function persistentPackageRequest(bundle, mode, callback) {
    return new Promise((resolve, reject) => {
      const openRequest = indexedDB.open('AstroOS_AppLoaderOptimizer', 1);
      openRequest.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('packages')) {
          db.createObjectStore('packages', { keyPath: 'file' });
        }
      };
      openRequest.onsuccess = event => {
        const db = event.target.result;
        const transaction = db.transaction('packages', mode);
        const request = callback(transaction.objectStore('packages'));
        let result;
        request.onsuccess = resultEvent => {
          result = resultEvent.target.result;
          if (mode !== 'readwrite') resolve(result);
        };
        request.onerror = resultEvent => reject(resultEvent.target.error);
        if (mode === 'readwrite') {
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = transaction.onerror = transactionEvent =>
            reject(transactionEvent.target.error);
        }
      };
      openRequest.onerror = event => reject(event.target.error);
    });
  }

  async function getBootstrapCachedPackage(bundle) {
    if (!bundle.cacheKey || typeof indexedDB === 'undefined') return null;
    try {
      const record = await persistentPackageRequest(bundle, 'readonly', store =>
        store.get(bundle.file)
      );
      return record?.cacheKey === bundle.cacheKey ? record.pkg : null;
    } catch (error) {
      console.warn('[SystemServiceLoader] Could not read optimizer package cache:', error);
      return null;
    }
  }

  async function persistBootstrapPackage(bundle, pkg) {
    if (!bundle.cacheKey || typeof indexedDB === 'undefined') return;
    try {
      await persistentPackageRequest(bundle, 'readwrite', store =>
        store.put({ file: bundle.file, cacheKey: bundle.cacheKey, pkg })
      );
    } catch (error) {
      console.warn('[SystemServiceLoader] Could not persist optimizer package cache:', error);
    }
  }

  async function getPackage(bundle, serviceId) {
    try {
      if (typeof window.AppLoaderOptimizer?.getPackage === 'function') {
        return await window.AppLoaderOptimizer.getPackage(bundle.file, bundle.cacheKey);
      }
      if (serviceId === APP_LOADER_OPTIMIZER_ID) {
        const cachedPackage = await getBootstrapCachedPackage(bundle);
        if (cachedPackage) return cachedPackage;
      }
      const response = await fetch(bundle.file, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${serviceId}: HTTP ${response.status}`);
      }
      const pkg = await response.json();
      if (serviceId === APP_LOADER_OPTIMIZER_ID) {
        await persistBootstrapPackage(bundle, pkg);
      }
      return pkg;
    } catch (error) {
      if (error?.status) {
        throw new Error(`Failed to fetch ${serviceId}: HTTP ${error.status}`, { cause: error });
      }
      throw error;
    }
  }

  function decodePackageFile(encoded) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function loadService(service, bundle) {
    if (!service || typeof service.id !== 'string' ||
        !bundle || bundle.id !== service.id || bundle.systemService !== true ||
        typeof bundle.file !== 'string') {
      throw new Error('Invalid entry in system-service manifest');
    }

    const pkg = await getPackage(bundle, service.id);
    const manifest = pkg?.manifest;
    const entry = manifest?.unrestrictedEntry;

    const scriptEntries = service.scripts ?? [entry];
    if (manifest?.id !== service.id || manifest?.system !== true ||
        manifest?.systemService !== true || entry !== service.entry ||
        !Array.isArray(scriptEntries) || scriptEntries.length === 0 ||
        scriptEntries[0] !== entry ||
        scriptEntries.some(scriptEntry =>
          typeof scriptEntry !== 'string' || typeof pkg.files?.[scriptEntry] !== 'string'
        )) {
      throw new Error(`Invalid system-service package: ${service.id}`);
    }

    const runtimeApp = {
      ...pkg,
      id: manifest.id,
      system: true,
      verified: true,
      signer: 'Astro System',
      source: 'system-bundle',
    };
    const result = await UnrestrictedGate.checkUnrestrictedApp(runtimeApp);
    if (!result.allowed) {
      throw new Error(`Trusted execution denied for ${service.id}: ${result.reason}`);
    }

    for (const scriptEntry of scriptEntries) {
      const script = document.createElement('script');
      script.dataset.novaSystemService = service.id;
      script.dataset.novaSystemServiceEntry = scriptEntry;
      script.textContent = decodePackageFile(pkg.files[scriptEntry]);
      let runtimeError = null;
      const onScriptError = event => {
        runtimeError = event.error || new Error(event.message || 'Unknown script error');
      };
      window.addEventListener('error', onScriptError, true);
      try {
        document.head.appendChild(script);
      } finally {
        window.removeEventListener('error', onScriptError, true);
        script.remove();
      }
      if (runtimeError) {
        throw new Error(`System service ${service.id} entry ${scriptEntry} failed during startup: ${runtimeError.message || runtimeError}`);
      }
    }
    const registeredService = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      icon: manifest.icon,
      permissions: manifest.permissions || [],
      optionalPermissions: manifest.optionalPermissions || [],
      manifest,
      system: true,
      verified: true,
      signer: 'Astro System',
      source: 'system-bundle',
      headlessSystemService: manifest.headless !== false,
    };
    if (typeof AppRegistry === 'undefined' ||
        typeof AppRegistry.registerSystemService !== 'function') {
      throw new Error('AppRegistry system-service support is unavailable');
    }
    AppRegistry.registerSystemService(registeredService);
    loadedServices.push(registeredService);
    console.info(`[SystemServiceLoader] Started ${service.id}`);
  }

  function showUnavailableServices(failures) {
    if (!failures.length) return;
    const banner = document.createElement('aside');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:flex-start;gap:12px;max-width:min(720px,calc(100vw - 32px));padding:12px 16px;border:1px solid #8b6b2e;border-radius:8px;background:#292316;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 4px 20px #0008';

    const message = document.createElement('span');
    message.textContent = `AstroOS started with ${failures.length} unavailable system service${failures.length === 1 ? '' : 's'}: ${failures.map(({ id }) => id).join(', ')}. See the console for details.`;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss system service warning');
    dismiss.addEventListener('click', () => banner.remove());
    banner.append(message, dismiss);
    document.body.appendChild(banner);
  }

  async function loadServices(services, bundlesById, bundles, failures) {
    for (const service of services) {
      try {
        await loadService(service, bundlesById.get(service?.id));
        if (service.id === APP_LOADER_OPTIMIZER_ID &&
            typeof window.AppLoaderOptimizer?.start === 'function') {
          window.AppLoaderOptimizer.start(bundles)
            .then(stats => console.info('[SystemServiceLoader] Package prefetch complete', stats))
            .catch(error => console.error('[SystemServiceLoader] Package prefetch failed:', error));
        }
      } catch (error) {
        const failure = { id: service?.id || '(invalid service entry)', error };
        failures.push(failure);
        console.error(`[SystemServiceLoader] Service unavailable: ${failure.id}`, error);
      }
    }
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const failures = [];
      try {
        const response = await fetch('js/apps/system-service-manifest.json', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to fetch system-service manifest: HTTP ${response.status}`);
        }
        const services = await response.json();
        if (!Array.isArray(services)) {
          throw new Error('System-service manifest must be an array');
        }
        const bundleResponse = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
        if (!bundleResponse.ok) {
          throw new Error(`Failed to fetch first-party app manifest: HTTP ${bundleResponse.status}`);
        }
        const bundles = await bundleResponse.json();
        if (!Array.isArray(bundles)) {
          throw new Error('First-party app manifest must be an array');
        }
        const bundlesById = new Map(bundles.map(bundle => [bundle?.id, bundle]));
        await loadServices(services, bundlesById, bundles, failures);
      } catch (error) {
        failures.push({ id: 'system-service-manifest', error });
        console.error('[SystemServiceLoader] Could not load service manifests:', error);
      }

      try {
        if (typeof window.boot === 'function') {
          await window.boot();
        } else {
          throw new Error('boot() is not defined');
        }
      } catch (error) {
        failures.push({ id: 'OS boot', error });
        console.error('[SystemServiceLoader] OS boot failed:', error);
      }

      showUnavailableServices(failures);
      return { failures: failures.map(({ id, error }) => ({ id, message: error?.message || String(error) })) };
    })();
    return loadPromise;
  }

  window.SystemServiceLoader = Object.freeze({
    load,
    unregisterService: id => {
      if (typeof AppRegistry === 'undefined' ||
          typeof AppRegistry.unregisterSystemService !== 'function') return false;
      const removed = AppRegistry.unregisterSystemService(id);
      if (!removed) return false;
      const index = loadedServices.findIndex(service => service.id === id);
      if (index !== -1) loadedServices.splice(index, 1);
      return true;
    },
    listLoadedServices: () => loadedServices.map(service => ({ ...service })),
  });

  load().catch(error => console.error('[SystemServiceLoader] Unexpected loader failure:', error));
})();
