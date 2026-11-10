# NBOSP OS boot image

## Desktop applications and boot

Desktop applications continue to use NovaByte's existing app sandbox and
permission system. The optional Weston multi-window proof of concept and the
SELinux boot integration have been removed; the image boots with Buildroot's
standard BusyBox init and launches the kiosk in Cage. The newer per-app Linux
UID supervisor, process launcher, and associated seccomp, cgroup, and firewall
isolation are not part of this image. The Linux Terminal runs commands through
`/bin/sh`, and the image includes the `curl` command-line client for HTTP(S)
requests.

The image supplies an explicit BusyBox `/etc/inittab` and `rcS` script so init
runs the standard `/etc/init.d/S*` service sequence instead of BusyBox's
fallback actions when the inittab is absent. The post-build hook installs the
startup files into cached target trees and normalizes their line endings; the
inittab invokes the scripts through `/bin/sh` so startup does not depend on
script executable bits or shebang handling. The BusyBox configuration
explicitly installs its shell applet at `/bin/sh`. The ISO build recreates and
checks the shell and startup files in the actual CPIO initramfs it boots.

This milestone extends the working x86_64 Buildroot boot into a graphical
VMware desktop: Linux DRM/KMS with the VMware SVGA driver, Mesa, Wayland,
and Cage. The Linux x64 NBOSP NW.js bundle remains the main OS interface. On
Linux, Files browses the host filesystem directly, can list ISO contents,
and can launch executable files as the unprivileged kiosk user after
confirmation. The shared filesystem API maps to the kiosk user's real home
directory, app data and package blobs are stored under
`~/.local/share/novabyte`, settings use `~/.config/novabyte/settings.json`, and
browser-origin state is mirrored to the native filesystem. The sandbox's
per-app tree `/data/<appId>/` (the `appdata:` root) resolves to
`~/.local/share/novabyte/data/<appId>/` — the same folders AppDirs
bootstraps, with the app's real id (dots preserved, aliases canonicalized) as
the folder name. Older builds mangled the id (dots to underscores) and wrote
it under `~/data`; boot merges that legacy content into the data root and
renames mangled folders to their canonical app ids. First boot imports
legacy VFS, OPFS, and IndexedDB data when available; the browser-backed
filesystem remains only for non-Linux builds and that one-time migration.
Sandboxed apps use the system file picker to browse the kiosk user's readable
host filesystem, including hidden files and directories reached through
symlinks. The user can enter a folder path directly. Apps receive only the
file they explicitly select (up to 10 MB); saving writes only to the chosen
destination and asks before overwriting an existing file. Normal Linux file
permissions still apply, so root-only files remain unavailable to the kiosk
user.

## Build on Linux or WSL2

Buildroot must be built on a Linux host. On Windows, use WSL2 with Ubuntu. Keep
the source tree in the WSL filesystem (for example, `~/src/novabyte-os`) rather
than under `/mnt/c` for better build performance and filesystem behavior.

Install the host dependencies:

```sh
sudo apt update
sudo apt install -y build-essential bc bison flex file wget cpio unzip rsync \
  python3 perl patch gzip bzip2 xz-utils libncurses-dev libelf-dev libssl-dev curl \
  grub-common grub-pc-bin grub-efi-amd64-bin xorriso mtools
```

From `NBOSP/os`, build the ISO:

```sh
bash build-iso.sh
```

The script downloads Buildroot 2025.02 once, configures the x86_64 target,
builds the Linux 6.12.18 kernel, compressed live initramfs, and a root
filesystem archive for the installer, and creates:

```text
NBOSP/os/output/images/nbosp-live.iso
```

Attach that ISO to a VMware x86_64 VM and boot it. The GRUB menu has a
three-second timeout; Linux writes to the virtual display and serial console.
The live root filesystem is an in-memory initramfs, so live-session changes
are temporary until you install NovaByte to a VM disk.

## Installing to a VM disk

The launchpad includes **Install NovaByte**. Add a separate virtual hard disk
to the test VM, start the live ISO, select that disk in the installer, and
type the exact confirmation shown (for example, `ERASE /dev/sda`) before it
will proceed. The installer erases every partition on the selected disk,
creates a GPT layout, and installs BIOS and UEFI bootloaders. It checks that
the selected disk and its partitions are not mounted. Do not select a disk
containing data you need; the erase is irreversible.
The installed GRUB entry passes the root partition's GPT `PARTUUID` directly
to Linux, so the kernel can locate the ext4 root filesystem without an
initramfs.
For UEFI guests, disable Secure Boot; the installed GRUB loader is not signed.

After a successful installation, the app removes its own desktop shortcut;
any taskbar pin is left unchanged. Restart through the launchpad's power
controls, then remove the live ISO or change the VM boot order so it starts
from the installed disk. The installed root filesystem is writable and keeps
the user's home directory and NW.js profile across normal reboots. It does
not copy data from the temporary live session into the installed system.

This installer is designed for x86_64 VMware BIOS and UEFI guests. It has not
yet been validated in VMware or against physical disks; use a disposable VM
with a separate test disk until that verification is complete. Open VM Tools
is built into the image, so installing a separate VMware Tools ISO inside the
guest is unnecessary.
The launcher exposes restart and power-off controls through a dedicated
root-owned helper that accepts only those two actions; it does not provide
general root command execution.
**Wipe All Data** and Recovery's **Factory Reset** clear the contents of
`/home/nbosp` and restart the system, removing user files, settings, installed
app data, runtime state, and the NW.js profile. They preserve the installed
system under `/opt/nbosp` and do not repartition or reinstall the disk. Use the
installer to replace the operating system itself.

If boot reaches the console but the kiosk reports a missing VMware DRM device,
use a newly built ISO with `CONFIG_DRM_VMWGFX=y` and ensure the VM has a
connected virtual display. The kernel also includes VMware-compatible
`e1000`, `e1000e`, and `vmxnet3` network drivers for the VM's virtual NIC.
NetworkManager has a system-wide Ethernet profile that automatically connects
with DHCP and DNS; the VMware network adapter must be enabled and connected.
The boot command line keeps the VMware `e1000` interface named `eth0` and makes
the serial console the userspace console so init and
kiosk startup messages are captured by a configured VMware serial port.

The manual GitHub Actions workflow runs `npm ci` in `NBOSP`, builds the Linux
x64 NW.js application, adjusts its window settings for fullscreen Cage kiosk
mode using XWayland, and installs the complete app bundle into the ISO at
`/opt/nbosp`.
The application build uses the same pinned NW.js SDK version as the `nw`
package instead of tracking `latest`, keeping the runtime, SDK, and optional
FFmpeg binary release in sync. Browser downloads use NW.js's Downloads API,
save into the user's Downloads folder, and appear in the Downloads app with
progress and completion status.
At boot, Buildroot starts Cage on the VMware display and launches NW.js as the
unprivileged `nbosp` user. Cage and NW.js output is appended to
`/home/nbosp/nbosp-kiosk.log` and mirrored to the configured `ttyS0` serial
console for debugging without switching virtual terminals. The kiosk is
started inside a fresh D-Bus session to avoid inheriting a malformed session
bus address. The NW.js bundle remains root-owned. Mutable runtime state,
including generated secrets, TLS certificates, server logs, and SQLite data,
is stored under `/home/nbosp/.config/novabyte/runtime`. User settings and
profile data are stored under `/home/nbosp`. Cage runs the compositor on Wayland and
XWayland is enabled for NW.js, retaining GPU acceleration while avoiding the
Chromium native-Wayland DMA-BUF import failure observed with VMware SVGA.
The image enables Mesa's VMware SVGA Gallium driver and X11/GLX support for
NW.js running through XWayland. Chromium explicitly requests the built
EGL/ANGLE implementation with its OpenGL backend; the previous desktop-GL
request was not in this NW.js build's allowed implementation list and caused
the GPU process to exit. GPU rasterization and zero-copy buffers remain
enabled. udev assigns DRM render nodes to the dedicated `nbosp` account and
the `render` group, which is created in the system user table.
Before starting the browser, the service verifies that `nbosp` can read and
write a DRM render node rather than silently accepting the software-rendering
fallback.
libepoxy is included so Buildroot enables XWayland's glamor path as well as
GLX. The ISO build verifies XWayland's configured Meson options, not just the
presence of GL libraries, before producing the image.
Mesa GBM is enabled explicitly as well, since XWayland's glamor path needs it
to initialize accelerated rendering. The ISO build verifies that `libgbm`
ships in the target image.
Xorg protocol headers are enabled explicitly because Mesa's GLX client build
requires `GL/glxproto.h`. libglvnd provides the standard `libGL.so.1` dispatch
library; the image build verifies that it is present alongside Mesa's GLX
library and SVGA DRI driver. XWayland's GLX server also needs Mesa's
`GL/internal/dri_interface.h`; the build stages that private header from the
matching Mesa source into the toolchain sysroot before compiling XWayland.
In VMware, enable **Accelerate 3D graphics** for the VM. The image build checks
for XWayland GLX/glamor, Mesa GBM, libepoxy, and the VMware SVGA driver; still
confirm Chromium's actual renderer from its GPU log in the VM.

### GL debug mode

`S99nbosp` runs in GL debug mode by default (`NBOSP_GL_DEBUG=1`) while the
XWayland glamor failure is being tracked down. Set `NBOSP_GL_DEBUG=0` in the
init environment to turn it all off. It does not change which GL backend
Chromium requests. It adds:

- Cage logs at wlroots debug level. Release Cage hard-codes the error level,
  so `patches/cage/0001-runtime-debug-logging.patch` makes it honour
  `CAGE_DEBUG`. (Cage's `-d` flag is "no client-side decorations", not debug.)
- By default the dump runs a second XWayland (`:7`) against the live cage with
  `-verbose 10`, which should say why glamor falls back. Output:
  `~nbosp/xwayland-probe.log`.
- Optional, off by default (`NBOSP_GL_XWRAP=1`): launch cage's XWayland through
  `/run/nbosp-debug-bin/Xwayland` (via `WLR_XWAYLAND`, with a `PATH` fallback).
  It runs with `-verbose 10` and `LD_DEBUG=libs`, plus `strace -Z` if
  `NBOSP_GL_STRACE=1`. In the first two debug boots this wrapper made XWayland
  exit within 10-90ms, so it stays off until we know why.
  Output: `~nbosp/xwayland-debug.log`, `xwayland-ld.<pid>`, `xwayland.strace`.
- `EGL_LOG_LEVEL=debug`, `MESA_DEBUG=1`, and Chromium `--vmodule` logging for
  the GL display/context/GPU-init code.
- `mesa3d-demos` (`eglinfo`, `glxinfo`), `wayland-utils` (`wayland-info`) and
  `strace` in the image.
- About 30 seconds after boot (once XWayland has started) a dump of the
  graphics state is written to `~nbosp/nbosp-gl-debug.log`, the serial
  console and `nbosp-kiosk.log`: library and driver listing, glvnd vendor
  files, the libraries cage and XWayland actually mapped, their environment,
  `eglinfo`/`glxinfo`/`wayland-info`, and the filtered XWayland logs. Attach
  the serial log, or that file, to a bug report.
The image also includes ALSA HDA and Ensoniq ES1371 drivers and utilities.
At kiosk startup, `amixer` attempts to unmute and set the common playback
controls on the detected card; it logs a warning and the available controls
if the card has none of those controls. udev grants the kiosk account access
to sound devices while retaining the `audio` group. For VMware audio, add or
enable a virtual sound card and select **Connect at power on**. The attached
boot log detects a generic VMware HDA codec after a CORB reset timeout and
reports that UCM configuration is absent, so ALSA's `alsactl init` did not
reliably initialize it. The kiosk now uses direct mixer controls instead.
NovaByte's built-in HTML select controls open an in-page listbox instead of
Chromium's native popup, avoiding popup-positioning differences in the
XWayland kiosk. Select controls rendered inside external websites in the
Browser app remain managed by Chromium.
The kiosk does not force Chromium's device scale factor. In the XWayland
session, overriding it can misalign pointer hit-testing and native popup
positions, including NW.js context menus and DevTools. Adjust the virtual
machine's display resolution instead.
The Date and Region settings also include a keyboard layout selector. The
selected XKB layout is saved for the `nbosp` user and passed to Cage on its
next start, so restart NovaByte OS after changing it. The ISO build verifies
that every offered layout is included in the image.
Settings includes a Connectivity section backed by NetworkManager/wpa_supplicant
for Ethernet and Wi-Fi and BlueZ for Bluetooth scanning and pairing. Network
control is authorized for the dedicated `nbosp` kiosk account through a
Polkit rule scoped to network-management and Bluetooth device actions. VMware
exposes virtual Ethernet by default; Wi-Fi and Bluetooth require suitable
guest-visible adapters, kernel drivers, and any firmware those adapters need.
The ISO includes common wireless kernel drivers and selected Intel Wi-Fi
firmware, but does not bundle firmware for every vendor or model.
The image includes the public CA bundle so Chromium and Node can validate
external HTTPS sites. At each Linux kiosk start, NovaByte refreshes its local
CA entry in the kiosk user's NSS database and verifies the imported certificate
and SSL trust flags against the CA used by the server. NW.js retains
`--allow-insecure-localhost` as a localhost-only fallback; broad certificate
verification bypasses remain disabled.
DejaVu Sans/Mono and Noto Color Emoji fonts and Fontconfig are included so
Chromium and the UI can render text and emoji without downloading fonts at
runtime. The emoji font is pinned to a Noto Emoji source revision and its OFL
license is included in the image. The Whiteglass Xcursor theme is included,
and Cage uses the DRM hardware cursor plane. If the pointer is invisible in
VMware, set `WLR_NO_HARDWARE_CURSORS=1` for Cage in `S99nbosp` to force a
software cursor.
The image build keeps Buildroot's cached kernel and graphics outputs. It
clean-rebuilds Mesa, libglvnd, and XWayland only when the graphics configuration
signature changes, and checks that `libGL.so.1`, Mesa's `vmwgfx_dri.so` SVGA
driver, and GLX library are present.
CI first opens a minimal NW.js app under Xvfb, then checks Node access and the
`better-sqlite3` native module before starting the Buildroot build. The image
does not build a separate Node.js package. The build uploads the ISO artifact
`nbosp-live-x86_64`; there is no separate NW.js artifact.

The kiosk user runs with the Linux account and device-group permissions, but
this is not yet per-`.novaapp` process isolation. The live initramfs remains
ephemeral: files and app data are lost at shutdown unless you use the disk
installer. The tty2 console remains available for debugging.
The VMware Open VM Tools guest daemon and its resolution-KMS plugin are
included. The daemon waits for udev to expose the VMware DRM device before
loading the plugin, which only probes for dynamic display support at startup.
Installing a separate Tools ISO inside the guest is unnecessary.
NovaByte System reports hardware visible to the Linux guest (CPU, memory,
graphics, network, audio, and VMware guest tools) to Settings. Network and
Bluetooth actions are delegated to the existing NetworkManager and BlueZ
backend. Settings and the Shell UI use NovaByte System's validated settings
API; the shell remains responsible for rendering visual changes. The system
service coordinates guest-visible controls through their existing backends
and routes confirmed restart and power-off requests through the NBOSP power
helper. It does not replace drivers or control VMware's host-side CPU, memory,
or device assignments; adjust those in VMware. Display resolution remains a
guest display mode and is reported, not changed, by the inventory API. If the
required NovaByte System service fails during startup, the core boot path
routes to Recovery Mode without depending on that service.
The guest Terminal runs as the unprivileged `nbosp` user. This Buildroot image
does not provide `sudo` or Debian's `apt`; the `sudo apt` commands above are
for installing build dependencies on the Ubuntu/WSL host, not for use inside
the guest. Add guest software through the Buildroot configuration and rebuild
the ISO.
The kernel command line explicitly selects the SRSO `safe-ret` mitigation.
The guest cannot provide the host CPU microcode required for the additional
IBPB protection. If the host CPU is affected, update its BIOS/UEFI firmware
and VMware, then fully power off and cold-start the VM. The guest may continue
to report `Vulnerable: Safe RET, no microcode` when the host does not expose
the required microcode; do not disable the kernel mitigation to hide that
status.

The workflow caches the Buildroot source/downloads and compiled output, along
with the NW.js SDK and npm cache, to speed up later manual runs. The local
Buildroot package is deliberately rebuilt each run to include the newly built
NW.js bundle.

### XWayland popup positioning

NW.js runs as an X11 client through XWayland, so the native Chromium right-click
menu and `<select>` dropdowns are X11 override-redirect windows. Those windows
map first and then move themselves to the anchored position, and Cage 0.2.0 only
copied the position at map time — every such popup landed in the top-left corner
instead of at the cursor (upstream cage issue #228, fix in unmerged PR #283).
`patches/cage/0003-xwayland-position-override-redirect-windows.patch` backports
that fix: it tracks wlroots' `set_geometry` event for override-redirect surfaces
and moves the scene node with it, and skips maximize/center positioning for them.

### XWayland input stacking

The same XWayland boundary also affects which window receives the mouse. Xwayland
delivers pointer events to the topmost X11 window under the cursor (`XYToWindow`
semantics), but wlroots 0.17+ restacks every newly mapped managed window to the
*bottom* of the X11 stack and leaves syncing the stack to the compositor via
`wlr_xwayland_surface_restack()` — which Cage 0.2.0 never calls. Since kiosk views
are all fullscreen at (0,0), a second window (NW.js DevTools, any other X client)
draws on top but sits at the bottom of the X11 stack: it renders fine, keyboard
focus follows activation, yet every click silently lands on the window underneath.
`patches/cage/0004-xwayland-restack-focused-view.patch` fixes this by restacking
the surface to the top of the managed X11 stack whenever cage focuses the view
(both map-time focus and click-to-focus go through `seat_set_focus`), mirroring
sway's handling of the same wlroots API. Override-redirect surfaces are skipped:
wlroots asserts on restacking them and they always map above managed windows.

### Nested webview overlays, context menus, and the annotation layer

`<webview>` guests are composited by NW.js as separate out-of-process surfaces
that render above ordinary same-window DOM content regardless of z-index or
stacking context. Host pixels can only win by toggling the guest's own
visibility — the same fact `showFileDialog` has always worked around.
`nova:overlay:show` and `nova:context-menu:show` rendered body/window-level
host DOM and therefore lost to the app's webview and any nested webview, so
both appeared behind the page: static overlays were invisible and host context
menus never surfaced.

The sandbox stack now freezes guests behind captured stills for the duration
of an overlay or context menu (`NovaSystemWebview.freezeSandbox` /
`restoreSandbox`, refcounted and generation-guarded so overlapping menus,
in-flight captures, and bounds updates cannot leak a frozen guest), raises the
context menu above its own window's z-index, and keeps the page visible behind
the stills instead of blanking it.

For interactive pixels above a webview — annotation tools drawing over the
page — host DOM can never work even when frozen, because the app's own UI is
itself a guest surface. The nested-webview API therefore gained an
annotation layer that lives inside the guest document:

- `browserView.setAnnotationLayer({ color, lineWidth, active })` injects a
  fixed-position canvas into the page that captures pointer input while
  active; it re-injects itself after every navigation.
- `browserView.updateAnnotationLayer({ color, lineWidth })`,
  `browserView.setAnnotationActive(bool)`, `browserView.clearAnnotationLayer()`,
  and `browserView.undoAnnotationLayer()` drive the tool state.
- `browserView.exportAnnotationLayer()` resolves through the console bridge
  and emits an `annotation-export` event on the view carrying the canvas as a
  PNG data URL.
- `browserView.setOverlayActive(true)` freezes the live guest behind a
  captured still so the app's own DOM can composite above it — only useful
  when the app keeps its view container transparent, since an opaque app
  background still paints over the frozen page.

## Current limitations

This image targets the VMware virtual SVGA device first. Graphics support for
other virtual machines or physical hardware has not been validated. NW.js,
Wayland, Cage, and their runtime libraries are compiled into the image, so the
ISO is significantly larger than the earlier console-only image.
