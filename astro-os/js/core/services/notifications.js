
const Notify = {
        _storageKey: 'novaOS_notifications',
        _loaded: false,

        loadPersisted() {
          if (Notify._loaded) return;
          Notify._loaded = true;
          try {
            const saved = JSON.parse(localStorage.getItem(Notify._storageKey) || '[]');
            if (Array.isArray(saved)) {
              OS.notifications = saved.slice(0, 100);
              OS.notifUnread = OS.notifications.filter(n => !n.read).length;
            }
          } catch (e) {
            OS.notifications = [];
            OS.notifUnread = 0;
          }
        },

        persist() {
          try { localStorage.setItem(Notify._storageKey, JSON.stringify(OS.notifications.slice(0, 100))); } catch (e) { }
        },

        markAllRead() {
          let changed = false;
          OS.notifications = OS.notifications.map(n => {
            if (n && !n.read) {
              changed = true;
              return { ...n, read: true };
            }
            return n;
          });
          OS.notifUnread = 0;
          if (changed) Notify.persist();
          Notify.updateBadge();
          updateNotificationBadge();
          Notify.renderPanel();
        },

        show(opts) {
          Notify.loadPersisted();
          const { title, body, type, appName, category, icon, action, actionLabel } = opts;
          const notif = {
            id: generateId(),
            title: title || '',
            body: body || '',
            type: type || 'info',
            appName: appName || 'System',
            category: category || 'system',
            icon: icon || 'bell',
            timestamp: Date.now(),
            read: false,
            action: action || null,
            actionLabel: actionLabel || null
          };
          OS.notifications.unshift(notif);
          if (OS.notifications.length > 100) OS.notifications.pop();
          OS.notifUnread++;
          Notify.updateBadge();
          updateNotificationBadge();
          Notify.renderPanel();
          // FIX 15 — persist to localStorage
          Notify.persist();

          if (!OS.dnd) Notify.showToast(notif);
        },

        showToast(notif) {
          const container = document.getElementById('toast-container');
          const toast = createEl('div', { className: `toast ${notif.type}`, role: 'alert' });

          const content = createEl('div', { className: 'toast-content' });
          const titleEl = createEl('div', { className: 'toast-title', textContent: notif.title });
          const bodyEl = createEl('div', { className: 'toast-body', textContent: notif.body });
          content.appendChild(titleEl);
          content.appendChild(bodyEl);

          // Add action button if action is provided
          if (notif.action && notif.actionLabel) {
            const actionBtn = createEl('button', { className: 'toast-action' });
            actionBtn.textContent = notif.actionLabel;
            actionBtn.style.cssText = 'margin-left:auto;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';
            actionBtn.onmouseenter = () => { actionBtn.style.background = 'rgba(88,166,255,0.35)'; };
            actionBtn.onmouseleave = () => { actionBtn.style.background = 'rgba(88,166,255,0.2)'; };
            actionBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              clearTimeout(timer);
              try {
                removeToast();
                if (typeof notif.action === 'function') {
                  notif.action();
                } else if (typeof notif.action === 'string') {
                  // Handle built-in actions
                  switch (notif.action) {
                    case 'settings':
                    case 'open-settings':
                    case 'openSettings':
                      renderSettings();
                      break;
                    default:
                      console.warn('[Notify] Unknown built-in action:', notif.action);
                  }
                }
              } catch (err) {
                console.error('[Notify] Action error:', err);
                alert('Error: ' + err.message);
              }
            });
            content.appendChild(actionBtn);
          }

          const closeBtn = createEl('button', { className: 'toast-close', 'aria-label': 'Dismiss notification' });
          closeBtn.innerHTML = svgIcon('x', 14);

          toast.appendChild(content);
          toast.appendChild(closeBtn);
          container.appendChild(toast);

          let timer = setTimeout(() => removeToast(), notif.action ? 8000 : 4000);

          toast.addEventListener('pointerenter', () => clearTimeout(timer));
          toast.addEventListener('pointerleave', () => { timer = setTimeout(() => removeToast(), notif.action ? 4000 : 2000); });

          closeBtn.addEventListener('click', () => { clearTimeout(timer); removeToast(); });

          function removeToast() {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
          }
        },

        updateBadge() {
          const badge = document.getElementById('notif-badge');
          if (OS.notifUnread > 0) {
            badge.textContent = OS.notifUnread > 99 ? '99+' : OS.notifUnread;
            badge.classList.remove('hidden');
          } else {
            badge.classList.add('hidden');
          }
        },

        renderPanel() {
          Notify.loadPersisted();
          const list = document.getElementById('notif-list');
          list.innerHTML = '';
          if (OS.notifications.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="text-muted">No notifications</div></div>';
            return;
          }
          for (const n of OS.notifications.slice(0, 50)) {
            const item = createEl('div', { className: 'notif-item' });
            const icon = createEl('div', { style: { width: '24px', height: '24px', color: 'var(--text-secondary)', flexShrink: '0' } });
            icon.innerHTML = svgIcon('bell', 16);
            const content = createEl('div', { className: 'notif-item-content' });
            content.appendChild(createEl('div', { className: 'notif-item-title', textContent: n.title }));
            content.appendChild(createEl('div', { className: 'notif-item-body', textContent: n.body }));
            const ago = Date.now() - n.timestamp;
            const mins = Math.floor(ago / 60000);
            const timeStr = mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
            content.appendChild(createEl('div', { className: 'notif-item-time', textContent: timeStr }));
            item.appendChild(icon);
            item.appendChild(content);
            list.appendChild(item);
          }
        },

        togglePanel() {
          Notify.loadPersisted();
          const panel = document.getElementById('notification-panel');
          if (!panel) return;
          const opening = !panel.classList.contains('active');
          panel.classList.toggle('active');
          if (typeof window.resetShellScroll === 'function') {
            window.resetShellScroll();
            requestAnimationFrame(window.resetShellScroll);
          }
          if (opening) {
            if (OS.notifications.length) {
              OS.notifications = OS.notifications.map(n => n && !n.read ? { ...n, read: true } : n);
              OS.notifUnread = 0;
              Notify.persist();
            }
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        }
      };

// ── EXPOSE TO GLOBAL RUNTIME SCOPE ───────────────────────────────────────────
if (typeof Notify !== 'undefined') {
  window.Notify = Notify;
} else {
  console.warn('Notify object was not found in the local scope of app-notifications.js');
}
