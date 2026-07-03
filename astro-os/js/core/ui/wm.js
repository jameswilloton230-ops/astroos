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

    createWindow(appId, options) {
      if (appId === 'launchpad') { toggleLaunchpad(); return null; }

      const disabled = (() => {
        try { return JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]'); }
        catch { return []; }
      })();
      if (disabled.some(x => (typeof x === 'string' ? x : x?.id) === appId)) {
        return null;
      }

      const id  = generateId();
      const app = OS.apps[appId];
      if (!app) return null;

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
      closeBtn.innerHTML = '<span class="material-symbols-rounded wctrl-icon">close</span>';
      const minBtn    = createEl('button', { className: 'window-control-btn minimize', 'aria-label': 'Minimize window' });
      minBtn.innerHTML   = '<span class="material-symbols-rounded wctrl-icon">remove</span>';
      const maxBtn    = createEl('button', { className: 'window-control-btn maximize', 'aria-label': 'Maximize window' });
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
          if (app.onDrop) {
            try {
              await app.onDrop(file, state);
            } catch (err) {
              console.warn(`[WM] ${appId}.onDrop error:`, err);
            }
          } else {
            const ext       = file.name.split('.').pop().toLowerCase();
            const targetApp = ['txt', 'md', 'js', 'html', 'css', 'json'].includes(ext)
              ? 'quill'
              : 'vault';

            const fileId   = generateId();
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
            const dropNode = {
              id: fileId,  name: file.name,  type: 'file',
              size: file.size,  content: new Uint8Array(fileData),
              mimeType: mime,
              parentId: FS.specialFolders.desktop ?? FS.rootId,
              modified: Date.now(),
            };
            FS.files.set(fileId, dropNode);
            await OS.workers.fs.call('putFiles', [dropNode]);
            wm.createWindow(targetApp, { fileId });
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

      try {
        if (app.init) app.init(content, state, options);
      } catch (err) {
        console.warn(`[WM] ${appId}.init error:`, err);
      }

      OS.events.emit('app:opened', { id, appId });
      return state;
    },

    closeWindow(id) {
      const state = OS.windows.get(id);
      if (!state) return;

      state.element.classList.add('closing');

      // Use animationend for accurate timing; fall back after 250 ms in case
      // no animation fires (reduced-motion, missing keyframe, etc.).
      let closed = false;
      const finishClose = () => {
        if (closed) return;
        closed = true;
        clearTimeout(fallback);

        for (const cleanup of state.cleanups) {
          try { cleanup(); } catch (err) { console.warn('[WM] cleanup error:', err); }
        }
        state.element.remove();
        OS.windows.delete(id);

        const app = OS.apps[state.appId];
        if (app?.onClose) {
          try { app.onClose(state); } catch (err) { console.warn(`[WM] ${state.appId}.onClose error:`, err); }
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
      };

      const fallback = setTimeout(finishClose, 250);
      state.element.addEventListener('animationend', finishClose, { once: true });
    },

    minimizeWindow(id) {
      const state = OS.windows.get(id);
      if (!state) return;
      state.minimized = true;
      state.element.classList.add('minimizing');
      if (OS.focusedWindowId === id) OS.focusedWindowId = null;
      wm.updateTaskbar();
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
      state.element.classList.add('window-restoring');
      wm.focusWindow(id);
      state.element.addEventListener('animationend',
        () => state.element.classList.remove('window-restoring'), { once: true });
      wm.updateTaskbar();
    },

    getWorkArea() {
      if (_waCache) return _waCache;

      const vw   = Math.max(0, window.innerWidth  || document.documentElement.clientWidth  || 0);
      const vh   = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
      const tb   = document.getElementById('taskbar');
      const area = { left: 0, top: 0, right: vw, bottom: vh };

      if (!tb) {
        return (_waCache = { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' });
      }

      const isHidden = tb.classList.contains('taskbar-autohide') && !tb.classList.contains('taskbar-ah-shown');
      if (isHidden) {
        return (_waCache = { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' });
      }

      const rect   = tb.getBoundingClientRect();
      const style  = window.getComputedStyle(tb);
      let position = 'bottom';
      if      (tb.classList.contains('taskbar-left'))   position = 'left';
      else if (tb.classList.contains('taskbar-right'))  position = 'right';
      else if (tb.classList.contains('taskbar-top'))    position = 'top';

      const gap = 8;
      if      (position === 'bottom') area.bottom = Math.max(area.top    + 220, Math.floor(rect.top)   - gap);
      else if (position === 'top')    area.top    = Math.min(area.bottom - 220, Math.ceil(rect.bottom) + gap);
      else if (position === 'left')   area.left   = Math.min(area.right  - 320, Math.ceil(rect.right)  + gap);
      else if (position === 'right')  area.right  = Math.max(area.left   + 320, Math.floor(rect.left)  - gap);

      return (_waCache = {
        ...area,
        width:           Math.max(0, area.right  - area.left),
        height:          Math.max(0, area.bottom - area.top),
        taskbarHidden:   false,
        taskbarPosition: position,
      });
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
      if (app.alwaysOnTop) el.style.zIndex = String(9999 + (Number(el.style.zIndex) || 0));
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
        state.element.classList.add('window-restoring');
        if (state.preMaxState) {
          const { x, y, w, h } = state.preMaxState;
          state.element.style.left   = `${x}px`;
          state.element.style.top    = `${y}px`;
          state.element.style.width  = `${w}px`;
          state.element.style.height = `${h}px`;
          state.x = x;  state.y = y;  state.width = w;  state.height = h;
        }
        state.element.addEventListener('animationend',
          () => state.element.classList.remove('window-restoring'), { once: true });
      } else {
        state.preMaxState = { x: state.x, y: state.y, w: state.width, h: state.height };
        state.maximized = true;
        state.element.classList.add('maximized');
        const area = wm.getWorkArea();
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
      if (state.minimized) wm.restoreWindow(id);
      state.element.style.zIndex = ++OS.windowZCounter;
      OS.focusedWindowId = id;
      for (const [wid, w] of OS.windows) {
        w.element.classList.toggle('focused', wid === id);
      }
      wm.updateTaskbar();
      OS.events.emit('app:focused', { id, appId: state.appId });

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

    updateTaskbar() {
      const container = document.getElementById('taskbar-apps');
      if (!container) return;

      const pinnedApps    = OS.settings.get('pinnedApps') ?? [];
      const pinnedAppsSet = new Set(pinnedApps); // O(1) lookups vs O(n) includes()

      // Group open windows by appId
      const appWindows = new Map();
      for (const [id, state] of OS.windows) {
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
        const app     = OS.apps[appId];
        const windows = appWindows.get(appId) ?? [];
        const isPinned = pinnedAppsSet.has(appId);
        if (!app) continue;

        const hasWindows         = windows.length > 0;
        const hasMultipleWindows = windows.length > 1;
        const isAnyActive        = windows.some(w => OS.focusedWindowId === w.id && !w.state.minimized);

        const btn = createEl('button', {
          className:   `taskbar-app-btn${isAnyActive ? ' active' : ''}${isPinned ? ' pinned' : ''}`,
          'aria-label': app.name + (hasMultipleWindows ? ` (${windows.length} windows)` : ''),
        });

        btn.innerHTML = svgIcon(app.icon, 20);
        btn.appendChild(createEl('span', { className: 'indicator' }));
        if (hasMultipleWindows) {
          btn.appendChild(createEl('span', {
            className:   'taskbar-window-count',
            textContent: String(windows.length),
          }));
        }

        const clickHandler = () => {
          if (!hasWindows) {
            wm.createWindow(appId);
          } else if (hasMultipleWindows) {
            showWindowPreview(btn, appId, windows);
          } else {
            const { id, state } = windows[0];
            if (OS.focusedWindowId === id && !state.minimized) wm.minimizeWindow(id);
            else wm.focusWindow(id);
          }
        };

        const contextMenuHandler = (e) => {
          e.preventDefault();
          const menuItems = [];
          if (hasMultipleWindows) {
            for (const [index, w] of windows.entries()) {
              const winTitle = w.state.title ?? `Window ${index + 1}`;
              menuItems.push({
                label:  winTitle,
                icon:   OS.focusedWindowId === w.id ? 'check' : 'square',
                action: () => wm.focusWindow(w.id),
              });
            }
            menuItems.push({ separator: true });
          }
          if (hasWindows) {
            menuItems.push({
              label:  hasMultipleWindows ? 'Close All Windows' : 'Close Window',
              icon:   'x',
              danger: true,
              action: () => { for (const w of windows) wm.closeWindow(w.id); },
            });
            menuItems.push({ separator: true });
          } else {
            menuItems.push({ label: 'Open', icon: 'play', action: () => wm.createWindow(appId) });
            menuItems.push({ separator: true });
          }
          menuItems.push({
            label:  isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
            icon:   'pin',
            action: () => {
              const pins = OS.settings.get('pinnedApps') ?? [];
              const next = isPinned ? pins.filter(p => p !== appId) : [...pins, appId];
              OS.settings.set('pinnedApps', next);
              wm.updateTaskbar();
              Notify.show({
                title:   isPinned ? 'Unpinned' : 'Pinned',
                body:    `${app.name} ${isPinned ? 'removed from' : 'pinned to'} taskbar`,
                type:    'success',
                appName: 'Taskbar',
              });
            },
          });
          ContextMenu.show(e.clientX, e.clientY, menuItems);
        };

        btn.addEventListener('click',       clickHandler);
        btn.addEventListener('contextmenu', contextMenuHandler);
        frag.appendChild(btn);
      }

      container.replaceChildren(frag);
    },

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