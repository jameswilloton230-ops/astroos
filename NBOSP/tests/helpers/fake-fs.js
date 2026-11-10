'use strict';
// In-memory fake of the host FS service covering exactly the surface
// app-sandbox.js touches: FS.files (Map), FS.rootId, FS.specialFolders,
// FS.getPath, FS.getByPath, FS.listDir, FS.createFile, FS.writeFile,
// FS.createFolder, FS.rename, FS.move, FS.deleteToTrash, FS.permanentDelete,
// FS.clear. Tree layout mirrors the host convention: /data/<appId>/ is owned
// by that app.

let seq = 0;
function nid() { return 'f' + (++seq); }

function createFakeFS() {
  const files = new Map(); // id -> node { id, name, type, parentId, content?, mimeType? }
  const specialFolders = {};

  function makeNode(name, type, parentId, extra = {}) {
    const node = { id: nid(), name, type, parentId, ...extra };
    files.set(node.id, node);
    return node;
  }

  const root = makeNode('', 'folder', null, { __path: '/' });
  const data = makeNode('data', 'folder', root.id);
  const trash = makeNode('.Trash', 'folder', root.id);
  specialFolders.trash = trash.id;
  specialFolders.data = data.id;

  function getPath(id) {
    const node = files.get(id);
    if (!node) return null;
    if (node === root || node.__path === '/') return '/';
    const parts = [];
    let cur = node;
    while (cur && cur !== root) {
      parts.unshift(cur.name);
      cur = files.get(cur.parentId);
    }
    return '/' + parts.join('/');
  }

  function getByPath(path) {
    const clean = String(path || '/').replace(/\/+$/, '') || '/';
    if (clean === '/') return root;
    const parts = clean.split('/').filter(Boolean);
    let cur = root;
    for (const part of parts) {
      const next = listDir(cur.id).find((n) => n.name === part);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  function listDir(folderId) {
    return [...files.values()].filter((n) => n.parentId === folderId);
  }

  async function createFile(parentId, name, content = '', mimeType = 'text/plain') {
    return makeNode(String(name), 'file', parentId, {
      content: String(content), mimeType, size: String(content).length, modified: Date.now(),
    });
  }

  async function writeFile(id, content = '', mimeType) {
    const node = files.get(id);
    if (!node) throw new Error('fake-fs: no such file ' + id);
    node.content = String(content);
    node.size = String(content).length;
    if (mimeType) node.mimeType = mimeType;
    node.modified = Date.now();
    return node;
  }

  async function createFolder(parentId, name) {
    return makeNode(String(name), 'folder', parentId);
  }

  async function rename(id, name) {
    const node = files.get(id);
    if (!node) throw new Error('fake-fs: no such file ' + id);
    node.name = String(name);
    return node;
  }

  async function move(id, parentId) {
    const node = files.get(id);
    if (!node || !files.get(parentId)) throw new Error('fake-fs: bad move');
    node.parentId = parentId;
    return node;
  }

  async function deleteToTrash(id) {
    const node = files.get(id);
    if (node) node.parentId = specialFolders.trash;
    return node;
  }

  async function permanentDelete(id) {
    files.delete(id);
  }

  function clear() {
    for (const [id, node] of files) {
      if (node !== root && node !== data && node !== trash) files.delete(id);
    }
  }

  // Ensure /data/<appId> exists (the host does this lazily on first write).
  // Segment naming must mirror app-sandbox.js's sanitizeAppIdSegment exactly
  // — dots are KEPT ('com.gallery.app.r6'), only genuinely unsafe
  // characters become underscores, with the same leading-character fallback —
  // or the sandbox's /data/<appId>/... path rewrites won't resolve against
  // directories created here. (This helper previously stripped dots to
  // underscores, so every dotted app id failed its own /data writes with
  // NOT_FOUND — see tests/test_real_use.js R6.)
  function sanitizeAppIdSegment(appId) {
    let segment = String(appId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) {
      segment = segment.replace(/^[._-]+/, '');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) segment = 'default';
    }
    return segment;
  }
  function ensureAppDir(appId) {
    const seg = sanitizeAppIdSegment(appId);
    let dir = listDir(data.id).find((n) => n.name === seg && n.type === 'folder');
    if (!dir) dir = makeNode(seg, 'folder', data.id);
    return dir;
  }

  return {
    files, rootId: root.id, specialFolders,
    getPath, getByPath, listDir,
    createFile, writeFile, createFolder, rename, move,
    deleteToTrash, permanentDelete, clear, ensureAppDir,
    __nodes: files,
  };
}

module.exports = { createFakeFS };
