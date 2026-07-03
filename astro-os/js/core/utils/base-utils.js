'use strict';

// base-utils.js — shared utilities for the flat-module architecture.
// Every public function below is also attached to window.* at the bottom of
// the file so other scripts can call them without an ES module loader.
//
// Design notes:
// - The file is loaded as a classic <script>, so top-level function and class
//   declarations already become properties of window. The explicit assignments
//   at the end are documentation of the intended public surface.
// - DOM access is feature-detected so the file can be imported in Node/jsdom
//   for testing without throwing at parse time.
// - Hot paths (HTML escaping, icon lookup) avoid per-call allocation.

(function () {
  const hasDocument = (typeof document !== 'undefined') && (typeof document.createElement === 'function');
  const hasWindow = (typeof window !== 'undefined');
  const hasRAF = (typeof requestAnimationFrame === 'function');
  const hasCAF = (typeof cancelAnimationFrame === 'function');

  // Pooled element used by the DOM-based escapers. Allocating a fresh <div>
  // on every escape call shows up in profiles when escapeText is called inside
  // list-render loops; one shared element is enough because we only read
  // innerHTML back synchronously.
  const escaperEl = hasDocument ? document.createElement('div') : null;

  // Module-level lookup tables. The original file rebuilt these objects on
  // every svgIcon call, which is both slow and forces the JS engine to keep
  // a fresh object alive for the lifetime of the returned HTML string.
  const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']);
  const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const MONTH_NAMES = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

  // Inline SVG paths for the small UI icon set. These return crisp scalable
  // SVGs with no extra HTTP request, so they are checked first.
  const UI_ICONS = Object.freeze({
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'minus': '<line x1="5" y1="12" x2="19" y2="12"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    'corner-up-left': '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    'corner-up-right': '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
    'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'minimize-2': '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>',
    'align-left': '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
    'align-center': '<line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/>',
    'align-right': '<line x1="21" y1="7" x2="3" y2="7"/><line x1="21" y1="17" x2="3" y2="17"/><line x1="21" y1="12" x2="3" y2="12"/>',
    'square': '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    'layout': '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    'skip-back': '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
    'skip-forward': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
    'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
  });

  // Aliases for icons that are served as PNGs from /assets/icons8-*.png.
  // Names that already resolve via UI_ICONS or ICON_SPECIAL above are omitted
  // here because they would be unreachable.
  const ICON_MAP = Object.freeze({
    'folder-open': 'safe',
    'pen-tool': 'pen',
    'globe': 'globe',
    'music': 'music',
    'image': 'picture',
    'calendar': 'calendar',
    'mail': 'mail',
    'monitor': 'monitor',
    'settings': 'gear',
    'alarm-clock': 'alarm-clock',
    'bell': 'bell',
    'shield': 'shield',
    'sliders': 'adjust',
    'users': 'people',
    'wifi': 'wi-fi',
    'clock': 'calendar',
    'database': 'server',
    'terminal': 'command-line',
    'trash': 'trash',
    'trash-2': 'trash',
    'folder': 'opened-folder',
    'file': 'document',
    'file-text': 'document',
    'document': 'document',
    'play': 'play',
    'volume-2': 'sound',
    'archive': 'archive',
    'search': 'magnifying-glass',
    'download': 'download',
    'save': 'save',
    'copy': 'copy',
    'star': 'star',
    'star-filled': 'rating',
    'rating': 'rating',
    'favorite': 'rating',
    'bookmark-filled': 'rating',
    'bookmark': 'bookmark',
    'refresh': 'refresh',
    'maximize': 'fullscreen',
    'info': 'info',
    'eye': 'eye',
    'zap': 'lightning',
    'tag': 'tag',
    'edit-3': 'edit',
    'edit-pencil': 'edit-pencil',
    'edit-property': 'edit-property',
    'filter': 'filter',
    'bar-chart-2': 'bar-chart',
    'list-ordered': 'numbered-list',
    'message-square': 'chat',
    'check-circle': 'checkmark',
    'check-square': 'checkmark',
    'x-circle': 'cancel',
    'keyboard': 'keyboard',
    'layers': 'layers',
    'clipboard-list': 'paste',
    'clip-board': 'paste',
    'clipboard': 'paste',
    'paste': 'paste',
    'user': 'profile',
    'groups': 'people',
    'key': 'key',
    'hard-drive': 'database',
    'attention': 'info',
    'alert-triangle': 'info',
    'lock': 'lock',
    'plus-math': 'plus-math',
    'add': 'plus-math',
    'cpu': 'processor',
    'processor': 'processor',
    'command-line': 'command-line',
    'console': 'command-line',
    'administrative-tools': 'document',
    'maintenance': 'document',
    'registry-editor': 'document',
    'quill-pen': 'pen',
    'pen': 'pen',
    'reading-book-and-apple': 'document',
    'incognito': 'incognito',
    'gamepad-2': 'dice',
    'box': 'dice',
    'circle': 'dice',
    'bomb': 'bomb',
    'clover': 'clover',
    'timer': 'counter',
    'wallet': 'wallet',
    'file-code': 'document',
    'palette': 'color-palette',
    'type': 'quote',
    'qr-code': 'qr-code',
    'metronome': 'counter',
    'binary': 'barcode',
    'hash': 'barcode',
    'regex': 'document',
    'text': 'quote',
    'diff': 'layers',
    'briefcase': 'briefcase',
    'list': 'document',
    'move': 'arrow-right',
    'shuffle': 'shuffle-96',
    'repeat': 'repeat'
  });

  // Icons that need a non-standard PNG filename suffix. Checked before
  // ICON_MAP so the special path wins when present.
  const ICON_SPECIAL = Object.freeze({
    'shuffle': 'shuffle-96',
    'repeat': 'repeat-button-96',
    'pause': 'pause-96'
  });

  // Cache of already-rendered icon HTML keyed by `${name}|${size}`. The output
  // of svgIcon is a pure function of its inputs, so memoising it avoids both
  // repeated string concatenation and repeated Map lookups for the common
  // case of rendering the same icon many times in a list.
  const iconCache = new Map();
  const ICON_CACHE_LIMIT = 500;

  // Structured error type for the arithmetic evaluator. Callers can use
  // `err instanceof ArithmeticError` (or the cross-realm-safe `Error.isError`
  // plus name check) to distinguish parse failures from other thrown errors.
  class ArithmeticError extends Error {
    constructor(message, { position, input } = {}) {
      super(message);
      this.name = 'ArithmeticError';
      if (position !== undefined) this.position = position;
      if (input !== undefined) this.input = input;
    }
  }

  // --- Internal helpers ---------------------------------------------------

  // Canonical HTML escaper. Uses the DOM when available because it correctly
  // handles characters the regex would miss (NBSP -> &nbsp;, etc.). Falls back
  // to a regex in non-DOM environments. Always escapes the five characters
  // that matter for text content and both single- and double-quoted
  // attributes: & < > " '. The DOM only escapes four of those (and jsdom
  // escapes none of ", '), so we force-escape " and ' afterwards for
  // cross-browser consistency.
  function domEscape(value) {
    const s = String(value);
    if (!escaperEl) {
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    escaperEl.textContent = s;
    return escaperEl.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Coerce a size argument for svgIcon into a safe positive number. The
  // original code used `size || 18`, which kept negative numbers and string
  // values that would later be interpolated raw into HTML.
  function coerceIconSize(size) {
    const n = Number(size);
    if (Number.isFinite(n) && n > 0) return n;
    return 18;
  }

  // One-time delegated listener that hides <img data-hide-on-error> elements
  // when their src fails to load. This replaces the inline onerror handlers
  // the original file embedded in every svgIcon output, which were both a
  // CSP violation (script-src 'unsafe-inline') and an unnecessary per-image
  // attribute. The visual outcome is identical: broken icons disappear.
  function installHideOnErrorListener() {
    if (!hasWindow || !hasDocument) return;
    if (window.__baseUtilsHideOnErrorInstalled) return;
    window.__baseUtilsHideOnErrorInstalled = true;
    // Capture phase: error events on <img> do not bubble.
    document.addEventListener('error', (event) => {
      const target = event.target;
      if (target && target.tagName === 'IMG' && target.hasAttribute('data-hide-on-error')) {
        target.style.visibility = 'hidden';
      }
    }, true);
  }

  // --- Public functions ---------------------------------------------------

  // Generate a UUID. Prefers the native crypto.randomUUID for cryptographic
  // quality; falls back to a Math.random-based RFC 4122 v4 layout for
  // non-secure contexts (e.g. HTTP, sandboxed iframes without crypto).
  function generateId() {
    if (hasWindow && window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Escape a value for safe insertion as HTML text or attribute value.
  // Treats null/undefined as empty string; everything else is stringified.
  function sanitiseHTML(str) {
    if (str == null) return '';
    return domEscape(str);
  }

  // String-only variant kept for backward compatibility with existing
  // callers. Non-strings return empty string.
  function escapeText(str) {
    if (typeof str !== 'string') return '';
    return domEscape(str);
  }

  // Regex-only escaper for cases where the caller already knows the input is
  // a primitive. Same five-character escape set as domEscape.
  function escapeHtml(s) {
    return domEscape(s);
  }

  // Evaluate a string containing + - * / % and parentheses without ever
  // calling eval or new Function. Throws ArithmeticError on any parse or
  // runtime failure (unbalanced parens, divide-by-zero producing Infinity,
  // input too long, nesting too deep).
  function safeEvaluateArithmetic(input) {
    if (input == null) {
      throw new ArithmeticError('Input is required');
    }
    const source = String(input).replace(/\s+/g, '');
    if (source.length === 0) {
      throw new ArithmeticError('Empty expression', { input: String(input) });
    }
    if (source.length > 10000) {
      throw new ArithmeticError('Expression too long (max 10000 chars)', { input: String(input) });
    }

    let pos = 0;
    let depth = 0;
    const MAX_DEPTH = 200;

    function consume(ch) {
      if (source[pos] === ch) {
        pos += 1;
        return true;
      }
      return false;
    }

    function parseNumber() {
      const start = pos;
      let sawDigit = false;
      let sawDot = false;
      while (pos < source.length) {
        const ch = source[pos];
        if (ch >= '0' && ch <= '9') {
          sawDigit = true;
          pos += 1;
        } else if (ch === '.' && !sawDot) {
          sawDot = true;
          pos += 1;
        } else {
          break;
        }
      }
      if (!sawDigit) {
        throw new ArithmeticError('Expected number', { position: pos, input: source });
      }
      return Number(source.slice(start, pos));
    }

    function parsePrimary() {
      depth += 1;
      if (depth > MAX_DEPTH) {
        throw new ArithmeticError('Expression nested too deeply', { position: pos, input: source });
      }
      try {
        // Iterate unary +/- instead of recursing so that arbitrarily long
        // chains like "+++++++1" do not blow the stack.
        let sign = 1;
        for (;;) {
          if (consume('+')) continue;
          if (consume('-')) { sign = -sign; continue; }
          break;
        }
        if (consume('(')) {
          const value = parseAddSub();
          if (!consume(')')) {
            throw new ArithmeticError('Expected )', { position: pos, input: source });
          }
          return sign * value;
        }
        return sign * parseNumber();
      } finally {
        depth -= 1;
      }
    }

    function parseMulDiv() {
      let left = parsePrimary();
      while (pos < source.length) {
        if (consume('*')) {
          left *= parsePrimary();
        } else if (consume('/')) {
          left /= parsePrimary();
        } else if (consume('%')) {
          left %= parsePrimary();
        } else {
          break;
        }
      }
      return left;
    }

    function parseAddSub() {
      let left = parseMulDiv();
      while (pos < source.length) {
        if (consume('+')) {
          left += parseMulDiv();
        } else if (consume('-')) {
          left -= parseMulDiv();
        } else {
          break;
        }
      }
      return left;
    }

    const value = parseAddSub();
    if (pos !== source.length) {
      throw new ArithmeticError('Unexpected trailing token', { position: pos, input: source });
    }
    if (!Number.isFinite(value)) {
      throw new ArithmeticError('Result is not finite (divide by zero?)', { input: source });
    }
    return value;
  }

  // Best-effort browser detection. Uses navigator.userAgentData.brands when
  // available, then falls back to UA-string sniffing with the ordering bugs
  // from the original fixed (Opera and Brave are now checked before Chrome).
  // Returns one of: Edge, Brave, Chrome, Firefox, Safari, Opera, Chromium,
  // Unknown.
  function detectBrowser() {
    // User-Agent Client Hints are the modern, less-spoofable path.
    const uaData = (typeof navigator !== 'undefined') ? navigator.userAgentData : null;
    if (uaData && Array.isArray(uaData.brands)) {
      const brands = uaData.brands.map((b) => b.brand.toLowerCase());
      if (brands.includes('microsoft edge')) return 'Edge';
      if (brands.includes('opera')) return 'Opera';
      if (brands.includes('brave')) return 'Brave';
      if (brands.includes('chromium')) return 'Chromium';
      if (brands.includes('google chrome')) return 'Chrome';
    }

    // Brave is detectable via navigator.brave (an async boolean). We can't
    // await here, so we accept the synchronous shape and skip if it is a
    // promise — the UA string never contains "Brave/".
    if (typeof navigator !== 'undefined' && typeof navigator.brave === 'object' && navigator.brave !== null && typeof navigator.brave.isBrave === 'function') {
      // navigator.brave.isBrave() resolves to true on Brave. We cannot wait,
      // but its mere presence is a strong signal.
      return 'Brave';
    }

    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';

    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
    if (ua.includes('Brave/')) return 'Brave';
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Chrome/') && !ua.includes('Chromium/')) return 'Chrome';
    if (ua.includes('Chromium/')) return 'Chromium';
    // Safari's UA contains "Safari/" but also "Chrome/" when spoofing; the
    // Chrome branch above already filtered that out.
    if (ua.includes('Safari/')) return 'Safari';

    return 'Unknown';
  }

  // Format a byte count into a human-readable string with binary units
  // (1024-based). Handles zero, negatives, and values larger than 1 YB
  // without producing "NaN undefined".
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n)) {
      throw new TypeError('formatBytes: expected a finite number, got ' + String(bytes));
    }
    if (n === 0) return '0 B';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const k = 1024;
    const i = Math.min(Math.floor(Math.log(abs) / Math.log(k)), BYTE_UNITS.length - 1);
    return sign + parseFloat((abs / Math.pow(k, i)).toFixed(1)) + ' ' + BYTE_UNITS[i];
  }

  // Cross-realm Date validator. `instanceof Date` fails for dates created in
  // a different realm (iframes, jsdom tests), so we use the toString tag and
  // check the time is not NaN.
  function isValidDate(value) {
    if (value == null || typeof value !== 'object') return false;
    if (Object.prototype.toString.call(value) !== '[object Date]') return false;
    return !Number.isNaN(value.getTime());
  }

  // Format a Date as HH:MM (24h) or H:MM AM/PM (12h), honouring the
  // clockFormat setting from the global OS object when present.
  function formatTime(date) {
    if (!isValidDate(date)) {
      throw new TypeError('formatTime: expected a valid Date');
    }
    const h = date.getHours();
    const m = date.getMinutes();
    const use24 = (typeof OS !== 'undefined')
      && OS
      && OS.settings
      && typeof OS.settings.get === 'function'
      && OS.settings.get('clockFormat') === '24h';
    if (use24) {
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
    const h12 = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  // Format a Date as "Wed 5 Jun".
  function formatDate(date) {
    if (!isValidDate(date)) {
      throw new TypeError('formatDate: expected a valid Date');
    }
    return DAY_NAMES[date.getDay()] + ' ' + date.getDate() + ' ' + MONTH_NAMES[date.getMonth()];
  }

  // Debounce fn by ms milliseconds. The returned function exposes .cancel()
  // (drop pending call) and .flush() (fire pending call immediately) so
  // callers can clean up on unmount or before navigation. Preserves `this`
  // and arguments of the most recent invocation.
  function debounce(fn, ms) {
    let timer = null;
    let pendingArgs = null;
    let pendingThis = null;

    function fire() {
      timer = null;
      const args = pendingArgs;
      const thisArg = pendingThis;
      pendingArgs = null;
      pendingThis = null;
      fn.apply(thisArg, args);
    }

    function debounced(...args) {
      pendingArgs = args;
      pendingThis = this;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, ms);
    }

    debounced.cancel = function cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
      pendingThis = null;
    };

    debounced.flush = function flush() {
      if (timer !== null) {
        clearTimeout(timer);
        fire();
      }
    };

    return debounced;
  }

  // Throttle fn to one invocation per animation frame. Uses the latest
  // arguments and `this` (the original used the first call's arguments,
  // which gave stale scroll positions for scroll handlers). Exposes .cancel()
  // to drop a pending frame. Falls back to setTimeout(16ms) when RAF is
  // unavailable (SSR, jsdom).
  function throttleRAF(fn) {
    const scheduleFrame = hasRAF ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const cancelFrame = hasCAF ? cancelAnimationFrame : clearTimeout;

    let scheduledId = null;
    let pendingArgs = null;
    let pendingThis = null;

    function run() {
      scheduledId = null;
      const args = pendingArgs;
      const thisArg = pendingThis;
      pendingArgs = null;
      pendingThis = null;
      fn.apply(thisArg, args);
    }

    function throttled(...args) {
      pendingArgs = args;
      pendingThis = this;
      if (scheduledId !== null) return;
      scheduledId = scheduleFrame(run);
    }

    throttled.cancel = function cancel() {
      if (scheduledId !== null) {
        cancelFrame(scheduledId);
        scheduledId = null;
      }
      pendingArgs = null;
      pendingThis = null;
    };

    return throttled;
  }

  // Best-effort localStorage write. Operational storage failures (quota,
  // private mode, disabled storage) are swallowed because the app must
  // continue. Programmer errors (bad key, non-serialisable value) are
  // rethrown so they surface during development. If the AppDirs VFS sync
  // helper exists, it is invoked fire-and-forget so a slow sync never blocks
  // the caller.
  function lsSave(key, value) {
    const stored = typeof value === 'string' ? value : JSON.stringify(value);

    try {
      localStorage.setItem(key, stored);
    } catch (err) {
      const isStorageError = err instanceof DOMException && (
        err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.name === 'SecurityError'
      );
      if (isStorageError) {
        // Best-effort: log and continue. The app degrades gracefully when
        // persistence is unavailable.
        if (hasWindow && window.console && typeof window.console.warn === 'function') {
          console.warn('lsSave: storage unavailable (' + err.name + ') for key ' + key);
        }
        return;
      }
      throw err;
    }

    if (hasWindow && window.AppDirs && window.AppDirs.vfsFolders && typeof window.AppDirs.syncKey === 'function') {
      try {
        const maybePromise = window.AppDirs.syncKey(key, value);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => { /* sync is best-effort */ });
        }
      } catch (_) {
        // Synchronous failure setting up the sync — ignore.
      }
    }
  }

  // Tiny DOM builder. Supports className/class, textContent, style (object
  // or string), on* event handlers, boolean attributes, and arbitrary
  // attributes. Uses setAttribute('class', ...) so the same call works for
  // HTML and SVG elements (el.className is read-only on SVG).
  function createEl(tag, attrs, children) {
    const el = document.createElement(tag);

    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null) continue;

        if (key === 'className' || key === 'class') {
          el.setAttribute('class', value);
        } else if (key === 'textContent') {
          el.textContent = value;
        } else if (key === 'style') {
          if (typeof value === 'object') {
            Object.assign(el.style, value);
          } else {
            el.style.cssText = String(value);
          }
        } else if (key === 'dataset' && typeof value === 'object') {
          for (const [dk, dv] of Object.entries(value)) {
            el.dataset[dk] = dv;
          }
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (typeof value === 'boolean') {
          if (value) el.setAttribute(key, '');
          else el.removeAttribute(key);
        } else {
          el.setAttribute(key, value);
        }
      }
    }

    if (children != null) {
      if (Array.isArray(children)) {
        // Batch appends via a fragment so we trigger a single reflow.
        const frag = document.createDocumentFragment();
        for (const child of children) {
          // Preserve original falsy-skip behaviour so visuals stay identical
          // for callers that pass sparse arrays.
          if (!child && child !== 0) continue;
          if (typeof child === 'string' || typeof child === 'number') {
            frag.appendChild(document.createTextNode(String(child)));
          } else if (child instanceof Node) {
            frag.appendChild(child);
          }
          // else: silently skip unknown types — matches original behaviour.
        }
        el.appendChild(frag);
      } else if (typeof children === 'string' || typeof children === 'number') {
        el.textContent = String(children);
      } else if (children instanceof Node) {
        el.appendChild(children);
      } else {
        // Unknown child type — coerce to string for safety.
        el.textContent = String(children);
      }
    }

    return el;
  }

  // Return HTML markup for an icon. Three cases:
  //   1. Inline SVG (UI_ICONS) — scalable, no HTTP request.
  //   2. data: URL — escaped and embedded as <img>.
  //   3. icons8 PNG — fallback for the broad icon set.
  //
  // All <img> output uses data-hide-on-error instead of an inline onerror
  // handler so the file is CSP-compliant (script-src without 'unsafe-inline').
  function svgIcon(name, size) {
    const safeSize = coerceIconSize(size);

    if (typeof name === 'string' && name.startsWith('data:')) {
      // Escape characters that would break out of the src attribute. Valid
      // data: URLs never contain raw " or <, but we defend against malformed
      // input.
      const safeSrc = String(name)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
      return '<img src="' + safeSrc + '" width="' + safeSize + '" height="' + safeSize +
        '" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;"' +
        ' draggable="false" alt="" aria-hidden="true" data-hide-on-error>';
    }

    const cacheKey = name + '|' + safeSize;
    const cached = iconCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let html;
    if (UI_ICONS[name]) {
      html = '<svg width="' + safeSize + '" height="' + safeSize +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
        ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
        UI_ICONS[name] + '</svg>';
    } else {
      const iconMap = {
        'folder-open': 'safe', 'pen-tool': 'pen', 'novashell': 'console',
        'globe': 'globe', 'music': 'music', 'image': 'picture',
        'calendar': 'calendar', 'mail': 'mail', 'monitor': 'monitor',
        'settings': 'gear', 'alarm-clock': 'alarm-clock', 'bell': 'bell',
        'shield': 'shield', 'sliders': 'adjust', 'users': 'people',
        'wifi': 'wi-fi', 'clock': 'calendar', 'database': 'server',
        'terminal': 'command-line', 'trash': 'trash', 'trash-2': 'trash',
        'folder': 'opened-folder', 'file': 'document', 'file-text': 'document',
        'document': 'document', 'play': 'play', 'volume-2': 'sound',
        'archive': 'archive', 'search': 'magnifying-glass', 'download': 'download',
        'save': 'save', 'copy': 'copy', 'star': 'star', 'star-filled': 'rating',
        'rating': 'rating', 'favorite': 'rating', 'bookmark-filled': 'rating',
        'bookmark': 'bookmark', 'refresh': 'refresh', 'maximize': 'fullscreen',
        'info': 'info', 'eye': 'eye', 'zap': 'lightning', 'tag': 'tag',
        'edit-3': 'edit', 'filter': 'filter', 'bar-chart-2': 'bar-chart',
        'list-ordered': 'numbered-list', 'message-square': 'chat',
        'check-circle': 'checkmark', 'check-square': 'checkmark',
        'x-circle': 'cancel', 'keyboard': 'keyboard', 'layers': 'layers',
        'clipboard-list': 'paste', 'clipboard': 'paste', 'user': 'profile',
        'groups': 'people', 'key': 'key', 'hard-drive': 'database',
        'attention': 'info', 'alert-triangle': 'info', 'lock': 'lock',
        'plus-math': 'plus-math', 'add': 'plus-math', 'cpu': 'processor',
        'processor': 'processor', 'command-line': 'command-line', 'console': 'console'
      };
      const msMap = {
        'folder-open': ['folder_open', '#1565C0'], 'pen-tool': ['edit_note', '#E65100'],
        'novashell': ['terminal', '#1B5E20'], 'terminal': ['terminal', '#1B5E20'],
        'globe': ['public', '#0277BD'], 'music': ['music_note', '#6A1B9A'],
        'image': ['photo', '#AD1457'], 'picture': ['photo', '#AD1457'],
        'calendar': ['calendar_month', '#0288D1'], 'mail': ['mail', '#1565C0'],
        'settings': ['settings', '#37474F'], 'gear': ['settings', '#37474F'],
        'alarm-clock': ['alarm', '#00695C'], 'clock': ['schedule', '#00695C'],
        'search': ['search', '#283593'], 'magnifying-glass': ['search', '#283593'],
        'users': ['group', '#00838F'], 'people': ['group', '#00838F'],
        'download': ['download', '#2E7D32'], 'table': ['calculate', '#F57F17'],
        'calculator': ['calculate', '#F57F17'], 'package': ['inventory_2', '#4527A0'],
        'store': ['apps', '#4527A0'], 'shop': ['apps', '#4527A0'],
        'monitor': ['computer', '#4A148C'], 'bell': ['notifications', '#B71C1C'],
        'shield': ['security', '#1A237E'], 'shield-check': ['verified_user', '#1A237E'],
        'key': ['key', '#4E342E'], 'database': ['storage', '#006064'],
        'server': ['storage', '#006064'], 'hdd': ['hard_drive', '#263238'],
        'cpu': ['memory', '#311B92'], 'processor': ['memory', '#311B92'],
        'wifi': ['wifi', '#01579B'], 'trash': ['delete', '#B71C1C'],
        'trash-2': ['delete', '#B71C1C'], 'folder': ['folder', '#1565C0'],
        'file': ['description', '#37474F'], 'file-text': ['description', '#37474F'],
        'document': ['description', '#37474F'], 'console': ['terminal', '#1B5E20'],
        'command-line': ['terminal', '#1B5E20'], 'safe': ['folder_open', '#1565C0'],
        'pen': ['edit_note', '#E65100'], 'activity-feed': ['monitoring', '#00695C'],
        'bar-chart': ['bar_chart', '#1565C0'], 'gamepad-2': ['sports_esports', '#6A1B9A'],
        'bomb': ['crisis_alert', '#B71C1C'], 'clover': ['casino', '#2E7D32'],
        'timer': ['timer', '#00695C'], 'check-square': ['check_box', '#2E7D32'],
        'wallet': ['account_balance_wallet', '#E65100'], 'file-code': ['code', '#1B5E20'],
        'palette': ['palette', '#AD1457'], 'qr-code': ['qr_code', '#37474F'],
        'briefcase': ['work', '#4E342E'], 'sticky-note': ['sticky_note_2', '#F57F17'],
        'book-open': ['menu_book', '#1565C0'], 'layers': ['layers', '#283593'],
        'idea': ['lightbulb', '#F57F17'], 'box': ['inventory_2', '#4527A0'],
        'dice': ['casino', '#6A1B9A']
      };
      const [msName, tileColor] = msMap[name] || msMap[iconMap[name]] || ['apps', '#37474F'];
      if (safeSize >= 32) {
        const r = Math.round(safeSize * 0.22);
        const fs = Math.round(safeSize * 0.54);
        html = '<span style="display:inline-flex;align-items:center;justify-content:center;width:' + safeSize + 'px;height:' + safeSize + 'px;background:' + tileColor + ';border-radius:' + r + 'px;flex-shrink:0;" aria-hidden="true"><span class="material-symbols-rounded" style="font-size:' + fs + 'px;color:#fff;font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 48;line-height:1;">' + msName + '</span></span>';
      } else {
        html = '<span class="material-symbols-rounded" style="font-size:' + safeSize + 'px;color:' + tileColor + ';font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 20;line-height:1;vertical-align:middle;" aria-hidden="true">' + msName + '</span>';
      }
    }

    if (iconCache.size < ICON_CACHE_LIMIT) {
      iconCache.set(cacheKey, html);
    }
    return html;
  }

  // Install the delegated error listener on first script load. Idempotent
  // across multiple inclusions of this file on the same page.
  installHideOnErrorListener();

  // --- Public surface -----------------------------------------------------
  // Every function above is also assigned to window here so the intended
  // public API is explicit, and so the file remains usable if it is ever
  // migrated to an ES module wrapper (where top-level declarations would no
  // longer auto-attach to window).
  if (hasWindow) {
    window.generateId = generateId;
    window.sanitiseHTML = sanitiseHTML;
    window.escapeText = escapeText;
    window.escapeHtml = escapeHtml;
    window.safeEvaluateArithmetic = safeEvaluateArithmetic;
    window.ArithmeticError = ArithmeticError;
    window.detectBrowser = detectBrowser;
    window.formatBytes = formatBytes;
    window.formatTime = formatTime;
    window.formatDate = formatDate;
    window.debounce = debounce;
    window.throttleRAF = throttleRAF;
    window.lsSave = lsSave;
    window.createEl = createEl;
    window.svgIcon = svgIcon;
  }
})();