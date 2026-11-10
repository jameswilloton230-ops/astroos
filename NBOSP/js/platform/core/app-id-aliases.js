(() => {
  'use strict';

  const aliases = Object.freeze({
    'com.nbosp.quill': 'com.nbosp.textedit',
    'com.nbosp.shell': 'com.nbosp.terminal',
    'com.nbosp.vault': 'com.nbosp.files',
    quill: 'textedit',
    shell: 'com.nbosp.terminal',
    terminal: 'com.nbosp.terminal',
    vault: 'files',
  });

  const canonicalize = id => typeof id === 'string' ? aliases[id] || id : id;

  window.NovaAppIdAliases = Object.freeze({
    canonicalize(id) {
      return canonicalize(id);
    },
    isAlias(id) {
      return Object.hasOwn(aliases, id);
    },
    migratePersistentReferences(settings, storage) {
      let changed = false;
      const migrateSettingsArray = key => {
        const current = settings.get(key);
        if (!Array.isArray(current)) return;
        const next = current.map(canonicalize);
        if (next.some((value, index) => value !== current[index])) {
          settings.set(key, next);
          changed = true;
        }
      };

      const defaults = settings.get('defaultApps');
      if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
        const next = Object.fromEntries(
          Object.entries(defaults).map(([key, appId]) => [key, canonicalize(appId)])
        );
        if (Object.entries(defaults).some(([key, appId]) => next[key] !== appId)) {
          settings.set('defaultApps', next);
          changed = true;
        }
      }

      migrateSettingsArray('pinnedApps');

      const iconPositions = settings.get('desktopIconPositions');
      if (iconPositions && typeof iconPositions === 'object' && !Array.isArray(iconPositions)) {
        const next = {};
        for (const [appId, position] of Object.entries(iconPositions)) {
          const currentId = appId.startsWith('app:')
            ? `app:${canonicalize(appId.slice(4))}`
            : canonicalize(appId);
          if (!Object.hasOwn(next, currentId) || currentId === appId) next[currentId] = position;
        }
        if (Object.keys(next).length !== Object.keys(iconPositions).length ||
            Object.keys(iconPositions).some(id => !Object.hasOwn(next, id))) {
          settings.set('desktopIconPositions', next);
          changed = true;
        }
      }

      const remapIdList = (current) => current.map(item => {
        if (typeof item === 'string') return canonicalize(item);
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const updated = { ...item };
        for (const field of ['id', 'appId']) {
          if (typeof updated[field] === 'string') updated[field] = canonicalize(updated[field]);
        }
        return updated;
      });

      // Legacy localStorage copies — pre-registry installs may still hold
      // values here; the registry is the live store now but these are kept
      // consistent so a later adoption can't resurrect stale ids.
      for (const key of ['nova_boot_apps', 'nova_disabled_apps']) {
        try {
          const raw = storage.getItem(key);
          if (raw === null) continue;
          const current = JSON.parse(raw);
          if (!Array.isArray(current)) continue;
          const next = remapIdList(current);
          if (JSON.stringify(next) !== JSON.stringify(current)) {
            storage.setItem(key, JSON.stringify(next));
            changed = true;
          }
        } catch (error) {
          console.error(`[BOOT] Failed migrating legacy app IDs in ${key}:`, error);
        }
      }

      // Registry paths — the live stores for both lists (RegistryPrefs).
      const reg = (typeof window !== 'undefined' && window.NovaRegistry) || null;
      if (reg && typeof reg.get === 'function') {
        for (const path of ['HKNU/apps/disabled', 'HKNU/apps/boot']) {
          try {
            const current = reg.get(path);
            if (!Array.isArray(current)) continue;
            const next = remapIdList(current);
            if (JSON.stringify(next) !== JSON.stringify(current)) {
              reg.set(path, next, { type: 'REG_JSON', source: 'app-id-alias-migration' });
              changed = true;
            }
          } catch (error) {
            console.error(`[BOOT] Failed migrating legacy app IDs in ${path}:`, error);
          }
        }
      }
      return changed;
    },
  });
})();
