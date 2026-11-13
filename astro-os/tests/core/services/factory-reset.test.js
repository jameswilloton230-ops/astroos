import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { clearDirectoryContents, isAstroosLinuxRuntime } = await import(
  '../../../js/core/services/factory-reset.js'
);

describe('factory reset', () => {
  let tempDirectory;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('removes all user-home entries without removing the home directory', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'astroos-reset-'));
    await mkdir(join(tempDirectory, 'documents'));
    await writeFile(join(tempDirectory, 'documents', 'notes.txt'), 'private');
    await writeFile(join(tempDirectory, '.profile'), 'settings');

    await clearDirectoryContents(tempDirectory, tempDirectory);

    expect(await readdir(tempDirectory)).toEqual([]);
    expect((await stat(tempDirectory)).isDirectory()).toBe(true);
  });

  it('refuses to clear a target outside the approved reset path', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'astroos-reset-'));
    await writeFile(join(tempDirectory, 'keep.txt'), 'keep');

    await expect(clearDirectoryContents(tempDirectory, join(tempDirectory, 'other')))
      .rejects.toThrow('outside the approved reset scope');
    await expect(readFile(join(tempDirectory, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('only identifies the installed AstroOS Linux runtime from its explicit home and data path', () => {
    expect(isAstroosLinuxRuntime({
      platform: 'linux',
      home: '/home/astroos',
      dataDirectory: '/home/astroos/.config/novabyte/runtime',
    })).toBe(true);
    expect(isAstroosLinuxRuntime({
      platform: 'linux',
      home: '/home/other',
      dataDirectory: '/home/other/.config/novabyte/runtime',
    })).toBe(false);
  });
});
