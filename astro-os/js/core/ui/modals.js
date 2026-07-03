// Optimized Modal service using high-efficiency delegated handling to limit active closures
const ModalService = {
  /**
   * Central core utility to generate and display fully flexible, optimized modals or prompts
   */
  show(title, body, actions, inputType, defaultInputValue = '') {
    return new Promise((resolve) => {
      const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
      const dialog = createEl('div', { className: 'modal-dialog' });

      if (title) {
        dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));
      }

      // Append textual information or an existing detached DOM branch
      if (typeof body === 'string') {
        dialog.appendChild(createEl('div', { className: 'modal-body', textContent: body }));
      } else if (body instanceof HTMLElement) {
        const bodyDiv = createEl('div', { className: 'modal-body' });
        bodyDiv.appendChild(body);
        dialog.appendChild(bodyDiv);
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
          return terminateModal(btn._hasExplicitValue ? btn._actionValue : btn._actionLabel);
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

      // Inject to body framework in a single paint call
      document.body.appendChild(overlay);

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