(function () {
  'use strict';
  const _reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let _debouncedLaunchpadSearch = null;
  function getLauncherDeveloperMode() {
    const settings = window.AstroOSSystem?.settings;
    if (!settings || typeof settings.get !== 'function') {
      throw new Error('Astro System settings API is unavailable');
    }
    return settings.get('devMode') === true;
  }

  function isLauncherRootAccessEnabled() {
    const settings = window.AstroOSSystem?.settings;
    if (!settings || typeof settings.get !== 'function') {
      throw new Error('Astro System settings API is unavailable');
    }
    return settings.get('rootAccessEnabled') === true;
  }

  function disableLauncherRootAccess() {
    const setRootAccess = window.AstroOSSystem?.developer?.setRootAccess;
    if (typeof setRootAccess !== 'function') {
      throw new Error('Astro System developer API is unavailable');
    }
    return setRootAccess(false);
  }
// Stable display order for the launchpad grid. Apps not listed here sort
// alphabetically after the pinned entries. Built-in apps were previously
// rendered in registration order, which followed module-load order and
// drifted whenever a hot-reload reordered them — the grid was effectively
// random across boots.
const LAUNCHPAD_ORDER = Object.freeze([
  'com.astroos.install',      // Install AstroOS
  'com.astroos.files',        // Files
  'com.astroos.textedit',     // TextEdit
  'com.astroos.terminal',     // Terminal
  'com.astroos.browser',      // Browser
  'com.astroos.calendar',     // Calendar
  'com.astroos.settings',     // Settings
  'com.astroos.calculator',   // Calculator
  'com.astroos.appmanager',   // App Manager
  'com.astroos.clock',        // Clock
  'com.astroos.email',        // Email
  'com.astroos.gallery',      // Gallery
  'com.astroos.downloads',    // Downloads
  'com.astroos.contacts',     // Contacts
  'com.astroos.search',       // Search
  'com.astroos.music',        // Music
]);

function launchpadRank(app) {
  // Three tiers so an unbundled system app can't collide with a user app on
  // the same fallback rank: pinned system apps first (by list order), then
  // any other system app, then user-installed apps. Within each tier the
  // tiebreak is alphabetical, so the layout is deterministic regardless of
  // module load order.
  const pinned = LAUNCHPAD_ORDER.indexOf(app?.id);
  if (pinned !== -1) return pinned;
  if (app?.system === true) return LAUNCHPAD_ORDER.length;
  return LAUNCHPAD_ORDER.length + 1;
}

// Look up whether an app already has a desktop .lnk shortcut. Used by the
// launchpad context menu to decide between "Pin to Desktop" and "Unpin from
// Desktop". Tolerates any FS failure and just reports "no shortcut".
function _hasDesktopShortcut(appId) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return false;
    for (const f of FS.listDir(desktopFolder)) {
      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          if (JSON.parse(f.content || '{}')?.target === appId) return true;
        } catch { /* skip invalid shortcut payloads */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Highlight every case-insensitive occurrence of `query` inside `text` by
// appending text nodes and <mark> elements to `target`. Done entirely through
// the DOM so app names containing <, >, or & can't break out into HTML.
function _highlightMatches(target, text, query) {
  target.textContent = '';
  if (!query) {
    target.appendChild(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      target.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) target.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.style.cssText = 'background:var(--accent);color:#fff;border-radius:2px;padding:0 2px;';
    mark.textContent = text.slice(idx, idx + q.length);
    target.appendChild(mark);
    i = idx + q.length;
  }
}

// LAUNCHPAD

document.getElementById('start-btn')?.addEventListener('click', toggleLaunchpad);
const powerActions = document.getElementById('launchpad-power-actions');
if (powerActions) {
  const isLinux = typeof process !== 'undefined' && process.platform === 'linux';
  powerActions.style.display = isLinux ? 'flex' : 'none';
  document.getElementById('restart-system-btn')?.addEventListener('click', () => requestSystemPowerAction('restart'));
  document.getElementById('poweroff-system-btn')?.addEventListener('click', () => requestSystemPowerAction('poweroff'));
}

async function requestSystemPowerAction(action) {
  const isRestart = action === 'restart';
  const confirmed = await showModal(
    isRestart ? 'Restart AstroOS?' : 'Power off AstroOS?',
    isRestart ? 'The system will close running apps and restart.' : 'The system will close running apps and power off.',
    [{ label: 'Cancel' }, { label: isRestart ? 'Restart' : 'Power off', danger: true, value: 'confirm' }]
  );
  if (confirmed !== 'confirm') return;
  try {
    const power = window.AstroOSSystem?.hardware?.power;
    const run = action === 'restart' ? power?.restart
      : action === 'poweroff' ? power?.powerOff
        : null;
    if (typeof run !== 'function') throw new Error('Astro System power API is unavailable');
    await run();
  } catch (error) {
    console.error('[Launcher] System power action failed:', error);
    Notify.show({ title: 'Power action failed', body: error.message, type: 'error', appName: 'System' });
  }
}

function toggleLaunchpad() {
  const launchpad = document.getElementById('launchpad');
  if (!launchpad) return;
  const isClosing = launchpad.classList.contains('active');
  launchpad.classList.toggle('active');
  if (launchpad.classList.contains('active')) {
    _debouncedLaunchpadSearch?.cancel?.();
    renderLaunchpad();
    const searchEl = document.getElementById('launchpad-search');
    if (searchEl) {
      searchEl.value = '';
      setTimeout(() => { searchEl.focus(); searchEl.select() }, 50);
    }
    document.querySelectorAll('.launchpad-item').forEach(item => {
      item.style.display = '';
    });
    const noResultsMsg = document.getElementById('launchpad-no-results');
    if (noResultsMsg) noResultsMsg.style.display = 'none';
    launchpad.querySelectorAll('.launchpad-name mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  } else if (isClosing) {
    _debouncedLaunchpadSearch?.cancel?.();
    // Strip <mark> highlights back to plain text on close.
    launchpad.querySelectorAll('.launchpad-name mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }
}

function renderLaunchpad() {
  const grid = document.getElementById('launchpad-grid');
  if (!grid) return;
  const devMode = getLauncherDeveloperMode();
  const apps = (devMode ? APP_REGISTRY : APP_REGISTRY.filter(app => !app.devOnly))
    .filter(app => app.id !== 'com.astroos.launcher');
  // Stable sort: pinned order first, everything else alphabetical. This keeps
  // the grid layout consistent across reloads instead of tracking module
  // load order, which drifts whenever a hot-reload reorders registration.
const orderedApps = [...apps].sort((a, b) => {
    const ra = launchpadRank(a);
    const rb = launchpadRank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
  const webApps = (typeof WebAppManager !== 'undefined' && WebAppManager.getAllApps)
    ? WebAppManager.getAllApps()
    : [];

  // Signature tracks the set of apps currently rendered so we only rebuild the
  // grid when something actually changes — not on every open. Order is part
  // of the signature: without it a re-sort of the same app set is treated as
  // a no-op and the grid keeps its previous layout.
  const signature = [
    ...orderedApps.map(app => `${app.id}:${app.name}:${app.icon}`),
    ...webApps.map(wa => `web:${wa.id}:${wa.name}:${wa.icon}:${wa.url}`)
  ].join('||');

  const needsRebuild = grid.dataset.renderedSignature !== signature || grid.children.length === 0;

  if (needsRebuild) {
    grid.innerHTML = '';
    grid.dataset.renderedSignature = signature;

    orderedApps.forEach(app => appendAppItem(app, grid));

    if (typeof WebAppManager !== 'undefined') {
      webApps.forEach(webApp => appendWebAppItem(webApp, grid));
    }
  } else {
    // Already built — just reset animation state for re-open.
    Array.from(grid.children).forEach(item => {
      item.classList.remove('animate');
      item.style.opacity = '';
      item.style.transform = '';
      item.style.removeProperty('--delay');
      item.style.willChange = '';
      item.style.display = '';
    });
  }

  // Stagger animation radiates out from the grid centre.
  requestAnimationFrame(() => {
    const prefersReducedMotion =
      OS.settings.get('reduceMotion') || _reducedMotionMQ.matches;
    const items = Array.from(grid.querySelectorAll('.launchpad-item'))
      .filter(item => item.style.display !== 'none');

    if (prefersReducedMotion) {
      items.forEach(item => {
        item.style.opacity = '1';
        item.style.transform = 'scale(1)';
        item.classList.add('animate');
      });
      return;
    }

    const gridWidth = grid.offsetWidth;
    const gridHeight = grid.offsetHeight;
    const centerX = gridWidth / 2;
    const centerY = gridHeight / 2;
    const maxDist = Math.sqrt((gridWidth / 2) ** 2 + (gridHeight / 2) ** 2) || 1;

    items.forEach(item => {
      const cx = item.offsetLeft + item.offsetWidth / 2;
      const cy = item.offsetTop + item.offsetHeight / 2;
      const d = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2);
      const delay = Math.round((d / maxDist) * 300);
      item.style.setProperty('--delay', `${delay}ms`);
      item.style.willChange = 'transform, opacity';
      item.classList.add('animate');
      // Drop willChange once the animation has finished so the compositor can
      // release the layer.
      setTimeout(() => { item.style.willChange = ''; }, 500 + delay);
    });
  });
}

function appendAppItem(app, grid) {
  const targetGrid = grid || document.getElementById('launchpad-grid');
  if (!targetGrid) return;

  const item = createEl('button', {
    className: 'launchpad-item',
    'aria-label': app.name,
    draggable: 'true'
  });
  const icon = createEl('div', { className: 'launchpad-icon' });
  icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 64);
  item.appendChild(icon);
  item.appendChild(createEl('div', { className: 'launchpad-name', textContent: app.name }));

  item.addEventListener('click', () => { toggleLaunchpad(); WM.createWindow(app.id); });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAppContextMenu(e, app);
  });

  attachLaunchpadDragHandlers(item, app.name, {
    type: 'app-shortcut', appId: app.id, appName: app.name, appIcon: app.icon
  });
  targetGrid.appendChild(item);
}

// The installed-apps inventory is registry-backed (HKNS/apps/installed via
// NovaAppPackageStore); the localStorage key is only the fail-soft fallback.
function readInstalledApps() {
  if (typeof window !== 'undefined' && window.NovaAppPackageStore?.loadRegistry) {
    try { return window.NovaAppPackageStore.loadRegistry() || []; } catch { /* fall through */ }
  }
  try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; }
}

function showAppContextMenu(e, app) {
  const pinnedApps = OS.settings.get('pinnedApps') || [];
  const isPinned = pinnedApps.includes(app.id);
  const storedApps = readInstalledApps();
  const isUserApp = storedApps.some(a => a.id === app.id);
  const isSystemApp = storedApps.some(a => a.id === app.id && a.system === true);

  const menuItems = [
    { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); WM.createWindow(app.id); } },
    { separator: true },
    {
      label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
      icon: 'pin',
      action: () => toggleTaskbarPin(app.id, app.name, isPinned)
    }
  ];

  if (_hasDesktopShortcut(app.id)) {
    menuItems.push({ separator: true }, {
      label: 'Unpin from Desktop', icon: 'pin',
      action: () => unpinAppFromDesktop(app)
    });
  } else {
    menuItems.push({ separator: true }, {
      label: 'Pin to Desktop', icon: 'pin',
      action: () => pinAppToDesktop(app)
    });
  }

  if (isUserApp && isSystemApp) {
    menuItems.push({ separator: true }, {
      label: 'System App', icon: 'lock', disabled: true
    });
  } else if (isUserApp) {
    menuItems.push({ separator: true }, {
      label: 'Uninstall', icon: 'trash', danger: true,
      action: () => uninstallApp(app)
    });
  }

  ContextMenu.show(e.clientX, e.clientY, menuItems);
}

function toggleTaskbarPin(appId, appName, currentlyPinned) {
  const pins = OS.settings.get('pinnedApps') || [];
  if (currentlyPinned) {
    OS.settings.set('pinnedApps', pins.filter(id => id !== appId));
    WM.updateTaskbar();
    Notify.show({ title: 'Unpinned', body: `${appName} removed from taskbar`, type: 'success', appName: 'Launchpad' });
  } else {
    if (pins.includes(appId)) {
      Notify.show({ title: 'Already Pinned', body: `${appName} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
      return;
    }
    OS.settings.set('pinnedApps', [...pins, appId]);
    WM.updateTaskbar();
    Notify.show({ title: 'Pinned', body: `${appName} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
  }
}

async function pinAppToDesktop(app) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return;
    const shortcutContent = JSON.stringify({
      target: app.id,
      type: 'app-shortcut',
      icon: app.icon
    });
    await FS.createFile(desktopFolder, app.name + '.lnk', shortcutContent, 'application/x-app-shortcut');
    renderDesktopIcons();
    Notify.show({ title: 'Pinned to Desktop', body: `${app.name} shortcut added to desktop`, type: 'success', appName: 'Launchpad' });
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to pin to desktop: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

async function unpinAppFromDesktop(app) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return;
    let removed = 0;
    const iconPositions = OS.settings.get('desktopIconPositions') || {};
    for (const f of FS.listDir(desktopFolder)) {
      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          const data = JSON.parse(f.content || '{}');
          if (data?.type === 'app-shortcut' && data?.target === app.id) {
            await FS.permanentDelete(f.id);
            delete iconPositions['file:' + f.id];
            removed++;
          }
        } catch { /* skip invalid shortcut payloads */ }
      }
    }
    OS.settings.set('desktopIconPositions', iconPositions);
    renderDesktopIcons();
    WM.updateTaskbar();
    Notify.show({
      title: 'Unpinned from Desktop',
      body: removed > 0
        ? `Removed ${removed} desktop shortcut${removed > 1 ? 's' : ''} for ${app.name}`
        : `No desktop shortcuts found for ${app.name}`,
      type: 'success', appName: 'Launchpad'
    });
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to unpin from desktop: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

async function uninstallApp(app) {
  toggleLaunchpad();
  try {
    await uninstallThroughAppManager(app.id, 'Launchpad');
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to uninstall: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

async function uninstallThroughAppManager(appId, source) {
  try {
    const appManagerId = 'com.astroos.appmanager';
    let managerWindow = [...(window.OS?.windows?.values() ?? [])].find(w => w.appId === appManagerId);
    managerWindow ??= WM.createWindow(appManagerId);
    if (!managerWindow) throw new Error('App Manager is not available.');

    const deadline = Date.now() + 8000;
    while (typeof managerWindow.content?._novaAppUninstall !== 'function') {
      if (Date.now() > deadline) throw new Error('App Manager took too long to open.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await managerWindow.content._novaAppUninstall(appId);
    if (source === 'Desktop') renderDesktopIcons();
  } catch (error) {
    console.error(`[${source}] App Manager uninstall failed:`, error);
    Notify.show({
      title: 'Cannot uninstall app',
      body: error?.message || String(error),
      type: 'error',
      appName: source,
    });
  }
}

function appendWebAppItem(webApp, grid) {
  const item = createEl('button', {
    className: 'launchpad-item',
    'aria-label': `${webApp.name} (Web App)`,
    // Cap URL length on the tooltip so very long data URIs don't reflow the
    // browser's native tooltip popup for seconds at a time.
    title: typeof webApp.url === 'string' ? webApp.url.slice(0, 2048) : '',
    draggable: 'true'
  });

  const icon = createEl('div', {
    className: 'launchpad-icon',
    style: 'font-size: 28px; line-height: 1;'
  });
  if (webApp.icon) {
    if (/^data:|^https?:\/\//i.test(webApp.icon)) {
      const img = createEl('img', {
        src: webApp.icon,
        style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:inherit;',
        draggable: 'false',
        crossorigin: 'anonymous'
      });
      img.onerror = () => { icon.innerHTML = svgIcon('globe', 28); };
      icon.appendChild(img);
    } else {
      icon.textContent = webApp.icon;
    }
  } else {
    icon.innerHTML = svgIcon('globe', 28);
  }

  const name = createEl('div', { className: 'launchpad-name', textContent: webApp.name });
  const indicator = createEl('div', {
    style: 'position:absolute;bottom:4px;right:4px;width:8px;height:8px;background:#58a6ff;border-radius:50%;border:1px solid rgba(255,255,255,0.3);',
    title: 'Web App'
  });

  item.append(icon, name, indicator);

  // Extracted so the context-menu "Open" can call it directly. Calling
  // item.click() instead would re-enter toggleLaunchpad() and double-close.
  // Delegates to openWebApp() (registry.js) which sets OS.apps[id].init(),
  // so the webview renders correctly on subsequent opens via taskbar/desktop.
  function launchWebApp() {
    toggleLaunchpad();
    try {
      if (typeof window.openWebApp !== 'function') throw new Error('Web app launcher unavailable');
      const windowElement = window.openWebApp(webApp.id);
      if (!windowElement) throw new Error('Web app not found');
    } catch (error) {
      Notify.show({
        title: 'Error', body: `Failed to launch app: ${error.message}`,
        type: 'error', appName: 'System'
      });
    }
  }

  item.addEventListener('click', launchWebApp);

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const waPins = OS.settings.get('pinnedApps') || [];
    const waId = 'webapp_' + webApp.id;
    const waIsPinned = waPins.includes(waId);
    ContextMenu.show(e.clientX, e.clientY, [
      { label: 'Open', icon: 'play', action: launchWebApp },
      { separator: true },
      {
        label: waIsPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
        icon: 'pin',
        action: () => {
          const p = OS.settings.get('pinnedApps') || [];
          if (waIsPinned) {
            OS.settings.set('pinnedApps', p.filter(id => id !== waId));
            WM?.updateTaskbar?.();
            Notify.show({ title: 'Unpinned', body: `${webApp.name} unpinned from taskbar`, type: 'success', appName: 'Launchpad' });
          } else {
            if (p.includes(waId)) {
              Notify.show({ title: 'Already Pinned', body: `${webApp.name} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
              return;
            }
            OS.settings.set('pinnedApps', [...p, waId]);
            WM?.updateTaskbar?.();
            Notify.show({ title: 'Pinned', body: `${webApp.name} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
          }
        }
      },
      { separator: true },
      {
        label: 'Remove Web App', icon: 'trash', danger: true,
        action: async () => {
          // removeWebApp (registry.js) also unpins from the taskbar and
          // deletes any desktop .lnk shortcut, matching the Web Apps tab's
          // own Remove button.
          if (typeof window.removeWebApp === 'function') {
            await window.removeWebApp(webApp.id);
          } else {
            WebAppManager.removeApp(webApp.id);
          }
          renderLaunchpad();
          Notify.show({ title: 'Removed', body: `"${webApp.name}" has been removed`, type: 'success', appName: 'Launchpad' });
        }
      }
    ]);
  });

  attachLaunchpadDragHandlers(item, webApp.name, {
    type: 'app-shortcut', appId: 'webapp_' + webApp.id, appName: webApp.name, appIcon: webApp.icon
  });
  grid.appendChild(item);
}

// Shared drag handlers for both native and web app launchpad items.
function attachLaunchpadDragHandlers(item, displayName, payload) {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', displayName);
    const dragImg = createEl('div', {
      style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;'
    });
    dragImg.textContent = displayName;
    document.body.appendChild(dragImg);
    e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
    requestAnimationFrame(() => {
      // requestAnimationFrame may fire after a dragcancel has already torn
      // the drag image down — guard the removeChild so we don't throw.
      if (dragImg.parentNode === document.body) document.body.removeChild(dragImg);
      const lp = document.getElementById('launchpad');
      if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
    });
  });

  item.addEventListener('dragend', () => {
    const lp = document.getElementById('launchpad');
    if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
    setTimeout(() => {
      if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
    }, 80);
  });
}

// Launchpad search — debounced so we don't reflow the whole grid on every keystroke.
_debouncedLaunchpadSearch = debounce((e) => {
  const q = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.launchpad-item');
  let visibleCount = 0;

  items.forEach(item => {
    const nameEl = item.querySelector('.launchpad-name');
    const name = (nameEl?.textContent || '').toLowerCase();
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    const match = q === '' || name.includes(q) || label.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) {
      visibleCount++;
      if (nameEl && q) {
        const original = nameEl.dataset.originalText ?? nameEl.textContent;
        nameEl.dataset.originalText = original;
        _highlightMatches(nameEl, original, q);
      } else if (nameEl) {
        delete nameEl.dataset.originalText;
        nameEl.textContent = nameEl.textContent;
      }
    }
  });

  let noResultsMsg = document.getElementById('launchpad-no-results');
  if (q && visibleCount === 0 && items.length > 0) {
    if (!noResultsMsg) {
      noResultsMsg = createEl('div', {
        id: 'launchpad-no-results',
        className: 'launchpad-no-results',
        textContent: 'No apps found',
        style: 'grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;'
      });
      document.getElementById('launchpad-grid')?.appendChild(noResultsMsg);
    }
    noResultsMsg.style.display = '';
  } else if (noResultsMsg) {
    noResultsMsg.style.display = 'none';
  }
}, 150);

document.getElementById('launchpad-search')?.addEventListener('input', _debouncedLaunchpadSearch);

document.getElementById('launchpad-search')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.toLowerCase().trim();
  if (!q) return;
  const items = Array.from(document.querySelectorAll('.launchpad-item'))
    .filter(item => item.style.display !== 'none');
  if (!items.length) return;
  const target = items.find(item => {
    const name = item.querySelector('.launchpad-name')?.textContent?.toLowerCase() ?? '';
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    return name === q || label === q;
  });
  if (target) target.click();
});

// Close launchpad on backdrop click.
document.getElementById('launchpad')?.addEventListener('click', (e) => {
  if (e.target.id === 'launchpad') toggleLaunchpad();
});


// FIX: module-level AbortController list — one per icon drag, aborted on every renderDesktopIcons()
// call so no mousemove/mouseup listeners ever outlive their icons.
let _iconDragControllers = [];

// FIX: hoisted out of renderDesktopIcons — was a new function object on every render call.
// Takes the shared state it needs as parameters instead of closure captures.
function _makeIconDraggable(icon, desktopEl, key, iconPositions) {
  const ac = new AbortController();
  const { signal } = ac;
  _iconDragControllers.push(ac);

  let isDragging = false;
  let dragStarted = false; // true only once movement has crossed DRAG_THRESHOLD
  let startX = 0, startY = 0, initialX = 0, initialY = 0;
  let originalX = 0, originalY = 0;
  let overTaskbar = false;
  const DRAG_THRESHOLD = 4; // px — below this, mousedown+mouseup is a click, not a drag

  function getAppId() {
    return key.startsWith('app:') ? key.slice(4) : icon.dataset.shortcutTarget;
  }

  function addPlusBadge() {
    if (icon.querySelector('.pin-plus-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'pin-plus-badge';
    badge.textContent = '+';
    icon.appendChild(badge);
  }

  function removePlusBadge() {
    const badge = icon.querySelector('.pin-plus-badge');
    if (badge) badge.remove();
  }

  function setTaskbarHover(active) {
    if (active === overTaskbar) return;
    overTaskbar = active;
    const taskbar = document.getElementById('taskbar');
    const label = icon.querySelector('.desktop-icon-label');
    if (active) {
      icon.style.transform = 'scale(0.75)';
      icon.style.opacity = '0.9';
      addPlusBadge();
      taskbar?.classList.add('drag-over');
      if (label) label.style.display = 'none';
    } else {
      icon.style.transform = '';
      icon.style.opacity = '';
      removePlusBadge();
      taskbar?.classList.remove('drag-over');
      if (label) label.style.display = '';
    }
  }

  icon.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    dragStarted = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = icon.getBoundingClientRect();
    initialX = rect.left;
    initialY = rect.top;
    originalX = rect.left - desktopEl.getBoundingClientRect().left;
    originalY = rect.top - desktopEl.getBoundingClientRect().top;
    // NOTE: reparenting to document.body and bumping z-index/dragging state
    // now happens lazily in mousemove, once DRAG_THRESHOLD is crossed — not
    // here. Doing it unconditionally on every mousedown meant a plain click
    // (mousedown immediately followed by mouseup at ~the same spot) still
    // ran the full "drop" path below: it reparented the icon out of the
    // desktop container, rewrote its stored position via
    // OS.settings.set('desktopIconPositions', ...), and re-appended it —
    // which fires the settings-change listener that re-renders the whole
    // desktop, and can visibly nudge the icon if the reparent-triggered
    // reflow changes its measured rect even slightly. A single click should
    // only select the icon.
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!dragStarted) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      // Threshold crossed — this is now a real drag. Do the reparent/style
      // work that used to happen unconditionally on mousedown.
      dragStarted = true;
      icon.style.zIndex = '99999';
      icon.style.transition = 'none';
      icon.classList.add('dragging');
      document.body.appendChild(icon);
    }

    const newX = initialX + dx;
    const newY = initialY + dy;

    const isAppIcon = key.startsWith('app:');
    const shortcutTarget = icon.dataset.shortcutTarget;
    const canPin = isAppIcon || shortcutTarget;

    if (canPin) {
      icon.style.position = 'fixed';
      icon.style.left = `${newX}px`;

      const taskbar = document.getElementById('taskbar');
      let over = false;
      if (taskbar) {
        const tbRect = taskbar.getBoundingClientRect();
        const cx = e.clientX;
        const cy = e.clientY;
        over = cx > tbRect.left && cx < tbRect.right && cy > tbRect.top && cy < tbRect.bottom;
        setTaskbarHover(over);
      }

      if (over) {
        icon.style.top = `${newY}px`;
      } else {
        const maxY = taskbar ? taskbar.getBoundingClientRect().top - icon.offsetHeight : window.innerHeight;
        icon.style.top = `${Math.min(newY, maxY)}px`;
      }
    } else {
      const taskbar = document.getElementById('taskbar');
      const maxY = taskbar ? taskbar.getBoundingClientRect().top - icon.offsetHeight : window.innerHeight;
      const clampedY = Math.min(newY, maxY);
      icon.style.position = 'fixed';
      icon.style.left = `${newX}px`;
      icon.style.top = `${clampedY}px`;
    }
  }, { signal });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    if (!dragStarted) {
      // Never crossed the threshold — this was a click, not a drag. Icon
      // was never reparented or restyled, so there's nothing to undo and
      // nothing to write back to desktopIconPositions.
      return;
    }
    dragStarted = false;

    icon.style.zIndex = '';
    icon.style.transition = '';
    icon.classList.remove('dragging');

    const pinnedNow = overTaskbar;
    const appId = getAppId();
    setTaskbarHover(false);

    if (pinnedNow && appId) {
      const pins = OS.settings.get('pinnedApps') || [];
      if (!pins.includes(appId)) {
        pins.push(appId);
        OS.settings.set('pinnedApps', pins);
        if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
        const app = OS.apps[appId];
        Notify.show({ title: 'Pinned to Taskbar', body: `${app?.name || appId} pinned to taskbar`, type: 'success', appName: 'Desktop' });
      } else {
        Notify.show({ title: 'Already Pinned', body: `${OS.apps[appId]?.name || appId} is already pinned to taskbar`, type: 'info', appName: 'Desktop' });
      }
    }

    let x, y;
    if (pinnedNow) {
      x = originalX;
      y = originalY;
    } else {
      const rect = icon.getBoundingClientRect();
      const desktopRect = desktopEl.getBoundingClientRect();
      const rawX = rect.left - desktopRect.left;
      const rawY = rect.top - desktopRect.top;
      const target = _pixelToCell(rawX, rawY, desktopEl);

      const occupantKey = _cellKeyOccupant(iconPositions, target.col, target.row, key);
      if (occupantKey) {
        // Windows-style swap: dropping this icon on another one's cell
        // trades their positions instead of shoving this icon off to the
        // next open slot. The occupant re-renders in its new cell on the
        // next renderDesktopIcons() pass (triggered by the settings write
        // below); this icon takes the cell being dropped on.
        const occupantCell = _posToCell(iconPositions[key]) || _pixelToCell(originalX, originalY, desktopEl);
        iconPositions[occupantKey] = { col: occupantCell.col, row: occupantCell.row };
      }

      const cell = target;
      const pixel = _cellToPixel(cell.col, cell.row);
      x = pixel.x; y = pixel.y;
      iconPositions[key] = { col: cell.col, row: cell.row };
      icon.style.position = 'absolute';
      icon.style.left = `${x}px`;
      icon.style.top = `${y}px`;
      OS.settings.set('desktopIconPositions', iconPositions);
      desktopEl.appendChild(icon);
      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      return;
    }
    icon.style.position = 'absolute';
    icon.style.left = `${x}px`;
    icon.style.top = `${y}px`;
    desktopEl.appendChild(icon);
  }, { signal });
}

// ── Desktop icon grid ────────────────────────────────────────────────
// Icons used to store raw {x, y} pixel positions with a "push to nearest
// free spot on overlap" resolver. That's why dragging felt inconsistent —
// two icons a few pixels apart were both "valid" positions, so drops
// landed in slightly different spots depending on exactly where the mouse
// was released, and stored positions from a wider window didn't line up
// with a grid at a narrower one. Everything below now snaps to a fixed
// cell grid (col, row) — same layout model Windows/macOS use — so every
// valid position is one of a fixed set of cells, not "anywhere that
// doesn't overlap."
const DESKTOP_GRID = {
  cellW: 88,   // icon slot width, including horizontal spacing
  cellH: 104,  // icon slot height, including vertical spacing + label
  marginX: 12,
  marginY: 12,
};

function _gridCols(desktopEl) {
  const width = desktopEl ? desktopEl.getBoundingClientRect().width : window.innerWidth;
  return Math.max(1, Math.floor((width - DESKTOP_GRID.marginX * 2) / DESKTOP_GRID.cellW));
}

function _gridRows(desktopEl) {
  // Must be measured in the same coordinate space as the drop position
  // (desktop-relative, from desktopEl's own rect), not viewport-relative.
  // Mixing the two — comparing a desktop-relative Y against a viewport-
  // relative taskbar top — was why drops always computed a row near the
  // bottom of the *desktop's* box regardless of where the cursor actually
  // was: the desktop area sits below the window titlebar, so its own
  // height is shorter than (and offset from) the viewport height the old
  // code was measuring against.
  const el = desktopEl || document.getElementById('desktop');
  const height = el ? el.getBoundingClientRect().height : window.innerHeight;
  return Math.max(1, Math.floor((height - DESKTOP_GRID.marginY * 2) / DESKTOP_GRID.cellH));
}

function _cellToPixel(col, row) {
  return {
    x: DESKTOP_GRID.marginX + col * DESKTOP_GRID.cellW,
    y: DESKTOP_GRID.marginY + row * DESKTOP_GRID.cellH,
  };
}

// Converts a raw pixel drop point (e.g. cursor position from a drag) to
// the nearest grid cell, clamped to stay within the visible desktop area.
// Takes desktopEl so column count is measured against the actual desktop
// container width, not window.innerWidth — mirrors the fix already applied
// to _gridRows. Without this, _gridCols() fell back to window.innerWidth
// (wider than the real desktop area, e.g. AstroOS-app-in-webapp), so `cols`
// came out too high and the right-edge clamp never engaged early enough,
// letting icons get dragged/dropped past the actual visible right edge.
function _pixelToCell(x, y, desktopEl) {
  const el = desktopEl || document.getElementById('desktop');
  const cols = _gridCols(el);
  const rows = _gridRows(el);
  const col = Math.min(cols - 1, Math.max(0, Math.round((x - DESKTOP_GRID.marginX) / DESKTOP_GRID.cellW)));
  const row = Math.min(rows - 1, Math.max(0, Math.round((y - DESKTOP_GRID.marginY) / DESKTOP_GRID.cellH)));
  return { col, row };
}

// Legacy positions were stored as pixel {x, y}. Grid positions are stored
// as {col, row}. This tells them apart so old saved layouts still resolve
// to a reasonable cell on first load instead of breaking.
function _posToCell(pos) {
  if (pos && typeof pos.col === 'number' && typeof pos.row === 'number') return { col: pos.col, row: pos.row };
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') return _pixelToCell(pos.x, pos.y);
  return null;
}

function _cellKeyOccupant(iconPositions, col, row, excludeKey) {
  for (const [k, pos] of Object.entries(iconPositions)) {
    if (k === excludeKey) continue;
    const cell = _posToCell(pos);
    if (cell && cell.col === col && cell.row === row) return k;
  }
  return null;
}

// Finds the nearest unoccupied cell to (col, row), searching outward in
// rings so a drop near a full cell lands close by rather than jumping to
// the first empty slot in reading order.
function _findFreeCell(col, row, iconPositions, excludeKey, desktopEl) {
  const el = desktopEl || document.getElementById('desktop');
  const cols = _gridCols(el);
  const rows = _gridRows(el);
  const clamp = (c, r) => ({ col: Math.min(cols - 1, Math.max(0, c)), row: Math.min(rows - 1, Math.max(0, r)) });
  if (!_cellKeyOccupant(iconPositions, col, row, excludeKey)) return clamp(col, row);
  for (let radius = 1; radius < Math.max(cols, rows) + 1; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue; // ring only
        const c = col + dc, r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (!_cellKeyOccupant(iconPositions, c, r, excludeKey)) return { col: c, row: r };
      }
    }
  }
  return clamp(col, row); // grid is full — overlap rather than escape the desktop
}


function _getInitialIconPosition(key, index, iconPositions, desktopEl) {
  const saved = iconPositions[key];
  if (saved) {
    const cell = _posToCell(saved);
    const { x, y } = _cellToPixel(cell.col, cell.row);
    return { left: `${x}px`, top: `${y}px`, position: 'absolute' };
  }

  const cols = _gridCols(desktopEl || document.getElementById('desktop'));
  const occupied = new Set();
  for (const [k, pos] of Object.entries(iconPositions)) {
    if (k === key) continue;
    const cell = _posToCell(pos);
    if (cell) occupied.add(`${cell.col},${cell.row}`);
  }

  let col = index % cols;
  let row = Math.floor(index / cols);
  if (occupied.has(`${col},${row}`)) {
    for (let r = row; r < row + 50; r++) {
      const startC = r === row ? col : 0;
      for (let c = startC; c < cols; c++) {
        if (!occupied.has(`${c},${r}`)) { col = c; row = r; break; }
      }
      if (!occupied.has(`${col},${row}`)) break;
    }
  }

  const { x, y } = _cellToPixel(col, row);
  return { position: 'absolute', left: `${x}px`, top: `${y}px` };
}

// FIX: hoisted — was redefined inside renderDesktopIcons on every call.
// Handles app-shortcut drops and host-file drops, reads files correctly by type.
async function _handleDesktopDrop(e, desktopEl) {
  // Always read fresh — never use a stale closure reference from renderDesktopIcons
  const iconPositions = OS.settings.get('desktopIconPositions') || {};
  e.preventDefault();
  e.stopPropagation();

  try {
    // Check for app-shortcut drags first (JSON payload)
    const rawData = e.dataTransfer.getData('application/json');
    if (rawData) {
      let payload;
      try { payload = JSON.parse(rawData); } catch { /* not JSON, fall through */ }
      if (payload?.type === 'app-shortcut') {
        const shortcutName = payload.appName + '.lnk';
        const shortcutContent = JSON.stringify({
          target: payload.appId,
          type: 'app-shortcut',
          icon: payload.appIcon
        });
        const desktopFolderId = FS.specialFolders.desktop;
        try {
          const desktopFiles = FS.listDir(desktopFolderId);
          const alreadyExists = desktopFiles.some(f =>
            f.name === shortcutName && f.mimeType === 'application/x-app-shortcut'
          );
          if (alreadyExists) {
            Notify.show({ title: 'Already Pinned', body: `${payload.appName} shortcut already exists on desktop`, type: 'info', appName: 'Desktop' });
            return;
          }
          await FS.createFile(desktopFolderId, shortcutName, shortcutContent, 'application/x-app-shortcut');
          const desktopRect = desktopEl.getBoundingClientRect();
          const dropCell = _pixelToCell(e.clientX - desktopRect.left, e.clientY - desktopRect.top, desktopEl);
          const freeCell = _findFreeCell(dropCell.col, dropCell.row, iconPositions, 'app:' + payload.appId, desktopEl);
          iconPositions['app:' + payload.appId] = { col: freeCell.col, row: freeCell.row };
          OS.settings.set('desktopIconPositions', iconPositions);
          renderDesktopIcons();
          Notify.show({ title: 'Shortcut Created', body: `${payload.appName} shortcut added to desktop`, type: 'success', appName: 'Desktop' });
        } catch (err) {
          console.error('[Desktop Drop] Failed to create shortcut:', err);
          Notify.show({ title: 'Error', body: 'Failed to create shortcut', type: 'error', appName: 'Desktop' });
        }
        return;
      }
    }

    // Host filesystem file drops
    const droppedFiles = e.dataTransfer.files;
    if (!droppedFiles || droppedFiles.length === 0) return;

    const desktopId = FS.specialFolders.desktop;
    if (!desktopId) {
      Notify.show({ title: 'Error', body: 'Desktop folder not found', type: 'error', appName: 'System' });
      return;
    }

    // FIX: process all files concurrently and await all results before showing the summary
    // notification — fixes the race where filesAdded was always 0 in the original setTimeout.
    // FIX: binary files (images, audio, PDF, etc.) are read with readAsDataURL, not TextDecoder,
    // so they are stored intact instead of being corrupted.
    // FIX: extract just the base64 payload from the data URL before storing — the file system stores
    // raw content strings, and apps like Music/Gallery expect base64 strings they can decode,
    // not the full data:...;base64,... wrapper.
    function extractBase64FromDataUrl(dataUrl) {
      if (typeof dataUrl !== 'string') return dataUrl;
      const comma = dataUrl.indexOf(',');
      if (comma > -1 && dataUrl.slice(comma - 7, comma).toLowerCase() === ';base64') {
        return dataUrl.slice(comma + 1);
      }
      return dataUrl;
    }

    const TEXT_TYPES = new Set(['text/', 'application/json', 'application/xml', 'application/javascript', 'application/xhtml+xml']);
    const TEXT_EXTS = /\.(txt|md|json|xml|csv|js|ts|css|html|htm|svg|yaml|yml|toml|ini|sh|py|rb|java|c|cpp|h|rs)$/i;

    const isTextFile = (file) =>
      [...TEXT_TYPES].some(t => file.type.startsWith(t)) || TEXT_EXTS.test(file.name);

    const readFile = async (file) => {
      let verdict;
      try {
        if (typeof window.Scanner?.scan !== 'function') {
          throw new Error('File Scanner service is unavailable');
        }
        verdict = await window.Scanner.scan(file);
      } catch (error) {
        console.error('[Desktop Drop] File scan failed:', file.name, error);
        Notify.show({ title: 'File Scan Failed', body: `Could not safely scan ${file.name}`, type: 'error', appName: 'System' });
        return false;
      }

      if (!verdict.safe) {
        const reason = verdict.reason || 'The file did not pass the safety scan.';
        Notify.show({ title: 'File Blocked', body: `"${file.name}": ${reason}`, type: 'error', appName: 'System' });
        console.warn('[Security] File blocked by scanner:', { file: file.name, reason });
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Desktop', category: 'security', severity: 'warn', message: `Blocked file "${file.name}": ${reason}`, data: { file: file.name, reason } });
        }
        return false;
      }

      let content;
      try {
        const useText = isTextFile(file);
        const result = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
          if (useText) reader.readAsText(file);
          else reader.readAsDataURL(file);
        });

        // Binary content is stored as raw base64 so filesystem consumers can decode
        // the original bytes without a data-URL wrapper.
        content = useText ? result : extractBase64FromDataUrl(result);
        await FS.createFile(desktopId, file.name, content, file.type || 'application/octet-stream');
        return true;
      } catch (error) {
        console.error('[Desktop Drop] File read or save failed:', file.name, error);
        Notify.show({ title: 'Error', body: `Failed to add ${file.name}: ${error.message}`, type: 'error', appName: 'System' });
        return false;
      }
    };

    const results = await Promise.all([...droppedFiles].map(readFile));
    const succeeded = results.filter(Boolean).length;

    // Refresh after all files are processed
    renderDesktopIcons();

    if (succeeded > 0) {
      Notify.show({ title: 'Files Added', body: `${succeeded} file(s) added to desktop`, type: 'success', appName: 'System', duration: 3000 });
    }
  } catch (err) {
    console.error('[Desktop Drop] Unhandled error:', err);
  }
}

function renderDesktopIcons() {
  const desktop = document.getElementById('desktop');
  if (!desktop) return;

  // Respect user showDesktopIcons setting
  if (OS.settings.get('showDesktopIcons') === false) {
    desktop.innerHTML = '';
    return;
  }

  const desktopFolder = FS.specialFolders.desktop;
  if (!desktopFolder) {
    if (!renderDesktopIcons._retryScheduled) {
      renderDesktopIcons._retryScheduled = true;
      setTimeout(() => { renderDesktopIcons._retryScheduled = false; renderDesktopIcons(); }, 400);
    }
    return;
  }
  renderDesktopIcons._retryScheduled = false;

  for (const ac of _iconDragControllers) ac.abort();
  _iconDragControllers = [];

  desktop.innerHTML = '';

  const files = FS.listDir(desktopFolder);
  const iconPositions = OS.settings.get('desktopIconPositions') || {};
  const defaultApps = [];

  // ── Desktop drop handlers ─────────────────────────────────────────
  // FIX: guard prevents re-adding on every renderDesktopIcons() call
  if (!desktop._dropHandlersAttached) {
    desktop._dropHandlersAttached = true;

    desktop.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      desktop.style.opacity = '0.7';
    });

    desktop.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      desktop.style.opacity = '0.7';
    });

    // FIX: use relatedTarget to detect true departure from desktop boundary —
    // original used e.target === desktop which failed when dragging over child icons
    desktop.addEventListener('dragleave', (e) => {
      if (!desktop.contains(e.relatedTarget)) {
        desktop.style.opacity = '1';
      }
    });

    desktop.addEventListener('drop', (e) => {
      desktop.style.opacity = '1';
      _handleDesktopDrop(e, desktop);
    });

    // Document-level fallback for drops on child elements
    document.addEventListener('drop', (e) => {
      if (e.target === desktop || desktop.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        desktop.style.opacity = '1';
        _handleDesktopDrop(e, desktop);
      }
    }, true);
  }

  // ── Taskbar drop handlers ─────────────────────────────────────────
  // FIX: guard prevents re-registering on every renderDesktopIcons() call —
  // original had NO guard, so N renders = N×4 taskbar listeners firing per event
  const taskbar = document.getElementById('taskbar');
  if (taskbar && !taskbar._dropHandlersAttached) {
    taskbar._dropHandlersAttached = true;

    // Drop indicator — a thin bar rendered ABOVE the taskbar, not as a border on it
    const _tbIndicator = (() => {
      let el = document.getElementById('taskbar-drop-indicator');
      if (!el) {
        el = createEl('div', { id: 'taskbar-drop-indicator' });
        el.style.cssText = 'position:fixed;left:0;right:0;height:4px;background:var(--accent);' +
          'box-shadow:0 0 12px var(--accent),0 0 4px var(--accent);border-radius:2px 2px 0 0;z-index:99998;display:none;pointer-events:none;';
        document.body.appendChild(el);
      }
      return el;
    })();

    const _showTbIndicator = () => {
      const rect = taskbar.getBoundingClientRect();
      _tbIndicator.style.top = rect.top + 'px';
      _tbIndicator.style.transform = 'translateY(-100%)';
      _tbIndicator.style.display = 'block';
    };
    const _hideTbIndicator = () => {
      _tbIndicator.style.display = 'none';
    };

    taskbar.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _showTbIndicator();
    });

    taskbar.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      _showTbIndicator();
    });

    taskbar.addEventListener('dragleave', (e) => {
      if (!taskbar.contains(e.relatedTarget)) {
        _hideTbIndicator();
      }
    });

    taskbar.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      _hideTbIndicator();
      try {
        const rawData = e.dataTransfer.getData('application/json');
        if (!rawData) return;
        const payload = JSON.parse(rawData);
        if (payload.type !== 'app-shortcut') return;
        const pinnedApps = OS.settings.get('pinnedApps') || [];
        if (!pinnedApps.includes(payload.appId)) {
          pinnedApps.push(payload.appId);
          OS.settings.set('pinnedApps', pinnedApps);
          if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
          Notify.show({ title: 'Pinned to Taskbar', body: `${payload.appName} pinned to taskbar`, type: 'success', appName: 'Taskbar' });
        }
      } catch (err) {
        console.error('[Taskbar Drop] Error:', err);
      }
    });
  }

  // ── Render default app icons ──────────────────────────────────────
  defaultApps.forEach((app, idx) => {
    const key = 'app:' + app.id;
    const icon = createEl('div', {
      className: 'desktop-icon',
      tabindex: '0',
      'aria-label': app.name,
      role: 'button',
      style: _getInitialIconPosition(key, idx, iconPositions, desktop)
    });
    const img = createEl('div', { className: 'desktop-icon-img' });
    img.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 40);
    const label = createEl('div', { className: 'desktop-icon-label', textContent: app.name });
    icon.appendChild(img);
    icon.appendChild(label);

    _makeIconDraggable(icon, desktop, key, iconPositions);

    icon.addEventListener('dblclick', () => WM.createWindow(app.id));
    icon.addEventListener('click', (e) => {
      if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
      icon.classList.add('selected');
    });
    icon.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pinnedApps = OS.settings.get('pinnedApps') || [];
      const isPinned = pinnedApps.includes(app.id);
      const storedApps = readInstalledApps();
      const isUserApp = storedApps.some(a => a.id === app.id);
      const isSystemApp = storedApps.some(a => a.id === app.id && a.system === true);
      const items = [
        { label: 'Open', icon: 'play', action: () => WM.createWindow(app.id) },
        { separator: true },
        {
          label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
          icon: 'pin',
          action: () => {
            const pins = OS.settings.get('pinnedApps') || [];
            if (isPinned) {
              const next = pins.filter(id => id !== app.id);
              OS.settings.set('pinnedApps', next);
              WM.updateTaskbar();
              Notify.show({ title: 'Unpinned', body: `${app.name} removed from taskbar`, type: 'success', appName: 'Desktop' });
            } else {
              if (pins.includes(app.id)) {
                Notify.show({ title: 'Already Pinned', body: `${app.name} is already pinned to taskbar`, type: 'info', appName: 'Desktop' });
                return;
              }
              const next = [...pins, app.id];
              OS.settings.set('pinnedApps', next);
              WM.updateTaskbar();
              Notify.show({ title: 'Pinned', body: `${app.name} pinned to taskbar`, type: 'success', appName: 'Desktop' });
            }
          }
        }
      ];
      if (isUserApp && isSystemApp) {
        items.push({ separator: true }, {
          label: 'System App', icon: 'lock', disabled: true
        });
      } else if (isUserApp) {
        items.push({ separator: true }, {
          label: 'Uninstall', icon: 'trash', danger: true,
          action: () => uninstallThroughAppManager(app.id, 'Desktop')
        });
      }
      ContextMenu.show(e.clientX, e.clientY, items);
    });
    desktop.appendChild(icon);
  });

  // ── Render desktop files ──────────────────────────────────────────
  files.forEach((f, idx) => {
    let isShortcut = false;
    let shortcutData = null;

    const key = 'file:' + f.id;

    if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
      try {
        shortcutData = JSON.parse(f.content);
        if (shortcutData?.type === 'app-shortcut') isShortcut = true;
      } catch { /* not a valid shortcut, treat as regular file */ }
    }

    let targetApp = null;
    if (isShortcut && shortcutData) {
      const devMode = getLauncherDeveloperMode();
      targetApp = OS.apps?.[shortcutData.target];
      if (!devMode && targetApp?.devOnly) return;

      const appPosKey = 'app:' + shortcutData.target;
      if (iconPositions[appPosKey] && !iconPositions[key]) {
        iconPositions[key] = iconPositions[appPosKey];
      }
    }
    const icon = createEl('div', {
      className: 'desktop-icon',
      tabindex: '0',
      'aria-label': f.name,
      role: 'button',
      style: _getInitialIconPosition(key, defaultApps.length + idx, iconPositions, desktop),
      'data-shortcut-target': isShortcut && shortcutData ? shortcutData.target : ''
    });
    const img = createEl('div', { className: 'desktop-icon-img' });

    if (isShortcut && shortcutData) {
      const isWebShortcut = shortcutData.target && shortcutData.target.startsWith('webapp_');
      // Prefer the live icon from OS.apps over the snapshot baked into the
      // .lnk file at pin-time — the target app's icon can change (e.g. a
      // replace/reinstall with new artwork) without anything ever updating
      // this file, since it's stored on disk and only ever written once.
      const liveIcon = targetApp?.icon;
      const iconToUse = isWebShortcut ? (liveIcon || shortcutData.icon) : (liveIcon || shortcutData.icon || '/assets/no_app_icon.svg');
      img.innerHTML = svgIcon(iconToUse, 40);
      const arrow = createEl('div', {
        style: 'position:absolute;bottom:0;right:0;width:16px;height:16px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:white;font-weight:bold;'
      });
      arrow.textContent = '→';
      img.style.position = 'relative';
      img.appendChild(arrow);
    } else {
      img.innerHTML = svgIcon(FS.getMimeIcon(f.mimeType, f.name), 40);
      if (f.type === 'folder') img.style.color = 'var(--text-warning)';
    }

    const label = createEl('div', {
      className: 'desktop-icon-label',
      textContent: isShortcut ? f.name.replace(/\.lnk$/i, '') : f.name
    });
    icon.appendChild(img);
    icon.appendChild(label);

    _makeIconDraggable(icon, desktop, key, iconPositions);

    icon.addEventListener('dblclick', () => {
      if (isShortcut && shortcutData) {
        // Web app shortcuts need openWebApp() (registry.js), which sets
        // OS.apps[id].init() before creating the window — WM.createWindow()
        // alone only renders content for apps that already define .init(),
        // and a web app shortcut's target has never had one set at this
        // point unless the app happened to be launched earlier this session
        // from somewhere that did (only the App Manager's Open button did).
        // Without this, double-clicking the shortcut opened a blank window.
        if (typeof shortcutData.target === 'string' && shortcutData.target.startsWith('webapp_') && typeof window.openWebApp === 'function') {
          window.openWebApp(shortcutData.target.slice('webapp_'.length));
        } else {
          WM.createWindow(shortcutData.target);
        }
      } else if (f.type === 'folder') {
        WM.createWindow('files', { folderId: f.id });
      } else {
        openFileWithDefaultApp(f);
      }
    });
    icon.addEventListener('click', (e) => {
      if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
      icon.classList.add('selected');
    });
    icon.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const viewOnly = OS.settings.get('filesViewOnly');
      const menuItems = [
        {
          label: 'Open', icon: 'play',
          action: () => {
            if (isShortcut && shortcutData) {
              if (typeof shortcutData.target === 'string' && shortcutData.target.startsWith('webapp_') && typeof window.openWebApp === 'function') {
                window.openWebApp(shortcutData.target.slice('webapp_'.length));
              } else {
                WM.createWindow(shortcutData.target);
              }
            } else if (f.type === 'folder') {
              WM.createWindow('files', { folderId: f.id });
            } else {
              openFileWithDefaultApp(f);
            }
          }
        }
      ];
      if (!isShortcut && f.type !== 'folder') {
        menuItems.push({
          label: 'Open with...', icon: 'external-link',
          action: () => showOpenWithDialog(f),
        });
      }
      if (isShortcut && shortcutData) {
        menuItems.push(
          {
            label: 'Unpin from Desktop', icon: 'pin',
            action: async () => {
              try {
                const fileKey = 'file:' + f.id;
                delete iconPositions[fileKey];
                OS.settings.set('desktopIconPositions', iconPositions);
                await FS.permanentDelete(f.id);
                renderDesktopIcons();
                Notify.show({ title: 'Unpinned', body: `${f.name.replace(/\.lnk$/i, '')} removed from desktop`, type: 'success', appName: 'Desktop' });
              } catch (err) {
                Notify.show({ title: 'Error', body: `Failed to remove shortcut: ${err.message}`, type: 'error', appName: 'Desktop' });
              }
            }
          },
          { separator: true }
        );
        const targetApp = OS.apps?.[shortcutData.target];
        if (targetApp) {
          const pins = OS.settings.get('pinnedApps') || [];
          const isPinned = pins.includes(shortcutData.target);
          menuItems.push({
            label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
            icon: 'pin',
            action: () => {
              const pins = OS.settings.get('pinnedApps') || [];
              if (isPinned) {
                const next = pins.filter(id => id !== shortcutData.target);
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Unpinned', body: `${targetApp.name} removed from taskbar`, type: 'success', appName: 'Desktop' });
              } else {
                if (pins.includes(shortcutData.target)) {
                  Notify.show({ title: 'Already Pinned', body: `${targetApp.name} is already pinned to taskbar`, type: 'info', appName: 'Desktop' });
                  return;
                }
                const next = [...pins, shortcutData.target];
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Pinned', body: `${targetApp.name} pinned to taskbar`, type: 'success', appName: 'Desktop' });
              }
            }
          }, { separator: true });
        }
      }
      if (!viewOnly) {
        menuItems.push(
          {
             label: 'Rename', icon: 'rename',
            action: async () => {
              const name = await showPrompt('Rename', f.name.replace(/\.lnk$/i, ''));
              if (name && name !== f.name.replace(/\.lnk$/i, '')) {
                await FS.rename(f.id, name.endsWith('.lnk') ? name : name + '.lnk');
                renderDesktopIcons();
              }
            }
          },
          { separator: true }
        );
      }
      if (isShortcut && shortcutData) {
        const storedApps = readInstalledApps();
        const isUserApp = storedApps.some(a => a.id === shortcutData.target);
        const isSystemApp = storedApps.some(a => a.id === shortcutData.target && a.system === true);
        const isWebApp = typeof shortcutData.target === 'string' && shortcutData.target.startsWith('webapp_');
        if (isWebApp) {
          // Web app shortcuts aren't in nova_installed_apps (that's only
          // native/package apps), so they were previously falling through
          // both branches below with no removal option at all — the
          // shortcut, taskbar pin, and WebAppManager record all had to be
          // cleaned up by hand, in three different places, none of which
          // existed on the desktop. Reuse the same removeWebApp() helper as
          // the Web Apps tab and launchpad so all three stay in sync.
          menuItems.push({
            label: 'Remove Web App', icon: 'trash', danger: true,
            action: async () => {
              const appName = f.name.replace(/\.lnk$/i, '');
              const removeResult = await showModal(
                'Remove Web App',
                `Remove "${appName}"?`,
                [{ label: 'Cancel' }, { label: 'Remove', value: 'confirm', danger: true }]
              );
              if (removeResult !== 'confirm') return;
              const waId = shortcutData.target.slice('webapp_'.length);
              if (typeof window.removeWebApp === 'function') {
                await window.removeWebApp(waId);
              }
              delete iconPositions['file:' + f.id];
              delete iconPositions['app:' + shortcutData.target];
              OS.settings.set('desktopIconPositions', iconPositions);
              renderDesktopIcons();
              Notify.show({ title: 'Removed', body: `${appName} has been removed.`, type: 'success', appName: 'Desktop' });
            }
          });
        } else if (isUserApp && isSystemApp) {
          menuItems.push({
            label: 'System App', icon: 'lock', disabled: true
          });
        } else if (isUserApp) {
          menuItems.push({
            label: 'Uninstall', icon: 'trash', danger: true,
            action: () => uninstallThroughAppManager(shortcutData.target, 'Desktop')
          });
        }
      } else if (!viewOnly) {
        menuItems.push(
          {
            label: 'Move to Trash', icon: 'trash', danger: true,
            action: async () => {
              await FS.deleteToTrash(f.id);
              renderDesktopIcons();
            }
          }
        );
      }
      ContextMenu.show(e.clientX, e.clientY, menuItems);
    });
    desktop.appendChild(icon);
  });
}

function updateTaskbar() {
      const container = document.getElementById('taskbar-apps');
      if (!container) return;

      const devMode = getLauncherDeveloperMode();
      const pinnedApps = (OS.settings.get('pinnedApps') ?? []).filter(id => {
        if (devMode) return true;
        const app = OS.apps[id];
        return !app?.devOnly;
      });
      const pinnedAppsSet = new Set(pinnedApps); // O(1) lookups vs O(n) includes()

      // Group open windows by appId
      const appWindows = new Map();
      for (const [id, state] of OS.windows) {
        const app = OS.apps[state.appId];
        if (!devMode && app?.devOnly) continue;
        appWindows.getOrInsertComputed(state.appId, () => []).push({ id, state });
      }

      // Ordered: unique pinned apps first (handles duplicate entries in pinnedApps),
      // then any running-but-unpinned apps.
      const orderedIds = [...new Set(pinnedApps)];
      for (const appId of appWindows.keys()) {
        if (!pinnedAppsSet.has(appId)) orderedIds.push(appId);
      }

      // Build into a fragment; swap once to minimise reflows
      const frag = document.createDocumentFragment();

      for (const appId of orderedIds) {
        let app       = OS.apps[appId];
        const windows = appWindows.get(appId) ?? [];
        const isPinned = pinnedAppsSet.has(appId);

        // Pinned web apps only get an OS.apps entry once launched (see
        // openWebApp() in registry.js). OS.apps is in-memory and never
        // persisted, so a web app pinned in a previous session — or pinned
        // without ever being opened — has no entry here and would
        // otherwise be silently skipped by the `if (!app) continue;` below,
        // dropping its taskbar icon entirely. Rebuild it from WebAppManager,
        // the persisted source of truth, before giving up on it.
        //
        // IMPORTANT: this must use buildWebAppEntry(), not a hand-rolled
        // {name, icon, defaultSize, minSize} object. WM.createWindow() only
        // renders content by calling app.init() — a plain object with no
        // .init produces a real window (so it doesn't get skipped) but with
        // permanently empty content, which is why clicking a taskbar icon
        // that was rehydrated here used to open a blank/glass-only window
        // even though double-clicking the same app's desktop shortcut (which
        // goes through openWebApp()) rendered it correctly.
        if (!app && appId.startsWith('webapp_') && typeof WebAppManager !== 'undefined' && typeof buildWebAppEntry === 'function') {
          const waId = appId.slice('webapp_'.length);
          const waData = WebAppManager.getApp(waId);
          if (waData) {
            app = OS.apps[appId] = buildWebAppEntry(waData);
          }
        }

        if (!app) continue;

        const hasWindows         = windows.length > 0;
        const hasMultipleWindows = windows.length > 1;
        const isAnyActive        = windows.some(w => OS.focusedWindowId === w.id && !w.state.minimized);

        const btn = createEl('button', {
          className:   `taskbar-app-btn${isAnyActive ? ' active' : ''}${isPinned ? ' pinned' : ''}`,
          'aria-label': app.name + (hasMultipleWindows ? ` (${windows.length} windows)` : ''),
        });

        btn.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 20);
        btn.appendChild(createEl('span', { className: 'indicator' }));
        if (hasMultipleWindows) {
          btn.appendChild(createEl('span', {
            className:   'taskbar-window-count',
            textContent: String(windows.length),
          }));
        }

        // App-set badge (system:badge permission, host-clamped). Read from
        // the read-only NovaAppBadges store that app-sandbox.js exports;
        // badge updates call WM.updateTaskbar() themselves, so this render
        // pass always runs after the store changed.
        const appBadge = (typeof NovaAppBadges !== 'undefined' && NovaAppBadges.get) ? NovaAppBadges.get(appId) : null;
        if (appBadge) {
          const badgeLabel = appBadge.count != null ? String(appBadge.count) : appBadge.text;
          if (badgeLabel) {
            btn.appendChild(createEl('span', {
              className:   'taskbar-app-badge',
              textContent: badgeLabel,
            }));
          }
        }

        const clickHandler = () => {
          if (!hasWindows) {
            // Web apps need openWebApp() (registry.js) so OS.apps[appId]
            // is (re)built with a real init() before the window opens —
            // see the rehydration comment above. Plain createWindow(appId)
            // only works here if updateTaskbar() already ran the rehydration
            // this render pass; routing explicitly avoids depending on that
            // ordering.
            if (appId.startsWith('webapp_') && typeof openWebApp === 'function') {
              openWebApp(appId.slice('webapp_'.length));
            } else {
              WM.createWindow(appId);
            }
          } else if (hasMultipleWindows) {
            showWindowPreview(btn, appId, windows);
          } else {
            const { id, state } = windows[0];
            if (OS.focusedWindowId === id && !state.minimized) WM.minimizeWindow(id);
            else WM.focusWindow(id);
          }
        };

        const contextMenuHandler = (e) => {
          e.preventDefault();
          const menuItems = [];
          menuItems.push({
            label: 'Open', icon: 'play',
            action: () => {
              if (appId.startsWith('webapp_') && typeof openWebApp === 'function') {
                openWebApp(appId.slice('webapp_'.length));
              } else {
                WM.createWindow(appId);
              }
            }
          });
          menuItems.push({ separator: true });
          menuItems.push({
            label:  isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
            icon:   'pin',
            action: () => {
              const pins = OS.settings.get('pinnedApps') ?? [];
              if (isPinned) {
                const next = pins.filter(p => p !== appId);
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Unpinned', body: `${app.name} removed from taskbar`, type: 'success', appName: 'Taskbar' });
              } else {
                if (pins.includes(appId)) {
                  Notify.show({ title: 'Already Pinned', body: `${app.name} is already pinned to taskbar`, type: 'info', appName: 'Taskbar' });
                  return;
                }
                const next = [...pins, appId];
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Pinned', body: `${app.name} pinned to taskbar`, type: 'success', appName: 'Taskbar' });
              }
            },
          });
          if (hasWindows) {
            menuItems.push({ separator: true });
            menuItems.push({
              label: 'Close Window',
              icon:   'x',
              danger: true,
              action: () => { for (const w of windows) WM.closeWindow(w.id); },
            });
          }
          ContextMenu.show(e.clientX, e.clientY, menuItems);
        };

        btn.addEventListener('click',       clickHandler);
        btn.addEventListener('contextmenu', contextMenuHandler);
        frag.appendChild(btn);
      }

      container.replaceChildren(frag);
  }

// ── Window preview popup ───────────────────────────────────────────────────────
function showWindowPreview(btn, appId, windows) {
  document.querySelector('.taskbar-window-preview')?.remove();

  const preview = createEl('div', { className: 'taskbar-window-preview' });
  let   dismissFn = null;

  // Single helper so every code-path (outside click, item click, close btn)
  // removes the dismiss listener — no orphaned document handlers.
  const closePreview = () => {
    preview.remove();
    if (dismissFn !== null) {
      document.removeEventListener('pointerdown', dismissFn);
      dismissFn = null;
    }
  };

  for (const [index, w] of windows.entries()) {
    const app      = OS.apps[appId];
    const winTitle = w.state.title ?? `Window ${index + 1}`;
    const isActive = OS.focusedWindowId === w.id && !w.state.minimized;

    const item = createEl('div', {
      className: `preview-window-item${isActive ? ' active' : ''}`,
    });

    const icon = createEl('span', { className: 'preview-icon' });
    icon.innerHTML = svgIcon(app.icon, 16);

    const title    = createEl('span', { className: 'preview-title', textContent: winTitle });
    const closeBtn = createEl('button', { className: 'preview-close', 'aria-label': 'Close window' });
    closeBtn.innerHTML = svgIcon('x', 12);

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      WM.closeWindow(w.id);
      closePreview();
    });

    item.addEventListener('click', () => {
      WM.focusWindow(w.id);
      closePreview();
    });

    item.append(icon, title, closeBtn);
    preview.appendChild(item);
  }

  document.body.appendChild(preview);

  const btnRect     = btn.getBoundingClientRect();
  const previewRect = preview.getBoundingClientRect();
  const left        = Math.max(8, Math.min(
    btnRect.left + (btnRect.width  / 2) - (previewRect.width  / 2),
    window.innerWidth - previewRect.width - 8,
  ));
  const bottom = window.innerHeight - btnRect.top + 8;

  preview.style.left   = `${left}px`;
  preview.style.bottom = `${bottom}px`;

  // Dismiss on outside click — deferred to avoid catching the triggering pointerdown
  setTimeout(() => {
    dismissFn = (e) => {
      if (!preview.contains(e.target) && e.target !== btn) closePreview();
    };
    document.addEventListener('pointerdown', dismissFn);
  }, 10);
}

// DESKTOP CONTEXT MENU

const desktopEl = document.getElementById('desktop');
if (desktopEl) {
  desktopEl.addEventListener('pointerdown', (e) => {
    if (
      e.target.closest('.app-window') ||
      e.target.closest('.taskbar') ||
      e.target.closest('.context-menu')
    ) return;
    // Clicking empty desktop defocuses any window and clears focus state.
    if (OS.windows) {
      for (const [, w] of OS.windows) w.element.classList.remove('focused');
    }
    OS.focusedWindowId = null;
    WM.updateTaskbar();
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  desktopEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.desktop-icon')) return;
    e.preventDefault();
    ContextMenu.show(e.clientX, e.clientY, [
      {
        label: 'New File', icon: 'file', action: async () => {
          const name = await showPrompt('New File Name', 'untitled.txt');
          if (!name) return;
          const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
          await FS.createFile(FS.specialFolders.desktop, finalName, '', 'text/plain');
          renderDesktopIcons();
        }
      },
      {
        label: 'New Folder', icon: 'folder', action: async () => {
          const name = await showPrompt('New Folder Name', 'New Folder');
          if (!name) return;
          const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
          await FS.createFolder(FS.specialFolders.desktop, finalName);
          renderDesktopIcons();
        }
      },
      ...(OS.clipboard?.fileId ? [
        { separator: true },
        {
          label: 'Paste', icon: 'paste', action: async () => {
            if (OS.settings?.get?.('disableClipboardPaste')) {
              Notify.show({ title: 'Paste disabled', body: 'Paste disabled.', type: 'error', appName: 'Desktop' });
              return;
            }
            try {
              const clip = OS.clipboard;
              await FS.pasteInto(clip, FS.specialFolders.desktop);
              OS.clipboard = null;
              renderDesktopIcons();
            } catch (err) {
              console.error('[Desktop] paste failed:', err);
              Notify.show({ title: 'Paste failed', body: err?.message || 'Unknown error', type: 'error', appName: 'Desktop' });
            }
          }
        }
      ] : []),
      { separator: true },
      { label: 'Open Terminal', icon: 'terminal', action: () => WM.createWindow('com.astroos.terminal') },
      { label: 'Open Settings', icon: 'settings', action: () => WM.createWindow('com.astroos.settings') },
      { separator: true },
      { label: 'Refresh', action: () => renderDesktopIcons() }
    ]);
  });
}

  function configureLauncherTaskbar(sGet) {
    const taskbar = document.getElementById('taskbar');
    if (!taskbar) return;

    const rootStyle = document.documentElement.style;
    const size = sGet('taskbarSize') || 'normal';
    const height = { compact: '36px', normal: '52px', large: '64px' }[size] || '52px';
    rootStyle.setProperty('--taskbar-height', height);

    const position = sGet('taskbarPosition') || 'bottom';
    // AstroOS: the floating pill taskbar is positioned with CSS classes
    // (.taskbar-top/-left/-right) — see the AstroOS block in style.css.
    taskbar.classList.remove('taskbar-top', 'taskbar-left', 'taskbar-right');
    if (position !== 'bottom') {
      taskbar.classList.add('taskbar-' + position);
    }

    const autoHide = !!sGet('taskbarAutoHide');
    taskbar.classList.toggle('taskbar-autohide', autoHide);
    if (!autoHide) taskbar.classList.remove('taskbar-ah-shown');
    if (autoHide && !window.__tbProximityInit) {
      window.__tbProximityInit = true;
      document.addEventListener('mousemove', (event) => {
        if (!taskbar.classList.contains('taskbar-autohide')) return;
        const currentPosition = OS.settings.get('taskbarPosition') || 'bottom';
        const atEdge = currentPosition === 'top' ? event.clientY <= 8
          : currentPosition === 'left' ? event.clientX <= 8
          : currentPosition === 'right' ? event.clientX >= window.innerWidth - 8
          : event.clientY >= window.innerHeight - 8;
        taskbar.classList.toggle('taskbar-ah-shown', atEdge);
      }, { passive: true });
    }
  }

  function configureLauncherCursorSize(sGet) {
    const cursorSize = sGet('cursorSize');
    if (!cursorSize) return;
    let style = document.getElementById('cursor-custom-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'cursor-custom-styles';
      document.head.appendChild(style);
    }
    const scales = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
    style.textContent = `#desktop .desktop-icon{transform:${scales[cursorSize] || scales.normal}}`;
  }

  function applyLauncherSettings(sGet) {
    configureLauncherTaskbar(sGet);
    configureLauncherCursorSize(sGet);
    const iconSize = Number(sGet('desktopIconSize'));
    if (Number.isFinite(iconSize)) document.documentElement.style.setProperty('--desktop-icon-size', `${iconSize}px`);
    const gridSpacing = Number(sGet('desktopGridSpacing'));
    if (Number.isFinite(gridSpacing)) document.documentElement.style.setProperty('--desktop-grid-spacing', `${gridSpacing}px`);
    const clock = document.getElementById('tray-clock');
    if (clock) clock.style.display = sGet('showTaskbarClock') === false ? 'none' : 'flex';
  }

  window.configureLauncherTaskbar = configureLauncherTaskbar;
  window.configureLauncherCursorSize = configureLauncherCursorSize;
  window.applyLauncherSettings = applyLauncherSettings;

  const systemTray = document.getElementById('system-tray-root');
  const taskbar = document.getElementById('taskbar');
  if (systemTray && taskbar) {
    systemTray.style.display = 'contents';
    taskbar.appendChild(systemTray);
  }
  const taskbarApps = document.getElementById('taskbar-apps');
  if (taskbarApps && taskbar) {
    taskbarApps.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('application/json')) return;
      event.preventDefault();
      taskbar.classList.add('drag-over');
    });
    taskbarApps.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('application/json')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'link';
      taskbar.classList.add('drag-over');
    });
    taskbarApps.addEventListener('dragleave', (event) => {
      if (!taskbarApps.contains(event.relatedTarget)) taskbar.classList.remove('drag-over');
    });
    taskbarApps.addEventListener('drop', (event) => {
      taskbar.classList.remove('drag-over');
      const raw = event.dataTransfer?.getData('application/json');
      if (!raw) return;
      try {
        const payload = JSON.parse(raw);
        if (payload?.type !== 'app-shortcut' || !payload.appId) return;
        event.preventDefault();
        const pins = OS.settings.get('pinnedApps') || [];
        if (pins.includes(payload.appId)) {
          Notify.show({
            title: 'Already Pinned',
            body: `${payload.appName || payload.appId} is already pinned to taskbar`,
            type: 'info',
            appName: 'Taskbar',
          });
          return;
        }
        OS.settings.set('pinnedApps', [...pins, payload.appId]);
        updateTaskbar();
        Notify.show({
          title: 'Pinned to Taskbar',
          body: `${payload.appName || payload.appId} pinned to taskbar`,
          type: 'success',
          appName: 'Taskbar',
        });
      } catch (error) {
        console.warn('[Launcher] Ignoring invalid taskbar drop payload:', error);
      }
    });
  }
  document.getElementById('start-btn')?.addEventListener('click', toggleLaunchpad);
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === ' ') { event.preventDefault(); toggleLaunchpad(); }
    if (event.key === 'Escape' && document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
  });
  window.updateTaskbar = updateTaskbar;
  window.renderDesktopIcons = renderDesktopIcons;
  window.LauncherShell = Object.freeze({
    renderDesktopIcons, updateTaskbar, renderLaunchpad, toggleLaunchpad,
    posToCell: _posToCell, findFreeCell: _findFreeCell,
    switchWorkspace, showAppSwitcher, hideAppSwitcher,
  });


OS.events.on('settings:changed', ({ key }) => {
  switch (key) {
    case 'taskbarSize':
    case 'taskbarPosition':
    case 'taskbarAutoHide':
      configureLauncherTaskbar(OS.settings.get.bind(OS.settings));
      WM.attachTaskbar?.();
      break;
    case 'desktopIconSize': {
      const size = Number(OS.settings.get('desktopIconSize'));
      if (Number.isFinite(size)) document.documentElement.style.setProperty('--desktop-icon-size', size + 'px');
      break;
    }
    case 'desktopGridSpacing': {
      const spacing = Number(OS.settings.get('desktopGridSpacing'));
      if (Number.isFinite(spacing)) document.documentElement.style.setProperty('--desktop-grid-spacing', spacing + 'px');
      break;
    }
    case 'showDesktopIcons':
      renderDesktopIcons();
      break;
    case 'showTaskbarClock': {
      const clock = document.getElementById('tray-clock');
      if (clock) clock.style.display = OS.settings.get('showTaskbarClock') === false ? 'none' : 'flex';
      break;
    }
    case 'devMode': {

  const devMode = getLauncherDeveloperMode();
  if (!devMode) {
    if (isLauncherRootAccessEnabled()) disableLauncherRootAccess();
    if (typeof AppSandbox !== 'undefined'
      && AppSandbox.reloadAfterRootRevocation?.('Developer Mode was disabled')) return;
  }
  let iconPositions = OS.settings.get('desktopIconPositions') || {};
  const devAppIds = new Set();
  for (const [appId, app] of Object.entries(OS.apps || {})) {
    if (app.devOnly) devAppIds.add(appId);
  }

  const devShortcutFileKeys = new Set();
  try {
    const desktopFolder = FS.specialFolders.desktop;
    if (desktopFolder) {
      const files = FS.listDir(desktopFolder);
      for (const f of files) {
        if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
          try {
            const data = JSON.parse(f.content || '{}');
            if (data?.type === 'app-shortcut' && devAppIds.has(data.target)) {
              devShortcutFileKeys.add('file:' + f.id);
            }
          } catch { /* skip invalid */ }
        }
      }
    }
  } catch { /* FS not ready yet */ }

  if (!devMode) {
    const hiddenDevPositions = {};
    for (const [k, pos] of Object.entries(iconPositions)) {
      const appId = k.startsWith('app:') ? k.slice(4) : null;
      if (appId && devAppIds.has(appId)) {
        hiddenDevPositions[k] = { ...pos };
        delete iconPositions[k];
      } else if (devShortcutFileKeys.has(k)) {
        hiddenDevPositions[k] = { ...pos };
        delete iconPositions[k];
      }
    }
    OS.settings.set('desktopIconPositions', iconPositions);
    OS.settings.set('_hiddenDevIconPositions', hiddenDevPositions);
  } else {
    const hiddenDevPositions = OS.settings.get('_hiddenDevIconPositions') || {};

    for (const [k, pos] of Object.entries(hiddenDevPositions) || {}) {
      if (!k.startsWith('app:')) continue;
      const cell = _posToCell(pos);
      if (!cell) continue;
      for (const [otherKey, otherPos] of Object.entries(iconPositions)) {
        const otherAppId = otherKey.startsWith('app:') ? otherKey.slice(4) : null;
        if (otherAppId && devAppIds.has(otherAppId)) continue;
        const otherCell = _posToCell(otherPos);
        if (otherCell && otherCell.col === cell.col && otherCell.row === cell.row) {
          const newCell = _findFreeCell(otherCell.col, otherCell.row, iconPositions, otherKey);
          iconPositions[otherKey] = { col: newCell.col, row: newCell.row };
        }
      }
    }

    for (const [k, pos] of Object.entries(hiddenDevPositions)) {
      iconPositions[k] = pos;
    }
    OS.settings.set('desktopIconPositions', iconPositions);
    OS.settings.set('_hiddenDevIconPositions', null);
  }

  if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
  if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
  if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
      break;
    }
    default:
      break;
  }
});

  const MAX_WORKSPACES = 9;

// VIRTUAL DESKTOPS

function switchWorkspace(direction) {
  if (!OS.workspaces || OS.workspaces.length === 0) return;
  const currentIdx = OS.workspaces.findIndex(w => w.id === OS.currentWorkspace);
  const newIdx = currentIdx + direction;

  if (newIdx >= 0 && newIdx < OS.workspaces.length) {
    OS.currentWorkspace = OS.workspaces[newIdx].id;
  } else if (newIdx >= OS.workspaces.length && OS.workspaces.length < MAX_WORKSPACES) {
    const newWs = { id: Date.now(), name: `Workspace ${OS.workspaces.length + 1}` };
    OS.workspaces.push(newWs);
    OS.currentWorkspace = newWs.id;
    EventLog?.log?.({ app: 'System', category: 'window', severity: 'info', message: `Created ${newWs.name}`, data: { workspaceId: newWs.id } });
  }
}

// APP SWITCHER

let switcherActive = false;
let switcherIdx = 0;

function showAppSwitcher() {
  if (!OS.windows) return;
  const windows = Array.from(OS.windows.values());
  if (windows.length === 0) return;

  switcherActive = true;
  switcherIdx = 0;

  const switcher = document.getElementById('app-switcher');
  const list = document.getElementById('app-switcher-list');
  if (!switcher || !list) return;
  list.innerHTML = '';

  windows.forEach((w, i) => {
    const app = OS.apps?.[w.appId];
    if (!app) return;
    const item = createEl('div', { className: 'app-switcher-item' + (i === 0 ? ' active' : '') });
    const icon = createEl('div', { className: 'app-switcher-icon' });
    icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 32);
    item.appendChild(icon);
    item.appendChild(createEl('div', { className: 'app-switcher-name', textContent: app.name }));
    list.appendChild(item);
  });

  switcher.classList.add('active');
}

function hideAppSwitcher() {
  document.getElementById('app-switcher')?.classList.remove('active');
  switcherActive = false;
}

document.addEventListener('keyup', (e) => {
  if (!switcherActive || e.key !== 'Alt') return;
  hideAppSwitcher();
  if (!OS.windows) return;
  const windows = Array.from(OS.windows.values());
  if (windows[switcherIdx]) WM.focusWindow(windows[switcherIdx].id);
});

  // ── AstroOS: PILL TASKBAR AUTO-HIDE ────────────────────────────────────────
  // CSS :hover only catches a 3px strip when the pill is hidden — JS edge
  // detection reliably shows it when the user moves to the bottom edge.
  // If the user enables the native `taskbarAutoHide` setting, that system
  // takes over and this one stands down.
  (function _initPillTaskbar() {
    const _tb = document.getElementById('taskbar');
    if (!_tb) return;

    let _visible = true;
    let _hideTimer = null;  // null = idle, number = pending hide
    let _hovered = false;

    const _nativeAutohide = () => _tb.classList.contains('taskbar-autohide');

    function _applyVisible() {
      _tb.style.transform = 'translateX(-50%) translateY(0)';
      _tb.style.opacity = '1';
      _tb.style.pointerEvents = 'auto';
    }
    function _applyHidden() {
      _tb.style.transform = 'translateX(-50%) translateY(calc(100% + 24px))';
      _tb.style.opacity = '0';
      _tb.style.pointerEvents = 'none';
    }

    function _showPill() {
      if (_hideTimer !== null) { clearTimeout(_hideTimer); _hideTimer = null; }
      if (_visible) return;
      _visible = true;
      _applyVisible();
    }

    function _hidePill() {
      if (_hideTimer !== null) return;
      if (!_visible) return;
      _hideTimer = setTimeout(function () {
        _hideTimer = null;
        if (!_hovered) {
          _visible = false;
          _applyHidden();
        }
      }, 600);
    }

    function _hasOpenWindows() {
      const wins = document.querySelectorAll('.app-window');
      for (let i = 0; i < wins.length; i++) {
        if (wins[i].style.display !== 'none') return true;
      }
      return false;
    }

    _tb.addEventListener('mouseenter', function () {
      _hovered = true;
      if (_hideTimer !== null) { clearTimeout(_hideTimer); _hideTimer = null; }
      if (!_visible) { _visible = true; _applyVisible(); }
    });
    _tb.addEventListener('mouseleave', function () {
      _hovered = false;
      if (_hasOpenWindows()) _hidePill();
    });

    // Bottom-edge swipe — always show the pill
    document.addEventListener('mousemove', function (e) {
      if (e.clientY >= window.innerHeight - 16) {
        _hovered = false; // treat edge-trigger like a hover-enter
        if (_hideTimer !== null) { clearTimeout(_hideTimer); _hideTimer = null; }
        if (!_visible) { _visible = true; _applyVisible(); }
      }
    }, { passive: true });

    // Poll every 500ms to sync state — only triggers a hide ONCE per open session
    setInterval(function () {
      if (_hovered || _nativeAutohide()) return;
      const lp = document.getElementById('launchpad');
      const lpOpen = lp && lp.classList.contains('active');
      if (lpOpen || _hasOpenWindows()) {
        _hidePill();   // no-op if hide already pending or already hidden
      } else {
        _showPill();   // no-op if already visible
      }
    }, 500);

    _tb.style.transition = 'transform 440ms cubic-bezier(0.34,1.56,0.64,1), opacity 280ms ease';
    // Boot: always start visible
    _visible = false; // force _showPill to apply styles
    _showPill();
  })();

  window.renderLaunchpad = renderLaunchpad;
  window.toggleLaunchpad = toggleLaunchpad;
})();
