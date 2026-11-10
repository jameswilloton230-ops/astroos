export function safeHttpsUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function packageDownloadUrl(value, fileName, baseUrl) {
  const href = safeHttpsUrl(value, baseUrl);
  if (!href) return null;

  const url = new URL(href);
  if (url.pathname.includes('/storage/v1/object/')) {
    url.searchParams.set('download', String(fileName));
  }
  return url.href;
}
