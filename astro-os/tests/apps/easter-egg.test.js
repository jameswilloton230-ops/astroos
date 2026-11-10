// tests/apps/easter-egg.test.js — service app: hidden Snake game overlay.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

// jsdom's canvas getContext() returns null without the `canvas` npm package,
// which would make the game's draw() throw. The source only ever calls 2d
// drawing methods and reads nothing back, so a self-returning call proxy is a
// faithful stand-in for the purposes of this service's behavior.
function installFake2dContext(window) {
  window.HTMLCanvasElement.prototype.getContext = function () {
    const proxy = new Proxy({}, {
      get: () => (...args) => proxy, // every method (incl. createRadialGradient) chains
      set: () => true,               // fillStyle/strokeStyle/lineWidth assignments
    });
    return proxy;
  };
}

async function launchEgg() {
  const { window, document } = await loadServiceApp('easter-egg', { withBaseUtils: true });
  installFake2dContext(window);
  window.AstroOSEasterEgg.launch();
  const overlay = document.getElementById('snake-game-overlay');
  return { window, document, overlay };
}

function closeOverlay(document, overlay) {
  const closeBtn = overlay.querySelector('button[aria-label="Close"]');
  closeBtn.click();
}

describe('AstroOSEasterEgg service (js/apps/easter-egg)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen AstroOSEasterEgg exposing only launch()', async () => {
    const { window } = await loadServiceApp('easter-egg', { withBaseUtils: true });
    const svc = window.AstroOSEasterEgg;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['launch']);
    expect(typeof svc.launch).toBe('function');
  });

  it('launch() mounts the snake overlay with title, score and a 20x20 cell canvas', async () => {
    const { document, overlay } = await launchEgg();
    try {
      expect(overlay).toBeTruthy();
      expect(overlay.textContent).toContain('🐍 AstroOS Snake');
      expect(overlay.textContent).toContain('Score: 0');
      expect(overlay.textContent).toContain('Arrow keys / WASD');
      const canvas = overlay.querySelector('canvas');
      expect(canvas).toBeTruthy();
      expect(canvas.width).toBe(360); // COLS 20 * CELL 18
      expect(canvas.height).toBe(360);
      expect(canvas.getAttribute('aria-label')).toBe('Snake game canvas');
    } finally {
      closeOverlay(document, overlay);
    }
  });

  it('is idempotent: a second launch() while open does not stack overlays', async () => {
    const { window, document, overlay } = await launchEgg();
    try {
      window.AstroOSEasterEgg.launch();
      window.AstroOSEasterEgg.launch();
      expect(document.querySelectorAll('#snake-game-overlay')).toHaveLength(1);
    } finally {
      closeOverlay(document, overlay);
    }
  });

  it('steers with arrows/WASD, prevents page scroll, and blocks 180° reversals', async () => {
    const { window, document, overlay } = await launchEgg();
    try {
      const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      // Snake starts heading right — Up is a legal turn and must preventDefault.
      const up = new window.KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
      document.dispatchEvent(up);
      expect(up.defaultPrevented).toBe(true);
      // Reverse of the CURRENT direction is ignored (no preventDefault either).
      const left = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
      document.dispatchEvent(left);
      expect(left.defaultPrevented).toBe(false);
      // WASD aliases work too.
      const s = new window.KeyboardEvent('keydown', { key: 's', cancelable: true });
      document.dispatchEvent(s);
      expect(s.defaultPrevented).toBe(true);
      // Unrelated keys are left alone.
      const f = new window.KeyboardEvent('keydown', { key: 'f', cancelable: true });
      document.dispatchEvent(f);
      expect(f.defaultPrevented).toBe(false);
    } finally {
      closeOverlay(document, overlay);
    }
  });

  it('close button removes the overlay and unbinds the key handler', async () => {
    const { window, document, overlay } = await launchEgg();
    closeOverlay(document, overlay);
    expect(document.getElementById('snake-game-overlay')).toBe(null);

    const after = new window.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('clicking the backdrop (not the board) dismisses the game', async () => {
    const { document, overlay } = await launchEgg();
    overlay.click(); // target === overlay
    expect(document.getElementById('snake-game-overlay')).toBe(null);
  });
});
