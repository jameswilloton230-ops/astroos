# `.novaapp` App Development Guide

This guide documents the `.novaapp` package format and the APIs available to sandboxed apps on NovaByte OS and compatible NBOSP systems. Studio setup, templates, and Studio builds are covered in the [NovaByte Studio README](./README.md).

## Manifest Format

Every app needs a `manifest.json` at the root of its directory (`novaapp.json` is also accepted).

### Minimal manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "entry": "index.html"
}
```

### Full manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "description": "A short description",
  "author": "Your Name",
  "email": "you@example.com",
  "website": "https://example.com",
  "entry": "index.html",
  "icon": "box",
  "type": "blank",
  "permissions": ["fs:read:images"],
  "optionalPermissions": ["device:notifications"],
  "ipc": {
    "exports": [],
    "receives": []
  },
  "notifications": {
    "channels": [
      { "id": "messages", "name": "Messages", "importance": "high" }
    ]
  },
  "handles": {
    "extensions": [".mp3", ".flac"]
  },
  "defaultSize": [800, 560],
  "minSize": [400, 300],
  "maxSize": [1600, 1200],
  "resizable": true,
  "frame": true,
  "categories": ["utilities"]
}
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique app ID — reverse domain format (see [App ID format](#app-id-format)) |
| `name` | string | Display name shown in the OS |
| `version` | string | Semantic version `x.y.z` |
| `entry` | string | Main HTML file to load |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | Short description |
| `author` | string | — | Your name |
| `email` | string | — | Contact email |
| `website` | string | — | Your site |
| `icon` | string | `"box"` | Icon Lucide name, data URI, or URL |
| `type` | string | `"blank"` | App type |
| `unrestrictedEntry` | string | — | Packaged JavaScript entry used by OS-managed unrestricted launch paths |
| `permissions` | array | `[]` | Required capabilities; missing sensitive grants are requested at launch, but denial does not block the app |
| `optionalPermissions` | array | `[]` | Optional permissions — app must handle denial gracefully |
| `permissionReasons` | object | — | Per-permission reason text shown in the grant dialogs — see [Declared reasons](#declared-reasons--permissionreasons) |
| `defaultSize` | array | `[800, 560]` | `[width, height]` in pixels |
| `minSize` | array | `[400, 300]` | Minimum window size |
| `maxSize` | array | — | Maximum window size |
| `resizable` | boolean | `true` | Whether the window can be resized |
| `frame` | boolean | `true` | Whether the window has a title bar |
| `transparent` | boolean | `false` | Enables an alpha-capable sandboxed app surface |
| `categories` | array | `[]` | App categories for filtering |
| `handles` | object | — | File extensions, URL protocols, MIME types, and roles your app can open — see [Default Apps](#default-apps) |
| `ipc` | object | — | App-to-app service/provider endpoints and broadcast actions your app accepts — see [Inter-app communication](#inter-app-communication) |
| `notifications` | object | — | `{ "channels": [...] }` registered before your first post — see [Notifications](#notifications--novanotifications) |
| `allowNestedWebview` | boolean | `false` | Manifest opt-in required (with the user grant) for `sandbox:nested-webview` |
| `allowPopupsToEscapeSandbox` | boolean | `false` | Manifest opt-in required (with the user grant) for `sandbox:escape-popups` |
| `sandbox` | object | — | `{ "allowSameOrigin": true }` manifest opt-in required (with the user grant) for `sandbox:same-origin` |

### Sandboxed execution and system APIs

Third-party packages run inside an isolated app webview. Trusted, bundled NovaByte System apps are different: after the OS verifies their signature, integrity, and first-party bundle identity, they run directly in the OS page with unrestricted host access. They are not sandboxed, and this path is only for OS-controlled system code — a package cannot gain it by setting `system: true` or claiming the NovaByte System signer.

`unrestrictedEntry` names the packaged JavaScript file used by OS-managed unrestricted launch paths. Ordinary app content loads from `entry`. A third-party package can request `system:root` to run its `unrestrictedEntry` directly in the OS page, but that is a separate, critical permission — not a system-app signature. It is available only when Developer Mode and Root Access are enabled, and requires the user's explicit grant acknowledging the app runs outside its sandbox.

The `system:root` grant gives the app unrestricted host-page access; it does not by itself run Linux commands as root. For privileged OS operations the app must call the OS `NovaRoot` broker (`window.NovaRoot`). The broker checks the live grant and settings, shows a NovaByte-owned confirmation prompt, and runs argv-based commands through passwordless `sudo`. The prompt authorizes a temporary session (up to 15 minutes); the command's system changes may persist after that session ends. This requires `sudo` and the NBOSP passwordless sudoers rule in the OS image. The broker audits its own root operations but cannot audit arbitrary JavaScript run by an unrestricted app.

Built-in headless system services also run in the OS page, not in isolated AppSandbox guests. Their startup is restricted to the verified first-party system bundle and declared service manifest.

### App ID format

Use reverse domain name notation. Studio's manifest validation enforces this at Build time.

```
✅  com.example.myapp
✅  io.github.username.app
✅  webapp_uniqueid          ← web app shortcut IDs use this prefix instead
❌  MyApp                    ← no uppercase
❌  myapp                    ← needs at least one dot
```

### Default Apps

Declaring a `handles` block makes your app selectable in **Settings → Default Apps** and in the file context menu's **Open with...** chooser for matching types, alongside the built-in apps (Browser, TextEdit, Music, Gallery, Email, Calendar). Apps may also declare the `home` role to be offered as a Home app:

```json
{
  "handles": {
    "extensions": [".webp"],
    "mimeTypes": ["image/heic"],
    "roles": ["home"]
  }
}
```

`protocols`, `extensions`, `mimeTypes`, and `roles` are independent and optional — declare whichever applies, or omit `handles` entirely. `roles` currently supports `home`; declaring it only makes the app eligible, the user must choose it in Settings. A selected third-party Home app is hosted in a full-screen sandboxed surface, not an OS application window, and does not receive host-page access. Home selection takes effect after the OS page reloads. Extensions are matched case-insensitively and should include the leading dot (`.mp3`, not `mp3`); protocols and MIME types are matched case-insensitively, MIME parameters are ignored, and subtype wildcards such as `image/*` are supported.

`handles` is a **discovery/selection** declaration, not a permission — it grants no ambient file access and there is no `handles:*` permission string. When the user opens a file through **Open with...**, the launch receives a `fileIntent` object in `window.__NOVA_APP_OPTIONS__`, and the host grants that sandbox access to only that selected file: read and write via `nova:fs:read` / `nova:fs:write` by file id, with no directory listing or access to other files. A user choice applies once unless they pick **Always use this app for this file type**; the OS re-checks the declaration and installed status at every launch, so a stale choice or a type the app no longer declares grants nothing.

Files opened without a matching `handles` declaration do not receive this scoped grant. Any installed `.novaapp`, including unsigned/Unverified ones, is eligible to appear in the chooser for types it declares; the OS does not currently restrict which apps may claim which types.

A sandboxed file manager can show the same OS chooser for a file it can access by calling `window.nova.openWith(fileId)`:

```javascript
fileMenuItems.push({
  label: 'Open with…',
  action: async () => {
    const result = await window.nova.openWith(file.id);
    if (result.cancelled) return;
    if (!result.success) console.error('The selected app could not be opened');
  }
});
```

The host checks the file is within the calling app's accessible filesystem scope before displaying the chooser. The app cannot pass a path or file contents to this API. It resolves to `{ cancelled: true }` if the user dismisses the chooser (or no compatible app is installed), or `{ cancelled: false, success, appId, windowId, defaultSaved }` after a choice. It shows the chooser every time; it never silently launches a remembered default.

```javascript
const intent = window.__NOVA_APP_OPTIONS__?.fileIntent;
if (intent?.action === 'open') {
  const file = await window.nova.ipc('nova:fs:read', { id: intent.file.id });
  // `file.data` is the selected file's content.
  // Saving this same file is scoped to this launch:
  await window.nova.ipc('nova:fs:write', {
    id: intent.file.id,
    content: 'Updated content'
  });
}
```

---

## Build process

When you hit Build in Studio:

- Reads and validates `manifest.json` (or `novaapp.json`)
- Validates the app ID format and all declared permissions against the known permission list
- If the project has a C/C++ source file (e.g. `module.cpp`, from the `native-cpp` template), compiles it with `emcc` first — output is `module.js` (glue) + `module.wasm`, bundled like any other file. The Build button turns purple when C/C++ sources are detected. Requires `emcc` on your PATH.
- Reads every file in the project directory and Base64-encodes it
- Generates an Ed25519 signature over the manifest + files payload
- Writes `<app.id>.novaapp` to your chosen output directory

### Headless system services

NovaByte's built-in headless services are first-party `.novaapp` packages whose entry scripts run directly in the OS page with unrestricted host access. Their manifests use `system: true`, `systemService: true`, and a packaged `unrestrictedEntry`; they have no user-facing window. This is privileged OS code, not sandboxed third-party execution.

Startup order is declared in `js/apps/system-service-manifest.json`. The loader checks package identity, integrity, and the NovaByte System signature against the trust store before launching each service. A manifest's `system` field alone is not authoritative. Framework/bootstrap pieces such as `boot.js`, `kernel.js`, `app-registry.js`, and trust/security initialization also run as OS-page scripts because they are prerequisites for safely loading packages.

Rebuild the built-in services after changing their source:

```sh
node build-apps.mjs js/apps background-apps calendar-notifier default-apps event-log notifications registry scanner server-events-bridge system-dialogs system-events
```

`npm start` and `npm run dev` build the NovaApp packages automatically. Set `NBOSP_SKIP_APP_BUILD=1` to skip that build and use the packages already on disk:

```powershell
$env:NBOSP_SKIP_APP_BUILD = '1'
npm start
```

Remove it with `Remove-Item Env:\NBOSP_SKIP_APP_BUILD` when you want the automatic build again.

---

## App Runtime

When a `.novaapp` is installed and launched, here's what actually happens:

### Install

The App Manager reads the file, validates the manifest fields (`id`, `name`, `version` are required), checks the signature (prompting the user if it fails rather than blocking outright), saves the app data to `localStorage` under `nova_installed_apps`, and calls `registerNovaApp()` so the app appears in the launcher.

In **App Manager → Packages**, user-facing system apps remain visible. Developer tools, the built-in launcher, and headless system services are hidden by default; enable **Show hidden apps** to inspect them. The launcher and headless services cannot be opened from App Manager, and headless services are managed by NovaByte rather than launched, disabled, or uninstalled individually.

### Launch — permission gate

Declaring a permission explains what your app may request; it does not grant access by itself. Low-risk permissions — public internet, public WebSockets, clipboard writing, notifications — are auto-granted unless the user previously denied them. `fs:access` is special all-files access: users enable it manually in Settings, and apps cannot prompt for it. Apps can always access their own `/data/` files; shared media uses type-specific read permissions; documents are opened or saved only after user selection in a file picker. Missing required medium-or-higher permissions go through the consent queue; denying one never blocks app launch — only that capability fails when called. Optional sensitive permissions are not prompted at launch: request them with `window.nova.requestPermission(...)` when the related feature is used.

This follows the Android distinction between ordinary install-time capabilities and sensitive access. Auto-grant is based on the OS risk catalogue, not on an app's `required` label, and a previous denial is never silently replaced.

Design each sensitive feature to be independently optional: explain the reason at the moment of use, request the permission then, and offer a useful fallback if it is denied.

### Launch — sandbox

Third-party apps run inside an NW.js `<webview>` element, not an iframe — a separate renderer process, not a same-document sandbox. There is no `window.parent`/`contentWindow` reference between guest and host, so the two sides cannot reach each other via DOM references or `postMessage`. Communication with the OS happens exclusively through `window.nova`, described below.

`allow-same-origin` is **not** granted to third-party apps by default — only to an audited allowlist of first-party system apps (exempted by app id, not by holding any permission). Granting it to a third-party app gives its guest content access to cookies/localStorage/sessionStorage on the shared origin, which widens the impact of any XSS inside that app. If your app genuinely needs it, **both** of these must be true, or `sanitizeSandboxAttr()` strips it and your webview runs without it:

1. Your manifest declares `sandbox: { allowSameOrigin: true }`, **and**
2. The user has granted the `sandbox:same-origin` permission (declare it in `permissions` so it's requested at launch — see [Permissions](#permissions)).

Declaring the manifest flag without the permission (or vice versa) still gets you a sandbox with no `allow-same-origin`. This is `high` risk — expect extra scrutiny before your app is verified.

**Do not rely on raw browser storage for durable data or guaranteed erasure.** Apps without `sandbox:same-origin` have their `persist:app_<appId>` execution partition cleared on final close; cleanup is serialized per app and a new launch waits for any required clear to finish. If clearing fails, the OS logs the failure and refuses to launch that app until a later retry succeeds. Revoking `sandbox:same-origin` closes that app's live sandbox windows and marks the partition for cleanup before a replacement launch. This is a fail-closed cleanup policy, **not** a forensic secure-erasure guarantee, and it does not affect `nova:storage:*` or the separate partitions used by nested browser views. For settings and save data that must persist, use [Storage](#storage); never store secrets in raw `localStorage` or cookies.

If your app just needs data to survive across launches — settings, save state, caches — don't request `sandbox:same-origin` for this. Use [`nova:storage:*`](#storage), which is durable by default, requires no permission, and isn't affected by any of this.

**Nested browser views:** creating an in-app browser view is gated separately and blocked by default. The supported Nova browser API is documented in [Building browser apps](#building-browser-apps). Legacy `<webview>` creation is proxied for compatibility; the host creates a sibling web-content view rather than a native child webview inside the app renderer. Both an app opt-in and the user's grant are required:

1. Your manifest declares `"allowNestedWebview": true` or `sandbox:nested-webview` in `permissions`, **and**
2. The user has granted the `sandbox:nested-webview` permission.

Without either opt-in or the grant, access is blocked. This is a critical permission because browser views expose live third-party web content and navigation; host-side network permissions continue to apply inside them.

The old advice to delay the first navigation by one second is obsolete. The host-mediated implementation creates the web-content view outside the app renderer. Prefer `window.nova.browser.createView()`: it waits for host-side view creation before starting the first navigation and gives your app a stable Nova API.

### Stable app URLs — OAuth and redirect callbacks

Your bundled files are reachable at **two** serving paths:

- **Per-session path** — `https://localhost:3003/api/apps/serve/sandbox_<app-id>_<unique>/index.html`. The `<unique>` suffix is regenerated at every launch, so this URL is for your app's own runtime navigation only. It is what your webview actually loads.
- **Stable per-app path** — `https://localhost:3003/api/apps/serve/sandbox_<app-id>/index.html`. Same bundled files, no unique suffix. This URL is fixed for the lifetime of the install, which is what redirect-based flows need.

Use the stable path as the `redirect_uri` you register with third-party providers — OAuth (GitHub, Google, …), payment providers, anything that redirects back to your app:

```
https://localhost:3003/api/apps/serve/sandbox_com.example.myapp/callback.html
```

Register that URL with the provider once; it keeps working across restarts. **Always use `https://`** — the OS server is TLS-only, and a provider redirecting to an `http://` callback sends the user's browser at the HTTPS port over plain HTTP. The server answers that with an explicit "HTTPS required" error page (never silently), but the flow stops there. Behavior of the stable path:

- It resolves to the **most recent launch** of your app. Relaunching repoints it; a still-open older window keeps its own per-session path, so multi-window apps are unaffected.
- It serves files **only while your app is running**. When your app's last window closes, the stable path stops serving (HTTP 404) — an OAuth redirect that arrives after the user closed the app gets a 404, which is the honest signal to restart the flow.
- It serves the same **static bundled files** as the session path, under the same relaxed app CSP. Long-running apps are kept servable automatically (the OS refreshes the registry while a sandbox is alive), so a consent page that takes a while does not expire your files mid-flow.

A callback page is ordinary static HTML from your own bundle — it does **not** get the `window.nova` bridge (only the entry file gets the capability shim). Hand the authorization result back to your app yourself:

- **Popup flows** (`sandbox:escape-popups`): from `callback.html`, `window.opener.postMessage({ code }, '*')` — the `'*'` target origin is **required**, not a shortcut. Without `sandbox:same-origin` your app's guest window has an opaque origin, and the browser matches `postMessage`'s target origin against the *receiver* — a concrete origin string such as `window.location.origin` can never match an opaque origin, so the message is silently dropped: the popup closes, nothing arrives, and no error appears anywhere. `'*'` still delivers to exactly one window (the `window.opener` reference); the security check is the receiving side's origin validation, which works because the escaped popup runs at your real serving origin:

  ```js
  // app.js (receiver)
  if (event.origin !== 'https://localhost:3003') return; // sender is your escaped popup
  // callback.js (sender) — never a concrete targetOrigin here:
  window.opener.postMessage({ type: 'auth-callback', code }, '*');
  ```

  The same applies to `window.close()` + a watchdog: poll `popup.closed` for the failure case only, and let the `message` handler cancel the watchdog when the payload arrives.
- **In-page redirect flows**: navigating your own frame to the provider and back replaces your document; `callback.html` reads `?code=` from its own `location.search` directly.
- With `sandbox:same-origin` granted, the callback page (same origin and partition) can also relay through `localStorage`/`BroadcastChannel`.

The `sandbox:escape-popups` permission (see the [permission list](#full-permission-list)) covers the popup leg of these flows: popups open into an OS-owned overlay window that shares your app's storage partition, so provider login sessions work the way users expect. The user grant is checked **each time a popup is opened**, not once at launch — request it right before your first `window.open()` (or at any point before), and it applies to that popup immediately, no relaunch needed. Revoking it stops further escape popups at once. What the grant does requires the top-level `allowPopupsToEscapeSandbox` manifest flag; without it the OS never lets your popups leave the sandbox, and a popup that stays sandboxed runs at an opaque (`null`) origin — where the origin check above can never pass, so relay messages are dropped even though everything looks like it worked.

### Building browser apps

Use the Nova browser API for an in-app browser. It creates a host-managed browser view and exposes Nova event names and Promise-based operations; app code does not need `BrowserWindow`, `webContents`, `ipcRenderer`, `require('electron')`, or direct access to `OS`. The older nested `<webview>` proxy remains for compatibility, but new browser apps should prefer `window.nova.browser`.

#### 1. Declare browser permissions

```json
{
  "id": "com.example.browser",
  "name": "Example Browser",
  "version": "1.0.0",
  "entry": "index.html",
  "allowNestedWebview": true,
  "permissions": [
    "sandbox:nested-webview",
    "net:external"
  ]
}
```

`sandbox:nested-webview` allows the app to create a browser view. `net:external` allows it to navigate to public HTTP(S) sites and download external content. Declared public internet and WebSocket permissions are auto-granted unless previously denied. Internal NovaByte services and private-network destinations still require `net:internal`; `net:external` cannot reach them. If the nested-webview grant is absent, `window.nova.browser` is not available.

#### 2. Add the browser viewport and controls

Keep the viewport in a container with a definite height. The host-managed view fills the container:

```html
<form id="address-form">
  <button id="back" type="button" aria-label="Back">Back</button>
  <button id="forward" type="button" aria-label="Forward">Forward</button>
  <button id="reload" type="button">Reload</button>
  <input id="address" type="text" autocomplete="url" aria-label="Address or search">
  <button type="submit">Go</button>
</form>
<div id="browser-viewport" style="height: 600px"></div>
<p id="browser-status" role="status"></p>
<script src="app.js" defer></script>
```

The host enforces deferred execution for packaged external scripts even if `defer` is omitted. Keeping the attribute is still useful when testing the page outside NovaByte OS.

#### 3. Create a view and connect navigation

`createView()` resolves to a `BrowserView`. It installs its event listeners before it starts the initial navigation. A URL passed to the app through `nova:open-url` takes precedence over the optional initial `url`, so links opened by the OS are not replaced by the browser's home page.

```javascript
const HOME = 'https://example.com';
let browserView;

function addressToUrl(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(input) && !input.includes(' ')) {
    return 'https://' + input;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

async function main() {
  const address = document.getElementById('address');
  const status = document.getElementById('browser-status');
  const viewport = document.getElementById('browser-viewport');

  browserView = await window.nova.browser.createView({
    container: viewport,
    url: HOME,
    pollingInterval: 1000
  });

  browserView.addEventListener('url-change', event => {
    if (document.activeElement !== address) address.value = event.detail.url;
  });
  browserView.addEventListener('title-change', event => {
    document.title = event.detail.title || 'Browser';
  });
  browserView.addEventListener('navigation-start', () => {
    status.textContent = 'Loading…';
  });
  browserView.addEventListener('navigation-complete', () => {
    status.textContent = '';
  });
  browserView.addEventListener('navigation-error', event => {
    status.textContent = event.detail.errorDescription || event.detail.reason || 'Navigation failed';
  });
  browserView.addEventListener('state-change', event => {
    document.getElementById('back').disabled = !event.detail.canGoBack;
    document.getElementById('forward').disabled = !event.detail.canGoForward;
  });

  document.getElementById('address-form').addEventListener('submit', async event => {
    event.preventDefault();
    const url = addressToUrl(address.value);
    if (url) await browserView.navigate(url);
    address.blur();
  });
  document.getElementById('back').addEventListener('click', () => browserView.back());
  document.getElementById('forward').addEventListener('click', () => browserView.forward());
  document.getElementById('reload').addEventListener('click', () => browserView.reload());
}

main();
```

Navigation and download calls return Promises. Handle rejections in UI actions so permission denials and host errors are visible.

#### Browser API reference

```javascript
const view = await window.nova.browser.createView({
  container,            // required DOM Element
  url: 'https://…',     // optional; a pending OS open-url target takes precedence
  pollingInterval: 1000 // optional: 0 disables polling; otherwise 250–10000 ms
});
```

`BrowserView` exposes:

| Member | Behavior |
|--------|----------|
| `element` | The host-managed view element. Prefer the methods below. |
| `url`, `title`, `loading` | Latest known state. URL and title are also refreshed by polling, which catches client-side history changes. |
| `canGoBack`, `canGoForward` | Latest history availability (`null` until state is first queried). |
| `getState()` | Promise for `{ url, title, loading, canGoBack, canGoForward }`. |
| `navigate(url)` | Navigate to a URL; the host enforces network permissions. |
| `back()`, `forward()`, `reload()`, `stop()` | Browser navigation controls. |
| `find(query, options)` | Search page text; resolves with the match count and active match. Options: `backward`, `matchCase`, `wordStart`, `medialCapitalAsWordStart`. |
| `stopFinding(action)` | End page search; `action` is `clear`, `keep`, or `activate` (defaults to `clear`). |
| `setZoom(factor)` | Set page zoom from `0.25` through `5`. |
| `setZoomMode(mode)` | Set `per-view`, `per-origin`, or `automatic` zoom behavior. |
| `setUserAgent(userAgent)` | Override the view's user-agent string (maximum 512 characters). |
| `clearData(types)` | Clear selected site-data categories for this app's browser partition (for example `['cookies', 'cache', 'localStorage', 'indexedDB']`). |
| `executeScript(code)` | Execute JavaScript in the loaded site and resolve with its result. Treat page script execution as privileged; it runs with that site's access. |
| `on(type, listener)` | Listen for an event; returns an unsubscribe function. `addEventListener` / `removeEventListener` are also supported. |
| `destroy()` | Stop polling and remove the view. Call this when permanently discarding a view. |

Nova events use `CustomEvent`; read event-specific information from `event.detail`.

| Event | Detail |
|-------|--------|
| `navigation-start` | Top-level navigation started. |
| `navigation-redirect` | Navigation redirect details. |
| `navigation-commit` | Top-level committed URL and navigation details. |
| `navigation-complete` | Current state after the page load completes. |
| `navigation-error` | `{ url, reason, errorCode, errorDescription, isTopLevel }`. |
| `url-change` | `{ url, previousUrl }`, including in-page URL changes found by polling. |
| `title-change` | `{ title, previousTitle }`. |
| `state-change` | Current URL/title/loading/history state. |
| `state-error` | `{ error }` when the host cannot refresh browser state. |
| `new-window` | `{ url, disposition, width, height, window }`; decide whether to block, open a tab, or display a popup. |
| `download-request` | `{ url }` when page content requests a download. |
| `close`, `crash`, `destroy` | View lifecycle notifications. |

#### Host-rendered overlays

App DOM cannot paint above a host-managed browser view because it runs in a separate renderer. Use `window.nova.overlay.show()` to render custom HTML and CSS in a sandboxed host-layer frame. It requires the `sandbox:nested-webview` grant. The optional `bounds` are relative to the app viewport in CSS pixels; omitted bounds cover the app viewport. Use `data-nova-action` and `data-nova-field` attributes to receive user interactions. Call `hide()` when the overlay is no longer needed; replacing it, closing the app, or revoking the browser-view permission also removes it.

```javascript
const removeOverlayListener = window.nova.overlay.onEvent(event => {
  if (event.type === 'click' && event.action === 'close-bookmarks') {
    window.nova.overlay.hide();
  } else if (event.type === 'input' && event.field === 'search') {
    filterBookmarks(event.value);
  }
});

await window.nova.overlay.show({
  bounds: { left: 0, top: 0, width: 320, height: 560 },
  html: `
    <aside class="bookmark-panel">
      <header><strong>Bookmarks</strong>
        <button data-nova-action="close-bookmarks">Close</button>
      </header>
      <input data-nova-field="search" placeholder="Search bookmarks">
    </aside>
  `,
  css: `
    .bookmark-panel { box-sizing: border-box; height: 100%; padding: 16px;
      color: #eee; background: #252538; font: 14px sans-serif; }
    header { display: flex; justify-content: space-between; }
  `
});
// Later, when the app is disposed:
removeOverlayListener();
await window.nova.overlay.hide();
```

Overlay HTML is sanitized and runs in a script-disabled frame with network access blocked; scripts and inline event handlers in the markup are not run. The `onEvent` callback receives `click`, `input`, `change`, `submit`, or `keydown` events with the `action`/`field` value and relevant input `value`, checkbox `checked`, or key `key`. `show()` resolves with `{ success: true, overlayId }`.

For simple native-style menus, use `window.nova.contextMenu.show()`. Like `overlay.show()` it renders in a host layer, so it requires the same `sandbox:nested-webview` grant (and the `allowNestedWebview` manifest opt-in). Coordinates are client coordinates in the app viewport, such as `event.clientX` and `event.clientY`. Its Promise resolves with `{ cancelled: false, index }` after selection or `{ cancelled: true, index: null }` when dismissed:

```javascript
viewport.addEventListener('contextmenu', async event => {
  event.preventDefault();
  try {
    const result = await window.nova.contextMenu.show(event.clientX, event.clientY, [
      { label: 'Reload', icon: 'refresh' },
      { separator: true },
      { label: 'Close tab', danger: true }
    ]);
    if (!result.cancelled && result.index === 0) browserView.reload();
  } catch (error) {
    console.error('Could not show menu:', error);
  }
});
```

Menu items support `label` (required), `icon`, `shortcut`, `disabled`, and `danger`; separators use `{ separator: true }`. `window.nova.contextMenu.hide()` dismisses the current app menu.

#### Downloads and popups

Page-initiated downloads are denied by default at the native webview boundary. Handle `download-request` and use Nova's save-dialog-backed download method instead of granting a website filesystem access:

```javascript
browserView.addEventListener('download-request', async event => {
  try {
    const result = await window.nova.browser.download({
      url: event.detail.url,
      filename: 'download'
    });
    if (result.cancelled) return;
  } catch (error) {
    console.error('Download failed:', error);
  }
});
```

`download({ url, filename })` fetches through the app's permission-checked network bridge, then asks the user where to save the file. There is no size cap — the user's save-dialog confirmation is the control — but the payload is buffered in memory, so this is not a resumable or background download manager.

For `new-window`, create a view in your tab or popup container, then attach the pending popup to preserve the opener relationship:

```javascript
browserView.addEventListener('new-window', async event => {
  const popupView = await window.nova.browser.createView({ container: popupViewport });
  await event.detail.window.attach(popupView);
  if (event.detail.url) await popupView.navigate(event.detail.url);
});
```

Always provide a user-visible way to close popup views and call `destroy()` when a tab or popup is removed.

#### Browser-app boundaries

- Store bookmarks, history, preferences, and tab metadata with [`nova:storage:*`](#storage); never expose the host `OS` object to app code.
- The OS gives each app a persistent browser-content partition. Cookies and site storage are isolated from the app's own storage and other apps. The API does not let an app select arbitrary partitions or implement a private/incognito profile.
- `canGoBack` and `canGoForward` reflect URL history observed by the view, including polling discoveries. Use them for toolbar state; keep durable history UI in your app.
- Keep browser controls in the app's trusted UI, validate/normalize address-bar input, and never treat arbitrary user text as an executable URL scheme. Only HTTP(S) navigation is supported for nested browser views.
- Treat `executeScript()` as a privileged escape into the current site's page context. Use it only for explicit features and never interpolate untrusted strings into the script source.
- A browser app is responsible for tabs, history/bookmarks UI, downloads UI, popup policy, and user-facing error pages. The API does not provide browser extensions, engine internals, certificate-warning bypass, per-site permission prompts, download progress/resume, or profile management.
- Use [`window.nova.openUrl(url)`](#ipc-api--windownova) to hand a link to the OS-selected browser app rather than opening the system's external desktop browser.

### Launch — window.nova bridge

Before your app's HTML executes, the runtime injects `window.nova` into the guest's page — no import, no handshake required to start using it:

```javascript
window.nova.ipc(type, payload)        // → Promise, resolves with `result`, rejects with {code, message}
window.nova.requestPermission(...)    // convenience wrapper around nova:request-permission
window.nova.onEvent(eventName, cb)    // subscribe to pushed events (see Event bus below)
```

The `nova:ready` handshake fires automatically on load. Call it directly if you want the response (your app's metadata and actually-granted permissions):

```javascript
const info = await window.nova.ipc('nova:ready', {});
// { success, appId, permissions, optionalPermissions, osVersion, securityPatch }
console.log(info.permissions, info.optionalPermissions);
```

The v2 facade exposes the same payload, normalized — `window.novaOS.ready.get()` resolves `{ appId, permissions, optionalPermissions, osVersion, securityPatch, username }` (see [Ready snapshot](#ready-snapshot--windownovaosready)).

`window.fetch` and `XMLHttpRequest` inside your app are routed through the permission-checking bridge. `fetch()` remains the preferred API. The asynchronous `XMLHttpRequest` compatibility layer supports property callbacks and event listeners, string and supported binary/form request bodies (capped by the app's `httpBodyBytes` budget — 16 MiB by default), real CRLF response-header formatting, and text/JSON/ArrayBuffer/Blob response types. It intentionally rejects synchronous XHR. `timeout` raises timeout/loadend events in the guest but does not cancel the in-flight host request; incremental progress events, upload-target events, and credentialed XHR are not implemented. Use `fetch()` for new code.

There is no `window.__novaPrivateStore` — for isolated, namespaced storage use `nova:storage:*` (see [Storage](#storage)), which is backed by the host, not raw `localStorage` inside the guest.

---

## Permissions

Permissions are declared in `manifest.json` and checked before the app loads. Low-risk permissions are auto-granted unless previously denied; required medium-or-higher permissions are requested at launch, while optional sensitive permissions are requested when needed. Denying a permission never blocks app launch. Grants persist across sessions in `localStorage` (validated structurally on load) and unused app grants expire after 30 days of inactivity.

### Full permission list

52 permissions across 11 categories, mirroring `app-permission-manager.js` exactly — these are the only strings `validateManifest` recognizes without a warning.

The three Sandbox permissions have additional manifest opt-ins: `sandbox:nested-webview` requires the top-level `allowNestedWebview` field (or its declaration in `permissions`), `sandbox:same-origin` requires `sandbox.allowSameOrigin`, and `sandbox:escape-popups` requires `allowPopupsToEscapeSandbox`.

They differ in *when* the user grant takes effect. `sandbox:same-origin` shapes the document's origin itself, so it can only be honored when the sandbox is created — grant it before your app launches (a grant answered mid-session applies from the next launch). `sandbox:nested-webview` and `sandbox:escape-popups` are checked at the moment the capability is used — each webview or popup — so a grant answered mid-session applies immediately, and revoking it blocks further use right away. The sandbox *attribute* for escape-popups follows the manifest flag alone (the publisher's declaration of intent); the per-popup grant check is what actually gates consent.

Filesystem permissions follow scoped-storage rules: app-owned files need no grants; shared media requires a matching read grant; document access is user-picker mediated. `fs:metadata` grants metadata-only access to shared files, not contents. `fs:access` is manually enabled special access for the shared filesystem and never grants access to another app's private `/data/` directory.

`system:background`, `system:background:live`, and `system:autostart` are three deliberately separate grants — see [Background execution](#background-execution--novabackground).

| Permission | Category | Risk | Useful for |
|------------|----------|------|------------|
| `fs:access` | Filesystem | Critical | Special access to shared files; users enable it manually in Settings |
| `fs:metadata` | Filesystem | Medium | Reading metadata for shared files without their contents |
| `fs:watch` | Filesystem | Low | Change alerts for paths your app can already read (see [File watch](#file-watch--novafswatch--novaosfswatch)) |
| `fs:read:images` | Filesystem | Medium | Reading shared images |
| `fs:read:video` | Filesystem | Medium | Reading shared videos |
| `fs:read:audio` | Filesystem | Medium | Reading shared audio |
| `apps:communicate` | Apps | High | Calling other apps' exported services/providers and broadcasting (see [Inter-app communication](#inter-app-communication)) |
| `net:internal` | Network | High | Calling this OS's own API/server endpoints and explicitly authorized internal/private-network destinations; known cloud-metadata address literals are blocked by the network guards |
| `net:external` | Network | Low | Calling public internet services (auto-granted unless previously denied) |
| `net:websocket` | Network | Low | Public WebSocket connections (auto-granted unless previously denied) |
| `mail:read` | Email | High | Inbox viewers, search, unread-count widgets |
| `mail:write` | Email | Critical | Mark-as-read/move tools, compose-preview UIs, account connect/disconnect |
| `mail:send` | Email | Critical | Send-on-your-behalf tools (needs its own SMTP config — see [Mail](#mail--novamail--windownovamail)) |
| `mail:delete` | Email | Critical | Cleanup/triage tools (spam pruning, bulk delete) |
| `calendar:read` | Calendar | Medium | Agenda widgets, scheduling assistants |
| `calendar:write` | Calendar | High | Event creation, meeting schedulers |
| `calendar:delete` | Calendar | High | Calendar cleanup/sync tools |
| `contacts:read` | Contacts | Medium | Address-book pickers, CRM-style lookups |
| `contacts:write` | Contacts | High | Contact import/sync tools |
| `contacts:delete` | Contacts | High | Dedup/cleanup tools |
| `device:notifications` | Device | Low | Alerts, reminders, background-task completion pings |
| `device:geolocation` | Device | High | Maps, weather, location-tagged content |
| `device:camera` | Device | Critical | Photo capture, video chat, QR/barcode scanning |
| `device:microphone` | Device | Critical | Voice recording, voice chat, dictation |
| `clipboard:read` | Device | High | Paste-in tools, import-from-clipboard features — can expose whatever any other app or the user copied, not just your own app's data |
| `clipboard:write` | Device | Low | Copy-to-clipboard features (does not allow reading clipboard contents) |
| `data:export` | Data | Low | Export a targeted subset of your app's own storage namespace and import previously exported envelopes back (see [Data portability](#data-portability--novadata--windownovadata)) |
| `data:backup` | Data | Low | Snapshot your app's entire storage namespace to a portable envelope and restore it, optionally wiping first (see [Data portability](#data-portability--novadata--windownovadata)) |
| `secrets:store` | Data | Medium | Encrypted storage for your app's own passwords and tokens — never included in export/backup envelopes (see [Secrets](#secrets--novasecrets--novaossecrets)) |
| `system:info` | System | Medium | Diagnostics, "about this device" panels — also gates reading allowlisted settings values (see [Settings](#settings--novasettingsget--novasettingsset)) |
| `system:settings` | System | Medium | Preference sync, theme/settings dashboards |
| `system:apps` | System | Medium | Launchers, app-store-style installers, dock/dashboard replacements |
| `system:app-launch` | System | Low | Launching an installed app without access to app inventory or management |
| `system:root` | System | Critical | Runs the packaged `unrestrictedEntry` in the OS page after Developer Mode and Root Access are enabled and the user explicitly grants access; real root commands additionally require NovaRoot confirmation and working passwordless sudo |
| `system:events` | System | Medium | Reacting to protected OS-level events (see [Event bus](#event-bus--novaevents)) |
| `system:background` | System | Medium | Periodic sync/checks while closed (see below) |
| `system:background:live` | System | High | Staying alive after the window closes (see below) |
| `system:autostart` | System | High | Launching automatically at OS startup with no user action (see below) |
| `system:badge` | System | Low | Show a count or short label on your app's own taskbar icon (see [Taskbar badge](#taskbar-badge--novabadge)) |
| `system:schedule` | System | Medium | Schedule named alarms your running app reacts to — never self-launching while closed (see [Named alarms](#named-alarms--novaalarms--novaosalarms)) |
| `system:share-target` | System | Medium | Be offered as a destination in the share sheet and receive what the user sends (see [Share target](#share-target--systemshare-target--novaosshareoninbound)) |
| `push:receive` | System | Medium | Receive push messages from the app's own backend through the OS push service (see [Push delivery](#push-delivery--pushreceive--novaospush)) |
| `registry.read` | System | Low | Read the NovaByte Registry — OS and app config facts (the `HKNS/security` subtree stays blocked without `registry.system`; see [NovaByte Registry](#novabyte-registry--novareg--windownovaregistry)) |
| `registry.write` | System | Medium | Store settings in your app's own `HKNA/<your-app-id>/` registry subtree — quota'd, user-visible in the NovaReg editor |
| `registry.system` | System | Critical | Full Registry access: every hive, including the `HKNS` system keys and the `HKNS/security` subtree the OS boots from |
| `admin:apps` | Admin | High | Fleet/security audit tools — see actual grants per app, not just declared ones (needs admin mode) |
| `admin:users` | Admin | Critical | Session monitors, force-logout tools (needs admin mode) |
| `admin:system` | Admin | Critical | Security-policy dashboards, lockout/IP-block tuning (needs admin mode) |
| `admin:audit` | Admin | High | Security/activity log viewers (needs admin mode) |
| `sandbox:nested-webview` | Sandbox | Critical | Apps that create their own browser views for in-app browsing; requires the `allowNestedWebview` opt-in (or a `permissions` declaration) plus the user grant |
| `sandbox:same-origin` | Sandbox | High | Apps that need a stable origin for cross-tab logic, or `localStorage`/cookies that survive relaunch. Also requires `"sandbox": { "allowSameOrigin": true }` — the permission alone does nothing |
| `sandbox:escape-popups` | Sandbox | High | Apps whose popups need to open as normal, unsandboxed browser windows (e.g. OAuth flows, external checkout). Also requires `"allowPopupsToEscapeSandbox": true` — the permission alone does nothing |

`admin:*` additionally requires the machine itself to be in admin mode — a separate, local-only toggle in Settings → Privacy & Security → Admin Access. Granting an app an `admin:*` permission doesn't put the machine in admin mode by itself; both gates must pass, or the call is denied with a message saying so.

### Required vs optional

```json
{
  "permissions": ["fs:read:images", "net:internal"],
  "optionalPermissions": ["device:notifications"]
}
```

Required medium-or-higher-risk permissions are prompted for at launch, but a denial does not block the app from loading — check what was actually granted and degrade gracefully. Low-risk permissions are auto-granted regardless of which array they appear in, unless the user previously denied them. Optional sensitive permissions are not prompted at launch; users can grant them manually from Settings → Apps, or your app can request one at runtime.

### Declared reasons — `permissionReasons`

Every permission dialog shows a reason. You declare yours in the manifest with `permissionReasons` — a map from permission strings to a short explanation of why your app needs that grant:

```json
{
  "permissions": ["system:root", "fs:read:images"],
  "permissionReasons": {
    "system:root": "Needed to manage system services on behalf of the user.",
    "fs:read:images": "Displays a gallery of the user's shared images."
  }
}
```

When the OS prompts for one of these permissions — at launch, or at runtime via `nova:request-permission` — the dialog shows the declared text under the permission name, and the same text is stored with the grant so Settings shows why the app asked. If a runtime request passes its own `reason`, that call-specific text wins for that prompt; the manifest reason is the standing fallback. If neither exists, the dialog shows an explicit "This app declared no reason why it needs this permission." line rather than nothing, so an app that stays silent is visible as such.

Rules:

- Reasons must be non-empty strings, at most 500 characters after trimming. A package whose `permissionReasons` breaks this shape fails validation at install.
- Keys must be real permission strings (legacy `vfs:*` names are translated to their `fs:*` equivalents at install, mirroring the `permissions` array). Unknown keys and unusable values are stripped at install with an EventLog warning; validation reports them as non-fatal warnings so you catch typos at build time.
- A reason for a permission your manifest doesn't declare (in `permissions` or `optionalPermissions`) is kept but inert — no prompt can ever show it — and is flagged as a validation warning. Reasons never widen what an app can do; they are display text only.

### Requesting a permission at runtime

Use the `window.nova.requestPermission` convenience wrapper (or call `nova.ipc('nova:request-permission', ...)` directly — they're equivalent). The v2 form is `novaOS.permissions.request(permission, reason?)`, which resolves the granted boolean directly; `novaOS.permissions.checkRateLimited(permission)` is the cooldown peek below:

```javascript
const { granted } = await window.nova.requestPermission('fs:read:images', 'Needed to display shared images.');
console.log(granted); // true or false

// v2 equivalent:
const grantedV2 = await window.novaOS.permissions.request('fs:read:images', 'Needed to display shared images.');
```

`permanent` defaults to `true` (grant persists) unless explicitly set to `false`. The wrapper doesn't expose it — for a one-time, non-persistent grant, call `nova.ipc` directly:

```javascript
const { granted } = await window.nova.ipc('nova:request-permission', {
  permission: 'fs:read:images',
  reason: 'Needed to display shared images.',
  permanent: false,
});
```

#### Rate limiting

Every call to `requestPermission` shows a live dialog again, even if the permission was previously denied. A buggy or malicious app calling it in a loop could otherwise spam the user with dialogs, so requests for the same `appId:permission` pair are rate-limited:

- Up to **3 prompts within a rolling 60-second window** are shown normally.
- The next request in that window is **auto-denied with no dialog** (`granted` resolves to `false` immediately) and a cooldown starts.
- The cooldown is **5 seconds base**, **doubling for each consecutive denial** for that pair, capped at **15 minutes**. A grant resets the denial streak.
- Rate-limited requests are logged to `EventLog` (category `permissions`, severity `warn`) even though nothing is shown to the user.

Your app can't distinguish "the user clicked deny" from "auto-denied by the rate limiter" — both resolve `granted: false`.

To check cooldown status without triggering a prompt, use the `nova:permission-rate-limited` channel (or `novaOS.permissions.checkRateLimited(permission)` in v2 — same record):

```javascript
const status = await window.nova.ipc('nova:permission-rate-limited', {
  permission: 'fs:read:images',
});
// { limited: false }
// or, mid-cooldown: { limited: true, retryAfterMs: 4213 }
```

Calling `resetPermission` clears both the grant and any rate-limit cooldown state for that pair.

---

## Storage

### Key-value storage — `nova:storage:*`

Per-app key-value storage via the OS bridge. There is no `window.__novaPrivateStore` object; isolated storage is host-side, namespaced by app ID — your app can never read or overwrite another app's data:

```javascript
await window.nova.ipc('nova:storage:set', { key: 'settings', value: JSON.stringify({ theme: 'dark' }) });
const { value } = await window.nova.ipc('nova:storage:get', { key: 'settings' });
await window.nova.ipc('nova:storage:delete', { key: 'settings' });
await window.nova.ipc('nova:storage:clear', {});
const { keys } = await window.nova.ipc('nova:storage:keys', {});
```

Host-backed storage is durable across launches regardless of permissions — raw `localStorage`/cookies inside the guest are not (see [Launch — sandbox](#launch--sandbox)).

### Modern storage — `window.novaOS.storage` (API v2)

New apps can use the separate `window.novaOS` facade. It is additive: `window.nova` and its existing methods, payloads, return objects, and error behavior remain unchanged for older packages.

```javascript
if (window.novaOS.capabilities.has('storage.v2')) {
  const theme = await window.novaOS.storage.get('theme'); // stored value, or null
  await window.novaOS.storage.set('theme', 'dark');
  await window.novaOS.storage.remove('draft');
  const keys = await window.novaOS.storage.keys(); // string[]
  await window.novaOS.storage.clear(); // clears this app's storage only
}
```

`window.novaOS.apiVersion` is `2`. `capabilities.has(name)` returns `true` only for capabilities supported by this runtime; the initial v2 capability is `storage.v2`. The v2 facade uses the same host-side storage service — per-app isolation, key validation, size limits, quota enforcement, and error behavior are identical; it introduces no parallel store or privileged route.

| Behavior | Legacy API (V1) | Modern API (V2) |
|---|---|---|
| Global name | `window.nova` (preserved) | `window.novaOS` (new) |
| Read a value | `nova:storage:get` returns `{ success, value }` | `storage.get(key)` returns the value, or `null` if missing |
| Write a value | `nova:storage:set` with `{ key, value }` | `storage.set(key, value)` |
| Delete a key | `nova:storage:delete` with `{ key }` | `storage.remove(key)` |
| List keys | `nova:storage:keys` returns `{ success, keys }` | `storage.keys()` returns `string[]` |
| Clear storage | `nova:storage:clear` | `storage.clear()` |
| Results | Response objects preserved | Mutations resolve `undefined`; reads return normalized values |

### Storage Ledger — budgets, accounting, and scoped roots

Every app gets a **ledger record** host-side: per-app resource budgets, byte/request accounting, and a shared-file access audit. Apps can't see the ledger itself (Settings reads it for the storage/privacy dashboards); what apps get is the behavior:

**Per-app budgets.** The old fixed OS-wide caps are now defaults in a per-app budget table, enforced on every call. An app can be granted a bigger budget without an OS update:

| Budget | Default | Was | Override range |
| --- | --- | --- | --- |
| `storageQuotaBytes` | 256 MB | 25 MB | 1 MB – 2 GB |
| `ipcPayloadBytes` | 256 KB | 64 KB | 1 KB – 8 MB |
| `httpBodyBytes` | 16 MiB | 6 MiB | 64 KB – 64 MiB |
| `requestTimeoutMs` | 60 s | 30 s | 5 s – 10 min |

Your app can read its own numbers — and only its own — through the v2 facade:

```javascript
const { usage, budget } = await window.novaOS.storage.usage();
if (budget - usage < 64 * 1024) pruneOldData();
```

**Scoped filesystem roots.** Raw `/data/...` paths remain caller-relative (the host injects your app's own id segment; there is no way to name another app's subtree). On top of that, three logical roots are accepted anywhere a path is:

```javascript
// 'appdata:' — YOUR own /data/<appId>/ subtree. Always caller-scoped.
await window.novaOS.fs.appdata.write('notes/todo.txt', 'hello');
const listing = await window.novaOS.fs.appdata.list('notes');
// appdata.read resolves the same file record nova:fs:read returns:
// { data, mimeType, name, size, id, path, modified, created }.
const file = await window.novaOS.fs.appdata.read('notes/todo.txt');
console.log(file.data);

// 'shared:' / 'media:' — the shared tree (Documents, Downloads, …) under
// the same permission rules as raw paths: media grants, user-picked files,
// or fs:access. 'shared:' and 'media:' cannot address /data at all.
await window.nova.ipc('nova:fs:read', { path: 'shared:/Downloads/report.txt' });
```

`appdata:/someOtherApp/…` is not an escape: the caller-relative rewrite happens after scheme expansion, so it still lands in **your own** subtree.

**Indexed media.** `window.novaOS.media.query()` returns shared image, audio, or video metadata from NovaByte's MediaStore index. Querying requires a matching `fs:read:images`, `fs:read:audio`, or `fs:read:video` grant, `fs:metadata`, or `fs:access`; each returned item is filtered through the same metadata permissions. The returned `path` is a `media:` path. Read its bytes separately through `window.novaOS.fs.read()`, which applies the usual per-file read grant and audit:

```javascript
const { files } = await window.novaOS.media.query({ type: 'image', limit: 100 });
const image = files.length ? await window.novaOS.fs.read(files[0].path) : null;
```

Supported query types are `image`, `audio`, `video`, and `all`. Results include `id`, `name`, `type`, `mimeType`, `size`, `created`, `modified`, and `path`; queries accept a bounded `limit` and `offset`.

**Shared-access audit.** Reads and writes outside your own `appdata:` subtree (shared files via grants, user-picked files) are logged to the ledger and surfaced in **Settings → Privacy & Security → File Access Audit**. Apps that stay inside their own sandbox generate no audit entries.

**Accounting.** Bytes written/read and request counts are tracked per app (storage sets, fs writes, fetch bodies) and power the **Settings → Storage → Per-App Storage** dashboard. Quotas are enforced by the system regardless of what the app does.

---

## Data portability — `nova:data:*` / `window.nova.data`

History note, because it matters: `data:export` and `data:backup` were listed in the earliest permission documentation but **were never implemented** — dead metadata with no backing handler — and were later removed from the docs entirely. They now exist for real, with the semantics below.

Two permissions, both **low risk** because the entire surface is strictly caller-scoped — it touches your app's own key/value namespace (the same store behind `nova:storage:*`) and nothing else:

- **`data:export`** gates `nova:data:export` + `nova:data:import` — targeted subsets. Export a selection of your own storage keys (an explicit key list or a key prefix) as a portable envelope; import merges a previously exported envelope back over the live namespace (merge only — import never deletes keys).
- **`data:backup`** gates `nova:data:backup` + `nova:data:restore` — full snapshots. Back up your entire namespace as one envelope; restore it, optionally wiping the namespace first (`clearFirst: true`) for a true reset-then-restore.

Envelope shape (versioned, checksummed):

```json
{
  "novaDataEnvelope": 1,
  "format": 1,
  "kind": "backup",
  "appId": "com.example.myapp",
  "capturedAt": "2026-11-04T12:00:00.000Z",
  "storage": { "key": "value" },
  "counts": { "keys": 1, "bytes": 42 },
  "checksum": "<sha256 hex over a key-sorted serialization of storage>"
}
```

Rules the host enforces, in order:

1. **Envelope validation** — `novaDataEnvelope: 1`, matching `format`, and a `kind` matching the channel (restore wants `'backup'`, import wants `'export'`); anything else rejects with `INVALID_ARGS`.
2. **appId pinning** — an envelope only ever restores/imports into the app that produced it. A `kind`-valid envelope whose `appId` differs from the caller rejects with `POLICY_BLOCKED`; envelopes are deliberately **not** a cross-app data-transfer channel.
3. **Integrity** — the checksum is re-computed and compared before anything is written; a corrupted or hand-edited envelope rejects with `INVALID_ARGS` instead of half-writing.
4. **Normal storage limits** — values are written through the same path as `nova:storage:set`, so the per-value byte cap and the per-app quota apply; a value over the cap is reported per-key in `failedKeys` rather than failing the whole call.

```javascript
// Requires data:export
const { envelope } = await window.nova.data.export({ prefix: 'recipes.' });
await window.nova.data.import(envelope);                    // merge back

// Requires data:backup
const { envelope: snapshot } = await window.nova.data.backup();
const result = await window.nova.data.restore(snapshot, { clearFirst: true });
// → { success: true, restoredKeys, cleared: true, failedKeys: [] }
```

Envelope payloads can be large (they contain your whole namespace), so persist them through the same channels you already use for user files: `nova:files:save`, the download surface, or your app's own export flows. The OS does not store envelopes for you.

---

## Platform API v2 — `window.novaOS` (completed facade)

`window.novaOS` is the additive, modern API surface. It started as a small facade (storage, fs roots) and now covers **every v1 channel family** in full — nothing with a raw `nova:...` channel is left facade-less. Everything it does is **pure sugar over the existing v1 channels**: same payloads, same return records, same error codes, same permission gates, same host-side checks. Nothing in the facade bypasses, re-implements, or relaxes the host boundary.

Detect a surface before using it — capabilities are a runtime feature statement, not a permission state:

```javascript
if (window.novaOS.capabilities.has('fs.v2')) {
  await window.novaOS.fs.write('appdata:/notes/todo.txt', 'hello');
}
```

Current capability names: `storage.v2`, `fs.v2`, `clipboard.v2`, `notifications.v2`, `window.v2`, `dialogs.v2`, `app.v2`, `data.v2`, plus the newer host-side powers `locale.v1`, `badge.v1`, `fsWatch.v1`, `alarms.v1`, `secrets.v1`, `shareTarget.v1`, `push.v1`, `registry.v1`, and the v2 sugar over the remaining frozen channels: `settings.v2`, `ready.v2`, `events.v2`, `geolocation.v2`, `media.v2`, `calendar.v2`, `contacts.v2`, `mail.v2`, `admin.v2`, `background.v2`, `permissions.v2`, `net.v2`. New capabilities may be added in future runtimes; existing names are never removed.

| Facade | Methods | Wraps (unchanged) | Permission (unchanged) |
| --- | --- | --- | --- |
| `storage` | `get set remove clear keys usage` | `nova:storage:*` | none — always your own namespace |
| `fs` | `read write list stat mkdir rename move remove` + `watch`/`unwatch` + `appdata.*` / `shared.*` roots | `nova:fs:*` + `nova:fs:watch` | same path rules as raw `nova:fs:*`; watch adds `fs:watch` |
| `clipboard` | `readText() → text\|null`, `writeText(text)` | `nova:clipboard:*` | `clipboard:read` / `clipboard:write` |
| `notifications` | `show post createChannel cancel cancelAll clear consumeActions` | `nova:notifications:*` | `device:notifications` |
| `window` | `close minimize maximize setTitle resize getState` | `nova:window:*` | none |
| `dialog` | `pickOpen(options)`, `pickSave(options)` | `nova:sysdialog:*` / `nova:dialog:*` | none — user-mediated |
| `app` | `info list launch openUrl share openWith` | `nova:app:*`, `nova:open-url`, `nova:share`, `nova:open-with` | same as wrapped channel |
| `data` | `export import backup restore` | `nova:data:*` | `data:export` / `data:backup` |
| `locale` | `get()` → `{ locale, region, timeZone, firstDayOfWeek }` | `nova:locale:get` | none |
| `badge` | `set(count\|{text})`, `clear()` | `nova:badge:*` | `system:badge` |
| `alarms` | `create(options)`, `clear(name)`, `getAll()`, `onAlarm(cb)` | `nova:alarms:*` | `system:schedule` |
| `secrets` | `set(key, value)`, `get(key)`, `delete(key)`, `keys()` | `nova:secrets:*` | `secrets:store` |
| `share` | `onInbound(cb)` | push: `nova:share:inbound` | `system:share-target` |
| `push` | `register()`, `unregister()`, `onMessage(cb)` | `nova:push:*` + push: `nova:push:message` | `push:receive` |
| `settings` | `get(key)`, `set(key, value)` | `nova:settings:get` / `nova:settings:set` | `system:info` (read) / `system:settings` (write; wallpaper keys exempt) |
| `ready` | `get()` → `{ appId, permissions, optionalPermissions, osVersion, securityPatch, username }` | `nova:ready` | none |
| `events` | `on(name, cb)` → off, `subscribe(name)`, `unsubscribe(name)` | `nova:events:*` + push: `nova:events:event` | allowlist; `system:events` (+ domain read) for sensitive events |
| `geolocation` | `getCurrentPosition(options?)` → `{ coords, timestamp }` | `nova:device:geolocation` | `device:geolocation` |
| `media` | `query(options)` → MediaStore index, `checkCamera()`, `checkMicrophone()`, `getUserMedia(constraints)` | `nova:media:query`, `nova:device:camera`, `nova:device:microphone` | query: matching media read grant / `fs:metadata` / `fs:access`; checks: `device:camera` / `device:microphone` |
| `calendar` | `list()` → events, `save(event)` → record, `remove(id)` → bool | `nova:calendar:*` | `calendar:read` / `calendar:write` / `calendar:delete` |
| `contacts` | `list()` → contacts, `save(contact)` → record, `remove(id)` → bool | `nova:contacts:*` | `contacts:read` / `contacts:write` / `contacts:delete` |
| `mail` | `connect disconnect restore account folders messages message search preview markRead move send remove openLink` | `nova:mail:*`, `nova:email:open-link` | `mail:read` / `mail:write` / `mail:send` / `mail:delete` |
| `admin` | `auditQuery systemGet systemSet usersList usersRevoke appsList` | `nova:admin:*` | `admin:*` + machine admin mode |
| `background` | `stayAlive(enabled?)` → `{ enabled }`, `wakeDone()`, `onWake(cb)` → off | `nova:background:stay-alive`, `nova:background:wake-done` + push: `nova:background:wake` | `system:background:live` (stayAlive); wakes gated host-side by `system:background` |
| `permissions` | `request(permission, reason?)` → bool, `checkRateLimited(permission)` → status | `nova:request-permission`, `nova:permission-rate-limited` | none — requesting grants is the point |
| `net` | `websocket(url, protocols?)` → handle `{ wsId, readyState, onMessage, onError, onClose, send, close }` | `nova:net:websocket`, `nova:net:ws:send`, `nova:net:ws:close` + pushes `nova:net:ws:message` / `ws:error` / `ws:close` | `net:websocket` (+ `net:internal` for private/first-party hosts) |
| `registry` | `get(path)` → value\|undefined, `stat(path)`, `set(path, value, type?)`, `remove(path, {recursive}?)`, `list(path)`, `export(path)`, `import(path, data)`, `watch(path, cb)` → off | `nova:reg:*` + push: `nova:reg:changed` | `registry.read` (get/stat/list/export/watch) / `registry.write` (set/remove/import) + per-hive rules — see [NovaByte Registry](#novabyte-registry--novareg--windownovaregistry) |

Normalization rules, and nothing more: mutation methods resolve `undefined`; reads return the value directly (e.g. `clipboard.readText()` → the text or `null`, `window.getState()` → the state record without its `success` flag). Everything else — file records, envelopes, notification responses, error rejections with `.code`/`.message` — is exactly the object the wrapped channel returns. Permission denials reject with `PERMISSION_DENIED` exactly as they do over raw `window.nova.ipc`.

```javascript
// Clipboard roundtrip (needs clipboard:read + clipboard:write).
await window.novaOS.clipboard.writeText('copied');
const text = await window.novaOS.clipboard.readText();

// Window controls (no permission).
await window.novaOS.window.setTitle('My App');
const { width, height, maximized } = await window.novaOS.window.getState();

// Dialog — one pair of methods for both historical pickers.
// style: 'styled' (default) → the OS-styled picker (nova:sysdialog:*);
// style: 'system' → the plain picker (nova:dialog:*). Both are
// user-mediated: your app only ever receives what the user picked.
const picked = await window.novaOS.dialog.pickOpen({ accept: '.json', multiple: false });
const target = await window.novaOS.dialog.pickSave({ defaultName: 'out.txt', style: 'system' });

// App management + intents (same gates as nova:app:*).
const { id } = await window.novaOS.app.info();
await window.novaOS.app.launch('com.example.other');
await window.novaOS.app.share({ title: 'Look', text: 'shared text' });

// Locale + badge (new host powers — see their own sections below).
const { region, firstDayOfWeek } = await window.novaOS.locale.get();
await window.novaOS.badge.set(3);

// Settings (system:info to read, system:settings to write) + the ready
// snapshot (no permission — see their own sections below).
const theme = await window.novaOS.settings.get('theme');
await window.novaOS.settings.set('accentColor', '#3366ff');
const { appId, permissions } = await window.novaOS.ready.get();

// The full-coverage sugar over the remaining v1 families — same gates,
// normalized results only (each is detailed in its own chapter below).
const off = await window.novaOS.events.on('system:themeChanged', (data) => {});
const { coords, timestamp } = await window.novaOS.geolocation.getCurrentPosition();
const stream = await window.novaOS.media.getUserMedia({ video: true });
const events = await window.novaOS.calendar.list();
const granted = await window.novaOS.permissions.request('device:geolocation', 'Show nearby stores');
const { enabled } = await window.novaOS.background.stayAlive();
```

The `dialog` facade deserves one explicit note: it exists precisely because the two picker families (`nova:dialog:*` plain, `nova:sysdialog:*` styled) predate the v2 facade and remain separately available for compatibility. New apps should use `novaOS.dialog` and stop caring which picker family runs underneath; the raw channels stay unchanged either way.

---

## IPC API — `window.nova`

Apps communicate with the OS via `window.nova.ipc(type, payload)`, injected automatically before your app's script runs:

```javascript
try {
  const result = await window.nova.ipc('nova:<category>:<action>', {
    // ... payload fields
  });
  console.log(result);
} catch (err) {
  // err.code and err.message are set for IPC-level errors (see Error codes below)
  console.error(err.code, err.message);
}
```

### App lifecycle and launch intents — `window.nova.app`

`nova:open-url` and app launches carry options into the new app session. Use the app facade instead of reading host globals:

```javascript
const info = await window.nova.app.getInfo();
const options = await window.nova.app.getLaunchOptions();

const removeLaunchListener = window.nova.app.onLaunch(({ options, reason }) => {
  if (options.url) navigateTo(options.url);
  if (options.sharedText) showSharedText(options.sharedText);
});

const removeStateListener = window.nova.app.onStateChange(({ visible, focused }) => {
  // Pause animations or defer nonessential refresh work while not visible.
});
```

`onLaunch` reports this app window's initial options; it is not an app-to-app broadcast channel. `onStateChange` reports this document's visibility/focus and returns an unsubscribe function. These lifecycle signals do not grant background execution; background work still requires the relevant `system:background*` permission.

### Inter-app communication

NovaByte uses host-brokered APIs rather than an Android-Binder-style direct channel. Explicit launches are available through `window.nova.app.launch(appId, options)` and require `system:app-launch`; this grant does not expose another app's data. `window.nova.openWith(fileId)` and `window.nova.openUrl(url)` use the OS's registered handlers/default apps for file and URL intents. A file opened through the OS chooser receives a temporary grant for that selected file only. There is no package-enumeration API through this broker, so there is no Android 11-style package-visibility query declaration.

For service requests, provider-style data methods, and app broadcasts, **both** apps must hold the high-risk `apps:communicate` permission. The receiving app must also declare each exported endpoint or broadcast action in its manifest; the host only routes requests to an active sandbox and never starts a provider app implicitly.

```json
{
  "permissions": ["apps:communicate"],
  "ipc": {
    "exports": [
      "service:com.example.weather.current",
      "provider:com.example.contacts.lookup"
    ],
    "receives": ["com.example.notes.changed"]
  }
}
```

The `service:` / `provider:` prefixes distinguish call kinds. Each endpoint is a request/reply callback implemented by the receiving app:

```javascript
const stopProviding = await window.nova.ipc.provide(
  'provider:com.example.contacts.lookup',
  async ({ sourceAppId, data }) => {
    if (data.query !== 'Ada') return null;
    return { id: 'contact-1', name: 'Ada' };
  }
);

const response = await window.nova.ipc.call(
  'com.example.contacts',
  'provider:com.example.contacts.lookup',
  { query: 'Ada' }
);
console.log(response.result);
```

Provider callbacks return data chosen by the provider; they do not grant access to its filesystem, database, or private app directory. Treat requests and returned data as untrusted, validate the request shape, and return only the minimum data needed. Requests time out after 25 seconds, carry up to the app's `ipcPayloadBytes` budget of JSON data (256 KB by default), and are rate-limited to 20 per minute per app and endpoint type.

Broadcast actions are opt-in and delivered only to active apps that declare the action under `ipc.receives`, subscribe to it, and hold `apps:communicate`:

```javascript
const stopListening = await window.nova.ipc.onBroadcast(
  'com.example.notes.changed',
  ({ sourceAppId, data }) => refreshNote(data.noteId)
);

await window.nova.ipc.broadcast('com.example.notes.changed', { noteId: 'note-1' });
```

Each `provide` and `onBroadcast` registration resolves to an unsubscribe function. `onEvent` remains the separate OS-event API. App broadcasts cannot forge system events.

### Appearance — `window.nova.appearance`

Reading the small, non-sensitive appearance snapshot and subscribing to its changes require no permission:

```javascript
const current = await window.nova.appearance.get();
const unsubscribe = await window.nova.appearance.onChange(appearance => {
  /* appearance.theme is an OS theme id ('nova-light', 'nord', …), NOT a
     light/dark token. Map it to your app's own theme names — unless your
     stylesheet really covers every OS id — or the assignment below matches
     no selector and your app silently keeps its default look. */
  const light = appearance.theme === 'nova-light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.style.setProperty('--accent', appearance.accentColor || '');
  document.documentElement.classList.toggle('high-contrast', appearance.highContrast);
  document.documentElement.classList.toggle('reduce-motion', appearance.reduceMotion);
});
// later, when the view is disposed:
unsubscribe();
```

`appearance.theme` is an OS theme id, not a light/dark token. Apps that only ship a light and a dark variant must map ids onto their own theme names (above) instead of assigning the id raw to an attribute like `data-theme` — an unmatched selector fails silently, leaving the app stuck on its default look. Every OS theme id except `'nova-light'` currently names a dark palette, so map unrecognized ids (from future OS versions) to your dark variant.

The API deliberately does not expose unrelated OS settings. `set` accepts only the supported appearance fields and validated values; it does not require `system:settings`. Valid values: `theme` must be one of the OS theme ids — `'nova-dark'`, `'nova-light'`, `'nord'`, `'dracula'`, `'catppuccin'`, `'tokyo-night'`, `'gruvbox'` (an unknown theme rejects with `INVALID_ARGS`); `accentColor` is a `#rrggbb` hex string or `null`; `highContrast`, `reduceMotion`, and `transparentSurfaces` are booleans. `onChange` calls the callback immediately with the current snapshot, then on each change. Updates are rate-limited to 10 per minute.

```javascript
await window.nova.appearance.set({
  theme: 'nord',
  accentColor: '#5e81ac',
  highContrast: false,
  reduceMotion: true,
  transparentSurfaces: true
});
```

### User-mediated sharing — `window.nova.share` / `novaOS.app.share`

Opening the OS share sheet needs no permission: the user chooses what happens next, and the app cannot silently write to the clipboard or launch a recipient through this chooser. Both the v1 channel and the v2 facade accept the same payload:

```javascript
// v1
const result = await window.nova.share({
  title: 'Share this page',     // optional; defaults to your app's name, trimmed to 120 chars
  text: 'Useful note',          // optional, max 4000 chars
  url: 'https://example.com/article' // optional, credential-free HTTP(S) only
});
if (result.cancelled) return;

// v2 — identical payload and result (capability: app.v2)
const r2 = await window.novaOS.app.share({ title: 'Look', text: 'shared text', url });
```

At least one of `text` or `url` must be present. `url` must be a credential-free `http:`/`https:` link (no `user:pass@`) or the call fails with `INVALID_ARGS`; more than 4000 characters of text is also `INVALID_ARGS`. The sheet is rate-limited to 5 opens per minute per app (`RATE_LIMITED` beyond that).

The sheet offers some of: **Copy** (text + url to the OS clipboard), **Open link in browser** (only when a `url` was supplied), **Email** (opens the Mail composer with the title as subject and the text + url as the body), **Send to \<app\>** (one entry per installed share target — see [Share target](#share-target--systemshare-target--novaosshareoninbound)), and **Cancel**. The returned object tells you what happened:

```javascript
{ cancelled: false, action: 'Copy' }            // the button label the user tapped
{ cancelled: true }                             // dismissed via Cancel / Esc / backdrop
{ cancelled: false, action: 'Send to Notes', sharedWith: 'Notes', queued: true }
```

`queued: true` means the target app was not running, so the inbound share is delivered on its next launch. A dismissed sheet is a normal outcome, not an error — treat it as "the user changed their mind".

### Desktop wallpaper — settings keys & `window.nova.wallpaper`

Changing the desktop wallpaper is a low-risk ambient capability: **no permission is required**. Two allowlisted settings keys control it, and they are exempt from the `system:settings` write grant that every other writable settings key needs (reads still require `system:info` as usual):

| Key | Value | Meaning |
| --- | --- | --- |
| `wallpaperId` | preset id string, or `null`/`''` to clear | One of the built-in gradient presets: `stock-blue`, `stock-dark`, `stock-light`, `stock-green`, `stock-purple`, `stock-red`, `stock-gray`, `stock-teal` |
| `customWallpaper` | image URL string (typically a `data:` URL), or `null`/`''` to clear | A custom image painted over the whole desktop (`background-size: cover`) |

The keys are mutually exclusive in practice: setting `customWallpaper` paints the image regardless of `wallpaperId`; clearing it back to `null` restores the preset named by `wallpaperId` (default `stock-blue` when both are empty). Values are validated — an unknown `wallpaperId` or a non-string `customWallpaper` fails with `INVALID_ARGS` instead of silently doing nothing, and both keys reject the change with `POLICY_BLOCKED` when the `prohibitWallpaperChange` kiosk policy is on:

```javascript
// Apply a downloaded image as the wallpaper (data: URL, any app, no permission)
await window.novaOS.settings.set('customWallpaper', dataUrl);
await window.novaOS.settings.set('wallpaperId', null); // optional hygiene

// Or switch back to a built-in preset
await window.novaOS.settings.set('customWallpaper', null);
await window.novaOS.settings.set('wallpaperId', 'stock-teal');

// Legacy dedicated bridge — same two keys, same validation, same policy gate.
// Equivalent to nova:settings:set for these two keys; kept for apps written
// against it.
await window.nova.wallpaper.set('wallpaperId', 'stock-purple');
await window.nova.wallpaper.set('customWallpaper', dataUrl);
```

Notes for apps:

- `wallpaperId` takes a **preset id**, never an image. Passing a data URL there fails with `INVALID_ARGS` (older runtimes silently fell back to the default preset — check `novaOS.capabilities` on new runtimes and treat `INVALID_ARGS` as the signal you used the wrong key).
- There is no size cap enforced host-side beyond the IPC payload budget, but large wallpapers are still subject to the platform's general payload limits — prefer a compressed image, and handle `PAYLOAD_TOO_LARGE` by offering the file for the user to set from Settings instead.
- The desktop applies changes live on the `settings:changed` event, so the new wallpaper appears immediately — no reload needed.

### Picker-scoped files — `window.nova.files`

Use these methods to import or export a document the user explicitly selects. The picker mediates access to one chosen file or save destination. It can show shared user files and the calling app's own private data, never another app's private `/data/<app-id>/` folder:

```javascript
const opened = await window.nova.files.open({
  title: 'Import notes',
  accept: ['text/plain', 'application/json', '.json']
});
if (!opened.cancelled) {
  console.log(opened.file.id, opened.file.name, opened.file.content);
}

const saved = await window.nova.files.save({
  title: 'Export notes',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  content: 'Exported content'
});
if (!saved.cancelled) console.log('Saved:', saved.file.path);
```

`accept` is an array of at most 20 entries; each entry is a MIME type (`'text/plain'`) and/or a file extension with its leading dot (`'.json'`), matching `<input accept>` semantics. Passing only MIME types used to be the accepted form — both forms (and mixed lists) work now, and an invalid entry rejects the call with `INVALID_ARGS` instead of being silently dropped.

Open/save calls return `{ cancelled: true }` when dismissed. A single selection is returned; use `nova:sysdialog:open` with `multiple: true` when the user needs to pick several files at once. Files are capped at 10 MB. A selected file's id can be used with `nova:fs:*` for the lifetime of that sandbox, with a confirmation for shared-file changes.

Picked-file content decoding (both this picker and `nova:sysdialog:open`): text-typed files come back as `content` text; binary files come back as base64 with an `encoding: 'base64'` marker, so image pickers get decodable bytes. A file whose extension the OS cannot type (a custom format like `.recipe`) is sniffed — clean UTF-8 text is returned as text, anything else as base64 with the marker.

### Filesystem — `nova:fs:*`

The filesystem is scoped by ownership and user choice:

- Apps can read, write, list, rename, move, and delete files in their own `/data/` directory without declaring a filesystem permission.
- Shared images, videos, and audio require `fs:read:images`, `fs:read:video`, or `fs:read:audio` respectively. `fs:metadata` permits metadata-only access, not contents.
- Shared documents and other non-media files are accessed through a file picker. Selecting a file grants that sandbox access to that file for the session; modifying, renaming, moving, or deleting it asks the user to confirm.
- `fs:access` enables broad access to shared files. It is special access managed manually in Settings, not promptable. It never exposes another app's private `/data/` directory.
- Apps cannot delete the filesystem root, `/data`, or the Trash folder. App-owned files remain private while in Trash.

```javascript
// Read a file in your app's own storage (no permission required).
// The file's bytes come back in `data` (the picker APIs use `file.content`).
const { data, size, modified } = await window.nova.ipc('nova:fs:read', { path: '/data/notes.txt' });

// Read shared media only after declaring the matching permission
const image = await window.nova.ipc('nova:fs:read', { path: '/Pictures/photo.png' });
// image.data is the content; image.mimeType / name / size / id / path too.

// List your app's files (no permission required)
const { files } = await window.nova.ipc('nova:fs:list', { path: '/data/' });
// files: [{ id, name, type, mimeType, size, modified, created }, ...]

// Get metadata only for a shared file (requires fs:metadata or its media read grant)
const { stat } = await window.nova.ipc('nova:fs:stat', { path: '/Pictures/photo.png' });
// stat: { id, name, type, mimeType, size, path, parentId, created, modified, accessed, tags }

// Write under your app's data (no permission required). Missing parent
// folders inside your own /data/ subtree are created automatically
// (mkdir -p semantics) — 'notes/deep/todo.txt' works without a prior
// mkdir. Missing parents in the SHARED tree still fail with NOT_FOUND.
await window.nova.ipc('nova:fs:write', { path: '/data/notes.txt', content: 'Hello' });

// Create a folder under your app root; omit path for app root.
// NOTE: 'path' must include the trailing slash ('/data/', not '/data') — see
// the path-rewriting section right below for why this matters.
await window.nova.ipc('nova:fs:mkdir', { path: '/data/', name: 'exports' });

// Rename / move / delete in your app data (no permission required)
await window.nova.ipc('nova:fs:rename', { path: '/data/notes.txt', name: 'renamed.txt' });
await window.nova.ipc('nova:fs:move', { path: '/data/notes.txt', destPath: '/data/exports/notes.txt' });
await window.nova.ipc('nova:fs:delete', { path: '/data/notes.txt' });

// For shared documents, use nova:files.open() to choose one; destructive
// changes through nova:fs require a separate confirmation from the user.
```

#### `/data/` path rewriting — read this before you build anything

The most common first-app bug is a caller mistake: passing the wrong `/data/` path shape. The errors you'll hit (`NOT_FOUND`, `PERMISSION_DENIED`) are the system correctly enforcing scoping; they just don't make *which shape you got wrong* obvious. Every `/data/`-prefixed path is rewritten host-side before it's resolved:

> Any path starting with `/data/` (**the trailing slash matters**) has the segment immediately after `/data/` replaced with your own app id, unconditionally — regardless of what you put there.

| You send | Host resolves it as | Result |
|---|---|---|
| `/data/notes.txt` | `/data/<your-app-id>/notes.txt` | ✅ correct — the intended usage |
| `/data/<your-app-id>/notes.txt` | `/data/<your-app-id>/<your-app-id>/notes.txt` | ❌ double-nested. `NOT_FOUND` — **never include your own app id in the path**, the host adds it for you |
| `/data` *(no trailing slash)* | `/data` unchanged — rewrite doesn't fire | ⚠️ resolves to the shared data root. The host filters private app folders so you only see your own subtree. |
| `/data/` *(trailing slash, nothing else)* | `/data/<your-app-id>/` | ✅ correct — the right way to refer to your own app root, e.g. for `list` or as `mkdir`'s parent |

**Takeaways:**
- Treat `/data/` (with the trailing slash) as your app's root constant. Don't hardcode your app id into any path.
- If `list`/`write`/`mkdir` on "my own root" returns folders that aren't yours, you almost certainly sent bare `/data` without a trailing slash.
- If you get `NOT_FOUND: Parent folder not found` on a path you were sure existed, check whether you concatenated your own app id into a `/data/`-prefixed path — that's the #1 cause.
- A leading double-slash from concatenation (e.g. `'/data/' + '/foo.txt'`) is harmless — empty segments are skipped — but avoid it for readability.

#### Auto-created subfolders in your app root

The first time your app's `/data/<your-app-id>/` folder is set up, the host pre-populates it with four subfolders:

```
/data/<your-app-id>/
  files/          — general-purpose app files (suggested default for user content)
  cache/          — disposable/regenerable data
  databases/      — structured/serialized data (JSON, etc.)
  shared_prefs/   — simple key-value settings
```

This mirrors Android's internal-storage convention by name, but the subfolders are organizational only — writing directly to your app root works exactly the same. If you list your root right after install and see these four folders, that's expected. File-browser-style apps should decide up front whether to show them or filter them out.

### File watch — `nova:fs:watch` / `novaOS.fs.watch`

Requires `fs:watch` (Filesystem / Low) **plus** the exact per-path access rules of `nova:fs:read` — watching is reading, never a way to learn about paths you couldn't already read. App-owned paths need no other grant; shared paths need the same grants a read would.

`novaOS.fs.watch(path, callback)` resolves with a handle: `{ watcherId, path, unwatch() }`. Changes arrive on the callback as `{ watcherId, path, kind: 'changed' | 'created' | 'deleted', timestamp }`.

Delivery is deliberately best-effort and budgeted host-side:

- max **8 watchers per app** (a 9th rejects with `RATE_LIMITED`);
- events are **debounced** — a burst of writes is one event;
- a per-app cap of **60 events per minute**; beyond it, events are coalesced away (the watcher stays live and healthy);
- a watcher whose target is deleted reports `kind: 'deleted'` once and keeps watching — recreating the path reports `created`;
- watchers are session-scoped and torn down with the app.

If your app must not miss an event, poll instead — the watch surface is a convenience over the same read rules, not a guaranteed event log.

```javascript
// Requires fs:watch
const handle = await window.novaOS.fs.watch('appdata:/notes/todo.txt', (event) => {
  if (event.kind === 'changed') reloadFile();
});
// …later
await handle.unwatch();
```

Feature-detect with `window.novaOS.capabilities.has('fsWatch.v1')`.

### Notifications — `nova:notifications:*`

All notification APIs require `device:notifications` (low risk, auto-granted).

**Channels.** Sort notifications into named categories your users can control. Declare them in your manifest (see [Full manifest](#full-manifest)) or create them at runtime:

```javascript
await window.nova.ipc('nova:notifications:createChannel', {
  id: 'messages', name: 'Messages', importance: 'high', description: 'Incoming chats'
});
// { success: true, created: true, channel: { id: 'messages', importance: 'high' } }
```

Channel ids are slugs (`[a-zA-Z0-9_-]`, ≤64 chars), max 32 per app. **Importance is locked at creation** (Android parity): re-creating a channel updates name/description but keeps the original importance — only the user can change importance, in Settings → Notifications. Importances: `'low'` (panel only, no toast), `'default'` (toast + panel), `'high'` (long-lived toast + panel). `'none'` is not valid at creation — that state exists only when the user blocks a channel.

**Posting.**

```javascript
const res = await window.nova.ipc('nova:notifications:post', {
  channelId: 'messages',
  tag: 'chat:alice',                       // optional — enables update-in-place
  title: 'Alice',
  body: 'Lunch at noon?',
  actions: [ { id: 'reply', label: 'Reply' }, { id: 'open', label: 'Open' } ],
  progress: { value: 42, max: 100 }        // or { indeterminate: true }
});
// { success: true, posted: true, updated: false, id: 'n42', importance: 'high' }
```

- `channelId` must resolve; posting to an unknown channel fails with `INVALID_ARGS`. If the user blocked the channel, the call succeeds with `{ posted: false, reason: 'CHANNEL_MUTED' }` — treat that as normal, not an error.
- `tag` groups posts: posting again with the same tag **replaces the live notification in place** (same id, same panel position). Updates run against a separate, larger budget (60/min) than new posts (10/min), so a progress ticker updating once a second never trips the spam limiter. On an update, omitted fields keep their previous value — pass `actions: []` explicitly to clear buttons.
- `actions` (max 3): `{ id, label }` pairs. Ids are opaque slugs (≤40 chars) routed back to your app — never functions. Tapping an action **opens your app** and queues `{ actionId, label, tag, notifId, title, clickedAt }`; drain the queue on launch/resume with `nova:notifications:consumeActions` (returns and acknowledges all pending actions, oldest first, capped at 20). Tapping the notification body also opens your app.
- `progress` renders a determinate bar (`value` clamped to `0..max`, `max` ≤ 100000; `indeterminate: true` shows a fixed sliver).
- Legacy fields still work on `post` and on the old `nova:notifications:show`: `type` (`'info' | 'success' | 'warning' | 'error'`), `icon` (OS icon-set name), `action`/`actionLabel` (built-in strings such as `'open-settings'`, `'open-store'`). `title` (≤120) and `body` (≤500) are length-capped; invalid values fall back rather than erroring.

**Cancel.** `nova:notifications:cancel` removes one of your notifications by `tag` or `id`; `nova:notifications:cancelAll` (and the legacy `nova:notifications:clear`) clears all of them. Pinned background-app entries are never affected.

**Rate limits.** Max 10 new posts per app per minute; tagged updates get their own 60/min window. Exceeding either rejects with `{ code: 'RATE_LIMITED' }` until the window rolls over.

**User controls.** Settings → Notifications exposes Do Not Disturb (toasts suppressed; panel entries still land) and a per-channel importance picker (Blocked / Low / Normal / High). Your declared importance is the default; the user's choice always wins.

### Clipboard — `nova:clipboard:*`

```javascript
// Read clipboard (requires clipboard:read)
const { text } = await window.nova.ipc('nova:clipboard:read', {});

// Write clipboard (declare clipboard:write; auto-granted)
await window.nova.ipc('nova:clipboard:write', { text: 'Hello' });
```

Reads/writes hit the real system clipboard via `navigator.clipboard`:

- **Read** tries `navigator.clipboard.readText()` first; if that throws (no permission, no focus, insecure context), it falls back to the last value this OS instance wrote, so same-session copy/paste keeps working.
- **Write** tries `navigator.clipboard.writeText()` first, falling back to a legacy `execCommand('copy')` shim. If both fail, the call rejects with `CLIPBOARD_UNAVAILABLE` instead of silently no-oping.

### Window — `nova:window:*`

```javascript
await window.nova.ipc('nova:window:close', {});
await window.nova.ipc('nova:window:minimize', {});
await window.nova.ipc('nova:window:maximize', {});
await window.nova.ipc('nova:window:setTitle', { title: 'My App — Editing' });
await window.nova.ipc('nova:window:resize', { width: 1200, height: 800 });

const state = await window.nova.ipc('nova:window:getState', {});
// { width, height, x, y, maximized, minimized }
```

### Network — `fetch()` / `nova:net:fetch`

You generally don't need to call `nova:net:fetch` directly — `window.fetch` inside your app is routed through the bridge, so plain `fetch(url, opts)` works once the relevant `net:*` permission is granted:

```javascript
// Requires net:external (or net:internal for same-origin requests)
const res = await fetch('https://api.example.com/data', {
  headers: { 'Accept': 'application/json' },
});
const data = await res.json();
```

**Exception — fetching your own bundled files:** a same-origin `fetch()` for a file this app already ships (e.g. `module.wasm` in the `native-cpp` template) does not require a `net:*` permission. It's treated the same as a `<script src>` or `<img src>` reading a bundled asset, not as outbound network access.

### WebSocket — `nova:net:websocket` / `window.nova.websocket`

Requires `net:websocket`. Only `ws:` and `wss:` URLs are accepted; credential-bearing URLs and known cloud-metadata address literals are blocked. Literal loopback/private/link-local addresses and NovaByte's internal hosts also require `net:internal`. Hostname classification is based on the URL hostname, so deployments that use private DNS aliases should apply network egress controls as a second layer. The `window.nova.websocket()` wrapper is the convenient form — it handles requestId bookkeeping and per-socket event dispatch:

```javascript
const ws = await window.nova.websocket('wss://example.com/socket');

// onMessage receives { wsId, data } — not the bare server message.
ws.onMessage((envelope) => {
  const data = JSON.parse(envelope.data);
  console.log('received:', data);
});
ws.onError((err) => console.error('ws error:', err));
ws.onClose(() => console.log('closed'));

ws.send('hello');
ws.close(1000, 'done');
```

> **Don't skip this:** `onMessage`'s callback argument is `{wsId, data}`, not the raw payload. Treating it as the bare message means everything connects with no errors while your handler never fires.

The returned promise resolves once the connection is open — from the host's `onopen` handler only. There is no host-side rejection path if the connection never opens (bad host, refused connection, TLS failure): the call sits until the bridge timeout fires with a generic timeout error. Treat that timeout as a real connection failure.

Also available as `novaOS.net.websocket(url, protocols?)` (v2, capability `net.v2`) — the same wrapper under a modern name: same gates, same `{ wsId, data }` envelope shape on `onMessage`, same open-only resolution and timeout-on-never-opens behavior, and callbacks registered through it see only pushes for sockets opened through it (the v1 wrapper and the v2 facade keep independent listener registries; a socket opened through one surface never delivers to the other's callbacks).

#### Raw channels — `nova:net:websocket` / `nova:net:ws:*`

The raw IPC channels are also a complete standalone API: connect, send, close, and receive. Receiving works through the events bus — the host mirrors every socket push onto `OS.events` under the channel's own name (`nova:net:ws:message`, `nova:net:ws:error`, `nova:net:ws:close`), so the regular subscription surfaces deliver it:

```javascript
// Connect and send over the raw channels (requires net:websocket).
const res = await window.nova.ipc('nova:net:websocket', { url: 'wss://example.com/socket' });
const wsId = res.wsId;
await window.nova.ipc('nova:net:ws:send', { wsId, data: 'hello' });

// Receive: subscribable like any other event (net:websocket required).
const off = await window.novaOS.events.on('nova:net:ws:message', (push) => {
  if (push.wsId !== wsId) return;          // one bus name, many sockets
  console.log('received:', push.data);     // same { wsId, data } envelope
});
// window.nova.onEvent('nova:net:ws:message', cb) works identically (v1).
```

Delivery is filtered to the owning app: a subscriber only ever receives pushes for its own sockets, never another app's. Subscribing to the three names requires `net:websocket` — the same permission opening a socket needs — rather than `system:events`. If you see `...:response` spellings on pushed messages (`nova:net:ws:message:response`), those are the transport envelope the bridge appends to every channel; the subscribable event names have no suffix.

Pick one receive surface per socket: a socket opened through the wrapper or facade delivers to that surface's per-socket callbacks, and if the same app *also* subscribes to the bus name it receives the push a second time through the events path.

### Geolocation — `nova:device:geolocation`

Also available as `novaOS.geolocation.getCurrentPosition(options?)` (v2) — same permission, same options, resolves `{ coords, timestamp }`.

```javascript
// Requires device:geolocation
const { coords, timestamp } = await window.nova.ipc('nova:device:geolocation', {
  options: { timeout: 5000 }, // passed through to getCurrentPosition
});
// coords: { latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed }
```

### Camera / Microphone — `window.nova.getUserMedia`

Also available as `novaOS.media` (v2): `checkCamera()` / `checkMicrophone()` resolve `true` when the app-level grant is held, and `getUserMedia(constraints)` behaves exactly like the wrapper below.

A live `MediaStream` can't cross the IPC bridge — `nova:device:camera`/`nova:device:microphone` are authorization-only checks. Use the wrapper; it checks the app-level permission first, then calls the real `navigator.mediaDevices.getUserMedia()` in your own document (which still goes through the browser's own permission gate):

```javascript
// Requires device:camera and/or device:microphone matching your constraints
try {
  const stream = await window.nova.getUserMedia({ video: true });
  stream.getTracks().forEach(t => t.stop());
} catch (err) {
  // PERMISSION_DENIED from the app-level check, or a standard
  // getUserMedia DOMException (NotAllowedError, NotFoundError, NotReadableError)
}
```

### Calendar — `nova:calendar:*` / `window.nova.calendar`

Also available as `novaOS.calendar` (v2): `list()` resolves the events array, `save(event)` the host-normalized record, `remove(id)` a `removed` boolean. Same gates.

Reads and writes the **same shared calendar data** the built-in Calendar app uses — not an isolated per-app store.

```javascript
// requires calendar:read
const { events } = await window.nova.calendar.list();

// requires calendar:write
await window.nova.calendar.save({ id: 'my-event', title: 'Standup', date: '2026-07-20' });

// requires calendar:delete
await window.nova.calendar.remove('my-event');
```

### Contacts — `nova:contacts:*` / `window.nova.contacts`

Also available as `novaOS.contacts` (v2): same three methods and gates as Calendar.

Same shared-data model as Calendar — reads/writes the real Contacts app's data.

```javascript
// requires contacts:read
const { contacts } = await window.nova.contacts.list();

// requires contacts:write
await window.nova.contacts.save({ id: 'c1', name: 'Jane Doe', email: 'jane@example.com' });

// requires contacts:delete
await window.nova.contacts.remove('c1');
```

### App management — `nova:app:*` / `window.nova.apps`

```javascript
// List installed apps (requires system:apps)
const { apps } = await window.nova.apps.list();
// Each app retains `icon` and adds `iconUrl` for direct rendering:
// <img src="${apps[0].iconUrl}" alt="">
// `iconUrl` is a package image data URL, a safe local /assets path, or a
// generated SVG data URL for built-in icon names. It is null when unavailable.

// Launch an installed app (requires system:app-launch; max 30 per minute)
await window.nova.apps.launch('com.example.otherapp');

// Get info about this app (no permission)
const info = await window.nova.ipc('nova:app:info', { appId: 'com.example.otherapp' });

// Install a package (requires system:apps) — fails closed. Only succeeds
// for a fully signed, trust-store-verified, unmodified package. Anything
// that would normally need a human warning dialog (untrusted signer,
// tampered contents, already installed) is rejected outright rather than
// silently bypassed — install that manually via App Manager.
await window.nova.apps.install(packageObject);

// Uninstall (requires system:apps) — only works on real, file-installed
// .novaapp packages, not built-in system apps.
await window.nova.apps.uninstall('com.example.otherapp');

// Send the user to Settings → Default Apps (requires system:apps).
// `category` is optional; pass one of the category ids (e.g. 'music',
// 'browser') to open Settings with that row highlighted and a banner
// naming your app as the requester.
await window.nova.apps.openDefaultAppsSettings('music');

// A currently selected sandboxed Home app can take the user directly
// to Home app selection without requesting the broader system:apps grant.
await window.nova.home.openDefaultAppsSettings();

// Home-only app drawer APIs. Settings and App Manager are always listed
// and launchable by the currently selected Home app. Other apps appear
// in list() with system:apps, and can be launched with system:app-launch
// or system:apps.
const { apps, fullAccess } = await window.nova.home.apps.list();
await window.nova.home.apps.launch('com.nbosp.settings');
await window.nova.home.apps.launch('com.nbosp.appmanager');
```

**`openDefaultAppsSettings` is rate-limited** to 12 calls per minute per app id, using the same sliding-window pattern as notifications. This exists because, unlike a real click, there's no reliable host-side signal that the call came from a user gesture; the limit bounds how often a misbehaving app can steal focus by repeatedly popping Settings open — the budget sits well above any human flow, while a focus-stealing loop still bounces. Calls beyond the limit reject with `{ code: 'RATE_LIMITED' }`.

This call only opens Settings to the right place — it never changes the user's default. The user still picks your app from the picker; there's no way to set a default programmatically without their action.

`window.nova.home.*` variants are restricted to the currently selected Home app (others receive `PERMISSION_DENIED`), share the 12-per-minute settings limit, and Home launches are limited to 30 per minute without accepting caller-supplied launch options or file intents.

### Admin — `nova:admin:*` / `window.nova.admin`

Also available as `novaOS.admin` (v2) — the same six methods 1:1; the dual gate (per-app grant **and** machine admin mode) is unchanged, records pass through unnormalized.

Requires **both** the relevant `admin:*` grant *and* the machine's local admin-mode flag (Settings → Privacy & Security → Admin Access, off by default). If the machine isn't in admin mode, calls reject with a message saying so — that's a correct denial, not a bug.

```javascript
// requires admin:audit — reads the live server event log (a 500-entry
// ring buffer, not a persisted audit trail)
const { logs } = await window.nova.admin.auditQuery({ limit: 10 });

// requires admin:system — read or update server-side security settings
// (password policy, lockout thresholds, IP blocking, etc.)
const { settings } = await window.nova.admin.systemGet();
await window.nova.admin.systemSet({ sessionTimeoutMinutes: 30 });

// requires admin:users — list/revoke active sessions (this OS is
// single-user; "sessions" means active browser/app sessions, not accounts)
const { sessions } = await window.nova.admin.usersList();
await window.nova.admin.usersRevoke(sessionId);

// requires admin:apps — admin-scoped view of the same app registry
// system:apps already exposes
const { apps } = await window.nova.admin.appsList();
```

### Mail — `nova:mail:*` / `window.nova.mail`

Also available as `novaOS.mail` (v2) — the same fourteen methods 1:1, same per-action gates, records pass through unnormalized.

All mail calls act on the host Email app's mail session. If nothing is connected, calls reject with a clear "no email account connected" error. Two ways to get there:

- **Use the account the user already connected in the Email app** — `mail.account()` / `mail.restore()` read the live session; reads/writes/sends act on it.
- **Connect an account yourself** — `mail.connect(account)` (requires `mail:write`) takes `{ type, host, user, pass, port?, ssl? }` and connects through the host Email controller. SSL is mandatory (plaintext connections are rejected); credentials are forwarded to the host-side Email controller and never processed in the guest. `mail.disconnect()` ends the session.

```javascript
// requires mail:write — session lifecycle
await window.nova.mail.connect({ type: 'imap', host: 'imap.example.com', user: 'me@example.com', pass: '…' });
await window.nova.mail.restore();
await window.nova.mail.disconnect();

// requires mail:read
const { data } = await window.nova.mail.folders();
const { data } = await window.nova.mail.messages({ folder: 'INBOX', page: 1, limit: 20 });
const { data } = await window.nova.mail.message(uid, 'INBOX');
const { data } = await window.nova.mail.search('invoice', 'INBOX');
const { data } = await window.nova.mail.account(); // { restored, type, host, user }

// requires mail:write — batch mark-read/move, plus HTML preview rendering
await window.nova.mail.markRead([101, 102], 'INBOX');
await window.nova.mail.move([101], 'Archive', 'INBOX');
const { token } = await window.nova.mail.preview('<p>Hello</p>');

// requires mail:send — smtpHost/smtpPort are mandatory. The server cannot
// infer your account's real SMTP host from its IMAP/POP3/EWS host (they're
// frequently different, e.g. imap.gmail.com vs smtp.gmail.com) — get it
// from the account config, don't guess.
await window.nova.mail.send({
  to: 'someone@example.com',
  subject: 'Hello',
  text: 'Hi there',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
});

// requires mail:delete
await window.nova.mail.remove([101], 'INBOX');
```

For providers with an HTTP/REST API (Gmail API, Microsoft Graph, etc.) you can skip `mail:*` entirely and call the provider directly over `net:external`, handling your own OAuth flow. Raw IMAP/SMTP/POP3 wire protocols are not reachable through `net:external` — there is no host-side handler for arbitrary non-HTTP protocols.

### System info — `nova:system:info`

```javascript
// Requires system:info
const info = await window.nova.ipc('nova:system:info', {});
// { osVersion, securityPatch, platform, ... }
```

### Locale — `nova:locale:get` / `window.novaOS.locale`

Coarse, read-only locale facts for formatting dates, numbers, and currencies. **No permission** — on purpose: these are the same values any plain web page gets from `navigator`/`Intl` on the open web, they identify no one, and gating date formatting behind a prompt would just push apps back to user-agent sniffing. Anything sensitive (username, hostname, uptime) stays behind `system:info` — this surface exposes nothing but formatting facts.

```javascript
const { locale, region, timeZone, firstDayOfWeek } = await window.novaOS.locale.get();
// locale: 'de-DE' (environment default), region: 'DE' | null,
// timeZone: 'Europe/Berlin', firstDayOfWeek: 'monday' | 'sunday'
```

Precedence: the user's OS **region** and **timezone** settings win when set; otherwise region derives from the locale tag and the timezone comes from the environment. `firstDayOfWeek` is a coarse documented mapping (Sunday-conventional regions vs Monday), enough for calendar grids — it is not a full i18n library.

Feature-detect with `window.novaOS.capabilities.has('locale.v1')`.

### Taskbar badge — `nova:badge:*` / `window.novaOS.badge`

Requires `system:badge` (System / Low). Shows a badge on **your app's own** taskbar icon: a count (0–999) or a short text label (1–4 characters after trimming). Host-side clamps are authoritative, updates are rate-limited to 30/minute, and the badge is **session-only live state** — it clears when your app closes (a badge is a view of live state, not data) and never persists across reboots.

```javascript
// Requires system:badge
await window.novaOS.badge.set(3);        // count badge
await window.novaOS.badge.set({ text: 'new' }); // 1-4 characters
await window.novaOS.badge.set(0);        // same as clear() — nothing to show
await window.novaOS.badge.clear();
```

`set` accepts a number or an object; when both `count` and `text` are given, `count` wins. The taskbar renders the badge bottom-right on your icon (the window count, managed by the OS, stays top-right).

Feature-detect with `window.novaOS.capabilities.has('badge.v1')`.

### Share target — `system:share-target` / `novaOS.share.onInbound`

The inbound half of [User-mediated sharing](#user-mediated-sharing--windownovashare--novaosappshare). Declare what you accept in the manifest and hold the `system:share-target` grant (System / Medium):

```json
{
  "shareTarget": { "mimeTypes": ["text/plain", "text/uri-list"] }
}
```

```javascript
// Requires system:share-target
const unsub = window.novaOS.share.onInbound((share) => {
  // share: { title, text, url, sourceAppId, firedAt, queued? }
});
```

Delivery is strictly user-mediated: other apps open the share sheet, the OS lists matching targets (apps whose declared MIME patterns match the shared text or URL — `type/*` and `*/*` wildcards accepted), and the user's pick is the consent. At most 6 targets are listed so the sheet stays human.

Delivery semantics: a live sandbox receives the `nova:share:inbound` push immediately; a closed target has the entry **queued** (bounded at 8) and delivered right after its next launch, with `queued: true`. The pick itself may open the target's window; the push never starts an app by itself. `sourceAppId` names the sharing app when known.

Feature-detect with `window.novaOS.capabilities.has('shareTarget.v1')`.

### Secrets — `nova:secrets:*` / `novaOS.secrets`

Requires `secrets:store` (Data / Medium). An encrypted per-app key/value store for small credentials — tokens, passwords, API keys. AES-256-GCM at rest under a per-install master key (`root/app-secrets.key`, 0600); plaintext never touches disk. Budgets: **64 secrets per app, 8 KB per value, 128-character keys**.

```javascript
// Requires secrets:store
await window.novaOS.secrets.set('api-token', 'dN0t…');
const token = await window.novaOS.secrets.get('api-token'); // string | null
const labels = await window.novaOS.secrets.keys();          // your own key names only
await window.novaOS.secrets.delete('api-token');
```

Two rules make this surface safe rather than decorative:

1. **Secrets are not part of your portable namespace.** `data:export` / `data:backup` read the storage service only — a backup envelope can never silently carry credentials. If you want a secret in a backup, encrypt it yourself and store the ciphertext.
2. **No cross-app reads, ever.** The store is namespaced by app ID host-side; `keys()` lists only your own labels, and the Settings dashboard shows per-app secret *counts*, never values. A blob that fails authentication (wrong master key after a reinstall, tampered store) reads back as `null` instead of erroring or leaking.

If the OS cannot persist the master key (locked-down filesystem), secrets degrade to session-only memory and `set` responds with `persisted: false` — surface that to the user rather than pretending nothing happened.

Feature-detect with `window.novaOS.capabilities.has('secrets.v1')`.

### Named alarms — `nova:alarms:*` / `novaOS.alarms`

Requires `system:schedule` (System / Medium). Create named alarms — a one-shot `when` (future epoch ms, up to a year out) or a periodic `periodMinutes` (**floor: 15 minutes**, matching real OS schedulers' coarse periodic intervals). Re-creating a name replaces that alarm. Max **32 alarms per app**.

```javascript
// Requires system:schedule
await window.novaOS.alarms.create({ name: 'sync', periodMinutes: 30 });
await window.novaOS.alarms.create({ name: 'reminder', when: Date.now() + 60_000 });
const alarms = await window.novaOS.alarms.getAll(); // [{ name, when, periodMinutes, scheduledTime }]
const unsub = window.novaOS.alarms.onAlarm((fire) => {
  // fire: { name, alarm: { scheduledTime, ... }, firedAt, queued? }
});
await window.novaOS.alarms.clear('reminder');
```

Delivery semantics, stated plainly:

- Alarms fire into a **live** sandbox — a running window or a keep-alive (`system:background:live`) process. The push channel is `nova:background:alarm`; register with `novaOS.alarms.onAlarm()`.
- While your app is **fully closed**, alarms never launch it. Periodic alarms skip to their next occurrence; one-shot alarms are **queued** (bounded at 8, oldest dropped) and delivered right after the next `nova:ready` handshake with `queued: true`.
- The alarm registry persists across OS reboots (timers are rebuilt at boot; missed one-shots join the queue).
- Apps that must run brief work while fully closed want `system:background` (Tier-1 scheduled wakes) instead — alarms schedule *moments*, the scheduler runs *code*.

Feature-detect with `window.novaOS.capabilities.has('alarms.v1')`.

### Push delivery — `push:receive` / `novaOS.push`

Requires `push:receive` (System / Medium). Server-to-app push in the FCM shape: your backend publishes a message to a per-install subscription token, and the OS push service relays it to the device. The defining design rule is the same one that makes Android's version work: **the OS holds the one server connection — your app never opens a listen socket and never runs just to wait for messages.** Push reaches a closed app by *waking* it under the existing bounded-wake rules, not by keeping it alive.

```javascript
// Requires push:receive
const { token, endpoint, subscribed } = await window.novaOS.push.register();
// Hand `token` to YOUR backend — it publishes to the OS push service:
// `subscribed` is true once the OS server acknowledges this device mapping.
// If false (for example, while offline), retry register() after connectivity returns.

// (on your backend, not in the app)
// POST <os-server>/api/push/publish
// { "token": "<token>", "title": "New message", "body": "Ada says hi",
//   "data": { "conversationId": "c-42" } }

const unsub = window.novaOS.push.onMessage((message) => {
  // message: { appId, id, title?, body?, data?, sentAt, queued? }
});
await window.novaOS.push.unregister(); // revokes the token and drops the queue
```

`register()` is idempotent — the same install keeps the same token across restarts and reboots; the registry persists host-side like the alarm registry. Messages arriving through `onMessage` carry `queued: true` when they are replayed from the closed-app queue rather than delivered live.

**Delivery ladder** — where a published message goes, checked top to bottom on every message:

| App state | What happens |
| --- | --- |
| Running (window or keep-alive) | `nova:push:message` push into the live sandbox — immediate. |
| Closed, holds `system:background` | Queued (bounded at 8) and a Tier-1 wake is requested; the queue flushes right after the woken sandbox's ready handshake, inside the same bounded wake window as any scheduled wake. |
| Closed, message has `title`/`body` | The **OS displays the notification attributed to your app** (same sanitizer and same per-app notification rate budget as apps posting their own) and queues the message for the next launch. |
| Closed, data-only message | Queued (bounded at 8), delivered right after the next `nova:ready` with `queued: true`. |
| Revoked grant, disabled, or uninstalled app | **Dropped at the door.** The ladder re-checks the grant on every message; no sandbox is ever started for a message the app may no longer see. |

Message limits: `title` ≤ 200 characters, `body` ≤ 2000, `data` a JSON object ≤ 4 KB — anything larger is rejected at the publish endpoint. `title`/`body`/`data` are all optional; a message with only `data` is a data-only message and never displays anything by itself.

**The publish endpoint and its trust model:** `POST /api/push/publish` accepts `{ token, title?, body?, data?, id? }` and is *untrusted* traffic — no account, no signature; the subscription token is the capability, and the endpoint lives under the same global API rate limit as every other outside caller. `404 { delivered: false, reason: "unknown-token" }` means no device is currently subscribed to that token; `202 { delivered: false, reason: "device-offline" }` means the message made the device's replay backlog and delivery depends on the next reconnect.

**Honest limits, stated plainly:**

- Push is **live-delivery semantics, not a mailbox**. The server holds a small in-memory backlog per token (last 16 messages, 24 h) that replays on the next device connect and drains there; a server restart forgets it. Devices re-subscribe their whole token set on every reconnect, so token mappings self-heal — but a message older than the backlog, or beyond it, is genuinely lost. For must-not-lose data, push a *pointer* ("you have mail") and fetch the real payload over your own authenticated channel.
- The device stream connects **only while at least one installed, enabled app holds `push:receive`**; with no holders, the OS keeps no connection at all.
- Displaying a notification while closed is part of the `push:receive` grant, not a second notification permission — but it draws from the same per-app notification rate budget, so a chatty backend can't out-shout the user's quiet hours (per-device quiet hours are a planned OS-level addition; apps should not build their own around push).
- The token identifies the *app + device*, and publishing is addressed to the app's own backend by design — the OS never relays third-party content to an app that didn't register for its own server's messages.

Feature-detect with `window.novaOS.capabilities.has('push.v1')`.

### Settings — `nova:settings:get` / `nova:settings:set`

Reading and writing OS settings are gated by **different** permissions, and both directions are **allowlisted** — this is a shared, OS-wide key space of user preferences, not arbitrary key/value access and not per-app storage:

- `nova:settings:get` requires `system:info` and can read only allowlisted preference keys (`theme`, `accentColor`, `username`, `region`, `timezone`, `devMode`, `highContrast`, `reduceMotion`, `taskbarPosition`, `wallpaperId`, and other desktop/appearance/settings values).
- `nova:settings:set` requires `system:settings` and can write the same allowlist minus `osVersion` and `devMode` (those change only through OS-owned flows). **Exception:** the two wallpaper keys `wallpaperId` and `customWallpaper` are writable without any permission — see [Desktop wallpaper](#desktop-wallpaper--settings-keys--windownovawallpaper).

```javascript
// Requires system:info
const { value } = await window.nova.ipc('nova:settings:get', { key: 'theme' });

// Requires system:settings (theme values follow the OS theme ids, e.g. 'nord')
await window.nova.ipc('nova:settings:set', { key: 'theme', value: 'nord' });
```

Security-sensitive material — `lockPin`, `pinSalt`, `biometricCredentialId`, `bootPassword`, `lockoutUntil`, `wrongPinCount` — is not in the readable allowlist and never reachable through this API, so holding `system:info` can't read the user's PIN hash and holding `system:settings` can't reset lockout state. Calls for any other unlisted key fail with `PERMISSION_DENIED` ("not readable/writable by apps") — the allowlist is a scope boundary, not an argument-format check.

For appearance customization, prefer `window.nova.appearance.set(...)`: it changes only validated theme/accent/accessibility preferences.

The v2 facade is thin sugar over the same two channels — identical gates, identical allowlists, identical error codes:

```javascript
// Requires system:info — resolves the raw stored value (undefined when unset)
const theme = await window.novaOS.settings.get('theme');

// Requires system:settings — resolves undefined
await window.novaOS.settings.set('theme', 'nord');
```

Feature-detect with `window.novaOS.capabilities.has('settings.v2')`.

For data scoped to your own app, use [Storage](#storage) instead.

### NovaByte Registry — `nova:reg:*` / `window.novaOS.registry`

Requires `registry.read` (System / Low) to read, `registry.write` (System / Medium) to write. The registry is the OS's hierarchical configuration database — the thing the shell itself boots from — so writes are **per-hive** and enforced host-side on every call:

| Hive | What lives there | Who may write |
|---|---|---|
| `HKNS` | NovaSystem — shell config (`HKNS/shell/theme`, `HKNS/shell/accentColor`, `HKNS/shell/wallpaper`), security policy under `HKNS/security/...` | System apps only (never `HKNS/security` without `registry.system`) |
| `HKNU` | NovaUser — per-user preferences | `registry.system` only |
| `HKNA` | NovaApps — one subtree per app: `HKNA/<your-app-id>/...` | Your app alone, inside its own subtree |
| `HKND` | NovaDev — developer scratch space | `registry.write` while Developer Mode is ON |

`registry.system` (System / Critical) reads and writes everything, but Developer Mode still gates `HKND`. Reading is broad for any `registry.read` holder — config facts are not per-app private state — except `HKNS/security/...`, which needs `registry.system` even to read.

A path names **keys** and ends in a **value**: `HKNS/shell/wallpaper` is the value `wallpaper` under key `shell`. Two Windows-isms sit on top:

- **Every key has a `(default)` value.** A *bare key path* (`HKNS/shell`) reads and writes that key's default value — `stat()` reports `found: false` while it is unset. An explicit `(default)` segment (`HKNS/shell/(default)`) addresses the same thing.
- **`HKCU` is an alias for `HKNU`** — the parser maps `HKCU/...` to `HKNU/...` the way `HKEY_CURRENT_USER` names a user hive.

Values are typed — `REG_SZ` (string), `REG_EXPAND_SZ` (string with `%VAR%` tokens, stored raw and expanded on read against the `HKNS/env/*` variable table, single pass, unknown variables left verbatim), `REG_MULTI_SZ` (array of strings — never auto-detected, arrays without an explicit type stay `REG_JSON`), `REG_BOOL`, `REG_DWORD` (uint32), `REG_QWORD` (non-negative safe integer), `REG_JSON` (any JSON value), `REG_BINARY` (base64 string) — and the type is validated host-side on every write. Omitting the type on `set` auto-detects it. The engine quotas everything (16-segment paths, 256 KB per value, per-hive caps), persists every hive atomically, and quarantines a corrupt hive file instead of failing the boot.

Keys can also be **links** (Windows `REG_LINK` / junction flavor): a link key carries a target path and is followed transparently on reads (`list`/`get`/`stat`/`export`) and same-hive writes; removing a link path removes the link, never the target; writes through a *cross-hive* link are refused with `LINK_CROSS_HIVE`. Links are created host-side (`NovaRegistry.setLink`, the NovaReg **+ Link** button) and survive export/import.

```javascript
// Requires registry.read
const wallpaper = await window.novaOS.registry.get('HKNS/shell/wallpaper'); // 'stock-blue' or undefined
const stat = await window.novaOS.registry.stat('HKNS/shell/theme');  // { found, path, type, data }
const shell = await window.novaOS.registry.list('HKNS/shell');       // { path, keys: [...], values: {...} }
const dump  = await window.novaOS.registry.export('HKNA');           // whole-subtree plain object

// Requires registry.write — stores under YOUR app's subtree
await window.novaOS.registry.set('HKNA/com.example.player/volume', 80, 'REG_DWORD');
await window.novaOS.registry.set('HKNA/com.example.player/lastPlaylist', { tracks: [1, 7, 9] }); // auto REG_JSON
await window.novaOS.registry.remove('HKNA/com.example.player/volume');

// A bare key path writes/reads the key's default value
await window.novaOS.registry.set('HKNA/com.example.player', 'player/2.0'); // the (default) value
(await window.novaOS.registry.stat('HKNA/com.example.player')).data;       // 'player/2.0'

// Watch for changes (watching is reading — same grant as the event)
const off = await window.novaOS.registry.watch('HKNS/shell', (change) => {
  console.log('registry changed:', change.path, change.type, change.value);
});
await off(); // stop watching
```

**Per-key ACLs.** On top of the hive rules, any key can carry an ACL — `{ owner, entries: [{ id, rights: ['read','write'], inherit }] }` where `id` is an app id or `*` for everyone. Entries with `inherit !== false` flow down the subtree; a deeper entry for the same id replaces a shallower one; grants from different ids (the actor's own and `*`) are additive. With **no ACL anywhere** in a key's chain the base hive rules apply unchanged; with **any** covering ACL, an actor must appear (directly or via `*`) with the needed right — `registry.system` bypasses ACLs entirely, and `HKNS/security` stays `registry.system`-only regardless. ACLs are managed in the NovaReg **Permissions** dialog; apps only ever see their effect as `PERMISSION_DENIED: key ACL denies <read|write>`.

**Manifest-declared scopes.** A `.novaapp` manifest may declare `registryScopes: { write: ['HKNU/shell/notifications', ...] }` — a bounded list (32 entries max) of designated prefixes. A matching prefix unlocks writes into that `HKNU` area without `registry.system` (the model for apps the user has designated to manage a slice of user config). Scopes can never unlock `HKNS`, `HKND`, or another app's `HKNA` subtree; `registryScopes.read` is advisory documentation (reads are already broad).

**Scope defaults.** A manifest that declares **no** `registryScopes` field at all still gets one built-in write scope: its own `HKNU/software/<app-id>/` subtree — the per-user slice that mirrors Windows' `HKCU\Software\<App>`. That is the supported home for third-party user-scoped settings: writable with plain `registry.write` (no `registry.system`), sandbox-enforced, and separate from the machine-scoped `HKNA/<app-id>/` subtree. Declaring the field at all — even as an empty object — **opts out** of the default (an explicit empty scope list means "no designated keys"), and a declared scope list *replaces* the default rather than merging with it. System apps never receive the default: they either hold `registry.system` or declare their intents explicitly.

Change notifications ride the event bus as `nova:reg:changed` (see [Event bus](#event-bus--novaevents)): the payload is `{ path, type, value, appId, source }`, one event per committed write/delete/import. `watch(path, cb)` is the facade's prefix-filtered sugar over that event, so it holds exactly the grants subscribing to it needs.

Writes to the mapped shell paths (`HKNS/shell/theme`, `HKNS/shell/accentColor`, `HKNS/shell/wallpaper`, plus the user-side `HKNU/desktop/pins` ↔ `pinnedApps` and `HKNU/shell/defaultApps` ↔ `defaultApps`) apply live: the settings shim subscribes to `nova:reg:changed`, maps the path back to its settings key, refreshes `OS.settings`' cache and re-emits `settings:changed`, so the desktop re-applies immediately — whether the write came from the Settings app, NovaReg, the `reg` CLI, or your app's IPC. On first registry boot the OS **adopts** the legacy settings store (Linux `settings.json`, web IndexedDB) into the live registry paths — guarded by `HKND/_migration/registrySourceDone`, running exactly once, with adopted values beating boot seeds. (The older `HKNU/legacy/*` snapshot written by `migrateLegacySettings` is retained only as a forensic copy.) Apps should treat their `HKNA` subtree as their supported config surface: it persists across updates, is visible to the user in the NovaReg editor (Developer Mode), and survives alongside the app's own storage. NovaReg renders **friendly names** for the well-known paths — an info strip under the values header plus tree/find tooltips — including dynamic display names for `HKNA/<app-id>` and `HKNU/software/<app-id>` resolved from the installed-app inventory and humanized names for `HKNU/settings/<key>`, so user-scoped third-party config reads plainly too. Error codes: `INVALID_ARGS` (bad path), `INVALID_VALUE` (type mismatch), `QUOTA_EXCEEDED` (size/node caps), `NOT_FOUND`, `SUBTREE_NOT_EMPTY` (delete a non-empty key without `recursive: true`), `LINK_CROSS_HIVE`, `LINK_LOOP`, `NAME_CONFLICT` (rename), `PERMISSION_DENIED`.

Feature-detect with `window.novaOS.capabilities.has('registry.v1')`.

### Ready snapshot — `window.novaOS.ready`

`novaOS.ready.get()` is the v2 view of the `nova:ready` handshake — the same authenticated payload the runtime delivers automatically on load, with no permission gate:

```javascript
const snap = await window.novaOS.ready.get();
// { appId, permissions, optionalPermissions, osVersion, securityPatch, username }
// username is the OS username for system-bundled apps only; everyone else gets null.
```

It is a snapshot, not a re-handshake: the automatic handshake on load keeps the delivery side effects (queued alarms, inbound shares, and pushes flush right after it), while `ready.get()` only reads. Repeat calls are harmless — those queues drain once. Note the difference from `window.novaOS.app.info()`, which returns the `nova:app:info` record about your app's package; `ready.get()` returns your grants and the OS identity.

### Event bus — `nova:events:*`

Use `window.nova.onEvent`, which handles the subscribe call and dispatches pushed events:

```javascript
window.nova.onEvent('system:themeChanged', (data) => {
  console.log('theme changed:', data);
});
```

Or the v2 facade, which adds stacking listeners over one host subscription, an unsubscribe function, and tolerance for subscriptions another surface already made:

```javascript
const off = await window.novaOS.events.on('system:themeChanged', (data) => {
  console.log('theme changed:', data);
});
// ...later:
await off(); // removes this listener; unsubscribes host-side when the last one goes

// Raw equivalents for manual control (same channels, same errors):
await window.novaOS.events.subscribe('system:themeChanged');
await window.novaOS.events.unsubscribe('system:themeChanged');
```

The two surfaces coexist: the host holds a single subscription per sandbox per event name, and each push fans out to the v1 listeners and the v2 listeners independently.

Calling `nova.ipc('nova:events:unsubscribe', { event: 'system:themeChanged' })` directly also works.

**Event names are restricted to a fixed allowlist** — subscribing to any other name fails with `INVALID_ARGS`. Common appearance, volume, workspace, power, and network change events require no permission; notifications, app inventory/lifecycle events, and mail/calendar/contact events require `system:events`, and the mail/calendar/contact ones additionally require their domain read permission. The three WebSocket push events require `net:websocket` alone (no `system:events`) and are delivered only to the app that owns the socket (see [WebSocket](#websocket--novanetwebsocket--windownovawebsocket)). The registry change event requires `registry.read` alone — the same grant reading the registry needs (see [NovaByte Registry](#novabyte-registry--novareg--windownovaregistry)):

| Event | Fires when | Permission |
|---|---|---|
| `system:notification` | A system notification is shown | `system:events` |
| `system:volumeChanged` | Volume is changed | — |
| `system:themeChanged` | Light/dark theme is switched | — |
| `system:workspaceChanged` | The active workspace changes | — |
| `system:power` | Power state changes (battery/charging) | — |
| `system:network` | Network connectivity changes | — |
| `app:installed` | An app is installed | `system:events` |
| `app:uninstalled` | An app is uninstalled | `system:events` |
| `app:launched` | An app is launched | `system:events` |
| `mail:new` | New mail arrives | `system:events` + `mail:read` |
| `mail:updated` | Mail state changes | `system:events` + `mail:read` |
| `calendar:reminder` | A calendar reminder fires | `system:events` + `calendar:read` |
| `calendar:updated` | Calendar data changes | `system:events` + `calendar:read` |
| `contacts:updated` | Contacts data changes | `system:events` + `contacts:read` |
| `nova:net:ws:message` | A socket opened by this app received a message (raw `nova:net:websocket` data plane) | `net:websocket` |
| `nova:net:ws:error` | A socket opened by this app errored | `net:websocket` |
| `nova:net:ws:close` | A socket opened by this app closed | `net:websocket` |
| `nova:reg:changed` | A registry value was written, deleted, or imported (`{ path, type, value, appId, source }` — see [NovaByte Registry](#novabyte-registry--novareg--windownovaregistry)) | `registry.read` |

The bus is OS-to-app only — there is no event for arbitrary custom app-to-app messaging (use [Inter-app communication](#inter-app-communication) instead).

### Background execution — `nova:background:*`

Three separate permissions cover three genuinely different questions:

| Permission | Answers | Must the user have opened the app first? |
|------------|---------|---------|
| `system:background` | "Can this app periodically wake up and do a little work while closed?" | No — the OS can wake it even if never launched this session |
| `system:background:live` | "Can this app keep running after its window is closed?" | Yes — it must already be open and choose to stay alive |
| `system:autostart` | "Can this app launch itself at OS startup with no user action?" | No — the biggest ask of the three |

#### Tier 1 — scheduled wake (`system:background`)

Roughly every 15 minutes, the OS spins your app up headlessly — no window, no visible UI — and gives it a short deadline (seconds) to do work: check state, sync data, refresh a cache. It does **not** grant `device:notifications` — a wake handler that wants to alert the user needs that permission separately and gets `PERMISSION_DENIED` without it, exactly as in the foreground.

```javascript
// Requires system:background
window.nova.onBackgroundWake((info) => {
  // info.wokeAt     — ISO timestamp
  // info.deadlineMs — how long you have before the host tears this down

  doQuickSync();

  // Optional: signal done early so the host doesn't wait out the deadline.
  window.nova.backgroundWakeDone();
});

// v2 equivalent: novaOS.background — same push, plus an unsubscribe
// function for the wake handler and an undefined-resolving wakeDone().
const offWake = window.novaOS.background.onWake((info) => {
  doQuickSync();
  window.novaOS.background.wakeDone();
});
```

If you never call `backgroundWakeDone()`, the host waits out `deadlineMs` and tears the sandbox down anyway.

#### Tier 2 — stay alive after close (`system:background:live`)

Holding the permission is **not** enough by itself — your app must explicitly opt in for the current session:

```javascript
// Requires system:background:live
const { enabled } = await window.nova.stayAliveInBackground();
// Call again with `false` to opt out before the window closes.

// v2 equivalent — same channel, resolves the enabled state either way:
await window.novaOS.background.stayAlive();
await window.novaOS.background.stayAlive(false);
```

Once opted in, closing the window keeps the app running. The user sees a one-time toast plus a persistent, non-dismissible notification entry with a **Terminate** button — the only way the process stops short of the app exiting on its own. Reopening the app from the launcher reattaches the existing running instance (same process, same in-memory state) and clears the pinned entry; closing it again re-backgrounds the app without calling `stayAliveInBackground()` a second time.

#### Tier 3 — autostart at OS boot (`system:autostart`)

Your app can launch itself when NovaByte OS starts. Opt-in on two axes: the app needs the grant, **and** the user must add it to their own "start at boot" list (the app's detail page in App Manager shows that toggle only for apps declaring `system:autostart`). Neither alone is enough. There is no runtime API for this tier.

Autostart never runs behind a lock screen — if the machine is locked at boot, autostart apps wait until the user unlocks.

### File picker — `nova:dialog:*`

```javascript
// Open file picker (user selection grants access to the chosen file)
const result = await window.nova.ipc('nova:dialog:open', {
  accept: ['.txt', '.md'],   // optional: extension and/or MIME rules; the
                             // picker filters the visible files to match
});
if (result.cancelled) {
  // user backed out — not an error
} else {
  const { id, name, content, mimeType, size, path } = result.file;
}

// Save file picker (user selection grants access to the chosen destination)
await window.nova.ipc('nova:dialog:save', {
  filename: 'notes.txt',
  content: 'Hello',
});
```

`accept` takes the same forms as the other pickers — a comma-separated string or an array of MIME types and/or `.ext` entries (at most 20) — and is enforced: files that don't match are hidden from the list (folders stay visible for navigation; files the OS cannot type pass MIME rules). An invalid list rejects the call with `INVALID_ARGS`. This picker is single-select; there is no `multiple` option — use `nova:sysdialog:open` with `multiple: true` when the user should pick several files in one go.

### Styled file picker — `nova:sysdialog:*`

A second, additional picker pair — separate from `nova:dialog:*`, not a replacement; both keep working. Where `nova:dialog:*` renders a minimal one-off overlay, `nova:sysdialog:*` opens the shared, Files-app-styled filesystem browser (`SystemDialogs`) that built-in apps use for Open/Save As: real folder navigation, back/up buttons, a path bar, an icon grid, and no "save as type" dropdown. The picker itself grants access to the chosen item or destination.

```javascript
// Open picker
const result = await window.nova.ipc('nova:sysdialog:open', {
  title: 'Import',            // optional, defaults to "Open"
  startPath: '/home/nbosp',   // optional host path the browser opens at
  accept: ['.json', 'text/plain'],  // optional: extension and/or MIME rules
});
if (result.cancelled) {
  // user backed out — not an error
} else {
  const { id, name, content, mimeType, size, path } = result.file;
}

// Multi-select — the user toggles files in the grid, you get all of them
const result = await window.nova.ipc('nova:sysdialog:open', {
  title: 'Choose photos',
  multiple: true,
  accept: ['image/jpeg', 'image/png', 'image/webp'],
});
if (!result.cancelled) {
  for (const f of result.files) {
    // f has the same shape as result.file above
  }
}

// Save picker — writes the file once a destination is chosen
const result = await window.nova.ipc('nova:sysdialog:save', {
  title: 'Save As',            // optional, defaults to "Save As"
  suggestedName: 'notes.txt',  // optional, prefills the filename box
  startPath: '/home/nbosp',    // optional host path to open at
  content: 'Hello',
  mimeType: 'text/plain',      // optional, defaults to 'text/plain'
});
if (!result.cancelled) {
  const { id, name, path } = result.file;
}
```

`accept` takes a comma-separated string or an array of at most 20 MIME types and/or `.ext` entries; the grid filters what the user can select to matching files (folders stay navigable). An invalid list rejects the call with `INVALID_ARGS` rather than being ignored. `multiple: true` turns the picker into click-to-toggle multi-select: the response carries `files` (an array, capped at 25 files — a larger selection rejects with `LIMIT_REACHED`) plus `file`, an alias for the first entry, so single-select code keeps working unchanged. Single-select responses include `files` as a one-element array for the same uniformity. Picked files are capped at 10 MB each, and follow the content-decoding rule described under [`window.nova.files`](#picker-scoped-files--windownovafiles) — text as `content`, binary as base64 with `encoding: 'base64'`.

Both picker channels are on the same interactive, long-timeout tier as `nova:download` and `nova:share` — the call can legitimately sit open for minutes while a person navigates folders, so it gets the 10-minute interactive timeout instead of the normal per-request timeout (60 s by default, per the app's `requestTimeoutMs` budget).

### Error codes

`window.nova.ipc` rejects (throws) rather than resolving with an `{ error }` field — always wrap calls in `try/catch` or attach `.catch()`. The thrown error has `.code` and `.message`:

| Code | Meaning |
|------|---------|
| `PERMISSION_DENIED` | Required permission not granted, or the call was blocked by system security policy (MAC) |
| `INVALID_ARGS` | Missing or invalid payload fields |
| `NOT_FOUND` | File or resource not found |
| `UNKNOWN_API` | Unknown IPC endpoint (typo in the channel name) |
| `REMOTE_ERROR` | A remote app's IPC callback failed or did not respond in time |
| `ALREADY_REGISTERED` | This sandbox already registered the endpoint |
| `ALREADY_SUBSCRIBED` | This sandbox already subscribed to that event |
| `LIMIT_REACHED` | A per-app object limit was hit (e.g. max notification channels) |
| `STORAGE_FULL` | Storage quota or per-value size limit reached |
| `NETWORK_ERROR` | Fetch failed |
| `RATE_LIMITED` | Too many calls to a rate-limited API in the current window |
| `TIMEOUT` | An interactive flow (save dialog, share sheet) timed out |
| `IO_ERROR` | Disk write or save-dialog failure |
| `UNAVAILABLE` | The underlying OS service isn't available, an IPC endpoint isn't running, a required upstream connection isn't set up (e.g. no email account connected), or a machine-level gate is closed (e.g. `admin:*` when the machine isn't in admin mode) |
| `UNVERIFIED` | `nova:app:install` rejected an unsigned or trust-store-unverified package — a correct, fail-closed rejection |
| `GEOLOCATION_ERROR` | The browser's geolocation API itself failed or timed out (separate from `PERMISSION_DENIED`, which means the app-level grant was missing) |
| `CLIPBOARD_UNAVAILABLE` | The system clipboard could not be written/read |
| `INVALID_EVENT` | A calendar write was malformed (needs a title and a `YYYY-MM-DD` date) |
| `INVALID_CONTACT` | A contact write was malformed (needs an id and a name) |
| `INVALID_ID` / `INVALID_STATE` / `INVALID_OPERATION` | Malformed ids, wrong object state, or an operation the target doesn't support (e.g. writing to a folder) |
| `UNSUPPORTED_TYPE` | A value's MIME type is not supported by that channel |
| `POLICY_BLOCKED` | A kiosk/system policy blocked the change (e.g. wallpaper locked) |
| `PROTECTED_LOCATION` | The target is a system filesystem root (`/`, `/data`, Trash) that apps cannot mutate |
| `FILE_TOO_LARGE` / `PAYLOAD_TOO_LARGE` | A file or request payload exceeded its size cap (files 10 MB, IPC payloads the app's `ipcPayloadBytes` budget) |
| `ALREADY_INSTALLED` / `NOT_UNINSTALLABLE` / `UNTRUSTED` / `TAMPERED` / `INVALID_PACKAGE` / `MALICIOUS_PACKAGE` | Package install/uninstall validation failures — all fail-closed; install those manually through App Manager instead |
| `DIALOG_ERROR` / `PICKER_ERROR` / `SHARE_FAILED` / `RENDER_FAILED` / `SANITIZE_FAILED` | A host-side dialog, picker, share sheet, or render/sanitize step failed internally |
| `WRITE_ERROR` | A disk write failed (a distinct code from `IO_ERROR`, which covers save-dialog failures) |
| `INTERNAL_ERROR` | An unexpected host-side handler failure |

---

## Security

### Sandbox model and app isolation

NovaByte's app runtime is NW.js webview guests plus a host-side capability broker:

```text
[NovaByte app guest]
        |
        | validated nova:* IPC + per-app grants
        v
[NovaByte host broker] ---- [scoped FS / OS services]
```

The host broker checks the calling app's identity and grants on every privileged operation. App-private files are scoped under the app's own `/data/<app-id>/` directory; shared filesystem access is mediated by the FS API and picker-granted file ids; cross-app service/provider requests and broadcasts are separately permissioned and limited to manifest-declared targets.

This is not Android, and it is worth being precise about what the boundaries are:

- Apps do **not** run under distinct Linux UIDs, SELinux domains, seccomp filters, or cgroups. There is one browser process and one user; an NW.js renderer guest is not a separate Linux user. (Earlier NBOSP images experimented with a per-app Linux UID supervisor and SELinux boot integration; that substrate has been removed from the image and is not part of the current architecture.)
- JavaScript's managed runtime is not protection against memory or native-code vulnerabilities.
- What enforces isolation instead is the webview renderer boundary plus **two JS-side layers at the IPC choke point**, described below: the MAC policy engine (which endpoints a domain may call, with which grants) and the storage ledger (what an app may store, and which files it may touch). Both are enforced host-side before any handler runs.

### System policy engine (NB-MAC)

Every sandboxed IPC call passes a mandatory access control check in the bridge (`MacPolicy.checkIpc`) **before** any handler code runs. It is the JS-side analog of the SELinux layer Android stacks on top of its per-app UIDs, reimplemented at the bridge because the kernel route does not fit this architecture (single browser process, single-user OS).

The model, briefly: each app maps to a policy **domain** (every sandboxed app starts as `untrusted_app`, enforcing); each IPC endpoint family (`nova:fs`, `nova:admin`, …) has a policy row that is either grant-coupled (the call requires ANY-of a listed permission set) or advisory (the handler's own context-sensitive checks — path ownership, quotas, picker grants — remain the boundary). An endpoint with **no policy row at all is refused** for enforcing domains, so new attack surface is locked by default. A `neverallow` list protects privilege anchors (e.g. `nova:admin:*` can never be made advisory), and a linter rejects policies that leave handlers uncovered or violate it.

What apps observe:

- Grant-coupled endpoints behave exactly as before: without the required permission the call is refused with `PERMISSION_DENIED` (message prefixed `Blocked by system security policy (MAC):`); with it, the call succeeds. Handlers keep their own checks as defense in depth.
- Denials are avc-audited to a rate-limited ring buffer surfaced in **Settings → Privacy & Security → Security Policy**, so users (and you, while debugging) can see what a domain was denied.
- Permissive domains exist for rollout: would-be denials are logged but passed through, the SELinux "ship permissive first, then flip to enforcing" playbook.

App developers normally don't interact with any of this: declare the permissions your app needs and the policy does the rest.

### `eval()` auditing

`eval()` and `new Function()` are blocked twice, independently:

- **Install time:** the Content Scanner flags literal `eval(` and `new Function(` as dynamic-code patterns and can block install before the app ever runs.
- **Runtime:** the sandbox CSP no longer contains `unsafe-eval`, so the browser blocks `eval()` and `new Function()` outright, including indirect forms like `window['ev' + 'al']`. `wasm-unsafe-eval` remains for WebAssembly only — that is not a dynamic-JS grant.

The CSP is enforced from **two independent places**, both stripped of `unsafe-eval`: the client-side `RELAXED_CSP_META` meta tag injected by `app-sandbox.js`, and the server-sent `Content-Security-Policy` header on the `/api/apps/serve/:sandboxId/*` route that serves packaged app files. The header is at least as authoritative as the meta tag — it's set before the browser parses the HTML — so both had to be patched for the fix to be complete.

The sandbox's capability shim still reports attempted `eval()` calls via the internal `nova:audit:eval` channel to `EventLog` (category `security`, severity `warn`) for observability, but in practice the CSP throws before the call does anything.

Practical takeaway: there is no supported way to use `eval()` or `new Function()` in this sandbox. Don't ship code that tries.

### Best practices

- Request the minimum permissions your app actually needs.
- Handle optional permission denial gracefully — the app should still function.
- Don't use `eval()` — use safer alternatives.
- Validate and sanitize all user input and any file content you read.
- Don't collect data you don't need.
- External scripts in the packaged entry HTML are deferred by the NovaByte host, so `app.js` can initialize against the parsed entry-page DOM directly. Add `defer` as well if you also run the page outside NovaByte OS. Dynamically created scripts and documents retain normal browser timing.

### Content Scanner — avoiding false positives on install

Every dropped file and every file inside a `.novaapp` package is run through a static heuristic scanner (`window.Scanner`) before it's trusted — on drag-and-drop into Files/Desktop, and on App Manager package install. It isn't an AV engine; it's a small set of cheap tripwire checks. A handful of ordinary build patterns will trip it if you're not aware of the rules:

- **Reference your script, don't inline it.** In `index.html`, use `<script src="app.js"></script>` — a local relative path to a sibling file in your package. An inline `<script>...</script>` block with actual code inside is flagged and blocks install, no exceptions. Each file in a `.novaapp` package stays a separate file at build and runtime; this rule is purely about what the scanner allows.
- **"Local" means local.** The `src` path can't have a scheme (`http://`, `data:`, …), can't be protocol-relative (`//...`), can't be absolute (`/...`), and can't contain `..` traversal. Keep it a plain relative filename like `app.js` or `js/app.js`.
- **Don't `eval()` decoded/assembled strings.** `atob(...)`, `Buffer.from(..., 'base64')`, and `String.fromCharCode(...)` are fine on their own. What blocks is piping the result into `eval(...)`, `new Function(...)`, `document.write(...)`, or `.innerHTML =`. Decode binary data and use it as data — don't hand it to something that executes it.
- **Avoid literal `eval(` and `new Function(` entirely** — flagged outright, independent of the base64 rule.
- **If your app renders user-supplied HTML/Markdown/SVG, keep iframes sandboxed.** An `<iframe>` with no `sandbox` attribute is always rejected; a sandboxed iframe combining `allow-same-origin` with `allow-scripts` is rejected too — everything else with a proper `sandbox` attribute and a local or `https://` `src` is fine.
- **Don't ship high-entropy content under a text-like extension.** A file declared `.js`, `.json`, `.svg`, `.html`, `.md`, `.txt`, etc. whose bytes look like packed/encoded binary (high Shannon entropy) is flagged as likely disguised content.
- **Don't double up extensions.** `readme.pdf.exe` is flagged purely for the executable extension trailing a plausible document one.

None of this affects `vendor/` libraries dropped in as single minified JS/CSS files — those are bundled at Build time via the normal template pipeline.

---

## Package format

A `.novaapp` file is plain JSON:

```json
{
  "novabyte_app": true,
  "compiled_at": 1700000000000,
  "manifest": { "id": "...", "name": "...", "version": "...", "entry": "...", "permissions": [] },
  "files": {
    "index.html": "<base64-encoded content>",
    "app.js": "<base64-encoded content>"
  },
  "signing": { "method": "ed25519" },
  "signature": "<signature, base64url>",
  "signer": "NovaByte Trusted Signing",
  "integrity": {
    "method": "blake3",
    "payloadHash": "<hex digest of the signed payload>",
    "fileHashes": { "index.html": "<hex digest>", "app.js": "<hex digest>" }
  }
}
```

File contents are Base64-encoded. `signature` is a signature over the `novabyte_app`, `manifest`, `files`, and `compiled_at` fields — not a checksum. A checksum says nothing about who produced the file; a signature can only be produced by whoever holds the matching private key, which is what makes trust meaningful. `signing.method` records which algorithm produced the signature (Ed25519 unless stated otherwise — see [Supported signing methods](#supported-signing-methods)), and the optional `integrity` block records tamper-evidence digests (see [Package integrity](#package-integrity)).

### Package signatures

Signed doesn't automatically mean trusted. The runtime checks two separate things on install:

1. **Is the signature valid?** — does it verify against the public key that produced it.
2. **Is that public key trusted by the OS?** — the OS trust store determines which signers are trusted.

An app can carry a perfectly valid signature from some other key and still be reported **Unverified**. Trust is about "was this signed with a key the OS actually trusts," not "was this signed."

**Self-signing** — you can sign your own `.novaapp` with your own keypair for local testing. It will only be trusted if the corresponding public key is in the OS trust store. Self-signing proves the package hasn't been tampered with since you signed it; it does not make it trusted.

**Revocation** — trust can be pulled from one specific signed package after the fact, by its exact signature, without touching the signing key or any other package that key signed:

- Revocation is keyed by the exact signature string, not by app id/name/version — those fields are dev-controlled and could be reused or spoofed, whereas a signature is a fixed value produced once, at sign time.
- Revoking a signature does **not** revoke the key — every other package signed with that key stays trusted. If the private key itself is compromised, the trust store entry needs to be replaced and everything re-signed.
- Revocations persist to disk (`revoked-signatures.json`) and apply across every NBOSP process on that machine. A mistaken revocation can be undone.

**What the user sees:**

- **Verified** — signed with NovaByte's trusted key, not revoked. Installs normally.
- **Unverified** — unsigned, self-signed, signed with any other key, or individually revoked. The install still proceeds, but the OS shows a clear warning first so the user can back out.

Unverified doesn't mean blocked — NBOSP doesn't gatekeep what you can run on your own machine. It means the OS tells you the truth about what it can and can't vouch for, and leaves the decision with you.

### Supported signing methods

Packages record the algorithm that produced their signature in a `signing: { "method": "..." }` field, and verification reads that field. Seven methods are built in (`AppPackage.listSigningMethods()` returns this list at runtime):

| `signing.method` | Algorithm | Status | Notes |
| --- | --- | --- | --- |
| `ed25519` | Ed25519 | **Default** | 64-byte signatures, fast verification. What NovaByte's own keys use; a package without a `signing` field is verified as Ed25519. |
| `ecdsa-p256` | ECDSA P-256 | Stable | NIST curve over SHA-256. Enterprise / smart-card compatibility. |
| `ecdsa-p384` | ECDSA P-384 | Stable | Same, over SHA-384. |
| `rsa-pss-4096` | RSA-PSS 4096 | Stable | 4096-bit keys, SHA-384, 48-byte salt. Legacy infrastructure fallback. |
| `ml-dsa-65` | ML-DSA-65 | Experimental | NIST post-quantum signatures (FIPS 204). Requires `@noble/post-quantum`; keys are hex strings rather than JWKs. |
| `ed448` | Ed448 | Experimental | 224-bit security margin. Requires Node crypto — present in the NW.js host, absent in a plain browser tab, where verification of this method fails. |
| `custom` | Bring your own | Stable | You supply the signing and verification logic; the `signature` field holds whatever your signer emits. Only useful where you control both ends. |

Practical notes:

- Keypairs come from `AppPackage.generateSigningKeyPair(method)` — WebCrypto JWKs for every method except ML-DSA-65 (hex strings) and `custom` (you bring your own material). The Packages app generates keypairs and builds signed packages for any of these methods.
- Verification accepts both the documented base64url signature encoding and the plain-hex encoding older builds emitted (an ambiguous string is tried as both), so packages from either generation verify. New builds emit base64url.
- A trust-store entry can pin the method it verifies with; otherwise the package's `signing.method` decides, falling back to Ed25519 when absent.
- Experimental methods are labelled as such in the Packages app. Don't ship production packages on them without a fallback plan.

### Package integrity

Signatures prove who produced a package; integrity digests prove the bytes you received are still the ones that were produced. A package may carry an optional `integrity` block: `payloadHash` covers the exact canonical payload the signature covers, and `fileHashes` covers each packaged file's decoded bytes individually — so a tampered install can be narrowed down to the exact files that changed.

Supported methods (`AppPackage.listIntegrityMethods()`): `blake3` (default), `sha256`, `sha512`, and `none`. Recording a digest is opt-in at build time — the Packages app offers the choice per build, and NovaPack Studio v1.1.80+ defaults new projects to None. A package has integrity protection only if its build computed one.

How the runtime treats the block:

- **Fail closed.** A block recorded with method `none` — or missing its payload hash — never verifies as passing. There is nothing to compare, so it is reported as *unavailable*, never *ok*.
- **A separate axis from trust.** The App Manager checks recorded digests before the trust decision and reports the two independently. A trusted signer whose bytes were altered gets a dedicated tamper warning listing the mismatched files; an untrusted signer with altered bytes gets a combined dialog. Like the unverified warning, both can be overridden by the user — the OS tells the truth and leaves the decision with you.
- **Integrity-only installs.** `installPackage()` accepts an `allowIntegrityFallback` option: when trust-store verification fails but the recorded digests all match, the install proceeds marked with signer `integrity-only` — the contents provably match what was built, but nobody vouches for who built them. The Packages app exposes this behind an explicit opt-in in its install tab; the Store and the App Manager never use it.

---

## Distribution

### Direct distribution

Share the `.novaapp` file directly. Users drag and drop it into the App Manager — anywhere in its window — or click Install and pick the file; several files dropped at once install as a batch. That's the whole install flow: no separate installer, no admin rights required.

Every install runs the content scanner over each packaged file, then verifies the signature against the trust store and any recorded integrity digests, with the dialog flow described under [Package signatures](#package-signatures). Unverified packages still install, but with a warning so users can decide whether to trust them.

When a user installs a package whose app id is already installed, the App Manager detects the conflict and prompts to replace the existing version. System apps cannot be replaced by package installs. A replace only swaps the package files — the app's sandboxed storage and data folders survive.

### Store

The Store (`com.nbosp.store`) is the built-in catalog app, and the normal way users discover and install third-party apps. It merges two catalogs, deduplicated by app id:

- **The static catalog** — `apps.json` served from `https://novabyteteam.github.io/novabyte-os/`.
- **The community publisher catalog** — NovaByte's hosted publisher service.

A catalog entry carries: `id`, `name`, `version`, `file` (the `.novaapp` URL), `author`, `description`, `categories`, `icon`, `size`, `screenshots`, `links`, `releaseNotes`, and `versionHistory` — an array of `{ version, date, notes }` entries that powers the detail page's Release track panel. `file`, icons, and screenshots resolve against the catalog base URL, so they can be relative paths on the catalog host or absolute `https://` URLs — a GitHub Releases download link works fine. Non-HTTPS URLs are dropped.

Store installs run the same trust machinery as manual installs: the package's manifest id must match the catalog entry, the signature is verified against the trust store with revocation applied (a revoked signature refuses to install outright), and any recorded integrity digests are checked. Packages that verify get a **Verified** badge with the signer's name on the card and detail page. If one catalog is unreachable, the Store degrades to the other; if both fail, it shows a connection error.

### Updates

Updates are built in — users never re-download a package by hand unless they want to.

**One-click updates in the Store.** When the catalog version is strictly newer than the installed version, the app's card and detail page show an **Update** button. Updating re-downloads and re-verifies the package, requires the downloaded version to match the catalog entry and be strictly newer than what's installed, then swaps it in place: the original install date and source are preserved, the update source and time are recorded, the app is re-registered into the live OS registry (launchable immediately, no restart), and an *App Updated* notification with release notes is posted. The app's data is untouched.

**Background update checks.** The Store Update Service (`com.nbosp.service.store-updates`, a system service) checks the catalog once at startup and then on an interval — 15/30/60 (default)/120/360/720/1440 minutes, or 0 to disable — set in the Store's settings, next to a manual *Check now*. When an installed non-system app has a newer catalog version, it posts an OS notification — app name, new version, release notes, and an *Open store* action — once per app and version.

**What a release looks like for the developer:**

1. Bump `version` in `manifest.json`
2. Build and sign the `.novaapp`
3. Publish it at the URL the catalog entry's `file` field points to
4. Update the catalog entry — new `version`, plus a `versionHistory` entry (and `releaseNotes`) so the notification and Release track say what changed

Two rules keep the pipeline working:

- **Versions must be valid semver** — `1.2.3`, optionally `v`/`=`-prefixed, with optional `-prerelease` and `+build` suffixes (a prerelease sorts before its release). Anything else can't be compared, and update detection silently skips that app.
- **System apps never update through the Store** — neither the background check nor the Update button applies to them.

---

## Compatibility

The `.novaapp` format is used by NovaByte OS and compatible NBOSP forks. Runtime APIs and permissions can differ between hosts and forks; check the target system documentation and test against the environments you intend to support.

### API evolution and backward compatibility

Existing `.novaapp` APIs remain available to apps that already use them. When NovaByte adds different behavior, it ships through a new API (like the `window.novaOS` v2 facade) so existing apps keep working.

This does not mean bugs or security issues are left unfixed. NovaByte may fix an existing API when it has a genuine bug or vulnerability, while taking care not to break apps that rely on it.

The working rules, spelled out:

1. **The v1 channel surface is frozen.** Every `nova:*` channel documented here keeps its payload shape, response object, error codes, and permission gate forever. Tests assert this on every change (the guest-bridge audit runs the documented raw-channel probe against the real dispatcher).
2. **New behavior ships as new API, never as a change to old API.** A better version of an existing capability appears as a new channel or a new facade method (see [Platform API v2](#platform-api-v2--windownovaos-completed-facade)); the old one stays byte-compatible.
3. **Facades are sugar, not replacements.** Each `window.novaOS.*` facade wraps one or more v1 channels 1:1 — the facade and the channel cannot drift apart, because the facade makes the same call through the same bridge.
4. **Feature detection is `window.novaOS.capabilities.has(name)`.** Version your probes off capability names, not off `novaOS.apiVersion` or user-agent sniffing. Capability names are added over time and never removed or reused for different meanings.
5. **Removal is not a thing.** Channels are not removed or repurposed in major OS versions; at most they stop being *documented as recommended* when a facade supersedes them — which is always stated next to the facade (see the `dialog` facade note for the pattern).

### Legacy vfs compatibility

The earliest `.novaapp` packages predate the scoped-storage `fs` family. Their manifests declare the `vfs:*` permission family and their code dials the `nova:vfs:*` channels directly. Those names are still accepted through a background translation layer — old apps keep working without a repack, and the translation never weakens enforcement:

**Permissions** (translated at registration, before the unknown-permission strip — an old manifest registers with exactly the grants a modern manifest would carry):

| Legacy manifest name | Modern equivalent |
| --- | --- |
| `vfs:metadata` (and the `vfs:metedata` typo) | `fs:metadata` |
| `vfs:access`, `vfs:read`, `vfs:write`, `vfs:delete` | `fs:access` |

There is no generic `fs:read`/`fs:write`/`fs:delete` permission anymore — the scoped-storage model collapsed the broad filesystem verbs into the single special-access grant. `fs:access` is **special access**: it is never prompt-granted at install or runtime; the user must explicitly enable "Manage all files" for the app in Settings → per-app permissions. Translating into it therefore cannot widen an old app's access silently. Without that toggle, old apps keep the modern scoped behavior: their own `/data/` files need no grant, and shared-tree writes go through the same picker/confirmation flows a modern app sees.

**Channels** (translated at the IPC front door, *before* handler lookup and the MAC policy check — a legacy call takes exactly the enforcement path a modern call takes):

| Legacy channel | Modern channel |
| --- | --- |
| `nova:vfs:read` / `vfs:read` | `nova:fs:read` |
| `nova:vfs:write` / `vfs:write` | `nova:fs:write` |
| `nova:vfs:delete` / `vfs:delete` | `nova:fs:delete` |
| `nova:vfs:list` / `vfs:list` | `nova:fs:list` |
| `nova:vfs:mkdir` / `vfs:mkdir` | `nova:fs:mkdir` |
| `nova:vfs:stat` / `vfs:stat` | `nova:fs:stat` |
| `nova:vfs:rename` / `vfs:rename` | `nova:fs:rename` |
| `nova:vfs:move` / `vfs:move` | `nova:fs:move` |
| `vfs:metadata` / `vfs:metedata` | `nova:fs:stat` |

Notes for legacy callers:

- Responses carry the modern channel's type string (e.g. `nova:fs:read:response`), not the legacy name. The bridge matches responses by `requestId`, so existing promise/listener code resolves unchanged.
- `vfs:access` is deliberately **not** aliased as a channel — it was only ever a permission name, and as a channel it returns `UNKNOWN_API` exactly as it always did.
- Unknown `vfs:*` names (`vfs:frobnicate`, …) still return `UNKNOWN_API`; the alias table is exact, there is no prefix wildcard.
- `nova:vfs:watch` never existed and has no alias; filesystem watching is the `nova:fs:watch` / `fs:watch` grant pair from the modern family.
- The `vfs:metedata` misspelling of `vfs:metadata` is accepted too, as pure typo insurance — it is not a known historical channel or permission spelling, but accepting it costs nothing and a package that ever shipped the typo keeps working.