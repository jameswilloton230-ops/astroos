// Music app for NovaByte OS.
//
// Scans the virtual file system for audio files, exposes a library list,
// and plays the selected track through a hidden <audio> element. Playback
// state is mirrored in a now-playing bar with seek, volume, shuffle and
// repeat controls. Preferences (shuffle, repeat, volume) persist across
// sessions via localStorage.
//
// Host runtime is expected to provide these globals:
//   registerApp, createEl, svgIcon, lsSave, Notify, FS, AppDirs.

(() => {
  'use strict';

  // ---- Module-level constants ----

  const PREFS_KEY = 'nova_music_prefs';

  // Extensions we treat as audio when the stored MIME is missing or
  // generic. Kept in sync with EXT_TO_MIME below.
  const AUDIO_EXTENSIONS = new Set([
    'mp3', 'mp4', 'm4a', 'ogg', 'wav', 'flac', 'aac', 'opus', 'weba', 'webm',
  ]);

  const EXT_TO_MIME = Object.freeze({
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    opus: 'audio/ogg; codecs=opus',
    weba: 'audio/webm',
    webm: 'audio/webm',
  });

  const DEFAULT_VOLUME = 1;

  // Volume changes can fire dozens of input events per second while the
  // user drags the slider; debounce disk writes so we don't thrash
  // localStorage or block the main thread on JSON.stringify.
  const VOLUME_AUTOSAVE_DELAY_MS = 400;

  // ---- Pure helpers (no closure state) ----

  // Lowercased extension without the dot. Empty string for files with
  // no extension or names that end in a dot.
  function extOf(name) {
    const idx = (name || '').lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
  }

  // Maps an audio filename to a MIME type the browser will accept.
  // Returns '' for unknown extensions so the browser sniffs from bytes.
  function mimeFromName(name) {
    return EXT_TO_MIME[extOf(name)] || '';
  }

  // Cheap pre-check before attempting Uint8Array.fromBase64. Avoids
  // throwing inside fromBase64 for plain-text content.
  function isLikelyBase64(str) {
    return (
      str.length > 0 &&
      str.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(str)
    );
  }

  // Coerces whatever shape track.content happens to be into a typed
  // array we can wrap in a Blob. Returns null for unsupported shapes
  // or empty payloads.
  function normalizeBuffer(raw) {
    if (!raw) return null;
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw;

    if (typeof raw === 'string') {
      // Prefer native base64 decoding when the string looks like base64;
      // otherwise treat it as UTF-8 text. Native decoding is constant-
      // time and avoids the per-byte charCodeAt loop the original used.
      if (isLikelyBase64(raw)) {
        try {
          return Uint8Array.fromBase64(raw);
        } catch {
          // fall through and treat as UTF-8 text
        }
      }
      return new TextEncoder().encode(raw);
    }

    if (typeof raw === 'object') {
      // Legacy shape: array-like object with numeric keys.
      const keys = Object.keys(raw);
      const out = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) out[i] = raw[i] ?? 0;
      return out;
    }

    return null;
  }

  function loadPrefs(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      // Corrupt JSON in storage is recoverable — start fresh.
      console.warn('[Music] Discarding unreadable prefs:', err);
      return {};
    }
  }

  function savePrefs(key, prefs) {
    try {
      lsSave(key, prefs);
    } catch (err) {
      // Quota / privacy mode / disabled storage — non-fatal, but log
      // so the user has a clue why their prefs "forgot" themselves.
      console.warn('[Music] Could not persist prefs:', err);
    }
  }

  // Formats seconds as m:ss or h:mm:ss. Falls back to 0:00 for NaN /
  // Infinity (which <audio> emits before metadata has loaded).
  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function clampVolume(v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return DEFAULT_VOLUME;
    return Math.min(1, Math.max(0, v));
  }

  function stripExtension(name) {
    return (name || '').replace(/\.[^.]+$/, '');
  }

  // ---- App registration ----

  registerApp({
    id: 'nbosp-music',
    name: 'Music',
    icon: 'music',
    description: 'Music Player',
    defaultSize: [520, 520],
    minSize: [360, 380],

    init(content, state) {
      // The OS grants each app a private data directory. If it is
      // missing we cannot do anything useful, so fail loudly instead of
      // rendering a half-broken UI.
      if (!window.AppDirs?.getVFSDir('com.nbosp.music', 'files')) {
        renderAppDirMissing(content);
        return;
      }

      const prefs = loadPrefs(PREFS_KEY);

      const root = createEl('div', {
        style:
          'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-base);',
      });
      content.appendChild(root);

      // Hidden <audio> drives all playback. We never expose it directly.
      const audio = document.createElement('audio');
      audio.style.display = 'none';
      audio.preload = 'metadata';
      root.appendChild(audio);

      // ---- Mutable playback state ----
      const tracks = [];
      let queue = [];
      let queueIdx = -1;
      let shuffle = Boolean(prefs.shuffle);
      let repeat = Boolean(prefs.repeat);
      let volumeSaveTimer = null;

      // Object URLs we hand to <audio>. Cached per track id so flipping
      // back to a track is instant and free.
      const blobCache = new Map();

      // One AbortController for every listener we attach. Aborting it on
      // teardown drops every closure and lets the GC collect the DOM.
      const events = new AbortController();
      const on = (target, type, handler, opts) =>
        target.addEventListener(type, handler, { signal: events.signal, ...opts });

      // ---- Library header ----
      const libHeader = createEl('div', {
        style:
          'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);',
      });
      const libTitle = createEl('span', {
        textContent: 'Library',
        style: 'font-size:13px;font-weight:600;flex:1;',
      });
      const libCount = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
      const refreshBtn = createEl('button', {
        className: 'browser-nav-btn',
        title: 'Rescan library',
      });
      refreshBtn.setAttribute('aria-label', 'Rescan library');
      refreshBtn.innerHTML = svgIcon('refresh', 15);
      libHeader.append(libTitle, libCount, refreshBtn);
      root.appendChild(libHeader);

      // ---- Track list ----
      const trackList = createEl('div', {
        style: 'flex:1;overflow-y:auto;min-height:0;',
      });
      trackList.setAttribute('role', 'list');
      trackList.setAttribute('aria-label', 'Music library');
      root.appendChild(trackList);

      // ---- Now-playing bar ----
      const player = createEl('div', {
        style:
          'border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);padding:12px 14px;display:flex;flex-direction:column;gap:8px;',
      });

      // Track info row: album art + title/subtitle.
      const trackInfoRow = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });
      const albumArt = createEl('div', {
        style:
          'width:40px;height:40px;border-radius:6px;background:var(--bg-sunken);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-muted);',
      });
      albumArt.setAttribute('aria-hidden', 'true');
      albumArt.innerHTML = svgIcon('music', 18);
      const trackNameEl = createEl('div', { style: 'flex:1;min-width:0;' });
      const trackTitle = createEl('div', {
        textContent: 'No track selected',
        style:
          'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      });
      const trackSub = createEl('div', {
        textContent: '',
        style: 'font-size:11px;color:var(--text-muted);',
      });
      trackNameEl.append(trackTitle, trackSub);
      trackInfoRow.append(albumArt, trackNameEl);

      // Progress row: current time / seek bar / total time.
      const progressRow = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
      const timeCur = createEl('span', {
        textContent: '0:00',
        style:
          'font-size:10px;color:var(--text-muted);width:30px;text-align:right;font-variant-numeric:tabular-nums;',
      });
      const scrubWrap = createEl('div', {
        title: 'Seek',
        style:
          'flex:1;height:4px;background:var(--border-subtle);border-radius:2px;cursor:pointer;position:relative;',
      });
      scrubWrap.setAttribute('role', 'slider');
      scrubWrap.tabIndex = 0;
      scrubWrap.setAttribute('aria-label', 'Seek');
      scrubWrap.setAttribute('aria-valuemin', '0');
      scrubWrap.setAttribute('aria-valuemax', '0');
      scrubWrap.setAttribute('aria-valuenow', '0');
      scrubWrap.setAttribute('aria-valuetext', '0:00 of 0:00');
      const scrubFill = createEl('div', {
        style:
          'height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.25s linear;pointer-events:none;',
      });
      scrubWrap.appendChild(scrubFill);
      const timeTotal = createEl('span', {
        textContent: '0:00',
        style: 'font-size:10px;color:var(--text-muted);width:30px;font-variant-numeric:tabular-nums;',
      });
      progressRow.append(timeCur, scrubWrap, timeTotal);

      // Controls row: shuffle / prev / play-pause / next / repeat / volume.
      const controlsRow = createEl('div', {
        style: 'display:flex;align-items:center;justify-content:center;gap:6px;',
      });

      function ctrlBtn(icon, size, label) {
        const b = createEl('button', {
          className: 'browser-nav-btn',
          title: label,
          style:
            'width:32px;height:32px;display:flex;align-items:center;justify-content:center;',
        });
        b.setAttribute('aria-label', label);
        b.innerHTML = svgIcon(icon, size);
        return b;
      }

      const shuffleBtn = ctrlBtn('shuffle', 14, 'Shuffle');
      const prevBtn = ctrlBtn('arrow-left', 16, 'Previous track');
      const playPauseBtn = createEl('button', {
        style:
          'width:38px;height:38px;border-radius:50%;background:var(--accent);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,background 0.1s;',
        title: 'Play/Pause',
      });
      playPauseBtn.setAttribute('aria-label', 'Play');
      playPauseBtn.innerHTML = svgIcon('play', 18);
      const nextBtn = ctrlBtn('arrow-right', 16, 'Next track');
      const repeatBtn = ctrlBtn('repeat', 14, 'Repeat');

      // Volume row.
      const volRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
      const volIco = createEl('span', { style: 'color:var(--text-muted);' });
      volIco.setAttribute('aria-hidden', 'true');
      volIco.innerHTML = svgIcon('sound', 14);
      const volSlider = createEl('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.02',
        value: String(clampVolume(prefs.volume)),
        style: 'flex:1;accent-color:var(--accent);height:4px;cursor:pointer;',
      });
      volSlider.setAttribute('aria-label', 'Volume');
      volRow.append(volIco, volSlider);

      controlsRow.append(
        shuffleBtn,
        prevBtn,
        playPauseBtn,
        nextBtn,
        repeatBtn,
        createEl('span', { style: 'flex:1;' }),
        volRow,
      );
      player.append(trackInfoRow, progressRow, controlsRow);
      root.appendChild(player);

      // ---- Audio wiring ----

      audio.volume = clampVolume(parseFloat(volSlider.value));

      // Reflect playback state in the play/pause button label and ARIA.
      function syncPlayPauseLabel() {
        const playing = !audio.paused;
        playPauseBtn.innerHTML = svgIcon(playing ? 'pause' : 'play', 18);
        playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      }

      function syncShuffleBtn() {
        shuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
        shuffleBtn.setAttribute('aria-pressed', String(shuffle));
      }

      function syncRepeatBtn() {
        repeatBtn.style.color = repeat ? 'var(--accent)' : '';
        repeatBtn.setAttribute('aria-pressed', String(repeat));
      }

      function syncScrubAria() {
        const cur = audio.currentTime || 0;
        const dur = audio.duration || 0;
        scrubWrap.setAttribute('aria-valuenow', String(Math.floor(cur)));
        scrubWrap.setAttribute('aria-valuemax', String(Math.floor(dur) || 0));
        scrubWrap.setAttribute('aria-valuetext', `${fmtTime(cur)} of ${fmtTime(dur)}`);
      }

      on(audio, 'timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        scrubFill.style.width = pct + '%';
        timeCur.textContent = fmtTime(audio.currentTime);
        syncScrubAria();
      });
      on(audio, 'loadedmetadata', () => {
        timeTotal.textContent = fmtTime(audio.duration);
        syncScrubAria();
      });
      on(audio, 'play', syncPlayPauseLabel);
      on(audio, 'pause', syncPlayPauseLabel);
      on(audio, 'ended', () => {
        // repeat = loop the current track; otherwise advance, wrapping
        // around the queue (preserves the original "loop-all" semantics).
        if (repeat) {
          audio.currentTime = 0;
          playAudio();
        } else {
          playIdx(queueIdx + 1);
        }
      });
      on(audio, 'error', () => {
        const err = audio.error;
        console.warn('[Music] <audio> error:', err?.code, err?.message);
        Notify.show({
          title: 'Music',
          body: 'Could not play ' + (queue[queueIdx]?.name ?? 'track'),
          type: 'error',
          appName: 'Music',
        });
      });

      // ---- Seek bar: click + keyboard ----

      function seekToClientX(clientX) {
        if (!audio.duration) return;
        const r = scrubWrap.getBoundingClientRect();
        if (r.width <= 0) return;
        const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        audio.currentTime = ratio * audio.duration;
      }

      on(scrubWrap, 'click', (e) => seekToClientX(e.clientX));
      on(scrubWrap, 'keydown', (e) => {
        if (!audio.duration) return;
        const step = e.shiftKey ? 30 : 5;
        switch (e.key) {
          case 'ArrowLeft':
            audio.currentTime = Math.max(0, audio.currentTime - step);
            e.preventDefault();
            break;
          case 'ArrowRight':
            audio.currentTime = Math.min(audio.duration, audio.currentTime + step);
            e.preventDefault();
            break;
          case 'Home':
            audio.currentTime = 0;
            e.preventDefault();
            break;
          case 'End':
            audio.currentTime = audio.duration;
            e.preventDefault();
            break;
        }
      });

      // ---- Volume slider ----
      // Update audio.volume on every input for live feedback, but only
      // persist on `change` (fires when the user releases the slider).
      // Even then we debounce the disk write so a fast drag doesn't
      // queue a dozen JSON.stringify calls.
      on(volSlider, 'input', () => {
        audio.volume = clampVolume(parseFloat(volSlider.value));
      });
      on(volSlider, 'change', () => {
        prefs.volume = audio.volume;
        if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
        volumeSaveTimer = setTimeout(
          () => savePrefs(PREFS_KEY, prefs),
          VOLUME_AUTOSAVE_DELAY_MS,
        );
      });

      // ---- Play/pause button ----
      on(playPauseBtn, 'mouseenter', () => {
        playPauseBtn.style.transform = 'scale(1.08)';
      });
      on(playPauseBtn, 'mouseleave', () => {
        playPauseBtn.style.transform = '';
      });
      on(playPauseBtn, 'click', () => {
        if (audio.paused) {
          // If nothing is loaded yet, start the queue from the top so
          // the play button isn't a no-op on first interaction.
          if (!audio.src && queue.length) {
            playIdx(0);
          } else {
            playAudio();
          }
        } else {
          audio.pause();
        }
      });

      on(prevBtn, 'click', () => playIdx(queueIdx - 1));
      on(nextBtn, 'click', () => playIdx(queueIdx + 1));

      on(shuffleBtn, 'click', () => {
        shuffle = !shuffle;
        prefs.shuffle = shuffle;
        savePrefs(PREFS_KEY, prefs);
        syncShuffleBtn();
        // Rebuild the queue keeping the currently targeted track first
        // so the user doesn't lose their place.
        buildQueue(queue[queueIdx]?.id);
      });
      on(repeatBtn, 'click', () => {
        repeat = !repeat;
        prefs.repeat = repeat;
        savePrefs(PREFS_KEY, prefs);
        syncRepeatBtn();
      });

      on(refreshBtn, 'click', () => scanLibrary());

      // Initial toggle visuals.
      syncShuffleBtn();
      syncRepeatBtn();

      // ---- Playback helpers ----

      // Wrap audio.play() so rejections are reported consistently.
      // AbortError is normal — it fires when play() is interrupted by
      // pause() or by setting a new src mid-load.
      function playAudio() {
        return audio.play().catch((err) => {
          if (err?.name === 'AbortError') return;
          console.warn('[Music] Playback failed:', err);
          Notify.show({
            title: 'Music',
            body: 'Could not play ' + (queue[queueIdx]?.name ?? 'track'),
            type: 'error',
            appName: 'Music',
          });
        });
      }

      function getUrl(track) {
        if (!track) return null;
        const cached = blobCache.get(track.id);
        if (cached) return cached;
        if (!track.content) return null;

        let data;
        try {
          data = normalizeBuffer(track.content);
        } catch (err) {
          console.warn('[Music] Could not normalise track content:', err);
          return null;
        }
        if (!data || data.byteLength === 0) return null;

        // Prefer a stored audio/* MIME; otherwise fall back to the
        // extension-derived one. A wrong MIME on the blob causes
        // NS_ERROR_DOM_MEDIA_METADATA_ERR in Firefox even when the
        // bytes themselves are valid.
        const storedMime = track.mimeType || '';
        const mime = storedMime.startsWith('audio/') ? storedMime : mimeFromName(track.name);

        try {
          const blob = new Blob([data], mime ? { type: mime } : undefined);
          const url = URL.createObjectURL(blob);
          blobCache.set(track.id, url);
          return url;
        } catch (err) {
          console.warn('[Music] Could not create object URL:', err);
          return null;
        }
      }

      function buildQueue(startId) {
        queue = [...tracks];
        if (shuffle) {
          // Fisher–Yates — unbiased shuffle.
          for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
          }
        }
        if (startId != null) {
          const si = queue.findIndex((t) => t.id === startId);
          if (si > -1) queueIdx = si;
        }
      }

      function playIdx(i) {
        if (!queue.length) return;
        queueIdx = ((i % queue.length) + queue.length) % queue.length;
        playTrack(queue[queueIdx]);
      }

      function playTrack(track) {
        const url = getUrl(track);
        if (!url) {
          Notify.show({
            title: 'Music',
            body: 'Cannot load ' + track.name,
            type: 'error',
            appName: 'Music',
          });
          return;
        }
        audio.src = url;
        playAudio();
        trackTitle.textContent = stripExtension(track.name);
        trackSub.textContent = fmtTime(0);
        // Reset total until the new metadata event fires — otherwise
        // the previous track's duration is shown briefly while loading.
        timeTotal.textContent = '0:00';
        renderList();
      }

      // ---- Library scan & render ----

      function scanLibrary() {
        const files = FS?.files;
        if (!files) {
          tracks.length = 0;
        } else {
          // Filter in a single pass and sort once, rather than building
          // an intermediate array with Array.from + filter.
          const next = [];
          for (const f of files.values()) {
            if (f.type !== 'file') continue;
            const isAudio =
              (f.mimeType && f.mimeType.startsWith('audio/')) ||
              AUDIO_EXTENSIONS.has(extOf(f.name));
            if (isAudio) next.push(f);
          }
          next.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

          // Mutate tracks in place so external references (if any)
          // stay valid.
          tracks.length = 0;
          for (const t of next) tracks.push(t);
        }

        // Revoke object URLs for tracks that have disappeared — without
        // this the blobCache leaks one object URL per ever-loaded track.
        const validIds = new Set(tracks.map((t) => t.id));
        for (const [id, url] of blobCache) {
          if (!validIds.has(id)) {
            URL.revokeObjectURL(url);
            blobCache.delete(id);
          }
        }

        const n = tracks.length;
        libCount.textContent = n ? `${n} track${n > 1 ? 's' : ''}` : '';
        // Keep the cursor on the current track if it is still in the
        // library; otherwise queueIdx is left as-is and playIdx wraps
        // to a valid index on the next interaction.
        buildQueue(queue[queueIdx]?.id);
        renderList();
      }

      // ---- List rendering (with event delegation) ----
      //
      // We attach a fixed set of listeners to trackList and use data
      // attributes on each row to identify the track. This is O(1)
      // listeners regardless of library size and survives re-renders
      // without churning the AbortController.

      const ROW_SELECTOR = '[data-track-id]';

      on(trackList, 'click', (e) => {
        const row = e.target.closest(ROW_SELECTOR);
        if (!row) return;
        const track = tracks.find((t) => t.id === row.dataset.trackId);
        if (!track) return;
        if (row.dataset.current === 'true') {
          if (audio.paused) playAudio();
          else audio.pause();
        } else {
          buildQueue(track.id);
          playTrack(track);
        }
      });

      on(trackList, 'dblclick', (e) => {
        const row = e.target.closest(ROW_SELECTOR);
        if (!row) return;
        const track = tracks.find((t) => t.id === row.dataset.trackId);
        if (!track) return;
        buildQueue(track.id);
        playTrack(track);
      });

      on(trackList, 'keydown', (e) => {
        const row = e.target.closest(ROW_SELECTOR);
        if (!row) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });

      // mouseover/mouseout bubble; mouseenter/mouseleave don't. We use
      // the bubbling pair and check relatedTarget so the hover effect
      // only flips when the pointer actually leaves the row.
      on(trackList, 'mouseover', (e) => {
        const row = e.target.closest(ROW_SELECTOR);
        if (!row || row.dataset.current === 'true') return;
        row.style.background = 'var(--bg-hover)';
      });
      on(trackList, 'mouseout', (e) => {
        const row = e.target.closest(ROW_SELECTOR);
        if (!row || row.dataset.current === 'true') return;
        const next = e.relatedTarget;
        if (next && row.contains(next)) return;
        row.style.background = '';
      });

      function renderList() {
        // replaceChildren is the modern, single-call way to clear and
        // optionally repopulate a container.
        trackList.replaceChildren();

        if (!tracks.length) {
          const empty = createEl('div', {
            style:
              'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;text-align:center;padding:24px;',
          });
          const iconSpan = createEl('span', { innerHTML: svgIcon('music', 36) });
          const msg = createEl('div', {
            textContent: 'No audio files found',
            style: 'font-size:13px;margin-top:10px;color:var(--text-secondary);',
          });
          const hint = createEl('div', {
            textContent: 'Save audio files via Files to play them here',
            style: 'font-size:11px;margin-top:4px;',
          });
          empty.append(iconSpan, msg, hint);
          trackList.appendChild(empty);
          return;
        }

        const currentId = queue[queueIdx]?.id;
        const fragment = document.createDocumentFragment();

        tracks.forEach((track, idx) => {
          const isCurrent = track.id === currentId;
          const isActuallyPlaying = isCurrent && !audio.paused;

          const row = createEl('div', {
            title: track.name,
            style:
              'display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.1s;background:' +
              (isCurrent ? 'var(--accent-muted)' : 'transparent') +
              ';',
          });
          row.setAttribute('role', 'listitem');
          row.tabIndex = 0;
          row.dataset.trackId = track.id;
          row.dataset.current = String(isCurrent);
          row.setAttribute(
            'aria-label',
            stripExtension(track.name) + (isCurrent ? (isActuallyPlaying ? ', playing' : ', paused') : ''),
          );

          const numEl = createEl('div', {
            textContent: String(idx + 1).padStart(2, '0'),
            style:
              'font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:20px;text-align:right;',
          });

          const ico = createEl('span', {
            style:
              'color:' + (isCurrent ? 'var(--accent)' : 'var(--text-muted)') + ';flex-shrink:0;',
            innerHTML: svgIcon(isActuallyPlaying ? 'pause' : 'music', 15),
          });
          ico.setAttribute('aria-hidden', 'true');

          const nameEl = createEl('div', {
            textContent: stripExtension(track.name),
            style:
              'flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' +
              (isCurrent ? 'var(--accent)' : 'var(--text-primary)') +
              ';',
          });

          row.append(numEl, ico, nameEl);
          fragment.appendChild(row);
        });

        trackList.appendChild(fragment);
      }

      // ---- Teardown ----
      // Everything we registered — listeners, object URLs, the audio
      // element itself — is owned by this init() invocation and must be
      // released when the OS closes the app.
      state.cleanups = state.cleanups ?? [];
      state.cleanups.push(() => {
        // Drop every listener we attached in one call. Closures over
        // audio, scrubFill, etc. become collectable.
        events.abort();

        // Stop playback and release the current media resource.
        audio.pause();
        try {
          audio.src = '';
          audio.load();
        } catch {
          // Some engines throw when you set src to '' on a detached
          // element — non-fatal.
        }
        audio.remove();

        // Revoke every object URL we created.
        for (const url of blobCache.values()) URL.revokeObjectURL(url);
        blobCache.clear();

        // Cancel any pending volume autosave.
        if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
      });

      // ---- Initial render ----
      scanLibrary();
    },
  });

  // ---- App data directory missing — friendly fallback UI ----
  //
  // Kept structurally identical to the original (icon + two-line
  // message) but built from createEl + textContent so there is no
  // innerHTML with mixed trusted markup. The warning glyph is a
  // literal Unicode character; no SVG dependency at this stage.
  function renderAppDirMissing(content) {
    content.style.cssText =
      'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
    const icon = createEl('div', { textContent: '⚠️', style: 'font-size:32px' });
    const msg = createEl('div', { style: 'font-size:14px;text-align:center' });
    const appName = createEl('b', { textContent: 'com.nbosp.music' });
    msg.append(
      appName,
      document.createElement('br'),
      document.createTextNode('App data directory missing.'),
      document.createElement('br'),
      document.createTextNode('This app requires NovaByte OS.'),
    );
    content.replaceChildren(icon, msg);
  }
})();
