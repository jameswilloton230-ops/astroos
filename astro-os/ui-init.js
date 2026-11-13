'use strict';
/**
 * ui-init.js — wires up event listeners that were previously inline
 * event handler attributes (onclick, onerror) in index.html.
 *
 * Kept separate from app.js so server.js can add a nonce to it via the
 * same regex it uses for app.js.
 */
document.addEventListener('DOMContentLoaded', function () {

  // ── Tray icon image fallback ─────────────────────────────────────────────
  // Previously: onerror="this.style.visibility='hidden'"
  // IDs assigned to the img tags in index.html for stable targeting.
  ['tray-volume-img', 'tray-wifi-img', 'tray-bell-img'].forEach(function (id) {
    var img = document.getElementById(id);
    if (img) {
      img.addEventListener('error', function () {
        img.style.visibility = 'hidden';
      });
    }
  });

  // ── Developer keyboard shortcuts ─────────────────────────────────────────
  // Previously: inline <script> block in index.html (line ~743).
  // F12 / Ctrl+Shift+I  →  toggle Chrome DevTools (NW.js only)
  // F5  / Ctrl+R        →  hot-reload the page
  // F11                 →  toggle fullscreen (in-page, not a global hotkey)
  // Ctrl+F5             →  BLOCKED — a hard cache-bypassing reload wipes
  //                        OS state and is never wanted on a locked-down
  //                        AstroOS session (a plain F5/Ctrl+R reload stays
  //                        available for development).
  // PrintScreen         →  deliberately untouched here so the OS screenshot
  //                        layer (system-events) keeps handling it.
  function isFullscreenSetupOpen() {
    const windows = window.OS?.windows;
    return !!windows && [...windows.values()].some(state =>
      state.appId === 'com.astroos.setup' && state.fullscreen === true
    );
  }

  window.addEventListener('keydown', function (e) {
    if (isFullscreenSetupOpen()) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape' ||
          e.key === 'PrintScreen' || /^F\d+$/.test(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    // Ctrl+F5 (and Ctrl+Shift+F5) — blocked outright.
    if ((e.ctrlKey || e.metaKey) && e.key === 'F5') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
      e.preventDefault();
      nw.Window.get().showDevTools();
    }
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
      e.preventDefault();
      nw.Window.get().reload();
    }
    if (e.key === 'F11') {
      e.preventDefault();
      nw.Window.get().toggleFullscreen();
    }
  }, true);

});