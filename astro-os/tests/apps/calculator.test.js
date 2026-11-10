import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const appUrl = new URL('../../js/apps/calculator/app.js', import.meta.url);
const manifestUrl = new URL('../../js/apps/calculator/manifest.json', import.meta.url);
const htmlUrl = new URL('../../js/apps/calculator/index.html', import.meta.url);

describe('Calculator sandbox entry', () => {
  it('runs without host globals and handles calculations', async () => {
    const [source, html] = await Promise.all([
      readFile(appUrl, 'utf8'),
      readFile(htmlUrl, 'utf8'),
    ]);
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });

    try {
      expect(dom.window.OS).toBeUndefined();
      expect(dom.window.AppDirs).toBeUndefined();
      expect(dom.window.createEl).toBeUndefined();
      dom.window.eval(source);

      for (const key of ['7', '+', '3', '=']) {
        dom.window.document.querySelector(`[data-key="${key}"]`).click();
      }

      expect(dom.window.document.querySelector('#calculator-display').value).toBe('10');
    } finally {
      dom.window.close();
    }
  });

  it('declares a sandboxed HTML entry instead of a host execution entry', async () => {
    const [manifestText, html] = await Promise.all([
      readFile(manifestUrl, 'utf8'),
      readFile(htmlUrl, 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText);

    expect(manifest.entry).toBe('index.html');
    expect(manifest).not.toHaveProperty('unrestrictedEntry');
    expect(html).toContain('<script src="app.js"></script>');
    // AstroOS Lineage Material Dark tokens
    expect(html).toContain('--bg-base: #0f0f0f');
    expect(html).toContain('--bg-elevated: #1a1a1a');
    expect(html).toContain('--bg-overlay: #222222');
    expect(html).toContain('--accent: #4dd0e1');
  });
});
