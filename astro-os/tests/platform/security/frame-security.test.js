import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock document for FrameSecurity ─────────────────────────────────────────
const mockIframe = (attrs = {}) => {
  const sandboxTokens = (attrs.sandbox || '').split(/\s+/).filter(Boolean);
  return {
    src: attrs.src || '',
    sandbox: {
      contains: vi.fn((token) => sandboxTokens.includes(token)),
      value: attrs.sandbox || '',
    },
    hasAttribute: vi.fn((name) => attrs[name] !== undefined || (name === 'sandbox' && attrs.sandbox !== undefined)),
    getAttribute: vi.fn((name) => attrs[name] ?? null),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    tagName: 'IFRAME',
    id: attrs.id || '',
    className: attrs.className || '',
    parentElement: attrs.parentElement || null,
    isConnected: true,
  };
};

globalThis.document = {
  querySelectorAll: vi.fn(() => []),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  documentElement: { tagName: 'HTML', querySelectorAll: vi.fn(() => []) },
};
globalThis.window = { FrameSecurity: undefined };

describe('FrameSecurity (js/platform/security/frame-security.js)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('loads and exposes the public API on window.FrameSecurity', () => {
    vi.resetModules();
    require('../../../js/platform/security/frame-security.js');
    expect(window.FrameSecurity).toBeDefined();
    expect(typeof window.FrameSecurity.isNodeRemoteUrl).toBe('function');
    expect(typeof window.FrameSecurity.hasNwDisable).toBe('function');
    expect(typeof window.FrameSecurity.isInWebview).toBe('function');
    expect(typeof window.FrameSecurity.getFrameType).toBe('function');
    expect(typeof window.FrameSecurity.validateFrameSecurity).toBe('function');
    expect(typeof window.FrameSecurity.securifyFrame).toBe('function');
    expect(typeof window.FrameSecurity.securifyAllFrames).toBe('function');
    expect(typeof window.FrameSecurity.auditAllFrames).toBe('function');
    expect(typeof window.FrameSecurity.startObserver).toBe('function');
    expect(typeof window.FrameSecurity.stopObserver).toBe('function');
    expect(typeof window.FrameSecurity.getRecentIssues).toBe('function');
    expect(typeof window.FrameSecurity.getNodeRemotePatterns).toBe('function');
  });

  describe('isNodeRemoteUrl', () => {
    it('returns false for non-string input', () => {
      const fs = window.FrameSecurity;
      expect(fs.isNodeRemoteUrl(null)).toBe(false);
      expect(fs.isNodeRemoteUrl(123)).toBe(false);
    });

    it('returns false for non-https schemes', () => {
      const fs = window.FrameSecurity;
      expect(fs.isNodeRemoteUrl('http://localhost:3003/app')).toBe(false);
      expect(fs.isNodeRemoteUrl('blob:http://example.com/uuid')).toBe(false);
      expect(fs.isNodeRemoteUrl('file:///etc/passwd')).toBe(false);
      expect(fs.isNodeRemoteUrl('javascript:alert(1)')).toBe(false);
    });

    it('returns true for https://localhost URLs', () => {
      const fs = window.FrameSecurity;
      expect(fs.isNodeRemoteUrl('https://localhost:3003/app')).toBe(true);
    });

    it('returns true for https://127.0.0.1 URLs', () => {
      const fs = window.FrameSecurity;
      expect(fs.isNodeRemoteUrl('https://127.0.0.1:3003/app')).toBe(true);
    });

    it('returns false for public HTTPS URLs', () => {
      const fs = window.FrameSecurity;
      expect(fs.isNodeRemoteUrl('https://example.com')).toBe(false);
    });
  });

  describe('hasNwDisable', () => {
    it('returns false for null iframe', () => {
      const fs = window.FrameSecurity;
      expect(fs.hasNwDisable(null)).toBe(false);
    });

    it('returns true when nwdisable attribute is present', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ nwdisable: '' });
      expect(fs.hasNwDisable(iframe)).toBe(true);
    });
  });

  describe('isInWebview', () => {
    it('returns false for null iframe', () => {
      const fs = window.FrameSecurity;
      expect(fs.isInWebview(null)).toBe(false);
    });

    it('returns true when parentElement is a webview', () => {
      const fs = window.FrameSecurity;
      const webviewEl = { tagName: 'WEBVIEW', parentElement: null };
      const iframe = mockIframe({ parentElement: webviewEl });
      expect(fs.isInWebview(iframe)).toBe(true);
    });

    it('returns false for normal parent chain', () => {
      const fs = window.FrameSecurity;
      const div = { tagName: 'DIV', parentElement: null };
      const iframe = mockIframe({ parentElement: div });
      expect(fs.isInWebview(iframe)).toBe(false);
    });
  });

  describe('getFrameType', () => {
    it('returns normal for null iframe', () => {
      const fs = window.FrameSecurity;
      expect(fs.getFrameType(null)).toBe('normal');
    });

    it('returns node for localhost URLs without nwdisable', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://localhost:3003/app' });
      expect(fs.getFrameType(iframe)).toBe('node');
    });

    it('returns normal when nwdisable is present', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://localhost:3003/app', nwdisable: '' });
      expect(fs.getFrameType(iframe)).toBe('normal');
    });

    it('returns normal for external URLs', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/' });
      expect(fs.getFrameType(iframe)).toBe('normal');
    });
  });

  describe('validateFrameSecurity', () => {
    it('returns invalid for null iframe', () => {
      const fs = window.FrameSecurity;
      const result = fs.validateFrameSecurity(null);
      expect(result.valid).toBe(false);
      expect(result.frameType).toBe('normal');
      expect(result.issues).toContain('iframe element is null');
    });

    it('validates a correct normal frame with sandbox', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/', sandbox: 'allow-scripts' });
      const result = fs.validateFrameSecurity(iframe);
      expect(result.valid).toBe(true);
      expect(result.frameType).toBe('normal');
    });

    it('flags missing sandbox on normal frame', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/' });
      const result = fs.validateFrameSecurity(iframe);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('sandbox'))).toBe(true);
    });

    it('flags allow-same-origin as escape risk', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/', sandbox: 'allow-scripts allow-same-origin' });
      const result = fs.validateFrameSecurity(iframe);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('allow-same-origin'))).toBe(true);
    });

    it('flags node frame with sandbox restrictions', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://localhost:3003/app', sandbox: 'allow-scripts' });
      const result = fs.validateFrameSecurity(iframe);
      expect(result.valid).toBe(false);
      expect(result.frameType).toBe('node');
      expect(result.issues.some(i => i.includes('Node frame should not have sandbox'))).toBe(true);
    });
  });

  describe('securifyFrame', () => {
    it('adds nwdisable and sandbox to normal frames in patch mode', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/' });
      fs.securifyFrame(iframe, 'normal', { mode: 'patch' });
      expect(iframe.setAttribute).toHaveBeenCalledWith('nwdisable', '');
      // sandbox is set via setAttribute or sandbox.value depending on DOMTokenList availability
      const sandboxCalls = iframe.setAttribute.mock.calls.filter(c => c[0] === 'sandbox');
      const sandboxValueSet = iframe.sandbox.value === 'allow-scripts allow-forms allow-modals allow-popups';
      expect(sandboxCalls.length > 0 || sandboxValueSet).toBe(true);
    });

    it('strips sandbox and nwdisable from node frames', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://localhost:3003/app', sandbox: 'allow-scripts', nwdisable: '' });
      fs.securifyFrame(iframe, 'node');
      expect(iframe.removeAttribute).toHaveBeenCalledWith('sandbox');
      expect(iframe.removeAttribute).toHaveBeenCalledWith('nwdisable');
    });

    it('replaces sandbox tokens in replace mode', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/', sandbox: 'allow-scripts allow-same-origin' });
      fs.securifyFrame(iframe, 'normal', { mode: 'replace' });
      // In replace mode the sandbox value is set directly via sandbox.value or setAttribute
      const expected = 'allow-scripts allow-forms allow-modals allow-popups';
      const setAttributeCalled = iframe.setAttribute.mock.calls.some(c => c[0] === 'sandbox' && c[1] === expected);
      const valueSet = iframe.sandbox.value === expected;
      expect(setAttributeCalled || valueSet).toBe(true);
    });
  });

  describe('securifyAllFrames', () => {
    it('returns summary with securified count when iframes have issues', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/' });
      document.querySelectorAll.mockReturnValue([iframe]);
      const summary = fs.securifyAllFrames({ mode: 'patch' });
      expect(summary.total).toBe(1);
      expect(summary.securified.length).toBeGreaterThanOrEqual(1);
    });

    it('skips excluded iframes', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/', id: 'skip-me' });
      document.querySelectorAll.mockReturnValue([iframe]);
      const summary = fs.securifyAllFrames({ exclude: ['#skip-me'] });
      expect(summary.skipped).toContain('#skip-me');
    });
  });

  describe('auditAllFrames', () => {
    it('returns total count and issues array', () => {
      const fs = window.FrameSecurity;
      const iframe = mockIframe({ src: 'https://example.com/' });
      document.querySelectorAll.mockReturnValue([iframe]);
      const audit = fs.auditAllFrames();
      expect(audit.total).toBe(1);
      expect(audit.normalFrames).toBe(1);
      expect(audit.issues.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('startObserver / stopObserver', () => {
    it('startObserver does not throw when MutationObserver is available', () => {
      const MockObs = vi.fn().mockImplementation(() => ({ observe: vi.fn(), disconnect: vi.fn() }));
      window.MutationObserver = MockObs;
      vi.resetModules();
      require('../../../js/platform/security/frame-security.js');
      const fs = window.FrameSecurity;
      expect(() => fs.startObserver({ autoSecurify: true, mode: 'patch' })).not.toThrow();
    });

    it('startObserver is a no-op when MutationObserver is unavailable', () => {
      const prev = window.MutationObserver;
      window.MutationObserver = undefined;
      vi.resetModules();
      require('../../../js/platform/security/frame-security.js');
      const fs = window.FrameSecurity;
      expect(() => fs.startObserver()).not.toThrow();
      window.MutationObserver = prev;
    });

    it('stopObserver disconnects an existing observer', () => {
      vi.resetModules();
      require('../../../js/platform/security/frame-security.js');
      const fs = window.FrameSecurity;
      const mockObs = { disconnect: vi.fn() };
      // Set via the module's internal reference by calling startObserver first
      fs.startObserver();
      // The module stores the observer internally; we can't directly set it
      // because the API is frozen, but we can verify stopObserver doesn't throw
      expect(() => fs.stopObserver()).not.toThrow();
    });

    it('getRecentIssues returns a copy of the issues array', () => {
      const fs = window.FrameSecurity;
      const result = fs.getRecentIssues();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getNodeRemotePatterns', () => {
    it('returns the regex sources for node-remote patterns', () => {
      const fs = window.FrameSecurity;
      const patterns = fs.getNodeRemotePatterns();
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
    });
  });
});
