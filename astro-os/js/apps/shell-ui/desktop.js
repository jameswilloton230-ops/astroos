/* ═══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

function getShellSystemSetting(key) {
  const settings = window.AstroOSSystem?.settings;
  if (!settings || typeof settings.get !== 'function') {
    throw new Error('Astro System settings API is unavailable');
  }
  return settings.get(key);
}

function getShellSystemSettingsSnapshot() {
  const settings = window.AstroOSSystem?.settings;
  if (!settings || typeof settings.exportSnapshot !== 'function') {
    throw new Error('Astro System settings API is unavailable');
  }
  return settings.exportSnapshot();
}

// FIX: themes object hoisted to module-level constant — was re-allocated on every applyTheme() call
const THEMES = {
  'nova-dark': {
    '--bg-base': '#07090f',
    '--bg-elevated': 'rgba(14, 18, 28, 0.80)',
    '--bg-overlay': 'rgba(20, 26, 40, 0.70)',
    '--bg-sunken': '#030508',
    '--text-primary': '#e6edf3',
    '--text-secondary': '#8b949e',
    '--text-muted': '#484f58',
    '--text-link': '#58a6ff',
    '--text-danger': '#f85149',
    '--text-success': '#3fb950',
    '--text-warning': '#d29922',
    '--accent': '#58a6ff',
    '--accent-hover': '#79b8ff',
    '--accent-muted': 'rgba(88, 166, 255, 0.15)',
    '--window-bg': 'rgba(10, 14, 22, 0.62)',
    '--surface-overlay': 'rgba(8, 12, 20, 0.78)',
    '--surface-panel': 'rgba(8, 12, 20, 0.82)',
    '--surface-header': 'rgba(8, 12, 20, 0.32)',
    '--surface-card': 'rgba(8, 12, 20, 0.46)',
    '--surface-card-hover': 'rgba(18, 26, 40, 0.68)',
    '--surface-card-read': 'rgba(4, 7, 12, 0.52)',
    '--surface-border': 'rgba(255, 255, 255, 0.14)',
    '--surface-border-subtle': 'rgba(255, 255, 255, 0.08)',
    '--surface-rim': 'rgba(255, 255, 255, 0.16)',
    '--surface-highlight': 'rgba(255, 255, 255, 0.08)',
    '--window-border': 'rgba(255, 255, 255, 0.12)',
    '--window-shadow': '0 32px 64px rgba(0,0,0,0.50), 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)',
    '--taskbar-bg': 'rgba(6, 10, 18, 0.65)',
    '--taskbar-border': 'rgba(255, 255, 255, 0.08)',
    '--border-subtle': 'rgba(255, 255, 255, 0.06)',
    '--border-default': 'rgba(255, 255, 255, 0.12)',
    '--border-strong': 'rgba(255, 255, 255, 0.25)',
    '--r-window': '16px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'nova-light': {
    '--bg-base': '#ffffff',
    '--bg-elevated': '#f6f8fa',
    '--bg-overlay': '#ffffff',
    '--bg-sunken': '#eaeef2',
    '--text-primary': '#24292f',
    '--text-secondary': '#57606a',
    '--text-muted': '#6e7781',
    '--text-link': '#0969da',
    '--text-danger': '#cf222e',
    '--text-success': '#1a7f37',
    '--text-warning': '#9a6700',
    '--accent': '#0969da',
    '--accent-hover': '#0550ae',
    '--accent-muted': 'rgba(9, 105, 218, 0.1)',
    '--window-bg': 'rgba(255, 255, 255, 0.82)',
    '--surface-overlay': 'rgba(246, 248, 250, 0.94)',
    '--surface-panel': 'rgba(246, 248, 250, 0.96)',
    '--surface-header': 'rgba(234, 238, 242, 0.72)',
    '--surface-card': 'rgba(255, 255, 255, 0.72)',
    '--surface-card-hover': 'rgba(234, 238, 242, 0.90)',
    '--surface-card-read': 'rgba(234, 238, 242, 0.68)',
    '--surface-border': 'rgba(27, 31, 35, 0.14)',
    '--surface-border-subtle': 'rgba(27, 31, 35, 0.08)',
    '--surface-rim': 'rgba(27, 31, 35, 0.12)',
    '--surface-highlight': 'rgba(255, 255, 255, 0.76)',
    '--window-border': 'rgba(27, 31, 35, 0.12)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.12), 0 6px 20px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.90)',
    '--taskbar-bg': 'rgba(246, 248, 250, 0.72)',
    '--taskbar-border': 'rgba(27, 31, 35, 0.12)',
    '--border-subtle': 'rgba(27, 31, 35, 0.06)',
    '--border-default': 'rgba(27, 31, 35, 0.12)',
    '--border-strong': 'rgba(27, 31, 35, 0.25)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'nord': {
    '--bg-base': '#2e3440',
    '--bg-elevated': '#3b4252',
    '--bg-overlay': '#434c5e',
    '--bg-sunken': '#242933',
    '--text-primary': '#eceff4',
    '--text-secondary': '#d8dee9',
    '--text-muted': '#4c566a',
    '--text-link': '#88c0d0',
    '--text-danger': '#bf616a',
    '--text-success': '#a3be8c',
    '--text-warning': '#ebcb8b',
    '--accent': '#88c0d0',
    '--accent-hover': '#81a1c1',
    '--accent-muted': 'rgba(136, 192, 208, 0.15)',
    '--window-bg': 'rgba(46, 52, 64, 0.64)',
    '--surface-overlay': 'rgba(46, 52, 64, 0.90)',
    '--surface-panel': 'rgba(46, 52, 64, 0.94)',
    '--surface-header': 'rgba(36, 41, 51, 0.72)',
    '--surface-card': 'rgba(36, 41, 51, 0.62)',
    '--surface-card-hover': 'rgba(67, 76, 94, 0.82)',
    '--surface-card-read': 'rgba(36, 41, 51, 0.72)',
    '--surface-border': 'rgba(236, 239, 244, 0.16)',
    '--surface-border-subtle': 'rgba(236, 239, 244, 0.09)',
    '--surface-rim': 'rgba(236, 239, 244, 0.16)',
    '--surface-highlight': 'rgba(236, 239, 244, 0.08)',
    '--window-border': 'rgba(236, 239, 244, 0.12)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.07)',
    '--taskbar-bg': 'rgba(36, 41, 51, 0.65)',
    '--taskbar-border': 'rgba(236, 239, 244, 0.10)',
    '--border-subtle': 'rgba(236, 239, 244, 0.08)',
    '--border-default': 'rgba(236, 239, 244, 0.15)',
    '--border-strong': 'rgba(236, 239, 244, 0.30)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'dracula': {
    '--bg-base': '#282a36',
    '--bg-elevated': '#44475a',
    '--bg-overlay': '#44475a',
    '--bg-sunken': '#21222c',
    '--text-primary': '#f8f8f2',
    '--text-secondary': '#6272a4',
    '--text-muted': '#484a66',
    '--text-link': '#8be9fd',
    '--text-danger': '#ff5555',
    '--text-success': '#50fa7b',
    '--text-warning': '#f1fa8c',
    '--accent': '#bd93f9',
    '--accent-hover': '#ff79c6',
    '--accent-muted': 'rgba(189, 147, 249, 0.15)',
    '--window-bg': 'rgba(40, 42, 54, 0.64)',
    '--surface-overlay': 'rgba(40, 42, 54, 0.90)',
    '--surface-panel': 'rgba(40, 42, 54, 0.94)',
    '--surface-header': 'rgba(30, 31, 41, 0.72)',
    '--surface-card': 'rgba(30, 31, 41, 0.62)',
    '--surface-card-hover': 'rgba(68, 71, 90, 0.82)',
    '--surface-card-read': 'rgba(30, 31, 41, 0.72)',
    '--surface-border': 'rgba(248, 248, 242, 0.16)',
    '--surface-border-subtle': 'rgba(248, 248, 242, 0.09)',
    '--surface-rim': 'rgba(248, 248, 242, 0.16)',
    '--surface-highlight': 'rgba(248, 248, 242, 0.08)',
    '--window-border': 'rgba(248, 248, 242, 0.12)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(189,147,249,0.08)',
    '--taskbar-bg': 'rgba(30, 31, 41, 0.65)',
    '--taskbar-border': 'rgba(248, 248, 242, 0.10)',
    '--border-subtle': 'rgba(248, 248, 242, 0.08)',
    '--border-default': 'rgba(248, 248, 242, 0.15)',
    '--border-strong': 'rgba(248, 248, 242, 0.30)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'catppuccin': {
    '--bg-base': '#1e1e2e',
    '--bg-elevated': '#313244',
    '--bg-overlay': '#45475a',
    '--bg-sunken': '#181825',
    '--text-primary': '#cdd6f4',
    '--text-secondary': '#a6adc8',
    '--text-muted': '#6c7086',
    '--text-link': '#89b4fa',
    '--text-danger': '#f38ba8',
    '--text-success': '#a6e3a1',
    '--text-warning': '#f9e2af',
    '--accent': '#cba6f7',
    '--accent-hover': '#b4befe',
    '--accent-muted': 'rgba(203, 166, 247, 0.15)',
    '--window-bg': 'rgba(30, 30, 46, 0.64)',
    '--surface-overlay': 'rgba(30, 30, 46, 0.90)',
    '--surface-panel': 'rgba(30, 30, 46, 0.94)',
    '--surface-header': 'rgba(22, 22, 34, 0.72)',
    '--surface-card': 'rgba(22, 22, 34, 0.62)',
    '--surface-card-hover': 'rgba(69, 71, 90, 0.82)',
    '--surface-card-read': 'rgba(22, 22, 34, 0.72)',
    '--surface-border': 'rgba(205, 214, 244, 0.16)',
    '--surface-border-subtle': 'rgba(205, 214, 244, 0.09)',
    '--surface-rim': 'rgba(205, 214, 244, 0.16)',
    '--surface-highlight': 'rgba(205, 214, 244, 0.08)',
    '--window-border': 'rgba(205, 214, 244, 0.13)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(203,166,247,0.08)',
    '--taskbar-bg': 'rgba(22, 22, 34, 0.65)',
    '--taskbar-border': 'rgba(205, 214, 244, 0.10)',
    '--border-subtle': 'rgba(205, 214, 244, 0.08)',
    '--border-default': 'rgba(205, 214, 244, 0.15)',
    '--border-strong': 'rgba(205, 214, 244, 0.30)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'tokyo-night': {
    '--bg-base': '#1a1b26',
    '--bg-elevated': '#24283b',
    '--bg-overlay': '#414868',
    '--bg-sunken': '#16161e',
    '--text-primary': '#c0caf5',
    '--text-secondary': '#565f89',
    '--text-muted': '#3b4261',
    '--text-link': '#7aa2f7',
    '--text-danger': '#f7768e',
    '--text-success': '#9ece6a',
    '--text-warning': '#e0af68',
    '--accent': '#7aa2f7',
    '--accent-hover': '#bb9af7',
    '--accent-muted': 'rgba(122, 162, 247, 0.15)',
    '--window-bg': 'rgba(22, 24, 38, 0.64)',
    '--surface-overlay': 'rgba(22, 24, 38, 0.90)',
    '--surface-panel': 'rgba(22, 24, 38, 0.94)',
    '--surface-header': 'rgba(16, 17, 28, 0.72)',
    '--surface-card': 'rgba(16, 17, 28, 0.62)',
    '--surface-card-hover': 'rgba(65, 72, 104, 0.82)',
    '--surface-card-read': 'rgba(16, 17, 28, 0.72)',
    '--surface-border': 'rgba(192, 202, 245, 0.16)',
    '--surface-border-subtle': 'rgba(192, 202, 245, 0.09)',
    '--surface-rim': 'rgba(192, 202, 245, 0.16)',
    '--surface-highlight': 'rgba(192, 202, 245, 0.08)',
    '--window-border': 'rgba(192, 202, 245, 0.13)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(122,162,247,0.08)',
    '--taskbar-bg': 'rgba(16, 17, 28, 0.65)',
    '--taskbar-border': 'rgba(192, 202, 245, 0.10)',
    '--border-subtle': 'rgba(192, 202, 245, 0.08)',
    '--border-default': 'rgba(192, 202, 245, 0.15)',
    '--border-strong': 'rgba(192, 202, 245, 0.30)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'gruvbox': {
    '--bg-base': '#282828',
    '--bg-elevated': '#3c3836',
    '--bg-overlay': '#504945',
    '--bg-sunken': '#1d2021',
    '--text-primary': '#ebdbb2',
    '--text-secondary': '#d5c4a1',
    '--text-muted': '#665c54',
    '--text-link': '#83a598',
    '--text-danger': '#fb4934',
    '--text-success': '#b8bb26',
    '--text-warning': '#fabd2f',
    '--accent': '#fabd2f',
    '--accent-hover': '#fe8019',
    '--accent-muted': 'rgba(250, 189, 47, 0.15)',
    '--window-bg': 'rgba(40, 40, 40, 0.64)',
    '--surface-overlay': 'rgba(40, 40, 40, 0.90)',
    '--surface-panel': 'rgba(40, 40, 40, 0.94)',
    '--surface-header': 'rgba(29, 32, 33, 0.72)',
    '--surface-card': 'rgba(29, 32, 33, 0.62)',
    '--surface-card-hover': 'rgba(80, 73, 69, 0.82)',
    '--surface-card-read': 'rgba(29, 32, 33, 0.72)',
    '--surface-border': 'rgba(235, 219, 178, 0.16)',
    '--surface-border-subtle': 'rgba(235, 219, 178, 0.09)',
    '--surface-rim': 'rgba(235, 219, 178, 0.16)',
    '--surface-highlight': 'rgba(235, 219, 178, 0.08)',
    '--window-border': 'rgba(235, 219, 178, 0.13)',
    '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(250,189,47,0.06)',
    '--taskbar-bg': 'rgba(29, 32, 33, 0.65)',
    '--taskbar-border': 'rgba(235, 219, 178, 0.10)',
    '--border-subtle': 'rgba(235, 219, 178, 0.08)',
    '--border-default': 'rgba(235, 219, 178, 0.15)',
    '--border-strong': 'rgba(235, 219, 178, 0.30)',
    '--r-window': '14px',
    '--font-size': '14px',
    '--window-blur': 'blur(28px) saturate(160%)'
  },
  'high-contrast': {
    '--bg-base': '#000000',
    '--bg-elevated': '#1a1a1a',
    '--bg-overlay': '#333333',
    '--bg-sunken': '#000000',
    '--text-primary': '#ffffff',
    '--text-secondary': '#cccccc',
    '--text-muted': '#999999',
    '--text-link': '#ffff00',
    '--text-danger': '#ff0000',
    '--text-success': '#00ff00',
    '--text-warning': '#ffff00',
    '--accent': '#ffff00',
    '--accent-hover': '#ffffff',
    '--accent-muted': 'rgba(255, 255, 0, 0.15)',
    '--window-bg': 'rgba(0, 0, 0, 0.95)',
    '--surface-overlay': '#1a1a1a',
    '--surface-panel': '#1a1a1a',
    '--surface-header': '#000000',
    '--surface-card': '#111111',
    '--surface-card-hover': '#222222',
    '--surface-card-read': '#111111',
    '--surface-border': '#ffffff',
    '--surface-border-subtle': '#cccccc',
    '--surface-rim': '#ffffff',
    '--surface-highlight': '#222222',
    '--window-border': '3px solid #ffffff',
    '--window-shadow': '0 8px 32px rgba(255,255,255,0.2), 0 2px 8px rgba(255,255,255,0.1)',
    '--taskbar-bg': 'rgba(0, 0, 0, 0.95)',
    '--taskbar-border': '2px solid #ffffff',
    '--border-subtle': '2px solid #ffffff',
    '--border-default': '3px solid #ffffff',
    '--border-strong': '4px solid #ffffff',
    '--r-window': '0px',
    '--font-size': '16px',
    '--window-blur': 'none'
  }
};

function applyTheme(theme) {
  const t = THEMES[theme] || THEMES['nova-dark'];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) {
    root.style.setProperty(k, v);
  }
  window.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme } }));
}

/* ═══════════════════════════════════════════════════════════════════
   OPFS (Origin Private File System) Support
   ═══════════════════════════════════════════════════════════════════ */

const OPFS = {
  root: null,
  available: false,
  _nativeRoot: null,
  _getNativePath(path = '') {
    const pathModule = require('path');
    const nativeFs = require('fs');
    const root = this._nativeRoot || pathModule.join(require('os').homedir(), '.local', 'share', 'novabyte', 'storage');
    const resolved = pathModule.resolve(root, String(path).replace(/\\/g, '/'));
    if (resolved !== root && !resolved.startsWith(root + pathModule.sep)) {
      throw new Error(`Storage path escapes AstroOS's data directory: ${path}`);
    }
    let existingPath = resolved;
    while (true) {
      try {
        nativeFs.lstatSync(existingPath);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || existingPath === root) throw error;
        existingPath = pathModule.dirname(existingPath);
      }
    }
    const realRoot = nativeFs.realpathSync(root);
    const realExistingPath = nativeFs.realpathSync(existingPath);
    if (realExistingPath !== realRoot && !realExistingPath.startsWith(realRoot + pathModule.sep)) {
      throw new Error(`Storage path traverses a symbolic link outside AstroOS's data directory: ${path}`);
    }
    return resolved;
  },
  async _migrateLegacyOpfs() {
    const nativeFs = require('fs');
    const marker = require('path').join(require('os').homedir(), '.local', 'share', 'novabyte', 'migration', 'opfs-imported');
    if (nativeFs.existsSync(marker)) return;
    try {
      nativeFs.mkdirSync(require('path').dirname(marker), { recursive: true, mode: 0o700 });
      if (navigator.storage?.getDirectory) {
        const legacyRoot = await navigator.storage.getDirectory();
        const copyDirectory = async (source, destination) => {
          nativeFs.mkdirSync(destination, { recursive: true });
          for await (const [name, entry] of source.entries()) {
            const relativeTarget = require('path').join(require('path').relative(this._nativeRoot, destination), name);
            const target = this._getNativePath(relativeTarget);
            if (entry.kind === 'directory') {
              await copyDirectory(entry, target);
            } else if (!nativeFs.existsSync(target)) {
              nativeFs.mkdirSync(require('path').dirname(target), { recursive: true });
              const file = await entry.getFile();
              nativeFs.writeFileSync(target, Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 });
            }
          }
        };
        await copyDirectory(legacyRoot, this._nativeRoot);
      }
      for (const entry of await this._listIndexedDB()) {
        const target = this._getNativePath(entry.path);
        if (nativeFs.existsSync(target)) continue;
        const blob = await this._getIndexedDB(entry.path);
        if (!blob) continue;
        nativeFs.mkdirSync(require('path').dirname(target), { recursive: true });
        nativeFs.writeFileSync(target, Buffer.from(await blob.arrayBuffer()), { flag: 'wx', mode: 0o600 });
      }
      nativeFs.writeFileSync(marker, 'legacy OPFS and IndexedDB storage imported\n');
      console.info('[Storage] Migrated legacy browser storage into the Linux filesystem');
    } catch (error) {
      console.error('[Storage] Could not migrate legacy browser OPFS data:', error);
      throw error;
    }
  },
  // FIX: store init promise to prevent concurrent double-init
  _initPromise: null,

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      if (typeof process !== 'undefined' && process.platform === 'linux') {
        const path = require('path');
        const nativeFs = require('fs');
        this._nativeRoot = path.join(require('os').homedir(), '.local', 'share', 'novabyte', 'storage');
        nativeFs.mkdirSync(this._nativeRoot, { recursive: true });
        this.root = { kind: 'linux-filesystem', path: this._nativeRoot };
        this.available = true;
        await this._migrateLegacyOpfs();
        return true;
      }
      try {
        if ('storage' in navigator && 'getDirectory' in navigator.storage) {
          this.root = await navigator.storage.getDirectory();
          this.available = true;
        } else {
          this.available = false;
        }
      } catch {
        this.available = false;
      }
      return this.available;
    })();
    return this._initPromise;
  },

  async ensureRoot() {
    if (this.root) return this.root;
    await this.init();
    return this.root;
  },

  async _getFileHandle(path, options = {}) {
    const root = await this.ensureRoot();
    if (!root) return null;

    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) throw new Error('Path is required');

    const fileName = parts.pop();
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: !!options.create });
    }
    return dir.getFileHandle(fileName, { create: !!options.create });
  },

  async storeBlob(key, blob) {
    return this.writeBlob(key, blob);
  },

  async writeBlob(path, blob, type = 'application/octet-stream') {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      const target = this._getNativePath(path);
      nativeFs.mkdirSync(require('path').dirname(target), { recursive: true });
      const bytes = blob instanceof Blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.from(blob);
      nativeFs.writeFileSync(target, bytes, { mode: 0o600 });
      return true;
    }
    if (this.available && this.root) {
      // FIX: try/finally ensures writable stream is always closed even if write throws
      let writable;
      try {
        const fileHandle = await this._getFileHandle(path, { create: true });
        writable = await fileHandle.createWritable();
        await writable.write(blob instanceof Blob ? blob : new Blob([blob], { type }));
        await writable.close();
        writable = null;
        return true;
      } catch {
        if (writable) {
          try { await writable.close(); } catch { /* ignore close error */ }
        }
        // fall through to IndexedDB
      }
    }
    return this._storeIndexedDB(path, blob instanceof Blob ? blob : new Blob([blob], { type }));
  },

  async getBlob(key) {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      const target = this._getNativePath(key);
      try {
        return new Blob([nativeFs.readFileSync(target)]);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }
    if (this.available && this.root) {
      try {
        const fileHandle = await this._getFileHandle(key);
        return await fileHandle.getFile();
      } catch {
        // fall through to IndexedDB
      }
    }
    return this._getIndexedDB(key);
  },

  async deleteBlob(key) {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      try {
        nativeFs.unlinkSync(this._getNativePath(key));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (this.available && this.root) {
      try {
        const parts = String(key || '').split('/').filter(Boolean);
        if (!parts.length) return false;
        const name = parts.pop();
        let parent = this.root;
        for (const part of parts) parent = await parent.getDirectoryHandle(part);
        await parent.removeEntry(name);
        return true;
      } catch {
        // fall through to IndexedDB
      }
    }
    return this._deleteIndexedDB(key);
  },

  async ensureDirectory(path) {
    if (this._nativeRoot) {
      const target = this._getNativePath(path);
      require('fs').mkdirSync(target, { recursive: true });
      return target;
    }
    const root = await this.ensureRoot();
    if (!root) return null;
    const parts = String(path || '').split('/').filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  },

  async writeText(path, text, type = 'text/plain') {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      const target = this._getNativePath(path);
      nativeFs.mkdirSync(require('path').dirname(target), { recursive: true });
      const bytes = text instanceof Blob ? Buffer.from(await text.arrayBuffer()) : String(text);
      nativeFs.writeFileSync(target, bytes, { mode: 0o600 });
      return true;
    }
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) throw new Error('Path is required');
    const fileName = parts.pop();
    const dir = parts.length ? await this.ensureDirectory(parts.join('/')) : await this.ensureRoot();
    if (!dir) return this._storeIndexedDB(path, new Blob([String(text)], { type }));
    // FIX: try/finally ensures writable is always closed
    let writable;
    try {
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      writable = await fileHandle.createWritable();
      const blob = text instanceof Blob ? text : new Blob([String(text)], { type });
      await writable.write(blob);
      await writable.close();
      writable = null;
      return true;
    } catch (e) {
      if (writable) {
        try { await writable.close(); } catch { /* ignore */ }
      }
      throw e;
    }
  },

  async readText(path) {
    if (this._nativeRoot) {
      try {
        return require('fs').readFileSync(this._getNativePath(path), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }
    const blob = await this.getBlob(path);
    if (!blob) return null;
    try {
      return await blob.text();
    } catch {
      return null;
    }
  },

  async deletePath(path, recursive = true) {
    if (this._nativeRoot) {
      try {
        require('fs').rmSync(this._getNativePath(path), { recursive, force: false });
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) return false;

    if (this.available && this.root) {
      try {
        const name = parts.pop();
        let parent = this.root;
        for (const part of parts) {
          parent = await parent.getDirectoryHandle(part);
        }
        await parent.removeEntry(name, { recursive });
        return true;
      } catch {
        // fall through to IndexedDB
      }
    }

    return this._deleteIndexedDB(path);
  },

  async listEntries() {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      const path = require('path');
      const entries = [];
      const walk = (directory, prefix = '') => {
        for (const item of nativeFs.readdirSync(directory, { withFileTypes: true })) {
          const itemPath = path.join(directory, item.name);
          const relative = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isSymbolicLink()) continue;
          if (item.isDirectory()) {
            entries.push({ path: relative, name: item.name, kind: 'directory', size: 0, type: 'inode/directory', lastModified: 0 });
            walk(itemPath, relative);
          } else {
            const stat = nativeFs.statSync(itemPath);
            entries.push({ path: relative, name: item.name, kind: 'file', size: stat.size, type: '', lastModified: stat.mtimeMs });
          }
        }
      };
      walk(this._nativeRoot);
      return entries;
    }
    if (this.available && this.root) {
      try {
        const entries = [];
        const walk = async (dir, prefix = '') => {
          const children = [];
          for await (const [name, handle] of dir.entries()) children.push([name, handle]);
          children.sort((a, b) => {
            if (a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
            return a[0].localeCompare(b[0]);
          });
          for (const [name, handle] of children) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'directory') {
              entries.push({ path, name, kind: 'directory', size: 0, type: 'inode/directory', lastModified: 0 });
              await walk(handle, path);
            } else {
              let size = 0, type = '', lastModified = 0;
              try {
                const file = await handle.getFile();
                size = file.size || 0;
                type = file.type || '';
                lastModified = file.lastModified || 0;
              } catch { /* skip unreadable file */ }
              entries.push({ path, name, kind: 'file', size, type, lastModified });
            }
          }
        };
        await walk(this.root);
        return entries;
      } catch {
        // fall through to IndexedDB
      }
    }
    return this._listIndexedDB();
  },

  async clear() {
    if (this._nativeRoot) {
      const nativeFs = require('fs');
      for (const name of nativeFs.readdirSync(this._nativeRoot)) {
        nativeFs.rmSync(require('path').join(this._nativeRoot, name), { recursive: true, force: false });
      }
      return true;
    }
    if (this.available && this.root) {
      try {
        const entries = [];
        for await (const [name, handle] of this.root.entries()) entries.push([name, handle]);
        for (const [name, handle] of entries) {
          try {
            await this.root.removeEntry(name, { recursive: handle.kind === 'directory' });
          } catch { /* skip individual failures */ }
        }
      } catch { /* ignore clear errors */ }
    }
    return this._clearIndexedDB();
  },

  // ── IndexedDB fallback ──────────────────────────────────────────
  _db: null,
  // FIX: store pending open promise to prevent concurrent double-open
  _dbPromise: null,

  _openDB() {
    if (this._db) return Promise.resolve(this._db);
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('novabyte_opfs_fallback', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this._db = request.result;
        resolve(this._db);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
      };
    });
    return this._dbPromise;
  },

  async _storeIndexedDB(key, blob) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      const request = tx.objectStore('blobs').put(blob, key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  },

  async _getIndexedDB(key) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readonly');
      const request = tx.objectStore('blobs').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async _deleteIndexedDB(key) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      const request = tx.objectStore('blobs').delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  },

  async _listIndexedDB() {
    try {
      const db = await this._openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', 'readonly');
        const items = [];
        const req = tx.objectStore('blobs').openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) {
            items.sort((a, b) => a.path.localeCompare(b.path));
            resolve(items);
            return;
          }
          const value = cursor.value;
          const blob = value instanceof Blob ? value : new Blob([value]);
          items.push({
            path: cursor.key,
            name: String(cursor.key).split('/').pop(),
            kind: 'file',
            size: blob.size || 0,
            type: blob.type || '',
            lastModified: 0,
            fallback: true
          });
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  },

  // FIX: replaced cursor-based per-row deletion with objectStore.clear() — atomic and O(1)
  async _clearIndexedDB() {
    try {
      const db = await this._openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      return false;
    }
  }
};

// ── AppDirs — per-app OPFS data directories mirrored into one visible /data tree ──
const AppDirs = {
  PACKAGES: {
    'files': 'com.astroos.files',
    'textedit': 'com.astroos.textedit',
    'terminal': 'com.astroos.terminal',
    'vault': 'com.astroos.files',
    'quill': 'com.astroos.textedit',
    'shell': 'com.astroos.terminal',
    'browser': 'com.astroos.browser',
    'calendar-app': 'com.astroos.calendar',
    'settings': 'com.astroos.settings',
    'calculator': 'com.astroos.calculator',
    'app-manager': 'com.astroos.appmanager',
    'astroos-email': 'com.astroos.email',
    'astroos-gallery': 'com.astroos.gallery',
    'astroos-downloads': 'com.astroos.downloads',
    'astroos-contacts': 'com.astroos.contacts',
    'astroos-search': 'com.astroos.search',
    'astroos-music': 'com.astroos.music',
    'devconsole': 'com.astroos.devconsole',
    'events': 'com.astroos.events',
    'inspector': 'com.astroos.inspector',
    'modules': 'com.astroos.modules',
    'packages': 'com.astroos.packages',
    'perf': 'com.astroos.perf',
    'permissions': 'com.astroos.permissions',
    'sysaccess': 'com.astroos.sysaccess',
    'com.astroos.files': 'com.astroos.files',
    'com.astroos.textedit': 'com.astroos.textedit',
    'com.astroos.terminal': 'com.astroos.terminal',
    'com.astroos.browser': 'com.astroos.browser',
    'com.astroos.calendar': 'com.astroos.calendar',
    'com.astroos.settings': 'com.astroos.settings',
    'com.astroos.calculator': 'com.astroos.calculator',
    'com.astroos.appmanager': 'com.astroos.appmanager',
    'com.astroos.clock': 'com.astroos.clock',
    'com.astroos.email': 'com.astroos.email',
    'com.astroos.gallery': 'com.astroos.gallery',
    'com.astroos.downloads': 'com.astroos.downloads',
    'com.astroos.contacts': 'com.astroos.contacts',
    'com.astroos.search': 'com.astroos.search',
    'com.astroos.music': 'com.astroos.music',
    'com.astroos.devconsole': 'com.astroos.devconsole',
    'com.astroos.events': 'com.astroos.events',
    'com.astroos.inspector': 'com.astroos.inspector',
    'com.astroos.modules': 'com.astroos.modules',
    'com.astroos.packages': 'com.astroos.packages',
    'com.astroos.perf': 'com.astroos.perf',
    'com.astroos.permissions': 'com.astroos.permissions',
    'com.astroos.sysaccess': 'com.astroos.sysaccess',
  },

  // Resolved directory handles cache — avoids repeated getDirectoryHandle calls
  _handles: {},

  // Reverse map: full package id → short app id
  _PKG_TO_APP: null,
  _getPkgToApp() {
    if (!this._PKG_TO_APP) {
      this._PKG_TO_APP = {};
      for (const [k, v] of Object.entries(this.PACKAGES)) {
        this._PKG_TO_APP[v] = k;
      }
    }
    return this._PKG_TO_APP;
  },
  _resolveAppId(pkg) {
    const m = this._getPkgToApp();
    return m[pkg] || pkg;
  },
  _getCallerAppId() {
    try {
      const winId = OS?.focusedWindowId;
      if (!winId || !OS?.windows) return null;
      return OS.windows.get(winId)?.appId ?? null;
    } catch {
      return null;
    }
  },

  _linuxDataRoot() {
    const path = require('path');
    const os = require('os');
    // Multi-user: the account's whole tree IS <machine home>/users/<username>/,
    // so AppDirs root at ~/users/<username>/.apps/<appId>/{files,cache,databases,
    // shared_prefs} — the /data alias resolves against the active user and app
    // subtree (fs.js re-roots its appDataRoot to the same location, so the VFS
    // /data mount and this tree stay the same disk bytes), hidden from
    // listings. Single-user machines keep the legacy flat data root
    // byte-for-byte.
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
      const uid = String(NovaUserScope.uid() || '');
      const uname = typeof NovaUserScope.activeUsername === 'function'
        ? String(NovaUserScope.activeUsername() || '') : '';
      const segment = uname || uid;
      if (segment) {
        return path.join(os.homedir(), 'users', segment, '.apps');
      }
    }
    return path.join(os.homedir(), '.local', 'share', 'novabyte', 'data');
  },
  _linuxAppPath(pkg, subdir = '') {
    const path = require('path');
    if (typeof pkg !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg)) {
      throw new Error(`Invalid app data package identifier: ${pkg}`);
    }
    const base = path.join(this._linuxDataRoot(), pkg);
    const resolved = path.resolve(base, subdir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Invalid app data path: ${pkg}/${subdir}`);
    }
    const fs = require('fs');
    const dataRoot = path.resolve(this._linuxDataRoot());
    let existingPath = resolved;
    while (true) {
      try {
        fs.lstatSync(existingPath);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || existingPath === dataRoot) throw error;
        existingPath = path.dirname(existingPath);
      }
    }
    const realRoot = fs.realpathSync(dataRoot);
    const realExistingPath = fs.realpathSync(existingPath);
    if (realExistingPath !== realRoot && !realExistingPath.startsWith(realRoot + path.sep)) {
      throw new Error(`App data path traverses outside AstroOS's data directory: ${pkg}/${subdir}`);
    }
    return resolved;
  },
  _nativePersistenceInstalled: false,
  _nativeBrowserStatePath() {
    const path = require('path');
    const os = require('os');
    // Full-machine localStorage dump becomes per-user at
    // ~/users/<username>/.browser-state.json (multi-user) — the LS_MAP keys
    // it mirrors are per-account now, and the file rides inside the
    // account's own tree (dot-hidden from listings).
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
      const uid = String(NovaUserScope.uid() || '');
      const uname = typeof NovaUserScope.activeUsername === 'function'
        ? String(NovaUserScope.activeUsername() || '') : '';
      const segment = uname || uid;
      if (segment) {
        return path.join(os.homedir(), 'users', segment, '.browser-state.json');
      }
    }
    return path.join(os.homedir(), '.local', 'share', 'novabyte', 'browser-state.json');
  },
  _persistBrowserState() {
    const fs = require('fs');
    const path = require('path');
    const statePath = this._nativeBrowserStatePath();
    const state = Object.create(null);
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null) state[key] = localStorage.getItem(key);
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  },
  _removeNativeStorageKey(key) {
    const mapping = Object.prototype.hasOwnProperty.call(this.LS_MAP, key) ? this.LS_MAP[key] : null;
    if (!mapping) return;
    const pkg = window.NovaAppIdAliases?.canonicalize(mapping.pkg) || mapping.pkg;
    try {
      require('fs').unlinkSync(require('path').join(
        this._linuxAppPath(pkg, mapping.subdir),
        mapping.file
      ));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  },
  _writeNativeStorageKey(key, value) {
    const mapping = Object.prototype.hasOwnProperty.call(this.LS_MAP, key) ? this.LS_MAP[key] : null;
    if (!mapping) return;
    const pkg = window.NovaAppIdAliases?.canonicalize(mapping.pkg) || mapping.pkg;
    const fs = require('fs');
    const path = require('path');
    const target = path.join(this._linuxAppPath(pkg, mapping.subdir), mapping.file);
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });
  },
  _installNativeBrowserStatePersistence() {
    if (this._nativePersistenceInstalled) return;
    const storage = localStorage;
    const originalSetItem = storage.setItem.bind(storage);
    const originalRemoveItem = storage.removeItem.bind(storage);
    const originalClear = storage.clear.bind(storage);
    const persist = () => this._persistBrowserState();
    storage.setItem = function (key, value) {
      originalSetItem(key, value);
      AppDirs._writeNativeStorageKey(String(key), localStorage.getItem(String(key)));
      persist();
    };
    storage.removeItem = function (key) {
      originalRemoveItem(key);
      AppDirs._removeNativeStorageKey(String(key));
      persist();
    };
    storage.clear = function () {
      originalClear();
      for (const key of Object.keys(AppDirs.LS_MAP)) AppDirs._removeNativeStorageKey(key);
      persist();
    };
    this._nativePersistenceInstalled = true;
  },
  async _bootstrapLinux() {
    const fs = require('fs');
    const path = require('path');
    const dataRoot = this._linuxDataRoot();
    fs.mkdirSync(dataRoot, { recursive: true });
    const browserStatePath = this._nativeBrowserStatePath();
    if (fs.existsSync(browserStatePath)) {
      const browserState = JSON.parse(fs.readFileSync(browserStatePath, 'utf8'));
      if (!browserState || typeof browserState !== 'object' || Array.isArray(browserState)) {
        throw new Error('Linux browser-state file must contain a JSON object');
      }
      for (const [key, value] of Object.entries(browserState)) {
        if (typeof value === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
    }

    const mergeDirectory = (source, destination) => {
      if (!fs.existsSync(source)) return;
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (fs.existsSync(to)) {
          if (entry.isDirectory() && fs.statSync(to).isDirectory()) mergeDirectory(from, to);
          continue;
        }
        fs.cpSync(from, to, { recursive: true, errorOnExist: true });
      }
    };

    mergeDirectory(path.join(OPFS._nativeRoot || '', 'data'), dataRoot);
    mergeDirectory(path.join(require('os').homedir(), 'data'), dataRoot);

    // Older builds mangled the app id in the /data/ segment (dots replaced
    // with underscores) and wrote it under ~/data, so an app could end up
    // with two differently-named data folders — com_example_app next to
    // com.example.app. After the merges above have relocated any legacy
    // ~/data content, reconcile the names: every mangled folder whose real
    // (dotted) app id is known is renamed into place, or merged into the
    // canonical folder when both exist.
    const legacySegment = id => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const knownIds = new Set(Object.values(this.PACKAGES));
    try {
      // Registry-backed inventory (HKNS/apps/installed) with the legacy
      // localStorage key as fail-soft fallback.
      const installed = (window.NovaAppPackageStore?.loadRegistry?.())
        ?? JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
      if (Array.isArray(installed)) {
        for (const app of installed) {
          if (app && typeof app.id === 'string') {
            knownIds.add(window.NovaAppIdAliases?.canonicalize(app.id) || app.id);
          }
        }
      }
    } catch (error) {
      console.warn('[AppDirs] Could not read installed apps for the data migration:', error);
    }
    for (const id of knownIds) {
      const legacyName = legacySegment(id);
      if (legacyName === id) continue;
      const legacyPath = path.join(dataRoot, legacyName);
      const canonicalPath = path.join(dataRoot, id);
      let legacyIsFolder = false;
      try {
        legacyIsFolder = fs.statSync(legacyPath).isDirectory();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!legacyIsFolder) continue;
      if (!fs.existsSync(canonicalPath)) {
        fs.renameSync(legacyPath, canonicalPath);
      } else {
        mergeDirectory(legacyPath, canonicalPath);
        fs.rmSync(legacyPath, { recursive: true, force: true });
      }
    }

    this._handles = {};
    this.appDataPaths = {};

    for (const [alias, rawPkg] of Object.entries(this.PACKAGES)) {
      const pkg = window.NovaAppIdAliases?.canonicalize(rawPkg) || rawPkg;
      const appRoot = this._linuxAppPath(pkg);
      for (const subdir of ['files', 'cache', 'databases', 'shared_prefs']) {
        fs.mkdirSync(this._linuxAppPath(pkg, subdir), { recursive: true });
      }
      this._handles[pkg] = appRoot;
      this.appDataPaths[pkg] = {
        root: appRoot,
        files: this._linuxAppPath(pkg, 'files'),
        cache: this._linuxAppPath(pkg, 'cache'),
        databases: this._linuxAppPath(pkg, 'databases'),
        shared_prefs: this._linuxAppPath(pkg, 'shared_prefs'),
      };
      if (alias === pkg) continue;
    }

    for (const [storageKey, mapping] of Object.entries(this.LS_MAP)) {
      const pkg = window.NovaAppIdAliases?.canonicalize(mapping.pkg) || mapping.pkg;
      const target = path.join(this._linuxAppPath(pkg, mapping.subdir), mapping.file);
      if (!fs.existsSync(target)) {
        const raw = localStorage.getItem(storageKey);
        if (raw !== null) {
          fs.writeFileSync(target, raw, { flag: 'wx', mode: 0o600 });
        }
      }
      if (fs.existsSync(target)) {
        try { localStorage.setItem(storageKey, fs.readFileSync(target, 'utf8')); }
        catch (error) { console.warn(`[AppDirs] Could not sync ${storageKey} from Linux app data:`, error); }
      }
    }
    this._installNativeBrowserStatePersistence();
    this._persistBrowserState();
    console.info(`[AppDirs] App data now uses ${dataRoot}`);
  },

  // Bootstrap the full directory tree — safe to call every boot (idempotent)
  async bootstrap() {
    await OPFS.init();
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      await this._bootstrapLinux();
      return;
    }

    // ── 1. OPFS physical directories ────────────────────────────────
    if (OPFS.available && OPFS.root) {
      const mkd = (parent, name) => parent.getDirectoryHandle(name, { create: true });
      try {
        const system = await mkd(OPFS.root, 'System');
        // FIX: try/finally ensures runtime marker writable is always closed
        let w;
        try {
          const marker = await system.getFileHandle('.astroos_runtime', { create: true });
          w = await marker.createWritable();
          await w.write(JSON.stringify({ os: 'AstroOS', layer: 'astroos', booted: Date.now() }));
          await w.close();
          w = null;
        } catch {
          if (w) { try { await w.close(); } catch { /* ignore */ } }
        }
        const data = await mkd(OPFS.root, 'data');
        const appIdRenames = [
          ['com.astroos.quill', 'com.astroos.textedit'],
          ['com.astroos.shell', 'com.astroos.terminal'],
          ['com.astroos.vault', 'com.astroos.files'],
        ];
        const mergeOPFSDirectory = async (source, target) => {
          for await (const [name, entry] of source.entries()) {
            if (entry.kind === 'directory') {
              const targetChild = await target.getDirectoryHandle(name, { create: true });
              await mergeOPFSDirectory(entry, targetChild);
              continue;
            }
            let targetFile;
            try {
              targetFile = await target.getFileHandle(name);
            } catch (error) {
              if (error.name !== 'NotFoundError') throw error;
              targetFile = await target.getFileHandle(name, { create: true });
              const sourceFile = await entry.getFile();
              const writable = await targetFile.createWritable();
              try {
                await writable.write(sourceFile);
              } finally {
                await writable.close();
              }
            }
          }
        };
        for (const [legacyPkg, currentPkg] of appIdRenames) {
          try {
            const legacyDir = await data.getDirectoryHandle(legacyPkg);
            const currentDir = await data.getDirectoryHandle(currentPkg, { create: true });
            await mergeOPFSDirectory(legacyDir, currentDir);
            await data.removeEntry(legacyPkg, { recursive: true });
          } catch (error) {
            if (error.name !== 'NotFoundError') {
              console.warn('[AppDirs] Failed migrating legacy app data', legacyPkg, error);
            }
          }
        }
        for (const pkg of Object.values(this.PACKAGES)) {
          const appDir = await mkd(data, pkg);
          await mkd(appDir, 'files');
          await mkd(appDir, 'cache');
          await mkd(appDir, 'databases');
          await mkd(appDir, 'shared_prefs');
          this._handles[pkg] = appDir;
        }
      } catch (e) {
        console.warn('[AppDirs] OPFS bootstrap failed:', e);
      }
    }

    // ── 2. Virtual FS — mirror tree so it's visible in Files app ────
    const findVChild = (parentId, name, type, excludedIds = new Set()) =>
      FS.listDir(parentId).find(f =>
        f.name === name && f.type === type && !excludedIds.has(f.id));

    const mergeVDir = async (sourceId, targetId) => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const children = FS.listDir(sourceId).slice();
      for (const child of children) {
        const existing = findVChild(
          targetId,
          child.name,
          child.type,
          new Set([sourceId, child.id])
        );

        if (existing && child.type === 'folder') {
          await mergeVDir(child.id, existing.id);
          await FS.permanentDelete(child.id);
        } else if (existing) {
          await FS.permanentDelete(child.id);
        } else {
          await FS.move(child.id, targetId);
        }
      }
    };

    const mkVDir = async (parentId, name) => {
      const matches = FS.listDir(parentId).filter(f => f.name === name && f.type === 'folder');
      const canonical = matches[0] || await FS.createFolder(parentId, name);
      for (const duplicate of matches.slice(1)) {
        await mergeVDir(duplicate.id, canonical.id);
        await FS.permanentDelete(duplicate.id);
      }
      return canonical;
    };
    const mkVFile = async (parentId, name, content, mime) => {
      const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
      if (existing) return existing;
      return await FS.createFile(parentId, name, content, mime || 'application/json');
    };
    const updateVFile = async (parentId, name, content, mime) => {
      const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
      if (existing) { await FS.writeFile(existing.id, content); return existing; }
      return await FS.createFile(parentId, name, content, mime || 'application/json');
    };
    const collapseLegacyDataDirs = async (dataNode) => {
      const nestedDataDirs = FS.listDir(dataNode.id)
        .filter(f => f.name === 'data' && f.type === 'folder');
      for (const nestedDataDir of nestedDataDirs) {
        await mergeVDir(nestedDataDir.id, dataNode.id);
        await FS.permanentDelete(nestedDataDir.id);
      }
    };

    const APP_META = {
      'com.astroos.files':       { name: 'Files',       version: '3.0.2', description: 'File Manager' },
      'com.astroos.textedit':    { name: 'TextEdit',    version: '3.0.2', description: 'Text Editor' },
      'com.astroos.terminal':    { name: 'Terminal',    version: '3.0.2', description: 'System Terminal' },
      'com.astroos.browser':     { name: 'Browser',     version: '3.0.3', description: 'Web Browser' },
      'com.astroos.calendar':    { name: 'Calendar',    version: '3.0.2', description: 'Calendar & Events' },
      'com.astroos.settings':    { name: 'Settings',    version: '3.0.2', description: 'System Settings' },
      'com.astroos.calculator':  { name: 'Calculator',  version: '3.0.2', description: 'Calculator' },
      'com.astroos.appmanager':  { name: 'App Manager', version: '3.0.2', description: 'Package Manager' },
      'com.astroos.clock':       { name: 'Clock',       version: '3.0.4', description: 'Clock & Alarms' },
      'com.astroos.email':       { name: 'Email',       version: '3.0.3', description: 'Email Client' },
      'com.astroos.gallery':     { name: 'Gallery',     version: '3.0.2', description: 'Image Viewer' },
      'com.astroos.downloads':   { name: 'Downloads',   version: '3.0.2', description: 'Download Manager' },
      'com.astroos.contacts':    { name: 'Contacts',    version: '3.0.2', description: 'Contacts' },
      'com.astroos.search':      { name: 'Search',      version: '3.0.2', description: 'System Search' },
      'com.astroos.music':       { name: 'Music',       version: '3.0.2', description: 'Music Player' },
      'com.astroos.devconsole':  { name: 'Console',     version: '3.0.2', description: 'Developer Console' },
      'com.astroos.events':      { name: 'Events',      version: '3.0.2', description: 'Event Log' },
      'com.astroos.permissions': { name: 'Permissions', version: '3.0.2', description: 'App Permissions' },
      'com.astroos.inspector': { name: 'Inspector', version: '3.0.2', description: 'App Inspector' },
      'com.astroos.modules': { name: 'Modules', version: '3.0.2', description: 'Module Manager' },
      'com.astroos.packages': { name: 'Packages', version: '3.0.2', description: 'Package Tools' },
      'com.astroos.perf': { name: 'Perf Monitor', version: '3.0.2', description: 'Performance Monitor' },
      'com.astroos.sysaccess': { name: 'System Access', version: '3.0.2', description: 'System Access' },
    };

    try {
      const dataNode = await mkVDir(FS.rootId, 'data');
      await collapseLegacyDataDirs(dataNode);

      // /System/ — OS identity visible in Files
      const systemNode = await mkVDir(FS.rootId, 'System');
      await updateVFile(systemNode.id, 'build.json', JSON.stringify({
        os: 'AstroOS', layer: 'astroos', version: '3.0.2',
        booted: new Date().toISOString()
      }, null, 2));

      this.fsFolders = {};

      for (const pkg of Object.values(this.PACKAGES)) {
        const appNode     = await mkVDir(dataNode.id, pkg);
        const filesNode   = await mkVDir(appNode.id, 'files');
        const cacheNode   = await mkVDir(appNode.id, 'cache');
        const dbNode      = await mkVDir(appNode.id, 'databases');
        const prefsNode   = await mkVDir(appNode.id, 'shared_prefs');

        this.fsFolders[pkg] = {
          root: appNode.id, files: filesNode.id,
          cache: cacheNode.id, databases: dbNode.id, shared_prefs: prefsNode.id
        };

        const meta = APP_META[pkg] || { name: pkg, version: '3.0.2', description: '' };
        await mkVFile(filesNode.id, 'appinfo.json', JSON.stringify({
          packageId: pkg, name: meta.name, version: meta.version,
          description: meta.description, installedAt: new Date().toISOString(), layer: 'astroos',
        }, null, 2));
      }

      for (const [legacyPkg, currentPkg] of [
        ['com.astroos.quill', 'com.astroos.textedit'],
        ['com.astroos.shell', 'com.astroos.terminal'],
        ['com.astroos.vault', 'com.astroos.files'],
      ]) {
        const legacyDir = FS.listDir(dataNode.id).find(node =>
          node.name === legacyPkg && node.type === 'folder');
        const currentDirId = this.fsFolders[currentPkg]?.root;
        if (legacyDir && currentDirId) {
          await mergeVDir(legacyDir.id, currentDirId);
          await FS.permanentDelete(legacyDir.id);
        }
      }

      if (FS.specialFolders.desktop) {
        for (const shortcut of FS.listDir(FS.specialFolders.desktop)) {
          if (!shortcut.name.endsWith('.lnk') || shortcut.mimeType !== 'application/x-app-shortcut') continue;
          try {
            const data = JSON.parse(shortcut.content || '{}');
            if (typeof data.target !== 'string') continue;
            const target = window.NovaAppIdAliases?.canonicalize(data.target) || data.target;
            if (target !== data.target) {
              data.target = target;
              if (typeof data.appId === 'string') {
                data.appId = window.NovaAppIdAliases?.canonicalize(data.appId) || data.appId;
              }
              await FS.writeFile(shortcut.id, JSON.stringify(data));
            }
          } catch (error) {
            console.warn('[AppDirs] Failed migrating legacy desktop shortcut', shortcut.name, error);
          }
        }
      }

      // ── Migrate existing notes from Documents → com.astroos.textedit/files/ ──
      const textEditFilesId = this.fsFolders['com.astroos.textedit']?.files;
      if (textEditFilesId && FS.specialFolders.documents) {
        const docsFiles = FS.listDir(FS.specialFolders.documents);
        for (const f of docsFiles) {
          if (f.type === 'file') {
            const alreadyMoved = FS.listDir(textEditFilesId).find(n => n.name === f.name);
            if (!alreadyMoved) {
              await FS.move(f.id, textEditFilesId);
            }
          }
        }
      }

      // ── Sync real localStorage data into virtual FS databases/ ──
      await this._syncAllToFS(updateVFile);

      // ── Sync real settings into com.astroos.settings/shared_prefs/prefs.json ──
      const settingsPrefsId = this.fsFolders['com.astroos.settings']?.shared_prefs;
      if (settingsPrefsId) {
        await updateVFile(settingsPrefsId, 'prefs.json',
          JSON.stringify(getShellSystemSettingsSnapshot(), null, 2));
      }

      this.fsFolders = { data: dataNode.id, system: systemNode.id };
      console.log('[AppDirs] Virtual FS tree bootstrapped — visible in Files app');
    } catch (e) {
      console.warn('[AppDirs] Virtual FS bootstrap failed:', e);
    }
  },

  async _ensureDataNode() {
    const dataNode = FS.getByPath('/data');
    if (dataNode && dataNode.type === 'folder') return dataNode.id;
    const created = await FS.createFolder(FS.rootId, 'data');
    return created ? created.id : null;
  },

  async _ensureFSChild(parentId, name, type) {
    const existing = FS.listDir(parentId).find(f => f.name === name && f.type === type);
    if (existing) return existing;
    if (type === 'folder') return await FS.createFolder(parentId, name);
    return await FS.createFile(parentId, name, '', 'application/json');
  },

  async ensureAppDataFolder(appIdOrPkg) {
    appIdOrPkg = window.NovaAppIdAliases?.canonicalize(appIdOrPkg) || appIdOrPkg;
    const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      const fs = require('fs');
      const root = this._linuxAppPath(pkg);
      for (const subdir of ['files', 'cache', 'databases', 'shared_prefs']) {
        fs.mkdirSync(this._linuxAppPath(pkg, subdir), { recursive: true });
      }
      this._handles[pkg] = root;
      return root;
    }
    if (this._handles[pkg]) return this._handles[pkg];

    if (OPFS.available && OPFS.root) {
      try {
        const data = await OPFS.root.getDirectoryHandle('data', { create: true });
        const appDir = await data.getDirectoryHandle(pkg, { create: true });
        const mkd = async (p, n) => { try { await p.getDirectoryHandle(n, { create: true }); } catch {} };
        await mkd(appDir, 'files');
        await mkd(appDir, 'cache');
        await mkd(appDir, 'databases');
        await mkd(appDir, 'shared_prefs');
        this._handles[pkg] = appDir;
      } catch (e) {
        console.warn('[AppDirs] OPFS ensure failed for', pkg, e);
      }
    }

    try {
      const dataNodeId = FS.specialFolders?.data || (await this._ensureDataNode());
      const appNode = await this._ensureFSChild(dataNodeId, pkg, 'folder');
      const filesNode = await this._ensureFSChild(appNode.id, 'files', 'folder');
      const cacheNode = await this._ensureFSChild(appNode.id, 'cache', 'folder');
      const dbNode = await this._ensureFSChild(appNode.id, 'databases', 'folder');
      const prefsNode = await this._ensureFSChild(appNode.id, 'shared_prefs', 'folder');
      if (!this.fsFolders) this.fsFolders = {};
      this.fsFolders[pkg] = {
        root: appNode.id,
        files: filesNode?.id,
        cache: cacheNode?.id,
        databases: dbNode?.id,
        shared_prefs: prefsNode?.id,
      };
    } catch (e) {
      console.warn('[AppDirs] filesystem ensure failed for', pkg, e);
    }

    return this._handles[pkg] || null;
  },

  async getAppDir(appIdOrPkg) {
    appIdOrPkg = window.NovaAppIdAliases?.canonicalize(appIdOrPkg) || appIdOrPkg;
    const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      await this.ensureAppDataFolder(pkg);
      return this._linuxAppPath(pkg);
    }

    // Runtime guard: deny requests for another app's directory unless the caller
    // has system:apps permission. System calls (no focused window) pass through.
    const callerAppId = this._getCallerAppId();
    if (callerAppId) {
      const targetAppId = this._resolveAppId(pkg);
      if (targetAppId && targetAppId !== callerAppId) {
        const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
        if (!mgr?.isGranted?.('system:apps', callerAppId)) {
          console.warn('[AppDirs] Access denied — caller', callerAppId, 'tried to access app dir for', pkg);
          return null;
        }
      }
    }

    if (this._handles[pkg]) return this._handles[pkg];
    if (!OPFS.available || !OPFS.root) return null;
    try {
      const data = await OPFS.root.getDirectoryHandle('data', { create: true });
      let appDir;
      try {
        appDir = await data.getDirectoryHandle(pkg);
      } catch {
        try {
          const legacyData = await data.getDirectoryHandle('data');
          appDir = await legacyData.getDirectoryHandle(pkg);
        } catch {
          appDir = await data.getDirectoryHandle(pkg, { create: true });
        }
      }
      const mkd = (p, n) => p.getDirectoryHandle(n, { create: true });
      await mkd(appDir, 'files');
      await mkd(appDir, 'cache');
      await mkd(appDir, 'databases');
      await mkd(appDir, 'shared_prefs');
      this._handles[pkg] = appDir;
      return appDir;
    } catch {
      return null;
    }
  },

  async getPrefs(appIdOrPkg) {
    const appDir = await this.getAppDir(appIdOrPkg);
    if (!appDir) return {};
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      try {
        return JSON.parse(require('fs').readFileSync(
          require('path').join(appDir, 'shared_prefs', 'prefs.json'),
          'utf8'
        ));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    }
    try {
      const prefsDir = await appDir.getDirectoryHandle('shared_prefs');
      const file = await prefsDir.getFileHandle('prefs.json');
      const f = await file.getFile();
      return JSON.parse(await f.text());
    } catch {
      return {};
    }
  },

  // Single source of truth for uninstall-time app data cleanup — deletes
  // the app's /data/<appId> filesystem folder (resolved via FS.getByPath, since
  // FS.specialFolders never has a 'data' entry — only desktop/documents/
  // downloads/music/pictures/videos/trash are registered there) plus the
  // OPFS-backed folder and any cached handles. All uninstall call sites
  // (App Manager, desktop right-click x2, Launchpad, My Apps panel)
  // should call this instead of each re-implementing (or skipping) it.
  async removeAppData(appId) {
    if (!appId) return;
    appId = window.NovaAppIdAliases?.canonicalize(appId) || appId;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      const fs = require('fs');
      fs.rmSync(this._linuxAppPath(this.PACKAGES[appId] || appId), { recursive: true, force: true });
      delete this._handles?.[this.PACKAGES[appId] || appId];
      delete this.fsFolders?.[this.PACKAGES[appId] || appId];
      return;
    }
    if (typeof OPFS !== 'undefined' && OPFS.available && OPFS.root) {
      try { await OPFS.deletePath('data/' + appId, true); } catch { /* ignore */ }
    }
    delete this._handles?.[appId];
    delete this.fsFolders?.[appId];
    if (typeof FS === 'undefined') return;
    try {
      const dataNode = FS.getByPath('/data');
      if (!dataNode) return;
      const files = FS.listDir(dataNode.id);
      const match = files.find(f => f.name === appId && f.type === 'folder');
      if (!match) return;
      try {
        await FS.permanentDelete(match.id);
      } catch (e) {
        console.warn('[AppDirs] permanentDelete failed for', appId, e);
        const children = FS.listDir(match.id);
        for (const child of children) {
          try { await FS.permanentDelete(child.id); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      console.warn('[AppDirs] removeAppData failed for', appId, e);
    }
  },

  async setPrefs(appIdOrPkg, data) {
    const appDir = await this.getAppDir(appIdOrPkg);
    if (!appDir) return false;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      const target = require('path').join(appDir, 'shared_prefs', 'prefs.json');
      require('fs').writeFileSync(target, JSON.stringify(data), { mode: 0o600 });
      return true;
    }
    // FIX: try/finally ensures writable is always closed
    let w;
    try {
      const prefsDir = await appDir.getDirectoryHandle('shared_prefs', { create: true });
      const file = await prefsDir.getFileHandle('prefs.json', { create: true });
      w = await file.createWritable();
      await w.write(JSON.stringify(data));
      await w.close();
      w = null;
      return true;
    } catch {
      if (w) { try { await w.close(); } catch { /* ignore */ } }
      return false;
    }
  },

  // localStorage keys mirrored into per-app data folders. Keys whose data
  // moved into the AstroOS Registry are NOT listed — the hive files under
  // the registry storage root are the durable copy, and mirroring a stale
  // localStorage shadow would fight the registry:
  //   nova_installed_apps        -> HKNS/apps/installed
  //   astroos_clock_v1             -> HKNA/com.astroos.clock/alarms
  //   astroos_email_accts_v2       -> HKNA/com.astroos.email/accounts
  //   nova_music_prefs           -> HKNA/com.astroos.music/prefs
  //   astroos_browser_settings     -> HKNA/com.astroos.browser/settings
  //   nova_events_{app_filters,views,alerts} -> HKND/events/*
  //   (platform prefs -> HKNU/* via RegistryPrefs, see the note below)
  LS_MAP: {
    'calendar_events_v2':    { pkg: 'com.astroos.calendar',    subdir: 'databases',    file: 'events.json' },
    'astroos_email_drafts_v1': { pkg: 'com.astroos.email',       subdir: 'databases',    file: 'drafts.json' },
    'nova_downloads':         { pkg: 'com.astroos.downloads',   subdir: 'databases',    file: 'history.json' },
    'nova_contacts':          { pkg: 'com.astroos.contacts',    subdir: 'databases',    file: 'contacts.json' },

    // App Manager — install log (the disabled/boot lists moved into the
    // AstroOS Registry — HKNU/apps/* via RegistryPrefs — so there is no
    // localStorage key left to mirror).
    'nova_appmanager_log':    { pkg: 'com.astroos.appmanager',  subdir: 'databases',    file: 'install-log.json' },

    // Browser — bookmarks, history (settings moved to HKNA/com.astroos.browser/settings)
    'astroos_browser_bookmarks':{ pkg: 'com.astroos.browser',     subdir: 'databases',    file: 'bookmarks.json' },
    'astroos_browser_history':  { pkg: 'com.astroos.browser',     subdir: 'databases',    file: 'history.json' },

    // Events (system log viewer) — sessions only (filters, saved views and
    // alert rules moved to HKND/events/*)
    'nova_events_sessions':   { pkg: 'com.astroos.events',      subdir: 'databases',    file: 'sessions.json' },

    // Developer Console — command history
    'astroos_devconsole_history': { pkg: 'com.astroos.devconsole', subdir: 'databases',   file: 'history.json' },

    // Permissions — event-log read cutoff
    'astroos_permissions_log_cutoff': { pkg: 'com.astroos.permissions', subdir: 'shared_prefs', file: 'log-cutoff.json' },

    // Settings — custom keyboard shortcuts moved into the AstroOS Registry
    // (HKNU/shell/shortcuts via RegistryPrefs); no localStorage key to mirror.
  },

  getAppDataPath(appIdOrPkg, subdir) {
    appIdOrPkg = window.NovaAppIdAliases?.canonicalize(appIdOrPkg) || appIdOrPkg;
    const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      return this._linuxAppPath(pkg, subdir || '');
    }
    if (this.fsFolders?.[pkg]) return this.fsFolders[pkg][subdir] ?? null;
    void this.ensureAppDataFolder(pkg);
    return null;
  },
  getFSDir(appIdOrPkg, subdir) {
    return this.getAppDataPath(appIdOrPkg, subdir);
  },

  /**
   * Mount-time re-hydration (multi-user): seed the LS_MAP user-data keys
   * from the mounted account's per-app files into localStorage, so the
   * first-party apps read the account's calendar/contacts/bookmarks/…
   * through their existing localStorage reads. Called by the
   * SessionManager as part of the per-user mount sequence.
   */
  syncAllFromUser() {
    if (typeof process === 'undefined' || process.platform !== 'linux') {
      return; // web build: the LS_MAP strata stay on the legacy channel
    }
    for (const lsKey of Object.keys(this.LS_MAP)) {
      const mapping = this.LS_MAP[lsKey];
      try {
        const pkg = window.NovaAppIdAliases?.canonicalize(mapping.pkg) || mapping.pkg;
        const fs = require('fs');
        const path = require('path');
        const target = path.join(this._linuxAppPath(pkg, mapping.subdir), mapping.file);
        if (fs.existsSync(target)) {
          localStorage.setItem(lsKey, fs.readFileSync(target, 'utf8'));
        } else {
          localStorage.removeItem(lsKey);
        }
      } catch { /* silent — absent stratum just means an empty app state */ }
    }
  },

  /**
   * Flush-time mirror (multi-user): write the LS_MAP user-data keys into the
   * mounted account's per-app files, then drop them from localStorage —
   * the global namespace holds nothing personal between accounts. Called
   * by the SessionManager at suspend/logout.
   */
  syncAllToUser() {
    if (typeof process === 'undefined' || process.platform !== 'linux') {
      return;
    }
    for (const lsKey of Object.keys(this.LS_MAP)) {
      const raw = localStorage.getItem(lsKey);
      if (raw === null) continue;
      try {
        this._writeNativeStorageKey(lsKey, raw);
      } catch { /* silent */ }
      localStorage.removeItem(lsKey);
    }
  },

  async syncKey(lsKey, value) {
    const mapping = Object.prototype.hasOwnProperty.call(this.LS_MAP, lsKey) ? this.LS_MAP[lsKey] : null;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      this._writeNativeStorageKey(lsKey, value);
      return;
    }
    if (!mapping || !this.fsFolders) return;
    const folderId = this.getFSDir(mapping.pkg, mapping.subdir);
    if (!folderId) return;
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    try {
      const existing = FS.listDir(folderId).find(f => f.name === mapping.file && f.type === 'file');
      if (existing) { await FS.writeFile(existing.id, content); }
      else { await FS.createFile(folderId, mapping.file, content, 'application/json'); }
    } catch { /* silent */ }
  },

  async _syncAllToFS(updateVFile) {
    for (const [lsKey, mapping] of Object.entries(this.LS_MAP)) {
      const raw = localStorage.getItem(lsKey);
      if (!raw) continue;
      const folderId = this.getFSDir(mapping.pkg, mapping.subdir);
      if (!folderId) continue;
      try {
        let content = raw;
        try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* not JSON, store as-is */ }
        await updateVFile(folderId, mapping.file, content, 'application/json');
      } catch { /* silent */ }
    }
  },

  async clearAppData(appIdOrPkg) {
    appIdOrPkg = window.NovaAppIdAliases?.canonicalize(appIdOrPkg) || appIdOrPkg;
    const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      const fs = require('fs');
      const appRoot = this._linuxAppPath(pkg);
      fs.rmSync(appRoot, { recursive: true, force: true });
      await this.ensureAppDataFolder(pkg);
      return true;
    }
    if (!OPFS.available || !OPFS.root) return false;
    try {
      const data = await OPFS.root.getDirectoryHandle('data', { create: true });
      try { await data.removeEntry(pkg, { recursive: true }); } catch { /* ignore */ }
      try {
        const legacyData = await data.getDirectoryHandle('data');
        await legacyData.removeEntry(pkg, { recursive: true });
      } catch { /* ignore */ }
      delete this._handles[pkg];
      delete this.fsFolders?.[pkg];
      const appDir = await data.getDirectoryHandle(pkg, { create: true });
      const mkd = async (p, n) => { try { await p.getDirectoryHandle(n, { create: true }); } catch {} };
      await mkd(appDir, 'files');
      await mkd(appDir, 'cache');
      await mkd(appDir, 'databases');
      await mkd(appDir, 'shared_prefs');
      this._handles[pkg] = appDir;
      try {
        const dataNodeId = FS.specialFolders?.data || (await this._ensureDataNode());
        const appNode = await this._ensureFSChild(dataNodeId, pkg, 'folder');
        const filesNode = await this._ensureFSChild(appNode.id, 'files', 'folder');
        const cacheNode = await this._ensureFSChild(appNode.id, 'cache', 'folder');
        const dbNode = await this._ensureFSChild(appNode.id, 'databases', 'folder');
        const prefsNode = await this._ensureFSChild(appNode.id, 'shared_prefs', 'folder');
        if (!this.fsFolders) this.fsFolders = {};
        this.fsFolders[pkg] = {
          root: appNode.id,
          files: filesNode?.id,
          cache: cacheNode?.id,
          databases: dbNode?.id,
          shared_prefs: prefsNode?.id,
        };
      } catch { /* ignore filesystem clear errors */ }
      return true;
    } catch {
      return false;
    }
  },
};

// Global runtime flag — apps check this to verify they're running inside AstroOS
window.__NB_RUNTIME = { os: 'AstroOS', layer: 'astroos', ready: false };
window.AppDirs = AppDirs;

/* ═══════════════════════════════════════════════════════════════
   DESKTOP ICONS
   ═══════════════════════════════════════════════════════════════ */

function getFileTypeQuery(fileNode) {
  const name = typeof fileNode?.name === 'string' ? fileNode.name : '';
  const dotIdx = name.lastIndexOf('.');
  return {
    extension: dotIdx !== -1 ? name.slice(dotIdx).toLowerCase() : null,
    mimeType: typeof fileNode?.mimeType === 'string' ? fileNode.mimeType : '',
  };
}

function openFileWithDefaultApp(fileNode) {
  if (!fileNode) return;

  const query = getFileTypeQuery(fileNode);
  const mime = query.mimeType;

  let appId = 'com.astroos.textedit'; // fallback default

  if (mime === 'text/html' || fileNode.name.endsWith('.html') || fileNode.name.endsWith('.htm')) appId = 'com.astroos.browser';
  else if (mime.startsWith('image/')) appId = 'com.astroos.gallery';
  else if (mime.startsWith('audio/')) appId = 'com.astroos.music';
  // NOTE: no built-in app declares a .pdf handler (the previous 'lumina'
  // fallback here pointed at an app id that was never registered, so PDFs
  // silently failed to open). Falls through to TextEdit until a real PDF
  // viewer exists — see DefaultApps.CATEGORIES for where to add one.

  // Honor a chosen default only when the installed app declared support
  // for this exact file type; otherwise retain the working built-in fallback.
  if (typeof DefaultApps !== 'undefined') {
    const categoryId = DefaultApps.getCategoryFor(query);
    const systemFallback = DefaultApps.CATEGORIES[categoryId]?.apps?.[0]?.id || appId;
    appId = DefaultApps.resolveHandler(query, systemFallback);
  }

  openFileWithApp(fileNode, appId);
}

function openFileWithApp(fileNode, appId, rememberDefault = false, requireHandler = false) {
  const liveFile = fileNode?.id ? FS.files.get(fileNode.id) : null;
  if (!liveFile || liveFile.type !== 'file' || !appId || !OS.apps?.[appId]) {
    Notify.show({
      title: 'Unable to open file',
      body: 'The file or selected app is no longer available.',
      type: 'warn',
      appName: 'Desktop',
    });
    return false;
  }
  fileNode = liveFile;
  const name = fileNode.name;
  const query = getFileTypeQuery(fileNode);
  const canHandle = typeof DefaultApps !== 'undefined'
    && DefaultApps.supportsFile(appId, query);
  if (requireHandler && !canHandle) {
    Notify.show({
      title: 'App no longer supports this file',
      body: 'Choose an app that currently declares support for this file type.',
      type: 'warn',
      appName: 'Desktop',
    });
    return false;
  }
  const defaultSaved = rememberDefault && canHandle
    ? DefaultApps.setDefaultForFile(query, appId)
    : false;
  if (rememberDefault && canHandle && !defaultSaved) {
    Notify.show({
      title: 'Default not saved',
      body: 'The selected app could not be saved as the default for this file type.',
      type: 'warn',
      appName: 'Desktop',
    });
  }

  const options = { fileId: fileNode.id };
  if (canHandle) {
    options.fileIntent = {
      action: 'open',
      file: {
        id: fileNode.id,
        name,
        mimeType: query.mimeType,
      },
    };
  }
  const win = WM.createWindow(appId, options);
  return {
    success: !!win,
    appId,
    windowId: win?.id || null,
    defaultSaved,
  };
}

function showOpenWithDialog(fileNode) {
  if (!fileNode || typeof DefaultApps === 'undefined') return Promise.resolve({ cancelled: true });
  const name = typeof fileNode.name === 'string' ? fileNode.name : '';
  const query = getFileTypeQuery(fileNode);
  const candidates = DefaultApps.getAppsForFile(query);
  if (candidates.length === 0) {
    Notify.show({
      title: 'No compatible apps',
      body: `No installed app declares support for ${name || 'this file'}.`,
      type: 'info',
      appName: 'Desktop',
    });
    return Promise.resolve({ cancelled: true, reason: 'no-compatible-apps' });
  }

  return new Promise(resolve => {
  const dialog = document.createElement('dialog');
  dialog.className = 'nova-open-with-dialog';
  dialog.setAttribute('aria-labelledby', 'open-with-title');
  dialog.style.cssText = [
    'position:fixed',
    'inset:0',
    'margin:auto',
    'width:min(420px,calc(100vw - 32px))',
    'max-height:calc(100vh - 32px)',
    'padding:0',
    'border:1px solid var(--border-color,rgba(255,255,255,.14))',
    'border-radius:14px',
    'background:var(--bg-elevated,rgba(30,30,30,.82))',
    'backdrop-filter:blur(12px)',
    '-webkit-backdrop-filter:blur(12px)',
    'color:var(--text-primary,#fff)',
    'box-shadow:0 24px 80px rgba(0,0,0,.55)',
  ].join(';');

  const form = document.createElement('form');
  form.method = 'dialog';
  form.style.cssText = 'display:flex;flex-direction:column;gap:14px;padding:20px;';
  const title = document.createElement('h2');
  title.id = 'open-with-title';
  title.textContent = 'Open with';
  title.style.cssText = 'font-size:18px;margin:0;';
  const subtitle = document.createElement('p');
  subtitle.textContent = name;
  subtitle.title = name;
  subtitle.style.cssText = 'font-size:13px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;';

  const list = document.createElement('div');
  list.setAttribute('role', 'radiogroup');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height: min(45vh,320px);overflow:auto;';
  const categoryId = DefaultApps.getCategoryFor(query);
  const categoryDefault = categoryId ? DefaultApps.getDefault(categoryId) : null;
  const savedDefault = DefaultApps.getDefaultForFile(query) || categoryDefault;
  let selectedId = candidates.some(app => app.id === savedDefault) ? savedDefault : candidates[0].id;

  for (const app of candidates) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;cursor:pointer;';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'open-with-app';
    radio.value = app.id;
    radio.checked = app.id === selectedId;
    radio.addEventListener('change', () => { selectedId = app.id; });
    const icon = document.createElement('span');
    icon.style.cssText = 'width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;';
    if (typeof svgIcon === 'function') icon.innerHTML = svgIcon(app.icon || 'box', 18);
    const appName = document.createElement('span');
    appName.textContent = app.name;
    label.append(radio, icon, appName);
    list.appendChild(label);
  }

  const rememberLabel = document.createElement('label');
  rememberLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;';
  const remember = document.createElement('input');
  remember.type = 'checkbox';
  rememberLabel.append(remember, document.createTextNode('Always use this app for this file type'));

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:2px;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const open = document.createElement('button');
  open.type = 'submit';
  open.textContent = 'Open';
  open.className = 'primary';
  for (const button of [cancel, open]) {
    button.style.cssText = 'border:1px solid var(--border-color,rgba(255,255,255,.16));border-radius:7px;padding:8px 14px;color:inherit;background:var(--bg-overlay,rgba(255,255,255,.08));cursor:pointer;';
  }
  actions.append(cancel, open);
  form.append(title, subtitle, list, rememberLabel, actions);
  dialog.appendChild(form);
  document.body.appendChild(dialog);

  let settled = false;
  const finish = result => {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    resolve(result);
  };
  cancel.addEventListener('click', () => finish({ cancelled: true }));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    finish({ cancelled: true });
  });
  dialog.addEventListener('close', () => finish({ cancelled: true }), { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    finish(openFileWithApp(fileNode, selectedId, remember.checked, true) || { cancelled: true });
  });
  dialog.showModal();
  });
}

window.showOpenWithDialog = showOpenWithDialog;

OS.events.on('settings:changed', async ({ key }) => {
  // Apply settings in the running host immediately. The Settings app is a
  // sandboxed webview, so it must never try to reach host-only DOM nodes itself.
  try {
    switch (key) {
      case 'theme': {
        applyTheme(getShellSystemSetting('theme') || 'nova-dark');
        const accent = getShellSystemSetting('accentColor');
        if (accent) {
          document.documentElement.style.setProperty('--accent', accent);
          document.documentElement.style.setProperty('--accent-hover', accent + 'dd');
          document.documentElement.style.setProperty('--accent-muted', accent + '22');
        }
        break;
      }
      case 'accentColor': {
        const accent = getShellSystemSetting('accentColor');
        if (accent) {
          document.documentElement.style.setProperty('--accent', accent);
          document.documentElement.style.setProperty('--accent-hover', accent + 'dd');
          document.documentElement.style.setProperty('--accent-muted', accent + '22');
        }
        break;
      }
      case 'reduceMotion':
        Boot?.applyAccessibility?.(getShellSystemSetting);
        break;
      case 'removeTransparency':
      case 'highContrast':
        Boot?.applyAccessibility?.(getShellSystemSetting);
        break;
      case 'wallpaperId':
      case 'customWallpaper':
        window.WallpaperService?.apply(getShellSystemSetting);
        break;
      case 'cursorSize':
        Boot?.applyCursorSize?.(getShellSystemSetting);
        break;
      case 'username':
        OS.username = getShellSystemSetting('username') || 'user';
        document.getElementById('lock-username')?.replaceChildren(document.createTextNode(OS.username));
        break;
      case 'autoLock':
        OS.idleTimeout = (parseInt(getShellSystemSetting('autoLock')) || 10) * 60000;
        break;
      case 'devMode':
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn('[Desktop] immediate settings apply failed:', key, e);
  }

  if (key === 'rootAccessEnabled' && getShellSystemSetting('rootAccessEnabled') !== true
    && typeof AppSandbox !== 'undefined'
    && AppSandbox.reloadAfterRootRevocation?.('Root Access was disabled')) return;
});
