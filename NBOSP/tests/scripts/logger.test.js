import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createLogStream, createConout, makeTee } = require('../../scripts/logger.js');

const tempDirs = [];
const envRestore = { ...process.env };

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env.NBOSP_DATA_DIR = envRestore.NBOSP_DATA_DIR;
  delete process.env.NW_SHOW_CONSOLE;
  vi.restoreAllMocks();
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-logger-'));
  tempDirs.push(dir);
  return dir;
}

describe('scripts/logger.js — createLogStream', () => {
  it('opens server.log in append mode inside the app dir', async () => {
    const dir = tmp();
    const stream = createLogStream(dir);
    await new Promise((resolve, reject) => {
      stream.write('first line\n', resolve);
      stream.on('error', reject);
    });
    stream.end();
    const content = fs.readFileSync(path.join(dir, 'server.log'), 'utf8');
    expect(content).toBe('first line\n');
  });

  it('honours NBOSP_DATA_DIR over the app dir (runtime data relocation)', async () => {
    const appDir = tmp();
    const dataDir = tmp();
    process.env.NBOSP_DATA_DIR = dataDir;
    const stream = createLogStream(appDir);
    await new Promise((resolve) => stream.write('x', resolve));
    stream.end();
    expect(fs.existsSync(path.join(dataDir, 'server.log'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'server.log'))).toBe(false);
  });

  it('surfaces stream errors through console instead of crashing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = tmp();
    const stream = createLogStream(dir);
    stream.emit('error', new Error('disk gone'));
    expect(err).toHaveBeenCalled();
    stream.end();
  });
});

describe('scripts/logger.js — createConout', () => {
  it('returns null on non-Windows platforms', () => {
    expect(process.platform).not.toBe('win32');
    expect(createConout()).toBeNull();
  });

  it('opens CONOUT$ lazily on a faked win32 host and swallows its async errors', async () => {
    const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.NW_SHOW_CONSOLE = 'true';
    // on Linux the CONOUT$ path is just a RELATIVE filename, resolved against
    // the cwd at open time — and fs.createWriteStream opens asynchronously.
    // Stay in a throwaway cwd until the open attempt has fully settled so the
    // lazy open cannot litter the repo root with a literal '\.\\CONOUT$' file.
    const cwd = process.cwd();
    const scratch = tmp();
    process.chdir(scratch);
    try {
      const conout = createConout();
      expect(conout).not.toBeNull();
      expect(conout.fd).toBeNull();
      expect(() => conout.emit('error', new Error('cannot open conout'))).not.toThrow();
      conout.destroy();
      // let the deferred open fire (and fail) while still inside scratch
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.chdir(cwd);
      Object.defineProperty(process, 'platform', origDescriptor);
    }
  });

  it('returns null on Windows without NW_SHOW_CONSOLE=true', () => {
    const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(createConout()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', origDescriptor);
    }
  });
});

describe('scripts/logger.js — makeTee', () => {
  function fakeStream(writable = true) {
    return { writable, write: vi.fn(), on: vi.fn() };
  }

  it('writes to both the log stream and stdout when no conout exists', () => {
    const logStream = fakeStream();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const tee = makeTee(logStream, null);
    tee('hello\n');
    expect(logStream.write).toHaveBeenCalledWith('hello\n');
    expect(stdout).toHaveBeenCalledWith('hello\n');
  });

  it('routes error chunks to stderr when conout is missing', () => {
    const logStream = fakeStream();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const tee = makeTee(logStream, null);
    tee('oops\n', true);
    expect(stderr).toHaveBeenCalledWith('oops\n');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('prefers the conout stream over stdout when provided', () => {
    const logStream = fakeStream();
    const conout = fakeStream();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const tee = makeTee(logStream, conout);
    tee('both\n');
    expect(conout.write).toHaveBeenCalledWith('both\n');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('falls back to stdout after the conout stream errors out', () => {
    const logStream = fakeStream();
    const conout = fakeStream();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const tee = makeTee(logStream, conout);
    // simulate conout dying: capture its error handler and fire it
    const errorHandler = conout.on.mock.calls.find(([ev]) => ev === 'error')?.[1];
    expect(errorHandler).toBeTypeOf('function');
    errorHandler(new Error('conout closed'));
    tee('after death\n');
    expect(stdout).toHaveBeenCalledWith('after death\n');
    expect(conout.write).not.toHaveBeenCalledWith('after death\n');
  });

  it('never throws when the log stream is not writable', () => {
    const logStream = fakeStream(false);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const tee = makeTee(logStream, null);
    expect(() => tee('safe\n')).not.toThrow();
    expect(logStream.write).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith('safe\n');
  });
});
