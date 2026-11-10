/**
 * NovaByte - Scanner
 * Barebones static-heuristic gate for untrusted file content before it's
 * written to FS or installed as an app. Not an AV engine — no signature DB,
 * no cloud lookups, no quarantine UI. Just cheap checks that catch the
 * common "disguised payload" tricks, run synchronously against the bytes
 * the browser already has in memory.
 *
 * Currently wired into:
 *   - Desktop / Files drag-and-drop (js/apps/shell-ui/wm.js, js/apps/com.nbosp.files.novaapp)
 *   - App Manager package install (js/apps/appmanager/app.js)
 *
 * Exposed globally as window.Scanner so any other app/feature can call into
 * it before trusting file content it receives from outside the OS.
 *
 * Usage: const verdict = await Scanner.scan(file);   // File/Blob
 *        if (!verdict.safe) { reject with verdict.reason }
 */
(function () {
  'use strict';

  // First few bytes of common binary/executable formats, keyed by the
  // extension a legitimate file of that type would carry. If a dropped
  // file's declared extension implies "not executable" but its header
  // matches one of these, it's lying about what it is.
  const MAGIC_SIGNATURES = [
    { bytes: [0x4d, 0x5a],                         label: 'Windows PE executable (MZ header)' },
    { bytes: [0x7f, 0x45, 0x4c, 0x46],              label: 'Linux ELF executable' },
    { bytes: [0xca, 0xfe, 0xba, 0xbe],              label: 'Mach-O / Java class (fat binary)' },
    { bytes: [0xfe, 0xed, 0xfa, 0xce],              label: 'Mach-O executable (32-bit)' },
    { bytes: [0xfe, 0xed, 0xfa, 0xcf],              label: 'Mach-O executable (64-bit)' },
    { bytes: [0x23, 0x21],                          label: 'shell script shebang (#!)' },
  ];

  // Extensions that are inherently executable/script content. Dropping
  // these directly is flagged; nothing here runs in this OS, so there's
  // no legitimate reason for one to land in the vault.
  const EXECUTABLE_EXTENSIONS = new Set([
    'exe', 'dll', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'wsf', 'wsh',
    'scr', 'msi', 'msp', 'jar', 'sh', 'bash', 'run', 'bin', 'app', 'command',
    'apk', 'jse', 'cpl', 'gadget',
  ]);

  // Extensions whose content gets *rendered* elsewhere in this OS (Quill,
  // Gallery, Browser preview, Email attachments-preview, etc). These are
  // allowed, but get scanned for embedded active content since an SVG or
  // HTML file can carry a script payload just like a .js file can.
  //
  // .txt is deliberately NOT in here even though it's user-facing content:
  // plain-text viewers render it as literal characters, never as markup —
  // there's no parser in the loop that would ever turn "<script>" typed in
  // a .txt file into a live element. Scanning it with markup patterns only
  // produces false positives on ordinary text ("javascript: the language",
  // a tutorial documenting onclick=, etc). If it ever becomes previewable
  // as HTML somewhere, move it back in.
  const RENDERED_TEXT_EXTENSIONS = new Set([
    'svg', 'html', 'htm', 'xhtml', 'xml', 'md',
  ]);

  // Renderers that parse embedded raw HTML out of otherwise-plain markup
  // (most Markdown renderers do this, XML with embedded HTML islands can
  // too) get the same narrower, attribute-aware treatment as real HTML —
  // a script tag or on*= handler inside these is just as live as it is in
  // an .html file, so it can't get the blanket SVG-style treatment either.
  const HTML_AWARE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'md']);

  // Patterns indicating embedded script / active content inside a file
  // that's nominally "just markup" (SVG/XML — no legitimate reason to ever
  // carry any of this). Kept intentionally small — this is a tripwire, not
  // a parser.
  const ACTIVE_CONTENT_PATTERNS = [
    { re: /<script\b/i,                      label: 'embedded <script> tag' },
    { re: /\son\w+\s*=\s*["']/i,             label: 'inline event handler (on*=)' },
    { re: /javascript:/i,                    label: 'javascript: URI' },
    { re: /<iframe\b/i,                      label: 'embedded <iframe>' }, // HTML-aware extensions get a narrower iframe check below; this stays blanket for svg/xml
    { re: /<object\b|<embed\b/i,             label: 'embedded <object>/<embed>' },
    { re: /data:text\/html/i,                label: 'data: HTML payload' },
  ];

  // .novaapp's own template pipeline (NovaByte Studio) always emits
  // index.html with <script src="app.js"></script> — a reference to a
  // sibling file, not inline code. Blanket-flagging any <script tag in
  // HTML (below, for svg/md/xml/txt) makes every standard .novaapp build
  // untrustable. HTML gets its own narrower rule instead: local
  // <script src="..."> references are fine, but inline <script>...</script>
  // content, and everything else in ACTIVE_CONTENT_PATTERNS (on*=,
  // javascript:, iframe, object/embed, data:text/html), still blocks.
  //
  // "Local" means a relative path with no scheme and no traversal out of
  // the package — not http(s)://, not //host-relative, not ../.. — so an
  // externally-hosted or path-escaping script src is still rejected.
  const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  function isLocalRelativeSrc(src) {
    if (!src) return false;
    const trimmed = src.trim();
    if (trimmed === '') return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false; // any scheme (http:, javascript:, data:, etc)
    if (trimmed.startsWith('//')) return false;              // protocol-relative
    if (trimmed.startsWith('/')) return false;                // absolute path, outside package root
    if (trimmed.split(/[/\\]/).includes('..')) return false;  // traversal
    return true;
  }

  // HTML-specific active-content check: same non-script patterns as
  // ACTIVE_CONTENT_PATTERNS, but <script> is only a hit if it's inline
  // (has body content) or its src isn't a safe local relative path.
  const IFRAME_TAG_RE = /<iframe\b([^>]*)>/gi;

  // A sandboxed iframe with a validated local-or-https src is a legitimate
  // .novaapp pattern (the "Web App Wrapper" template). The one combination
  // that defeats the sandbox's isolation is allow-same-origin together
  // with allow-scripts — that lets framed content script its way back out
  // to the parent's origin. Anything without a sandbox attribute, or with
  // that specific combo, still blocks.
  function isSafeSandboxedIframe(attrs) {
    const sandboxMatch = /\bsandbox\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!sandboxMatch) return false; // unsandboxed iframe: never safe
    const tokens = sandboxMatch[1].toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.includes('allow-same-origin') && tokens.includes('allow-scripts')) return false;
    const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!srcMatch) return true; // no src at all — inert
    const src = srcMatch[1].trim();
    if (isLocalRelativeSrc(src)) return true;
    return /^https:\/\//i.test(src); // https external origin ok inside a real sandbox
  }

  // javascript: and on*= are only actually dangerous when they sit inside
  // a real tag's attributes — <a href="javascript:...">, <img onerror=...>.
  // For .md, the surrounding content is ordinary prose (a tutorial saying
  // "the onclick= attribute" or "javascript: the language" is completely
  // normal technical writing), so scanning the whole text blindly for
  // these words produces false positives that scanning the whole text
  // blindly for <script>/<iframe> does not. Match them only when actually
  // inside a tag's attribute list. .html is stricter: a real HTML file's
  // *source* has no legitimate reason to contain "javascript:" or an on*=
  // pattern outside a tag at all — hand-authored markup doesn't casually
  // mention them as words the way a tutorial does — so it keeps the
  // original blanket check for those two.
  const HTML_TAG_RE = /<[a-z][a-z0-9-]*\b[^>]*>/gi;

  function findHtmlActiveContentHit(text, { scopeAttrChecksToTags } = {}) {
    for (const pat of ACTIVE_CONTENT_PATTERNS) {
      if (pat.label === 'embedded <script> tag') continue; // handled separately below
      if (pat.label === 'embedded <iframe>') continue;      // handled separately below
      if (scopeAttrChecksToTags && (pat.label === 'javascript: URI' || pat.label === 'inline event handler (on*=)')) {
        continue; // handled via the tag-scoped pass below instead
      }
      if (pat.re.test(text)) return pat.label;
    }

    if (scopeAttrChecksToTags) {
      HTML_TAG_RE.lastIndex = 0;
      let tagMatch;
      while ((tagMatch = HTML_TAG_RE.exec(text))) {
        const tag = tagMatch[0];
        if (/javascript:/i.test(tag)) return 'javascript: URI';
        if (/\son\w+\s*=\s*["']/i.test(tag)) return 'inline event handler (on*=)';
      }
    }

    IFRAME_TAG_RE.lastIndex = 0;
    let iframeMatch;
    while ((iframeMatch = IFRAME_TAG_RE.exec(text))) {
      if (!isSafeSandboxedIframe(iframeMatch[1])) return 'an unsandboxed or unsafe <iframe>';
    }

    SCRIPT_TAG_RE.lastIndex = 0;
    let match;
    while ((match = SCRIPT_TAG_RE.exec(text))) {
      const [, attrs, body] = match;
      if (body.trim() !== '') return 'inline <script>...</script> content';
      const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs);
      if (!srcMatch || !isLocalRelativeSrc(srcMatch[1])) {
        return 'a <script> tag with a non-local or unsafe src';
      }
    }
    return null;
  }

  // Obfuscation smells for anything that will be treated as executable
  // script content (either by extension, or because it tripped an
  // active-content pattern above).
  const OBFUSCATION_PATTERNS = [
    { re: /\beval\s*\(/i,                                    label: 'eval(...) call' },
    { re: /new\s+Function\s*\(/i,                            label: 'new Function(...) construction' },
    { re: /(?:\\x[0-9a-f]{2}){8,}/i,                          label: 'long \\xHH escape chain' },
    { re: /(?:%[0-9a-f]{2}){8,}/i,                            label: 'long percent-encoded chain' },
    // Bare atob(...)/Buffer.from(..., 'base64') is normal in any app doing
    // crypto, binary payloads, or image data — flagging it outright makes
    // this rule fire on totally legitimate code (e.g. decoding an AES-GCM
    // ciphertext back to bytes). What's actually dangerous is base64 used
    // to *smuggle code past this scanner*, i.e. decode-then-execute in the
    // same chain: eval(atob(...)), new Function(atob(...)), etc. Gate on
    // that combination instead of the decode call alone.
    { re: /\b(?:eval|Function)\s*\([^)]*(?:atob\s*\(|Buffer\.from\([^)]*base64)/i, label: 'base64-decoded code passed to eval/Function' },
    // Same issue as the base64 rule above: String.fromCharCode(...) alone
    // is the standard way to turn bytes into a string (e.g. before btoa())
    // and shows up in any code doing binary/base64 conversion — it's not
    // itself evidence of anything. The actual malicious pattern is using
    // fromCharCode to assemble a string of *code* character-by-character
    // specifically to dodge string-literal scanning, then handing that
    // string to something that executes or injects it. Gate on that.
    { re: /\b(?:eval|Function|document\.write(?:ln)?)\s*\([^)]*fromCharCode\s*\(/i, label: 'String.fromCharCode(...) chain passed to eval/Function/document.write' },
    { re: /\.innerHTML\s*=\s*[^;]*fromCharCode\s*\(/i,        label: 'String.fromCharCode(...) chain assigned to innerHTML' },
  ];

  const MAX_SCAN_BYTES = 512 * 1024;      // only need the head of the file to fingerprint it
  const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024; // cap text/regex scanning for large "text" files

  function extOf(name) {
    const parts = String(name || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  // Flags "invoice.pdf.exe"-style disguises: an executable extension
  // preceded by a plausible document/media extension.
  function hasDoubleExtensionTrick(name) {
    const lower = String(name || '').toLowerCase();
    const parts = lower.split('.');
    if (parts.length < 3) return false;
    const finalExt = parts[parts.length - 1];
    return EXECUTABLE_EXTENSIONS.has(finalExt);
  }

  function matchesMagicBytes(bytes) {
    for (const sig of MAGIC_SIGNATURES) {
      if (bytes.length < sig.bytes.length) continue;
      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (bytes[i] !== sig.bytes[i]) { match = false; break; }
      }
      if (match) return sig.label;
    }
    return null;
  }

  // Rough Shannon entropy over a byte sample — high entropy in something
  // claiming to be plain text/markup is a signal of packed/encoded payload
  // rather than authored content.
  function estimateEntropy(bytes) {
    if (!bytes.length) return 0;
    const counts = new Array(256).fill(0);
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
    let entropy = 0;
    for (const c of counts) {
      if (!c) continue;
      const p = c / bytes.length;
      entropy -= p * Math.log2(p);
    }
    return entropy; // 0 (uniform/repetitive) .. 8 (fully random)
  }

  function decodeAsText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (_e) {
      return '';
    }
  }

  // Shared verdict logic once we have a name + byte buffer, regardless of
  // whether it arrived as a File (drag-and-drop) or a decoded string
  // (app package file entry). Keeps scan() and scanText() from drifting.
  async function scanBytes(name, bytes) {
    const ext = extOf(name);

    if (hasDoubleExtensionTrick(name)) {
      return {
        safe: false,
        reason: `"${name}" disguises an executable (.${extOf(name)}) behind a second file extension.`,
      };
    }

    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      return {
        safe: false,
        reason: `"${name}" is an executable/script file type (.${ext}), which isn't allowed.`,
      };
    }

    const magicLabel = matchesMagicBytes(bytes.subarray(0, Math.min(bytes.length, MAX_SCAN_BYTES)));
    if (magicLabel) {
      return {
        safe: false,
        reason: `"${name}" claims to be a .${ext || 'unknown'} file but its contents are a ${magicLabel}.`,
      };
    }

    const looksTextish = RENDERED_TEXT_EXTENSIONS.has(ext) || ext === '' ||
      ext === 'js' || ext === 'mjs' || ext === 'css' || ext === 'json' || ext === 'txt';
    if (looksTextish && bytes.length <= MAX_TEXT_SCAN_BYTES) {
      const sampleBytes = bytes.subarray(0, Math.min(bytes.length, MAX_TEXT_SCAN_BYTES));
      const text = decodeAsText(sampleBytes);

      // .js/.mjs/.css/.json are expected to contain code, so the markup
      // "active content" patterns (script tags, on*=, iframes) don't apply
      // to them — only the obfuscation + entropy checks do. Same for .txt:
      // plain-text viewers never parse it as markup, so those patterns
      // would only produce false positives on ordinary prose.
      //
      // HTML/XHTML/MD get a narrower check: local <script src="..."> refs
      // are the normal .novaapp shape (index.html -> app.js) and are
      // allowed; inline script bodies and everything else (on*=,
      // javascript:, iframe, object/embed, data:html) still block. MD is
      // included here (not just html/htm/xhtml) because most Markdown
      // renderers pass raw embedded HTML through live, same as a browser
      // would. SVG/XML have no legitimate reason to carry any <script> at
      // all, so they keep the original blanket rule.
      const isHtmlLike = HTML_AWARE_EXTENSIONS.has(ext);
      if (isHtmlLike) {
        const htmlHit = findHtmlActiveContentHit(text, { scopeAttrChecksToTags: ext === 'md' });
        if (htmlHit) {
          return {
            safe: false,
            reason: `"${name}" contains ${htmlHit}, which isn't allowed.`,
          };
        }
      } else if (RENDERED_TEXT_EXTENSIONS.has(ext) || ext === '') {
        let activeHit = null;
        for (const pat of ACTIVE_CONTENT_PATTERNS) {
          if (pat.re.test(text)) { activeHit = pat.label; break; }
        }
        if (activeHit) {
          return {
            safe: false,
            reason: `"${name}" contains ${activeHit}, which isn't allowed in a file that gets previewed/rendered.`,
          };
        }
      }

      for (const pat of OBFUSCATION_PATTERNS) {
        if (pat.re.test(text)) {
          return {
            safe: false,
            reason: `"${name}" contains obfuscated code (${pat.label}).`,
          };
        }
      }

      const entropy = estimateEntropy(sampleBytes);
      if (entropy > 6.5) {
        return {
          safe: false,
          reason: `"${name}" is declared as text but its content is high-entropy (likely packed/encoded binary), which isn't allowed.`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Scan a dropped File before it's committed to FS.
   * Returns { safe: boolean, reason?: string, warnings: string[] }
   */
  async function scan(file) {
    const warnings = [];

    if (!file || typeof file.name !== 'string') {
      return { safe: false, reason: 'Invalid file object.', warnings };
    }

    // Only need the head of the file to fingerprint + text-scan it — no
    // reason to pull a multi-GB drop fully into memory.
    const headSize = Math.min(file.size, MAX_TEXT_SCAN_BYTES);
    let headBytes;
    try {
      const headBuf = await file.slice(0, headSize).arrayBuffer();
      headBytes = new Uint8Array(headBuf);
    } catch (_e) {
      return { safe: false, reason: `Could not read "${file.name}" to scan it.`, warnings };
    }

    const verdict = await scanBytes(file.name, headBytes);
    return { ...verdict, warnings };
  }

  /**
   * Scan already-decoded text content (e.g. a package file entry that's
   * been base64-decoded to a string already) without needing a File/Blob.
   * Returns { safe: boolean, reason?: string }
   */
  async function scanText(name, text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    return scanBytes(name, bytes);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /**
   * Scan a raw base64 string directly against the real bytes it decodes
   * to — unlike scanText(), this doesn't round-trip through a JS string
   * first, so magic-byte fingerprinting works correctly even for binary
   * package entries (icons, images, etc), not just text files.
   * Returns { safe: boolean, reason?: string }
   */
  async function scanBase64(name, base64) {
    let bytes;
    try {
      bytes = base64ToBytes(String(base64 ?? ''));
    } catch (_e) {
      return { safe: false, reason: `"${name}" is not valid base64 and could not be scanned.` };
    }
    return scanBytes(name, bytes);
  }

  const Scanner = { scan, scanText, scanBase64 };
  window.Scanner = Scanner;
  // Back-compat alias for existing call sites / anything already wired to
  // the old name.
  window.DropScanner = Scanner;
})();