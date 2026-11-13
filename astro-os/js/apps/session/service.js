'use strict';

/**
 * AstroOS — SessionManager (com.astroos.service.session)
 *
 * The one core service permitted to swap per-user storage mounts. It owns:
 *   - the active account (uid, role, display name) and its server session;
 *   - the bearer token + CSRF token pair issued at login (host memory only
 *     — never handed to webviews, same discipline as the system-app HMAC
 *     headers);
 *   - the session verbs: login, logout, lock, unlock (reverify), switch
 *     (suspend-and-resume, not teardown);
 *   - the per-user strata mounting sequence at login and the teardown at
 *     logout/switch: registry user hives, VFS root, settings re-hydration,
 *     theme/wallpaper re-application, LS_MAP re-seed, desktop swap;
 *   - the OS events the rest of the shell subscribes to:
 *     session:changed, session:locked, session:unlocked,
 *     session:suspended, session:resumed, session:loggedout.
 *
 * The lock screen (com.astroos.service.lock-screen) renders the picker and
 * the per-account auth sheet; it calls INTO this service for every verb.
 */

(() => {
  // ── State ────────────────────────────────────────────────────────────
  const state = {
    status: 'loggedout',   // loggedout | active | locked | suspended | guest
    uid: null,
    uname: null,
    displayName: null,
    role: null,
    token: null,           // opaque session id — host memory only
    csrfToken: null,
    mustChangePin: false,
    via: null,
  };

  // Parked sessions during a fast switch: uid -> {token, csrfToken, uname, role, parkedAt}
  const suspendedSessions = new Map();

  const listeners = new Set();

  function enabled() {
    return typeof NovaUserScope !== 'undefined' && NovaUserScope.enabled();
  }

  function emit(name, detail) {
    const event = { name, ...detail };
    for (const fn of listeners) {
      try { fn(event); } catch (_) { /* listeners must not break the flow */ }
    }
    try {
      if (typeof OS !== 'undefined' && OS?.events?.emit) OS.events.emit(name, event);
    } catch (_) { }
    try {
      if (typeof EventLog !== 'undefined' && EventLog?.log) {
        EventLog.log({
          app: 'System', category: 'security', severity: 'info',
          message: `Session event: ${name}${detail?.uid ? ` (uid ${String(detail.uid).slice(0, 8)}…)` : ''}`,
        });
      }
    } catch (_) { }
  }

  function metaCsrf() {
    try { return document.querySelector('meta[name="csrf-token"]')?.content || ''; } catch (_) { return ''; }
  }

  /**
   * Host-side authenticated fetch. Sends the bearer token as X-Nova-Session
   * (the middleware resolves it to that exact session) and the matching CSRF
   * token. `omit` skips cookies entirely — the identity-establishing verbs
   * (login/setup) must mint a FRESH session instead of riding the page's
   * anonymous one, and the browser's single cookie slot stays untouched.
   */
  async function authFetch(path, { method = 'GET', body, bearer = null, omit = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = (bearer && bearer.csrfToken) || state.csrfToken || metaCsrf();
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const token = (bearer && bearer.token) || state.token;
    if (token) headers['X-Nova-Session'] = token;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: omit ? 'omit' : 'same-origin',
      });
    } catch (err) {
      return { status: 0, ok: false, json: null, error: err?.message || 'network error' };
    }
    let json = null;
    try { json = await res.json(); } catch (_) { }
    return { status: res.status, ok: res.ok, json };
  }

  // ── Per-user strata mounting ─────────────────────────────────────────

  function flushCurrentUserHives() {
    // The web-app list saves on a debounce; push it into the departing
    // account's hive before the hives swap or unmount under it.
    try { WebAppManager?.flush?.(); } catch (err) {
      console.warn('[SessionManager] Flushing web apps failed:', err);
    }
    try {
      if (typeof NovaRegistry !== 'undefined' && NovaRegistry?.flushUserHives) {
        NovaRegistry.flushUserHives();
      }
    } catch (err) {
      console.warn('[SessionManager] Flushing user hives failed:', err);
    }
  }

  // A guest's installs are volatile (the hive is never saved) but their
  // package files are not; delete them once the guest is done.
  function discardGuestApps() {
    try {
      if (NovaRegistry?.mountedUserUid?.() === 'guest') {
        NovaAppPackageStore?.purgeUserFiles?.('guest')?.catch?.(() => {});
      }
    } catch (err) {
      console.warn('[SessionManager] Guest app cleanup failed:', err);
    }
  }

  /** Seeds the LS_MAP user-data keys from the mounted user's AppDirs files. */
  function seedLocalStorageFromUser() {
    try {
      if (typeof AppDirs !== 'undefined' && AppDirs?.syncAllFromUser) {
        AppDirs.syncAllFromUser();
        return;
      }
      // Fallback: the shell-ui bootstrap mirror is one-directional; without
      // it the keys simply stay absent for a user who never wrote them.
    } catch (err) {
      console.warn('[SessionManager] LS_MAP re-seed failed:', err);
    }
  }

  /** Flushes LS_MAP keys into the mounted user's files, then clears them. */
  function flushLocalStorageToUser() {
    try {
      if (typeof AppDirs !== 'undefined' && AppDirs?.syncAllToUser) {
        AppDirs.syncAllToUser();
      }
    } catch (err) {
      console.warn('[SessionManager] LS_MAP flush failed:', err);
    }
  }

  function teardownDesktop() {
    try {
      if (typeof OS !== 'undefined' && OS.windows) {
        for (const id of [...OS.windows.keys()]) {
          try { WM.closeWindow(id, { forceKill: true }); } catch (_) { }
        }
      }
    } catch (_) { }
    try { WM?.updateTaskbar?.(); } catch (_) { }
  }

  /**
   * The mounting sequence for one account: hives, scope flag, settings,
   * VFS root, theme, desktop. This is the ONLY code path that performs it.
   *
   * The account's USERNAME is the on-disk segment for every per-user
   * stratum: its filesystem IS users/<username>/ (Desktop, Documents,
   * Trash and the hidden .apps app-data root all directly inside it) and
   * the hive documents live under users/<username>/registry/ — the
   * login-time layout upgrade (uid → username directories, nested → flat
   * tree) runs first so machines created under earlier layouts keep
   * every byte.
   */
  async function mountUserScope(user, { volatile: isGuest = false } = {}) {
    flushCurrentUserHives();
    discardGuestApps();
    flushLocalStorageToUser();

    const username = !isGuest && typeof user?.username === 'string' ? user.username : '';

    if (!isGuest && username) {
      try {
        if (typeof MultiUserMigration !== 'undefined' && MultiUserMigration?.upgradeUserLayout) {
          MultiUserMigration.upgradeUserLayout(user.uid, username);
        }
      } catch (err) {
        console.warn('[SessionManager] Username layout upgrade failed:', err);
      }
    }

    if (typeof NovaUserScope !== 'undefined') {
      NovaUserScope.setActive(isGuest ? 'guest' : user.uid);
      if (!isGuest && typeof NovaUserScope.setActiveUsername === 'function') {
        NovaUserScope.setActiveUsername(username || null);
      } else if (typeof NovaUserScope.clearActiveUsername === 'function') {
        NovaUserScope.clearActiveUsername();
      }
      NovaUserScope.setActiveRole(isGuest ? 'guest' : user.role);
    }

    // 1. Registry: mount this account's HKNU/HKNA/HKND from its own files,
    //    addressed by the username segment (legacy uid segment fallback).
    try {
      if (typeof NovaRegistry !== 'undefined' && NovaRegistry?.mountUserHives) {
        const segment = username || user.uid;
        NovaRegistry.mountUserHives(isGuest ? 'guest' : segment, { volatile: isGuest });
      }
    } catch (err) {
      console.error('[SessionManager] Mounting user hives failed:', err);
    }

    // 2. Settings: re-hydrate the cache from the freshly mounted hives.
    try { await OS.settings.load(); } catch (err) {
      console.warn('[SessionManager] Settings re-hydration failed:', err);
    }

    // 3. VFS: re-root the filesystem service onto this account's tree —
    //    ~/users/<username>/ itself (guests get their volatile tree).
    try {
      if (typeof FS !== 'undefined' && FS?.setUserRoot) {
        await FS.setUserRoot(isGuest ? 'guest' : user.uid, { guest: isGuest, username });
      }
    } catch (err) {
      console.error('[SessionManager] VFS re-root failed:', err);
    }

    // 4. Re-apply the account's shell appearance.
    try {
      if (typeof Boot !== 'undefined' && Boot?.applyOSVars) {
        const sGet = Boot.applyOSVars();
        Boot.applyThemeAndVars?.(sGet);
        Boot.applyWallpaper?.(sGet);
        Boot.applyAccessibility?.(sGet);
        Boot.applyCursorSize?.(sGet);
        Boot.configureTaskbar?.(sGet);
      }
    } catch (err) {
      console.warn('[SessionManager] Appearance re-apply failed:', err);
    }

    // 5. User-data localStorage keys: seed from this account's files.
    if (!isGuest) seedLocalStorageFromUser();

    // 5b. Per-account permission grants: re-load the grant table from the
    // freshly mounted HKNU (each account consents for itself; machine-level
    // app facts stay in HKNS).
    try {
      if (!isGuest && typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.reloadForUser) {
        AppPermissionManager.reloadForUser();
      }
    } catch (err) {
      console.warn('[SessionManager] Permission re-load failed:', err);
    }

    // 5c. Per-account installed apps: drop the previous account's .novaapp
    // registrations and register this one's. Runs for guests too, so a guest
    // never sees the last user's installs.
    try {
      if (typeof Boot !== 'undefined' && Boot?.reloadUserNovaApps) {
        await Boot.reloadUserNovaApps();
      }
    } catch (err) {
      console.warn('[SessionManager] Installed-app reload failed:', err);
    }

    // 5d. Per-account web-app shortcuts, same reason as 5c.
    try { WebAppManager?.reloadForUser?.(); } catch (err) {
      console.warn('[SessionManager] Web-app reload failed:', err);
    }

    // 6. Desktop: icons, launchpad, the trusted launcher, autostart.
    try {
      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
      if (typeof Boot !== 'undefined' && Boot?.startConfiguredHomeApp) {
        await Boot.startConfiguredHomeApp();
      }
      if (typeof Boot !== 'undefined' && Boot?.launchAutostartApps) {
        Boot.launchAutostartApps();
      }
      WM?.updateTaskbar?.();
    } catch (err) {
      console.warn('[SessionManager] Desktop mount failed:', err);
    }
  }

  function applyLoginResult(data) {
    state.token = data.sessionId;
    state.csrfToken = data.csrfToken;
    state.uid = data.user?.uid ?? null;
    state.uname = data.user?.username ?? null;
    state.displayName = data.user?.displayName ?? null;
    state.role = data.user?.role ?? null;
    state.mustChangePin = !!data.mustChangePin;
    state.via = data.via || 'pin';
  }

  // ── Session verbs ────────────────────────────────────────────────────

  /**
   * PIN / passphrase login for a picked account. `omit` mints a fresh
   * session (credentials omitted), so the browser cookie keeps pointing at
   * the anonymous page session and the returned bearer token is what the
   * host presents from here on.
   */
  async function login({ uid, secret }) {
    if (!enabled()) return { ok: false, code: 'MULTI_USER_DISABLED', message: 'Multi-user mode is off' };
    const { status, ok, json } = await authFetch('/api/auth/login', {
      method: 'POST', omit: true, body: { uid, secret },
    });
    if (!ok || !json?.success) {
      return { ok: false, code: json?.code || `HTTP_${status}`, message: json?.message || 'Login failed', retryAfterMs: json?.retryAfterMs };
    }
    applyLoginResult(json.data);
    suspendedSessions.delete(state.uid);
    state.status = 'active';
    await mountUserScope(json.data.user);
    emit('session:changed', { uid: state.uid, role: state.role, via: state.via, mustChangePin: state.mustChangePin });
    return { ok: true, user: json.data.user, mustChangePin: state.mustChangePin };
  }

  /** WebAuthn login for a picked account (same session outcome as login). */
  async function webauthnLogin({ uid }) {
    if (!enabled()) return { ok: false, code: 'MULTI_USER_DISABLED', message: 'Multi-user mode is off' };
    if (typeof navigator === 'undefined' || !navigator.credentials?.get) {
      return { ok: false, code: 'UNAVAILABLE', message: 'WebAuthn is not available in this runtime' };
    }
    const options = await authFetch('/api/auth/webauthn/login/options', { method: 'POST', omit: true, body: { uid } });
    if (!options.ok || !options.json?.success) {
      return { ok: false, code: options.json?.code || 'WEBAUTHN_OPTIONS', message: options.json?.message || 'No authenticator options' };
    }
    const data = options.json.data;
    const b64uToBytes = (text) => Uint8Array.from(
      typeof Uint8Array.fromBase64 === 'function'
        ? Uint8Array.fromBase64(text)
        : Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    );
    let credential;
    try {
      credential = await navigator.credentials.get({
        publicKey: {
          challenge: b64uToBytes(data.challenge),
          rpId: data.rpId,
          allowCredentials: (data.allowCredentials || []).map(item => ({ type: 'public-key', id: b64uToBytes(item.id) })),
          timeout: data.timeout || 60000,
          userVerification: 'required',
        },
      });
    } catch (err) {
      return { ok: false, code: 'WEBAUTHN_CANCELLED', message: err?.message || 'Biometric unlock cancelled' };
    }
    const toB64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const finish = await authFetch('/api/auth/webauthn/login/finish', {
      method: 'POST', omit: true,
      body: {
        uid,
        credentialId: credential.id,
        authenticatorData: toB64u(credential.response.authenticatorData),
        clientDataJSON: toB64u(credential.response.clientDataJSON),
        signature: toB64u(credential.response.signature),
      },
    });
    if (!finish.ok || !finish.json?.success) {
      return { ok: false, code: finish.json?.code || 'WEBAUTHN_INVALID', message: finish.json?.message || 'Biometric verification failed' };
    }
    applyLoginResult(finish.json.data);
    suspendedSessions.delete(state.uid);
    state.status = 'active';
    await mountUserScope(finish.json.data.user);
    emit('session:changed', { uid: state.uid, role: state.role, via: 'webauthn' });
    return { ok: true, user: finish.json.data.user };
  }

  /** First-boot setup: creates the owner account and enters the session. */
  async function setupOwner({ displayName, username, pin, passphrase, avatar }) {
    const { status, ok, json } = await authFetch('/api/auth/setup', {
      method: 'POST', omit: true, body: { displayName, username, pin, passphrase, avatar },
    });
    if (!ok || !json?.success) {
      return { ok: false, code: json?.code || `HTTP_${status}`, message: json?.message || 'Setup failed' };
    }
    if (typeof NovaUserScope !== 'undefined') {
      NovaUserScope.enable();
      NovaUserScope.setLegacyOwnerUid(json.data.user.uid);
    }
    applyLoginResult(json.data);
    state.status = 'active';
    await mountUserScope(json.data.user);
    emit('session:changed', { uid: state.uid, role: state.role, via: 'setup' });
    return { ok: true, user: json.data.user };
  }

  /**
   * Sign out: flush + teardown + picker. The server session is ended, so
   * the next picker auth is a full login — the clean end for shared machines.
   */
  async function logout() {
    if (state.status === 'loggedout') return { ok: true };
    const uid = state.uid;
    const uname = state.uname;
    flushCurrentUserHives();
    discardGuestApps();
    flushLocalStorageToUser();
    teardownDesktop();
    if (typeof NovaUserScope !== 'undefined') {
      NovaUserScope.clearActive();
      NovaUserScope.setActiveRole(null);
    }
    if (typeof NovaRegistry !== 'undefined' && NovaRegistry?.unmountUserHives) {
      try { NovaRegistry.unmountUserHives(); } catch (_) { }
    }
    // The departed account's tree must stop being the mounted one: re-root
    // onto the machine tree so nothing personal stays reachable from the
    // picker (and a following guest session starts from a clean slate).
    try {
      if (typeof FS !== 'undefined' && FS?.setUserRoot) {
        await FS.setUserRoot(null);
      }
    } catch (err) {
      console.warn('[SessionManager] VFS re-root to machine tree failed:', err);
    }
    suspendedSessions.clear();
    await authFetch('/api/auth/logout', { method: 'POST' });
    state.status = 'loggedout';
    state.uid = state.uname = state.displayName = state.role = null;
    state.token = state.csrfToken = null;
    state.mustChangePin = false;
    emit('session:loggedout', { uid });
    emit('session:changed', { uid: null, loggedOut: true, uname });
    return { ok: true };
  }

  /** Guest session (policy-gated): volatile mounts, no server session. */
  async function guestLogin() {
    state.status = 'guest';
    state.uid = null;
    state.uname = 'Guest';
    state.displayName = 'Guest';
    state.role = 'guest';
    state.token = null;
    state.csrfToken = metaCsrf();
    // A guest desktop used to ride on whatever tree happened to be mounted —
    // the previous user's after a logout, or the machine tree at boot —
    // which handed the guest (and anyone watching) the last account's files.
    // Guests now mount their own volatile tree/hives/app roots through the
    // same sequence every other session uses.
    await mountUserScope({ uid: 'guest', username: '', role: 'guest' }, { volatile: true });
    emit('session:changed', { uid: null, role: 'guest', via: 'guest' });
    return { ok: true, guest: true };
  }

  /**
   * Lock the ACTIVE session: server marks it locked (privileged routes
   * refuse it), the desktop stays mounted, and the lock screen gates it.
   */
  async function lock() {
    if (state.status !== 'active') return { ok: false, code: 'NOT_ACTIVE', message: 'No active session' };
    const result = await authFetch('/api/auth/lock', { method: 'POST' });
    if (result.ok && result.json?.success) {
      state.status = 'locked';
      emit('session:locked', { uid: state.uid });
      return { ok: true };
    }
    return { ok: false, code: result.json?.code || 'LOCK_FAILED', message: result.json?.message || 'Could not lock the session' };
  }

  /**
   * Unlock / switch-resume: re-verify the secret against the server for
   * the targeted session. A remotely revoked session cannot pass this —
   * the account row is gone — so it can never be unlocked back into a
   * live desktop.
   */
  async function unlock(secret, { bearer = null } = {}) {
    const effectiveBearer = bearer || { token: state.token, csrfToken: state.csrfToken };
    if (!effectiveBearer.token) return { ok: false, code: 'NO_SESSION', message: 'No session to unlock' };
    const result = await authFetch('/api/auth/reverify', { method: 'POST', body: { secret }, bearer: effectiveBearer });
    if (!result.ok || !result.json?.success) {
      return { ok: false, code: result.json?.code || 'REVERIFY_FAILED', message: result.json?.message || 'Verification failed', retryAfterMs: result.json?.retryAfterMs };
    }
    // A suspended session resumed through reverify becomes active again.
    const wasSuspended = state.status === 'suspended' || suspendedSessions.has(result.json.data.user?.uid);
    if (bearer && bearer.token !== state.token) {
      // Resuming a parked session: adopt its identity back.
      applyLoginResult(result.json.data);
      suspendedSessions.delete(result.json.data.user?.uid);
      state.mustChangePin = !!result.json.data.mustChangePin;
    }
    state.status = 'active';
    emit(wasSuspended ? 'session:resumed' : 'session:unlocked', { uid: state.uid });
    if (wasSuspended) {
      await mountUserScope(result.json.data.user);
      emit('session:changed', { uid: state.uid, role: state.role, via: 'resume' });
    }
    return { ok: true, mustChangePin: !!result.json.data.mustChangePin };
  }

  /**
   * Fast user switching — suspend-and-resume, not teardown. The departing
   * session is marked suspended server-side (privileged routes refuse it
   * while it sleeps), its token is parked in host memory, and the picker
   * appears for the next account. Both sessions stay alive.
   */
  async function suspendForSwitch() {
    if (state.status === 'loggedout' || state.status === 'suspended') return { ok: true };
    const uid = state.uid;
    const parked = { token: state.token, csrfToken: state.csrfToken, uname: state.uname, role: state.role, parkedAt: Date.now() };
    const result = await authFetch('/api/auth/suspend', { method: 'POST' });
    if (uid && state.token) suspendedSessions.set(uid, parked);
    // Memory-disciplined switch: apps close (the snapshot restores layout
    // on return), hives and user-data keys flush into the departing tree.
    flushCurrentUserHives();
    discardGuestApps();
    flushLocalStorageToUser();
    teardownDesktop();
    if (typeof NovaUserScope !== 'undefined') {
      NovaUserScope.clearActive();
      NovaUserScope.setActiveRole(null);
    }
    if (typeof NovaRegistry !== 'undefined' && NovaRegistry?.unmountUserHives) {
      try { NovaRegistry.unmountUserHives(); } catch (_) { }
    }
    state.status = 'suspended';
    // Same re-root as logout: the picker replaces the departing account's
    // desktop, and its tree has no business staying mounted underneath it.
    try {
      if (typeof FS !== 'undefined' && FS?.setUserRoot) {
        await FS.setUserRoot(null);
      }
    } catch (err) {
      console.warn('[SessionManager] VFS re-root to machine tree failed:', err);
    }
    emit('session:suspended', { uid });
    emit('session:changed', { uid: null, switchedFrom: uid });
    return { ok: result.ok && result.json?.success !== false, parked };
  }

  /** Switch to another account by authenticating as them (picker flow). */
  async function switchUser({ uid, secret }) {
    const suspendResult = await suspendForSwitch();
    if (!suspendResult.ok) return suspendResult;
    return login({ uid, secret });
  }

  /** Uids with parked (suspended) sessions that can be resumed. */
  function suspendedUsers() {
    return [...suspendedSessions.entries()].map(([uid, info]) => ({
      uid, uname: info.uname, role: info.role, parkedAt: info.parkedAt,
    }));
  }

  /** Resume a parked session from the picker (re-verification required). */
  async function resumeUser(uid, secret) {
    const parked = suspendedSessions.get(uid);
    if (!parked) return { ok: false, code: 'NOT_SUSPENDED', message: 'No suspended session for this account' };
    const result = await unlock(secret, { bearer: parked });
    if (!result.ok) return result;
    await mountUserScope({ uid, username: parked.uname, role: parked.role });
    emit('session:changed', { uid, role: parked.role, via: 'resume' });
    return result;
  }

  // ── Credential self-service ──────────────────────────────────────────

  async function changePin(currentSecret, newPin) {
    const result = await authFetch('/api/auth/change-pin', {
      method: 'POST',
      body: { currentSecret, newPin },
    });
    if (result.ok && result.json?.success) state.mustChangePin = false;
    return result.ok && result.json?.success
      ? { ok: true }
      : { ok: false, code: result.json?.code || 'CHANGE_PIN_FAILED', message: result.json?.message || 'PIN change failed' };
  }

  async function changePassphrase(currentSecret, passphrase) {
    const result = await authFetch('/api/auth/change-passphrase', {
      method: 'POST',
      body: { currentSecret, passphrase },
    });
    return result.ok && result.json?.success
      ? { ok: true }
      : { ok: false, code: result.json?.code || 'CHANGE_PHRASE_FAILED', message: result.json?.message || 'Passphrase change failed' };
  }

  /** Enroll the platform authenticator for the current (or admin-picked) account. */
  async function enrollWebauthn({ uid = null, label = null } = {}) {
    const options = await authFetch('/api/auth/webauthn/register/options', { method: 'POST', body: { uid } });
    if (!options.ok || !options.json?.success) {
      return { ok: false, code: options.json?.code || 'WEBAUTHN_OPTIONS', message: options.json?.message || 'Could not start enrollment' };
    }
    const data = options.json.data;
    const b64uToBytes = (text) => Uint8Array.from(
      typeof Uint8Array.fromBase64 === 'function'
        ? Uint8Array.fromBase64(text)
        : Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    );
    let credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: b64uToBytes(data.challenge),
          rp: data.rp,
          user: { ...data.user, id: b64uToBytes(data.user.id) },
          pubKeyCredParams: data.pubKeyCredParams,
          authenticatorSelection: data.authenticatorSelection,
          timeout: data.timeout,
          excludeCredentials: (data.excludeCredentials || []).map(item => ({ type: 'public-key', id: b64uToBytes(item.id) })),
          attestation: data.attestation || 'none',
        },
      });
    } catch (err) {
      return { ok: false, code: 'WEBAUTHN_CANCELLED', message: err?.message || 'Enrollment cancelled' };
    }
    const toB64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const coseKey = credential.response.getPublicKey?.();
    if (!coseKey) {
      return { ok: false, code: 'WEBAUTHN_NO_KEY', message: 'This authenticator does not expose a usable public key' };
    }
    const finish = await authFetch('/api/auth/webauthn/register/finish', {
      method: 'POST',
      body: {
        credentialId: credential.id,
        publicKey: Array.from(new Uint8Array(coseKey)),
        alg: credential.response.getPublicKeyAlgorithm?.(),
        clientDataJSON: toB64u(credential.response.clientDataJSON),
        label,
      },
    });
    return finish.ok && finish.json?.success
      ? { ok: true }
      : { ok: false, code: finish.json?.code || 'WEBAUTHN_ERROR', message: finish.json?.message || 'Enrollment failed' };
  }

  // ── Introspection helpers ────────────────────────────────────────────

  async function listAccounts() {
    const { ok, json } = await authFetch('/api/auth/users');
    if (!ok || !json?.success) return { ok: false, users: [], policies: {} };
    return { ok: true, users: json.data.users || [], policies: json.data.policies || {} };
  }

  async function policies() {
    const { ok, json } = await authFetch('/api/auth/policies');
    return ok && json?.success ? json.data : {};
  }

  async function currentSession() {
    const { ok, json } = await authFetch('/api/auth/session');
    if (!ok || !json?.success) return { authenticated: false };
    return json.data;
  }

  /**
   * The boot gate: presents the login picker when no account session is
   * live, or the first-boot setup wizard when users.db is empty. Called at
   * the end of boot() when multi-user mode is enabled.
   */
  async function bootGate() {
    if (!enabled()) return { mode: 'legacy' };
    const accounts = await listAccounts();
    if (!accounts.users.length) {
      emit('session:changed', { phase: 'first-boot' });
      return { mode: 'first-boot' };
    }
    if (state.status !== 'loggedout') {
      // A session is already live (page-level resume path).
      return { mode: 'active', user: publicState() };
    }
    emit('session:changed', { phase: 'picker' });
    return { mode: 'picker', users: accounts.users, policies: accounts.policies };
  }

  // ── Public state view (no secrets ever) ──────────────────────────────

  function publicState() {
    return {
      status: state.status,
      uid: state.uid,
      uname: state.uname,
      displayName: state.displayName,
      role: state.role,
      isAdmin: state.role === 'owner' || state.role === 'admin',
      mustChangePin: state.mustChangePin,
      via: state.via,
    };
  }

  const SessionManager = {
    // state
    state: publicState,
    active: () => state.status === 'active' || state.status === 'locked' || state.status === 'suspended',
    isActive: () => state.status === 'active',
    isLocked: () => state.status === 'locked',
    isAdmin: () => state.role === 'owner' || state.role === 'admin',
    token: () => state.token,
    csrf: () => state.csrfToken,
    suspendedUsers,
    // verbs
    login,
    webauthnLogin,
    setupOwner,
    logout,
    guestLogin,
    lock,
    unlock,
    suspendForSwitch,
    switchUser,
    resumeUser,
    // credentials
    changePin,
    changePassphrase,
    enrollWebauthn,
    // data
    listAccounts,
    policies,
    currentSession,
    bootGate,
    // transport (host apps only — lock screen, Users console relays)
    authFetch,
    // events
    on(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
    _mountUserScope: mountUserScope,
  };

  if (typeof window !== 'undefined' && window) {
    window.SessionManager = Object.freeze(SessionManager);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionManager;
  }
})();
