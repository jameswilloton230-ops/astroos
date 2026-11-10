const ContextMenu = {
  current: null,
  _activeDismiss: null, // Track the current event handler for absolute safety

  show(x, y, items, onDismiss) {
    ContextMenu.hide();
    
    const menu = createEl('div', { className: 'context-menu', role: 'menu' });
    const fragment = document.createDocumentFragment();
    const len = items.length;

    // Use a high-performance indexed loop instead of for...of
    for (let i = 0; i < len; i++) {
      const item = items[i];
      
      if (item.separator) {
        fragment.appendChild(createEl('div', { className: 'ctx-separator' }));
        continue;
      }
      
      const btn = createEl('button', {
        className: 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : ''),
        role: 'menuitem',
        'aria-label': item.label,
        'aria-disabled': item.disabled ? 'true' : 'false'
      });
      if (item.disabled) btn.disabled = true;
      
      // Store reference to the specific action directly on the DOM element for event delegation
      if (item.action) btn._action = item.action;
      if (Number.isInteger(item._selectionIndex)) btn._selectionIndex = item._selectionIndex;

      if (item.icon) {
        const iconEl = createEl('span');
        iconEl.innerHTML = svgIcon(item.icon, 14);
        btn.appendChild(iconEl);
      }
      
      btn.appendChild(createEl('span', { textContent: item.label }));
      
      if (item.shortcut) {
        btn.appendChild(createEl('span', { className: 'ctx-shortcut', textContent: item.shortcut }));
      }
      
      fragment.appendChild(btn);
    }

    menu.appendChild(fragment);
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    ContextMenu.current = menu;
    menu.__onDismiss = typeof onDismiss === 'function' ? onDismiss : null;
    menu.style.visibility = '';

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.ctx-item');
      if (btn) {
        ContextMenu.hide(menu, Number.isInteger(btn._selectionIndex) ? btn._selectionIndex : null);
        if (btn._action) btn._action();
      }
    });

    // Optimized dismiss handler using capture phase to avoid setTimeout lag
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        ContextMenu.hide();
      }
    };
    
    ContextMenu._activeDismiss = dismiss;
    document.addEventListener('pointerdown', dismiss, { capture: true, passive: true });
    return menu;
  },

  hide(expectedMenu = null, selection = null) {
    const current = ContextMenu.current;
    if (expectedMenu && current !== expectedMenu) return;
    if (current) {
      current.remove();
      ContextMenu.current = null;
    }
    if (ContextMenu._activeDismiss) {
      document.removeEventListener('pointerdown', ContextMenu._activeDismiss, { capture: true });
      ContextMenu._activeDismiss = null;
    }
    if (current?.__onDismiss) {
      const onDismiss = current.__onDismiss;
      current.__onDismiss = null;
      onDismiss(selection);
    }
  }
};

window.ContextMenu = ContextMenu;