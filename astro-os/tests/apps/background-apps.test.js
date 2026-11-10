// tests/apps/background-apps.test.js — service app: bg clock (timers/alarms) + email poller.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

// The clock interval (250ms) and alarm logic read Date at call time from the
// jsdom realm — swapping window.Date for a fixed-clock subclass makes every
// timer/alarm assertion deterministic.
function installFixedDate(window, initialMs) {
  let now = initialMs;
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  FixedDate.advance = (ms) => { now += ms; return now; };
  FixedDate.set = (ms) => { now = ms; return now; };
  window.Date = FixedDate;
  return FixedDate;
}

// Harness AudioContext lacks close(); the service's destroy() calls it.
class FakeAudioContext {
  static instances = [];
  constructor() {
    FakeAudioContext.instances.push(this);
    this.state = 'running'; this.currentTime = 0; this.destination = {}; this.oscillators = 0;
  }
  createOscillator() { this.oscillators++; return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const pad = (n) => String(n).padStart(2, '0'); // eslint-disable-line no-unused-vars

let notifyCalls;
let dom;

async function loadBackgroundApps({ now = new Date(2024, 1, 26, 10, 5, 0, 0).getTime(), fetch } = {}) {
  const loaded = await loadServiceApp('background-apps', {
    withBaseUtils: true, // persist() calls the shared lsSave()
    stubs: {
      fetch: fetch ?? (() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })),
      extra: { AudioContext: FakeAudioContext, Notify: { show: (o) => notifyCalls.push(o) } },
    },
  });
  dom = loaded.dom;
  const FixedDate = installFixedDate(loaded.window, now);
  return { ...loaded, bg: loaded.window.__ASTROOS_BG, FixedDate, audio: FakeAudioContext };
}

describe('BackgroundApps service (js/apps/background-apps)', () => {
  beforeEach(() => { resetTestStorage(); notifyCalls = []; FakeAudioContext.instances.length = 0; });
  afterEach(() => {
    try {
      dom?.window.__ASTROOS_BG?.clock?.destroy?.();
      dom?.window.__ASTROOS_BG?.email?.stop?.();
      dom?.window.close(); // stop any remaining jsdom timers
    } catch { /* realm already gone */ }
  });

  it('attaches clock and email services on the shared __ASTROOS_BG root', async () => {
    const { bg, window: w } = await loadBackgroundApps();
    expect(w.__ASTROOS_BG).toBe(bg);
    expect(bg).toBeTruthy();
    expect(Object.isFrozen(bg.clock)).toBe(false);
    for (const m of ['startTimer', 'pauseTimer', 'resetTimer', 'restartTimer', 'setTimerPreset', 'timerMs',
      'startStopwatch', 'pauseStopwatch', 'resetStopwatch', 'lapStopwatch', 'getStopwatchLaps',
      'alarmTick', 'loadAlarms', 'saveAlarms', 'persist', 'ensureBooted', 'destroy']) {
      expect(typeof bg.clock[m]).toBe('function');
    }
    for (const m of ['ensureBooted', 'refreshAccounts', 'getAccounts', 'saveAccounts', 'setAccounts', 'syncNow', 'stop']) {
      expect(typeof bg.email[m]).toBe('function');
    }
    // The clock's 250ms tick is running; destroy() must clear it.
    expect(bg._clockTimer).toBeTruthy();
    bg.clock.destroy();
    expect(bg._clockTimer).toBe(null);
    // destroy() is idempotent.
    expect(() => bg.clock.destroy()).not.toThrow();
  });

  it('persists normalized clock state and rewrites corrupt storage on the next persist', async () => {
    const { window, bg } = await loadBackgroundApps();
    const saved = JSON.parse(window.localStorage.getItem('astroos_clock_state_v2'));
    expect(saved).toMatchObject({
      timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
      stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
      lastAlarmMinute: '',
    });
    // Corrupt the persisted blob, then let any state change rewrite it wholesale.
    window.localStorage.setItem('astroos_clock_state_v2', '{corrupt');
    bg.clock.startTimer(100);
    const rewritten = JSON.parse(window.localStorage.getItem('astroos_clock_state_v2'));
    expect(rewritten.timer).toMatchObject({ presetMs: 100, running: true });
  });

  it('timer lifecycle: start/pause/restart/reset with a controllable clock', async () => {
    const { window, bg, FixedDate } = await loadBackgroundApps();
    const clock = bg.clock;

    clock.startTimer(5000);
    expect(clock.state.timer).toMatchObject({ running: true, done: false, presetMs: 5000, remainingMs: 5000, endAt: FixedDate.now() + 5000 });
    expect(clock.timerMs()).toBe(5000);

    FixedDate.advance(2000);
    expect(clock.timerMs()).toBe(3000);
    clock.pauseTimer();
    expect(clock.state.timer).toMatchObject({ running: false, remainingMs: 3000, endAt: 0 });

    clock.restartTimer(); // restart replays the PRESET (5000), not the paused remainder
    expect(clock.state.timer.running).toBe(true);
    expect(clock.state.timer.remainingMs).toBe(5000);
    FixedDate.advance(5000);
    expect(clock.timerMs()).toBe(0); // expired
    expect(clock.state.timer).toMatchObject({ running: false, done: true, endAt: 0 });
    expect(clock.state.timer.done).toBe(true);
    clock.resetTimer();
    expect(clock.state.timer).toMatchObject({ running: false, done: false, remainingMs: 5000, endAt: 0 });

    // Input sanitizing: garbage and negatives clamp to 0 and never start.
    clock.startTimer(-100);
    expect(clock.state.timer.running).toBe(false);
    clock.startTimer('abc');
    expect(clock.state.timer.presetMs).toBe(0);
    clock.setTimerPreset(8000);
    expect(clock.state.timer).toMatchObject({ presetMs: 8000, remainingMs: 8000 });
  });

  it('timer completion beeps a three-note chime through the shared AudioContext', async () => {
    const { bg, FixedDate, audio } = await loadBackgroundApps();
    bg.clock.startTimer(1000);
    FixedDate.advance(2000);
    expect(bg.clock.timerMs()).toBe(0); // expiry fires the first beep synchronously
    await settle(800); // beeps 2 and 3 follow via setTimeout
    expect(audio.instances.length).toBeGreaterThan(0);
    expect(audio.instances[0].oscillators).toBeGreaterThanOrEqual(3);
    expect(bg.clock.state.timer.done).toBe(true);
  });

  it('stopwatch: start/lap/pause/reset accumulate wall time against the fixed clock', async () => {
    const { bg, FixedDate } = await loadBackgroundApps();
    const clock = bg.clock;

    clock.startStopwatch();
    clock.startStopwatch(); // idempotent — startedAt not overwritten
    expect(clock.state.stopwatch.running).toBe(true);
    FixedDate.advance(1500);
    expect(clock.stopwatchMs()).toBe(1500);
    expect(clock.lapStopwatch()).toBe(1500);
    FixedDate.advance(500);
    expect(clock.lapStopwatch()).toBe(2000);
    expect(clock.getStopwatchLaps()).toEqual([1500, 2000]);

    clock.pauseStopwatch();
    expect(clock.state.stopwatch).toMatchObject({ running: false, elapsedMs: 2000, startedAt: 0 });
    expect(clock.stopwatchMs()).toBe(2000); // frozen while paused

    clock.resetStopwatch();
    expect(clock.state.stopwatch).toMatchObject({ running: false, elapsedMs: 0, laps: [] });
    expect(clock.getStopwatchLaps()).toEqual([]);
  });

  it('alarmTick fires matching one-shot alarms once per minute and disables them', async () => {
    const { window, bg, FixedDate } = await loadBackgroundApps();
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [{ id: 'a1', time: '10:05', label: 'Wake up', days: [], enabled: true }],
    }));
    const fired = [];
    bg.clock.alarmTick((al) => fired.push(al.id)); // FixedDate = Mon 2024-02-26 10:05:00.000

    expect(fired).toEqual(['a1']);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toMatchObject({ title: 'Wake up', body: 'Alarm for 10:05', appName: 'Clock', appId: 'com.astroos.clock', category: 'alarm' });
    // One-shot alarm got disabled and persisted.
    const saved = JSON.parse(window.localStorage.getItem('astroos_clock_v1'));
    expect(saved.alarms[0].enabled).toBe(false);
    expect(bg.clock.state.lastAlarmMinute).toBe('2024-1-26-10:5');
    // Same-minute tick is suppressed (no double fire).
    bg.clock.alarmTick((al) => fired.push(al.id));
    expect(fired).toEqual(['a1']);
  });

  it('alarmTick respects the day-of-week filter and mid-minute gating', async () => {
    const { window, bg, FixedDate } = await loadBackgroundApps();
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [{ id: 'mondays', time: '10:05', days: [1], enabled: true }],
    }));
    const fired = [];
    // 2024-02-26 is a Monday — matches.
    bg.clock.alarmTick((al) => fired.push(al.id));
    expect(fired).toEqual(['mondays']);

    // Rewind to Sunday 10:05 — days filter blocks the alarm.
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [{ id: 'mondays', time: '10:05', days: [1], enabled: true }],
    }));
    bg.clock.state.lastAlarmMinute = '';
    FixedDate.set(new Date(2024, 1, 25, 10, 5, 0, 0).getTime()); // Sunday
    bg.clock.alarmTick((al) => fired.push(al.id));
    expect(fired).toEqual(['mondays']);
    // lastAlarmMinute was still claimed for this minute even though nothing fired
    expect(bg.clock.state.lastAlarmMinute).toBe('2024-1-25-10:5');
  });

  it('alarmTick ignores mid-minute ticks (seconds != 0) entirely', async () => {
    const { window, bg, FixedDate } = await loadBackgroundApps();
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [{ id: 'a1', time: '10:05', days: [], enabled: true }],
    }));
    FixedDate.set(new Date(2024, 1, 26, 10, 5, 30, 0).getTime()); // :30 — not the top of the minute
    const fired = [];
    bg.clock.alarmTick((al) => fired.push(al.id));
    expect(fired).toEqual([]);
    expect(bg.clock.state.lastAlarmMinute).toBe(''); // minute not claimed
  });

  it('loadAlarms() filters malformed entries and normalizes fields', async () => {
    const { window, bg } = await loadBackgroundApps();
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [
        { time: 'not-a-time' },                               // fails the HH:MM format check -> dropped
        { time: '07:30' },                                    // defaults: enabled, no days, generated id
        { time: '06:00', days: [0, 9, 'x', 6.5], enabled: 'yes' }, // days filtered to valid ints
      ],
      extra: 'preserved?',
    }));
    const alarms = bg.clock.loadAlarms();
    expect(alarms).toHaveLength(2);
    expect(alarms[0]).toMatchObject({ time: '07:30', enabled: true, days: [] });
    expect(typeof alarms[0].id).toBe('string');
    expect(alarms[1]).toMatchObject({ time: '06:00', days: [0], enabled: true }); // 'yes' !== false -> enabled

    // saveAlarms round-trips through the same envelope key.
    bg.clock.saveAlarms([{ id: 'z', time: '08:00', label: 'L', days: [], enabled: true }]);
    const raw = JSON.parse(window.localStorage.getItem('astroos_clock_v1'));
    expect(raw.alarms).toHaveLength(1);
    expect(raw.alarms[0].id).toBe('z');
  });

  it('email: ensureBooted loads accounts, syncNow records unread state and notifies', async () => {
    const calls = [];
    const { window, bg } = await loadBackgroundApps({
      fetch: (url) => {
        calls.push(url);
        if (url === '/api/email/connect') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        if (url.startsWith('/api/email/messages')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ messages: [{ seen: false }, { seen: false }, { seen: true }] }) });
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      },
    });
    window.localStorage.setItem('astroos_email_accts_v2', JSON.stringify([
      { id: 'a1', name: 'Work', host: 'imap.example', user: 'u', pass: 'p', syncInterval: 0 },
    ]));

    bg.email.ensureBooted();
    expect(bg.email.state.started).toBe(true);
    expect(bg.email.state.lastBootAt).toBeGreaterThan(0);
    bg.email.ensureBooted(); // idempotent
    expect(calls).toEqual([]); // interval 0 -> no auto-sync

    await bg.email.syncNow('a1');
    expect(calls).toEqual(['/api/email/connect', '/api/email/messages?folder=INBOX&page=1&limit=10']);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toMatchObject({ title: 'Email', body: '2 new in Work', appName: 'Email' });
    const saved = JSON.parse(window.localStorage.getItem('astroos_email_accts_v2'));
    expect(saved[0]).toMatchObject({ id: 'a1', _unread: 2 });
    expect(typeof saved[0]._lastSync).toBe('number');
  });

  it('email: sync failures are swallowed silently (no throw, no notify)', async () => {
    const { window, bg } = await loadBackgroundApps(); // default fetch = 404
    window.localStorage.setItem('astroos_email_accts_v2', JSON.stringify([
      { id: 'a1', name: 'Work', host: 'imap.example', user: 'u', pass: 'p' },
    ]));
    bg.email.ensureBooted();
    await expect(bg.email.syncNow('a1')).resolves.toBeUndefined();
    expect(notifyCalls).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('astroos_email_accts_v2'))[0]._unread).toBeUndefined();
  });

  it('email: setAccounts persists + notifies observers, getAccounts reads back, stop() resets', async () => {
    const { window, bg } = await loadBackgroundApps();
    const changes = [];
    bg.email.state.onChange = () => changes.push('changed');

    bg.email.setAccounts([{ id: 'a2', name: 'Personal', syncInterval: 0 }]);
    expect(changes).toEqual(['changed']);
    expect(JSON.parse(window.localStorage.getItem('astroos_email_accts_v2'))).toHaveLength(1);
    expect(bg.email.getAccounts().map((a) => a.id)).toEqual(['a2']);

    bg.email.setAccounts('not-an-array'); // non-array -> cleared
    expect(bg.email.getAccounts()).toEqual([]);
    expect(changes).toEqual(['changed', 'changed']);

    bg.email.ensureBooted();
    bg.email.stop();
    expect(bg.email.state.started).toBe(false);
  });
});
