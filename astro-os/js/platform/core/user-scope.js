/**
 * AstroOS — per-user storage scoping (platform module).
 *
 * The one source of truth for "which account's storage is mounted",
 * resolved by the trusted host at the point of enforcement. Sandboxed
 * apps never construct addresses that carry a uid — every storage
 * chokepoint (registry hive documents, VFS roots, AppStorage keys,
 * AppDirs, webview partitions, secrets) derives its owner segment from
 * here, so there is exactly one place scoping can be wrong.
 *
 * Boot-time state (flag, active uid, legacy owner) lives in localStorage
 * because it must be readable before the registry is mounted and before
 * any user is logged in — machine-level state only, per the design's
 * "localStorage holds nothing personal" rule.
 */
(() => {
  'use strict';

  const FLAG_KEY = 'nova_multi_user';        // '1' = multi-user mode enabled
  const ACTIVE_KEY = 'nova_active_uid';     // uid of the mounted account
  const ACTIVE_UNAME_KEY = 'nova_active_uname'; // username of the mounted account
  const LEGACY_OWNER_KEY = 'nova_legacy_owner'; // uid that owns 3.0.2 data after migration

  function lsGet(key) {
    try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { }
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { }
  }

  function safeUid(uid) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(uid || '')) ? String(uid) : '';
  }

  /* Usernames are the human-facing directory segment under the AstroOS
   * roots (the account's filesystem IS users/<username>/), so they get the
   * same shape check the account database enforces: lowercase letters,
   * digits, dots, dashes, 3–32 chars, leading alphanumeric. */
  function safeUsername(uname) {
    return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(String(uname || '').toLowerCase())
      ? String(uname || '').toLowerCase() : '';
  }

  const UserScope = {
    /**
     * Multi-user mode is the default: accounts are how the OS works, so an
     * unset flag means ON and only an explicit '0' (disable()) turns it off.
     * That lets a factory-fresh machine reach the first-boot wizard.
     */
    enabled() {
      return lsGet(FLAG_KEY) !== '0';
    },
    /**
     * True only once this machine has actually been through account setup or
     * the legacy migration (flag written as '1'). The migration uses this,
     * not enabled(), to decide whether it already ran.
     */
    explicitlyEnabled() {
      return lsGet(FLAG_KEY) === '1';
    },
    enable() {
      lsSet(FLAG_KEY, '1');
    },
    disable() {
      lsSet(FLAG_KEY, '0');
    },

    /** uid of the currently mounted (logged-in) account; '' when none. */
    uid() {
      return this.enabled() ? safeUid(lsGet(ACTIVE_KEY)) : '';
    },

    /**
     * Username of the currently mounted account — the directory segment
     * its per-user filesystem and registry hives live under
     * (users/<username>/*). Set by the SessionManager at mount, alongside
     * setActive(uid); '' when no account is mounted. Usernames are
     * immutable in the account database, so the segment is stable.
     */
    activeUsername() {
      return this.enabled() ? safeUsername(lsGet(ACTIVE_UNAME_KEY)) : '';
    },
    setActiveUsername(uname) {
      const value = safeUsername(uname);
      if (value) lsSet(ACTIVE_UNAME_KEY, value);
      else lsRemove(ACTIVE_UNAME_KEY);
    },
    clearActiveUsername() {
      lsRemove(ACTIVE_UNAME_KEY);
    },

    /**
     * uid that the legacy 3.0.2 single-user data was stamped to during
     * migration — used by schema upgrades (AppStorage rows, partitions)
     * so upgraded machines keep every byte owned.
     */
    legacyOwnerUid() {
      return safeUid(lsGet(LEGACY_OWNER_KEY));
    },
    setLegacyOwnerUid(uid) {
      const value = safeUid(uid);
      if (value) lsSet(LEGACY_OWNER_KEY, value);
    },

    setActive(uid) {
      const value = safeUid(uid);
      if (value) lsSet(ACTIVE_KEY, value);
      else lsRemove(ACTIVE_KEY);
    },
    clearActive() {
      lsRemove(ACTIVE_KEY);
      lsRemove(ACTIVE_UNAME_KEY);
    },

    /**
     * The uid a NEW storage row / partition must be stamped with: the active
     * account, or the legacy owner while single-user data is still unscoped
     * (pre-migration / flag-off machines keep byte-identical addressing).
     */
    ownerUid() {
      const active = this.uid();
      if (active) return active;
      if (this.enabled()) return this.legacyOwnerUid();
      return '';
    },

    /**
     * Directory segment under the AstroOS roots for the mounted account.
     * The username is the segment when one is mounted (users/<username>);
     * pre-login the legacy owner uid keeps the old addressing so storage
     * schema upgrades keep stamping the same owner.
     */
    userSegment() {
      const uname = this.activeUsername();
      if (uname) return `users/${uname}`;
      const uid = this.ownerUid();
      return uid ? `users/${uid}` : '';
    },

    isActiveAdmin() {
      if (!this.enabled()) return true; // single-user legacy machines
      const role = lsGet('nova_active_role');
      return role === 'owner' || role === 'admin';
    },
    setActiveRole(role) {
      if (role) lsSet('nova_active_role', String(role));
      else lsRemove('nova_active_role');
    },

    /** Wipes every machine-level scope flag (factory reset / disable). */
    reset() {
      [FLAG_KEY, ACTIVE_KEY, ACTIVE_UNAME_KEY, LEGACY_OWNER_KEY, 'nova_active_role'].forEach(lsRemove);
    },
  };

  if (typeof window !== 'undefined' && window) {
    window.NovaUserScope = Object.freeze(UserScope);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UserScope;
  }
})();
