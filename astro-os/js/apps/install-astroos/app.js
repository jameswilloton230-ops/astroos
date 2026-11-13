(function () {
  'use strict';

  const APP_ID = 'com.astroos.install';
  const INSTALLER = '/usr/bin/astroos-install';

  function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function listDisks() {
    const fs = require('fs');
    const names = fs.readdirSync('/sys/block')
      .filter(name => /^(sd[a-z]|vd[a-z]|nvme\d+n\d+|mmcblk\d+)$/.test(name));

    return names.flatMap(name => {
      const device = `/dev/${name}`;
      try {
        if (!fs.statSync(device).isBlockDevice()) return [];
        const sectors = Number(fs.readFileSync(`/sys/block/${name}/size`, 'utf8').trim());
        if (!Number.isSafeInteger(sectors) || sectors <= 0) return [];
        const modelPath = `/sys/block/${name}/device/model`;
        let model = '';
        try {
          model = fs.readFileSync(modelPath, 'utf8').trim().replace(/\s+/g, ' ');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn(`[Install AstroOS] Could not read the model for ${device}:`, error);
          }
        }
        return [{ device, model, size: sectors * 512 }];
      } catch (error) {
        console.error(`[Install AstroOS] Could not inspect ${device}:`, error);
        return [];
      }
    });
  }

  async function removeInstallerDesktopShortcut() {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) throw new Error('The desktop folder is unavailable.');

    const iconPositions = OS.settings.get('desktopIconPositions') || {};
    let removed = 0;
    for (const file of FS.listDir(desktopFolder)) {
      if (!file.name.endsWith('.lnk') || file.mimeType !== 'application/x-app-shortcut') continue;
      let shortcut;
      try {
        shortcut = JSON.parse(file.content || '{}');
      } catch {
        continue;
      }
      if (shortcut?.type !== 'app-shortcut' || shortcut?.target !== APP_ID) continue;
      await FS.permanentDelete(file.id);
      delete iconPositions[`file:${file.id}`];
      removed++;
    }

    OS.settings.set('desktopIconPositions', iconPositions);
    if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
    return removed;
  }

  async function removeInstallerFromSession() {
    let cleanupError = null;
    try {
      await removeInstallerDesktopShortcut();
    } catch (error) {
      cleanupError = error;
      console.error('[Install AstroOS] Could not remove its desktop shortcut:', error);
    }

    OS.settings.set(
      'pinnedApps',
      (OS.settings.get('pinnedApps') || []).filter(id => id !== APP_ID)
    );

    if (typeof WM !== 'undefined' && WM.closeWindow && OS.windows) {
      const windowIds = [];
      for (const [windowId, windowState] of OS.windows) {
        if (windowState.appId === APP_ID) windowIds.push(windowId);
      }
      await Promise.all(windowIds.map(windowId => WM.closeWindow(windowId, { forceKill: true })));
    }

    if (typeof AppRegistry !== 'undefined' && AppRegistry.unregisterApp) {
      AppRegistry.unregisterApp(APP_ID);
    }
    if (OS.apps) delete OS.apps[APP_ID];
    const registryIndex = APP_REGISTRY.findIndex(app => app.id === APP_ID);
    if (registryIndex !== -1) APP_REGISTRY.splice(registryIndex, 1);
    if (typeof WM !== 'undefined') WM.updateTaskbar?.();
    if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
    if (typeof renderLaunchpad === 'function') renderLaunchpad();
    if (cleanupError) throw cleanupError;
  }

  registerApp({
    id: APP_ID,
    name: 'Install AstroOS',
    icon: 'hard-drive',
    version: '3.0.2',
    description: 'Install AstroOS to a selected disk.',
    defaultSize: [680, 520],
    minSize: [400, 320],
    init(content) {
      content.replaceChildren();
      if (typeof process === 'undefined' || process.platform !== 'linux') {
        content.textContent = 'Disk installation is available only in the AstroOS Linux image.';
        return;
      }
      Object.assign(content.style, {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(8px, 2vh, 18px)',
        padding: 'clamp(12px, 4vw, 28px)',
        height: '100%',
        minWidth: '0',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui, sans-serif)'
      });

      const header = createEl('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      const title = createEl('h1', {
        textContent: 'Install AstroOS',
        style: 'font-size:24px;margin:0'
      });
      const description = createEl('p', {
        textContent: 'A short guided setup will prepare a disk and install the live system.',
        style: 'margin:0;line-height:1.5;color:var(--text-secondary)'
      });
      header.append(title, description);

      const progressLabel = createEl('div', {
        style: 'font-size:13px;color:var(--text-secondary);font-weight:600'
      });
      const progressTrack = createEl('div', {
        style: 'display:flex;gap:6px'
      });
      let disks = [];
      let selectedDevice = '';
      let step = 0;
      let installOutput = '';
      let running = false;
      let installationFailed = false;
      const stages = ['Choose a disk', 'Review and confirm', 'Installing', 'Complete'];
      const body = createEl('div', {
        className: 'astroos-installer-body',
        style: 'display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;gap:12px;overflow-y:auto;overscroll-behavior:contain'
      });
      const footer = createEl('div', {
        className: 'astroos-installer-footer',
        style: 'display:flex;flex:0 0 auto;flex-wrap:wrap;align-items:stretch;gap:12px;margin-top:auto'
      });
      const backButton = createEl('button', {
        textContent: 'Back',
        style: 'box-sizing:border-box;flex:1 1 150px;min-width:0;padding:10px 16px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--text-primary);white-space:normal;line-height:1.35;cursor:pointer'
      });
      const nextButton = createEl('button', {
        textContent: 'Continue',
        style: 'box-sizing:border-box;flex:1 1 150px;min-width:0;padding:10px 18px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;white-space:normal;line-height:1.35;cursor:pointer'
      });
      const refreshDisks = () => {
        try {
          disks = listDisks();
        } catch (error) {
          console.error('[Install AstroOS] Disk discovery failed:', error);
          disks = [];
        }
      };
      const selectedDisk = () => disks.find(disk => disk.device === selectedDevice);
      const appendOutput = text => {
        const readable = String(text)
          .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
          .replace(/[\u2580-\u259f]/g, '#')
          .replace(/\r\n?/g, '\n');
        installOutput = `${installOutput}${readable}`.slice(-16000);
        const output = body.querySelector('pre');
        if (output) {
          output.textContent = installOutput;
          output.scrollTop = output.scrollHeight;
        }
      };
      const renderProgress = () => {
        progressLabel.textContent = `Step ${Math.min(step + 1, stages.length)} of ${stages.length} — ${stages[step]}`;
        progressTrack.replaceChildren();
        stages.forEach((label, index) => {
          progressTrack.appendChild(createEl('div', {
            'aria-label': label,
            style: `height:4px;flex:1;border-radius:4px;background:${index <= step ? 'var(--accent)' : 'var(--border)'}`
          }));
        });
      };
      const renderStep = () => {
        renderProgress();
        body.replaceChildren();
        backButton.hidden = step === 0 || step === 3 || running;
        nextButton.hidden = step === 2 || step === 3;
        nextButton.disabled = step === 0 ? !selectedDisk() : false;

        if (step === 0) {
          const explanation = createEl('p', {
            textContent: 'Choose the virtual hard disk you added for AstroOS. The live ISO is not a destination disk.',
            style: 'line-height:1.55;color:var(--text-secondary)'
          });
          const diskSelect = createEl('select', {
            'aria-label': 'Installation disk',
            style: 'box-sizing:border-box;width:100%;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg-secondary);color:var(--text-primary);font:inherit'
          });
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = disks.length ? 'Select an installation disk…' : 'No supported disks found.';
          placeholder.disabled = disks.length > 0;
          diskSelect.appendChild(placeholder);
          for (const disk of disks) {
            const option = document.createElement('option');
            option.value = disk.device;
            option.textContent = `${disk.device}${disk.model ? ` — ${disk.model}` : ''} (${formatSize(disk.size)})`;
            diskSelect.appendChild(option);
          }
          diskSelect.value = selectedDevice;
          diskSelect.addEventListener('change', () => {
            selectedDevice = diskSelect.value;
            nextButton.disabled = !selectedDisk();
          });
          const refreshButton = createEl('button', {
            textContent: 'Refresh disk list',
            style: 'align-self:flex-start;padding:8px 12px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--text-primary);cursor:pointer'
          });
          refreshButton.addEventListener('click', () => {
            refreshDisks();
            if (!selectedDisk()) selectedDevice = '';
            renderStep();
          });
          const safety = createEl('div', {
            textContent: 'For safety, use a separate, disposable VMware virtual disk. Never select a disk containing files you want to keep.',
            style: 'padding:14px;border:1px solid var(--text-warning,#d29922);border-radius:8px;color:var(--text-warning,#d29922);line-height:1.5'
          });
          body.append(explanation, diskSelect, refreshButton, safety);
          nextButton.textContent = 'Review disk';
        } else if (step === 1) {
          const disk = selectedDisk();
          if (!disk) {
            step = 0;
            renderStep();
            return;
          }
          const warning = createEl('div', {
            textContent: 'This operation permanently erases every partition and file on the selected disk.',
            style: 'padding:16px;border:1px solid var(--text-danger,#f85149);border-radius:8px;color:var(--text-danger,#f85149);font-weight:700;line-height:1.5'
          });
          const summary = createEl('div', {
            textContent: `${disk.device}${disk.model ? ` — ${disk.model}` : ''}\n${formatSize(disk.size)}`,
            style: 'padding:16px;border-radius:8px;background:var(--bg-secondary);white-space:pre-line;line-height:1.6;font-family:var(--font-mono,monospace)'
          });
          const prompt = createEl('p', {
            textContent: `To confirm you selected the correct disk, type ERASE ${disk.device} below.`,
            style: 'line-height:1.5;color:var(--text-secondary)'
          });
          const confirmation = document.createElement('input');
          confirmation.type = 'text';
          confirmation.autocomplete = 'off';
          confirmation.spellcheck = false;
          confirmation.setAttribute('aria-label', `Type ERASE ${disk.device} to confirm`);
          confirmation.placeholder = `ERASE ${disk.device}`;
          Object.assign(confirmation.style, {
            boxSizing: 'border-box',
            width: '100%',
            padding: '12px',
            color: 'var(--text-primary)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '7px',
            font: 'inherit'
          });
          confirmation.addEventListener('input', () => {
            nextButton.disabled = confirmation.value.trim() !== `ERASE ${disk.device}`;
          });
          body.append(warning, summary, prompt, confirmation);
          nextButton.textContent = 'Erase and install';
          nextButton.disabled = true;
        } else if (step === 2) {
          const status = createEl('div', {
            textContent: `Installing to ${selectedDevice}. Do not power off the VM.`,
            style: 'font-weight:600;line-height:1.5'
          });
          const output = createEl('pre', {
            textContent: installOutput || 'Starting the installer…',
            style: 'box-sizing:border-box;flex:1;min-height:100px;overflow:auto;margin:0;padding:14px;border-radius:8px;background:var(--bg-secondary);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--font-mono,monospace)'
          });
          body.append(status, output);
          nextButton.hidden = true;
          startInstallation(status);
        } else {
          body.append(
            createEl('div', { textContent: 'AstroOS is installed.', style: 'font-size:20px;font-weight:700' }),
            createEl('p', {
              textContent: `Installation to ${selectedDevice} completed. Restart the VM, disconnect the live ISO, and boot from the installed disk.`,
              style: 'line-height:1.6;color:var(--text-secondary)'
            })
          );
          nextButton.hidden = true;
          backButton.hidden = true;
        }
      };
      const startInstallation = status => {
        if (running) return;
        running = true;
        backButton.hidden = true;
        installOutput = '';
        const childProcess = require('child_process');
        let child;
        try {
          child = childProcess.spawn(INSTALLER, [selectedDevice, `ERASE:${selectedDevice}`], {
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (error) {
          running = false;
          installationFailed = true;
          console.error('[Install AstroOS] Could not start installer:', error);
          status.textContent = 'The installer could not be started.';
          appendOutput(`${error.message}\n`);
          backButton.hidden = false;
          backButton.textContent = 'Back to disk selection';
          return;
        }

        let finished = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', appendOutput);
        child.stderr.on('data', appendOutput);
        child.on('error', error => {
          if (finished) return;
          finished = true;
          running = false;
          installationFailed = true;
          console.error('[Install AstroOS] Installer process failed:', error);
          status.textContent = 'Installation failed. The disk may have changed; review the output before trying again.';
          appendOutput(`${error.message}\n`);
          backButton.hidden = false;
          backButton.textContent = 'Back to disk selection';
        });
        child.on('close', async code => {
          if (finished) return;
          finished = true;
          running = false;
          if (code !== 0) {
            installationFailed = true;
            status.textContent = `Installation failed with exit code ${code ?? 'unknown'}. The disk may have changed; review the output before trying again.`;
            backButton.hidden = false;
            backButton.textContent = 'Back to disk selection';
            return;
          }

          step = 3;
          renderStep();
          Notify.show({
            title: 'Installation complete',
            body: `AstroOS is installed to ${selectedDevice}. The installer has been removed. Restart the VM to boot from the installed system.`,
            type: 'success',
            appName: 'Install AstroOS'
          });
          try {
            await removeInstallerFromSession();
          } catch (error) {
            console.error('[Install AstroOS] Could not remove itself from the live session:', error);
            Notify.show({
              title: 'Installer cleanup failed',
              body: error?.message || String(error),
              type: 'warning',
              appName: 'Install AstroOS'
            });
          }
        });
      };

      backButton.addEventListener('click', () => {
        if (installationFailed) {
          installationFailed = false;
          step = 0;
          selectedDevice = '';
          renderStep();
        } else if (step > 0 && step < 3 && !running) {
          step--;
          renderStep();
        }
      });
      nextButton.addEventListener('click', () => {
        if (step === 0 && selectedDisk()) {
          step = 1;
          renderStep();
        } else if (step === 1 && selectedDisk()) {
          const confirmation = body.querySelector('input');
          if (confirmation?.value.trim() === `ERASE ${selectedDevice}`) {
            step = 2;
            renderStep();
          }
        }
      });
      footer.append(backButton, nextButton);
      content.append(header, progressLabel, progressTrack, body, footer);
      refreshDisks();
      renderStep();
    }
  });
})();
