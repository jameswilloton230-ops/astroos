#!/usr/bin/env bash
set -euo pipefail

BINARIES_DIR="${1:?Buildroot binaries directory is required}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ISO_ROOT="$(mktemp -d)"
trap 'rm -rf "$ISO_ROOT"' EXIT

GRUB_MKRESCUE="${GRUB_MKRESCUE:-grub-mkrescue}"
if ! command -v "$GRUB_MKRESCUE" >/dev/null 2>&1; then
  echo "Missing grub-mkrescue. Install GRUB BIOS/EFI tools and xorriso." >&2
  exit 1
fi

if [[ ! -f "$BINARIES_DIR/bzImage" || ! -f "$BINARIES_DIR/rootfs.cpio.gz" || ! -f "$BINARIES_DIR/rootfs.tar" ]]; then
  echo "Buildroot did not produce bzImage, rootfs.cpio.gz, and rootfs.tar." >&2
  exit 1
fi

mkdir -p "$ISO_ROOT/boot/grub" "$ISO_ROOT/nbosp"
cp "$BINARIES_DIR/bzImage" "$ISO_ROOT/boot/vmlinuz"
cp "$BINARIES_DIR/rootfs.cpio.gz" "$ISO_ROOT/boot/initrd"
cp "$SCRIPT_DIR/grub.cfg" "$ISO_ROOT/boot/grub/grub.cfg"
gzip -1 -c "$BINARIES_DIR/rootfs.tar" > "$ISO_ROOT/nbosp/rootfs.tar.gz"
stat --format='%s' "$BINARIES_DIR/rootfs.tar" > "$ISO_ROOT/nbosp/rootfs-size"

"$GRUB_MKRESCUE" -o "$BINARIES_DIR/nbosp-live.iso" "$ISO_ROOT"
echo "Created $BINARIES_DIR/nbosp-live.iso"
