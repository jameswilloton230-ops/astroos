import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const serviceSource = readFileSync(
  fileURLToPath(new URL('../../js/apps/default-apps/service.js', import.meta.url)),
  'utf8'
);

function loadDefaultApps({ apps = {}, defaults = {}, rejectWrites = false } = {}) {
  const settings = { ...defaults };
  const context = {
    OS: {
      apps,
      settings: {
        get: key => settings[key],
        set: (key, value) => {
          if (rejectWrites) return false;
          settings[key] = value;
          return true;
        },
      },
    },
    console: { warn() {}, error() {} },
    window: {},
  };
  runInNewContext(serviceSource, context);
  return { DefaultApps: context.window.DefaultApps, settings };
}

describe('DefaultApps', () => {
  it('normalizes file routes and validates choices against installed app capabilities', () => {
    const { DefaultApps, settings } = loadDefaultApps({
      apps: {
        'com.nbosp.browser': { name: 'Browser' },
        'com.test.web': {
          name: 'Web Handler',
          handles: { protocols: ['HTTPS:'], extensions: [' .HTML '], mimeTypes: ['text/html; charset=utf-8'] },
        },
      },
    });

    expect(DefaultApps.getCategoryFor({ protocol: 'HTTPS:' })).toBe('browser');
    expect(DefaultApps.getCategoryFor({ extension: '.HTML' })).toBe('browser');
    expect(DefaultApps.getCategoryFor({ mimeType: 'TEXT/HTML; charset=utf-8' })).toBe('browser');
    expect(DefaultApps.getCategoryFor(null)).toBeNull();
    expect(DefaultApps.getAppsForCategory('__proto__')).toEqual([]);
    expect(DefaultApps.setDefault('__proto__', 'com.test.web')).toBe(false);
    expect(DefaultApps.getAppsForCategory('browser').map(app => app.id)).toEqual([
      'com.nbosp.browser',
      'com.test.web',
    ]);
    expect(DefaultApps.setDefault('browser', 'com.test.web')).toBe(true);
    expect(settings.defaultApps.browser).toBe('com.test.web');
    expect(DefaultApps.resolveHandler({ protocol: 'https:' }, 'com.nbosp.browser')).toBe('com.test.web');
    expect(DefaultApps.resolveHandler({ protocol: 'http:' }, 'com.nbosp.browser')).toBe('com.nbosp.browser');
    expect(DefaultApps.setDefault('browser', 'com.test.not-installed')).toBe(false);
  });

  it('offers only apps that declare the Home role as Home app candidates', () => {
    const { DefaultApps } = loadDefaultApps({
      apps: {
        'com.nbosp.launcher': { name: 'NovaByte Launcher' },
        'com.test.home': { name: 'Home App', handles: { roles: ['home'] } },
        'com.test.unrelated': { name: 'Unrelated App', handles: { roles: ['home-screen'] } },
      },
    });

    expect(DefaultApps.getAppsForCategory('home').map(app => app.id)).toEqual([
      'com.nbosp.launcher',
      'com.test.home',
    ]);
    expect(DefaultApps.setDefault('home', 'com.test.home')).toBe(true);
    expect(DefaultApps.getDefault('home')).toBe('com.test.home');
    expect(DefaultApps.setDefault('home', 'com.test.unrelated')).toBe(false);
  });

  it('ignores stale persisted choices and resolves MIME types through installed candidates', () => {
    const { DefaultApps } = loadDefaultApps({
      apps: {
        'com.nbosp.gallery': { name: 'Gallery' },
        'com.test.image-viewer': { handles: { mimeTypes: ['image/heic'] } },
      },
      defaults: { defaultApps: { gallery: 'com.test.removed-viewer' } },
    });

    expect(DefaultApps.getDefault('gallery')).toBeNull();
    expect(DefaultApps.resolveHandler({ mimeType: 'IMAGE/HEIC; name=photo' }, 'com.nbosp.gallery')).toBe('com.nbosp.gallery');
    expect(DefaultApps.setDefault('gallery', 'com.test.image-viewer')).toBe(true);
    expect(DefaultApps.resolveHandler({ mimeType: 'image/heic' }, 'com.nbosp.gallery')).toBe('com.test.image-viewer');
    expect(DefaultApps.resolveHandler({ mimeType: 'image/jpeg' }, 'com.nbosp.gallery')).toBe('com.nbosp.gallery');
  });

  it('offers only apps matching the selected file and persists a file-specific default', () => {
    const { DefaultApps, settings } = loadDefaultApps({
      apps: {
        'com.nbosp.gallery': { name: 'Gallery' },
        'com.test.heic-viewer': { name: 'HEIC Viewer', handles: { extensions: ['.heic'], mimeTypes: ['image/heic'] } },
        'com.test.avif-viewer': { name: 'AVIF Viewer', handles: { extensions: ['.avif'], mimeTypes: ['image/avif'] } },
      },
    });
    const heicQuery = { extension: '.HEIC', mimeType: 'IMAGE/HEIC; charset=binary' };

    expect(DefaultApps.getAppsForFile(heicQuery).map(app => app.id)).toEqual([
      'com.nbosp.gallery',
      'com.test.heic-viewer',
    ]);
    expect(DefaultApps.getAppsForFile({ extension: '.avif', mimeType: 'image/avif' }).map(app => app.id))
      .toContain('com.test.avif-viewer');
    expect(DefaultApps.getAppsForFile({ extension: '.png', mimeType: 'image/png' }).map(app => app.id))
      .not.toContain('com.test.heic-viewer');
    expect(DefaultApps.setDefaultForFile(heicQuery, 'com.test.heic-viewer')).toBe(true);
    expect(settings.defaultApps['extension:.heic']).toBe('com.test.heic-viewer');
    expect(DefaultApps.resolveHandler(heicQuery, 'com.nbosp.gallery')).toBe('com.test.heic-viewer');
    expect(DefaultApps.setDefaultForFile(heicQuery, 'com.test.avif-viewer')).toBe(false);
  });

  it('clears explicit choices and reports persistence failures', () => {
    const { DefaultApps, settings } = loadDefaultApps({
      apps: { 'com.nbosp.browser': { name: 'Browser' } },
      defaults: { defaultApps: { browser: 'com.nbosp.browser', other: 'preserved' } },
    });

    expect(DefaultApps.setDefault('browser', null)).toBe(true);
    expect(settings.defaultApps).toEqual({ other: 'preserved' });

    const refusingService = loadDefaultApps({
      apps: { 'com.nbosp.browser': { name: 'Browser' } },
      rejectWrites: true,
    }).DefaultApps;
    expect(refusingService.setDefault('browser', 'com.nbosp.browser')).toBe(false);
    expect(refusingService.getDefault('browser')).toBeNull();
  });

  it('clears category and file defaults for one app while preserving other defaults', () => {
    const { DefaultApps, settings } = loadDefaultApps({
      apps: {
        'com.nbosp.browser': { name: 'Browser' },
        'com.nbosp.textedit': { name: 'TextEdit' },
        'com.test.web': {
          name: 'Web Handler',
          handles: { protocols: ['https'], extensions: ['.html'] },
        },
      },
      defaults: {
        defaultApps: {
          browser: 'com.test.web',
          'extension:.html': 'com.test.web',
          texteditor: 'com.nbosp.textedit',
        },
      },
    });

    expect(DefaultApps.clearDefaultsForApp('com.test.web')).toBe(true);
    expect(settings.defaultApps).toEqual({ texteditor: 'com.nbosp.textedit' });
    expect(DefaultApps.resolveHandler({ protocol: 'https:' }, 'com.nbosp.browser'))
      .toBe('com.nbosp.browser');
    expect(DefaultApps.clearDefaultsForApp('com.nbosp.browser')).toBe(true);
  });
});
