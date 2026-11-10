// tests/apps/debug-overlay.test.js — service app: developer HUD (F3 overlay).
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

describe('DebugOverlay service (js/apps/debug-overlay)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches DebugOverlay to window with the documented surface (not frozen)', async () => {
    const { window } = await loadServiceApp('debug-overlay');
    const svc = window.DebugOverlay;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['enable', 'disable', 'toggle', 'isEnabled', '_copyDebugInfo']) expect(typeof svc[m]).toBe('function');
    expect(svc.isEnabled()).toBe(false);
  });

  it('toggle() flips state and render loop paints HUD content (no OS stub -> "?" placeholders)', async () => {
    const { window, document } = await loadServiceApp('debug-overlay');
    // jsdom has no WebGL — keep the source's real "No WebGL" path but skip the
    // not-implemented stderr noise by mirroring the same null return.
    window.HTMLCanvasElement.prototype.getContext = () => null;

    expect(window.DebugOverlay.toggle()).toBe(true);
    expect(window.DebugOverlay.isEnabled()).toBe(true);
    const overlay = document.getElementById('debug-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.style.opacity).toBe('1');

    await settle(40); // let the rAF render loop run at least one frame
    const content = overlay.querySelector('.debug-content').textContent;
    expect(overlay.querySelector('.debug-drag-handle').textContent).toBe('AstroOS v?  [Dev Mode]');
    expect(content).toContain('FPS:');
    expect(content).toContain('Windows:      ?');
    expect(content).toContain('GPU:          No WebGL');
    expect(content).toContain('URL:          https://localhost/js/apps/debug-overlay/'); // href sliced to 40 chars

    expect(window.DebugOverlay.toggle()).toBe(false);
    expect(overlay.style.opacity).toBe('0');
    await settle(260); // removal timeout (200ms)
    expect(document.getElementById('debug-overlay')).toBe(null);
  });

  it('enable() is gated on OS.settings devMode and syncs debugOverlayVisible', async () => {
    const setCalls = [];
    const osStub = {
      version: '3.1',
      settings: { get: (k) => (k === 'devMode' ? false : null), set: (k, v) => setCalls.push([k, v]) },
      windows: new Map([['w1', { appId: 'com.a' }]]),
      apps: { a: {}, b: {} },
      currentWorkspace: 'ws1',
      workspaces: [{ id: 'ws1', name: 'Dev' }],
      _activeAppId: 'com.a',
    };
    const { window, document } = await loadServiceApp('debug-overlay', { stubs: { extra: { OS: osStub } } });
    window.HTMLCanvasElement.prototype.getContext = () => null;

    window.DebugOverlay.enable(); // devMode off -> no-op
    expect(window.DebugOverlay.isEnabled()).toBe(false);
    expect(document.getElementById('debug-overlay')).toBe(null);
    expect(setCalls).toEqual([]);

    osStub.settings.get = (k) => (k === 'devMode' ? true : null);
    window.DebugOverlay.enable();
    expect(setCalls).toEqual([['debugOverlayVisible', true]]);
    await settle(40);
    const content = document.querySelector('#debug-overlay .debug-content').textContent;
    expect(document.querySelector('#debug-overlay .debug-drag-handle').textContent).toBe('AstroOS v3.1  [Dev Mode]');
    expect(content).toContain('Windows:      1');
    expect(content).toContain('Apps:         2');
    expect(content).toContain('Workspace:    Dev');
    expect(content).toContain('Active App:   com.a');
    window.DebugOverlay.disable();
    expect(setCalls.at(-1)).toEqual(['debugOverlayVisible', false]);
  });

  it('enable() is idempotent and repeated calls do not stack overlays', async () => {
    const { window, document } = await loadServiceApp('debug-overlay');
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.DebugOverlay.enable();
    window.DebugOverlay.enable();
    window.DebugOverlay.enable();
    expect(document.querySelectorAll('#debug-overlay')).toHaveLength(1);
    expect(window.DebugOverlay.isEnabled()).toBe(true);
    window.DebugOverlay.disable();
  });

  it('drags via the handle, clamps to the viewport and persists the position', async () => {
    const { window, document } = await loadServiceApp('debug-overlay');
    window.DebugOverlay.enable();
    const overlay = document.getElementById('debug-overlay');
    // jsdom implements neither pointer capture nor layout — stub the former,
    // the latter is always 0 so the saved position is {0,0}-based.
    overlay.setPointerCapture = () => {};
    const handle = overlay.querySelector('.debug-drag-handle');
    const dispatch = (type, x, y) => overlay.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

    handle.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    expect(handle.style.cursor).toBe('grabbing');
    dispatch('pointermove', 160, 90); // dx 60, dy -10
    expect(overlay.style.left).toBe('60px');
    expect(overlay.style.top).toBe('0px'); // clamped at 0
    dispatch('pointermove', 6000, 100); // far off-screen
    expect(overlay.style.left).toBe(`${1024 - 60}px`); // clamped to innerWidth - 60
    dispatch('pointerup', 6000, 100);
    expect(handle.style.cursor).toBe('grab');
    expect(JSON.parse(window.localStorage.getItem('debug_overlay_pos'))).toEqual({ x: 0, y: 0 }); // offsetLeft/Top are 0 in jsdom
    // second pointerup without a drag is a no-op
    expect(() => overlay.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }))).not.toThrow();
    window.DebugOverlay.disable();
  });

  it('restores a saved position clamped into the viewport, and ignores corrupt state', async () => {
    const { window, document } = await loadServiceApp('debug-overlay');
    window.localStorage.setItem('debug_overlay_pos', JSON.stringify({ x: 5000, y: 5000 }));
    window.DebugOverlay.enable();
    const overlay = document.getElementById('debug-overlay');
    expect(overlay.style.top).toBe(`${768 - 20}px`); // innerHeight - 20
    expect(overlay.style.left).toBe(`${1024 - 60}px`); // innerWidth - 60
    window.DebugOverlay.disable();
    await settle(260);

    window.localStorage.setItem('debug_overlay_pos', '{corrupt');
    window.DebugOverlay.enable();
    const second = document.getElementById('debug-overlay');
    expect(second.style.top).toBe('8px');
    expect(second.style.left).toBe('8px');
    window.DebugOverlay.disable();
  });

  it('quirk: re-enabling within the 200ms removal window loses the element while still "enabled"', async () => {
    const { window, document } = await loadServiceApp('debug-overlay');
    window.DebugOverlay.enable();
    window.DebugOverlay.disable();
    window.DebugOverlay.enable(); // _create() returns the pending-removal element
    expect(window.DebugOverlay.isEnabled()).toBe(true);
    await settle(260);
    // The stale removal timer nukes the element out of the DOM; rAF loop stops.
    expect(document.getElementById('debug-overlay')).toBe(null);
    expect(window.DebugOverlay.isEnabled()).toBe(true);
    window.DebugOverlay.disable();
  });

  it('_copyDebugInfo() is a safe no-op when navigator.clipboard is unavailable', async () => {
    const { window } = await loadServiceApp('debug-overlay');
    expect(() => window.DebugOverlay._copyDebugInfo()).not.toThrow(); // no overlay, no clipboard
  });
});
