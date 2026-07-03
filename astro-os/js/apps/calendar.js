registerApp({
  id: 'calendar-app', name: 'Calendar', icon: 'calendar',
  description: 'Calendar & Scheduling',
  defaultSize: [860, 580], minSize: [600, 440],

  init(content, _state) {
    // ── NovaByte runtime guard ──────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.calendar', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.calendar</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    // ── Constants (frozen — no accidental mutation) ─────────────────────
    const STORE_KEY   = 'calendar_events_v2';
    const COLORS      = Object.freeze(['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364']);
    const COLOR_NAMES = Object.freeze(['Blue','Green','Yellow','Red','Purple','Salmon','Sky','Lime']);
    const VALID_VIEWS = Object.freeze(['month','week','day','agenda']);
    const DAYS_SHORT  = Object.freeze(['Sun','Mon','Tue','Wed','Thu','Fri','Sat']);
    const DAYS_MINI   = Object.freeze(['S','M','T','W','T','F','S']);

    // ── Date helpers ────────────────────────────────────────────────────
    // FIX: always derive date strings from local getters, never toISOString()
    // toISOString() returns UTC midnight, which is the previous day in UTC− zones.
    const toDateStr = d =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // FIX: parse stored YYYY-MM-DD strings as local noon, not UTC midnight
    const parseDate = str => new Date(`${str}T12:00:00`);

    // FIX: immutable navigation — replaces mutating setMonth/setDate calls
    // which cause month-end overflow bugs (e.g. Jan 31 → setMonth(-1) → Dec 31 ✓
    // but Mar 31 → setMonth(1) → Mar 3 ✗ because Feb 31 overflows)
    const navMonth = (d, delta) => new Date(d.getFullYear(), d.getMonth() + delta, 1);
    const navWeek  = (d, delta) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta * 7);
    const navDay   = (d, delta) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);

    // ── Storage ─────────────────────────────────────────────────────────
    // SECURITY: sanitize every event loaded from localStorage to prevent
    // CSS injection via ev.color and corrupt/missing field crashes.
    function sanitizeEvent(ev) {
      if (!ev || typeof ev !== 'object') return null;
      if (typeof ev.title !== 'string' || !ev.title.trim()) return null;
      if (typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
      return {
        id:        typeof ev.id === 'string' && ev.id ? ev.id : crypto.randomUUID(),
        title:     ev.title.trim(),
        date:      ev.date,
        timeStart: typeof ev.timeStart === 'string' ? ev.timeStart : '',
        timeEnd:   typeof ev.timeEnd   === 'string' ? ev.timeEnd   : '',
        desc:      typeof ev.desc      === 'string' ? ev.desc      : '',
        // SECURITY: only allow known colors — blocks CSS injection from tampered storage
        color:     COLORS.includes(ev.color) ? ev.color : COLORS[0],
      };
    }

    function loadEvents() {
      if (!AppPermissionManager?.isGranted('calendar:read', 'calendar-app')) return [];
      try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
        return Array.isArray(raw) ? raw.map(sanitizeEvent).filter(Boolean) : [];
      } catch { return []; }
    }
    function saveEvents(evs) { lsSave(STORE_KEY, evs); }

    // ── App state ───────────────────────────────────────────────────────
    let events   = loadEvents();
    let view     = 'month';
    let viewDate = new Date();

    // ── Root layout ─────────────────────────────────────────────────────
    const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;font-size:13px;' });
    content.appendChild(root);

    // ── Sidebar ──────────────────────────────────────────────────────────
    const sidebar = createEl('div', { style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);display:flex;flex-direction:column;background:var(--bg-sunken);' });

    const miniNav   = createEl('div', { style: 'padding:10px 12px 4px;' });
    const miniHdr   = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;' });
    const miniTitle = createEl('span', { style: 'font-size:12px;font-weight:600;' });
    const miniPrev  = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
    const miniNext  = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
    miniPrev.innerHTML = svgIcon('chevron-left', 12);
    miniNext.innerHTML = svgIcon('chevron-right', 12);
    miniHdr.append(miniPrev, miniTitle, miniNext);

    const miniGrid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:10px;text-align:center;' });
    DAYS_MINI.forEach(d => {
      miniGrid.appendChild(createEl('div', { textContent: d, style: 'color:var(--text-muted);padding:2px 0;font-weight:600;' }));
    });
    miniNav.append(miniHdr, miniGrid);

    const upcomingWrap  = createEl('div', { style: 'flex:1;overflow-y:auto;padding:8px 10px;border-top:1px solid var(--border-subtle);' });
    const upcomingTitle = createEl('div', { textContent: 'Upcoming', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:6px;' });
    const upcomingList  = createEl('div');
    upcomingWrap.append(upcomingTitle, upcomingList);

    const newEvtBtn = createEl('button', { className: 'btn btn-primary', style: 'margin:10px;width:calc(100% - 20px);font-size:12px;' });
    newEvtBtn.innerHTML = svgIcon('plus', 12) + ' New Event';

    sidebar.append(miniNav, upcomingWrap, newEvtBtn);

    // ── Main panel ───────────────────────────────────────────────────────
    const main = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

    const toolbar   = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
    const prevBtn   = createEl('button', { className: 'btn btn-icon btn-sm' }); prevBtn.innerHTML  = svgIcon('chevron-left', 16);
    const nextBtn   = createEl('button', { className: 'btn btn-icon btn-sm' }); nextBtn.innerHTML  = svgIcon('chevron-right', 16);
    const todayBtn  = createEl('button', { className: 'btn btn-sm', textContent: 'Today' });
    const mainTitle = createEl('h3', { style: 'margin:0;font-size:15px;font-weight:700;flex:1;' });

    const viewBtnsWrap = createEl('div', { style: 'display:flex;background:var(--bg-sunken);border-radius:8px;padding:3px;gap:2px;' });
    VALID_VIEWS.forEach(v => {
      const b = createEl('button', {
        textContent: v[0].toUpperCase() + v.slice(1),
        style: 'padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.15s;'
      });
      b.dataset.view = v;
      b.addEventListener('click', () => { view = v; renderMain(); updateViewBtns(); });
      viewBtnsWrap.appendChild(b);
    });

    toolbar.append(prevBtn, nextBtn, todayBtn, mainTitle, viewBtnsWrap);

    const contentArea = createEl('div', { style: 'flex:1;overflow:auto;' });
    main.append(toolbar, contentArea);
    root.append(sidebar, main);

    // ── Mini-calendar ────────────────────────────────────────────────────
    function renderMini() {
      const y = viewDate.getFullYear(), m = viewDate.getMonth();
      miniTitle.textContent = viewDate.toLocaleDateString([], { month: 'short', year: 'numeric' });

      // O(1) per-day lookup instead of O(n) events.some() per day
      const eventDates = new Set(events.map(ev => ev.date));

      const today  = new Date();
      const todayY = today.getFullYear(), todayM = today.getMonth(), todayD = today.getDate();
      const firstDay = new Date(y, m, 1).getDay();
      const daysIn   = new Date(y, m + 1, 0).getDate();

      miniGrid.querySelectorAll('.mini-day').forEach(el => el.remove());

      const frag = document.createDocumentFragment();
      for (let i = 0; i < firstDay; i++) {
        frag.appendChild(createEl('div', { className: 'mini-day', style: 'padding:2px;' }));
      }
      for (let d = 1; d <= daysIn; d++) {
        const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isToday = d === todayD && m === todayM && y === todayY;
        const hasDot  = eventDates.has(dateStr);
        const cell = createEl('div', {
          className: 'mini-day',
          textContent: String(d),
          style: `padding:2px;border-radius:4px;cursor:pointer;${isToday ? 'background:var(--accent);color:#fff;font-weight:700;' : ''}`
        });
        if (hasDot && !isToday) cell.style.textDecoration = 'underline';
        cell.addEventListener('click', () => {
          viewDate = new Date(y, m, d);
          view = 'day'; updateViewBtns(); renderAll();
        });
        frag.appendChild(cell);
      }
      miniGrid.appendChild(frag);
    }

    // ── Upcoming list ────────────────────────────────────────────────────
    function renderUpcoming() {
      const today = toDateStr(new Date()); // FIX: local date, not UTC
      const upcoming = events
        .filter(ev => ev.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.timeStart.localeCompare(b.timeStart))
        .slice(0, 8);

      const frag = document.createDocumentFragment();
      if (!upcoming.length) {
        frag.appendChild(createEl('div', { textContent: 'No upcoming events', style: 'font-size:11px;color:var(--text-muted);padding:4px 0;' }));
      } else {
        upcoming.forEach(ev => {
          const item = createEl('div', { style: 'padding:5px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;' });
          const bar  = createEl('div', { style: `width:3px;height:28px;background:${ev.color};border-radius:2px;float:left;margin-right:8px;` });
          const info = createEl('div', { style: 'overflow:hidden;' });
          info.appendChild(createEl('div', { textContent: ev.title, style: 'font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
          info.appendChild(createEl('div', { textContent: ev.date + (ev.timeStart ? ' · ' + ev.timeStart : ''), style: 'font-size:10px;color:var(--text-muted);' }));
          item.append(bar, info);
          item.addEventListener('click', () => openEventModal(parseDate(ev.date), ev)); // FIX: was new Date(ev.date) — UTC shift
          frag.appendChild(item);
        });
      }
      upcomingList.replaceChildren(frag); // replaceChildren: modern clear+append vs innerHTML = ''
    }

    // ── View buttons ──────────────────────────────────────────────────────
    function updateViewBtns() {
      viewBtnsWrap.querySelectorAll('button').forEach(b => {
        const active = b.dataset.view === view;
        b.style.background = active ? 'var(--accent)' : 'transparent';
        b.style.color = active ? '#fff' : 'var(--text-primary)';
      });
    }

    // ── Month view ───────────────────────────────────────────────────────
    function renderMonthView(y, m) {
      mainTitle.textContent = viewDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
      const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);height:100%;' });

      const hdrFrag = document.createDocumentFragment();
      DAYS_SHORT.forEach(day => {
        hdrFrag.appendChild(createEl('div', { textContent: day, style: 'text-align:center;padding:6px 0;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);' }));
      });
      grid.appendChild(hdrFrag);

      const today  = new Date();
      const todayY = today.getFullYear(), todayM = today.getMonth(), todayD = today.getDate();
      const firstDay = new Date(y, m, 1).getDay();
      const daysIn   = new Date(y, m + 1, 0).getDate();

      // O(1) per-cell lookup: group all events by date string upfront
      const byDate = Object.groupBy(events, ev => ev.date);

      const cellFrag = document.createDocumentFragment();
      for (let i = 0; i < firstDay; i++) {
        cellFrag.appendChild(createEl('div', { style: 'border:1px solid var(--border-subtle);min-height:80px;background:var(--bg-sunken);opacity:0.5;' }));
      }
      for (let day = 1; day <= daysIn; day++) {
        const isToday = day === todayD && m === todayM && y === todayY;
        const dateStr  = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayEvs   = byDate[dateStr] ?? [];
        const cell = createEl('div', {
          style: `border:1px solid var(--border-subtle);min-height:80px;padding:4px;cursor:pointer;transition:background 0.1s;position:relative;${isToday ? 'background:var(--accent-muted);' : ''}`
        });
        cell.appendChild(createEl('div', {
          textContent: String(day),
          style: `font-size:12px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};margin-bottom:3px;`
        }));
        dayEvs.slice(0, 3).forEach(ev => {
          // SECURITY: textContent only — never innerHTML with user data
          const label = (ev.timeStart ? ev.timeStart + ' ' : '') + ev.title;
          const evEl  = createEl('div', {
            textContent: label,
            style: `font-size:10px;background:${ev.color};color:#fff;border-radius:3px;padding:1px 4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;`
          });
          evEl.addEventListener('click', e => { e.stopPropagation(); openEventModal(parseDate(dateStr), ev); });
          cell.appendChild(evEl);
        });
        cell.addEventListener('click', () => openEventModal(parseDate(dateStr), null));
        cell.addEventListener('mouseenter', () => { if (!isToday) cell.style.background = 'var(--bg-elevated)'; });
        cell.addEventListener('mouseleave', () => { cell.style.background = isToday ? 'var(--accent-muted)' : ''; });
        cellFrag.appendChild(cell);
      }
      grid.appendChild(cellFrag);
      contentArea.replaceChildren(grid);
    }

    // ── Week view ────────────────────────────────────────────────────────
    function renderWeekView(y, m, d) {
      const dow = viewDate.getDay();
      // FIX: immutable — create a fresh Date for start of week
      const startOfWeek = new Date(y, m, d - dow);
      // FIX: Array.from with mapper (ES2015+) — cleaner than [...Array(7)].map(...)
      const days = Array.from({ length: 7 }, (_, i) =>
        new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + i)
      );

      mainTitle.textContent =
        days[0].toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' +
        days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

      const today = new Date();
      const grid  = createEl('div', { style: 'display:grid;grid-template-columns:40px repeat(7,1fr);height:100%;overflow-y:auto;' });

      // Corner + day headers
      grid.appendChild(createEl('div', { style: 'border-bottom:1px solid var(--border-subtle);' }));
      days.forEach(dt => {
        const isToday = dt.toDateString() === today.toDateString();
        grid.appendChild(createEl('div', {
          textContent: dt.toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
          style: `text-align:center;padding:6px 4px;border-bottom:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);font-size:11px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};`
        }));
      });

      // O(1) lookup
      const byDate = Object.groupBy(events, ev => ev.date);

      // FIX: All-day events row (no timeStart) — these were completely invisible before
      // because `parseInt('99') === hr` never matched any hour 0–23
      grid.appendChild(createEl('div', {
        textContent: 'all', style: 'font-size:9px;color:var(--text-muted);padding:2px 4px;text-align:right;border-top:1px solid var(--border-subtle);line-height:2.8;'
      }));
      days.forEach(dt => {
        // FIX: toDateStr (local) not toISOString (UTC) — prevents off-by-one in UTC− zones
        const dStr    = toDateStr(dt);
        const allDay  = (byDate[dStr] ?? []).filter(ev => !ev.timeStart);
        const cell    = createEl('div', { style: 'border-top:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);min-height:28px;padding:1px;' });
        allDay.forEach(ev => {
          const evEl = createEl('div', { textContent: ev.title, style: `font-size:10px;background:${ev.color};color:#fff;border-radius:3px;padding:2px 4px;cursor:pointer;margin-bottom:1px;` });
          evEl.addEventListener('click', () => openEventModal(dt, ev));
          cell.appendChild(evEl);
        });
        grid.appendChild(cell);
      });

      // Hourly rows
      for (let hr = 0; hr < 24; hr++) {
        grid.appendChild(createEl('div', {
          textContent: hr === 0 ? '12a' : hr < 12 ? hr + 'a' : hr === 12 ? '12p' : (hr - 12) + 'p',
          style: 'font-size:10px;color:var(--text-muted);padding:2px 4px;text-align:right;border-top:1px solid var(--border-subtle);'
        }));
        days.forEach(dt => {
          const dStr = toDateStr(dt); // FIX: local date string
          const cell = createEl('div', { style: 'border-top:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);min-height:36px;padding:1px;position:relative;' });
          // FIX: Number(ev.timeStart.split(':')[0]) — correct hour parse, handles '09:30' → 9
          // Old: parseInt(ev.timeStart || '99') — broke when timeStart was empty ('99' !== any hr)
          const hrEvs = (byDate[dStr] ?? []).filter(ev => ev.timeStart && Number(ev.timeStart.split(':')[0]) === hr);
          hrEvs.forEach(ev => {
            const evEl = createEl('div', { textContent: ev.title, style: `font-size:10px;background:${ev.color};color:#fff;border-radius:3px;padding:2px 4px;cursor:pointer;` });
            evEl.addEventListener('click', () => openEventModal(dt, ev));
            cell.appendChild(evEl);
          });
          grid.appendChild(cell);
        });
      }
      contentArea.replaceChildren(grid);
    }

    // ── Day view ─────────────────────────────────────────────────────────
    function renderDayView(y, m, d) {
      mainTitle.textContent = viewDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayEvs  = events
        .filter(ev => ev.date === dateStr)
        .sort((a, b) => a.timeStart.localeCompare(b.timeStart));

      const wrap = createEl('div', { style: 'padding:16px;max-width:600px;' });
      if (!dayEvs.length) {
        wrap.appendChild(createEl('div', { textContent: 'No events — click to add one.', style: 'color:var(--text-muted);font-size:13px;margin-top:24px;' }));
      } else {
        const frag = document.createDocumentFragment();
        dayEvs.forEach(ev => {
          const row  = createEl('div', { style: 'display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;' });
          const bar  = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color};flex-shrink:0;` });
          const info = createEl('div', { style: 'flex:1;' });
          info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:14px;' }));
          if (ev.timeStart) info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:12px;color:var(--text-muted);' }));
          if (ev.desc)      info.appendChild(createEl('div', { textContent: ev.desc, style: 'font-size:12px;color:var(--text-secondary);margin-top:4px;' }));
          row.append(bar, info);
          row.addEventListener('click', () => openEventModal(viewDate, ev));
          frag.appendChild(row);
        });
        wrap.appendChild(frag);
      }
      wrap.addEventListener('click', e => { if (e.target === wrap) openEventModal(viewDate, null); });
      contentArea.replaceChildren(wrap);
    }

    // ── Agenda view ──────────────────────────────────────────────────────
    function renderAgendaView() {
      mainTitle.textContent = 'Agenda';
      const today  = toDateStr(new Date()); // FIX: local date
      const sorted = events
        .filter(ev => ev.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.timeStart.localeCompare(b.timeStart));

      const wrap = createEl('div', { style: 'padding:16px;' });
      if (!sorted.length) {
        wrap.appendChild(createEl('div', { textContent: 'No upcoming events.', style: 'color:var(--text-muted);' }));
        contentArea.replaceChildren(wrap);
        return;
      }

      let lastDate = '';
      const frag = document.createDocumentFragment();
      sorted.forEach(ev => {
        if (ev.date !== lastDate) {
          lastDate = ev.date;
          frag.appendChild(createEl('div', {
            textContent: parseDate(ev.date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
            style: 'font-size:12px;font-weight:700;color:var(--text-muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.06em;'
          }));
        }
        const row  = createEl('div', { style: 'display:flex;gap:10px;padding:8px;border-radius:8px;cursor:pointer;margin-bottom:4px;' });
        const bar  = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color};flex-shrink:0;` });
        const info = createEl('div');
        info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:13px;' }));
        if (ev.timeStart) info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:11px;color:var(--text-muted);' }));
        row.append(bar, info);
        row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', () => openEventModal(parseDate(ev.date), ev)); // FIX: parseDate not new Date(ev.date)
        frag.appendChild(row);
      });
      wrap.appendChild(frag);
      contentArea.replaceChildren(wrap);
    }

    // ── renderMain dispatcher ────────────────────────────────────────────
    function renderMain() {
      const y = viewDate.getFullYear(), m = viewDate.getMonth(), d = viewDate.getDate();
      if      (view === 'month')  renderMonthView(y, m);
      else if (view === 'week')   renderWeekView(y, m, d);
      else if (view === 'day')    renderDayView(y, m, d);
      else if (view === 'agenda') renderAgendaView();
    }

    // ── Event modal ──────────────────────────────────────────────────────
    function openEventModal(date, existing) {
      const isEdit = existing != null;

      // AbortController: all listeners attached with { signal } are torn down
      // in one call when the modal closes — no manual removeEventListener bookkeeping
      const ac  = new AbortController();
      const sig = ac.signal;
      const close = () => { ac.abort(); overlay.remove(); };

      const overlay = createEl('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;'
      });
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', isEdit ? 'Edit Event' : 'New Event');

      const modal = createEl('div', {
        style: 'background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:12px;padding:20px;width:360px;max-width:90vw;'
      });

      // Keyboard: Escape closes, all listeners auto-removed on close via signal
      document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }, { signal: sig });

      const titleRow = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;' });
      titleRow.appendChild(createEl('span', { textContent: isEdit ? 'Edit Event' : 'New Event', style: 'font-size:15px;font-weight:700;' }));
      const closeBtn = createEl('button', { className: 'btn btn-icon btn-sm' });
      closeBtn.innerHTML = svgIcon('x', 14);
      closeBtn.addEventListener('click', close, { signal: sig });
      titleRow.appendChild(closeBtn);
      modal.appendChild(titleRow);

      // FIX: unique per-modal IDs prevent collisions if runtime ever mounts 2+ instances
      const uid = crypto.randomUUID().slice(0, 8);

      function field(labelText, inputId, el) {
        const wrap = createEl('div', { style: 'margin-bottom:12px;' });
        const lbl  = createEl('label', { textContent: labelText, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' });
        if (inputId) lbl.htmlFor = inputId; // Accessibility: label → input association
        wrap.append(lbl, el);
        return wrap;
      }

      const titleInp = createEl('input', { className: 'input', placeholder: 'Event title', value: existing?.title ?? '', id: `evt-t-${uid}`, style: 'width:100%;' });
      modal.appendChild(field('Title', `evt-t-${uid}`, titleInp));

      // FIX: toDateStr(date) — safe local date string even if `date` came from parseDate()
      const safeDate = (date instanceof Date && !isNaN(date)) ? toDateStr(date) : toDateStr(new Date());
      const dateInp  = createEl('input', { type: 'date', className: 'input', value: safeDate, id: `evt-d-${uid}`, style: 'width:100%;' });
      modal.appendChild(field('Date', `evt-d-${uid}`, dateInp));

      const timeStartInp = createEl('input', { type: 'time', className: 'input', value: existing?.timeStart ?? '', id: `evt-ts-${uid}`, style: 'flex:1;' });
      const timeEndInp   = createEl('input', { type: 'time', className: 'input', value: existing?.timeEnd ?? '', id: `evt-te-${uid}`, style: 'flex:1;' });
      const timeRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
      function timeField(labelText, inputId, el) {
        const w   = createEl('div', { style: 'flex:1;' });
        const lbl = createEl('label', { textContent: labelText, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' });
        lbl.htmlFor = inputId;
        w.append(lbl, el);
        return w;
      }
      timeRow.append(timeField('Start', `evt-ts-${uid}`, timeStartInp), timeField('End', `evt-te-${uid}`, timeEndInp));
      modal.appendChild(timeRow);

      const descInp = createEl('textarea', { className: 'input', id: `evt-dc-${uid}`, placeholder: 'Description (optional)', style: 'width:100%;resize:vertical;min-height:56px;' });
      descInp.value = existing?.desc ?? '';
      modal.appendChild(field('Description', `evt-dc-${uid}`, descInp));

      // Color picker
      const colorWrap = createEl('div', { style: 'margin-bottom:16px;' });
      colorWrap.appendChild(createEl('label', { textContent: 'Color', style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;' }));
      const colorRow = createEl('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
      // SECURITY: validate color from existing event against known COLORS
      let selectedColor = (existing?.color && COLORS.includes(existing.color)) ? existing.color : COLORS[0];
      const colorBtns = COLORS.map((c, i) => {
        const cb = createEl('button', {
          title: COLOR_NAMES[i],
          style: `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === selectedColor ? '#fff' : 'transparent'};cursor:pointer;`
        });
        cb.setAttribute('aria-label', COLOR_NAMES[i]);
        cb.addEventListener('click', () => {
          selectedColor = c;
          colorBtns.forEach((b, j) => b.style.borderColor = COLORS[j] === c ? '#fff' : 'transparent');
        }, { signal: sig });
        colorRow.appendChild(cb);
        return cb;
      });
      colorWrap.appendChild(colorRow);
      modal.appendChild(colorWrap);

      // Save handler — shared between button click and Enter key
      function handleSave() {
        const t = titleInp.value.trim();
        if (!t) { titleInp.focus(); return; }
        // FIX: validate date before saving — original allowed empty string date
        const dateVal = dateInp.value;
        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) { dateInp.focus(); return; }

        if (isEdit) {
          if (!AppPermissionManager?.isGranted('calendar:write', 'calendar-app')) {
            Notify.show({ title: 'Permission denied', body: 'Calendar needs calendar:write to edit events.', type: 'error', appName: 'Calendar' });
            return;
          }
          const idx = events.findIndex(ev => ev.id === existing.id);
          if (idx !== -1) {
            // structuredClone for clean immutable update — no Object.assign mutation
            events[idx] = structuredClone({
              ...events[idx],
              title: t, date: dateVal,
              timeStart: timeStartInp.value, timeEnd: timeEndInp.value,
              desc: descInp.value.trim(), color: selectedColor,
            });
          }
        } else {
          if (!AppPermissionManager?.isGranted('calendar:write', 'calendar-app')) {
            Notify.show({ title: 'Permission denied', body: 'Calendar needs calendar:write to create events.', type: 'error', appName: 'Calendar' });
            return;
          }
          events.push({
            id:        crypto.randomUUID(),   // FIX: UUID not Date.now() — no collision risk
            title:     t,
            date:      dateVal,
            timeStart: timeStartInp.value,
            timeEnd:   timeEndInp.value,
            desc:      descInp.value.trim(),
            color:     selectedColor,
          });
        }
        saveEvents(events);
        close();
        renderAll();
        Notify?.show?.({ title: isEdit ? 'Event updated' : 'Event added', body: t, type: 'success', appName: 'Calendar' });
      }

      // Keyboard: Enter in title submits
      titleInp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSave(); }, { signal: sig });

      // Actions row
      const actions  = createEl('div', { style: 'display:flex;gap:8px;justify-content:space-between;' });
      const saveBtn  = createEl('button', { className: 'btn btn-primary', textContent: isEdit ? 'Save Changes' : 'Add Event' });
      const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
      saveBtn.addEventListener('click',   handleSave, { signal: sig });
      cancelBtn.addEventListener('click', close,      { signal: sig });

      if (isEdit) {
        if (AppPermissionManager?.isGranted('calendar:delete', 'calendar-app')) {
          const delBtn = createEl('button', { className: 'btn', style: 'color:var(--text-danger);border-color:var(--text-danger);', textContent: 'Delete' });
          delBtn.addEventListener('click', () => {
            events = events.filter(ev => ev.id !== existing.id);
            saveEvents(events); close(); renderAll();
          }, { signal: sig });
          actions.appendChild(delBtn);
        }
      } else {
        actions.appendChild(createEl('div'));
      }
      actions.append(cancelBtn, saveBtn);
      modal.appendChild(actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // FIX: requestAnimationFrame instead of setTimeout(..., 50) — no magic delay,
      // fires reliably after paint when the element is actually in the DOM
      requestAnimationFrame(() => titleInp.focus());
    }

    // ── Navigation handlers ──────────────────────────────────────────────
    prevBtn.addEventListener('click', () => {
      // FIX: assign new Date — never mutate viewDate in place
      if      (view === 'month') viewDate = navMonth(viewDate, -1);
      else if (view === 'week')  viewDate = navWeek(viewDate, -1);
      else                       viewDate = navDay(viewDate, -1);
      renderAll();
    });
    nextBtn.addEventListener('click', () => {
      if      (view === 'month') viewDate = navMonth(viewDate, 1);
      else if (view === 'week')  viewDate = navWeek(viewDate, 1);
      else                       viewDate = navDay(viewDate, 1);
      renderAll();
    });
    todayBtn.addEventListener('click',  () => { viewDate = new Date(); renderAll(); });
    miniPrev.addEventListener('click',  () => { viewDate = navMonth(viewDate, -1); renderAll(); });
    miniNext.addEventListener('click',  () => { viewDate = navMonth(viewDate,  1); renderAll(); });
    newEvtBtn.addEventListener('click', () => openEventModal(new Date(), null));

    function renderAll() { renderMini(); renderMain(); renderUpcoming(); updateViewBtns(); }
    renderAll();
  }
});