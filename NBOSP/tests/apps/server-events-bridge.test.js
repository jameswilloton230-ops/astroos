// tests/apps/server-events-bridge.test.js — service app: SSE -> EventLog forwarder.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

// jsdom has no EventSource — the source would throw on every reconnect attempt
// and schedule an ever-growing backoff chain of real timers, so the harness
// load always injects this recording fake via stubs.extra.
const fakeEventSourceStub = () => {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      instances.push(this);
    }
    close() { this.closed = true; }
  }
  return { FakeEventSource, instances };
};

describe('ServerEventsBridge service (js/apps/server-events-bridge)', () => {
  beforeEach(() => resetTestStorage());

  it('auto-starts at eval time: attaches ServerEventsBridge and opens /api/events/stream', async () => {
    const { FakeEventSource, instances } = fakeEventSourceStub();
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource } },
    });
    const svc = window.ServerEventsBridge;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['start', '_connect', '_scheduleReconnect']) expect(typeof svc[m]).toBe('function');
    // start() ran during eval — one source exists already, pointed at the stream.
    expect(instances.length).toBe(1);
    expect(instances[0].url).toBe('/api/events/stream');
    expect(svc._source).toBe(instances[0]);
  });

  it('start() is idempotent while connected', async () => {
    const { FakeEventSource, instances } = fakeEventSourceStub();
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource } },
    });
    window.ServerEventsBridge.start();
    window.ServerEventsBridge.start();
    expect(instances.length).toBe(1); // no duplicate subscriptions
  });

  it('forwards parsed frames into window.EventLog.ingestRemote', async () => {
    const { FakeEventSource } = fakeEventSourceStub();
    const ingested = [];
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource, EventLog: { ingestRemote: (e) => ingested.push(e) } } },
    });
    const es = window.ServerEventsBridge._source;
    es.onmessage({ data: JSON.stringify({ app: 'security', message: 'login ok', severity: 'info' }) });
    expect(ingested).toEqual([{ app: 'security', message: 'login ok', severity: 'info' }]);
  });

  it('drops malformed frames without throwing and without touching EventLog', async () => {
    const { FakeEventSource } = fakeEventSourceStub();
    const ingested = [];
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource, EventLog: { ingestRemote: (e) => ingested.push(e) } } },
    });
    const es = window.ServerEventsBridge._source;
    expect(() => es.onmessage({ data: 'not-json{{' })).not.toThrow();
    expect(ingested).toEqual([]);
  });

  it('survives a missing EventLog global (optional chaining guard)', async () => {
    const { FakeEventSource } = fakeEventSourceStub();
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource } }, // no EventLog stub on purpose
    });
    const es = window.ServerEventsBridge._source;
    expect(() => es.onmessage({ data: '{"app":"proxy","message":"GET /"}' })).not.toThrow();
  });

  it('onerror closes the source and schedules a reconnect with exponential backoff', async () => {
    const { FakeEventSource, instances } = fakeEventSourceStub();
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource } },
    });
    // The source resolves setTimeout from window — record instead of firing so
    // no real reconnect timers dangle past the test.
    const reconnectDelays = [];
    window.setTimeout = (fn, ms) => { reconnectDelays.push(ms); return reconnectDelays.length; };

    window.ServerEventsBridge._source.onerror();
    expect(instances[0].closed).toBe(true);
    expect(window.ServerEventsBridge._source).toBe(null);
    expect(reconnectDelays).toEqual([1000]);

    // start() after a drop reconnects (second source); its error doubles the backoff.
    window.ServerEventsBridge.start();
    expect(instances.length).toBe(2);
    instances[1].onerror();
    expect(reconnectDelays).toEqual([1000, 2000]);
  });

  it('onopen resets the backoff to 1s', async () => {
    const { FakeEventSource, instances } = fakeEventSourceStub();
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource } },
    });
    const reconnectDelays = [];
    window.setTimeout = (fn, ms) => { reconnectDelays.push(ms); return reconnectDelays.length; };

    instances[0].onerror();
    window.ServerEventsBridge.start();
    instances[1].onopen();
    instances[1].onerror();
    expect(reconnectDelays).toEqual([1000, 1000]); // reset, not 2000
  });

  it('reconnects fire for real and re-ingest after the backoff elapses', async () => {
    const { FakeEventSource, instances } = fakeEventSourceStub();
    const ingested = [];
    const { window } = await loadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: FakeEventSource, EventLog: { ingestRemote: (e) => ingested.push(e) } } },
    });
    expect(instances.length).toBe(1);
    window.ServerEventsBridge._source.onerror();
    await settle(1050); // reconnect timer (1000ms) fires -> second source
    expect(instances.length).toBe(2);
    instances[1].onmessage({ data: '{"app":"email","message":"imap tick"}' });
    expect(ingested[ingested.length - 1]).toEqual({ app: 'email', message: 'imap tick' });
  });
});
