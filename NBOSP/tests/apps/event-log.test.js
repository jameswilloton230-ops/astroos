// tests/apps/event-log.test.js — service app: structured event store + console capture.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

describe('EventLog service (js/apps/event-log)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches EventLog to window with the documented surface (not frozen)', async () => {
    const { window } = await loadServiceApp('event-log');
    const svc = window.EventLog;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['log', 'ingestRemote', 'getAll', 'clear', 'subscribe', 'patchConsole', 'loadPersisted', 'persist', 'getCategories']) {
      expect(typeof svc[m]).toBe('function');
    }
    expect(svc._maxEntries).toBe(500);
  });

  it('log() builds a structured entry with defaults and persists it', async () => {
    const { window } = await loadServiceApp('event-log');
    const entry = window.EventLog.log({ app: 'AppPermissionManager', category: 'permissions', message: 'Denied fs:write' });
    expect(entry.app).toBe('AppPermissionManager');
    expect(entry.category).toBe('permissions');
    expect(entry.severity).toBe('info'); // default
    expect(entry.data).toBe(null); // default
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(window.EventLog.getAll()[0]).toEqual(entry);
    // persisted to localStorage (newest first)
    const saved = JSON.parse(window.localStorage.getItem('novaOS_eventlog'));
    expect(saved[0].message).toBe('Denied fs:write');
  });

  it('ingestRemote() forces category "server" no matter what the sender passed', async () => {
    const { window } = await loadServiceApp('event-log');
    const entry = window.EventLog.ingestRemote({ app: 'security-routes', category: 'should-be-overridden', message: 'Login ok', severity: 'warn' });
    expect(entry.category).toBe('server');
    expect(entry.severity).toBe('warn');
  });

  it('captures console.log/warn/error at eval time, attributing [Tag] prefixes', async () => {
    const { window } = await loadServiceApp('event-log');
    window.EventLog.clear();
    window.console.log('[MyApp] started', { pid: 7 });
    window.console.warn('[OtherApp] disk almost full');
    window.console.error('plain failure');
    const all = window.EventLog.getAll();
    expect(all.length).toBe(3); // newest first
    expect(all[2]).toMatchObject({ app: 'MyApp', severity: 'info', message: 'started {"pid":7}' });
    expect(all[1]).toMatchObject({ app: 'OtherApp', severity: 'warn', message: 'disk almost full' });
    expect(all[0]).toMatchObject({ app: 'system', severity: 'error', message: 'plain failure' });
  });

  it('console capture is idempotent and skips empty messages', async () => {
    const { window } = await loadServiceApp('event-log');
    window.EventLog.clear();
    window.EventLog.patchConsole(); // second call must be a no-op (no double entries)
    window.console.log('[A] once only');
    window.console.log('   '); // whitespace-only -> dropped
    window.console.log('[Tag]'); // tag with no body -> dropped
    const all = window.EventLog.getAll();
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ app: 'A', message: 'once only' });
  });

  it('subscribe() listeners receive entries; a throwing subscriber never breaks others', async () => {
    const { window } = await loadServiceApp('event-log');
    const seen = [];
    const bad = () => { throw new Error('bad subscriber'); };
    const unsubBad = window.EventLog.subscribe(bad);
    window.EventLog.subscribe((e) => seen.push(e.message));
    window.EventLog.log({ message: 'first' });
    expect(seen).toEqual(['first']);
    unsubBad();
    window.EventLog.log({ message: 'second' });
    expect(seen).toEqual(['first', 'second']);
  });

  it('restores persisted history lazily from localStorage (before first getAll)', async () => {
    const { window } = await loadServiceApp('event-log');
    // loadPersisted() is lazy — seeding before the first read replays last session.
    window.localStorage.setItem('novaOS_eventlog', JSON.stringify([{ id: 'old', message: 'from last session' }]));
    expect(window.EventLog.getAll().map((e) => e.message)).toContain('from last session');
    // A second getAll() must not re-read and duplicate anything.
    expect(window.EventLog.getAll().length).toBe(1);
  });

  it('survives malformed persisted state: resets to empty and keeps working', async () => {
    const { window } = await loadServiceApp('event-log');
    window.localStorage.setItem('novaOS_eventlog', '{oops');
    expect(window.EventLog.getAll()).toEqual([]); // loadPersisted swallowed the parse error
    const entry = window.EventLog.log({ message: 'after corruption' });
    expect(window.EventLog.getAll()).toEqual([entry]);
  });

  it('clear() empties memory and storage; getCategories() returns a stable copy', async () => {
    const { window } = await loadServiceApp('event-log');
    window.EventLog.log({ message: 'x' });
    window.EventLog.clear();
    expect(window.EventLog.getAll()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('novaOS_eventlog'))).toEqual([]);
    const cats = window.EventLog.getCategories();
    expect(cats).toContain('security');
    expect(cats).toContain('packages');
    cats.push('mutated');
    expect(window.EventLog.getCategories()).not.toContain('mutated'); // defensive copy
  });
});
