import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('AstroOS VMware kiosk device configuration', () => {
  it('mounts procfs and sysfs before device discovery and desktop startup', () => {
    const mounts = readFileSync(
      new URL('../../os/board/astroos/rootfs-overlay/etc/init.d/S01mounts', import.meta.url),
      'utf8',
    );
    const procMount = 'mounted /proc || mount -t proc proc /proc';
    const sysfsMount = 'mounted /sys || mount -t sysfs sysfs /sys';
    const deviceMount = 'mounted /dev/pts || mount -t devpts';
    const tmpMount = 'mounted /tmp || mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp';

    expect(mounts).toContain('mkdir -p /proc /sys /dev/pts /dev/shm /tmp /run');
    expect(mounts.indexOf(procMount)).toBeGreaterThanOrEqual(0);
    expect(mounts.indexOf(procMount)).toBeLessThan(mounts.indexOf(sysfsMount));
    expect(mounts.indexOf(sysfsMount)).toBeGreaterThanOrEqual(0);
    expect(mounts.indexOf(sysfsMount)).toBeLessThan(mounts.indexOf(deviceMount));
    const runtimeMount = 'mounted /run || mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run';
    const runtimeDirectories = 'mkdir -p /run/lock/subsys /var/lock/subsys';
    expect(mounts.indexOf(tmpMount)).toBeGreaterThanOrEqual(0);
    expect(mounts.indexOf(tmpMount)).toBeLessThan(mounts.indexOf(runtimeMount));
    expect(mounts.indexOf(runtimeMount)).toBeLessThan(mounts.indexOf(runtimeDirectories));
    expect(mounts).toContain(runtimeDirectories);
  });

  it('seeds a runtime DNS file in /run so name resolution works before NetworkManager populates resolv.conf', () => {
    const networkScript = readFileSync(
      new URL('../../os/board/astroos/rootfs-overlay/etc/init.d/S41network', import.meta.url),
      'utf8',
    );

    expect(networkScript).toContain('mkdir -p /run');
    expect(networkScript).toContain('/run/resolv.conf');
    expect(networkScript).not.toContain('/tmp/resolv.conf');
    expect(networkScript).toContain('ln -sf /run/resolv.conf /etc/resolv.conf');
  });

  it('includes passwordless sudo in the booted root filesystem for NovaRoot', () => {
    const defconfig = readFileSync(new URL('../../os/configs/astroos_x86_64_defconfig', import.meta.url), 'utf8');
    const sudoers = readFileSync(
      new URL('../../os/board/astroos/rootfs-overlay/etc/sudoers.d/astroos', import.meta.url),
      'utf8',
    );
    const mainSudoers = readFileSync(
      new URL('../../os/board/astroos/rootfs-overlay/etc/sudoers', import.meta.url),
      'utf8',
    );
    const deviceTable = readFileSync(new URL('../../os/board/astroos/device_table.txt', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const postBuild = readFileSync(new URL('../../os/board/astroos/post-build.sh', import.meta.url), 'utf8');

    expect(defconfig).toContain('BR2_PACKAGE_SUDO=y');
    expect(sudoers).toContain('astroos ALL=(ALL) NOPASSWD: ALL');
    // The drop-in rule only takes effect when the main sudoers delegates to
    // /etc/sudoers.d — Buildroot's stock sudoers is not guaranteed to do so.
    expect(mainSudoers).toMatch(/^[#@]includedir\s+\/etc\/sudoers\.d\s*$/m);
    expect(deviceTable).toContain('/etc/sudoers\tf\t440\t0\t0');
    expect(deviceTable).toContain('/etc/sudoers.d/astroos\tf\t440\t0\t0');
    expect(postBuild).toContain('install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers"');
    expect(postBuild).toContain('"${TARGET_DIR}/etc/sudoers"');
    expect(postBuild).toContain('install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers.d/astroos"');
    expect(postBuild).toContain('"${TARGET_DIR}/etc/sudoers.d/astroos"');
    expect(build).toContain('BR2_PACKAGE_SUDO \\');
    expect(build).toContain('SUDO_BIN="$OUTPUT_DIR/target/usr/bin/sudo"');
    expect(build).toContain('SUDOERS_FILE="$OUTPUT_DIR/target/etc/sudoers.d/astroos"');
    expect(build).toContain('MAIN_SUDOERS="$OUTPUT_DIR/target/etc/sudoers"');
    expect(build).toContain("'^[#@]includedir[[:space:]]+/etc/sudoers.d");
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./usr/bin/sudo\'');
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./etc/sudoers\'');
    expect(build).toContain('tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx \'./etc/sudoers.d/astroos\'');
    expect(build).toContain('$0 == "usr/bin/sudo"');
    expect(build).toContain('$0 == "etc/sudoers"');
    expect(build).toContain('$0 == "etc/sudoers.d/astroos"');
  });

  it('keeps XWayland GLX GPU acceleration and checks render-node access', () => {
    const defconfig = readFileSync(new URL('../../os/configs/astroos_x86_64_defconfig', import.meta.url), 'utf8');
    const kernel = readFileSync(new URL('../../os/board/astroos/linux.fragment', import.meta.url), 'utf8');
    const prepareKiosk = readFileSync(
      new URL('../../os/package/astroos-kiosk/prepare-kiosk.mjs', import.meta.url),
      'utf8',
    );
    const startup = readFileSync(new URL('../../os/board/astroos/S99astroos', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const users = readFileSync(new URL('../../os/board/astroos/users.table', import.meta.url), 'utf8');

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
    expect(build).toContain('grep -Eq \'^render:[^:]*:[^:]*:([^,]*,)*astroos(,|$)\' <<<"$ROOTFS_GROUPS"');
    expect(build).toContain('$1 == "-" && $3 == "render" && $4 == "60000"');
    expect(build).toContain('split($8, groups, ",")');
    expect(build).toContain('The AstroOS user table does not grant the kiosk user render-group access.');
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
    const defconfig = readFileSync(new URL('../../os/configs/astroos_x86_64_defconfig', import.meta.url), 'utf8');
    const kernel = readFileSync(new URL('../../os/board/astroos/linux.fragment', import.meta.url), 'utf8');
    const startup = readFileSync(new URL('../../os/board/astroos/S99astroos', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const udevRules = readFileSync(
      new URL('../../os/board/astroos/rootfs-overlay/etc/udev/rules.d/70-astroos-device-groups.rules', import.meta.url),
      'utf8',
    );

    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_AMIXER=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY=y');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY');
    expect(build).toContain('alsa-utils-dirclean astroos-kiosk-dirclean');
    expect(build).toContain('target/usr/sbin/alsactl');
    expect(build).toContain('target/usr/bin/amixer');
    expect(build).toContain('target/usr/bin/aplay');
    expect(build).toContain('OWNER="astroos", GROUP="render"');
    expect(build).toContain('OWNER="astroos", GROUP="audio"');
    expect(kernel).toContain('CONFIG_SND_HDA_INTEL=y');
    expect(kernel).toContain('CONFIG_SND_HDA_GENERIC=y');
    expect(kernel).toContain('CONFIG_SND_ENS1371=y');
    expect(udevRules).toContain('KERNEL=="renderD*", OWNER="astroos", GROUP="render", MODE="0660"');
    expect(udevRules).toContain('SUBSYSTEM=="sound", OWNER="astroos", GROUP="audio", MODE="0660"');
    expect(startup).toContain('amixer -q -c 0 sset "$control" 80% unmute');
    expect(startup).toContain('no supported playback mixer controls found');
    expect(startup).toContain('no ALSA sound card detected');
  });

  it('installs a secure DHCP autoconnect profile for the VMware Ethernet adapter', () => {
    const connection = readFileSync(
      new URL('../../os/board/astroos/astroos-wired.nmconnection', import.meta.url),
      'utf8',
    );
    const packageMakefile = readFileSync(
      new URL('../../os/package/astroos-kiosk/astroos-kiosk.mk', import.meta.url),
      'utf8',
    );
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');

    expect(connection).toContain('type=ethernet');
    expect(connection).toContain('autoconnect=true');
    expect(connection).toContain('method=auto');
    expect(packageMakefile).toContain('astroos-wired.nmconnection');
    expect(packageMakefile).toContain('-m 0600');
    expect(build).toContain('WIRED_CONNECTION=');
    expect(build).toContain('The default DHCP-enabled VMware Ethernet connection');
  });

  it('keeps Chromium device scaling native in the XWayland kiosk', () => {
    const startup = readFileSync(new URL('../../os/board/astroos/S99astroos', import.meta.url), 'utf8');
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
    expect(build).toContain('.astroos-openvmtools-signature');
    expect(build).toContain('openvmtools-dirclean');
    expect(build).toContain('S10vmtoolsd');
    expect(build).toContain('libresolutionKMS.so*');
  });

  it('ships GL bring-up debugging that can be switched off', () => {
    const defconfig = readFileSync(new URL('../../os/configs/astroos_x86_64_defconfig', import.meta.url), 'utf8');
    const startup = readFileSync(new URL('../../os/board/astroos/S99astroos', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');

    for (const option of [
      'BR2_PACKAGE_MESA3D_DEMOS=y',
      'BR2_PACKAGE_WAYLAND_UTILS=y',
      'BR2_PACKAGE_STRACE=y',
    ]) {
      expect(defconfig).toContain(option);
    }
    expect(defconfig).toContain('BR2_GLOBAL_PATCH_DIR="$(BR2_EXTERNAL_ASTROOS_PATH)/patches"');
    // GL debug is runtime-controlled: env override > kernel cmdline > off.
    expect(startup).toContain('if [ -z "$ASTROOS_GL_DEBUG" ]; then');
    expect(startup).toContain('*ASTROOS_GL_DEBUG=1*) ASTROOS_GL_DEBUG=1 ;;');
    expect(startup).toContain('*)                  ASTROOS_GL_DEBUG=0 ;;');
    expect(startup).toContain('WLR_XWAYLAND=/run/astroos-debug-bin/Xwayland');
    expect(startup).toContain('-verbose 10');
    // GL debug output is machine state under /var/log/astroos — never in the
    // kiosk user's home (the home root is the system area: ~/users trees +
    // hidden dot-state only).
    expect(startup).toContain('astroos_log_dir=/var/log/astroos');
    expect(startup).toContain('GL_DEBUG_LOG="$astroos_log_dir/gl-debug.log"');
    expect(startup).not.toContain('/home/astroos/astroos-gl-debug.log');
    expect(startup).not.toContain('/home/astroos/astroos-kiosk.log');
    expect(startup).toContain('$chromium_gl_debug');
    expect(startup).toContain("'\"$gl_debug_env\"'");
    // Debug mode must not change which GL backend Chromium asks for, and
    // labwc gets debug logging via its own -d flag (no patch needed, unlike
    // the retired cage setup whose -d meant "no client-side decorations").
    expect(startup).toContain('--use-angle=gl');
    expect(startup).toContain('labwc_debug_flag="-d"');
    expect(startup).toContain('exec /usr/bin/labwc $labwc_debug_flag -C /etc/labwc');
    expect(build).toContain("grep -v '^BR2_PACKAGE_MESA3D_DEMOS='");
    expect(build).toContain('labwc-dirclean');
  });

  it('uses Buildroot 2026.08.1 stock Xwayland and overrides wlroots for labwc', () => {
    const build = readFileSync(new URL('../../os/build-iso.sh', import.meta.url), 'utf8');
    const defconfig = readFileSync(new URL('../../os/configs/astroos_x86_64_defconfig', import.meta.url), 'utf8');
    const wlrootsMk = readFileSync(new URL('../../os/overrides/wlroots/wlroots.mk', import.meta.url), 'utf8');
    const wlrootsPatch = readFileSync(
      new URL('../../os/patches/wlroots/0001-dmabuf-tolerate-close-handle-failure.patch', import.meta.url),
      'utf8',
    );

    // Buildroot 2026.08.1 ships Xwayland 24.1.13 with a wl_drm-free glamor
    // fix already included, so the old xwayland override is gone; wlroots is
    // overridden to 0.20.2 because labwc 0.20.3 requires >= 0.20.1.
    expect(build).toContain('BUILDROOT_VERSION="2026.08.1"');
    expect(build).not.toContain('overrides/xwayland');
    expect(build).not.toContain('overrides/host-m4');
    expect(build).toContain('overrides/wlroots');
    expect(build).toContain('"$BUILDROOT_DIR/package/wlroots/"');
    expect(wlrootsMk).toMatch(/^WLROOTS_VERSION = 0\.20\.2$/m);
    // The vmwgfx dmabuf close-handle tolerance patch is rebased for 0.20.x:
    // close-handle failure is only logged (WLR_DEBUG), never fatal.
    expect(wlrootsPatch).toContain('drmCloseBufferHandle');
    expect(wlrootsPatch).toContain('wlr_log_errno(WLR_DEBUG');
    expect(wlrootsPatch).not.toContain('+\t\t\treturn false');
    expect(defconfig).toContain('BR2_PACKAGE_LABWC=y');
    expect(defconfig).toContain('BR2_LINUX_KERNEL_CUSTOM_VERSION_VALUE="7.3.4"');
  });
});
