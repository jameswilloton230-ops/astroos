<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="AstroOS Logo" /></div>

<div><img src="https://img.shields.io/badge/AstroOS-v3.0.2_Beta-6366f1?style=for-the-badge" alt="AstroOS"/></div>

# AstroOS

**A NBOSP fork with a full LineageOS-inspired reskin, Material icons throughout,**
**and our own customisations re-applied on top of NBOSP's 3.0.2 core rewrite.**

<br>

[![Fork of NBOSP](https://img.shields.io/badge/Fork_of-NBOSP-22c55e?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os/tree/main/NBOSP)
[![v3.0.2](https://img.shields.io/badge/v3.0.2-Beta-f59e0b?style=flat-square)](#status)
[![Node](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Security Patch Level](https://img.shields.io/badge/Security_Patch_Level-2026--06--03-22c55e?style=flat-square)](#security)
[![License](https://img.shields.io/badge/License-MIT_%2B_Apache_2.0-22c55e?style=flat-square)](#license)

<br>

[**About**](#about) · [**What's New in 3.0.2**](#whats-new-in-302) · [**Design**](#design--lineageos-style--material-icons) · [**Getting Started**](#getting-started) · [**Permissions**](#permission-layer) · [**Architecture**](#architecture-notes) · [**Status**](#status) · [**Contributing**](#contributing--issues) · [**License**](#license)

</div>

-----

## About

AstroOS is a fork of **NBOSP (NovaByte Open Source Project)** — a heavy reskin rather than a from-scratch OS. The base architecture, server, security runtime, and app logic all come from NBOSP. On top of that, AstroOS applies:

- A **LineageOS-inspired visual style** across the entire shell and every app
- **Material icons** applied system-wide, replacing the stock NBOSP icon set
- Our own accumulated customisations, carried forward from earlier AstroOS releases

If you want the bare, unstyled foundation, go use NBOSP directly. AstroOS exists for people who want that foundation with a different visual identity already applied.

-----

## What's New in 3.0.2

This is described internally as the biggest update AstroOS has shipped. NBOSP itself went through a massive refactor between its 3.0.1 and 3.0.2 lines — core files and effectively every NBOSP app were rewritten. Because AstroOS sits on top of NBOSP rather than alongside it, that refactor meant migrating all of our existing customisations (styling, icon overrides, prior tweaks) back onto the new NBOSP base by hand. It was a slow, grep-heavy process, but it's done and AstroOS 3.0.2 is built on the new NBOSP core.

**What we inherited from the NBOSP 3.0.2 refactor:**

- 200+ vulnerability and security fixes — we went through all ~70 commits NBOSP made since our last clone to migrate our customisations forward, and the sheer number of files touched for security/audit fixes alone made an exact count impractical to list here
- Wide rewrites across core files and NBOSP apps
- A substantial number of memory leak fixes
- General best-practice and performance/efficiency cleanup, plus assorted bug fixes
- `npm start` now bootstraps itself — it auto-generates `.env` and self-signed certs on first run instead of requiring manual setup
- Dependency bumps across the board to latest versions
- A **new system-wide permission layer** — every app, including stock NBOSP apps, now has to request permission before it can do anything. We did not strip this out; it's intact in AstroOS. See [Permission Layer](#permission-layer) below.
- A new **Apps** section inside Settings for managing those per-app permissions
- Large round of browser bug fixes (see below)
- **`.novaapp` packages now run in WebView instead of iframe.** Iframe rendering for `.novaapp` was less secure and frequently didn't work at all. Every app built for NovaByte OS that ships as `.novaapp` now runs correctly under AstroOS as a result.
- Security patch level bumped from `2026-05-01` to `2026-06-03`

**What NBOSP removed that we kept:**

- NBOSP removed `user-power-menu.js` in this cycle. It was broken in NBOSP anyway, so we don't know their exact reasoning — but AstroOS still has our own working version of it, since it shipped fine on our side.

### Browser fixes

The in-app browser had a rough run leading into this release — iframe-mode rendering had a number of long-standing issues. Most of those are resolved in 3.0.2:

- iframe mode is mostly fixed and significantly more stable than before
- `.novaapp` apps moved from iframe to WebView (see above), which was the bigger fix overall

-----

## Design — LineageOS Style, Material Icons

AstroOS's defining difference from stock NBOSP is visual, not functional:

- **LineageOS-style theming** applied across the shell, window chrome, and every bundled app
- **Material icons** replacing the stock icon set system-wide — taskbar, app launcher, Settings, file types, everything
- This is a reskin layered on top of NBOSP's behavior, not a behavioral fork. App functionality, the VFS, the permission system, and the server architecture are all NBOSP's; the look is ours

> [!NOTE]
> Because NBOSP Settings is the one app that keeps receiving feature/visual updates upstream (it controls OS-wide visual identity), every NBOSP refactor to Settings is something we have to re-theme on our end. That's most of where the "massive rewrites" pain came from this cycle.

-----

## Getting Started

```bash
git clone https://github.com/jameswilloton230-ops/astroos
cd astroos
npm start
```

`npm start` handles first-run setup automatically — it checks for `node_modules`, installs dependencies if missing, generates a `.env`, and generates self-signed certs if they don't already exist. No separate `npm install` step needed.

> [!IMPORTANT]
> **AstroOS is currently in beta and active development.** Expect rough edges. If something breaks, that's expected at this stage — see [Contributing](#contributing--issues) below for how to report it.

-----

## Permission Layer

NBOSP 3.0.2 introduced a system-wide permission model: every app — including stock NBOSP apps, not just third-party `.novaapp` packages — now has to request and be granted permission before it can do anything. AstroOS kept this as-is rather than removing or weakening it.

You can manage this from **Settings → Apps**:

- See every installed app (NBOSP apps, web apps, and `.novaapp` packages) with its current permission state
- Sensitive permissions are called out separately from automatic/low-risk ones
- Grant, revoke, or reset any permission per app at any time
- Previously denied permissions can be re-enabled from this screen

-----

## Architecture Notes

AstroOS doesn't restructure NBOSP's backend — we build on top of its existing modular `server/` split (core, routes, middleware, SSL/env handling, proxies) rather than maintaining a separate server architecture. Our work this cycle was almost entirely about re-locating and re-applying our styling and customisation layer inside that structure after NBOSP's reorganization, not about changing how the server itself works.

If you're trying to find where AstroOS-specific code lives versus stock NBOSP code, expect to grep for it — that's exactly what we had to do to migrate our own changes forward, and the layout reflects NBOSP's structure more than a custom AstroOS one.

-----

## Status

AstroOS is **beta / active development**. Versioning currently tracks NBOSP's own version numbers (this release is 3.0.2). Expect bugs, incomplete theming in newer NBOSP-added surfaces, and behavior that may shift before a stable release.

-----

## Contributing & Issues

This is an open project and contributions are welcome.

- **Found a bug or have a fix?** Open an issue or PR on the [repo](https://github.com/jameswilloton230-ops/astroos).
- **Security issues:** please use the **private issues tab** rather than filing a public issue, so problems aren't disclosed before there's a fix.

-----

## License

AstroOS uses two licenses, split by where the code came from:

| Code | License |
|------|---------|
| Inherited NBOSP code (core, server, stock apps) | **Apache 2.0** — NBOSP's original license, preserved as required |
| AstroOS-authored code (reskin, theming, Material icon set, permission manager, and other AstroOS customisations) | **MIT** |

NBOSP's copyright notices and Apache 2.0 license text are preserved wherever NBOSP code is used, per its licensing terms. Code written by AstroOS is licensed under MIT — see `LICENSE` in the repo for the full text.

-----

*AstroOS — built on NBOSP, restyled from the ground up.*
