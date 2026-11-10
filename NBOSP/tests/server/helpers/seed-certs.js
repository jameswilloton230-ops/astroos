import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// certs.js parses the files it finds, so placeholder text no longer counts as
// "existing certs". test/setup.js stubs globalThis.crypto too, which means
// certs.js can't generate them here; use openssl to make real ones instead.
export async function seedCerts(dir) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-seed-certs-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: tmp, stdio: 'pipe' });

  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
      '-subj', '/CN=Test CA', '-days', '30', '-addext', 'basicConstraints=critical,CA:TRUE');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'cert.key', '-out', 'cert.csr',
      '-subj', '/CN=localhost');
    run('x509', '-req', '-in', 'cert.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', 'cert.crt', '-days', '30');

    for (const file of ['ca.key', 'ca.crt', 'cert.key', 'cert.crt']) {
      await fs.copyFile(path.join(tmp, file), path.join(dir, file));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
