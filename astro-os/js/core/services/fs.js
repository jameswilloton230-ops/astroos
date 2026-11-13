const FS = {
  files: new Map(),             // Kept as a pure native Map for 100% external compatibility
  rootId: null,
  specialFolders: {},
  _childrenByParent: new Map(), // O(1) Fast folder-tree index tracking
  _searchTimeout: null,         // Debounce state holder

  // Internal high-performance helper to index items
  _indexFile(f) {
    if (!f || f.parentId === undefined) return;
    let parentMap = this._childrenByParent.get(f.parentId);
    if (!parentMap) {
      parentMap = new Map();
      this._childrenByParent.set(f.parentId, parentMap);
    }
    parentMap.set(f.id, f);
  },

  // Internal high-performance helper to clear items from index
  _unindexFile(id) {
    const f = this.files.get(id);
    if (!f || f.parentId === undefined) return;
    const parentMap = this._childrenByParent.get(f.parentId);
    if (parentMap) {
      parentMap.delete(id);
      if (parentMap.size === 0) this._childrenByParent.delete(f.parentId);
    }
  },

  /**
   * Multi-user: re-root the service onto one account's tree.
   * SessionManager-only surface — the FS service never discovers the
   * active account on its own. Single-user machines (multi-user mode
   * off) keep the byte-identical 3.0.2 behaviour: this is a no-op.
   */
  async setUserRoot(uid, options = {}) {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    if (!scope || !scope.enabled()) return false;
    if (options && options.guest) {
      // Guest trees are volatile and unique per session — never reused, and
      // previous sessions' rows are dead weight (their owner id can never
      // be re-mounted), so wipe them before minting the fresh one.
      try {
        await OS.workers.fs.call('purgeGuestOwners');
      } catch (err) {
        console.warn('[FS] Guest tree cleanup failed:', err);
      }
      await OS.workers.fs.call('setOwner', 'guest_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      await this.init();
      this._hideSharedForGuest();
    } else if (uid === null || uid === undefined || uid === '') {
      // Explicit teardown (logout / user switch): back to the MACHINE tree —
      // unscoped rows only. Previously a falsy uid fell back to the legacy
      // owner uid, so after logout the FS cache kept serving the departed
      // account's tree (and a guest desktop rode straight onto it) — the
      // "filesystem shared as one" leak. Nothing personal is mounted while
      // the picker is up; the next login re-roots onto the right account.
      await OS.workers.fs.call('setOwner', null);
      await this.init();
    } else {
      await OS.workers.fs.call('setOwner', String(uid));
      await this.init();
    }
    return true;
  },

  /**
   * Guests get no /Shared access (the native backend's jail-root rule): the
   * worker already excludes '__shared__' rows from guest mounts, so drop the
   * folder from this mount's cache too — createDefaultFS builds it before
   * the owner id exists to know better.
   */
  _hideSharedForGuest() {
    const sharedId = this.specialFolders.shared;
    if (!sharedId) return;
    const node = this.files.get(sharedId);
    if (node) {
      this._unindexFile(sharedId);
      this.files.delete(sharedId);
    }
    delete this.specialFolders.shared;
  },

  /** Creator of a /Shared entry, for the write-own-entries-only rule. */
  creatorOf(node) {
    return node && node.creator ? node.creator : null;
  },

  /**
   * Entries created under /Shared carry the '__shared__' owner (so every
   * account's mount sees them) and a creator stamp (so only the creator
   * account — or an admin — may modify or delete them).
   */
  _stampSharedEntry(node, parentId) {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    if (!scope || !scope.enabled() || !node) return node;
    const parent = this.files.get(parentId);
    const parentIsShared = parentId === this.specialFolders.shared ||
      (parent && (parent.ownerUid === '__shared__' || parentId === parent.id && parent.name === 'Shared' && parent.parentId === this.rootId));
    if (!parentIsShared) return node;
    // Guests never write into the cross-account drop box: without this a
    // guest-created entry would ride the '__shared__' owner into every
    // account's tree (the native backend already excludes /Shared from a
    // guest's jail roots — setUserRoot hides the folder from guest mounts).
    if (scope.uid() === 'guest') {
      throw new Error('Guest sessions cannot write to the shared drop box');
    }
    node.ownerUid = '__shared__';
    node.creator = scope.uid() || '__anonymous__';
    return node;
  },

  /**
   * /Shared rule: every account reads it; each account writes and
   * deletes only its own entries; admins administer it outright. Files
   * land there through an explicit share action, not ambient access.
   */
  assertSharedWriteAllowed(node) {
    if (!node) return;
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    if (!scope || !scope.enabled()) return;
    if (scope.uid() === 'guest') {
      throw new Error('Guest sessions cannot write to the shared drop box');
    }
    const isSharedEntry = node.ownerUid === '__shared__';
    if (!isSharedEntry) return;
    const creator = this.creatorOf(node);
    if (creator === null || creator === '__system__') return; // folder itself
    if (creator === scope.uid() || scope.isActiveAdmin()) return;
    throw new Error('This /Shared entry belongs to another account');
  },

  async init() {
    try {
      const files = await OS.workers.fs.call('getAllFiles');
      this.files.clear();
      this._childrenByParent.clear();
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          this.files.set(f.id, f);
          this._indexFile(f);
        }
        this.findSpecialFolders();
        this._ensureSharedFolder();
      } else {
        await this.createDefaultFS();
      }
      this.updateSearchIndex();
    } catch (e) {
      console.warn('[FS] createDefaultFS failed, retrying once:', e);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'FS', category: 'filesystem', severity: 'error', message: `FS init failed, retrying: ${e?.message || e}` });
      }
      await this.createDefaultFS();
    }
  },

  /**
   * Self-heal for trees created before /Shared was persisted (createDefaultFS
   * used to build the node and then drop it from allFiles): on a multi-user
   * machine whose mounted tree has no Shared root child, create + persist
   * it now. Single-user machines (scope disabled) keep the exact 3.0.2 tree.
   */
  async _ensureSharedFolder() {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    if (!scope || !scope.enabled()) return;
    if (this.rootId === null || this.specialFolders.shared) return;
    const now = Date.now();
    const shared = {
      id: generateId(), name: 'Shared', type: 'folder', parentId: this.rootId,
      content: null, blobKey: null, size: 0, mimeType: 'inode/directory',
      created: now, modified: now, accessed: now,
      permissions: { read: true, write: true, execute: true },
      tags: [], sha256: null, icon: null,
      ownerUid: '__shared__', creator: '__system__',
    };
    this.files.set(shared.id, shared);
    this._indexFile(shared);
    this.specialFolders.shared = shared.id;
    await OS.workers.fs.call('putFiles', [shared]);
  },

  findSpecialFolders() {
    for (const [id, f] of this.files) {
      if (f.parentId === null && f.type === 'folder') { 
        this.rootId = id; 
        break; 
      }
    }
    if (this.rootId === null) return;

    const rootChildren = this._childrenByParent.get(this.rootId);
    if (rootChildren) {
      for (const f of rootChildren.values()) {
        const name = f.name.toLowerCase();
        switch (name) {
          case 'desktop': this.specialFolders.desktop = f.id; break;
          case 'documents': this.specialFolders.documents = f.id; break;
          case 'downloads': this.specialFolders.downloads = f.id; break;
          case 'music': this.specialFolders.music = f.id; break;
          case 'pictures': this.specialFolders.pictures = f.id; break;
          case 'videos': this.specialFolders.videos = f.id; break;
          case 'trash': this.specialFolders.trash = f.id; break;
          case 'shared': this.specialFolders.shared = f.id; break;
        }
      }
    }
  },

  async createDefaultFS() {
    const now = Date.now();
    const mkNode = (name, type, parentId, content, mime) => ({
      id: generateId(), name, type, parentId,
      content: content || null, blobKey: null,
      size: content ? new Blob([content]).size : 0,
      mimeType: mime || (type === 'folder' ? 'inode/directory' : 'text/plain'),
      created: now, modified: now, accessed: now,
      permissions: { read: true, write: true, execute: false },
      tags: [], sha256: null, icon: null
    });

    const root = mkNode('/', 'folder', null);
    this.rootId = root.id;

    const desktop = mkNode('Desktop', 'folder', root.id);
    const documents = mkNode('Documents', 'folder', root.id);
    const downloads = mkNode('Downloads', 'folder', root.id);
    const music = mkNode('Music', 'folder', root.id);
    const pictures = mkNode('Pictures', 'folder', root.id);
    const videos = mkNode('Videos', 'folder', root.id);
    const trash = mkNode('Trash', 'folder', root.id);
    const screenshots = mkNode('Screenshots', 'folder', pictures.id);
    // The cross-account drop box rides the owner-scoped store under the
    // '__shared__' pseudo-owner: visible to every account, ownership-
    // tracked by the FS service layer (see assertSharedWriteAllowed).
    // PERSISTED here too — the node used to be built and then dropped from
    // allFiles, so no account's tree ever contained a /Shared folder and
    // the feature was unreachable on the virtual backend.
    const shared = mkNode('Shared', 'folder', root.id);
    shared.ownerUid = '__shared__';
    shared.creator = '__system__';

    const allFiles = [root, desktop, documents, downloads, music, pictures, videos, trash, screenshots, shared];

    this.files.clear();
    this._childrenByParent.clear();
    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      this.files.set(f.id, f);
      this._indexFile(f);
    }

    this.specialFolders = {
      desktop: desktop.id, documents: documents.id, downloads: downloads.id,
      music: music.id, pictures: pictures.id, videos: videos.id, trash: trash.id,
      shared: shared.id
    };

    await OS.workers.fs.call('putFiles', allFiles);
  },

  listDir(folderId) {
    const parentMap = this._childrenByParent.get(folderId);
    if (!parentMap) return [];
    
    const children = Array.from(parentMap.values());
    return children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  },

  // Given a desired name for a new/moved child of parentId, returns a name
  // that doesn't collide with an existing sibling — appending " (1)",
  // " (2)", etc. before the last extension until one is free. Shared by
  // any caller that creates, copies, or moves files/folders (the Files
  // app and the desktop's empty-area "New File"/"New Folder" menu), so
  // none of them silently produce two siblings with the same name.
  // Pass excludeId when checking a node that may already be a sibling of
  // parentId (e.g. moving it within the same folder), so it isn't
  // compared against itself.
  uniqueName(parentId, name, excludeId) {
    const siblings = new Set(
      this.listDir(parentId)
        .filter(f => f.id !== excludeId)
        .map(f => f.name)
    );
    if (!siblings.has(name)) return name;

    const dot = name.lastIndexOf('.');
    // No extension, or a leading dot (e.g. ".gitignore") — treat as no extension.
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext  = hasExt ? name.slice(dot) : '';

    let i = 1;
    let candidate;
    do {
      candidate = `${base} (${i})${ext}`;
      i++;
    } while (siblings.has(candidate));
    return candidate;
  },

  getPath(id) {
    const parts = [];
    let node = this.files.get(id);
    while (node) {
      if (node.parentId === null) break;
      parts.push(node.name); 
      node = this.files.get(node.parentId);
    }
    return '/' + parts.reverse().join('/');
  },

  getByPath(path) {
    if (path === '/') return this.files.get(this.rootId);
    const parts = path.split('/');
    let current = this.rootId;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      
      const parentMap = this._childrenByParent.get(current);
      if (!parentMap) return null;
      
      let found = null;
      for (const c of parentMap.values()) {
        if (c.name === part) {
          found = c;
          break;
        }
      }
      if (!found) return null;
      current = found.id;
    }
    return this.files.get(current);
  },

  async createFile(parentId, name, content, mimeType) {
    const node = {
      id: generateId(), name, type: 'file', parentId,
      content: content || '', blobKey: null,
      size: content ? new Blob([content]).size : 0,
      mimeType: mimeType || 'text/plain',
      created: Date.now(), modified: Date.now(), accessed: Date.now(),
      permissions: { read: true, write: true, execute: false },
      tags: [], sha256: null, icon: null
    };
    this._stampSharedEntry(node, parentId);
    this.files.set(node.id, node);
    this._indexFile(node);
    await OS.workers.fs.call('putFiles', [node]);
    this.updateSearchIndex();
    OS.events.emit('fs:created', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'info', message: `Created file ${name}`, data: { id: node.id, parentId, mimeType: node.mimeType } });
    }
    return node;
  },

  async createFolder(parentId, name) {
    const node = {
      id: generateId(), name, type: 'folder', parentId,
      content: null, blobKey: null, size: 0,
      mimeType: 'inode/directory',
      created: Date.now(), modified: Date.now(), accessed: Date.now(),
      permissions: { read: true, write: true, execute: true },
      tags: [], sha256: null, icon: null
    };
    this._stampSharedEntry(node, parentId);
    this.files.set(node.id, node);
    this._indexFile(node);
    await OS.workers.fs.call('putFiles', [node]);
    OS.events.emit('fs:created', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'info', message: `Created folder ${name}`, data: { id: node.id, parentId } });
    }
    return node;
  },

  async writeFile(id, content, mimeType) {
    const node = this.files.get(id);
    if (!node) return null;
    this.assertSharedWriteAllowed(node);
    node.content = content;
    if (typeof mimeType === 'string' && mimeType) node.mimeType = mimeType;
    node.size = new Blob([content]).size;
    node.modified = Date.now();
    try { node.sha256 = await OS.workers.crypto.call('sha256', content); } catch (e) { }
    await OS.workers.fs.call('putFiles', [node]); 
    this.updateSearchIndex();
    OS.events.emit('fs:updated', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'info', message: `Wrote content to ${node.name}`, data: { id, size: node.size } });
    }
    return node;
  },

  async rename(id, newName) {
    const node = this.files.get(id);
    if (!node) return null;
    this.assertSharedWriteAllowed(node);
    const oldName = node.name;
    if (oldName === newName) return node;
    const siblings = this.listDir(node.parentId);
    const collision = siblings.find(f => f.name === newName && f.id !== id);
    if (collision) {
      const err = new Error(`A file or folder named "${newName}" already exists in this location.`);
      err.code = 'EEXIST';
      throw err;
    }
    node.name = newName;
    node.modified = Date.now();
    await OS.workers.fs.call('putFiles', [node]);
    OS.events.emit('fs:updated', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'info', message: `Renamed ${oldName} → ${newName}`, data: { id, oldName, newName } });
    }
    return node;
  },

  async move(id, newParentId) {
    const node = this.files.get(id);
    if (!node) return null;
    this.assertSharedWriteAllowed(node);
    this._unindexFile(id);
    node.parentId = newParentId;
    node.modified = Date.now();
    this._indexFile(node);
    await OS.workers.fs.call('putFiles', [node]);
    OS.events.emit('fs:moved', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'info', message: `Moved ${node.name}`, data: { id, newParentId } });
    }
    return node;
  },

  // Recursively copies a file or folder node (and, for folders, every
  // descendant) into destParentId. Shared by any paste implementation
  // (Files app, desktop context menu) so copying a folder always produces
  // a real folder with its contents, not a flattened file.
  //
  // name collisions: only the top-level copy needs a name override —
  // pass one in via `name` if the caller already deduped it with
  // uniqueName(). Recursive calls always target a folder just created
  // fresh, so its children can never already have a same-named sibling.
  async copyNodeInto(node, destParentId, name) {
    const finalName = name ?? node.name;
    if (node.type === 'folder') {
      const newFolder = await this.createFolder(destParentId, finalName);
      for (const child of this.listDir(node.id)) {
        await this.copyNodeInto(child, newFolder.id);
      }
      return newFolder;
    }
    return this.createFile(destParentId, finalName, node.content, node.mimeType);
  },

  // Performs a full cut/copy paste of `clip` ({ type: 'cut'|'copy', fileId })
  // into destParentId, deduping names against existing siblings. Shared by
  // the Files app and the desktop's empty-area context menu so "Paste"
  // behaves identically everywhere instead of each caller reimplementing
  // move/copy semantics. Returns the pasted/moved node, or null if there
  // was nothing valid to paste.
  async pasteInto(clip, destParentId) {
    if (!clip?.fileId) return null;
    const src = this.files.get(clip.fileId);
    if (!src) return null;

    if (clip.type === 'cut') {
      // Dedupe against the destination's existing children (excluding src
      // itself, in case it's a same-folder move-in-place) and rename BEFORE
      // moving, so the node never transiently shares a name with a sibling
      // and lands exactly once — the same contract the linux-native backend
      // enforces by moving straight to the deduped name.
      const finalName = this.uniqueName(destParentId, src.name, src.id);
      if (finalName !== src.name) await this.rename(src.id, finalName);
      await this.move(src.id, destParentId);
      return src;
    }

    const finalName = this.uniqueName(destParentId, src.name);
    return this.copyNodeInto(src, destParentId, finalName);
  },

  async deleteToTrash(id) {
    const node = this.files.get(id);
    if (!node) return;
    this.assertSharedWriteAllowed(node);
    this._unindexFile(id);
    node._originalParent = node.parentId;
    node.parentId = this.specialFolders.trash;
    node.modified = Date.now();
    this._indexFile(node);
    await OS.workers.fs.call('putFiles', [node]);
    OS.events.emit('fs:deleted', node);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'warn', message: `Moved ${node.name} to Trash`, data: { id } });
    }
  },

  async permanentDelete(id) {
    const node = this.files.get(id);
    if (!node) return;
    this.assertSharedWriteAllowed(node);
    if (node.type === 'folder') {
      const parentMap = this._childrenByParent.get(id);
      if (parentMap) {
        const childIds = Array.from(parentMap.keys());
        for (let i = 0; i < childIds.length; i++) {
          await this.permanentDelete(childIds[i]);
        }
      }
    }
    this._unindexFile(id);
    this.files.delete(id);
    await OS.workers.fs.call('deleteFile', id);
    OS.events.emit('fs:deleted', { id });
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'FS', category: 'filesystem', severity: 'warn', message: `Permanently deleted ${node.name}`, data: { id, type: node.type } });
    }
  },

  async emptyTrash() {
    const parentMap = this._childrenByParent.get(this.specialFolders.trash);
    if (!parentMap) return;
    const childIds = Array.from(parentMap.keys());
    for (let i = 0; i < childIds.length; i++) {
      await this.permanentDelete(childIds[i]);
    }
  },

  updateSearchIndex() {
    if (this._searchTimeout) clearTimeout(this._searchTimeout);
    
    this._searchTimeout = setTimeout(() => {
      const MAX_CONTENT = 50_000;
      const files = [];
      
      for (const f of this.files.values()) {
        files.push({
          id: f.id,
          name: f.name || '',
          content: typeof f.content === 'string' ? f.content.slice(0, MAX_CONTENT) : ''
        });
      }
      OS.workers.search.call('buildIndex', files).catch(() => { });
    }, 150);
  },

  async search(query) {
    try {
      const files = [];
      for (const f of this.files.values()) files.push(f);
      return await OS.workers.search.call('search', query, files);
    } catch (e) { return []; }
  },

  getMimeIcon(mimeType, name) {
    if (!mimeType) return 'file';
    if (mimeType === 'inode/directory') return 'folder';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'music';
    if (mimeType.startsWith('video/')) return 'file';
    if (mimeType === 'application/pdf') return 'file-text';
    return (name && name.endsWith('.md')) ? 'file-text' : 'file-text';
  }
};

if (typeof process !== 'undefined' && process.platform === 'linux') {
  const nativeFs = require('fs');
  const nativePath = require('path');
  const nativeOs = require('os');
  // ── Per-user scoping (multi-user mode) ─────────────────────────────
  // Default roots match 3.0.2 byte-for-byte: single-user machines (and
  // any pre-login phase) keep exactly today's layout, because
  // setUserRoot() is only ever called by the SessionManager, and only
  // after a successful account login. When it IS called, the active
  // account's filesystem IS <machine home>/users/<username>/ — a real,
  // separately-rooted tree beside the other accounts (users/sam/,
  // users/ada/…), not a "home inside the machine home" buried under
  // ~/.local/share. Its Trash and per-app data (.apps) live inside it,
  // and the machine-wide /Shared drop box joins the jail as a second
  // legal root.
  const machineHome = nativePath.resolve(nativeOs.homedir());
  const usersRoot = nativePath.join(machineHome, 'users');
  const sharedRoot = nativePath.join(machineHome, '.local', 'share', 'novabyte', 'shared');
  const defaultTrashPath = nativePath.join(machineHome, '.local', 'share', 'Trash', 'files');
  const defaultAppDataRoot = nativePath.join(machineHome, '.local', 'share', 'novabyte', 'data');
  let home = machineHome;
  let homePrefix = home.endsWith(nativePath.sep) ? home : home + nativePath.sep;
  let trashPath = defaultTrashPath;
  let appDataRoot = defaultAppDataRoot;
  let allowedRoots = [home];
  let scopedUser = '';
  let guestRoots = false;

  /* The on-disk segment for an account: the USERNAME (users/sam/),
   * matching what a person sees when they open /home/<linux-user>/users.
   * Usernames are immutable in the account database, so the segment is
   * stable; accounts created under earlier layouts (users/<uid>, or the
   * nested users/<name>/home tree) are renamed/lifted onto this layout by
   * the SessionManager's login-time upgrade before any root is applied. */
  const safeUsername = (uname) =>
    /^[a-z0-9][a-z0-9._-]{2,31}$/.test(String(uname || '').toLowerCase())
      ? String(uname || '').toLowerCase() : '';

  /* Per-account roots. Accounts live at ~/users/<username>/ with the
   * standard folders directly inside it. Guest sessions are volatile and
   * never real accounts, so they stay under the hidden machine state tree
   * (~/.local/share/novabyte/guest/<g-id>) where they never pollute users/. */
  const userRootsFor = (segment, guest) => {
    const base = guest
      ? nativePath.join(machineHome, '.local', 'share', 'novabyte', 'guest', `g-${Date.now().toString(36)}`)
      : nativePath.join(usersRoot, safeUsername(segment) || String(segment || ''));
    return { home: base, apps: nativePath.join(base, '.apps') };
  };

  const applyRoots = (newHome, uid, { scoped = false, guest = false } = {}) => {
    home = nativePath.resolve(newHome);
    homePrefix = home.endsWith(nativePath.sep) ? home : home + nativePath.sep;
    scopedUser = scoped ? String(uid) : '';
    guestRoots = guest;
    if (scoped || guest) {
      // The account tree owns its Trash and its app data directly: both
      // are first-class children of ~/users/<name>/ (.apps is dot-hidden
      // from listings, exactly like ~/.local on a real Linux home).
      trashPath = nativePath.join(home, 'Trash');
      appDataRoot = nativePath.join(home, '.apps');
      allowedRoots = scoped ? [home, appDataRoot, sharedRoot] : [home, appDataRoot]; // guests get no /Shared access
    } else {
      trashPath = defaultTrashPath;
      appDataRoot = defaultAppDataRoot;
      allowedRoots = [home];
    }
  };
  // The per-app data root — ~/users/<name>/.apps on multi-user machines
  // (the tree AppDirs bootstraps as .apps/<appId>/…), or the legacy
  // ~/.local/share/novabyte/data/<appId>/… on single-user machines.
  // The VFS exposes it as /data so sandboxed apps' appdata:/ and /data/
  // paths land in the account's own tree, hidden from listings.
  const oldVfsMigrated = nativePath.join(machineHome, '.local', 'share', 'novabyte', 'migration', 'vfs-imported');

  const assertUserPath = path => {
    const resolved = nativePath.resolve(path);
    const insideRoot = (root, target) =>
      target === root || target.startsWith(root.endsWith(nativePath.sep) ? root : root + nativePath.sep);
    if (!allowedRoots.some(root => insideRoot(root, resolved))) {
      throw new Error(`Filesystem operation is outside the user home directory: ${resolved}`);
    }
    let existingPath = resolved;
    while (!nativeFs.existsSync(existingPath) &&
           !allowedRoots.some(root => existingPath === nativePath.dirname(root))) {
      existingPath = nativePath.dirname(existingPath);
    }
    const realPath = nativeFs.realpathSync(existingPath);
    const realRoots = allowedRoots.map(root => {
      try { return nativeFs.existsSync(root) ? nativeFs.realpathSync(root) : root; } catch (_) { return root; }
    });
    if (!realRoots.some(root => insideRoot(root, realPath))) {
      throw new Error(`Filesystem operation traverses a path outside the user home directory: ${resolved}`);
    }
    return resolved;
  };
  const assertHomePath = assertUserPath;
  const mimeForPath = path => {
    const extension = nativePath.extname(path).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
      '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
      '.lnk': 'application/x-app-shortcut',
      '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml', '.avif': 'image/avif', '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
      '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
      '.aac': 'audio/aac', '.opus': 'audio/ogg; codecs=opus',
      '.weba': 'audio/webm', '.webm': 'video/webm',
    };
    return mimeTypes[extension] || 'application/octet-stream';
  };
  const contentToBuffer = content => {
    if (content == null) return Buffer.alloc(0);
    if (typeof content === 'string') return Buffer.from(content);
    if (Buffer.isBuffer(content)) return content;
    if (ArrayBuffer.isView(content)) {
      return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    }
    if (content instanceof ArrayBuffer) return Buffer.from(content);
    if (Array.isArray(content)) return Buffer.from(content);
    if (content.type === 'Buffer' && Array.isArray(content.data)) return Buffer.from(content.data);
    const numericKeys = Object.keys(content);
    if (numericKeys.length && numericKeys.every(key => /^\d+$/.test(key))) {
      return Buffer.from(numericKeys.sort((a, b) => Number(a) - Number(b)).map(key => content[key]));
    }
    return Buffer.from(JSON.stringify(content));
  };
  const fileContent = async content => {
    if (typeof Blob !== 'undefined' && content instanceof Blob) {
      return Buffer.from(await content.arrayBuffer());
    }
    if (content == null || typeof content === 'string') return content ?? '';
    return contentToBuffer(content);
  };
  const nodeForPath = path => {
    const resolved = assertHomePath(path);
    const stat = nativeFs.lstatSync(resolved);
    const isDirectory = stat.isDirectory();
    const content = !isDirectory && stat.isFile() && stat.size <= 4 * 1024 * 1024
      ? nativeFs.readFileSync(resolved)
      : null;
    const parentPath = resolved === home ? null : nativePath.dirname(resolved);
    const node = {
      id: resolved,
      name: resolved === home ? '/' : nativePath.basename(resolved),
      type: isDirectory ? 'folder' : 'file',
      parentId: parentPath,
      content,
      blobKey: null,
      size: stat.size,
      mimeType: isDirectory ? 'inode/directory' : mimeForPath(resolved),
      created: stat.birthtimeMs || stat.ctimeMs,
      modified: stat.mtimeMs,
      accessed: stat.atimeMs,
      permissions: {
        read: true,
        write: !!(stat.mode & 0o200),
        execute: !!(stat.mode & 0o100),
      },
      tags: [],
      sha256: null,
      icon: null,
      isSymbolicLink: stat.isSymbolicLink(),
    };
    FS.files.set(resolved, node);
    FS._indexFile(node);
    return node;
  };
  const safeChild = (parentId, name) => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('Invalid file or directory name');
    }
    return assertHomePath(nativePath.join(assertHomePath(parentId), name));
  };
  const refreshChildren = folderId => {
    const folder = assertHomePath(folderId);
    try {
      const entries = nativeFs.readdirSync(folder, { withFileTypes: true })
        // Dot entries are machine plumbing (.apps, .browser-state.json):
        // hidden from every listing exactly like a real OS file manager,
        // and consistent with the virtual backend whose tree only ever
        // contains the folders the user (or the OS shell) created.
        .filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.'))
        .map(entry => nodeForPath(nativePath.join(folder, entry.name)))
        .sort((a, b) => a.type !== b.type
          ? (a.type === 'folder' ? -1 : 1)
          : a.name.localeCompare(b.name));
      const childIds = new Set(entries.map(entry => entry.id));
      for (const [id, cached] of FS.files) {
        if (cached.parentId === folder && !childIds.has(id)) FS.files.delete(id);
      }
      const children = new Map(entries.map(entry => [entry.id, entry]));
      if (children.size) FS._childrenByParent.set(folder, children);
      else FS._childrenByParent.delete(folder);
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') {
        for (const [id, cached] of FS.files) {
          if (cached.parentId === folder) FS.files.delete(id);
        }
        FS._childrenByParent.delete(folder);
        return [];
      }
      throw error;
    }
  };
  const refreshVisibleTree = () => {
    FS.files.clear();
    FS._childrenByParent.clear();
    nodeForPath(home);
    const visit = folder => {
      for (const node of refreshChildren(folder)) {
        if (node.type === 'folder' && !node.name.startsWith('.')) visit(node.id);
      }
    };
    visit(home);
  };
  const createFolderAt = path => {
    nativeFs.mkdirSync(path, { recursive: true });
    return nodeForPath(path);
  };
  const migrateLegacyVfs = async () => {
    if (nativeFs.existsSync(oldVfsMigrated)) return;
    let oldNodes;
    try {
      oldNodes = await OS.workers.fs.call('getAllFiles');
    } catch (error) {
      console.warn('[LinuxFS] Could not read the legacy virtual filesystem for migration:', error);
      return;
    }
    if (!Array.isArray(oldNodes) || !oldNodes.length) {
      nativeFs.mkdirSync(nativePath.dirname(oldVfsMigrated), { recursive: true });
      nativeFs.writeFileSync(oldVfsMigrated, JSON.stringify({ imported: 0, migratedAt: new Date().toISOString() }));
      return;
    }
    const nodes = new Map(oldNodes.map(node => [node.id, node]));
    const legacyRoot = oldNodes.find(node => node.parentId === null && node.type === 'folder');
    const resolveLegacyPath = node => {
      const parts = [];
      let current = node;
      const visited = new Set();
      while (current && current !== legacyRoot) {
        if (visited.has(current.id)) throw new Error('Cycle in legacy filesystem tree');
        visited.add(current.id);
        parts.push(current.name);
        current = nodes.get(current.parentId);
      }
      if (current !== legacyRoot) return null;
      return parts.reverse().reduce((base, part) => safeChild(base, part), home);
    };
    let imported = 0;
    for (const node of oldNodes) {
      if (node === legacyRoot) continue;
      let destination;
      try {
        destination = resolveLegacyPath(node);
        if (!destination || nativeFs.existsSync(destination)) continue;
        if (node.type === 'folder') {
          nativeFs.mkdirSync(destination, { recursive: true });
        } else if ((node.content !== null && node.content !== undefined) || node.blobKey) {
          nativeFs.mkdirSync(nativePath.dirname(destination), { recursive: true });
          let content = node.content;
          if ((content === null || content === undefined) && node.blobKey) {
            content = await OPFS.getBlob(node.blobKey);
            if (!content) {
              console.warn('[LinuxFS] Legacy file has a missing blob; leaving it in the old store:', node.name);
              continue;
            }
          }
          if (typeof Blob !== 'undefined' && content instanceof Blob) {
            content = Buffer.from(await content.arrayBuffer());
          }
          const bytes = contentToBuffer(content);
          nativeFs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
        imported++;
      } catch (error) {
        console.warn('[LinuxFS] Could not migrate a legacy file:', node.name, error);
      }
    }
    nativeFs.mkdirSync(nativePath.dirname(oldVfsMigrated), { recursive: true });
    nativeFs.writeFileSync(oldVfsMigrated, JSON.stringify({ imported, migratedAt: new Date().toISOString() }));
    console.info(`[LinuxFS] Imported ${imported} legacy filesystem entries into ${home}`);
  };

  Object.assign(FS, {
    async init() {
      nativeFs.mkdirSync(home, { recursive: true });
      // On a multi-user machine the machine home is the SYSTEM area — the
      // ~/users/<username>/ account trees plus hidden dot-state — never a
      // user's home. Boot (picker phase) must NOT create the standard user
      // folders or the machine Trash at its root: they belong inside each
      // account's tree, and the login-time sweep
      // (MultiUserMigration.upgradeUserLayout) adopts any legacy leftovers
      // into the signing-in account. Single-user machines (multi-user off)
      // keep the exact 3.0.2 layout: the machine home IS the user home with
      // the standard folders directly inside it.
      const mountedScope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
      const machinePhase = !!(mountedScope && mountedScope.enabled && mountedScope.enabled() && !scopedUser && !guestRoots);
      if (!machinePhase) {
        for (const folder of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', trashPath]) {
          createFolderAt(nativePath.isAbsolute(folder) ? folder : nativePath.join(home, folder));
        }
        createFolderAt(nativePath.join(home, 'Pictures', 'Screenshots'));
      }
      nativeFs.mkdirSync(appDataRoot, { recursive: true });
      this.rootId = home;
      this.files = new Map();
      this._childrenByParent = new Map();
      this.specialFolders = {
        desktop: nativePath.join(home, 'Desktop'),
        documents: nativePath.join(home, 'Documents'),
        downloads: nativePath.join(home, 'Downloads'),
        music: nativePath.join(home, 'Music'),
        pictures: nativePath.join(home, 'Pictures'),
        videos: nativePath.join(home, 'Videos'),
        trash: trashPath,
        data: appDataRoot,
      };
      const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
      if (scope && scope.enabled() && allowedRoots.includes(sharedRoot)) {
        // The cross-account drop box: visible to every account, owned by
        // the system, administered by admins, written per-account.
        createFolderAt(sharedRoot);
        this.specialFolders.shared = sharedRoot;
      }
      nodeForPath(home);
      // Machine-phase special folders may not exist on disk (nothing
      // created them); only index the ones that are really there.
      for (const folder of Object.values(this.specialFolders)) {
        if (nativeFs.existsSync(folder)) nodeForPath(folder);
      }
      await migrateLegacyVfs();
      refreshVisibleTree();
      console.info(`[LinuxFS] Using the native filesystem under ${home}`);
    },
    listDir(folderId) {
      return refreshChildren(folderId);
    },
    uniqueName(parentId, name, excludeId) {
      const siblings = new Set(refreshChildren(parentId)
        .filter(node => node.id !== excludeId)
        .map(node => node.name));
      if (!siblings.has(name)) return name;
      const extensionIndex = name.lastIndexOf('.');
      const hasExtension = extensionIndex > 0;
      const base = hasExtension ? name.slice(0, extensionIndex) : name;
      const extension = hasExtension ? name.slice(extensionIndex) : '';
      let suffix = 1;
      while (siblings.has(`${base} (${suffix})${extension}`)) suffix++;
      return `${base} (${suffix})${extension}`;
    },
    getPath(id) {
      return assertHomePath(id);
    },
    getByPath(path) {
      let resolved;
      if (path === '/') resolved = home;
      else if (path === '/data' || path.startsWith('/data/')) resolved = nativePath.join(appDataRoot, path.slice('/data/'.length));
      else if (path === '/Shared' || path.startsWith('/Shared/')) resolved = nativePath.join(sharedRoot, path.slice('/Shared/'.length));
      else if (path.startsWith('/')) resolved = nativePath.join(home, path.slice(1));
      else resolved = nativePath.resolve(home, path);
      try {
        return nodeForPath(resolved);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    },
    async setUserRoot(uid, options = {}) {
      const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
      if (!scope || !scope.enabled()) return false;
      const guest = !!(options && options.guest);
      // Prefer the explicit username from the SessionManager; fall back to
      // the scope module (set at mount), then the uid (legacy layout).
      const username = safeUsername(options && options.username) ||
        (typeof scope.activeUsername === 'function' ? scope.activeUsername() : '') ||
        String(uid || '');
      if (guest) {
        applyRoots(userRootsFor('', true).home, '', { guest: true });
      } else if (uid) {
        applyRoots(userRootsFor(username, false).home, username, { scoped: true });
      } else {
        // No account mounted (picker phase): back to the machine roots.
        applyRoots(machineHome, '', {});
      }
      await this.init();
      return true;
    },

    /** Creator bookkeeping for /Shared entries (sidecar index). */
    _sharedIndex() {
      try {
        const raw = nativeFs.readFileSync(nativePath.join(sharedRoot, '.nova-owners.json'), 'utf8');
        const doc = JSON.parse(raw);
        return doc && typeof doc === 'object' && doc.entries ? doc.entries : {};
      } catch (_) { return {}; }
    },
    _sharedIndexWrite(entries) {
      try {
        nativeFs.mkdirSync(sharedRoot, { recursive: true });
        const tmp = nativePath.join(sharedRoot, `.nova-owners.json.${process.pid}.tmp`);
        nativeFs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
        nativeFs.renameSync(tmp, nativePath.join(sharedRoot, '.nova-owners.json'));
      } catch (_) { /* best-effort bookkeeping */ }
    },
    _sharedRelative(resolved) {
      if (resolved === sharedRoot || !resolved.startsWith(sharedRoot + nativePath.sep)) return null;
      return resolved.slice(sharedRoot.length + 1);
    },
    _noteSharedCreator(resolved) {
      const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
      const rel = this._sharedRelative(resolved);
      if (rel === null || !scope || !scope.enabled()) return;
      const entries = this._sharedIndex();
      entries[rel] = scope.uid() || '__anonymous__';
      this._sharedIndexWrite(entries);
    },
    /** /Shared rule: write/delete only your own entries; admins all. */
    assertSharedWriteAllowed(resolved) {
      const rel = this._sharedRelative(resolved);
      if (rel === null) return;
      const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
      if (!scope || !scope.enabled()) return;
      if (scope.isActiveAdmin()) return;
      const entries = this._sharedIndex();
      const creator = entries[rel];
      if (creator === undefined) return; // pre-scoping entry: writable by admins only? keep permissive for compat
      if (creator === scope.uid()) return;
      throw new Error(`This /Shared entry belongs to another account: ${rel}`);
    },

    async createFile(parentId, name, content, mimeType) {
      const path = safeChild(parentId, name);
      nativeFs.writeFileSync(path, await fileContent(content), { flag: 'wx', mode: 0o600 });
      this._noteSharedCreator(path);
      const node = nodeForPath(path);
      if (mimeType) node.mimeType = mimeType;
      OS.events.emit('fs:created', node);
      return node;
    },
    async createFolder(parentId, name) {
      const path = safeChild(parentId, name);
      const node = createFolderAt(path);
      this._noteSharedCreator(path);
      OS.events.emit('fs:created', node);
      return node;
    },
    async writeFile(id, content, mimeType) {
      const path = assertHomePath(id);
      this.assertSharedWriteAllowed(path);
      const previous = nodeForPath(path);
      if (previous.type !== 'file') throw new Error(`Not a regular file: ${path}`);
      nativeFs.writeFileSync(path, await fileContent(content), { mode: 0o600 });
      const node = nodeForPath(path);
      if (mimeType) node.mimeType = mimeType;
      OS.events.emit('fs:updated', node);
      return node;
    },
    async rename(id, newName) {
      const source = assertHomePath(id);
      this.assertSharedWriteAllowed(source);
      const destination = safeChild(nativePath.dirname(source), newName);
      if (nativeFs.existsSync(destination)) {
        const error = new Error(`A file or folder named "${newName}" already exists in this location.`);
        error.code = 'EEXIST';
        throw error;
      }
      nativeFs.renameSync(source, destination);
      refreshVisibleTree();
      const node = nodeForPath(destination);
      OS.events.emit('fs:updated', node);
      return node;
    },
    async move(id, newParentId, nameOverride) {
      const source = assertHomePath(id);
      this.assertSharedWriteAllowed(source);
      const destination = safeChild(newParentId, nameOverride || nativePath.basename(source));
      if (destination === source) {
        // Cut-pasted into the folder it already sits in, with the same name:
        // a no-op paste, not a collision with itself.
        return nodeForPath(source);
      }
      if (nativeFs.existsSync(destination)) {
        const error = new Error(`A file or folder named "${nativePath.basename(destination)}" already exists in this location.`);
        error.code = 'EEXIST';
        throw error;
      }
      try {
        nativeFs.renameSync(source, destination);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        nativeFs.cpSync(source, destination, { recursive: true, errorOnExist: true });
        nativeFs.rmSync(source, { recursive: true });
      }
      this._noteSharedCreator(destination);
      refreshVisibleTree();
      const node = nodeForPath(destination);
      OS.events.emit('fs:moved', node);
      return node;
    },
    async copyNodeInto(node, destParentId, name) {
      const source = assertHomePath(node.id);
      const destination = safeChild(destParentId, name ?? node.name);
      nativeFs.cpSync(source, destination, { recursive: true, errorOnExist: true });
      refreshVisibleTree();
      return nodeForPath(destination);
    },
    async pasteInto(clip, destParentId) {
      if (!clip?.fileId) return null;
      const source = this.files.get(clip.fileId) || this.getByPath(clip.fileId);
      if (!source) return null;
      const name = this.uniqueName(destParentId, source.name, clip.type === 'cut' ? source.id : undefined);
      if (clip.type === 'cut') {
        // Compute the deduped name BEFORE moving so the file lands exactly
        // once: moving under the original name first would collide with the
        // same-named sibling the dedup was computed against.
        return this.move(source.id, destParentId, name === source.name ? undefined : name);
      }
      return this.copyNodeInto(source, destParentId, name);
    },
    async deleteToTrash(id) {
      const source = assertHomePath(id);
      this.assertSharedWriteAllowed(source);
      const uniqueDestination = this.uniqueName(trashPath, nativePath.basename(source));
      const finalPath = safeChild(trashPath, uniqueDestination);
      nativeFs.renameSync(source, finalPath);
      refreshVisibleTree();
      const node = nodeForPath(finalPath);
      OS.events.emit('fs:deleted', node);
      return node;
    },
    async permanentDelete(id) {
      const path = assertHomePath(id);
      this.assertSharedWriteAllowed(path);
      if (path === home) throw new Error('Refusing to delete the user home directory');
      if (allowedRoots.includes(path)) throw new Error('Refusing to delete a storage root directory');
      nativeFs.rmSync(path, { recursive: true, force: false });
      refreshVisibleTree();
      OS.events.emit('fs:deleted', { id: path });
    },
    async emptyTrash() {
      for (const entry of nativeFs.readdirSync(trashPath)) {
        nativeFs.rmSync(nativePath.join(trashPath, entry), { recursive: true, force: false });
      }
    },
    updateSearchIndex() {},
    async search(query) {
      const needle = String(query || '').toLocaleLowerCase();
      if (!needle) return [];
      const results = [];
      const contentText = node => {
        if (typeof node.content === 'string') return node.content;
        // The native backend reads file bytes as a Buffer — decode it so
        // content search works there exactly as it does on the virtual one.
        if (Buffer.isBuffer(node.content)) return node.content.toString('utf8');
        return '';
      };
      const visit = folder => {
        for (const node of refreshChildren(folder)) {
          if (node.name.startsWith('.')) continue;
          if (node.name.toLocaleLowerCase().includes(needle) ||
              contentText(node).toLocaleLowerCase().includes(needle)) {
            results.push(node);
          }
          if (node.type === 'folder') visit(node.id);
        }
      };
      visit(home);
      if (allowedRoots.includes(sharedRoot)) visit(sharedRoot);
      return results;
    },
    async exportNodes() {
      const exported = [];
      const visit = directory => {
        for (const node of refreshChildren(directory)) {
          if (node.name === '.cache' || node.name === '.config') continue;
          const item = { ...node };
          if (node.type === 'file') {
            item.content = node.content === null
              ? nativeFs.readFileSync(node.id).toString('base64')
              : Buffer.from(node.content).toString('base64');
            item.contentEncoding = 'base64';
          }
          exported.push(item);
          if (node.type === 'folder') visit(node.id);
        }
      };
      visit(home);
      return [{ id: home, name: '/', type: 'folder', parentId: null }, ...exported];
    },
    async importNodes(nodes) {
      if (!Array.isArray(nodes)) throw new TypeError('Imported filesystem data must be an array');
      const sourceNodes = new Map(nodes.filter(node => node?.id).map(node => [node.id, node]));
      const root = nodes.find(node => node?.parentId === null && node.type === 'folder');
      if (!root) throw new Error('Imported filesystem data has no root directory');
      const destinationRoot = nativePath.join(home, 'Documents', `Imported Data ${new Date().toISOString().replace(/[:.]/g, '-')}`);
      nativeFs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
      const resolveRelativeParts = node => {
        const parts = [];
        let current = node;
        const visited = new Set();
        while (current && current !== root) {
          if (visited.has(current.id)) throw new Error('Cycle in imported filesystem data');
          visited.add(current.id);
          parts.push(current.name);
          current = sourceNodes.get(current.parentId);
        }
        if (current !== root) throw new Error(`Invalid parent reference for imported item: ${node.name}`);
        return parts.reverse();
      };
      for (const node of nodes) {
        if (node === root) continue;
        const parts = resolveRelativeParts(node);
        if (!parts.length || parts.some(part => typeof part !== 'string' || !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
          throw new Error(`Invalid imported path for item: ${node.name}`);
        }
        const target = nativePath.join(destinationRoot, ...parts);
        assertHomePath(target);
        if (node.type === 'folder') {
          nativeFs.mkdirSync(target, { recursive: true, mode: 0o700 });
        } else {
          nativeFs.mkdirSync(nativePath.dirname(target), { recursive: true, mode: 0o700 });
          if (nativeFs.existsSync(target)) continue;
          const bytes = node.contentEncoding === 'base64'
            ? Buffer.from(String(node.content || ''), 'base64')
            : contentToBuffer(node.content);
          nativeFs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        }
      }
      refreshVisibleTree();
      return destinationRoot;
    },
  });
  FS.backend = 'linux-native';
} else {
  // Dev machines (and any non-Linux host) run the in-memory virtual FS.
  // The marker keeps the active backend observable (devconsole/tests) the
  // same way 'linux-native' is on the real kiosk.
  FS.backend = 'virtual';
}

window.FS = FS;