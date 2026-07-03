registerApp({
  id: 'nbosp-contacts', name: 'Contacts', icon: 'users',
  description: 'Contact Book',
  defaultSize: [640, 500], minSize: [440, 320],

  init(content, state) {
    // ── NovaByte runtime guard ──────────────────────────────────────────────
          if (!window.AppDirs?.getVFSDir('com.nbosp.contacts', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      const warn = createEl('div', { style: 'font-size:32px;' });
      warn.textContent = '⚠️';
      const msg = createEl('div', { style: 'font-size:14px;text-align:center;' });
      const b = createEl('b');
       b.textContent = 'nbosp-contacts';
      msg.append(b, document.createTextNode('\nApp data directory missing.\nThis app requires NovaByte OS.'));
      content.append(warn, msg);
      return;
    }

    // ── Storage helpers ─────────────────────────────────────────────────────
    const SK = 'nova_contacts';

    function isValidContact(c) {
      return c !== null && typeof c === 'object' &&
        typeof c.id === 'string' && c.id.length > 0 &&
        typeof c.name === 'string' &&
        typeof c.email === 'string' &&
        typeof c.phone === 'string' &&
        typeof c.notes === 'string';
    }

    function load() {
      try {
        if (!AppPermissionManager?.isGranted('contacts:read', 'nbosp-contacts')) return [];
        const raw = localStorage.getItem(SK);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        // Validate + sanitise each entry; drop malformed ones
        return arr.filter(isValidContact).map(c => ({
          id:    String(c.id),
          name:  String(c.name),
          email: String(c.email),
          phone: String(c.phone),
          notes: String(c.notes),
        }));
      } catch {
        return [];
      }
    }

    function save(arr) {
      try {
        lsSave(SK, arr);
      } catch (e) {
        // Storage quota or private-mode error — surface silently, data stays in memory
        console.warn('[contacts] save failed:', e);
      }
    }

    function genId() {
      // crypto.randomUUID is baseline-widely-available; collision-free
      return crypto.randomUUID();
    }

    function initials(name) {
      const parts = (name || '?').trim().split(/\s+/);
      return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    // ── State ────────────────────────────────────────────────────────────────
    let contacts  = load();
    let selectedId = null;   // track by id, not reference, so mutations stay clean
    let editMode  = false;
    let searchQ   = '';

    function getSelected() {
      return selectedId ? (contacts.find(c => c.id === selectedId) ?? null) : null;
    }

    // ── DOM scaffolding (built once, never torn down) ────────────────────────
    const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;' });
    content.appendChild(root);

    // Left panel
    const leftPanel = createEl('div', {
      style: 'width:220px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sidebar);',
    });
    const listToolbar = createEl('div', {
      style: 'padding:8px;border-bottom:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:6px;flex-shrink:0;',
    });
    const searchInp = createEl('input', {
      type: 'text', placeholder: 'Search contacts…',
      style: 'width:100%;background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-primary);outline:none;',
    });
    const addBtn = createEl('button', {
      className: 'btn btn-sm btn-primary',
      style: 'display:flex;align-items:center;gap:4px;justify-content:center;',
    });
    // Safe: svgIcon returns trusted runtime SVG; text node for label
    addBtn.appendChild(createEl('span', {}));  // icon slot, set below
    addBtn.querySelector('span').innerHTML = svgIcon('plus', 12);
    addBtn.appendChild(document.createTextNode(' New Contact'));
    listToolbar.append(searchInp, addBtn);

    const contactList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
    leftPanel.append(listToolbar, contactList);

    // Right panel
    const rightPanel = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });
    const detailArea = createEl('div', { style: 'flex:1;overflow-y:auto;padding:20px;' });
    const actionBar  = createEl('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);',
    });
    rightPanel.append(detailArea, actionBar);
    root.append(leftPanel, rightPanel);

    // ── Render helpers ───────────────────────────────────────────────────────

    // Clear a node's children without innerHTML to avoid listener-leak warnings
    function clearChildren(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    // ── List render (event-delegated — no per-row listeners) ─────────────────
    //
    // Hover state is handled with a CSS class set on contactList via delegation
    // rather than per-row mouseenter/mouseleave listeners.
    //
    // We track a single "hovered" data-id so the CSS variable assignment
    // happens in one place.

    function renderList() {
      clearChildren(contactList);

      const q        = searchQ.toLowerCase();
      const filtered = contacts
        .filter(c => !q ||
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (!filtered.length) {
        const empty = createEl('div', { style: 'padding:20px;text-align:center;color:var(--text-muted);font-size:12px;' });
        empty.textContent = searchQ ? 'No matches' : 'No contacts yet';
        contactList.appendChild(empty);
        return;
      }

      // Build all rows into a fragment — one DOM write
      const frag = document.createDocumentFragment();
      for (const c of filtered) {
        const isActive = c.id === selectedId;
        const row = createEl('div', {
          style: 'display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer;transition:background 0.1s;border-bottom:1px solid var(--border-subtle);' +
                 (isActive ? 'background:var(--accent-muted);' : ''),
          'data-id': c.id,
        });

        const avatar = createEl('div', {
          style: 'width:32px;height:32px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;',
        });
        avatar.textContent = initials(c.name);

        const info   = createEl('div', { style: 'min-width:0;' });
        const nameEl = createEl('div', {
          style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        });
        nameEl.textContent = c.name || '(no name)';
        const subEl = createEl('div', {
          style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        });
        subEl.textContent = c.email || c.phone || '';
        info.append(nameEl, subEl);
        row.append(avatar, info);
        frag.appendChild(row);
      }
      contactList.appendChild(frag);
    }

    // Delegated pointer/click handlers on contactList (attached once below)
    function onListPointerOver(e) {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      if (row.dataset.id !== selectedId) row.style.background = 'var(--bg-hover)';
    }
    function onListPointerOut(e) {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      if (row.dataset.id !== selectedId) row.style.background = '';
    }
    function onListClick(e) {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      selectContact(row.dataset.id);
    }
    contactList.addEventListener('pointerover',  onListPointerOver);
    contactList.addEventListener('pointerout',   onListPointerOut);
    contactList.addEventListener('click',        onListClick);

    // ── Detail / edit render ─────────────────────────────────────────────────
    //
    // actionBar buttons are also built fresh each render but the total number
    // is tiny (2–3). No delegation needed there; clearing them is cheap.
    // The key fix is that detailArea/actionBar innerHTML = '' is replaced
    // with clearChildren() so any future sub-node cleanup hooks can fire.

    function renderDetail() {
      clearChildren(detailArea);
      clearChildren(actionBar);

      const selected = getSelected();

      if (!selected) {
        const empty = createEl('div', {
          style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;',
        });
        const ico = createEl('span', {});
        ico.innerHTML = svgIcon('users', 36);   // trusted runtime value
        const lbl = createEl('div', { style: 'font-size:13px;margin-top:10px;' });
        lbl.textContent = 'Select a contact';
        empty.append(ico, lbl);
        detailArea.appendChild(empty);
        return;
      }

      if (editMode) {
        // ── Edit form ──────────────────────────────────────────────────────
        const form = createEl('div', { style: 'display:flex;flex-direction:column;gap:12px;max-width:360px;' });

        // Unique prefix per instance avoids duplicate id collisions when the
        // app is opened multiple times simultaneously.
        const uid = selected.id;

        function buildField(labelText, key, inputType) {
          const inputId = `nbosp-contacts-${uid}-${key}`;
          const wrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
          const lbl  = createEl('label', {
            htmlFor: inputId,
            style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;',
          });
          lbl.textContent = labelText;
          const inp  = createEl('input', {
            id: inputId, type: inputType || 'text',
            style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;',
          });
          inp.value = selected[key] || '';
          inp.addEventListener('focus', () => { inp.style.borderColor = 'var(--accent)'; });
          inp.addEventListener('blur',  () => { inp.style.borderColor = 'var(--border-default)'; });
          wrap.append(lbl, inp);
          form.appendChild(wrap);
          return inp;
        }

        const nameInp  = buildField('Name',  'name');
        const emailInp = buildField('Email', 'email', 'email');
        const phoneInp = buildField('Phone', 'phone', 'tel');

        // Notes textarea
        const notesId   = `nbosp-contacts-${uid}-notes`;
        const notesWrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
        const notesLbl  = createEl('label', {
          htmlFor: notesId,
          style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;',
        });
        notesLbl.textContent = 'Notes';
        const notesInp = createEl('textarea', {
          id: notesId,
          style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;min-height:80px;resize:vertical;',
        });
        notesInp.value = selected.notes || '';
        notesInp.addEventListener('focus', () => { notesInp.style.borderColor = 'var(--accent)'; });
        notesInp.addEventListener('blur',  () => { notesInp.style.borderColor = 'var(--border-default)'; });
        notesWrap.append(notesLbl, notesInp);
        form.appendChild(notesWrap);
        detailArea.appendChild(form);

        // Snapshot of the original values for cancel — prevents mutating state
        // before the user commits, which was the original cancel-edit bug.
        const snapshot = { name: selected.name, email: selected.email, phone: selected.phone, notes: selected.notes };

        const saveBtn   = createEl('button', { className: 'btn btn-primary btn-sm' });
        saveBtn.textContent = 'Save';
        const cancelBtn = createEl('button', { className: 'btn btn-sm' });
        cancelBtn.textContent = 'Cancel';
        actionBar.append(saveBtn, cancelBtn);

        saveBtn.addEventListener('click', () => {
          if (!AppPermissionManager?.isGranted('contacts:write', 'nbosp-contacts')) {
            Notify.show({ title: 'Permission denied', body: 'Contacts needs contacts:write to save.', type: 'error', appName: 'Contacts' });
            return;
          }
          selected.name  = nameInp.value.trim()  || '(no name)';
          selected.email = emailInp.value.trim();
          selected.phone = phoneInp.value.trim();
          selected.notes = notesInp.value.trim();
          save(contacts);
          editMode = false;
          renderList();
          renderDetail();
        });

        cancelBtn.addEventListener('click', () => {
          // New unsaved contact (snapshot name is empty string) → discard entirely
          if (!snapshot.name) {
            contacts = contacts.filter(c => c.id !== selectedId);
            selectedId = null;
          } else {
            // Restore original values — do not mutate selected before save
            selected.name  = snapshot.name;
            selected.email = snapshot.email;
            selected.phone = snapshot.phone;
            selected.notes = snapshot.notes;
          }
          editMode = false;
          renderList();
          renderDetail();
        });

      } else {
        // ── View mode ────────────────────────────────────────────────────────
        const avatar = createEl('div', {
          style: 'width:56px;height:56px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;margin-bottom:14px;flex-shrink:0;',
        });
        avatar.textContent = initials(selected.name);

        const nameEl = createEl('div', { style: 'font-size:17px;font-weight:700;margin-bottom:16px;' });
        nameEl.textContent = selected.name || '(no name)';
        detailArea.append(avatar, nameEl);

        function buildInfoRow(iconName, labelText, value, clickFn, iconSrc) {
          if (!value) return;
          const row = createEl('div', {
            style: 'display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);cursor:' + (clickFn ? 'pointer' : 'default') + ';',
          });
          if (clickFn) {
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
            row.addEventListener('click', clickFn);
          }
          const ico = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;margin-top:1px;' });
          if (iconSrc) {
            ico.innerHTML = '<img src="' + iconSrc + '" width="15" height="15" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" onerror="this.style.visibility=\'hidden\';">';
          } else {
            ico.innerHTML = svgIcon(iconName, 15);
          }
          const wrap = createEl('div', { style: 'min-width:0;' });
          const lbl  = createEl('div', { style: 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;' });
          lbl.textContent = labelText;
          const val  = createEl('div', { style: 'font-size:13px;color:' + (clickFn ? 'var(--text-link)' : 'var(--text-primary)') + ';word-break:break-all;' });
          val.textContent = value;
          wrap.append(lbl, val);
          row.append(ico, wrap);
          detailArea.appendChild(row);
        }

        buildInfoRow('mail', 'Email', selected.email, selected.email ? () => {
          navigator.clipboard.writeText(selected.email).then(() => Notify.show({ title: 'Copied', body: selected.email, type: 'info', appName: 'Contacts' }));
        } : null);
        buildInfoRow('phone', 'Phone', selected.phone, selected.phone ? () => {
          navigator.clipboard.writeText(selected.phone).then(() => Notify.show({ title: 'Copied', body: selected.phone, type: 'info', appName: 'Contacts' }));
        } : null, '/assets/icons8-call-94.png');
        buildInfoRow('file',  'Notes', selected.notes, null);

        const editBtn = createEl('button', { className: 'btn btn-sm btn-primary' });
        editBtn.textContent = 'Edit';
        const delBtn = createEl('button', { className: 'btn btn-sm btn-danger' });
        delBtn.textContent = 'Delete';
        actionBar.append(editBtn, delBtn, createEl('span', { style: 'flex:1;' }));

        editBtn.addEventListener('click', () => { editMode = true; renderDetail(); });
        delBtn.addEventListener('click',  () => {
          if (!AppPermissionManager?.isGranted('contacts:delete', 'nbosp-contacts')) {
            Notify.show({ title: 'Permission denied', body: 'Contacts needs contacts:delete to remove.', type: 'error', appName: 'Contacts' });
            return;
          }
          contacts   = contacts.filter(c => c.id !== selectedId);
          selectedId = null;
          save(contacts);
          renderList();
          renderDetail();
        });
      }
    }

    // ── Contact selection ────────────────────────────────────────────────────
    function selectContact(id) {
      selectedId = id;
      editMode   = false;
      renderList();
      renderDetail();
    }

    // ── Add new contact ──────────────────────────────────────────────────────
    addBtn.addEventListener('click', () => {
      const c = { id: genId(), name: '', email: '', phone: '', notes: '' };
      contacts.push(c);
      selectedId = c.id;
      editMode   = true;
      renderList();
      renderDetail();
    });

    // ── Search ───────────────────────────────────────────────────────────────
    searchInp.addEventListener('input', () => {
      searchQ = searchInp.value;
      renderList();
    });

    // ── Initial render ───────────────────────────────────────────────────────
    renderList();
    renderDetail();
  },
});