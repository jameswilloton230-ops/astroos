// tests/apps/search-index.test.js — service app: trigram search + storage watching.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

describe('SearchIndex service (js/apps/search-index)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen SearchIndex with build/search/collectFiles/watchStorage', async () => {
    const { window } = await loadServiceApp('search-index');
    const svc = window.SearchIndex;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    for (const m of ['build', 'search', 'collectFiles', 'watchStorage']) expect(typeof svc[m]).toBe('function');
  });

  it('build() indexes trigrams from one or several key selectors and validates input', async () => {
    const { window } = await loadServiceApp('search-index');
    const docs = [
      { id: 1, name: 'Meeting Notes.txt', tag: 'work' },
      { id: 2, name: 'Holiday Photo.png', tag: 'personal' },
    ];
    const built = window.SearchIndex.build(docs, (d) => d.name);
    expect(Array.isArray(built.items)).toBe(true);
    // Cross-realm Map — assert structurally rather than via `instanceof Map`.
    expect(typeof built.index.get).toBe('function');
    expect(built.index.size).toBeGreaterThan(0);
    expect(built.index.get('mee').has(docs[0])).toBe(true);

    const multi = window.SearchIndex.build(docs, (d) => [d.name, d.tag]);
    expect(multi.index.get('per').has(docs[1])).toBe(true); // from the tag selector

    expect(() => window.SearchIndex.build('nope', (x) => x)).toThrow(/must be an array/);
    expect(() => window.SearchIndex.build(docs, 'not-a-function')).toThrow(/key selector/);
  });

  it('search() verifies candidates; short queries fall back to a linear filter', async () => {
    const { window } = await loadServiceApp('search-index');
    const docs = [
      { id: 1, name: 'Meeting Notes.txt' },
      { id: 2, name: 'Holiday Photo.png' },
      { id: 3, name: 'budget-2024.xlsx' },
    ];
    const built = window.SearchIndex.build(docs, (d) => d.name);
    const contains = (item, q) => item.name.toLowerCase().includes(q);

    expect(window.SearchIndex.search(built, 'notes', contains)).toEqual([docs[0]]);
    expect(window.SearchIndex.search(built, 'PHOTO', contains)).toEqual([docs[1]]); // lowercased
    expect(window.SearchIndex.search(built, 'zzz', contains)).toEqual([]); // trigram absent -> no results
    expect(window.SearchIndex.search(built, '', contains)).toEqual([]); // empty query
    expect(window.SearchIndex.search(built, 'ph', contains)).toEqual([docs[1]]); // <3 chars -> linear filter

    expect(() => window.SearchIndex.search(null, 'x', contains)).toThrow(/Search index is invalid/);
    expect(() => window.SearchIndex.search(built, 'notes', 'nope')).toThrow(/verifier/);
  });

  it('collectFiles() walks root + data folder, dedupes ids, skips dot-folders', async () => {
    const { window } = await loadServiceApp('search-index');
    const file = (id, name) => ({ id, name, type: 'file' });
    const folder = (id, name) => ({ id, name, type: 'folder' });
    const fs = {
      rootId: 'root',
      specialFolders: { data: 'data-folder' },
      files: new Map(),
      listDir(id) {
        if (id === 'root') return [folder('docs', 'Docs'), file('f1', 'readme.txt'), folder('.git', '.git')];
        if (id === 'docs') return [file('f2', 'deep.md')];
        if (id === 'data-folder') return [file('f1', 'readme.txt'), file('f3', 'data.json')];
        if (id === '.git') return [file('f4', 'config')];
        return [];
      },
    };
    const files = window.SearchIndex.collectFiles(fs);
    expect(files.map((f) => f.id).sort()).toEqual(['f1', 'f2', 'f3']); // f4 hidden, f1 deduped
  });

  it('collectFiles() falls back to fs.files when traversal finds nothing, and guards bad input', async () => {
    const { window } = await loadServiceApp('search-index');
    const fallbackFiles = [
      { id: 'a', name: 'one.txt', type: 'file' },
      { id: 'b', name: 'two.txt', type: 'file' },
    ];
    const fs = {
      rootId: 'root',
      specialFolders: {},
      files: new Map(fallbackFiles.map((f) => [f.id, f])),
      listDir: () => [],
    };
    expect(window.SearchIndex.collectFiles(fs)).toEqual(fallbackFiles);

    expect(window.SearchIndex.collectFiles(null)).toEqual([]);
    expect(window.SearchIndex.collectFiles({})).toEqual([]);
    expect(window.SearchIndex.collectFiles({ files: new Map() })).toEqual([]); // no listDir
  });

  it('watchStorage() reacts to storage events (incl. clear with null key) and validates args', async () => {
    const { window } = await loadServiceApp('search-index');
    const seen = [];
    window.SearchIndex.watchStorage(['evt-key'], (key) => seen.push(key));

    window.dispatchEvent(new window.StorageEvent('storage', { key: 'evt-key' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'other' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: null })); // clear-all event
    expect(seen).toEqual(['evt-key', null]);

    // Cross-realm (jsdom) TypeError — match the message, not the class.
    expect(() => window.SearchIndex.watchStorage('not-an-array', () => {})).toThrow(/requires keys and a listener/);
    expect(() => window.SearchIndex.watchStorage(['k'], 'not-a-function')).toThrow(/requires keys and a listener/);
  });
});
