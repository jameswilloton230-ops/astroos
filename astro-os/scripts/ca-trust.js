'use strict';

// Installs a local CA certificate into the OS trust store so Chromium/NW.js
// trusts it natively without needing any --ignore-certificate-errors flags.
//
//   Windows → certutil.exe        (CurrentUser\Root, no admin required)
//   macOS   → osascript + security (System keychain, admin dialog)
//   Linux   → certutil (NSS db)   + system CA update (supplemental)

const fs                        = require('fs');
const os                        = require('os');
const path                      = require('path');
const { execSync, execFileSync } = require('child_process');

// ── Windows ───────────────────────────────────────────────────────────────────

function installCaTrustWindows(caCrtPath) {
  try {
    execFileSync('certutil', ['-addstore', '-user', 'Root', caCrtPath], {
      stdio:   'inherit', // security dialog needs a window parent
      timeout: 60_000,
    });
    return true;
  } catch (e) {
    console.error('[NovaByte] Windows CA install failed:', e.message);
    return false;
  }
}

// ── macOS ─────────────────────────────────────────────────────────────────────

function installCaTrustMac(caCrtPath) {
  // osascript elevates `security add-trusted-cert` so it can write to the System
  // keychain (which Chromium reads) without a full sudo session.
  // Single-quote-escape the path to survive special chars and spaces.
  const quotedPath  = "'" + caCrtPath.replace(/'/g, "'\\''") + "'";
  const shellScript = `do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${quotedPath}" with administrator privileges`;
  try {
    execFileSync('osascript', ['-e', shellScript], { stdio: 'inherit', timeout: 120_000 });
    return true;
  } catch (e) {
    console.error('[NovaByte] macOS CA install failed:', e.message);
    return false;
  }
}

// ── Linux ─────────────────────────────────────────────────────────────────────

function installCaTrustLinux(caCrtPath) {
  // Chromium/NW.js on Linux reads the NSS database (~/.pki/nssdb), not the
  // system CA store. NSS install is critical; system CA update is supplemental.

  let nssOk = false;
  let sysOk = false;

  // 1. NSS db ─────────────────────────────────────────────────────────────────
  try {
    const certutil =
      ['/usr/bin/certutil', '/usr/local/bin/certutil'].find(p => fs.existsSync(p)) ||
      (() => { try { return execSync('which certutil 2>/dev/null', { encoding: 'utf8' }).trim(); } catch (_) { return ''; } })();

    if (certutil) {
      const nssDb = path.join(os.homedir(), '.pki', 'nssdb');

      if (!fs.existsSync(nssDb)) {
        fs.mkdirSync(nssDb, { recursive: true });
        execFileSync(certutil, ['-N', '-d', `sql:${nssDb}`, '--empty-password'], { stdio: 'pipe', timeout: 15_000 });
      }

      // Remove stale entry (ignore error if absent)
      try {
        execFileSync(certutil, ['-D', '-d', `sql:${nssDb}`, '-n', 'NovaByte Local CA'], { stdio: 'pipe', timeout: 10_000 });
      } catch (_) {}

      // 'C,,' = trusted CA for SSL
      execFileSync(certutil, ['-A', '-d', `sql:${nssDb}`, '-t', 'C,,', '-n', 'NovaByte Local CA', '-i', caCrtPath], {
        stdio: 'pipe', timeout: 15_000,
      });
      console.log('[NovaByte] CA installed in NSS db (Chromium will trust it).');
      nssOk = true;
    } else {
      console.warn('[NovaByte] certutil not found — install libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).');
    }
  } catch (e) {
    console.error('[NovaByte] NSS db install failed:', e.message);
  }

  // 2. System CA store (supplemental) ────────────────────────────────────────
  const distros = [
    ['/usr/local/share/ca-certificates/novabyte-ca.crt', ['update-ca-certificates']],
    ['/etc/pki/ca-trust/source/anchors/novabyte-ca.crt',  ['update-ca-trust', 'extract']],
  ];

  for (const [dest, updateCmd] of distros) {
    try {
      execFileSync('sudo', ['cp', caCrtPath, dest],  { stdio: 'inherit', timeout: 30_000 });
      execFileSync('sudo', updateCmd,                 { stdio: 'pipe',    timeout: 30_000 });
      sysOk = true;
      break;
    } catch (_) {}
  }

  return nssOk || sysOk;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function installCaTrust(caCrtPath) {
  switch (process.platform) {
    case 'win32':  return installCaTrustWindows(caCrtPath);
    case 'darwin': return installCaTrustMac(caCrtPath);
    default:       return installCaTrustLinux(caCrtPath);
  }
}

module.exports = { installCaTrust };
