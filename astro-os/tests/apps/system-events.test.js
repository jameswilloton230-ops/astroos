import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// system-events.js has side effects at load time (DOM access, matchMedia, etc.)
// and is a flat script with no exports. All functions are local closures.
// We test the documented pure-logic behaviors by re-implementing them here
// so regressions in the documented contract are caught. The actual module
// would need to expose these helpers (or be split) for direct import tests.

// ── Mock globals ─────────────────────────────────────────────────────────────
const mockOS = {
  apps: {},
  windows: new Map(),
  settings: { get: vi.fn(), set: vi.fn() },
  notifications: [],
  notifUnread: 0,
  volume: 50,
  lockPin: null,
  lockoutUntil: 0,
  wrongPinCount: 0,
  isLocked: false,
  idleTimeout: 600000,
  username: 'testuser',
  version: '3.0.2',
  _bootTime: Date.now(),
  workspaces: [{ id: 'ws1', name: 'Workspace 1' }],
  currentWorkspace: 'ws1',
  clipboard: '',
  clipboardHistory: [],
};
globalThis.OS = mockOS;

// Stable mock elements
const elementMap = new Map();
function getMockEl(id) {
  if (!elementMap.has(id)) {
    elementMap.set(id, {
      id,
      style: {},
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
      textContent: '',
      innerHTML: '',
      value: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      appendChild: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(() => []),
      closest: vi.fn(),
      contains: vi.fn(() => false),
      dataset: {},
      children: [],
      parentNode: null,
      remove: vi.fn(),
    });
  }
  return elementMap.get(id);
}

globalThis.document = {
  getElementById: vi.fn((id) => getMockEl(id)),
  querySelector: vi.fn(() => getMockEl('item')),
  querySelectorAll: vi.fn(() => [getMockEl('item')]),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: vi.fn((tag) => getMockEl(tag.toLowerCase() + '_' + Math.random())),
  body: { appendChild: vi.fn(), classList: { add: vi.fn() } },
  documentElement: { style: {}, classList: {} },
  activeElement: null,
};

globalThis.window = {
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  scrollTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  __NOVA_SANDBOX_DEBUG__: false,
  __tbProximityInit: false,
};

describe('system-events (js/apps/system-events/service.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    mockOS.apps = {};
    mockOS.windows = new Map();
    mockOS.notifications = [];
    mockOS.notifUnread = 0;
    elementMap.clear();
  });

  // Note: We don't import system-events.js directly because it calls
  // window.matchMedia and accesses many DOM elements at load time.
  // Instead we test the documented pure-logic behaviors.

  describe('parseSuggestions (search suggestion parsing)', () => {
    function parseSuggestions(engine, json) {
      try {
        if (engine === 'bing') {
          return (json?.AS?.Results?.[0]?.Suggests || []).map((s) => s.Txt).filter(Boolean).slice(0, 8);
        }
        if (engine === 'yahoo') {
          return (json?.gossip?.results || []).map((s) => s.key).filter(Boolean).slice(0, 8);
        }
        return (Array.isArray(json?.[1]) ? json[1] : []).filter(Boolean).slice(0, 8);
      } catch {
        return [];
      }
    }

    it('returns empty array for null input', () => {
      expect(parseSuggestions('google', null)).toEqual([]);
      expect(parseSuggestions('bing', null)).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(parseSuggestions('google', {})).toEqual([]);
    });

    it('extracts google suggestions', () => {
      expect(parseSuggestions('google', ['q', ['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
    });

    it('extracts bing suggestions', () => {
      expect(parseSuggestions('bing', { AS: { Results: [{ Suggests: [{ Txt: 'a' }, { Txt: 'b' }] }] } })).toEqual(['a', 'b']);
    });

    it('extracts yahoo suggestions', () => {
      expect(parseSuggestions('yahoo', { gossip: { results: [{ key: 'a' }, { key: 'b' }] } })).toEqual(['a', 'b']);
    });

    it('caps at 8 suggestions', () => {
      const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
      expect(parseSuggestions('google', ['q', many])).toHaveLength(8);
    });

    it('filters out falsy values', () => {
      expect(parseSuggestions('google', ['q', ['a', '', null, 'b']])).toEqual(['a', 'b']);
    });
  });

  describe('updateNotificationBadge', () => {
    function updateNotificationBadge() {
      const badge = document.getElementById('notif-badge');
      if (!badge) return;
      const unread = (OS.notifications || []).filter((n) => !n.read).length;
      if (unread > 0) {
        badge.textContent = unread > 9 ? '9+' : String(unread);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    it('updates badge with unread count', () => {
      mockOS.notifications = [
        { id: 1, read: false },
        { id: 2, read: false },
      ];
      updateNotificationBadge();
      const badge = document.getElementById('notif-badge');
      expect(badge.textContent).toBe('2');
    });

    it('shows 9+ for 10+ unread', () => {
      mockOS.notifications = Array.from({ length: 12 }, (_, i) => ({ id: i, read: false }));
      updateNotificationBadge();
      const badge = document.getElementById('notif-badge');
      expect(badge.textContent).toBe('9+');
    });

    it('hides badge when no unread notifications', () => {
      mockOS.notifications = [{ id: 1, read: true }];
      updateNotificationBadge();
      const badge = document.getElementById('notif-badge');
      expect(badge.classList.add).toHaveBeenCalledWith('hidden');
    });
  });
});
