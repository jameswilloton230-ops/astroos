// Optimized Modal service using high-efficiency delegated handling to limit active closures
const ModalService = {
  /**
   * Central core utility to generate and display fully flexible, optimized modals or prompts
   */
  show(title, body, actions, inputType, defaultInputValue = '', options = {}) {
    return new Promise((resolve) => {
      // System dialogs are a host-level surface. Keep the modal portal outside
      // any app window/webview stacking context so Settings confirmations can
      // never become visually trapped inside the Settings content surface.
      let modalRoot = document.getElementById('system-modal-root');
      if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'system-modal-root';
        Object.assign(modalRoot.style, {
          position: 'fixed',
          inset: '0',
          width: '100vw',
          height: '100vh',
          zIndex: '2147483000',
          pointerEvents: 'none',
          isolation: 'isolate',
        });
        document.body.appendChild(modalRoot);
      }

      const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
      overlay.style.pointerEvents = 'auto';
      const dialog = createEl('div', { className: 'modal-dialog' });
      if (options && options.variant) {
        dialog.dataset.modalVariant = String(options.variant);
        if (options.variant === 'developer-warning') {
          Object.assign(dialog.style, {
            background: 'var(--bg-elevated,#1b1f23)',
            border: '1px solid var(--text-danger,#f85149)',
            borderRadius: '12px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(248,81,73,0.25)',
            padding: '28px',
            maxWidth: '520px',
            width: '92%',
          });
        }
      }

      if (title) {
        dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));
      }

      // Append textual information or an existing detached DOM branch
      let bodyDiv = null;
      if (typeof body === 'string') {
        bodyDiv = createEl('div', { className: 'modal-body', textContent: body });
        dialog.appendChild(bodyDiv);
      } else if (body instanceof HTMLElement) {
        bodyDiv = createEl('div', { className: 'modal-body' });
        if (options?.variant === 'developer-warning') bodyDiv.style.padding = '0 0 18px 0';
        bodyDiv.appendChild(body);
        dialog.appendChild(bodyDiv);
      }

      // Optional selection value owned by a custom body (used by native
      // Settings pickers such as Default Apps). Body rows can carry
      // [data-modal-value] and the modal's primary action submits the current
      // selection without requiring the guest app to render its own overlay.
      let bodySelection;
      if (bodyDiv) {
        const selected = bodyDiv.querySelector('[data-modal-selected="true"]');
        if (selected) bodySelection = selected.getAttribute('data-modal-value');
        bodyDiv.addEventListener('click', (e) => {
          const option = e.target.closest?.('[data-modal-value]');
          if (!option || !bodyDiv.contains(option)) return;
          bodySelection = option.getAttribute('data-modal-value');
          for (const el of bodyDiv.querySelectorAll('[data-modal-value]')) {
            const on = el === option;
            el.setAttribute('data-modal-selected', on ? 'true' : 'false');
            el.setAttribute('aria-checked', on ? 'true' : 'false');
            if (el.dataset.modalSelectedStyle === 'radio') {
              el.style.borderColor = on ? 'var(--accent)' : 'transparent';
              el.style.background = on ? 'var(--accent-muted)' : 'transparent';
              const dot = el.querySelector('[data-modal-radio-dot]');
              if (dot) {
                dot.style.opacity = on ? '1' : '0';
                if (dot.parentElement) dot.parentElement.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
              }
            }
          }
        });
      }

      // Combined dynamic Input Layer (Supports standard field inputs as well as prompt mode)
      let modalInput = null;
      if (inputType || defaultInputValue) {
        const inputWrap = createEl('div', { className: 'modal-body', style: 'padding-top: 0;' });
        modalInput = createEl('input', {
          id: 'modal-input-field',
          name: 'modal-input',
          className: 'input',
          type: inputType || 'text',
          value: defaultInputValue,
          style: 'width: 100%; margin-top: 4px;',
          'aria-label': title || 'Input'
        });
        inputWrap.appendChild(modalInput);
        dialog.appendChild(inputWrap);
      }

      // Render the actions layout block
      const actionsDiv = createEl('div', { className: 'modal-actions' });
      const buttonArray = actions || [{ label: 'OK', primary: true, value: true }];
      const btnLen = buttonArray.length;

      for (let i = 0; i < btnLen; i++) {
        const act = buttonArray[i];
        const btn = createEl('button', {
          className: 'btn' + (act.primary ? ' btn-primary' : '') + (act.danger ? ' btn-danger' : ''),
          textContent: act.label
        });
        
        // Pass resolution values down straight to the DOM node context
        btn._actionValue = act.value;
        btn._actionLabel = act.label;
        btn._hasExplicitValue = act.value !== undefined;
        
        actionsDiv.appendChild(btn);
      }
      dialog.appendChild(actionsDiv);
      overlay.appendChild(dialog);

      // Central Clean Closure Resolution
      const terminateModal = (outputValue) => {
        overlay.remove();
        resolve(outputValue);
      };

      // Event Delegation: Intercept clicks on the overlay to reduce functional allocations
      overlay.addEventListener('click', (e) => {
        const target = e.target;
        
        // Fired when selecting the transparent background area outside the modal bounds
        if (target === overlay) {
          return terminateModal(null);
        }

        // Fired when clicking an option button inside the modal dialog box
        const btn = target.closest('button');
        if (btn && actionsDiv.contains(btn)) {
          if (modalInput) {
            return terminateModal(btn._hasExplicitValue ? modalInput.value : null);
          }
          const actionValue = btn._hasExplicitValue ? btn._actionValue : btn._actionLabel;
          if (actionValue === '__MODAL_SUBMIT_SELECTION__') {
            return terminateModal(bodySelection ?? null);
          }
          if (actionValue === '__MODAL_SUBMIT_CUSTOM__') {
            let value = null;
            try { value = typeof options?.collect === 'function' ? options.collect(bodyDiv) : null; }
            catch { value = null; }
            return terminateModal(value);
          }
          return terminateModal(actionValue);
        }
      });

      // Efficient capture of key presses on the input fields
      if (modalInput) {
        modalInput.addEventListener('keydown', (e) => {
          const key = e.key;
          if (key === 'Enter') {
            e.preventDefault();
            terminateModal(modalInput.value);
          } else if (key === 'Escape') {
            e.preventDefault();
            terminateModal(null);
          }
        });
      }

      // Portal the overlay into the host-level modal root in one paint.
      modalRoot.appendChild(overlay);

      // Manage view element focus thresholds safely
      if (modalInput) {
        modalInput.focus();
        if (defaultInputValue) modalInput.select();
      } else {
        dialog.querySelector('button')?.focus();
      }
    });
  }
};

// Global backward compatibility layer mapping directly to our optimized architecture
function showModal(title, body, actions, inputType) {
  return ModalService.show(title, body, actions, inputType);
}

function showPrompt(title, defaultValue) {
  return ModalService.show(
    title, 
    null, 
    [
      { label: 'Cancel' }, 
      { label: 'OK', primary: true, value: true }
    ], 
    'text', 
    defaultValue
  );
}

// Bind cleanly across global namespaces
window.showModal = showModal;
// Fixed to expose globally so external features can invoke it correctly
window.showPrompt = showPrompt;