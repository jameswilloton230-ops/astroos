/* Astro System Webview host */
(() => {
  'use strict';

  const sandboxStates = new Map();
  const CAPTURE_TIMEOUT_MS = 1500;
  const MAX_ANNOTATION_EXPORT_LENGTH = 2_000_000;
  const WEBVIEW_EVENTS = [
    'loadstart', 'loadredirect', 'loadcommit', 'loadstop', 'contentload',
    'loadabort', 'loaderror', 'close', 'crashed', 'exit', 'did-fail-load',
    'enter-html-full-screen', 'leave-html-full-screen', 'unresponsive',
    'responsive', 'permissionrequest', 'consolemessage',
  ];

  function getSandboxState(sandbox, appId) {
    let state = sandboxStates.get(sandbox);
    if (!state) {
      state = {
        appId,
        views: new Map(),
        pendingPopups: new Map(),
        guests: new Map(),
        freezeSeq: 0,
      };
      sandboxStates.set(sandbox, state);
    }
    return state;
  }

  function reportFailure(callbacks, webview, requestId, error) {
    console.error('[SystemWebview] Webview operation failed:', error);
    return callbacks.respondError(
      webview,
      'nova:nested-webview',
      requestId,
      'INTERNAL_ERROR',
      error?.message || 'Webview operation failed'
    );
  }

  /*
   * <webview> guests are composited by NW.js as separate out-of-process
   * surfaces that render above ordinary same-window DOM content regardless
   * of z-index or stacking context (the same fact showFileDialog in
   * app-sandbox.js works around). The only thing that reliably wins against
   * a guest is toggling its own visibility. These helpers hide a guest while
   * host pixels (overlays, context menus, dialogs) must appear above it,
   * optionally leaving a captured still of the guest so the page does not
   * blank out behind the overlay.
   */

  function captureGuest(child) {
    return new Promise(resolve => {
      if (!child || typeof child.capturePage !== 'function') return resolve(null);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
      try {
        const maybe = child.capturePage(result => {
          let dataUrl = result;
          if (dataUrl && typeof dataUrl === 'object' && typeof dataUrl.toDataURL === 'function') {
            try { dataUrl = dataUrl.toDataURL(); } catch (_) { dataUrl = null; }
          }
          finish(typeof dataUrl === 'string' && dataUrl.startsWith('data:image') ? dataUrl : null);
        });
        if (maybe && typeof maybe.then === 'function') maybe.then(finish, () => finish(null));
      } catch (_) {
        finish(null);
      }
    });
  }

  async function freezeGuest(state, guest, { capture = true } = {}) {
    if (!guest || !guest.isConnected) return { captured: false };
    let record = state.guests.get(guest);
    if (!record) {
      record = { img: null, baseVisibility: guest.style.visibility || 'visible', refs: 0 };
      state.guests.set(guest, record);
    }
    record.refs += 1;
    if (record.img) return { captured: true };
    if (record.pending) {
      await record.pending;
      return { captured: Boolean(record.img) };
    }
    record.pending = (async () => {
      const dataUrl = capture ? await captureGuest(guest) : null;
      /* The guest may have been restored or destroyed while the capture was
         in flight — in that case drop our ref instead of hiding it. */
      if (state.guests.get(guest) !== record || !guest.isConnected) return;
      if (dataUrl) {
        const img = guest.ownerDocument.createElement('img');
        img.src = dataUrl;
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.style.cssText = 'position:absolute;border:0;margin:0;padding:0;pointer-events:none;object-fit:fill;'
          + `left:${guest.style.left || '0px'};top:${guest.style.top || '0px'};`
          + `width:${guest.style.width || '100%'};height:${guest.style.height || '100%'};`;
        if (guest.style.zIndex) img.style.zIndex = guest.style.zIndex;
        guest.parentNode?.insertBefore(img, guest.nextSibling);
        record.img = img;
      }
      guest.style.visibility = 'hidden';
    })();
    try { await record.pending; } finally { record.pending = null; }
    return { captured: Boolean(record.img) };
  }

  function unfreezeGuest(state, guest) {
    const record = guest && state.guests.get(guest);
    if (!record) return;
    record.refs -= 1;
    if (record.refs > 0) return;
    if (record.img) {
      record.img.remove();
      record.img = null;
    }
    if (guest.isConnected) guest.style.visibility = record.baseVisibility;
    state.guests.delete(guest);
  }

  function syncGuestTwin(state, guest) {
    const record = guest && state.guests.get(guest);
    if (!record?.img) return;
    const img = record.img;
    img.style.left = guest.style.left;
    img.style.top = guest.style.top;
    img.style.width = guest.style.width;
    img.style.height = guest.style.height;
    img.style.display = guest.style.display === 'none' ? 'none' : 'block';
  }

  async function freezeSandbox(sandbox, { capture = true } = {}) {
    const state = sandboxStates.get(sandbox);
    if (!state) return { captured: false };
    /* Generation guard: restoreSandbox (or a newer freeze) while captures
       are in flight must not leave half-frozen guests behind. */
    const generation = ++state.freezeSeq;
    const guests = [];
    if (sandbox?.webview?.isConnected) guests.push(sandbox.webview);
    for (const entry of state.views.values()) {
      if (entry.view?.isConnected && !guests.includes(entry.view)) guests.push(entry.view);
    }
    let captured = false;
    for (const guest of guests) {
      if (generation !== state.freezeSeq) break;
      const result = await freezeGuest(state, guest, { capture });
      captured = captured || result.captured;
    }
    if (generation !== state.freezeSeq) {
      for (const guest of guests) unfreezeGuest(state, guest);
      return { captured: false, superseded: true };
    }
    return { captured };
  }

  function restoreSandbox(sandbox) {
    const state = sandboxStates.get(sandbox);
    if (!state) return;
    state.freezeSeq += 1;
    if (sandbox?.webview) unfreezeGuest(state, sandbox.webview);
    for (const entry of state.views.values()) unfreezeGuest(state, entry.view);
  }

  function dropGuestRecord(state, guest) {
    const record = guest && state.guests.get(guest);
    if (!record) return;
    if (record.img) record.img.remove();
    state.guests.delete(guest);
  }

  const runGuestScript = (child, code) => new Promise(resolve => {
    try { child.executeScript({ code }, () => resolve(true)); } catch (_) { resolve(false); }
  });

  async function handleAnnotation(state, child, entry, payload) {
    const command = payload?.command;
    if (command === 'enable') {
      entry.annotationEnabled = true;
      entry.annotationOptions = payload.options && typeof payload.options === 'object' ? payload.options : {};
      const installed = await runGuestScript(child, annotationLayerScript(entry.annotationMarker));
      if (installed) await applyAnnotationOptions(child, entry.annotationOptions);
      return { success: installed, installed };
    }
    if (command === 'disable') {
      entry.annotationEnabled = false;
      await runGuestScript(child,
        'try { window.__novaAnnotationLayer && window.__novaAnnotationLayer.setActive(false); '
        + 'document.querySelector("[data-nova-annotation-layer]")?.remove(); '
        + 'delete window.__novaAnnotationLayer; } catch (_) {} true;');
      return { success: true };
    }
    if (!entry.annotationEnabled) {
      return { success: false, reason: 'Annotation layer is not enabled' };
    }
    if (command === 'style' || command === 'active') {
      const options = command === 'style' ? payload.options : { active: payload.active };
      entry.annotationOptions = { ...entry.annotationOptions, ...options };
      await applyAnnotationOptions(child, options);
      return { success: true };
    }
    if (command === 'clear' || command === 'undo') {
      await runGuestScript(child,
        `window.__novaAnnotationLayer && window.__novaAnnotationLayer.${command === 'clear' ? 'clear' : 'undo'}()`);
      return { success: true };
    }
    if (command === 'export') {
      const sent = await runGuestScript(child,
        'window.__novaAnnotationLayer && window.__novaAnnotationLayer.export()');
      return { success: sent };
    }
    return { success: false, reason: 'Unsupported annotation command' };
  }

  async function applyAnnotationOptions(child, options = {}) {
    const style = {};
    if (typeof options.color === 'string') style.color = options.color.slice(0, 64);
    if (Number.isFinite(Number(options.lineWidth))) style.lineWidth = Math.max(1, Math.min(64, Number(options.lineWidth)));
    const active = typeof options.active === 'boolean' ? options.active : undefined;
    await runGuestScript(child,
      `window.__novaAnnotationLayer && window.__novaAnnotationLayer.configure(${JSON.stringify({ ...style, active })})`);
  }

  /* The annotation layer lives INSIDE the guest: host-side DOM can never
     composite above a webview guest, so interactive pixels that must appear
     over the page have to be part of the guest's own document. The layer is
     a fixed-position canvas that captures pointer input while active and
     exports its content through the console bridge (captured in the
     consolemessage listener below). */
  function annotationLayerScript(marker) {
    return '(() => {'
      + 'if (window.__novaAnnotationLayer) return true;'
      + 'const state = { active: false, color: "#ff4d6d", lineWidth: 3, strokes: [], redo: [], drawing: false, points: null };'
      + 'const canvas = document.createElement("canvas");'
      + 'canvas.setAttribute("data-nova-annotation-layer", "");'
      + 'canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;display:none;touch-action:none;cursor:crosshair;";'
      + '(document.body || document.documentElement).appendChild(canvas);'
      + 'const ctx = canvas.getContext("2d");'
      + 'const ratio = () => window.devicePixelRatio || 1;'
      + 'function drawStroke(s) {'
      + '  if (!s || s.points.length === 0) return;'
      + '  ctx.strokeStyle = s.color; ctx.lineWidth = s.lineWidth; ctx.lineCap = "round"; ctx.lineJoin = "round";'
      + '  ctx.beginPath();'
      + '  if (s.points.length === 1) { ctx.arc(s.points[0].x, s.points[0].y, s.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill(); return; }'
      + '  ctx.moveTo(s.points[0].x, s.points[0].y);'
      + '  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);'
      + '  ctx.stroke();'
      + '}'
      + 'function redraw() {'
      + '  const r = ratio(); ctx.setTransform(r, 0, 0, r, 0, 0);'
      + '  ctx.clearRect(0, 0, canvas.width / r, canvas.height / r);'
      + '  for (const s of state.strokes) drawStroke(s);'
      + '  if (state.drawing && state.points) drawStroke({ color: state.color, lineWidth: state.lineWidth, points: state.points });'
      + '}'
      + 'function resize() {'
      + '  const r = ratio();'
      + '  canvas.width = Math.max(1, Math.round(window.innerWidth * r));'
      + '  canvas.height = Math.max(1, Math.round(window.innerHeight * r));'
      + '  redraw();'
      + '}'
      + 'function pointOf(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }'
      + 'canvas.addEventListener("pointerdown", e => {'
      + '  if (!state.active) return;'
      + '  e.preventDefault(); canvas.setPointerCapture(e.pointerId);'
      + '  state.drawing = true; state.points = [pointOf(e)]; redraw();'
      + '});'
      + 'canvas.addEventListener("pointermove", e => {'
      + '  if (!state.active || !state.drawing) return;'
      + '  e.preventDefault(); state.points.push(pointOf(e)); redraw();'
      + '});'
      + 'const finishStroke = e => {'
      + '  if (!state.drawing) return;'
      + '  state.drawing = false; state.strokes.push({ color: state.color, lineWidth: state.lineWidth, points: state.points });'
      + '  state.points = null; redraw();'
      + '};'
      + 'canvas.addEventListener("pointerup", finishStroke);'
      + 'canvas.addEventListener("pointercancel", finishStroke);'
      + 'window.addEventListener("resize", resize);'
      + 'window.__novaAnnotationLayer = {'
      + '  configure(o) { if (!o) return; if (typeof o.color === "string") state.color = o.color; if (Number.isFinite(+o.lineWidth)) state.lineWidth = Math.max(1, Math.min(64, +o.lineWidth)); if (typeof o.active === "boolean") state.active = o.active; canvas.style.display = state.active ? "block" : "none"; if (state.active) resize(); redraw(); },'
      + '  setActive(v) { state.active = !!v; canvas.style.display = state.active ? "block" : "none"; if (state.active) resize(); },'
      + '  clear() { state.strokes = []; state.redo = []; state.points = null; redraw(); },'
      + '  undo() { state.redo.push(state.strokes.pop()); redraw(); },'
      + '  export() { try { console.log(\'' + marker + '\' + canvas.toDataURL("image/png")); } catch (_) {} },'
      + '};'
      + 'resize();'
      + 'return true;'
      + '})()';
  }

  async function handleRequest(context) {
    const {
      payload, requestId, app, webview, sandbox,
      callbacks,
    } = context;
    const { respond, respondError, generateRequestId, log, canNavigate, setupPermissionRequestGate } = callbacks;
    if (!sandbox || typeof sandbox !== 'object') {
      return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'App window is unavailable');
    }
    const id = payload?.id;
    if (typeof id !== 'string' || !/^nvw_[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview id');
    }

    const state = getSandboxState(sandbox, app.id);
    const action = payload?.action;
    let entry = state.views.get(id);

    if (action === 'discard-popup') {
      const pending = state.pendingPopups.get(payload.popupId);
      if (!pending) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request has expired');
      state.pendingPopups.delete(payload.popupId);
      pending.discard();
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }
    if (action === 'attach-popup') {
      const pending = state.pendingPopups.get(payload.popupId);
      if (!pending || !entry) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request or nested webview does not exist');
      state.pendingPopups.delete(payload.popupId);
      pending.attach(entry.view);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'create') {
      if (entry) return respond(webview, 'nova:nested-webview', requestId, { success: true });
      const parent = sandbox.state?.content;
      if (!parent?.isConnected) {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'App window is unavailable');
      }

      const attrs = payload.attributes && typeof payload.attributes === 'object' ? payload.attributes : {};
      if (typeof attrs.src === 'string' && attrs.src && !canNavigate(attrs.src)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      const child = document.createElement('webview');
      child.setAttribute('nodeintegration', 'false');
      child.setAttribute('nodeintegrationsubframes', 'false');
      child.setAttribute('enableremotemodule', 'false');
      child.setAttribute('partition', `persist:app_${app.id}_webcontent`);
      child.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;border:0;display:none;z-index:1;';
      const contextMenuMarker = app.id === 'com.astroos.browser'
        ? `__NOVA_BROWSER_CONTEXT_MENU__:${generateRequestId()}:`
        : null;
      const contextMenuScript = `(() => {
        if (window.__novaContextMenuBridgeInstalled) return;
        window.__novaContextMenuBridgeInstalled = true;
        const marker = ${JSON.stringify(contextMenuMarker)};
        document.addEventListener('contextmenu', event => {
          event.preventDefault();
          const element = event.target;
          const link = element?.closest?.('a');
          const image = element?.tagName === 'IMG' ? element : element?.closest?.('img');
          const selection = window.getSelection?.().toString().trim() || '';
          const payload = {
            clientX: event.clientX,
            clientY: event.clientY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            linkUrl: link?.href || '',
            linkText: (link?.textContent || '').trim().slice(0, 120),
            imageUrl: image?.src || '',
            imageAlt: image?.alt || '',
            selectedText: selection.slice(0, 500),
            pageUrl: location.href,
            pageTitle: document.title,
          };
          try { console.log(marker + JSON.stringify(payload)); } catch (_) {}
        }, true);
      })();`;
      const annotationMarker = `__NOVA_ANNOTATION_EXPORT__:${id}:`;

      if (app.id === 'com.astroos.browser' && typeof child.addContentScripts === 'function') {
        try {
          child.addContentScripts([{
            name: `nova-browser-scrollbar-guard-${id}`,
            matches: ['<all_urls>'],
            js: { code: `(() => {
              const css = 'html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
                '*::-webkit-scrollbar,*::-webkit-scrollbar-thumb,*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{' +
                'display:none!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important}';
              const install = () => {
                const root = document.documentElement;
                if (!root) return false;
                let style = root.querySelector('style[data-astroos-scrollbar-guard]');
                if (!style) {
                  style = document.createElement('style');
                  style.setAttribute('data-astroos-scrollbar-guard', '');
                  style.textContent = css;
                  (root.head || root).appendChild(style);
                }
                return true;
              };
              if (!install()) {
                const observer = new MutationObserver(() => {
                  if (install()) observer.disconnect();
                });
                observer.observe(document, { childList: true, subtree: true });
              }
            })();` },
            run_at: 'document_start',
            all_frames: false,
          }]);
        } catch (error) {
          log('warn', 'Browser early scrollbar guard registration failed:', error);
        }
      }

      const cleanups = [];
      const sendEvent = (name, event) => {
        const result = { proxyId: id, eventName: name };
        for (const key of ['url', 'isTopLevel', 'reason', 'errorCode', 'errorDescription', 'validatedURL', 'targetUrl', 'disposition', 'windowOpenDisposition', 'initialWidth', 'initialHeight', 'message', 'permission']) {
          if (event?.[key] !== undefined) result[key] = event[key];
        }
        if (event?.request?.url) result.request = { url: event.request.url };
        if (event?.__novaPopupId) result.popupId = event.__novaPopupId;
        respond(webview, 'nova:nested-webview:event', id, result);
      };
      for (const name of WEBVIEW_EVENTS) {
        const listener = event => {
          if (name === 'loadstop' && state.views.get(id)?.annotationEnabled) {
            runGuestScript(child, annotationLayerScript(annotationMarker)).then(installed => {
              if (installed) applyAnnotationOptions(child, state.views.get(id)?.annotationOptions || {});
            });
          }
          if (name === 'loadstop' && contextMenuMarker) {
            try {
              child.executeScript({ code: contextMenuScript }, results => {
                if (Array.isArray(results) && results[0] === false) {
                  log('warn', `Could not install nested browser context menu bridge for ${app?.id || 'app'}`);
                }
              });
            } catch (error) {
              log('warn', 'Could not install nested browser context menu bridge', error);
            }
          }
          if (name === 'consolemessage' && typeof event?.message === 'string' && event.message.startsWith(annotationMarker)) {
            const dataUrl = event.message.slice(annotationMarker.length);
            if (dataUrl.startsWith('data:image/') && dataUrl.length <= MAX_ANNOTATION_EXPORT_LENGTH) {
              respond(webview, 'nova:nested-webview:event', id, { proxyId: id, eventName: 'annotation-export', dataUrl });
            }
            return;
          }
          if (name === 'consolemessage' && typeof event?.message === 'string' && event.message.startsWith(contextMenuMarker)) {
            let contextData;
            try { contextData = JSON.parse(event.message.slice(contextMenuMarker.length)); }
            catch (error) {
              log('warn', 'Ignored malformed nested browser context menu event', error);
              return;
            }
            if (!Number.isFinite(contextData?.clientX) || !Number.isFinite(contextData?.clientY)
              || !Number.isFinite(contextData?.viewportWidth) || !Number.isFinite(contextData?.viewportHeight)) return;
            const bounded = value => typeof value === 'string' ? value.slice(0, 2000) : '';
            sendEvent('contextmenu', {
              clientX: contextData.clientX,
              clientY: contextData.clientY,
              viewportWidth: contextData.viewportWidth,
              viewportHeight: contextData.viewportHeight,
              linkUrl: bounded(contextData.linkUrl),
              linkText: bounded(contextData.linkText),
              imageUrl: bounded(contextData.imageUrl),
              imageAlt: bounded(contextData.imageAlt),
              selectedText: bounded(contextData.selectedText),
              pageUrl: bounded(contextData.pageUrl),
              pageTitle: bounded(contextData.pageTitle),
            });
            return;
          }
          sendEvent(name, event);
        };
        child.addEventListener(name, listener);
        cleanups.push(() => child.removeEventListener(name, listener));
      }
      const newWindowListener = event => {
        event.preventDefault();
        const popupId = generateRequestId();
        state.pendingPopups.set(popupId, event.window);
        event.__novaPopupId = popupId;
        setTimeout(() => {
          const pending = state.pendingPopups.get(popupId);
          if (!pending) return;
          state.pendingPopups.delete(popupId);
          try { pending.discard(); } catch (error) { log('warn', 'Pending popup cleanup failed', error); }
        }, 30000);
        sendEvent('newwindow', event);
      };
      child.addEventListener('newwindow', newWindowListener);
      cleanups.push(() => child.removeEventListener('newwindow', newWindowListener));
      const navigationListener = event => {
        if (event?.isTopLevel === false) return;
        const destination = event?.url || event?.targetUrl || event?.validatedURL;
        if (typeof destination === 'string' && !canNavigate(destination)) {
          event.preventDefault?.();
          sendEvent('navigation-blocked', { url: destination, reason: 'Network permission required' });
        }
      };
      child.addEventListener('will-navigate', navigationListener);
      cleanups.push(() => child.removeEventListener('will-navigate', navigationListener));
      cleanups.push(setupPermissionRequestGate(child));
      parent.style.position ||= 'relative';
      entry = { view: child, cleanups, annotationEnabled: false, annotationOptions: {}, annotationMarker };
      state.views.set(id, entry);
      parent.appendChild(child);

      for (const name of ['allowfullscreen', 'allowpopups']) {
        if (typeof attrs[name] === 'string') child.setAttribute(name, attrs[name]);
      }
      if (typeof attrs.src === 'string' && attrs.src) child.src = attrs.src;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (!entry) {
      return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Nested webview does not exist');
    }
    const child = entry.view;

    if (action === 'destroy') {
      destroyView(state, id, entry, log);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'freeze') {
      const result = await freezeGuest(state, child, { capture: payload.capture !== false });
      return respond(webview, 'nova:nested-webview', requestId, { success: true, ...result });
    }

    if (action === 'unfreeze') {
      unfreezeGuest(state, child);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'annotation') {
      return respond(webview, 'nova:nested-webview', requestId, await handleAnnotation(state, child, entry, payload));
    }

    if (action === 'bounds') {
      const bounds = payload.bounds || {};
      const requested = [bounds.left, bounds.top, bounds.width, bounds.height].map(Number);
      if (!requested.every(Number.isFinite) || requested[2] < 0 || requested[3] < 0) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview bounds');
      }
      const [requestedLeft, requestedTop, requestedWidth, requestedHeight] = requested;
      const parent = sandbox.state?.content;
      const maxWidth = Math.max(0, parent?.clientWidth || 0);
      const maxHeight = Math.max(0, parent?.clientHeight || 0);
      const left = Math.max(0, Math.min(maxWidth, requestedLeft));
      const top = Math.max(0, Math.min(maxHeight, requestedTop));
      const width = Math.min(requestedWidth, maxWidth - left);
      const height = Math.min(requestedHeight, maxHeight - top);
      const visible = bounds.visible === true && width > 0 && height > 0;
      child.style.left = `${left}px`;
      child.style.top = `${top}px`;
      child.style.width = `${width}px`;
      child.style.height = `${height}px`;
      child.style.display = visible ? 'flex' : 'none';
      /* While the guest is frozen (hidden behind a captured still), the
         bounds sync must not unhide it — the facade reports the proxy's
         visibility, which says nothing about the freeze. */
      const frozen = state.guests.has(child);
      child.style.visibility = bounds.visibility === 'hidden' || frozen ? 'hidden' : 'visible';
      child.style.pointerEvents = bounds.pointerEvents === 'none' ? 'none' : 'auto';
      child.style.zIndex = String(Math.max(0, Math.min(100, Number(bounds.zIndex) || 1)));
      syncGuestTwin(state, child);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'attribute') {
      const name = payload.name;
      if (!['allowfullscreen', 'allowpopups', 'src'].includes(name)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'Attribute is not available on nested webviews');
      }
      if (name === 'src' && payload.remove !== true
        && (typeof payload.value !== 'string' || !canNavigate(payload.value))) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      if (payload.remove === true) child.removeAttribute(name);
      else if (typeof payload.value === 'string') child.setAttribute(name, payload.value);
      if (name === 'src' && payload.remove !== true && typeof payload.value === 'string') child.src = payload.value;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action !== 'command') {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    const command = payload.command;
    if (command === 'reload') child.reload();
    else if (command === 'back') child.back();
    else if (command === 'forward') child.forward();
    else if (command === 'stop') child.stop();
    else if (command === 'canGoBack' || command === 'canGoForward') {
      const method = child[command];
      if (typeof method !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', `${command} is not supported by this webview`);
      }
      return respond(webview, 'nova:nested-webview', requestId, { value: Boolean(method.call(child)) });
    } else if (command === 'find') {
      const query = payload.query;
      const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
      if (typeof query !== 'string' || !query.trim() || query.length > 1000
        || Object.keys(options).some(key => !['backward', 'matchCase', 'wordStart', 'medialCapitalAsWordStart'].includes(key))
        || Object.values(options).some(value => typeof value !== 'boolean')) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid page-find query or options');
      }
      if (typeof child.find !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      const result = await new Promise((resolve, reject) => {
        try { child.find(query, options, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    } else if (command === 'stopFinding') {
      const value = payload.value || 'clear';
      if (!['clear', 'keep', 'activate'].includes(value)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid stop-finding action');
      }
      if (typeof child.stopFinding !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      child.stopFinding(value);
    } else if (command === 'setUserAgentOverride') {
      const userAgent = payload.value;
      if (typeof userAgent !== 'string' || userAgent.length > 512) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid user-agent string');
      }
      if (typeof child.setUserAgentOverride !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'User-agent overrides are not supported by this webview');
      }
      child.setUserAgentOverride(userAgent);
    } else if (command === 'setZoom') {
      const zoom = Number(payload.value);
      if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom factor');
      }
      child.setZoom(zoom);
    } else if (command === 'setZoomMode') {
      if (!['per-view', 'per-origin', 'automatic'].includes(payload.value)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom mode');
      }
      child.setZoomMode(payload.value);
    } else if (command === 'clearData') {
      const types = Array.isArray(payload.types) ? payload.types.filter(type => typeof type === 'string') : [];
      await new Promise((resolve, reject) => {
        try { child.clearData({}, types, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    } else if (command === 'executeScript' || command === 'insertCSS') {
      const code = payload.details?.code;
      if (typeof code !== 'string' || code.length > 1_000_000) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid webview script');
      }
      const method = command === 'executeScript' ? child.executeScript : child.insertCSS;
      const result = await new Promise((resolve, reject) => {
        try {
          method.call(child, { code }, results => resolve(results));
        } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    } else {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    return respond(webview, 'nova:nested-webview', requestId, { success: true });
  }

  function destroyView(state, id, entry, log = (...args) => console.warn(...args.slice(1))) {
    state.views.delete(id);
    for (const cleanup of entry.cleanups) {
      try { cleanup(); } catch (error) { log('warn', 'Nested webview cleanup failed', error); }
    }
    dropGuestRecord(state, entry.view);
    try { entry.view.remove(); }
    catch (error) { log('warn', 'Nested webview removal failed', error); }
  }

  function disposeState(state, log = (...args) => console.warn(...args.slice(1))) {
    for (const [id, entry] of state.views) destroyView(state, id, entry, log);
    for (const pending of state.pendingPopups.values()) {
      try { pending.discard(); } catch (error) { log('warn', 'Pending popup cleanup failed', error); }
    }
    state.pendingPopups.clear();
    for (const record of state.guests.values()) {
      if (record.img) record.img.remove();
    }
    state.guests.clear();
  }

  function destroySandbox(sandbox) {
    const state = sandboxStates.get(sandbox);
    if (!state) return false;
    disposeState(state);
    sandboxStates.delete(sandbox);
    return true;
  }

  function revokeApp(appId) {
    let removed = destroyTrustedGuests(appId);
    for (const [sandbox, state] of sandboxStates) {
      if (state.appId !== appId) continue;
      disposeState(state);
      sandboxStates.delete(sandbox);
      removed = true;
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Trusted (first-party) guests
  //
  // The IPC route above is for sandboxed third-party apps and always forces an
  // app-scoped partition and a permission-gated navigation. The Browser and web
  // apps run in the trusted host runtime and need full control of the guest
  // (per-tab or incognito partitions, executeScript, zoom, UA, content scripts,
  // their own event handling). This path gives them that, but only to system
  // callers; third-party apps never get a handle.
  // ---------------------------------------------------------------------------
  const trustedGuests = new Map(); // appId -> Set<handle>
  const TRUSTED_ID_PATTERN = /^com\.astroos\.[a-z0-9._-]+$/;
  const BLOCKED_NAV_SCHEMES = /^\s*(javascript|vbscript):/i;

  function isFirstParty(app) {
    if (!app || typeof app.id !== 'string') return false;
    const system = app.system === true || app.manifest?.system === true;
    return system && TRUSTED_ID_PATTERN.test(app.id);
  }

  function resolveTrustedPartition(app, options) {
    const key = String(options.guestId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    // No "persist:" prefix means in-memory, which is what incognito needs.
    if (options.incognito) return `incognito_${app.id}_${key || Date.now()}`;
    if (options.partition !== undefined && options.partition !== null) {
      if (typeof options.partition !== 'string' || !/^(persist:)?[a-zA-Z0-9_.-]{1,160}$/.test(options.partition)) {
        throw Object.assign(new Error('Invalid partition name'), { code: 'INVALID_ARGS' });
      }
      return options.partition;
    }
    return `persist:app_${app.id}_trusted`;
  }

  function createTrustedGuest(app, options = {}) {
    if (!isFirstParty(app)) {
      throw Object.assign(new Error('Trusted webviews are limited to system apps'), { code: 'PERMISSION_DENIED' });
    }
    const parent = options.parent;
    if (!parent || typeof parent.appendChild !== 'function') {
      throw Object.assign(new Error('A parent element is required'), { code: 'INVALID_ARGS' });
    }

    const view = document.createElement('webview');
    // Partition has to be on the element before src or NW.js won't honour it.
    view.setAttribute('partition', resolveTrustedPartition(app, options));
    view.setAttribute('nodeintegration', 'false');
    view.setAttribute('nodeintegrationsubframes', 'false');
    view.setAttribute('enableremotemodule', 'false');
    if (options.allowFullscreen !== false) view.setAttribute('allowfullscreen', 'true');
    // sandbox: null leaves the attribute off entirely (web apps rely on that).
    if (options.sandbox !== null) {
      view.setAttribute('sandbox', options.sandbox || 'allow-scripts allow-same-origin allow-forms allow-popups');
    }
    if (typeof options.style === 'string') view.style.cssText = options.style;

    const listeners = [];
    let destroyed = false;
    const guard = () => { if (destroyed) throw new Error('Webview guest was destroyed'); };

    const handle = {
      element: view,
      on(type, fn) {
        guard();
        view.addEventListener(type, fn);
        listeners.push([type, fn]);
        return () => view.removeEventListener(type, fn);
      },
      navigate(url) {
        guard();
        if (typeof url !== 'string' || !url || BLOCKED_NAV_SCHEMES.test(url)) {
          throw Object.assign(new Error('Blocked navigation target'), { code: 'INVALID_ARGS' });
        }
        view.src = url;
      },
      executeScript(code) {
        guard();
        return new Promise(resolve => {
          try {
            view.executeScript({ code }, result => {
              if (globalThis.chrome?.runtime?.lastError) return resolve(null);
              resolve(Array.isArray(result) ? result[0] : null);
            });
          } catch (_) { resolve(null); }
        });
      },
      getUrl: () => handle.executeScript('location.href'),
      setZoom(factor) { guard(); try { view.setZoom(factor); } catch (_) { /* not ready yet */ } },
      setUserAgent(ua) { guard(); try { view.setUserAgentOverride(ua); } catch (_) { /* not ready yet */ } },
      addContentScripts(scripts) {
        guard();
        if (typeof view.addContentScripts !== 'function') return false;
        view.addContentScripts(scripts);
        return true;
      },
      capture: () => captureGuest(view),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const [type, fn] of listeners) view.removeEventListener(type, fn);
        listeners.length = 0;
        try { view.remove(); } catch (_) { /* already detached */ }
        trustedGuests.get(app.id)?.delete(handle);
      },
    };

    parent.appendChild(view);
    if (!trustedGuests.has(app.id)) trustedGuests.set(app.id, new Set());
    trustedGuests.get(app.id).add(handle);
    if (typeof options.src === 'string' && options.src) handle.navigate(options.src);
    return handle;
  }

  function destroyTrustedGuests(appId) {
    const set = trustedGuests.get(appId);
    if (!set) return false;
    for (const handle of [...set]) handle.destroy();
    trustedGuests.delete(appId);
    return true;
  }

  window.NovaSystemWebview = Object.freeze({
    handleRequest(context) {
      return handleRequest(context).catch(error => reportFailure(
        context.callbacks,
        context.webview,
        context.requestId,
        error
      ));
    },
    destroySandbox,
    revokeApp,
    freezeSandbox,
    restoreSandbox,
    createTrustedGuest,
    destroyTrustedGuests,
  });
})();
