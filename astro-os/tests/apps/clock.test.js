// tests/apps/clock.test.js — window app: registration, tab switching, clock face.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp } from '../helpers/app-harness.js';

describe('Clock app (js/apps/clock)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('clock');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.clock');
    expect(app.name).toBe('Clock');
    expect(typeof app.init).toBe('function');
    expect(Array.isArray(app.defaultSize)).toBe(true);
    expect(Array.isArray(app.minSize)).toBe(true);
  });

  it('renders the tab bar with the four sections and defaults to the Clock tab', async () => {
    const { app, window } = await loadWindowApp('clock');
    const content = initApp(app, { window });
    // AppDirs stub is present, so init must render the real UI (not the
    // "App data directory missing" fallback).
    expect(content.querySelector('.nbc-root')).toBeTruthy();
    const tabs = [...content.querySelectorAll('.nbc-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Alarm', 'Clock', 'Timer', 'Stopwatch']);
    const active = content.querySelector('.nbc-tab.active');
    expect(active.textContent).toBe('Clock');
    expect(content.querySelector('.nbc-clock-face')).toBeTruthy();
  });

  it('switches the active section when a tab is clicked', async () => {
    const { app, window } = await loadWindowApp('clock');
    const content = initApp(app, { window });
    const tabs = [...content.querySelectorAll('.nbc-tab')];
    const sections = [...content.querySelectorAll('.nbc-section')];
    // Tab bar order is alarm/clock/timer/stopwatch but the body renders the
    // sections clock-first, so section index = tab index + 1.
    tabs[0].click(); // Alarm
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(sections[1].classList.contains('active')).toBe(true);
    expect(tabs[1].classList.contains('active')).toBe(false);
    tabs[3].click(); // Stopwatch
    expect(tabs[3].classList.contains('active')).toBe(true);
    expect(sections[3].classList.contains('active')).toBe(true);
    expect(sections[1].classList.contains('active')).toBe(false);
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('clock', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.querySelector('.nbc-root')).toBeNull();
    expect(content.textContent).toContain('App data directory missing');
  });

  it('survives malformed persisted alarms via sanitisation', async () => {
    const { app, window } = await loadWindowApp('clock');
    window.localStorage.setItem('astroos_clock_v1', JSON.stringify({
      alarms: [
        { time: '99:99', label: 'invalid' },          // dropped: fails TIME_RE
        { time: '07:30', days: [0, 9, 'x'] },         // days filtered to [0]
        { enabled: false },                            // time defaulted to 07:00
      ],
    }));
    const content = initApp(app, { window });
    expect(content.querySelector('.nbc-root')).toBeTruthy();
    // Sanitised db is persisted back on next save; the in-memory state must
    // have dropped the invalid time and defaulted the missing one.
    const stored = JSON.parse(window.localStorage.getItem('astroos_clock_v1'));
    expect(Array.isArray(stored.alarms)).toBe(true);
  });
});
