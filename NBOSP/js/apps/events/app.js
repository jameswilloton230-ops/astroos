registerApp({
  id: 'com.nbosp.events',
  name: 'Events',
  version: '3.0.2',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZXZ0LWJvZHkiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzMzNDE1NSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImV2dC1iYXIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIwIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzQ3NTU2OSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMxZTI5M2IiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxlbGxpcHNlIGN4PSI0OCIgY3k9IjkwIiByeD0iMzAiIHJ5PSI2IiBmaWxsPSIjMDAwIiBvcGFjaXR5PSIwLjE4Ii8+CiAgPHJlY3QgeD0iMTQiIHk9IjIwIiB3aWR0aD0iNjgiIGhlaWdodD0iNTQiIHJ4PSI4IiBmaWxsPSJ1cmwoI2V2dC1ib2R5KSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0idXJsKCNldnQtYmFyKSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyNyIgd2lkdGg9IjY4IiBoZWlnaHQ9IjciIGZpbGw9InVybCgjZXZ0LWJhcikiLz4KICA8Y2lyY2xlIGN4PSIyMiIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmODcxNzEiLz4KICA8Y2lyY2xlIGN4PSIzMCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmYmJmMjQiLz4KICA8Y2lyY2xlIGN4PSIzOCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiM0YWRlODAiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI0NiIgeDI9Ijc0IiB5Mj0iNDYiIHN0cm9rZT0iIzRhZGU4MCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI1NiIgeDI9IjY0IiB5Mj0iNTYiIHN0cm9rZT0iI2ZiYmYyNCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI2NiIgeDI9IjcwIiB5Mj0iNjYiIHN0cm9rZT0iI2Y4NzE3MSIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8cmVjdCB4PSIxNCIgeT0iMjAiIHdpZHRoPSI2OCIgaGVpZ2h0PSIxNCIgcng9IjgiIGZpbGw9IiNmZmYiIG9wYWNpdHk9IjAuMDgiLz4KPC9zdmc+',
  description: 'Unified timeline of console output, permission events, and package events',
  category: 'developer',
  devOnly: true,
  defaultSize: [700, 520],
  minSize: [420, 320],
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Events.</div>';
      return;
    }

    if (typeof EventLog === 'undefined') {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center">EventLog service is not available in this context.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    // Dev-tool config lives in the dev hive (HKND/events/* — same home as
    // the debug overlay position); localStorage is the pre-registry seed
    // and the fail-soft fallback. Session history is bookkeeping, not bulk
    // data, so it rides the same hive path (HKND/events/sessions).
    const VIEWS_STORAGE_KEY = 'nova_events_views';
    const ALERTS_STORAGE_KEY = 'nova_events_alerts';
    const SESSION_STORAGE_KEY = 'nova_events_sessions';
    const VIEWS_REG_PATH = 'HKND/events/views';
    const ALERTS_REG_PATH = 'HKND/events/alerts';
    const SESSION_REG_PATH = 'HKND/events/sessions';

    let savedViews = [];
    let alertRules = [];

    function devReg() {
      return (typeof window !== 'undefined' && window.NovaRegistry && typeof window.NovaRegistry.get === 'function')
        ? window.NovaRegistry : null;
    }
    function readDevJson(path, legacyKey, fallback) {
      const r = devReg();
      if (r) {
        try {
          const value = r.get(path);
          if (value !== undefined) return value;
        } catch (_) { /* fall through to legacy */ }
      }
      try { return JSON.parse(localStorage.getItem(legacyKey) || JSON.stringify(fallback)); }
      catch { return fallback; }
    }
    function writeDevJson(path, legacyKey, value) {
      const r = devReg();
      if (r) {
        try { r.set(path, value, { type: 'REG_JSON', source: 'events-app' }); return; }
        catch (_) { /* fall through to legacy */ }
      }
      try { localStorage.setItem(legacyKey, JSON.stringify(value)); } catch {}
    }
    let currentSessionId = null;

    loadViews();
    loadAlerts();

    // ── Toolbar ────────────────────────────────────────────────────────
    const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:8px;flex-shrink:0;flex-wrap:wrap;' });

    const searchInput = createEl('input', {
      placeholder: 'Filter by message, app, or appId…',
      style: 'flex:1;min-width:140px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;'
    });

    const appSelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    appSelect.appendChild(createEl('option', { value: '', textContent: 'All apps' }));

    const categorySelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    categorySelect.appendChild(createEl('option', { value: '', textContent: 'All categories' }));
    const categoryList = (typeof EventLog.getCategories === 'function') ? EventLog.getCategories() : [];
    for (const c of categoryList) {
      categorySelect.appendChild(createEl('option', { value: c, textContent: c }));
    }

    const severitySelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    for (const [value, label] of [['', 'All severities'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']]) {
      severitySelect.appendChild(createEl('option', { value, textContent: label }));
    }

    const timeRangeSelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    for (const [value, label] of [
      ['all', 'All time'],
      ['5m', 'Last 5 min'],
      ['15m', 'Last 15 min'],
      ['1h', 'Last 1 hour'],
      ['session', 'This session'],
    ]) {
      timeRangeSelect.appendChild(createEl('option', { value, textContent: label }));
    }

    const sortSelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    for (const [value, label] of [
      ['newest', 'Newest first'],
      ['oldest', 'Oldest first'],
      ['severity', 'Severity'],
      ['app', 'A-Z'],
    ]) {
      sortSelect.appendChild(createEl('option', { value, textContent: label }));
    }

    const savedViewSelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    refreshViewOptions();

    const saveViewBtn = createEl('button', { textContent: '+ Save view', title: 'Save current filters as a named view', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const manageViewsBtn = createEl('button', { textContent: '⚙ Manage', title: 'Rename or delete saved views', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });

    const pauseBtn = createEl('button', { textContent: 'Pause', title: 'Pause live updates without losing scroll position', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const clearBtn = createEl('button', { textContent: 'Clear', title: 'Clear the event log', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const exportBtn = createEl('button', { textContent: 'Export', title: 'Download the filtered events as a .txt file', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });

    toolbar.appendChild(searchInput);
    toolbar.appendChild(appSelect);
    toolbar.appendChild(categorySelect);
    toolbar.appendChild(severitySelect);
    toolbar.appendChild(timeRangeSelect);
    toolbar.appendChild(sortSelect);
    toolbar.appendChild(savedViewSelect);
    toolbar.appendChild(saveViewBtn);
    toolbar.appendChild(manageViewsBtn);
    toolbar.appendChild(pauseBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(exportBtn);
    content.appendChild(toolbar);

    const countLine = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:6px;flex-shrink:0;display:flex;justify-content:space-between;gap:8px;' });
    const countText = createEl('span', {});
    const rateText = createEl('span', { style: 'color:var(--text-muted);' });
    countLine.appendChild(countText);
    countLine.appendChild(rateText);
    content.appendChild(countLine);

    const detailPanel = createEl('div', {
      style: 'display:none;flex-shrink:0;background:var(--bg-sunken,#0a0c10);border:1px solid var(--border-subtle);border-radius:6px;padding:10px 12px;margin-bottom:8px;max-height:180px;overflow:auto;font-family:monospace;font-size:11px;'
    });
    const detailHeader = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;' });
    const detailTitle = createEl('span', { style: 'color:var(--accent, #67e8f9);font-weight:600;font-size:12px;' });
    const detailClose = createEl('button', { textContent: '✕', title: 'Close detail panel', style: 'background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 2px;' });
    detailClose.addEventListener('click', () => { selectedEventId = null; detailPanel.style.display = 'none'; render(); });
    detailHeader.appendChild(detailTitle);
    detailHeader.appendChild(detailClose);
    detailPanel.appendChild(detailHeader);
    const detailBody = createEl('div', {});
    detailPanel.appendChild(detailBody);
    content.appendChild(detailPanel);

    const list = createEl('div', {
      style: 'flex:1;overflow:auto;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:6px;padding:4px;'
    });
    content.appendChild(list);

    // ── State ──────────────────────────────────────────────────────────
    const FILTER_STORAGE_KEY = 'nova_events_app_filters';

    let paused = false;
    let searchQuery = '';
    let appFilter = '';
    let categoryFilter = '';
    let severityFilter = '';
    let timeRange = 'all';
    let sortOrder = 'newest';
    let knownApps = new Set();
    let selectedEventId = null;
    let eventDetailEl = null;

    // Restore previously used filters so reopening the app doesn't reset them.
    try {
      const saved = readDevJson('HKND/events/filters', FILTER_STORAGE_KEY, {});
      searchQuery = saved.searchQuery || '';
      appFilter = saved.appFilter || '';
      categoryFilter = saved.categoryFilter || '';
      severityFilter = saved.severityFilter || '';
      timeRange = saved.timeRange || 'all';
      sortOrder = saved.sortOrder || 'newest';
      searchInput.value = searchQuery;
      appSelect.value = appFilter;
      categorySelect.value = categoryFilter;
      severitySelect.value = severityFilter;
      timeRangeSelect.value = timeRange;
      sortSelect.value = sortOrder;
    } catch { /* corrupt/missing — just start with defaults */ }

    function saveFilters() {
      writeDevJson('HKND/events/filters', FILTER_STORAGE_KEY, { searchQuery, appFilter, categoryFilter, severityFilter, timeRange, sortOrder });
    }

    function loadViews() {
      try {
        savedViews = readDevJson(VIEWS_REG_PATH, VIEWS_STORAGE_KEY, []);
        if (!Array.isArray(savedViews)) savedViews = [];
      } catch { savedViews = []; }
    }

    function saveViews() {
      writeDevJson(VIEWS_REG_PATH, VIEWS_STORAGE_KEY, savedViews);
    }

    function loadAlerts() {
      try {
        alertRules = readDevJson(ALERTS_REG_PATH, ALERTS_STORAGE_KEY, []);
        if (!Array.isArray(alertRules)) alertRules = [];
      } catch { alertRules = []; }
    }

    function saveAlerts() {
      writeDevJson(ALERTS_REG_PATH, ALERTS_STORAGE_KEY, alertRules);
    }

    function refreshViewOptions() {
      savedViewSelect.innerHTML = '';
      savedViewSelect.appendChild(createEl('option', { value: '', textContent: 'Saved views…' }));
      for (const v of savedViews) {
        savedViewSelect.appendChild(createEl('option', { value: v.id, textContent: v.name }));
      }
    }

    function getCurrentSessionId() {
      if (!currentSessionId) {
        const today = new Date();
        const key = `session_${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}_${String(today.getHours()).padStart(2,'0')}${String(today.getMinutes()).padStart(2,'0')}`;
        return key;
      }
      return currentSessionId;
    }

    // Rolling events/sec: timestamps of events seen in the last 5s window.
    const RATE_WINDOW_MS = 5000;
    let recentTimestamps = [];
    function recordRate(entries) {
      const now = Date.now();
      for (const e of entries) recentTimestamps.push(e.timestamp);
      recentTimestamps = recentTimestamps.filter(t => now - t <= RATE_WINDOW_MS);
      const perSec = recentTimestamps.length / (RATE_WINDOW_MS / 1000);
      rateText.textContent = perSec > 0 ? `${perSec.toFixed(1)}/s` : '';
    }
    let lastSeenCount = 0;

    const SEVERITY_COLOR = { info: 'var(--text-muted, #9ca3af)', warn: '#fbbf24', error: '#f87171' };
    const SEVERITY_LABEL = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

    function evaluateAlerts(entries) {
      for (const rule of alertRules) {
        if (!rule.enabled) continue;
        let matched = false;
        let matchedEntry = null;
        for (const e of entries) {
          let ok = true;
          if (rule.app && e.app !== rule.app) ok = false;
          if (rule.category && e.category !== rule.category) ok = false;
          if (rule.severity && e.severity !== rule.severity) ok = false;
          if (rule.contains && !e.message.toLowerCase().includes(rule.contains.toLowerCase())) ok = false;
          if (ok) { matched = true; matchedEntry = e; break; }
        }
        if (matched && rule.lastFiredAt && (Date.now() - rule.lastFiredAt < 60_000)) continue;
        if (matched) {
          rule.lastFiredAt = Date.now();
          saveAlerts();
          if (typeof Notify !== 'undefined') {
            Notify.show({
              title: `⚡ Alert: ${rule.name}`,
              body: matchedEntry ? matchedEntry.message.slice(0, 120) : 'Matching event detected',
              type: rule.severity === 'error' ? 'error' : 'warn',
              appName: 'Events',
              icon: 'alert',
            });
          }
        }
      }
    }

    function refreshAppOptions(entries) {
      let changed = false;
      for (const e of entries) {
        if (!knownApps.has(e.app)) { knownApps.add(e.app); changed = true; }
      }
      if (!changed) return;
      const current = appSelect.value;
      appSelect.innerHTML = '';
      appSelect.appendChild(createEl('option', { value: '', textContent: 'All apps' }));
      for (const app of [...knownApps].sort((a, b) => a.localeCompare(b))) {
        appSelect.appendChild(createEl('option', { value: app, textContent: app }));
      }
      appSelect.value = current;
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    function matches(e) {
      if (severityFilter && e.severity !== severityFilter) return false;
      if (appFilter && e.app !== appFilter) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (timeRange && timeRange !== 'all') {
        const now = Date.now();
        const ts = e.timestamp;
        let cutoff;
        if (timeRange === '5m') cutoff = now - 5 * 60 * 1000;
        else if (timeRange === '15m') cutoff = now - 15 * 60 * 1000;
        else if (timeRange === '1h') cutoff = now - 60 * 60 * 1000;
        else if (timeRange === 'session') {
          const sid = getCurrentSessionId();
          cutoff = new Date(sid.replace('session_', '').slice(0, 13)).getTime();
        }
        if (cutoff && ts < cutoff) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const messageMatch = e.message.toLowerCase().includes(q);
        const appMatch = e.app.toLowerCase().includes(q);
        const appIdMatch = e.data && e.data.appId && String(e.data.appId).toLowerCase().includes(q);
        if (!messageMatch && !appMatch && !appIdMatch) return false;
      }
      return true;
    }

    const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

    function sortEntries(entries) {
      const sorted = entries.slice();
      switch (sortOrder) {
        case 'oldest':
          sorted.sort((a, b) => a.timestamp - b.timestamp);
          break;
        case 'severity':
          sorted.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.timestamp - a.timestamp);
          break;
        case 'app':
          sorted.sort((a, b) => (a.app || '').localeCompare(b.app || '') || b.timestamp - a.timestamp);
          break;
        case 'newest':
        default:
          sorted.sort((a, b) => b.timestamp - a.timestamp);
          break;
      }
      return sorted;
    }

    // Two entries are considered "correlated" if they share the same
    // data.appId and land within this many ms of each other. This groups
    // e.g. a launch → permission-check → window-opened burst from one
    // action into a single collapsible cluster instead of separate rows.
    const CORRELATION_WINDOW_MS = 1500;

    function buildGroups(filtered) {
      // Walk filtered entries and cluster adjacent ones that share an appId
      // and are close in time. Sort order is preserved within each cluster.
      const groups = [];
      let current = null;
      for (const e of filtered) {
        const appId = e.data && e.data.appId;
        if (
          appId &&
          current &&
          current.appId === appId &&
          (current.entries[current.entries.length - 1].timestamp - e.timestamp) <= CORRELATION_WINDOW_MS
        ) {
          current.entries.push(e);
        } else {
          current = { appId: appId || null, entries: [e] };
          groups.push(current);
        }
      }
      return groups;
    }

    function renderRow(e) {
      const isSelected = selectedEventId === e.id;
      const row = createEl('div', {
        style: `display:flex;gap:8px;padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px;align-items:baseline;cursor:pointer;${isSelected ? 'background:var(--bg-sunken,#0a0c10);' : ''}`
      });
      row.appendChild(createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;white-space:nowrap;', textContent: formatTime(e.timestamp) }));
      row.appendChild(createEl('span', {
        style: `color:${SEVERITY_COLOR[e.severity] || SEVERITY_COLOR.info};flex-shrink:0;width:42px;font-weight:600;`,
        textContent: SEVERITY_LABEL[e.severity] || 'INFO'
      }));
      row.appendChild(createEl('span', { style: 'color:var(--accent, #67e8f9);flex-shrink:0;white-space:nowrap;', textContent: `[${e.app}]` }));
      if (e.category) {
        row.appendChild(createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;white-space:nowrap;font-size:10px;border:1px solid var(--border-subtle);border-radius:3px;padding:0 4px;', textContent: e.category }));
      }
      row.appendChild(createEl('span', { style: 'color:var(--text-primary);word-break:break-word;flex:1;', textContent: e.message }));
      if (e.data != null) {
        row.appendChild(createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;font-size:10px;', title: 'Has data payload — click for details', textContent: '●' }));
      }
      row.addEventListener('click', () => {
        selectedEventId = e.id;
        renderDetail(e);
        render();
      });
      return row;
    }

    function renderDetail(e) {
      if (!e) { detailPanel.style.display = 'none'; return; }
      detailPanel.style.display = 'block';
      detailTitle.textContent = `${new Date(e.timestamp).toLocaleTimeString()} — [${e.app}] ${e.message}`;
      detailBody.innerHTML = '';

      const meta = createEl('div', { style: 'color:var(--text-muted);margin-bottom:6px;font-size:10px;' });
      meta.textContent = `id: ${e.id}  severity: ${e.severity}  category: ${e.category || '(none)'}`;
      detailBody.appendChild(meta);

      // Correlated breadcrumbs — show related events with same appId in ±3s window
      const all = EventLog.getAll();
      const related = all.filter(r => r.id !== e.id && r.data && e.data && r.data.appId && r.data.appId === e.data.appId && Math.abs(r.timestamp - e.timestamp) <= 3000).slice(0, 8);
      if (related.length) {
        const crumbLabel = createEl('div', { style: 'color:var(--text-muted);font-size:10px;margin-top:8px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;' });
        crumbLabel.textContent = `Related events (±3s, same appId: ${e.data.appId})`;
        detailBody.appendChild(crumbLabel);
        const crumbBox = createEl('div', { style: 'margin-left:8px;border-left:1px solid var(--border-subtle);padding-left:6px;' });
        for (const r of related) {
          const crumb = createEl('div', { style: 'font-size:10px;color:var(--text-muted);cursor:pointer;padding:2px 0;', textContent: `${formatTime(r.timestamp)} [${r.severity.toUpperCase()}] ${r.message.slice(0, 90)}` });
          crumb.addEventListener('click', () => { selectedEventId = r.id; renderDetail(r); render(); });
          crumbBox.appendChild(crumb);
        }
        detailBody.appendChild(crumbBox);
      }

      if (e.data != null) {
        const dataLabel = createEl('div', { style: 'color:var(--text-muted);font-size:10px;margin-top:8px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;' });
        dataLabel.textContent = 'Data payload';
        detailBody.appendChild(dataLabel);
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0;padding:6px 8px;background:var(--bg-sunken,#0a0c10);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-muted);font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto;';
        try { pre.textContent = JSON.stringify(e.data, null, 2); } catch { pre.textContent = String(e.data); }
        detailBody.appendChild(pre);
      }
    }

    let lastFiltered = [];

    function render() {
      const all = EventLog.getAll();
      refreshAppOptions(all);
      const filtered = sortEntries(all.filter(matches));
      lastFiltered = filtered;

      // Rate indicator only tracks genuinely new entries since the last
      // render, not the whole filtered set, so it reflects live throughput.
      if (all.length !== lastSeenCount) {
        const newCount = Math.max(0, all.length - lastSeenCount);
        recordRate(all.slice(0, newCount));
        lastSeenCount = all.length;
        evaluateAlerts(all.slice(0, newCount));
      }

      countText.textContent = filtered.length === all.length
        ? `${all.length} event${all.length === 1 ? '' : 's'}`
        : `${filtered.length} of ${all.length} events`;

      list.innerHTML = '';
      if (!filtered.length) {
        list.appendChild(createEl('div', {
          style: 'padding:24px;text-align:center;color:var(--text-muted);font-size:12px;',
          textContent: all.length ? 'No events match the current filter.' : 'No events yet. Activity from apps, permissions, and packages will show up here.'
        }));
        return;
      }

      // Newest first — matches EventLog.log's unshift order already, so no
      // extra sort needed here.
      const groups = buildGroups(filtered.slice(0, 500));
      for (const g of groups) {
        if (g.entries.length === 1) {
          list.appendChild(renderRow(g.entries[0]));
          continue;
        }

        // Correlated cluster: show the newest entry as the summary row with
        // a count badge; the rest render underneath, indented, always visible
        // (no separate collapse state needed — the cluster itself is the
        // grouping, not another layer of hide/show).
        const head = g.entries[0];
        const headRow = renderRow(head);
        headRow.appendChild(createEl('span', {
          style: 'color:var(--text-muted);flex-shrink:0;font-size:10px;background:var(--bg-sunken);border-radius:8px;padding:1px 6px;',
          textContent: `+${g.entries.length - 1} related`
        }));
        list.appendChild(headRow);

        const clusterBox = createEl('div', { style: 'margin-left:20px;border-left:2px solid var(--border-subtle);padding-left:8px;' });
        for (const e of g.entries.slice(1)) {
          clusterBox.appendChild(renderRow(e));
        }
        list.appendChild(clusterBox);
      }
    }

    // ── Live updates ───────────────────────────────────────────────────
    const unsubscribe = EventLog.subscribe(() => {
      if (paused) return;
      render();
    });
    state.cleanups.push(unsubscribe);

    // ── Wiring ─────────────────────────────────────────────────────────
    searchInput.addEventListener('input', () => { searchQuery = searchInput.value; saveFilters(); render(); }, { signal: ac.signal });
    appSelect.addEventListener('change', () => { appFilter = appSelect.value; saveFilters(); render(); }, { signal: ac.signal });
    categorySelect.addEventListener('change', () => { categoryFilter = categorySelect.value; saveFilters(); render(); }, { signal: ac.signal });
    severitySelect.addEventListener('change', () => { severityFilter = severitySelect.value; saveFilters(); render(); }, { signal: ac.signal });
    timeRangeSelect.addEventListener('change', () => { timeRange = timeRangeSelect.value; saveFilters(); render(); }, { signal: ac.signal });
    sortSelect.addEventListener('change', () => { sortOrder = sortSelect.value; saveFilters(); render(); }, { signal: ac.signal });

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.style.color = paused ? 'var(--accent, #67e8f9)' : 'var(--text-muted)';
      if (!paused) render();
    }, { signal: ac.signal });

    clearBtn.addEventListener('click', () => {
      EventLog.clear();
      recentTimestamps = [];
      lastSeenCount = 0;
      rateText.textContent = '';
      render();
    }, { signal: ac.signal });

    exportBtn.addEventListener('click', () => {
      if (!lastFiltered.length) return;
      const lines = lastFiltered.map(e => `${new Date(e.timestamp).toISOString()} [${SEVERITY_LABEL[e.severity] || 'INFO'}] [${e.app}] ${e.message}`);
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = createEl('a', { href: url, download: 'nbosp-events-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, { signal: ac.signal });

    // ── Saved views ─────────────────────────────────────────────────────
    async function promptViewName(existing) {
      const name = await showPrompt(existing ? 'Rename view:' : 'Name this view:', existing ? existing.name : '');
      if (name === null) return null;
      const trimmed = name.trim();
      if (!trimmed) return null;
      return trimmed;
    }

    saveViewBtn.addEventListener('click', async () => {
      const name = await promptViewName(null);
      if (!name) return;
      const view = {
        id: 'view_' + Date.now(),
        name,
        searchQuery, appFilter, categoryFilter, severityFilter, timeRange, sortOrder,
        createdAt: Date.now(),
      };
      savedViews.push(view);
      saveViews();
      refreshViewOptions();
      savedViewSelect.value = view.id;
    }, { signal: ac.signal });

    savedViewSelect.addEventListener('change', () => {
      const id = savedViewSelect.value;
      if (!id) return;
      const view = savedViews.find(v => v.id === id);
      if (!view) return;
      searchQuery = view.searchQuery || '';
      appFilter = view.appFilter || '';
      categoryFilter = view.categoryFilter || '';
      severityFilter = view.severityFilter || '';
      timeRange = view.timeRange || 'all';
      sortOrder = view.sortOrder || 'newest';
      searchInput.value = searchQuery;
      appSelect.value = appFilter;
      categorySelect.value = categoryFilter;
      severitySelect.value = severityFilter;
      timeRangeSelect.value = timeRange;
      sortSelect.value = sortOrder;
      saveFilters();
      render();
    }, { signal: ac.signal });

    async function openManageViewsModal() {
      if (!savedViews.length) { await showModal('Manage views', 'No saved views yet.'); return; }

      const body = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;' });
      for (const v of savedViews) {
        const row = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--border-subtle);border-radius:4px;' });
        row.appendChild(createEl('span', { style: 'flex:1;font-size:12px;', textContent: v.name }));
        const renameBtn = createEl('button', { className: 'btn', textContent: 'Rename', style: 'font-size:11px;padding:3px 8px;' });
        const deleteBtn = createEl('button', { className: 'btn btn-danger', textContent: 'Delete', style: 'font-size:11px;padding:3px 8px;' });
        renameBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const newName = await promptViewName(v);
          if (newName) { v.name = newName; saveViews(); refreshViewOptions(); row.firstChild.textContent = newName; }
        });
        deleteBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          savedViews = savedViews.filter(sv => sv.id !== v.id);
          saveViews();
          refreshViewOptions();
          if (savedViewSelect.value === v.id) savedViewSelect.value = '';
          row.remove();
        });
        row.appendChild(renameBtn);
        row.appendChild(deleteBtn);
        body.appendChild(row);
      }

      await showModal('Manage views', body, [{ label: 'Close', primary: true }]);
    }

    manageViewsBtn.addEventListener('click', () => { openManageViewsModal(); }, { signal: ac.signal });

    // ── Alert rules (quick inline) ──────────────────────────────────────
    const alertsBtn = createEl('button', { textContent: '⚡ Alerts', title: 'Manage alert rules', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    toolbar.appendChild(alertsBtn);

    async function openAlertsModal() {
      const body = createEl('div', { style: 'display:flex;flex-direction:column;gap:10px;' });

      const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;' });
      function renderRuleList() {
        list.innerHTML = '';
        if (!alertRules.length) {
          list.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted);', textContent: 'No alert rules yet.' }));
          return;
        }
        for (const r of alertRules) {
          const row = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--border-subtle);border-radius:4px;font-size:11px;' });
          row.appendChild(createEl('span', {
            style: 'flex:1;font-family:monospace;color:' + (r.enabled ? 'var(--text-primary)' : 'var(--text-muted)'),
            textContent: `[${r.severity || 'any'}] ${r.app || '*'}/${r.category || '*'} "${r.contains || ''}"`
          }));
          const toggleBtn = createEl('button', { className: 'btn', textContent: r.enabled ? 'Enabled' : 'Disabled', style: 'font-size:11px;padding:3px 8px;' });
          const removeBtn = createEl('button', { className: 'btn btn-danger', textContent: 'Remove', style: 'font-size:11px;padding:3px 8px;' });
          toggleBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            r.enabled = !r.enabled;
            saveAlerts();
            renderRuleList();
          });
          removeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            alertRules = alertRules.filter(ar => ar.id !== r.id);
            saveAlerts();
            renderRuleList();
          });
          row.appendChild(toggleBtn);
          row.appendChild(removeBtn);
          list.appendChild(row);
        }
      }
      renderRuleList();
      body.appendChild(list);

      body.appendChild(createEl('div', { style: 'border-top:1px solid var(--border-subtle);margin-top:2px;padding-top:8px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;', textContent: 'Add rule' }));

      const form = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
      const nameInput = createEl('input', { placeholder: 'Rule name', className: 'input', style: 'width:100%;box-sizing:border-box;font-size:11px;' });
      const fieldsRow = createEl('div', { style: 'display:flex;gap:6px;' });
      const sevInput = createEl('select', { className: 'input', style: 'flex:1;font-size:11px;' });
      for (const [value, label] of [['', 'Any severity'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']]) {
        sevInput.appendChild(createEl('option', { value, textContent: label }));
      }
      const appInput = createEl('input', { placeholder: 'App (blank = any)', className: 'input', style: 'flex:1;font-size:11px;' });
      const categoryInput = createEl('input', { placeholder: 'Category (blank = any)', className: 'input', style: 'flex:1;font-size:11px;' });
      fieldsRow.appendChild(sevInput);
      fieldsRow.appendChild(appInput);
      fieldsRow.appendChild(categoryInput);
      const containsInput = createEl('input', { placeholder: 'Message contains (optional)', className: 'input', style: 'width:100%;box-sizing:border-box;font-size:11px;' });
      const addBtn = createEl('button', { className: 'btn btn-primary', textContent: '+ Add rule', style: 'align-self:flex-start;font-size:11px;padding:5px 10px;' });

      addBtn.addEventListener('click', () => {
        const rule = {
          id: 'alert_' + Date.now(),
          name: nameInput.value.trim() || 'Unnamed',
          severity: sevInput.value || null,
          app: appInput.value.trim() || null,
          category: categoryInput.value.trim() || null,
          contains: containsInput.value.trim() || null,
          enabled: true,
          lastFiredAt: null,
        };
        alertRules.push(rule);
        saveAlerts();
        renderRuleList();
        nameInput.value = ''; sevInput.value = ''; appInput.value = ''; categoryInput.value = ''; containsInput.value = '';
      });

      form.appendChild(nameInput);
      form.appendChild(fieldsRow);
      form.appendChild(containsInput);
      form.appendChild(addBtn);
      body.appendChild(form);

      await showModal('Alert rules', body, [{ label: 'Close', primary: true }]);
    }

    alertsBtn.addEventListener('click', () => { openAlertsModal(); }, { signal: ac.signal });

    // ── Session tracking ────────────────────────────────────────────────
    function recordSessionStart() {
      const sid = getCurrentSessionId();
      currentSessionId = sid;
      try {
        const sessions = readDevJson(SESSION_REG_PATH, SESSION_STORAGE_KEY, []);
        const existing = sessions.find(s => s.id === sid);
        if (!existing) {
          sessions.push({ id: sid, startedAt: Date.now(), eventCount: 0 });
          writeDevJson(SESSION_REG_PATH, SESSION_STORAGE_KEY, sessions.slice(-20));
        }
      } catch {}
    }
    recordSessionStart();

    const compareBtn = createEl('button', { textContent: '⇔ Compare', title: 'Compare current session with a previous one', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    toolbar.appendChild(compareBtn);

    function renderDiffColumn(label, entries) {
      const col = createEl('div', { style: 'flex:1;min-width:0;' });
      col.appendChild(createEl('div', { style: 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;', textContent: `${label} (${entries.length})` }));
      const box = createEl('div', { style: 'max-height:200px;overflow:auto;border:1px solid var(--border-subtle);border-radius:4px;padding:6px;font-family:monospace;font-size:10px;display:flex;flex-direction:column;gap:2px;' });
      if (!entries.length) {
        box.appendChild(createEl('div', { style: 'color:var(--text-muted);', textContent: '(none)' }));
      } else {
        for (const e of entries.slice(0, 20)) {
          box.appendChild(createEl('div', {
            style: `color:${SEVERITY_COLOR[e.severity] || SEVERITY_COLOR.info};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
            title: `${formatTime(e.timestamp)} [${e.severity.toUpperCase()}] [${e.app}] ${e.message}`,
            textContent: `${formatTime(e.timestamp)} [${e.app}] ${e.message}`
          }));
        }
      }
      col.appendChild(box);
      return col;
    }

    async function openCompareModal() {
      let sessions = [];
      try { sessions = readDevJson(SESSION_REG_PATH, SESSION_STORAGE_KEY, []); } catch {}
      if (sessions.length < 2) { await showModal('Compare sessions', 'Need at least 2 sessions recorded to compare.'); return; }

      const picker = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;' });
      const otherSessions = sessions.filter(s => s.id !== currentSessionId);
      for (const s of otherSessions) {
        const row = createEl('button', {
          className: 'btn',
          style: 'text-align:left;font-size:11px;padding:6px 8px;',
          textContent: `${s.id}  (${new Date(s.startedAt).toLocaleString()})`
        });
        row.addEventListener('click', () => showDiff(s));
        picker.appendChild(row);
      }

      async function showDiff(other) {
        const otherEvents = EventLog.getAll().filter(e => {
          const sessionTime = new Date(other.id.replace('session_', '')).getTime();
          return e.timestamp >= sessionTime && e.timestamp < sessionTime + 24 * 60 * 60 * 1000;
        });
        const currentEvents = EventLog.getAll().filter(e => {
          const sessionTime = new Date(currentSessionId.replace('session_', '')).getTime();
          return e.timestamp >= sessionTime && e.timestamp < sessionTime + 24 * 60 * 60 * 1000;
        });
        const onlyInOther = otherEvents.filter(e => !currentEvents.some(c => c.id === e.id));
        const onlyInCurrent = currentEvents.filter(e => !otherEvents.some(o => o.id === e.id));

        const diffBody = createEl('div', { style: 'display:flex;flex-direction:column;gap:8px;' });
        diffBody.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted);', textContent: `Current: ${currentSessionId}  vs  Other: ${other.id}` }));
        const cols = createEl('div', { style: 'display:flex;gap:10px;' });
        cols.appendChild(renderDiffColumn('New in current', onlyInCurrent));
        cols.appendChild(renderDiffColumn('New in other', onlyInOther));
        diffBody.appendChild(cols);

        await showModal('Session diff', diffBody, [{ label: 'Close', primary: true }]);
      }

      await showModal('Compare sessions', picker, [{ label: 'Cancel' }]);
    }

    compareBtn.addEventListener('click', () => { openCompareModal(); }, { signal: ac.signal });

    render();
  }
});