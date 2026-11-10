// tests/apps/notifications.test.js — service app: Notify (channels, pins, toasts, actions).
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';
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

// Notify drives host globals (OS state, updateNotificationBadge, WM, EventLog).
// The OS stub is captured per load as `os` so tests can assert/mutate shell state.
async function load({ OS: osOverrides, ...extra } = {}, opts = {}) {
  const wmCalls = [];
  const eventLogCalls = [];
  const stubs = {
    extra: {
      OS: { notifications: [], notifUnread: 0, dnd: true, ...osOverrides },
      updateNotificationBadge: () => {},
      WM: { createWindow: (id) => wmCalls.push(id) },
      EventLog: { log: (e) => eventLogCalls.push(e) },
      ...extra,
    },
  };
  const loaded = await loadServiceApp('notifications', { withBaseUtils: true, stubs, ...opts });
  return { ...loaded, os: loaded.window.OS, wmCalls, eventLogCalls };
}

describe('Notify service (js/apps/notifications)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches Notify to window with the full documented surface', async () => {
    const { window } = await load();
    const svc = window.Notify;
    expect(svc).toBeTruthy();
    // Source attaches the plain module object — no Object.freeze here.
    expect(Object.isFrozen(svc)).toBe(false);
    for (const m of ['show', 'ensureChannel', 'getChannel', 'setChannelOverride', 'listChannels',
      'listAppsWithChannels', 'findByTag', 'cancelByTag', 'cancelById', 'clearForApp', 'clearAll',
      'markAllRead', 'pinBackgroundApp', 'unpin', 'runAction', 'consumePendingActions',
      'removeAllAppState', 'loadPersisted', 'persist', 'showToast', 'updateBadge', 'renderPanel', 'togglePanel']) {
      expect(typeof svc[m]).toBe('function');
    }
  });

  it('show() creates a normalized notification, bumps unread state and persists it', async () => {
    const { window, os } = await load();
    const notif = window.Notify.show({ title: 'Hello', body: 'World', type: 'success', appName: 'Tester' });
    expect(notif).toMatchObject({
      title: 'Hello', body: 'World', type: 'success', appName: 'Tester',
      appId: null, category: 'system', icon: 'bell', read: false, pinned: false, channelId: null, tag: null,
    });
    expect(typeof notif.id).toBe('string');
    expect(os.notifications).toHaveLength(1);
    expect(os.notifUnread).toBe(1);
    expect(JSON.parse(window.localStorage.getItem('novaOS_notifications'))).toHaveLength(1);
  });

  it('sanitizes unknown icons to "bell" (the innerHTML boundary)', async () => {
    const { window } = await load();
    const malicious = window.Notify.show({ title: 'x', icon: '"><img src=x onerror=alert(1)>' });
    const valid = window.Notify.show({ title: 'y', icon: 'zap' });
    expect(malicious.icon).toBe('bell');
    expect(valid.icon).toBe('zap');
  });

  it('channels: importance locked at creation, user overrides mute, muted posts drop', async () => {
    const { window, os } = await load();
    const svc = window.Notify;

    const created = svc.ensureChannel('com.chat', { id: 'msgs', name: 'Messages', importance: 'low', description: 'Chat' });
    expect(created.created).toBe(true);
    expect(created.channel.importance).toBe('low');
    expect(created.channel.declaredBy).toBe('runtime');

    // Android parity: importance locked, name still updatable.
    const again = svc.ensureChannel('com.chat', { id: 'msgs', name: 'Messages renamed', importance: 'high' });
    expect(again.created).toBe(false);
    expect(again.channel.importance).toBe('low');
    expect(again.channel.name).toBe('Messages renamed');

    // 'none' at creation is remapped to 'default' (only users may mute).
    expect(svc.ensureChannel('com.chat', { id: 'quiet', name: 'Quiet', importance: 'none' }).channel.importance).toBe('default');

    // Invalid definitions rejected.
    expect(svc.ensureChannel('com.chat', { id: 'bad id!', name: 'X' })).toBe(null);
    expect(svc.ensureChannel('com.chat', { id: 'noid', name: '  ' })).toBe(null);

    // User mutes -> post dropped silently.
    expect(svc.setChannelOverride('com.chat', 'msgs', { enabled: false })).toBe(true);
    const muted = svc.getChannel('com.chat', 'msgs');
    expect(muted.enabled).toBe(false);
    expect(muted.blocked).toBe(true);
    expect(svc.show({ title: 'hi', appId: 'com.chat', channelId: 'msgs' })).toBe(null);
    expect(os.notifications).toHaveLength(0);

    // Clearing the override lets it through with the declared importance.
    expect(svc.setChannelOverride('com.chat', 'msgs', null)).toBe(true);
    const notif = svc.show({ title: 'hi again', appId: 'com.chat', channelId: 'msgs' });
    expect(notif.channelId).toBe('msgs');
    expect(notif.category).toBe('app');

    expect(svc.listChannels('com.chat')).toHaveLength(2);
    expect(svc.listAppsWithChannels()).toEqual(['com.chat']);
    expect(svc.setChannelOverride('com.chat', 'unknown', { enabled: false })).toBe(false);
  });

  it('manifest-declared channels are seeded with declaredBy "manifest"', async () => {
    const { window } = await load();
    window.Notify.ensureChannelsFromManifest('com.store', {
      notifications: { channels: [{ id: 'updates', name: 'Updates', importance: 'default' }] },
    });
    expect(window.Notify.getChannel('com.store', 'updates')).toMatchObject({ declaredBy: 'manifest', importance: 'default' });
  });

  it('tag updates replace in place (same id) and keep actions/progress field-wise', async () => {
    const { window, os } = await load();
    const svc = window.Notify;
    const first = svc.show({ appId: 'com.dl', tag: 'download-1', title: 'Downloading', body: '10%' });
    expect(os.notifications).toHaveLength(1);
    expect(os.notifUnread).toBe(1);

    const second = svc.show({
      appId: 'com.dl', tag: 'download-1', title: 'Downloading', body: '50%',
      progress: { value: 5, max: 10 },
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'bad id', label: 'nope' }, { id: 'nolabel', label: '   ' }],
    });
    expect(second.id).toBe(first.id); // update-in-place
    expect(os.notifications).toHaveLength(1);
    expect(second.body).toBe('50%');
    expect(second.progress).toEqual({ value: 5, max: 10 });
    expect(second.actions).toEqual([{ id: 'cancel', label: 'Cancel' }]); // invalid entries dropped

    // An update that omits actions/progress keeps the previous ones.
    const third = svc.show({ appId: 'com.dl', tag: 'download-1', title: 'Downloading', body: '90%' });
    expect(third.id).toBe(first.id);
    expect(third.actions).toEqual([{ id: 'cancel', label: 'Cancel' }]);
    expect(third.progress).toEqual({ value: 5, max: 10 });
    // Explicit empty actions and an explicit null progress clear them.
    const fourth = svc.show({ appId: 'com.dl', tag: 'download-1', title: 'Done', actions: [], progress: null });
    expect(fourth.actions).toEqual([]);
    expect(fourth.progress).toEqual(null);
    expect(os.notifUnread).toBe(1); // still the single unread entry
  });

  it('pinned background-app entries survive clearAll and are removed only via their action/unpin', async () => {
    const { window, os } = await load();
    const svc = window.Notify;
    const terminated = [];
    const pin = svc.pinBackgroundApp('com.sync', { appName: 'Sync', body: 'syncing files', onTerminate: () => terminated.push('end') });
    expect(pin.pinned).toBe(true);
    expect(pin.pinId).toBe('pin_bg_com.sync');
    expect(pin.category).toBe('background');
    expect(pin.icon).toBe('zap');
    expect(typeof pin.action).toBe('function');

    // Re-pinning replaces rather than duplicates.
    svc.pinBackgroundApp('com.sync', { appName: 'Sync', onTerminate: () => terminated.push('end') });
    expect(os.notifications.filter((n) => n.pinned)).toHaveLength(1);

    svc.show({ title: 'regular', appName: 'Other' });
    svc.clearAll();
    expect(os.notifications.map((n) => n.pinned)).toEqual([true]); // pinned survives the sweep

    // The Terminate action runs the callback, then unpins itself.
    svc.runAction(os.notifications[0]);
    expect(terminated).toEqual(['end']);
    expect(os.notifications).toHaveLength(0);
  });

  it('runAction() routes legacy string actions to WM and logs unknown ones', async () => {
    const { window, wmCalls, eventLogCalls } = await load();
    const svc = window.Notify;

    svc.runAction(svc.show({ title: 't', action: 'settings', actionLabel: 'Open settings' }));
    expect(wmCalls).toEqual(['com.nbosp.settings']);

    svc.runAction(svc.show({ title: 't', action: 'open-store', actionLabel: 'Open store' }));
    expect(wmCalls).toEqual(['com.nbosp.settings', 'com.nbosp.store']);

    svc.runAction(svc.show({ title: 't', action: 'bogus-action', actionLabel: 'X' }));
    expect(eventLogCalls.at(-1)).toMatchObject({ severity: 'warn', message: 'Unknown built-in action: bogus-action' });
  });

  it('runAction() catches a throwing function action and posts an error notification', async () => {
    const { window, os } = await load();
    const before = os.notifications.length;
    const n = window.Notify.show({ title: 't', action: () => { throw new Error('boom'); }, actionLabel: 'Go' });
    expect(() => window.Notify.runAction(n)).not.toThrow();
    expect(os.notifications.length).toBe(before + 2); // original + the 'Action Failed' post
    expect(os.notifications[0]).toMatchObject({ title: 'Action Failed', body: 'boom', type: 'error' });
  });

  it('markAllRead / clearForApp / cancelByTag / cancelById mutate exactly their scope', async () => {
    const { window, os } = await load();
    const svc = window.Notify;
    svc.show({ title: 'a1', appId: 'com.a', tag: 't1' });
    svc.show({ title: 'a2', appId: 'com.a' });
    svc.show({ title: 'b1', appId: 'com.b' });
    expect(os.notifUnread).toBe(3);

    expect(svc.cancelByTag('com.a', 't1')).toBe(true);
    expect(svc.cancelByTag('com.a', 't1')).toBe(false); // idempotent
    expect(os.notifications).toHaveLength(2);

    expect(svc.cancelById('com.a', 'missing')).toBe(false);
    svc.clearForApp('com.a');
    expect(os.notifications.map((n) => n.appId)).toEqual(['com.b']);

    svc.show({ title: 'b2', appId: 'com.b' });
    svc.markAllRead();
    expect(os.notifUnread).toBe(0);
    expect(os.notifications.every((n) => n.read)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('novaOS_notifications'))).toHaveLength(2);
  });

  it('panel: pinned rows sort first, dismiss is hidden for pinned, Mark read re-renders', async () => {
    const { window, document, os } = await load();
    document.body.innerHTML = '<div id="notif-list"></div>';
    const svc = window.Notify;
    svc.show({ title: 'plain', appName: 'A' });
    svc.pinBackgroundApp('com.bg', { appName: 'BG' });
    svc.markAllRead();
    svc.show({ title: 'fresh', appName: 'B' });

    svc.renderPanel();
    const rows = [...document.querySelectorAll('#notif-list .notif-item')];
    expect(rows).toHaveLength(3);
    expect(rows[0].className).toContain('notif-item-pinned');
    expect(rows[0].textContent).toContain('BG is running in the background');
    expect(rows[0].querySelectorAll('.notif-item-dismiss')).toHaveLength(0);

    const freshRow = rows.find((r) => r.textContent.includes('fresh'));
    expect(freshRow).toBeTruthy();
    freshRow.querySelector('.notif-item-action').click(); // "Mark read"

    const freshAfter = [...document.querySelectorAll('#notif-list .notif-item')].find((r) => r.textContent.includes('fresh'));
    expect(freshAfter.querySelectorAll('.notif-item-action')).toHaveLength(0); // re-rendered without it
    expect(freshAfter.className).toContain('read');
    expect(os.notifUnread).toBe(0); // the only unread row was just marked read
  });

  it('progress bars render determinately (40% sliver when indeterminate)', async () => {
    const { window, document } = await load();
    document.body.innerHTML = '<div id="notif-list"></div>';
    const svc = window.Notify;
    svc.show({ title: 'p1', progress: { value: 25, max: 200 } });
    svc.show({ title: 'p2', progress: { indeterminate: true } });
    svc.renderPanel();
    const rows = [...document.querySelectorAll('#notif-list .notif-item')]; // newest first
    const pcts = rows.map((row) => {
      for (const div of row.querySelectorAll('div')) {
        const m = /width:\s*(\d+(?:\.\d+)?)%/.exec(div.style.cssText);
        if (m) return m[1] + '%';
      }
      return null;
    });
    expect(pcts.filter(Boolean)).toEqual(['40%', '13%']); // round(25/200*100)=13
  });

  it('toasts render into #toast-container, route action clicks (WM + action queue), and respect DND', async () => {
    const { window, document, os, wmCalls } = await load();
    document.body.innerHTML = '<div id="toast-container"></div>';
    const svc = window.Notify;

    // DND suppresses the toast even though the container exists.
    const dndNotif = svc.show({ title: 'silent', appId: 'com.dnd' });
    expect(document.querySelector('#toast-container .toast')).toBe(null);

    os.dnd = false;
    const notif = svc.show({
      title: 'New message', body: 'hi', appId: 'com.chat', tag: 'msg-1',
      actions: [{ id: 'reply', label: 'Reply' }],
    });
    const toast = document.querySelector('#toast-container .toast');
    expect(toast).toBeTruthy();
    expect(toast.querySelector('.toast-title').textContent).toBe('New message');
    const actionBtn = toast.querySelector('.toast-action');
    expect(actionBtn.textContent).toBe('Reply');

    actionBtn.click(); // stopPropagation -> open app + queue the action
    expect(wmCalls).toContain('com.chat');
    const drained = svc.consumePendingActions('com.chat');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ appId: 'com.chat', actionId: 'reply', notifId: notif.id, label: 'Reply', title: 'New message' });
    expect(svc.consumePendingActions('com.chat')).toEqual([]); // drained exactly once
    expect(dndNotif).toBeTruthy();
  });

  it('toast close button marks it removing and it leaves the DOM after the grace timeout', async () => {
    const { window, document, os } = await load({ OS: { dnd: false } });
    document.body.innerHTML = '<div id="toast-container"></div>';
    window.Notify.show({ title: 'toast me', body: 'b' });
    const toast = document.querySelector('#toast-container .toast');
    expect(toast.querySelector('.toast-title').textContent).toBe('toast me');
    toast.querySelector('.toast-close').click();
    expect(toast.className).toContain('removing');
    await settle(320);
    expect(document.querySelector('#toast-container .toast')).toBe(null);
  });

  it('loadPersisted() replays saved notifications (capped at 100) and survives malformed JSON', async () => {
    const { window, os } = await load();
    const saved = Array.from({ length: 110 }, (_, i) => ({ id: `n${i}`, title: `t${i}`, read: i > 3 }));
    window.localStorage.setItem('novaOS_notifications', JSON.stringify(saved));
    window.Notify.loadPersisted();
    expect(os.notifications).toHaveLength(100);
    expect(os.notifUnread).toBe(4);

    const { window: w2, os: os2 } = await load({ OS: { notifications: ['sentinel'], notifUnread: 99 } });
    w2.localStorage.setItem('novaOS_notifications', '{nope');
    w2.Notify.loadPersisted();
    expect(os2.notifications).toEqual([]);
    expect(os2.notifUnread).toBe(0);
  });

  it('removeAllAppState() wipes channels, overrides and queued actions of one app', async () => {
    const { window, document, os } = await load({ OS: { dnd: false } });
    const svc = window.Notify;
    svc.ensureChannel('com.dead', { id: 'c1', name: 'C1' });
    svc.ensureChannel('com.alive', { id: 'c2', name: 'C2' });
    svc.setChannelOverride('com.dead', 'c1', { enabled: false });

    document.body.innerHTML = '<div id="toast-container"></div>';
    svc.show({ title: 'x', appId: 'com.dead', actions: [{ id: 'open', label: 'Open' }] });
    document.querySelector('.toast-action').click(); // queue {open} for com.dead
    expect(JSON.parse(window.localStorage.getItem('novaOS_notifPendingActions'))).toHaveLength(1);

    svc.removeAllAppState('com.dead');

    expect(svc.listChannels('com.dead')).toEqual([]);
    expect(svc.listAppsWithChannels()).toEqual(['com.alive']);
    expect(svc.getChannel('com.dead', 'c1')).toBe(null);
    expect(JSON.parse(window.localStorage.getItem('novaOS_notifPendingActions'))).toEqual([]);
  });

  it('queues action taps into the registry when the engine is up, and drains them from there', async () => {
    const Reg = freshRegistry();
    const { window, document } = await load({ OS: { dnd: false }, NovaRegistry: Reg });
    const svc = window.Notify;

    document.body.innerHTML = '<div id="toast-container"></div>';
    svc.show({ title: 'x', appId: 'com.dead', actions: [{ id: 'open', label: 'Open' }] });
    document.querySelector('.toast-action').click(); // queue {open} for com.dead

    // The queue landed in the hive (HKNU/shell/notifications/pendingActions,
    // beside channels + overrides); the legacy shadow stays untouched.
    expect(Reg.get('HKNU/shell/notifications/pendingActions')).toHaveLength(1);
    expect(Reg.get('HKNU/shell/notifications/pendingActions')[0]).toMatchObject({ appId: 'com.dead', actionId: 'open' });
    expect(window.localStorage.getItem('novaOS_notifPendingActions')).toBeNull();

    // Drain consumes from the same hive path.
    const drained = svc.consumePendingActions('com.dead');
    expect(drained).toHaveLength(1);
    expect(Reg.get('HKNU/shell/notifications/pendingActions')).toEqual([]);
  });
});
