/* ── Background services: Clock + Email ───────────────────────────────── */
(function () {
  'use strict';

  const bgRoot = window.__ASTROOS_BG = window.__ASTROOS_BG || {};

  // ── Shared AudioContext (reused instead of creating new one per beep) ──
  let sharedAudioCtx = null;

  function getAudioContext() {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      try {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch { return null; }
    }
    // Resume if suspended (browser autoplay policy)
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }

  function bgBeep(freq, dur) {
    try {
      const actx = getAudioContext();
      if (!actx) return;
      const osc = actx.createOscillator();
      const gn = actx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq || 880;
      gn.gain.setValueAtTime(0.25, actx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (dur || 1.0));
      osc.connect(gn);
      gn.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + (dur || 1.0));
      // No setTimeout to close — we reuse the AudioContext
    } catch { /* audio not available */ }
  }

  function safeJSONParse(raw, fallback) {
    try { return JSON.parse(raw); }
    catch { return fallback; }
  }

  /* ---------------------------- Clock service ---------------------------- */
  if (!bgRoot.clock) {
    const STATE_KEY = 'astroos_clock_state_v2'; // legacy seed + fallback; live path is HKNA/com.astroos.clock/state
    const ALARMS_KEY = 'astroos_clock_v1';

    const defaults = () => ({
      timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
      stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
      lastAlarmMinute: ''
    });

    // Registry-backed (HKNA/com.astroos.clock/state via NovaAppConfig); the
    // localStorage key is the pre-registry seed and the fail-soft fallback.
    let state = null;
    if (typeof window !== 'undefined' && window.NovaAppConfig) {
      try {
        state = window.NovaAppConfig.get('com.astroos.clock', 'state', { legacyKey: STATE_KEY, fallback: null });
      } catch (_) { state = null; }
    }
    if (state === null || state === undefined) state = safeJSONParse(localStorage.getItem(STATE_KEY), null);
    if (!state || typeof state !== 'object') state = defaults();

    function normaliseState() {
      state.timer = state.timer || {};
      state.stopwatch = state.stopwatch || {};
      state.timer.running = !!state.timer.running;
      state.timer.done = !!state.timer.done;
      state.timer.presetMs = Math.max(0, Number(state.timer.presetMs) || 0);
      state.timer.remainingMs = Math.max(0, Number(state.timer.remainingMs) || 0);
      state.timer.endAt = Math.max(0, Number(state.timer.endAt) || 0);

      state.stopwatch.running = !!state.stopwatch.running;
      state.stopwatch.elapsedMs = Math.max(0, Number(state.stopwatch.elapsedMs) || 0);
      state.stopwatch.startedAt = Math.max(0, Number(state.stopwatch.startedAt) || 0);
      state.stopwatch.laps = Array.isArray(state.stopwatch.laps)
        ? state.stopwatch.laps.filter(n => Number.isFinite(n) && n >= 0).map(n => Math.floor(n))
        : [];
      state.lastAlarmMinute = typeof state.lastAlarmMinute === 'string' ? state.lastAlarmMinute : '';
    }

    function persist() {
      normaliseState();
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          window.NovaAppConfig.set('com.astroos.clock', 'state', state, { legacyKey: STATE_KEY });
          return;
        } catch (_) { /* fall through to legacy */ }
      }
      lsSave(STATE_KEY, state);
    }

    function loadAlarms() {
      // Registry-backed (HKNA/com.astroos.clock/alarms); the localStorage key
      // is the pre-registry fallback. Shares the path with the clock app.
      let raw = null;
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          raw = window.NovaAppConfig.get('com.astroos.clock', 'alarms', { legacyKey: ALARMS_KEY, fallback: null });
        } catch (_) { raw = null; }
      }
      if (raw === null || raw === undefined) raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
      const alarms = Array.isArray(raw?.alarms) ? raw.alarms : [];
      return alarms
        .map(al => ({
          id: al?.id ?? Date.now().toString(36),
          time: typeof al?.time === 'string' ? al.time : '07:00',
          label: typeof al?.label === 'string' ? al.label : '',
          days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
          enabled: al?.enabled !== false
        }))
        .filter(al => /^\d{2}:\d{2}$/.test(al.time));
    }

    function saveAlarms(alarms) {
      let raw = null;
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          raw = window.NovaAppConfig.get('com.astroos.clock', 'alarms', { legacyKey: ALARMS_KEY, fallback: null });
        } catch (_) { raw = null; }
      }
      if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
        raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
      }
      raw.alarms = alarms;
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          window.NovaAppConfig.set('com.astroos.clock', 'alarms', raw, { legacyKey: ALARMS_KEY });
          return;
        } catch (_) { /* fall through to legacy */ }
      }
      lsSave(ALARMS_KEY, raw);
    }

    function nowMs() { return Date.now(); }

    function timerMs() {
      normaliseState();
      if (state.timer.running && state.timer.endAt) {
        const rem = Math.max(0, state.timer.endAt - nowMs());
        if (rem <= 0) {
          state.timer.running = false;
          state.timer.done = true;
          state.timer.remainingMs = 0;
          state.timer.endAt = 0;
          persist();
          bgBeep(880, 0.7);
          setTimeout(() => bgBeep(1047, 0.7), 350);
          setTimeout(() => bgBeep(1319, 1.0), 700);
          return 0;
        }
        return rem;
      }
      return state.timer.remainingMs || 0;
    }

    function stopwatchMs() {
      normaliseState();
      return state.stopwatch.running
        ? state.stopwatch.elapsedMs + Math.max(0, nowMs() - state.stopwatch.startedAt)
        : state.stopwatch.elapsedMs;
    }

    bgRoot.clock = {
      state,
      persist,
      loadAlarms,
      saveAlarms,
      timerMs,
      stopwatchMs,

      startTimer(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      pauseTimer() {
        state.timer.remainingMs = timerMs();
        state.timer.running = false;
        state.timer.done = false;
        state.timer.endAt = 0;
        persist();
      },

      resetTimer() {
        state.timer.running = false;
        state.timer.done = false;
        state.timer.remainingMs = state.timer.presetMs || 0;
        state.timer.endAt = 0;
        persist();
      },

      restartTimer() {
        const amount = state.timer.presetMs || state.timer.remainingMs || 0;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      setTimerPreset(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        if (!state.timer.running) state.timer.remainingMs = amount;
        persist();
      },

      startStopwatch() {
        if (!state.stopwatch.running) {
          state.stopwatch.startedAt = nowMs();
          state.stopwatch.running = true;
          persist();
        }
      },

      pauseStopwatch() {
        if (state.stopwatch.running) {
          state.stopwatch.elapsedMs = stopwatchMs();
          state.stopwatch.running = false;
          state.stopwatch.startedAt = 0;
          persist();
        }
      },

      resetStopwatch() {
        state.stopwatch.running = false;
        state.stopwatch.elapsedMs = 0;
        state.stopwatch.startedAt = 0;
        state.stopwatch.laps = [];
        persist();
      },

      lapStopwatch() {
        const current = Math.floor(stopwatchMs());
        const laps = state.stopwatch.laps;
        if (!laps.length || laps[laps.length - 1] !== current) {
          laps.push(current);
          persist();
        }
        return current;
      },

      getStopwatchLaps() {
        normaliseState();
        return state.stopwatch.laps.slice();
      },

      alarmTick(checkFn) {
        const now = new Date();
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
        if (state.lastAlarmMinute === minuteKey) return;
        const seconds = now.getSeconds();
        const ms = now.getMilliseconds();
        if (seconds !== 0 || ms > 1400) return;
        state.lastAlarmMinute = minuteKey;
        persist();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dow = now.getDay();
        const alarms = loadAlarms();
        alarms.forEach((al, i) => {
          if (!al.enabled || al.time !== timeStr) return;
          if (al.days.length > 0 && !al.days.includes(dow)) return;
          if (typeof checkFn === 'function') {
            try { checkFn(al, i); } catch { /* observer error — don't block */ }
          }
          bgBeep(880, 0.8);
          setTimeout(() => bgBeep(1047, 0.8), 400);
          setTimeout(() => bgBeep(1319, 1.2), 800);
          try {
            if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
              Notify.show({
                title: al.label || 'Alarm',
                body: `Alarm for ${al.time}`,
                type: 'info',
                appName: 'Clock',
                appId: 'com.astroos.clock',
                category: 'alarm',
                icon: 'bell'
              });
            }
          } catch { /* notification UI is best effort; the alarm tone still fires */ }
          if (al.days.length === 0) {
            al.enabled = false;
            saveAlarms(alarms);
          }
        });
      },

      ensureBooted() { return true; },

      // ── Cleanup method for clock interval ──
      destroy() {
        if (bgRoot._clockTimer) {
          clearInterval(bgRoot._clockTimer);
          bgRoot._clockTimer = null;
        }
        if (sharedAudioCtx) {
          sharedAudioCtx.close().catch(() => {});
          sharedAudioCtx = null;
        }
      }
    };

    normaliseState();
    persist();

    if (!bgRoot._clockTimer) {
      bgRoot._clockTimer = setInterval(() => {
        timerMs();
        bgRoot.clock.alarmTick();
      }, 250);
    }
  }

  /* ---------------------------- Email service ---------------------------- */
  if (!bgRoot.email) {
    const ACCTS_KEY = 'astroos_email_accts_v2';

    const state = {
      started: false,
      accounts: [],
      syncTimers: {},
      onChange: null,
      lastBootAt: 0
    };

    const rawLoad = () => {
      // Registry-backed (HKNA/com.astroos.email/accounts); the localStorage
      // key is the pre-registry fallback.
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          const fromRegistry = window.NovaAppConfig.get('com.astroos.email', 'accounts', { legacyKey: ACCTS_KEY, fallback: null });
          if (Array.isArray(fromRegistry)) return fromRegistry;
        } catch (_) { /* fall through to legacy */ }
      }
      try { return JSON.parse(localStorage.getItem(ACCTS_KEY) || '[]'); }
      catch { return []; }
    };

    function saveAccounts() {
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try {
          window.NovaAppConfig.set('com.astroos.email', 'accounts', state.accounts, { legacyKey: ACCTS_KEY });
          return;
        } catch (_) { /* fall through to legacy */ }
      }
      lsSave(ACCTS_KEY, state.accounts);
    }

    function clearTimers() {
      for (const id of Object.keys(state.syncTimers)) {
        clearInterval(state.syncTimers[id]);
        delete state.syncTimers[id];
      }
    }

    async function api(path, opts) {
      const r = await fetch('/api/email' + path, Object.assign({ credentials: 'include' }, opts || {}));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }

    async function connectAccount(acct) {
      if (!acct || !acct.host || !acct.user || !acct.pass) return;
      await api('/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: acct.type, host: acct.host, port: acct.port,
          ssl: acct.ssl, user: acct.user, pass: acct.pass
        })
      });
    }

    function renderHook() {
      if (typeof state.onChange === 'function') {
        try { state.onChange(); } catch { /* observer error */ }
      }
    }

    // ── AbortController for cancelling in-flight sync requests ──
    let syncAbortController = null;

    async function syncAccount(acct) {
      // ── Create per-sync abort signal ──
      const localAc = new AbortController();

      try {
        await connectAccount(acct);
        const d = await api('/messages?folder=INBOX&page=1&limit=10', { method: 'GET', signal: localAc.signal });
        const unread = (d.messages || []).filter(m => !m.seen).length;
        acct._unread = unread;
        acct._lastSync = Date.now();
        state.accounts = rawLoad();
        const target = state.accounts.find(a => a.id === acct.id);
        if (target) {
          target._unread = unread;
          target._lastSync = acct._lastSync;
          saveAccounts();
        }
        if (unread > 0 && window.Notify?.show) {
          Notify.show({ title: 'Email', body: `${unread} new in ${acct.name || acct.email || 'Email'}`, type: 'info', appName: 'Email' });
        }
        renderHook();
      } catch {
        // Network error or abort — silently handled
      }
    }

    function schedule() {
      clearTimers();
      state.accounts = rawLoad();
      state.accounts.forEach(acct => {
        const mins = parseInt(acct.syncInterval) || 0;
        if (!mins) return;
        state.syncTimers[acct.id] = setInterval(() => { syncAccount(acct); }, mins * 60000);
      });
    }

    bgRoot.email = {
      state,

      ensureBooted() {
        if (state.started) return;
        state.started = true;
        state.lastBootAt = Date.now();
        state.accounts = rawLoad();
        schedule();
        state.accounts.forEach(acct => {
          const mins = parseInt(acct.syncInterval) || 0;
          if (mins) syncAccount(acct);
        });
      },

      refreshAccounts: schedule,

      getAccounts() {
        state.accounts = rawLoad();
        return state.accounts.slice();
      },

      saveAccounts,

      setAccounts(next) {
        state.accounts = Array.isArray(next) ? next : [];
        saveAccounts();
        schedule();
        renderHook();
      },

      syncNow(acctId) {
        const list = rawLoad();
        if (acctId) {
          const acct = list.find(a => a.id === acctId);
          if (acct) return syncAccount(acct);
          return Promise.resolve();
        }
        return Promise.allSettled(list.map(acct => syncAccount(acct)));
      },

      stop() {
        clearTimers();
        // ── Cancel any in-flight sync requests ──
        if (syncAbortController) {
          syncAbortController.abort();
          syncAbortController = null;
        }
        state.started = false;
      }
    };
  }
})();
