const ContextMenu = {
  current: null,
  _activeDismiss: null, // Track the current event handler for absolute safety

  show(x, y, items) {
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
        className: 'ctx-item' + (item.danger ? ' danger' : ''),
        role: 'menuitem',
        'aria-label': item.label
      });
      
      // Store reference to the specific action directly on the DOM element for event delegation
      if (item.action) btn._action = item.action;

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

    // Single delegated handler to manage all menu actions instantly
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.ctx-item');
      if (btn) {
        ContextMenu.hide();
        if (btn._action) btn._action();
      }
    });

    // Append to DOM and compute placement boundaries
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    ContextMenu.current = menu;

    // Optimized dismiss handler using capture phase to avoid setTimeout lag
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        ContextMenu.hide();
      }
    };
    
    ContextMenu._activeDismiss = dismiss;
    document.addEventListener('pointerdown', dismiss, { capture: true, passive: true });
  },

  hide() {
    if (ContextMenu.current) {
      ContextMenu.current.remove();
      ContextMenu.current = null;
    }
    if (ContextMenu._activeDismiss) {
      document.removeEventListener('pointerdown', ContextMenu._activeDismiss, { capture: true });
      ContextMenu._activeDismiss = null;
    }
  }
};

window.ContextMenu = ContextMenu;