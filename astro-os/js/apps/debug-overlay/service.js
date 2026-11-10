/**
 * AstroOS — Debug Overlay
 * ─────────────────────────────────────────────────────────────
 * Developer-mode HUD inspired by Minecraft F3.
 * Shows FPS, memory, window count, workspace, and runtime info.
 * Toggle with F3 or Ctrl+Shift+D.
 * Drag the header to reposition; position persists in localStorage
 * (separate from OS.settings.debugOverlayVisible, which only tracks
 * whether the overlay is shown at all).
 * Clicks pass through the overlay to windows behind it.
 */

const DebugOverlay = (() => {
  'use strict';

  let _el        = null;
  let _enabled   = false;
  let _rafId     = null;
  let _frames    = 0;
  let _fps       = 0;
  let _lastFpsUpdate = 0;
  let _lastFrameTime = 0;
  let _frameTimeMs   = 0;
  let _dragState = null;
  let _gpuCache  = null;

  const STORAGE_KEY = 'debug_overlay_pos';

  function _loadPos() {
    // Registry-backed (HKND/overlay/position) via RegistryPrefs, with the
    // old localStorage key as the fail-soft fallback inside the helper.
    try {
      if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.overlayPosition) {
        const p = RegistryPrefs.overlayPosition();
        if (p) return p;
      }
    } catch {}
    return null;
  }

  function _savePos(x, y) {
    try { if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setOverlayPosition) RegistryPrefs.setOverlayPosition(x, y); } catch {}
  }

  function _create() {
    if (_el) return _el;

    _el = document.createElement('div');
    _el.id = 'debug-overlay';

    const saved = _loadPos();
    // Same clamp the drag handler applies during pointermove — without it,
    // a stale saved position from a larger screen (or a corrupted/tampered
    // localStorage value) would place the overlay off-screen with no way
    // to drag it back into view, since you can't drag what you can't see.
    const top = saved ? Math.max(0, Math.min(saved.y, window.innerHeight - 20)) : 8;
    const left = saved ? Math.max(0, Math.min(saved.x, window.innerWidth - 60)) : 8;

    _el.style.cssText = `
      position: fixed;
      top: ${top}px;
      left: ${left}px;
      z-index: 99999;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #0f0;
      background: transparent;
      padding: 0;
      border-radius: 6px;
      pointer-events: none;
      user-select: none;
      white-space: pre;
      border: none;
      text-shadow: 0 0 6px rgba(0, 0, 0, 0.95), 0 0 3px rgba(0, 0, 0, 0.8), 1px 1px 0 rgba(0,0,0,0.9);
      transition: opacity 0.2s;
    `;

    // Drag handle — top strip with header text, receives pointer events
    const handle = document.createElement('div');
    handle.className = 'debug-drag-handle';
    handle.style.cssText = `
      width: 100%;
      cursor: grab;
      pointer-events: auto;
      touch-action: none;
      padding: 4px 10px 2px;
      box-sizing: border-box;
    `;
    _el.appendChild(handle);

    // Content area — clicks pass through
    const content = document.createElement('div');
    content.className = 'debug-content';
    content.style.cssText = `
      pointer-events: none;
      padding: 0 10px 6px;
    `;
    _el.appendChild(content);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _dragState = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: _el.offsetLeft,
        origTop: _el.offsetTop,
      };
      _el.setPointerCapture(e.pointerId);
      handle.style.cursor = 'grabbing';
    });

    _el.addEventListener('pointermove', (e) => {
      if (!_dragState) return;
      const dx = e.clientX - _dragState.startX;
      const dy = e.clientY - _dragState.startY;
      let newLeft = _dragState.origLeft + dx;
      let newTop = _dragState.origTop + dy;
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 60));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 20));
      _el.style.left = newLeft + 'px';
      _el.style.top = newTop + 'px';
    });

    const endDrag = () => {
      if (!_dragState) return;
      _savePos(_el.offsetLeft, _el.offsetTop);
      _dragState = null;
      handle.style.cursor = 'grab';
    };
    _el.addEventListener('pointerup', endDrag);
    _el.addEventListener('pointercancel', endDrag);

    document.body.appendChild(_el);
    return _el;
  }

  // ── Info getters ───────────────────────────────────────────────────────────

  function _getMemory() {
    if (typeof performance !== 'undefined' && performance.memory) {
      const mb = performance.memory.usedJSHeapSize / 1048576;
      const limit = performance.memory.jsHeapSizeLimit / 1048576;
      return `${mb.toFixed(1)} / ${limit.toFixed(0)} MB`;
    }
    return 'N/A';
  }

  function _getWindowCount() {
    if (typeof OS !== 'undefined' && OS.windows) {
      return String(OS.windows.size || 0);
    }
    return '?';
  }

  function _getInstalledApps() {
    if (typeof OS !== 'undefined' && OS.apps) {
      return String(Object.keys(OS.apps).length);
    }
    if (typeof APP_REGISTRY !== 'undefined') {
      return String(APP_REGISTRY.length);
    }
    return '?';
  }

  function _getActiveApp() {
    if (typeof OS !== 'undefined') {
      if (OS._activeAppId) return OS._activeAppId;
      if (OS.focusedWindowId) {
        const win = OS.windows?.get(OS.focusedWindowId);
        if (win) return win.appId || win.app || '?';
      }
    }
    return '-';
  }

  function _getActiveWindowState() {
    if (typeof OS !== 'undefined' && OS.focusedWindowId) {
      const win = OS.windows?.get(OS.focusedWindowId);
      if (win) {
        // Window state fields (x/y/width/height/minimized/maximized) are
        // flat on the object stored by OS.windows.set(id, state) — see
        // wm.js line 159, and usages like state.minimized / w.state.minimized
        // (wm.js:879,993, where `w` is the window row and `w.state` is that
        // same flat object, not a nested sub-state). Reading win.state here
        // was always undefined, so this line silently printed "0,0 ?x?" for
        // the focused window regardless of its real geometry.
        const pos = `${win.x || 0},${win.y || 0}`;
        const size = `${win.width || '?'}x${win.height || '?'}`;
        const flags = (win.minimized ? ' [min]' : '') + (win.maximized ? ' [max]' : '') + (win.fullscreen ? ' [fs]' : '');
        return `${pos} ${size}${flags}`;
      }
    }
    return '-';
  }

  function _getBootTime() {
    if (typeof performance !== 'undefined' && performance.timing) {
      const t = performance.timing;
      const load = t.loadEventEnd - t.navigationStart;
      if (load > 0) return (load / 1000).toFixed(2) + 's';
    }
    return 'N/A';
  }

  function _getWorkspace() {
    if (typeof OS !== 'undefined' && OS.currentWorkspace) {
      const ws = OS.workspaces?.find(w => w.id === OS.currentWorkspace);
      return ws ? ws.name : OS.currentWorkspace;
    }
    return '-';
  }

  function _getCPU() {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      return navigator.hardwareConcurrency + ' cores';
    }
    return 'N/A';
  }

  function _getNWVersions() {
    try {
      const nw = typeof process !== 'undefined' ? process.versions : null;
      const parts = [];
      if (nw?.nw) parts.push('NW ' + nw.nw);
      if (nw?.chrome) parts.push('Chromium ' + nw.chrome);
      if (nw?.node) parts.push('Node ' + nw.node);
      if (parts.length) return parts.join(' · ');
    } catch {}
    return 'N/A';
  }

  function _getGPU() {
    if (_gpuCache) return _gpuCache;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      // Only the success path below used to cache into _gpuCache. Without
      // WebGL support, this branch would run again on every frame for as
      // long as the overlay stayed open — recreating a canvas and
      // re-attempting getContext('webgl') every single time, on exactly
      // the machines least able to afford that. Caching the negative
      // result makes this a one-time check like the success path already
      // is.
      if (!gl) return _gpuCache = 'No WebGL';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        return _gpuCache = renderer.length > 40 ? renderer.slice(0, 40) + '...' : renderer;
      }
      return _gpuCache = gl.getParameter(gl.RENDERER);
    } catch {
      // Same reasoning — cache the failure so a machine that throws here
      // (rather than just lacking WebGL) doesn't retry every frame either.
      return _gpuCache = 'N/A';
    }
  }

  function _getUptime() {
    if (typeof performance !== 'undefined' && performance.timeOrigin) {
      const s = Math.floor((Date.now() - performance.timeOrigin) / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + 'h ' + (m % 60) + 'm';
      if (m > 0) return m + 'm ' + (s % 60) + 's';
      return s + 's';
    }
    return 'N/A';
  }

  function _getFrameTime() {
    if (typeof performance !== 'undefined') {
      return _frameTimeMs.toFixed(1) + ' ms';
    }
    return 'N/A';
  }

  function _getDOMNodes() {
    if (typeof document !== 'undefined') {
      return String(document.querySelectorAll('*').length);
    }
    return '?';
  }

  function _getStorageStats() {
    const parts = [];
    try {
      parts.push('localStorage: ' + Object.keys(localStorage).length);
    } catch {}
    try {
      parts.push('sessionStorage: ' + Object.keys(sessionStorage).length);
    } catch {}
    try {
      // typeof, not a bare reference — caches is restricted to secure
      // contexts and isn't guaranteed to exist. Optional chaining alone
      // wouldn't have caught that: `caches?.keys` still throws a
      // ReferenceError if `caches` itself is undeclared, since ?. only
      // guards against a value being nullish once the identifier's
      // already resolved. This line happened to be safe anyway because
      // it's in its own try/catch, but that's a fragile thing to depend
      // on — matching the typeof pattern every other check here uses
      // makes the actual safety mechanism visible instead of implicit.
      parts.push('caches: ' + (typeof caches !== 'undefined' && caches?.keys ? 'available' : 'none'));
    } catch {}
    return parts.join(' · ') || 'N/A';
  }

  function _getOnlineStatus() {
    if (typeof navigator !== 'undefined') {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const status = navigator.onLine ? 'online' : 'offline';
      if (conn) {
        return `${status} (${conn.effectiveType || '?'})`;
      }
      return status;
    }
    return 'N/A';
  }

  function _getLanguage() {
    if (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function') {
      return OS.settings.get('region') || 'N/A';
    }
    if (typeof navigator !== 'undefined') {
      return navigator.language || 'N/A';
    }
    return 'N/A';
  }

  function _getTimezone() {
    if (typeof Intl !== 'undefined') {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'N/A';
    }
    return 'N/A';
  }

  function _getBatteryLine() {
    if (typeof navigator !== 'undefined' && navigator.getBattery) {
      return _el?.dataset?.battery || 'Battery:      ...';
    }
    return 'Battery:      N/A';
  }

  function _copyDebugInfo() {
    const text = _el?.textContent || '';
    if (navigator.clipboard && text) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function _getPerfEntries() {
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        const dns = nav.domainLookupEnd - nav.domainLookupStart;
        const tcp = nav.connectEnd - nav.connectStart;
        const ttfb = nav.responseStart - nav.requestStart;
        const download = nav.responseEnd - nav.responseStart;
        return `DNS: ${dns.toFixed(0)}ms · TCP: ${tcp.toFixed(0)}ms · TTFB: ${ttfb.toFixed(0)}ms · DL: ${download.toFixed(0)}ms`;
      }
    }
    return 'N/A';
  }

  // Long-task tracking state. Previously _getLongTasks() created a brand
  // new PerformanceObserver on *every* call (it's invoked from _update(),
  // i.e. every rAF frame) and returned inside the async callback, which
  // has no effect on the caller — the function always synchronously
  // returned the hardcoded 'No long tasks >50ms' string regardless of
  // what actually happened, while leaking a new observer + subscription
  // every frame that was never disconnected. Also 'longtask' is
  // deprecated in Chrome in favor of 'long-animation-frame' (see perf.js
  // for the same fix applied there). This sets up a single observer once
  // and accumulates a real count.
  let _longTaskCount = 0;
  let _longTaskSupported = false;
  let _longTaskObserver = null;

  function _initLongTaskObserver() {
    if (_longTaskObserver || typeof PerformanceObserver === 'undefined') return;
    const supportedTypes = PerformanceObserver.supportedEntryTypes || [];
    const entryType = supportedTypes.includes('long-animation-frame')
      ? 'long-animation-frame'
      : (supportedTypes.includes('longtask') ? 'longtask' : null);
    if (!entryType) return;
    try {
      _longTaskObserver = new PerformanceObserver((list) => {
        _longTaskCount += list.getEntries().filter(e => e.duration > 50).length;
      });
      _longTaskObserver.observe({ type: entryType, buffered: true });
      _longTaskSupported = true;
    } catch {
      _longTaskSupported = false;
    }
  }

  function _getLongTasks() {
    if (!_longTaskSupported) return 'N/A';
    return _longTaskCount > 0 ? _longTaskCount + ' (>50ms)' : 'No long tasks >50ms';
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function _update() {
    if (!_enabled || !_el) return;

    _frames++;
    const now = performance.now();
    _frameTimeMs = _lastFrameTime ? (now - _lastFrameTime) : 0;
    _lastFrameTime = now;
    if (now - _lastFpsUpdate >= 500) {
      _fps = Math.round((_frames * 1000) / (now - _lastFpsUpdate));
      _lastFpsUpdate = now;
      _frames = 0;
    }

    // Async battery
    if (navigator.getBattery && !_el.dataset._battInit) {
      _el.dataset._battInit = '1';
      navigator.getBattery().then(b => {
        if (!_el) return;
        const level = Math.round(b.level * 100) + '%';
        const charging = b.charging ? ' (charging)' : '';
        _el.dataset.battery = `Battery:      ${level}${charging}`;
      }).catch(() => {
        if (_el) _el.dataset.battery = 'Battery:      N/A';
      });
    }

    const headerText = `AstroOS v${typeof OS !== 'undefined' ? OS.version : '?'}  [Dev Mode]`;
    const restLines = [
      `─────────────────────────────`,
      `FPS:          ${_fps}`,
      `Frame Time:   ${_getFrameTime()}`,
      `Boot Time:    ${_getBootTime()}`,
      `Uptime:       ${_getUptime()}`,
      `─────────────────────────────`,
      `Memory:       ${_getMemory()}`,
      `CPU:          ${_getCPU()}`,
      `Platform:     ${typeof navigator !== 'undefined' ? navigator.platform : 'N/A'}`,
      `NW:           ${_getNWVersions()}`,
      `GPU:          ${_getGPU()}`,
      `─────────────────────────────`,
      `Windows:      ${_getWindowCount()}`,
      `Apps:         ${_getInstalledApps()}`,
      `Workspace:    ${_getWorkspace()}`,
      `Active App:   ${_getActiveApp()}`,
      `Win Geometry: ${_getActiveWindowState()}`,
      `DOM Nodes:    ${_getDOMNodes()}`,
      `─────────────────────────────`,
      `Screen:       ${screen.width}x${screen.height}`,
      `Viewport:     ${window.innerWidth}x${window.innerHeight}`,
      `Device Pixel: ${window.devicePixelRatio}`,
      `Online:       ${_getOnlineStatus()}`,
      `${_getBatteryLine()}`,
      `─────────────────────────────`,
      `Storage:      ${_getStorageStats()}`,
      `Language:     ${_getLanguage()}`,
      `Timezone:     ${_getTimezone()}`,
      `Net Timing:   ${_getPerfEntries()}`,
      `Long Tasks:   ${_getLongTasks()}`,
      `─────────────────────────────`,
      `URL:          ${window.location.href.slice(0, 40)}`,
    ];

    const handleEl = _el.querySelector('.debug-drag-handle');
    const contentEl = _el.querySelector('.debug-content');
    if (handleEl) handleEl.textContent = headerText;
    if (contentEl) contentEl.textContent = restLines.join('\n');
    _rafId = requestAnimationFrame(_update);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function enable() {
    if (_enabled) return;
    // F3 in system-events.js calls toggle() with no devMode check of its
    // own — boot.js and the Settings toggle both check devMode before
    // calling enable(), but F3 didn't, so pressing it would show the
    // overlay even with Developer Mode off. Gating here instead of only
    // at each call site means every current and future caller is covered,
    // not just the ones that remember to check first.
    if (typeof OS !== 'undefined' && OS.settings && !OS.settings.get('devMode')) return;
    _enabled = true;
    if (typeof OS !== 'undefined' && OS.settings) OS.settings.set('debugOverlayVisible', true);
    _create();
    _el.style.opacity = '1';
    _lastFpsUpdate = performance.now();
    _frames = 0;
    _lastFrameTime = 0;
    _frameTimeMs = 0;
    _longTaskCount = 0;
    _initLongTaskObserver();
    _rafId = requestAnimationFrame(_update);
  }

  function disable() {
    _enabled = false;
    if (typeof OS !== 'undefined' && OS.settings) OS.settings.set('debugOverlayVisible', false);
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    if (_longTaskObserver) {
      _longTaskObserver.disconnect();
      _longTaskObserver = null;
      _longTaskSupported = false;
    }
    if (_el) {
      _el.style.opacity = '0';
      setTimeout(() => {
        if (_el && _el.parentNode) {
          _el.parentNode.removeChild(_el);
        }
        _el = null;
      }, 200);
    }
  }

  function toggle() {
    if (_enabled) disable(); else enable();
    return _enabled;
  }

  function isEnabled() {
    return _enabled;
  }

  return { enable, disable, toggle, isEnabled, _copyDebugInfo };
})();

window.DebugOverlay = DebugOverlay;