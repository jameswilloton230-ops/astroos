// tests/apps/tray.test.js — service app: tray flyouts (wifi, volume, calendar, battery).
import { describe, expect, it, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

const TRAY_MARKUP = `
  <span id="tray-wifi"></span>
  <button id="tray-volume"></button>
  <div id="volume-popup"></div>
  <input id="volume-slider" />
  <span id="volume-value"></span>
  <span id="tray-clock"></span>
  <div id="calendar-popup">
    <div id="calendar-popup-title"></div>
    <div id="calendar-popup-weekdays"></div>
    <div id="calendar-popup-grid"></div>
    <button id="calendar-popup-prev"></button>
    <button id="calendar-popup-next"></button>
  </div>
  <span id="tray-battery"></span>`;

// The tray wires its DOM listeners while service.js is being evaluated (it
// grabs #tray-* elements at the top of the script), so the harness's
// load-then-use order can't provide the markup in time. We therefore load with
// scripts: [] (stubs still installed), populate the real jsdom document, and
// eval the service script manually — the same mechanism the host uses, just
// with the shell markup present.
async function loadTray({ osOverrides = {}, NovaByteSystem, navigatorExtras } = {}) {
  const os = {
    volume: 0,
    events: { emit: (...a) => emitted.push(a) },
    windows: new Map(),
    ...osOverrides,
  };
  const emitted = [];
  const { dom, window, document } = await loadServiceApp('tray', {
    scripts: [],
    stubs: { extra: { OS: os, ...(NovaByteSystem ? { NovaByteSystem } : {}) } },
  });
  document.body.innerHTML = TRAY_MARKUP;
  for (const [key, value] of Object.entries(navigatorExtras ?? {})) {
    Object.defineProperty(window.navigator, key, { value, configurable: true });
  }
  window.eval(await readFile(new URL('../../js/apps/tray/service.js', import.meta.url), 'utf8'));
  return { dom, window, document, os, emitted };
}

describe('TrayService service (js/apps/tray)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen TrayService that mirrors OS.applyVolumeToWebviews', async () => {
    const { window, os } = await loadTray();
    const svc = window.TrayService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['applyVolumeToWebviews']);
    expect(svc.applyVolumeToWebviews).toBe(os.applyVolumeToWebviews); // same function, defined by the volume section
    expect(typeof svc.applyVolumeToWebviews).toBe('function');
  });

  it('volume slider: updates OS volume, label, emits os:volumeChanged and pushes to webviews', async () => {
    const webview = { executeScript: (args) => webview.calls.push(args) };
    webview.calls = [];
    const otherWebview = { executeScript: () => { throw new Error('should not be touched'); } };
    const { window, document, os, emitted } = await loadTray({
      osOverrides: {
        windows: new Map([
          ['w1', { appId: 'com.nbosp.browser', element: { querySelectorAll: (sel) => (sel === 'webview' ? [webview] : []) } }],
          ['w2', { appId: 'com.nbosp.notes', element: { querySelectorAll: () => [otherWebview] } }],
        ]),
      },
    });

    const slider = document.getElementById('volume-slider');
    slider.value = '37';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(os.volume).toBe(37);
    expect(document.getElementById('volume-value').textContent).toBe('37%');
    expect(emitted).toEqual([['os:volumeChanged', { volume: 37 }]]);
    expect(webview.calls).toHaveLength(1);
    // the injected script JSON-encodes the clamped volume — never raw concatenation
    expect(webview.calls[0].code).toContain('var v=0.37;');
  });

  it('applyVolumeToWebviews: clamps out-of-range values, ignores NaN, targets single webview', async () => {
    const webview = { executeScript: (args) => webview.calls.push(args.code) };
    webview.calls = [];
    const target = { executeScript: (args) => target.calls.push(args.code) };
    target.calls = [];
    const { window } = await loadTray({
      osOverrides: {
        windows: new Map([['w1', { appId: 'com.nbosp.browser', element: { querySelectorAll: () => [webview] } }]]),
      },
    });
    const apply = window.TrayService.applyVolumeToWebviews;

    apply(150);
    expect(webview.calls.at(-1)).toContain('var v=1;');
    apply(-5);
    expect(webview.calls.at(-1)).toContain('var v=0;');
    apply(Number.NaN);
    expect(webview.calls).toHaveLength(2); // NaN ignored

    apply(55, target);
    expect(target.calls).toEqual([expect.stringContaining('var v=0.55;')]);
    expect(webview.calls).toHaveLength(2); // broadcast not re-sent
  });

  it('volume popup: button toggles it, outside click closes it, right-click pins it', async () => {
    const { window, document } = await loadTray();
    const btn = document.getElementById('tray-volume');
    const popup = document.getElementById('volume-popup');

    btn.click();
    expect(popup.classList.contains('active')).toBe(true);
    document.body.click(); // not pinned -> closes
    expect(popup.classList.contains('active')).toBe(false);

    btn.click();
    btn.dispatchEvent(new window.MouseEvent('contextmenu', { cancelable: true })); // pin
    document.body.click();
    expect(popup.classList.contains('active')).toBe(true); // pinned stays open
    btn.dispatchEvent(new window.MouseEvent('contextmenu', { cancelable: true })); // unpin
    document.body.click();
    expect(popup.classList.contains('active')).toBe(false);
  });

  it('calendar popup: opens on today, renders a 42-cell Monday-first grid with today highlighted', async () => {
    const { window, document } = await loadTray();
    const today = new Date();
    const fmt = (d, opts) => d.toLocaleDateString([], opts);

    document.getElementById('tray-clock').click();
    const popup = document.getElementById('calendar-popup');
    expect(popup.classList.contains('active')).toBe(true);
    expect(document.getElementById('calendar-popup-title').textContent).toBe(
      fmt(new Date(today.getFullYear(), today.getMonth(), 1), { month: 'long', year: 'numeric' }));

    const weekdayLabels = [...document.getElementById('calendar-popup-weekdays').children].map((s) => s.textContent);
    expect(weekdayLabels).toHaveLength(7);
    expect(weekdayLabels[0]).toBe(fmt(new Date(1970, 0, 5), { weekday: 'short' })); // a Monday

    const cells = [...document.getElementById('calendar-popup-grid').children];
    expect(cells).toHaveLength(42); // always padded to 6 rows
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const leading = (first.getDay() + 6) % 7;
    expect(cells[leading].textContent).toBe('1'); // day 1 sits under the right weekday
    expect(cells[leading - 1].classList.contains('is-outside-month')).toBe(true);
    const todayCell = cells.find((c) => c.classList.contains('is-today'));
    expect(todayCell.textContent).toBe(String(today.getDate()));
  });

  it('calendar popup: prev/next navigate months and roll over year boundaries', async () => {
    const { window, document } = await loadTray();
    const today = new Date();
    const fmt = (d) => d.toLocaleDateString([], { month: 'long', year: 'numeric' });

    document.getElementById('tray-clock').click();
    document.getElementById('calendar-popup-next').click();
    expect(document.getElementById('calendar-popup-title').textContent).toBe(
      fmt(new Date(today.getFullYear(), today.getMonth() + 1, 1)));

    // walk back 2 -> previous month; crossing into the previous year rolls over
    document.getElementById('calendar-popup-prev').click();
    document.getElementById('calendar-popup-prev').click();
    expect(document.getElementById('calendar-popup-title').textContent).toBe(
      fmt(new Date(today.getFullYear(), today.getMonth() - 1, 1)));

    // no cell in another month is highlighted as today
    expect(document.getElementById('calendar-popup-grid').querySelector('.is-today')).toBe(null);
    document.body.click();
    expect(document.getElementById('calendar-popup').classList.contains('active')).toBe(false); // outside click closes
  });

  it('wifi popup: shows NetworkManager connectivity when available, toggles and dismisses', async () => {
    const { window, document } = await loadTray({
      NovaByteSystem: {
        hardware: { network: { getStatus: async () => ({ supported: true, connectivity: 'full', networkState: 'connected' }) } },
      },
    });
    const wifi = document.getElementById('tray-wifi');

    wifi.click();
    let popup = document.getElementById('wifi-popup');
    expect(popup).toBeTruthy();
    expect(popup.textContent).toContain('Network');
    await settle();
    expect(popup.textContent).toContain('Connected to the internet');

    wifi.click(); // second click on the tray icon toggles it closed
    expect(document.getElementById('wifi-popup')).toBe(null);

    wifi.click(); // reopen, then an outside click dismisses (the once-listener)
    popup = document.getElementById('wifi-popup');
    expect(popup).toBeTruthy();
    document.body.click();
    expect(document.getElementById('wifi-popup')).toBe(null);
  });

  it('wifi popup: falls back to navigator.onLine and reports getStatus failures', async () => {
    const { window, document } = await loadTray(); // no NovaByteSystem -> onLine fallback
    document.getElementById('tray-wifi').click();
    await settle();
    expect(document.getElementById('wifi-popup').textContent).toContain('Connected to network');

    const { window: w2, document: d2 } = await loadTray({
      NovaByteSystem: { hardware: { network: { getStatus: async () => ({ supported: true, connectivity: 'limited' }) } } },
    });
    d2.getElementById('tray-wifi').click();
    await settle();
    expect(d2.getElementById('wifi-popup').textContent).toContain('Connected, but no internet access');

    const { window: w3, document: d3 } = await loadTray({
      NovaByteSystem: { hardware: { network: { getStatus: async () => { throw new Error('down'); } } } },
    });
    d3.getElementById('tray-wifi').click();
    await settle();
    expect(d3.getElementById('wifi-popup').textContent).toContain('Network status unavailable');
  });

  it('battery: renders level percentage and live-updates on levelchange', async () => {
    const listeners = {};
    const battery = {
      level: 0.87,
      charging: false,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: () => {},
    };
    const { window, document } = await loadTray({
      navigatorExtras: { getBattery: async () => battery },
    });
    await settle();
    const btn = document.getElementById('tray-battery');
    expect(btn.textContent).toBe('87%');

    battery.level = 0.5;
    listeners.levelchange(); // live update path
    expect(btn.textContent).toBe('50%');
    expect(Object.isFrozen(window.TrayService)).toBe(true);
  });
});
