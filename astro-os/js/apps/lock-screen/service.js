'use strict';

let _wipeCountdownId = 0;

// LOCK SCREEN

function handleLockScreenKeydown(e) {
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl?.classList.contains('active')) {
    document.removeEventListener('keydown', handleLockScreenKeydown);
    return;
  }
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); enterPinDigit(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); backspacePin(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (enteredPin.length === 4) verifyPin(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearPin(); }
}

function lockScreen() {
  if (!OS.lockPin) { WM.minimizeAll(); return; }
  OS.isLocked = true;
  document.getElementById('lock-screen')?.classList.add('active');
  renderLockScreen();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
}

let enteredPin = '';

function renderLockScreen() {
  const usernameEl = document.getElementById('lock-username');
  const dotsEl = document.getElementById('lock-pin-dots');
  const statusEl = document.getElementById('lock-status');
  const numpadEl = document.getElementById('lock-numpad');
  if (!usernameEl || !dotsEl || !statusEl || !numpadEl) return;

  usernameEl.textContent = OS.username || '';
  dotsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
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
  if (window.PublicKeyCredential && OS.settings.get('biometricCredentialId')) {
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

async function attemptBiometricUnlock(statusEl) {
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) { statusEl.textContent = 'Biometric not available on this device'; return; }
    statusEl.textContent = 'Waiting for biometric...';

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = OS.settings.get('biometricCredentialId');
    // Uint8Array.fromBase64() (ES2026) replaces the legacy atob() + char-code
    // dance. Feature-detect and fall back to atob() for older browsers.
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

function unlockFromLockScreen() {
  OS.isLocked = false;
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen unlocked' });

  // Cancel any pending wipe countdown — biometric auth must be able to abort it.
  if (_wipeCountdownId) {
    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
  }

  document.getElementById('lock-screen')?.classList.remove('active');
  document.removeEventListener('keydown', handleLockScreenKeydown);
  enteredPin = '';

  WM.updateTaskbar();
  requestAnimationFrame(() => { renderDesktopIcons(); WM.updateTaskbar(); });
}

function enterPinDigit(d) {
  if (enteredPin.length >= 4) return;
  enteredPin += d;
  updatePinDots();
  if (enteredPin.length === 4) verifyPin();
}

function clearPin() {
  enteredPin = '';
  updatePinDots();
  document.getElementById('lock-status').textContent = '';
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

async function verifyPin() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;

  // Enforce lockout before touching the hash worker — the original code set
  // OS.lockoutUntil but never checked it at entry, so a caller could keep
  // submitting PINs indefinitely during the lockout window.
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

// Shared lockout path for both the standard and extended windows. Starts a
// timer that clears the count once the window expires.
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

// Ten or more failed attempts triggers a 10-second countdown to a full local
// wipe. Biometric unlock can still cancel it via unlockFromLockScreen().
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

// IDLE LOCK

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
  }
}, 30_000);

window.LockScreenService = Object.freeze({ lockScreen });
