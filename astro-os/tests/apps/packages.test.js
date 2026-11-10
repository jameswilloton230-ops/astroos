// tests/apps/packages.test.js — window app: dev gates, tab switching, sign /
// verify / install flows driven through the real UI against an AppPackage
// stub that mirrors the real module's documented contract (the real crypto
// backend is separately covered by tests/platform/core/app-package.test.js).
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const DEV_OS = { settings: { get: (key) => key === 'devMode' }, apps: {} };

// Deterministic AppPackage implementing the exact API surface packages/app.js
// consumes (shapes verified against js/platform/core/app-package.js).
function makeAppPackageStub() {
  const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
  const dec = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
  return {
    listSigningMethods: () => [
      { id: 'ed25519', label: 'Ed25519' },
      { id: 'custom', label: 'Custom' },
    ],
    listIntegrityMethods: () => [
      { id: 'blake3', label: 'BLAKE3' },
      { id: 'sha256', label: 'SHA-256' },
      { id: 'none', label: 'None' },
    ],
    validateManifest: (m = {}) => {
      const errors = [];
      if (!/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(m.id || '')) errors.push('id must be reverse-domain like com.test.app');
      if (!m.name) errors.push('name is required');
      if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) errors.push('version must be x.y.z');
      if (!m.entry) errors.push('entry is required');
      return { valid: errors.length === 0, errors, warnings: [] };
    },
    generateSigningKeyPair: async (method) => ({
      method,
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'stub-public-key' },
      privateKey: { kty: 'OKP', crv: 'Ed25519', d: 'stub-private-key' },
    }),
    createPackage: async (manifest, files, opts = {}) => ({
      novabyte_app: '1.0',
      manifest: { ...manifest, packagedAt: '2026-01-01T00:00:00.000Z' },
      files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, enc(c)])),
      signature: `sig(${manifest.id})`,
      signer: 'local-dev-' + (opts.signingMethod || 'ed25519'),
      signing: { method: opts.signingMethod || 'ed25519' },
      integrity: opts.integrityMethod && opts.integrityMethod !== 'none'
        ? { method: opts.integrityMethod }
        : null,
      compiled_at: '2026-01-01T00:00:00.000Z',
    }),
    inspectPackage: (pkg) => ({
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      fileCount: Object.keys(pkg.files).length,
    }),
    verifyPackage: async () => true,
    verifyIntegrity: async () => true,
    extractPackage: (pkg) => Object.fromEntries(
      Object.entries(pkg.files).map(([p, b64]) => [p, dec(b64)]),
    ),
    installPackage: async (pkg, opts = {}) => ({
      success: true,
      verified: !opts.skipVerify,
      signer: 'stub-signer',
      app: { id: pkg.manifest.id },
    }),
  };
}

function makeTrustStore(list = []) {
  const calls = [];
  return {
    calls,
    list: () => list,
    revoke: (sig, reason) => { calls.push(['revoke', sig, reason]); },
    isRevoked: (sig) => calls.some(([, s]) => s === sig),
  };
}

async function loadPackages({ trustStore, extra = {} } = {}) {
  const loaded = await loadWindowApp('packages', {
    stubs: {
      extra: {
        OS: DEV_OS,
        AppPackage: makeAppPackageStub(),
        ...(trustStore ? { TrustStore: trustStore } : {}),
        ...extra,
      },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: { cleanups: [] } });
  await settle(10); // keypair generation is async
  return { ...loaded, content };
}

const tabButtons = (content) => [...content.querySelectorAll('button')].filter((b) => ['Sign', 'Verify', 'Install'].includes(b.textContent));
const clickTab = (content, name) => tabButtons(content).find((b) => b.textContent === name).click();
// content children: [tabBar, scroll]; the three panels live inside scroll in TABS order.
const panelByName = (content, tabIdx) => content.children[1].children[tabIdx];

describe("'Packages' app (js/apps/packages)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full dev-only app descriptor with the host', async () => {
    const { app } = await loadWindowApp('packages');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.packages');
    expect(app.name).toBe('Packages');
    expect(app.version).toBe('3.0.2');
    expect(app.category).toBe('developer');
    expect(app.devOnly).toBe(true);
    expect(app.defaultSize).toEqual([520, 620]);
    expect(app.minSize).toEqual([420, 420]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the developer-mode gate when dev mode is off', async () => {
    const { app, window } = await loadWindowApp('packages', {
      stubs: { extra: { OS: { settings: { get: () => false } } } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Packages.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('packages', {
      stubs: { AppDirs: null, extra: { OS: DEV_OS } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
  });

  it('renders the three tabs with Sign active and the default form values', async () => {
    const { content } = await loadPackages();
    const tabs = tabButtons(content);
    expect(tabs.map((b) => b.textContent)).toEqual(['Sign', 'Verify', 'Install']);

    const signPanel = panelByName(content, 0);
    const verifyPanel = panelByName(content, 1);
    const installPanel = panelByName(content, 2);
    expect(signPanel.style.display).toBe('block');
    expect(verifyPanel.style.display).toBe('none');
    expect(installPanel.style.display).toBe('none');

    // Four manifest fields plus the default file-row path input.
    const inputs = [...signPanel.querySelectorAll('input')];
    expect(inputs.length).toBe(5);
    expect(inputs.slice(0, 4).map((i) => i.value)).toEqual(['com.test.app', 'Test App', '1.0.0', 'index.html']);
    const fileRow = signPanel.querySelector('[data-role="file-row"]');
    expect(fileRow.querySelector('input').value).toBe('index.html');
    // Source quirk (asserted as-is): addFileRow passes `value` to createEl,
    // which forwards unknown props to setAttribute — but a <textarea>'s value
    // attribute is not its current value, so the '<h1>Hello</h1>' default
    // silently never appears and the row starts empty.
    expect(fileRow.querySelector('textarea').value).toBe('');
    // Signing-method select offers the stubbed catalogue with ed25519 selected.
    const methodSelect = signPanel.querySelector('select');
    expect([...methodSelect.options].map((o) => o.value)).toEqual(['ed25519', 'custom']);
  });

  it('switches tabs, shows the trust list, and drives the revoke flow', async () => {
    const trustStore = makeTrustStore([{ id: 'novabyte-trusted-signing-v1', name: 'AstroOS', publicKey: {} }]);
    const { content, window } = await loadPackages({ trustStore });

    clickTab(content, 'Verify');
    const verifyPanel = panelByName(content, 1);
    expect(verifyPanel.style.display).toBe('block');
    expect(panelByName(content, 0).style.display).toBe('none');

    // Trust list renders the store's entries, tagging the built-in signer.
    const trustList = [...verifyPanel.querySelectorAll('div')].find((d) => d.textContent.includes('AstroOS'));
    expect(trustList.textContent).toContain('AstroOS');
    expect(trustList.textContent).toContain('(built-in)');

    // Revoke without input → guard message.
    const revokeBtn = [...verifyPanel.querySelectorAll('button')].find((b) => b.textContent === 'Revoke');
    const unrevokeBtn = [...verifyPanel.querySelectorAll('button')].find((b) => b.textContent === 'Unrevoke');
    const sigInput = verifyPanel.querySelector('input[placeholder*="Exact pkg.signature"]');
    const note = revokeBtn.parentElement.querySelector('span:last-child');

    revokeBtn.click();
    expect(note.textContent).toBe('Paste a signature first.');

    sigInput.value = 'abc-signature';
    revokeBtn.click();
    expect(note.textContent).toBe('Revoked. Persisted to revoked-signatures.json.');
    expect(trustStore.calls).toEqual([['revoke', 'abc-signature', null]]);

    unrevokeBtn.click();
    // Stub has no unrevoke() → the app's fallback branch reports failure.
    expect(note.textContent).toBe('That signature wasn\u2019t on the revocation list.');
  });

  it('signs a package end-to-end and hands it to the Install tab', async () => {
    const { content } = await loadPackages();
    const signPanel = panelByName(content, 0);
    const signBtn = [...signPanel.querySelectorAll('button')].find((b) => b.textContent === 'Create & Sign Package');

    signBtn.click();
    await settle(30);

    const box = signPanel.querySelector('pre');
    expect(box.style.display).toBe('block');
    expect(box.style.borderColor).toBe('rgb(63, 185, 80)'); // ok=true → green
    const payload = JSON.parse(box.textContent);
    expect(payload.verified).toBe(true);
    expect(payload.verifyDetail).toBe('verified');
    expect(payload.integrityVerified).toBe(true);
    expect(payload.signingMethod).toBe('ed25519');
    expect(payload.integrityMethod).toBe('blake3');
    expect(payload.info.fileCount).toBe(1);
    expect(payload.fullPackage.manifest.id).toBe('com.test.app');
    expect(payload.publicKeyJwk.x).toBe('stub-public-key');

    // The signed package is carried over to the Install tab.
    clickTab(content, 'Install');
    const installPanel = panelByName(content, 2);
    const useSigned = [...installPanel.querySelectorAll('button')].find((b) => b.textContent === 'Use last signed package');
    useSigned.click();
    const textarea = installPanel.querySelector('textarea');
    expect(textarea.value).toContain('"com.test.app"');
  });

  it('reports manifest validation failures inline', async () => {
    const { content } = await loadPackages();
    const signPanel = panelByName(content, 0);

    // Blank name → validateManifest fails.
    const nameInput = [...signPanel.querySelectorAll('input')][1];
    nameInput.value = '';
    [...signPanel.querySelectorAll('button')].find((b) => b.textContent === 'Create & Sign Package').click();
    await settle(20);

    let box = signPanel.querySelector('pre');
    expect(JSON.parse(box.textContent).error).toBe('Manifest invalid');
    expect(box.style.borderColor).toBe('rgb(248, 81, 73)');

    // Entry not among the packaged files (name restored so validation passes).
    nameInput.value = 'Test App';
    const entryInput = [...signPanel.querySelectorAll('input')][3];
    entryInput.value = 'main.js';
    [...signPanel.querySelectorAll('button')].find((b) => b.textContent === 'Create & Sign Package').click();
    await settle(20);
    box = signPanel.querySelector('pre');
    expect(JSON.parse(box.textContent).error).toBe('Entry file "main.js" is not among the packaged files');
  });

  it('verifies a pasted package and previews its decoded files', async () => {
    const stub = makeAppPackageStub();
    const pkg = await stub.createPackage(
      { id: 'com.test.app', name: 'Test App', version: '1.0.0', entry: 'index.html' },
      { 'index.html': '<h1>Hello</h1>' },
      { integrityMethod: 'blake3', signingMethod: 'ed25519' },
    );

    const { content } = await loadPackages();
    clickTab(content, 'Verify');
    const verifyPanel = panelByName(content, 1);
    const textarea = verifyPanel.querySelector('textarea');

    // Invalid JSON first.
    textarea.value = '{nope';
    [...verifyPanel.querySelectorAll('button')].find((b) => b.textContent === 'Validate & Verify').click();
    await settle(10);
    expect(JSON.parse(verifyPanel.querySelector('pre').textContent).error).toBe('Invalid JSON');

    // Valid package: integrity holds but no public key → signature unverified.
    textarea.value = JSON.stringify(pkg);
    [...verifyPanel.querySelectorAll('button')].find((b) => b.textContent === 'Validate & Verify').click();
    await settle(30);

    const result = JSON.parse(verifyPanel.querySelector('pre').textContent);
    expect(result.manifestValid).toBe(true);
    expect(result.hasSignature).toBe(true);
    expect(result.signatureVerified).toBe(false);
    expect(result.integrityVerified).toBe(true);

    // File preview decodes the base64 payload back to text.
    const preview = [...verifyPanel.querySelectorAll('pre')].find((p) => p.textContent === '<h1>Hello</h1>');
    expect(preview).toBeTruthy();
  });

  it('installs a pasted package into the live registry', async () => {
    const stub = makeAppPackageStub();
    const pkg = await stub.createPackage(
      { id: 'com.test.app', name: 'Test App', version: '1.0.0', entry: 'index.html' },
      { 'index.html': '<h1>Hello</h1>' },
      {},
    );
    const notify = { calls: [], show: (n) => notify.calls.push(n) };
    const APP_REGISTRY = [];

    const { content, window } = await loadPackages({
      extra: {
        Notify: notify,
        APP_REGISTRY,
        AppRegistry: { launchApp: () => {} },
      },
    });

    clickTab(content, 'Install');
    const installPanel = panelByName(content, 2);

    // Without a package pasted → guard message.
    [...installPanel.querySelectorAll('button')].find((b) => b.textContent === 'Install Package').click();
    await settle(10);
    expect(JSON.parse(installPanel.querySelector('pre').textContent).error)
      .toBe('Paste package JSON first, or use a button above');

    installPanel.querySelector('textarea').value = JSON.stringify(pkg);
    [...installPanel.querySelectorAll('button')].find((b) => b.textContent === 'Install Package').click();
    await settle(30);

    const box = installPanel.querySelector('pre');
    const payload = JSON.parse(box.textContent);
    expect(payload.success).toBe(true);
    expect(payload.persisted).toBe(true);
    expect(payload.message).toBe('Test App v1.0.0 installed and registered.');

    // Registered into both the OS live map and APP_REGISTRY with a real launcher init.
    const cfg = window.OS.apps['com.test.app'];
    expect(cfg.name).toBe('Test App');
    expect(typeof cfg.init).toBe('function');
    expect(cfg.sandbox).toEqual({ allowSameOrigin: false, allowScripts: true, allowForms: true, allowPopups: false });
    expect(APP_REGISTRY.some((a) => a.id === 'com.test.app')).toBe(true);
    expect(notify.calls.some((n) => n.title === 'App Installed')).toBe(true);
  });

  it('refuses to install when AppRegistry is unavailable', async () => {
    const stub = makeAppPackageStub();
    const pkg = await stub.createPackage(
      { id: 'com.test.app', name: 'Test App', version: '1.0.0', entry: 'index.html' },
      { 'index.html': '<h1>Hello</h1>' },
      {},
    );
    const { content } = await loadPackages(); // no AppRegistry stub

    clickTab(content, 'Install');
    const installPanel = panelByName(content, 2);
    installPanel.querySelector('textarea').value = JSON.stringify(pkg);
    [...installPanel.querySelectorAll('button')].find((b) => b.textContent === 'Install Package').click();
    await settle(20);

    const payload = JSON.parse(installPanel.querySelector('pre').textContent);
    expect(payload.error).toBe('AppRegistry is not available in this context — cannot install');
  });
});
