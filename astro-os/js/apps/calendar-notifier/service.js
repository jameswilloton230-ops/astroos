// ── Calendar Notifier ─────────────────────────────────────────────────────
// Background service that watches saved calendar events and fires a
// Notify.show() reminder shortly before each event starts.
//
// The calendar app itself only ever shows a toast at the moment an event is
// *saved* (see js/apps/calendar/app.js handleSave) — nothing previously polled
// events to warn about them as they approached. This service closes that
// gap without touching the calendar app's own storage format.
//
// Runs independently of whether the Calendar app window is open, since it
// reads calendar's localStorage directly and is booted once as a Boot.after
// hook (see js/core/core/boot.js).
//
// The fired-id dedupe set ("already reminded for this event") is machine
// service bookkeeping, so it lives in the hive at
// HKNS/apps/calendar/notifiedIds — the same family as the store-update
// notified marker (HKNS/apps/store/lastNotifiedAt). The legacy localStorage
// key stays as the adoption source and the fail-soft fallback.

const CalendarNotifier = {
  _STORE_KEY:   'calendar_events_v2',   // must match calendar.js STORE_KEY
  _FIRED_KEY:   'calendar_notified_v1', // ids we've already alerted for (legacy)
  _FIRED_REG:   'HKNS/apps/calendar/notifiedIds',
  _LEAD_MS:     10 * 60 * 1000,         // warn 10 minutes before start
  _POLL_MS:     30 * 1000,              // check every 30s
  _timer:       null,

  start() {
    if (CalendarNotifier._timer) return; // idempotent — don't double-schedule
    CalendarNotifier._tick();
    CalendarNotifier._timer = setInterval(CalendarNotifier._tick, CalendarNotifier._POLL_MS);
  },

  stop() {
    if (CalendarNotifier._timer) {
      clearInterval(CalendarNotifier._timer);
      CalendarNotifier._timer = null;
    }
  },

  _loadEvents() {
    try {
      const raw = JSON.parse(localStorage.getItem(CalendarNotifier._STORE_KEY) ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  },

  _reg() {
    return (typeof window !== 'undefined' && window.NovaRegistry && typeof window.NovaRegistry.get === 'function')
      ? window.NovaRegistry : null;
  },

  _loadFired() {
    const r = CalendarNotifier._reg();
    if (r) {
      try {
        const value = r.get(CalendarNotifier._FIRED_REG);
        if (value !== undefined) return Array.isArray(value) ? new Set(value) : new Set();
      } catch (_) { /* fall through to legacy */ }
    }
    try {
      const raw = JSON.parse(localStorage.getItem(CalendarNotifier._FIRED_KEY) ?? '[]');
      return Array.isArray(raw) ? new Set(raw) : new Set();
    } catch { return new Set(); }
  },

  _saveFired(set) {
    // Cap so this can't grow unbounded over months of use.
    const arr = Array.from(set).slice(-500);
    const r = CalendarNotifier._reg();
    if (r) {
      try {
        r.set(CalendarNotifier._FIRED_REG, arr, { type: 'REG_JSON', source: 'calendar-notifier' });
        return;
      } catch (_) { /* fall through to legacy */ }
    }
    try { localStorage.setItem(CalendarNotifier._FIRED_KEY, JSON.stringify(arr)); } catch {}
  },

  // Parses an event's date + timeStart as a local Date, or null if there's
  // no usable start time (all-day / time-less events aren't reminded).
  _eventStart(ev) {
    if (!ev || typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
    if (typeof ev.timeStart !== 'string' || !/^\d{2}:\d{2}$/.test(ev.timeStart)) return null;
    const d = new Date(`${ev.date}T${ev.timeStart}:00`);
    return isNaN(d.getTime()) ? null : d;
  },

  _tick() {
    const events = CalendarNotifier._loadEvents();
    if (!events.length) return;

    const fired = CalendarNotifier._loadFired();
    const now = Date.now();
    let changed = false;

    for (const ev of events) {
      if (!ev || !ev.id || fired.has(ev.id)) continue;
      const start = CalendarNotifier._eventStart(ev);
      if (!start) continue;

      const msUntil = start.getTime() - now;
      // Fire once the event enters the lead window, but not for events
      // that have already fully passed (e.g. app was closed for a day).
      if (msUntil <= CalendarNotifier._LEAD_MS && msUntil > -60 * 1000) {
        const title = typeof ev.title === 'string' && ev.title.trim() ? ev.title.trim() : 'Untitled event';
        const minutes = Math.max(0, Math.round(msUntil / 60000));
        const body = minutes <= 1 ? 'Starting now' : `Starts in ${minutes} min`;

        if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
          Notify.show({
            title: `Upcoming: ${title}`,
            body,
            type: 'info',
            appName: 'Calendar',
            category: 'calendar',
            icon: 'calendar',
          });
        }

        fired.add(ev.id);
        changed = true;
      }
    }

    if (changed) CalendarNotifier._saveFired(fired);
  },
};

// ── EXPOSE TO GLOBAL RUNTIME SCOPE ───────────────────────────────────────────
if (typeof CalendarNotifier !== 'undefined') {
  window.CalendarNotifier = CalendarNotifier;
} else {
  console.warn('CalendarNotifier object was not found in the local scope of calendar-notifier.js');
}

// Start once the desktop/lock screen has finished booting, alongside the
// rest of AstroOS's Boot.hooks.after consumers.
if (typeof Boot !== 'undefined' && Boot?.hooks?.after) {
  Boot.hooks.after.push(() => CalendarNotifier.start());
}
