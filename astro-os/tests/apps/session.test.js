import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

// com.astroos.service.session — the SessionManager owns the account session
// state machine: login (fresh bearer session, cookie slot untouched),
// suspend-and-resume switching, logout teardown, and the per-user mount
// sequence it alone is permitted to perform.

let dom;

function makeFetchRouter(routes) {
  // routes: { 'POST /api/auth/login': (body) => ({ status, json }) , ... }
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    const route = routes[`${method} ${url.split('?')[0]}`];
    calls.push({
      method, url,
      body,
      credentials: options.credentials,
      headers: { ...(options.headers || {}) },
    });
    const response = route ? route(body, options) : { status: 404, json: { success: false, message: 'no route' } };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.json,
    };
  };
  return { fetchImpl, calls };
}

async function loadSessionManager({ routes = {}, mountEnabled = true } = {}) {
  const { fetchImpl, calls } = makeFetchRouter(routes);
  const mounts = { scopeActive: [], scopeUsernames: [], registry: [], userRoots: [], userRootArgs: [], layoutUpgrades: [], settingsLoads: 0, permissionReloads: 0 };
  const scope = {
    enabled: () => mountEnabled,
    uid: () => mounts.scopeActive[mounts.scopeActive.length - 1] || '',
    activeUsername: () => mounts.scopeUsernames[mounts.scopeUsernames.length - 1] || '',
    ownerUid: () => '',
    legacyOwnerUid: () => '',
    setActiveRole: () => {},
    clearActive: () => { mounts.scopeActive.pop(); },
    setActive(uid) { mounts.scopeActive.push(uid); },
    setActiveUsername(uname) { mounts.scopeUsernames.push(String(uname || '')); },
    clearActiveUsername() { mounts.scopeUsernames.push(''); },
    isActiveAdmin: () => false,
    setLegacyOwnerUid: () => {},
    enable: () => {},
  };
  const registry = {
    mountUserHives(segment) { mounts.registry.push(segment); },
    unmountUserHives() { mounts.registry.pop(); },
    flushUserHives() { },
  };
  const migration = {
    upgradeUserLayout(uid, username) { mounts.layoutUpgrades.push([uid, username]); },
  };
  const events = [];
  const loaded = await loadServiceApp('session', {
    stubs: {
      extra: {
        NovaUserScope: scope,
        NovaRegistry: registry,
        MultiUserMigration: migration,
        SessionManager: undefined,
        OS: {
          settings: {
            load: async () => { mounts.settingsLoads += 1; },
          },
          events: { emit: (name, payload) => events.push({ name, payload }), on: () => {} },
          windows: new Map(),
        },
        FS: {
          setUserRoot: async (uid, opts) => { mounts.userRoots.push(uid); mounts.userRootArgs.push({ uid, opts }); },
        },
        Boot: {
          applyOSVars: () => () => undefined,
          applyThemeAndVars: () => {},
          applyWallpaper: () => {},
          applyAccessibility: () => {},
          applyCursorSize: () => {},
          configureTaskbar: () => {},
          startConfiguredHomeApp: async () => {},
          launchAutostartApps: () => { mounts.autostarts = (mounts.autostarts || 0) + 1; },
        },
        WM: { closeWindow: () => {}, updateTaskbar: () => {} },
        renderDesktopIcons: () => {},
        renderLaunchpad: () => {},
        AppDirs: { syncAllFromUser: () => {}, syncAllToUser: () => {} },
        AppPermissionManager: { reloadForUser: () => { mounts.permissionReloads += 1; } },
        EventLog: { log: () => {} },
        fetch: fetchImpl,
      },
    },
  });
  dom = loaded.dom;
  const manager = loaded.window.SessionManager;
  const emitted = [];
  manager.on((event) => emitted.push(event));
  return { manager, calls, mounts, events, emitted, scope };
}

afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });

beforeEach(() => resetTestStorage());

describe('SessionManager (js/apps/session service)', () => {
  it('attaches a frozen service with the documented surface', async () => {
    const { manager } = await loadSessionManager();
    expect(Object.isFrozen(manager)).toBe(true);
    for (const key of ['login', 'webauthnLogin', 'setupOwner', 'logout', 'guestLogin', 'lock', 'unlock', 'suspendForSwitch', 'switchUser', 'resumeUser', 'changePin', 'changePassphrase', 'enrollWebauthn', 'listAccounts', 'policies', 'currentSession', 'bootGate', 'authFetch', 'on']) {
      expect(typeof manager[key]).toBe('function');
    }
    expect(manager.state().status).toBe('loggedout');
    expect(manager.active()).toBe(false);
  });

  it('login mints a FRESH session with cookies omitted and keeps the token in host memory only', async () => {
    const { manager, calls, mounts, emitted } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: {
            success: true,
            data: {
              sessionId: 'sid-AAAA',
              csrfToken: 'csrf-AAAA',
              user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', pinLength: 4 },
              mustChangePin: false,
              via: 'pin',
            },
          },
        }),
      },
    });
    const result = await manager.login({ uid: 'u1', secret: '1234' });
    expect(result.ok).toBe(true);
    expect(manager.state()).toMatchObject({ status: 'active', uid: 'u1', uname: 'ada', role: 'owner', isAdmin: true });
    expect(manager.token()).toBe('sid-AAAA');
    expect(manager.csrf()).toBe('csrf-AAAA');

    // The login request omitted cookies (fresh session mint) and never
    // sent a bearer token it did not have yet.
    const loginCall = calls.find(c => c.url === '/api/auth/login');
    expect(loginCall.credentials).toBe('omit');
    expect(loginCall.headers['X-Nova-Session']).toBeUndefined();

    // The per-user mount sequence ran exactly once: scope flag (uid +
    // username), the login-time layout upgrade (uid→username rename +
    // nested→flat lift), hive mount on the USERNAME segment, settings
    // re-hydration, VFS re-root, permission reload. The VFS re-root keeps
    // the uid as its identity arg but carries the username so fs.js roots
    // the tree at ~/users/<username>/.
    expect(mounts.scopeActive).toEqual(['u1']);
    expect(mounts.scopeUsernames).toEqual(['ada']);
    expect(mounts.layoutUpgrades).toEqual([['u1', 'ada']]);
    expect(mounts.registry).toEqual(['ada']);
    expect(mounts.settingsLoads).toBe(1);
    expect(mounts.userRoots).toEqual(['u1']);
    expect(mounts.userRootArgs[0].opts).toMatchObject({ username: 'ada', guest: false });
    expect(mounts.permissionReloads).toBe(1);

    expect(emitted.some(e => e.name === 'session:changed' && e.uid === 'u1')).toBe(true);
  });

  it('failed login stays logged out and surfaces the server code', async () => {
    const { manager, mounts, emitted } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({ status: 401, json: { success: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' } }),
      },
    });
    const result = await manager.login({ uid: 'u1', secret: '9999' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BAD_CREDENTIAL');
    expect(manager.state().status).toBe('loggedout');
    expect(mounts.registry).toEqual([]); // nothing mounted on failure
    expect(emitted).toEqual([]);
  });

  it('authFetch presents the bearer token and the session CSRF token on later calls', async () => {
    const { manager, calls } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: { success: true, data: { sessionId: 'sid-BBB', csrfToken: 'csrf-BBB', user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'standard', pinLength: 4 } } },
        }),
        'GET /api/auth/session': () => ({ status: 200, json: { success: true, data: { authenticated: true } } }),
      },
    });
    await manager.login({ uid: 'u1', secret: '1234' });
    await manager.currentSession();
    const probe = calls.find(c => c.url === '/api/auth/session');
    expect(probe.headers['X-Nova-Session']).toBe('sid-BBB');
    expect(probe.headers['X-CSRF-Token']).toBe('csrf-BBB');
  });

  it('lock + unlock (reverify): state machine goes active → locked → active', async () => {
    const { manager, emitted } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: { success: true, data: { sessionId: 'sid-C', csrfToken: 'c', user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', pinLength: 4 } } },
        }),
        'POST /api/auth/lock': () => ({ status: 200, json: { success: true, data: { locked: true } } }),
        'POST /api/auth/reverify': () => ({ status: 200, json: { success: true, data: { sessionId: 'sid-C', csrfToken: 'c', user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', pinLength: 4 } } } }),
      },
    });
    await manager.login({ uid: 'u1', secret: '1234' });
    await manager.lock();
    expect(manager.isLocked()).toBe(true);
    expect(emitted.some(e => e.name === 'session:locked')).toBe(true);
    const unlocked = await manager.unlock('1234');
    expect(unlocked.ok).toBe(true);
    expect(manager.isActive()).toBe(true);
    expect(emitted.some(e => e.name === 'session:unlocked')).toBe(true);
  });

  it('switching is suspend-and-resume: the departing token is parked, the new session mounts', async () => {
    let nextSession = 'sid-A';
    const { manager, emitted } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: {
            success: true,
            data: {
              sessionId: nextSession,
              csrfToken: 't-' + nextSession,
              user: { uid: nextSession === 'sid-A' ? 'u1' : 'u2', username: nextSession === 'sid-A' ? 'ada' : 'sam', displayName: nextSession === 'sid-A' ? 'Ada' : 'Sam', role: 'standard', pinLength: 4 },
            },
          },
        }),
        'POST /api/auth/suspend': () => ({ status: 200, json: { success: true, data: { suspended: true } } }),
      },
    });
    await manager.login({ uid: 'u1', secret: '1234' });
    expect(manager.token()).toBe('sid-A');

    nextSession = 'sid-B';
    const switchResult = await manager.switchUser({ uid: 'u2', secret: '4321' });
    expect(switchResult.ok).toBe(true);
    expect(manager.token()).toBe('sid-B'); // the new session is active
    expect(manager.suspendedUsers().map(u => u.uid)).toEqual(['u1']); // A's token parked
    expect(emitted.some(e => e.name === 'session:suspended' && e.uid === 'u1')).toBe(true);
  });

  it('resuming a parked session goes through reverify with the parked bearer', async () => {
    const { manager, calls } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: { success: true, data: { sessionId: 'sid-A', csrfToken: 'tA', user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'standard', pinLength: 4 } } },
        }),
        'POST /api/auth/suspend': () => ({ status: 200, json: { success: true, data: { suspended: true } } }),
        'POST /api/auth/reverify': (body, options) => ({
          status: 200,
          json: {
            success: true,
            data: {
              sessionId: 'sid-A',
              csrfToken: 'tA',
              user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'standard', pinLength: 4 },
            },
          },
        }),
      },
    });
    await manager.login({ uid: 'u1', secret: '1234' });
    await manager.suspendForSwitch();
    // Parked token must be presented for the resume reverify.
    calls.length = 0;
    const result = await manager.resumeUser('u1', '1234');
    expect(result.ok).toBe(true);
    const reverify = calls.find(c => c.url === '/api/auth/reverify');
    expect(reverify.headers['X-Nova-Session']).toBe('sid-A');
    expect(manager.isActive()).toBe(true);
  });

  it('logout tears the session down: scope cleared, hives unmounted, VFS re-rooted to the machine tree, server session ended', async () => {
    const { manager, calls, mounts } = await loadSessionManager({
      routes: {
        'POST /api/auth/login': () => ({
          status: 200,
          json: { success: true, data: { sessionId: 'sid-D', csrfToken: 'tD', user: { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', pinLength: 4 } } },
        }),
        'POST /api/auth/logout': () => ({ status: 200, json: { success: true, data: { signedOut: true } } }),
      },
    });
    await manager.login({ uid: 'u1', secret: '1234' });
    const result = await manager.logout();
    expect(result.ok).toBe(true);
    expect(manager.state()).toMatchObject({ status: 'loggedout', uid: null, role: null });
    expect(manager.token()).toBe(null);
    expect(mounts.scopeActive).toEqual([]);
    // The departed account's tree stops being mounted: teardown re-roots
    // the VFS onto the machine tree (null owner) so nothing personal stays
    // reachable from the picker — previously the FS cache kept serving the
    // logged-out user's files (and a guest desktop rode straight onto them).
    expect(mounts.userRoots).toEqual(['u1', null]);
    expect(calls.some(c => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(true);
  });

  it('bootGate: zero accounts → first-boot; accounts → picker', async () => {
    const empty = await loadSessionManager({
      routes: { 'GET /api/auth/users': () => ({ status: 200, json: { success: true, data: { users: [], policies: {} } } }) },
    });
    expect((await empty.manager.bootGate()).mode).toBe('first-boot');

    const populated = await loadSessionManager({
      routes: {
        'GET /api/auth/users': () => ({
          status: 200,
          json: { success: true, data: { users: [{ uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active', pinLength: 4 }], policies: { guestAccess: true } } },
        }),
      },
    });
    const gate = await populated.manager.bootGate();
    expect(gate.mode).toBe('picker');
    expect(gate.users).toHaveLength(1);
    expect(gate.policies.guestAccess).toBe(true);
  });

  it('multi-user disabled: login is refused outright (legacy machines keep single-user)', async () => {
    const { manager, calls } = await loadSessionManager({ routes: {}, mountEnabled: false });
    const result = await manager.login({ uid: 'u1', secret: '1234' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MULTI_USER_DISABLED');
    expect(calls).toEqual([]); // never even talked to the server
  });

  it('setupOwner creates the owner and enters the session (first-boot wizard path)', async () => {
    const { manager, mounts, emitted } = await loadSessionManager({
      routes: {
        'POST /api/auth/setup': () => ({
          status: 200,
          json: {
            success: true,
            data: {
              sessionId: 'sid-E',
              csrfToken: 'tE',
              user: { uid: 'u-owner', username: 'ada', displayName: 'Ada', role: 'owner', pinLength: 6 },
            },
          },
        }),
      },
    });
    const result = await manager.setupOwner({ displayName: 'Ada', username: 'ada', pin: '123456' });
    expect(result.ok).toBe(true);
    expect(manager.state()).toMatchObject({ status: 'active', role: 'owner', mustChangePin: false });
    // The owner's hives mount on the username segment; the layout upgrade
    // moved any pre-existing uid-keyed tree onto it first.
    expect(mounts.registry).toEqual(['ada']);
    expect(mounts.layoutUpgrades).toEqual([['u-owner', 'ada']]);
    expect(mounts.userRootArgs[0].opts).toMatchObject({ username: 'ada' });
    expect(emitted.some(e => e.name === 'session:changed' && e.via === 'setup')).toBe(true);
  });

  it('guest sessions mount volatile state without any server session', async () => {
    const { manager, calls, mounts, emitted } = await loadSessionManager({ routes: {} });
    const result = await manager.guestLogin();
    expect(result.ok).toBe(true);
    expect(result.guest).toBe(true);
    expect(manager.state().role).toBe('guest');
    expect(calls).toEqual([]);
    expect(emitted.some(e => e.name === 'session:changed' && e.role === 'guest')).toBe(true);
    // A guest used to ride on whatever tree was already mounted (the last
    // user's after logout, the machine tree at boot). The guest now mounts
    // its own volatile tree through the same sequence every session uses.
    expect(mounts.userRoots).toEqual(['guest']);
    expect(mounts.userRootArgs[0].opts).toMatchObject({ guest: true });
    expect(mounts.registry).toEqual(['guest']);
  });
});
