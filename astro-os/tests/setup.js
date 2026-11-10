import { vi } from 'vitest';

// ── Global test setup ──────────────────────────────────────────────────────
// Runs before every test file. Stubs browser globals so client-side modules
// can be imported in Node without throwing at import time.

Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }),
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0;
      return arr;
    },
    subtle: {
      importKey: vi.fn(),
      sign: vi.fn(),
      verify: vi.fn(),
    },
  },
  writable: true,
});

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class {
    encode(input) {
      const bytes = [];
      for (let i = 0; i < input.length; i++) bytes.push(input.charCodeAt(i));
      return new Uint8Array(bytes);
    }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(input) {
      return String.fromCharCode(...new Uint8Array(input));
    }
  };
}

const _ls = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => _ls.get(key) ?? null,
    setItem: (key, value) => _ls.set(key, String(value)),
    removeItem: (key) => _ls.delete(key),
    clear: () => _ls.clear(),
    key: (index) => [..._ls.keys()][index] ?? null,
    get length() { return _ls.size; },
  },
  writable: true,
});

const _ss = new Map();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (key) => _ss.get(key) ?? null,
    setItem: (key, value) => _ss.set(key, String(value)),
    removeItem: (key) => _ss.delete(key),
    clear: () => _ss.clear(),
    key: (index) => [..._ss.keys()][index] ?? null,
    get length() { return _ss.size; },
  },
  writable: true,
});

// Ensure window exists for modules that reference it at import time
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Vitest/1.0',
    language: 'en-US',
    hardwareConcurrency: 8,
    onLine: true,
    clipboard: { readText: vi.fn(), writeText: vi.fn() },
    mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
    geolocation: { getCurrentPosition: vi.fn() },
    getBattery: vi.fn().mockResolvedValue({
      level: 0.8,
      charging: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  },
  writable: true,
});

Object.defineProperty(globalThis, 'matchMedia', {
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
  writable: true,
});

let _rafId = 0;
const _rafCbs = new Map();
globalThis.requestAnimationFrame = (cb) => {
  const id = ++_rafId;
  _rafCbs.set(id, cb);
  return id;
};
globalThis.cancelAnimationFrame = (id) => _rafCbs.delete(id);
globalThis.flushRAF = () => {
  [..._rafCbs.values()].forEach((cb) => cb());
  _rafCbs.clear();
};

const _blobUrls = new Set();
Object.defineProperty(globalThis.URL, 'createObjectURL', {
  value: () => {
    const u = 'blob:test://' + Math.random().toString(36).slice(2);
    _blobUrls.add(u);
    return u;
  },
});
Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
  value: (url) => _blobUrls.delete(url),
});

globalThis.fetch = vi.fn();
globalThis.AbortController = class {
  constructor() {
    const listeners = new Set();
    this.signal = {
      aborted: false,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      dispatchEvent: () => {},
    };
    this._listeners = listeners;
  }
  abort() {
    this.signal.aborted = true;
    this._listeners.forEach((fn) => fn());
  }
};

// Storage reset helper — call in afterEach to keep tests isolated.
export const resetTestStorage = () => {
  _ls.clear();
  _ss.clear();
};
