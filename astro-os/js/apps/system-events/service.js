'use strict';

// system-events.js — keyboard and notification-panel handlers.

// The built-in launcher owns launchpad behavior.

// NOTIFICATION PANEL

document.getElementById('notification-panel')?.addEventListener('click', (e) => {
  if (e.target.id !== 'notification-panel') return;
  e.currentTarget.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('tray-bell')?.addEventListener('click', Notify.togglePanel);

document.getElementById('notif-close')?.addEventListener('click', () => {
  document.getElementById('notification-panel')?.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('notif-mark-all')?.addEventListener('click', () => {
  // Notify.clearAll() preserves pinned entries (like "running in background");
  // bypassing it by assigning OS.notifications = [] would wipe those too and
  // leave a background app running with no way to stop it.
  Notify.clearAll();
  // clearAll() updates Notify's own badge but not this file's separate tray
  // badge element, so call that here too.
  updateNotificationBadge();
});

document.getElementById('notif-mark-read')?.addEventListener('click', () => {
  Notify.markAllRead();
  updateNotificationBadge();
});

function resetShellScrollTwice() {
  if (typeof window.resetShellScroll !== 'function') return;
  window.resetShellScroll();
  requestAnimationFrame(window.resetShellScroll);
}

function updateNotificationBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = (OS.notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

Notify.loadPersisted();
Notify.renderPanel();
Notify.updateBadge();
updateNotificationBadge();

// WINDOW RESIZE

window.addEventListener('resize', throttleRAF(() => {
  if (!OS.windows) return;
  for (const state of OS.windows.values()) {
    if (state.maximized) {
      const area = WM.getWorkArea();
      state.x = area.left; state.y = area.top;
      state.width = area.width; state.height = area.height;
      state.element.style.left = area.left + 'px';
      state.element.style.top = area.top + 'px';
      state.element.style.width = area.width + 'px';
      state.element.style.height = area.height + 'px';
    } else {
      const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
      state.x = next.x; state.y = next.y; state.width = next.w; state.height = next.h;
      state.element.style.left = next.x + 'px';
      state.element.style.top = next.y + 'px';
      state.element.style.width = next.w + 'px';
      state.element.style.height = next.h + 'px';
    }
  }
  WM.hideSnapPreview();
}));

// Desktop interactions are owned by the bundled launcher.

// KEYBOARD SHORTCUTS

document.addEventListener('keydown', (e) => {
  const setupOpen = [...(OS.windows?.values?.() ?? [])].some(state =>
    state.appId === 'com.astroos.setup' && state.fullscreen === true
  );
  if (setupOpen) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape' ||
        e.key === 'PrintScreen' || /^F\d+$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  const focused = document.activeElement;
  const inAppContent = focused?.closest?.('.window-content');
  const alwaysAllow =
    (e.altKey && (e.key === 'F4' || e.key === 'Tab')) ||
    e.key === 'Escape' || e.key === 'PrintScreen';

  // Don't hijack editor-style shortcuts when the user is typing inside an app.
  if (inAppContent && !alwaysAllow) {
    const conflicting = (e.ctrlKey || e.metaKey) && [
      'l', 'L', 'e', 'E', 'd', 'D', 'c', 'C', 'u', 'U', 'a', 'A',
      ' ', 'ArrowLeft', 'ArrowRight'
    ].includes(e.key);
    if (conflicting) return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'e') { e.preventDefault(); WM.createWindow('com.astroos.files'); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't') { e.preventDefault(); WM.createWindow('com.astroos.terminal'); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') { e.preventDefault(); window.LockScreenService.lockScreen(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); WM.minimizeAll(); }
  if (e.key === 'PrintScreen' && !e.altKey) { e.preventDefault(); window.ScreenshotService.capture('desktop'); }
  if (e.altKey && e.key === 'PrintScreen') { e.preventDefault(); window.ScreenshotService.capture('window'); }
  if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault(); window.ScreenshotService.capture('region');
  }
  if (e.altKey && e.key === 'F4') {
    e.preventDefault();
    if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId);
  }
  if (e.altKey && e.key === 'Tab') { e.preventDefault(); window.LauncherShell?.showAppSwitcher(); }

  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    window.LauncherShell?.switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
  }

  if (e.key === 'Escape') {
    ContextMenu.hide();
  }

  // F3 toggles the debug overlay only; devMode setting is unchanged.
  if (e.key === 'F3') {
    e.preventDefault();
    window.DebugOverlay?.toggle?.();
  }

  // Ctrl+Shift+D copies the debug overlay text to the clipboard.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (window.DebugOverlay?._copyDebugInfo) {
      window.DebugOverlay._copyDebugInfo();
      Notify.show({ title: 'Debug Info Copied', body: 'Overlay text copied to clipboard', type: 'success' });
    }
  }
});

// ASTROOS: USER MENU (tray power/user actions)
(() => {
  const trayUserBtn = document.getElementById('tray-user');
  const userMenu = document.getElementById('user-menu');
  if (!trayUserBtn || !userMenu) return;

  const setUserMenuOpen = (open) => {
    userMenu.classList.toggle('show', open);
    trayUserBtn.setAttribute('aria-expanded', String(open));
  };

  trayUserBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setUserMenuOpen(!userMenu.classList.contains('show'));
  });

  userMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    const action = item.dataset.action;
    setUserMenuOpen(false);

    if (action === 'lock') {
      window.LockScreenService?.lockScreen?.();
      return;
    }
    if (action === 'restart' || action === 'shutdown') {
      const power = window.AstroOSSystem?.hardware?.power;
      const run = action === 'restart' ? power?.restart : power?.powerOff;
      if (typeof run !== 'function') {
        Notify.show({ title: 'Power action failed', body: 'System power API is unavailable', type: 'error', appName: 'System' });
        return;
      }
      try {
        await run();
      } catch (error) {
        Notify.show({ title: 'Power action failed', body: error?.message || 'The action did not complete.', type: 'error', appName: 'System' });
      }
    }
  });

  // Close on outside click / Escape
  document.addEventListener('click', (e) => {
    if (userMenu.classList.contains('show') && !userMenu.contains(e.target) && e.target !== trayUserBtn) {
      setUserMenuOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setUserMenuOpen(false);
  });
})();

// BACKGROUND EMAIL BOOTSTRAP — silent startup sync.
// Wrapped in try/catch so a failure in the email service can't break the
// rest of the shell's boot wiring.
try {
  const bg = window.__ASTROOS_BG = window.__ASTROOS_BG || {};
  if (!bg.email?.__patchedStartup) {
    const svc = bg.email = bg.email || {};
    svc.__patchedStartup = true;
    svc.ensureBooted?.();
  }
} catch { /* email service unavailable — silent */ }

OS.events?.on?.('settings:changed', ({ key }) => {
  if (key !== 'devMode') return;
  if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
  WM?.updateTaskbar?.();
});
