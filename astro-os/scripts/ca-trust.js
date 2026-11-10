'use strict';

const fs                        = require('fs');
const os                        = require('os');
const path                      = require('path');
const crypto                    = require('crypto');
const { execFileSync }          = require('child_process');

function installCaTrustWindows(caCrtPath) {
  try {
    execFileSync('certutil', ['-addstore', '-user', 'Root', caCrtPath], {
      stdio:   'inherit',
      timeout: 60_000,
    });
    return true;
  } catch (e) {
    console.error('[AstroOS] Windows CA install failed:', e.message);
    return false;
  }
}

function installCaTrustMac(caCrtPath) {
  // Single-quote escape path for POSIX shell
  const posixEscaped = caCrtPath.replace(/'/g, "'\\''");
  const quotedPath = `'${posixEscaped}'`;

  // Escape backslashes and double quotes inside AppleScript string literal
  const appleScriptEscaped = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${quotedPath}`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  const shellScript = `do shell script "${appleScriptEscaped}" with administrator privileges`;

  try {
    execFileSync('osascript', ['-e', shellScript], { stdio: 'inherit', timeout: 120_000 });
    return true;
  } catch (e) {
    console.error('[AstroOS] macOS CA install failed:', e.message);
    return false;
  }
}

function installCaTrustLinux(caCrtPath) {
  let nssOk = false;
  let sysOk = false;

  try {
    const knownPaths = [
      '/usr/bin/certutil',
      '/usr/local/bin/certutil',
      '/bin/certutil',
    ];

    const certutil = knownPaths.find(p => fs.existsSync(p)) || '';

    if (certutil) {
      const nssDb = path.join(os.homedir(), '.pki', 'nssdb');
      const dbPath = `sql:${nssDb}`;
      const nickname = 'AstroOS Local CA';

      fs.mkdirSync(nssDb, { recursive: true });
      if (!fs.existsSync(path.join(nssDb, 'cert9.db'))) {
        execFileSync(certutil, ['-N', '-d', dbPath, '--empty-password'], { stdio: 'pipe', timeout: 15_000 });
      }

      const existing = execFileSync(certutil, ['-L', '-d', dbPath], {
        encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
      });
      if (existing.split(/\r?\n/).some(line => line.trimStart().startsWith(`${nickname} `))) {
        execFileSync(certutil, ['-D', '-d', dbPath, '-n', nickname], { stdio: 'pipe', timeout: 10_000 });
      }

      execFileSync(certutil, ['-A', '-d', dbPath, '-t', 'C,,', '-n', nickname, '-i', caCrtPath], {
        stdio: 'pipe', timeout: 15_000,
      });
      const trusted = execFileSync(certutil, ['-L', '-d', dbPath], {
        encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
      });
      const trustEntry = trusted.split(/\r?\n/).find(line => line.trimStart().startsWith(`${nickname} `));
      if (!trustEntry || !/\sC,,\s*$/.test(trustEntry)) {
        throw new Error('The CA was imported, but NSS does not report it as a trusted SSL CA.');
      }
      const exported = execFileSync(certutil, ['-L', '-d', dbPath, '-n', nickname, '-a'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
      });
      const importedFingerprint = new crypto.X509Certificate(exported).fingerprint256;
      const sourceFingerprint = new crypto.X509Certificate(fs.readFileSync(caCrtPath)).fingerprint256;
      if (importedFingerprint !== sourceFingerprint) {
        throw new Error('The NSS CA certificate does not match the certificate served by AstroOS.');
      }
      console.log('[AstroOS] CA installed in NSS db (Chromium will trust it).');
      nssOk = true;
    } else {
      console.warn('[AstroOS] certutil not found — install libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).');
    }
  } catch (e) {
    console.error('[AstroOS] NSS db install failed:', e.message);
  }

  const distros = [
    ['/usr/local/share/ca-certificates/novabyte-ca.crt', ['update-ca-certificates']],
    ['/etc/pki/ca-trust/source/anchors/novabyte-ca.crt',  ['update-ca-trust', 'extract']],
  ];

  for (const [dest, updateCmd] of distros) {
    if (!fs.existsSync(path.dirname(dest))) continue;
    try {
      execFileSync('sudo', ['cp', caCrtPath, dest],  { stdio: 'inherit', timeout: 30_000 });
      execFileSync('sudo', updateCmd,                 { stdio: 'pipe',    timeout: 30_000 });
      sysOk = true;
      break;
    } catch (_) {}
  }

  return nssOk || sysOk;
}

function installCaTrust(caCrtPath) {
  switch (process.platform) {
    case 'win32':  return installCaTrustWindows(caCrtPath);
    case 'darwin': return installCaTrustMac(caCrtPath);
    default:       return installCaTrustLinux(caCrtPath);
  }
}

module.exports = { installCaTrust };