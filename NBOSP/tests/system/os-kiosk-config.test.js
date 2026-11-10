import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('NBOSP VMware kiosk device configuration', () => {
  it('mounts procfs and sysfs before device discovery and desktop startup', () => {
    const mounts = readFileSync(
      new URL('../../os/board/nbosp/rootfs-overlay/etc/init.d/S01mounts', import.meta.url),
      'utf8',
    );
    const procMount = 'mounted /proc || mount -t proc proc /proc';
    const sysfsMount = 'mounted /sys || mount -t sysfs sysfs /sys';
    const deviceMount = 'mounted /dev/pts || mount -t devpts';

    expect(mounts).toContain('mkdir -p /proc /sys /dev/pts /dev/shm /tmp');
    expect(mounts.indexOf(procMount)).toBeGreaterThanOrEqual(0);
    expect(mounts.indexOf(procMount)).toBeLessThan(mounts.indexOf(sysfsMount));
    expect(mounts.indexOf(sysfsMount)).toBeGreaterThanOrEqual(0);
    expect(mounts.indexOf(sysfsMount)).toBeLessThan(mounts.indexOf(deviceMount));
  });

  it('includes passwordless sudo in the booted root filesystem for NovaRoot', () => {
    const defconfig = readFileSync(new URL('../../os/configs/nbosp_x86_64_defconfig', import.meta.url), 'utf8');
    const sudoers = readFileSync(
      new URL('../../os/board/nbosp/rootfs-overlay/etc/sudoers.d/nbosp', import.meta.url),
      'utf8',
    );
    const mainSudoers = readFileSync(
      new URL('../../os/board/nbosp/rootfs-overlay/etc/sudoers', import.meta.url),
      'utf8',
    );
    const deviceTable = readFileSync(new URL('../../os/board/nbosp/device_table.txt', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const postBuild = readFileSync(new URL('../../os/board/nbosp/post-build.sh', import.meta.url), 'utf8');

    expect(defconfig).toContain('BR2_PACKAGE_SUDO=y');
    expect(sudoers).toContain('nbosp ALL=(ALL) NOPASSWD: ALL');
    // The drop-in rule only takes effect when the main sudoers delegates to
    // /etc/sudoers.d — Buildroot's stock sudoers is not guaranteed to do so.
    expect(mainSudoers).toMatch(/^[#@]includedir\s+\/etc\/sudoers\.d\s*$/m);
    expect(deviceTable).toContain('/etc/sudoers\tf\t440\t0\t0');
    expect(deviceTable).toContain('/etc/sudoers.d/nbosp\tf\t440\t0\t0');
    expect(postBuild).toContain('install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers"');
    expect(postBuild).toContain('"${TARGET_DIR}/etc/sudoers"');
    expect(postBuild).toContain('install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers.d/nbosp"');
    expect(postBuild).toContain('"${TARGET_DIR}/etc/sudoers.d/nbosp"');
    expect(build).toContain('BR2_PACKAGE_SUDO \\');
    expect(build).toContain('SUDO_BIN="$OUTPUT_DIR/target/usr/bin/sudo"');
    expect(build).toContain('SUDOERS_FILE="$OUTPUT_DIR/target/etc/sudoers.d/nbosp"');
    expect(build).toContain('MAIN_SUDOERS="$OUTPUT_DIR/target/etc/sudoers"');
    expect(build).toContain("'^[#@]includedir[[:space:]]+/etc/sudoers.d");
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./usr/bin/sudo\'');
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./etc/sudoers\'');
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./etc/sudoers.d/nbosp\'');
    expect(build).toContain('$0 == "usr/bin/sudo"');
    expect(build).toContain('$0 == "etc/sudoers"');
    expect(build).toContain('$0 == "etc/sudoers.d/nbosp"');
  });

  it('keeps XWayland GLX GPU acceleration and checks render-node access', () => {
    const defconfig = readFileSync(new URL('../../os/configs/nbosp_x86_64_defconfig', import.meta.url), 'utf8');
    const kernel = readFileSync(new URL('../../os/board/nbosp/linux.fragment', import.meta.url), 'utf8');
    const prepareKiosk = readFileSync(
      new URL('../../os/package/nbosp-kiosk/prepare-kiosk.mjs', import.meta.url),
      'utf8',
    );
    const startup = readFileSync(new URL('../../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const users = readFileSync(new URL('../../os/board/nbosp/users.table', import.meta.url), 'utf8');

    for (const content of [prepareKiosk, startup]) {
      expect(content).toContain('--ozone-platform=x11');
      expect(content).toContain('--use-gl=angle');
      expect(content).toContain('--use-angle=gl');
      expect(content).not.toContain('--use-gl=desktop');
      expect(content).toContain('--disable-features=Vulkan');
      expect(content).toContain('--enable-gpu-rasterization');
      expect(content).toContain('--enable-zero-copy');
      expect(content).not.toContain('--disable-gpu');
    }
    expect(kernel).toContain('CONFIG_DRM_VMWGFX=y');
    expect(defconfig).toContain('BR2_PACKAGE_MESA3D_GALLIUM_DRIVER_SVGA=y');
    expect(build).toContain("-name 'vmwgfx_dri.so'");
    expect(build).toContain("Mesa's VMware SVGA DRI driver is missing");
    expect(users).toContain('video,input,seat');
    expect(users).toContain('- - render 60000 - - - - Render device access group');
    expect(users).toContain('video,input,seat,render');
    expect(build).toContain('tar -xOf "$OUTPUT_DIR/images/rootfs.tar" ./etc/group');
    expect(build).toContain('grep -Eq \'^render:[^:]*:[^:]*:\' <<<"$ROOTFS_GROUPS"');
    expect(build).toContain('grep -Eq \'^render:[^:]*:[^:]*:([^,]*,)*nbosp(,|$)\' <<<"$ROOTFS_GROUPS"');
    expect(build).toContain('$1 == "-" && $3 == "render" && $4 == "60000"');
    expect(build).toContain('split($8, groups, ",")');
    expect(build).toContain('The NBOSP user table does not grant the kiosk user render-group access.');
    expect(startup).toContain('/dev/dri/renderD*');
    expect(startup).toContain('hardware acceleration would fail');
    expect(startup).toContain('VMware vmwgfx kernel driver is active.');
    expect(startup).toContain('VMware vmwgfx kernel driver is not bound');
    expect(build).toContain('BR2_PACKAGE_LIBDRM_VMWGFX');
    expect(build).toContain('libdrm-dirclean');
    expect(build).toContain('options.get("vmwgfx") != "enabled"');
    expect(build).toContain("-name 'libdrm.so.2*'");
    expect(build).not.toContain('libdrm_vmwgfx.so');
  });

  it('builds ALSA drivers, utilities, device permissions, and mixer initialization', () => {
    const defconfig = readFileSync(new URL('../../os/configs/nbosp_x86_64_defconfig', import.meta.url), 'utf8');
    const kernel = readFileSync(new URL('../../os/board/nbosp/linux.fragment', import.meta.url), 'utf8');
    const startup = readFileSync(new URL('../../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const udevRules = readFileSync(
      new URL('../../os/board/nbosp/rootfs-overlay/etc/udev/rules.d/70-nbosp-device-groups.rules', import.meta.url),
      'utf8',
    );

    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_AMIXER=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY=y');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY');
    expect(build).toContain('alsa-utils-dirclean nbosp-kiosk-dirclean');
    expect(build).toContain('target/usr/sbin/alsactl');
    expect(build).toContain('target/usr/bin/amixer');
    expect(build).toContain('target/usr/bin/aplay');
    expect(build).toContain('OWNER="nbosp", GROUP="render"');
    expect(build).toContain('OWNER="nbosp", GROUP="audio"');
    expect(kernel).toContain('CONFIG_SND_HDA_INTEL=y');
    expect(kernel).toContain('CONFIG_SND_HDA_GENERIC=y');
    expect(kernel).toContain('CONFIG_SND_ENS1371=y');
    expect(udevRules).toContain('KERNEL=="renderD*", OWNER="nbosp", GROUP="render", MODE="0660"');
    expect(udevRules).toContain('SUBSYSTEM=="sound", OWNER="nbosp", GROUP="audio", MODE="0660"');
    expect(startup).toContain('amixer -q -c 0 sset "$control" 80% unmute');
    expect(startup).toContain('no supported playback mixer controls found');
    expect(startup).toContain('no ALSA sound card detected');
  });

  it('installs a secure DHCP autoconnect profile for the VMware Ethernet adapter', () => {
    const connection = readFileSync(
      new URL('../../os/board/nbosp/nbosp-wired.nmconnection', import.meta.url),
      'utf8',
    );
    const packageMakefile = readFileSync(
      new URL('../../os/package/nbosp-kiosk/nbosp-kiosk.mk', import.meta.url),
      'utf8',
    );
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');

    expect(connection).toContain('type=ethernet');
    expect(connection).toContain('autoconnect=true');
    expect(connection).toContain('method=auto');
    expect(packageMakefile).toContain('nbosp-wired.nmconnection');
    expect(packageMakefile).toContain('-m 0600');
    expect(build).toContain('WIRED_CONNECTION=');
    expect(build).toContain('The default DHCP-enabled VMware Ethernet connection');
  });

  it('keeps Chromium device scaling native in the XWayland kiosk', () => {
    const startup = readFileSync(new URL('../../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const settings = readFileSync(new URL('../../js/apps/settings/app.js', import.meta.url), 'utf8');
    const desktop = readFileSync(new URL('../../js/apps/shell-ui/desktop.js', import.meta.url), 'utf8');

    expect(startup).not.toContain('--force-device-scale-factor');
    expect(startup).not.toContain('display-scale');
    expect(settings).not.toContain('Display Scale');
    expect(desktop).not.toContain('displayScale');
  });

  it('waits for VMware DRM before starting the resolution-KMS daemon', () => {
    const vmtools = readFileSync(new URL('../../os/overrides/openvmtools/S10vmtoolsd', import.meta.url), 'utf8');
    const recipe = readFileSync(new URL('../../os/overrides/openvmtools/openvmtools.mk', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');

    expect(vmtools).toContain('wait_for_vmware_drm');
    expect(vmtools).toContain('udevadm settle --timeout=30');
    expect(vmtools).toContain('/sys/class/drm/card[0-9]*');
    expect(vmtools).toContain('= vmwgfx');
    expect(vmtools.indexOf('wait_for_vmware_drm;')).toBeLessThan(vmtools.indexOf('start-stop-daemon -S'));
    expect(recipe).toContain('--enable-resolutionkms');
    expect(build).toContain('.nbosp-openvmtools-signature');
    expect(build).toContain('openvmtools-dirclean');
    expect(build).toContain('S10vmtoolsd');
    expect(build).toContain('libresolutionKMS.so*');
  });

  it('ships GL bring-up debugging that can be switched off', () => {
    const defconfig = readFileSync(new URL('../../os/configs/nbosp_x86_64_defconfig', import.meta.url), 'utf8');
    const startup = readFileSync(new URL('../../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const cagePatch = readFileSync(
      new URL('../../os/patches/cage/0001-runtime-debug-logging.patch', import.meta.url),
      'utf8',
    );

    for (const option of [
      'BR2_PACKAGE_MESA3D_DEMOS=y',
      'BR2_PACKAGE_WAYLAND_UTILS=y',
      'BR2_PACKAGE_STRACE=y',
    ]) {
      expect(defconfig).toContain(option);
    }
    expect(defconfig).toContain('BR2_GLOBAL_PATCH_DIR="$(BR2_EXTERNAL_NBOSP_PATH)/patches"');
    expect(cagePatch).toContain('getenv("CAGE_DEBUG")');
    // GL debug is runtime-controlled: env override > kernel cmdline > off.
    expect(startup).toContain('if [ -z "$NBOSP_GL_DEBUG" ]; then');
    expect(startup).toContain('*NBOSP_GL_DEBUG=1*) NBOSP_GL_DEBUG=1 ;;');
    expect(startup).toContain('*)                  NBOSP_GL_DEBUG=0 ;;');
    expect(startup).toContain('WLR_XWAYLAND=/run/nbosp-debug-bin/Xwayland');
    expect(startup).toContain('-verbose 10');
    expect(startup).toContain('/home/nbosp/nbosp-gl-debug.log');
    expect(startup).toContain('$chromium_gl_debug');
    expect(startup).toContain("'\"$gl_debug_env\"'");
    // Debug mode must not change which GL backend Chromium asks for, and
    // cage's -d means "no client-side decorations", not debug.
    expect(startup).toContain('--use-angle=gl');
    expect(startup).not.toMatch(/\/usr\/bin\/cage -d/);
    expect(build).toContain("grep -v '^BR2_PACKAGE_MESA3D_DEMOS='");
    expect(build).toContain('cage-dirclean');
  });

  it('overrides Buildroot Xwayland with a build that works without wl_drm', () => {
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const mk = readFileSync(new URL('../../os/overrides/xwayland/xwayland.mk', import.meta.url), 'utf8');
    const hash = readFileSync(new URL('../../os/overrides/xwayland/xwayland.hash', import.meta.url), 'utf8');

    // 23.2.4 requires wl_drm, which wlroots 0.18 (cage) does not advertise.
    expect(mk).toMatch(/^XWAYLAND_VERSION = 24\.1\./m);
    expect(mk).not.toContain('xwayland_eglstream');
    expect(hash).toMatch(/sha256\s+[0-9a-f]{64}\s+xwayland-24\.1\./);
    expect(build).toContain('overrides/xwayland');
    expect(build).toContain('"$BUILDROOT_DIR/package/x11r7/xwayland/"');
    expect(build).toContain('"$XWAYLAND_OVERRIDE_DIR/xwayland.mk"');
  });
});
