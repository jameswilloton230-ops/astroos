// The Users admin console renders a Role chip per account. createEl has no
// `html` option, so the chip used to come out empty; this pins the rendered
// text, and that markup in a server-supplied field stays inert text.
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const read = rel => readFile(new URL(rel, import.meta.url), 'utf8');

async function mountUsersApp(users, { events = [], save = vi.fn(async () => null), writeFile = vi.fn() } = {}) {
  const [baseUtils, appSource] = await Promise.all([
    read('../../js/core/utils/base-utils.js'),
    read('../../js/apps/users/app.js'),
  ]);
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only' });
  const { window } = dom;

  let config;
  window.registerApp = cfg => { config = cfg; };
  window.NovaUserScope = { enabled: () => true };
  window.SystemDialogs = { save };
  window.require = name => {
    if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
    return { promises: { writeFile } };
  };
  window.SessionManager = {
    isAdmin: () => true,
    authFetch: async path => ({
      status: 200,
      json: {
        success: true,
        data: path.endsWith('/usage') ? { usage: [] }
          : path.includes('/events') ? { events }
            : { users },
      },
    }),
  };

  window.eval(baseUtils);
  window.eval(appSource);
  const host = window.document.getElementById('host');
  await config.init(host, { cleanups: [] }, {});
  return { window, host, save, writeFile };
}

describe('Users app account table', () => {
  it('shows each account\'s role and status as text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
      { uid: 'u2', username: 'sam', displayName: 'Sam', role: 'standard', roleLabel: 'Standard', status: 'disabled', locked: true },
    ]);
    try {
      expect(host.style.background).toBe('var(--bg-base)');
      expect(host.style.color).toBe('var(--text-primary)');
      expect(host.querySelector('style').textContent).toContain('.nbusers-event.warn { border-left-color:var(--text-warning); }');
      const rows = [...host.querySelectorAll('.nbusers-table tbody tr')];
      expect(rows).toHaveLength(2);

      const addButton = host.querySelector('.nbusers-add-btn');
      expect(addButton.getAttribute('aria-label')).toBe('Add account');
      expect(addButton.querySelector('svg path').getAttribute('d')).toBe('M12 5v14M5 12h14');

      const chips = row => [...row.querySelectorAll('.nbusers-chip')].map(chip => chip.textContent);
      expect(chips(rows[0])).toEqual(['Owner', 'active']);
      expect(chips(rows[1])).toEqual(['Standard', 'disabled', 'locked']);
      expect(rows[0].querySelector('.nbusers-chip.owner')).not.toBeNull();
      expect(rows.map(row => row.cells[0].style.display)).toEqual(['', '']);
      expect(rows.every(row => row.querySelector('.nbusers-account-info'))).toBe(true);
      expect(host.querySelector('style').textContent).toContain('.nbusers-account-info { display:flex;align-items:center;gap:10px; }');
    } finally {
      window.close();
    }
  });

  it('renders markup in a display field as plain text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'admin', roleLabel: '<img src=x onerror=alert(1)>', status: 'active' },
    ]);
    try {
      expect(host.querySelector('.nbusers-table img')).toBeNull();
      expect(host.querySelector('.nbusers-chip.admin').textContent).toBe('<img src=x onerror=alert(1)>');
    } finally {
      window.close();
    }
  });

  it('exports audit CSV through SystemDialogs and writes to the selected path', async () => {
    const save = vi.fn(async () => ({ path: '/home/sam/novabyte-account-events.csv' }));
    const writeFile = vi.fn(async () => {});
    const { window, host } = await mountUsersApp([], {
      events: [{
        ts: '2025-01-02T03:04:05.000Z',
        actor: 'sam',
        action: 'login',
        target: 'account',
        severity: 'info',
        ip: '127.0.0.1',
      }],
      save,
      writeFile,
    });
    try {
      host.querySelector('.nbusers-tab:nth-child(3)').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      host.querySelector('.nbusers-btn').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(save).toHaveBeenCalledWith({
        title: 'Export account events',
        suggestedName: 'novabyte-account-events.csv',
      });
      expect(writeFile).toHaveBeenCalledWith(
        '/home/sam/novabyte-account-events.csv',
        'ts,actor,action,target,severity,ip\n2025-01-02T03:04:05.000Z,sam,login,account,info,127.0.0.1',
        'utf8',
      );
      expect(host.querySelector('a[download]')).toBeNull();
    } finally {
      window.close();
    }
  });
});
