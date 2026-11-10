// tests/apps/search.test.js — window app: system-wide search over files,
// contacts, downloads and DuckDuckGo web results, with debounce, caching and
// clear behaviour. Uses the REAL js/apps/search-index/service.js trigram index.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const APPDIRS_OK = { getAppDataPath: (id, kind) => `/data/${id}/${kind ?? 'files'}` };

function makeFsStub(files) {
  return {
    rootId: 'root',
    specialFolders: { data: 'data' },
    files: new Map(files.map((f) => [f.id, f])),
    listDir: () => [],
    getPath: (id) => '/Docs/' + (files.find((f) => f.id === id)?.name || ''),
  };
}

function makeDownloads(items) {
  return {
    getAll: () => items.slice(),
    subscribe: (cb) => () => {},
  };
}

function makeOsStub() {
  return { events: { on() {}, off() {} } };
}

function makeWmSpy() {
  const calls = [];
  return { calls, createWindow: (appId, opts) => calls.push([appId, opts]) };
}

async function loadSearch({ files = [], contacts = [], downloads = [], fetch: fetchStub, skipServices = false, noInit = false } = {}) {
  const scripts = skipServices ? ['app.js'] : ['../search-index/service.js', 'app.js'];
  const wm = makeWmSpy();
  const loaded = await loadWindowApp('search', {
    scripts,
    stubs: {
      ...(fetchStub ? { fetch: fetchStub } : {}),
      extra: {
        AppDirs: APPDIRS_OK,
        OS: makeOsStub(),
        FS: makeFsStub(files),
        Downloads: makeDownloads(downloads),
        WM: wm,
        ...(skipServices ? { SearchIndex: undefined } : {}),
      },
    },
  });
  // The contacts cache is read from localStorage at search time.
  loaded.window.localStorage.setItem('nova_contacts', JSON.stringify(contacts));
  if (noInit) return { ...loaded, wm };
  const content = initApp(loaded.app, { window: loaded.window, state: {} });
  return { ...loaded, content, wm };
}

const type = (window, input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

const sectionByName = (content, title) =>
  [...content.querySelectorAll('div')].find((d) =>
    d.children.length && d.children[0].textContent === title); // header text is set verbatim (uppercase is CSS-only)

describe("'Search' app (js/apps/search)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('search');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.search');
    expect(app.name).toBe('Search');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('System Search');
    expect(app.icon).toBe('search');
    expect(app.defaultSize).toEqual([640, 500]);
    expect(app.minSize).toEqual([420, 300]);
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('search', { stubs: { AppDirs: null } });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.astroos.search');
  });

  it('throws the documented service-unavailable error when SearchIndex is missing', async () => {
    const { app, window } = await loadSearch({ skipServices: true, noInit: true });
    // The guard runs before any DOM is built.
    expect(() => initApp(app, { window, state: {} }))
      .toThrow(/Search Index or Downloads History system service is unavailable/);
  });

  it('renders the search bar and the idle hint', async () => {
    const { content, window } = await loadSearch();
    const input = content.querySelector('input[placeholder="Search files, contacts, downloads…"]');
    expect(input).toBeTruthy();
    expect(input.getAttribute('aria-label')).toBe('Search');
    expect(content.querySelector('#astroos-search-results').getAttribute('aria-live')).toBe('polite');
    expect(content.textContent).toContain('Type to search');
    // Clear button hidden until there is a query.
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Clear search');
    expect(clearBtn.style.display).toBe('none');
  });

  it('finds files from the FS trigram index and opens them via WM', async () => {
    const { content, window, wm } = await loadSearch({
      files: [
        { id: 'f1', name: 'notes.txt', type: 'file', mimeType: 'text/plain' },
        { id: 'f2', name: 'photo.png', type: 'file', mimeType: 'image/png' },
      ],
    });
    const input = content.querySelector('input[placeholder="Search files, contacts, downloads…"]');
    type(window, input, 'notes');
    await settle(200); // 80ms debounce + async web fetch

    const filesSection = sectionByName(content, 'Files');
    expect(filesSection).toBeTruthy();
    const row = [...filesSection.querySelectorAll('[data-result-row]')]
      .find((r) => r.textContent.includes('notes.txt'));
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('/Docs/notes.txt');

    row.click();
    expect(wm.calls).toContainEqual(['com.astroos.textedit', { fileId: 'f1' }]);

    // The clear affordance appears once a query is typed.
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Clear search');
    expect(clearBtn.style.display).toBe('');
  });

  it('searches contacts from localStorage and downloads from the history service', async () => {
    const { content, window, wm } = await loadSearch({
      contacts: [{ id: 'c1', name: 'Ada Lovelace', email: 'ada@calc.dev' }],
      downloads: [{ id: 'd1', name: 'installer.novaapp', url: 'https://example.com/installer.novaapp' }],
    });
    const input = content.querySelector('input[placeholder="Search files, contacts, downloads…"]');

    type(window, input, 'ada');
    await settle(200);
    const contactsSection = sectionByName(content, 'Contacts');
    expect(contactsSection).toBeTruthy();
    const contactRow = contactsSection.querySelector('[data-result-row]');
    expect(contactRow.textContent).toContain('Ada Lovelace');
    expect(contactRow.textContent).toContain('ada@calc.dev');
    contactRow.click();
    expect(wm.calls).toContainEqual(['com.astroos.contacts', { contactId: 'c1' }]);

    type(window, input, 'installer');
    await settle(200);
    const dlSection = sectionByName(content, 'Downloads');
    expect(dlSection).toBeTruthy();
    const dlRow = dlSection.querySelector('[data-result-row]');
    expect(dlRow.textContent).toContain('installer.novaapp');
    dlRow.click();
    expect(wm.calls).toContainEqual(['com.astroos.downloads', { itemId: 'd1' }]);
  });

  it('fetches web results, caches them per query, and falls back when offline', async () => {
    let ddgCalls = 0;
    const { content, window } = await loadSearch({
      fetch: async (url) => {
        const u = String(url);
        if (u.startsWith('https://api.duckduckgo.com/') && u.includes('q=novabyte')) {
          ddgCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              AbstractText: 'AstroOS is a desktop OS.',
              Heading: 'AstroOS',
              AbstractURL: 'https://novabyte.example/os',
              RelatedTopics: [{ Text: 'AstroOS Docs - official documentation', FirstURL: 'https://docs.example' }],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    const input = content.querySelector('input[placeholder="Search files, contacts, downloads…"]');

    type(window, input, 'novabyte');
    await settle(250);

    const webSection = sectionByName(content, 'Web');
    expect(webSection).toBeTruthy();
    expect(webSection.textContent).toContain('AstroOS');
    expect(webSection.textContent).toContain('AstroOS Docs');
    // Prefetch on input + cache hit for the debounced search → exactly one HTTP call.
    expect(ddgCalls).toBe(1);

    // Clearing the input goes back to the idle hint.
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Clear search');
    clearBtn.click();
    await settle(150);
    expect(input.value).toBe('');
    expect(content.textContent).toContain('Type to search');

    // Offline query → Brave fallback row and an explicit no-results note.
    type(window, input, 'zzz');
    await settle(250);
    expect(content.textContent).toContain('No results for "zzz"');
    const fallback = [...content.querySelectorAll('[data-result-row]')]
      .find((r) => r.textContent.includes('Search Brave for "zzz"'));
    expect(fallback).toBeTruthy();
    fallback.click();
    expect(String(window.WM.calls.at(-1)?.[1]?.url)).toContain('https://search.brave.com/search?');
  });

  it('shows the empty-state message for queries with no local or web hits', async () => {
    const { content, window } = await loadSearch();
    const input = content.querySelector('input[placeholder="Search files, contacts, downloads…"]');
    type(window, input, 'qqqq');
    await settle(200);
    expect(content.textContent).toContain('No results for "qqqq"');
  });
});
