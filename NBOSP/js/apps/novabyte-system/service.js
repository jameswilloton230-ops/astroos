(function () {
  'use strict';

  const appId = 'com.nbosp.service.novabyte-system';
  const storedSettings = OS?.settings;
  if (!storedSettings || typeof storedSettings.get !== 'function' ||
      typeof storedSettings.set !== 'function') {
    throw new Error('[NovaByteSystem] OS settings store is unavailable');
  }
  const fs = require('fs');
  const os = require('os');

  const themes = new Set([
    'nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox',
  ]);
  const wallpaperIds = new Set([
    'stock-blue', 'stock-dark', 'stock-light', 'stock-green',
    'stock-purple', 'stock-red', 'stock-gray', 'stock-teal',
  ]);
  const keyboardLayouts = new Set([
    'us', 'gb', 'ca', 'au', 'de', 'fr', 'be', 'es', 'it', 'pt',
    'br', 'nl', 'se', 'no', 'dk', 'fi', 'pl', 'tr', 'ru', 'ua', 'jp',
  ]);
  const readableKeys = new Set([
    'accentColor', 'autoLock', 'clockFormat', 'cursorSize', 'devMode',
    'highContrast', 'keyboardLayout', 'osVersion', 'prohibitWallpaperChange',
    'reduceMotion', 'region', 'removeTransparency', 'rootAccessEnabled',
    'showTaskbarClock', 'taskbarSize', 'theme', 'timezone', 'username',
    'wallpaperId', 'customWallpaper', 'customWallpaperName', 'doNotDisturb',
  ]);
  const protectedImportKeys = new Set([
    'devMode', 'rootAccessEnabled', 'lockPin', 'pinSalt',
    'biometricCredentialId', 'bootPassword', 'osVersion',
    'prohibitWallpaperChange',
  ]);
  const validators = new Map([
    ['theme', value => typeof value === 'string' && themes.has(value)],
    ['accentColor', value => value === null || (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value))],
    ['clockFormat', value => value === '12h' || value === '24h'],
    ['username', value => typeof value === 'string' && value.trim().length > 0 &&
      value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)],
    ['timezone', value => {
      if (typeof value !== 'string' || value.length > 128) return false;
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }],
    ['region', value => {
      if (typeof value !== 'string' || value.length > 64) return false;
      try {
        return Intl.getCanonicalLocales(value).length === 1;
      } catch {
        return false;
      }
    }],
    ['keyboardLayout', value => typeof value === 'string' && keyboardLayouts.has(value)],
    ['wallpaperId', value => value === null || (typeof value === 'string' && wallpaperIds.has(value))],
    ['customWallpaper', value => value === null ||
      (typeof value === 'string' && value.length <= 5_500_000 &&
        /^data:image\/(?:png|jpe?g|webp|gif|bmp|x-ms-bmp|svg\+xml);base64,[a-z\d+/]+=*$/i.test(value))],
    ['customWallpaperName', value => value === null ||
      (typeof value === 'string' && value.length > 0 && value.length <= 255 &&
        !/[\u0000-\u001f\u007f]/.test(value))],
    ['doNotDisturb', value => typeof value === 'boolean'],
    ['showTaskbarClock', value => typeof value === 'boolean'],
    ['taskbarSize', value => value === 'compact' || value === 'normal' || value === 'large'],
    ['reduceMotion', value => typeof value === 'boolean'],
    ['removeTransparency', value => typeof value === 'boolean'],
    ['highContrast', value => typeof value === 'boolean'],
    ['cursorSize', value => value === 'normal' || value === 'large' || value === 'xlarge'],
  ]);

  function get(key) {
    if (typeof key !== 'string' || !readableKeys.has(key)) {
      throw new TypeError(`Setting '${String(key)}' is not readable through NovaByte System`);
    }
    return storedSettings.get(key);
  }

  function validate(key, value) {
    const validator = validators.get(key);
    if (!validator || !validator(value)) {
      throw new TypeError(`Invalid value for system setting '${key}'`);
    }
  }

  function persistKeyboardLayout(layout) {
    if (typeof process === 'undefined' || process.platform !== 'linux') return;
    const fs = require('fs');
    const path = require('path');
    const configDir = path.join(require('os').homedir(), '.config', 'novabyte');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const target = path.join(configDir, 'keyboard-layout');
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${layout}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  function set(key, value) {
    validate(key, value);
    if (key === 'keyboardLayout') persistKeyboardLayout(value);
    if (key === 'username') value = value.trim();
    const result = storedSettings.set(key, value);
    if (result === false) return false;
    if (key === 'username') OS.username = value;
    return true;
  }

  function setCredential(key, value) {
    if (key !== 'lockPin' || !(value === null ||
        (typeof value === 'string' && value.length > 0 && value.length <= 1024))) {
      throw new TypeError('Invalid system credential update');
    }
    OS.lockPin = value;
    storedSettings.set(key, value);
    return true;
  }

  function setDeveloperMode(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Developer Mode must be a boolean');
    storedSettings.set('devMode', enabled);
    if (window.DebugOverlay) {
      enabled ? window.DebugOverlay.enable() : window.DebugOverlay.disable();
    }
    return true;
  }

  function setRootAccess(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Root Access must be a boolean');
    if (enabled && storedSettings.get('devMode') !== true) {
      throw new Error('Developer Mode must be enabled before Root Access');
    }
    storedSettings.set('rootAccessEnabled', enabled);
    return true;
  }

  function exportSnapshot() {
    const settings = JSON.parse(JSON.stringify(storedSettings._cache || {}));
    for (const key of protectedImportKeys) delete settings[key];
    return settings;
  }

  async function importSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Imported settings must be an object');
    }
    const knownKeys = new Set([
      ...Object.keys(storedSettings.defaults || {}),
      ...Object.keys(storedSettings._cache || {}),
    ]);
    const accepted = [];
    const skipped = [];
    for (const [key, value] of Object.entries(input)) {
      if (protectedImportKeys.has(key)) {
        skipped.push(key);
        continue;
      }
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !knownKeys.has(key)) {
        skipped.push(key);
        continue;
      }
      const validator = validators.get(key);
      if (validator && !validator(value)) {
        skipped.push(key);
        continue;
      }
      let serialized;
      try {
        serialized = JSON.stringify(value);
      } catch {
        skipped.push(key);
        continue;
      }
      if (serialized === undefined || serialized.length > 5_500_000) {
        skipped.push(key);
        continue;
      }
      accepted.push([key, value]);
    }

    // Every import lands through storedSettings.set — registry-backed since
    // the settings shim became the persistence path, so imported values are
    // committed to their hive (atomic + audited) and fanned out through
    // 'settings:changed' exactly like a manual change.
    const imported = [];
    for (const [key, value] of accepted) {
      if (validators.has(key)) {
        if (set(key, value) === false) {
          skipped.push(key);
          continue;
        }
      } else {
        storedSettings.set(key, value);
      }
      imported.push(key);
    }
    OS.events.emit('settings:changed', { key: null, value: null, bulk: true });
    return { imported, skipped };
  }

  function readOptionalFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }

  function listDirectory(directory) {
    try {
      return fs.readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
  }

  function getDriver(devicePath) {
    try {
      return pathBasename(fs.realpathSync(`${devicePath}/driver`));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }

  function pathBasename(filePath) {
    return require('path').basename(filePath);
  }

  function getGraphicsDevices() {
    return listDirectory('/sys/class/drm')
      .filter(name => /^card\d+$/.test(name))
      .map(name => {
        const devicePath = `/sys/class/drm/${name}/device`;
        const vendorId = readOptionalFile(`${devicePath}/vendor`);
        return {
          id: name,
          driver: getDriver(devicePath),
          vendorId,
          deviceId: readOptionalFile(`${devicePath}/device`),
          vendor: vendorId?.toLowerCase() === '0x15ad' ? 'VMware' : null,
        };
      });
  }

  function getNetworkAdapters() {
    return listDirectory('/sys/class/net')
      .filter(name => name !== 'lo')
      .map(name => {
        const devicePath = `/sys/class/net/${name}/device`;
        const wireless = fs.existsSync(`/sys/class/net/${name}/wireless`);
        return {
          name,
          type: wireless ? 'wifi' : 'ethernet-or-other',
          state: readOptionalFile(`/sys/class/net/${name}/operstate`),
          driver: getDriver(devicePath),
        };
      });
  }

  function getAudioDevices() {
    const cards = readOptionalFile('/proc/asound/cards');
    if (!cards) return [];
    return cards.split(/\r?\n/)
      .map(line => /^\s*(\d+)\s+\[([^\]]+)\s*\]:\s*(.+)$/.exec(line))
      .filter(Boolean)
      .map(match => ({ id: Number(match[1]), name: match[3].trim() }));
  }

  function getVmwareToolsStatus(isVmware) {
    if (!isVmware) return { installed: false, running: false, displayResize: false };
    const installed = fs.existsSync('/usr/bin/vmtoolsd') &&
      fs.existsSync('/usr/bin/vmware-checkvm');
    const pid = readOptionalFile('/run/vmtoolsd.pid');
    const processName = pid && /^\d+$/.test(pid)
      ? readOptionalFile(`/proc/${pid}/comm`)
      : null;
    const running = processName === 'vmtoolsd';
    const graphics = getGraphicsDevices();
    return {
      installed,
      running,
    };
  }

  function getHardwareInventory() {
    if (typeof process === 'undefined' || process.platform !== 'linux') {
      return {
        supported: false,
        reason: 'Hardware inventory is currently available only in the NBOSP Linux guest.',
      };
    }

    const systemVendor = readOptionalFile('/sys/class/dmi/id/sys_vendor');
    const graphics = getGraphicsDevices();
    const vmware = systemVendor?.toLowerCase().includes('vmware') === true ||
      graphics.some(device => device.vendor === 'VMware');

    return {
      supported: true,
      platform: process.platform,
      architecture: process.arch,
      virtualization: {
        detected: vmware,
        vendor: vmware ? 'VMware' : null,
      },
      cpu: {
        model: os.cpus()[0]?.model || null,
        logicalCores: os.cpus().length,
      },
      memory: { totalBytes: os.totalmem() },
      graphics,
      network: getNetworkAdapters(),
      audio: getAudioDevices(),
      vmwareTools: getVmwareToolsStatus(vmware),
      display: {
        resolution: typeof screen !== 'undefined' ? {
          width: screen.width,
          height: screen.height,
        } : null,
        resolutionSource: 'current guest display mode',
      },
    };
  }

  function getConnectivityBackend() {
    const backend = window.NovaConnectivity;
    if (!backend) throw new Error('Network and Bluetooth hardware backend is unavailable');
    return backend;
  }

  const network = Object.freeze(Object.fromEntries([
    'getStatus', 'getWifiNetworks', 'setNetworkingEnabled', 'setWifiEnabled',
    'connectWifi', 'disconnectWifi', 'setBluetoothEnabled', 'scanBluetooth',
    'pairBluetooth', 'connectBluetooth', 'disconnectBluetooth', 'forgetBluetooth',
  ].map(method => [method, (...args) => {
    const backend = getConnectivityBackend();
    if (typeof backend[method] !== 'function') {
      throw new Error(`Network and Bluetooth backend does not support ${method}`);
    }
    return backend[method](...args);
  }])));

  async function runPowerAction(action) {
    if (action !== 'restart' && action !== 'poweroff') {
      throw new TypeError('Unsupported system power action');
    }
    if (typeof process === 'undefined' || process.platform !== 'linux') {
      throw new Error('System power actions are available only in the NBOSP Linux guest');
    }
    return new Promise((resolve, reject) => {
      require('child_process').execFile(
        '/usr/bin/nbosp-power',
        [action],
        { timeout: 15000 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message).trim();
            reject(new Error(detail || `System ${action} failed`, { cause: error }));
            return;
          }
          resolve(true);
        }
      );
    });
  }

  const power = Object.freeze({
    restart: () => runPowerAction('restart'),
    powerOff: () => runPowerAction('poweroff'),
  });

  const api = Object.freeze({
    id: appId,
    settings: Object.freeze({ get, set, exportSnapshot, import: importSettings }),
    security: Object.freeze({ setLockPin: value => setCredential('lockPin', value) }),
    developer: Object.freeze({ setMode: setDeveloperMode, setRootAccess }),
    hardware: Object.freeze({
      getInventory: getHardwareInventory,
      network,
      power,
    }),
  });
  window.NovaByteSystem = api;
  console.info('[NovaByteSystem] System control plane ready');
})();
