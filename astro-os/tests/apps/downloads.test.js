// tests/apps/downloads.test.js — window app: Downloads manager UI over the
// Downloads History system service (getAll/remove/clearCompleted/subscribe).
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

// Builds a fake Downloads History system service with an in-memory store so
// the app's real subscribe/render/remove code paths run against live data.
function makeDownloadsService(initial = []) {
  const items = [...initial];
  const svc = {
    listeners: new Set(),
    getAll: () => [...items],
    // Mutations notify subscribers, exactly like the real Downloads History
    // service — the app re-renders only from the subscribe callback.
    remove: (id) => {
      const idx = items.findIndex((x) => String(x.id) === String(id));
      if (idx > -1) items.splice(idx, 1);
      svc.emit();
    },
    clearCompleted: () => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'done') items.splice(i, 1);
      }
      svc.emit();
    },
    subscribe: (cb) => {
      svc.listeners.add(cb);
      return () => svc.listeners.delete(cb);
    },
    emit: () => { for (const cb of [...svc.listeners]) cb(); },
  };
  return svc;
}

describe('Downloads app (js/apps/downloads)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('downloads');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.downloads');
    expect(app.name).toBe('Downloads');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Download Manager');
    expect(app.icon).toBe('download');
    expect(app.defaultSize).toEqual([580, 460]);
    expect(app.minSize).toEqual([400, 300]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('downloads', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.downloads');
    // The fallback path returns before any list UI is built.
    expect(content.querySelector('.dl-row')).toBeNull();
  });

  it('hard-fails at init when the Downloads History service is unavailable', async () => {
    const { app, window } = await loadWindowApp('downloads');
    // window.Downloads is not installed — the source throws a specific error.
    // Cross-realm (jsdom) error: match the message, not the class.
    expect(() => initApp(app, { window })).toThrow(/Downloads History system service is unavailable/);
  });

  it('renders the empty state and the toolbar with a Clear button', async () => {
    const { app, window } = await loadWindowApp('downloads');
    window.Downloads = makeDownloadsService([]);
    const content = initApp(app, { window });
    // Toolbar
    const toolbar = content.querySelector('[style*="border-bottom"]');
    expect(toolbar.textContent).toContain('Downloads');
    const buttons = [...content.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('Clear completed');
    // Empty state
    expect(content.querySelector('[role="list"]')).toBeTruthy();
    expect(content.textContent).toContain('No downloads yet');
    expect(content.textContent).toContain('Files saved from the browser appear here');
    expect(content.querySelector('.dl-row')).toBeNull();
  });

  it('renders one row per download with name, size, date, status badge and delete button', async () => {
    const ts = new Date('2024-03-01T12:00:00').getTime();
    const { app, window } = await loadWindowApp('downloads');
    window.Downloads = makeDownloadsService([
      { id: 'd1', name: 'report.pdf', size: 2048, status: 'done', ts, url: 'https://example.com/report.pdf' },
      { id: 'd2', name: 'installer.exe', size: 5 * 1024 * 1024, status: 'failed', ts },
      { id: 'd3', name: 'stream.bin', size: 512, status: 'downloading', ts },
    ]);
    const content = initApp(app, { window });
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows).toHaveLength(3);

    const [pdf, exe, bin] = rows;
    expect(pdf.textContent).toContain('report.pdf');
    expect(pdf.textContent).toContain('2.0 KB');
    expect(pdf.textContent).toContain('done');
    expect(pdf.title).toBe('https://example.com/report.pdf'); // URL capped into the row tooltip
    const del = pdf.querySelector('[data-del]');
    expect(del).toBeTruthy();
    expect(del.dataset.del).toBe('d1');
    expect(del.getAttribute('aria-label')).toBe('Remove report.pdf');

    expect(exe.textContent).toContain('5.0 MB');
    expect(exe.textContent).toContain('failed');
    expect(bin.textContent).toContain('512 B');
    expect(bin.textContent).toContain('downloading');
  });

  it('formats edge-case sizes and names: 0 bytes shows "0 B", missing name shows "(unnamed)"', async () => {
    const { app, window } = await loadWindowApp('downloads');
    // FIX #6 uses ?? so only null/undefined names get the fallback — an empty
    // string renders as an (empty) name. Test both shapes.
    window.Downloads = makeDownloadsService([
      { id: 'z0', name: null, size: 0, status: 'done' },
      { id: 'z1', name: '', size: 0, status: 'done' },
      { id: 'z2', name: 'no-size', status: 'done' }, // size undefined → '—'
    ]);
    const content = initApp(app, { window });
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows[0].textContent).toContain('(unnamed)'); // nullish → fallback
    expect(rows[0].textContent).toContain('0 B');        // FIX #3: 0 is a number
    expect(rows[0].textContent).toContain('done');
    expect(rows[1].textContent).not.toContain('(unnamed)'); // '' is not nullish — quirk
    expect(rows[2].textContent).toContain('no-size');
    expect(rows[2].textContent).toContain('—');          // non-number → placeholder
  });

  it('deletes a download via the row button and clears completed via the toolbar', async () => {
    const { app, window } = await loadWindowApp('downloads');
    const svc = makeDownloadsService([
      { id: 'keep-me', name: 'keep.txt', size: 10, status: 'downloading' },
      { id: 'gone-1', name: 'a.zip', size: 10, status: 'done' },
      { id: 'gone-2', name: 'b.zip', size: 10, status: 'done' },
    ]);
    window.Downloads = svc;
    const content = initApp(app, { window });

    // Click the delete button on row "gone-1" (event delegation on the list).
    const rowA = [...content.querySelectorAll('.dl-row')].find((r) => r.textContent.includes('a.zip'));
    rowA.querySelector('[data-del]').click();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(2);
    expect([...content.querySelectorAll('.dl-row')].some((r) => r.textContent.includes('a.zip'))).toBe(false);
    expect([...content.querySelectorAll('.dl-row')].some((r) => r.textContent.includes('keep.txt'))).toBe(true);

    // "Clear completed" removes every done item but keeps the active one.
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Clear completed');
    clearBtn.click();
    await settle();
    const remaining = [...content.querySelectorAll('.dl-row')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain('keep.txt');
    expect(remaining[0].textContent).toContain('downloading');
  });

  it('live-renders when the service notifies subscribers and unsubscribes on cleanup', async () => {
    const { app, window } = await loadWindowApp('downloads');
    const svc = makeDownloadsService([]);
    window.Downloads = svc;
    const state = { cleanups: [] };
    const content = initApp(app, { window, state });
    expect(content.textContent).toContain('No downloads yet');

    // External service change → subscribe callback → re-render.
    svc.getAll = () => [{ id: 'live', name: 'live-file.iso', size: 4096, status: 'downloading' }];
    svc.emit();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(1);
    expect(content.textContent).toContain('live-file.iso');

    // The subscription was registered as a window-manager cleanup.
    expect(state.cleanups.length).toBeGreaterThanOrEqual(1);
    const unsubscribe = state.cleanups[0];
    expect(typeof unsubscribe).toBe('function');
    unsubscribe(); // app window closed — listener removed
    expect(svc.listeners.size).toBe(0);
    // After unsubscribing the app no longer re-renders: the store is emptied
    // and the service emits, but the DOM keeps showing the stale last render.
    svc.getAll = () => [];
    svc.emit();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(1); // stale on purpose
    expect(content.textContent).toContain('live-file.iso');
  });
});
