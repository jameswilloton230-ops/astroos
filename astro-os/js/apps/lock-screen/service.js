'use strict';

/**
 * AstroOS — Lock Screen v2 (com.astroos.service.lock-screen)
 *
 * Two related surfaces sharing one visual language:
 *
 *  ── The login picker ── appears whenever there is no active session:
 *  cold boot, after sign out, or after a switch. Full-bleed dimmed
 *  wallpaper, a large clock and date, a horizontal set of account tiles
 *  (public-safe fields only: avatar, display name, role badge, status),
 *  an optional guest tile when machine policy enables guest access, and
 *  power controls in the corner. Zero accounts ⇒ first boot: the AstroOS
 *  Setup app (com.astroos.setup, an AOSP-style .novaapp wizard) owns the
 *  whole first-run experience — this service launches it full-screen and
 *  only falls back to an in-picker notice when the app cannot start.
 *
 *  ── The locked screen ── appears over an ACTIVE session: the current
 *  account's avatar and name, their PIN pad (4 or 6 dots, per the
 *  account's PIN length) or passphrase field, a biometric button when
 *  that account has enrolled WebAuthn credentials, and a switch-user
 *  affordance that suspends the session and returns to the picker
 *  without ending it.
 *
 * The auth sheet is the only place a credential is ever typed, and in
 * multi-user mode it submits straight to the server (SessionManager →
 * POST /api/auth/reverify) — the client never sees a hash. Machines
 * with multi-user mode disabled keep the 3.0.2 client-side PBKDF2
 * verification byte-for-byte.
 */

let _wipeCountdownId = 0;

// ── Mode helpers ─────────────────────────────────────────────────────

function multiUserEnabled() {
  return typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.();
}

function sessionManager() {
  return (typeof SessionManager !== 'undefined' && SessionManager) || null;
}

// Current surface: 'hidden' | 'locked' | 'picker' | 'picker-auth' | 'forced-pin' | 'setup'
let surface = 'hidden';

// ── PIN sheet state ──────────────────────────────────────────────────

let enteredPin = '';
let sheetAccount = null;      // public account record the sheet is authenticating
let sheetMode = 'pin';        // 'pin' | 'passphrase'
let sheetResumable = false;    // sheet targets a parked (suspended) session
let passphraseValue = '';

// ── First-boot setup (AstroOS Setup .novaapp) ───────────────────────

// The wizard itself lives in the com.astroos.setup system app; this service
// only detects "no accounts yet" and hands the machine over to it. Rapid
// relaunch counting keeps a crashing setup package from spawn-looping the
// window manager — after two quick closes the picker shows the fallback
// notice instead of launching it again.
let setupWindowId = null;
let setupLastLaunch = 0;
let setupRapidCloses = 0;
const SETUP_APP_ID = 'com.astroos.setup';

// ── Keyboard handler ─────────────────────────────────────────────────

function handleLockScreenKeydown(e) {
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl?.classList.contains('active')) {
    document.removeEventListener('keydown', handleLockScreenKeydown);
    return;
  }
  if (surface === 'picker') {
    handlePickerKeydown(e, lockScreenEl);
    return;
  }
  if (surface === 'setup') return; // the wizard owns its own keyboard handling
  if (sheetMode === 'passphrase') {
    if (e.key === 'Enter') { e.preventDefault(); verifySheetSecret(); }
    return; // the field handles its own input
  }
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); enterPinDigit(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); backspacePin(); }
  else if (e.key === 'Enter') { e.preventDefault(); submitSheetIfComplete(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearPin(); }
}

function submitSheetIfComplete() {
  const pinLength = sheetAccount?.pinLength || 4;
  if (enteredPin.length === pinLength) verifyPin();
}

// ── Shared sheet rendering (numpad + dots are reused components) ─────

function renderLockScreen() {
  const usernameEl = document.getElementById('lock-username');
  const dotsEl = document.getElementById('lock-pin-dots');
  const statusEl = document.getElementById('lock-status');
  const numpadEl = document.getElementById('lock-numpad');
  if (!usernameEl || !dotsEl || !statusEl || !numpadEl) return;

  if (multiUserEnabled()) {
    const manager = sessionManager();
    const account = sheetAccount || (manager ? manager.state() : null);
    usernameEl.textContent = account?.displayName || account?.uname || 'Sign in';
    const pinLength = Math.min(Math.max(account?.pinLength || 4, 4), 6);
    dotsEl.innerHTML = '';
    for (let i = 0; i < pinLength; i++) {
      dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
    }
  } else {
    usernameEl.textContent = OS.username || '';
    dotsEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
    }
  }
  statusEl.textContent = '';
  numpadEl.innerHTML = '';

  for (let i = 1; i <= 9; i++) {
    const btn = createEl('button', { textContent: String(i), 'aria-label': String(i) });
    btn.addEventListener('click', () => enterPinDigit(String(i)));
    numpadEl.appendChild(btn);
  }
  const clearBtn = createEl('button', { textContent: 'C', 'aria-label': 'Clear' });
  clearBtn.addEventListener('click', clearPin);
  numpadEl.appendChild(clearBtn);

  const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
  zeroBtn.addEventListener('click', () => enterPinDigit('0'));
  numpadEl.appendChild(zeroBtn);

  const backBtn = createEl('button', { 'aria-label': 'Backspace' });
  backBtn.innerHTML = svgIcon('chevron-left', 18);
  backBtn.addEventListener('click', backspacePin);
  numpadEl.appendChild(backBtn);

  // Biometric unlock button — added once per lock screen mount.
  const biometricReady = multiUserEnabled()
    ? (sheetAccount?.hasBiometric || sessionManager()?.state()?.via === 'webauthn')
    : (window.PublicKeyCredential && OS.settings.get('biometricCredentialId'));
  if (window.PublicKeyCredential && biometricReady) {
    const lockScreenEl = document.getElementById('lock-screen');
    if (lockScreenEl && !lockScreenEl.querySelector('.biometric-btn')) {
      const bioBtn = createEl('button', {
        className: 'biometric-btn',
        style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
      });
      bioBtn.textContent = '👆 Use Biometric';
      bioBtn.addEventListener('click', () => attemptBiometricUnlock(statusEl));
      numpadEl.parentNode?.appendChild(bioBtn);
    }
  }

  enteredPin = '';
  updatePinDots();
  // Remove before re-adding so re-renders don't stack keydown listeners.
  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
}

// ── Sheet: PIN entry ─────────────────────────────────────────────────

function enterPinDigit(d) {
  const pinLength = (multiUserEnabled() ? (sheetAccount?.pinLength || 4) : 4);
  if (enteredPin.length >= pinLength) return;
  enteredPin += d;
  updatePinDots();
  if (enteredPin.length === pinLength) verifyPin();
}

function clearPin() {
  enteredPin = '';
  passphraseValue = '';
  updatePinDots();
  const statusEl = document.getElementById('lock-status');
  if (statusEl) statusEl.textContent = '';
}

function backspacePin() {
  enteredPin = enteredPin.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  document.querySelectorAll('.lock-pin-dot').forEach((dot, i) =>
    dot.classList.toggle('filled', i < enteredPin.length)
  );
}

// ── Sheet: verification ──────────────────────────────────────────────

async function verifyPin() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;

  if (multiUserEnabled()) {
    await verifySheetSecret();
    return;
  }

  // ── Legacy single-user path (multi-user disabled): byte-identical ──
  if (OS.lockoutUntil && Date.now() < OS.lockoutUntil) {
    const remaining = Math.ceil((OS.lockoutUntil - Date.now()) / 1000);
    statusEl.textContent = `Locked out. Try again in ${remaining}s`;
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `PIN attempt blocked — lockout active (${remaining}s remaining)` });
    return;
  }

  statusEl.textContent = 'Verifying...';

  let hash;
  try {
    if (!OS.workers?.crypto?.call) throw new Error('crypto worker unavailable');
    if (typeof getPinSalt !== 'function') throw new Error('PIN salt provider unavailable');
    hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());
  } catch (err) {
    statusEl.textContent = 'Verification unavailable: ' + (err?.message || 'try again');
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: `PIN verification failed: ${err?.message || err}` });
    return;
  }

  if (hash === OS.lockPin) {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    unlockFromLockScreen();
    return;
  }

  // Wrong PIN — escalate lockout based on attempt count.
  OS.wrongPinCount++;
  enteredPin = '';
  updatePinDots();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `Incorrect PIN entered (attempt ${OS.wrongPinCount})`, data: { wrongPinCount: OS.wrongPinCount } });

  const THRESHOLD = 3;
  const DURATION_MS = 30_000;

  if (OS.wrongPinCount >= THRESHOLD && OS.wrongPinCount < THRESHOLD * 2) {
    applyLockout(statusEl, DURATION_MS);
  } else if (OS.wrongPinCount >= THRESHOLD * 2 && OS.wrongPinCount < 10) {
    applyLockout(statusEl, DURATION_MS * 5);
  } else if (OS.wrongPinCount >= 10) {
    triggerSecurityWipe(statusEl);
  } else {
    statusEl.textContent = 'Incorrect PIN';
  }
}

/**
 * Multi-user sheet verification — always a server round-trip. The sheet is
 * the only place a credential is ever typed; the lockout ladder runs on the
 * server where a compromised webview cannot reset the counter.
 */
async function verifySheetSecret() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;
  const manager = sessionManager();
  if (!manager) {
    statusEl.textContent = 'Session service unavailable';
    return;
  }

  const secret = sheetMode === 'passphrase' ? passphraseValue : enteredPin;
  if (!secret) {
    statusEl.textContent = sheetMode === 'passphrase' ? 'Enter your passphrase' : 'Enter your PIN';
    return;
  }

  statusEl.textContent = 'Verifying…';

  let result;
  if (sheetResumable && sheetAccount) {
    // Picker flow on a parked (suspended) session: re-verification resumes it.
    result = await manager.resumeUser(sheetAccount.uid, secret);
  } else if (sheetAccount && (surface === 'picker' || surface === 'picker-auth')) {
    // Picker login: fresh authentication as this account.
    result = await manager.login({ uid: sheetAccount.uid, secret });
  } else {
    // Locked session of the active account.
    result = await manager.unlock(secret);
  }

  if (result?.ok) {
    clearPin();
    passphraseValue = '';
    unlockFromLockScreen();
    if (result.mustChangePin) showForcedPinChange();
    return;
  }

  enteredPin = '';
  passphraseValue = '';
  updatePinDots();
  const sheet = document.getElementById('lock-screen');
  sheet?.querySelector('.lock-sheet-card')?.classList.remove('shake');
  requestAnimationFrame(() => sheet?.querySelector('.lock-sheet-card')?.classList.add('shake'));

  if (result?.retryAfterMs && result.retryAfterMs > 0) {
    startServerLockoutCountdown(statusEl, result.retryAfterMs, result.message);
  } else {
    statusEl.textContent = result?.message || 'Incorrect PIN';
  }
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'warn',
    message: `Sign-in failed: ${result?.code || 'BAD_CREDENTIAL'}${sheetAccount ? ` (account: ${sheetAccount.displayName || sheetAccount.username})` : ''}`,
  });
}

function startServerLockoutCountdown(statusEl, durationMs, message) {
  const label = message || 'Too many attempts';
  let remaining = Math.ceil(durationMs / 1000);
  const render = () => {
    statusEl.textContent = remaining > 0
      ? `${label}. Try again in ${remaining}s`
      : '';
  };
  render();
  const id = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) clearInterval(id);
  }, 1000);
}

// ── Sheet: passphrase mode ───────────────────────────────────────────

function showPassphraseField() {
  sheetMode = 'passphrase';
  enteredPin = '';
  passphraseValue = '';
  const dotsEl = document.getElementById('lock-pin-dots');
  const numpadEl = document.getElementById('lock-numpad');
  if (dotsEl) dotsEl.innerHTML = '';
  if (numpadEl) numpadEl.innerHTML = '';
  const statusEl = document.getElementById('lock-status');
  if (statusEl) statusEl.textContent = '';

  const existing = document.getElementById('lock-passphrase');
  if (existing) existing.remove();
  const numpad = document.getElementById('lock-numpad');
  const card = numpad?.parentElement;
  if (!card) return;
  const field = createEl('input', {
    id: 'lock-passphrase',
    type: 'password',
    autocomplete: 'current-password',
    placeholder: 'Passphrase',
    'aria-label': 'Account passphrase',
  });
  Object.assign(field.style, {
    width: '100%', maxWidth: '260px', padding: '12px 14px',
    borderRadius: '10px', border: '1px solid var(--border-default)',
    background: 'var(--bg-overlay)', color: 'var(--text-primary)',
    fontSize: '14px', outline: 'none', textAlign: 'center',
  });
  field.addEventListener('input', () => { passphraseValue = field.value; });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verifySheetSecret(); }
  });
  card.insertBefore(field, document.getElementById('lock-status'));
  field.focus();

  const back = createEl('button', {
    id: 'lock-passphrase-back',
    textContent: 'Use PIN instead',
    'aria-label': 'Switch back to PIN entry',
  });
  Object.assign(back.style, {
    marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
    border: '1px solid var(--border-default)', background: 'transparent',
    color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
  });
  back.addEventListener('click', showPinPadForAccount);
  card.insertBefore(back, document.getElementById('lock-status'));
}

function showPinPadForAccount() {
  sheetMode = 'pin';
  const field = document.getElementById('lock-passphrase');
  field?.remove();
  const back = document.getElementById('lock-passphrase-back');
  back?.remove();
  renderLockScreen();
}

// ── Biometric unlock ─────────────────────────────────────────────────

async function attemptBiometricUnlock(statusEl) {
  const manager = sessionManager();
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) { statusEl.textContent = 'Biometric not available on this device'; return; }
    if (multiUserEnabled() && manager && sheetAccount?.uid) {
      statusEl.textContent = 'Waiting for biometric…';
      const result = await manager.webauthnLogin({ uid: sheetAccount.uid });
      if (result.ok) {
        unlockFromLockScreen();
        if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
          Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
        }
      } else {
        statusEl.textContent = 'Biometric failed: ' + (result.message || 'Try your PIN instead');
      }
      return;
    }

    // Legacy single-user path.
    statusEl.textContent = 'Waiting for biometric...';
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = OS.settings.get('biometricCredentialId');
    const credBytes = Uint8Array.fromBase64
      ? Uint8Array.fromBase64(credentialId)
      : Uint8Array.from(atob(credentialId), c => c.charCodeAt(0));

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credBytes, type: 'public-key' }],
        userVerification: 'required'
      }
    });
    if (credential) {
      unlockFromLockScreen();
      if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
        Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
      }
    }
  } catch (err) {
    statusEl.textContent = 'Biometric failed: ' + (err?.message || 'Try PIN instead');
  }
}

// ── Unlock / hide ────────────────────────────────────────────────────

function unlockFromLockScreen() {
  OS.isLocked = false;
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen unlocked' });

  // Cancel any pending wipe countdown — biometric auth must be able to abort it.
  if (_wipeCountdownId) {
    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
  }

  sheetAccount = null;
  hideAllSurfaces();
  enteredPin = '';
  passphraseValue = '';

  WM.updateTaskbar();
  requestAnimationFrame(() => { renderDesktopIcons(); WM.updateTaskbar(); });
}

function hideAllSurfaces() {
  document.getElementById('lock-screen')?.classList.remove('active');
  document.getElementById('lock-screen')?.querySelector('.lock-picker')?.remove();
  document.getElementById('lock-passphrase')?.remove();
  document.getElementById('lock-passphrase-back')?.remove();
  document.getElementById('lock-switch-user')?.remove();
  document.getElementById('lock-passphrase-toggle')?.remove();
  document.removeEventListener('keydown', handleLockScreenKeydown);
  surface = 'hidden';
}

// ── Lock (the active session) ────────────────────────────────────────

async function lockScreen() {
  if (multiUserEnabled()) {
    const manager = sessionManager();
    if (!manager || !manager.active()) {
      // No live session: the picker IS the gate.
      await showLoginPicker();
      return;
    }
    OS.isLocked = true;
    surface = 'locked';
    sheetAccount = {
      uid: manager.state().uid,
      displayName: manager.state().displayName || manager.state().uname,
      uname: manager.state().uname,
      pinLength: 4,
    };
    // Best-effort account metadata for the sheet (dots count, biometric).
    try {
      if (manager.listAccounts) {
        const accounts = await manager.listAccounts();
        const match = accounts.users?.find((u) => u.uid === sheetAccount.uid);
        if (match) sheetAccount = match;
      }
    } catch (_) { }
    document.getElementById('lock-screen')?.classList.add('active');
    showPinPadForAccount();
    await manager.lock?.();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
    return;
  }

  if (!OS.lockPin) { WM.minimizeAll(); return; }
  OS.isLocked = true;
  document.getElementById('lock-screen')?.classList.add('active');
  renderLockScreen();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
}

/** Lock showing the sheet for a specific account (API parity helper). */
async function lockForUser(uid) {
  if (!multiUserEnabled()) { await lockScreen(); return; }
  const manager = sessionManager();
  try {
    if (manager?.listAccounts) {
      const accounts = await manager.listAccounts();
      sheetAccount = accounts.users?.find((u) => u.uid === uid) || { uid, displayName: uid };
    }
  } catch (_) { }
  OS.isLocked = true;
  surface = 'locked';
  document.getElementById('lock-screen')?.classList.add('active');
  showPinPadForAccount();
}

// ── Login picker ─────────────────────────────────────────────────────

async function showLoginPicker() {
  if (!multiUserEnabled()) { await lockScreen(); return; }
  const manager = sessionManager();
  if (!manager) return;

  surface = 'picker';
  sheetAccount = null;
  sheetResumable = false;
  sheetMode = 'pin';
  const accounts = await manager.listAccounts();

  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl) return;

  // Zero accounts = first boot: the AstroOS Setup app owns the whole
  // first-run experience (nothing account-shaped is hardcoded here). The
  // picker stays down while the wizard runs; if the app cannot start, or
  // closes without creating an account, the picker (re)appears below.
  if (!accounts.users?.length) {
    const launched = await launchFirstBootSetup(manager);
    if (launched) {
      hideAllSurfaces(); // picker chrome down while the wizard runs
      surface = 'setup';
      return;
    }
  }

  // Hide the sheet chrome while the picker is up.
  for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad', 'lock-passphrase', 'lock-passphrase-back', 'lock-switch-user', 'lock-passphrase-toggle']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  lockScreenEl.querySelector('.lock-picker')?.remove();

  const picker = createEl('div', { className: 'lock-picker', role: 'group', 'aria-label': 'Account picker' });

  if (!accounts.users?.length) {
    picker.appendChild(buildSetupUnavailableNotice());
  } else {
    const clock = createEl('div', { className: 'lock-picker-clock' });
    const now = new Date();
    clock.appendChild(createEl('div', {
      className: 'lp-time',
      textContent: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      'aria-label': 'Current time',
    }));
    clock.appendChild(createEl('div', {
      className: 'lp-date',
      textContent: now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
      'aria-label': 'Current date',
    }));
    picker.appendChild(clock);

    picker.appendChild(createEl('div', {
      className: 'lock-picker-title',
      textContent: 'Who\u2019s signing in?',
      role: 'heading', 'aria-level': 1,
    }));

    const tiles = createEl('div', { className: 'lock-picker-tiles' });
    const suspended = new Map((manager.suspendedUsers?.() || []).map((u) => [u.uid, u]));
    for (const user of accounts.users) {
      tiles.appendChild(buildAccountTile(user, { resumable: suspended.has(user.uid), showUsername: !!accounts.policies?.showUsernames }));
    }
    if (accounts.policies?.guestAccess) {
      tiles.appendChild(buildGuestTile());
    }
    picker.appendChild(tiles);

    const status = createEl('div', { className: 'lock-picker-status', 'aria-live': 'assertive', id: 'lock-picker-status' });
    picker.appendChild(status);
  }

  picker.appendChild(buildPowerControls());

  lockScreenEl.appendChild(picker);
  lockScreenEl.classList.add('active');

  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Login picker shown' });
}

function tileAvatar(user) {
  const avatar = createEl('div', { className: 'lp-avatar', 'aria-hidden': 'true' });
  if (typeof user.avatar === 'string' && user.avatar && user.avatar.length <= 8) {
    avatar.textContent = user.avatar;
  } else {
    const source = user.displayName || user.username || '?';
    avatar.textContent = String(source).trim().charAt(0).toUpperCase() || '?';
  }
  return avatar;
}

function buildAccountTile(user, { resumable = false, showUsername = false } = {}) {
  const tile = createEl('button', {
    className: 'lp-tile',
    'aria-label': `Sign in as ${user.displayName || user.username}${user.roleLabel ? `, ${user.roleLabel}` : ''}`,
  });
  if (resumable) tile.classList.add('resumable');
  if (user.locked) tile.classList.add('locked');

  tile.appendChild(tileAvatar(user));
  tile.appendChild(createEl('div', { className: 'lp-name', textContent: user.displayName || user.username }));
  if (showUsername) tile.appendChild(createEl('div', { className: 'lp-uname', textContent: user.username }));

  const chips = createEl('div', { className: 'lp-chips' });
  // Admin accounts carry a small shield chip so anyone at the screen can
  // see who holds management power.
  if (user.role === 'admin' || user.role === 'owner') {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-admin', title: `${user.roleLabel} account` }));
  }
  if (user.locked) {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-locked', textContent: 'Locked' }));
  } else if (resumable) {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-resume', textContent: 'Resumable' }));
  }
  tile.appendChild(chips);

  tile.addEventListener('click', () => selectAccountForAuth(user, { resumable }));
  return tile;
}

function buildGuestTile() {
  const tile = createEl('button', { className: 'lp-tile lp-tile-guest', 'aria-label': 'Continue as guest' });
  const avatar = createEl('div', { className: 'lp-avatar', 'aria-hidden': 'true', textContent: 'G' });
  tile.appendChild(avatar);
  tile.appendChild(createEl('div', { className: 'lp-name', textContent: 'Guest' }));
  tile.appendChild(createEl('div', { className: 'lp-uname', textContent: 'Ephemeral session' }));
  tile.addEventListener('click', async () => {
    const manager = sessionManager();
    if (!manager) return;
    await manager.guestLogin();
    unlockFromLockScreen();
  });
  return tile;
}

function buildPowerControls() {
  const row = createEl('div', { className: 'lock-picker-power', 'aria-label': 'Power controls' });
  const mk = (label, title, action) => {
    const btn = createEl('button', { className: 'lp-power-btn', textContent: label, title, 'aria-label': title });
    btn.addEventListener('click', action);
    return btn;
  };
  row.appendChild(mk('Restart', 'Restart AstroOS', () => location.reload()));
  row.appendChild(mk('Power off', 'Shut the machine down', () => {
    try {
      if (typeof nw !== 'undefined' && nw?.App?.quit) nw.App.quit();
      else window.close();
    } catch (_) { window.close(); }
  }));
  return row;
}

function handlePickerKeydown(e, lockScreenEl) {
  const tiles = [...lockScreenEl.querySelectorAll('.lp-tile')];
  if (!tiles.length) return;
  const focused = document.activeElement?.classList?.contains('lp-tile')
    ? tiles.indexOf(document.activeElement)
    : -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    tiles[(focused + 1 + tiles.length) % tiles.length].focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    tiles[(focused - 1 + tiles.length) % tiles.length].focus();
  } else if (e.key === 'Enter' && focused >= 0) {
    e.preventDefault();
    tiles[focused].click();
  } else if (/^[1-9]$/.test(e.key) && tiles[Number(e.key) - 1]) {
    e.preventDefault();
    tiles[Number(e.key) - 1].click();
  }
}

/**
 * The per-account auth sheet from the picker: adapts to what the account
 * actually has — a 4- or 6-dot PIN pad driven by the account's PIN length,
 * a passphrase field for passphrase accounts, and a biometric button only
 * when WebAuthn descriptors exist for that uid.
 */
function selectAccountForAuth(user, { resumable = false } = {}) {
  sheetAccount = user;
  sheetResumable = resumable;
  surface = 'picker-auth';
  sheetMode = 'pin';

  const lockScreenEl = document.getElementById('lock-screen');
  const pickerEl = lockScreenEl?.querySelector('.lock-picker');
  if (pickerEl) pickerEl.style.display = 'none';

  for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad']) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  const avatar = document.getElementById('lock-avatar');
  if (avatar) {
    if (typeof user.avatar === 'string' && user.avatar && user.avatar.length <= 8) avatar.textContent = user.avatar;
    else avatar.textContent = String(user.displayName || user.username || '?').charAt(0).toUpperCase();
  }

  renderLockScreen();

  const card = document.getElementById('lock-numpad')?.parentElement;
  if (card) {
    // Back-to-picker affordance.
    const existingBack = document.getElementById('lock-picker-back');
    existingBack?.remove();
    const back = createEl('button', { id: 'lock-picker-back', textContent: '← All accounts', 'aria-label': 'Back to account list' });
    Object.assign(back.style, {
      marginTop: '14px', padding: '6px 14px', borderRadius: '8px',
      border: '1px solid var(--border-default)', background: 'transparent',
      color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
    });
    back.addEventListener('click', () => { showLoginPicker(); });
    card.appendChild(back);

    // Passphrase affordance for accounts that carry one.
    const existingToggle = document.getElementById('lock-passphrase-toggle');
    existingToggle?.remove();
    if (user.hasPassphrase) {
      const toggle = createEl('button', { id: 'lock-passphrase-toggle', textContent: 'Use passphrase', 'aria-label': 'Sign in with passphrase' });
      Object.assign(toggle.style, {
        marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
        border: '1px solid var(--border-default)', background: 'transparent',
        color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
      });
      toggle.addEventListener('click', showPassphraseField);
      card.appendChild(toggle);
    }

    // Switch-user affordance when a live session is being gated instead.
    const existingSwitch = document.getElementById('lock-switch-user');
    existingSwitch?.remove();
    const manager = sessionManager();
    if (manager?.active() && !resumable) {
      const switchBtn = createEl('button', { id: 'lock-switch-user', textContent: 'Switch user', 'aria-label': 'Suspend this session and pick another account' });
      Object.assign(switchBtn.style, {
        marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
        border: '1px solid var(--accent)', background: 'transparent',
        color: 'var(--accent)', fontSize: '12px', cursor: 'pointer',
      });
      switchBtn.addEventListener('click', async () => {
        await manager.suspendForSwitch();
        await showLoginPicker();
      });
      card.appendChild(switchBtn);
    }
  }
}

// ── First-boot setup (launches the AstroOS Setup .novaapp) ───────────

/**
 * Zero accounts on the machine: hand the first-run experience over to the
 * AstroOS Setup system app (com.astroos.setup) — the AOSP-style multi-step
 * wizard that creates the owner account. Nothing account-shaped stays
 * hardcoded here: the wizard is a signed .novaapp, so it can be updated,
 * extended or replaced like any other system package. Failures fall back
 * to a notice in the picker instead of a broken gate.
 */
async function launchFirstBootSetup(manager) {
  if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') return false;
  if (!manager || typeof manager.setupOwner !== 'function') return false;
  if (setupRapidCloses >= 2) return false; // crashing package — stop relaunching

  const app = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[SETUP_APP_ID] : null;
  if (!app || typeof app.init !== 'function') {
    console.error('[LockScreen] AstroOS Setup (' + SETUP_APP_ID + ') is not registered');
    return false;
  }

  try {
    const id = WM.createWindow(SETUP_APP_ID, {
      x: 0,
      y: 0,
      width: window.innerWidth || 1280,
      height: window.innerHeight || 800,
      fullscreen: true,
    });
    if (!id) return false;
    setupWindowId = id;
    setupLastLaunch = Date.now();
    surface = 'setup';

    const onClosed = ({ appId, id: closedId } = {}) => {
      if (appId !== SETUP_APP_ID || closedId !== setupWindowId) return;
      try { OS.events?.off?.('app:closed', onClosed); } catch (_) { }
      setupWindowId = null;
      // A setup window that closes without creating an account re-offers
      // the gate; rapid closes are counted so a crashing package cannot
      // spawn-loop (rapidCloses >= 2 keeps the fallback notice instead).
      if (Date.now() - setupLastLaunch < 8000) setupRapidCloses++;
      const session = sessionManager();
      if (session && session.active?.()) return;
      showLoginPicker().catch(() => { });
    };
    try {
      OS.events?.on?.('app:closed', onClosed);
    } catch (_) { }

    EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'First-boot setup started (AstroOS Setup)' });
    return true;
  } catch (error) {
    console.error('[LockScreen] AstroOS Setup launch failed:', error);
    return false;
  }
}

/** Fallback notice when the Setup app itself cannot run (damaged bundle). */
function buildSetupUnavailableNotice() {
  const wrap = createEl('div', { className: 'lock-wizard', role: 'alert' });
  wrap.appendChild(createEl('div', { className: 'lock-picker-title', textContent: 'Set up AstroOS', role: 'heading', 'aria-level': 1 }));
  wrap.appendChild(createEl('div', {
    className: 'lock-wizard-sub',
    textContent: 'The AstroOS Setup app could not start — the system package is damaged. Restart the machine to retry; if every restart lands here, reinstall AstroOS.',
  }));
  const retry = createEl('button', { className: 'fw-submit', textContent: 'Retry setup', 'aria-label': 'Retry launching AstroOS Setup' });
  Object.assign(retry.style, {
    marginTop: '14px', padding: '12px 22px', borderRadius: '10px',
    border: '1px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--accent)', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  });
  retry.addEventListener('click', async () => {
    setupRapidCloses = 0;
    const launched = await launchFirstBootSetup(sessionManager());
    if (launched) hideAllSurfaces();
  });
  wrap.appendChild(retry);
  return wrap;
}

// ── Forced new-PIN sheet (admin reset / temporary PIN) ────────────────

function showForcedPinChange() {
  const manager = sessionManager();
  if (!manager) return;
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl) return;

  const existing = document.getElementById('lock-forced-pin');
  existing?.remove();

  const card = createEl('div', { id: 'lock-forced-pin', className: 'lock-forced-pin', role: 'form', 'aria-label': 'Set a new PIN' });
  card.appendChild(createEl('div', { className: 'lock-picker-title', textContent: 'Choose a new PIN', role: 'heading', 'aria-level': 2 }));
  card.appendChild(createEl('div', { className: 'lock-wizard-sub', textContent: 'Your account was reset — set a new PIN before continuing.' }));

  const pin = createEl('input', { id: 'fp-pin', type: 'password', inputmode: 'numeric', maxlength: '6', placeholder: 'New PIN', 'aria-label': 'New PIN' });
  const pin2 = createEl('input', { id: 'fp-pin2', type: 'password', inputmode: 'numeric', maxlength: '6', placeholder: 'Confirm new PIN', 'aria-label': 'Confirm new PIN' });
  for (const input of [pin, pin2]) {
    Object.assign(input.style, {
      width: '260px', padding: '10px 12px', borderRadius: '10px', margin: '4px 0',
      border: '1px solid var(--border-default)', background: 'var(--bg-overlay)',
      color: 'var(--text-primary)', fontSize: '13px', outline: 'none', textAlign: 'center',
    });
    card.appendChild(input);
  }
  const status = createEl('div', { className: 'lock-picker-status', id: 'fp-status', 'aria-live': 'assertive' });
  card.appendChild(status);
  const submit = createEl('button', { className: 'fw-submit', textContent: 'Save new PIN', 'aria-label': 'Save the new PIN' });
  Object.assign(submit.style, {
    marginTop: '12px', padding: '12px 22px', borderRadius: '10px',
    border: '1px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--accent)', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  });
  submit.addEventListener('click', async () => {
    if (!/^\d{4,6}$/.test(pin.value)) { status.textContent = 'PIN must be 4–6 digits.'; return; }
    if (pin.value !== pin2.value) { status.textContent = 'The PINs do not match.'; return; }
    const result = await manager.changePin(null, pin.value);
    if (result.ok) card.remove();
    else status.textContent = result.message || 'Could not save the new PIN.';
  });
  card.appendChild(submit);

  lockScreenEl.appendChild(card);
  lockScreenEl.classList.add('active');
  surface = 'forced-pin';
  pin.focus();
}

// ── Legacy lockout / wipe helpers (single-user mode only) ─────────────

function applyLockout(statusEl, durationMs) {
  const sec = Math.round(durationMs / 1000);
  const label = sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
  statusEl.textContent = `Too many attempts. ${label} lockout.`;
  OS.lockoutUntil = Date.now() + durationMs;
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'warn',
    message: `Lockout triggered (${label}) after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount, durationMs }
  });
  setTimeout(() => {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    statusEl.textContent = '';
  }, durationMs);
}

function triggerSecurityWipe(statusEl) {
  statusEl.textContent = 'Security alert! Data will be wiped.';
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'error',
    message: `Security wipe countdown started after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount }
  });

  let countdown = 10;
  _wipeCountdownId = setInterval(() => {
    countdown--;
    statusEl.textContent = `Security alert! Wiping in ${countdown}s`;
    if (countdown > 0) return;

    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
    localStorage.clear();
    sessionStorage.clear();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: 'Security wipe executed — all local data cleared' });
    Notify.show({
      title: 'Security Wipe',
      body: 'All data has been wiped due to too many failed attempts.',
      type: 'error', appName: 'System'
    });
    setTimeout(() => location.reload(), 2000);
  }, 1000);
}

// ── Idle lock ─────────────────────────────────────────────────────────

let lastActivity = Date.now();
const _resetIdleTimer = () => { lastActivity = Date.now(); };
['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, _resetIdleTimer, { passive: true });
});

setInterval(() => {
  // Truthy check on idleTimeout guards against undefined/0/null — without it,
  // an unset idleTimeout would compare NaN < Infinity (false) and never lock,
  // but a 0 would lock on the very first tick.
  if (OS.lockPin && !OS.isLocked && OS.idleTimeout && OS.idleTimeout < Infinity) {
    if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
  } else if (multiUserEnabled()) {
    const manager = sessionManager();
    if (manager && manager.isActive() && !OS.isLocked && OS.idleTimeout && OS.idleTimeout < Infinity) {
      if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
    }
  }
}, 30_000);

// ── Session event wiring ─────────────────────────────────────────────

try {
  const manager = sessionManager();
  manager?.on?.((event) => {
    if (event?.name === 'session:changed' && event.uid) {
      // A signed-in account: the gate is done — the setup window (if the
      // owner was just created through it) closes itself on its finish step.
      if (surface !== 'forced-pin') unlockFromLockScreen();
      setupRapidCloses = 0;
    }
    if (event?.name === 'session:loggedout' || (event?.name === 'session:changed' && event.uid === null && event.phase !== 'picker' && event.phase !== 'setup')) {
      showLoginPicker().catch(() => { });
    }
  });
} catch (_) { /* SessionManager loads before this service; guards cover dev/test loads */ }

window.LockScreenService = Object.freeze({ lockScreen, showLoginPicker, lockForUser, state: () => surface });
