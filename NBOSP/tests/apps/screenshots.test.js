// tests/apps/screenshots.test.js — service app: screen capture into Pictures/Screenshots.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

// jsdom's canvas getContext() returns null (no `canvas` npm package) and the
// video element never plays — this test patches the minimal surface the
// capture pipeline needs (2d ctx, toDataURL, video play + dimensions).
function installCanvasAndVideoStubs(window, { dataUrl = 'data:image/png;base64,AAAA' } = {}) {
  window.HTMLCanvasElement.prototype.getContext = function () {
    const proxy = new Proxy({}, {
      get: () => (...args) => proxy,
      set: () => true,
    });
    return proxy;
  };
  window.HTMLCanvasElement.prototype.toDataURL = () => dataUrl;
  window.HTMLVideoElement.prototype.play = () => Promise.resolve();
}

function makeFsStub({ picturesId = 'pic-1', listDir = [], files = null } = {}) {
  const calls = { createFolder: [], createFile: [], listDir: [], uniqueName: [] };
  return {
    calls,
    stub: {
      files: files ?? new Set(),
      specialFolders: picturesId ? { pictures: picturesId } : {},
      listDir: (id) => { calls.listDir.push(id); return typeof listDir === 'function' ? listDir(id) : listDir; },
      createFolder: async (parent, name) => { calls.createFolder.push([parent, name]); return { id: 'shots-1' }; },
      uniqueName: (dir, name) => { calls.uniqueName.push([dir, name]); return name; },
      createFile: async (dir, name, content, mime) => { calls.createFile.push([dir, name, content, mime]); return { id: 'file-1' }; },
    },
  };
}

async function loadWithMedia({ getDisplayMedia, fsOpts, notifyCalls = [], eventLogCalls = [] } = {}) {
  const fs = makeFsStub(fsOpts);
  // withBaseUtils: _promptRegionSelect builds its overlay with the shared
  // createEl() helper from js/core/utils/base-utils.js.
  const { window, document } = await loadServiceApp('screenshots', {
    withBaseUtils: true,
    stubs: {
      extra: {
        FS: fs.stub,
        Notify: { show: (o) => notifyCalls.push(o) },
        EventLog: { log: (e) => eventLogCalls.push(e) },
      },
    },
  });
  // The source reads navigator.mediaDevices (a jsdom Navigator getter), so the
  // override must go on the navigator instance, not on an own window property.
  if (getDisplayMedia) {
    Object.defineProperty(window.navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
  }
  return { window, document, fsCalls: fs.calls, notifyCalls, eventLogCalls };
}

const makeStream = () => {
  const stopped = [];
  return { stream: { getTracks: () => [{ stop: () => stopped.push(1) }] }, stopped };
};

describe('ScreenshotService service (js/apps/screenshots)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen ScreenshotService exposing capture()', async () => {
    const { window } = await loadServiceApp('screenshots');
    const svc = window.ScreenshotService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['capture']);
    expect(typeof svc.capture).toBe('function');
  });

  it('without navigator.mediaDevices it fails gracefully via Notify + EventLog', async () => {
    const { window, notifyCalls, eventLogCalls } = await loadWithMedia();
    await window.ScreenshotService.capture('monitor');
    expect(notifyCalls).toEqual([{ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' }]);
    expect(eventLogCalls).toHaveLength(1);
    expect(eventLogCalls[0]).toMatchObject({ severity: 'error', app: 'System' });
    expect(eventLogCalls[0].message).toContain('Screenshot capture failed (monitor)');
  });

  it('captures the full screen: stops tracks, writes base64 into FS, notifies success', async () => {
    const { stream, stopped } = makeStream();
    const { window, fsCalls, notifyCalls, eventLogCalls } = await loadWithMedia({
      getDisplayMedia: async () => stream,
    });
    installCanvasAndVideoStubs(window);

    await window.ScreenshotService.capture('monitor');

    expect(stopped).toHaveLength(1); // track released before the user interacts
    expect(fsCalls.createFolder).toEqual([['pic-1', 'Screenshots']]);
    const [dir, name, content, mime] = fsCalls.createFile[0];
    expect(dir).toBe('shots-1');
    expect(name).toMatch(/^screenshot-\d+\.png$/);
    expect(content).toBe('AAAA'); // data: wrapper stripped, raw base64 stored
    expect(mime).toBe('image/png');
    expect(notifyCalls[0]).toMatchObject({ title: 'Screenshot Saved', type: 'success', appName: 'System' });
    expect(notifyCalls[0].body).toContain(`Saved to Pictures/Screenshots as ${name}`);
    expect(eventLogCalls[0]).toMatchObject({ severity: 'info', data: { mode: 'monitor', name } });
  });

  it('region mode: resolves a pointer-drawn rectangle in image space', async () => {
    const { stream } = makeStream();
    const { window, document, fsCalls, notifyCalls } = await loadWithMedia({
      getDisplayMedia: async () => stream,
    });
    installCanvasAndVideoStubs(window);
    // Give the captured frame real dimensions so the region math has a scale.
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 320, configurable: true });
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 240, configurable: true });

    const pending = window.ScreenshotService.capture('region');
    await settle();
    const overlay = document.getElementById('screenshot-region-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('Drag to select a region · Esc to cancel');

    const dispatch = (type, x, y) => overlay.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    const frame = overlay.firstElementChild;
    const selectionBox = frame.children[1]; // [img, selectionBox, hint]
    dispatch('pointerdown', 10, 10);
    dispatch('pointermove', 60, 40);
    expect(selectionBox.style.display).toBe('block');
    expect(selectionBox.style.width).toBe('50px'); // scale = min(921.6/320, 691.2/240, 1) = 1
    expect(selectionBox.style.height).toBe('30px');
    dispatch('pointerup', 60, 40);
    await pending;

    expect(fsCalls.createFile).toHaveLength(1);
    expect(fsCalls.createFile[0][1]).toMatch(/^screenshot-\d+\.png$/);
    expect(notifyCalls[0].title).toBe('Screenshot Saved');
  });

  it('region mode: Escape cancels without saving or notifying', async () => {
    const { stream } = makeStream();
    const { window, document, fsCalls, notifyCalls } = await loadWithMedia({
      getDisplayMedia: async () => stream,
    });
    installCanvasAndVideoStubs(window);

    const pending = window.ScreenshotService.capture('region');
    await settle();
    expect(document.getElementById('screenshot-region-overlay')).toBeTruthy();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await pending;

    expect(document.getElementById('screenshot-region-overlay')).toBe(null);
    expect(fsCalls.createFile).toHaveLength(0);
    expect(notifyCalls).toEqual([]); // cancelled — not an error
  });

  it('missing Pictures folder surfaces "Pictures folder not found" as a failed capture', async () => {
    const { stream } = makeStream();
    const { window, notifyCalls, eventLogCalls } = await loadWithMedia({
      getDisplayMedia: async () => stream,
      fsOpts: { picturesId: null },
    });
    installCanvasAndVideoStubs(window);
    await window.ScreenshotService.capture('window');
    expect(notifyCalls[0].title).toBe('Screenshot Failed');
    expect(eventLogCalls[0].severity).toBe('error');
    expect(eventLogCalls[0].message).toContain('Pictures folder not found');
  });

  it('caches the Screenshots folder id across captures (single createFolder)', async () => {
    const { stream } = makeStream();
    const { window, fsCalls } = await loadWithMedia({
      getDisplayMedia: async () => stream,
      fsOpts: { files: new Set(['shots-1']) }, // cache validator sees the folder as live
    });
    installCanvasAndVideoStubs(window);

    await window.ScreenshotService.capture('monitor');
    await window.ScreenshotService.capture('window');

    expect(fsCalls.createFolder).toHaveLength(1); // created once
    expect(fsCalls.listDir).toHaveLength(1); // second capture used the cached id
    expect(fsCalls.createFile).toHaveLength(2);
  });
});
