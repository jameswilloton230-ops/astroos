/**
 * AppScheduler — Tier 1 background execution (system:background).
 *
 * This is the "scheduled wake" tier from the permission design doc: an app
 * holding system:background doesn't need to be open, or ever have been
 * opened, for it to periodically run and do work (check state, sync data,
 * update its own storage). It is explicitly NOT a way to send notifications
 * — that still requires device:notifications separately, same as every
 * other capability in this permission model. It is also NOT "stay alive
 * indefinitely" — that's Tier 2 (system:background:live, see
 * AppSandbox.detachToBackground). A Tier-1 wake is brief and bounded: spin
 * the app's sandbox up headlessly, give it a short window to do work, tear
 * it down again.
 *
 * How a wake cycle works:
 *  1. Every WAKE_INTERVAL_MS, sweep every installed, non-disabled app that
 *     holds system:background.
 *  2. If the app already has a live Tier-2 sandbox sitting in
 *     #background-app-host, reuse it — no need to spin up a second
 *     instance of the same app. Otherwise, launch a fresh headless sandbox
 *     into the same hidden host.
 *  3. Dispatch a nova:background:wake push (AppSandbox.dispatchBackgroundWake)
 *     into the sandbox. The app's JS receives this via
 *     nova.onBackgroundWake(callback) (see the capability shim in
 *     app-sandbox.js) and can call nova.ipc('nova:background:wake-done', {})
 *     — or the sugar form nova.backgroundWakeDone() — to signal it's done
 *     early.
 *  4. Give the app up to WAKE_DEADLINE_MS. If it signals done first, or the
 *     deadline passes first, tear the sandbox down (unless it was a
 *     pre-existing Tier-2 sandbox, which is left alone — Tier 1 doesn't get
 *     to kill a Tier-2 process just because its wake window ended).
 *
 * This module has no UI and holds no persistent state beyond in-memory
 * timers — a browser refresh naturally clears all of it, which is correct:
 * scheduled wakes resume from boot.js calling AppScheduler.start().
 */
const AppScheduler = (() => {
  'use strict';

  // Real OS schedulers use similarly coarse intervals for periodic
  // background work (Android's minimum periodic WorkManager interval is
  // 15 minutes) — matching that cadence here rather than inventing a
  // tighter one that would make "background" indistinguishable from
  // "always running", which is exactly the distinction Tier 1 vs Tier 2
  // exists to preserve.
  const WAKE_INTERVAL_MS = 15 * 60 * 1000;

  // How long a single wake gets to run before being torn down regardless
  // of whether it called wake-done. Bounded and short — this is meant for
  // "check something, update local state," not sustained work.
  //
  // This is expected to stay well under WAKE_INTERVAL_MS. If someone ever
  // widens the deadline close to (or past) the interval, wakes could start
  // overlapping with the next sweep for the same app. The dedupe check in
  // wake() (pendingWakes.has(sandboxId)) protects against a double-dispatch
  // if that happens, but it's still worth keeping this gap large on
  // purpose rather than relying on that guard.
  const WAKE_DEADLINE_MS = 10 * 1000;

  // sandboxId -> { timeoutId, appId, ownedByScheduler, wrapperEl }
  // ownedByScheduler distinguishes "this scheduler launched and must tear
  // down this sandbox" from "this is someone else's Tier-2 sandbox that
  // the scheduler is just borrowing for a wake push." wrapperEl is the
  // scaffolding div the scheduler created for an owned launch, kept here
  // directly rather than re-derived later — see endWake() for why.
  const pendingWakes = new Map();

  let intervalId = null;
  let running = false;

  // Sandboxes get destroyed here regardless of how endWake() was reached
  // (deadline timer or an early wake-done signal), so tearDownOwnedSandbox
  // is the single place that owns "how to clean up a sandbox this
  // scheduler created." One path in, one path out.
  function tearDownOwnedSandbox(sandboxId, wrapperEl) {
    if (typeof AppSandbox !== 'undefined') {
      try {
        AppSandbox.destroy(sandboxId);
      } catch (err) {
        log('warn', `AppScheduler: AppSandbox.destroy threw for ${sandboxId}`, {
          error: err?.message,
        });
      }
    }

    // wrapperEl is the exact node wake() created and appended — not
    // rediscovered by walking sandbox internals — so this removal is
    // correct regardless of what AppSandbox.launch() does internally with
    // the container it's given.
    if (wrapperEl && wrapperEl.isConnected) {
      wrapperEl.remove();
    }
  }

  // Logging must never be able to take down the caller. A malformed data
  // payload or a broken EventLog shouldn't turn a routine wake/teardown
  // into an uncaught exception.
  function log(level, msg, data) {
    if (typeof window === 'undefined' || !window.EventLog) return;
    try {
      EventLog.log({
        app: 'AppScheduler',
        category: 'system',
        severity: level === 'warn' ? 'warn' : 'info',
        message: msg,
        data,
      });
    } catch {
      // Logging is best-effort. If EventLog itself is broken, there's
      // nowhere safe left to report that — swallow rather than crash the
      // scheduler over a logging failure.
    }
  }

  // Warn once per missing-dependency situation instead of once per app,
  // per cycle, forever. If AppPermissionManager isn't loaded, every app
  // will keep failing this same check every 15 minutes — one warning on
  // first sighting is more useful than silent repeated no-ops.
  let warnedMissingPermissionManager = false;

  /**
   * Every app eligible for a Tier-1 wake right now: installed, not
   * disabled, and actually holding the system:background grant. Mirrors
   * the same three-part eligibility check boot.js uses for autostart
   * (installed && !disabled && grant held) — deliberately consistent
   * rather than inventing a slightly different rule here.
   * @returns {object[]} app objects from OS.apps
   */
  function getEligibleApps() {
    if (typeof OS === 'undefined' || !OS.apps) return [];

    if (typeof AppPermissionManager === 'undefined') {
      if (!warnedMissingPermissionManager) {
        warnedMissingPermissionManager = true;
        log('warn', 'AppScheduler: AppPermissionManager unavailable, no apps are eligible for wake');
      }
      return [];
    }

    let disabled = [];
    try {
      // Registry-backed (HKNU/apps/disabled) via RegistryPrefs.
      disabled = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : [];
    } catch {
      // Corrupt value — treat as none disabled rather than failing eligibility
      // for every app.
    }

    return Object.values(OS.apps).filter((app) => {
      if (!app || !app.id) return false;
      if (disabled.includes(app.id)) return false;
      return AppPermissionManager.isGranted('system:background', app.id);
    });
  }

  /**
   * Find an already-live sandbox for this app sitting in the background
   * host (i.e. a Tier-2 system:background:live instance). Tier 1 should
   * reuse it rather than launching a redundant second sandbox for the
   * same app.
   * @param {string} appId
   * @returns {object|null} sandbox info from AppSandbox.getAllSandboxes()
   */
  function findLiveBackgroundSandbox(appId) {
    if (typeof AppSandbox === 'undefined') return null;
    return (
      AppSandbox.getAllSandboxes().find((s) => s.appId === appId && s.backgrounded) ?? null
    );
  }

  /**
   * Run one wake cycle for a single app: get or create its sandbox,
   * dispatch the wake push, and schedule teardown.
   * @param {object} app
   */
  function wake(app) {
    if (typeof AppSandbox === 'undefined') return;

    const existing = findLiveBackgroundSandbox(app.id);
    let sandboxId;
    let ownedByScheduler;
    let wrapperEl = null;

    if (existing) {
      // Already alive for Tier 2 reasons — just piggyback the wake push,
      // don't touch its lifecycle. Tier 1 didn't create it and doesn't
      // get to destroy it.
      sandboxId = existing.sandboxId;
      ownedByScheduler = false;
    } else {
      const host = document.getElementById('background-app-host');
      if (!host) {
        log('warn', `AppScheduler: no #background-app-host, skipping wake for ${app.id}`);
        return;
      }

      // A fresh headless launch: no window state, into the same hidden
      // host Tier 2 uses. loadAppContent inside launch() is async and
      // fire-and-forget — the wake push below can race ahead of the
      // app's own page load finishing, same as it would for a real user
      // opening the app quickly and the OS sending an early IPC call.
      // That's an acceptable, pre-existing characteristic of this IPC
      // model, not something Tier 1 introduces.
      wrapperEl = document.createElement('div');
      wrapperEl.style.cssText =
        'position:absolute;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      host.appendChild(wrapperEl);

      let result;
      try {
        result = AppSandbox.launch(app, wrapperEl, null, {});
      } catch (err) {
        log('warn', `AppScheduler: launch threw for ${app.id}`, { error: err?.message });
        wrapperEl.remove();
        return;
      }

      if (!result || !result.success) {
        log('warn', `AppScheduler: launch failed for ${app.id}, skipping wake`);
        wrapperEl.remove();
        return;
      }
      sandboxId = result.sandboxId;
      ownedByScheduler = true;
    }

    if (pendingWakes.has(sandboxId)) {
      // Already mid-wake (e.g. two intervals overlapped for a slow app) —
      // don't double-dispatch or double-schedule teardown. If this wake
      // owns a wrapper no one else knows about yet, it has to be cleaned
      // up here rather than leaked, since nothing else holds a reference
      // to it.
      if (ownedByScheduler) tearDownOwnedSandbox(sandboxId, wrapperEl);
      return;
    }

    let dispatched;
    try {
      dispatched = AppSandbox.dispatchBackgroundWake(sandboxId, {
        wokeAt: Temporal.Now.instant().toString(),
        deadlineMs: WAKE_DEADLINE_MS,
      });
    } catch (err) {
      log('warn', `AppScheduler: dispatch threw for ${app.id} (sandbox ${sandboxId})`, {
        error: err?.message,
      });
      if (ownedByScheduler) tearDownOwnedSandbox(sandboxId, wrapperEl);
      return;
    }

    if (!dispatched) {
      log('warn', `AppScheduler: dispatch failed for ${app.id} (sandbox ${sandboxId})`);
      if (ownedByScheduler) tearDownOwnedSandbox(sandboxId, wrapperEl);
      return;
    }

    const timeoutId = setTimeout(() => endWake(sandboxId), WAKE_DEADLINE_MS);
    pendingWakes.set(sandboxId, { timeoutId, appId: app.id, ownedByScheduler, wrapperEl });

    log('info', `AppScheduler: woke ${app.id}`, { sandboxId, ownedByScheduler });
  }

  /**
   * End a wake cycle for a sandbox — called either when the deadline
   * timer fires, or early via _markWakeDone(). Only actually tears down
   * the sandbox if the scheduler was the one that created it; a
   * piggybacked Tier-2 sandbox is left running.
   * @param {string} sandboxId
   */
  function endWake(sandboxId) {
    const pending = pendingWakes.get(sandboxId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    pendingWakes.delete(sandboxId);

    if (pending.ownedByScheduler) {
      tearDownOwnedSandbox(sandboxId, pending.wrapperEl);
    }

    log('info', 'AppScheduler: ended wake', {
      sandboxId,
      ownedByScheduler: pending.ownedByScheduler,
    });
  }

  /**
   * Called from AppSandbox.handleBackgroundWakeDone when an app signals
   * it's finished early via nova.backgroundWakeDone(). Internal — not
   * part of the intended public surface, hence the leading underscore,
   * but must be reachable from app-sandbox.js.
   * @param {string} sandboxId
   */
  function _markWakeDone(sandboxId) {
    endWake(sandboxId);
  }

  /**
   * Sweep every eligible app and wake each one. Exposed so it can also be
   * triggered manually (e.g. from a debug/inspector panel) without
   * waiting for the next interval tick.
   *
   * Each app's wake is isolated with try/catch — one app throwing (a bad
   * launch, a broken dispatch) shouldn't stop the rest of the sweep from
   * running. Without this, a single misbehaving app could silently cost
   * every other eligible app its wake for that entire 15-minute cycle.
   */
  function runWakeCycle() {
    const apps = getEligibleApps();
    for (const app of apps) {
      try {
        wake(app);
      } catch (err) {
        log('warn', `AppScheduler: wake threw for ${app?.id}`, { error: err?.message });
      }
    }
  }

  /**
   * Request a one-off Tier-1 wake for a single app, right now, instead of
   * waiting for the next sweep tick. Used by push delivery: a message for
   * a fully-closed app that holds system:background gets queued and the
   * app is woken so the queue flushes right after the sandbox's ready
   * handshake (the same bounded wake window, deadline, and teardown as a
   * scheduled wake — requestWake is a trigger, not a new execution tier).
   *
   * Mirrors getEligibleApps()'s three-part eligibility (installed, not
   * disabled, holds system:background) for the one app. Returns whether a
   * wake was actually dispatched — a false return is honest: the caller
   * (push delivery) still has the message queued for next launch either
   * way, and the OS-attributed notification path does not depend on it.
   * @param {string} appId
   * @returns {boolean}
   */
  function requestWake(appId) {
    if (typeof appId !== 'string' || !appId) return false;
    if (typeof OS === 'undefined' || !OS.apps || !OS.apps[appId]) return false;
    if (typeof AppPermissionManager === 'undefined' || !AppPermissionManager.isGranted) return false;
    if (!AppPermissionManager.isGranted('system:background', appId)) return false;
    let disabled = [];
    try {
      disabled = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : [];
    } catch {
      disabled = [];
    }
    if (disabled.includes(appId)) return false;
    try {
      wake(OS.apps[appId]);
      return true;
    } catch (err) {
      log('warn', `AppScheduler: requestWake threw for ${appId}`, { error: err?.message });
      return false;
    }
  }

  /**
   * Start the periodic scheduler. Safe to call more than once — a second
   * call is a no-op rather than stacking duplicate intervals.
   */
  function start() {
    if (running) return;
    running = true;
    intervalId = setInterval(runWakeCycle, WAKE_INTERVAL_MS);
    log('info', 'AppScheduler started', { intervalMs: WAKE_INTERVAL_MS });
  }

  /**
   * Stop the periodic scheduler and cancel any in-flight wake deadlines.
   * Does not tear down live Tier-2 sandboxes (not the scheduler's to
   * manage) but does clean up any scheduler-owned sandbox mid-wake.
   */
  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    running = false;
    for (const sandboxId of [...pendingWakes.keys()]) {
      endWake(sandboxId);
    }
    log('info', 'AppScheduler stopped');
  }

  return {
    start,
    stop,
    runWakeCycle,
    getEligibleApps,
    requestWake,

    // Internal — called from app-sandbox.js's wake-done IPC handler, and
    // by tests. Not covered by stability guarantees.
    _markWakeDone,
    _pendingWakes: pendingWakes,
  };
})();

window.AppScheduler = AppScheduler;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppScheduler;
}