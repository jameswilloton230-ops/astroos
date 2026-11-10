#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# NM connection files must be owner-only readable or NM ignores them
chmod 600 "${TARGET_DIR}/etc/NetworkManager/system-connections/"*.nmconnection 2>/dev/null || true

# Nothing mounts a tmpfs on /tmp (custom inittab, no fstab), so it stays a plain
# initramfs dir. Without the sticky world-writable bit the kiosk user can't
# bind its dbus session socket there and the session restart-loops.
chmod 1777 "${TARGET_DIR}/tmp"
[ -d "${TARGET_DIR}/var/tmp" ] && chmod 1777 "${TARGET_DIR}/var/tmp"
mkdir -p "${TARGET_DIR}/tmp/.X11-unix"
chmod 1777 "${TARGET_DIR}/tmp/.X11-unix"
# S01mounts mounts a tmpfs over /tmp at boot; make sure it's executable even
# when Buildroot reuses a cached target tree.
install -D -m 0755 "${SCRIPT_DIR}/rootfs-overlay/etc/init.d/S01mounts" \
	"${TARGET_DIR}/etc/init.d/S01mounts"

# The sudo package may replace /etc/sudoers after the rootfs overlay is copied.
# Reinstall both NovaByte policy files after package installation so the
# includedir directive and kiosk rule are always present in the final target.
install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers" \
	"${TARGET_DIR}/etc/sudoers"
install -D -m 0440 "${SCRIPT_DIR}/rootfs-overlay/etc/sudoers.d/nbosp" \
	"${TARGET_DIR}/etc/sudoers.d/nbosp"

# Keep startup files current even when Buildroot reuses a cached target tree.
install -D -m 0644 "${SCRIPT_DIR}/rootfs-overlay/etc/inittab" \
	"${TARGET_DIR}/etc/inittab"
install -D -m 0755 "${SCRIPT_DIR}/rootfs-overlay/etc/init.d/rcS" \
	"${TARGET_DIR}/etc/init.d/rcS"
install -D -m 0755 "${SCRIPT_DIR}/rootfs-overlay/etc/init.d/rcK" \
	"${TARGET_DIR}/etc/init.d/rcK"
sed -i 's/\r$//' \
	"${TARGET_DIR}/etc/inittab" \
	"${TARGET_DIR}/etc/init.d/rcS" \
	"${TARGET_DIR}/etc/init.d/rcK"
