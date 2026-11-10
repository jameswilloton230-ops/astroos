// tests/apps/wallpaper.test.js — service app: presets + background application.
import { describe, expect, it } from 'vitest';
import { loadServiceApp } from '../helpers/app-harness.js';

describe('Wallpaper service (js/apps/wallpaper)', () => {
  it('attaches a frozen WallpaperService to window', async () => {
    const { window } = await loadServiceApp('wallpaper');
    const svc = window.WallpaperService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(typeof svc.apply).toBe('function');
    expect(typeof svc.getPresets).toBe('function');
  });

  it('exposes the stock preset catalogue', async () => {
    const { window } = await loadServiceApp('wallpaper');
    const presets = window.WallpaperService.getPresets();
    expect(presets.length).toBeGreaterThanOrEqual(8);
    const ids = presets.map((p) => p.id);
    for (const id of ['stock-blue', 'stock-dark', 'stock-light', 'stock-teal']) {
      expect(ids).toContain(id);
    }
    for (const p of presets) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      // AstroOS presets may be CSS gradients or flat hex colours
      // (the stock default 'Lineage Dark' is a flat '#0f0f0f').
      expect(p.gradient).toMatch(/gradient\(|^#[0-9a-f]{3,6}$/i);
    }
  });

  it('applies a stock preset gradient to #wallpaper and #desktop', async () => {
    const { window, document } = await loadServiceApp('wallpaper');
    document.body.innerHTML = '<div id="wallpaper"></div><div id="desktop"></div>';
    const settings = (key) => (key === 'wallpaperId' ? 'stock-teal' : null);
    expect(window.WallpaperService.apply(settings)).toBe(true);
    const gradient = document.getElementById('wallpaper').style.backgroundImage;
    // jsdom's CSS serializer normalizes the declared gradient (hex -> rgb(),
    // ellipse keyword dropped), so assert on the leading color channel plus
    // the structural fact that BOTH targets got the same preset.
    expect(gradient).toMatch(/^radial-gradient\(/);
    expect(gradient).toContain('rgb(10, 94, 112)'); // stock-teal leading #0a5e70
    expect(document.getElementById('desktop').style.backgroundImage).toBe(gradient);
  });

  it('prefers a custom wallpaper and switches to cover/center/no-repeat', async () => {
    const { window, document } = await loadServiceApp('wallpaper');
    document.body.innerHTML = '<div id="wallpaper"></div>';
    const settings = (key) => (key === 'customWallpaper' ? 'file:///home/me/pic.png' : null);
    window.WallpaperService.apply(settings);
    const style = document.getElementById('wallpaper').style;
    expect(style.backgroundImage).toContain('pic.png');
    expect(style.backgroundSize).toBe('cover');
    expect(style.backgroundPosition).toMatch(/^center( center)?$/); // jsdom normalizes
    expect(style.backgroundRepeat).toBe('no-repeat');
  });

  it('rejects a non-function settings reader and no-ops without targets', async () => {
    const { window, document } = await loadServiceApp('wallpaper');
    // Cross-realm (jsdom) TypeError — match the message, not the class.
    expect(() => window.WallpaperService.apply('not-a-function')).toThrow(/must be a function/);
    document.body.innerHTML = '<div id="unrelated"></div>';
    expect(window.WallpaperService.apply(() => null)).toBe(false);
  });

  it('falls back to the stock-blue preset for unknown ids', async () => {
    const { window, document } = await loadServiceApp('wallpaper');
    document.body.innerHTML = '<div id="wallpaper"></div>';
    window.WallpaperService.apply(() => null);
    const blue = window.WallpaperService.getPresets().find((p) => p.id === 'stock-blue');
    // AstroOS default preset is the flat 'Lineage Dark' (#0f0f0f), which the
    // service routes to backgroundColor because a flat hex is not a valid
    // backgroundImage value.
    expect(document.getElementById('wallpaper').style.backgroundColor).toBe('rgb(15, 15, 15)');
    expect(document.getElementById('wallpaper').style.backgroundImage).toBe('none');
    expect(blue.name).toBe('Lineage Dark');
  });
});
