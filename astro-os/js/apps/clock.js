registerApp({
  id: 'nbosp-clock',
  name: 'Clock',
  icon: 'alarm-clock',
  description: 'Alarm · Clock · Timer · Stopwatch',
  defaultSize: [400, 600],
  minSize: [340, 480],

  init(content, state) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.clock', 'files')) {
      content.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center"><b>com.nbosp.clock</b><br>' +
        'App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    const SK = 'nbosp_clock_v1';

    function loadDb() {
      try {
        return JSON.parse(localStorage.getItem(SK) || '{}');
      } catch {
        return {};
      }
    }

    function saveDb() {
      try {
        localStorage.setItem(SK, JSON.stringify(db));
      } catch {}
    }

    const TIME_RE = /^\d{2}:\d{2}$/;

    function sanitiseAlarm(al) {
      return {
        id: typeof al?.id === 'string' ? al.id : Date.now().toString(36),
        time: typeof al?.time === 'string' ? al.time : '07:00',
        label: typeof al?.label === 'string' ? al.label : '',
        days: Array.isArray(al?.days)
          ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          : [],
        enabled: al?.enabled !== false,
      };
    }

    const db = loadDb();
    if (!Array.isArray(db.alarms)) db.alarms = [];
    db.alarms = db.alarms.map(sanitiseAlarm).filter(al => TIME_RE.test(al.time));

    function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

    const clockSvc = window.__NBOSP_BG?.clock;

    function syncClockState() {
      const s = clockSvc?.state;
      if (!s) {
        return {
          timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
          stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
        };
      }
      return {
        timer: { ...s.timer },
        stopwatch: {
          ...s.stopwatch,
          laps: Array.isArray(s.stopwatch?.laps) ? s.stopwatch.laps.slice() : [],
        },
      };
    }

    // Reuse one context.
    let _actx = null;
    function getAudioContext() {
      if (!_actx || _actx.state === 'closed') {
        _actx = new (window.AudioContext || window.webkitAudioContext)();
      }
      return _actx;
    }

    // Lets us cancel the queued tones.
    function beep(freq, dur) {
      const ids = [];
      function _beep(f, d, delayMs) {
        const id = setTimeout(() => {
          try {
            const actx = getAudioContext();
            const osc = actx.createOscillator();
            const gn = actx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f || 880;
            gn.gain.setValueAtTime(0.3, actx.currentTime);
            gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (d || 1.2));
            osc.connect(gn);
            gn.connect(actx.destination);
            osc.start();
            osc.stop(actx.currentTime + (d || 1.2));
          } catch {}
        }, delayMs);
        ids.push(id);
      }
      _beep(freq, dur, 0);
      _beep(1047, 0.8, 400);
      _beep(1319, 1.2, 800);
      return () => ids.forEach(clearTimeout);
    }

    // Keep cleanup around for teardown.
    let _cancelBeep = null;
    function fireAlarmBeep() {
      _cancelBeep?.();
      _cancelBeep = beep(880, 0.8);
    }

    const root = createEl('div', { className: 'nbc-root' });
    content.appendChild(root);

    const TABS = ['alarm', 'clock', 'timer', 'stopwatch'];
    const LABELS = { alarm: 'Alarm', clock: 'Clock', timer: 'Timer', stopwatch: 'Stopwatch' };
    let activeTab = 'clock';

    const tabBar = createEl('div', { className: 'nbc-tabbar' });
    const body = createEl('div', { className: 'nbc-body' });
    root.append(tabBar, body);

    const clockSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding:28px 16px 16px;' });
    const alarmSec = createEl('div', { className: 'nbc-section' });
    const timerSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;justify-content:center;padding:20px;gap:18px;' });
    const swSec    = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding-top:28px;' });

    const sections = { clock: clockSec, alarm: alarmSec, timer: timerSec, stopwatch: swSec };
    body.append(clockSec, alarmSec, timerSec, swSec);

    const tabEls = {};
    TABS.forEach(t => {
      const el = createEl('button', { className: 'nbc-tab', textContent: LABELS[t] });
      el.addEventListener('click', () => switchTab(t));
      tabBar.appendChild(el);
      tabEls[t] = el;
    });

    function switchTab(t) {
      activeTab = t;
      for (const id of TABS) {
        sections[id].classList.toggle('active', id === t);
        tabEls[id].classList.toggle('active', id === t);
      }
    }
    switchTab(activeTab);


    const NS_SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS_SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'nbc-clock-face');

    const tickMarkup = Array.from({ length: 60 }, (_, i) => {
      const angle = (i * 6 - 90) * Math.PI / 180;
      const major = i % 5 === 0;
      const r1 = major ? 76 : 83;
      const r2 = 91;
      const x1 = (100 + r1 * Math.cos(angle)).toFixed(3);
      const y1 = (100 + r1 * Math.sin(angle)).toFixed(3);
      const x2 = (100 + r2 * Math.cos(angle)).toFixed(3);
      const y2 = (100 + r2 * Math.sin(angle)).toFixed(3);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--text-muted)" stroke-width="${major ? 2 : 1}" opacity="${major ? 0.9 : 0.35}"/>`;
    }).join('');

    svg.innerHTML =
      '<circle cx="100" cy="100" r="96" fill="none" stroke="var(--border-subtle)" stroke-width="1.5"/>' +
      '<circle cx="100" cy="100" r="95" fill="var(--bg-elevated)"/>' +
      tickMarkup +
      '<line id="nbc-hr" x1="100" y1="100" x2="100" y2="47" stroke="var(--text-primary)" stroke-width="5.5" stroke-linecap="round"/>' +
      '<line id="nbc-mn" x1="100" y1="100" x2="100" y2="24" stroke="var(--text-primary)" stroke-width="3" stroke-linecap="round"/>' +
      '<line id="nbc-sc" x1="100" y1="114" x2="100" y2="18" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="100" cy="100" r="5" fill="var(--accent)"/>' +
      '<circle cx="100" cy="100" r="2" fill="var(--bg-elevated)"/>';

    // Hand refs live once; no need to query again.
    const hrHand = svg.querySelector('#nbc-hr');
    const mnHand = svg.querySelector('#nbc-mn');
    const scHand = svg.querySelector('#nbc-sc');

    const digitalEl = createEl('div', { className: 'nbc-digital' });
    const dateEl    = createEl('div', { className: 'nbc-date' });
    clockSec.append(svg, digitalEl, dateEl);

    let _lastClockSec = -1;
    let _lastAlarmMinute = '';

    function tickClock() {
      const now = new Date();
      const sec = now.getSeconds();
      const ms  = now.getMilliseconds();

      const h = (now.getHours() % 12) + now.getMinutes() / 60 + sec / 3600;
      const m = now.getMinutes() + sec / 60;
      const s = sec + ms / 1000;
      hrHand.setAttribute('transform', `rotate(${(h * 30).toFixed(2)} 100 100)`);
      mnHand.setAttribute('transform', `rotate(${(m * 6).toFixed(2)} 100 100)`);
      scHand.setAttribute('transform', `rotate(${(s * 6).toFixed(2)} 100 100)`);

      if (sec !== _lastClockSec) {
        _lastClockSec = sec;
        digitalEl.textContent = now.toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        dateEl.textContent = now.toLocaleDateString([], {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        });

        if (sec === 0 && ms < 300) {
          const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
          if (timeStr !== _lastAlarmMinute) {
            _lastAlarmMinute = timeStr;
            const dow = now.getDay();
            let didDisable = false;
            for (const al of db.alarms) {
              if (!al.enabled || al.time !== timeStr) continue;
              if (al.days.length > 0 && !al.days.includes(dow)) continue;
              fireAlarmBeep();
              if (al.days.length === 0) { al.enabled = false; didDisable = true; }
            }
            if (didDisable) { saveDb(); renderAlarms(); }
          }
        }
      }
    }

    const clockInt = setInterval(tickClock, 250);
    state.cleanups?.push(() => clearInterval(clockInt));
    tickClock();


    const alarmHdr = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;',
    });
    alarmHdr.appendChild(createEl('div', { textContent: 'Alarms', style: 'font-size:15px;font-weight:700;' }));

    const addAlarmBtn = createEl('button', { className: 'btn btn-sm btn-primary', style: 'display:flex;align-items:center;gap:4px;' });
    addAlarmBtn.innerHTML = svgIcon('plus', 13) + ' Add';
    alarmHdr.appendChild(addAlarmBtn);
    alarmSec.appendChild(alarmHdr);

    const alarmList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
    alarmSec.appendChild(alarmList);

    const DOW      = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const DOW_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Simple id counter for toggle inputs.
    let _toggleIdCounter = 0;

    function makeToggle(checked, onChange) {
      const uid = `nbc-tog-${++_toggleIdCounter}`;
      const wrap = createEl('label', { className: 'nbc-toggle', htmlFor: uid });
      const inp = createEl('input');
      inp.type = 'checkbox';
      inp.id = uid;
      inp.name = uid;
      inp.checked = checked;
      inp.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
      const track = createEl('div', {
        className: 'nbc-track',
        style: `background:${checked ? 'var(--accent)' : 'var(--border-default)'};`,
      });
      const thumb = createEl('div', {
        className: 'nbc-thumb',
        style: `left:${checked ? '23' : '3'}px;`,
      });
      inp.addEventListener('change', () => {
        const v = inp.checked;
        track.style.background = v ? 'var(--accent)' : 'var(--border-default)';
        thumb.style.left = v ? '23px' : '3px';
        onChange(v);
      });
      wrap.append(inp, track, thumb);
      return wrap;
    }

    function renderAlarms() {
      alarmList.innerHTML = '';

      const sorted = db.alarms
        .map((al, idx) => ({ idx, al: sanitiseAlarm(al) }))
        .filter(({ al }) => TIME_RE.test(al.time))
        .sort((a, b) => a.al.time.localeCompare(b.al.time));

      if (!sorted.length) {
        alarmList.appendChild(createEl('div', {
          textContent: 'No alarms set. Tap + Add to create one.',
          style: 'padding:40px 20px;text-align:center;color:var(--text-muted);font-size:13px;',
        }));
        return;
      }

      const frag = document.createDocumentFragment();
      for (const { idx, al } of sorted) {
        const [hhS, mmS] = al.time.split(':');
        const hh = +hhS, mm = +mmS;
        const ampm = hh < 12 ? 'AM' : 'PM';
        const h12  = hh % 12 || 12;

        const row  = createEl('div', { className: 'nbc-alarm-row' });
        const left = createEl('div', { style: 'flex:1;cursor:pointer;' });
        left.addEventListener('click', () => openAlarmModal(idx));

        const timeRow = createEl('div', { style: 'display:flex;align-items:baseline;gap:5px;' });
        const timeEl  = createEl('div', { className: 'nbc-alarm-time', textContent: `${h12}:${pad(mm)}` });
        timeEl.style.color = al.enabled ? 'var(--text-primary)' : 'var(--text-muted)';
        const ampmEl = createEl('div', { className: 'nbc-alarm-ampm', textContent: ampm });
        timeRow.append(timeEl, ampmEl);

        const meta = createEl('div', { className: 'nbc-alarm-meta' });
        const parts = [];
        if (al.label) parts.push(al.label);
        if (al.days.length === 0) parts.push('Once');
        else if (al.days.length === 7) parts.push('Every day');
        else if (al.days.length === 5 && !al.days.includes(0) && !al.days.includes(6)) parts.push('Weekdays');
        else parts.push(al.days.map(d => DOW[d]).join(' '));
        meta.textContent = parts.join(' · ');

        left.append(timeRow, meta);

        const toggle = makeToggle(al.enabled, v => {
          db.alarms[idx].enabled = v;
          saveDb();
          renderAlarms();
        });

        row.append(left, toggle);
        frag.appendChild(row);
      }
      alarmList.appendChild(frag);
    }

    // Track the open modal for teardown.
    let _activeModal = null;

    function openAlarmModal(idx) {
      _activeModal?.remove();

      const isEdit = idx !== null && idx >= 0 && idx < db.alarms.length;
      const src = isEdit
        ? db.alarms[idx]
        : { time: '07:00', label: '', days: [1, 2, 3, 4, 5], enabled: true };
      const al = { ...src, days: [...src.days] };

      const ov = createEl('div', {
        style: 'position:absolute;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;',
      });

      function closeModal() {
        ov.remove();
        _activeModal = null;
      }

      const box = createEl('div', {
        style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:16px;padding:22px;width:320px;max-width:95%;box-shadow:0 24px 48px rgba(0,0,0,0.4);',
      });

      const hdr = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;' });
      hdr.appendChild(createEl('span', { textContent: isEdit ? 'Edit Alarm' : 'Add Alarm', style: 'font-size:15px;font-weight:700;' }));
      const xBtn = createEl('button', { className: 'btn btn-icon btn-sm' });
      xBtn.innerHTML = svgIcon('x', 14);
      xBtn.addEventListener('click', closeModal);
      hdr.appendChild(xBtn);
      box.appendChild(hdr);

      const timeInp = createEl('input', {
        type: 'time',
        className: 'input',
        id: `alarm-time-${Date.now()}`,
        name: 'alarm-time',
        style: 'width:100%;font-size:30px;font-weight:200;height:54px;text-align:center;margin-bottom:14px;letter-spacing:2px;font-variant-numeric:tabular-nums;',
      });
      timeInp.value = al.time;
      box.appendChild(timeInp);

      const labelInp = createEl('input', {
        type: 'text',
        className: 'input',
        id: `alarm-label-${Date.now()}`,
        name: 'alarm-label',
        placeholder: 'Label (optional)',
        style: 'width:100%;margin-bottom:14px;',
      });
      labelInp.value = al.label;
      box.appendChild(labelInp);

      box.appendChild(createEl('div', {
        textContent: 'Repeat',
        style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;',
      }));

      const daysRow = createEl('div', { style: 'display:flex;gap:5px;margin-bottom:18px;' });
      const dayBtns = DOW_FULL.map((d, i) => {
        const on = al.days.includes(i);
        const btn = createEl('button', {
          title: d,
          style: `flex:1;padding:7px 0;border-radius:50%;font-size:11px;font-weight:700;cursor:pointer;border:1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#fff' : 'var(--text-muted)'};aspect-ratio:1;transition:all 0.12s;`,
        });
        btn.textContent = d.charAt(0);
        btn.dataset.i  = i;
        btn.dataset.on = on ? '1' : '0';
        btn.addEventListener('click', () => {
          const isOn = btn.dataset.on === '1';
          btn.dataset.on    = isOn ? '0' : '1';
          btn.style.background   = isOn ? 'transparent' : 'var(--accent)';
          btn.style.color        = isOn ? 'var(--text-muted)' : '#fff';
          btn.style.borderColor  = isOn ? 'var(--border-subtle)' : 'var(--accent)';
        });
        daysRow.appendChild(btn);
        return btn;
      });
      box.appendChild(daysRow);

      const acts = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });

      if (isEdit) {
        const delBtn = createEl('button', { textContent: 'Delete', className: 'btn btn-sm', style: 'color:#f85149;border-color:#f85149;' });
        delBtn.addEventListener('click', () => {
          db.alarms.splice(idx, 1);
          saveDb();
          renderAlarms();
          closeModal();
        });
        acts.appendChild(delBtn);
      } else {
        acts.appendChild(createEl('div'));
      }

      const rightActs  = createEl('div', { style: 'display:flex;gap:8px;' });
      const cancelBtn  = createEl('button', { textContent: 'Cancel', className: 'btn btn-sm' });
      cancelBtn.addEventListener('click', closeModal);

      const saveBtn = createEl('button', { textContent: 'Save', className: 'btn btn-sm btn-primary' });
      saveBtn.addEventListener('click', () => {
        const t = timeInp.value;
        if (!t || !TIME_RE.test(t)) return;
        const selDays = dayBtns.filter(b => b.dataset.on === '1').map(b => +b.dataset.i);
        const payload = { time: t, label: labelInp.value.trim().slice(0, 64), days: selDays, enabled: true };
        if (isEdit) {
          Object.assign(db.alarms[idx], payload);
        } else {
          db.alarms.push({ id: Date.now().toString(36), ...payload });
        }
        saveDb();
        renderAlarms();
        closeModal();
      });

      ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });

      rightActs.append(cancelBtn, saveBtn);
      acts.appendChild(rightActs);
      box.appendChild(acts);
      ov.appendChild(box);
      content.appendChild(ov);
      _activeModal = ov;

      requestAnimationFrame(() => timeInp.focus());
    }

    addAlarmBtn.addEventListener('click', () => openAlarmModal(null));
    renderAlarms();


    let tiMs = 0, tiSet = 0, tiRun = false, tiDone = false;

    const tiDisplay = createEl('div', { className: 'nbc-timer-display', textContent: '00:00' });

    const tiInpRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });

    function tiInp(max) {
      const el = createEl('input', {
        type: 'number',
        min: '0',
        max: String(max),
        className: 'nbc-timer-inp',
        placeholder: '0',
      });
      el.addEventListener('input', () => {
        let v = parseInt(el.value, 10) || 0;
        if (v > max) { v = max; el.value = max; }
        syncTiFromInputs();
      });
      return el;
    }

    const tiH = tiInp(99), tiM = tiInp(59), tiS = tiInp(59);
    const mkColon = () => createEl('span', { textContent: ':', style: 'font-size:30px;font-weight:200;color:var(--text-muted);' });
    const mkLbl   = t  => createEl('div',  { textContent: t, style: 'font-size:10px;color:var(--text-muted);text-align:center;' });

    function col(inp, lbl) {
      const c = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:3px;' });
      c.append(inp, mkLbl(lbl));
      return c;
    }
    tiInpRow.append(col(tiH, 'h'), mkColon(), col(tiM, 'm'), mkColon(), col(tiS, 's'));

    function syncTiFromInputs() {
      tiSet = tiMs = (
        (parseInt(tiH.value, 10) || 0) * 3600 +
        (parseInt(tiM.value, 10) || 0) * 60  +
        (parseInt(tiS.value, 10) || 0)
      ) * 1000;
      clockSvc?.setTimerPreset?.(tiSet);
      clockSvc?.persist?.();
      renderTiDisplay();
    }

    function renderTiDisplay() {
      const st = syncClockState();
      tiRun  = !!st.timer.running;
      tiDone = !!st.timer.done;
      tiSet  = Math.max(0, Number(st.timer.presetMs) || 0);
      tiMs   = tiRun
        ? Math.max(0, Number(st.timer.endAt) - Date.now())
        : Math.max(0, Number(st.timer.remainingMs) || tiSet || 0);
      const h = Math.floor(tiMs / 3600000);
      const m = Math.floor((tiMs % 3600000) / 60000);
      const s = Math.floor((tiMs % 60000) / 1000);
      tiDisplay.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      tiDisplay.style.color = tiDone ? 'var(--accent)' : 'var(--text-primary)';
    }

    const tiBtnRow = createEl('div', { style: 'display:flex;gap:10px;' });
    const tiStart  = createEl('button', { className: 'nbc-pill-btn primary', textContent: 'Start' });
    const tiReset  = createEl('button', { className: 'nbc-pill-btn', textContent: 'Reset', style: 'display:none;' });
    tiBtnRow.append(tiReset, tiStart);

    function renderTiBtns() {
      tiStart.textContent       = tiRun ? 'Pause' : tiDone ? 'Restart' : 'Start';
      tiReset.style.display     = (tiMs !== tiSet || tiDone) ? 'block' : 'none';
    }

    tiStart.addEventListener('click', () => {
      const st = syncClockState();
      if (!st.timer.presetMs && !st.timer.remainingMs && !tiSet) return;
      if (st.timer.running) {
        clockSvc?.pauseTimer?.();
      } else if (st.timer.done) {
        clockSvc?.restartTimer?.();
      } else {
        clockSvc?.startTimer?.(st.timer.remainingMs || tiSet || 0);
      }
      renderTiDisplay();
      renderTiBtns();
    });

    tiReset.addEventListener('click', () => {
      clockSvc?.resetTimer?.();
      const st = syncClockState();
      tiRun  = false;
      tiDone = false;
      tiMs   = Math.max(0, Number(st.timer.remainingMs) || st.timer.presetMs || 0);
      tiH.value = tiSet ? String(Math.floor(tiSet / 3600000))             || '' : '';
      tiM.value = tiSet ? String(Math.floor((tiSet % 3600000) / 60000))        : '';
      tiS.value = tiSet ? String(Math.floor((tiSet % 60000) / 1000))           : '';
      renderTiDisplay();
      renderTiBtns();
    });

    timerSec.append(tiDisplay, tiInpRow, tiBtnRow);
    renderTiDisplay();
    renderTiBtns();


    let swRun = false, swElapsed = 0, swStart = 0, swLaps = [];

    function swSync() {
      const st = syncClockState();
      swRun     = !!st.stopwatch.running;
      swElapsed = Math.max(0, Number(st.stopwatch.elapsedMs) || 0);
      swStart   = Math.max(0, Number(st.stopwatch.startedAt) || 0);
      swLaps    = Array.isArray(st.stopwatch.laps) ? st.stopwatch.laps.slice() : [];
    }

    function swCurrentMs() {
      return swRun ? swElapsed + (Date.now() - swStart) : swElapsed;
    }

    const swDisplay = createEl('div', { className: 'nbc-sw-display', textContent: '00:00.00' });

    const swBtnRow  = createEl('div', { style: 'display:flex;gap:12px;margin-top:16px;margin-bottom:16px;' });
    const swStartBtn = createEl('button', { textContent: 'Start', className: 'nbc-pill-btn primary' });
    const swLapBtn   = createEl('button', { textContent: 'Lap',   className: 'nbc-pill-btn', style: 'min-width:82px;' });
    swBtnRow.append(swLapBtn, swStartBtn);

    const swLapHdr = createEl('div', { style: 'display:flex;justify-content:space-between;padding:6px 16px;border-bottom:1px solid var(--border-subtle);' });
    const mkHdrCell = t => createEl('span', { textContent: t, style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;' });
    swLapHdr.append(mkHdrCell('Lap'), mkHdrCell('Split'), mkHdrCell('Overall'));

    const swLapScroll = createEl('div', { style: 'flex:1;overflow-y:auto;width:100%;' });
    swSec.append(swDisplay, swBtnRow, swLapHdr, swLapScroll);

    function fmtSw(ms) {
      const m  = Math.floor(ms / 60000);
      const s  = Math.floor((ms % 60000) / 1000);
      const cs = Math.floor((ms % 1000) / 10);
      return `${pad(m)}:${pad(s)}.${pad(cs)}`;
    }

    // Smooth stopwatch redraw. Elapsed time is derived from Date.now() so there
    // is no drift — we just repaint the centiseconds each animation frame
    // instead of every 250ms (which made the display visibly stutter).
    let swRafId = null;
    function swStopRaf() {
      if (swRafId !== null) { cancelAnimationFrame(swRafId); swRafId = null; }
    }
    function swEnsureRaf() {
      if (swRafId !== null || !swRun) return;
      const loop = () => {
        if (!swRun) { swRafId = null; return; }
        swDisplay.textContent = fmtSw(swCurrentMs());
        swRafId = requestAnimationFrame(loop);
      };
      swRafId = requestAnimationFrame(loop);
    }

    function renderSwLaps() {
      if (!swLaps.length) { swLapScroll.innerHTML = ''; return; }

      const splits     = swLaps.map((v, i) => v - (i > 0 ? swLaps[i - 1] : 0));
      const bestSplit  = Math.min(...splits);
      const worstSplit = Math.max(...splits);
      const frag       = document.createDocumentFragment();

      for (let ri = swLaps.length - 1; ri >= 0; ri--) {
        const split = splits[ri];
        const row   = createEl('div', { className: 'nbc-lap-row' });

        const lapLabel  = createEl('span', { textContent: `Lap ${ri + 1}`, style: 'color:var(--text-secondary);' });
        const splitEl   = createEl('span', { textContent: fmtSw(split) });
        if (swLaps.length > 1) {
          if (split === bestSplit)  splitEl.className = 'nbc-lap-best';
          else if (split === worstSplit) splitEl.className = 'nbc-lap-worst';
        }
        const overallEl = createEl('span', { textContent: fmtSw(swLaps[ri]), style: 'color:var(--text-muted);font-size:12px;' });

        row.append(lapLabel, splitEl, overallEl);
        frag.appendChild(row);
      }

      swLapScroll.innerHTML = '';
      swLapScroll.appendChild(frag);
    }

    swStartBtn.addEventListener('click', () => {
      const st = syncClockState();
      if (st.stopwatch.running) {
        clockSvc?.pauseStopwatch?.();
      } else {
        clockSvc?.startStopwatch?.();
      }
      swSync();
      swStartBtn.textContent = swRun ? 'Stop'  : 'Start';
      swLapBtn.textContent   = swRun ? 'Lap'   : 'Reset';
      if (swRun) {
        swEnsureRaf();
      } else {
        swStopRaf();
        swDisplay.textContent = fmtSw(swCurrentMs());
      }
    });

    swLapBtn.addEventListener('click', () => {
      const st = syncClockState();
      if (st.stopwatch.running) {
        clockSvc?.lapStopwatch?.();
        swSync();
        renderSwLaps();
      } else {
        clockSvc?.resetStopwatch?.();
        swStopRaf();
        swRun = false; swElapsed = 0; swStart = 0; swLaps = [];
        swLapScroll.innerHTML = '';
        swDisplay.textContent = '00:00.00';
        swStartBtn.textContent = 'Start';
        swLapBtn.textContent   = 'Lap';
      }
    });

    const mainInt = setInterval(() => {
      const st = syncClockState();

      tiRun  = !!st.timer.running;
      tiDone = !!st.timer.done;
      tiSet  = Math.max(0, Number(st.timer.presetMs) || 0);
      tiMs   = clockSvc?.timerMs?.()
        ?? (tiRun
          ? Math.max(0, Number(st.timer.endAt) - Date.now())
          : Math.max(0, Number(st.timer.remainingMs) || 0));

      if (tiRun || tiDone) {
        renderTiDisplay();
        renderTiBtns();
      }

      const swWasRun = swRun;
      swRun     = !!st.stopwatch.running;
      swElapsed = Math.max(0, Number(st.stopwatch.elapsedMs) || 0);
      swStart   = Math.max(0, Number(st.stopwatch.startedAt) || 0);
      if (Array.isArray(st.stopwatch.laps)) swLaps = st.stopwatch.laps.slice();

      if (swRun) {
        // Smooth redraw is driven by rAF; here we just make sure it's running
        // (e.g. when the stopwatch was started from elsewhere) and keep the
        // Start/Lap button labels accurate.
        swEnsureRaf();
        swStartBtn.textContent = 'Stop';
        swLapBtn.textContent   = 'Lap';
      } else if (swWasRun) {
        // Just stopped/paused elsewhere: final paint + cancel the loop.
        swStopRaf();
        swDisplay.textContent = fmtSw(swCurrentMs());
        swStartBtn.textContent = 'Start';
        swLapBtn.textContent   = 'Reset';
      }
    }, 250);

    state.cleanups?.push(() => {
      clearInterval(mainInt);
      clearInterval(clockInt);
      swStopRaf();
      _cancelBeep?.();
      _activeModal?.remove();
      _activeModal = null;
      if (_actx && _actx.state !== 'closed') _actx.close();
    });

    clockSvc?.ensureBooted?.();
    renderTiDisplay();
    renderTiBtns();
    swSync();
    swDisplay.textContent = fmtSw(swCurrentMs());
    renderSwLaps();
    switchTab('clock');
  },
});
