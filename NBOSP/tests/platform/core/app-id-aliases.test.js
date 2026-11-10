import { describe, expect, it } from 'vitest';
import { resetTestStorage } from '../../setup.js';

require('../../../js/platform/core/app-id-aliases.js');

describe('built-in app ID migration', () => {
  it('resolves legacy package IDs and launcher slugs', () => {
    expect(window.NovaAppIdAliases.canonicalize('com.nbosp.quill')).toBe('com.nbosp.textedit');
    expect(window.NovaAppIdAliases.canonicalize('shell')).toBe('com.nbosp.terminal');
    expect(window.NovaAppIdAliases.canonicalize('terminal')).toBe('com.nbosp.terminal');
    expect(window.NovaAppIdAliases.canonicalize('com.nbosp.vault')).toBe('com.nbosp.files');
    expect(window.NovaAppIdAliases.canonicalize('com.example.app')).toBe('com.example.app');
  });

  it('migrates saved defaults, pins, desktop positions, boot apps, and disabled apps', () => {
    resetTestStorage();
    const data = {
      defaultApps: { texteditor: 'com.nbosp.quill' },
      pinnedApps: ['com.nbosp.shell', 'com.nbosp.vault'],
      desktopIconPositions: {
        'app:com.nbosp.quill': { col: 1, row: 2 },
        'com.nbosp.vault': { col: 3, row: 4 },
      },
    };
    const settings = {
      get: key => data[key],
      set: (key, value) => { data[key] = value; },
    };
    localStorage.setItem('nova_boot_apps', JSON.stringify(['com.nbosp.shell']));
    localStorage.setItem('nova_disabled_apps', JSON.stringify([{ id: 'com.nbosp.quill' }]));

    expect(window.NovaAppIdAliases.migratePersistentReferences(settings, localStorage)).toBe(true);
    expect(data.defaultApps.texteditor).toBe('com.nbosp.textedit');
    expect(data.pinnedApps).toEqual(['com.nbosp.terminal', 'com.nbosp.files']);
    expect(data.desktopIconPositions).toEqual({
      'app:com.nbosp.textedit': { col: 1, row: 2 },
      'com.nbosp.files': { col: 3, row: 4 },
    });
    expect(JSON.parse(localStorage.getItem('nova_boot_apps'))).toEqual(['com.nbosp.terminal']);
    expect(JSON.parse(localStorage.getItem('nova_disabled_apps'))).toEqual([{ id: 'com.nbosp.textedit' }]);
  });
});
