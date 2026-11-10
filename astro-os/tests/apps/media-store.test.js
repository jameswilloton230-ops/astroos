import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(
  new URL('../../js/apps/media-store/service.js', import.meta.url),
  'utf8'
);

function createMediaStore() {
  const handlers = new Map();
  const nodes = [
    { id: '/', name: '/', type: 'folder', parentId: null },
    { id: '/Music', name: 'Music', type: 'folder', parentId: '/' },
    { id: '/Pictures', name: 'Pictures', type: 'folder', parentId: '/' },
    { id: '/.private', name: '.private', type: 'folder', parentId: '/' },
    { id: '/Trash', name: 'Trash', type: 'folder', parentId: '/' },
    { id: '/Music/song.mp3', name: 'song.mp3', type: 'file', parentId: '/Music', mimeType: 'audio/mpeg', size: 12, created: 1, modified: 3 },
    { id: '/Pictures/photo.png', name: 'photo.png', type: 'file', parentId: '/Pictures', mimeType: 'image/png', size: 20, created: 2, modified: 4 },
    { id: '/.private/secret.jpg', name: 'secret.jpg', type: 'file', parentId: '/.private', mimeType: 'image/jpeg', size: 8, created: 2, modified: 5 },
    { id: '/Trash/removed.png', name: 'removed.png', type: 'file', parentId: '/Trash', mimeType: 'image/png', size: 8, created: 2, modified: 5 },
  ];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const fs = {
    rootId: '/',
    specialFolders: { trash: '/Trash' },
    listDir: id => nodes.filter(node => node.parentId === id),
    getPath: id => id,
  };
  const window = {
    FS: fs,
    OS: {
      events: {
        on: (name, callback) => handlers.set(name, callback),
      },
    },
  };
  runInNewContext(serviceSource, { window, Date, Set, Map, Object, String, Number, TypeError });
  return { store: window.AstroOSMediaStore, handlers, nodes };
}

describe('AstroOS MediaStore', () => {
  it('indexes shared media metadata and filters by type, excluding hidden and trashed files', () => {
    const { store } = createMediaStore();
    expect(store.query({ type: 'image' })).toMatchObject([
      { id: '/Pictures/photo.png', type: 'image', path: 'media:/Pictures/photo.png' },
    ]);
    expect(store.query({ type: 'audio' })).toMatchObject([
      { id: '/Music/song.mp3', type: 'audio', path: 'media:/Music/song.mp3' },
    ]);
    expect(store.query({ type: 'all', limit: 1, offset: 1 })).toHaveLength(1);
    expect(() => store.query({ type: 'document' })).toThrow(/Media type/);
    expect(() => store.query({ limit: 0 })).toThrow(/limit/);
  });

  it('refreshes its metadata index when the filesystem changes', () => {
    const { store, handlers, nodes } = createMediaStore();
    expect(store.query({ type: 'image' })).toHaveLength(1);
    const newImage = {
      id: '/Pictures/new.webp',
      name: 'new.webp',
      type: 'file',
      parentId: '/Pictures',
      mimeType: 'image/webp',
      size: 30,
      created: 5,
      modified: 6,
    };
    nodes.push(newImage);
    handlers.get('fs:created')();
    expect(store.query({ type: 'image' })).toHaveLength(2);
  });

  it('returns home-relative media paths when the host filesystem uses absolute IDs', () => {
    const window = {
      FS: {
        rootId: '/home/astroos',
        specialFolders: {},
        listDir: id => id === '/home/astroos'
          ? [{ id: '/home/astroos/Music/song.mp3', name: 'song.mp3', type: 'file', mimeType: 'audio/mpeg' }]
          : [],
        getPath: id => id,
      },
      OS: { events: { on() {} } },
    };
    runInNewContext(serviceSource, { window, Date, Set, Map, Object, String, Number, TypeError });
    expect(window.AstroOSMediaStore.query({ type: 'audio' })[0].path)
      .toBe('media:/Music/song.mp3');
  });
});
