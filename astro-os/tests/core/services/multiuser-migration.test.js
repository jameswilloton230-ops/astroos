import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import { createRequire } from 'node:module';

// js/core/services/multiuser-migration.js — the one-time 3.0.2 → accounts
// migration. Pinned here for the step that was DESIGNED but never wired:
// on the web build the migration must stamp AstroOS_FS's unscoped rows to
// the owner (OS.workers.fs 'stampOwner'), otherwise every login re-roots
// onto an empty tree and the machine's existing files vanish from view —
// the "filesystem is still shared as one" class of bug.

const require = createRequire(import.meta.url);

function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

const MIGRATION_PATH = '../../../js/core/services/multiuser-migration.js';

describe('MultiUserMigration (js/core/services/multiuser-migration.js)', () => {
  let savedGlobals;

  beforeEach(() => {
    resetTestStorage();
    savedGlobals = {};
    for (const key of ['NovaRegistry', 'NovaUserScope', 'OS', 'fetch', 'document', 'MultiUserMigration']) {
      savedGlobals[key] = globalThis[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    vi.restoreAllMocks();
  });

  function installHarness({ legacyPinHash = 'deadbeef', legacyPinSalt = 'cafe', username = 'Diraz' } = {}) {
    const fsWorkerCalls = [];
    const scopeState = { enabledFlag: false, legacyOwner: null };
    const registryStore = new Map([
      ['HKNU/settings/username', username],
      ['HKNS/security/lockPin', legacyPinHash],
      ['HKNS/security/pinSalt', legacyPinSalt],
    ]);

    globalThis.NovaRegistry = {
      get: (key) => registryStore.get(key) ?? null,
      set: (key, value) => registryStore.set(key, value),
      remove: (key) => registryStore.delete(key),
      mountUserHives: () => {}, flushUserHives: () => {}, unmountUserHives: () => {},
    };
    globalThis.NovaUserScope = {
      enabled: () => scopeState.enabledFlag,
      explicitlyEnabled: () => scopeState.enabledFlag,
      enable: () => { scopeState.enabledFlag = true; },
      setLegacyOwnerUid: (uid) => { scopeState.legacyOwner = uid; },
      setActive: () => {}, clearActive: () => {}, setActiveRole: () => {},
    };
    globalThis.OS = {
      workers: {
        fs: {
          call: async (method, ...args) => {
            fsWorkerCalls.push([method, ...args]);
            if (method === 'stampOwner') return { stamped: 7 };
            return undefined;
          },
        },
      },
    };
    globalThis.fetch = vi.fn(async (path) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (path === '/api/auth/users') return { success: true, data: { users: [], policies: {} } };
        if (path === '/api/auth/migrate-legacy') return { success: true, data: { uid: 'u-legacy-owner', username: 'diraz' } };
        if (path === '/api/security/admin-mode') return { success: true, data: { adminEnabled: false } };
        return { success: true };
      },
    }));
    globalThis.document = { querySelector: () => null };

    // The web branch must run: this suite executes on Linux boxes, and the
    // linux-native branch performs REAL filesystem moves on $HOME — never
    // something a unit test should touch. Pin the platform for the run.
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const MultiUserMigration = requireFresh(MIGRATION_PATH);
    return {
      MultiUserMigration,
      fsWorkerCalls,
      scopeState,
      restorePlatform() {
        Object.defineProperty(process, 'platform', platformDescriptor);
      },
    };
  }

  it('imports the legacy owner, enables multi-user, and STAMPS the legacy filesystem rows to the owner', async () => {
    const { MultiUserMigration, fsWorkerCalls, scopeState, restorePlatform } = installHarness();
    try {
      const result = await MultiUserMigration.run();
      expect(result).toEqual({ migrated: true, ownerUid: 'u-legacy-owner' });
      expect(scopeState.enabledFlag).toBe(true);
      expect(scopeState.legacyOwner).toBe('u-legacy-owner');

      // The wiring this suite guards: the migration feeds the FS worker's
      // stampOwner() with the owner uid so the account's first login mounts
      // the tree the machine always had. Without it, unscoped 3.0.2 rows
      // belong to nobody and vanish from every account's view.
      expect(fsWorkerCalls).toContainEqual(['stampOwner', 'u-legacy-owner']);
    } finally {
      restorePlatform();
    }
  });

  it('is a no-op once multi-user is already enabled (no stamping, no server import)', async () => {
    const { MultiUserMigration, fsWorkerCalls, restorePlatform } = installHarness();
    globalThis.NovaUserScope.explicitlyEnabled = () => true;
    try {
      const result = await MultiUserMigration.run();
      expect(result).toEqual({ skipped: 'already-enabled' });
      expect(fsWorkerCalls).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('survives a stamping failure — the migration still completes', async () => {
    const { MultiUserMigration, restorePlatform } = installHarness();
    globalThis.OS.workers.fs.call = async () => { throw new Error('worker gone'); };
    try {
      const result = await MultiUserMigration.run();
      expect(result).toEqual({ migrated: true, ownerUid: 'u-legacy-owner' });
    } finally {
      restorePlatform();
    }
  });
});
