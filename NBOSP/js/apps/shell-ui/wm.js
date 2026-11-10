// ── Window Manager ─────────────────────────────────────────────────────────────
//
// Fixes & optimisations applied vs. the original:
//  • IIFE wrapper gives private scope for the work-area cache, keeping the public
//    API identical.
//  • Work-area computed once and cached (_waCache); invalidated by window-resize,
//    taskbar class-mutations, and taskbar resize-events — eliminating repeated
//    getBoundingClientRect / getComputedStyle calls on every drag/resize RAF.
//  • clampWindowRect() accepts an optional pre-computed area argument so hot
//    paths (drag/resize) pass the same snapshot rather than recomputing it per
//    frame.
//  • pointermove / pointerup listeners are installed dynamically on drag/resize
//    start and removed on end — no more always-on document listeners for every
//    open window.  Each setup also registers a safety-net cleanup in state.cleanups
//    that fires if the window is closed mid-drag/resize.
//  • pointercancel is now handled (same path as pointerup) so drags/resizes
//    terminate cleanly when the OS cancels pointer input.
//  • dragleave bug fixed: the original checked e.target === content which failed
//    when the pointer moved to a child element inside content.  Correct check is
//    !content.contains(e.relatedTarget).
//  • dropExt variable removed — the already-computed ext is reused for the mime
//    lookup.
//  • closeWindow uses animationend {once:true} + 250 ms fallback rather than a
//    hard-coded 150 ms setTimeout, so the close animation fully completes before
//    DOM cleanup regardless of CSS timing.
//  • minimizeWindow stores its hide-timer on state._minimizeTimer;
//    restoreWindow cancels it to prevent a race where the element is hidden after
//    the user has already restored it.
//  • updateTaskbar: pinnedApps converted to a Set for O(1) lookups; orderedIds
//    built with new Set() to handle duplicate entries in pinnedApps; Map now uses
//    getOrInsertComputed() to avoid allocating a default array that is immediately
//    discarded; badge element built with createEl/textContent instead of HTML
//    string concatenation; output built in a DocumentFragment then swapped with
//    replaceChildren() to minimise reflows; for…of used throughout.
//  • showWindowPreview: a shared closePreview() helper removes the dismiss
//    listener from every code-path so it can never be orphaned.
//  • Empty catch blocks replaced with console.warn.
//  • Template literals used throughout; optional-chaining applied where relevant.
//  • Dead code removed: the redundant window.WM assignment and the undefined
//    WindowInstance guard at the original EOF.

const WM = window.WM = (() => {
  // ── Work-area cache ────────────────────────────────────────────────────────
  // Invalidated by window resize, taskbar class changes, and taskbar resizes.
  let _waCache = null;
  const _clearWACache = () => { _waCache = null; };
  const resetShellScroll = () => {
    const root = document.documentElement;
    const body = document.body;
    if (root) { root.scrollLeft = 0; root.scrollTop = 0; }
    if (body) { body.scrollLeft = 0; body.scrollTop = 0; }
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  if (typeof window.resetShellScroll !== 'function') window.resetShellScroll = resetShellScroll;
  window.addEventListener('resize', _clearWACache, { passive: true });
  window.addEventListener('scroll', resetShellScroll, { passive: true });

  // ── WM object ──────────────────────────────────────────────────────────────
  const wm = {
    container:   null,
    snapPreview: null,
    snapCompass: null,

    init() {
      wm.container   = document.getElementById('windows');
      wm.snapPreview = document.getElementById('snap-preview');
      wm.snapCompass = document.getElementById('snap-compass');

      wm.attachTaskbar();
    },

    attachTaskbar() {
      const existingTaskbar = document.getElementById('taskbar');
      if (!existingTaskbar || existingTaskbar._wmTaskbarAttached) return;
      existingTaskbar._wmTaskbarAttached = true;
      // Invalidate work-area cache whenever the taskbar changes size or visibility
      const tb = document.getElementById('taskbar');
      if (tb) {
        new MutationObserver(_clearWACache).observe(tb, {
          attributes:      true,
          attributeFilter: ['class'],
        });
        new ResizeObserver(_clearWACache).observe(tb);
      }


    },

    createWindow(appId, options = {}) {
      if (appId === 'launchpad') { window.toggleLaunchpad?.(); return null; }
      appId = window.NovaAppIdAliases?.canonicalize(appId) || appId;

      const disabled = (() => {
        // Registry-backed (HKNU/apps/disabled) via RegistryPrefs.
        try { return (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : []; }
        catch { return []; }
      })();
      if (disabled.some(x => (typeof x === 'string' ? x : x?.id) === appId)) {
        return null;
      }

      const id  = generateId();
      const app = OS.apps[appId];
      if (!app) return null;

      const systemSettings = window.NovaByteSystem?.settings;
      if (!systemSettings || typeof systemSettings.get !== 'function') {
        throw new Error('NovaByte System settings API is unavailable');
      }
      if (!systemSettings.get('devMode') && app.devOnly) return null;

      const defaults = {
        width:     app.defaultSize?.[0] ?? 700,
        height:    app.defaultSize?.[1] ?? 500,
        x:         80 + Math.random() * 200,
        y:         40 + Math.random() * 100,
        minWidth:  app.minSize?.[0]     ?? 300,
        minHeight: app.minSize?.[1]     ?? 200,
        maxWidth:  app.maxSize?.[0]     ?? null,
        maxHeight: app.maxSize?.[1]     ?? null,
      };
      const cfg = { ...defaults, ...options };

      // Shell Bags (HKNU/shell/bags/windows/<app-id> — the Explorer "Bags"
      // idea): remember each app's last on-screen geometry and restore it on
      // the next open instead of cascading randomly. Explicit x/y in the
      // launch options (scripted/centered dialogs) always win.
      if (options.x === undefined && options.y === undefined) {
        const bag = wm.windowBag(appId);
        if (bag) {
          if (Number.isFinite(bag.x) && Number.isFinite(bag.y)) { cfg.x = bag.x; cfg.y = bag.y; }
          if (Number.isFinite(bag.width)  && bag.width  >= cfg.minWidth)  cfg.width  = bag.width;
          if (Number.isFinite(bag.height) && bag.height >= cfg.minHeight) cfg.height = bag.height;
        }
      }

      const win = createEl('div', {
        className: 'app-window opening',
        style: {
          left:   `${cfg.x}px`,
          top:    `${cfg.y}px`,
          width:  `${cfg.width}px`,
          height: `${cfg.height}px`,
          zIndex: ++OS.windowZCounter,
        },
        role:         'dialog',
        'aria-label': `${app.name} window`,
      });
      win.dataset.windowId = id;
      win.dataset.appId    = appId;

      // Resize handles
      for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        win.appendChild(createEl('div', {
          className:    `window-resize-handle ${d}`,
          'aria-hidden': 'true',
        }));
      }

      // Title bar
      const titlebar  = createEl('div', { className: 'window-titlebar' });
      const icon      = createEl('div', { className: 'window-titlebar-icon' });
      icon.innerHTML  = svgIcon(app.icon, 16);
      const titleText = createEl('span', { className: 'window-titlebar-text', textContent: app.name });
      const controls  = createEl('div', { className: 'window-controls' });
      const closeBtn  = createEl('button', { className: 'window-control-btn close',    'aria-label': 'Close window' });
      const minBtn    = createEl('button', { className: 'window-control-btn minimize', 'aria-label': 'Minimize window' });
      const maxBtn    = createEl('button', { className: 'window-control-btn maximize', 'aria-label': 'Maximize window' });

      closeBtn.innerHTML = '<span class="material-symbols-rounded wctrl-icon">close</span>';
      minBtn.innerHTML   = '<span class="material-symbols-rounded wctrl-icon">remove</span>';
      maxBtn.innerHTML   = '<span class="material-symbols-rounded wctrl-icon">crop_square</span>';

      controls.append(minBtn, maxBtn, closeBtn);
      titlebar.append(icon, titleText, controls);
      win.appendChild(titlebar);

      const content = createEl('div', { className: 'window-content' });
      win.appendChild(content);

      wm.container.appendChild(win);

      const state = {
        id, appId, element: win, content, titlebar, titleText,
        x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
        minWidth: cfg.minWidth, minHeight: cfg.minHeight,
        maxWidth: cfg.maxWidth, maxHeight: cfg.maxHeight,
        maximized: false, minimized: false,
        preMaxState: null, snapSide: null, preSnapState: null,
        _minimizeTimer: null,
        cleanups: [],
      };
      OS.windows.set(id, state);

      // Clamp spawn position so the window never starts outside the OS viewport
      const spawnArea = wm.getWorkArea();
      const clamped   = wm.clampWindowRect(state, state.x, state.y, state.width, state.height, spawnArea);
      state.x      = clamped.x;  state.y      = clamped.y;
      state.width  = clamped.w;  state.height = clamped.h;
      win.style.left   = `${state.x}px`;
      win.style.top    = `${state.y}px`;
      win.style.width  = `${state.width}px`;
      win.style.height = `${state.height}px`;

      win.addEventListener('animationend', () => win.classList.remove('opening'), { once: true });

      wm.setupDrag(state);
      wm.setupResize(state);

      // Button + interaction handlers
      const onClose    = () => wm.closeWindow(id);
      const onMin      = () => wm.minimizeWindow(id);
      const onMax      = () => wm.toggleMaximize(id);
      const onFocus    = () => wm.focusWindow(id);
      const onDblClick = () => wm.toggleMaximize(id);

      closeBtn.addEventListener('click',    onClose);
      minBtn.addEventListener('click',      onMin);
      maxBtn.addEventListener('click',      onMax);
      win.addEventListener('pointerdown',   onFocus);
      titlebar.addEventListener('dblclick', onDblClick);

      state.cleanups.push(
        () => closeBtn.removeEventListener('click',    onClose),
        () => minBtn.removeEventListener('click',      onMin),
        () => maxBtn.removeEventListener('click',      onMax),
        () => win.removeEventListener('pointerdown',   onFocus),
        () => titlebar.removeEventListener('dblclick', onDblClick),
      );

      // ── Drag-and-drop support ────────────────────────────────────────────────

      const onDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect   = 'copy';
        content.style.background    = 'var(--bg-overlay)';
        content.style.borderRadius  = '8px';
      };

      const onDragLeave = (e) => {
        // Only clear the highlight when the pointer fully leaves `content` itself,
        // not when it enters a child element within it.
        if (!content.contains(e.relatedTarget)) {
          content.style.background   = '';
          content.style.borderRadius = '';
        }
      };

      const onDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        content.style.background   = '';
        content.style.borderRadius = '';

        const { files } = e.dataTransfer;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];

          if (window.Scanner) {
            let verdict;
            try {
              verdict = await window.Scanner.scan(file);
            } catch (err) {
              console.warn('[WM] Scanner error:', err);
              verdict = { safe: false, reason: `Could not verify "${file.name}" — dropped in a safe state and skipped.` };
            }
            if (!verdict.safe) {
              Notify.show({ title: 'File Blocked', body: verdict.reason, type: 'error', appName: 'Security' });
              continue;
            }
          }

          if (app.onDrop) {
            try {
              await app.onDrop(file, state);
            } catch (err) {
              console.warn(`[WM] ${appId}.onDrop error:`, err);
            }
          } else {
            const ext       = file.name.split('.').pop().toLowerCase();
            const targetApp = ['txt', 'md', 'js', 'html', 'css', 'json'].includes(ext)
              ? 'textedit'
              : 'files';

            const fileData = await file.arrayBuffer();
            let mime = file.type;
            if (!mime) {
              const extMap = {
                jpg:  'image/jpeg',        jpeg: 'image/jpeg',
                png:  'image/png',         gif:  'image/gif',
                webp: 'image/webp',        bmp:  'image/bmp',
                svg:  'image/svg+xml',     mp3:  'audio/mpeg',
                mp4:  'audio/mp4',         ogg:  'audio/ogg',
                wav:  'audio/wav',         flac: 'audio/flac',
                m4a:  'audio/mp4',         pdf:  'application/pdf',
                txt:  'text/plain',        md:   'text/markdown',
                json: 'application/json',
              };
              mime = extMap[ext] ?? 'application/octet-stream';
            }
            const fileNode = await FS.createFile(
              FS.specialFolders.desktop ?? FS.rootId,
              file.name,
              new Uint8Array(fileData),
              mime
            );
            wm.createWindow(targetApp, { fileId: fileNode.id });
          }
        }

        const text = e.dataTransfer.getData('text/plain');
        if (text && app.onDropText) {
          try {
            app.onDropText(text, state);
          } catch (err) {
            console.warn(`[WM] ${appId}.onDropText error:`, err);
          }
        }
      };

      content.addEventListener('dragover',  onDragOver);
      content.addEventListener('dragleave', onDragLeave);
      content.addEventListener('drop',      onDrop);
      state.cleanups.push(
        () => content.removeEventListener('dragover',  onDragOver),
        () => content.removeEventListener('dragleave', onDragLeave),
        () => content.removeEventListener('drop',      onDrop),
      );

      wm.focusWindow(id);
      wm.updateTaskbar();
      wm.applyWindowFlags(state);

      // If this app already has a live sandbox sitting in the background
      // host (system:background:live kept it alive after a previous
      // window close), reattach that instance instead of launching a
      // second, independent one — otherwise the app silently ends up
      // running twice, with the original orphaned and its pinned
      // notification now describing a process the user can't see or find
      // from this new window.
      let reattached = false;
      if (!options?.fileIntent && typeof AppSandbox !== 'undefined') {
        const bg = AppSandbox.getAllSandboxes().find(s => s.appId === appId && s.backgrounded);
        if (bg) {
          reattached = AppSandbox.reattachFromBackground(bg.sandboxId, content, state);
          if (reattached && typeof Notify !== 'undefined' && Notify.unpin) {
            Notify.unpin(`pin_bg_${appId}`);
          }
        }
      }

      try {
        if (!reattached && app.init) {
          const initResult = app.init(content, state, options);
          // app.init is a generic hook: built-in apps call it as a plain
          // sync function with no meaningful return, but AppSandbox-backed
          // apps route it through AppRegistry.launchApp, which is async and
          // resolves to { cleanup: () => destroy(sandboxId), ... } (or
          // null on an early-return path like a denied-permission or
          // disabled-app launch). Without this, that cleanup was silently
          // discarded — closeWindow's cleanup loop below never ran
          // destroy() for any sandboxed app, so no storage partition was
          // ever wiped on a normal window close.
          if (initResult && typeof initResult.then === 'function') {
            initResult.then(result => {
              if (!result || typeof result.cleanup !== 'function') return;
              const current = OS.windows.get(id);
              if (current === state) {
                // Window is still open — register normally so the
                // existing close path (closeWindow's cleanup loop) runs
                // this exactly once, same as every other cleanup.
                state.cleanups.push(result.cleanup);
              } else {
                // Window already closed before launchApp resolved (fast
                // close). closeWindow's cleanup loop for this id has
                // already run and will never run again, so push()'ing
                // here would silently strand this cleanup forever — call
                // it directly instead.
                try { result.cleanup(); } catch (err) { console.warn(`[WM] ${appId} late cleanup error:`, err); }
              }
            }).catch(err => {
              console.warn(`[WM] ${appId}.init rejected:`, err);
              if (typeof EventLog !== 'undefined') {
                EventLog.log({ app: 'WM', category: 'window', severity: 'error', message: `${appId}.init rejected: ${err?.message || err}`, data: { windowId: id, appId } });
              }
            });
          }
        }
      } catch (err) {
        console.warn(`[WM] ${appId}.init error:`, err);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'WM', category: 'window', severity: 'error', message: `${appId}.init threw: ${err?.message || err}`, data: { windowId: id, appId } });
        }
      }

      // `app` here is the exact object reference registerApp() pushed into
      // APP_REGISTRY (OS.apps[appId] and the APP_REGISTRY entry are the same
      // object, not a copy) — so mutating it directly is enough, no separate
      // lookup-by-id needed. Previously nothing on this path ever touched
      // launchCount, so every app showed 0 in Inspector regardless of how
      // many times it had actually been opened. Not to be confused with the
      // unrelated launchCount tracked by platform/core/app-registry.js,
      // which is a separate sandboxed-app registry with its own storage.
      app.launchCount = (app.launchCount || 0) + 1;
      app.lastLaunched = Date.now();

      OS.events.emit('app:opened', { id, appId });
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'WM', category: 'window', severity: 'info', message: `Opened window for ${appId}`, data: { windowId: id, appId } });
      }
      return state;
    },

    closeWindow(id, options = {}) {
      const { forceKill = false } = options;
      const state = OS.windows.get(id);
      if (!state) return Promise.resolve();

      state.element.classList.add('closing');

      // Use animationend for accurate timing; fall back after 250 ms in case
      // no animation fires (reduced-motion, missing keyframe, etc.).
      let closed = false;
      let resolveClosed;
      const closedPromise = new Promise(res => { resolveClosed = res; });
      const finishClose = () => {
        if (closed) return;
        closed = true;
        clearTimeout(fallback);

        // system:background:live keep-alive check. This only ever keeps the
        // *sandbox* (the webview + its process) alive — the window chrome,
        // event listeners, and OS.windows entry for this window are always
        // torn down below exactly as before. What changes is whether
        // AppSandbox destroys the webview or reparents it into the hidden
        // background host first. An app must hold the grant AND have
        // explicitly opted in this session via nova.stayAliveInBackground()
        // (sandbox.wantsBackgroundLive, see handleBackgroundStayAlive in
        // app-sandbox.js) for this to trigger — holding the grant alone is
        // no longer sufficient. It used to be: every app with the
        // permission got backgrounded on every close, whether or not it
        // (or the user) had actually asked for that this session.
        //
        // forceKill skips this entirely: uninstall, "disable app", and any
        // other path that's actually removing the app (see
        // AppRegistry.unregisterApp) must not let a background grant turn
        // into an orphaned webview that outlives the registry entry, its
        // files, and its permissions. Those callers pass forceKill: true and
        // additionally terminate any sandbox already sitting in the
        // background host for this app (see below), since the app may have
        // been backgrounded in an earlier session already.
        let keptAlive = false;
        let isFirstBackground = false;
        try {
          if (!forceKill &&
              typeof AppPermissionManager !== 'undefined' &&
              typeof AppSandbox !== 'undefined' &&
              AppPermissionManager.isGranted('system:background:live', state.appId)) {
            const sandbox = AppSandbox.getAllSandboxes().find(s => s.windowId === id && !s.backgrounded);
            if (sandbox && sandbox.wantsBackgroundLive) {
              isFirstBackground = !sandbox.everBackgrounded;
              keptAlive = AppSandbox.detachToBackground(sandbox.sandboxId);
            }
          }
        } catch (err) {
          console.warn('[WM] background keep-alive check failed:', err);
        }

        for (const cleanup of state.cleanups) {
          try { cleanup(); } catch (err) { console.warn('[WM] cleanup error:', err); }
        }
        // Shell Bags: remember the geometry for the next open of this app.
        // Maximized/snapped rects are skipped — restoring a full-screen rect
        // would defeat the bag; the window reopens at its pre-max size.
        try {
          if (!state.maximized && !state.snapSide && Number.isFinite(state.x) && Number.isFinite(state.y)) {
            wm.writeWindowBag(state.appId, {
              x: Math.round(state.x), y: Math.round(state.y),
              width: Math.round(state.width), height: Math.round(state.height),
            });
          }
        } catch (err) { /* best-effort — bags must never block a close */ }
        state.element.remove();
        OS.windows.delete(id);

        const app = OS.apps[state.appId];
        if (app?.onClose) {
          try { app.onClose(state); } catch (err) { console.warn(`[WM] ${state.appId}.onClose error:`, err); }
        }

        if (keptAlive && typeof Notify !== 'undefined' && Notify.pinBackgroundApp) {
          const appName = app?.name || state.appId;
          if (isFirstBackground) {
            Notify.show({ title: `${appName} started running in the background`, type: 'info', appName, appId: state.appId });
          }
          Notify.pinBackgroundApp(state.appId, {
            appName,
            onTerminate: () => {
              const sandbox = AppSandbox.getAllSandboxes().find(s => s.appId === state.appId && s.backgrounded);
              if (sandbox) AppSandbox.terminateBackground(sandbox.sandboxId);
            },
          });
        }

        if (OS.focusedWindowId === id) {
          OS.focusedWindowId = null;
          const remaining = [...OS.windows.values()];
          if (remaining.length > 0) {
            const top = remaining.reduce((a, b) =>
              Number(a.element.style.zIndex) > Number(b.element.style.zIndex) ? a : b
            );
            wm.focusWindow(top.id);
          }
        }

        wm.updateTaskbar();
        OS.events.emit('app:closed', { id, appId: state.appId });
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'WM', category: 'window', severity: 'info', message: `Closed window for ${state.appId}`, data: { windowId: id, appId: state.appId } });
        }
        resolveClosed();
      };

      const fallback = setTimeout(finishClose, 250);
      state.element.addEventListener('animationend', finishClose, { once: true });
      return closedPromise;
    },

    minimizeWindow(id) {
      const state = OS.windows.get(id);
      if (!state) return;
      state.minimized = true;
      state.element.classList.add('minimizing');
      if (OS.focusedWindowId === id) OS.focusedWindowId = null;
      wm.updateTaskbar();
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'WM', category: 'window', severity: 'info', message: `Minimized window for ${state.appId}`, data: { windowId: id, appId: state.appId } });
      }
      // Store timer so restoreWindow can cancel it before it hides the element
      state._minimizeTimer = setTimeout(() => {
        state._minimizeTimer = null;
        if (state.minimized) state.element.style.display = 'none';
      }, 300);
    },

    restoreWindow(id) {
      const state = OS.windows.get(id);
      if (!state) return;
      // Cancel any pending hide-timer from minimizeWindow to prevent race
      if (state._minimizeTimer !== null) {
        clearTimeout(state._minimizeTimer);
        state._minimizeTimer = null;
      }
      state.minimized = false;
      state.element.style.display = '';
      state.element.classList.remove('minimizing');
      state.element.classList.add('restoring');
      wm.focusWindow(id);
      state.element.addEventListener('animationend',
        () => state.element.classList.remove('restoring'), { once: true });
      wm.updateTaskbar();
    },

    // ── Shell Bags (HKNU/shell/bags/*) ─────────────────────────────
    // Per-app window geometry remembered across opens, the way Explorer
    // remembers folder window sizes. New persistence — no legacy channel:
    // when the registry engine is down the bag reads null and windows
    // cascade exactly as before, so this degrades silently.

    windowBag(appId) {
      try {
        const r = window.NovaRegistry;
        if (!r || typeof r.get !== 'function' || typeof appId !== 'string' || !appId) return null;
        const bag = r.get(`HKNU/shell/bags/windows/${appId}`);
        if (!bag || typeof bag !== 'object') return null;
        const { x, y, width, height } = bag;
        const ok = (v) => Number.isFinite(v) && v >= 0 && v <= 32767;
        if (!ok(x) || !ok(y) || !ok(width) || !ok(height)) return null;
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      } catch { return null; }
    },

    writeWindowBag(appId, rect) {
      try {
        const r = window.NovaRegistry;
        if (!r || typeof r.set !== 'function' || typeof appId !== 'string' || !appId || !rect) return false;
        r.set(`HKNU/shell/bags/windows/${appId}`, rect, { type: 'REG_JSON', source: 'shell-bags' });
        return true;
      } catch { return false; }
    },

    getWorkArea(noGap = false) {
      if (!noGap && _waCache) return _waCache;

      const vw   = Math.max(0, window.innerWidth  || document.documentElement.clientWidth  || 0);
      const vh   = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
      const tb   = document.getElementById('taskbar');
      const area = { left: 0, top: 0, right: vw, bottom: vh };

      if (!tb) {
        const result = { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
        return noGap ? result : (_waCache = result);
      }

      const isHidden = tb.classList.contains('taskbar-autohide') && !tb.classList.contains('taskbar-ah-shown');
      if (isHidden) {
        const result = { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
        return noGap ? result : (_waCache = result);
      }

      const rect   = tb.getBoundingClientRect();
      const style  = window.getComputedStyle(tb);
      let position = 'bottom';
      // AstroOS positions the taskbar with .taskbar-left/-right/-top classes
      if      (tb.classList.contains('taskbar-left'))  position = 'left';
      else if (tb.classList.contains('taskbar-right')) position = 'right';
      else if (tb.classList.contains('taskbar-top'))   position = 'top';
      else if (style.left  === '0px' && style.right  === 'auto') position = 'left';
      else if (style.right === '0px' && style.left   === 'auto') position = 'right';
      else if (style.top   === '0px' && style.bottom === 'auto') position = 'top';

      // Maximize should sit flush against the taskbar edge — the 8px gap
      // below is only for regular floating/snapped windows so they don't
      // visually touch the taskbar. Applying it to maximize left a small
      // sliver of desktop visible on the taskbar side.
      const gap = noGap ? 0 : 8;
      if      (position === 'bottom') area.bottom = Math.max(area.top    + 220, Math.floor(rect.top)   - gap);
      else if (position === 'top')    area.top    = Math.min(area.bottom - 220, Math.ceil(rect.bottom) + gap);
      else if (position === 'left')   area.left   = Math.min(area.right  - 320, Math.ceil(rect.right)  + gap);
      else if (position === 'right')  area.right  = Math.max(area.left   + 320, Math.floor(rect.left)  - gap);

      const result = {
        ...area,
        width:           Math.max(0, area.right  - area.left),
        height:          Math.max(0, area.bottom - area.top),
        taskbarHidden:   false,
        taskbarPosition: position,
      };
      return noGap ? result : (_waCache = result);
    },

    // area is an optional pre-computed work-area snapshot; pass it from hot paths
    // (drag / resize) to avoid calling getWorkArea() on every animation frame.
    clampWindowRect(state, x, y, w, h, area = null) {
      const a    = area ?? wm.getWorkArea();
      const minW = state.minWidth  || 300;
      const minH = state.minHeight || 200;
      const maxW = state.maxWidth  ? Math.max(minW, state.maxWidth)  : (window.innerWidth  || minW);
      const maxH = state.maxHeight ? Math.max(minH, state.maxHeight) : (window.innerHeight || minH);
      const vw   = window.innerWidth;
      const vh   = window.innerHeight;
      const width  = Math.min(Math.max(w, minW), maxW);
      const height = Math.min(Math.max(h, minH), maxH);

      const grabMarginH = 80;
      const minX = a.left - width + grabMarginH;
      const maxX = Math.min(a.right, vw) - grabMarginH;
      const grabH = 32;
      const minY  = a.top;
      const maxY  = a.bottom - grabH;

      return {
        x: Math.min(Math.max(x, minX), maxX),
        y: Math.min(Math.max(y, minY), maxY),
        w: width,
        h: height,
      };
    },

    applyWindowFlags(state) {
      const app = OS.apps[state.appId];
      if (!app) return;
      const el = state.element;

      if (app.alwaysOnTop) {
        const phishingCombo = app.frame === false && app.transparent === true;
        if (phishingCombo) {
          console.warn('[WM] Phishing overlay risk: app', app.id, 'uses alwaysOnTop + frameless + transparent. Restricting z-index below system chrome.');
          el.style.zIndex = '1000';
        } else {
          el.style.zIndex = String(9999 + (Number(el.style.zIndex) || 0));
        }
      }

      if (app.transparent) el.classList.add('app-window--transparent');
      if (app.resizable === false) el.classList.add('app-window--no-resize');
      if (app.frame === false) el.classList.add('app-window--frameless');
      if (app.startMinimized) {
        setTimeout(() => wm.minimizeWindow(state.id), 0);
      }
    },

    toggleMaximize(id) {
      const state = OS.windows.get(id);
      if (!state) return;

      state.element.classList.add('is-maximizing');
      setTimeout(() => state.element.classList.remove('is-maximizing'), 420);

      if (state.maximized) {
        state.maximized = false;
        state.element.classList.remove('maximized');
        // Don't reuse '.restoring' here — that class plays the windowRestore
        // pop-from-minimized keyframe animation, which fights with the
        // instant inline-style snap below and causes a double-animation
        // (the window would visibly "pop" in addition to un-maximizing).
        // 'unmaximizing' instead just gets a plain transition on
        // left/top/width/height so the window eases back to its
        // pre-maximize rect with a single, consistent motion.
        state.element.classList.add('unmaximizing');
        if (state.preMaxState) {
          const { x, y, w, h } = state.preMaxState;
          state.element.style.left   = `${x}px`;
          state.element.style.top    = `${y}px`;
          state.element.style.width  = `${w}px`;
          state.element.style.height = `${h}px`;
          state.x = x;  state.y = y;  state.width = w;  state.height = h;
        }
        setTimeout(() => state.element.classList.remove('unmaximizing'), 400);
      } else {
        state.preMaxState = { x: state.x, y: state.y, w: state.width, h: state.height };
        state.maximized = true;
        state.element.classList.add('maximized');
        const area = wm.getWorkArea(true);
        state.element.style.left   = `${area.left}px`;
        state.element.style.top    = `${area.top}px`;
        state.element.style.width  = `${area.width}px`;
        state.element.style.height = `${area.height}px`;
        state.x      = area.left;   state.y      = area.top;
        state.width  = area.width;  state.height = area.height;
      }
    },

    focusWindow(id) {
      const state = OS.windows.get(id);
      if (!state) return;
      // Every pointerdown anywhere inside a window's content (typing in an
      // input, clicking a button, etc.) bubbles up and calls this via the
      // window's own 'pointerdown' -> onFocus listener (see the listener
      // setup above). Without this guard, an already-focused window still
      // re-bumps z-index, re-toggles every window's .focused class, and
      // re-emits 'app:focused' on every single click inside its own
      // content — which any app reacting to that event (e.g. Inspector's
      // live re-render) would re-run needlessly on every click, including
      // clicks on its own buttons. Only actually do the work when focus is
      // changing to a different window.
      if (!state.minimized && OS.focusedWindowId === id) return;
      if (state.minimized) wm.restoreWindow(id);
      const app = OS.apps?.[state.appId];
      if (app?.alwaysOnTop) {
        // Stay above the normal stacking range, but keep relative ordering
        // among multiple always-on-top windows using the same counter.
        state.element.style.zIndex = String(9999 + (++OS.windowZCounter));
      } else {
        state.element.style.zIndex = ++OS.windowZCounter;
      }
      OS.focusedWindowId = id;
      for (const [wid, w] of OS.windows) {
        w.element.classList.toggle('focused', wid === id);
      }
      wm.updateTaskbar();
      OS.events.emit('app:focused', { id, appId: state.appId });
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'WM', category: 'window', severity: 'info', message: `Focused window for ${state.appId}`, data: { windowId: id, appId: state.appId } });
      }

      const win            = state.element;
      const alreadyFocused = document.activeElement;
      if (!alreadyFocused || !win.contains(alreadyFocused)) {
        const focusable = win.querySelector(
          'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]'
        );
        if (focusable) {
          requestAnimationFrame(() => focusable.focus());
        } else {
          const contentEl = win.querySelector('.window-content');
          if (contentEl) { contentEl.tabIndex = -1; contentEl.focus({ preventScroll: true }); }
        }
      }
    },

    setupDrag(state) {
      const { titlebar } = state;
      let dragging = false;
      let startX, startY, origX, origY;
      let snapZoneCandidate = null, snapZoneCandidateCount = 0;
      let dragArea = null; // cached work area for the duration of one drag operation
      const SNAP_DWELL = 2;

      const rawMove = (e) => {
        if (!dragging) return;
        resetShellScroll();
        const dx   = e.clientX - startX;
        const dy   = e.clientY - startY;
        const next = wm.clampWindowRect(state, origX + dx, origY + dy, state.width, state.height, dragArea);
        state.x = next.x;
        state.y = next.y;
        state.element.style.transform = `translate(${state.x - origX}px, ${state.y - origY}px)`;

        const rawZone = e.altKey ? null : wm.getSnapZone(e.clientX, e.clientY);
        if (rawZone === snapZoneCandidate) {
          snapZoneCandidateCount = Math.min(snapZoneCandidateCount + 1, 10);
        } else {
          snapZoneCandidate      = rawZone;
          snapZoneCandidateCount = 1;
        }
        const activeZone = snapZoneCandidateCount >= SNAP_DWELL ? snapZoneCandidate : null;

        const W = window.innerWidth, H = window.innerHeight;
        const nearEdge = !e.altKey &&
          (e.clientX < 160 || e.clientX > W - 160 || e.clientY < 160 || e.clientY > H - 160);
        if (nearEdge) wm.showSnapCompass(activeZone);
        else          wm.hideSnapCompass();

        if (activeZone) wm.showSnapPreview(activeZone);
        else            wm.hideSnapPreview();
      };

      // Throttled once per createWindow call; reused across all drags for this window
      const onPointerMove = throttleRAF(rawMove);

      const onPointerDown = (e) => {
        if (e.target.closest('.window-controls')) return;

        if (state.maximized) {
          state.maximized = false;
          state.element.classList.remove('maximized');
          const np = document.getElementById('notification-panel');
          if (np?.classList.contains('active')) {
            np.classList.remove('active');
            resetShellScroll();
          }
          if (state.preMaxState) {
            state.width  = state.preMaxState.w;
            state.height = state.preMaxState.h;
            state.element.style.width  = `${state.width}px`;
            state.element.style.height = `${state.height}px`;
            const safeX   = Math.min(e.clientX, window.innerWidth - 80);
            const restored = wm.clampWindowRect(state, safeX - state.width / 2, e.clientY - 10, state.width, state.height);
            state.x = restored.x;  state.y = restored.y;
            state.element.style.left = `${state.x}px`;
            state.element.style.top  = `${state.y}px`;
          }
        }

        if (state.snapSide) {
          state.snapSide = null;
          if (state.preSnapState) {
            state.width  = state.preSnapState.w;
            state.height = state.preSnapState.h;
            state.element.style.width  = `${state.width}px`;
            state.element.style.height = `${state.height}px`;
            const safeX = Math.min(e.clientX, window.innerWidth - 80);
            const r = wm.clampWindowRect(state, safeX - state.width / 2, e.clientY - 10, state.width, state.height);
            state.x = r.x;  state.y = r.y;
            state.element.style.left = `${state.x}px`;
            state.element.style.top  = `${state.y}px`;
            state.preSnapState = null;
          }
        }

        dragging = true;
        resetShellScroll();
        dragArea = wm.getWorkArea(); // computed once; reused every RAF in rawMove
        startX   = e.clientX;  startY = e.clientY;
        origX    = state.x;    origY  = state.y;
        state.element.style.transition = 'none';
        state.element.style.willChange = 'transform';
        state.element.classList.add('is-dragging');
        document.body.style.cursor = 'grabbing';
        e.preventDefault();

        // Install move/up listeners only for the duration of this drag
        document.addEventListener('pointermove',   onPointerMove);
        document.addEventListener('pointerup',     onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
      };

      const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        dragArea = null;

        document.removeEventListener('pointermove',   onPointerMove);
        document.removeEventListener('pointerup',     onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        state.element.classList.remove('is-dragging');
        state.element.style.transition = 'none';
        state.element.style.left       = `${state.x}px`;
        state.element.style.top        = `${state.y}px`;
        state.element.style.transform  = 'none';
        document.body.style.cursor     = '';
        resetShellScroll();

        requestAnimationFrame(() => {
          state.element.style.transform  = '';
          state.element.style.willChange = '';
          requestAnimationFrame(() => {
            state.element.style.transition = '';
          });
        });

        const activeZone = snapZoneCandidateCount >= SNAP_DWELL ? snapZoneCandidate : null;
        if (activeZone) {
          if (activeZone === 'top') wm.toggleMaximize(state.id);
          else                      wm.snapWindow(state, activeZone);
        }
        snapZoneCandidate      = null;
        snapZoneCandidateCount = 0;
        wm.hideSnapPreview();
        wm.hideSnapCompass();
      };

      titlebar.addEventListener('pointerdown', onPointerDown);
      state.cleanups.push(
        () => titlebar.removeEventListener('pointerdown', onPointerDown),
        // Safety net: removes dynamic listeners if the window is closed mid-drag
        () => {
          document.removeEventListener('pointermove',   onPointerMove);
          document.removeEventListener('pointerup',     onPointerUp);
          document.removeEventListener('pointercancel', onPointerUp);
        },
      );
    },

    setupResize(state) {
      const handles = state.element.querySelectorAll('.window-resize-handle');
      let resizing = false;
      let dir = '', startX, startY, origX, origY, origW, origH;
      let resizeArea = null;

      const rawMove = (e) => {
        if (!resizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newW = origW, newH = origH, newX = origX, newY = origY;

        if (dir.includes('e')) newW = Math.max(state.minWidth,  origW + dx);
        if (dir.includes('w')) { newW = Math.max(state.minWidth,  origW - dx); newX = origX + origW - newW; }
        if (dir.includes('s')) newH = Math.max(state.minHeight, origH + dy);
        if (dir.includes('n')) { newH = Math.max(state.minHeight, origH - dy); newY = origY + origH - newH; }

        const next = wm.clampWindowRect(state, newX, newY, newW, newH, resizeArea);
        state.width  = next.w;  state.height = next.h;
        state.x      = next.x;  state.y      = next.y;
        state.element.style.width  = `${next.w}px`;
        state.element.style.height = `${next.h}px`;
        state.element.style.left   = `${next.x}px`;
        state.element.style.top    = `${next.y}px`;
      };

      const onPointerMove = throttleRAF(rawMove);

      const onPointerDown = (e) => {
        if (state.maximized) return;
        resizing = true;
        dir = '';
        for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
          if (e.target.classList.contains(d)) { dir = d; break; }
        }
        startX = e.clientX;    startY = e.clientY;
        origX  = state.x;      origY  = state.y;
        origW  = state.width;  origH  = state.height;
        resizeArea = wm.getWorkArea();
        state.element.style.transition           = 'none';
        state.element.style.backdropFilter       = 'none';
        state.element.style.webkitBackdropFilter = 'none';
        state.element.classList.add('is-resizing');
        e.preventDefault();
        e.stopPropagation();

        document.addEventListener('pointermove',   onPointerMove);
        document.addEventListener('pointerup',     onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
      };

      const onPointerUp = () => {
        if (!resizing) return;
        resizing   = false;
        resizeArea = null;

        document.removeEventListener('pointermove',   onPointerMove);
        document.removeEventListener('pointerup',     onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        state.element.classList.remove('is-resizing');
        state.element.style.transition           = '';
        state.element.style.backdropFilter       = '';
        state.element.style.webkitBackdropFilter = '';
      };

      for (const h of handles) h.addEventListener('pointerdown', onPointerDown);
      state.cleanups.push(
        () => { for (const h of handles) h.removeEventListener('pointerdown', onPointerDown); },
        // Safety net: removes dynamic listeners if the window is closed mid-resize
        () => {
          document.removeEventListener('pointermove',   onPointerMove);
          document.removeEventListener('pointerup',     onPointerUp);
          document.removeEventListener('pointercancel', onPointerUp);
        },
      );
    },

    // ── Returns the snap zone name for a pointer position, or null ──
    getSnapZone(x, y) {
      const W      = window.innerWidth;
      const H      = window.innerHeight;
      const CORNER = 80;
      const EDGE   = 40;
      if (x < CORNER && y < CORNER)         return 'top-left';
      if (x > W - CORNER && y < CORNER)     return 'top-right';
      if (x < CORNER && y > H - CORNER)     return 'bottom-left';
      if (x > W - CORNER && y > H - CORNER) return 'bottom-right';
      if (x < EDGE)         return 'left';
      if (x > W - EDGE)     return 'right';
      if (y < EDGE)         return 'top';
      if (y > H - EDGE)     return 'bottom';
      return null;
    },

    // ── Returns {x,y,w,h} for a zone relative to the work area ──
    getSnapRect(zone) {
      const a  = wm.getWorkArea();
      const hw = Math.floor(a.width  / 2);
      const hh = Math.floor(a.height / 2);
      const map = {
        'left':         { x: a.left,      y: a.top,      w: hw,           h: a.height      },
        'right':        { x: a.left + hw,  y: a.top,      w: a.width - hw, h: a.height      },
        'top':          { x: a.left,      y: a.top,      w: a.width,      h: a.height      },
        'bottom':       { x: a.left,      y: a.top + hh, w: a.width,      h: a.height - hh },
        'top-left':     { x: a.left,      y: a.top,      w: hw,           h: hh            },
        'top-right':    { x: a.left + hw,  y: a.top,      w: a.width - hw, h: hh            },
        'bottom-left':  { x: a.left,      y: a.top + hh, w: hw,           h: a.height - hh },
        'bottom-right': { x: a.left + hw,  y: a.top + hh, w: a.width - hw, h: a.height - hh },
      };
      return map[zone] ?? null;
    },

    snapWindow(state, zone) {
      const r = wm.getSnapRect(zone);
      if (!r) return;
      if (!state.snapSide) {
        state.preSnapState = { x: state.x, y: state.y, w: state.width, h: state.height };
      }
      state.snapSide    = zone;
      state.preMaxState = state.preSnapState;
      const next = wm.clampWindowRect(state, r.x, r.y, r.w, r.h);
      state.x = next.x;  state.y = next.y;  state.width = next.w;  state.height = next.h;
      state.element.style.left   = `${state.x}px`;
      state.element.style.top    = `${state.y}px`;
      state.element.style.width  = `${state.width}px`;
      state.element.style.height = `${state.height}px`;
    },

    showSnapPreview(zone) {
      const r  = wm.getSnapRect(zone);
      if (!r) return;
      const el = wm.snapPreview;
      if (!el.classList.contains('visible')) {
        // First appearance: position instantly then fade in (no visible teleport)
        el.style.transition = 'none';
        el.style.left   = `${r.x}px`;
        el.style.top    = `${r.y}px`;
        el.style.width  = `${r.w}px`;
        el.style.height = `${r.h}px`;
        el.offsetHeight; // force reflow so the transition fires on the next frame
        el.style.transition = '';
        el.classList.add('visible');
      } else {
        el.style.left   = `${r.x}px`;
        el.style.top    = `${r.y}px`;
        el.style.width  = `${r.w}px`;
        el.style.height = `${r.h}px`;
      }
    },

    hideSnapPreview() {
      wm.snapPreview.classList.remove('visible');
    },

    showSnapCompass(activeZone) {
      const compass = wm.snapCompass;
      if (!compass) return;
      compass.classList.add('visible');
      for (const el of compass.querySelectorAll('.sc-zone')) {
        el.classList.toggle('active', el.dataset.zone === activeZone);
      }
    },

    hideSnapCompass() {
      wm.snapCompass?.classList.remove('visible');
    },

    updateTaskbar() { return window.updateTaskbar?.(); },

    minimizeAll() {
      for (const [id] of OS.windows) wm.minimizeWindow(id);
    },

    getWorkspaceWindows(workspaceId) {
      const ws = OS.workspaces.find(w => w.id === workspaceId);
      return ws ? ws.windows.map(id => OS.windows.get(id)).filter(Boolean) : [];
    },
  };

  return wm;
})();
