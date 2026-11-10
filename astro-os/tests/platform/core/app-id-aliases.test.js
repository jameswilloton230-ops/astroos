import { describe, expect, it } from 'vitest';
import { resetTestStorage } from '../../setup.js';

require('../../../js/platform/core/app-id-aliases.js');

describe('built-in app ID migration', () => {
  it('resolves legacy package IDs and launcher slugs', () => {
    expect(window.NovaAppIdAliases.canonicalize('com.astroos.quill')).toBe('com.astroos.textedit');
    expect(window.NovaAppIdAliases.canonicalize('shell')).toBe('com.astroos.terminal');
    expect(window.NovaAppIdAliases.canonicalize('terminal')).toBe('com.astroos.terminal');
    expect(window.NovaAppIdAliases.canonicalize('com.astroos.vault')).toBe('com.astroos.files');
    expect(window.NovaAppIdAliases.canonicalize('com.example.app')).toBe('com.example.app');
  });

  it('migrates saved defaults, pins, desktop positions, boot apps, and disabled apps', () => {
    resetTestStorage();
    const data = {
      defaultApps: { texteditor: 'com.astroos.quill' },
      pinnedApps: ['com.astroos.shell', 'com.astroos.vault'],
      desktopIconPositions: {
        'app:com.astroos.quill': { col: 1, row: 2 },
        'com.astroos.vault': { col: 3, row: 4 },
      },
    };
    const settings = {
      get: key => data[key],
      set: (key, value) => { data[key] = value; },
    };
    localStorage.setItem('nova_boot_apps', JSON.stringify(['com.astroos.shell']));
    localStorage.setItem('nova_disabled_apps', JSON.stringify([{ id: 'com.astroos.quill' }]));

    expect(window.NovaAppIdAliases.migratePersistentReferences(settings, localStorage)).toBe(true);
    expect(data.defaultApps.texteditor).toBe('com.astroos.textedit');
    expect(data.pinnedApps).toEqual(['com.astroos.terminal', 'com.astroos.files']);
    expect(data.desktopIconPositions).toEqual({
      'app:com.astroos.textedit': { col: 1, row: 2 },
      'com.astroos.files': { col: 3, row: 4 },
    });
    expect(JSON.parse(localStorage.getItem('nova_boot_apps'))).toEqual(['com.astroos.terminal']);
    expect(JSON.parse(localStorage.getItem('nova_disabled_apps'))).toEqual([{ id: 'com.astroos.textedit' }]);
  });
});
