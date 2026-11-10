'use strict';

// TRAY — WiFi

const trayWifi = document.getElementById('tray-wifi');
if (trayWifi) {
  trayWifi.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('wifi-popup');
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = 'wifi-popup';
    popup.style.cssText =
      'position:fixed;bottom:60px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--r-md);padding:16px;min-width:200px;z-index:9999;box-shadow:var(--shadow-md)';
    document.body.appendChild(popup);

    // Dismiss on any outside click. Looked up by id inside the handler so
    // reopening the popup doesn't leave stale closures over a removed element.
    document.addEventListener('click', () => {
      document.getElementById('wifi-popup')?.remove();
    }, { once: true });

    const rect = trayWifi.getBoundingClientRect();
    popup.style.left = Math.max(0, rect.left - 80) + 'px';

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:600;margin-bottom:8px;';
    header.textContent = 'Network';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;';
    const dot = document.createElement('span');
    const statusText = document.createElement('span');
    // navigator.onLine only means "an interface is up", which is true with the
    // virtual cable unplugged. Ask NetworkManager for real connectivity.
    const setState = (color, text) => {
      dot.style.color = color;
      statusText.textContent = text;
    };
    setState('var(--text-muted)', 'Checking network…');
    row.append(dot, statusText);

    popup.append(header, row);

    const nm = window.NovaByteSystem?.hardware?.network;
    if (nm && typeof nm.getStatus === 'function') {
      nm.getStatus().then((status) => {
        if (!status || !status.supported) {
          const up = navigator.onLine;
          setState(up ? 'var(--text-success)' : 'var(--text-danger)', up ? 'Connected to network' : 'No internet connection');
        } else if (status.connectivity === 'full') {
          setState('var(--text-success)', 'Connected to the internet');
        } else if (status.connectivity === 'limited' || status.connectivity === 'portal') {
          setState('var(--text-warning, orange)', 'Connected, but no internet access');
        } else if (status.connectivity === 'unknown' && /^connected/.test(status.networkState)) {
          // NM has no connectivity-check URI configured; trust the link state.
          setState('var(--text-success)', 'Connected to network');
        } else {
          setState('var(--text-danger)', status.networkState === 'disconnected' ? 'Not connected (check the network cable/adapter)' : 'No internet connection');
        }
      }).catch(() => setState('var(--text-danger)', 'Network status unavailable'));
    } else {
      const up = navigator.onLine;
      setState(up ? 'var(--text-success)' : 'var(--text-danger)', up ? 'Connected to network' : 'No internet connection');
    }
  });
}

// TRAY — Volume

// Guard all four elements — any one missing would throw on addEventListener.
const volumeBtn = document.getElementById('tray-volume');
const volumePopup = document.getElementById('volume-popup');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');

if (volumeBtn && volumePopup && volumeSlider && volumeValue) {
  let volumePopupPinned = false;

  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = volumeBtn.getBoundingClientRect();
    volumePopup.style.left = rect.left + 'px';
    volumePopup.style.bottom = '60px';
    volumePopup.classList.toggle('active');
  });

  volumeBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    volumePopupPinned = !volumePopupPinned;
  });

  volumeSlider.addEventListener('click', (e) => { e.stopPropagation(); });

  // Pushes the current system volume into every <audio>/<video> element inside
  // every open browser window's webview(s). Exposed on OS so browser.js can
  // call it for a freshly-created webview too (new tabs/popups otherwise
  // wouldn't pick up the system volume until the user next touched the slider).
  OS.applyVolumeToWebviews = function applyVolumeToWebviews(volumePercent, targetWebview) {
    if (!Number.isFinite(volumePercent)) return;
    // Clamp and JSON-stringify the volume before injecting it into webview
    // JavaScript. Never build the executed source by concatenating a value
    // directly into it — even one that's "supposed" to be a safe number —
    // because if this pattern gets copied elsewhere with a less-trusted
    // value, it becomes an injection point.
    const safeVolume = Math.min(1, Math.max(0, volumePercent / 100));
    const volumeLiteral = JSON.stringify(safeVolume);
    const code =
      `(function(){var v=${volumeLiteral};` +
      `document.querySelectorAll('audio,video').forEach(function(el){el.volume=v;});})();`;

    // NW.js <webview> exposes executeScript({code}, callback) — there is no
    // executeJavaScript() (that's Electron's API name, not NW.js's), so a
    // single specific webview can be targeted directly (e.g. right after
    // it's created) without waiting for the slider to fire again.
    const pushTo = (webview) => {
      if (typeof webview.executeScript !== 'function') return;
      try {
        webview.executeScript({ code }, () => {
          // Swallow chrome.runtime.lastError: an inactive/not-yet-ready
          // webview rejecting the call shouldn't surface as a console error.
          void chrome?.runtime?.lastError;
        });
      } catch (_) { /* webview not ready yet — ignore */ }
    };

    if (targetWebview) { pushTo(targetWebview); return; }

    if (!OS.windows) return;
    for (const state of OS.windows.values()) {
      if (state.appId !== 'com.nbosp.browser') continue;
      const webviews = state.element?.querySelectorAll?.('webview');
      if (!webviews) continue;
      for (const webview of webviews) pushTo(webview);
    }
  };

  volumeSlider.addEventListener('input', () => {
    // Number() returns NaN for garbage input; parseInt with radix works too but
    // Number() is stricter about rejecting trailing chars. NaN is rejected below.
    const newVolume = Number(volumeSlider.value);
    if (!Number.isFinite(newVolume)) return;

    OS.volume = newVolume;
    volumeValue.textContent = newVolume + '%';
    OS.events?.emit?.('os:volumeChanged', { volume: newVolume });

    OS.applyVolumeToWebviews(newVolume);
  });

  volumePopup.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('click', () => {
    if (!volumePopupPinned) volumePopup.classList.remove('active');
  });
}

// TRAY — Calendar

// Guard all elements — any one missing would throw on addEventListener.
const trayClock = document.getElementById('tray-clock');
const calendarPopup = document.getElementById('calendar-popup');
const calendarPopupTitle = document.getElementById('calendar-popup-title');
const calendarPopupWeekdays = document.getElementById('calendar-popup-weekdays');
const calendarPopupGrid = document.getElementById('calendar-popup-grid');
const calendarPopupPrev = document.getElementById('calendar-popup-prev');
const calendarPopupNext = document.getElementById('calendar-popup-next');

if (trayClock && calendarPopup && calendarPopupTitle && calendarPopupWeekdays &&
    calendarPopupGrid && calendarPopupPrev && calendarPopupNext) {
  // The month currently shown in the popup — defaults to today's month and
  // resets back to it every time the popup is (re)opened, matching the
  // Windows 11 clock-flyout behavior in the reference screenshot.
  let viewYear = 0;
  let viewMonth = 0;

  function renderCalendarPopup() {
    const today = new Date();
    const first = new Date(viewYear, viewMonth, 1);
    calendarPopupTitle.textContent =
      first.toLocaleDateString([], { month: 'long', year: 'numeric' });

    // Weekday header — Monday-first, matching the reference screenshot
    // (Mo Tu We Th Fr Sa Su) rather than the US Sunday-first convention.
    calendarPopupWeekdays.innerHTML = '';
    // Jan 5 1970 was a Monday — cheap way to get locale-correct short
    // weekday labels in Monday-first order without hardcoding names.
    for (let i = 0; i < 7; i++) {
      const label = new Date(1970, 0, 5 + i).toLocaleDateString([], { weekday: 'short' });
      calendarPopupWeekdays.appendChild(
        Object.assign(document.createElement('span'), { textContent: label }));
    }

    // getDay() is Sunday-first (0-6); convert to Monday-first (0-6) so the
    // grid lines up under the weekday header above.
    const firstWeekday = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    calendarPopupGrid.innerHTML = '';
    const addDay = (dayNum, outside) => {
      const span = document.createElement('span');
      span.textContent = String(dayNum);
      if (outside) span.classList.add('is-outside-month');
      calendarPopupGrid.appendChild(span);
      return span;
    };

    // Leading days from the previous month, to fill the grid to a Monday start.
    for (let i = firstWeekday - 1; i >= 0; i--) {
      addDay(daysInPrevMonth - i, true);
    }
    // Days in the current month — highlight today if it falls in this month.
    for (let d = 1; d <= daysInMonth; d++) {
      const span = addDay(d, false);
      if (viewYear === today.getFullYear() && viewMonth === today.getMonth() && d === today.getDate()) {
        span.classList.add('is-today');
      }
    }
    // Trailing days from the next month. Always pad out to exactly 6 rows
    // (42 cells total), not just "however many the month needs" — a 5-row
    // month (e.g. Sept 2024) and a 6-row month (e.g. Oct 2024) would
    // otherwise produce different grid heights, which shifts the whole
    // popup's position on every month change since it's bottom-anchored.
    const cellsSoFar = firstWeekday + daysInMonth;
    const trailing = 42 - cellsSoFar;
    for (let d = 1; d <= trailing; d++) {
      addDay(d, true);
    }
  }

  trayClock.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !calendarPopup.classList.contains('active');
    if (opening) {
      const today = new Date();
      viewYear = today.getFullYear();
      viewMonth = today.getMonth();
      renderCalendarPopup();
      const rect = trayClock.getBoundingClientRect();
      calendarPopup.style.left = 'auto';
      calendarPopup.style.right = (window.innerWidth - rect.right) + 'px';
      calendarPopup.style.bottom = (window.innerHeight - rect.top) + 'px';
    }
    calendarPopup.classList.toggle('active', opening);
  });

  calendarPopupPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendarPopup();
  });

  calendarPopupNext.addEventListener('click', (e) => {
    e.stopPropagation();
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendarPopup();
  });

  calendarPopup.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('click', () => {
    calendarPopup.classList.remove('active');
  });
}

// TRAY — Battery

// Track the battery object and its listeners so re-calling updateBattery (e.g.
// after a theme change) doesn't stack duplicate levelchange listeners.
let _batteryWatch = null;

async function updateBattery() {
  const batteryBtn = document.getElementById('tray-battery');
  if (!batteryBtn) return;
  if (!('getBattery' in navigator)) return;

  try {
    const battery = await navigator.getBattery();

    // If we're already watching this same battery object, don't re-subscribe.
    if (_batteryWatch?.battery === battery) return;
    // If we were watching a different one (page reload preserved the getter
    // result but the closure went stale), drop the old listener first.
    if (_batteryWatch) {
      _batteryWatch.battery.removeEventListener('levelchange', _batteryWatch.update);
    }

    const update = () => {
      const level = Math.round(battery.level * 100);
      batteryBtn.textContent = '';
      const span = document.createElement('span');
      span.style.fontSize = '11px';
      span.textContent = `${level}%`;
      batteryBtn.appendChild(span);
    };

    battery.addEventListener('levelchange', update);
    _batteryWatch = { battery, update };
    update();
  } catch { /* getBattery rejected — battery info unavailable, silently ignore */ }
}
updateBattery();

window.TrayService = Object.freeze({ applyVolumeToWebviews: OS.applyVolumeToWebviews });
