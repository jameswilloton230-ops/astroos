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

    const allFiles = [root, desktop, documents, downloads, music, pictures, videos, trash, screenshots];

    this.files.clear();
    this._childrenByParent.clear();
    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      this.files.set(f.id, f);
      this._indexFile(f);
    }

    this.specialFolders = {
      desktop: desktop.id, documents: documents.id, downloads: downloads.id,
      music: music.id, pictures: pictures.id, videos: videos.id, trash: trash.id
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
  const home = nativePath.resolve(nativeOs.homedir());
  const homePrefix = home.endsWith(nativePath.sep) ? home : home + nativePath.sep;
  const trashPath = nativePath.join(home, '.local', 'share', 'Trash', 'files');
  // The per-app data root — the same tree AppDirs bootstraps as
  // ~/.local/share/novabyte/data/<appId>/{files,cache,databases,shared_prefs}.
  // The VFS exposes it as /data so sandboxed apps' appdata:/ and /data/
  // paths land in the documented NovaByte data root instead of a stray
  // ~/data folder alongside the home directories.
  const appDataRoot = nativePath.join(home, '.local', 'share', 'novabyte', 'data');
  const oldVfsMigrated = nativePath.join(home, '.local', 'share', 'novabyte', 'migration', 'vfs-imported');

  const assertHomePath = path => {
    const resolved = nativePath.resolve(path);
    if (resolved !== home && !resolved.startsWith(homePrefix)) {
      throw new Error(`Filesystem operation is outside the user home directory: ${resolved}`);
    }
    let existingPath = resolved;
    while (!nativeFs.existsSync(existingPath) && existingPath !== home) {
      existingPath = nativePath.dirname(existingPath);
    }
    const realPath = nativeFs.realpathSync(existingPath);
    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error(`Filesystem operation traverses a path outside the user home directory: ${resolved}`);
    }
    return resolved;
  };
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
        .filter(entry => !entry.isSymbolicLink())
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
      for (const folder of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos', trashPath]) {
        createFolderAt(nativePath.isAbsolute(folder) ? folder : nativePath.join(home, folder));
      }
      createFolderAt(nativePath.join(home, 'Pictures', 'Screenshots'));
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
      nodeForPath(home);
      for (const folder of Object.values(this.specialFolders)) nodeForPath(folder);
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
      else if (path.startsWith('/')) resolved = nativePath.join(home, path.slice(1));
      else resolved = nativePath.resolve(home, path);
      try {
        return nodeForPath(resolved);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    },
    async createFile(parentId, name, content, mimeType) {
      const path = safeChild(parentId, name);
      nativeFs.writeFileSync(path, await fileContent(content), { flag: 'wx', mode: 0o600 });
      const node = nodeForPath(path);
      if (mimeType) node.mimeType = mimeType;
      OS.events.emit('fs:created', node);
      return node;
    },
    async createFolder(parentId, name) {
      const node = createFolderAt(safeChild(parentId, name));
      OS.events.emit('fs:created', node);
      return node;
    },
    async writeFile(id, content, mimeType) {
      const path = assertHomePath(id);
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
      if (path === home) throw new Error('Refusing to delete the user home directory');
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