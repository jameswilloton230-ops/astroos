import { describe, it, expect, afterEach } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';

// The guest capability shim defines window.nova for every sandboxed app.
// A misplaced brace once nested contextMenu and overlay INSIDE
// window.nova.appearance, so window.nova.overlay / window.nova.contextMenu
// were undefined for every app — overlay.show/onEvent threw
// "Cannot read properties of undefined" (Nova Browser's draw mode hit
// exactly that). These tests evaluate the generated shim in a fresh jsdom
// window, like a guest would, and pin the documented facade shape
// (NOVAAPP.md): window.nova.overlay.* and window.nova.contextMenu.* at the
// top level.

const doms = [];

function evaluateShim(nestedWebviewOptedIn) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://app.local/index.html',
    runScripts: 'outside-only',
  });
  doms.push(dom);
  const raw = AppSandbox._internal.buildCapabilityShim(nestedWebviewOptedIn);
  expect(raw.startsWith('<script>')).toBe(true);
  const source = raw.replace(/^<script>/, '').replace(/<\/script>\s*$/, '');
  // vm.runInContext (not window.eval) so the shim sees the window global
  // exactly as a guest renderer would.
  vm.runInContext(source, dom.getInternalVMContext());
  return dom.window;
}

afterEach(() => {
  while (doms.length) doms.pop().window.close();
});

describe('capability shim facade shape', () => {
  it('exposes overlay and contextMenu at the top level of window.nova (not opted in)', () => {
    const w = evaluateShim(false);

    expect(typeof w.nova.overlay.show).toBe('function');
    expect(typeof w.nova.overlay.hide).toBe('function');
    expect(typeof w.nova.overlay.onEvent).toBe('function');
    expect(typeof w.nova.contextMenu.show).toBe('function');
    expect(typeof w.nova.contextMenu.hide).toBe('function');

    // The regression: these were reachable only as appearance.overlay / appearance.contextMenu
    expect(w.nova.appearance.overlay).toBeUndefined();
    expect(w.nova.appearance.contextMenu).toBeUndefined();

    // appearance keeps its own documented surface
    expect(typeof w.nova.appearance.get).toBe('function');
    expect(typeof w.nova.appearance.set).toBe('function');
    expect(typeof w.nova.appearance.onChange).toBe('function');

    // the rest of the facade stays intact
    expect(typeof w.nova.requestPermission).toBe('function');
    expect(typeof w.nova.app.getInfo).toBe('function');
    expect(typeof w.nova.ipc).toBe('function');
  });

  it('exposes the same top-level shape for nested-webview opted-in apps', () => {
    const w = evaluateShim(true);

    expect(typeof w.nova.overlay.show).toBe('function');
    expect(typeof w.nova.overlay.onEvent).toBe('function');
    expect(typeof w.nova.contextMenu.show).toBe('function');
    expect(w.nova.appearance.overlay).toBeUndefined();
    expect(typeof w.nova.browser.createView).toBe('function');
  });

  it('subscribes and unsubscribes overlay listeners without touching the host', () => {
    const w = evaluateShim(false);

    const events = [];
    const unsubscribe = w.nova.overlay.onEvent(event => events.push(event));
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // A second unsubscribe must be a no-op, not a throw.
    expect(() => unsubscribe()).not.toThrow();
    expect(events).toEqual([]);
  });
});
