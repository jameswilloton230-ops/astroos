import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  compareCommunityTemplateVersions,
  encodeCommunityTemplateFiles,
  MAX_TEMPLATE_EXPANDED_BYTES,
  MAX_TEMPLATE_JSON_BYTES,
  NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
  parseCommunityTemplateJson,
  parseSignedCommunityTemplateJson,
  parseStudioCommunityTemplateBundle,
} from './community-template.js';

function makeUpload(overrides = {}) {
  return new TextEncoder().encode(JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template: {
      name: 'Starter Project',
      description: 'A reviewed starter project template.',
      author: 'NovaByte Community',
      releaseVersion: '1.0.0',
      category: 'general',
      icon: '✨',
      manifest: { formatVersion: 1 },
      files: { 'README.md': 'Starter content' },
      ...overrides,
    },
  }));
}

function makeStudioBundle() {
  const template = JSON.parse(new TextDecoder().decode(makeUpload())).template;
  template.files = Object.fromEntries(Object.entries(template.files).map(([path, text]) => [
    path,
    btoa(String.fromCharCode(...new TextEncoder().encode(text))),
  ]));
  return new TextEncoder().encode(JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template,
  }));
}

test('accepts an unsigned version-one template wrapper and preserves content', () => {
  const parsed = parseCommunityTemplateJson(makeUpload());
  assert.equal(parsed.format, 'novapack-studio-user-template');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.template.files['README.md'], 'Starter content');
});

test('accepts an exported .nbtemplate and decodes files only for validation', () => {
  const parsed = parseStudioCommunityTemplateBundle(makeStudioBundle());
  assert.equal(parsed.format, 'novapack-studio-user-template');
  assert.equal(parsed.template.files['README.md'], 'Starter content');
});

test('rejects a signed bundle as an initial unsigned template submission', () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = { algorithm: 'Ed25519', publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY, signature: 'invalid' };
  assert.throws(
    () => parseStudioCommunityTemplateBundle(new TextEncoder().encode(JSON.stringify(bundle))),
    /unsigned Studio \.nbtemplate/i,
  );
});

test('requires the pinned NovaByte signing key for signed templates', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = { algorithm: 'Ed25519', publicKey: 'not-the-pinned-key', signature: 'AA' };
  await assert.rejects(
    parseSignedCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(bundle))),
    /NovaByte Trusted Signing/,
  );
});

test('rejects a signed template with an invalid Ed25519 signature', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  const zeros = String.fromCharCode(...new Uint8Array(64));
  bundle.signature = {
    algorithm: 'Ed25519',
    publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
    signature: btoa(zeros).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  };
  await assert.rejects(
    parseSignedCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(bundle))),
    /failed NovaByte signature verification/,
  );
});

test('decodes a Base64-encoded signed template before verifying it', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = {
    algorithm: 'Ed25519',
    publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
    signature: btoa(String.fromCharCode(...new Uint8Array(64)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(bundle));
  const encoded = btoa(String.fromCharCode(...jsonBytes));
  const inputs = [
    encoded,
    `base64:${encoded}`,
    JSON.stringify(encoded),
    JSON.stringify(JSON.stringify(bundle)),
    `data:application/octet-stream;base64,${encoded}`,
    `\uFEFF${encoded}`,
    `\u200B${JSON.stringify(bundle)}`,
    ` \`\`\`json\n${JSON.stringify(bundle)}\n\`\`\` `,
  ];
  for (const input of inputs) {
    await assert.rejects(
      parseSignedCommunityTemplateJson(new TextEncoder().encode(input)),
      /failed NovaByte signature verification/,
    );
  }
});

test('accepts UTF-8 and UTF-16 JSON bundles with Base64 file contents', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = {
    algorithm: 'Ed25519',
    publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
    signature: btoa(String.fromCharCode(...new Uint8Array(64)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  };
  const json = JSON.stringify(bundle);
  const utf8 = new TextEncoder().encode(json);
  const toUtf16le = text => {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      bytes[index * 2] = code & 0xff;
      bytes[index * 2 + 1] = code >> 8;
    }
    return bytes;
  };
  const utf16 = toUtf16le(json);
  const leadingSpaceUtf16 = toUtf16le(`  \n${json}`);
  for (const bytes of [utf8, utf16, leadingSpaceUtf16]) {
    await assert.rejects(
      parseSignedCommunityTemplateJson(bytes),
      /failed NovaByte signature verification/,
    );
  }
});

test('canonical JSON sorts keys recursively', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
    '{"a":{"b":3,"y":2},"z":1}',
  );
});

test('encodes reviewed UTF-8 text files in the format Studio verifies', () => {
  const parsed = parseCommunityTemplateJson(makeUpload({
    files: { 'src/index.js': 'const title = "café";' },
  }));
  const signedTemplate = encodeCommunityTemplateFiles(parsed.template);
  assert.notEqual(signedTemplate.files['src/index.js'], parsed.template.files['src/index.js']);
  assert.equal(
    new TextDecoder().decode(Uint8Array.from(atob(signedTemplate.files['src/index.js']), character => character.charCodeAt(0))),
    'const title = "café";',
  );
});

test('rejects path traversal, hidden, dependency, and manifest-collision paths', () => {
  for (const path of ['../secret', 'folder/../../secret', '.git/config', 'node_modules/pkg', 'src/manifest.json']) {
    assert.throws(
      () => parseCommunityTemplateJson(makeUpload({ files: { [path]: 'content' } })),
      /unsafe|reserved metadata/i,
    );
  }
});

test('rejects prototype keys in nested JSON and duplicate file paths across case', () => {
  const unsafe = makeUpload();
  const unsafeObject = JSON.parse(new TextDecoder().decode(unsafe));
  unsafeObject.template.manifest.constructor = 'unsafe';
  assert.throws(
    () => parseCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(unsafeObject))),
    /forbidden key/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'src/main.ts': 'a', 'SRC/Main.ts': 'b' } })),
    /duplicate file path/i,
  );
});

test('enforces text-only files and expanded UTF-8 content limit', () => {
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'file.bin': { data: 'no' } } })),
    /must contain text/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'large.txt': 'é'.repeat(Math.floor(MAX_TEMPLATE_EXPANDED_BYTES / 2) + 1) } })),
    /2 MiB expanded-content limit/i,
  );
});

test('rejects unsupported fields, wrappers, and oversized JSON', () => {
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ description: 'x'.repeat(241) })),
    /Description must be between 10 and 240 characters/,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ icon: 'x'.repeat(101) })),
    /Icon must be between 1 and 100 characters/,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ screenshots: [] })),
    /exactly/i,
  );
  const bytes = makeUpload();
  const signedInput = JSON.parse(new TextDecoder().decode(bytes));
  signedInput.signature = {};
  assert.throws(
    () => parseCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(signedInput))),
    /only format, version, and template/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(new Uint8Array(MAX_TEMPLATE_JSON_BYTES + 1)),
    /between 1 byte and 4 MiB/i,
  );
});

test('compareCommunityTemplateVersions follows semver prerelease ordering', () => {
  assert.equal(compareCommunityTemplateVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareCommunityTemplateVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareCommunityTemplateVersions('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(compareCommunityTemplateVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareCommunityTemplateVersions('1.0.0+build', '1.0.0'), 0);
  assert.throws(() => compareCommunityTemplateVersions('1.0', '1.0.0'), /semantic versioning/);
});

test('rejects prototype-pollution keys nested deep in the template JSON', () => {
  const raw = JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template: {
      name: 'Starter Project',
      description: 'A reviewed starter project template.',
      author: 'NovaByte Community',
      releaseVersion: '1.0.0',
      category: 'general',
      icon: '✨',
      manifest: { nested: { ['__proto__']: 'nope' } },
      files: { 'README.md': 'Starter content' },
    },
  });
  assert.throws(
    () => parseCommunityTemplateJson(new TextEncoder().encode(raw)),
    /forbidden key/i,
  );
});

test('rejects .nbtemplate files whose base64 payloads decode to binary content', async () => {
  const template = JSON.parse(new TextDecoder().decode(makeUpload())).template;
  template.files = {
    'payload.bin': btoa(String.fromCharCode(0x00, 0x01, 0x02, 0xff)),
  };
  const bundle = new TextEncoder().encode(JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template,
  }));
  assert.throws(
    () => parseStudioCommunityTemplateBundle(bundle),
    /not valid UTF-8 text/,
  );
});

test('reports malformed raw JSON as a JSON problem, not a Base64 one', async () => {
  const bundle = new TextDecoder().decode(makeStudioBundle());
  const broken = {
    truncated: bundle.slice(0, -3),
    'trailing comma': bundle.replace('"version":1,', '"version":1,,'),
    'smart quote': bundle.replace('"format"', '\u201cformat"'),
    'two objects': bundle + bundle,
  };
  for (const [label, text] of Object.entries(broken)) {
    await assert.rejects(
      parseSignedCommunityTemplateJson(new TextEncoder().encode(text)),
      error => /is not valid JSON: /.test(error.message) && !/Base64/.test(error.message),
      label,
    );
  }
});

test('still names both accepted formats when the upload is neither JSON nor Base64', async () => {
  for (const text of ['not*base64*at*all', 'QUJD1', '"unterminated']) {
    await assert.rejects(
      parseSignedCommunityTemplateJson(new TextEncoder().encode(text)),
      /must be UTF-8 JSON or Base64-encoded UTF-8 JSON/,
      text,
    );
  }
});

test('explains exactly what is wrong when an upload fails both the JSON and Base64 checks', async () => {
  const json = new TextDecoder().decode(makeStudioBundle());
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  const replaceAt = (text, index, character) => text.slice(0, index) + character + text.slice(index + 1);
  const cases = [
    ['junk prefix then broken JSON', `signed:\n${json.slice(0, -3)}`, /is not valid JSON: /],
    ['unclosed brace', '{ "format": ', /is not valid JSON: .*no closing "\}"/],
    ['quoted JSON broken inside', JSON.stringify(json.slice(0, -3)), /quoted signed template is not valid JSON/],
    ['stray character in Base64', replaceAt(encoded, 50, '!'), /unexpected character \(U\+0021\) at position 51/],
    ['smart quotes around Base64', `\u201c${encoded}\u201d`, /unexpected character \(U\+201C\) at position 1/],
    ['truncated Base64', encoded.slice(0, 101), /impossible length/],
    ['mixed Base64 alphabets', replaceAt(replaceAt(encoded, 20, '-'), 40, '+'), /mixes standard/],
  ];
  for (const [label, text, expected] of cases) {
    await assert.rejects(
      parseSignedCommunityTemplateJson(new TextEncoder().encode(text)),
      error => expected.test(error.message),
      label,
    );
  }
});
