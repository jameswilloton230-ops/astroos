# AstroOS test signing keys (`astro-os/keys/`)

This directory holds the **NOVA TEST signing key** — the AstroOS equivalent
of AOSP's public `platform.pk8`/`platform.x509.pem` test keys that ship inside
the Android Open Source Project itself.

## What this key is

`test-system-key.json` is a complete Ed25519 pair (the private half `d` is
included on purpose). `astro-os/build-apps.mjs` uses it by default, and the
system-signing anchor in `astro-os/js/platform/security/trust-store.js` points
at its public half. The result:

- **Anyone can build a working OS.** A fresh clone — or any fork — runs
  `node build-apps.mjs` and gets `.novaapp` packages that install and verify
  as `Astro System` with no configuration at all, exactly like an
  `AOSP` build signed with the public platform test keys boots and works
  out of the box.
- **It is not a secret.** Because the private half is public, anyone who
  can read this repository can produce packages this build verifies as
  System-signed. That is the deliberate, documented trade-off of a test-key
  build; AOSP makes exactly the same one and tags those builds
  `ro.build.tags=test-keys`. AstroOS builds made this way report
  **`test-keys`** through `TrustStore.systemSignatureTier()` (Settings →
  About shows it next to the security patch level).

## What this key is not

- It is **not** a production key. A shipped, production, or otherwise
  security-sensitive AstroOS machine must be signed with a real key that
  is kept offline, the same way an OEM replaces AOSP's test keys with its
  own release keys. Never rely on a test-key-signed install to gate
  anything security-critical, because the signing half is public.

## Rotating to a release key (the "release-keys" path)

1. Generate a fresh Ed25519 key and keep its private half **offline**
   (for example on an air-gapped machine or encrypted media — never in
   this repository, never in a CI secret store you do not control):

   ```js
   const { generateKeyPairSync } = require('node:crypto');
   const { privateKey } = generateKeyPairSync('ed25519');
   console.log(JSON.stringify(privateKey.export({ format: 'jwk' })));
   ```

2. Build packages with it — the build script prefers the environment over
   the committed test key:

   ```sh
   ASTROOS_SYSTEM_SIGNING_KEY_PATH=/offline/keys/system-release.json node build-apps.mjs
   # or: ASTROOS_SYSTEM_SIGNING_KEY='{"kty":"OKP",...}' node build-apps.mjs
   ```

   Packages built this way carry `signing.tier: "release"` instead of
   `"test"`.

3. Tell the runtime trust anchor to trust your release public key by
   exporting its public JWK for the server (public half only — the server
   never needs the private key):

   ```sh
   ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK='{"kty":"OKP","crv":"Ed25519","x":"…"}' npm start
   ```

   The server injects it into the OS page and `trust-store.js` swaps the
   default test anchor for yours; `TrustStore.systemSignatureTier()`
   then reports **`release-keys`**. Test-key-signed packages stop
   verifying as System-signed on that machine — which is the point of
   rotating.

## History

The 2026-11-12 security audit (finding F1) removed a committed development
key whose private half matched the shipped trust anchor while the build
still *required* an environment key, which silently produced unsigned
packages that no longer verified as System on any machine other than the
original one — a fork-breaking change. This directory exists so that the
default state is an honest, AOSP-style **public test key**, not a broken
build: default builds work everywhere and are labelled `test-keys`;
release builds rotate through the environment variables above.
