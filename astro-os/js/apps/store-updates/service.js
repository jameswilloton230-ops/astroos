(() => {
  'use strict';

  const CATALOG_URL = 'https://novabyteteam.github.io/novabyte-os/apps.json';
  const CATALOG_FALLBACK_URL = 'https://raw.githubusercontent.com/AstroOSTeam/novabyte-os/main/src/apps.json';
  const INSTALLED_APPS_KEY = 'nova_installed_apps';
  const SETTINGS_KEY = 'nova_store_update_interval_minutes';
  const NOTIFIED_KEY = 'nova_store_update_notified';
  const SETTINGS_EVENT = 'nova-store-update-settings-changed';
  const DEFAULT_INTERVAL_MINUTES = 60;
  const ALLOWED_INTERVALS = new Set([0, 15, 30, 60, 120, 360, 720, 1440]);

  function parseVersion(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^[v=]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return null;
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4] ? match[4].split('.') : null,
    };
  }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;

    for (let index = 0; index < a.core.length; index++) {
      if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
    }
    if (!a.prerelease || !b.prerelease) {
      if (a.prerelease === b.prerelease) return 0;
      return a.prerelease ? -1 : 1;
    }
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
      if (a.prerelease[index] === undefined) return -1;
      if (b.prerelease[index] === undefined) return 1;
      if (a.prerelease[index] === b.prerelease[index]) continue;
      const aNumeric = /^\d+$/.test(a.prerelease[index]);
      const bNumeric = /^\d+$/.test(b.prerelease[index]);
      if (aNumeric && bNumeric) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
      return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
    }
    return 0;
  }

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.warn(`[StoreUpdateService] Could not read ${key}:`, error);
      return [];
    }
  }

  // The installed-apps inventory is registry-backed (HKNS/apps/installed);
  // the localStorage key is only the pre-registry fallback.
  function readInstalledApps() {
    if (typeof window !== 'undefined') {
      if (window.RegistrySystemState?.installedApps) {
        try { return window.RegistrySystemState.installedApps() || []; } catch (_) { /* fall through */ }
      }
      if (window.NovaAppPackageStore?.loadRegistry) {
        try { return window.NovaAppPackageStore.loadRegistry() || []; } catch (_) { /* fall through */ }
      }
    }
    return readArray(INSTALLED_APPS_KEY);
  }

  function getIntervalMinutes() {
    // Registry-backed (HKNS/apps/store/updateIntervalMinutes); the legacy
    // localStorage key is the pre-registry fallback.
    if (typeof window !== 'undefined' && window.RegistrySystemState?.storeUpdateInterval) {
      try {
        const fromRegistry = window.RegistrySystemState.storeUpdateInterval();
        if (fromRegistry !== null && ALLOWED_INTERVALS.has(fromRegistry)) return fromRegistry;
      } catch (_) { /* fall through to legacy */ }
    }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw === null) return DEFAULT_INTERVAL_MINUTES;
      const value = Number(raw);
      return ALLOWED_INTERVALS.has(value) ? value : DEFAULT_INTERVAL_MINUTES;
    } catch (error) {
      console.warn('[StoreUpdateService] Could not read update interval:', error);
      return DEFAULT_INTERVAL_MINUTES;
    }
  }

  function setIntervalMinutes(value) {
    const minutes = Number(value);
    if (!ALLOWED_INTERVALS.has(minutes)) {
      throw new RangeError('Update interval must be one of the available minute values.');
    }
    const inRegistry = typeof window !== 'undefined' && window.RegistrySystemState?.setStoreUpdateInterval;
    if (inRegistry) {
      window.RegistrySystemState.setStoreUpdateInterval(minutes);
    } else {
      localStorage.setItem(SETTINGS_KEY, String(minutes));
    }
    window.dispatchEvent(new Event(SETTINGS_EVENT));
    return minutes;
  }

  function getNotifiedVersions() {
    // Registry-first (HKNS/apps/store/lastNotifiedAt); the localStorage key
    // is the adoption source and the fail-soft fallback.
    if (typeof window !== 'undefined' && window.RegistrySystemState?.storeNotified) {
      try {
        const stored = window.RegistrySystemState.storeNotified();
        if (stored) return stored;
      } catch (_) { /* fall through */ }
    }
    try {
      const value = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      console.warn('[StoreUpdateService] Could not read notification history:', error);
      return {};
    }
  }

  function getLatestReleaseNotes(app) {
    const currentNotes = [app.releaseNotes, app.release_notes]
      .find(notes => typeof notes === 'string' && notes.trim());
    if (currentNotes) return currentNotes.trim();

    const history = Array.isArray(app.versionHistory)
      ? app.versionHistory
      : Array.isArray(app.version_history) ? app.version_history : [];
    const currentRelease = history.find(entry => entry?.version === app.version);
    return typeof currentRelease?.notes === 'string' ? currentRelease.notes.trim() : '';
  }

  function notifyUpdate(app, installed) {
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') {
      console.warn('[StoreUpdateService] Notifications are unavailable; update notification will be retried.');
      return false;
    }
    const releaseNotes = getLatestReleaseNotes(app);
    Notify.show({
      title: `${app.name} needs updating`,
      body: `Version ${app.version} is available (installed: ${installed.version || 'unknown'}).${
        releaseNotes ? `\n\nWhat’s new in v${app.version}:\n${releaseNotes}` : ''
      }`,
      type: 'info',
      appName: 'Store',
      appId: 'com.astroos.store',
      category: 'apps',
      icon: 'package',
      action: 'open-store',
      actionLabel: 'Open store',
    });
    return true;
  }

  let started = false;
  let timer = null;
  let checking = null;

  async function checkNow() {
    if (checking) return checking;
    checking = (async () => {
      let response;
      try {
        response = await fetch(CATALOG_URL, { cache: 'no-store' });
      } catch (primaryError) {
        console.warn('[StoreUpdateService] GitHub Pages catalog unavailable; trying the raw GitHub mirror.', primaryError);
        response = await fetch(CATALOG_FALLBACK_URL, { cache: 'no-store' });
      }
      if (!response.ok) throw new Error(`App catalog request failed (${response.status})`);
      const catalog = await response.json();
      if (!Array.isArray(catalog)) throw new Error('App catalog must contain a list.');

      const catalogById = new Map(catalog
        .filter(app => app && typeof app.id === 'string' && typeof app.name === 'string')
        .map(app => [app.id, app]));
      const notified = getNotifiedVersions();
      const updates = [];
      let notificationHistoryChanged = false;

      for (const installed of readInstalledApps()) {
        if (!installed || typeof installed.id !== 'string' || installed.system === true) continue;
        const app = catalogById.get(installed.id);
        if (!app || compareVersions(app.version, installed.version) !== 1) continue;
        updates.push({
          id: app.id,
          name: app.name,
          installedVersion: installed.version,
          version: app.version,
          releaseNotes: getLatestReleaseNotes(app),
        });
        if (notified[app.id] === app.version || !notifyUpdate(app, installed)) continue;
        notified[app.id] = app.version;
        notificationHistoryChanged = true;
      }

      if (notificationHistoryChanged) {
        try {
          if (typeof window !== 'undefined' && window.RegistrySystemState?.setStoreNotified) {
            window.RegistrySystemState.setStoreNotified(notified);
          } else {
            localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
          }
        } catch (error) {
          console.error('[StoreUpdateService] Could not save update notification history:', error);
        }
      }
      return updates;
    })();
    try {
      return await checking;
    } finally {
      checking = null;
    }
  }

  function scheduleNextCheck() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const minutes = getIntervalMinutes();
    if (!started || minutes === 0) return;
    timer = setTimeout(() => {
      timer = null;
      checkNow()
        .catch(error => console.error('[StoreUpdateService] Update check failed:', error))
        .finally(scheduleNextCheck);
    }, minutes * 60 * 1000);
  }

  function start() {
    if (started) return;
    started = true;
    checkNow()
      .catch(error => console.error('[StoreUpdateService] Startup update check failed:', error))
      .finally(scheduleNextCheck);
  }

  function reschedule() {
    scheduleNextCheck();
  }

  window.addEventListener(SETTINGS_EVENT, reschedule);
  window.addEventListener('storage', event => {
    if (event.key === SETTINGS_KEY) reschedule();
  });
  window.StoreUpdateService = Object.freeze({
    start,
    checkNow,
    getIntervalMinutes,
    setIntervalMinutes,
  });

  if (typeof Boot !== 'undefined' && Boot?.hooks?.after) {
    Boot.hooks.after.push(start);
  }
})();
