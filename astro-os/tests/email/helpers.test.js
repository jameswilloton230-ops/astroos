import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { msgShape, sanitizeEmailHtml } = require('../../email/helpers.js');

describe('email/helpers.js — msgShape', () => {
  it('normalises a mailparser-style message', () => {
    const shaped = msgShape({
      subject: 'Hello',
      from: { address: 'a@example.com', name: 'Alice' },
      to: [{ address: 'b@example.com' }, { address: 'c@example.com' }],
      cc: [{ address: 'd@example.com' }],
      date: new Date('2026-01-02T03:04:05Z'),
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [{ filename: 'f.txt', contentType: 'text/plain', size: 12 }],
    });
    expect(shaped.subject).toBe('Hello');
    expect(shaped.from).toBe('a@example.com');
    expect(shaped.to).toBe('b@example.com, c@example.com');
    expect(shaped.cc).toBe('d@example.com');
    expect(shaped.date).toBe('2026-01-02T03:04:05.000Z');
    expect(shaped.html).toBe('<p>hi</p>');
    expect(shaped.attachments).toEqual([{ filename: 'f.txt', contentType: 'text/plain', size: 12 }]);
  });

  it('falls back through address/text/string shapes for addresses', () => {
    expect(msgShape({ from: { text: 'Alice <a@x.com>' } }).from).toBe('Alice <a@x.com>');
    expect(msgShape({ from: ['x@y.com', { address: 'z@y.com' }] }).from).toBe('x@y.com, z@y.com');
    expect(msgShape({ from: undefined }).from).toBe('');
  });

  it('decodes entity-encoded HTML bodies', () => {
    expect(msgShape({ subject: 'x', html: '&lt;div&gt;boom&lt;/div&gt;' }).html).toBe('<div>boom</div>');
  });

  it('promotes an entity-encoded HTML document found in text (PostalMime quirk)', () => {
    const shaped = msgShape({ subject: 'x', text: '&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;p&gt;hi&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;' });
    expect(shaped.text).toBe('');
    expect(shaped.html).toContain('<!doctype html>');
    expect(shaped.html).toContain('<p>hi</p>');
  });

  it('defaults and date handling', () => {
    const shaped = msgShape({});
    expect(shaped.subject).toBe('(no subject)');
    expect(shaped.date).toBeNull();
    expect(shaped.text).toBe('');
    expect(shaped.html).toBeNull();
    expect(shaped.attachments).toEqual([]);
    // string dates pass through untouched; only real Date objects get ISO-normalised
    expect(msgShape({ date: '2026-05-01T00:00:00Z' }).date).toBe('2026-05-01T00:00:00Z');
  });

  it('decodes subjects and maps attachment mime fallbacks', () => {
    const shaped = msgShape({
      subject: 'Tom &amp; Jerry &#39;quote&#39;',
      attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream' }],
    });
    expect(shaped.subject).toBe("Tom & Jerry 'quote'");
    expect(shaped.attachments[0].contentType).toBe('application/octet-stream');
    expect(shaped.attachments[0].size).toBe(0);
  });
});

describe('email/helpers.js — sanitizeEmailHtml: content dropping', () => {
  it('drops script/noscript/object/embed content entirely', () => {
    expect(sanitizeEmailHtml('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(sanitizeEmailHtml('<noscript><img src=x></noscript>ok')).toBe('ok');
    expect(sanitizeEmailHtml('<object data="x">fallback</object>fine')).toBe('fine');
  });

  it('drops frame/frameset content but keeps iframe-tag content (tag itself removed)', () => {
    expect(sanitizeEmailHtml('<frame src="x">hidden</frame>visible')).toBe('visible');
    expect(sanitizeEmailHtml('<iframe src="https://evil.example"></iframe>kept')).toBe('kept');
  });

  it('drops <title> content even though title appears in the SVG allowlist (DROP wins)', () => {
    expect(sanitizeEmailHtml('<title>secret</title>after')).toBe('after');
  });

  it('skips doctype and processing instructions', () => {
    expect(sanitizeEmailHtml('<!DOCTYPE html><p>x</p>')).toBe('<p>x</p>');
    expect(sanitizeEmailHtml('<?xml version="1.0"?><p>x</p>')).toBe('<p>x</p>');
  });

  it('consumes MSO conditional comments whole (no stray inner text)', () => {
    const html = '<!--[if gte mso 9]><xml><o:PixelsPerInch>96</o:PixelsPerInch></xml><![endif]--><p>hi</p>';
    expect(sanitizeEmailHtml(html)).toBe('<p>hi</p>');
  });

  it('removes unrenderable tags but keeps their text', () => {
    expect(sanitizeEmailHtml('<form><input type="text"></form>hi')).toBe('hi');
    expect(sanitizeEmailHtml('<base href="https://x/">text')).toBe('text');
  });

  it('substitutes unknown tags carrying style/class with a neutral span', () => {
    const out = sanitizeEmailHtml('<custom-tag style="display:none">preheader</custom-tag>');
    expect(out).toContain('<span style="display: none">preheader</span>');
    expect(out).not.toContain('custom-tag');
  });

  it('plain unknown tags are dropped but their text survives', () => {
    expect(sanitizeEmailHtml('<weird>text stays</weird>')).toBe('text stays');
  });
});

describe('email/helpers.js — sanitizeEmailHtml: attributes', () => {
  it('strips event handler attributes', () => {
    expect(sanitizeEmailHtml('<div onclick="alert(1)" onmouseover="x()">t</div>')).toBe('<div>t</div>');
  });

  it('drops the whole iframe tag along with its srcdoc attribute', () => {
    // iframes are unrenderable — the tag (and any attribute on it, srcdoc
    // included) never reaches the output; the text after it survives
    expect(sanitizeEmailHtml('<iframe srcdoc="evil"></iframe>t')).toBe('t');
    expect(sanitizeEmailHtml('<form action="javascript:x"><p>in</p></form>')).toBe('<p>in</p>');
  });

  it('drops javascript:/vbscript: hrefs but keeps https and mailto', () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeEmailHtml('<a href="vbscript:x">x</a>')).toBe('<a>x</a>');
    expect(sanitizeEmailHtml('<a href="https://example.com">x</a>')).toBe('<a href="https://example.com">x</a>');
    expect(sanitizeEmailHtml('<a href="mailto:a@b.com">x</a>')).toBe('<a href="mailto:a@b.com">x</a>');
  });

  it('routes remote img/src through the server-side email-image proxy (SSRF)', () => {
    const out = sanitizeEmailHtml('<img src="https://imgs.example.com/pic.png">');
    expect(out).toContain('src="/api/email-image?url=');
    expect(out).toContain(encodeURIComponent('https://imgs.example.com/pic.png'));
    expect(out).not.toContain('src="https://imgs.example.com');
  });

  it('keeps data: img srcs (inline images are inert) and drops javascript: ones', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeEmailHtml(`<img src="${dataUri}">`)).toContain(`src="${dataUri}"`);
    expect(sanitizeEmailHtml('<img src="javascript:alert(1)">')).toBe('<img>');
  });

  it('drops remote hrefs on SVG reference tags (image/feimage/use)', () => {
    expect(sanitizeEmailHtml('<use xlink:href="https://evil.example/x.svg"></use>')).toBe('<use></use>');
    expect(sanitizeEmailHtml('<image href="https://evil.example/x.png"></image>')).toBe('<image></image>');
    // local fragment references stay
    expect(sanitizeEmailHtml('<use xlink:href="#icon"></use>')).toBe('<use xlink:href="#icon"></use>');
  });

  it('keeps benign layout attributes and data-* attributes', () => {
    const out = sanitizeEmailHtml('<td colspan="2" bgcolor="#fff" data-x="1" width="50">c</td>');
    expect(out).toContain('colspan="2"');
    expect(out).toContain('bgcolor="#fff"');
    expect(out).toContain('data-x="1"');
    expect(out).toContain('width="50"');
  });

  it('keeps class/id only when the value is a safe token', () => {
    expect(sanitizeEmailHtml('<div class="wrapper">t</div>')).toBe('<div class="wrapper">t</div>');
    // a class value containing whitespace is dropped, other attrs survive
    expect(sanitizeEmailHtml('<div class="a b" id="ok">t</div>')).toBe('<div id="ok">t</div>');
  });

  it('escapes dangerous characters inside kept attribute values', () => {
    // note: a ">" inside an attribute value terminates the tag early (the
    // parser scans for the first ">"), so only "<" appears in real attr values
    const out = sanitizeEmailHtml('<a title="a" href="https://x.com/?q=<b">t</a>');
    expect(out).toContain('&lt;');
    expect(out).not.toContain('"<');
  });
});

describe('email/helpers.js — sanitizeEmailHtml: CSS sanitisation', () => {
  it('removes expression()/behavior/-moz-binding declarations from inline styles', () => {
    const out = sanitizeEmailHtml('<div style="width:10px;expression(alert(1));color:red">t</div>');
    expect(out).toContain('width: 10px');
    expect(out).toContain('color: red');
    expect(out).not.toContain('expression');
  });

  it('drops position:fixed/absolute except on tags that legitimately use them', () => {
    expect(sanitizeEmailHtml('<table style="position:fixed">t</table>')).toBe('<table>t</table>');
    expect(sanitizeEmailHtml('<div style="position:fixed">t</div>')).toContain('position: fixed');
    expect(sanitizeEmailHtml('<td style="position:absolute">t</td>')).toContain('position: absolute');
  });

  it('strips url(https://…) from inline style values', () => {
    const out = sanitizeEmailHtml('<div style="background:url(https://evil.example/x.png);color:blue">t</div>');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('color: blue');
  });

  it('sanitises <style> blocks: @import and @font-face removed, remote url() neutralised', () => {
    const html = '<style>@import url("https://evil.example/x.css");@font-face{src:url(https://evil.example/f.woff)}p{color:red;background:url(https://evil.example/b.png)}</style>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain('<style>');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('@font-face');
    expect(out).toContain('color:red');
    expect(out).toContain('url(none)');
    expect(out).not.toContain('evil.example');
  });

  it('keeps style attribute off the tag entirely when nothing survives', () => {
    expect(sanitizeEmailHtml('<div style="expression(alert(1))">t</div>')).toBe('<div>t</div>');
  });
});

describe('email/helpers.js — sanitizeEmailHtml: text handling', () => {
  it('escapes text starting with a < that never forms a tag', () => {
    // no closing ">" after the "<" → the whole tail is treated as text.
    // (quirk: "a < b > c" drops "b" because the scan eats to the next ">" —
    // fail-safe rather than fail-open, so it is left as-is.)
    expect(sanitizeEmailHtml('a < b c')).toBe('a &lt; b c');
    expect(sanitizeEmailHtml('5 < 6')).toBe('5 &lt; 6');
  });

  it('does not double-encode existing HTML entities in text', () => {
    expect(sanitizeEmailHtml('Tom &amp; Jerry &#x27;s')).toBe('Tom &amp; Jerry &#x27;s');
  });

  it('escapes text left over after an unterminated tag', () => {
    expect(sanitizeEmailHtml('<p>ok</p><div class="x')).toBe('<p>ok</p>&lt;div class="x');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
    expect(sanitizeEmailHtml(undefined)).toBe('');
    expect(sanitizeEmailHtml(42)).toBe('');
  });

  it('keeps self-closing allowed tags', () => {
    expect(sanitizeEmailHtml('a<br/>b')).toBe('a<br />b');
    expect(sanitizeEmailHtml('a<hr>b')).toBe('a<hr>b');
  });
});
