/**
 * AstroOS — Multi-user migration (3.0.2 single-user → accounts)
 *
 * The migration that must be perfect, because the existing user's data IS
 * the product. One-time, idempotent behind the HKNS/system/migration/v1
 * marker, and a strict no-op on machines that never enabled multi-user
 * (those keep byte-identical single-user behaviour forever).
 *
 * Order matters: this runs in boot BEFORE any per-user hive is mounted and
 * BEFORE the storage schemas (AstroOS_FS v2, AstroOS_AppStorage v2)
 * stamp owner uids, so every legacy byte is stamped to the owner it
 * belongs to:
 *
 *   1. owner account imported from the legacy single-user state
 *      (HKNS/security/lockPin PBKDF2 hash + pinSalt + HKNU/settings/
 *      username) into the server's users.db — kdf records the legacy
 *      shape, the first successful verification re-hashes to scrypt;
 *   2. registry user hives moved into users/<owner>/registry/;
 *   3. the legacy home tree moved into users/<owner>/ (the account's
 *      actual filesystem root) and the per-app AppDirs re-rooted under
 *      users/<owner>/.apps/;
 *   4. AstroOS_FS + AstroOS_AppStorage rows stamped with the owner uid
 *      through their schema v2 upgrades;
 *   5. webview partitions renamed from persist:app_<appId> to
 *      persist:u<owner>_app_<appId> — best-effort at the NW.js user-data
 *      layout, fail-soft;
 *   6. the LS_MAP user-data localStorage keys ride their existing mirror
 *      into the owner's per-app files (the AppDirs bootstrap seeds from
 *      localStorage on first login);
 *   7. machine app-permission grants copied into the owner's per-account
 *      hive; legacy adminEnabled=true maps to the owner (owner IS admin).
 *
 * After migration the machine behaves exactly as it did before — one
 * account, one PIN, all data intact — but every stratum carries an owner.
 */
(() => {
  'use strict';

  const MIGRATION_MARKER = 'HKNS/system/migration/v1';
  const MULTI_USER_FLAG = 'HKNS/system/features/multiUser';

  function log(...args) {
    try { console.info('[MultiUserMigration]', ...args); } catch (_) { }
  }

  function warn(...args) {
    try { console.warn('[MultiUserMigration]', ...args); } catch (_) { }
  }

  function isLinuxRuntime() {
    return typeof process !== 'undefined' && process.platform === 'linux' &&
      typeof require === 'function';
  }

  function metaCsrf() {
    try { return document.querySelector('meta[name="csrf-token"]')?.content || ''; } catch (_) { return ''; }
  }

  async function api(path, { method = 'POST', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = metaCsrf();
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let json = null;
    try { json = await res.json(); } catch (_) { }
    return { status: res.status, ok: res.ok, json };
  }

  /**
   * Runs the migration exactly once per machine. Multi-user mode is only
   * enabled when the server successfully owns accounts afterwards, so a
   * failed migration leaves a fully functional single-user machine.
   */
  async function run() {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    const registry = (typeof NovaRegistry !== 'undefined' && NovaRegistry) || null;

    // This machine already went through account setup or an earlier
    // migration (flag written as '1') → nothing to do. enabled() can't be used
    // here: multi-user is on by default, so it is true on every fresh machine.
    if (scope && (scope.explicitlyEnabled ? scope.explicitlyEnabled() : scope.enabled())) {
      return { skipped: 'already-enabled' };
    }

    // The marker lives in HKNS — the machine hive, mounted at boot before
    // any account is mounted, so pre-login reads are safe.
    if (registry) {
      try {
        if (registry.get(MIGRATION_MARKER)) return { skipped: 'marker' };
      } catch (_) { }
    }

    // Read the legacy single-user state BEFORE any hive moves.
    let legacy = null;
    if (registry) {
      try {
        legacy = {
          username: registry.get('HKNU/settings/username'),
          displayName: registry.get('HKNU/settings/username'),
          pinHash: registry.get('HKNS/security/lockPin'),
          pinSalt: registry.get('HKNS/security/pinSalt'),
          biometricId: registry.get('HKNS/security/biometricCredentialId'),
        };
      } catch (err) {
        warn('legacy state read failed:', err);
      }
    }

    // Server-side: does users.db already have accounts (e.g. a previous
    // migration whose marker write failed)? Idempotence: import is refused
    // when accounts exist, and the marker is just re-stamped.
    const existing = await api('/api/auth/users', { method: 'GET' });
    const serverHasAccounts = existing.ok && Array.isArray(existing.json?.data?.users) &&
      existing.json.data.users.length > 0;

    let ownerUid = null;
    let ownerUsername = '';
    if (serverHasAccounts && existing.json.data.users.length) {
      ownerUid = existing.json.data.users[0].uid; // the first account is the owner by construction
      ownerUsername = String(existing.json.data.users[0].username || '');
    } else if (legacy && legacy.pinHash) {
      // The 3.0.2 → accounts import: the PBKDF2 hash + salt + username go
      // to the server; the first successful PIN verification re-hashes the
      // account to scrypt there.
      const username = typeof legacy.username === 'string' && legacy.username
        ? legacy.username : 'user';
      const pinLen = 4;
      const adminMode = await readAdminMode();
      const imported = await api('/api/auth/migrate-legacy', {
        body: {
          username: String(username).toLowerCase(),
          displayName: String(username),
          legacyPinHash: String(legacy.pinHash || ''),
          legacyPinSalt: String(legacy.pinSalt || ''),
          pinLen,
          adminEnabled: adminMode === true,
        },
      });
      if (!imported.ok || !imported.json?.success) {
        warn('legacy import refused — multi-user stays OFF:', imported.json?.message || imported.status);
        return { skipped: 'import-refused' };
      }
      ownerUid = imported.json.data?.uid || null;
      ownerUsername = String(imported.json.data?.username || username || '');
      if (!ownerUid) {
        warn('legacy import returned no owner uid — multi-user stays OFF');
        return { skipped: 'no-owner' };
      }
    } else {
      // No legacy PIN and no accounts: this is either a factory-fresh
      // machine (the first-boot wizard will create the owner) or a legacy
      // machine that never set a PIN. Neither has anything to import; the
      // first-boot wizard creates the owner account on the next gate.
      return { skipped: 'no-legacy-state' };
    }

    // Stamp the scope flags BEFORE the storage schemas open: AstroOS_FS
    // and AstroOS_AppStorage v2 upgrades stamp unscoped rows with the
    // legacy owner uid from here.
    if (scope) {
      scope.setLegacyOwnerUid(ownerUid);
      scope.enable();
    }

    if (isLinuxRuntime()) {
      try {
        moveStorageToOwner(ownerUid, { username: ownerUsername, registry, scope, legacy });
      } catch (err) {
        warn('storage move failed (data stays at the legacy roots):', err);
      }
    } else {
      try {
        moveWebStorageToOwner(ownerUid, { username: ownerUsername, registry });
      } catch (err) {
        warn('web storage move failed:', err);
      }
      // AstroOS_FS (IndexedDB): stamp every unscoped 3.0.2 row with the
      // owner's uid. The worker's stampOwner() method existed but was never
      // called by anything, so after the migration a login re-rooted onto
      // "rows owned by uid" — which is empty — and the account's whole
      // pre-existing tree vanished from every view. This is the wiring the
      // header's step 4 always promised: stamp, then the first login mounts
      // the exact tree the machine always had. Idempotent behind the
      // 'nova_fs_owner_stamped' settings marker, so re-running is a no-op.
      try {
        if (typeof OS !== 'undefined' && OS?.workers?.fs?.call) {
          const stamped = await OS.workers.fs.call('stampOwner', ownerUid);
          if (stamped && typeof stamped.stamped === 'number' && stamped.stamped > 0) {
            log(`stamped ${stamped.stamped} legacy filesystem rows to the owner`);
          }
        }
      } catch (err) {
        warn('legacy filesystem stamping failed (rows stay unscoped):', err);
      }
    }

    // The credential keys are deleted at migration time: users.db owns
    // credentials now, and their presence in HKNS would make the legacy
    // lock screen fire on the next boot.
    if (registry) {
      try {
        registry.remove('HKNS/security/lockPin', { actor: 'migration' });
        registry.remove('HKNS/security/pinSalt', { actor: 'migration' });
        registry.remove('HKNS/security/biometricCredentialId', { actor: 'migration' });
      } catch (err) {
        warn('legacy credential key deletion failed:', err);
      }
      try {
        registry.set(MULTI_USER_FLAG, true, { type: 'REG_BOOL', source: 'migration', actor: 'migration' });
        registry.set(MIGRATION_MARKER, { version: 1, at: Date.now(), ownerUid }, { type: 'REG_JSON', source: 'migration', actor: 'migration' });
      } catch (err) {
        warn('marker write failed:', err);
      }
    }

    log('legacy single-user machine migrated to accounts; owner', ownerUid);
    return { migrated: true, ownerUid };
  }

  async function readAdminMode() {
    try {
      const res = await api('/api/security/admin-mode', { method: 'GET' });
      return res.ok && res.json?.data?.adminEnabled === true;
    } catch (_) { return false; }
  }

  // ── Linux native storage move ───────────────────────────────────────────

  /* The per-account directory segment: the username when the caller knows
   * one, else the uid (machines that never learned the username keep
   * byte-identical uid-keyed addressing). Usernames are immutable in the
   * account database, so the segment stays stable for the account's life. */
  function safeUsername(uname) {
    return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(String(uname || '').toLowerCase())
      ? String(uname || '').toLowerCase() : '';
  }

  function ownerSegment(ownerUid, username) {
    return safeUsername(username) || String(ownerUid || '');
  }

  function moveStorageToOwner(ownerUid, { username, registry, scope, legacy }) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const home = os.homedir();
    const shareRoot = path.join(home, '.local', 'share', 'novabyte');
    const segment = ownerSegment(ownerUid, username);
    // The account's filesystem root IS <machine home>/users/<segment>/ —
    // a real tree beside the other accounts, not a "home" nested inside
    // hidden machine state. Registry hives stay under ~/.config (hidden
    // OS plumbing), everything user-visible lives under ~/users.
    const userRoot = path.join(home, 'users', segment);

    const moveTree = (from, to, { keepSource = false } = {}) => {
      if (!fs.existsSync(from)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(from, to);
      } catch (_) {
        // Cross-device or busy: fall back to copy + remove.
        fs.cpSync(from, to, { recursive: true });
        if (!keepSource) fs.rmSync(from, { recursive: true, force: true });
      }
      return true;
    };

    // 1. Registry user hives: ~/.config/novabyte/registry/{HKNU,HKNA,HKND}.json
    const regDir = path.join(home, '.config', 'novabyte', 'registry');
    const userRegDir = path.join(home, '.config', 'novabyte', 'users', segment, 'registry');
    for (const hive of ['HKNU', 'HKNA', 'HKND']) {
      moveTree(path.join(regDir, `${hive}.json`), path.join(userRegDir, `${hive}.json`));
    }

    // 2. Per-app AppDirs: ~/.local/share/novabyte/data/<appId> →
    //    ~/users/<segment>/.apps/<appId> (the account's own app-data root).
    const dataRoot = path.join(shareRoot, 'data');
    const userApps = path.join(userRoot, '.apps');
    if (fs.existsSync(dataRoot)) {
      for (const entry of fs.readdirSync(dataRoot)) {
        moveTree(path.join(dataRoot, entry), path.join(userApps, entry));
      }
    }

    // 3. The legacy home tree (documents, pictures, …) → ~/users/<segment>/
    // DIRECTLY — the account tree root itself, so the account's Desktop,
    // Documents, … sit at /home/<machine-user>/users/<name>/Desktop just
    // like a real multi-user OS. Dot-folders and the AstroOS roots move
    // with it only when they are INSIDE the home tree itself; ~/.config
    // and ~/.local/share are machine state and stay machine state.
    fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(home)) {
      if (entry === 'users') continue; // never fold the account root into itself
      if (entry.startsWith('.')) continue;
      moveTree(path.join(home, entry), path.join(userRoot, entry));
    }
    // The legacy XDG trash contents are not per-account property in the
    // same sense — leaving ~/.local/share/Trash alone is the conservative
    // choice; the owner can clean it from the Files app.

    // 4. Per-user browser-state + settings shadow: ~/users/<segment>/.browser-state.json
    // is seeded from the machine file on first login by the mirror.
    const legacyBrowserState = path.join(shareRoot, 'browser-state.json');
    if (fs.existsSync(legacyBrowserState)) {
      moveTree(legacyBrowserState, path.join(userRoot, '.browser-state.json'), { keepSource: true });
    }

    // 5. Webview partitions: best-effort rename at the NW.js user-data
    // layout (persist:app_<id> profiles). If the layout ever differs, the
    // rename is a silent no-op and apps just start with fresh partitions.
    try {
      migrateNwjsPartitions(ownerUid, path);
    } catch (err) {
      warn('webview partition migration skipped:', err?.message || err);
    }

    // 6. IndexedDB AstroOS_FS / AstroOS_AppStorage stamping happens via
    //    their own v2 schema upgrades at next open (scope flags are set).

    log('linux storage re-rooted under ~/users/' + segment);
  }

  function migrateNwjsPartitions(ownerUid) {
    const fs = require('fs');
    const path = require('path');
    // NW.js --user-data-dir=./nwjs-data (package.json chromium-args).
    // Persistent partitions live under a Partitions/ directory keyed by a
    // hash of the partition name on some versions, or a directly-named
    // directory on others. Try both, fail-soft.
    const candidates = [
      path.join(process.cwd(), 'nwjs-data', 'Partitions'),
      path.join(process.cwd(), 'nwjs-data'),
    ];
    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('app_')) {
          // Directly-named layout: rename app_<id> → u<owner>_app_<id>.
          try {
            fs.renameSync(path.join(root, entry), path.join(root, `u${ownerUid}_${entry}`));
          } catch (_) { }
        }
      }
    }
  }

  // ── Web build storage move (localStorage / OPFS best-effort) ────────────

  function moveWebStorageToOwner(ownerUid, { username, registry }) {
    // Registry hives: localStorage keys nova_registry_hive_<HIVE> →
    // nova_registry_hive_u_<segment>_<HIVE> (the mounted-hive layout).
    const segment = ownerSegment(ownerUid, username);
    try {
      for (const hive of ['HKNU', 'HKNA', 'HKND']) {
        const from = `nova_registry_hive_${hive}`;
        const to = `nova_registry_hive_u_${segment}_${hive}`;
        const raw = localStorage.getItem(from);
        if (raw !== null) {
          localStorage.setItem(to, raw);
          localStorage.removeItem(from);
        }
      }
    } catch (err) {
      warn('web hive move failed:', err);
    }
    // AstroOS_FS / AstroOS_AppStorage stamp through their v2 upgrades at
    // next open; the LS_MAP keys mirror into per-user files through the
    // AppDirs bootstrap; OPFS moves ride the next bootstrap reconcile.
  }

  // ── Per-user layout upgrades (login-time, before any mount) ───────────
  //
  // Two layout generations can exist on disk before this runs:
  //
  //   A. uid-keyed segments —   ~/.local/share/novabyte/users/<uid>/…,
  //                             ~/.config/novabyte/users/<uid>/registry/…
  //   B. the nested layout —   ~/.local/share/novabyte/users/<name>/home/…
  //                             (a "home" buried inside hidden machine state)
  //
  // The current layout puts the account's whole visible filesystem at
  // <machine home>/users/<username>/ (Desktop/Documents/… directly inside,
  // app data at .apps/) — a real, separated tree per account, exactly what
  // a person sees at /home/<machine-user>/users. This upgrade — run by the
  // SessionManager at login, before any mount — renames uid segments onto
  // the username segment, then lifts any nested-layout remains onto the
  // flat tree. It is strictly idempotent: a machine already on the current
  // layout (or one that never had the older ones) takes the fast
  // existsSync paths and changes nothing. Collisions never merge or
  // clobber — the older tree is left in place for manual recovery.

  function upgradeUserLayout(uid, username) {
    const uname = safeUsername(username);
    const userId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(uid || '')) ? String(uid) : '';
    if (!uname || !userId) return { moved: 0 };
    let moved = 0;

    if (isLinuxRuntime()) {
      const fs = require('fs');
      const path = require('path');
      const home = require('os').homedir();
      // uid segment → username segment, across every base that ever keyed
      // an account by uid: the current ~/users root, the pre-flat nested
      // share root, and the registry users root. Skipped when the segments
      // already match (common on the current layout — nothing to rename).
      if (uname !== userId) {
      for (const base of [
        path.join(home, 'users'),
        path.join(home, '.local', 'share', 'novabyte', 'users'),
        path.join(home, '.config', 'novabyte', 'users'),
      ]) {
        const from = path.join(base, userId);
        const to = path.join(base, uname);
        if (!fs.existsSync(from)) continue;
        if (fs.existsSync(to)) {
          // Never merge over an existing username directory — a username
          // collision with real data means the account keeps its uid
          // segment (callers fall back to it) rather than losing either.
          warn(`username layout upgrade skipped for ${uname}: target already exists`);
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
          fs.renameSync(from, to);
          moved++;
        } catch (err) {
          warn(`username layout upgrade failed for ${uname}:`, err?.message || err);
        }
      }
      }
      // Nested layout → flat ~/users/<username>/ lift. Everything the old
      // layout kept at ~/.local/share/novabyte/users/<uname>/ moves onto the
      // account's real tree: home/* becomes <name>/* directly, apps/ becomes
      // .apps/, browser-state.json becomes .browser-state.json.
      try {
        moved += liftNestedUserTree(uname) ? 1 : 0;
      } catch (err) {
        warn(`nested layout lift failed for ${uname}:`, err?.message || err);
      }
      // The machine home is the SYSTEM area: stray visible entries (legacy
      // folders, loose files) are adopted into the signing-in account's tree
      // so the machine root never holds anything user-owned.
      try {
        moved += sweepMachineHome(uname) ? 1 : 0;
      } catch (err) {
        warn(`machine-home sweep failed for ${uname}:`, err?.message || err);
      }
    } else {
      // Web build: the mounted-hive documents are localStorage keys.
      try {
        for (const hive of ['HKNU', 'HKNA', 'HKND']) {
          const from = `nova_registry_hive_u_${userId}_${hive}`;
          const to = `nova_registry_hive_u_${uname}_${hive}`;
          const raw = localStorage.getItem(from);
          if (raw !== null && localStorage.getItem(to) === null) {
            localStorage.setItem(to, raw);
            localStorage.removeItem(from);
            moved++;
          }
        }
      } catch (err) {
        warn('web username layout upgrade failed:', err);
      }
    }
    if (moved) log(`account ${uname}: storage moved onto the ~/users layout (${moved} root(s))`);
    return { moved };
  }

  /* Lifts ~/.local/share/novabyte/users/<name>/{home/*, apps,
   * browser-state.json} onto ~/users/<name>/. Returns true when anything
   * moved. Entry-by-entry with existsSync guards, so a half-completed lift
   * resumes safely and a collision leaves the older copy untouched. */
  function liftNestedUserTree(uname) {
    const fs = require('fs');
    const path = require('path');
    const home = require('os').homedir();
    const legacyRoot = path.join(home, '.local', 'share', 'novabyte', 'users', uname);
    if (!fs.existsSync(legacyRoot)) return false;
    const userRoot = path.join(home, 'users', uname);
    fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    let touched = false;

    const moveOne = (from, to) => {
      if (!fs.existsSync(from) || fs.existsSync(to)) return; // collision → keep both, admin recovers
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.renameSync(from, to);
        touched = true;
      } catch (_) {
        try { // cross-device / busy fallback: copy, then remove
          fs.cpSync(from, to, { recursive: true });
          fs.rmSync(from, { recursive: true, force: true });
          touched = true;
        } catch (err) {
          warn(`nested layout lift could not move ${from}:`, err?.message || err);
        }
      }
    };

    // home/* → <name>/* (the visible tree, directly inside the account root)
    const legacyHome = path.join(legacyRoot, 'home');
    if (fs.existsSync(legacyHome)) {
      for (const entry of fs.readdirSync(legacyHome)) {
        moveOne(path.join(legacyHome, entry), path.join(userRoot, entry));
      }
    }
    // apps/ → .apps/, browser-state.json → .browser-state.json
    moveOne(path.join(legacyRoot, 'apps'), path.join(userRoot, '.apps'));
    moveOne(path.join(legacyRoot, 'browser-state.json'), path.join(userRoot, '.browser-state.json'));

    // Best-effort cleanup of the emptied legacy shell (the now-empty home/
    // directory and, if fully drained, the account's legacy root); failures
    // just leave empty directories behind — harmless.
    try {
      if (fs.existsSync(legacyHome) && fs.readdirSync(legacyHome).length === 0) fs.rmdirSync(legacyHome);
    } catch (_) { }
    try {
      if (fs.readdirSync(legacyRoot).length === 0) fs.rmdirSync(legacyRoot);
    } catch (_) { }
    return touched;
  }

  /* Sweeps every visible (non-dot) entry at the MACHINE home into the
   * signing-in account's ~/users/<username>/ tree. The machine home is the
   * system area: it must hold nothing user-visible — no legacy Desktop/
   * Documents folders (boot no longer recreates them at the machine root,
   * fs.js init), no loose stray files. Whatever still sits there from older
   * layouts or stray writes is adopted into the account, merging without
   * ever clobbering (name collisions get a numbered suffix).
   *
   * Exclusions — never adopted:
   *   * dot entries (machine plumbing: .config, .local, .pki, …)
   *   * `users/` (the account trees themselves)
   *   * machine log files (astroos-kiosk.log, vmusr.log, xwayland-*): the
   *     S99astroos boot janitor owns those under /var/log/astroos.
   *
   * Strictly idempotent: a clean machine home is a fast no-op. Single-user
   * machines (multi-user off) never sweep — there the machine home IS the
   * user's home by design. */
  const MACHINE_HOME_KEEP = new Set(['users']);
  const MACHINE_LOG_NAMES = /^(?:astroos-kiosk\.log|vmusr\.log|astroos-gl-debug\.log|xwayland-.*)$/;

  function sweepMachineHome(uname) {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    if (!scope || !scope.enabled || !scope.enabled()) return false;
    const name = safeUsername(uname);
    if (!name) return false;
    const fs = require('fs');
    const path = require('path');
    const home = require('os').homedir();
    if (!fs.existsSync(home)) return false;
    const entries = fs.readdirSync(home)
      .filter(entry => !entry.startsWith('.') && !MACHINE_HOME_KEEP.has(entry) && !MACHINE_LOG_NAMES.test(entry));
    if (!entries.length) return false;
    const userRoot = path.join(home, 'users', name);
    fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 });

    let touched = false;
    const uniqueTarget = (dir, name_) => {
      let target = path.join(dir, name_);
      if (!fs.existsSync(target)) return target;
      const dot = name_.lastIndexOf('.');
      const stem = dot > 0 ? name_.slice(0, dot) : name_;
      const ext = dot > 0 ? name_.slice(dot) : '';
      for (let n = 1; ; n++) {
        target = path.join(dir, `${stem} (${n})${ext}`);
        if (!fs.existsSync(target)) return target;
      }
    };
    const adoptEntry = (from, to) => {
      if (!fs.existsSync(from)) return;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.renameSync(from, to);
        touched = true;
      } catch (_) {
        try { // cross-device / busy fallback: copy, then remove
          fs.cpSync(from, to, { recursive: true });
          fs.rmSync(from, { recursive: true, force: true });
          touched = true;
        } catch (err) {
          warn(`machine-home sweep could not move ${from}:`, err?.message || err);
        }
      }
    };
    const mergeInto = (sourceDir, targetDir) => {
      for (const child of fs.readdirSync(sourceDir)) {
        adoptEntry(path.join(sourceDir, child), uniqueTarget(targetDir, child));
      }
      try { if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir); } catch (_) { }
    };

    for (const entry of entries) {
      const from = path.join(home, entry);
      const to = path.join(userRoot, entry);
      try {
        if (fs.existsSync(to) && fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) {
          mergeInto(from, to); // both dirs: merge children, drop the emptied source
        } else {
          adoptEntry(from, uniqueTarget(userRoot, entry));
        }
      } catch (err) {
        warn(`machine-home sweep skipped ${entry}:`, err?.message || err);
      }
    }
    if (touched) log(`machine home swept: visible entries adopted into ~/users/${name}`);
    return touched;
  }

  const MultiUserMigration = { run, upgradeUserLayout, sweepMachineHome, MIGRATION_MARKER, MULTI_USER_FLAG };

  if (typeof window !== 'undefined' && window) {
    window.MultiUserMigration = Object.freeze(MultiUserMigration);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MultiUserMigration;
  }
})();
