'use strict';

// Shared helper functions for email processing

// message shape helper

function getAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  if (Array.isArray(addr)) return addr.map(a => a.address || a).join(', ');
  return addr.address || addr.text || '';
}

// decode top-level HTML entities that IMAP servers or PostalMime sometimes
// introduce (e.g. &lt;div&gt; instead of <div>).
// runs two passes to handle double-encoded sequences like &amp;#39; -> &#39; -> '.
// only decodes when the result actually contains HTML markup — avoids
// mangling plain-text emails that happen to contain &amp; or &lt; literally.
function decodeIfEntityEncoded(str) {
  if (!str || !str.includes('&lt;')) return str;

  function onePass(s) {
    return s
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
      .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, '/').replace(/&#x2f;/gi, '/')
      .replace(/&amp;/gi, '&'); // &amp; last so it doesn't pre-expand others
  }

  let decoded = onePass(str);
  // second pass handles double-encoded sequences (&amp;lt; -> &lt; -> <)
  if (decoded.includes('&lt;') || decoded.includes('&amp;') || decoded.includes('&#')) {
    decoded = onePass(decoded);
  }
  return (/<[a-zA-Z]/.test(decoded) || /<!doctype/i.test(decoded)) ? decoded : str;
}

function decodeSubject(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&#x27;/gi, "'").replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function msgShape(parsed) {
  // handle both mailparser and PostalMime formats
  let html = parsed.html ? decodeIfEntityEncoded(parsed.html) : null;
  let text = parsed.text || '';

  // PostalMime sometimes sets `text` to an entity-encoded copy of the HTML
  // body when there is no text/plain part. detect and promote it to `html`.
  if (!html && text) {
    const decoded = text
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    if (/^\s*<!doctype\s+html/i.test(decoded) || /^\s*<html[\s>]/i.test(decoded)) {
      html = decoded;
      text = '';
    }
  }

  return {
    subject: decodeSubject(parsed.subject || '(no subject)'),
    from: getAddress(parsed.from),
    to: getAddress(parsed.to),
    cc: getAddress(parsed.cc),
    date: parsed.date instanceof Date ? parsed.date.toISOString() : (parsed.date || null),
    text,
    html,
    attachments: (parsed.attachments || []).map(a => ({
      filename: a.filename,
      contentType: a.contentType || a.mimeType,
      size: a.size || 0
    }))
  };
}

// email HTML sanitizer

const DROP_CONTENT_TAGS = new Set([
  'script', 'noscript',
  'object', 'embed', 'applet',
  'frame', 'frameset',
  'title',
]);

const STRIP_TAG_ONLY = new Set([
  'html', 'head', 'body',
  'xml', 'xmp',
]);

const UNRENDERABLE_TAGS = new Set([
  'base', 'meta', 'link',
  'iframe', 'frame',
  'form', 'input', 'button', 'select', 'textarea', 'label', 'fieldset', 'legend', 'output',
]);

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'br', 'hr', 'pre', 'blockquote', 'center',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'i', 'u', 's', 'strong', 'em', 'ins', 'del', 'small', 'big', 'sub', 'sup',
  'tt', 'code', 'kbd', 'samp', 'var', 'abbr', 'acronym', 'cite', 'dfn', 'address',
  'a', 'img',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
  'font', 'nobr', 'wbr',
  'picture', 'source',
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'symbol', 'title', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  'filter', 'fegaussianblur', 'feblend', 'fecomposite', 'feflood',
  'fecolormatrix', 'feturbulence', 'fedisplacementmap', 'femerge', 'femergenode',
  'feimage', 'use', 'image',
]);

// tags allowed to keep position:fixed/absolute in inline styles — these are
// the ones legitimate HTML-email layouts use fixed positioning on for faked
// absolute layouts inside table-based templates.
const POSITION_FIXED_ALLOWED_TAGS = new Set(['td', 'th', 'div', 'span', 'p']);

// tags whose src/href attribute gets its own protocol check further down, so
// the blunt global DANGEROUS_ATTR_VALUE pre-check would otherwise clobber
// an allowance (e.g. data: URIs) those branches deliberately grant.
const TAGS_WITH_OWN_URL_HANDLING = new Set(['a', 'img', 'source', 'image', 'feimage', 'use']);

const BLOCKED_ATTRS = /^on\w+$|^srcdoc$|^formaction$|^action$/i;
const DANGEROUS_ATTR_VALUE = /^\s*(javascript|data|vbscript)\s*:/i;
const DANGEROUS_CSS_PROPS = /expression\s*\(|-moz-binding\s*:|behavior\s*:|filter\s*:\s*progid/i;
const DANGEROUS_CSS_ATRULES = /@import\b|@font-face\b/gi;

function escapeTextContent(text) {
  return text
    // only escape a bare '&' — one that isn't already the start of a valid
    // HTML entity reference (&#123;, &#x1F;, &name;). blindly escaping every
    // '&' double-encodes entities that were already valid in the source
    // email (e.g. &#x27; -> &amp;#x27;), which the browser then renders as
    // literal text ("&#x27;") instead of decoding to the intended character.
    .replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(val) {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeCssValue(prop, value) {
  if (DANGEROUS_CSS_PROPS.test(prop + ':' + value)) return null;
  if (/url\s*\(\s*['"]?https?:\/\//i.test(value)) return null;
  return value;
}

function sanitizeInlineStyle(styleStr, allowFixed) {
  if (!styleStr) return '';
  let cleaned = styleStr.replace(DANGEROUS_CSS_ATRULES, '');
  cleaned = cleaned.replace(/[^;]*(?:expression\s*\(|-moz-binding|-ms-behavior|behavior\s*:)[^;]*/gi, '');

  const decls = cleaned.split(';');
  const safe = [];

  for (const decl of decls) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!prop || !val) continue;

    if (prop === 'position') {
      const v = val.toLowerCase();
      if (!allowFixed && (v === 'fixed' || v === 'absolute')) continue;
    }

    const safeVal = sanitizeCssValue(prop, val);
    if (safeVal !== null) safe.push(`${prop}: ${safeVal}`);
  }

  return safe.join('; ');
}

function sanitizeStyleBlock(css) {
  css = css.replace(/@import\b[^;{]*[;{]/gi, '');
  css = css.replace(/@font-face\s*\{[^}]*\}/gi, '');
  css = css.replace(/[^;{]*expression\s*\([^)]*\)[^;{]*/gi, '');
  css = css.replace(/[^;{]*-moz-binding\s*:[^;{]*/gi, '');
  css = css.replace(/[^;{]*\bbehavior\s*:[^;{]*/gi, '');
  css = css.replace(/url\s*\(\s*['"]?https?:\/\/[^)'"]+['"]?\s*\)/gi, 'url(none)');
  return css;
}

// returns the safe attribute string for a tag, or null if the whole tag
// should be dropped (used for SVG remote-reference blocking, where keeping
// the tag with no href/xlink:href would be misleading).
function sanitizeTagAttrs(tagName, rawTag) {
  const attrStr = rawTag.slice(tagName.length + 1).replace(/\/?>$/, '').trim();
  if (!attrStr) return '';

  const safe = [];
  const attrRe = /([a-zA-Z][a-zA-Z0-9_:\-.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;

  while ((m = attrRe.exec(attrStr)) !== null) {
    const attrName = m[1].toLowerCase();
    const attrVal = m[2] ?? m[3] ?? m[4] ?? '';

    if (BLOCKED_ATTRS.test(attrName)) continue;

    // the global javascript:/data:/vbscript: check only applies to attributes
    // that don't have their own protocol handling below — href on <a>, src on
    // <img>/<source>, and href/xlink:href on the SVG reference tags all run
    // their own checks (and some of them deliberately allow data: for inline
    // images), so running the blunt check first would block that on-purpose
    // allowance before the branch that grants it ever runs.
    if (!TAGS_WITH_OWN_URL_HANDLING.has(tagName) && DANGEROUS_ATTR_VALUE.test(attrVal)) continue;

    if (attrName === 'style') {
      const allowFixed = POSITION_FIXED_ALLOWED_TAGS.has(tagName);
      const cleaned = sanitizeInlineStyle(attrVal, allowFixed);
      if (cleaned) safe.push(`style="${escapeAttr(cleaned)}"`);
      continue;
    }

    if (attrName === 'href' && tagName === 'a') {
      const v = attrVal.replace(/&amp;/gi, '&').trim();
      const proto = v.split(':')[0].toLowerCase();
      if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') continue;
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if (attrName === 'src' && (tagName === 'img' || tagName === 'source')) {
      const v = attrVal.replace(/&amp;/gi, '&').trim();
      const proto = v.split(':')[0].toLowerCase();
      if (proto === 'javascript' || proto === 'vbscript') continue;
      // data: URLs (inline images) are inert — pass through as-is.
      if (proto === 'data') { safe.push(`${attrName}="${escapeAttr(attrVal)}"`); continue; }
      // remote http(s) URLs must NEVER be handed to the renderer directly —
      // that lets attacker-controlled <img src> reach internal/private
      // addresses (SSRF) with zero user interaction. route through the
      // server-side proxy, which re-validates the destination (and every
      // redirect hop) before fetching. see NBOSP/server/proxies.js:
      // setupEmailImageProxy.
      if (proto === 'http' || proto === 'https') {
        const proxied = '/api/email-image?url=' + encodeURIComponent(v);
        safe.push(`${attrName}="${escapeAttr(proxied)}"`);
        continue;
      }
      // unrecognized protocol — drop rather than pass through blind.
      continue;
    }

    if ((attrName === 'href' || attrName === 'xlink:href') && (tagName === 'image' || tagName === 'feimage' || tagName === 'use')) {
      const v = attrVal.replace(/&amp;/gi, '&').trim();
      const proto = v.split(':')[0].toLowerCase();
      // same SSRF concern as <img src> above — these SVG reference tags can
      // pull in a remote resource just as easily as an <img>, so remote
      // URLs get dropped here too rather than proxied (SVG's own <image>
      // element has enough quirks across renderers that we don't attempt to
      // proxy it the way we do for plain <img>).
      if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') continue;
      if (proto === 'http' || proto === 'https') continue;
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if (/^(width|height|colspan|rowspan|cellpadding|cellspacing|border|bgcolor|color|align|valign)$/.test(attrName)) {
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if (/^(class|id)$/.test(attrName) && /^[a-zA-Z0-9_\-]+$/.test(attrVal)) {
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if (/^data-/.test(attrName)) {
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if (/^(title|alt|name)$/.test(attrName)) {
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }
  }

  return safe.length ? ' ' + safe.join(' ') : '';
}

function sanitizeEmailHtml(html) {
  if (!html || typeof html !== 'string') return '';

  const MAX_INPUT = 2 * 1024 * 1024;
  if (html.length > MAX_INPUT) html = html.slice(0, MAX_INPUT);

  let out = '';
  let pos = 0;
  const dropStack = [];
  const unknownTagSubStack = [];

  while (pos < html.length) {
    const tagStart = html.indexOf('<', pos);
    if (tagStart < 0) {
      if (dropStack.length === 0) out += escapeTextContent(html.slice(pos));
      break;
    }

    if (tagStart > pos && dropStack.length === 0) {
      out += escapeTextContent(html.slice(pos, tagStart));
    }

    // HTML comments (including MSO conditional comments like
    // <!--[if gte mso 9]><xml>...<![endif]-->, which are extremely common
    // boilerplate in commercial email templates) can contain '>' characters
    // well before their real terminator. treating the next '>' as the tag's
    // end — the generic path below — would only skip the "<!--[if ...]>"
    // opening fragment and then parse the comment's *contents* (<xml>,
    // <o:PixelsPerInch>, etc.) as if they were real tags, dropping the tags
    // but keeping their inner text (e.g. a bare "96" from PixelsPerInch>96<).
    // comments must be consumed in full, up to the actual '-->'.
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      pos = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = html.indexOf('>', tagStart);
    if (tagEnd < 0) {
      if (dropStack.length === 0) out += escapeTextContent(html.slice(tagStart));
      break;
    }

    const rawTag = html.slice(tagStart, tagEnd + 1);
    pos = tagEnd + 1;

    if (/^<!doctype/i.test(rawTag)) continue;
    if (rawTag.startsWith('<?')) continue;

    if (rawTag.startsWith('</')) {
      const tagName = rawTag.slice(2).replace(/[\s>\/]/g, '').toLowerCase();
      if (dropStack.length > 0 && dropStack[dropStack.length - 1] === tagName) {
        dropStack.pop();
      } else if (unknownTagSubStack.length > 0 && unknownTagSubStack[unknownTagSubStack.length - 1] === tagName) {
        unknownTagSubStack.pop();
        if (dropStack.length === 0) out += '</span>';
      } else if (dropStack.length === 0 && ALLOWED_TAGS.has(tagName)) {
        out += `</${tagName}>`;
      }
      continue;
    }

    const isSelfClosing = rawTag.endsWith('/>');
    const tagMatch = rawTag.match(/^<([a-zA-Z][a-zA-Z0-9:_-]*)/);
    if (!tagMatch) continue;
    const tagName = tagMatch[1].toLowerCase();

    if (tagName === 'style') {
      const closeStyle = html.indexOf('</style>', pos);
      if (dropStack.length === 0) {
        if (closeStyle < 0) { pos = html.length; continue; }
        const cssContent = html.slice(pos, closeStyle);
        out += '<style>' + sanitizeStyleBlock(cssContent) + '</style>';
        pos = closeStyle + '</style>'.length;
      } else {
        pos = closeStyle < 0 ? html.length : closeStyle + '</style>'.length;
      }
      continue;
    }

    if (DROP_CONTENT_TAGS.has(tagName)) {
      if (!isSelfClosing) dropStack.push(tagName);
      continue;
    }

    if (dropStack.length > 0) continue;

    if (STRIP_TAG_ONLY.has(tagName)) continue;

    if (UNRENDERABLE_TAGS.has(tagName)) continue;

    if (!ALLOWED_TAGS.has(tagName)) {
      // an unrecognised tag (custom ESP element, vendor markup, etc.) is not
      // itself safe to render, but if it carries a style/class attribute it
      // may be the *only* thing hiding its own text content (e.g. a hidden
      // preheader wrapped in a non-standard tag). dropping the tag outright
      // would keep the text but throw away the very attributes hiding it,
      // turning invisible preview-text padding into visible stray text.
      // substitute with a neutral <span> carrying the sanitized attrs so any
      // hiding CSS still applies, instead of unmasking the content.
      const hasStyleOrClass = /\b(style|class)\s*=/i.test(rawTag);
      if (hasStyleOrClass && !isSelfClosing) {
        const cleanAttrs = sanitizeTagAttrs('span', rawTag.replace(/^<[a-zA-Z0-9:_-]+/, '<span'));
        if (dropStack.length === 0) out += `<span${cleanAttrs}>`;
        unknownTagSubStack.push(tagName);
      }
      continue;
    }

    const cleanAttrs = sanitizeTagAttrs(tagName, rawTag);
    const selfClose = isSelfClosing ? ' /' : '';
    out += `<${tagName}${cleanAttrs}${selfClose}>`;
  }

  return out;
}

module.exports = {
  msgShape,
  sanitizeEmailHtml,
};