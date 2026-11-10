// tests/apps/music.test.js — window app: library scan via MediaStore, track
// row activation, shuffle/repeat/volume preferences, corrupt-pref recovery.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const PREFS_KEY = 'nova_music_prefs';

// jsdom has no createObjectURL and media play()/pause() are "not implemented"
// (play() returns undefined, which would crash `audio.play().catch(...)`).
// The real host (NW.js/Chromium) provides all of these — patch equivalents in.
function patchBrowserMedia(window) {
  if (typeof window.URL.createObjectURL !== 'function') {
    let n = 0;
    window.URL.createObjectURL = () => `blob:mock/${++n}`;
    window.URL.revokeObjectURL = () => {};
  }
  window.HTMLMediaElement.prototype.play = function play() {
    this.dispatchEvent(new window.Event('play'));
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause() {
    this.dispatchEvent(new window.Event('pause'));
  };
}

// MediaStore query fixture — { type:'audio', limit, offset } → page array.
function makeMediaStore(items) {
  return {
    query: ({ offset = 0 }) => (offset === 0 ? items : []),
  };
}

function makeNotify() {
  const calls = [];
  return { calls, show: (n) => calls.push(n) };
}

async function loadMusic({ media = [], notify = makeNotify() } = {}) {
  // scanLibrary prefers the FS.files record for each MediaStore hit, so the
  // fixture must live there to keep its content bytes.
  const fsFiles = new Map(media.map((t) => [t.id, { ...t, type: 'file' }]));
  const loaded = await loadWindowApp('music', {
    stubs: {
      extra: {
        FS: { files: fsFiles },
        AstroOSMediaStore: makeMediaStore(media),
        Notify: notify,
      },
    },
  });
  patchBrowserMedia(loaded.window);
  const content = initApp(loaded.app, { window: loaded.window, state: {} });
  await settle(10);
  return { ...loaded, content };
}

// Track records as they live in FS.files — content must be decodable by
// normalizeBuffer() (plain UTF-8 text here, the same path text-based
// fixtures take in the real app).
const TRACKS = [
  { id: 'm2', name: 'b-side.flac', mimeType: 'audio/flac', content: 'fake-flac-bytes' },
  { id: 'm1', name: 'Aurora.wav', mimeType: 'audio/wav', content: 'fake-wav-bytes' },
];

describe("'Music' app (js/apps/music)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('music');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.music');
    expect(app.name).toBe('Music');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Music Player');
    expect(app.icon).toBe('music');
    expect(app.defaultSize).toEqual([520, 520]);
    expect(app.minSize).toEqual([360, 380]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('music', { stubs: { AppDirs: null } });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.astroos.music');
  });

  it('renders the player shell with an empty-library state', async () => {
    const { content } = await loadMusic({ media: [] });
    expect(content.textContent).toContain('Library');
    expect(content.textContent).toContain('No audio files found');
    expect(content.textContent).toContain('Save audio files via Files to play them here');
    // Track counter stays blank for an empty library (source: libCount ternary).
    const counter = [...content.querySelectorAll('span')].find((s) => s.textContent === '');
    expect(counter).toBeTruthy();
    const playBtn = [...content.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Play');
    expect(playBtn).toBeTruthy();
    const seek = content.querySelector('[role="slider"][aria-label="Seek"]');
    expect(seek.getAttribute('aria-valuetext')).toBe('0:00 of 0:00');
    expect(content.querySelector('input[type="range"][aria-label="Volume"]').value).toBe('1');
  });

  it('scans the MediaStore, counts tracks and sorts them by name', async () => {
    const { content } = await loadMusic({ media: TRACKS });
    const counter = [...content.querySelectorAll('span')].find((s) => s.textContent === '2 tracks');
    expect(counter).toBeTruthy();
    const rows = [...content.querySelectorAll('[data-track-id]')];
    expect(rows.map((r) => r.dataset.trackId)).toEqual(['m1', 'm2']); // Aurora < b-side
    expect(rows[0].textContent).toContain('Aurora');
    expect(rows[0].getAttribute('aria-label')).toBe('Aurora'); // extension stripped
  });

  it('plays a track when its row is clicked (src swap + title update)', async () => {
    const { content, window } = await loadMusic({ media: TRACKS });
    const audio = content.querySelector('audio');
    const row = content.querySelector('[data-track-id="m1"]');

    row.click();
    await settle(10);

    expect(audio.src).toMatch(/^blob:mock\//);
    const title = [...content.querySelectorAll('div')].find((d) => d.textContent === 'Aurora');
    expect(title).toBeTruthy();
    const current = content.querySelector('[data-track-id="m1"]');
    expect(current.dataset.current).toBe('true');
    // Pause event never fired (play() resolves without a real play state
    // change in jsdom), so the row is marked current-but-paused.
    expect(current.getAttribute('aria-label')).toBe('Aurora, paused');
    // Second click on the current row toggles pause instead of reloading.
    current.click();
    await settle(10);
    expect(audio.src).toMatch(/^blob:mock\//); // src untouched — no re-load
  });

  it('notifies via Notify when the MediaStore service is unavailable', async () => {
    const notify = makeNotify();
    const loaded = await loadWindowApp('music', {
      stubs: { extra: { FS: { files: new Map() }, Notify: notify } },
    });
    patchBrowserMedia(loaded.window);
    initApp(loaded.app, { window: loaded.window, state: {} });
    await settle(20);

    expect(notify.calls.some((n) => n.title === 'Music' &&
      n.body.includes('Could not read the Music folder: AstroOS MediaStore is unavailable'))).toBe(true);
  });

  it('toggles shuffle and repeat, persisting each to localStorage', async () => {
    const { content, window } = await loadMusic({ media: TRACKS });
    const shuffleBtn = [...content.querySelectorAll('button')].find((b) => b.title === 'Shuffle');
    const repeatBtn = [...content.querySelectorAll('button')].find((b) => b.title === 'Repeat');

    shuffleBtn.click();
    expect(shuffleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(shuffleBtn.style.color).toBe('rgb(74, 222, 128)');
    let prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY));
    expect(prefs.shuffle).toBe(true);

    repeatBtn.click();
    expect(repeatBtn.getAttribute('aria-pressed')).toBe('true');
    expect(repeatBtn.style.color).toBe('rgb(74, 222, 128)');
    prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY));
    expect(prefs.repeat).toBe(true);

    shuffleBtn.click();
    expect(shuffleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)).shuffle).toBe(false);
  });

  it('applies volume live on input and debounces the persisted write', async () => {
    const { content, window } = await loadMusic({ media: [] });
    const slider = content.querySelector('input[type="range"][aria-label="Volume"]');
    const audio = content.querySelector('audio');

    slider.value = '0.5';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(audio.volume).toBeCloseTo(0.5);
    // Nothing persisted yet — the change event owns the debounced save.
    expect(window.localStorage.getItem(PREFS_KEY)).toBeNull();

    slider.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle(500); // VOLUME_AUTOSAVE_DELAY_MS = 400

    const prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY));
    expect(prefs.volume).toBeCloseTo(0.5);
  });

  it('recovers from corrupt or out-of-range persisted prefs', async () => {
    // Corrupt JSON in storage: loadPrefs() catches and starts fresh.
    const { app, window } = await loadWindowApp('music', {
      stubs: {
        extra: { FS: { files: new Map() }, AstroOSMediaStore: makeMediaStore([]) },
      },
    });
    patchBrowserMedia(window);
    window.localStorage.setItem(PREFS_KEY, '{oops-not-json');
    const content = initApp(app, { window, state: {} });
    expect(content.querySelector('input[type="range"][aria-label="Volume"]').value).toBe('1');

    // Out-of-range numeric volume is clamped into [0,1].
    const loaded2 = await loadWindowApp('music', {
      stubs: {
        extra: { FS: { files: new Map() }, AstroOSMediaStore: makeMediaStore([]) },
      },
    });
    patchBrowserMedia(loaded2.window);
    loaded2.window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: 7 }));
    const content2 = initApp(loaded2.app, { window: loaded2.window, state: {} });
    expect(content2.querySelector('input[type="range"][aria-label="Volume"]').value).toBe('1');
  });
});
