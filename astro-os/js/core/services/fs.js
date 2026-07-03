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
    return node;
  },

  async writeFile(id, content) {
    const node = this.files.get(id);
    if (!node) return null;
    node.content = content;
    node.size = new Blob([content]).size;
    node.modified = Date.now();
    try { node.sha256 = await OS.workers.crypto.call('sha256', content); } catch (e) { }
    await OS.workers.fs.call('putFiles', [node]); 
    this.updateSearchIndex();
    OS.events.emit('fs:updated', node);
    return node;
  },

  async rename(id, newName) {
    const node = this.files.get(id);
    if (!node) return null;
    node.name = newName;
    node.modified = Date.now();
    await OS.workers.fs.call('putFiles', [node]);
    OS.events.emit('fs:updated', node);
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
    return node;
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

window.FS = FS;