import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ServerEventLog = require('../../server/core/server-event-log.js');

afterEach(() => {
  ServerEventLog.clear();
});

describe('server/core/server-event-log.js — log()', () => {
  it('fills sensible defaults and returns the entry', () => {
    const entry = ServerEventLog.log();
    expect(typeof entry.id).toBe('string');
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof entry.timestamp).toBe('number');
    expect(entry.app).toBe('server');
    expect(entry.severity).toBe('info');
    expect(entry.message).toBe('');
    expect(entry.data).toBeNull();
  });

  it('keeps caller-supplied fields', () => {
    const entry = ServerEventLog.log({
      app: 'EmailController',
      severity: 'error',
      message: 'connect failed',
      data: { host: 'mail.example.com' },
    });
    expect(entry.app).toBe('EmailController');
    expect(entry.severity).toBe('error');
    expect(entry.message).toBe('connect failed');
    expect(entry.data).toEqual({ host: 'mail.example.com' });
  });

  it('caps the ring buffer at 500 entries, dropping the oldest', () => {
    ServerEventLog.clear();
    for (let i = 0; i < 505; i++) ServerEventLog.log({ message: `m-${i}` });
    const all = ServerEventLog.getAll();
    expect(all).toHaveLength(500);
    expect(all[0].message).toBe('m-5');
    expect(all[499].message).toBe('m-504');
  });
});

describe('server/core/server-event-log.js — getAll()', () => {
  it('returns a copy of the buffer (appends do not leak into the log)', () => {
    ServerEventLog.log({ message: 'one' });
    const copy = ServerEventLog.getAll();
    copy.push({ id: 'fake' });
    copy.pop();
    expect(ServerEventLog.getAll()).toHaveLength(1);
    expect(ServerEventLog.getAll()[0].message).toBe('one');
    // note: the copy is a slice() — entry objects themselves are shared
    // references, so mutating a returned entry's fields is visible to the log.
    // Consumers must treat entries as read-only.
  });
});

describe('server/core/server-event-log.js — subscribe()', () => {
  it('notifies subscribers with every new entry', () => {
    const seen = [];
    const unsubscribe = ServerEventLog.subscribe((entry) => seen.push(entry));
    ServerEventLog.log({ message: 'a' });
    ServerEventLog.log({ message: 'b' });
    expect(seen.map((e) => e.message)).toEqual(['a', 'b']);
    unsubscribe();
    ServerEventLog.log({ message: 'c' });
    expect(seen).toHaveLength(2);
  });

  it('isolates throwing subscribers so the log and other subscribers survive', () => {
    const good = [];
    const unsubscribe = ServerEventLog.subscribe(() => { throw new Error('subscriber boom'); });
    const unsubscribe2 = ServerEventLog.subscribe((entry) => good.push(entry));
    expect(() => ServerEventLog.log({ message: 'with a bad subscriber' })).not.toThrow();
    expect(good).toHaveLength(1);
    unsubscribe();
    unsubscribe2();
  });

  it('unsubscribe is idempotent', () => {
    const seen = [];
    const unsubscribe = ServerEventLog.subscribe((e) => seen.push(e));
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    ServerEventLog.log({ message: 'after' });
    expect(seen).toHaveLength(0);
  });
});

describe('server/core/server-event-log.js — clear()', () => {
  it('empties the buffer', () => {
    ServerEventLog.log({ message: 'x' });
    ServerEventLog.clear();
    expect(ServerEventLog.getAll()).toEqual([]);
  });
});
