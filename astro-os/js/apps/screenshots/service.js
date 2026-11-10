'use strict';

// Strips the `data:<mime>;base64,` wrapper so only the raw base64 payload is
// stored — matches the convention used for dropped/uploaded binary files
// (see extractBase64FromDataUrl in the desktop drop handler) and what apps
// like Gallery expect to decode.
function _dataUrlToBase64(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return '';
  const comma = dataUrl.indexOf(',');
  return comma > -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

// SCREENSHOT

// Lets the user drag out a rectangle over a still image of the captured
// frame. Resolves to {x, y, width, height} in the image's own pixel space,
// or null if the user cancels (Escape / right-click).
function _promptRegionSelect(frameCanvas) {
  return new Promise((resolve) => {
    const scale = Math.min(
      (window.innerWidth * 0.9) / frameCanvas.width,
      (window.innerHeight * 0.9) / frameCanvas.height,
      1
    );
    const dispW = frameCanvas.width * scale;
    const dispH = frameCanvas.height * scale;

    const overlay = createEl('div', {
      id: 'screenshot-region-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:99999;cursor:crosshair;user-select:none;'
    });

    const frame = createEl('div', {
      style: `position:relative;width:${dispW}px;height:${dispH}px;box-shadow:0 0 0 1px rgba(255,255,255,0.2);`
    });
    const img = createEl('img', { style: 'width:100%;height:100%;display:block;pointer-events:none;' });
    img.src = frameCanvas.toDataURL('image/png');

    const selectionBox = createEl('div', {
      style: 'position:absolute;border:2px solid var(--accent, #3b82f6);background:rgba(59,130,246,0.15);display:none;pointer-events:none;'
    });

    const hint = createEl('div', {
      textContent: 'Drag to select a region · Esc to cancel',
      style: 'position:absolute;top:-32px;left:0;color:#fff;font-size:12px;font-family:var(--font-ui, sans-serif);opacity:0.85;'
    });

    frame.append(img, selectionBox, hint);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    let startX = 0, startY = 0, dragging = false;
    let settled = false;

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const rect = frame.getBoundingClientRect();
      startX = clamp(e.clientX - rect.left, 0, dispW);
      startY = clamp(e.clientY - rect.top, 0, dispH);
      dragging = true;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${w}px`;
      selectionBox.style.height = `${h}px`;
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);

      // Too small to be intentional — treat as a click, keep waiting rather
      // than resolving with an empty region.
      if (w < 4 || h < 4) {
        selectionBox.style.display = 'none';
        return;
      }

      finish({
        x: Math.round(left / scale),
        y: Math.round(top / scale),
        width: Math.round(w / scale),
        height: Math.round(h / scale),
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    const onContextMenu = (e) => { e.preventDefault(); finish(null); };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
  });
}

// Finds the "Screenshots" subfolder inside Pictures, creating it once if it
// doesn't exist yet. Cached after the first successful lookup/creation so
// repeated screenshots don't re-scan Pictures' contents every time.
let _screenshotsFolderId = null;

async function _getOrCreateScreenshotsFolder() {
  if (_screenshotsFolderId && FS.files?.has(_screenshotsFolderId)) {
    return _screenshotsFolderId;
  }

  const picturesId = FS.specialFolders?.pictures;
  if (!picturesId) return null;

  const existing = FS.listDir(picturesId)
    .find(f => f.type === 'folder' && f.name === 'Screenshots');

  if (existing) {
    _screenshotsFolderId = existing.id;
    return existing.id;
  }

  const created = await FS.createFolder(picturesId, 'Screenshots');
  _screenshotsFolderId = created.id;
  return created.id;
}

async function captureScreenshot(mode) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: mode === 'window' ? 'window' : 'monitor' }
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext('2d').drawImage(video, 0, 0);

    // The stream is only needed to grab one frame — release it immediately
    // so the screen-capture indicator goes away while the user drags out a
    // region selection.
    stream.getTracks().forEach(t => t.stop());
    stream = null;

    let outputCanvas = fullCanvas;

    if (mode === 'region') {
      const region = await _promptRegionSelect(fullCanvas);
      if (!region) return; // user cancelled — not an error
      const cropped = document.createElement('canvas');
      cropped.width = region.width;
      cropped.height = region.height;
      cropped.getContext('2d').drawImage(
        fullCanvas,
        region.x, region.y, region.width, region.height,
        0, 0, region.width, region.height
      );
      outputCanvas = cropped;
    }

    const dataUrl = outputCanvas.toDataURL('image/png');
    const base64 = _dataUrlToBase64(dataUrl);

    const screenshotsId = await _getOrCreateScreenshotsFolder();
    if (!screenshotsId) throw new Error('Pictures folder not found');

    // Use FS.uniqueName so two screenshots taken in the same millisecond
    // don't collide and silently overwrite each other.
    const name = FS.uniqueName(screenshotsId, `screenshot-${Date.now()}.png`);
    await FS.createFile(screenshotsId, name, base64, 'image/png');

    Notify.show({ title: 'Screenshot Saved', body: `Saved to Pictures/Screenshots as ${name}`, type: 'success', appName: 'System' });
    EventLog?.log?.({ app: 'System', category: 'system', severity: 'info', message: `Screenshot captured (${mode})`, data: { mode, name } });
  } catch (err) {
    Notify.show({ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' });
    EventLog?.log?.({ app: 'System', category: 'system', severity: 'error', message: `Screenshot capture failed (${mode}): ${err?.message || err}`, data: { mode } });
  } finally {
    // Always stop tracks — never leave the screen-capture indicator dangling,
    // even if play() or drawImage() threw above.
    stream?.getTracks().forEach(t => t.stop());
  }
}

window.ScreenshotService = Object.freeze({ capture: captureScreenshot });
