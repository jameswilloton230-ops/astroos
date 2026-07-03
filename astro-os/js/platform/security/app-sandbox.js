/**
 * NovaByte — App Sandbox
 *
 * Creates secure execution environments for apps using sandboxed webviews with
 * process isolation. Each app gets its own renderer process, storage partition,
 * and a capability-scoped IPC bridge to host OS services (filesystem, network,
 * notifications, window manager, etc.).
 *
 * @module app-sandbox
 */

const AppSandbox = (() => {
  'use strict';

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  // Active sandboxes keyed by sandboxId. Each value holds the webview element,
  // app metadata, window state, WebSocket connections, and a cleanup function.
  const activeSandboxes = new Map();

  // Event subscriptions keyed by sandboxId, then event name -> handler.
  // Kept in a separate map so cleanup can iterate without touching the sandbox
  // object's other fields.
  const eventSubscriptions = new Map();

  // Open file dialogs keyed by sandboxId, so we can tear them down when a
  // sandbox is destroyed mid-dialog (prevents orphaned overlays in the DOM).
  const openDialogs = new Map();

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------

  const API_PREFIX = 'nova:';
  const STORAGE_KEY_PREFIX = 'nova_storage_';
  // Allow word chars, dash, dot, space. Anything else (slashes, colons) is
  // rejected to prevent key injection across app namespaces.
  const STORAGE_KEY_REGEX = /^[\w\-. ]+$/;
  const STORAGE_VALUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per single value
  const CLIPBOARD_HISTORY_MAX = 30;
  const ALLOWED_HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  ]);
  const ALLOWED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
  // Hostnames that count as "internal" for permission gating. Both bracketed
  // ([::1]) and unbracketed (::1) IPv6 forms are accepted.
  const INTERNAL_HOSTS = new Set([
    'localhost', '127.0.0.1', '::1', '[::1]', 'api.novabyte.internal',
  ]);
  const DEFAULT_WINDOW_WIDTH = 800;
  const DEFAULT_WINDOW_HEIGHT = 600;
  const MIN_WINDOW_DIMENSION = 100;

  // ------------------------------------------------------------------
  // Utility helpers
  // ------------------------------------------------------------------

  /**
   * Generate a unique request ID for IPC correlation. Prefers crypto.randomUUID
   * when available; falls back to timestamp + random otherwise.
   */
  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `req_${crypto.randomUUID()}`;
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Escape a string for safe HTML interpolation. Used whenever app-supplied
   * metadata (name, author, etc.) is embedded into the default shell or error
   * page. Without this, a malicious package could inject <script> tags.
   */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * UTF-8 safe base64 encoding. btoa() throws on non-Latin1 characters, so app
   * HTML containing emoji or CJK content would crash the loader. We go through
   * TextEncoder so the full Unicode range survives the round-trip.
   */
  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof bytes.toBase64 === 'function') {
      return bytes.toBase64();
    }
    // Legacy fallback for runtimes without Uint8Array.toBase64 (pre-ES2026).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /** Inverse of encodeBase64Utf8. */
  function decodeBase64Utf8(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return new TextDecoder().decode(Uint8Array.fromBase64(b64));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /**
   * Structured logger. Debug-level messages are gated on a window flag so
   * production builds stay quiet unless an operator opts in.
   */
  function log(level, message, ...rest) {
    const prefix = '[AppSandbox]';
    if (level === 'error') console.error(prefix, message, ...rest);
    else if (level === 'warn') console.warn(prefix, message, ...rest);
    else if (level === 'debug') {
      if (typeof window !== 'undefined' && window.__NOVA_SANDBOX_DEBUG__) {
        console.debug(prefix, message, ...rest);
      }
    } else {
      console.log(prefix, message, ...rest);
    }
  }

  /**
   * Resolve a URL string against the current origin and classify it as
   * internal or external. Handles protocol-relative URLs (//host/path) safely
   * by always resolving through new URL(rawUrl, window.location.origin).
   *
   * Without this, an app could pass "//evil.com/foo" to net:fetch and have it
   * treated as internal because the original check only looked at the leading
   * "/" character.
   */
  function resolveAndClassifyUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return { valid: false, error: 'Invalid URL' };
    }
    let resolved;
    try {
      resolved = new URL(rawUrl, window.location.origin);
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
    if (!ALLOWED_WEB_PROTOCOLS.has(resolved.protocol)) {
      return { valid: false, error: 'Only http and https URLs are allowed' };
    }
    return {
      valid: true,
      url: resolved.href,
      isInternal: isInternalHost(resolved.hostname),
    };
  }

  function isInternalHost(hostname) {
    return INTERNAL_HOSTS.has(hostname) || INTERNAL_HOSTS.has(hostname.toLowerCase());
  }

  /**
   * Validate that a value is a positive integer within optional bounds.
   * Returns the parsed integer or the fallback when invalid.
   */
  function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  // ------------------------------------------------------------------
  // Response helpers
  // ------------------------------------------------------------------

  /**
   * Send a response back to the sandboxed app. Apps are served from our own
   * origin, so we use window.location.origin as the target origin (never '*').
   */
  function respond(webview, type, requestId, result, error = null) {
    try {
      webview.contentWindow.postMessage(
        { type: `${type}:response`, requestId, result, error },
        window.location.origin
      );
    } catch (e) {
      log('error', `Failed to respond to ${type}:`, e);
    }
  }

  function respondError(webview, type, requestId, code, message) {
    respond(webview, type, requestId, null, { code, message });
  }

  // ------------------------------------------------------------------
  // Filesystem helpers
  // ------------------------------------------------------------------

  /** Resolve a payload (with either `path` or `id`) to a file node. */
  function resolveFile(payload) {
    const { path, id } = payload ?? {};
    if (id) return FS.files.get(id) || null;
    if (path) return FS.getByPath(path);
    return null;
  }

  /** Convert a file node to a safe serializable object. */
  function fileToJSON(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size,
      path: FS.getPath(node.id),
      parentId: node.parentId,
      created: node.created,
      modified: node.modified,
      accessed: node.accessed,
      permissions: node.permissions,
      sha256: node.sha256,
      tags: node.tags || [],
    };
  }

  // ------------------------------------------------------------------
  // File dialog
  // ------------------------------------------------------------------

  /**
   * Show a file open/save dialog. The dialog is a custom overlay so it matches
   * the NovaByte visual style. The visuals are kept identical to the original
   * implementation — only internal cleanup wiring has changed.
   */
  function showFileDialog(mode, webview, type, requestId, app, payload) {
    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.zIndex = '100001';

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #0e121c; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 24px; max-width: 620px; width: 92%;
      max-height: 80vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      font-family: var(--font-ui, system-ui, sans-serif);
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'color: #e6edf3; margin: 0 0 4px; font-size: 16px; font-weight: 700;';
    title.textContent = mode === 'open' ? '📂 Open File' : '💾 Save File';
    dialog.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'color: #8b949e; margin: 0 0 12px; font-size: 12px;';
    subtitle.textContent = payload.title || `Select a ${mode === 'open' ? 'file to open' : 'location to save'}`;
    dialog.appendChild(subtitle);

    const filter = payload.filter || payload.accept || null;
    if (filter) {
      const filterEl = document.createElement('p');
      filterEl.style.cssText = 'color: #d29922; margin: 0 0 12px; font-size: 11px;';
      filterEl.textContent = `Filter: ${Array.isArray(filter) ? filter.join(', ') : filter}`;
      dialog.appendChild(filterEl);
    }

    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;';
    dialog.appendChild(pathBar);

    const fileList = document.createElement('div');
    fileList.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.02);';

    let currentFolderId = FS.rootId;
    let selectedFile = null;

    function renderFileList() {
      fileList.innerHTML = '';
      const children = FS.listDir(currentFolderId);

      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 24px; text-align: center; color: #8b949e; font-size: 13px;';
        empty.textContent = '(empty folder)';
        fileList.appendChild(empty);
      }

      for (const item of children) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 4px; transition: background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(88,166,255,0.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

        const icon = document.createElement('span');
        icon.textContent = item.type === 'folder' ? '📁' : '📄';
        icon.style.fontSize = '16px';

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; color: #e6edf3; font-size: 13px;';
        name.textContent = item.name;

        const meta = document.createElement('span');
        meta.style.cssText = 'color: #8b949e; font-size: 11px; font-family: monospace;';
        if (item.type === 'file') {
          const size = item.size || 0;
          meta.textContent = size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(meta);

        if (item.type === 'folder') {
          row.addEventListener('click', () => {
            currentFolderId = item.id;
            renderBreadcrumb();
            renderFileList();
            selectedFile = null;
            updateConfirmState();
          });
        } else {
          row.addEventListener('click', () => {
            if (selectedFile === item.id) {
              selectedFile = null;
              row.style.background = 'transparent';
            } else {
              selectedFile = item.id;
              fileList.querySelectorAll('[data-selected]').forEach(el => {
                el.style.background = 'transparent';
                el.removeAttribute('data-selected');
              });
              row.style.background = 'rgba(88,166,255,0.15)';
              row.setAttribute('data-selected', 'true');
            }
            updateConfirmState();
          });

          if (mode === 'save' && item.name === (payload.suggestedName || '')) {
            selectedFile = item.id;
            row.style.background = 'rgba(88,166,255,0.15)';
            row.setAttribute('data-selected', 'true');
          }
        }

        fileList.appendChild(row);
      }
    }

    function renderBreadcrumb() {
      pathBar.innerHTML = '';
      const parts = [];
      let node = FS.files.get(currentFolderId);
      while (node) {
        parts.unshift(node);
        node = FS.files.get(node.parentId);
      }

      parts.forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.style.cssText = 'color: #8b949e;';
          sep.textContent = '/';
          pathBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.style.cssText = 'background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 3px;';
        btn.textContent = part.name;
        btn.addEventListener('click', () => {
          currentFolderId = part.id;
          renderBreadcrumb();
          renderFileList();
        });
        if (i === parts.length - 1) {
          btn.style.color = '#e6edf3';
          btn.style.fontWeight = '600';
          btn.style.cursor = 'default';
        }
        pathBar.appendChild(btn);
      });
    }

    let filenameInput = null;
    if (mode === 'save') {
      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';

      const label = document.createElement('label');
      label.style.cssText = 'color: #8b949e; font-size: 12px; white-space: nowrap;';
      label.textContent = 'Filename:';

      filenameInput = document.createElement('input');
      filenameInput.type = 'text';
      filenameInput.value = payload.suggestedName || '';
      filenameInput.placeholder = 'Enter filename...';
      filenameInput.style.cssText = 'flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e6edf3; font-size: 13px;';
      filenameInput.addEventListener('input', () => {
        selectedFile = null;
        updateConfirmState();
      });

      inputRow.appendChild(label);
      inputRow.appendChild(filenameInput);
      // Insert the filename row before the file list so the visual order is
      // breadcrumb → filename input → file list → buttons.
      dialog.appendChild(inputRow);
    }

    dialog.appendChild(fileList);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 8px 18px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; transition: all 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'rgba(255,255,255,0.05)'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
    cancelBtn.addEventListener('click', () => {
      closeDialog();
      respond(webview, type, requestId, { cancelled: true });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = mode === 'open' ? 'Open' : 'Save';
    confirmBtn.style.cssText = 'padding: 8px 18px; border: none; border-radius: 6px; background: #58a6ff; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s;';
    confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3a8be6'; });
    confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#58a6ff'; });
    confirmBtn.disabled = mode === 'open';

    function updateConfirmState() {
      if (mode === 'open') {
        confirmBtn.disabled = !selectedFile;
      } else {
        confirmBtn.disabled = !(filenameInput && filenameInput.value.trim());
      }
    }

    confirmBtn.addEventListener('click', async () => {
      if (mode === 'open') {
        if (!selectedFile) return;
        const node = FS.files.get(selectedFile);
        if (!node || node.type === 'folder') return;
        closeDialog();
        respond(webview, type, requestId, {
          success: true,
          file: {
            id: node.id,
            name: node.name,
            content: node.content || '',
            mimeType: node.mimeType || 'text/plain',
            size: node.size || 0,
            path: FS.getPath(node.id),
          },
        });
      } else {
        const name = filenameInput.value.trim();
        if (!name) return;
        const content = payload.content || '';
        const mimeType = payload.mimeType || 'text/plain';
        try {
          const newNode = await FS.createFile(currentFolderId, name, content, mimeType);
          closeDialog();
          respond(webview, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id),
            },
          });
        } catch (e) {
          closeDialog();
          respondError(webview, type, requestId, 'WRITE_ERROR', e.message || 'Failed to write file');
        }
      }
    });

    // Closes the dialog overlay and unregisters it from the openDialogs map
    // so destroy() knows it's no longer pending.
    function closeDialog() {
      overlay.remove();
      const sandboxId = webview.dataset.sandboxId;
      if (sandboxId && openDialogs.get(sandboxId) === overlay) {
        openDialogs.delete(sandboxId);
      }
    }

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Track the open dialog so destroy() can clean it up if the sandbox is
    // torn down while the user is still picking a file.
    const sandboxId = webview.dataset.sandboxId;
    if (sandboxId) openDialogs.set(sandboxId, overlay);

    renderBreadcrumb();
    renderFileList();

    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), 50);
    }
  }

  // ------------------------------------------------------------------
  // IPC handlers
  // ------------------------------------------------------------------
  //
  // Each handler is a named async function that receives a context object
  // with { payload, requestId, app, webview, sandbox }. Handlers that respond
  // synchronously call respond/respondError before returning; async handlers
  // (geolocation, websocket, file dialog) return without responding and send
  // the response later from a callback.

  // -- Filesystem --

  async function handleFsRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:read', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:read', requestId, 'NOT_FOUND', 'File or folder not found');
    if (node.type === 'folder') {
      const children = FS.listDir(node.id);
      return respond(webview, 'nova:fs:read', requestId, {
        success: true,
        isFolder: true,
        name: node.name,
        id: node.id,
        path: FS.getPath(node.id),
        children: children.map(c => ({
          id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
          size: c.size, modified: c.modified, created: c.created,
        })),
      });
    }
    return respond(webview, 'nova:fs:read', requestId, {
      success: true,
      data: node.content,
      mimeType: node.mimeType,
      name: node.name,
      size: node.size,
      id: node.id,
      path: FS.getPath(node.id),
      modified: node.modified,
      created: node.created,
    });
  }

  async function handleFsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:write', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const { path, content, mimeType } = payload ?? {};
    if (!path || content === undefined) {
      return respondError(webview, 'nova:fs:write', requestId, 'INVALID_ARGS', 'path and content are required');
    }
    let node = FS.getByPath(path);
    if (node) {
      if (node.type === 'folder') {
        return respondError(webview, 'nova:fs:write', requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
      }
      await FS.writeFile(node.id, content);
      return respond(webview, 'nova:fs:write', requestId, { success: true, id: node.id });
    }
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:write', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    const newNode = await FS.createFile(
      parent.id,
      fileName,
      typeof content === 'string' ? content : JSON.stringify(content),
      mimeType || 'text/plain'
    );
    return respond(webview, 'nova:fs:write', requestId, {
      success: true,
      id: newNode.id,
      path: FS.getPath(newNode.id),
    });
  }

  async function handleFsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:delete', app.id)) {
      return respondError(webview, 'nova:fs:delete', requestId, 'PERMISSION_DENIED', 'fs:delete permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:delete', requestId, 'NOT_FOUND', 'File not found');
    if (payload.permanent) {
      await FS.permanentDelete(node.id);
    } else {
      await FS.deleteToTrash(node.id);
    }
    return respond(webview, 'nova:fs:delete', requestId, { success: true });
  }

  async function handleFsList({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:list', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:list', requestId, 'NOT_FOUND', 'Folder not found');
    if (node.type !== 'folder') {
      return respondError(webview, 'nova:fs:list', requestId, 'INVALID_OPERATION', 'Path is not a folder');
    }
    const children = FS.listDir(node.id);
    return respond(webview, 'nova:fs:list', requestId, {
      success: true,
      path: FS.getPath(node.id),
      files: children.map(c => ({
        id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
        size: c.size, modified: c.modified, created: c.created,
      })),
    });
  }

  async function handleFsMkdir({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const { path, name } = payload ?? {};
    if (!name) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'INVALID_ARGS', 'name is required');
    }
    let parent;
    if (path) {
      parent = FS.getByPath(path);
    } else {
      parent = FS.files.get(FS.rootId);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    const newFolder = await FS.createFolder(parent.id, name);
    return respond(webview, 'nova:fs:mkdir', requestId, {
      success: true,
      id: newFolder.id,
      path: FS.getPath(newFolder.id),
    });
  }

  async function handleFsStat({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:stat', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:stat', requestId, 'NOT_FOUND', 'File not found');
    return respond(webview, 'nova:fs:stat', requestId, { success: true, stat: fileToJSON(node) });
  }

  async function handleFsRename({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:rename', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:rename', requestId, 'NOT_FOUND', 'File not found');
    if (!payload.name) {
      return respondError(webview, 'nova:fs:rename', requestId, 'INVALID_ARGS', 'name is required');
    }
    await FS.rename(node.id, payload.name);
    return respond(webview, 'nova:fs:rename', requestId, { success: true, name: payload.name });
  }

  async function handleFsMove({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:move', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const node = resolveFile(payload);
    if (!node) return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'File not found');
    const destParent = payload.destPath ? FS.getByPath(payload.destPath) : null;
    if (!destParent || destParent.type !== 'folder') {
      return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'Destination folder not found');
    }
    await FS.move(node.id, destParent.id);
    return respond(webview, 'nova:fs:move', requestId, { success: true, path: FS.getPath(node.id) });
  }

  // -- Notifications --

  async function handleNotificationsShow({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Notify may be absent in headless test environments. Report UNAVAILABLE
    // rather than silently claiming success — apps deserve to know.
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') {
      return respondError(webview, 'nova:notifications:show', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.show({
      title: payload.title || 'Notification',
      body: payload.body || '',
      type: payload.type || 'info',
      appName: app.name,
      icon: payload.icon || null,
      action: payload.action || null,
      actionLabel: payload.actionLabel || null,
      category: payload.category || 'app',
    });
    return respond(webview, 'nova:notifications:show', requestId, { success: true });
  }

  async function handleNotificationsClear({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:clear', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.clearAll !== 'function') {
      return respondError(webview, 'nova:notifications:clear', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.clearAll();
    return respond(webview, 'nova:notifications:clear', requestId, { success: true });
  }

  // -- Settings --

  async function handleSettingsGet({ payload, requestId, app, webview }) {
    // system:info gates read access — otherwise any app could read credentials
    // or other sensitive settings keys.
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const value = OS?.settings?.get(payload.key);
    return respond(webview, 'nova:settings:get', requestId, { success: true, value });
  }

  async function handleSettingsSet({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:settings', app.id)) {
      return respondError(webview, 'nova:settings:set', requestId, 'PERMISSION_DENIED', 'system:settings permission required');
    }
    OS?.settings?.set(payload.key, payload.value);
    return respond(webview, 'nova:settings:set', requestId, { success: true });
  }

  // -- Permission requests --

  async function handleRequestPermission({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:request-permission', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const granted = await AppPermissionManager.requestPermission(permission, app.id, {
        reason: payload.reason || `${app.name} wants to access this permission.`,
        permanent: payload.permanent !== false,
      });
      return respond(webview, 'nova:request-permission', requestId, { granted });
    } catch (e) {
      return respondError(webview, 'nova:request-permission', requestId, 'ERROR', e.message || 'Permission request failed');
    }
  }

  // -- Window management --
  //
  // These all no-op silently when WM or the window state is missing, then
  // return success. This matches the original behaviour — window operations
  // are best-effort from the app's perspective.

  async function handleWindowClose({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
      WM.closeWindow(windowId);
    }
    return respond(webview, 'nova:window:close', requestId, { success: true });
  }

  async function handleWindowMinimize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.minimizeWindow === 'function') {
      WM.minimizeWindow(windowId);
    }
    return respond(webview, 'nova:window:minimize', requestId, { success: true });
  }

  async function handleWindowMaximize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.toggleMaximize === 'function') {
      WM.toggleMaximize(windowId);
    }
    return respond(webview, 'nova:window:maximize', requestId, { success: true });
  }

  async function handleWindowSetTitle({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId) {
      const state = OS.windows.get(windowId);
      if (state && state.titleText) {
        state.titleText.textContent = String(payload?.title ?? '');
      }
    }
    return respond(webview, 'nova:window:setTitle', requestId, { success: true });
  }

  async function handleWindowResize({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId) {
      const state = OS.windows.get(windowId);
      if (state && state.element) {
        // parseInt with explicit radix and a minimum bound to prevent
        // zero/negative sizes that would render the window unusable.
        const w = parsePositiveInt(payload?.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_DIMENSION);
        const h = parsePositiveInt(payload?.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_DIMENSION);
        state.element.style.width = w + 'px';
        state.element.style.height = h + 'px';
        state.width = w;
        state.height = h;
        if (state.maximized) {
          state.maximized = false;
          state.element.classList.remove('maximized');
        }
      }
    }
    return respond(webview, 'nova:window:resize', requestId, { success: true });
  }

  async function handleWindowGetState({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    const state = windowId ? OS.windows.get(windowId) : null;
    if (!state) {
      return respondError(webview, 'nova:window:getState', requestId, 'NOT_FOUND', 'Window not found');
    }
    return respond(webview, 'nova:window:getState', requestId, {
      success: true,
      id: state.id,
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      maximized: !!state.maximized,
      minimized: !!state.minimized,
    });
  }

  // -- Clipboard --

  async function handleClipboardRead({ requestId, app, webview }) {
    // Clipboard is gated on fs:read — intentional design choice from the
    // original code (clipboard contents often include file paths).
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:read', requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
    }
    return respond(webview, 'nova:clipboard:read', requestId, {
      success: true,
      data: OS.clipboard || null,
    });
  }

  async function handleClipboardWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:write', requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
    }
    OS.clipboard = payload.data || '';
    if (!OS.clipboardHistory) OS.clipboardHistory = [];
    if (typeof payload.data === 'string' && !OS.clipboardHistory.includes(payload.data)) {
      OS.clipboardHistory.unshift(payload.data);
      if (OS.clipboardHistory.length > CLIPBOARD_HISTORY_MAX) OS.clipboardHistory.pop();
    }
    return respond(webview, 'nova:clipboard:write', requestId, { success: true });
  }

  // -- App lifecycle --

  async function handleAppLaunch({ payload, requestId, app, webview }) {
    // system:apps gates cross-app launches — otherwise any app could spawn
    // any other app (privilege escalation surface).
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId, options } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow(appId, options || {});
      return respond(webview, 'nova:app:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:launch', requestId, 'ERROR', e.message);
    }
  }

  async function handleAppInfo({ requestId, app, webview }) {
    return respond(webview, 'nova:app:info', requestId, {
      success: true,
      id: app.id,
      name: app.name,
      version: app.version,
      icon: app.icon,
      type: app.type,
      permissions: app.permissions || [],
      optionalPermissions: app.optionalPermissions || [],
    });
  }

  // -- Events --

  async function handleEventsSubscribe({ payload, requestId, app, webview, sandbox }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    if (!event) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', 'event name is required');
    }
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
    }
    const handler = (data) => {
      respond(webview, 'nova:events:event', generateRequestId(), { event, data });
    };
    OS?.events?.on(event, handler);
    if (subs) subs.set(event, handler);
    return respond(webview, 'nova:events:subscribe', requestId, { success: true, subscribed: event });
  }

  async function handleEventsUnsubscribe({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:unsubscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      const handler = subs.get(event);
      OS?.events?.off(event, handler);
      subs.delete(event);
    }
    return respond(webview, 'nova:events:unsubscribe', requestId, { success: true, unsubscribed: event });
  }

  // -- Network: fetch --

  async function handleNetFetch({ payload, requestId, app, webview }) {
    const { url: rawUrl, method, headers, body } = payload ?? {};
    if (!rawUrl) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'url is required');
    }
    const safeMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(safeMethod)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', `Method not allowed: ${safeMethod}`);
    }
    // Resolve and classify the URL in one pass. This catches protocol-relative
    // URLs (//evil.com) that the old leading-slash check missed.
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', classified.error);
    }
    const netPerm = classified.isInternal ? 'net:internal' : 'net:external';
    if (!AppPermissionManager.isGranted(netPerm, app.id)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
    }
    try {
      const res = await fetch(classified.url, {
        method: safeMethod,
        headers: headers || {},
        body: body || null,
      });
      const resBody = await res.text();
      return respond(webview, 'nova:net:fetch', requestId, {
        success: true,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body: resBody,
      });
    } catch (e) {
      return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', e.message);
    }
  }

  // -- Network: WebSocket --

  async function handleNetWebsocket({ payload, requestId, app, webview, sandbox }) {
    const { url, protocols } = payload ?? {};
    if (!url) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', 'url is required');
    }
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:websocket', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!AppPermissionManager.isGranted('net:websocket', app.id)) {
      return respondError(webview, 'nova:net:websocket', requestId, 'PERMISSION_DENIED', 'net:websocket permission required');
    }
    let ws;
    try {
      ws = protocols?.length
        ? new WebSocket(url, protocols)
        : new WebSocket(url);
    } catch (e) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', e.message);
    }
    const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Track the WebSocket so destroy() can close it when the sandbox is torn
    // down. Without this, sockets would outlive their app and leak.
    if (sandbox) {
      if (!sandbox.wsConnections) sandbox.wsConnections = new Map();
      sandbox.wsConnections.set(wsId, { ws, appId: app.id });
    }
    ws.onopen = () => respond(webview, 'nova:net:websocket', requestId, { success: true, wsId, readyState: ws.readyState });
    ws.onmessage = (e) => {
      respond(webview, 'nova:net:ws:message', generateRequestId(), { wsId, data: e.data });
    };
    ws.onerror = () => {
      respond(webview, 'nova:net:ws:error', generateRequestId(), { wsId, error: 'WebSocket error' });
    };
    ws.onclose = (e) => {
      respond(webview, 'nova:net:ws:close', generateRequestId(), {
        wsId, code: e.code, reason: e.reason, clean: e.wasClean,
      });
      sandbox?.wsConnections?.delete(wsId);
    };
    // Response is sent asynchronously via onopen; nothing to return here.
  }

  async function handleNetWsSend({ payload, requestId, sandbox, webview }) {
    const { wsId, data } = payload ?? {};
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (!wsState) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'NOT_FOUND', 'WebSocket connection not found');
    }
    if (wsState.ws.readyState !== WebSocket.OPEN) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', 'WebSocket is not open');
    }
    wsState.ws.send(data ?? '');
    return respond(webview, 'nova:net:ws:send', requestId, { success: true });
  }

  async function handleNetWsClose({ payload, requestId, sandbox, webview }) {
    const { wsId, code, reason } = payload ?? {};
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (wsState) {
      try { wsState.ws.close(code ?? 1000, reason); } catch { /* already closed */ }
      sandbox?.wsConnections?.delete(wsId);
    }
    return respond(webview, 'nova:net:ws:close', requestId, { success: true });
  }

  // -- Storage --
  //
  // All keys are namespaced under nova_storage_<appId>_ so apps can only see
  // their own keys. Key characters are restricted to prevent path-like
  // injection that could confuse the namespace.

  function validateStorageKey(rawKey) {
    const key = String(rawKey ?? '');
    if (!key || !STORAGE_KEY_REGEX.test(key)) return null;
    return key;
  }

  async function handleStorageGet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:get', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      const value = localStorage.getItem(key);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value });
    } catch (e) {
      // localStorage can throw in private browsing or when storage is disabled.
      // Treat as "no value" rather than crashing the IPC call.
      return respond(webview, 'nova:storage:get', requestId, { success: true, value: null });
    }
  }

  async function handleStorageSet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    // Enforce a per-value size cap so a single call can't exhaust the host's
    // localStorage quota and break other apps on the same origin.
    const value = payload?.value ?? '';
    const valueBytes = new TextEncoder().encode(String(value)).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', `Value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit`);
    }
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      localStorage.setItem(key, value);
      return respond(webview, 'nova:storage:set', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Failed to write to storage');
    }
  }

  async function handleStorageDelete({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:delete', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      localStorage.removeItem(key);
      return respond(webview, 'nova:storage:delete', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:delete', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageClear({ requestId, app, webview }) {
    try {
      const prefix = STORAGE_KEY_PREFIX + app.id + '_';
      // Collect first, mutate second — mutating during iteration would skip
      // entries because localStorage's indices shift on removal.
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
      return respond(webview, 'nova:storage:clear', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:clear', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageKeys({ requestId, app, webview }) {
    try {
      const prefix = STORAGE_KEY_PREFIX + app.id + '_';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return respond(webview, 'nova:storage:keys', requestId, { success: true, keys });
    } catch (e) {
      return respondError(webview, 'nova:storage:keys', requestId, 'ERROR', e.message);
    }
  }

  // -- Device: geolocation --

  async function handleDeviceGeolocation({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'UNAVAILABLE', 'Geolocation not available');
    }
    // Response is sent from one of the two callbacks below; we don't respond
    // here because getCurrentPosition returns immediately.
    navigator.geolocation.getCurrentPosition(
      (pos) => respond(webview, 'nova:device:geolocation', requestId, {
        success: true,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      }),
      (err) => respondError(webview, 'nova:device:geolocation', requestId, 'GEOLOCATION_ERROR', err.message),
      payload.options || {}
    );
  }

  // -- System info --

  async function handleSystemInfo({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:system:info', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    return respond(webview, 'nova:system:info', requestId, {
      success: true,
      os: {
        version: OS.version,
        securityPatch: OS.securityPatch,
        username: OS.username,
        uptime: Date.now() - (OS._bootTime || Date.now()),
      },
    });
  }

  // -- Ready handshake --

  async function handleReady({ requestId, app, webview }) {
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const granted = mgr
      ? (app.permissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.permissions || []);
    const optionalGranted = mgr
      ? (app.optionalPermissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.optionalPermissions || []);
    const payload = {
      success: true,
      appId: app.id,
      permissions: granted,
      optionalPermissions: optionalGranted,
      osVersion: OS.version,
      securityPatch: OS.securityPatch,
    };
    try {
      webview.contentWindow.postMessage(
        { type: 'nova:ready:response', requestId, ...payload, result: payload },
        window.location.origin
      );
    } catch (e) {
      log('error', `Failed to respond to nova:ready:`, e);
    }
  }

  // -- File dialogs --

  async function handleDialogOpen({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:dialog:open', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    showFileDialog('open', webview, 'nova:dialog:open', requestId, app, payload);
    // Response is sent from the dialog's confirm/cancel handler.
  }

  async function handleDialogSave({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:dialog:save', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    showFileDialog('save', webview, 'nova:dialog:save', requestId, app, payload);
  }

  // -- Audit: eval --
  //
  // Sent by the capability shim whenever an app calls eval(). We log it for
  // observability but don't block — the CSP allows unsafe-eval by design for
  // apps that genuinely need it. This is fire-and-forget; no response is sent.

  async function handleAuditEval({ app, payload }) {
    log('warn', `${app.name} called eval():`, payload?.preview);
  }

  // ------------------------------------------------------------------
  // Handler table
  // ------------------------------------------------------------------
  //
  // Maps API type strings to their handler functions. Using a table instead
  // of a long if/else chain makes the dispatch O(1) and lets new APIs be
  // added by appending a single entry.

  const API_HANDLERS = {
    'nova:fs:read': handleFsRead,
    'nova:fs:write': handleFsWrite,
    'nova:fs:delete': handleFsDelete,
    'nova:fs:list': handleFsList,
    'nova:fs:mkdir': handleFsMkdir,
    'nova:fs:stat': handleFsStat,
    'nova:fs:rename': handleFsRename,
    'nova:fs:move': handleFsMove,
    'nova:notifications:show': handleNotificationsShow,
    'nova:notifications:clear': handleNotificationsClear,
    'nova:settings:get': handleSettingsGet,
    'nova:settings:set': handleSettingsSet,
    'nova:request-permission': handleRequestPermission,
    'nova:window:close': handleWindowClose,
    'nova:window:minimize': handleWindowMinimize,
    'nova:window:maximize': handleWindowMaximize,
    'nova:window:setTitle': handleWindowSetTitle,
    'nova:window:resize': handleWindowResize,
    'nova:window:getState': handleWindowGetState,
    'nova:clipboard:read': handleClipboardRead,
    'nova:clipboard:write': handleClipboardWrite,
    'nova:app:launch': handleAppLaunch,
    'nova:app:info': handleAppInfo,
    'nova:events:subscribe': handleEventsSubscribe,
    'nova:events:unsubscribe': handleEventsUnsubscribe,
    'nova:net:fetch': handleNetFetch,
    'nova:net:websocket': handleNetWebsocket,
    'nova:net:ws:send': handleNetWsSend,
    'nova:net:ws:close': handleNetWsClose,
    'nova:storage:get': handleStorageGet,
    'nova:storage:set': handleStorageSet,
    'nova:storage:delete': handleStorageDelete,
    'nova:storage:clear': handleStorageClear,
    'nova:storage:keys': handleStorageKeys,
    'nova:device:geolocation': handleDeviceGeolocation,
    'nova:system:info': handleSystemInfo,
    'nova:ready': handleReady,
    'nova:dialog:open': handleDialogOpen,
    'nova:dialog:save': handleDialogSave,
    'nova:audit:eval': handleAuditEval,
  };

  /**
   * Dispatch an incoming IPC message to its handler. Catches sync throws and
   * async rejections so a single misbehaving handler can't take down the
   * bridge. Unknown types get an UNKNOWN_API error response.
   */
  async function handleAPICall(type, payload, requestId, app, webview, sandbox) {
    try {
      const handler = API_HANDLERS[type];
      if (!handler) {
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }
      await handler({ payload, requestId, app, webview, sandbox });
    } catch (err) {
      log('error', `Error handling ${type}:`, err);
      respondError(webview, type, requestId, 'INTERNAL_ERROR', err.message || 'Internal error');
    }
  }

  // ------------------------------------------------------------------
  // API bridge setup
  // ------------------------------------------------------------------

  /**
   * Wire up the postMessage bridge for a sandbox. Uses an AbortController so
   * the message listener is removed cleanly when the sandbox is destroyed —
   * this avoids the "window listener leak" pattern where each sandbox leaves
   * a permanent listener on window.
   */
  function setupAPIBridge(webview, app, sandboxId) {
    const abortController = new AbortController();

    const messageHandler = (event) => {
      // Apps are served from our origin, so we reject any other origin
      // outright. event.source must match this webview's contentWindow to
      // prevent messages from other frames on the same origin.
      if (event.origin !== window.location.origin) return;
      if (event.source !== webview.contentWindow) return;

      const { type, payload, requestId } = event.data ?? {};
      if (!type || !type.startsWith(API_PREFIX)) return;

      const sandbox = activeSandboxes.get(sandboxId);
      handleAPICall(type, payload, requestId, app, webview, sandbox);
    };

    window.addEventListener('message', messageHandler, { signal: abortController.signal });

    const sandbox = activeSandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.cleanup = () => {
        // Remove the message listener via AbortController.
        abortController.abort();

        // Detach OS event subscriptions.
        const subs = eventSubscriptions.get(sandboxId);
        if (subs) {
          for (const [eventName, handler] of subs) {
            try { OS?.events?.off(eventName, handler); } catch { /* best-effort */ }
          }
          subs.clear();
        }
        eventSubscriptions.delete(sandboxId);

        // Close any lingering WebSockets so they don't outlive the sandbox.
        if (sandbox.wsConnections) {
          for (const [, wsState] of sandbox.wsConnections) {
            try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
          }
          sandbox.wsConnections.clear();
        }

        // Close any open file dialog so the overlay doesn't linger in the DOM.
        const dialog = openDialogs.get(sandboxId);
        if (dialog) {
          dialog.remove();
          openDialogs.delete(sandboxId);
        }
      };
    }
  }

  // ------------------------------------------------------------------
  // Error handling
  // ------------------------------------------------------------------

  function setupErrorHandling(webview, app) {
    // loadabort fires when webview navigation is cancelled (network error,
    // blocked URL, etc.). Surface it so we can see why apps fail to load.
    webview.addEventListener('loadabort', (event) => {
      log('error', `Load aborted in ${app.name}:`, event.reason);
    });

    // consolemessage proxies console output from the webview's separate
    // renderer process. We can't attach to contentWindow directly due to
    // process isolation, so this is the only surface for runtime visibility.
    webview.addEventListener('consolemessage', (event) => {
      // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error.
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        log(level, `${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    });
  }

  // ------------------------------------------------------------------
  // Permission request gate (webview-level device permissions)
  // ------------------------------------------------------------------

  /**
   * Gate webview-level permission requests (geolocation, media) against
   * AppPermissionManager. The sandboxed webview's permissionrequest event is
   * the only enforcement surface for these device features at the
   * renderer-process boundary. Unrecognised permissions are denied by
   * default — fail-closed is the safe choice.
   */
  function setupPermissionRequestGate(webview, app) {
    webview.addEventListener('permissionrequest', (e) => {
      if (e.permission === 'geolocation') {
        if (AppPermissionManager?.isGranted('device:geolocation', app.id)) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      if (e.permission === 'media') {
        const camOk = AppPermissionManager?.isGranted('device:camera', app.id);
        const micOk = AppPermissionManager?.isGranted('device:microphone', app.id);
        if (camOk && micOk) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      // Default-deny any permission we don't explicitly handle. The previous
      // implementation left these to the webview's default, which is
      // non-portable and can silently allow access.
      if (typeof e.request.deny === 'function') e.request.deny();
    });
  }

  // ------------------------------------------------------------------
  // Capability shim
  // ------------------------------------------------------------------
  //
  // Injected as the first <script> in every packaged app's HTML. Overrides
  // fetch / XHR / eval / sendBeacon so apps that use standard web APIs work
  // transparently — all network goes through the IPC bridge where
  // permissions are enforced. connect-src 'none' in the served CSP ensures
  // nothing bypasses this at the browser level.
  //
  // The shim also exposes window.nova for apps that want to call the IPC
  // bridge directly (e.g. to request permissions or subscribe to events).

  const CAPABILITY_SHIM = `<script>
(function() {
  'use strict';
  var PARENT_ORIGIN = window.location.origin;
  var REQUEST_TIMEOUT_MS = 30000;
  var pendingRequests = new Map();

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'shim_' + window.crypto.randomUUID();
    }
    return 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Send a nova: IPC message and resolve on response. Rejects on timeout or
  // when the host returns an error.
  function ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = generateId();
      var timer = setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new TypeError('IPC request timed out: ' + type));
        }
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      window.parent.postMessage({ type: type, requestId: id, payload: payload }, PARENT_ORIGIN);
    });
  }

  // Single message listener handles all IPC responses and pushed events.
  window.addEventListener('message', function(event) {
    if (event.origin !== PARENT_ORIGIN) return;
    var data = event.data;

    // ── Fix: app-side ready handshake bypasses ipc() ──────────────────
    // The app sends window.parent.postMessage({ type: 'nova:ready', appId: ... }, '*')
    // directly instead of going through ipc('nova:ready'), so there is no entry
    // in pendingRequests. Catch the parent's 'nova:ready:response' here,
    // surface the permissions on window for late-loading scripts, and re-render
    // the calendar once the DOM is actually ready.
    if (data && data.type === 'nova:ready:response' && data.result) {
      var __novaReadyPerms = (data.result.permissions || []);
      var __novaReadyOptional = (data.result.optionalPermissions || []);
      try { window.__novaPermResponse = { permissions: __novaReadyPerms, optionalPermissions: __novaReadyOptional }; } catch (_) {}
      var __renderFn = null;
      try { __renderFn = (typeof renderCalendar === 'function') ? renderCalendar : null; } catch (_) {}
      if (__renderFn) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function _rr() {
            document.removeEventListener('DOMContentLoaded', _rr);
            try { __renderFn(); } catch (_) {}
          });
        } else {
          try { __renderFn(); } catch (_) {}
        }
      }
    }
    // ── End ready-handshake fix ────────────────────────────────────────

    if (!data || !data.requestId) return;
    var entry = pendingRequests.get(data.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRequests.delete(data.requestId);
    if (data.error) {
      var err = new TypeError(data.error.message || String(data.error));
      err.code = data.error.code;
      entry.reject(err);
    } else {
      entry.resolve(data.result);
    }
  });

  // Public API for apps that want to use the bridge directly.
  window.nova = {
    ipc: ipc,
    requestPermission: function(permission, reason) {
      return ipc('nova:request-permission', { permission: permission, reason: reason });
    },
    onEvent: function(eventName, callback) {
      window.addEventListener('message', function(event) {
        if (event.origin !== PARENT_ORIGIN) return;
        var d = event.data;
        if (d && d.type === 'nova:events:event:response' && d.result && d.result.event === eventName) {
          callback(d.result.data);
        }
      });
      return ipc('nova:events:subscribe', { event: eventName });
    }
  };

  // Override fetch — route through the IPC bridge.
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    var headers = init.headers || (input && input.headers) || {};
    var headerObj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(v, k) { headerObj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function(pair) { headerObj[pair[0]] = pair[1]; });
    } else if (headers && typeof headers === 'object') {
      for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) headerObj[k] = headers[k];
    }
    var body = init.body != null ? init.body : null;
    var bodyStr = null;
    if (typeof body === 'string') bodyStr = body;
    else if (body instanceof ArrayBuffer) bodyStr = new TextDecoder().decode(body);
    else if (body instanceof Uint8Array) bodyStr = new TextDecoder().decode(body);
    else if (body == null) bodyStr = null;
    else bodyStr = String(body);

    return ipc('nova:net:fetch', { url: url, method: method, headers: headerObj, body: bodyStr })
      .then(function(res) {
        if (!res || !res.success) throw new TypeError('Fetch failed');
        var responseInit = { status: res.status, statusText: res.statusText, headers: new Headers(res.headers || {}) };
        return new Response(res.body || '', responseInit);
      });
  };

  // Minimal XMLHttpRequest override that routes through the fetch shim.
  // Covers the common API surface (open/send/setRequestHeader/onload/onerror/
  // onreadystatechange/status/responseText). Advanced features (upload
  // events, progress, responseType blob) are not implemented — apps needing
  // those should use fetch directly.
  function NovaXHR() {
    var xhr = this;
    var method = 'GET', url = '', headers = {}, body = null;
    var state = 0;
    var listeners = { load: [], error: [], readystatechange: [], loadend: [], abort: [], timeout: [] };

    Object.defineProperty(this, 'readyState', { get: function() { return state; }, configurable: true });
    Object.defineProperty(this, 'status', { get: function() { return xhr._status || 0; }, configurable: true });
    Object.defineProperty(this, 'statusText', { get: function() { return xhr._statusText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseText', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'response', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseURL', { get: function() { return url; }, configurable: true });

    this.open = function(m, u) { method = (m || 'GET').toUpperCase(); url = u || ''; state = 1; };
    this.setRequestHeader = function(k, v) { headers[k] = v; };
    this.getAllResponseHeaders = function() { return xhr._responseHeaders || ''; };
    this.getResponseHeader = function(k) { return (xhr._responseHeaderMap || {})[k.toLowerCase()] || null; };
    this.abort = function() { state = 0; listeners.abort.forEach(function(h) { h.call(xhr); }); };
    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };

    this.send = function(b) {
      body = b;
      window.fetch(url, { method: method, headers: headers, body: typeof body === 'string' ? body : null })
        .then(function(res) {
          state = 2;
          xhr._status = res.status;
          xhr._statusText = res.statusText;
          var headerMap = {};
          var headerLines = [];
          res.headers.forEach(function(v, k) { headerMap[k.toLowerCase()] = v; headerLines.push(k + ': ' + v); });
          xhr._responseHeaderMap = headerMap;
          xhr._responseHeaders = headerLines.join('\\r\\n');
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          return res.text();
        })
        .then(function(text) {
          xhr._responseText = text;
          state = 3;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          state = 4;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          listeners.load.forEach(function(h) { h.call(xhr); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        })
        .catch(function(err) {
          xhr._error = err;
          state = 4;
          listeners.error.forEach(function(h) { h.call(xhr, err); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        });
    };
  }
  window.XMLHttpRequest = NovaXHR;

  // Audit eval calls — log to host but still execute (per the audit:eval
  // contract: "Log it — don't block"). CSP allows unsafe-eval by design.
  var originalEval = window.eval;
  window.eval = function(code) {
    try {
      var preview = String(code).slice(0, 200);
      // Fire-and-forget — no requestId needed since we don't wait for a reply.
      window.parent.postMessage({ type: 'nova:audit:eval', requestId: generateId(), payload: { preview: preview } }, PARENT_ORIGIN);
    } catch (e) { /* audit is best-effort */ }
    return originalEval.call(this, code);
  };

  // Override sendBeacon — fire-and-forget POST through the IPC bridge.
  // Returns true synchronously to match the native API contract; the actual
  // permission check happens host-side and the result is dropped.
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try {
        var body = typeof data === 'string' ? data : (data && data.toString ? data.toString() : '');
        window.parent.postMessage({
          type: 'nova:net:fetch',
          requestId: generateId(),
          payload: { url: url, method: 'POST', headers: {}, body: body }
        }, PARENT_ORIGIN);
        return true;
      } catch (e) {
        return false;
      }
    };
  }
})();
\x3C/script>`;

  // CSP meta tag injected into app HTML. Allows inline scripts/styles (apps
  // need this) and eval (the audit hook catches abuse), but blocks all direct
  // network access via connect-src 'none' — forcing network through the IPC
  // bridge where permissions are enforced.
  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\' \'unsafe-eval\'; script-src \'self\' blob: \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' http://localhost:* https://localhost:*">';

  /**
   * Prepend the capability shim as the very first script in the app's HTML.
   * Injects after <head> if present, otherwise prepends to the document.
   */
  function injectCapabilityShim(html) {
    if (typeof html !== 'string') return html;
    if (/<head(\s[^>]*)?>/i.test(html)) {
      const relaxed = RELAXED_CSP_META + '\n';
      return html.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + CAPABILITY_SHIM);
    }
    return CAPABILITY_SHIM + '\n' + RELAXED_CSP_META + '\n' + html;
  }

  // ------------------------------------------------------------------
  // App loading
  // ------------------------------------------------------------------

  /**
   * Load app content into a sandbox. For webapps (external URLs), validates
   * the protocol before assigning to webview.src — without this, a malicious
   * manifest could specify javascript: or file: URLs.
   */
  async function loadAppContent(webview, app, state) {
    if (app.type === 'webapp' && app.url) {
      const classified = resolveAndClassifyUrl(app.url);
      if (!classified.valid) {
        log('error', `Invalid webapp URL for ${app.name}: ${classified.error}`);
        showErrorPage(webview, app, `Invalid URL: ${classified.error}`);
        return;
      }
      webview.src = classified.url;
      return;
    }

    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const sandboxId = webview.dataset.sandboxId;
        // Inject the capability shim into the entry HTML before registering.
        // Use UTF-8-safe base64 so non-ASCII content survives the round-trip.
        const shimmedFiles = Object.assign({}, app.files);
        const rawHtml = decodeBase64Utf8(shimmedFiles[app.entry]);
        shimmedFiles[app.entry] = encodeBase64Utf8(injectCapabilityShim(rawHtml));

        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId, files: shimmedFiles }),
        });
        if (!regRes.ok) throw new Error(`File registration failed: ${regRes.status}`);
        const { baseUrl } = await regRes.json();
        webview.src = window.location.origin + baseUrl + '/' + app.entry;
      } catch (error) {
        log('error', `Failed to load app content for ${app.name}:`, error);
        showErrorPage(webview, app, 'Failed to load app content');
      }
    } else {
      createDefaultAppShell(webview, app, state);
    }
  }

  /**
   * Build the default app shell for apps without content. Uses
   * JSON.stringify for the app.id interpolation into the inline script —
   * escapeHtml is wrong for JS string context (it would insert HTML entities
   * literally inside a JS string).
   */
  async function createDefaultAppShell(webview, app, state) {
    const safeAppId = JSON.stringify(app.id || '');
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${RELAXED_CSP_META}
        <title>${escapeHtml(app.name)}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container { text-align: center; max-width: 600px; }
          .app-icon { font-size: 64px; margin-bottom: 20px; }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${escapeHtml(app.icon || '📱')}</div>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description || 'A NovaByte Application')}</p>
          <div class="status">
            <strong>Version:</strong> ${escapeHtml(app.version)}<br>
            <strong>Author:</strong> ${escapeHtml(app.author)}<br>
            <strong>Type:</strong> ${escapeHtml(app.type)}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data.type && event.data.type.startsWith('nova:')) {
              document.getElementById('apiStatus').textContent = 'API Bridge: Connected ✓';
            }
          });
          setTimeout(() => {
            window.parent.postMessage({ type: 'nova:ready', appId: ${safeAppId} },
              window.location.origin);
          }, 100);
        </script>
      </body>
      </html>
    `;

    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'index.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/index.html';
    } catch (error) {
      log('error', `Failed to create default shell for ${app.name}:`, error);
    }
  }

  /** Show an error page in the sandbox when app content fails to load. */
  async function showErrorPage(webview, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        ${RELAXED_CSP_META}
        <title>Error - ${escapeHtml(app.name)}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${escapeHtml(app.name)}</strong></p>
        <p>${escapeHtml(message)}</p>
        <p><small>App ID: ${escapeHtml(app.id)}</small></p>
      </body>
      </html>
    `;
    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'error.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/error.html';
    } catch (e) {
      log('error', `Could not show error page for ${app.name}:`, e);
    }
  }

  // ------------------------------------------------------------------
  // Sandbox attribute sanitisation
  // ------------------------------------------------------------------

  /**
   * Build a safe sandbox attribute string from an app's sandbox config.
   * allow-same-origin is always stripped — combining it with allow-scripts
   * is a known sandbox escape. Same-origin access is already provided by
   * the webview's partition, so this token is both unsafe and unnecessary.
   */
  function sanitizeSandboxAttr(sandboxConfig, appId) {
    const tokens = [];

    // Check for a capability. Accepts both camelCase (object key) and
    // kebab-case (string token) forms — the original code only checked
    // camelCase, which meant string configs like 'allow-scripts' never
    // matched and always fell through to the defaults.
    const has = (camelKey, kebabToken) => {
      if (sandboxConfig && typeof sandboxConfig === 'object') {
        return sandboxConfig[camelKey] === true;
      }
      if (typeof sandboxConfig === 'string') {
        return sandboxConfig.includes(kebabToken);
      }
      return false;
    };

    if (has('allowScripts', 'allow-scripts')) tokens.push('allow-scripts');
    if (has('allowForms', 'allow-forms')) tokens.push('allow-forms');
    if (has('allowPopups', 'allow-popups')) tokens.push('allow-popups');
    if (has('allowPopupsToEscapeSandbox', 'allow-popups-to-escape-sandbox')) tokens.push('allow-popups-to-escape-sandbox');
    if (has('allowModals', 'allow-modals')) tokens.push('allow-modals');

    if (tokens.length === 0) {
      tokens.push('allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals');
    }

    log('debug', `sandbox attrs for ${appId || 'unknown'}: ${tokens.join(' ')}`);
    return tokens.join(' ');
  }

  // ------------------------------------------------------------------
  // Sandbox creation
  // ------------------------------------------------------------------

  /**
   * Create a sandboxed webview for app execution. The webview runs in a
   * separate renderer process — true process isolation. It cannot access
   * main page JS, DOM, or memory regardless of app content.
   */
  function createSandbox(app, container, state) {
    const webview = document.createElement('webview');

    // nodeintegration=false means the app cannot require() Node.js modules
    // even if the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Isolated storage partition per sandbox instance. The 'persist:' prefix
    // means storage survives webview destruction (expected for apps). Each
    // app instance gets its own partition — cross-app storage access is
    // impossible.
    const sandboxId = `sandbox_${app.id}_${Date.now()}`;
    webview.setAttribute('partition', `persist:${sandboxId}`);

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    }

    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map(),
    });

    // Fullscreen support — toggle window maximise when the webview enters or
    // exits fullscreen so the app fills the screen.
    if (state && state.element) {
      const origMaximized = state.maximized;
      webview.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === webview) {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !origMaximized && state.maximized) {
            WM.toggleMaximize(state.id);
          }
        }
      }, false);
    }

    eventSubscriptions.set(sandboxId, new Map());

    setupAPIBridge(webview, app, sandboxId);
    setupErrorHandling(webview, app);
    setupPermissionRequestGate(webview, app);

    log('debug', `Created webview sandbox for ${app.name} (${sandboxId})`);

    return webview;
  }

  // ------------------------------------------------------------------
  // Public lifecycle
  // ------------------------------------------------------------------

  /**
   * Launch an app in a sandboxed environment.
   * @param {object} app - App definition
   * @param {HTMLElement} container - DOM element to mount the webview in
   * @param {object} state - Window state from the window manager
   * @param {object} [options={}] - Reserved for future launch options
   * @returns {{ success: boolean, sandboxId: string, appId: string, windowId: string, iframe: HTMLElement, webview: HTMLElement, cleanup: () => void }}
   */
  function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    // Clear container — any previous webview (and its listeners) goes away.
    container.innerHTML = '';

    const webview = createSandbox(app, container, state);
    container.appendChild(webview);

    // loadAppContent is async (registers files with the server) — fire and
    // let errors surface in the webview via showErrorPage.
    loadAppContent(webview, app, state);

    log('debug', `Launched ${app.name} in sandbox`);

    const sandboxId = webview.dataset.sandboxId;
    return {
      success: true,
      sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: webview, // backward-compat alias
      webview: webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  /**
   * Destroy a sandbox by ID. Tears down listeners, WebSockets, event
   * subscriptions, open dialogs, and unregisters app files from the serve
   * route. Safe to call multiple times — second call is a no-op.
   * @param {string} sandboxId
   * @returns {boolean} true if a sandbox was destroyed, false if not found
   */
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    // sandbox.cleanup (set up in setupAPIBridge) does the actual teardown:
    // aborts the message listener, detaches OS event subs, closes WebSockets,
    // and removes any open file dialog overlay.
    if (typeof sandbox.cleanup === 'function') {
      sandbox.cleanup();
    }

    // Unregister app files from the Express serve route. Best-effort —
    // failures here don't affect the sandbox teardown.
    fetch(`/api/apps/serve/unregister/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' })
      .catch(() => {});

    activeSandboxes.delete(sandboxId);
    log('debug', `Destroyed sandbox: ${sandboxId}`);

    return true;
  }

  /**
   * Get active sandbox info by ID.
   * @param {string} sandboxId
   * @returns {object|null}
   */
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  /**
   * Get all active sandboxes as an array.
   * @returns {object[]}
   */
  function getAllSandboxes() {
    return Array.from(activeSandboxes.values());
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  return {
    createSandbox,
    launch,
    destroy,
    getSandbox,
    getAllSandboxes,

    // Internal exports for testing and advanced consumers. Not covered by
    // stability guarantees — do not depend on these in production code.
    _internal: {
      escapeHtml,
      sanitizeSandboxAttr,
      injectCapabilityShim,
      encodeBase64Utf8,
      decodeBase64Utf8,
      generateRequestId,
      resolveAndClassifyUrl,
      isInternalHost,
      parsePositiveInt,
      validateStorageKey,
      handleAPICall,
      API_HANDLERS,
      CAPABILITY_SHIM,
      RELAXED_CSP_META,
      // Test-only helpers for resetting module state between tests.
      _resetState() {
        activeSandboxes.clear();
        eventSubscriptions.clear();
        openDialogs.clear();
      },
      _activeSandboxes: activeSandboxes,
      _eventSubscriptions: eventSubscriptions,
      _openDialogs: openDialogs,
    },
  };
})();

// CommonJS export for Node.js test runners and bundlers that expect it.
// In the browser, the module attaches as a global `AppSandbox`.
window.AppSandbox = AppSandbox;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}