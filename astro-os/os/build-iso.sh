#!/usr/bin/env bash
set -euo pipefail

OS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILDROOT_VERSION="2026.08.1"
BUILDROOT_DIR="$OS_DIR/.buildroot/buildroot-$BUILDROOT_VERSION"
DOWNLOAD_DIR="$OS_DIR/.downloads"
ARCHIVE="$DOWNLOAD_DIR/buildroot-$BUILDROOT_VERSION.tar.xz"
OUTPUT_DIR="$OS_DIR/output"
NWJS_APP_DIR="$OS_DIR/package/astroos-kiosk/source"
JOBS="${JOBS:-$(nproc)}"

mkdir -p "$DOWNLOAD_DIR" "$OS_DIR/.buildroot"

# Host tools (m4, gmp, ...) are built with the runner's gcc. Recent gcc releases
# default to C23, where old K&R-style configure probes and gnulib attribute
# placement fail ("could not find a working compiler" in host-gmp, nodiscard in
# host-m4). Pin host C to gnu17 through a wrapper: Buildroot resolves HOSTCC with
# `which`, so flags can't go in the variable itself. Flags a package passes later
# on its own command line still win over this one.
HOST_WRAPPER_DIR="$OS_DIR/.buildroot/host-wrappers"
REAL_HOSTCC="$(command -v "${HOSTCC:-gcc}")"
case "$REAL_HOSTCC" in "$HOST_WRAPPER_DIR"/*) REAL_HOSTCC="$(PATH="${PATH//$HOST_WRAPPER_DIR:/}" command -v gcc)";; esac
mkdir -p "$HOST_WRAPPER_DIR"
printf '#!/bin/sh\nexec "%s" -std=gnu17 "$@"\n' "$REAL_HOSTCC" > "$HOST_WRAPPER_DIR/gcc"
chmod +x "$HOST_WRAPPER_DIR/gcc"
export HOSTCC="$HOST_WRAPPER_DIR/gcc"
echo "Host compiler: $("$REAL_HOSTCC" --version | head -n1) (forced -std=gnu17)" >&2

if [[ ! -d "$BUILDROOT_DIR" ]]; then
  if [[ ! -f "$ARCHIVE" ]]; then
    curl --fail --location --retry 3 \
      "https://buildroot.org/downloads/buildroot-$BUILDROOT_VERSION.tar.xz" \
      --output "$ARCHIVE"
  fi
  mkdir -p "$BUILDROOT_DIR"
  tar -xJf "$ARCHIVE" --strip-components=1 -C "$BUILDROOT_DIR"
fi

# Buildroot 2026.08 ships wlroots 0.20.0, but labwc 0.20.3 requires wlroots
# >= 0.20.1. Copy in Buildroot master's wlroots recipe (0.20.2) on every run
# because the extracted Buildroot tree is cached.
WLROOTS_OVERRIDE_DIR="$OS_DIR/overrides/wlroots"
cp "$WLROOTS_OVERRIDE_DIR/wlroots.mk" "$WLROOTS_OVERRIDE_DIR/wlroots.hash" \
  "$BUILDROOT_DIR/package/wlroots/"

# Buildroot 2026.08 ships open-vm-tools 11.3.5 built --without-x, which drops the
# drag and drop and clipboard plugins, and whose configure needs libfuse2 for
# vmhgfs-fuse (this image only has libfuse3). The override is the 13.1.0 recipe
# from Buildroot master plus a DESKTOP option. Its patches replace the old
# ones; leftover 11.3.5 patches would fail to apply, so they are removed first.
OPENVMTOOLS_OVERRIDE_DIR="$OS_DIR/overrides/openvmtools"
OPENVMTOOLS_PKG_DIR="$BUILDROOT_DIR/package/openvmtools"
rm -f "$OPENVMTOOLS_PKG_DIR"/*.patch
cp "$OPENVMTOOLS_OVERRIDE_DIR"/patches/*.patch "$OPENVMTOOLS_PKG_DIR/"
cp "$OPENVMTOOLS_OVERRIDE_DIR/Config.in" "$OPENVMTOOLS_OVERRIDE_DIR/openvmtools.mk" \
  "$OPENVMTOOLS_OVERRIDE_DIR/openvmtools.hash" "$OPENVMTOOLS_OVERRIDE_DIR/S10vmtoolsd" \
  "$OPENVMTOOLS_OVERRIDE_DIR/shutdown" "$OPENVMTOOLS_OVERRIDE_DIR/vmtoolsd.service" \
  "$OPENVMTOOLS_PKG_DIR/"

if [[ ! -x "$NWJS_APP_DIR/AstroOS" || ! -f "$NWJS_APP_DIR/package.nw/package.json" ]]; then
  echo "Linux NW.js kiosk bundle missing. Run the workflow app build/staging steps first." >&2
  exit 1
fi

if [[ -f "$OUTPUT_DIR/.config" ]] \
  && grep -Eq '^BR2_PACKAGE_(REFPOLICY|WESTON)=y$' "$OUTPUT_DIR/.config"; then
  echo "Removing cached output from the retired SELinux and Weston sandbox experiments." >&2
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" clean
fi
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" astroos_x86_64_defconfig
for option in \
  BR2_TOOLCHAIN_BUILDROOT \
  BR2_PACKAGE_HOST_LINUX_HEADERS_CUSTOM_7_1 \
  BR2_TOOLCHAIN_BUILDROOT_GLIBC \
  BR2_TOOLCHAIN_BUILDROOT_CXX \
  BR2_INSTALL_LIBSTDCPP \
  BR2_SHARED_LIBS \
  BR2_TOOLCHAIN_HAS_THREADS_NPTL \
  BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV \
  BR2_PACKAGE_EUDEV \
  BR2_PACKAGE_LIBGTK3 \
  BR2_PACKAGE_LIBGTK3_WAYLAND \
  BR2_PACKAGE_LIBGTK3_X11 \
  BR2_PACKAGE_LIBNSS \
  BR2_PACKAGE_LIBNSPR \
  BR2_PACKAGE_CA_CERTIFICATES \
  BR2_PACKAGE_OPENSSL \
  BR2_PACKAGE_LIBCURL \
  BR2_PACKAGE_LIBCURL_CURL \
  BR2_PACKAGE_LIBCURL_OPENSSL \
  BR2_PACKAGE_FONTCONFIG \
  BR2_PACKAGE_NOTO_EMOJI \
  BR2_PACKAGE_DEJAVU \
  BR2_PACKAGE_DEJAVU_SANS \
  BR2_PACKAGE_DEJAVU_MONO \
  BR2_PACKAGE_ALSA_LIB \
  BR2_PACKAGE_ALSA_UTILS \
  BR2_PACKAGE_ALSA_UTILS_ALSACTL \
  BR2_PACKAGE_ALSA_UTILS_AMIXER \
  BR2_PACKAGE_ALSA_UTILS_APLAY \
  BR2_PACKAGE_LIBDRM_VMWGFX \
  BR2_PACKAGE_XORGPROTO \
  BR2_PACKAGE_LIBGLVND \
  BR2_PACKAGE_LIBEPOXY \
  BR2_PACKAGE_LABWC \
  BR2_PACKAGE_WLROOTS_XWAYLAND \
  BR2_PACKAGE_XWAYLAND \
  BR2_PACKAGE_SEATD_DAEMON \
  BR2_PACKAGE_DBUS \
  BR2_PACKAGE_NETWORK_MANAGER \
  BR2_PACKAGE_NETWORK_MANAGER_CLI \
  BR2_PACKAGE_POLKIT \
  BR2_PACKAGE_WPA_SUPPLICANT \
  BR2_PACKAGE_WPA_SUPPLICANT_NL80211 \
  BR2_PACKAGE_BLUEZ5_UTILS \
  BR2_PACKAGE_BLUEZ5_UTILS_CLIENT \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_AUDIO \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_HID \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_HOG \
  BR2_PACKAGE_LINUX_FIRMWARE \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_6E \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_9XXX \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_22000 \
  BR2_PACKAGE_XKEYBOARD_CONFIG \
  BR2_PACKAGE_XDATA_XCURSOR_THEMES \
  BR2_PACKAGE_LIBARCHIVE \
  BR2_PACKAGE_LIBARCHIVE_BSDTAR \
  BR2_PACKAGE_SUDO \
  BR2_PACKAGE_UTIL_LINUX_LIBUUID \
  BR2_PACKAGE_OPENVMTOOLS \
  BR2_PACKAGE_OPENVMTOOLS_RESOLUTIONKMS \
  BR2_PACKAGE_OPENVMTOOLS_DESKTOP \
  BR2_PACKAGE_MESA3D_OPENGL_EGL \
  BR2_PACKAGE_MESA3D_OPENGL_ES \
  BR2_PACKAGE_MESA3D_OPENGL_GLX \
  BR2_PACKAGE_MESA3D_GBM \
  BR2_PACKAGE_MESA3D_GALLIUM_DRIVER_SVGA \
  BR2_PACKAGE_ASTROOS_KIOSK \
  BR2_PACKAGE_ASTROOS_POWER \
  BR2_PACKAGE_ASTROOS_INSTALL \
  BR2_PACKAGE_DOSFSTOOLS \
  BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT \
  BR2_PACKAGE_E2FSPROGS \
  BR2_PACKAGE_UTIL_LINUX_BINARIES \
  BR2_TARGET_GRUB2 \
  BR2_TARGET_GRUB2_I386_PC \
  BR2_TARGET_GRUB2_X86_64_EFI \
  BR2_TARGET_GRUB2_INSTALL_TOOLS \
  BR2_TARGET_ROOTFS_TAR
do
  if ! grep -qx "$option=y" "$OUTPUT_DIR/.config"; then
    echo "Required Buildroot option was not enabled: $option" >&2
    exit 1
  fi
done

if ! grep -q '^BR2_ROOTFS_OVERLAY=.*board/astroos/rootfs-overlay' "$OUTPUT_DIR/.config"; then
  echo "AstroOS root filesystem overlay is not configured." >&2
  exit 1
fi

if grep -qx "BR2_PACKAGE_NODEJS=y" "$OUTPUT_DIR/.config"; then
  echo "Buildroot Node.js must stay disabled; the kiosk uses NW.js's bundled Node runtime." >&2
  exit 1
fi

CURL_TLS_SIGNATURE_FILE="$OUTPUT_DIR/.astroos-curl-tls-signature"
CURL_TLS_SIGNATURE="$(
  grep -E '^BR2_PACKAGE_(LIBCURL|OPENSSL)(_|=)' "$OUTPUT_DIR/.config" \
    | sha256sum | cut -d ' ' -f 1
)"
if [[ ! -f "$CURL_TLS_SIGNATURE_FILE" ]] \
  || [[ "$(cat "$CURL_TLS_SIGNATURE_FILE")" != "$CURL_TLS_SIGNATURE" ]]; then
  echo "cURL TLS configuration changed; rebuilding libcurl."
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" libcurl-dirclean
  printf '%s\n' "$CURL_TLS_SIGNATURE" > "$CURL_TLS_SIGNATURE_FILE"
fi

GRAPHICS_SIGNATURE_FILE="$OUTPUT_DIR/.astroos-graphics-signature"
GRAPHICS_SIGNATURE="$(
  {
    printf '%s\n' 'astroos-graphics-stack-v5'
    cat "$WLROOTS_OVERRIDE_DIR/wlroots.mk" "$WLROOTS_OVERRIDE_DIR/wlroots.hash" \
      "$OS_DIR/patches/wlroots/0001-dmabuf-tolerate-close-handle-failure.patch"
    # mesa3d-demos only adds debug tools; it must not force a Mesa/XWayland rebuild.
    grep -E '^BR2_PACKAGE_(LABWC|WLROOTS_XWAYLAND|XWAYLAND|XORGPROTO|LIBDRM|LIBGLVND|LIBEPOXY|MESA3D)(_|=)' "$OUTPUT_DIR/.config" \
      | grep -v '^BR2_PACKAGE_MESA3D_DEMOS='
  } | sha256sum | cut -d ' ' -f 1
)"
XWAYLAND_SOURCE_DIR_EARLY="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'xwayland-*' -print -quit 2>/dev/null || true)"
XWAYLAND_BUILD_OPTIONS_EARLY=""
if [[ -n "$XWAYLAND_SOURCE_DIR_EARLY" ]]; then
  XWAYLAND_BUILD_OPTIONS_EARLY="$(find "$XWAYLAND_SOURCE_DIR_EARLY" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit 2>/dev/null || true)"
fi
LIBDRM_SOURCE_DIR_EARLY="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'libdrm-*' -print -quit 2>/dev/null || true)"
LIBDRM_BUILD_OPTIONS_EARLY=""
if [[ -n "$LIBDRM_SOURCE_DIR_EARLY" ]]; then
  LIBDRM_BUILD_OPTIONS_EARLY="$(find "$LIBDRM_SOURCE_DIR_EARLY" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit 2>/dev/null || true)"
fi
if [[ ! -f "$GRAPHICS_SIGNATURE_FILE" ]] \
  || [[ "$(cat "$GRAPHICS_SIGNATURE_FILE")" != "$GRAPHICS_SIGNATURE" ]] \
  || [[ -z "$XWAYLAND_BUILD_OPTIONS_EARLY" ]] \
  || [[ -z "$LIBDRM_BUILD_OPTIONS_EARLY" ]]; then
  echo "Graphics configuration changed or graphics build incomplete; rebuilding Mesa, libglvnd, libdrm, and XWayland."
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    xwayland-dirclean libglvnd-dirclean mesa3d-dirclean libdrm-dirclean
  printf '%s\n' "$GRAPHICS_SIGNATURE" > "$GRAPHICS_SIGNATURE_FILE"
fi

# gdk's X11 backend includes <epoxy/glx.h>, which libepoxy only installs when
# it was configured with GLX (X11 + libgl present at build time). A cached
# libepoxy from before XORG7/LIBGLVND were enabled lacks it, and libgtk3 then
# dies in gdkdisplay-x11.c. Rebuild libepoxy first, then gtk3 on top of it.
EPOXY_GLX_H="$OUTPUT_DIR/host/x86_64-buildroot-linux-gnu/sysroot/usr/include/epoxy/glx.h"
if grep -qx "BR2_PACKAGE_LIBEPOXY=y" "$OUTPUT_DIR/.config" \
  && grep -qx "BR2_PACKAGE_XORG7=y" "$OUTPUT_DIR/.config" \
  && [[ ! -f "$EPOXY_GLX_H" ]]; then
  echo "Cached libepoxy lacks GLX support; rebuilding libepoxy, libgtk3, gtkmm3 and openvmtools." >&2
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    openvmtools-dirclean gtkmm3-dirclean libgtk3-dirclean libepoxy-dirclean
fi

# openvmtools' desktop plugins need gtk3 with the X11 backend, and gtkmm3 is
# configured with -Dbuild-x11-api=true to match. Buildroot never rebuilds a
# package when its config changes, so a cached gtk3 from before that option
# was enabled stays Wayland-only and gtkmm3 fails at configure time with
# "Requested X11 backend not supported by installed gdk".
GDK_X11_PC="$OUTPUT_DIR/host/x86_64-buildroot-linux-gnu/sysroot/usr/lib/pkgconfig/gdk-x11-3.0.pc"
if grep -qx "BR2_PACKAGE_LIBGTK3_X11=y" "$OUTPUT_DIR/.config" && [[ ! -f "$GDK_X11_PC" ]]; then
  echo "Cached gtk3 lacks the X11 backend; rebuilding libgtk3, gtkmm3 and openvmtools." >&2
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    openvmtools-dirclean gtkmm3-dirclean libgtk3-dirclean
fi

OPENVMTOOLS_SIGNATURE_FILE="$OUTPUT_DIR/.astroos-openvmtools-signature"
OPENVMTOOLS_SIGNATURE="$(
  {
    printf '%s\n' 'astroos-openvmtools-kms-v1'
    cat "$OPENVMTOOLS_OVERRIDE_DIR/Config.in" "$OPENVMTOOLS_OVERRIDE_DIR/openvmtools.mk" \
      "$OPENVMTOOLS_OVERRIDE_DIR/openvmtools.hash" "$OPENVMTOOLS_OVERRIDE_DIR/S10vmtoolsd"
    grep -E '^BR2_PACKAGE_(OPENVMTOOLS|EUDEV|LIBDRM)(_|=)' "$OUTPUT_DIR/.config"
  } | sha256sum | cut -d ' ' -f 1
)"
if [[ ! -f "$OPENVMTOOLS_SIGNATURE_FILE" ]] \
  || [[ "$(cat "$OPENVMTOOLS_SIGNATURE_FILE")" != "$OPENVMTOOLS_SIGNATURE" ]]; then
  echo "VMware Tools configuration changed; rebuilding open-vm-tools."
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" openvmtools-dirclean
  printf '%s\n' "$OPENVMTOOLS_SIGNATURE" > "$OPENVMTOOLS_SIGNATURE_FILE"
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
  alsa-utils-dirclean astroos-kiosk-dirclean astroos-install-dirclean astroos-power-dirclean \
  wlroots-dirclean labwc-dirclean
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" toolchain
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" mesa3d-extract
MESA3D_VERSION="$(sed -n 's/^MESA3D_VERSION = //p' "$BUILDROOT_DIR/package/mesa3d/mesa3d.mk")"
MESA_DRI_INTERFACE="$OUTPUT_DIR/build/mesa3d-$MESA3D_VERSION/include/GL/internal/dri_interface.h"
STAGING_DRI_INTERFACE="$OUTPUT_DIR/host/x86_64-buildroot-linux-gnu/sysroot/usr/include/GL/internal/dri_interface.h"
if [[ ! -f "$MESA_DRI_INTERFACE" ]]; then
  echo "Mesa's XWayland DRI interface header is missing: $MESA_DRI_INTERFACE" >&2
  exit 1
fi
install -D -m 0644 "$MESA_DRI_INTERFACE" "$STAGING_DRI_INTERFACE"
if [[ ! -x "$OUTPUT_DIR/target/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/sbin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/lsblk" \
  || ! -x "$OUTPUT_DIR/target/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/sbin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/sfdisk" ]]; then
  echo "Cached util-linux output lacks lsblk or sfdisk; rebuilding util-linux." >&2
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    util-linux-dirclean
fi
# The ISO boots from the initramfs, so don't trust a cached filesystem image.
rm -f "$OUTPUT_DIR/images/rootfs.cpio" \
  "$OUTPUT_DIR/images/rootfs.cpio.gz" \
  "$OUTPUT_DIR/images/rootfs.tar"
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" -j"$JOBS"

SYSTEM_INIT_APPLET="$OUTPUT_DIR/target/sbin/init"
SYSTEM_INIT="$OUTPUT_DIR/target/etc/init.d/rcS"
SYSTEM_SHELL="$OUTPUT_DIR/target/bin/sh"

for executable in "$SYSTEM_INIT_APPLET" "$SYSTEM_INIT"; do
  if [[ ! -x "$executable" ]]; then
    echo "Required AstroOS boot executable is missing or not executable: $executable" >&2
    exit 1
  fi
done
if ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" ./sbin/init >/dev/null 2>&1; then
  echo "Buildroot's original init applet is missing from the generated rootfs." >&2
  exit 1
fi
if ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" \
  ./etc/inittab ./etc/init.d/rcS >/dev/null 2>&1; then
  echo "BusyBox init configuration or system startup script is missing from the generated rootfs." >&2
  exit 1
fi
if ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" ./bin/sh >/dev/null 2>&1; then
  echo "BusyBox /bin/sh is missing from the generated rootfs." >&2
  exit 1
fi
SUDO_BIN="$OUTPUT_DIR/target/usr/bin/sudo"
SUDOERS_FILE="$OUTPUT_DIR/target/etc/sudoers.d/astroos"
MAIN_SUDOERS="$OUTPUT_DIR/target/etc/sudoers"
if [[ ! -x "$SUDO_BIN" \
  || ! -f "$SUDOERS_FILE" \
  || "$(stat -c '%a' "$SUDOERS_FILE")" != "440" ]] \
  || ! grep -Fqx 'astroos ALL=(ALL) NOPASSWD: ALL' "$SUDOERS_FILE"; then
  echo "The target image is missing sudo or its passwordless AstroOS sudoers rule." >&2
  exit 1
fi
# The drop-in rule is only effective when the main sudoers file delegates to
# /etc/sudoers.d. Buildroot's stock sudoers is not guaranteed to carry the
# directive (the AstroOS overlay ships one that does — this is the guard).
if [[ ! -f "$MAIN_SUDOERS" \
  || "$(stat -c '%a' "$MAIN_SUDOERS")" != "440" ]] \
  || ! grep -Eq '^[#@]includedir[[:space:]]+/etc/sudoers.d([[:space:]]|$)' "$MAIN_SUDOERS"; then
  echo "The target image's /etc/sudoers is missing or does not include /etc/sudoers.d; the AstroOS drop-in rule would be ignored." >&2
  exit 1
fi
if ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx './usr/bin/sudo' >/dev/null \
  || ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx './etc/sudoers' >/dev/null \
  || ! tar -tf "$OUTPUT_DIR/images/rootfs.tar" | grep -Fx './etc/sudoers.d/astroos' >/dev/null; then
  echo "sudo or the AstroOS sudoers rules are missing from the generated rootfs archive." >&2
  exit 1
fi
KERNEL_CONFIG="$(find "$OUTPUT_DIR/build" -maxdepth 2 -type f -path '*/linux-*/.config' -print -quit)"
if [[ -z "$KERNEL_CONFIG" ]]; then
  echo "The built Linux kernel configuration is missing." >&2
  exit 1
fi
for option in \
  CONFIG_DRM_VMWGFX \
  CONFIG_SND_HDA_INTEL \
  CONFIG_SND_HDA_GENERIC \
  CONFIG_SND_HDA_CODEC_REALTEK \
  CONFIG_SND_ENS1371
do
  if ! grep -qx "$option=y" "$KERNEL_CONFIG"; then
    echo "Required kernel security, graphics, or audio option is missing: $option" >&2
    exit 1
  fi
done

if [[ ! -x "$OUTPUT_DIR/target/usr/bin/labwc" ]]; then
  echo "labwc compositor is missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/etc/labwc/rc.xml" ]]; then
  echo "labwc kiosk configuration is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/Xwayland" ]]; then
  echo "XWayland is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/amixer" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/alsactl" \
  || ! -x "$OUTPUT_DIR/target/usr/bin/aplay" ]]; then
  echo "ALSA mixer, control, and playback utilities are missing from the target image." >&2
  exit 1
fi
ROOTFS_GROUPS="$(tar -xOf "$OUTPUT_DIR/images/rootfs.tar" ./etc/group)" || {
  echo "Could not read /etc/group from the generated rootfs.tar image." >&2
  exit 1
}
if ! grep -Eq '^render:[^:]*:[^:]*:' <<<"$ROOTFS_GROUPS"; then
  echo "The render group is missing from /etc/group in the generated rootfs.tar image:" >&2
  printf '%s\n' "$ROOTFS_GROUPS" >&2
  exit 1
fi
if ! grep -Eq '^render:[^:]*:[^:]*:([^,]*,)*astroos(,|$)' <<<"$ROOTFS_GROUPS"; then
  echo "The kiosk user is missing from the render group in /etc/group in the generated rootfs.tar image:" >&2
  printf '%s\n' "$ROOTFS_GROUPS" >&2
  exit 1
fi
if ! awk '$1 == "-" && $3 == "render" && $4 == "60000" { found = 1 } END { exit !found }' \
  "$OS_DIR/board/astroos/users.table"; then
  echo "The AstroOS user table does not define render with the reserved GID 60000." >&2
  exit 1
fi
if ! awk '$1 == "astroos" { count = split($8, groups, ","); for (i = 1; i <= count; i++) if (groups[i] == "render") found = 1 } END { exit !found }' \
  "$OS_DIR/board/astroos/users.table"; then
  echo "The AstroOS user table does not grant the kiosk user render-group access." >&2
  exit 1
fi
UDEV_DEVICE_RULES="$OUTPUT_DIR/target/etc/udev/rules.d/70-astroos-device-groups.rules"
if [[ ! -f "$UDEV_DEVICE_RULES" ]] \
  || ! grep -Fq 'KERNEL=="renderD*", OWNER="astroos", GROUP="render", MODE="0660"' "$UDEV_DEVICE_RULES" \
  || ! grep -Fq 'SUBSYSTEM=="sound", OWNER="astroos", GROUP="audio", MODE="0660"' "$UDEV_DEVICE_RULES"; then
  echo "udev rules granting the kiosk user access to GPU and audio devices are missing." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/nmcli" \
  || ! -x "$OUTPUT_DIR/target/usr/bin/bluetoothctl" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/NetworkManager" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/wpa_supplicant" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S40bluetoothd" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S45NetworkManager" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S50polkitd" \
  || ! -f "$OUTPUT_DIR/target/etc/polkit-1/rules.d/50-astroos-connectivity.rules" ]]; then
  echo "NetworkManager, Bluetooth control, or AstroOS connectivity authorization is missing from the target image." >&2
  exit 1
fi
WIRED_CONNECTION="$OUTPUT_DIR/target/etc/NetworkManager/system-connections/astroos-wired.nmconnection"
if [[ ! -f "$WIRED_CONNECTION" ]] \
  || ! grep -Fqx 'autoconnect=true' "$WIRED_CONNECTION" \
  || ! grep -Fqx 'method=auto' "$WIRED_CONNECTION" \
  || [[ "$(stat -c '%a' "$WIRED_CONNECTION")" != "600" ]]; then
  echo "The default DHCP-enabled VMware Ethernet connection is missing or has unsafe permissions." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/Xwayland" ]]; then
  echo "XWayland was enabled but /usr/bin/Xwayland is missing from the target image." >&2
  exit 1
fi
XWAYLAND_SOURCE_DIR="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'xwayland-*' -print -quit)"
XWAYLAND_BUILD_OPTIONS=""
if [[ -n "$XWAYLAND_SOURCE_DIR" ]]; then
  XWAYLAND_BUILD_OPTIONS="$(find "$XWAYLAND_SOURCE_DIR" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit)"
fi
if [[ -z "$XWAYLAND_BUILD_OPTIONS" ]]; then
  echo "XWayland Meson build options are missing; cannot verify GLX and glamor support." >&2
  exit 1
fi
python3 - "$XWAYLAND_BUILD_OPTIONS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as options_file:
    options = {item["name"]: item["value"] for item in json.load(options_file)}

missing = [name for name in ("glx", "glamor") if options.get(name) is not True]
if missing:
    raise SystemExit(
        "XWayland must be built with GLX and glamor enabled; disabled: "
        + ", ".join(missing)
    )
PY
# Mesa 24.2+ installs the per-driver *_dri.so names as symlinks to libdril_dri.so,
# so -type f alone misses them.
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'vmwgfx_dri.so' -print -quit | grep -q .; then
  echo "Mesa's VMware SVGA DRI driver is missing from the target image." >&2
  echo "What Mesa actually installed (for debugging):" >&2
  find "$OUTPUT_DIR/target/usr/lib" \( -name '*_dri.so' -o -name 'libdril*' -o -name 'libgallium*' \) -ls >&2 || true
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libGLX_mesa.so*' -print -quit | grep -q .; then
  echo "Mesa GLX support is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libGL.so.1*' -print -quit | grep -q .; then
  echo "The OpenGL libGL.so.1 dispatch library is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libgbm.so*' -print -quit | grep -q .; then
  echo "Mesa GBM is missing from the target image; XWayland glamor cannot initialize without it." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libepoxy.so*' -print -quit | grep -q .; then
  echo "libepoxy is missing from the target image; XWayland glamor cannot initialize." >&2
  exit 1
fi
LIBDRM_SOURCE_DIR="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'libdrm-*' -print -quit)"
LIBDRM_BUILD_OPTIONS=""
if [[ -n "$LIBDRM_SOURCE_DIR" ]]; then
  LIBDRM_BUILD_OPTIONS="$(find "$LIBDRM_SOURCE_DIR" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit)"
fi
if [[ -z "$LIBDRM_BUILD_OPTIONS" ]]; then
  echo "libdrm Meson build options are missing; cannot verify VMware support." >&2
  exit 1
fi
python3 - "$LIBDRM_BUILD_OPTIONS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as options_file:
    options = {item["name"]: item["value"] for item in json.load(options_file)}

if options.get("vmwgfx") != "enabled":
    raise SystemExit("libdrm must be built with vmwgfx support enabled.")
PY
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libdrm.so.2*' -print -quit | grep -q .; then
  echo "The libdrm runtime library required by Mesa's VMware driver is missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/etc/udev/rules.d/70-astroos-device-groups.rules" ]]; then
  echo "DRM render and ALSA device access rules are missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/etc/init.d/S10vmtoolsd" ]]; then
  echo "The VMware Tools daemon init script is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target" -type f -name 'libresolutionKMS.so*' -print -quit | grep -q .; then
  echo "The VMware resolution-KMS plugin is missing from the target image." >&2
  exit 1
fi
if [[ ! -s "$OUTPUT_DIR/target/etc/ssl/certs/ca-certificates.crt" ]]; then
  echo "The public CA certificate bundle is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/certutil" ]]; then
  echo "NSS certutil is missing from the target image; the kiosk cannot verify its local CA trust." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/opt/astroos/lib/libffmpeg.so" ]]; then
  echo "NW.js runtime library libffmpeg.so is missing from /opt/astroos/lib in the target image." >&2
  exit 1
fi
if [[ ! -d "$OUTPUT_DIR/target/usr/share/fonts/dejavu" ]]; then
  echo "DejaVu fonts were enabled but are missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf" ]]; then
  echo "Noto Color Emoji is missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/usr/share/icons/whiteglass/cursors/left_ptr" \
  && ! -f "$OUTPUT_DIR/target/usr/share/icons/Whiteglass/cursors/left_ptr" ]]; then
  echo "Whiteglass X cursor theme is missing from the target image." >&2
  exit 1
fi
for layout in us gb ca au de fr be es it pt br nl se no dk fi pl tr ru ua jp; do
  if [[ ! -f "$OUTPUT_DIR/target/usr/share/X11/xkb/symbols/$layout" ]]; then
    echo "XKB keyboard layout '$layout' is missing from the target image." >&2
    exit 1
  fi
done
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/bsdtar" ]]; then
  echo "BSD tar is required to browse ISO files but is missing from the target image." >&2
  exit 1
fi
target_has_command() {
  [[ -x "$OUTPUT_DIR/target/bin/$1" || -x "$OUTPUT_DIR/target/usr/bin/$1" ]]
}
remove_stale_busybox_applet() {
  local path target
  for path in "$OUTPUT_DIR/target/bin/$1" "$OUTPUT_DIR/target/usr/bin/$1"; do
    if [[ -L "$path" && ! -e "$path" ]]; then
      target="$(readlink "$path")"
      if [[ "$target" == "busybox" || "$target" == "/bin/busybox" \
        || "$target" == "/usr/bin/busybox" ]]; then
        rm -f -- "$path"
      fi
    fi
  done
}
if ! target_has_command tar || ! target_has_command gzip; then
  echo "Cached BusyBox output has missing tar or gzip applets; rebuilding BusyBox." >&2
  remove_stale_busybox_applet tar
  remove_stale_busybox_applet gzip
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    busybox-dirclean
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" busybox
  rm -f "$OUTPUT_DIR/images/rootfs.cpio" \
    "$OUTPUT_DIR/images/rootfs.cpio.gz" \
    "$OUTPUT_DIR/images/rootfs.tar"
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" -j"$JOBS"
  if ! target_has_command tar || ! target_has_command gzip; then
    echo "BusyBox tar or gzip is still missing after rebuilding BusyBox." >&2
    find "$OUTPUT_DIR/target/bin" "$OUTPUT_DIR/target/usr/bin" \
      -maxdepth 1 \( -name tar -o -name gzip -o -name busybox \) -ls >&2
    exit 1
  fi
fi
if [[ ! -u "$OUTPUT_DIR/target/usr/bin/astroos-power" ]]; then
  echo "Restricted power helper is missing its setuid permission." >&2
  exit 1
fi
if [[ ! -u "$OUTPUT_DIR/target/usr/bin/astroos-install" ]]; then
  echo "Restricted disk installer helper is missing its setuid permission." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/sbin/astroos-install-system" ]]; then
  echo "Root-owned disk installation script is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/sbin/grub-install" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/grub-install" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/grub-install" ]]; then
  echo "grub-install is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$SYSTEM_SHELL" ]]; then
  echo "BusyBox /bin/sh applet is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/sbin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/lsblk" ]]; then
  echo "lsblk is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/sbin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/sfdisk" ]]; then
  echo "sfdisk is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/sbin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/mkfs.vfat" ]]; then
  echo "mkfs.vfat is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/sbin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/mkfs.ext4" ]]; then
  echo "mkfs.ext4 is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/blkid" \
  && ! -x "$OUTPUT_DIR/target/sbin/blkid" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/blkid" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/blkid" ]]; then
  echo "blkid is missing from the target image." >&2
  exit 1
fi
if [[ ! -d "$OUTPUT_DIR/target/lib/grub/i386-pc" \
  && ! -d "$OUTPUT_DIR/target/usr/lib/grub/i386-pc" \
  || ! -d "$OUTPUT_DIR/target/lib/grub/x86_64-efi" \
  && ! -d "$OUTPUT_DIR/target/usr/lib/grub/x86_64-efi" ]]; then
  echo "GRUB BIOS or UEFI modules are missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/images/rootfs.tar" ]]; then
  echo "Buildroot did not produce the root filesystem archive for disk installation." >&2
  exit 1
fi
if ! gzip -dc "$OUTPUT_DIR/images/rootfs.cpio.gz" | cpio -it 2>/dev/null \
  | awk '{ sub(/^\.\//, ""); if ($0 == "etc/inittab") inittab = 1; if ($0 == "etc/init.d/rcS") rcS = 1; if ($0 == "etc/init.d/rcK") rcK = 1; if ($0 == "bin/sh") shell = 1; if ($0 == "usr/bin/sudo") sudo = 1; if ($0 == "etc/sudoers") sudoers = 1; if ($0 == "etc/sudoers.d/astroos") sudoersd = 1 } END { exit !(inittab && rcS && rcK && shell && sudo && sudoers && sudoersd) }'; then
  echo "The boot initramfs is missing required init files, shell, sudo, or the AstroOS sudoers rules." >&2
  exit 1
fi

bash "$OS_DIR/board/astroos/post-image.sh" "$OUTPUT_DIR/images"

echo "ISO ready: $OUTPUT_DIR/images/astroos-live.iso"
