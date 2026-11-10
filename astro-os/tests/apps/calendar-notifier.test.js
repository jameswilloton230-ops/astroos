// tests/apps/calendar-notifier.test.js — service app: pre-event reminder poller.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';
import NovaRegistry from '../../js/platform/core/nova-registry.js';

// A real registry engine over a memory store, for the registry-present paths.
function freshRegistry() {
  const map = new Map();
  const storage = {
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage, events: null, logger: console });
  return NovaRegistry;
}

const pad = (n) => String(n).padStart(2, '0');
const localYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// An event starting `minutes` from now, shaped exactly like calendar's store.
// +30s guard: start is formatted as local HH:MM (seconds truncated), so the
// parsed start can land up to a full minute earlier than requested. Without
// the guard, Math.round(msUntil/60000) flips between e.g. "Starts in 5 min"
// and "Starts in 4 min" depending on the wall clock's current second — a
// real flake. Adding half a minute keeps the floored start inside the same
// rounding bucket for every possible current-second value.
function eventInMinutes(id, minutes, extra = {}) {
  const start = new Date(Date.now() + minutes * 60000 + 30000);
  return { id, date: localYMD(start), timeStart: localHM(start), title: `Event ${id}`, ...extra };
}

function makeNotifyStub() {
  const calls = [];
  return { calls, stub: { show: (opts) => calls.push(opts) } };
}

describe('CalendarNotifier service (js/apps/calendar-notifier)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches CalendarNotifier to window (not frozen; no auto-start without Boot)', async () => {
    const { window } = await loadServiceApp('calendar-notifier');
    const svc = window.CalendarNotifier;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['start', 'stop', '_tick']) expect(typeof svc[m]).toBe('function');
    expect(svc._STORE_KEY).toBe('calendar_events_v2');
    expect(svc._FIRED_KEY).toBe('calendar_notified_v1');
    expect(svc._LEAD_MS).toBe(10 * 60 * 1000);
    // The harness has no Boot global, so the Boot.hooks.after branch is skipped
    // and no polling timer is running yet.
    expect(svc._timer).toBe(null);
  });

  it('fires one Notify reminder when an event enters the 10-minute lead window', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e1', 5)]));

    window.CalendarNotifier._tick();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      title: 'Upcoming: Event e1',
      body: 'Starts in 5 min',
      type: 'info',
      appName: 'Calendar',
      category: 'calendar',
      icon: 'calendar',
    });
    // The fired id is persisted so a reload cannot re-alert.
    expect(JSON.parse(window.localStorage.getItem('calendar_notified_v1'))).toEqual(['e1']);
  });

  it('never fires twice for the same event (fired-set is re-read every tick)', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e1', 5)]));

    window.CalendarNotifier._tick();
    window.CalendarNotifier._tick();
    window.CalendarNotifier._tick();
    expect(calls.length).toBe(1);
  });

  it('uses "Starting now" inside the last minute and ignores far-future/past/all-day events', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([
      eventInMinutes('soon', 0.4),              // inside the last minute
      eventInMinutes('later', 11),              // outside the lead window
      eventInMinutes('yesterday', -10),         // fully passed (>60s ago)
      { id: 'allday', date: localYMD(new Date()) }, // no timeStart -> no reminder
      { id: 'bad-date', date: '2024-13-99', timeStart: '10:00' },
    ]));

    window.CalendarNotifier._tick();

    expect(calls.length).toBe(1);
    expect(calls[0].title).toBe('Upcoming: Event soon');
    expect(calls[0].body).toBe('Starting now');
    expect(JSON.parse(window.localStorage.getItem('calendar_notified_v1'))).toEqual(['soon']);
  });

  it('survives malformed persisted stores (events and fired ids)', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    window.localStorage.setItem('calendar_events_v2', '{oops');
    window.localStorage.setItem('calendar_notified_v1', '{"not":"an array"}');
    expect(() => window.CalendarNotifier._tick()).not.toThrow();
    expect(calls.length).toBe(0);
  });

  it('caps the persisted fired-id list at 500, dropping the oldest', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    const oldIds = Array.from({ length: 505 }, (_, i) => `old-${i}`);
    window.localStorage.setItem('calendar_notified_v1', JSON.stringify(oldIds));
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('new-1', 3)]));

    window.CalendarNotifier._tick();

    expect(calls.length).toBe(1);
    const saved = JSON.parse(window.localStorage.getItem('calendar_notified_v1'));
    expect(saved.length).toBe(500);
    expect(saved[saved.length - 1]).toBe('new-1');
    expect(saved[0]).toBe('old-6'); // oldest six (old-0..old-5) were evicted
  });

  it('start() is idempotent, ticks immediately, and stop() clears the poll timer', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    const svc = window.CalendarNotifier;
    try {
      window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e1', 2)]));
      svc.start();
      const firstTimer = svc._timer;
      expect(firstTimer).toBeTruthy(); // a 30s interval is now live
      expect(calls.length).toBe(1); // immediate _tick on start
      svc.start(); // idempotent — no second interval, no second alert
      expect(svc._timer).toBe(firstTimer);
      expect(calls.length).toBe(1);
    } finally {
      svc.stop(); // must not leave a jsdom interval dangling
    }
    expect(svc._timer).toBe(null);
  });

  it('titles untitled events as "Untitled event"', async () => {
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub } } });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e9', 4, { title: '   ' })]));
    window.CalendarNotifier._tick();
    expect(calls[0].title).toBe('Upcoming: Untitled event');
  });

  it('keeps the fired set in the registry when the engine is up (no re-fire after reload)', async () => {
    const Reg = freshRegistry();
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub, NovaRegistry: Reg } } });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e1', 5)]));

    window.CalendarNotifier._tick();
    expect(calls.length).toBe(1);
    // The dedupe set lives in the hive; the legacy shadow stays untouched.
    expect(Reg.get('HKNS/apps/calendar/notifiedIds')).toEqual(['e1']);
    expect(window.localStorage.getItem('calendar_notified_v1')).toBeNull();

    // A reload with an EMPTY legacy channel still refuses to re-alert: the
    // fired set is read back from the registry.
    const { stub: stub2, calls: calls2 } = makeNotifyStub();
    const { window: w2 } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub2, NovaRegistry: Reg } } });
    w2.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e1', 5)]));
    w2.CalendarNotifier._tick();
    expect(calls2.length).toBe(0);
  });

  it('adopts a pre-registry localStorage fired set into the hive on the next save', async () => {
    const Reg = freshRegistry();
    const { stub, calls } = makeNotifyStub();
    const { window } = await loadServiceApp('calendar-notifier', { stubs: { extra: { Notify: stub, NovaRegistry: Reg } } });
    window.localStorage.setItem('calendar_notified_v1', JSON.stringify(['old-1']));
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([eventInMinutes('e2', 4)]));

    window.CalendarNotifier._tick();

    expect(calls.length).toBe(1);
    // Both the adopted id and the new one are in the hive now.
    expect(Reg.get('HKNS/apps/calendar/notifiedIds')).toEqual(['old-1', 'e2']);
  });
});
