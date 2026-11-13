<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="AstroOS Logo" /></div>

<div><img src="https://img.shields.io/badge/AstroOS-v3.0.2_Beta-6366f1?style=for-the-badge" alt="AstroOS"/></div>

# AstroOS

**A NBOSP fork with a full LineageOS-inspired reskin, Material icons throughout,**
**our own identity, and our customisations re-applied on top of the current NBOSP main.**

<br>

[![Fork of NBOSP](https://img.shields.io/badge/Fork_of-NBOSP-22c55e?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![v3.0.2](https://img.shields.io/badge/v3.0.2-Beta-f59e0b?style=flat-square)](#status)
[![Node](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![ISO Build](https://github.com/jameswilloton230-ops/astroos/actions/workflows/astroos-iso.yml/badge.svg)](https://github.com/jameswilloton230-ops/astroos/actions/workflows/astroos-iso.yml)
[![License](https://img.shields.io/badge/License-MIT_%2B_Apache_2.0-22c55e?style=flat-square)](#license)

<br>

[**About**](#about) · [**What's New in This Sync**](#whats-new-in-this-sync) · [**Running AstroOS**](#running-astroos-dev) · [**Building the ISO**](#building-the-bootable-iso) · [**Design**](#design--lineageos-style--material-icons) · [**Permissions**](#permission-layer) · [**Architecture**](#architecture-notes) · [**Status**](#status) · [**Contributing**](#contributing--issues) · [**License**](#license)

</div>

-----

## About

AstroOS is a fork of **NBOSP (NovaByte Open Source Project)** — a heavy reskin rather than a from-scratch OS. The base architecture, server, security runtime, permission system, bootable OS image, and app logic all come from NBOSP. On top of that, AstroOS applies:

- A **LineageOS-inspired visual style** across the entire shell and every app
- **Material icons** applied system-wide, replacing the stock icon set
- **Our own identity** — the tree, the build, and the app namespace are AstroOS's, not NBOSP's
- Our own accumulated customisations, re-applied on every sync

If you want the bare, unstyled foundation, go use NBOSP directly. AstroOS exists for people who want that foundation with a different look and name already applied.

> [!NOTE]
> This branch (`main`) also retires the old repo layout. Earlier AstroOS releases lived in a standalone `astro-os/` snapshot that shared no git history with upstream, which made every sync a manual, grep-heavy port. The tree now mirrors NBOSP's structure with our customisations applied as a clean diff on top — future upstream syncs are real merges instead of archaeology. The old layout is preserved on the `main-old` branch.

-----

## What's New in This Sync

This is a full re-sync onto **NBOSP main as of November 2026** — by far the largest content update yet (600+ files changed against the previous AstroOS release) — plus a full re-brand of the tree, followed by a merge of **upstream's `gl-debug` branch** (40 commits: multi-user support, the labwc window manager, and a large dependency/security pass), with our UI kept on top.

### The re-brand

The repo is now AstroOS end to end, not NBOSP with a sticker on it:

- **`astro-os/`** is the main tree (previously `NBOSP/`)
- **App IDs moved from `com.nbosp.*` to `com.astroos.*`** — registry, aliases, permission gates, CSS selectors, and storage keys all follow
- The Buildroot side is re-named too: `astroos_x86_64_defconfig`, `board/astroos/`, `astroos-kiosk` / `astroos-install` / `astroos-power` packages, the `astroos` kiosk user with its `/home/astroos` home, and the bootable image is now **`astroos-live.iso`**
- The installer and system apps are **Install AstroOS** and **Astro System** (previously the NovaByte-named ones)
- Non-fork infrastructure is gone: the upstream **store site (`src/`)**, the **Supabase publisher backend (`supabase/`)**, **`NOVAAPP.md`**, and the **GitHub Pages workflow** that deployed their site. NBOSP's Apache license text stays at `astro-os/LICENSE-APACHE` — that one's not ours to remove.

> [!WARNING]
> Because app IDs changed, **existing local app data and permission grants reset** on this branch (fresh data dirs per app). In the OS image, first-boot migration still imports legacy data. If you run from source and `.env` exists from a previous build, delete it once — `npm start` regenerates it (a rate-limit env variable was renamed with the re-brand).

### Inherited from upstream (NBOSP main)

- **A bootable OS image.** NBOSP builds a real x86_64 live ISO via Buildroot: BusyBox init, a Wayland kiosk running in labwc (XWayland for legacy clients), Linux DRM/KMS with the VMware SVGA driver and Mesa for a graphical desktop in VMs, with the NW.js bundle as the main OS interface. Files can browse the host filesystem and launch executables as the unprivileged kiosk user (after confirmation), the Linux Terminal runs through `/bin/sh`, `curl` is included, sandboxed apps get a system file picker, and per-app sandbox data lives under the kiosk user's home with a one-time legacy data import on first boot. See `astro-os/os/README.md`.
- **The ISO builds in CI.** The `Build AstroOS ISO` workflow (manual trigger) runs the whole pipeline on GitHub's `ubuntu-latest` runners — integration tests included — and uploads the image as the `astroos-live-x86_64` artifact. See [Building the ISO](#building-the-bootable-iso).
- **System Webview service.** A trusted first-party guest API now exists, the Browser app has been moved onto it, and web apps build their guests through the System Webview service instead of hand-rolling embedding.
- **Permission system upgrades.** App manifests must declare `permissionReasons` for every permission they request — those reasons are shown on the first-launch gate, `vfs:*` aliases resolve to real labels in the permission dialog, and filesystem read errors no longer render as `[object Object]`.
- **Sandbox fix.** `nova:fs:write` serialises object content on every branch, so writing objects no longer produces garbage.
- **OS build toolchain fixes.** `host-m4` bumped to 1.4.21, a `HOSTCC` wrapper forces `gnu17` for host tools, and the gnulib build failure on GCC 13 / current `ubuntu-latest` images is fixed — which is what makes the Buildroot ISO build work on modern CI at all.

### Merged from upstream `gl-debug`

- **Multi-user accounts.** First-boot **Setup** wizard, a **Users** app, a **Session Manager** service, per-account app/data scoping (`user-scope.js`, per-account registry hives and installed-apps lists), PIN/passphrase authentication with a lockout ladder, and a multi-account lock-screen picker. Legacy single-user data is migrated in on first boot (`multiuser-migration.js`).
- **The kiosk window manager is now labwc** (with XWayland) instead of Cage — the `labwc` Buildroot package replaces the cage patches, and the ISO boots a labwc session for the NW.js kiosk.
- **NW.js updated to 0.12.0** — pulls a newer Chromium that closes roughly 200 known vulnerabilities.
- **Public test signing key + platform signature tier.** `astro-os/keys/` now ships the AOSP-style public test key with a README; Settings → About shows the live **Platform signature** tier (`test-keys` vs `release-keys`) from the trust store, and the security-patch date now comes from the platform instead of being hard-coded.
- **Store title de-branded** — the in-app Store header now says AstroOS, not NovaByte.

### The AstroOS layer (re-applied and extended)

- **LineageOS-style theming** re-applied across the shell and apps — `style.css` alone grew by ~400 lines against upstream, plus re-theming of `index.html`, the launcher, and the calculator
- **Settings sidebar restored** — the LineageOS Material sidebar from the previous release: 220px rail, pill-shaped section buttons (50px radius, 44px tall) with cyan active state, Material card groups with in-card headers, 20px icons
- **Launcher rework** — custom layout and behaviour on top of the upstream launcher
- **Calculator extensions** — extra functionality beyond stock NBOSP's calculator
- **Wallpaper and system-events services** — AstroOS-specific tweaks to both
- **Window manager tweaks** in the shell UI (`wm.js`)
- **Material icons** system-wide, and AstroOS branding (logo, app icon)
- **Default server port 3006** (upstream ships 3003) — reflected in `astro-os/.env.example`

-----

## Running AstroOS (dev)

```bash
git clone https://github.com/jameswilloton230-ops/astroos
cd astroos/astro-os
npm start
```

`npm start` handles first-run setup automatically — it checks for `node_modules`, installs dependencies if missing, generates a `.env`, and generates self-signed certs if they don't already exist. No separate `npm install` step needed.

Once running, the desktop is served at **`https://localhost:3006`** (change it in `.env` if the port collides with something).

> [!IMPORTANT]
> **AstroOS is currently in beta and active development.** Expect rough edges. If something breaks, that's expected at this stage — see [Contributing](#contributing--issues) below for how to report it.

-----

## Building the Bootable ISO

There are two ways to get a bootable AstroOS image:

### Via GitHub Actions (recommended)

1. Open the **Actions** tab on the repo and enable workflows if GitHub shows the "workflows are disabled" banner (forks start with Actions disabled).
2. Select **Build AstroOS ISO** → **Run workflow** → pick the `latest` branch.
3. Wait. The workflow runs integration tests (kiosk contract tests, NW.js Node integration under Xvfb), builds the Linux NW.js app, then builds the Buildroot image — it can take a while (the job allows up to 3 hours).
4. Download the **`astroos-live-x86_64`** artifact from the finished run (retained for 14 days) and flash/boot the ISO in a VM or on bare metal. It boots to the Cage kiosk desktop with the AstroOS UI.

No self-hosted runner or special hardware is needed — it runs entirely on GitHub's hosted `ubuntu-latest` runners, with Buildroot sources and build output cached between runs.

### Locally

Buildroot must be built on a Linux host (on Windows, use WSL2 with Ubuntu and keep the tree in the WSL filesystem). Install the host dependencies listed in `astro-os/os/README.md`, then:

```bash
bash astro-os/os/build-iso.sh
```

The finished image lands at `astro-os/os/output/images/astroos-live.iso`. Full build docs, dependency lists, and image behaviour notes live in [`astro-os/os/README.md`](./astro-os/os/README.md).

-----

## Design — LineageOS Style, Material Icons

AstroOS's defining difference from stock NBOSP is visual, not functional:

- **LineageOS-style theming** applied across the shell, window chrome, and every bundled app
- **Material icons** replacing the stock icon set system-wide — taskbar, app launcher, Settings, file types, everything
- This is a reskin layered on top of NBOSP's behaviour, not a behavioural fork. App functionality, the VFS, the permission system, the bootable image, and the server architecture are all NBOSP's; the look — and now the name — is ours

> [!NOTE]
> NBOSP Settings is the one app that keeps receiving feature/visual updates upstream (it controls OS-wide visual identity), so every upstream refactor to Settings is something we re-theme on our end each sync.

-----

## Permission Layer

NBOSP introduced a system-wide permission model: every app — including stock NBOSP apps, not just third-party `.novaapp` packages — has to request and be granted permission before it can do anything. AstroOS keeps this as-is rather than removing or weakening it.

This sync picked up upstream's improvements to it: manifests now declare **`permissionReasons`** for every requested permission, and those reasons are surfaced on the first-launch gate instead of a blank "allow?" prompt.

You can manage everything from **Settings → Apps**:

- See every installed app with its current permission state
- Sensitive permissions are called out separately from automatic/low-risk ones
- Grant, revoke, or reset any permission per app at any time
- Previously denied permissions can be re-enabled from this screen

-----

## Architecture Notes

AstroOS doesn't restructure NBOSP — we build on top of what's already there:

- **`astro-os/server/`** — the modular server split (core, routes, middleware, SSL/env handling, proxies), untouched in shape; AstroOS's only server-side deltas are port defaults and small tweaks
- **`astro-os/js/`** — the client platform: app registry, app packaging, and the permission manager under `js/platform/`, with each app self-contained under `js/apps/`
- **`astro-os/os/`** — the bootable OS side: Buildroot config, board files, the Cage kiosk packaging (`astroos-kiosk`), installer and power packages, patches, and `build-iso.sh`
- **`astro-os/tests/`** — unit and system tests (run with `node --test`)

> [!NOTE]
> The upstream store site (`src/`), Supabase publisher backend, and their Pages deployment were removed with this sync — they're NovaByte's infrastructure, not ours. The Store app still points at the upstream-hosted catalog and publisher API out of the box; point it at your own endpoints if you run your own.

If you're trying to find where AstroOS-specific code lives versus stock NBOSP code: our layer is intentionally a small, clean diff on top of upstream, but expect to grep for it — the layout reflects NBOSP's structure, not an AstroOS-shaped one.

-----

## Status

AstroOS is **beta / active development**. Versioning tracks NBOSP's own version numbers — this release sits on the NBOSP **3.0.2** line with upstream `gl-debug` as of November 2026 merged in, re-branded to AstroOS throughout. Branch layout: **`main`** is this synced branch; **`main-old`** preserves the previous AstroOS release layout. Expect bugs, incomplete theming in newer NBOSP-added surfaces, and behaviour that may shift before a stable release.

-----

## Contributing & Issues

This is an open project and contributions are welcome.

- **Found a bug or have a fix?** Open an issue or PR on the [repo](https://github.com/jameswilloton230-ops/astroos).
- **Security issues:** please use the **private security advisories** rather than filing a public issue, so problems aren't disclosed before there's a fix.

-----

## License

AstroOS uses two licenses, split by where the code came from:

| Code | License |
|------|---------|
| Inherited NBOSP code (core, server, stock apps, OS image) | **Apache 2.0** — preserved in [`astro-os/LICENSE-APACHE`](./astro-os/LICENSE-APACHE) |
| AstroOS-authored code (reskin, theming, Material icon set, launcher and app customisations, branding) | **MIT** — see [`LICENSE`](./LICENSE) |

NBOSP's copyright notices and Apache 2.0 license text are preserved wherever NBOSP code is used, per its licensing terms. Code written by AstroOS is licensed under MIT.

-----

*AstroOS — built on NBOSP, restyled and renamed from the ground up.*
