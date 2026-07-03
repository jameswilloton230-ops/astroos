// NovaByte OS — Frame Security Manager
//
// Decides which <iframe> elements may receive Node.js access ("node
// frames") and validates that every other iframe is properly sandboxed.
// Runs a one-shot audit on demand and a MutationObserver that validates
// every iframe added to the DOM (or whose src / sandbox / nwdisable
// attribute changes) at any point after boot.
//
// Threat model: NW.js grants Node.js access to iframes loaded from
// trusted origins (https://localhost). A compromised page that escapes
// its sandbox can reach parent.document and strip the sandbox attribute,
// gaining full Node.js. This module mitigates by:
//   - restricting node-frame eligibility to https://localhost / 127.0.0.1
//   - forbidding blob:/data:/javascript:/file: from ever being node frames
//   - never applying allow-same-origin to sandboxed frames
//   - explicitly removing allow-same-origin when securifying a frame
//   - walking the full ancestor chain when checking nwdisable inheritance
//   - observing src / sandbox / nwdisable attribute changes, not just
//     newly-added iframes
//
// Public API (exposed as window.FrameSecurity):
//   isNodeRemoteUrl(url)                       → boolean
//   hasNwDisable(iframe)                       → boolean
//   isInWebview(iframe)                        → boolean
//   getFrameType(iframe)                       → 'node' | 'normal'
//   validateFrameSecurity(iframe)              → { valid, frameType, issues }
//   securifyFrame(iframe, frameType, options)  → iframe (mutated)
//     options.mode    — 'patch' (default) | 'replace'
//     options.exclude — passed via securifyAllFrames, not securifyFrame
//   securifyAllFrames(options)                 → { total, securified, skipped, errors }
//     options.mode    — 'patch' (default) | 'replace'
//     options.exclude — array of '#id' / '.class' / predicate(iframe) => boolean
//   auditAllFrames(verbose)                    → { total, nodeFrames, normalFrames, issues }
//   startObserver(options)                     — options: { autoSecurify, mode, exclude }
//   stopObserver()
//   getRecentIssues()                          → array of { time, iframe, type, problems }
//   getNodeRemotePatterns()                    → string[] (regex sources)
//
// Remediation model: detection is automatic; remediation is opt-in.
//   - auditAllFrames() and the observer detect issues.
//   - securifyFrame() / securifyAllFrames() fix issues explicitly.
//   - startObserver({ autoSecurify: true }) wires the observer to fix
//     what it finds. Default is false to preserve backwards compat;
//     production deployments should opt in.

(() => {
  'use strict';

  // If a previous instance of this module is already installed, stop
  // its observer before we install a new one. Prevents accumulated
  // observers when the file is re-evaluated (HMR, tests, OS hot-reload).
  if (typeof window !== 'undefined' && window.FrameSecurity?.stopObserver) {
    try {
      window.FrameSecurity.stopObserver();
    } catch {
      // Non-fatal — previous instance may already be torn down.
    }
  }

  // ---- Configuration ----

  // Only https:// to localhost / loopback may be a node frame.
  // http://, chrome-extension://, file://, etc. are rejected even
  // though NW.js would technically allow them — defence in depth.
  const NODE_REMOTE_PATTERNS = [
    /^https:\/\/localhost(:\d+)?\//,
    /^https:\/\/127\.0\.0\.1(:\d+)?\//,
  ];

  // Schemes that are ALWAYS normal frames regardless of URL content.
  // blob: / data: can carry arbitrary content; javascript: executes;
  // file: is local disk. None may receive Node.js access.
  const ALWAYS_NORMAL_SCHEMES = new Set([
    'blob:', 'data:', 'javascript:', 'file:',
  ]);

  // Sandbox tokens applied to normal frames. allow-same-origin is
  // intentionally absent — combining it with allow-scripts lets the
  // framed document reach parent.document and strip its own sandbox.
  const NORMAL_SANDBOX_TOKENS = 'allow-scripts allow-forms allow-modals allow-popups';

  // Cap the recent-issues ring buffer so a runaway observer can't
  // grow memory unbounded.
  const RECENT_ISSUES_MAX = 100;

  // ---- Pure helpers ----

  // True if the URL is https://localhost or https://127.0.0.1 (with an
  // optional port). Returns false for unparseable URLs, non-https
  // schemes, and the ALWAYS_NORMAL schemes.
  function isNodeRemoteUrl(urlString) {
    if (typeof urlString !== 'string') return false;
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return false;
    }
    if (ALWAYS_NORMAL_SCHEMES.has(url.protocol)) return false;
    if (url.protocol !== 'https:') return false;
    return NODE_REMOTE_PATTERNS.some((p) => p.test(urlString));
  }

  function hasNwDisable(iframe) {
    return Boolean(iframe && iframe.hasAttribute && iframe.hasAttribute('nwdisable'));
  }

  // True if the iframe has a sandbox attribute at all. This is NOT the
  // same as `iframe.sandbox.length > 0` — `sandbox=""` (empty string)
  // is the strictest possible sandbox (all restrictions apply) but
  // produces a length-0 DOMTokenList. The original code treated
  // `sandbox=""` as "not sandboxed" — a false-negative that let
  // fully-sandboxed iframes pass validation as "missing sandbox".
  function hasSandboxAttribute(iframe) {
    return Boolean(iframe && iframe.hasAttribute && iframe.hasAttribute('sandbox'));
  }

  // Returns true if the sandbox attribute contains the given token.
  // Prefers the DOMTokenList when available (real browsers); falls
  // back to parsing the attribute string for environments that don't
  // implement HTMLIFrameElement.sandbox as a DOMTokenList (jsdom,
  // minimal DOM implementations).
  function sandboxContains(iframe, token) {
    if (!iframe) return false;
    if (iframe.sandbox && typeof iframe.sandbox.contains === 'function') {
      return iframe.sandbox.contains(token);
    }
    const attr = iframe.getAttribute('sandbox');
    if (attr === null || attr === '') return false;
    return attr.trim().split(/\s+/).includes(token);
  }

  // Reads the current sandbox tokens as an array. Returns null if no
  // sandbox attribute is set at all, [] if it's set to empty string
  // (the strictest possible sandbox).
  function getSandboxTokens(iframe) {
    if (!hasSandboxAttribute(iframe)) return null;
    const attr = iframe.getAttribute('sandbox') || '';
    if (attr === '') return [];
    return attr.trim().split(/\s+/);
  }

  // Writes the sandbox attribute, preferring the DOMTokenList.value
  // setter when available so internal state stays consistent with the
  // attribute. Falls back to setAttribute for environments without a
  // DOMTokenList.
  function setSandboxValue(iframe, value) {
    if (iframe.sandbox && typeof iframe.sandbox.value !== 'undefined') {
      iframe.sandbox.value = value;
    } else {
      iframe.setAttribute('sandbox', value);
    }
  }

  // True if the iframe is nested anywhere inside a <webview> element.
  // <webview> is NW.js's external-host isolation primitive — content
  // inside it must never be a node frame.
  function isInWebview(iframe) {
    if (!iframe) return false;
    let parent = iframe.parentElement;
    while (parent) {
      if (parent.tagName === 'WEBVIEW') return true;
      parent = parent.parentElement;
    }
    return false;
  }

  // True if any ancestor <iframe> has nwdisable. A disabled ancestor
  // means the entire subtree is treated as normal — the original code
  // only checked the nearest parent iframe, missing deeply nested
  // cases like C inside B inside A where only A has nwdisable.
  function anyAncestorIframeDisabled(el) {
    let cur = el.parentElement;
    while (cur) {
      if (cur.tagName === 'IFRAME' && hasNwDisable(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ---- Frame type detection ----

  // A "node frame" requires ALL of:
  //   1. https://localhost or https://127.0.0.1 URL
  //   2. No nwdisable attribute on this iframe
  //   3. Not inside <webview>
  //   4. No ancestor <iframe> has nwdisable
  // Anything else is 'normal'.
  function getFrameType(iframe) {
    if (!iframe) return 'normal';

    const iframeUrl = iframe.src || '';

    // blob: / data: / file: / javascript: are always normal, even if
    // the URL somehow matches a node-remote pattern.
    try {
      const u = new URL(iframeUrl);
      if (ALWAYS_NORMAL_SCHEMES.has(u.protocol)) return 'normal';
    } catch {
      // Relative or empty URL — treat as normal.
    }

    if (hasNwDisable(iframe)) return 'normal';
    if (isInWebview(iframe)) return 'normal';
    if (anyAncestorIframeDisabled(iframe)) return 'normal';
    if (isNodeRemoteUrl(iframeUrl)) return 'node';

    return 'normal';
  }

  // ---- Validation ----

  // Returns { valid, frameType, issues }. `issues` is an array of
  // human-readable strings. `valid` is true iff issues is empty.
  // The shape is consistent for all inputs, including null iframes.
  function validateFrameSecurity(iframe) {
    if (!iframe) {
      return {
        valid: false,
        frameType: 'normal',
        issues: ['iframe element is null'],
      };
    }

    const issues = [];
    const frameType = getFrameType(iframe);
    const iframeUrl = iframe.src || '';
    const hasSandbox = hasSandboxAttribute(iframe);

    if (frameType === 'node') {
      // Node frames must NOT be sandboxed — the sandbox would block
      // the Node.js integration the frame exists to provide.
      if (hasSandbox) {
        issues.push('Node frame should not have sandbox restrictions');
      }
    } else if (iframeUrl) {
      // Normal frames with a src must be sandboxed. nwdisable alone
      // is not enough — it blocks Node.js access but does not restrict
      // script execution, so a third-party script could still run.
      if (!hasSandbox) {
        if (hasNwDisable(iframe)) {
          issues.push('nwdisable frame has no sandbox — scripts run unrestricted');
        } else {
          issues.push('Normal frame must have sandbox attribute');
        }
      } else if (sandboxContains(iframe, 'allow-same-origin')) {
        // allow-same-origin + allow-scripts is a known sandbox escape:
        // the framed document can call frameElement.removeAttribute
        // via parent.document, removing all restrictions.
        issues.push('Sandbox includes allow-same-origin — sandbox escape risk');
      }
    }

    return { valid: issues.length === 0, frameType, issues };
  }

  // ---- Securify ----

  // Forces an iframe into the correct security posture for its URL.
  //
  // mode:
  //   'patch' (default) — additive/subtractive. For normal URLs:
  //     adds nwdisable if missing, adds sandbox with NORMAL_SANDBOX_TOKENS
  //     if missing, removes allow-same-origin if present, PRESERVES all
  //     other caller-added tokens (allow-camera, allow-downloads, etc.).
  //     Safe for auto-remediation because it only changes what's wrong.
  //   'replace' — full overwrite. For normal URLs: sets sandbox to
  //     exactly NORMAL_SANDBOX_TOKENS, discarding any caller-added
  //     tokens. Use when you want a hard reset.
  //
  // For node-remote URLs, both modes do the same thing: strip sandbox
  // and nwdisable so the frame can use Node.js.
  //
  // The frameType argument is accepted for backwards compatibility
  // but the URL is the source of truth — a node-remote URL always
  // becomes a node frame regardless of what the caller passes.
  function securifyFrame(iframe, _frameType, { mode = 'patch' } = {}) {
    if (!iframe) return iframe;
    const iframeUrl = iframe.src || '';
    const shouldBeNodeFrame = isNodeRemoteUrl(iframeUrl);

    if (shouldBeNodeFrame) {
      iframe.removeAttribute('sandbox');
      iframe.removeAttribute('nwdisable');
      return iframe;
    }

    // Normal frame.
    if (!hasNwDisable(iframe)) {
      iframe.setAttribute('nwdisable', '');
    }

    if (mode === 'replace') {
      setSandboxValue(iframe, NORMAL_SANDBOX_TOKENS);
      return iframe;
    }

    // Patch mode. Preserve caller tokens, only fix what's wrong.
    const existing = getSandboxTokens(iframe);
    if (existing === null) {
      // No sandbox at all — apply the standard set.
      setSandboxValue(iframe, NORMAL_SANDBOX_TOKENS);
      return iframe;
    }

    const forbidden = 'allow-same-origin';
    const required = NORMAL_SANDBOX_TOKENS.split(/\s+/).filter(Boolean);
    const merged = new Set(existing);
    merged.delete(forbidden);
    for (const t of required) merged.add(t);
    setSandboxValue(iframe, Array.from(merged).join(' '));
    return iframe;
  }

  // Builds a predicate (iframe) => boolean that returns true for
  // iframes matching any entry in the exclude list. Entries can be:
  //   '#someId'       — match by id
  //   '.someClass'    — match by class (first match wins)
  //   'bareString'    — treated as an id for backwards-friendliness
  //   function(iframe) — custom predicate
  function buildExcludePredicate(exclude) {
    if (!exclude || exclude.length === 0) return () => false;
    const fns = exclude.map((entry) => {
      if (typeof entry === 'function') return entry;
      if (typeof entry !== 'string') return () => false;
      if (entry.startsWith('#')) {
        const id = entry.slice(1);
        return (iframe) => iframe.id === id;
      }
      if (entry.startsWith('.')) {
        const cls = entry.slice(1);
        return (iframe) =>
          Boolean(iframe.className) &&
          iframe.className.trim().split(/\s+/).includes(cls);
      }
      return (iframe) => iframe.id === entry;
    });
    return (iframe) => fns.some((fn) => fn(iframe));
  }

  // ---- Audit ----

  // Returns a short, non-sensitive identifier for an iframe. Never
  // logs the full src URL — it may contain tokens or paths. Prefers
  // id, then first class, then origin (protocol + hostname only).
  function safeId(iframe) {
    if (!iframe) return '<null>';
    if (iframe.id) return '#' + iframe.id;
    if (iframe.className) {
      const first = iframe.className.trim().split(/\s+/)[0];
      if (first) return '.' + first;
    }
    try {
      const u = new URL(iframe.src || '');
      // For blob: URLs the hostname is the originating origin; that's
      // acceptable to log. The UUID path component is dropped.
      return u.protocol + '//' + u.hostname;
    } catch {
      return '<no-src>';
    }
  }

  // Scans every <iframe> in the document and returns a summary. If
  // verbose is true, also logs the audit to the console.
  function auditAllFrames(verbose = false) {
    const iframes = document.querySelectorAll('iframe');
    const audit = {
      total: iframes.length,
      nodeFrames: 0,
      normalFrames: 0,
      issues: [],
    };

    iframes.forEach((iframe) => {
      const validation = validateFrameSecurity(iframe);
      if (validation.frameType === 'node') audit.nodeFrames++;
      else audit.normalFrames++;

      if (!validation.valid) {
        audit.issues.push({
          iframe: safeId(iframe),
          type: validation.frameType,
          problems: validation.issues,
        });
      }
    });

    if (verbose) console.log('[FrameSecurity] Audit Report:', audit);
    return audit;
  }

  // ---- Batch remediation ----

  // Validates every iframe in the document and calls securifyFrame on
  // each one with issues. Returns a summary:
  //   {
  //     total,                          — number of iframes scanned
  //     securified: [safeId, ...],      — iframes that were modified
  //     skipped:   [safeId, ...],       — matched exclude list
  //     errors:    [{ iframe, error }]  — securifyFrame threw
  //   }
  //
  // Options:
  //   mode    — 'patch' (default) or 'replace', passed to securifyFrame
  //   exclude — array of '#id' / '.class' / predicate(iframe). Matched
  //             iframes are validated but NOT modified.
  //
  // Already-valid iframes are silently skipped (not added to any list).
  function securifyAllFrames({ mode = 'patch', exclude = [] } = {}) {
    const excludePred = buildExcludePredicate(exclude);
    const iframes = document.querySelectorAll('iframe');
    const summary = {
      total: iframes.length,
      securified: [],
      skipped: [],
      errors: [],
    };

    iframes.forEach((iframe) => {
      const id = safeId(iframe);
      const validation = validateFrameSecurity(iframe);
      if (validation.valid) return;
      if (excludePred(iframe)) {
        summary.skipped.push(id);
        return;
      }
      try {
        securifyFrame(iframe, validation.frameType, { mode });
        summary.securified.push(id);
      } catch (err) {
        summary.errors.push({
          iframe: id,
          error: (err && err.message) ? err.message : String(err),
        });
      }
    });

    return summary;
  }

  // ---- Dynamic iframe observer ----

  let _observer = null;
  let _pending = null; // { iframes: Set<iframe>, scheduled: boolean }
  // Observer policy. Defaults to auto-securify insecure iframes on
  // detection; production deployments can call startObserver() with
  // autoSecurify: false to restore the original audit-only behaviour.
  let _autoSecurify = true;
  let _securifyMode = 'patch';
  let _excludePred = () => false;
  const _recentIssues = [];

  function recordIssue(iframe, validation) {
    _recentIssues.push({
      time: Date.now(),
      iframe: safeId(iframe),
      type: validation.frameType,
      problems: validation.issues,
    });
    if (_recentIssues.length > RECENT_ISSUES_MAX) {
      _recentIssues.shift();
    }
  }

  // Validates a single iframe. On failure: warns, records the issue,
  // and (if autoSecurify is enabled) calls securifyFrame to fix it.
  // Skips iframes in the exclude list. Called from the observer's
  // microtask flush.
  function validateAndReport(iframe) {
    if (!iframe || !iframe.isConnected) return;
    const v = validateFrameSecurity(iframe);
    if (v.valid) return;

    console.warn(
      '[FrameSecurity] Iframe security issue:',
      v.issues,
      safeId(iframe),
    );
    recordIssue(iframe, v);

    if (!_autoSecurify) return;
    if (_excludePred(iframe)) {
      console.info(
        '[FrameSecurity] Auto-securify skipped (excluded):',
        safeId(iframe),
      );
      return;
    }
    try {
      securifyFrame(iframe, v.frameType, { mode: _securifyMode });
      console.info(
        '[FrameSecurity] Auto-securified:',
        safeId(iframe),
        '(mode=' + _securifyMode + ')',
      );
      // Re-validate so the post-fix state is reflected in the recent
      // issues buffer. If securify didn't fully fix it (shouldn't
      // happen, but be defensive), the new issue is recorded too.
      const post = validateFrameSecurity(iframe);
      if (!post.valid) {
        console.warn(
          '[FrameSecurity] Iframe still invalid after securify:',
          post.issues,
          safeId(iframe),
        );
        recordIssue(iframe, post);
      }
    } catch (err) {
      console.error(
        '[FrameSecurity] Auto-securify failed:',
        safeId(iframe),
        err,
      );
    }
  }

  // Queues an iframe for validation. Multiple queues within the same
  // microtask batch are deduplicated by element identity — a single
  // DOM mutation that triggers several observer records for the same
  // iframe produces one warning, not several.
  function scheduleValidation(iframe) {
    if (!iframe) return;
    if (!_pending) {
      _pending = { iframes: new Set(), scheduled: false };
    }
    _pending.iframes.add(iframe);
    if (!_pending.scheduled) {
      _pending.scheduled = true;
      queueMicrotask(flushPending);
    }
  }

  function flushPending() {
    const batch = _pending;
    _pending = null;
    if (!batch) return;
    for (const iframe of batch.iframes) {
      validateAndReport(iframe);
    }
  }

  // Starts the MutationObserver. Options:
  //   autoSecurify (false) — when true, the observer calls securifyFrame
  //     on every iframe it detects with issues. Default false preserves
  //     the original audit-only behaviour; production should opt in.
  //   mode ('patch')      — passed to securifyFrame when autoSecurify is
  //     true. 'patch' preserves caller-added sandbox tokens; 'replace'
  //     overwrites them.
  //   exclude ([])         — array of '#id' / '.class' / predicate.
  //     Matched iframes are detected but NOT auto-securified. Useful
  //     for dev tools or apps that legitimately need a custom sandbox.
  //
  // Calling startObserver while already running is a no-op (the new
  // options are NOT applied). Call stopObserver first to reconfigure.
  function startObserver({ autoSecurify = false, mode = 'patch', exclude = [] } = {}) {
    if (_observer) return;
    if (typeof MutationObserver === 'undefined') return;

    _autoSecurify = Boolean(autoSecurify);
    _securifyMode = mode === 'replace' ? 'replace' : 'patch';
    _excludePred = buildExcludePredicate(exclude);

    const root = document.documentElement;
    if (!root) {
      // Document not ready — retry on DOMContentLoaded. Wrapped to
      // drop the event arg so startObserver doesn't misinterpret it
      // as an options bag.
      document.addEventListener('DOMContentLoaded', () => startObserver({}), {
        once: true,
      });
      return;
    }

    _observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue; // elements only
            if (node.tagName === 'IFRAME') {
              scheduleValidation(node);
            } else if (node.querySelectorAll) {
              // A subtree was added — check for nested iframes in
              // one query rather than walking manually.
              node.querySelectorAll('iframe').forEach(scheduleValidation);
            }
          }
        } else if (
          mutation.type === 'attributes' &&
          mutation.target &&
          mutation.target.tagName === 'IFRAME'
        ) {
          // src / nwdisable / sandbox changed on an existing iframe.
          // The original observer missed this — an attacker could
          // swap an iframe's src to a node-remote URL after the boot
          // audit and never be flagged.
          scheduleValidation(mutation.target);
        }
      }
    });

    _observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'nwdisable', 'sandbox'],
    });
  }

  function stopObserver() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    // Drop any pending batch so it doesn't fire after stop, and reset
    // policy so a future startObserver with new options takes effect.
    _pending = null;
    _autoSecurify = false;
    _securifyMode = 'patch';
    _excludePred = () => false;
  }

  // Returns a shallow copy of recently observer-detected issues
  // (newest last). Capped at RECENT_ISSUES_MAX entries so a chatty
  // page can't grow memory unbounded.
  function getRecentIssues() {
    return _recentIssues.slice();
  }

  // ---- Auto-start ----

  // The observer must be running before any iframes are added. Start
  // immediately if the DOM is ready, otherwise defer to DOMContentLoaded.
  // Auto-start uses default options (audit-only). Production code that
  // wants auto-remediation should call stopObserver() then
  // startObserver({ autoSecurify: true }) after this file loads.
  //
  // The DOMContentLoaded handler is wrapped to drop the event object —
  // startObserver destructures its first argument as an options bag, and
  // an Event would otherwise be misinterpreted as `{ autoSecurify: truthy }`.
  function autoStart() { startObserver(); }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoStart, {
        once: true,
      });
    } else {
      autoStart();
    }
  }

  // ---- Public API ----

  // Freeze the API surface so a malicious script can't replace
  // validateFrameSecurity with a no-op. New methods must be added in
  // this file, not via monkey-patching at runtime.
  const api = Object.freeze({
    isNodeRemoteUrl,
    hasNwDisable,
    isInWebview,
    getFrameType,
    validateFrameSecurity,
    securifyFrame,
    securifyAllFrames,
    auditAllFrames,
    startObserver,
    stopObserver,
    getRecentIssues,
    getNodeRemotePatterns: () => NODE_REMOTE_PATTERNS.map((p) => p.source),
  });

  if (typeof window !== 'undefined') {
    window.FrameSecurity = api;
  }
})();
