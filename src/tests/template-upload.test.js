import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSignedTemplateFile } from '../template-upload.js';
import { parseSignedCommunityTemplateJson } from '../../supabase/functions/_shared/community-template.js';

const bundleJson = JSON.stringify({
  format: 'novapack-studio-user-template',
  version: 1,
  template: { name: 'Starter', files: { 'README.md': 'IyBIaQ==' } },
  signature: { algorithm: 'Ed25519', publicKey: 'AAAA', signature: 'AAAA' },
}, null, 2);
const base64Json = Buffer.from(bundleJson).toString('base64');

const upload = (content) => new File([content], 'signed.nbtemplate');
const textOf = async (blob) => await blob.text();

test('passes UTF-8 JSON through unchanged', async () => {
  assert.equal(await textOf(await normalizeSignedTemplateFile(upload(bundleJson))), bundleJson);
});

test('passes Base64 uploads through for the server to decode', async () => {
  const wrapped = base64Json.replace(/(.{76})/g, '$1\n');
  for (const content of [base64Json, `${base64Json}\r\n`, wrapped, `\uFEFFbase64:${base64Json}`]) {
    const out = await textOf(await normalizeSignedTemplateFile(upload(content)));
    assert.equal(out.replace(/\s/g, '').replace(/^base64:/, ''), base64Json);
  }
});

test('re-encodes UTF-16 JSON and UTF-16 Base64 as UTF-8', async () => {
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(await textOf(await normalizeSignedTemplateFile(upload(utf16(bundleJson)))), bundleJson);
  assert.equal(await textOf(await normalizeSignedTemplateFile(upload(utf16(base64Json)))), base64Json);
});

test('rejects empty, truncated, and invalid JSON uploads', async () => {
  await assert.rejects(normalizeSignedTemplateFile(upload('  \n')), /is empty/);
  await assert.rejects(normalizeSignedTemplateFile(upload('{ "format": ')), /complete JSON bundle/);
  await assert.rejects(normalizeSignedTemplateFile(upload('{ "format": , }')), /not valid JSON/);
});

test('what the client sends is accepted by the server parser (both forms)', async () => {
  for (const content of [bundleJson, base64Json]) {
    const blob = await normalizeSignedTemplateFile(upload(content));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // the fake signature fails at the trust check, which is after decoding succeeds
    await assert.rejects(
      parseSignedCommunityTemplateJson(bytes),
      /must be signed with NovaByte Trusted Signing/,
    );
  }
});
