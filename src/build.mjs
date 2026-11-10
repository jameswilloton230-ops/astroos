// Static-site optimiser for the split markup/styling/logic source — same four
// steps as before (CSS purge, CSS minify, JS minify, HTML minify), just reading
// from three files instead of regex-slicing one.
import { readFileSync, writeFileSync } from 'node:fs';
import { build as esbuildBuild, transform as esbuildTransform } from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-next';
import { PurgeCSS } from 'purgecss';
import postcss from 'postcss';

const SRC_DIR = '.';
const OUT_FILE = `${SRC_DIR}/index.html`;

const html = readFileSync(`${SRC_DIR}/markup.html`, 'utf8');
const css = readFileSync(`${SRC_DIR}/styling.css`, 'utf8');
const js = readFileSync(`${SRC_DIR}/logic.js`, 'utf8');
const publishingJs = readFileSync(`${SRC_DIR}/publishing.js`, 'utf8');
const revokedSignatures = JSON.parse(
  readFileSync('../NBOSP/js/platform/security/revoked-signatures.json', 'utf8')
);
if (!Array.isArray(revokedSignatures)) {
  throw new Error('NBOSP revoked-signatures.json must contain a list.');
}
writeFileSync(
  `${SRC_DIR}/revoked-signatures.json`,
  JSON.stringify(revokedSignatures)
);

// PurgeCSS's own CSS parser doesn't reliably handle native nesting (`&.is-revealed { ... }`
// inside a parent rule) — it was silently dropping the whole nested block, which killed
// the .is-revealed rule that un-hides scroll-triggered elements. Flatten nesting with
// esbuild first (which DOES understand it) so PurgeCSS only ever sees plain flat selectors.
const { code: flattenedCss } = await esbuildTransform(css, { loader: 'css', minify: false });

const touchSafeCss = postcss.parse(flattenedCss);
const hoverRules = [];
touchSafeCss.walkRules(rule => hoverRules.push(rule));
for (const rule of hoverRules) {
  const selectors = postcss.list.comma(rule.selector);
  const hoverSelectors = selectors.filter(selector => selector.includes(':hover'));
  if (!hoverSelectors.length) continue;

  const nonHoverSelectors = selectors.filter(selector => !selector.includes(':hover'));
  const guardedRule = rule.clone({
    selector: hoverSelectors
      .map(selector => `:root:not(.has-touch-input) ${selector}`)
      .join(', '),
  });
  const hoverMedia = postcss.atRule({
    name: 'media',
    params: '(hover: hover) and (pointer: fine)',
  }).append(guardedRule);

  if (nonHoverSelectors.length) {
    rule.selector = nonHoverSelectors.join(', ');
    rule.after(hoverMedia);
  } else {
    rule.replaceWith(hoverMedia);
  }
}

// --- Purge unused CSS rules (checks against tags/classes/ids actually used in the HTML + JS) ---
const purgeResult = await new PurgeCSS().purge({
  content: [
    { raw: html, extension: 'html' },
    { raw: js, extension: 'js' },
    { raw: publishingJs, extension: 'js' },
  ],
  css: [{ raw: touchSafeCss.toString() }],
  safelist: {
    // keep anything toggled purely via JS, plus scroll-triggered/state classes
    standard: [/^is-/, /^has-/, /^active$/, /^open$/, /^visible$/, /^lenis/],
    // CodeMirror injects all of its own classes (cm-editor, cm-scroller,
    // cm-content, cm-gutter, cm-line, etc.) into the DOM at runtime from
    // the esm.sh import — they never appear as literal strings in
    // markup.html or logic.js, so PurgeCSS was silently deleting every
    // .cm-* rule from the built CSS, including the fix for the file
    // preview's scroll container. "greedy" so it also keeps modifier
    // classes CM6 appends dynamically (cm-focused, cm-gutters, etc.)
    greedy: [/^cm-/],
  },
});
const purgedCss = purgeResult[0].css;

// --- Minify the purged CSS and the JS via esbuild ---
const { code: minifiedCss } = await esbuildTransform(purgedCss, { loader: 'css', minify: true, legalComments: 'none', target: 'esnext' });
const { outputFiles: [jsOutput] } = await esbuildBuild({
  entryPoints: ['logic.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  minify: true,
  target: 'esnext',
  legalComments: 'none',
});
const minifiedJs = jsOutput.text;

// --- Inline both back into the HTML shell so production ships as one file ---
// (keeps the deploy artifact identical in shape to the old single-file build —
// one request instead of three, no separate cache invalidation to think about)
let outHtml = html
  .replace('<link rel="stylesheet" href="styling.css">', `<style>${minifiedCss}</style>`)
  .replace('<script type="module" src="logic.js"></script>', '<script id="novabyte-module-bundle"></script>');

// --- Minify the HTML shell itself ---
const finalHtml = await minifyHtml(outHtml, {
  collapseWhitespace: true,
  removeComments: true,
  removeRedundantAttributes: true,
  useShortDoctype: true,
  collapseBooleanAttributes: true,
  removeAttributeQuotes: true,
  removeEmptyAttributes: true,
  removeOptionalTags: false, // risky with your custom elements/data-attrs; skip
  sortAttributes: true,
  sortClassNames: true,
  // minifyCSS/minifyJS OFF: html-minifier-terser's internal CSS minifier (clean-css)
  // doesn't understand native `&` nesting inside @supports blocks and silently drops
  // those rules (this killed .is-revealed, the fallback path for browsers without
  // scroll-driven animations). We already minify CSS/JS ourselves with esbuild above,
  // so this would just be a second, worse pass anyway -- leave those blocks alone.
  minifyCSS: false,
  minifyJS: false,
});

const finalHtmlWithBundle = finalHtml.replace(
  /<script\b[^>]*\bid=["']?novabyte-module-bundle["']?[^>]*><\/script>/i,
  () => `<script type="module">${minifiedJs.trim()}</script>`
);
if (finalHtmlWithBundle === finalHtml) throw new Error('Could not insert the bundled website JavaScript.');
writeFileSync(OUT_FILE, finalHtmlWithBundle);

const before = Buffer.byteLength(html, 'utf8') + Buffer.byteLength(css, 'utf8')
  + Buffer.byteLength(js, 'utf8') + Buffer.byteLength(publishingJs, 'utf8');
const after = Buffer.byteLength(finalHtmlWithBundle, 'utf8');
console.log(`Before: ${(before / 1024).toFixed(1)} KB`);
console.log(`After:  ${(after / 1024).toFixed(1)} KB`);
console.log(`Saved:  ${(((before - after) / before) * 100).toFixed(1)}%`);
