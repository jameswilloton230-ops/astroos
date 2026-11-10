// tests/apps/sysaccess.test.js — window app: dev gates, network tab probing
// (proxy reachability + SSRF guard) with run history/export, and the virtual
// filesystem tree with filtering, node inspection and the uninitialized-FS
// fallback.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const DEV_OS = { settings: { get: (key) => key === 'devMode' } };

function makeFsFixture() {
  const files = new Map([
    ['root', { id: 'root', name: '', type: 'folder', parentId: null }],
    ['docs', { id: 'docs', name: 'Docs', type: 'folder', parentId: 'root' }],
    ['f1', { id: 'f1', name: 'hello.txt', type: 'file', parentId: 'docs', size: 5, mimeType: 'text/plain', content: 'hello', created: 1700000000000, modified: 1700000000001 }],
    ['f2', { id: 'f2', name: 'blob.bin', type: 'file', parentId: 'docs', size: 1048576, content: { binary: true } }],
  ]);
  return {
    rootId: 'root',
    files,
    _childrenByParent: new Map([
      ['root', new Map([['docs', true]])],
      ['docs', new Map([['f1', true], ['f2', true]])],
    ]),
  };
}

async function loadSysaccess({ fetch: fetchStub, fs = makeFsFixture(), extra = {} } = {}) {
  const loaded = await loadWindowApp('sysaccess', {
    stubs: {
      ...(fetchStub ? { fetch: fetchStub } : {}),
      extra: { OS: DEV_OS, FS: fs, ...extra },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: { cleanups: [] } });
  // init auto-clicks the first (Network) tab, rendering it eagerly.
  return { ...loaded, content };
}

const tabBtn = (content, name) =>
  [...content.querySelectorAll('.sysaccess-tab')].find((b) => b.textContent === name);
const findBtn = (content, text) =>
  [...content.querySelectorAll('button')].find((b) => b.textContent === text);
const treeRow = (content, name) =>
  [...content.querySelectorAll('div')].find((d) =>
    d.style.cursor === 'pointer' && d.textContent.includes(name)); // file rows end with a size label

describe("'System Access' app (js/apps/sysaccess)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full dev-only app descriptor with the host', async () => {
    const { app } = await loadWindowApp('sysaccess');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.sysaccess');
    expect(app.name).toBe('System Access');
    expect(app.version).toBe('3.0.2');
    expect(app.category).toBe('developer');
    expect(app.devOnly).toBe(true);
    expect(app.defaultSize).toEqual([750, 600]);
    expect(app.minSize).toEqual([450, 400]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the developer-mode gate when dev mode is off', async () => {
    const { app, window } = await loadWindowApp('sysaccess', {
      stubs: { extra: { OS: { settings: { get: () => false } } } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use System Access.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('sysaccess', {
      stubs: { AppDirs: null, extra: { OS: DEV_OS } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
  });

  it('renders the Network tab eagerly with probe cards and default CORS row', async () => {
    const { content } = await loadSysaccess();
    expect([...content.querySelectorAll('.sysaccess-tab')].map((b) => b.textContent)).toEqual(['Network', 'FS']);
    expect(content.textContent).toContain('Click Run Test to probe endpoints.');
    expect(content.textContent).toContain('Proxy Configuration');
    expect(content.textContent).toContain('SSRF Guard Test');
    expect(content.textContent).toContain('Waiting for test…');
    expect(content.textContent).toContain('Run History');
    expect(content.textContent).toContain('No runs yet');
    // process.env.CORS_ORIGIN is absent in jsdom → documented default.
    expect(content.textContent).toContain('CORS_ORIGIN: ');
    expect(content.textContent).toContain('https://localhost:3006 (default)');
  });

  it('probes proxy routes and the SSRF guard, then records a run history row', async () => {
    const calls = [];
    const { content, window } = await loadSysaccess({
      fetch: async (url, opts = {}) => {
        calls.push([String(url), opts.method || 'GET']);
        if (String(url) === '/api/frame-check') return { status: 200 };
        if (String(url) === '/api/proxy') {
          // Reachability probe sends POST without a body; the SSRF test
          // posts a JSON body and the guard 403s private hosts.
          if (!opts.body) return { status: 400 };
          const body = JSON.parse(opts.body);
          return { status: body.url.startsWith('https://example.com') ? 200 : 403 };
        }
        return { status: 404 };
      },
    });

    findBtn(content, 'Run Test').click();
    await settle(40);

    expect(calls.some(([u, m]) => u === '/api/frame-check' && m === 'GET')).toBe(true);
    expect(calls.filter(([u]) => u === '/api/proxy').length).toBe(5); // 1 probe + 4 SSRF posts

    expect(content.textContent).toContain('reachable (200)');
    expect(content.textContent).toContain('BLOCKED');
    expect(content.textContent).toContain('ALLOWED (200)');
    expect(content.textContent).toContain('Test complete.');
    // 3 of the 4 SSRF targets are private → blocked; proxy both reachable.
    expect(content.textContent).toContain('proxy 2/2 · ssrf blocked 3/4');
    expect(findBtn(content, 'Run Test').disabled).toBe(false);
  });

  it('marks unreachable proxies as failures when fetch rejects', async () => {
    const { content } = await loadSysaccess({
      fetch: async () => { throw new Error('ECONNREFUSED'); },
    });
    findBtn(content, 'Run Test').click();
    await settle(40);
    expect(content.textContent).toContain('unreachable');
    expect(content.textContent).toContain('request failed');
    expect(content.textContent).toContain('proxy 0/2 · ssrf blocked 0/4');
  });

  it('exports the run history as a JSON download only after a run', async () => {
    const downloads = [];
    const loaded = await loadWindowApp('sysaccess', {
      stubs: { extra: { OS: DEV_OS, FS: makeFsFixture() } },
    });
    const win = loaded.window;
    if (typeof win.URL.createObjectURL !== 'function') {
      win.URL.createObjectURL = () => 'blob:mock/export';
      win.URL.revokeObjectURL = () => {};
    }
    win.HTMLAnchorElement.prototype.click = function () {
      downloads.push(this.getAttribute('download'));
    };
    const content = initApp(loaded.app, { window: win, state: { cleanups: [] } });

    // No run yet → export is a no-op.
    findBtn(content, 'Export Results').click();
    expect(downloads).toEqual([]);

    findBtn(content, 'Run Test').click();
    await settle(30);
    findBtn(content, 'Export Results').click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^nbosp-sysaccess-network-.*\.json$/);
  });

  it('renders the FS tree, expands folders and inspects file nodes', async () => {
    const { content } = await loadSysaccess();
    tabBtn(content, 'FS').click();

    expect(content.textContent).toContain('Virtual filesystem tree rooted at /');
    // Root starts expanded (expanded set seeded with FS.rootId), Docs collapsed.
    const docsRow = treeRow(content, 'Docs');
    expect(docsRow).toBeTruthy();
    expect(content.textContent).not.toContain('hello.txt');

    docsRow.click(); // expands Docs
    expect(treeRow(content, 'hello.txt')).toBeTruthy();

    treeRow(content, 'hello.txt').click(); // select → detail panel
    expect(content.textContent).toContain('namehello.txt');
    expect(content.textContent).toContain('typefile');
    expect(content.textContent).toContain('size5 b');
    expect(content.textContent).toContain('mimeTypetext/plain'); // label+value rows concatenate
    expect(content.textContent).toContain('Content');
    expect(content.textContent).toContain('hello');

    // Non-string content renders the defensive preview instead of crashing.
    treeRow(content, 'blob.bin').click();
    expect(content.textContent).toContain('(non-text content, typeof "object" — cannot preview)');
  });

  it('filters the tree by name, keeping ancestor folders visible', async () => {
    const { content, window } = await loadSysaccess();
    tabBtn(content, 'FS').click();
    treeRow(content, 'Docs').click(); // expand

    const filter = content.querySelector('input[placeholder="Filter by name…"]');
    filter.value = 'hello';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(content.textContent).toContain('hello.txt');
    expect(content.textContent).not.toContain('blob.bin');
    // Docs stays visible because a descendant matched (auto-expanded).
    expect(treeRow(content, 'Docs')).toBeTruthy();

    filter.value = 'nomatch';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(treeRow(content, 'Docs')).toBeFalsy();
    expect(treeRow(content, 'hello.txt')).toBeFalsy();
  });

  it('degrades to "FS not initialized" before the filesystem service is ready', async () => {
    const { content } = await loadSysaccess({ fs: { files: new Map() } });
    tabBtn(content, 'FS').click();
    expect(content.textContent).toContain('FS not initialized');
  });
});
