registerApp({
        id: 'nook', name: 'AstroByte Settings', icon: 'settings',
        description: 'System Settings',
        defaultSize: [700, 500], minSize: [500, 400],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'nook-container' });

          const ASTRO_OS_VERSION = '1.0.0';

          const sidebar = createEl('div', { className: 'nook-sidebar', role: 'navigation' });
          const mainContent = createEl('div', { className: 'nook-content' });

          const sections = [
            { id: 'appearance', name: 'Appearance', icon: 'palette' },
            { id: 'accessibility', name: 'Accessibility', icon: 'accessibility' },
            { id: 'desktop', name: 'Desktop', icon: 'desktop_windows' },
            { id: 'system', name: 'System', icon: 'tune' },
            { id: 'storage', name: 'Storage', icon: 'storage' },
            { id: 'privacy', name: 'Privacy', icon: 'security' },
            { id: 'apps', name: 'Apps', icon: 'package' },
            { id: 'about', name: 'About', icon: 'info' }
          ];

          const validIds = new Set(sections.map(s => s.id));
          let currentSection = (options && validIds.has(options.section)) ? options.section : 'appearance';

          function renderSidebar() {
            sidebar.innerHTML = '';
            sections.forEach(s => {
              const btn = createEl('button', {
                className: 'nook-section-btn' + (currentSection === s.id ? ' active' : ''),
                'aria-label': s.name
              });
              const iconWrap = createEl('span', { className: 'nook-nav-icon' });
              iconWrap.innerHTML = '<span class="material-symbols-rounded nook-icon">' + s.icon + '</span>';
              btn.appendChild(iconWrap);
              btn.appendChild(createEl('span', { textContent: s.name }));
              btn.addEventListener('click', () => {
                currentSection = s.id;
                renderSidebar();
                renderContent();
              });
              sidebar.appendChild(btn);
            });
          }

          function renderContent() {
            const tabId = currentSection;

            // Always clear before rendering - this prevents any duplicates
            mainContent.innerHTML = '';
            mainContent.dataset.currentTab = tabId;

            switch (currentSection) {
              case 'appearance':
                renderAppearance();
                break;
              case 'accessibility':
                renderAccessibility();
                break;
              case 'system':
                renderSystem();
                break;
              case 'storage':
                renderStorage();
                break;
              case 'shortcuts':
                renderShortcuts();
                break;
              case 'privacy':
                renderPrivacy();
                break;
              case 'apps':
                renderApps();
                break;
              case 'desktop':
                renderDesktop();
                break;
              case 'about':
                renderAbout();
                break;
              default:
                mainContent.appendChild(createEl('div', { className: 'empty-state', textContent: 'Section coming soon' }));
            }
          }

          function renderAppearance() {
            mainContent.appendChild(createEl('h2', { textContent: 'Appearance' }));

            const _wallpaperLocked = OS.settings.get('prohibitWallpaperChange');

            // Theme switcher removed — LineageOS Material Dark is the only theme

            // Accent color — locked if wallpaper/personalization policy active
            const accentGroup = createEl('div', { className: 'nook-group' });
            accentGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Accent Color' }));

            if (_wallpaperLocked) {
              accentGroup.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-warning,#d29922);padding:4px 0;', textContent: '🔒 Accent colour changes are restricted by policy.' }));
            }

            const colors = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#ff7b72', '#79c0ff', '#56d4dd'];
            const colorRow = createEl('div', { className: 'nook-row' });
            colors.forEach(c => {
              const btn = createEl('button', {
                className: 'btn btn-sm',
                style: { width: '32px', height: '32px', background: c, border: OS.settings.get('accentColor') === c ? '2px solid white' : 'none', borderRadius: '50%', padding: '0', opacity: _wallpaperLocked ? '0.4' : '1', cursor: _wallpaperLocked ? 'not-allowed' : 'pointer' },
                'aria-label': 'Color ' + c,
                disabled: !!_wallpaperLocked
              });
              if (!_wallpaperLocked) {
                btn.addEventListener('click', () => {
                  OS.settings.set('accentColor', c);
                  document.documentElement.style.setProperty('--accent', c);
                  document.documentElement.style.setProperty('--accent-hover', c + 'dd');
                  document.documentElement.style.setProperty('--accent-muted', c + '22');
                  renderContent();
                });
              }
              colorRow.appendChild(btn);
            });
            accentGroup.appendChild(colorRow);
            mainContent.appendChild(accentGroup);

            // Clock format
            const clockGroup = createEl('div', { className: 'nook-group' });
            clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clock' }));

            const clockRow = createEl('div', { className: 'nook-row' });
            clockRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Time Format' }));
            const clockToggle = createEl('button', {
              className: 'toggle' + (OS.settings.get('clockFormat') === '24h' ? ' active' : ''),
              'aria-label': 'Toggle 24-hour time'
            });
            clockToggle.addEventListener('click', () => {
              const is24 = OS.settings.get('clockFormat') === '24h';
              OS.settings.set('clockFormat', is24 ? '12h' : '24h');
              clockToggle.classList.toggle('active', !is24);
              // FIX 10 — force clock to update immediately without waiting for next interval tick
              const _timeEl = document.getElementById('tray-time');
              if (_timeEl) {
                const _now = new Date();
                const _h = _now.getHours(), _m = _now.getMinutes();
                if (!is24) { // new format is 24h
                  _timeEl.textContent = String(_h).padStart(2, '0') + ':' + String(_m).padStart(2, '0');
                } else { // new format is 12h
                  const _h12 = _h % 12 || 12;
                  _timeEl.textContent = _h12 + ':' + String(_m).padStart(2, '0') + ' ' + (_h < 12 ? 'AM' : 'PM');
                }
              }
            });
            clockRow.appendChild(clockToggle);
            clockGroup.appendChild(clockRow);
            mainContent.appendChild(clockGroup);
          }

          function renderSystem() {
            mainContent.appendChild(createEl('h2', { textContent: 'System' }));

            const userGroup = createEl('div', { className: 'nook-group' });
            userGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'User' }));

            const userRow = createEl('div', { className: 'nook-row' });
            userRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Username' }));
            const userInput = createEl('input', { className: 'input', style: { width: '150px' }, value: OS.username });
            userInput.addEventListener('change', () => {
              OS.username = userInput.value || 'user';
              OS.settings.set('username', OS.username);
            });
            userRow.appendChild(userInput);
            userGroup.appendChild(userRow);
            mainContent.appendChild(userGroup);

            // Lock screen
            const lockGroup = createEl('div', { className: 'nook-group' });
            lockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Lock Screen' }));

            const pinRow = createEl('div', { className: 'nook-row' });
            pinRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'PIN Lock' }));
            const pinBtn = createEl('button', { className: 'btn btn-sm', textContent: OS.lockPin ? 'Change PIN' : 'Set PIN' });
            pinBtn.addEventListener('click', async () => {
              if (OS.lockPin) {
                // Change PIN - ask for current PIN first
                const currentPin = await showModal('Change PIN', 'Enter current PIN:', [
                  { label: 'Cancel' },
                  { label: 'Next', value: 'next' }
                ], 'password');
                if (!currentPin) return;

                const hash = await OS.workers.crypto.call('pbkdf2', currentPin, getPinSalt());
                if (hash !== OS.lockPin) {
                  showModal('Incorrect PIN', 'The current PIN you entered is incorrect.');
                  return;
                }
              }

              // Ask for new PIN twice
              const pin1 = await showModal(OS.lockPin ? 'New PIN' : 'Set PIN', 'Enter a 4-digit PIN:', [
                { label: 'Cancel' },
                { label: 'Next', value: 'next' }
              ], 'password');
              if (!pin1 || pin1.length !== 4 || !/^\d{4}$/.test(pin1)) {
                if (pin1) showModal('Invalid PIN', 'PIN must be exactly 4 digits.');
                return;
              }


              const pin2 = await showModal('Confirm PIN', 'Re-enter your PIN:', [
                { label: 'Cancel' },
                { label: 'Set PIN', value: 'confirm' }
              ], 'password');

              if (pin1 !== pin2) {
                showModal('PIN Mismatch', 'The PINs do not match. Please try again.');
                return;
              }

              const _wasSet = !!OS.lockPin;
              const newHash = await OS.workers.crypto.call('pbkdf2', pin1, getPinSalt());
              OS.lockPin = newHash;
              OS.settings.set('lockPin', newHash);
              Notify.show({ title: _wasSet ? 'PIN Updated' : 'PIN Set', body: _wasSet ? 'Lock screen PIN has been updated' : 'Lock screen PIN has been set', type: 'success', appName: 'Settings' });
              renderContent();
            });
            pinRow.appendChild(pinBtn);

            if (OS.lockPin) {
              const removePinBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Remove', style: { marginLeft: '8px' } });
              removePinBtn.addEventListener('click', async () => {
                const confirmed = await showModal('Remove PIN', 'Are you sure you want to remove PIN lock?', [
                  { label: 'Cancel' },
                  { label: 'Remove PIN', danger: true, value: 'confirm' }
                ]);
                if (confirmed === 'confirm') {
                  OS.settings.set('lockPin', null);
                  OS.lockPin = null;
                  Notify.show({ title: 'PIN Removed', body: 'PIN lock has been disabled', type: 'success', appName: 'Settings' });
                  renderContent();
                }
              });
              pinRow.appendChild(removePinBtn);
            }

            lockGroup.appendChild(pinRow);
            mainContent.appendChild(lockGroup);

            // Boot to Recovery section
            const recoveryGroup = createEl('div', { className: 'nook-group' });
            recoveryGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Recovery' }));

            const recoveryRow = createEl('div', { className: 'nook-row' });
            recoveryRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Recovery Environment' }));
            const recoveryBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Boot to Recovery', style: { background: '#6c5ce7' } });
            recoveryBtn.addEventListener('click', () => {
              const confirmed = confirm('Boot to Recovery Environment?\n\nThis will restart and show the recovery options screen.');
              if (!confirmed) return;
              // Set manual recovery flag so recovery screen knows this is intentional
              localStorage.setItem('nova_manual_recovery', '1');
              // Set enough boot attempts to trigger recovery (threshold is 2) but mark as intentional
              localStorage.setItem('nova_boot_attempts', JSON.stringify([
                { ts: Date.now() - 1000, reason: 'manual_recovery_intentional', ua: navigator.userAgent.slice(0, 80) },
                { ts: Date.now(), reason: 'manual_recovery_intentional', ua: navigator.userAgent.slice(0, 80) }
              ]));
              localStorage.removeItem('nova_safe_mode');
              location.reload();
            });
            recoveryRow.appendChild(recoveryBtn);
            recoveryGroup.appendChild(recoveryRow);
            mainContent.appendChild(recoveryGroup);
          }

          function renderBrowser() {
            mainContent.appendChild(createEl('h2', { textContent: 'Browser Settings' }));

            const proxyGroup = createEl('div', { className: 'nook-group' });
            proxyGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Proxy Configuration' }));

            const proxyRow = createEl('div', { className: 'nook-row' });
            proxyRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Proxy URL' }));
            const proxyInput = createEl('input', {
              className: 'input',
              style: { width: '300px' },
              value: OS.settings.get('proxyUrl') || '',
              placeholder: 'https://your-worker.workers.dev/?url='
            });
            proxyInput.addEventListener('change', () => OS.settings.set('proxyUrl', proxyInput.value));
            proxyRow.appendChild(proxyInput);
            proxyGroup.appendChild(proxyRow);

            const info = createEl('div', { style: { fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' } });
            info.textContent = 'Configure a CORS proxy for Browser to load external websites. See Help > Proxy Setup in Browser.';
            proxyGroup.appendChild(info);

            mainContent.appendChild(proxyGroup);

            // Search engine
            const searchGroup = createEl('div', { className: 'nook-group' });
            searchGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Search Engine' }));

            const engines = ['duckduckgo', 'google', 'bing', 'brave', 'startpage', 'ecosia'];
            engines.forEach((e, i) => {
              const row = createEl('div', { className: 'nook-row' });
              const engineDisplayNames = { duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing', brave: 'Brave', startpage: 'Startpage', ecosia: 'Ecosia' };
              row.appendChild(createEl('span', { className: 'nook-row-label', textContent: engineDisplayNames[e] || (e.charAt(0).toUpperCase() + e.slice(1)) }));
              const btn = createEl('button', {
                className: 'btn btn-sm' + (OS.settings.get('searchEngine') === e ? ' btn-primary' : ''),
                textContent: OS.settings.get('searchEngine') === e ? 'Active' : 'Select'
              });
              btn.addEventListener('click', () => {
                OS.settings.set('searchEngine', e);
                renderContent();
              });
              row.appendChild(btn);
              searchGroup.appendChild(row);
            });

            mainContent.appendChild(searchGroup);
          }

          async function renderStorage() {
            mainContent.appendChild(createEl('h2', { textContent: 'Storage' }));

            try {
              const est = await navigator.storage.estimate();

              const usageGroup = createEl('div', { className: 'nook-group' });
              usageGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Storage Usage' }));

              const usedRow = createEl('div', { className: 'nook-row' });
              usedRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Used' }));
              usedRow.appendChild(createEl('span', { textContent: formatBytes(est.usage || 0) }));
              usageGroup.appendChild(usedRow);

              const quotaRow = createEl('div', { className: 'nook-row' });
              quotaRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Quota' }));
              quotaRow.appendChild(createEl('span', { textContent: formatBytes(est.quota || 0) }));
              usageGroup.appendChild(quotaRow);

              const bar = createEl('div', { className: 'lens-bar' });
              const fill = createEl('div', { className: 'lens-bar-fill', style: { width: ((est.usage || 0) / (est.quota || 1) * 100) + '%' } });
              bar.appendChild(fill);
              usageGroup.appendChild(bar);

              mainContent.appendChild(usageGroup);
            } catch (e) {
              mainContent.appendChild(createEl('p', { textContent: 'Unable to retrieve storage information.' }));
            }

            // Clear data buttons
            const clearGroup = createEl('div', { className: 'nook-group' });
            clearGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clear Data' }));

            const clearCacheBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear Cache' });
            clearCacheBtn.addEventListener('click', async () => {
              let cleared = [];

              // 1. Cache Storage API (service worker caches)
              if ('caches' in window) {
                try {
                  const cacheNames = await caches.keys();
                  if (cacheNames.length) {
                    await Promise.all(cacheNames.map(n => caches.delete(n)));
                    cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length > 1 ? 's' : ''));
                  }
                } catch (e) { /* not available */ }
              }

              // 2. Temp / cache-like localStorage keys (safe to drop, not user data)
              try {
                const tempKeys = Object.keys(localStorage).filter(k =>
                  k.includes('_cache') || k.includes('_temp') ||
                  k === 'nova_boot_attempts' || k === 'nova_force_recovery'
                );
                if (tempKeys.length) {
                  tempKeys.forEach(k => localStorage.removeItem(k));
                  cleared.push(tempKeys.length + ' temp key' + (tempKeys.length > 1 ? 's' : ''));
                }
              } catch (e) { /* localStorage blocked */ }

              if (cleared.length) {
                Notify.show({ title: 'Cache Cleared', body: 'Removed: ' + cleared.join(', '), type: 'success', appName: 'Settings' });
              } else {
                Notify.show({ title: 'Nothing to Clear', body: 'Cache is already empty', type: 'info', appName: 'Settings' });
              }
            });
            clearGroup.appendChild(clearCacheBtn);

            const wipeBtn = createEl('button', { className: 'btn btn-danger btn-sm', style: { marginLeft: '8px' }, textContent: 'Wipe All Data' });
            wipeBtn.addEventListener('click', async () => {
              const confirm = await showModal('Wipe All Data', 'This will delete all files, settings, and data. This action cannot be undone.', [
                { label: 'Cancel' },
                { label: 'Wipe Everything', danger: true, value: 'wipe' }
              ]);
              if (confirm === 'wipe') {
                Notify.show({ title: 'Wiping Data', body: 'Please wait...', type: 'warning', appName: 'Settings' });
                // Clear synchronous storage first
                localStorage.clear();
                sessionStorage.clear();
                // Delete all IndexedDB databases sequentially, then clear OPFS, then reload
                const dbsToDelete = ['NovaByte_FS', 'novabyte_opfs_fallback'];
                let dbCount = 0;
                const deleteDbs = () => new Promise(resolve => {
                  if (dbCount >= dbsToDelete.length) { resolve(); return; }
                  const req = indexedDB.deleteDatabase(dbsToDelete[dbCount++]);
                  req.onsuccess = req.onerror = req.onblocked = () => deleteDbs().then(resolve);
                });
                const clearOPFS = async () => {
                  try {
                    if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear();
                  } catch { }
                };
                (async () => { await deleteDbs(); await clearOPFS(); location.reload(); })();
              }
            });
            clearGroup.appendChild(wipeBtn);

            mainContent.appendChild(clearGroup);
          }

          function renderShortcuts() {
            mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts' }));

            const shortcuts = [
              { key: 'Win + E', action: 'Open Files' },
              { key: 'Win + T', action: 'Open Terminal' },
              { key: 'Win + Space', action: 'Open Launchpad' },
              { key: 'Win + L', action: 'Lock Screen' },
              { key: 'Win + D', action: 'Show Desktop' },
              { key: 'Alt + Tab', action: 'Switch Apps' },
              { key: 'Alt + F4', action: 'Close Window' },
              { key: 'Ctrl + S', action: 'Save (in apps)' },
              { key: 'Ctrl + C/V/X', action: 'Copy/Paste/Cut' },
              { key: 'F11', action: 'Fullscreen' },
              { key: 'Print Screen', action: 'Screenshot' }
            ];

            shortcuts.forEach(s => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { className: 'nook-row-label', textContent: s.key }));
              row.appendChild(createEl('span', { style: { color: 'var(--text-secondary)', fontSize: '13px' }, textContent: s.action }));
              mainContent.appendChild(row);
            });
          }

          function renderAbout() { /* delegated to override below */ }


          function renderDesktop() {
            mainContent.appendChild(createEl('h2', { textContent: 'Desktop' }));

            // Custom wallpaper
            const wallpaperGroup = createEl('div', { className: 'nook-group' });
            wallpaperGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Wallpaper' }));

            // Preset wallpapers selector
            const PRESET_WALLPAPERS = [
              { id: 'stock-blue', name: 'Lineage Dark', gradient: '#0f0f0f' },
              { id: 'stock-dark', name: 'Obsidian', gradient: 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)' },
              { id: 'stock-light', name: 'Frost', gradient: 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)' },
              { id: 'stock-green', name: 'Evergreen', gradient: 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)' },
              { id: 'stock-purple', name: 'Deep Violet', gradient: 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)' },
              { id: 'stock-red', name: 'Ember Core', gradient: 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)' },
              { id: 'stock-gray', name: 'Steel', gradient: 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)' },
              { id: 'stock-teal', name: 'Abyss', gradient: 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)' }
            ];

            const presetRow = createEl('div', { className: 'nook-row' });
            presetRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Preset Wallpapers' }));

            const presetContainer = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });
            const savedWallpaperId = OS.settings.get('wallpaperId');
            const wallpaperExists = PRESET_WALLPAPERS.some(wp => wp.id === savedWallpaperId);
            const currentWallpaperId = (wallpaperExists ? savedWallpaperId : 'stock-blue');

            PRESET_WALLPAPERS.forEach(wp => {
              const wpCard = createEl('div', {
                style: `width:64px;height:48px;border-radius:12px;cursor:pointer;border:2px solid transparent;background:${wp.gradient};transition:all 0.15s;${currentWallpaperId === wp.id ? 'border-color:var(--accent);box-shadow:0 0 0 2px var(--window-bg), 0 0 8px var(--accent);' : 'opacity:0.7;'}`
              });

              wpCard.title = wp.name;
              wpCard.addEventListener('click', () => {
                const desktop = document.getElementById('desktop');
                if (desktop) {
                  desktop.style.backgroundImage = wp.gradient;
                }
                OS.settings.set('wallpaperId', wp.id);
                OS.settings.set('customWallpaper', null);
                wallpaperInput.value = '';

                // Update all cards
                Array.from(presetContainer.querySelectorAll('div')).forEach((card, idx) => {
                  if (idx === PRESET_WALLPAPERS.indexOf(wp)) {
                    card.style.borderColor = 'var(--accent)';
                    card.style.boxShadow = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
                    card.style.opacity = '1';
                  } else {
                    card.style.borderColor = 'transparent';
                    card.style.boxShadow = 'none';
                    card.style.opacity = '0.7';
                  }
                });

                Notify.show({ title: 'Wallpaper Changed', body: `Applied ${wp.name}`, type: 'success', appName: 'Settings' });
              });

              presetContainer.appendChild(wpCard);
            });

            presetRow.appendChild(presetContainer);
            wallpaperGroup.appendChild(presetRow);

            // Apply current wallpaper on render
            const desktop = document.getElementById('desktop');
            if (desktop) {
              // Clear all existing background
              desktop.style.backgroundImage = '';
              desktop.style.backgroundSize = '';
              desktop.style.backgroundPosition = '';
              desktop.style.backgroundRepeat = '';

              const customWallpaper = OS.settings.get('customWallpaper');
              if (customWallpaper) {
                desktop.style.backgroundImage = 'url(' + customWallpaper + ')';
                desktop.style.backgroundSize = 'cover';
                desktop.style.backgroundPosition = 'center';
                desktop.style.backgroundRepeat = 'no-repeat';
              } else {
                const currentWallpaper = PRESET_WALLPAPERS.find(wp => wp.id === currentWallpaperId);
                if (currentWallpaper) {
                  desktop.style.backgroundImage = currentWallpaper.gradient;
                }
              }
            }

            const wallpaperRow = createEl('div', { className: 'nook-row', style: 'margin-top:16px;' });
            wallpaperRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Custom Image' }));

            const wallpaperInput = createEl('input', {
              type: 'file',
              accept: 'image/*',
              style: { width: '200px' }
            });
            wallpaperInput.addEventListener('change', async () => {
              const file = wallpaperInput.files[0];
              if (file) {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = reader.result;
                  const desktop = document.getElementById('desktop');
                  if (desktop) {
                    desktop.style.backgroundImage = 'url(' + dataUrl + ')';
                    desktop.style.backgroundSize = 'cover';
                    desktop.style.backgroundPosition = 'center';
                    desktop.style.backgroundRepeat = 'no-repeat';
                  }
                  OS.settings.set('customWallpaper', dataUrl);
                  OS.settings.set('wallpaperId', null);
                  Notify.show({ title: 'Wallpaper Changed', body: 'Custom wallpaper applied', type: 'success', appName: 'Settings' });
                };
                reader.readAsDataURL(file);
              }
            });
            wallpaperRow.appendChild(wallpaperInput);

            // Reset button
            const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset to Default', style: { marginLeft: '8px' } });
            resetBtn.addEventListener('click', () => {
              const desktop = document.getElementById('desktop');
              const defaultGradient = PRESET_WALLPAPERS[0].gradient; // stock-blue
              if (desktop) {
                desktop.style.backgroundImage = defaultGradient;
                desktop.style.backgroundSize = '';
                desktop.style.backgroundPosition = '';
                desktop.style.backgroundRepeat = '';
              }
              OS.settings.set('customWallpaper', null);
              OS.settings.set('wallpaperId', 'stock-blue');
              wallpaperInput.value = '';

              // Reset all cards
              Array.from(presetContainer.querySelectorAll('div')).forEach((card, idx) => {
                if (idx === 0) {
                  card.style.borderColor = 'var(--accent)';
                  card.style.boxShadow = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
                  card.style.opacity = '1';
                } else {
                  card.style.borderColor = 'transparent';
                  card.style.boxShadow = 'none';
                  card.style.opacity = '0.7';
                }
              });

              Notify.show({ title: 'Wallpaper Reset', body: 'Default wallpaper restored', type: 'success', appName: 'Settings' });
            });
            wallpaperRow.appendChild(resetBtn);

            wallpaperGroup.appendChild(wallpaperRow);
            mainContent.appendChild(wallpaperGroup);

            // Show taskbar clock toggle
            const clockGroup = createEl('div', { className: 'nook-group' });
            clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Taskbar' }));

            const clockRow = createEl('div', { className: 'nook-toggle-row' });
            clockRow.appendChild(createEl('span', { textContent: 'Show Clock in Taskbar' }));
            const clockToggle = createEl('button', {
              className: 'toggle' + (OS.settings.get('showTaskbarClock') !== false ? ' active' : '')
            });
            clockToggle.addEventListener('click', () => {
              const newVal = OS.settings.get('showTaskbarClock') !== false;
              OS.settings.set('showTaskbarClock', !newVal);
              clockToggle.classList.toggle('active', !newVal);
              const clockEl = document.getElementById('tray-clock'); // FIX 4a — was 'taskbar-clock' (wrong ID)
              if (clockEl) clockEl.style.display = newVal ? 'none' : 'flex'; // FIX 4b — was inverted (!newVal)
            });
            clockRow.appendChild(clockToggle);
            clockGroup.appendChild(clockRow);

            // Taskbar size
            const sizeRow = createEl('div', { className: 'nook-row' });
            sizeRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Size' }));

            const sizes = [
              { value: 'compact', label: 'Compact' },
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' }
            ];
            const currentSize = OS.settings.get('taskbarSize') || 'normal';

            sizes.forEach(sz => {
              const btn = createEl('button', {
                className: 'btn btn-sm' + (currentSize === sz.value ? ' btn-primary' : ''),
                textContent: sz.label,
                style: { marginRight: '8px' }
              });
              btn.addEventListener('click', () => {
                OS.settings.set('taskbarSize', sz.value);
                const heights = { compact: '36px', normal: '48px', large: '64px' };
                document.documentElement.style.setProperty('--taskbar-height', heights[sz.value]);
                renderContent();
              });
              sizeRow.appendChild(btn);
            });
            mainContent.appendChild(clockGroup);
          }

          function renderAccessibility() {
            mainContent.appendChild(createEl('h2', { textContent: 'Accessibility' }));

            // Reduce Motion
            const motionGroup = createEl('div', { className: 'nook-group' });
            motionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Motion' }));

            const motionRow = createEl('div', { className: 'nook-toggle-row' });
            motionRow.appendChild(createEl('span', { textContent: 'Reduce Motion' }));
            const motionToggle = createEl('button', {
              className: 'toggle' + (OS.settings.get('reduceMotion') ? ' active' : '')
            });
            motionToggle.addEventListener('click', () => {
              const isActive = OS.settings.get('reduceMotion');
              OS.settings.set('reduceMotion', !isActive);
              document.documentElement.classList.toggle('reduce-motion', !isActive);
              document.documentElement.style.setProperty('--anim-speed', !isActive ? '0.001' : '1');
              const _wEl = document.getElementById('wallpaper');
              if (_wEl) _wEl.style.animation = !isActive ? 'none' : '';
              motionToggle.classList.toggle('active', !isActive);

              const wallpaper = document.getElementById('wallpaper');
              if (wallpaper) {
                wallpaper.style.animation = 'none';
              }
            });
            motionRow.appendChild(motionToggle);
            motionGroup.appendChild(motionRow);
            mainContent.appendChild(motionGroup);

            // Icon Size
            const cursorGroup = createEl('div', { className: 'nook-group' });
            cursorGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Icon Size' }));

            const cursorOptions = [
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
              { value: 'xlarge', label: 'X-Large' }
            ];

            cursorOptions.forEach(opt => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { textContent: opt.label }));
              const btn = createEl('button', {
                className: 'btn btn-sm' + (OS.settings.get('cursorSize') === opt.value ? ' btn-primary' : ''),
                textContent: OS.settings.get('cursorSize') === opt.value ? 'Active' : 'Select'
              });
              btn.addEventListener('click', () => {
                OS.settings.set('cursorSize', opt.value);
                // FIX 2: Use CSS transform to scale cursor indicator instead of invalid cursor size
                const cursorStyles = document.getElementById('cursor-custom-styles') || (() => {
                  const s = document.createElement('style'); s.id = 'cursor-custom-styles'; document.head.appendChild(s); return s;
                })();
                const transforms = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
                cursorStyles.textContent = `#desktop .desktop-icon { transform: ${transforms[opt.value]} }`;
                renderContent();
              });
              row.appendChild(btn);
              cursorGroup.appendChild(row);
            });

            mainContent.appendChild(cursorGroup);
          }

          function renderPrivacy() {
            mainContent.appendChild(createEl('h2', { textContent: 'Privacy & Security' }));

            // Data export/import
            const exportSection = createEl('div', { className: 'nook-privacy-section' });
            exportSection.appendChild(createEl('h3', { textContent: 'Data Management' }));

            const exportActions = createEl('div', { className: 'nook-data-actions' });

            const exportBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Export All Data (JSON)' });
            exportBtn.addEventListener('click', () => {
              const data = {
                settings: Object.fromEntries(Object.entries(OS.settings._cache || {})), // FIX 14 — was OS.settings.store (undefined); actual store is _cache
                version: OS.version,
                exportDate: new Date().toISOString()
              };
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = createEl('a', { href: url, download: 'novabyte-export.json' });
              a.click();
              URL.revokeObjectURL(url);
              Notify.show({ title: 'Data Exported', body: 'All data has been exported', type: 'success', appName: 'Nook' });
            });
            exportActions.appendChild(exportBtn);

            const importBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Import Data' });
            importBtn.addEventListener('click', async () => {
              const input = createEl('input', { type: 'file', accept: '.json' });
              input.addEventListener('change', async () => {
                const file = input.files[0];
                if (file) {
                  const text = await file.text();
                  try {
                    const data = JSON.parse(text);
                    if (data.settings) {
                      Object.entries(data.settings).forEach(([k, v]) => OS.settings.set(k, v));
                      Notify.show({ title: 'Data Imported', body: 'Settings have been imported', type: 'success', appName: 'Nook' });
                    }
                  } catch (e) {
                    Notify.show({ title: 'Import Failed', body: 'Invalid JSON file', type: 'error', appName: 'Nook' });
                  }
                }
              });
              input.click();
            });
            exportActions.appendChild(importBtn);

            exportSection.appendChild(exportActions);
            mainContent.appendChild(exportSection);
          }

          renderShortcuts = function () {
            mainContent.innerHTML = '';
            mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts' }));

            const searchInput = createEl('div', { className: 'nook-shortcuts-search' });
            const search = createEl('input', { placeholder: 'Search shortcuts...' });
            searchInput.appendChild(search);
            mainContent.appendChild(searchInput);

            const table = createEl('table', { className: 'nook-shortcuts-table' });
            const thead = createEl('thead');
            thead.innerHTML = '<tr><th>Action</th><th>Shortcut</th><th></th></tr>';
            table.appendChild(thead);

            const tbody = createEl('tbody');

            const shortcutsList = [
              { action: 'Open File Manager', key: 'Win+E' },
              { action: 'Open Terminal', key: 'Win+T' },
              { action: 'Open Launchpad', key: 'Win+Space' },
              { action: 'Lock Screen', key: 'Win+L' },
              { action: 'Show Desktop', key: 'Win+D' },
              { action: 'Switch Apps', key: 'Alt+Tab' },
              { action: 'Close Window', key: 'Alt+F4' },
              { action: 'Fullscreen', key: 'F11' },
              { action: 'Screenshot', key: 'Print Screen' },
              { action: 'New Tab (Browser)', key: 'Ctrl+T' },
              { action: 'Close Tab', key: 'Ctrl+W' },
              { action: 'Find in Page', key: 'Ctrl+F' },
              { action: 'Quick Commands', key: 'Ctrl+K' }
            ];

            const customShortcuts = JSON.parse(localStorage.getItem('novabyte-shortcuts') || '{}');

            function captureKeyBinding(action, currentKey) {
              return new Promise(resolve => {
                const overlay = createEl('div', {
                  // FIX 13 — tabIndex: -1 makes the div programmatically focusable so keydown events fire
                  tabIndex: -1,
                  style: 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;outline:none'
                });
                const msg = createEl('div', {
                  style: 'background:var(--bg-elevated);padding:30px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)',
                  innerHTML: `<h3 style="margin-bottom:15px;color:var(--text-primary)">Rebind: ${action}</h3><p style="color:var(--text-secondary);margin-bottom:20px">Press any key combination...</p><div id="kb-capture" style="font-family:var(--font-mono);font-size:18px;padding:10px 20px;background:var(--bg-sunken);border-radius:12px;color:var(--accent)">Waiting...</div>`
                });
                overlay.appendChild(msg);
                document.body.appendChild(overlay);

                const captureEl = msg.querySelector('#kb-capture');
                const keyCombo = { mods: [], key: '' };

                const keyHandler = e => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === 'Escape') { overlay.remove(); resolve(null); return; }
                  const parts = [];
                  if (e.ctrlKey) parts.push('Ctrl');
                  if (e.altKey) parts.push('Alt');
                  if (e.shiftKey) parts.push('Shift');
                  if (e.metaKey) parts.push('Win');
                  if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
                  if (parts.length > 0) {
                    keyCombo.mods = parts.slice(0, -1);
                    keyCombo.key = parts[parts.length - 1];
                    captureEl.textContent = parts.join('+');
                    setTimeout(() => {
                      overlay.remove();
                      resolve(parts.join('+'));
                    }, 400);
                  }
                };

                overlay.addEventListener('keydown', keyHandler, true);
                overlay.style.cursor = 'wait';
                setTimeout(() => overlay.focus(), 100);
              });
            }

            shortcutsList.forEach(s => {
              const row = createEl('tr');
              const currentKey = customShortcuts[s.action] || s.key;
              row.innerHTML = `<td></td><td><span class="nook-shortcut-key"></span></td><td><button class="btn btn-sm nook-rebind-btn">Rebind</button></td>`; row.querySelector("td:first-child").textContent = s.action; row.querySelector(".nook-shortcut-key").textContent = currentKey;
              const btn = row.querySelector('.nook-rebind-btn');
              btn.addEventListener('click', async () => {
                const newKey = await captureKeyBinding(s.action, s.key);
                if (newKey) {
                  customShortcuts[s.action] = newKey;
                  localStorage.setItem('novabyte-shortcuts', JSON.stringify(customShortcuts));
                  row.querySelector('.nook-shortcut-key').textContent = newKey;
                }
              });
              tbody.appendChild(row);
            });

            table.appendChild(tbody);
            mainContent.appendChild(table);

            search.addEventListener('input', () => {
              const query = search.value.toLowerCase();
              tbody.querySelectorAll('tr').forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
              });
            });
          };

          // ── Apps ────────────────────────────────────────────────────────────────
          const PERM_LABELS = {
            'fs:read': 'Read files', 'fs:write': 'Write files', 'fs:delete': 'Delete files', 'fs:metadata': 'File metadata',
            'net:internal': 'Internal network', 'net:external': 'External network', 'net:websocket': 'WebSocket',
            'mail:read': 'Read emails', 'mail:write': 'Compose emails', 'mail:send': 'Send emails', 'mail:delete': 'Delete emails',
            'calendar:read': 'Read calendar', 'calendar:write': 'Edit calendar', 'calendar:delete': 'Delete events',
            'contacts:read': 'Read contacts', 'contacts:write': 'Edit contacts',
            'device:camera': 'Camera', 'device:microphone': 'Microphone',
            'device:geolocation': 'Location', 'device:notifications': 'Notifications',
            'system:info': 'System info', 'system:settings': 'System settings', 'system:apps': 'Manage apps',
            'admin:system': 'System administration', 'admin:users': 'Manage users', 'admin:audit': 'Audit logs',
            'data:export': 'Export data', 'data:backup': 'Backup data',
          };
          const RISK_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149' };
          const RISK_BG    = { low: 'rgba(63,185,80,0.1)', medium: 'rgba(210,153,34,0.1)', high: 'rgba(240,136,62,0.1)', critical: 'rgba(248,81,73,0.1)' };

          function renderApps() {
            mainContent.appendChild(createEl('h2', { textContent: 'App Permissions', style: { marginBottom: '4px' } }));
            mainContent.appendChild(createEl('p', {
              textContent: 'Manage what each app is allowed to access. Denied permissions can be re-enabled here.',
              style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
            }));

            const mgr  = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
            const pmap = typeof AppPermissionsMap    !== 'undefined' ? AppPermissionsMap    : null;

            if (!mgr || !pmap) {
              const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
              warn.textContent = 'Permission system not available.';
              mainContent.appendChild(warn);
              return;
            }

            const appIds = new Set(Object.keys(pmap));
            if (typeof OS !== 'undefined' && OS.apps) {
              for (const id of Object.keys(OS.apps)) {
                if (id.startsWith('wa_')) appIds.add(id);
              }
            }

            let novaApps = [];
            try { novaApps = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { novaApps = []; }
            const novaAppIds = new Set(novaApps.map(a => a.id));

            const builtIns = [...appIds].filter(id => !id.startsWith('wa_') && !novaAppIds.has(id)).sort();
            const webApps  = [...appIds].filter(id =>  id.startsWith('wa_')).sort();

            function buildAppCard(appId, novaData) {
              const entry   = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[appId] : null;
              const appName = novaData?.name ?? entry?.name ?? appId;

              let dangerous, normal, appVersion, appVerified, appAuthor;
              if (novaData) {
                dangerous   = [...(novaData.permissions || []), ...(novaData.optionalPermissions || [])];
                normal      = [];
                appVersion  = novaData.version  || null;
                appVerified = novaData.verified  ?? false;
                appAuthor   = novaData.author    || null;
              } else {
                const mapEntry = pmap[appId];
                dangerous   = mapEntry?.dangerous ?? ['net:external', 'device:camera', 'device:microphone', 'device:geolocation'];
                normal      = mapEntry?.normal    ?? [];
                appVersion  = null;
                appVerified = null;
                appAuthor   = null;
              }

              if (dangerous.length === 0 && normal.length === 0 && !novaData && !appId.startsWith('wa_')) return null;

              const card = createEl('div', {
                style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;'
              });

              const header     = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;user-select:none;' });
              const headerLeft = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });

              const iconEl = createEl('div', {
                style: 'width:34px;height:34px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);flex-shrink:0;overflow:hidden;'
              });
              const iconVal  = novaData?.icon ?? entry?.icon ?? null;
              const isEmoji  = iconVal && /\p{Emoji}/u.test(iconVal) && iconVal.length <= 4;
              const isSvgKey = iconVal && !isEmoji && /^[a-z][a-z0-9-]*$/.test(iconVal);
              if (isSvgKey && typeof svgIcon === 'function') {
                iconEl.innerHTML = svgIcon(iconVal, 18);
                iconEl.style.color = 'var(--accent)';
              } else if (isEmoji) {
                iconEl.style.fontSize = '20px';
                iconEl.textContent = iconVal;
              } else {
                iconEl.textContent = appName.charAt(0).toUpperCase();
              }
              headerLeft.appendChild(iconEl);

              const nameEl  = createEl('div');
              nameEl.appendChild(createEl('div', { textContent: appName, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));

              const badgeRow = createEl('div', { style: 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;' });
              function refreshBadges() {
                badgeRow.innerHTML = '';
                const grantedCount = dangerous.filter(p => mgr.isGranted(p, appId)).length;
                const deniedCount  = dangerous.filter(p => mgr.isDenied ? mgr.isDenied(p, appId) : false).length;
                const pendingCount = dangerous.length - grantedCount - deniedCount;
                if (grantedCount > 0) badgeRow.appendChild(createEl('span', { textContent: grantedCount + ' allowed',    style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.3);' }));
                if (deniedCount  > 0) badgeRow.appendChild(createEl('span', { textContent: deniedCount  + ' denied',     style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(248,81,73,0.12);color:#f85149;border:1px solid rgba(248,81,73,0.3);' }));
                if (pendingCount > 0) badgeRow.appendChild(createEl('span', { textContent: pendingCount + ' not asked',  style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
                if (dangerous.length === 0 && normal.length === 0)
                  badgeRow.appendChild(createEl('span', { textContent: 'No permissions',           style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
                else if (dangerous.length === 0)
                  badgeRow.appendChild(createEl('span', { textContent: 'No sensitive permissions', style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
              }
              refreshBadges();

              if (appVersion || appAuthor || appVerified !== null) {
                const metaRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:3px;align-items:center;flex-wrap:wrap;' });
                if (appVersion)        metaRow.appendChild(createEl('span', { textContent: 'v' + appVersion,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
                if (appAuthor)         metaRow.appendChild(createEl('span', { textContent: 'by ' + appAuthor, style: 'font-size:10px;color:var(--text-muted);' }));
                if (appVerified === true)  metaRow.appendChild(createEl('span', { textContent: '✓ Verified',   style: 'font-size:10px;color:#3fb950;' }));
                if (appVerified === false) metaRow.appendChild(createEl('span', { textContent: '⚠ Unverified', style: 'font-size:10px;color:#d29922;' }));
                nameEl.appendChild(metaRow);
              }
              nameEl.appendChild(badgeRow);
              headerLeft.appendChild(nameEl);
              header.appendChild(headerLeft);

              const chevron = createEl('span', { style: 'color:var(--text-muted);font-size:12px;transition:transform 0.2s;' });
              chevron.textContent = '▶';
              header.appendChild(chevron);
              card.appendChild(header);

              const body = createEl('div', { style: 'display:none;border-top:1px solid var(--border-subtle);' });

              if (dangerous.length > 0) {
                const section = createEl('div', { style: 'padding:10px 14px 6px;' });
                section.appendChild(createEl('div', {
                  textContent: 'SENSITIVE PERMISSIONS',
                  style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:8px;'
                }));

                for (const perm of dangerous) {
                  const cat       = AppPermissionManager.PERMISSION_CATEGORIES?.[perm];
                  const risk      = cat?.risk ?? 'medium';
                  const label     = PERM_LABELS[perm] ?? perm;
                  const isGranted = mgr.isGranted(perm, appId);
                  const isDenied  = mgr.isDenied ? mgr.isDenied(perm, appId) : false;

                  const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);' });
                  const left = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });

                  const riskBadge = createEl('span', {
                    textContent: risk.charAt(0).toUpperCase() + risk.slice(1),
                    style: `font-size:9px;padding:1px 6px;border-radius:20px;background:${RISK_BG[risk]};color:${RISK_COLOR[risk]};border:1px solid ${RISK_COLOR[risk]}40;font-weight:600;`
                  });
                  const labelEl = createEl('div');
                  labelEl.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);font-weight:500;' }));
                  labelEl.appendChild(createEl('div', { textContent: perm,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
                  left.append(riskBadge, labelEl);
                  row.appendChild(left);

                  const toggleWrap  = createEl('label', { style: 'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;' });
                  const toggleInput = createEl('input', { type: 'checkbox' });
                  toggleInput.style.cssText = 'opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2;';
                  toggleInput.checked = isGranted;
                  const slider = createEl('span', {
                    style: `position:absolute;inset:0;border-radius:22px;transition:background 0.2s;background:${isGranted ? 'var(--accent)' : (isDenied ? 'rgba(248,81,73,0.3)' : 'var(--bg-elevated)')};border:1px solid var(--border-subtle);`
                  });
                  const knob = createEl('span', {
                    style: `position:absolute;top:2px;left:${isGranted ? '20px' : '2px'};width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);`
                  });
                  slider.appendChild(knob);
                  toggleWrap.append(toggleInput, slider);

                  toggleInput.addEventListener('change', async () => {
                    if (toggleInput.checked) {
                      if (mgr.resetPermission) await Promise.resolve(mgr.resetPermission(perm, appId)).catch(() => {});
                      await mgr.grantPermission(perm, appId, { permanent: true, reason: 'Manually granted via Settings', grantedBy: 'user' });
                      slider.style.background = 'var(--accent)';
                      knob.style.left = '20px';
                    } else {
                      await mgr.revokePermission(perm, appId);
                      slider.style.background = 'rgba(248,81,73,0.3)';
                      knob.style.left = '2px';
                    }
                    refreshBadges();
                  });

                  row.appendChild(toggleWrap);
                  section.appendChild(row);
                }
                body.appendChild(section);
              }

              if (normal.length > 0) {
                const normSection = createEl('div', { style: 'padding:8px 14px 10px;' });
                normSection.appendChild(createEl('div', {
                  textContent: 'AUTOMATIC PERMISSIONS',
                  style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:6px;'
                }));
                const normList = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;' });
                for (const perm of normal) {
                  normList.appendChild(createEl('span', {
                    textContent: PERM_LABELS[perm] ?? perm,
                    style: 'font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(63,185,80,0.08);color:#3fb950;border:1px solid rgba(63,185,80,0.2);'
                  }));
                }
                normSection.appendChild(normList);
                body.appendChild(normSection);
              }

              if (dangerous.length > 0) {
                const footer   = createEl('div', { style: 'padding:8px 14px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;' });
                const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset All Permissions', style: 'font-size:11px;' });
                resetBtn.addEventListener('click', async () => {
                  if (mgr.resetPermission) {
                    for (const p of dangerous) await mgr.resetPermission(p, appId);
                  } else {
                    await mgr.revokeAllPermissions(appId);
                  }
                  Notify.show({ title: 'Permissions Reset', body: appName + ' will be asked again next launch.', type: 'info', appName: 'Settings' });
                  refreshBadges();
                });
                footer.appendChild(resetBtn);
                body.appendChild(footer);
              }

              card.appendChild(body);

              let expanded = false;
              header.addEventListener('click', () => {
                expanded = !expanded;
                body.style.display       = expanded ? 'block' : 'none';
                chevron.style.transform  = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
              });

              return card;
            }

            if (builtIns.length > 0) {
              mainContent.appendChild(createEl('div', { textContent: 'BUILT-IN APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:10px;' }));
              for (const id of builtIns) {
                const card = buildAppCard(id);
                if (card) mainContent.appendChild(card);
              }
            }

            if (novaApps.length > 0) {
              mainContent.appendChild(createEl('div', { textContent: 'INSTALLED PACKAGES', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
              for (const novaData of novaApps) {
                const card = buildAppCard(novaData.id, novaData);
                if (card) mainContent.appendChild(card);
              }
            }

            if (webApps.length > 0) {
              mainContent.appendChild(createEl('div', { textContent: 'WEB APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
              for (const id of webApps) {
                const card = buildAppCard(id);
                if (card) mainContent.appendChild(card);
              }
            }

            if (builtIns.length === 0 && webApps.length === 0 && novaApps.length === 0) {
              const empty = createEl('div', { style: 'text-align:center;color:var(--text-muted);padding:40px 0;font-size:13px;' });
              empty.textContent = 'No apps found.';
              mainContent.appendChild(empty);
            }
          }

          // 2.3.8 — Redesigned About section with organised sections
          renderAbout = function () {
            mainContent.innerHTML = '';
            mainContent.style.padding = '0';

            const body = createEl('div', { style: 'padding:20px 24px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;flex:1;' });

            // ── helpers ──────────────────────────────────────────────────────────
            function mkCard(title, iconName) {
              const wrap = createEl('div', { style: 'background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;' });
              const hdr = createEl('div', { style: 'padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px;' });
              hdr.innerHTML = '<span class="material-symbols-rounded" style="font-size:15px;color:#4dd0e1;font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 24;">' + iconName + '</span>';
              hdr.appendChild(createEl('span', { textContent: title, style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.4);' }));
              const rows = createEl('div', { style: 'padding:0 16px;' });
              wrap.append(hdr, rows);
              return { wrap, rows };
            }

            function mkRow(label, value, last) {
              const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;' + (last ? '' : 'border-bottom:1px solid rgba(255,255,255,0.05);') });
              row.appendChild(createEl('span', { textContent: label, style: 'color:rgba(255,255,255,0.5);' }));
              const val = createEl('span', { textContent: value, style: 'color:rgba(255,255,255,0.9);font-weight:500;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
              row.appendChild(val);
              return row;
            }

            // ── HERO ─────────────────────────────────────────────────────────────
            const hero = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;padding:28px 16px 20px;text-align:center;gap:10px;' });

            // Hexagon logo
            const logoWrap = createEl('div', { style: 'width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,#0a84ff 0%,#5e5ce6 50%,#bf5af2 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(94,92,230,0.45),0 2px 8px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.2);margin-bottom:4px;' });
            logoWrap.innerHTML = '<svg viewBox="0 0 80 80" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><polygon points="40,6 68,22 68,58 40,74 12,58 12,22" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2.5"/><polygon points="40,16 60,28 60,52 40,64 20,52 20,28" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.5"/><circle cx="40" cy="40" r="6" fill="white" opacity="0.9"/><line x1="40" y1="6" x2="40" y2="16" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="68" y1="22" x2="60" y2="28" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="68" y1="58" x2="60" y2="52" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="40" y1="74" x2="40" y2="64" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="12" y1="58" x2="20" y2="52" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="12" y1="22" x2="20" y2="28" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/></svg>';

            const osName = createEl('div', { style: 'font-size:26px;font-weight:800;letter-spacing:-0.5px;background:linear-gradient(130deg,#ffffff 30%,#bf5af2 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;' });
            osName.textContent = 'AstroOS';

            const verPill = createEl('div', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(94,92,230,0.18);border:1px solid rgba(94,92,230,0.4);border-radius:20px;padding:3px 14px;font-size:11px;font-weight:700;color:#a39df5;' });
            verPill.textContent = 'AstroOS ' + ASTRO_OS_VERSION + ' · NovaByte ' + OS.version;

            const tagline = createEl('div', { style: 'font-size:11px;color:rgba(255,255,255,0.3);font-style:italic;' });
            tagline.textContent = '\u201cExplore beyond limits.\u201d';

            hero.append(logoWrap, osName, verPill, tagline);
            body.appendChild(hero);

            // ── CARD 1: SOFTWARE ──────────────────────────────────────────────────
            const { wrap: swWrap, rows: swRows } = mkCard('Software', 'deployed_code');

            // Build number row — tap 7x for asteroid dodger
            const buildRow = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;border-radius:14px;transition:background 0.15s;user-select:none;' });
            buildRow.appendChild(createEl('span', { textContent: 'Build number', style: 'color:rgba(255,255,255,0.5);' }));
            const buildRight = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
            const buildVal = createEl('span', { textContent: 'astro-' + OS.version + '-stable', style: 'color:rgba(255,255,255,0.9);font-weight:500;font-family:monospace;font-size:11.5px;' });
            const buildHint = createEl('span', { textContent: '', style: 'font-size:10px;color:#4dd0e1;min-width:60px;text-align:right;transition:opacity 0.2s;' });
            buildRight.append(buildVal, buildHint);
            buildRow.appendChild(buildRight);

            let _tapCount = 0, _tapTimer = null;
            buildRow.addEventListener('mouseenter', () => { buildRow.style.background = 'rgba(77,208,225,0.06)'; buildRow.style.paddingLeft = '6px'; buildRow.style.paddingRight = '6px'; });
            buildRow.addEventListener('mouseleave', () => { buildRow.style.background = 'transparent'; buildRow.style.paddingLeft = ''; buildRow.style.paddingRight = ''; });
            buildRow.addEventListener('click', () => {
              _tapCount++;
              const left = 7 - _tapCount;
              if (_tapCount >= 7) {
                _tapCount = 0;
                clearTimeout(_tapTimer);
                buildHint.textContent = '';
                launchAsteroidGame();
                return;
              }
              buildHint.textContent = left + ' tap' + (left === 1 ? '' : 's') + ' left';
              clearTimeout(_tapTimer);
              _tapTimer = setTimeout(() => { _tapCount = 0; buildHint.textContent = ''; }, 2000);
            });

            swRows.appendChild(buildRow);

            // AstroOS version row
            swRows.appendChild(mkRow('AstroOS version', ASTRO_OS_VERSION, false));
            // NovaByte base version row
            swRows.appendChild(mkRow('NovaByte base', 'v' + OS.version, false));

            // Security patch row
            const patchRow = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;' });
            patchRow.appendChild(createEl('span', { textContent: 'Security patch level', style: 'color:rgba(255,255,255,0.5);' }));
            const patchBadge = createEl('span', { style: 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.3);border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;color:#3fb950;' });
            patchBadge.textContent = '\uD83D\uDD12 ' + (OS.securityPatch || '2026-05-01');
            patchRow.appendChild(patchBadge);
            swRows.appendChild(patchRow);

            body.appendChild(swWrap);

            // ── CARD 2: DEVICE ────────────────────────────────────────────────────
            const { wrap: hwWrap, rows: hwRows } = mkCard('Device', 'devices');
            const uptimeSec = Math.floor(performance.now() / 1000);
            const uptimeStr = uptimeSec < 60 ? uptimeSec + 's'
              : uptimeSec < 3600 ? Math.floor(uptimeSec / 60) + 'm ' + (uptimeSec % 60) + 's'
                : Math.floor(uptimeSec / 3600) + 'h ' + Math.floor((uptimeSec % 3600) / 60) + 'm';
            [
              ['Screen', screen.width + ' \u00D7 ' + screen.height],
              ['Pixel ratio', window.devicePixelRatio + '\u00D7'],
              ['CPU cores', String(navigator.hardwareConcurrency || 'Unknown')],
              ['Device memory', navigator.deviceMemory ? navigator.deviceMemory + ' GB (est.)' : 'Not reported'],
              ['Session uptime', uptimeStr],
            ].forEach(([l, v], i, a) => hwRows.appendChild(mkRow(l, v, i === a.length - 1)));
            body.appendChild(hwWrap);

            // ── CARD 3: ENVIRONMENT ───────────────────────────────────────────────
            const { wrap: envWrap, rows: envRows } = mkCard('Environment', 'language');
            var _tz = 'Unknown';
            try { _tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch (e) { }
            [
              ['Language', navigator.language],
              ['Timezone', _tz],
              ['Do Not Track', navigator.doNotTrack === '1' ? 'On \u2713' : 'Off'],
              ['Cookies', navigator.cookieEnabled ? 'Enabled \u2713' : 'Disabled'],
            ].forEach(([l, v], i, a) => envRows.appendChild(mkRow(l, v, i === a.length - 1)));
            body.appendChild(envWrap);

            // ── CARD 4: LEGAL ─────────────────────────────────────────────────────
            const { wrap: lgWrap, rows: lgRows } = mkCard('Legal', 'gavel');
            [
              ['Licence', 'MIT'],
              ['Copyright', '\u00A9 2026 AstroOS'],
              ['Telemetry', 'Zero. None. Zilch.'],
            ].forEach(([l, v], i, a) => lgRows.appendChild(mkRow(l, v, i === a.length - 1)));
            body.appendChild(lgWrap);

            // ── Copy button ───────────────────────────────────────────────────────
            const copyBtn = createEl('button', { className: 'btn btn-sm', style: 'align-self:flex-start;display:flex;align-items:center;gap:6px;' });
            copyBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px;">content_copy</span> Copy system info';
            copyBtn.addEventListener('click', () => {
              var _tz2 = 'Unknown';
              try { _tz2 = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch (e) { }
              const lines = [
                'AstroOS ' + ASTRO_OS_VERSION + ' (based on NovaByte v' + OS.version + ')',
                'Build: astro-' + OS.version + '-stable',
                'Security patch: ' + (OS.securityPatch || '2026-05-01'),
                'Screen: ' + screen.width + '\u00D7' + screen.height,
                'CPU cores: ' + (navigator.hardwareConcurrency || 'Unknown'),
                'Language: ' + navigator.language,
                'Timezone: ' + _tz2,
              ];
              navigator.clipboard.writeText(lines.join('\n'));
              if (typeof Notify !== 'undefined') Notify.show({ title: 'Copied', body: 'System info copied to clipboard', type: 'success', appName: 'Settings' });
            });
            body.appendChild(copyBtn);
            mainContent.appendChild(body);

            // ── ASTEROID DODGER ───────────────────────────────────────────────────
            function launchAsteroidGame() {
              const overlay = createEl('div', { style: 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);' });

              const panel = createEl('div', { style: 'background:#0a0a1a;border:1px solid rgba(94,92,230,0.4);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:20px;gap:12px;box-shadow:0 24px 80px rgba(0,0,0,0.8),0 0 40px rgba(94,92,230,0.2);' });

              const titleRow = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;width:100%;' });
              titleRow.appendChild(createEl('div', { textContent: '\u2604\uFE0F Asteroid Dodger', style: 'font-size:15px;font-weight:700;color:#fff;letter-spacing:0.5px;' }));

              const scoreEl = createEl('div', { textContent: 'Score: 0', style: 'font-size:12px;color:#a39df5;font-weight:600;' });
              titleRow.appendChild(scoreEl);
              panel.appendChild(titleRow);

              const canvas = createEl('canvas');
              canvas.width = 320;
              canvas.height = 420;
              canvas.style.cssText = 'border-radius:12px;border:1px solid rgba(255,255,255,0.08);display:block;cursor:none;';
              panel.appendChild(canvas);

              const hint = createEl('div', { textContent: 'Move mouse or use \u2190\u2192 arrow keys to dodge', style: 'font-size:10.5px;color:rgba(255,255,255,0.35);' });
              panel.appendChild(hint);

              const closeBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Close', style: 'margin-top:4px;' });
              closeBtn.addEventListener('click', () => overlay.remove());
              panel.appendChild(closeBtn);

              overlay.appendChild(panel);
              document.body.appendChild(overlay);

              const ctx = canvas.getContext('2d');
              const W = canvas.width, H = canvas.height;

              // Stars background
              const stars = Array.from({ length: 80 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.5 + 0.3, spd: Math.random() * 0.4 + 0.1 }));

              // Ship
              const ship = { x: W / 2, y: H - 60, w: 22, h: 30, speed: 0, vx: 0 };
              const keys = {};
              let asteroids = [], particles = [], score = 0, lives = 3, gameOver = false, frame = 0, spawnRate = 80;

              function spawnAsteroid() {
                const sz = 14 + Math.random() * 18;
                asteroids.push({ x: sz + Math.random() * (W - sz * 2), y: -sz, r: sz, vy: 1.2 + Math.random() * 1.5 + score * 0.003, vx: (Math.random() - 0.5) * 1.2, rot: 0, rotSpd: (Math.random() - 0.5) * 0.06, sides: 6 + Math.floor(Math.random() * 3), color: ['#a39df5', '#4dd0e1', '#bf5af2', '#ff453a'][Math.floor(Math.random() * 4)] });
              }

              function spawnParticles(x, y, color) {
                for (let i = 0; i < 12; i++) {
                  const a = (Math.PI * 2 / 12) * i + Math.random() * 0.5;
                  const spd = 2 + Math.random() * 3;
                  particles.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, life: 1, color });
                }
              }

              function drawShip(x, y) {
                ctx.save();
                ctx.translate(x, y);
                // Engine glow
                ctx.shadowBlur = 18; ctx.shadowColor = '#5e5ce6';
                ctx.fillStyle = 'rgba(94,92,230,0.5)';
                ctx.beginPath(); ctx.ellipse(0, 14, 5, 8, 0, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
                // Body
                ctx.fillStyle = '#e0e0ff';
                ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(11, 12); ctx.lineTo(0, 8); ctx.lineTo(-11, 12); ctx.closePath(); ctx.fill();
                // Cockpit
                ctx.fillStyle = '#4dd0e1';
                ctx.beginPath(); ctx.ellipse(0, -4, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
                // Wings accent
                ctx.fillStyle = '#a39df5';
                ctx.beginPath(); ctx.moveTo(-11, 12); ctx.lineTo(-16, 16); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(11, 12); ctx.lineTo(16, 16); ctx.lineTo(8, 10); ctx.closePath(); ctx.fill();
                ctx.restore();
              }

              function drawAsteroid(a) {
                ctx.save();
                ctx.translate(a.x, a.y);
                ctx.rotate(a.rot);
                ctx.strokeStyle = a.color;
                ctx.lineWidth = 2;
                ctx.shadowBlur = 8; ctx.shadowColor = a.color;
                ctx.beginPath();
                for (let i = 0; i < a.sides; i++) {
                  const ang = (Math.PI * 2 / a.sides) * i;
                  const jitter = a.r * (0.78 + Math.random() * 0.0); // stable shape
                  const px = Math.cos(ang) * a.r * (0.8 + ((i * 7) % 5) * 0.06);
                  const py = Math.sin(ang) * a.r * (0.8 + ((i * 5) % 4) * 0.07);
                  i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.restore();
              }

              // Input
              window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey);
              function onKey(e) { keys[e.code] = e.type === 'keydown'; }

              canvas.addEventListener('mousemove', (e) => {
                const rect = canvas.getBoundingClientRect();
                ship.x = Math.max(ship.w, Math.min(W - ship.w, e.clientX - rect.left));
              });

              function loop() {
                if (!document.body.contains(overlay)) { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); return; }
                requestAnimationFrame(loop);
                frame++;

                // Stars
                ctx.fillStyle = '#040410';
                ctx.fillRect(0, 0, W, H);
                stars.forEach(s => {
                  s.y = (s.y + s.spd) % H;
                  ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + s.r * 0.3) + ')';
                  ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
                });

                if (gameOver) {
                  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H);
                  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px system-ui'; ctx.textAlign = 'center';
                  ctx.fillText('GAME OVER', W / 2, H / 2 - 30);
                  ctx.font = '14px system-ui'; ctx.fillStyle = '#a39df5';
                  ctx.fillText('Score: ' + score, W / 2, H / 2);
                  ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '12px system-ui';
                  ctx.fillText('Close and tap build number again to replay', W / 2, H / 2 + 30);
                  return;
                }

                // Keyboard movement
                if (keys['ArrowLeft']) ship.vx = Math.max(ship.vx - 0.8, -5);
                else if (keys['ArrowRight']) ship.vx = Math.min(ship.vx + 0.8, 5);
                else ship.vx *= 0.85;
                ship.x = Math.max(ship.w, Math.min(W - ship.w, ship.x + ship.vx));

                // Spawn
                if (frame % Math.max(25, spawnRate - Math.floor(score / 8)) === 0) spawnAsteroid();
                score = Math.floor(frame / 6);
                scoreEl.textContent = 'Score: ' + score;
                spawnRate = Math.max(28, 80 - Math.floor(score / 5));

                // Asteroids
                asteroids = asteroids.filter(a => a.y - a.r < H + 20);
                asteroids.forEach(a => {
                  a.x += a.vx; a.y += a.vy; a.rot += a.rotSpd;
                  drawAsteroid(a);
                  // Collision
                  const dx = a.x - ship.x, dy = a.y - ship.y;
                  if (Math.sqrt(dx * dx + dy * dy) < a.r * 0.7 + 10) {
                    spawnParticles(ship.x, ship.y, '#ff453a');
                    a.y = H + 100; lives--;
                    if (lives <= 0) gameOver = true;
                  }
                });

                // Particles
                particles = particles.filter(p => p.life > 0);
                particles.forEach(p => {
                  p.x += p.vx; p.y += p.vy; p.life -= 0.04; p.vy += 0.08;
                  ctx.globalAlpha = p.life;
                  ctx.fillStyle = p.color;
                  ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
                  ctx.globalAlpha = 1;
                });

                // Ship
                drawShip(ship.x, ship.y);

                // Lives
                for (let i = 0; i < 3; i++) {
                  ctx.globalAlpha = i < lives ? 1 : 0.18;
                  ctx.fillStyle = '#ff453a';
                  ctx.font = '14px system-ui';
                  ctx.fillText('\u2665', 8 + i * 20, 22);
                }
                ctx.globalAlpha = 1;
              }

              loop();
            }
          };
          container.appendChild(sidebar);
          container.appendChild(mainContent);
          content.appendChild(container);

          renderSidebar();
          renderContent();
        }
      });