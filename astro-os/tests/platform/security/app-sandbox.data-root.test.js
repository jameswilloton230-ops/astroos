import { describe, it, expect, vi, afterEach } from 'vitest';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';

// The /data/<appId> app-data root: the segment after /data/ must be the
// app's REAL id (dots preserved, alias-canonicalized), it must stay inside
// /data no matter what the id contains, and ownership must hold both for
// logical /data/... paths and for the native Linux layout where the data
// root lives at ~/.local/share/novabyte/data instead of ~/data.

describe('AppSandbox /data app-data root', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFs({ nodes, paths, getByPath, writeFile, createFile }) {
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map(nodes || []),
      specialFolders: {},
      getPath: id => (typeof paths === 'function' ? paths(id) : paths.get(id)) || '/',
      getByPath: getByPath || (() => null),
      writeFile,
      createFile,
    });
    vi.stubGlobal('window', { NovaAppIdAliases: undefined });
  }

  const webview = () => {
    const responses = [];
    return { webview: { __directResponder: message => responses.push(message) }, responses };
  };

  it('writes app data under the app id with its dots preserved', async () => {
    const parent = { id: '/data/com.example.editor', name: 'com.example.editor', type: 'folder' };
    const created = { id: '/data/com.example.editor/notes.txt', name: 'notes.txt', type: 'file' };
    let requestedPath = null;
    stubFs({
      nodes: [[parent.id, parent]],
      paths: id => id,
      getByPath: path => {
        if (requestedPath === null) {
          requestedPath = path;
          return null; // file does not exist yet → create flow
        }
        return path === parent.id ? parent : null;
      },
      createFile: vi.fn(async () => created),
    });
    const { webview: wv, responses } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:write', { path: '/data/notes.txt', content: 'hello' }, 'dotted-write',
      { id: 'com.example.editor', name: 'Editor' }, wv, {}
    );

    expect(requestedPath).toBe('/data/com.example.editor/notes.txt');
    expect(responses[0].result).toMatchObject({ success: true, id: created.id });
  });

  it('canonicalizes aliased app ids before building the data segment', async () => {
    let requestedPath = null;
    stubFs({
      nodes: [],
      paths: id => id,
      getByPath: path => {
        if (requestedPath === null) {
          requestedPath = path;
          return null;
        }
        return null;
      },
      createFile: vi.fn(async () => ({ id: 'x', type: 'file' })),
    });
    vi.stubGlobal('window', {
      NovaAppIdAliases: { canonicalize: id => (id === 'com.astroos.quill' ? 'com.astroos.textedit' : id) },
    });
    const { webview: wv } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:write', { path: '/data/note.txt', content: 'x' }, 'alias-write',
      { id: 'com.astroos.quill', name: 'Quill' }, wv, {}
    );

    // The legacy quill id owns the canonical textedit subtree — the same
    // folder AppDirs bootstraps — not a separate quill folder.
    expect(requestedPath).toBe('/data/com.astroos.textedit/note.txt');
  });

  it('collapses unsafe app ids instead of letting them escape /data', async () => {
    const cases = [
      ['..', '/data/default/escape.txt'],
      ['../..', '/data/default/escape.txt'],
      ['.hidden', '/data/hidden/escape.txt'],
      ['a b/c', '/data/a_b_c/escape.txt'],
    ];
    for (const [appId, expected] of cases) {
      let requestedPath = null;
      stubFs({
        nodes: [],
        paths: id => id,
        getByPath: path => {
          if (requestedPath === null) {
            requestedPath = path;
            return null;
          }
          return null;
        },
        createFile: vi.fn(async () => ({ id: 'x', type: 'file' })),
      });
      const { webview: wv } = webview();

      await AppSandbox._internal.handleAPICall(
        'nova:fs:write', { path: '/data/escape.txt', content: 'x' }, 'unsafe-write',
        { id: appId, name: 'App' }, wv, {}
      );

      expect(requestedPath).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it('keeps ownership of dotted data folders without any fs grant', async () => {
    const ownFile = { id: 'own', name: 'note.txt', type: 'file', content: 'mine' };
    stubFs({
      nodes: [[ownFile.id, ownFile]],
      paths: id => id === ownFile.id ? '/data/com.example.editor/note.txt' : '/',
    });
    const { webview: wv, responses } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:read', { id: ownFile.id }, 'own-dotted-read',
      { id: 'com.example.editor', name: 'Editor' }, wv, {}
    );

    expect(responses[0].result.data).toBe('mine');
  });

  it('still refuses another app\'s dotted data folder', async () => {
    const foreign = { id: 'foreign', name: 'secret.txt', type: 'file', content: 'no' };
    stubFs({
      nodes: [[foreign.id, foreign]],
      paths: id => id === foreign.id ? '/data/com.example.other/secret.txt' : '/',
    });
    const { webview: wv, responses } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:read', { id: foreign.id }, 'foreign-dotted-read',
      { id: 'com.example.editor', name: 'Editor' }, wv, {}
    );

    expect(responses[0].error.code).toBe('NOT_FOUND');
  });

  it('maps the native Linux data root back to the logical /data form', async () => {
    // On Linux the data root is ~/.local/share/novabyte/data, NOT a
    // first-level child of home — ownership must still resolve.
    const dataRoot = '/home/astroos/.local/share/novabyte/data';
    const ownFile = { id: 'own', name: 'note.txt', type: 'file', content: 'native' };
    const foreign = { id: 'foreign', name: 'secret.txt', type: 'file', content: 'no' };
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([[ownFile.id, ownFile], [foreign.id, foreign]]),
      specialFolders: { data: dataRoot },
      getPath: id => id === ownFile.id
        ? `${dataRoot}/com.example.editor/note.txt`
        : id === foreign.id
          ? `${dataRoot}/com.example.other/secret.txt`
          : '/home/astroos',
    });
    const { webview: wv, responses } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:read', { id: ownFile.id }, 'native-own-read',
      { id: 'com.example.editor', name: 'Editor' }, wv, {}
    );
    await AppSandbox._internal.handleAPICall(
      'nova:fs:read', { id: foreign.id }, 'native-foreign-read',
      { id: 'com.example.editor', name: 'Editor' }, wv, {}
    );

    expect(responses[0].result.data).toBe('native');
    expect(responses[1].error.code).toBe('NOT_FOUND');
  });

  it('keeps underscore ids working exactly as before', async () => {
    const ownFile = { id: 'own', name: 'note.txt', type: 'file', content: 'legacy' };
    stubFs({
      nodes: [[ownFile.id, ownFile]],
      paths: id => id === ownFile.id ? '/data/editor_app/note.txt' : '/',
    });
    const { webview: wv, responses } = webview();

    await AppSandbox._internal.handleAPICall(
      'nova:fs:read', { id: ownFile.id }, 'underscore-read',
      { id: 'editor_app', name: 'Editor' }, wv, {}
    );

    expect(responses[0].result.data).toBe('legacy');
  });
});
