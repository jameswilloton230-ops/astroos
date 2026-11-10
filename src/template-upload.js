function decodeUploadText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  }
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < Math.min(bytes.length, 256); index++) {
    if (bytes[index] === 0) {
      if (index % 2) oddNulls++;
      else evenNulls++;
    }
  }
  const encoding = oddNulls >= 4 && oddNulls > evenNulls * 2
    ? 'utf-16le'
    : evenNulls >= 4 && evenNulls > oddNulls * 2
      ? 'utf-16be'
      : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

// Reviewers may upload the signed bundle as UTF-8 JSON or as its Base64
// encoding, and the publisher API accepts both. Windows tools often save
// either one as UTF-16, so re-encode to UTF-8 here and leave Base64 decoding
// and validation to the server.
export async function normalizeSignedTemplateFile(file) {
  const text = decodeUploadText(new Uint8Array(await file.arrayBuffer()))
    .replace(/^\uFEFF/, '')
    .trim();
  if (!text) throw new Error('The selected .nbtemplate is empty.');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0) {
    // Base64 never contains "{", so no brace means the encoded form.
    return new Blob([text], { type: 'application/octet-stream' });
  }
  if (end <= start) {
    throw new Error('The selected .nbtemplate must contain the complete JSON bundle.');
  }
  const json = text.slice(start, end + 1);
  let bundle;
  try {
    bundle = JSON.parse(json);
  } catch {
    throw new Error('The selected .nbtemplate is not valid JSON. Save the complete bundle as a JSON .nbtemplate file.');
  }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('The selected .nbtemplate must be a JSON object.');
  }
  return new Blob([json], { type: 'application/octet-stream' });
}
