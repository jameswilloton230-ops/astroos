// tests/apps/gallery.test.js — window app: media-store backed image grid,
// lightbox navigation, trash filtering, and the missing-store fallback.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

// Minimal in-memory FS covering the gallery surface: files Map + trash folder.
function makeFS(nodes = []) {
  const files = new Map();
  const specialFolders = { trash: 'trash-id', desktop: 'desktop-id' };
  for (const n of nodes) files.set(n.id, n);
  return { files, specialFolders };
}

// MediaStore stub returning paged query results like the real service.
function makeMediaStore(items) {
  return {
    query: ({ offset }) => items.slice(offset, offset + 500),
  };
}

// jsdom has no URL.createObjectURL; gallery blob URLs are only used as img src
// strings, so a counting stub is enough and works because it is installed
// before initApp (the app resolves URL lazily at render time).
function stubBlobURLs(window) {
  const created = [];
  window.URL.createObjectURL = (blob) => {
    const url = 'blob:test-' + (created.length + 1);
    created.push({ url, blob });
    return url;
  };
  window.URL.revokeObjectURL = () => {};
  return created;
}

async function loadGallery({ fsNodes = [], mediaItems = [], state = {} } = {}) {
  const loaded = await loadWindowApp('gallery', {
    stubs: { extra: { Notify: { show: vi.fn() } } },
  });
  const { app, window } = loaded;
  const FS = makeFS(fsNodes);
  window.FS = FS;
  window.AstroOSMediaStore = makeMediaStore(mediaItems);
  const created = stubBlobURLs(window);
  const content = initApp(app, { window, state });
  await settle(); // render() is async
  return { ...loaded, app, window, FS, created, content };
}

describe('Gallery app (js/apps/gallery)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('gallery');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.gallery');
    expect(app.name).toBe('Gallery');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('image');
    expect(app.defaultSize).toEqual([840, 580]);
    expect(app.minSize).toEqual([500, 360]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('gallery', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.gallery');
  });

  it('renders an empty-state grid when the media store has no images', async () => {
    const { content } = await loadGallery();
    expect(content.textContent).toContain('Gallery');
    expect(content.textContent).toContain('No images found');
    expect(content.textContent).toContain('Save image files via Files to view them here');
  });

  it('surfaces a MediaStore failure as an error notification with the empty grid', async () => {
    const loaded = await loadWindowApp('gallery', {
      stubs: { extra: { Notify: { show: vi.fn() } } },
    });
    const { app, window } = loaded;
    window.FS = makeFS();
    const notify = loaded.window.Notify;
    window.AstroOSMediaStore = {}; // no .query → render throws
    const content = initApp(app, { window });
    await settle();
    expect(content.textContent).toContain('No images found');
    expect(notify.show).toHaveBeenCalledTimes(1);
    const call = notify.show.mock.calls[0][0];
    expect(call.title).toBe('Gallery');
    expect(call.body).toContain('Could not read the Pictures folder');
    expect(call.body).toContain('AstroOS MediaStore is unavailable');
  });

  it('lists image files newest-first and builds a blob URL per image', async () => {
    const a = { id: 'img-a', name: 'a.png', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/png', modified: 100 };
    const b = { id: 'img-b', name: 'b.jpg', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/jpeg', modified: 300 };
    const note = { id: 'txt', name: 'notes.txt', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'text/plain', modified: 999 };
    const { content, created } = await loadGallery({
      fsNodes: [a, b, note],
      // The real MediaStore.query({ type: 'image' }) only returns images —
      // the text file in FS is invisible to the gallery.
      mediaItems: [{ id: 'img-a' }, { id: 'img-b' }],
    });
    // Only images are shown, newest (b, modified 300) before a (100)
    expect(content.textContent).not.toContain('notes.txt');
    const cards = content.querySelectorAll('[role="button"][aria-label]');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('aria-label')).toBe('b.jpg');
    expect(cards[1].getAttribute('aria-label')).toBe('a.png');
    expect(content.textContent).toContain('2 images');
    // One object URL per image was created from the file bytes
    expect(created).toHaveLength(2);
    expect(created[0].blob.type).toBe('image/jpeg'); // sorted first → b.jpg rendered first
  });

  it('excludes images inside Trash and merges the state.fileId image into the grid', async () => {
    const kept = { id: 'kept', name: 'kept.png', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/png', modified: 5 };
    const trashed = { id: 'trashed', name: 'trashed.png', type: 'file', parentId: 'trash-id', content: PNG_BYTES, mimeType: 'image/png', modified: 10 };
    const opened = { id: 'opened', name: 'opened.gif', type: 'file', parentId: null, content: PNG_BYTES, mimeType: 'image/gif', modified: 1 };
    const { content } = await loadGallery({
      fsNodes: [kept, trashed, opened],
      mediaItems: [{ id: 'kept' }, { id: 'trashed' }],
      state: { fileId: 'opened' }, // not in the store → pulled in via state
    });
    const labels = [...content.querySelectorAll('[role="button"][aria-label]')].map((c) => c.getAttribute('aria-label'));
    expect(labels).toContain('kept.png');
    expect(labels).toContain('opened.gif');
    expect(labels).not.toContain('trashed.png');
  });

  it('opens the requested file and removes its placeholder icon from the image card', async () => {
    const opened = { id: 'opened', name: 'opened.avif', type: 'file', parentId: null, content: PNG_BYTES, mimeType: 'image/avif', modified: 1 };
    const { content, window } = await loadGallery({ fsNodes: [opened], state: { fileId: opened.id } });
    window.document.body.appendChild(content);
    content.querySelector('button[title="Refresh"]').click();
    await settle();
    const card = content.querySelector('[role="button"][aria-label="opened.avif"]');

    expect(content.querySelector('[role="dialog"]').style.display).toBe('flex');
    expect(card.querySelector('img')).toBeTruthy();
    expect(card.querySelector('[data-image-placeholder]')).toBeNull();
    expect(card.querySelector('img').style.position).toBe('absolute');
  });

  it('opens the lightbox from a card, navigates with next/prev and closes on Escape', async () => {
    const a = { id: 'img-a', name: 'a.png', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/png', modified: 100 };
    const b = { id: 'img-b', name: 'b.jpg', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/jpeg', modified: 300 };
    const { content, window } = await loadGallery({ fsNodes: [a, b], mediaItems: [{ id: 'img-a' }, { id: 'img-b' }] });
    const lb = content.querySelector('[role="dialog"]');
    expect(lb.style.display).toBe('none');

    // Click the first card (b.jpg — newest first)
    content.querySelector('[role="button"][aria-label="b.jpg"]').click();
    await settle();
    expect(lb.style.display).toBe('flex');
    const caption = lb.lastElementChild;
    expect(caption.textContent).toBe('b.jpg  (1 / 2)');
    const [prev, next] = [lb.children[2], lb.children[3]];
    expect(prev.disabled).toBe(true);  // at start
    expect(next.disabled).toBe(false);

    next.click();
    await settle();
    expect(caption.textContent).toBe('a.png  (2 / 2)');
    expect(next.disabled).toBe(true); // at end

    // Keyboard navigation scoped to the app content
    content.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(caption.textContent).toBe('b.jpg  (1 / 2)');

    // Escape closes and clears the img src
    content.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(lb.style.display).toBe('none');
  });

  it('refreshes the grid when the Refresh button is clicked', async () => {
    const { content, window, FS } = await loadGallery();
    expect(content.querySelectorAll('[role="button"][aria-label]')).toHaveLength(0);
    FS.files.set('later', { id: 'later', name: 'later.png', type: 'file', parentId: 'desktop-id', content: PNG_BYTES, mimeType: 'image/png', modified: 1 });
    window.AstroOSMediaStore = makeMediaStore([{ id: 'later' }]);
    const refreshBtn = [...content.querySelectorAll('button')].find((b) => b.title === 'Refresh');
    refreshBtn.click();
    await settle();
    const cards = content.querySelectorAll('[role="button"][aria-label]');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('aria-label')).toBe('later.png');
  });
});
