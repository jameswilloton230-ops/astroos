'use strict';

/**
 * com.astroos.setup — AstroOS Setup, the first-boot wizard (AOSP-style).
 *
 * The whole first-run experience lives in this .novaapp instead of being
 * hardcoded into the lock screen: the lock screen only DETECTS "this
 * machine has no accounts" and launches this app full-screen. Everything
 * a person does on a fresh machine — keyboard layout, network,
 * date and region, data & privacy,
 * the owner account, appearance — is a step here, so developers can add,
 * reorder or replace steps without touching core boot code.
 *
 * It runs in the trusted host (unrestrictedEntry) because account
 * creation is a trusted verb: the wizard calls SessionManager.setupOwner
 * directly, the same call the lock screen's inline wizard used to make.
 * After the owner exists the account mount sequence runs; preferences
 * collected along the way (keyboard layout, guest access, theme, accent)
 * are applied once the owner's hive is the mounted settings store.
 *
 * Launching it later (from the App Manager, after setup is done) shows a
 * completed-state screen instead of the wizard — setup is a one-way door.
 *
 * Steps (bare bones, AOSP-like):
 *   1. Welcome        — keyboard-layout picker, Start
 *   2. Network        — connectivity check, skippable
 *   3. Date and Region — timezone and locale
 *   4. Data & privacy — per-account storage notice and guest access
 *   5. Owner account  — display name, username, PIN, passphrase
 *   6. Appearance     — theme + accent
 *   7. All set        — apply + finish
 */

const SETUP_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSIzOCIgZmlsbD0iIzkzYzVmZCIvPjxjaXJjbGUgY3g9IjQ4IiBjeT0iNDgiIHI9IjMwIiBmaWxsPSIjMjU2M2ViIi8+PHBhdGggZD0iTTQwIDM2IEw0OCA1MCA1NiAzNiIgc3Ryb2tlPSIjZmRlNjhhIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxyZWN0IHg9IjM2IiB5PSI1NiIgd2lkdGg9IjI0IiBoZWlnaHQ9IjUiIHJ4PSIyLjUiIGZpbGw9IiNmZGU2OGEiLz48L3N2Zz4=';

registerApp({
  id: 'com.astroos.setup',
  name: 'AstroOS Setup',
  version: '3.0.2',
  icon: SETUP_ICON,
  description: 'First-boot setup wizard: keyboard layout, date and region, owner account, and appearance.',
  category: 'system',
  permissions: [],
  defaultSize: [920, 640],
  minSize: [560, 420],
  resizable: true,
  transparent: false,

  async init(content, state, options) {
    const ac = new AbortController();
    state.cleanups?.push(() => ac.abort());
    void options;

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,system-ui,sans-serif);overflow:hidden;';

    const css = document.createElement('style');
    css.textContent = `
      .nvsetup-root { display:flex;flex-direction:column;height:100%;overflow:hidden; }
      .nvsetup-top { flex-shrink:0;padding:22px 34px 12px;display:flex;align-items:center;justify-content:space-between; }
      .nvsetup-brand { display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;color:var(--text-secondary); }
      .nvsetup-brand .nvsetup-logo { width:22px;height:22px; }
      .nvsetup-progress { display:flex;gap:6px;align-items:center; }
      .nvsetup-dot { width:8px;height:8px;border-radius:50%;background:var(--bg-overlay);border:1px solid var(--border-default);transition:background .2s; }
      .nvsetup-dot.on { background:var(--accent);border-color:var(--accent); }
      .nvsetup-body { flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 40px 28px; }
      .nvsetup-card { width:min(560px,100%);display:flex;flex-direction:column;gap:14px; }
      .nvsetup-title { font-size:24px;font-weight:600;margin:0;text-align:center; }
      .nvsetup-sub { font-size:13px;color:var(--text-muted);text-align:center;line-height:1.5;margin:-4px 0 4px; }
      .nvsetup-label { display:block;font-size:12px;color:var(--text-secondary,var(--text-muted));line-height:1.35;margin:0 0 6px; }
      .nvsetup-input { padding:11px 14px;border-radius:10px;border:1px solid var(--border-default);background:var(--bg-overlay);color:var(--text-primary);font-size:14px;outline:none;width:100%;box-sizing:border-box; }
      .nvsetup-input:focus { border-color:var(--accent); }
      .nvsetup-input.bad { border-color:var(--text-danger); }
      .nvsetup-grid2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
      .nvsetup-row { display:flex;align-items:center;gap:10px;padding:11px 14px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-overlay);font-size:13px;cursor:pointer; }
      .nvsetup-row .nvsetup-row-text { flex:1; }
      .nvsetup-row b { font-weight:600;display:block; }
      .nvsetup-row small { color:var(--text-muted); }
      .nvsetup-theme-options .nvsetup-row[aria-pressed="true"] { border-color:var(--accent);background:var(--accent-muted);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent); }
      .nvsetup-theme-options .nvsetup-row[aria-pressed="true"]::after { content:'✓';font-size:15px;font-weight:700; }
      .nvsetup-switch { width:38px;height:20px;border-radius:999px;background:var(--bg-overlay);border:1px solid var(--border-default);position:relative;flex-shrink:0;transition:background .2s; }
      .nvsetup-switch::after { content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--text-muted);transition:transform .2s,background .2s; }
      .nvsetup-row[aria-pressed="true"] .nvsetup-switch { background:var(--accent-muted);border-color:var(--accent); }
      .nvsetup-row[aria-pressed="true"] .nvsetup-switch::after { transform:translateX(18px);background:var(--accent); }
      .nvsetup-layout { width:100%; }
      .nvsetup-status { min-height:18px;font-size:12px;color:var(--text-danger);text-align:center; }
      .nvsetup-status.ok { color:var(--text-success); }
      .nvsetup-neticon { font-size:34px;text-align:center;margin:0; }
      .nvsetup-note { font-size:12px;color:var(--text-muted);line-height:1.55;background:var(--bg-overlay);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px; }
      .nvsetup-note b { color:var(--text-secondary); }
      .nvsetup-bottom { flex-shrink:0;display:flex;justify-content:space-between;gap:10px;padding:16px 34px 22px;border-top:1px solid var(--border-subtle); }
      .nvsetup-btn { padding:10px 22px;border-radius:10px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);font-size:13px;cursor:pointer; }
      .nvsetup-btn.ghost { background:transparent;border-color:transparent;color:var(--text-muted); }
      .nvsetup-btn.primary { border-color:var(--accent);background:var(--accent);color:var(--text-primary);font-weight:600; }
      .nvsetup-btn.primary:disabled { opacity:.5;cursor:default; }
      .nvsetup-swatches { display:flex;gap:10px;justify-content:center;flex-wrap:wrap; }
      .nvsetup-swatch { width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer; }
      .nvsetup-swatch.on { border-color:var(--text-primary);transform:scale(1.1); }
      .nvsetup-center { text-align:center; }
      .nvsetup-big { font-size:44px;margin:8px 0; }
      .nvsetup-done { width:min(430px,100%);display:flex;flex-direction:column;gap:12px;align-items:center; }
    `;
    content.appendChild(css);

    const root = createEl('div', { className: 'nvsetup-root' });
    content.appendChild(root);

    // ── Shared helpers ────────────────────────────────────────────────────
    const manager = (typeof SessionManager !== 'undefined') ? SessionManager : null;
    const multiUser = typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.();

    const pending = {
      keyboardLayout: 'us',
      networkSkipped: false,
      guestAccess: true,
      displayName: '',
      username: '',
      pin: '',
      passphrase: '',
      theme: 'nova-dark',
      accent: '#93c5fd',
      region: OS.settings.get('region') || navigator.language || 'en-US',
      timezone: OS.settings.get('timezone') ||
        ((typeof Intl !== 'undefined' && Intl.DateTimeFormat)
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          : 'UTC'),
    };

    const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
    const THEMES = [
      { id: 'nova-dark', label: 'Nova Dark' },
      { id: 'nova-light', label: 'Nova Light' },
      { id: 'nord', label: 'Nord' },
      { id: 'dracula', label: 'Dracula' },
      { id: 'catppuccin', label: 'Catppuccin' },
      { id: 'tokyo-night', label: 'Tokyo Night' },
      { id: 'gruvbox', label: 'Gruvbox' },
    ];
    const ACCENTS = ['#93c5fd', '#2563eb', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];
    const KEYBOARD_LAYOUTS = [
      { code: 'us', label: 'English (US)' },
      { code: 'gb', label: 'English (UK)' },
      { code: 'ca', label: 'English (Canada)' },
      { code: 'au', label: 'English (Australia)' },
      { code: 'de', label: 'German' },
      { code: 'fr', label: 'French' },
      { code: 'be', label: 'Belgian' },
      { code: 'es', label: 'Spanish' },
      { code: 'it', label: 'Italian' },
      { code: 'pt', label: 'Portuguese' },
      { code: 'br', label: 'Portuguese (Brazil)' },
      { code: 'nl', label: 'Dutch' },
      { code: 'se', label: 'Swedish' },
      { code: 'no', label: 'Norwegian' },
      { code: 'dk', label: 'Danish' },
      { code: 'fi', label: 'Finnish' },
      { code: 'pl', label: 'Polish' },
      { code: 'tr', label: 'Turkish' },
      { code: 'ru', label: 'Russian' },
      { code: 'ua', label: 'Ukrainian' },
      { code: 'jp', label: 'Japanese' },
    ];
    const REGIONS = [
      ['en-US', 'United States (English)'], ['en-GB', 'United Kingdom (English)'],
      ['en-CA', 'Canada (English)'], ['fr-CA', 'Canada (French)'],
      ['en-AU', 'Australia (English)'], ['de-DE', 'Germany (German)'],
      ['fr-FR', 'France (French)'], ['es-ES', 'Spain (Spanish)'],
      ['es-MX', 'Mexico (Spanish)'], ['pt-BR', 'Brazil (Portuguese)'],
      ['pt-PT', 'Portugal (Portuguese)'], ['it-IT', 'Italy (Italian)'],
      ['nl-NL', 'Netherlands (Dutch)'], ['sv-SE', 'Sweden (Swedish)'],
      ['ja-JP', 'Japan (Japanese)'], ['zh-CN', 'China (Chinese)'],
      ['zh-TW', 'Taiwan (Chinese)'], ['hi-IN', 'India (Hindi)'],
      ['ar-SA', 'Saudi Arabia (Arabic)'], ['ko-KR', 'South Korea (Korean)'],
    ];
    const TIMEZONES = (() => {
      let supported = [];
      try {
        if (typeof Intl.supportedValuesOf === 'function') supported = Intl.supportedValuesOf('timeZone');
      } catch (_) { /* use the detected zone when timezone enumeration is unavailable */ }
      const common = [
        'Africa/Cairo', 'Africa/Johannesburg', 'America/Los_Angeles',
        'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai',
        'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
        'Europe/Berlin', 'Europe/London', 'Europe/Paris',
      ];
      return [...new Set(['UTC', pending.timezone, ...common, ...supported])].filter(Boolean).sort();
    })();

    // ── Step chrome ──────────────────────────────────────────────────────
    let step = 0;
    const LAST_STEP = 6;

    const top = createEl('div', { className: 'nvsetup-top' });
    const brand = createEl('div', { className: 'nvsetup-brand' });
    const logo = createEl('span', { className: 'nvsetup-logo', 'aria-hidden': 'true' });
    logo.innerHTML = svgIcon(SETUP_ICON, 22);
    brand.append(logo, createEl('span', { textContent: 'AstroOS Setup' }));
    const dots = createEl('div', { className: 'nvsetup-progress', role: 'progressbar', 'aria-label': 'Setup progress' });
    for (let i = 0; i <= LAST_STEP; i++) {
      dots.appendChild(createEl('div', { className: 'nvsetup-dot' }));
    }
    top.append(brand, dots);
    root.appendChild(top);

    const body = createEl('div', { className: 'nvsetup-body' });
    root.appendChild(body);

    const bottom = createEl('div', { className: 'nvsetup-bottom' });
    const backBtn = createEl('button', { className: 'nvsetup-btn ghost', textContent: 'Back', 'aria-label': 'Previous step' });
    const skipBtn = createEl('button', { className: 'nvsetup-btn ghost', textContent: 'Skip', 'aria-label': 'Skip this step' });
    const nextBtn = createEl('button', { className: 'nvsetup-btn primary', textContent: 'Next', 'aria-label': 'Next step' });
    bottom.append(backBtn, skipBtn, nextBtn);
    root.appendChild(bottom);

    function renderDots() {
      [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i <= step));
    }

    function setButtons({ next = 'Next', nextDisabled = false, skip = false, back = true } = {}) {
      nextBtn.textContent = next;
      nextBtn.disabled = nextDisabled;
      skipBtn.style.visibility = skip ? 'visible' : 'hidden';
      backBtn.style.visibility = back ? 'visible' : 'hidden';
    }

    // ── Step 1: Welcome ───────────────────────────────────────────────────
    function stepWelcome() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'AstroOS' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'Choose your keyboard layout to get started. AstroOS is currently available in English; you can change the keyboard layout later in Settings.' });

      const layoutLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-keyboard-layout', textContent: 'Keyboard layout' });
      const layoutSelect = createEl('select', {
        id: 'nvsetup-keyboard-layout',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': 'Keyboard layout',
      });
      for (const layout of KEYBOARD_LAYOUTS) {
        layoutSelect.appendChild(createEl('option', {
          value: layout.code,
          textContent: layout.label,
        }));
      }
      layoutSelect.value = pending.keyboardLayout;
      layoutSelect.addEventListener('change', () => { pending.keyboardLayout = layoutSelect.value; });

      card.append(title, sub, layoutLabel, layoutSelect);
      body.replaceChildren(card);
      setButtons({ next: 'Start' });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 2: Network ──────────────────────────────────────────────────
    function stepNetwork() {
      const card = createEl('div', { className: 'nvsetup-card nvsetup-center' });
      const icon = createEl('div', { className: 'nvsetup-neticon', textContent: '🌐', 'aria-hidden': 'true' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'Connect to network' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'AstroOS can check for updates and finish faster when connected. You can skip this and set up network later from the tray.' });
      const status = createEl('div', { className: 'nvsetup-status', role: 'status', 'aria-live': 'polite' });

      const refresh = createEl('button', { className: 'nvsetup-btn', textContent: 'Check again', 'aria-label': 'Re-check network status' });
      refresh.addEventListener('click', () => check());

      card.append(icon, title, sub, status, refresh);
      body.replaceChildren(card);
      setButtons({ next: 'Next', skip: true });

      async function check() {
        status.className = 'nvsetup-status';
        status.textContent = 'Checking…';
        const nm = window.AstroOSSystem?.hardware?.network;
        if (nm && typeof nm.getStatus === 'function') {
          try {
            const s = await nm.getStatus();
            if (s?.connectivity === 'full') {
              status.className = 'nvsetup-status ok';
              status.textContent = 'Connected to the internet';
            } else if (s?.connectivity === 'limited' || s?.connectivity === 'portal') {
              status.textContent = 'Connected, but no internet access';
            } else if (/^connected/.test(String(s?.networkState || ''))) {
              status.className = 'nvsetup-status ok';
              status.textContent = 'Connected to a network';
            } else {
              status.textContent = 'Not connected';
            }
            return;
          } catch (_) { /* fall through */ }
        }
        status.textContent = navigator.onLine ? 'Connected to a network' : 'Not connected';
      }
      check();
    }

    // ── Step 3: Date and Region ───────────────────────────────────────────
    function stepDateAndRegion() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'Date and Region' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'Choose the locale used for dates and regional formats, and set your timezone. You can change these later in Settings.' });
      const regionLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-region', textContent: 'Region and format' });
      const regionSelect = createEl('select', {
        id: 'nvsetup-region',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': 'Region and date format',
      });
      const regions = [...REGIONS];
      if (!regions.some(([code]) => code === pending.region)) {
        regions.push([pending.region, pending.region]);
      }
      for (const [code, label] of regions) {
        regionSelect.appendChild(createEl('option', { value: code, textContent: label }));
      }
      regionSelect.value = pending.region;
      regionSelect.addEventListener('change', () => { pending.region = regionSelect.value; });

      const timezoneLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-timezone', textContent: 'Timezone' });
      const timezoneSelect = createEl('select', {
        id: 'nvsetup-timezone',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': 'Timezone',
      });
      for (const timezone of TIMEZONES) {
        timezoneSelect.appendChild(createEl('option', { value: timezone, textContent: timezone }));
      }
      timezoneSelect.value = pending.timezone;
      timezoneSelect.addEventListener('change', () => { pending.timezone = timezoneSelect.value; });

      card.append(title, sub, regionLabel, regionSelect, timezoneLabel, timezoneSelect);
      body.replaceChildren(card);
      setButtons({ next: 'Next' });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 4: Data & privacy ────────────────────────────────────────────
    function stepPrivacy() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'Your data' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'AstroOS is multi-user: every account gets its own filesystem, registry and apps — one account never reads another\u2019s files.' });

      const note = createEl('div', { className: 'nvsetup-note' });
      note.innerHTML = '';
      note.appendChild(createEl('div', { textContent: 'Each account lives under its own directory — users/<username>/ is the account\u2019s filesystem (files, folders, Trash and app data all inside it), users/<username>/registry holds its settings — with a machine-wide Shared drop box in between. The account you create next becomes this machine\u2019s owner (administrator).' }));

      const mkRow = (heading, small, value, key, onToggle) => {
        const row = createEl('button', { className: 'nvsetup-row', type: 'button', 'aria-pressed': String(value) });
        const text = createEl('span', { className: 'nvsetup-row-text' });
        text.append(
          Object.assign(createEl('b'), { textContent: heading }),
          Object.assign(createEl('small'), { textContent: small }),
        );
        const sw = createEl('span', { className: 'nvsetup-switch', 'aria-hidden': 'true' });
        row.append(text, sw);
        row.addEventListener('click', () => {
          const now = row.getAttribute('aria-pressed') !== 'true';
          row.setAttribute('aria-pressed', String(now));
          pending[key] = now;
          onToggle?.(now);
        });
        return row;
      };
      const guestRow = mkRow('Guest access', 'Let people use this machine without an account (ephemeral sessions)', pending.guestAccess, 'guestAccess');

      card.append(title, sub, note, guestRow);
      body.replaceChildren(card);
      setButtons({ next: 'Next' });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 5: Owner account ────────────────────────────────────────────
    function stepAccount() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'Create the owner account' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'This account owns the machine — it manages other accounts, policies and system settings.' });

      const display = createEl('input', { className: 'nvsetup-input', type: 'text', placeholder: 'Ada Nova', autocomplete: 'name', maxLength: 64 });
      const username = createEl('input', { className: 'nvsetup-input', type: 'text', placeholder: 'ada', autocomplete: 'username', maxLength: 32, spellcheck: 'false' });
      const pin = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: '4\u20136 digits', inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autocomplete: 'new-password' });
      const pin2 = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: 'Confirm PIN', inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autocomplete: 'new-password' });
      const pass = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: 'Optional \u2014 8+ characters', autocomplete: 'new-password' });

      const nameRow = createEl('div');
      nameRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: 'Your name' })),
        display,
      );
      const userRow = createEl('div');
      userRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: 'Username \u2014 your storage directory (users/<username>)' })),
        username,
      );
      const credsGrid = createEl('div', { className: 'nvsetup-grid2' });
      const pinBox = createEl('div');
      pinBox.append(Object.assign(createEl('div', { className: 'nvsetup-label', textContent: 'PIN' })), pin);
      const pin2Box = createEl('div');
      pin2Box.append(Object.assign(createEl('div', { className: 'nvsetup-label', textContent: 'Confirm PIN' })), pin2);
      credsGrid.append(pinBox, pin2Box);
      const passRow = createEl('div');
      passRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: 'Passphrase (optional, for recovery-grade sign-in)' })),
        pass,
      );

      const status = createEl('div', { className: 'nvsetup-status', role: 'status', 'aria-live': 'polite' });

      const validate = () => {
        pending.displayName = display.value.trim();
        pending.username = username.value.trim().toLowerCase();
        pending.pin = pin.value;
        pending.passphrase = pass.value;
        let ok = true;
        username.classList.toggle('bad', !!pending.username && !USERNAME_RE.test(pending.username));
        if (!pending.displayName) { ok = false; }
        if (!USERNAME_RE.test(pending.username)) { ok = false; }
        if (!/^\d{4,6}$/.test(pending.pin)) { ok = false; }
        if (pending.pin !== pin2.value) { ok = false; }
        if (pending.passphrase && pending.passphrase.length < 8) { ok = false; }
        nextBtn.disabled = !ok;
        return ok;
      };
      for (const input of [display, username, pin, pin2, pass]) {
        input.addEventListener('input', () => { status.textContent = ''; validate(); });
      }

      card.append(title, sub, nameRow, userRow, credsGrid, passRow, status);
      body.replaceChildren(card);
      setButtons({ next: 'Create account', nextDisabled: true });
      validate();
      display.focus();
    }

    async function createOwner(statusEl) {
      if (!manager || typeof manager.setupOwner !== 'function') {
        statusEl.textContent = 'The session service is unavailable — restart the machine.';
        return false;
      }
      statusEl.textContent = 'Creating your account…';
      const result = await manager.setupOwner({
        displayName: pending.displayName,
        username: pending.username,
        pin: pending.pin,
        passphrase: pending.passphrase || undefined,
        avatar: String(pending.displayName).charAt(0).toUpperCase(),
      });
      if (result.ok) return true;
      statusEl.textContent = result.message || 'Setup failed \u2014 try again.';
      nextBtn.disabled = false;
      return false;
    }

    // ── Step 6: Appearance ────────────────────────────────────────────────
    function stepAppearance() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'Make it yours' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: 'Pick a theme and an accent colour. You can change these any time in Settings \u2192 Appearance.' });

      const themeLabel = createEl('div', { className: 'nvsetup-label', textContent: 'Theme' });
      const themeRows = createEl('div', { className: 'nvsetup-grid2 nvsetup-theme-options' });
      for (const theme of THEMES) {
        const btn = createEl('button', { className: 'nvsetup-row', type: 'button', 'aria-pressed': String(pending.theme === theme.id) });
        const text = createEl('span', { className: 'nvsetup-row-text' });
        text.append(Object.assign(createEl('b'), { textContent: theme.label }));
        btn.appendChild(text);
        btn.addEventListener('click', () => {
          pending.theme = theme.id;
          for (const other of themeRows.children) other.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-pressed', 'true');
        });
        themeRows.appendChild(btn);
      }

      const accentLabel = createEl('div', { className: 'nvsetup-label', textContent: 'Accent colour' });
      const swatches = createEl('div', { className: 'nvsetup-swatches', role: 'radiogroup', 'aria-label': 'Accent colour' });
      for (const accent of ACCENTS) {
        const sw = createEl('button', {
          className: 'nvsetup-swatch' + (accent === pending.accent ? ' on' : ''),
          type: 'button',
          role: 'radio',
          'aria-checked': String(accent === pending.accent),
          'aria-label': `Accent ${accent}`,
        });
        sw.style.background = accent;
        sw.addEventListener('click', () => {
          pending.accent = accent;
          for (const other of swatches.children) other.classList.remove('on');
          sw.classList.add('on');
        });
        swatches.appendChild(sw);
      }

      card.append(title, sub, themeLabel, themeRows, accentLabel, swatches);
      body.replaceChildren(card);
      setButtons({ next: 'Next' });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 7: All set ───────────────────────────────────────────────────
    function stepDone() {
      const card = createEl('div', { className: 'nvsetup-done' });
      const big = createEl('div', { className: 'nvsetup-big', textContent: '\u2705', 'aria-hidden': 'true' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: 'You\u2019re all set' });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: `Welcome to AstroOS, ${pending.displayName || 'owner'}. Your account\u2019s files live under users/${pending.username || 'owner'}/home \u2014 add more accounts any time from the Users app.` });
      card.append(big, title, sub);
      body.replaceChildren(card);
      setButtons({ next: 'Finish', skip: false, back: false });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    async function finish() {
      // Preferences are applied AFTER the account mount: the owner's hive
      // is the mounted settings store by now, so these writes land in the
      // owner's own registry rather than the machine store.
      try {
        OS.settings.set('theme', pending.theme);
        OS.settings.set('accentColor', pending.accent);
        OS.settings.set('keyboardLayout', pending.keyboardLayout);
        OS.settings.set('region', pending.region);
        OS.settings.set('timezone', pending.timezone);
        OS.settings.set('doNotDisturb', false);
      } catch (err) {
        console.warn('[AstroOSSetup] Preference apply failed:', err);
      }
      // Guest access is a machine policy — admin route, best effort.
      // PUT /admin/policies takes the patch DIRECTLY as the JSON body
      // (same contract as the Users app's policies.set); wrapping it in
      // a { policies: ... } envelope is rejected by setPolicies as an
      // unknown 'policies' key — 400 INVALID_POLICY.
      try {
        if (manager && typeof manager.authFetch === 'function' && manager.isAdmin?.()) {
          await manager.authFetch('/api/auth/admin/policies', {
            method: 'PUT',
            body: { guestAccess: pending.guestAccess === true },
          });
        }
      } catch (err) {
        console.warn('[AstroOSSetup] Guest-access policy apply failed:', err);
      }
      try {
        EventLog?.log?.({ app: 'AstroOS Setup', category: 'system', severity: 'info', message: 'First-boot setup complete', data: { username: pending.username } });
      } catch (_) { }

      // Close the wizard window — the desktop mounted by setupOwner is the
      // surface that remains. WM.closeWindow no-ops safely if the window is
      // already gone (e.g. the user closed it themselves mid-finish).
      try {
        if (typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
          WM.closeWindow(state.id);
        }
      } catch (_) { }
    }

    // ── Completed state (launched after setup already ran) ────────────────
    async function renderCompleted() {
      root.replaceChildren();
      const wrap = createEl('div', { className: 'nvsetup-body' });
      const card = createEl('div', { className: 'nvsetup-done' });
      card.append(
        Object.assign(createEl('div', { className: 'nvsetup-big', textContent: '\uD83D\uDD27', 'aria-hidden': 'true' })),
        Object.assign(createEl('h1', { className: 'nvsetup-title', textContent: 'Setup is already complete' })),
        Object.assign(createEl('div', { className: 'nvsetup-sub', textContent: 'This machine already has accounts. First-boot setup only runs once \u2014 manage accounts from the Users app, and preferences from Settings.' })),
      );
      wrap.appendChild(card);
      root.appendChild(wrap);
      const bar = createEl('div', { className: 'nvsetup-bottom' });
      const close = createEl('button', { className: 'nvsetup-btn primary', textContent: 'Close', 'aria-label': 'Close AstroOS Setup' });
      close.addEventListener('click', () => {
        if (typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') WM.closeWindow(state.id);
      });
      bar.appendChild(close);
      root.appendChild(bar);
    }

    // ── Step driver ───────────────────────────────────────────────────────
    const steps = [stepWelcome, stepNetwork, stepDateAndRegion, stepPrivacy, stepAccount, stepAppearance, stepDone];

    async function goTo(next) {
      if (next === step) return;
      if (next > step && step === 4) {
        // Leaving the account step: create the owner first.
        const statusEl = body.querySelector('.nvsetup-status');
        if (statusEl && !(await createOwner(statusEl))) return;
      }
      if (next === 6) {
        // Entering the final step: the mount sequence has already run
        // (setupOwner awaited it); nothing else to do here.
      }
      step = Math.min(Math.max(next, 0), LAST_STEP);
      renderDots();
      steps[step]();
    }

    nextBtn.addEventListener('click', () => {
      if (step === LAST_STEP) { nextBtn.disabled = true; finish(); return; }
      goTo(step + 1);
    });
    backBtn.addEventListener('click', () => { goTo(step - 1); });
    skipBtn.addEventListener('click', () => {
      if (step === 1) { pending.networkSkipped = true; goTo(step + 1); }
    });

    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !nextBtn.disabled && step !== 3) { e.preventDefault(); nextBtn.click(); }
    });

    // ── Entry decision: wizard or completed state ───────────────────────
    if (!multiUser || !manager) {
      renderCompleted();
      return;
    }
    try {
      const accounts = await manager.listAccounts();
      const hasAccounts = Array.isArray(accounts?.users) && accounts.users.length > 0;
      if (hasAccounts) { renderCompleted(); return; }
    } catch (_) { /* fall through to the wizard — the picker will re-gate */ }

    renderDots();
    stepWelcome();
  },
});
