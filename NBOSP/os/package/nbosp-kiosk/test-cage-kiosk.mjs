import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const packageDir = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, packageDir), 'utf8');

describe('NBOSP Cage kiosk configuration', () => {
  it('builds Cage and XWayland without the Weston desktop experiment', () => {
    const config = read('../../configs/nbosp_x86_64_defconfig');
    const build = read('../../build-iso.sh');

    assert.match(config, /^BR2_PACKAGE_CAGE=y$/m);
    assert.match(config, /^BR2_PACKAGE_XWAYLAND=y$/m);
    assert.doesNotMatch(config, /BR2_PACKAGE_WESTON/);
    assert.doesNotMatch(build, /target\/usr\/bin\/weston/);
  });

  it('starts the kiosk in Cage fullscreen mode only', () => {
    const init = read('../../board/nbosp/S99nbosp');
    const mounts = read('../../board/nbosp/rootfs-overlay/etc/init.d/S01mounts');
    const prepare = read('prepare-kiosk.mjs');
    const packageMakefile = read('nbosp-kiosk.mk');

    assert.match(init, /exec \/usr\/bin\/cage -- \/run\/nbosp-kiosk-session\.sh/);
    assert.doesNotMatch(init, /weston|compositor_mode|NBOSP_COMPOSITOR_MODE/i);
    assert.match(prepare, /frame: false/);
    assert.match(prepare, /fullscreen: true/);
    assert.match(prepare, /kiosk: true/);
    assert.match(mounts, /mkdir -p [^\n]*\/var\/lock\/subsys/);
    assert.match(packageMakefile, /chmod 0755 \$\(TARGET_DIR\)\/opt\/nbosp\/package\.nw \\/);
    assert.match(packageMakefile, /package\.nw\/js \\/);
    assert.match(packageMakefile, /package\.nw\/js\/apps/);
    assert.match(packageMakefile, /chmod 0644 \$\(TARGET_DIR\)\/opt\/nbosp\/package\.nw\/js\/apps\/novaapp-manifest\.json/);
  });

  it('boots without SELinux policy, boot wrapper, or kernel configuration', () => {
    const config = read('../../configs/nbosp_x86_64_defconfig');
    const kernel = read('../../board/nbosp/linux.fragment');
    const grub = read('../../board/nbosp/grub.cfg');
    const postBuild = read('../../board/nbosp/post-build.sh');
    const xwayland = read('../../overrides/xwayland/xwayland.mk');
    const build = read('../../build-iso.sh');

    assert.doesNotMatch(config, /SELINUX|REfpolicy|LIBSELINUX/i);
    assert.doesNotMatch(kernel, /SELINUX|AUDIT|NETFILTER|IP_NF|IP6_NF/);
    assert.doesNotMatch(grub, /selinux|enforcing=/i);
    assert.doesNotMatch(postBuild, /selinux|nbosp-init/i);
    assert.match(xwayland, /-Dxselinux=false/);
    assert.doesNotMatch(build, /nbosp-selinux-init|SELINUX_POLICY_ENTRY|CONFIG_SECURITY_SELINUX/);
  });
});
