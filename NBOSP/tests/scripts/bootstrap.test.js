import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('scripts/bootstrap.js', () => {
  it('runs clean in a prepared tree: deps considered up to date, vendor synced, exit 0', { timeout: 240_000 }, () => {
    const out = execFileSync(process.execPath, ['scripts/bootstrap.js'], {
      cwd: NBOSP_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    }); // node_modules + package-lock.json exist in the repo, so the fast path
    // (npm 7+ .package-lock.json mtime check) reports "up to date" — unless a
    // fresh checkout just changed package-lock, in which case npm install ran.
    expect(out).toMatch(/\[bootstrap\] (Dependencies up to date\.|Running npm (ci|install)\.\.\.)/);
  });

  it('leaves the vendored DOMPurify bundle in place after syncVendor', { timeout: 240_000 }, () => {
    execFileSync(process.execPath, ['scripts/bootstrap.js'], {
      cwd: NBOSP_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const vendored = path.join(NBOSP_ROOT, 'js', 'purify.min.js');
    expect(fs.existsSync(vendored)).toBe(true);
    expect(fs.statSync(vendored).size).toBeGreaterThan(1000);
  });

  it('is idempotent: a second run takes the fast path', { timeout: 240_000 }, () => {
    const first = execFileSync(process.execPath, ['scripts/bootstrap.js'], { cwd: NBOSP_ROOT, encoding: 'utf8', timeout: 120_000 });
    const second = execFileSync(process.execPath, ['scripts/bootstrap.js'], { cwd: NBOSP_ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(second).toContain('[bootstrap] Dependencies up to date.');
    expect(first).toBeDefined();
  });
});
