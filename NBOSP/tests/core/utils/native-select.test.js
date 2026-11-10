// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('in-page native select popups', () => {
  let select;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete window.__novaSelectPopupInstalled;
    require('../../../js/core/utils/base-utils.js');

    select = document.createElement('select');
    select.innerHTML = [
      '<option value="first">First option</option>',
      '<option value="second">Second option</option>',
      '<option value="disabled" disabled>Unavailable option</option>',
    ].join('');
    document.body.appendChild(select);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a positioned listbox and commits pointer selection with native events', () => {
    const rect = { left: 40, right: 160, top: 100, bottom: 130, width: 120, height: 30 };
    vi.spyOn(select, 'getBoundingClientRect').mockReturnValue(rect);
    const changed = vi.fn();
    select.addEventListener('change', changed);

    const openEvent = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    select.dispatchEvent(openEvent);

    const popup = document.querySelector('.nova-select-popup');
    expect(openEvent.defaultPrevented).toBe(true);
    expect(popup.getAttribute('role')).toBe('listbox');
    expect(popup.style.left).toBe('40px');
    expect(popup.style.top).toBe('134px');
    expect(select.getAttribute('aria-expanded')).toBe('true');

    const secondOption = popup.querySelector('[data-option-index="1"]');
    secondOption.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));

    expect(select.value).toBe('second');
    expect(changed).toHaveBeenCalledOnce();
    expect(document.querySelector('.nova-select-popup')).toBeNull();
    expect(select.getAttribute('aria-expanded')).toBe('false');
  });

  it('supports keyboard navigation, skips disabled options, and commits on Enter', () => {
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.querySelector('.nova-select-popup')).not.toBeNull();

    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(select.getAttribute('aria-activedescendant')).toContain('option-1');

    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(select.getAttribute('aria-activedescendant')).toContain('option-1');

    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(select.value).toBe('second');
    expect(document.querySelector('.nova-select-popup')).toBeNull();
  });

  it('closes on Escape without changing the selected value', () => {
    select.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(select.value).toBe('first');
    expect(document.querySelector('.nova-select-popup')).toBeNull();
    expect(select.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when the trigger is clicked again without reopening on click', () => {
    select.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.nova-select-popup')).not.toBeNull();
    select.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

    select.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    select.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

    expect(document.querySelector('.nova-select-popup')).toBeNull();
  });
});
