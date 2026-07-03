'use strict';

// Shared helper functions for email processing

// ─────────────────────────────────────────────────────────────────────────────
// Message shape helper
// ─────────────────────────────────────────────────────────────────────────────

function msgShape(parsed) {
  // Handle both mailparser and PostalMime formats
  const getAddress = (addr) => {
    if (!addr) return '';
    if (typeof addr === 'string') return addr;
    if (Array.isArray(addr)) return addr.map(a => a.address || a).join(', ');
    return addr.address || addr.text || '';
  };

  // Helper: decode top-level HTML entities that IMAP servers or PostalMime
  // sometimes introduce (e.g. &lt;div&gt; instead of <div>).
  // Runs two passes to handle double-encoded sequences like &amp;#39; → &#39; → '.
  // Only decodes when the result actually contains HTML markup — avoids
  // mangling plain-text emails that happen to contain &amp; or &lt; literally.
  function decodeIfEntityEncoded(str) {
    if (!str || !str.includes('&lt;')) return str;
    function onePass(s) {
      return s
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
        .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/').replace(/&#x2f;/gi, '/')
        .replace(/&amp;/gi, '&');  // &amp; last so it doesn't pre-expand others
    }
    let decoded = onePass(str);
    // Second pass handles double-encoded sequences (&amp;lt; → &lt; → <)
    if (decoded.includes('&lt;') || decoded.includes('&amp;') || decoded.includes('&#')) decoded = onePass(decoded);
    return (/<[a-zA-Z]/.test(decoded) || /<!doctype/i.test(decoded)) ? decoded : str;
  }

  let html = parsed.html ? decodeIfEntityEncoded(parsed.html) : null;
  let text = parsed.text || '';
  // PostalMime sometimes sets `text` to an entity-encoded copy of the HTML body
  // when there is no text/plain part. Detect and promote it to `html`.
  if (!html && text) {
    const decoded = text
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    if (/^\s*<!doctype\s+html/i.test(decoded) || /^\s*<html[\s>]/i.test(decoded)) {
      html = decoded;
      text = '';
    }
  }

  function decodeSubject(str) {
    if (!str || typeof str !== 'string') return str;
    return str
      .replace(/&#x27;/gi, "'").replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared URL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a URL string; return null (never throw) on invalid input. */
function safeParseUrl(str) {
  if (!str || typeof str !== 'string') return null;
  try { return new URL(str); } catch (_) { return null; }
}

/**
 * Iteratively decode a percent-encoded string up to maxPasses times.
 * Stops as soon as a pass produces no change or a valid http/https URL is obtained.
 * Handles double- and triple-encoded destinations (%2568ttp%253A%252F%252F...).
 */
function tryDecodeUrl(raw, maxPasses = 3) {
  let prev = raw;
  for (let i = 0; i < maxPasses; i++) {
    let decoded;
    try { decoded = decodeURIComponent(prev); } catch (_) { break; }
    if (decoded === prev) break;
    const u = safeParseUrl(decoded);
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) return decoded;
    prev = decoded;
  }
  return prev;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE PROXY — rewriteEmailImages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the proxy URL for a remote image src.
 * Pre-validates scheme (http/https only) — rejects javascript:, data:, file:, etc.
 * Strips tracking params before encoding.
 */
function proxyEmailImageUrl(src) {
  try {
    const u = new URL(src);
    // Only proxy http/https — never proxy javascript:, data:, file:, etc.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return src;
    return '/api/email-image?url=' + encodeURIComponent(src);
  } catch (_) { return src; }
}

// Regex to extract image src from tag — allows src="...", src='...', srcset, etc.
// This regex captures the src or srcset value in group 3 or 4.
const IMG_SRC_PATTERN = /\b(src|srcset)\s*=\s*(['"])((?:(?!\2).)*)\2/gi;

// For <style> tags, extract and rewrite url() references
const STYLE_URL_PATTERN = /url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function rewriteEmailImages(html) {
  if (!html || typeof html !== 'string') return html;

  // 1. Rewrite <img src="..."> and other img-like tags
  html = html.replace(IMG_SRC_PATTERN, (match, attr, quote, url) => {
    const cleaned = proxyEmailImageUrl(url);
    return `${attr}=${quote}${cleaned}${quote}`;
  });

  // 2. Rewrite <style> url() references
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (styleBlock) => {
    return styleBlock.replace(STYLE_URL_PATTERN, (match, quote, url) => {
      const quoteChar = quote || '';
      const cleaned = proxyEmailImageUrl(url);
      return `url(${quoteChar}${cleaned}${quoteChar})`;
    });
  });

  // 3. Rewrite inline style="background-image: url(...)"
  html = html.replace(/style\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (match, quote, styleVal) => {
    const cleaned = styleVal.replace(STYLE_URL_PATTERN, (m, q, url) => {
      const quoteChar = q || '';
      const proxied = proxyEmailImageUrl(url);
      return `url(${quoteChar}${proxied}${quoteChar})`;
    });
    return `style=${quote}${cleaned}${quote}`;
  });

  // 4. Rewrite <td background="...">
  html = html.replace(/\bbackground\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (match, quote, url) => {
    const cleaned = proxyEmailImageUrl(url);
    return `background=${quote}${cleaned}${quote}`;
  });

  // 5. Rewrite SVG image/@href and @xlink:href
  // <image href="..." /> or <image xlink:href="..." />
  html = html.replace(/<image\b[^>]*>/gi, (imgTag) => {
    let result = imgTag;
    // href
    result = result.replace(/\bhref\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `href=${quote}${cleaned}${quote}`;
    });
    // xlink:href
    result = result.replace(/\bxlink:href\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `xlink:href=${quote}${cleaned}${quote}`;
    });
    return result;
  });

  // 6. Rewrite SVG <feImage>
  html = html.replace(/<feImage\b[^>]*>/gi, (imgTag) => {
    let result = imgTag;
    result = result.replace(/\bhref\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `href=${quote}${cleaned}${quote}`;
    });
    result = result.replace(/\bxlink:href\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `xlink:href=${quote}${cleaned}${quote}`;
    });
    return result;
  });

  // 7. Rewrite SVG <use> (references to symbols/defs)
  html = html.replace(/<use\b[^>]*>/gi, (useTag) => {
    let result = useTag;
    result = result.replace(/\bhref\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `href=${quote}${cleaned}${quote}`;
    });
    result = result.replace(/\bxlink:href\s*=\s*(['"])((?:(?!\1).)*)\1/gi, (m, quote, url) => {
      const cleaned = proxyEmailImageUrl(url);
      return `xlink:href=${quote}${cleaned}${quote}`;
    });
    return result;
  });

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK PROXY — rewriteEmailLinks
// ─────────────────────────────────────────────────────────────────────────────

// Map of known ESP/email service redirect domains to query param names
// that typically contain the real destination URL
const TRACKING_REDIRECTS = new Map([
  ['click.mailgun.org', null],
  ['click.sendgrid.net', null],
  ['r.sendgrid.net', null],
  ['sendgrid.com', null],
  ['sendgrid.info', null],
  ['sendgrid.net', null],
  ['mg.sendgrid.com', null],
  ['click.constantcontact.com', null],
  ['track.hubspot.com', 'u'],
  ['mail.hubspot.com', 'u'],
  ['click2.mailchimp.com', 'u'],
  ['list-manage.com', null],
  ['links.constantcontact.com', null],
  ['links.mkt.salesforce.com', ['lpId', 'url']],
  ['email2.salesforce.com', null],
  ['click.mailmark.microsoft.com', null],
  ['send.mailmark.microsoft.com', null],
  ['amc.ysm.microsoft.com', null],
  ['amp.thebrighttag.com', 'redirect_url'],
  ['track.brevo.com', 'bta_tp'],
  ['click.brevo.com', 'url'],
  ['track.marketo.com', 'u'],
  ['go.marketo.com', 'u'],
  ['go.recordedfuture.com', 'url'],
  ['go.okta.com', 'url'],
  ['go.adobe.com', 'url'],
  ['links.adobe.com', 'url'],
  ['mail.activehosted.com', 'u'],
  ['track.gatherprospects.com', 'url'],
  ['links.getresponse.com', 'u'],
  ['links.klaviyo.com', 'url'],
  ['links.mkt.ontraport.com', 'redirectTo'],
  ['click.drip.com', 'url'],
  ['track.beehive.ai', 'goto'],
  ['mkt.de.invitebox.com', 'goto'],
  ['mkt.infusionsoft.com', 'goto'],
  ['mkt.selligent.com', 'url'],
  ['engage.ab.com', 'u'],
  ['go.marketingcloud.salesforce.com', 'u'],
  ['na88.salesforce.com', 'url'],
  ['na88.marketing.salesforce.com', 'url'],
  ['track.responsys.net', 'url'],
  ['d.responseurl.com', 'url'],
  ['track.nps.responsys.net', 'url'],
  ['track.smtpbucket.com', 'url'],
  ['m1.email.samsung.com', null],
  ['m2.email.samsung.com', null],
  ['t1.email.samsung.com', null],
  ['t2.email.samsung.com', null],
  ['t3.email.samsung.com', null],
  ['t4.email.samsung.com', null],
  ['t5.email.samsung.com', null],
  ['t6.m1.email.samsung.com', null],
  ['uk.email.samsung.com', null],
  ['m1.email.samsung.com', null],
]);

// Generic subdomain prefixes that identify click-tracker domains
const TRACKING_REDIRECT_PREFIXES = ['click.', 'track.', 'links.', 'trk.', 'go.email.', 'email.'];

/**
 * Try to extract a real destination URL from a redirect.
 * Tries query params first, then base64-encoded path segments (Marketo/Pardot).
 * Handles single, double, and triple percent-encoding layers.
 * Returns the first valid http/https URL found, or null.
 */
function extractRedirectDest(u, paramSpec) {
  // 1. Query param extraction
  const names = Array.isArray(paramSpec) ? paramSpec : (paramSpec ? [paramSpec] : []);
  for (const name of names) {
    const raw = u.searchParams.get(name);
    if (!raw) continue;
    const decoded = tryDecodeUrl(raw);
    const dest = safeParseUrl(decoded);
    if (dest && (dest.protocol === 'http:' || dest.protocol === 'https:')) return decoded;
  }

  // 2. Base64-encoded path segment (Marketo /r/<base64>, some Pardot variants)
  const segments = u.pathname.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.length < 20 || seg.includes('.')) continue;
    try {
      const decoded = Buffer.from(seg, 'base64').toString('utf8');
      const dest = safeParseUrl(decoded);
      if (dest && (dest.protocol === 'http:' || dest.protocol === 'https:')) return decoded;
    } catch (_) { /* not valid base64 */ }
  }

  return null;
}

/**
 * Match hostname against TRACKING_REDIRECTS and generic prefixes.
 */
function matchTrackingRedirectDomain(hostname) {
  hostname = hostname.toLowerCase().replace(/^www\./, '');

  // Exact / subdomain match against known ESP entries
  for (const [domain, paramSpec] of TRACKING_REDIRECTS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return { key: domain, paramSpec };
    }
  }

  // Generic prefix match
  for (const prefix of TRACKING_REDIRECT_PREFIXES) {
    if (hostname.startsWith(prefix) && hostname.includes('.', prefix.length)) {
      return { key: hostname, paramSpec: null };
    }
  }

  return null;
}

/**
 * Rewrite a single href value. Returns the cleaned URL string.
 */
function rewriteEmailLink(href) {
  const decoded = href.replace(/&amp;/gi, '&');
  const preDecoded = tryDecodeUrl(decoded);

  const u = safeParseUrl(preDecoded);
  if (!u) return href;

  const proto = u.protocol.toLowerCase();
  if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') return '#';

  if (proto !== 'http:' && proto !== 'https:') return href;

  const hostname = u.hostname.toLowerCase().replace(/^www\./, '');

  const match = matchTrackingRedirectDomain(hostname);
  if (match) {
    const destStr = extractRedirectDest(u, match.paramSpec);

    if (destStr) {
      const destU = safeParseUrl(destStr);
      if (destU) {
        const destProto = destU.protocol.toLowerCase();
        if (destProto === 'javascript:' || destProto === 'data:' || destProto === 'vbscript:') return '#';

        const destHost = destU.hostname.toLowerCase().replace(/^www\./, '');
        { // redirect tracking removed
          return destU.toString();
        }
      }
    }

    return u.toString();
  }

  return href;
}

function rewriteEmailLinks(html) {
  if (!html || typeof html !== 'string') return html;

  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(['"])(https?:\/\/[^'">\s]+|javascript:[^'">\s]*|data:[^'">\s]*)\2/gi,
    (_, pre, q, href) => {
      const clean = rewriteEmailLink(href);
      return `${pre}${q}${clean}${q}`;
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL HTML SANITISER
// ─────────────────────────────────────────────────────────────────────────────

const DROP_CONTENT_TAGS = new Set([
  'script','noscript',
  'object','embed','applet',
  'frame','frameset',
  'title',
]);

const STRIP_TAG_ONLY = new Set([
  'html','head','body',
  'xml','xmp',
]);

const ALLOWED_TAGS = new Set([
  'div','span','p','br','hr','pre','blockquote','center',
  'h1','h2','h3','h4','h5','h6',
  'b','i','u','s','strong','em','ins','del','small','big','sub','sup',
  'tt','code','kbd','samp','var','abbr','acronym','cite','dfn','address',
  'a','img',
  'ul','ol','li','dl','dt','dd',
  'table','thead','tbody','tfoot','tr','th','td','caption','col','colgroup',
  'font','nobr','wbr',
  'picture','source',
  'svg','g','path','rect','circle','ellipse','line','polyline','polygon',
  'text','tspan','defs','symbol','title','desc',
  'lineargradient','radialgradient','stop','clippath','mask','pattern',
  'filter','fegaussianblur','feblend','fecomposite','feflood',
  'fecolormatrix','feturbulence','fedisplacementmap','femerge','femergenode',
  'feimage','use','image',
]);

const BLOCKED_ATTRS = /^on\w+$|^srcdoc$|^formaction$|^action$/i;
const DANGEROUS_ATTR_VALUE = /^\s*(javascript|data|vbscript)\s*:/i;
const DANGEROUS_CSS_PROPS = /expression\s*\(|-moz-binding\s*:|behavior\s*:|filter\s*:\s*progid/i;
const DANGEROUS_CSS_ATRULES = /@import\b|@font-face\b/gi;

function escapeTextContent(text) {
  return text
    .replace(/&/g, '&amp;')
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
    const val  = decl.slice(colon + 1).trim();
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

function sanitizeTagAttrs(tagName, rawTag) {
  const attrStr = rawTag.slice(tagName.length + 1).replace(/\/?>$/, '').trim();
  if (!attrStr) return '';

  const safe = [];
  const attrRe = /([a-zA-Z][a-zA-Z0-9_:\-.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;

  while ((m = attrRe.exec(attrStr)) !== null) {
    const attrName = m[1].toLowerCase();
    const attrVal  = m[2] ?? m[3] ?? m[4] ?? '';

    if (BLOCKED_ATTRS.test(attrName)) continue;
    if (DANGEROUS_ATTR_VALUE.test(attrVal)) continue;

    if (attrName === 'style') {
      const allowFixed = ['td','th','div','span','p'].includes(tagName);
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
      if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') continue;
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    if ((attrName === 'href' || attrName === 'xlink:href') && (tagName === 'image' || tagName === 'feimage' || tagName === 'use')) {
      const v = attrVal.replace(/&amp;/gi, '&').trim();
      const proto = v.split(':')[0].toLowerCase();
      if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') return '#';
      if (proto === 'http:' || proto === 'https:') return '#';
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

  while (pos < html.length) {
    const tagStart = html.indexOf('<', pos);
    if (tagStart < 0) {
      if (dropStack.length === 0) out += escapeTextContent(html.slice(pos));
      break;
    }

    if (tagStart > pos && dropStack.length === 0) {
      out += escapeTextContent(html.slice(pos, tagStart));
    }

    let tagEnd = html.indexOf('>', tagStart);
    if (tagEnd < 0) {
      if (dropStack.length === 0) out += escapeTextContent(html.slice(tagStart));
      break;
    }

    const rawTag = html.slice(tagStart, tagEnd + 1);
    pos = tagEnd + 1;

    if (rawTag.startsWith('<!--')) continue;
    if (/^<!doctype/i.test(rawTag)) continue;
    if (rawTag.startsWith('<?')) continue;

    if (rawTag.startsWith('</')) {
      const tagName = rawTag.slice(2).replace(/[\s>\/]/g, '').toLowerCase();
      if (dropStack.length > 0 && dropStack[dropStack.length - 1] === tagName) {
        dropStack.pop();
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
      if (dropStack.length === 0) {
        const closeStyle = html.indexOf('</style>', pos);
        if (closeStyle < 0) { pos = html.length; continue; }
        const cssContent = html.slice(pos, closeStyle);
        out += '<style>' + sanitizeStyleBlock(cssContent) + '</style>';
        pos = closeStyle + '</style>'.length;
      } else {
        const closeStyle = html.indexOf('</style>', pos);
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

    if (tagName === 'base' || tagName === 'meta' || tagName === 'link' || 
        tagName === 'iframe' || tagName === 'frame' ||
        tagName === 'form' || tagName === 'input' || tagName === 'button' ||
        tagName === 'select' || tagName === 'textarea' || tagName === 'label' ||
        tagName === 'fieldset' || tagName === 'legend' || tagName === 'output') {
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) continue;

    const cleanAttrs = sanitizeTagAttrs(tagName, rawTag);
    const selfClose = isSelfClosing ? ' /' : '';
    out += `<${tagName}${cleanAttrs}${selfClose}>`;
  }

  return out;
}

module.exports = {
  msgShape,
  rewriteEmailImages,
  rewriteEmailLinks,
  sanitizeEmailHtml,
};
