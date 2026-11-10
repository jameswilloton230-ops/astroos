import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// base-utils is an IIFE that attaches to window when loaded.
// We explicitly require it so the side-effects run before assertions.

describe('base-utils (js/core/utils/base-utils.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    // Ensure document exists before loading the module
    if (typeof globalThis.document === 'undefined') {
      globalThis.document = {
        createElement: vi.fn((tag) => ({
          tagName: tag.toUpperCase(),
          style: {},
          setAttribute: vi.fn(),
          getAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          appendChild: vi.fn(),
          removeChild: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          textContent: '',
          innerHTML: '',
          classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
          dataset: {},
          children: [],
          parentNode: null,
        })),
        createDocumentFragment: vi.fn(() => ({ appendChild: vi.fn() })),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }
    // Load the module so it attaches to window
    require('../../../js/core/utils/base-utils.js');
  });

  it('attaches generateId to window', () => {
    expect(window.generateId).toBeDefined();
    expect(typeof window.generateId).toBe('function');
  });

  it('attaches sanitiseHTML and escapeHtml to window', () => {
    expect(typeof window.sanitiseHTML).toBe('function');
    expect(typeof window.escapeText).toBe('function');
    expect(typeof window.escapeHtml).toBe('function');
  });

  it('escapes dangerous HTML characters', () => {
    const input = '<script>alert("xss")</script>';
    expect(window.escapeHtml(input)).not.toContain('<script>');
    expect(window.sanitiseHTML(input)).not.toContain('<script>');
  });

  it('returns empty string for null/undefined', () => {
    expect(window.sanitiseHTML(null)).toBe('');
    expect(window.escapeText(undefined)).toBe('');
  });

  it('evaluates simple arithmetic expressions', () => {
    expect(window.safeEvaluateArithmetic('2+2')).toBe(4);
    expect(window.safeEvaluateArithmetic('10-3')).toBe(7);
    expect(window.safeEvaluateArithmetic('4*5')).toBe(20);
  });

  it('throws for invalid expressions', () => {
    expect(() => window.safeEvaluateArithmetic(null)).toThrow();
    expect(() => window.safeEvaluateArithmetic('')).toThrow();
  });

  it('formats bytes correctly', () => {
    expect(window.formatBytes(0)).toBe('0 B');
    expect(window.formatBytes(1024)).toBe('1 KB');
    expect(window.formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('throws for NaN bytes input', () => {
    expect(() => window.formatBytes(NaN)).toThrow(TypeError);
  });

  it('formats time and date', () => {
    const d = new Date('2026-07-10T14:30:00');
    const time = window.formatTime(d);
    expect(typeof time).toBe('string');
    const date = window.formatDate(d);
    expect(typeof date).toBe('string');
  });

  it('throws for null time/date input', () => {
    expect(() => window.formatTime(null)).toThrow(TypeError);
    expect(() => window.formatDate(null)).toThrow(TypeError);
  });

  it('debounces function calls', async () => {
    const fn = vi.fn();
    const debounced = window.debounce(fn, 100);
    debounced('arg1');
    debounced('arg2');
    expect(fn).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('arg2');
  });

  it('returns debounce object with cancel and flush', () => {
    const fn = () => {};
    const d = window.debounce(fn, 100);
    expect(d).toBeDefined();
    expect(typeof d.cancel).toBe('function');
    expect(typeof d.flush).toBe('function');
  });

  it('returns throttleRAF object with cancel', () => {
    const fn = () => {};
    const throttled = window.throttleRAF(fn);
    expect(throttled).toBeDefined();
    expect(typeof throttled.cancel).toBe('function');
  });

  it('creates DOM elements', () => {
    const el = window.createEl('button', { className: 'btn', textContent: 'Click' });
    expect(el.tagName).toBe('BUTTON');
  });

  it('sets innerHTML as element content rather than an HTML attribute', () => {
    const markup = '&#9998; Compose';
    const el = window.createEl('button', { innerHTML: markup });
    expect(el.innerHTML).toBe(markup);
    expect(el.setAttribute).not.toHaveBeenCalledWith('innerHTML', markup);
  });

  it('handles null children in createEl', () => {
    const el = window.createEl('div', null, null);
    expect(el).toBeDefined();
  });

  it('returns SVG markup for icons', () => {
    const html = window.svgIcon('x', 24);
    expect(html).toContain('<svg');
    expect(html).toContain('width="24"');
  });

  it('returns string for empty icon name', () => {
    const result = window.svgIcon('', 24);
    expect(typeof result).toBe('string');
  });

  it('detects browser', () => {
    const browser = window.detectBrowser();
    expect(typeof browser).toBe('string');
  });

  it('saves to localStorage', () => {
    window.lsSave('test-key', 'test-value');
    expect(globalThis.localStorage.getItem('test-key')).toBe('test-value');
  });
});
