import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const installerPath = fileURLToPath(
  new URL('../../os/package/nbosp-install/nbosp-install-system', import.meta.url)
);
const installerHelperPath = fileURLToPath(
  new URL('../../os/package/nbosp-install/nbosp-install.c', import.meta.url)
);

describe('NBOSP disk installer boot configuration', () => {
  it('marks the FAT boot partition as a GPT EFI System Partition', () => {
    const installer = readFileSync(installerPath, 'utf8');

    expect(installer).toContain(
      'start=4096, size=1048576, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B'
    );
    expect(installer).not.toContain('start=4096, size=1048576, type=U');
  });

  it('uses the GPT partition UUID for kernel root lookup without an initramfs', () => {
    const installer = readFileSync(installerPath, 'utf8');

    expect(installer).toContain('ROOT_PARTUUID="$(blkid -s PARTUUID -o value "$ROOT_PART")"');
    expect(installer).toContain('root=PARTUUID=$ROOT_PARTUUID');
    expect(installer).not.toContain('root=UUID=$ROOT_UUID');
  });

  it('boots the installed root filesystem read-write in every GRUB entry', () => {
    const installer = readFileSync(installerPath, 'utf8');
    const bootEntries = installer.match(/^\s*linux \/boot\/vmlinuz .*$/gm) || [];

    expect(bootEntries).toHaveLength(3);
    for (const entry of bootEntries) {
      expect(entry).toMatch(/\brootwait rw\b/);
    }
  });

  it('uses a UTF-8 locale for FAT volume-label conversion', () => {
    const helper = readFileSync(installerHelperPath, 'utf8');
    expect(helper).toContain('"LANG=C.UTF-8"');
    expect(helper).toContain('"LC_ALL=C.UTF-8"');
    expect(helper).not.toContain('"LC_ALL=C"');
  });
});
