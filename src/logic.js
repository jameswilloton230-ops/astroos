import { blake3 } from '@noble/hashes/blake3.js';
import { publisherPortal } from './publishing.js';
import { scrollToPosition, scrollToTop } from './smooth-scroll.js';

const touchHoverGuard = document.documentElement;
document.addEventListener('touchstart', () => {
  touchHoverGuard.classList.add('has-touch-input');
}, { passive: true });
document.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch') {
    touchHoverGuard.classList.add('has-touch-input');
  } else if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
    touchHoverGuard.classList.remove('has-touch-input');
  }
}, { passive: true });

// Icon SVG paths — Lucide-compatible strokes, inline so there's no icon library dep.
const ICONS = {
  'file-text': `<polyline points="14 2 14 8 20 8"/><path d="M20 8V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`,
  'calculator': `<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="10" x2="16" y2="14"/><line x1="8" y1="10" x2="8" y2="10"/><line x1="12" y1="10" x2="12" y2="10"/><line x1="8" y1="14" x2="8" y2="14"/><line x1="12" y1="14" x2="12" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/>`,
  'grid': `<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`,
  'box': `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
  'terminal': `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
  'music': `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  'image': `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`,
  'gamepad': `<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="17" y1="10" x2="17.01" y2="10"/><path d="M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>`,
  'settings': `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
};

function iconSvg(name) {
  const paths = ICONS[name] ?? ICONS['box'];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" aria-hidden="true">${paths}</svg>`;
}

function setAppIcon(container, app) {
  const icon = typeof app.icon === 'string' ? app.icon : '';
  const hasImageIcon = /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,|https:\/\/|\/|apps\/)/i.test(icon);
  if (!hasImageIcon) {
    container.innerHTML = iconSvg(icon);
    return;
  }

  const image = document.createElement('img');
  image.src = icon;
  image.alt = `${app.name} icon`;
  image.loading = 'lazy';
  image.onerror = () => {
    container.innerHTML = iconSvg(icon);
  };
  container.replaceChildren(image);
}

function badgesHtml(categories = []) {
  return categories.map(c => `<span class="badge">${escHtml(c)}</span>`).join('');
}

const packageCache = new Map();
const verificationCache = new Map();
const pendingBadges = new WeakMap();
let siteTrustDataPromise;
const badgeObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        badgeObserver.unobserve(entry.target);
        const pending = pendingBadges.get(entry.target);
        if (pending) verifyBadge(pending.badge, pending.app);
      }
    })
  : null;

async function fetchPackage(app) {
  if (!packageCache.has(app.id)) {
    const request = (async () => {
      const response = await fetch(new URL(app.file, document.baseURI));
      if (!response.ok) throw new Error(`Package request failed (${response.status})`);
      const pkg = await response.json();
      if (!pkg || pkg.novabyte_app !== true || pkg.manifest?.id !== app.id) {
        throw new Error(`Package identity does not match catalog entry "${app.id}".`);
      }
      return pkg;
    })();
    packageCache.set(app.id, request);
    request.catch(() => packageCache.delete(app.id));
  }
  return packageCache.get(app.id);
}

function loadSiteTrustData() {
  if (!siteTrustDataPromise) {
    siteTrustDataPromise = Promise.all([
      fetch('trusted-signers.json').then(response => {
        if (!response.ok) throw new Error(`Trusted signer list request failed (${response.status})`);
        return response.json();
      }),
      fetch('revoked-signatures.json').then(response => {
        if (!response.ok) throw new Error(`Revocation list request failed (${response.status})`);
        return response.json();
      }),
    ]).then(([signers, revocations]) => {
      if (!Array.isArray(signers) || !Array.isArray(revocations)) {
        throw new Error('Store verification data must contain lists.');
      }
      return { signers, revocations };
    });
  }
  return siteTrustDataPromise;
}

function signingPayload(pkg) {
  return JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at,
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
}

function decodeBase64(encoded) {
  if (typeof encoded !== 'string') return null;
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function digest(method, bytes) {
  if (method === 'blake3') return blake3(bytes);
  if (method !== 'sha256' && method !== 'sha512') return null;
  const algorithm = method === 'sha256' ? 'SHA-256' : 'SHA-512';
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

async function verifyPackageIntegrity(pkg) {
  if (!pkg.integrity) return false;
  const { method, payloadHash, fileHashes } = pkg.integrity;
  if (method === 'none' || !payloadHash) return true;

  const payloadDigest = await digest(method, new TextEncoder().encode(signingPayload(pkg)));
  if (!payloadDigest || bytesToHex(payloadDigest) !== String(payloadHash).toLowerCase()) return false;

  for (const [file, expectedHash] of Object.entries(fileHashes || {})) {
    const fileBytes = decodeBase64(pkg.files?.[file]);
    if (!fileBytes) return false;
    const fileDigest = await digest(method, fileBytes);
    if (!fileDigest || bytesToHex(fileDigest) !== String(expectedHash).toLowerCase()) return false;
  }
  return true;
}

async function verifyPackageSignature(pkg, app) {
  const { signers, revocations } = await loadSiteTrustData();
  const signature = pkg.signature;
  if (typeof signature !== 'string' || !signature) return null;
  const revoked = revocations.some(record =>
    (typeof record === 'string' ? record : record?.signature) === signature
  );
  if (revoked) return null;

  const method = String(pkg.signing?.method || 'ed25519').toLowerCase();
  if (method !== 'ed25519' || !(await verifyPackageIntegrity(pkg))) return null;
  const signatureBytes = decodeHex(signature);
  if (!signatureBytes) return null;
  const payload = new TextEncoder().encode(signingPayload(pkg));

  for (const signer of signers) {
    if (String(signer.method || 'ed25519').toLowerCase() !== method || !signer.publicKey) continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        signer.publicKey,
        { name: 'Ed25519' },
        false,
        ['verify']
      );
      if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, payload)) {
        return { name: signer.name || app.author || 'Trusted publisher' };
      }
    } catch (error) {
      console.warn(`[Store] Could not verify ${app.id} with signer ${signer.name || signer.id}:`, error);
    }
  }
  return null;
}

function verifyCatalogApp(app) {
  if (!verificationCache.has(app.id)) {
    const verification = fetchPackage(app)
      .then(pkg => verifyPackageSignature(pkg, app))
      .catch(error => {
        console.warn(`[Store] Could not verify ${app.id}:`, error);
        return null;
      });
    verificationCache.set(app.id, verification);
  }
  return verificationCache.get(app.id);
}

function verifyBadge(badge, app) {
  badge.hidden = true;
  verifyCatalogApp(app).then(result => {
    if (!result) return;
    badge.textContent = '✓ Verified';
    badge.title = `Signature and integrity verified: ${result.name}`;
    badge.setAttribute('aria-label', `Verified publisher: ${result.name}`);
    badge.hidden = false;
  });
}

function attachVerifiedBadge(badge, app, observeTarget, eager = false) {
  badge.hidden = true;
  if (!eager && badgeObserver && observeTarget) {
    pendingBadges.set(observeTarget, { badge, app });
    badgeObserver.observe(observeTarget);
    return;
  }
  verifyBadge(badge, app);
}

function permissionName(permission) {
  const labels = {
    'clipboard:read': 'Read clipboard',
    'clipboard:write': 'Write clipboard',
    'net:external': 'Internet access',
    'net:internal': 'Internal network access',
    'net:websocket': 'WebSocket access',
    'device:notifications': 'Notifications',
    'device:camera': 'Camera',
    'device:microphone': 'Microphone',
    'device:geolocation': 'Location',
    'fs:access': 'Manage all files',
    'fs:metadata': 'Read shared media metadata',
    'fs:read:images': 'Read shared images',
    'fs:read:video': 'Read shared videos',
    'fs:read:audio': 'Read shared audio',
  };
  return labels[permission] || permission;
}

function safeWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeAssetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const base = new URL(document.baseURI);
    const url = new URL(value, base);
    return url.origin === base.origin && ['https:', 'http:'].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function packageImageUrl(value, pkg) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(value)) return value;
  const packagedFile = pkg?.files?.[value];
  if (typeof packagedFile === 'string') {
    const extension = value.split('.').pop()?.toLowerCase();
    const mime = extension === 'svg' ? 'image/svg+xml'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'gif' ? 'image/gif'
      : extension === 'webp' ? 'image/webp'
      : extension === 'png' ? 'image/png'
      : null;
    if (mime) return `data:${mime};base64,${packagedFile}`;
  }
  return safeAssetUrl(value);
}

function packageDownloadUrl(value, fileName) {
  const url = new URL(value, document.baseURI);
  if (url.pathname.includes('/storage/v1/object/')) {
    url.searchParams.set('download', fileName);
  }
  return url.href;
}

// ── State ──────────────────────────────────────────────────────────────────

let allApps = [];
let allStudioPlugins = [];
let allCommunityTemplates = [];
let activeCategory = 'all';
let searchQuery = '';
let catalogMode = 'apps';
let pluginCollection = 'all';
let pluginFavorites = new Set();
const catalogRatingSummaries = new Map();
const catalogRatingStatus = new Map();

try {
  const savedFavorites = JSON.parse(localStorage.getItem('novabyte-studio-plugin-favorites') || '[]');
  if (Array.isArray(savedFavorites) && savedFavorites.every(id => typeof id === 'string')) {
    pluginFavorites = new Set(savedFavorites);
  }
} catch (error) {
  console.warn('[Store] Could not restore saved Studio plugin favorites:', error);
}

// ── DOM refs ───────────────────────────────────────────────────────────────

const siteHeader    = document.querySelector('.site-header');
const storeView     = document.getElementById('store-view');
const detailView    = document.getElementById('detail-view');
const grid          = document.getElementById('apps-grid');
const gridLoading   = document.getElementById('grid-loading');
const gridEmpty     = document.getElementById('grid-empty');
const gridHeading   = document.getElementById('grid-heading');
const sectionEyebrow = document.getElementById('section-eyebrow');
const resultsCount  = document.getElementById('results-count');
const catalogCount  = document.getElementById('catalog-count');
const catalogCountLabel = document.getElementById('catalog-count-label');
const catalogEyebrow = document.getElementById('catalog-eyebrow');
const catalogDescription = document.getElementById('catalog-description');
const storeHeading = document.getElementById('store-heading');
const categoryBar   = document.querySelector('.category-bar');
const catalogSwitch = document.querySelector('.catalog-switch');
const pluginCatalogTools = document.getElementById('plugin-catalog-tools');
const pluginCollections = document.getElementById('plugin-collections');
const pluginSort = document.getElementById('plugin-sort');
const pluginPublisherFilter = document.getElementById('plugin-publisher-filter');
const pluginCompatibilityFilter = document.getElementById('plugin-compatibility-filter');
const pluginRatingFilter = document.getElementById('plugin-rating-filter');
const catalogModeWarning = document.getElementById('catalog-mode-warning');
const searchInput   = document.getElementById('search-input');
const backBtn       = document.getElementById('back-btn');
const communityDetailView = document.getElementById('community-detail-view');
const communityDetailBack = document.getElementById('community-detail-back');
const communityDetailIcon = document.getElementById('community-detail-icon');
const communityDetailKicker = document.getElementById('community-detail-kicker');
const communityDetailName = document.getElementById('community-detail-name');
const communityDetailAuthor = document.getElementById('community-detail-author');
const communityDetailCats = document.getElementById('community-detail-cats');
const communityDetailDownload = document.getElementById('community-detail-download');
const communityDetailDownloadLabel = document.getElementById('community-detail-download-label');
const communityDetailFormat = document.getElementById('community-detail-format');
const communityDetailStats = document.getElementById('community-detail-stats');
const communityDetailTrust = document.getElementById('community-detail-trust');
const communityDetailAboutTitle = document.getElementById('community-detail-about-title');
const communityDetailDescription = document.getElementById('community-detail-description');
const communityDetailReleaseSection = document.getElementById('community-detail-release-section');
const communityDetailReleaseNotes = document.getElementById('community-detail-release-notes');
const communityDetailRatings = document.getElementById('community-detail-ratings');
const communityDetailInfo = document.getElementById('community-detail-info');
const communityDetailSafety = document.getElementById('community-detail-safety');

const featuredSection = document.getElementById('featured-section');
const featuredCard    = document.getElementById('featured-card');
const featuredIcon    = document.getElementById('featured-icon');
const featuredName    = document.getElementById('featured-name');
const featuredAuthor  = document.getElementById('featured-author');
const featuredDesc    = document.getElementById('featured-desc');
const featuredBadges  = document.getElementById('featured-badges');
const featuredVersion = document.getElementById('featured-version');
const featuredArt     = document.getElementById('featured-art');

const detailIcon     = document.getElementById('detail-icon');
const detailName     = document.getElementById('detail-name');
const detailVerified = document.getElementById('detail-verified');
const detailAuthor   = document.getElementById('detail-author');
const detailCats     = document.getElementById('detail-cats');
const detailDesc     = document.getElementById('detail-desc');
const detailId       = document.getElementById('detail-id');
const detailVersion  = document.getElementById('detail-version');
const detailSize     = document.getElementById('detail-size');
const detailDev      = document.getElementById('detail-dev');
const detailDownload = document.getElementById('detail-download');
const readMoreBtn    = document.getElementById('read-more-btn');
const detailScreenshots = document.getElementById('detail-screenshots');
const detailScreenshotList = document.getElementById('detail-screenshot-list');
const screenshotPreviewDialog = document.getElementById('screenshot-preview-dialog');
const screenshotPreviewImage = document.getElementById('screenshot-preview-image');
const screenshotPreviewCaption = document.getElementById('screenshot-preview-caption');
const screenshotPreviewClose = document.getElementById('screenshot-preview-close');
const detailPermissions = document.getElementById('detail-permissions');
const detailRequiredPermissions = document.getElementById('detail-required-permissions');
const detailOptionalPermissions = document.getElementById('detail-optional-permissions');
const detailLicense      = document.getElementById('detail-license');
const detailLicenseChip  = document.getElementById('detail-license-chip');
const detailReleaseNotes = document.getElementById('detail-release-notes');
const detailReleaseNotesSection = document.getElementById('detail-release-notes-section');
const detailRatings = document.getElementById('detail-ratings');
const detailLinks = document.getElementById('detail-links');
const detailRootWarning   = document.getElementById('detail-root-warning');
const detailSafetyBar     = document.getElementById('detail-safety-bar');
const detailSafetyFill    = document.getElementById('detail-safety-fill');
const detailSafetyLabel   = document.getElementById('detail-safety-label');
const detailVersionHistory = document.getElementById('detail-version-history');
const detailVersionHistoryList = document.getElementById('detail-version-history-list');

function catalogRatingKey(catalogType, itemId) {
  return `${catalogType}:${itemId}`;
}

function catalogRatingErrorMessage(error) {
  const message = error?.message || String(error);
  return /get_catalog_rating_|publisher_catalog_ratings|schema cache/i.test(message)
    ? 'Community ratings are not set up yet. Apply the catalog ratings migration to enable them.'
    : message;
}

function ratingSummaryElement(catalogType, itemId) {
  const element = document.createElement('span');
  element.className = 'catalog-rating-summary';
  const summary = catalogRatingSummaries.get(catalogRatingKey(catalogType, itemId));
  if (!publisherPortal.configured || catalogRatingStatus.get(catalogType) === 'error') {
    element.textContent = 'Ratings unavailable';
    return element;
  }
  if (!summary?.ratingCount) {
    element.textContent = '☆ No ratings yet';
    return element;
  }
  const count = document.createElement('span');
  count.textContent = `(${summary.ratingCount})`;
  element.append(document.createTextNode(`★ ${Number(summary.averageRating).toFixed(1)} `), count);
  return element;
}

async function loadCatalogRatingSummaries(catalogType, items) {
  catalogRatingStatus.set(catalogType, 'loading');
  try {
    const summaries = await publisherPortal.fetchCatalogRatingSummaries(
      catalogType,
      items.map(item => item.id),
    );
    if (!Array.isArray(summaries)) throw new Error('The rating service returned an invalid response.');
    for (const summary of summaries) {
      if (typeof summary.item_id !== 'string') continue;
      const averageRating = Number(summary.average_rating);
      const ratingCount = Number(summary.rating_count);
      if (!Number.isFinite(averageRating) || !Number.isInteger(ratingCount) || ratingCount < 1) continue;
      catalogRatingSummaries.set(catalogRatingKey(catalogType, summary.item_id), {
        averageRating,
        ratingCount,
      });
    }
    catalogRatingStatus.set(catalogType, 'loaded');
  } catch (error) {
    catalogRatingStatus.set(catalogType, 'error');
    console.warn(`[Store] Could not load ${catalogType} ratings:`, error);
  }
}

function updatePluginFilterOptions() {
  const populate = (select, values, firstLabel) => {
    const selected = select.value;
    select.replaceChildren(new Option(firstLabel, 'all'));
    for (const value of values) select.add(new Option(value, value));
    select.value = values.includes(selected) ? selected : 'all';
  };
  populate(pluginPublisherFilter,
    [...new Set(allStudioPlugins.map(plugin => plugin.publisher).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    'All publishers');
  populate(pluginCompatibilityFilter,
    [...new Set(allStudioPlugins.map(plugin => plugin.compatibleStudio).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    'All versions');
}

function savePluginFavorites() {
  try {
    localStorage.setItem('novabyte-studio-plugin-favorites', JSON.stringify([...pluginFavorites]));
    return true;
  } catch (error) {
    console.warn('[Store] Could not save Studio plugin favorites:', error);
    return false;
  }
}

function pluginFavoriteButton(plugin) {
  const saved = pluginFavorites.has(plugin.id);
  const button = document.createElement('button');
  button.className = `plugin-favorite${saved ? ' is-saved' : ''}`;
  button.type = 'button';
  button.setAttribute('aria-pressed', String(saved));
  button.setAttribute('aria-label', `${saved ? 'Remove' : 'Save'} ${plugin.name} ${saved ? 'from' : 'to'} favorites`);
  button.title = saved ? 'Remove from saved plugins' : 'Save plugin';
  button.textContent = saved ? '♥' : '♡';
  button.addEventListener('click', () => {
    if (pluginFavorites.has(plugin.id)) pluginFavorites.delete(plugin.id);
    else pluginFavorites.add(plugin.id);
    const savedSuccessfully = savePluginFavorites();
    renderGrid();
    if (!savedSuccessfully) {
      pluginCatalogTools.querySelector('.plugin-tools-notice')?.remove();
      const warning = document.createElement('p');
      warning.className = 'plugin-tools-notice';
      warning.textContent = 'Your favorites changed for this session, but could not be saved on this device.';
      pluginCatalogTools.appendChild(warning);
    }
  });
  return button;
}

// ── Fetch apps ─────────────────────────────────────────────────────────────

async function loadApps() {
  try {
    const res = await fetch('apps.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    if (!Array.isArray(catalog)) throw new Error('App catalog must contain a list.');
    const [remoteCatalog, pluginCatalog, templateCatalog] = await Promise.all([
      publisherPortal.fetchPublishedApps().catch(error => {
        console.warn('[Store] Could not load community-published apps:', error);
        return [];
      }),
      publisherPortal.fetchPublishedPlugins().catch(error => {
        console.warn('[Store] Could not load Studio plugins:', error);
        return [];
      }),
      publisherPortal.fetchPublishedTemplates().catch(error => {
        console.warn('[Store] Could not load Studio templates:', error);
        return [];
      }),
    ]);
    allStudioPlugins = pluginCatalog.filter(plugin =>
      plugin &&
      typeof plugin.id === 'string' &&
      typeof plugin.name === 'string' &&
      typeof plugin.file === 'string'
    );
    allCommunityTemplates = templateCatalog.filter(template =>
      template &&
      typeof template.id === 'string' &&
      typeof template.name === 'string' &&
      typeof template.file === 'string'
    );
    const mergedCatalog = new Map(catalog.map(app => [app.id, app]));
    for (const app of remoteCatalog) mergedCatalog.set(app.id, app);
    allApps = [...mergedCatalog.values()].filter(app =>
      app &&
      typeof app.id === 'string' &&
      typeof app.name === 'string' &&
      typeof app.file === 'string'
    );
    updatePluginFilterOptions();
    renderCategories();
    catalogCount.textContent = String(catalogSize(catalogMode)).padStart(2, '0');
    await Promise.all([
      loadCatalogRatingSummaries('apps', allApps),
      loadCatalogRatingSummaries('plugins', allStudioPlugins),
      loadCatalogRatingSummaries('templates', allCommunityTemplates),
    ]);
  } catch (err) {
    console.error('Could not load apps.json:', err);
    allApps = [];
  } finally {
    gridLoading.classList.add('hidden');
    renderFeatured();
    renderGrid();
    // Open deep-linked catalog items on first load.
    if (location.hash.length > 1) {
      const hash = location.hash.slice(1);
      const [kind, ...path] = hash.split('/');
      if (path.length) {
        let itemId;
        try {
          itemId = decodeURIComponent(path.join('/'));
        } catch (error) {
          console.warn('[Store] Could not decode catalog detail route:', error);
        }
        if (itemId && kind === 'plugin') {
          const plugin = allStudioPlugins.find(item => item.id === itemId);
          if (plugin) openCommunityDetail(plugin, 'plugins');
        } else if (itemId && kind === 'template') {
          const template = allCommunityTemplates.find(item => item.id === itemId);
          if (template) openCommunityDetail(template, 'templates');
        }
      } else {
        const app = allApps.find(item => item.id === hash);
        if (app) openDetail(app);
      }
    }
  }
}

function renderCategories() {
  const categories = [...new Set(allApps.flatMap(app =>
    Array.isArray(app.categories) ? app.categories.filter(category => typeof category === 'string') : []
  ))].sort((a, b) => a.localeCompare(b));
  const labels = { personalization: 'Personalization' };
  const entries = [
    { id: 'all', label: 'All apps', count: allApps.length },
    ...categories.map(id => ({
      id,
      label: labels[id] || id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
      count: allApps.filter(app => app.categories?.includes(id)).length,
    })),
  ];
  if (!entries.some(entry => entry.id === activeCategory)) activeCategory = 'all';

  categoryBar.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cat-btn${entry.id === activeCategory ? ' is-active' : ''}`;
    button.dataset.cat = entry.id;
    button.setAttribute('aria-pressed', String(entry.id === activeCategory));
    const label = document.createElement('span');
    label.textContent = entry.label;
    const count = document.createElement('span');
    count.className = 'category-count';
    count.textContent = String(entry.count);
    button.append(label, count);
    categoryBar.appendChild(button);
  }
}

// ── Featured ───────────────────────────────────────────────────────────────

function renderFeatured() {
  if (catalogMode !== 'apps') {
    featuredSection.hidden = true;
    featuredName.dataset.appId = '';
    delete featuredCard.dataset.catalogItem;
    delete featuredCard.dataset.catalogType;
    featuredArt.replaceChildren();
    return;
  }
  // Only show featured when browsing all categories with no search
  const app = allApps.find(candidate => candidate.featured === true)
    || (allApps.length >= 4 ? allApps[0] : null);
  if (activeCategory !== 'all' || searchQuery || !app) {
    featuredSection.hidden = true;
    featuredName.dataset.appId = '';
    delete featuredCard.dataset.catalogItem;
    delete featuredCard.dataset.catalogType;
    featuredArt.replaceChildren();
    return;
  }
  featuredSection.hidden = false;
  featuredName.dataset.appId = app.id;
  featuredCard.dataset.catalogItem = app.id;
  featuredCard.dataset.catalogType = 'apps';
  setAppIcon(featuredIcon, app);
  featuredArt.replaceChildren();
  renderFeaturedScreenshot(app);
  featuredName.textContent = app.name;
  const featuredVerified = document.createElement('span');
  featuredVerified.className = 'verified-badge';
  featuredVerified.textContent = '✓ Verified';
  attachVerifiedBadge(featuredVerified, app, featuredCard);
  const featuredFormat = document.createElement('span');
  featuredFormat.className = 'package-format-badge';
  featuredFormat.textContent = '.novaapp';
  featuredName.append(featuredVerified, featuredFormat);
  featuredAuthor.textContent = app.author ?? '';
  featuredDesc.textContent = app.description ?? '';
  featuredBadges.innerHTML = badgesHtml(app.categories);
  featuredVersion.textContent = `v${app.version}`;
  featuredCard.setAttribute('aria-label', `View ${app.name}`);
  featuredCard.onclick = () => openCatalogDetail('apps', app, featuredCard);
  featuredCard.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCatalogDetail('apps', app, featuredCard); }
  };
}

async function renderFeaturedScreenshot(app) {
  let pkg = null;
  try {
    pkg = await fetchPackage(app);
  } catch (error) {
    console.warn(`[Store] Could not load ${app.name} package for its featured screenshot:`, error);
  }

  if (featuredName.dataset.appId !== app.id || featuredSection.hidden) return;
  const screenshots = Array.isArray(app.screenshots) && app.screenshots.length
    ? app.screenshots
    : pkg?.manifest?.screenshots;
  if (!Array.isArray(screenshots)) return;

  const sources = screenshots.map(source => {
    if (typeof source !== 'string') return null;
    if (/^https:\/\//i.test(source)) return safeWebUrl(source);
    return pkg ? packageImageUrl(source, pkg) : safeAssetUrl(source);
  }).filter(Boolean);

  const showNextScreenshot = index => {
    if (featuredName.dataset.appId !== app.id || featuredSection.hidden || index >= sources.length) return;
    const image = document.createElement('img');
    image.src = sources[index];
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => showNextScreenshot(index + 1);
    featuredArt.replaceChildren(image);
  };
  showNextScreenshot(0);
}

// ── Grid ───────────────────────────────────────────────────────────────────

function filteredApps() {
  const q = searchQuery.trim().toLowerCase();
  return allApps.filter(app => {
    const matchesCat = activeCategory === 'all' || app.categories?.includes(activeCategory);
    const matchesSearch = !q
      || app.name.toLowerCase().includes(q)
      || app.description?.toLowerCase().includes(q)
      || app.id.toLowerCase().includes(q)
      || app.author?.toLowerCase().includes(q);
    return matchesCat && matchesSearch;
  });
}

function renderGrid() {
  if (catalogMode === 'plugins') {
    renderStudioPluginGrid();
    return;
  }
  if (catalogMode === 'templates') {
    renderCommunityTemplateGrid();
    return;
  }
  catalogModeWarning.hidden = true;
  gridEmpty.textContent = 'No apps match your search.';
  for (const card of grid.querySelectorAll('.app-card')) {
    badgeObserver?.unobserve(card);
    card.remove();
  }

  const apps = filteredApps();
  // In default view, skip the featured app — it already has the hero slot.
  const featuredId = featuredSection.hidden ? null : featuredName.dataset.appId;
  const gridApps = (activeCategory === 'all' && !searchQuery && featuredId)
    ? apps.filter(app => app.id !== featuredId)
    : apps;
  resultsCount.textContent = `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}`;
  gridHeading.textContent = activeCategory === 'all' && !searchQuery
    ? 'All apps'
    : searchQuery
      ? `Results for "${searchQuery}"`
      : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);
  sectionEyebrow.textContent = searchQuery ? 'FIND YOUR NEXT APP' : activeCategory === 'all' ? 'THE CATALOG' : 'BROWSE BY CATEGORY';

  if (apps.length === 0) {
    gridEmpty.textContent = searchQuery
      ? 'No apps match your search.'
      : 'No apps in this category yet.';
    gridEmpty.classList.remove('hidden');
    gridHeading.hidden = true;
    return;
  }

  gridEmpty.classList.add('hidden');
  gridHeading.hidden = false;

  for (const app of gridApps) {
    const card = document.createElement('article');
    card.className = 'app-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${app.name}`);
    card.dataset.id = app.id;
    card.dataset.catalogItem = app.id;
    card.dataset.catalogType = 'apps';
    card.dataset.category = app.categories?.[0] || 'other';

    card.innerHTML = `
      <div class="card-icon"></div>
      <div class="card-body">
        <div class="card-name"><span>${escHtml(app.name)}</span><span class="verified-badge" hidden></span><span class="package-format-badge">.novaapp</span></div>
        <div class="card-author">${escHtml(app.author ?? '')}</div>
        <p class="card-desc">${escHtml(app.description ?? '')}</p>
        <div class="card-footer">
          <div class="card-badges">${badgesHtml(app.categories)}</div>
          <span class="card-version">v${escHtml(app.version)}</span>
        </div>
        <div class="card-rating-slot"></div>
      </div>
      <div class="card-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `;
    attachVerifiedBadge(card.querySelector('.verified-badge'), app, card);
    setAppIcon(card.querySelector('.card-icon'), app);
    card.querySelector('.card-rating-slot').appendChild(ratingSummaryElement('apps', app.id));

    card.addEventListener('click', () => openCatalogDetail('apps', app, card));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCatalogDetail('apps', app, card); }
    });

    grid.appendChild(card);
  }
}

function renderStudioPluginGrid() {
  for (const card of grid.querySelectorAll('.app-card')) {
    badgeObserver?.unobserve(card);
    card.remove();
  }
  const query = searchQuery.trim().toLowerCase();
  const publisher = pluginPublisherFilter.value;
  const compatibility = pluginCompatibilityFilter.value;
  const minimumRating = Number(pluginRatingFilter.value);
  const matchesSearch = plugin => !query
    || plugin.name.toLowerCase().includes(query)
    || plugin.description?.toLowerCase().includes(query)
    || plugin.id.toLowerCase().includes(query)
    || plugin.publisher?.toLowerCase().includes(query)
    || plugin.compatibleStudio?.toLowerCase().includes(query);
  const plugins = allStudioPlugins.filter(plugin => {
    const summary = catalogRatingSummaries.get(catalogRatingKey('plugins', plugin.id));
    const matchesCollection = pluginCollection === 'favorites'
      ? pluginFavorites.has(plugin.id)
      : pluginCollection === 'top-rated'
        ? Boolean(summary?.ratingCount)
        : true;
    return matchesCollection
      && matchesSearch(plugin)
      && (publisher === 'all' || plugin.publisher === publisher)
      && (compatibility === 'all' || plugin.compatibleStudio === compatibility)
      && (!minimumRating || (summary?.ratingCount && summary.averageRating >= minimumRating));
  });
  const sortBy = pluginCollection === 'top-rated' ? 'rating'
    : pluginCollection === 'newest' ? 'newest'
      : pluginSort.value;
  plugins.sort((a, b) => {
    if (sortBy === 'rating') {
      const scoreDiff = (catalogRatingSummaries.get(catalogRatingKey('plugins', b.id))?.averageRating || 0)
        - (catalogRatingSummaries.get(catalogRatingKey('plugins', a.id))?.averageRating || 0);
      if (scoreDiff) return scoreDiff;
    }
    if (sortBy === 'newest') {
      const dateDiff = (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
      if (dateDiff) return dateDiff;
    }
    return a.name.localeCompare(b.name);
  });
  resultsCount.textContent = `${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'}`;
  gridHeading.hidden = false;
  gridHeading.textContent = searchQuery ? `Studio plugin results for "${searchQuery}"`
    : pluginCollection === 'favorites' ? 'Saved plugins'
      : pluginCollection === 'top-rated' ? 'Top-rated plugins'
        : pluginCollection === 'newest' ? 'Recently added plugins'
          : 'Studio plugins';
  sectionEyebrow.textContent = searchQuery ? 'FIND A PLUGIN'
    : pluginCollection === 'favorites' ? 'YOUR COLLECTION'
      : pluginCollection === 'top-rated' ? 'COMMUNITY FAVORITES'
        : pluginCollection === 'newest' ? 'FRESH RELEASES'
          : 'EXTEND YOUR WORKFLOW';
  featuredSection.hidden = true;
  categoryBar.hidden = true;
  catalogModeWarning.hidden = false;
  catalogModeWarning.textContent = 'Studio plugins run with full access to your computer. NovaByte reviews and signs marketplace packages, but a signature is not a guarantee of safety. Install only plugins you trust.';
  catalogCount.textContent = String(allStudioPlugins.length).padStart(2, '0');
  if (!plugins.length) {
    gridEmpty.textContent = searchQuery ? 'No Studio plugins match these search and filter settings.'
      : pluginCollection === 'favorites' ? 'No saved plugins match these filters yet.'
        : pluginCollection === 'top-rated' ? 'Plugins will appear here after the community rates them.'
          : 'No Studio plugins match these filters.';
    gridEmpty.classList.remove('hidden');
    return;
  }
  gridEmpty.classList.add('hidden');
  for (const plugin of plugins) {
    const card = document.createElement('article');
    card.className = 'app-card studio-plugin-card';
    card.dataset.catalogItem = plugin.id;
    card.dataset.catalogType = 'plugins';
    const safeFile = safeWebUrl(plugin.file);
    const downloadUrl = safeFile
      ? packageDownloadUrl(safeFile, `${plugin.id}-${plugin.version}.nbplugin`)
      : null;
    card.innerHTML = `
      <div class="card-body">
        <div class="card-name"><a class="community-card-title" href="#plugin/${encodeURIComponent(plugin.id)}">${escHtml(plugin.name)}</a><span class="verified-badge">✓ Verified</span><span class="package-format-badge">.nbplugin</span></div>
        <div class="card-author">by ${escHtml(plugin.publisher || 'Community publisher')}</div>
        <p class="card-desc">${escHtml(plugin.description || '')}</p>
        <p class="studio-plugin-card__compatibility">Requires Studio ${escHtml(plugin.compatibleStudio || 'version range unavailable')}</p>
        <div class="card-footer">
          <span class="card-version">${escHtml(plugin.id)} · v${escHtml(plugin.version)}</span>
        </div>
        <div class="card-rating-slot"></div>
      </div>
      <p class="studio-plugin-card__warning">Runs with full Node.js access. Review the publisher before enabling.</p>
      ${downloadUrl ? `<a class="studio-plugin-card__download" href="${escHtml(downloadUrl)}" download="${escHtml(`${plugin.id}-${plugin.version}.nbplugin`)}">Download .nbplugin</a>` : '<span class="studio-plugin-card__warning">Download link unavailable.</span>'}
    `;
    card.querySelector('.card-name').appendChild(pluginFavoriteButton(plugin));
    card.querySelector('.card-rating-slot').appendChild(ratingSummaryElement('plugins', plugin.id));
    card.querySelector('.community-card-title').addEventListener('click', event => {
      event.preventDefault();
      openCatalogDetail('plugins', plugin, card);
    });
    card.addEventListener('click', event => {
      if (event.target.closest('a, button')) return;
      openCatalogDetail('plugins', plugin, card);
    });
    grid.appendChild(card);
  }
}

function renderCommunityTemplateGrid() {
  for (const card of grid.querySelectorAll('.app-card')) {
    badgeObserver?.unobserve(card);
    card.remove();
  }
  const query = searchQuery.trim().toLowerCase();
  const templates = allCommunityTemplates.filter(template =>
    !query
    || template.name.toLowerCase().includes(query)
    || template.description?.toLowerCase().includes(query)
    || template.id.toLowerCase().includes(query)
    || template.author?.toLowerCase().includes(query)
    || template.category?.toLowerCase().includes(query)
  );
  resultsCount.textContent = `${templates.length} ${templates.length === 1 ? 'template' : 'templates'}`;
  gridHeading.hidden = false;
  gridHeading.textContent = searchQuery ? `Studio template results for "${searchQuery}"` : 'Studio templates';
  sectionEyebrow.textContent = searchQuery ? 'FIND A STARTING POINT' : 'START A NEW PROJECT';
  featuredSection.hidden = true;
  categoryBar.hidden = true;
  catalogModeWarning.hidden = false;
  catalogModeWarning.textContent = 'Community templates are signed .nbtemplate bundles. Review the publisher and verify the signature in Studio before using a template.';
  catalogCount.textContent = String(allCommunityTemplates.length).padStart(2, '0');
  if (!templates.length) {
    gridEmpty.textContent = searchQuery
      ? 'No Studio templates match your search.'
      : 'No community templates have been published yet.';
    gridEmpty.classList.remove('hidden');
    return;
  }
  gridEmpty.classList.add('hidden');
  for (const template of templates) {
    const safeFile = safeWebUrl(template.file);
    const fileName = `${template.id}-${template.version}.nbtemplate`;
    const downloadUrl = safeFile ? packageDownloadUrl(safeFile, fileName) : null;
    const card = document.createElement('article');
    card.className = 'app-card studio-plugin-card community-template-card';
    card.dataset.catalogItem = template.id;
    card.dataset.catalogType = 'templates';
    card.innerHTML = `
      <div class="card-body">
        <div class="card-name"><a class="community-card-title" href="#template/${encodeURIComponent(template.id)}">${escHtml(template.name)}</a><span class="verified-badge">✓ Verified</span><span class="package-format-badge">.nbtemplate</span></div>
        <div class="card-author">by ${escHtml(template.author || 'Community publisher')}</div>
        <p class="card-desc">${escHtml(template.description || '')}</p>
        <div class="card-footer">
          <span class="card-version">${escHtml(template.category || 'General')} · v${escHtml(template.version)}</span>
        </div>
        <div class="card-rating-slot"></div>
      </div>
      ${downloadUrl ? `<a class="studio-plugin-card__download" href="${escHtml(downloadUrl)}" download="${escHtml(fileName)}">Download .nbtemplate</a>` : '<span class="catalog-mode-warning">Download link unavailable.</span>'}
    `;
    card.querySelector('.card-rating-slot').appendChild(ratingSummaryElement('templates', template.id));
    card.querySelector('.community-card-title').addEventListener('click', event => {
      event.preventDefault();
      openCatalogDetail('templates', template, card);
    });
    card.addEventListener('click', event => {
      if (event.target.closest('a')) return;
      openCatalogDetail('templates', template, card);
    });
    grid.appendChild(card);
  }
}

function catalogSize(mode) {
  if (mode === 'plugins') return allStudioPlugins.length;
  if (mode === 'templates') return allCommunityTemplates.length;
  return allApps.length;
}

function setCatalogMode(mode) {
  if (!['apps', 'plugins', 'templates'].includes(mode)) return;
  catalogMode = mode;
  activeCategory = 'all';
  categoryBar.hidden = mode !== 'apps';
  pluginCatalogTools.hidden = mode !== 'plugins';
  renderCategories();
  const labels = {
    apps: { search: 'apps', count: 'apps to explore', eyebrow: 'THE NOVABYTE APP CATALOG' },
    plugins: { search: 'Studio plugins', count: 'plugins to explore', eyebrow: 'THE STUDIO PLUGIN MARKETPLACE' },
    templates: { search: 'Studio templates', count: 'templates to explore', eyebrow: 'THE COMMUNITY TEMPLATE CATALOG' },
  };
  const label = labels[mode];
  searchInput.placeholder = `Search ${label.search}…`;
  searchInput.setAttribute('aria-label', `Search ${label.search}`);
  catalogSwitch.querySelectorAll('.catalog-switch-button').forEach(button => {
    const selected = button.dataset.catalog === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  catalogCount.textContent = String(catalogSize(mode)).padStart(2, '0');
  catalogCountLabel.textContent = label.count;
  catalogEyebrow.innerHTML = `<span class="intro-spark"></span> ${label.eyebrow}`;
  catalogDescription.textContent = mode === 'plugins'
    ? 'Discover community extensions for NovaByte Studio. Plugins run with full access to your computer; install only publishers you trust.'
    : mode === 'templates'
      ? 'Browse community starter projects for NovaByte Studio. Download signed .nbtemplate bundles and verify them in Studio before use.'
      : 'The NovaByte Store is a place to share and test apps for a Linux-based OS. Install packages only from sources you trust.';
  storeHeading.innerHTML = mode === 'plugins'
    ? 'Extend your workflow<br>in <span>NovaByte Studio.</span>'
    : mode === 'templates'
      ? 'Start your next project<br>with <span>a template.</span>'
      : 'Apps to share and try<br>in <span>NovaByte.</span>';
  renderFeatured();
  renderGrid();
}

// ── Detail view ────────────────────────────────────────────────────────────

function fillPermissionList(container, permissions) {
  container.replaceChildren();
  for (const permission of permissions) {
    if (typeof permission !== 'string') continue;
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = permissionName(permission);
    const code = document.createElement('code');
    code.textContent = permission;
    item.append(label, code);
    container.appendChild(item);
  }
}

function appLinks(app, manifest) {
  const labels = {
    homepage: 'Website',
    website: 'Website',
    support: 'Support',
    supportUrl: 'Support',
    source: 'Source code',
    sourceUrl: 'Source code',
    repository: 'Source code',
    repositoryUrl: 'Source code',
    privacyPolicy: 'Privacy policy',
    privacyPolicyUrl: 'Privacy policy',
    documentation: 'Documentation',
    docs: 'Documentation',
    issues: 'Report an issue',
    issuesUrl: 'Report an issue',
  };
  const sources = [app.links, manifest.links];
  const candidates = sources.flatMap(source => Array.isArray(source)
    ? source
    : Object.entries(source || {}).map(([label, url]) => ({ label, url })));
  for (const key of Object.keys(labels)) {
    for (const url of [app[key], manifest[key]]) {
      if (url) candidates.push({ label: labels[key], url });
    }
  }

  const seen = new Set();
  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object') return [];
    const href = safeWebUrl(candidate.url || candidate.href);
    if (!href || seen.has(href)) return [];
    seen.add(href);
    const rawLabel = candidate.label || candidate.title || '';
    return [{ label: labels[rawLabel] || rawLabel || 'More information', href }];
  });
}

function renderPackageDetails(app, pkg) {
  const manifest = pkg?.manifest || {};
  const license = [app.license, manifest.license]
    .find(value => typeof value === 'string' && value.trim());
  detailLicense.textContent = license?.trim() || 'This app has no license';
  detailLicenseChip.hidden = false;

  const releaseNotes = app.releaseNotes || manifest.releaseNotes;
  detailReleaseNotesSection.hidden = !(typeof releaseNotes === 'string' && releaseNotes.trim());
  detailReleaseNotes.textContent = detailReleaseNotesSection.hidden ? '' : releaseNotes;

  const required = Array.isArray(app.permissions) ? app.permissions : manifest.permissions;
  const optional = Array.isArray(app.optionalPermissions) ? app.optionalPermissions : manifest.optionalPermissions;
  fillPermissionList(detailRequiredPermissions, Array.isArray(required) ? required : []);
  fillPermissionList(detailOptionalPermissions, Array.isArray(optional) ? optional : []);
  detailRequiredPermissions.closest('.permission-group').hidden = detailRequiredPermissions.childElementCount === 0;
  detailOptionalPermissions.closest('.permission-group').hidden = detailOptionalPermissions.childElementCount === 0;
  detailPermissions.hidden = detailRequiredPermissions.childElementCount === 0 && detailOptionalPermissions.childElementCount === 0;

  const allPerms = [...(Array.isArray(required) ? required : []), ...(Array.isArray(optional) ? optional : [])];
  detailRootWarning.hidden = !allPerms.includes('system:root');

  detailScreenshotList.replaceChildren();
  const screenshots = Array.isArray(app.screenshots) && app.screenshots.length
    ? app.screenshots
    : manifest.screenshots;
  if (Array.isArray(screenshots)) {
    for (const source of screenshots) {
      const src = packageImageUrl(source, pkg);
      if (!src) continue;
      const image = document.createElement('img');
      image.src = src;
      image.alt = `${app.name} screenshot`;
      image.loading = 'lazy';
      const figure = document.createElement('figure');
      const previewButton = document.createElement('button');
      previewButton.className = 'detail-screenshot-trigger';
      previewButton.type = 'button';
      previewButton.setAttribute('aria-label', `View larger ${image.alt}`);
      previewButton.appendChild(image);
      figure.appendChild(previewButton);
      detailScreenshotList.appendChild(figure);
    }
  }
  detailScreenshots.hidden = detailScreenshotList.childElementCount === 0;

  detailLinks.replaceChildren();
  for (const link of appLinks(app, manifest)) {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.label;
    detailLinks.appendChild(anchor);
  }
  detailLinks.closest('.detail-section').hidden = detailLinks.childElementCount === 0;
}

// ── Safety Confidence bar ──────────────────────────────────────────────────
//
// The bar reflects cryptographic verification state — not a code audit.
// "100%" means Ed25519 signature + file integrity hashes all passed.
// "Checking…" while verification is in flight.
// "Unverified" if signature is absent, revoked, or integrity fails.

function updateSafetyBar(state) {
  // state: 'pending' | 'verified' | 'unverified'
  const configs = {
    pending:    { pct: 0,   label: 'Checking signature…', mod: 'pending' },
    verified:   { pct: 100, label: '100% — Reviewed and signed by NovaByte', mod: 'verified' },
    unverified: { pct: 0,   label: 'Unverified — no trusted signature found', mod: 'unverified' },
  };
  const { pct, label, mod } = configs[state] ?? configs.unverified;
  detailSafetyFill.style.setProperty('--safety-pct', `${pct}%`);
  detailSafetyFill.dataset.state = mod;
  detailSafetyLabel.textContent = label;
  detailSafetyBar.dataset.state = mod;
}

// ── Version history ────────────────────────────────────────────────────────

function makeVersionEntry(entry, app, isCurrent) {
  const item = document.createElement('li');
  item.className = 'vh-entry';

  const header = document.createElement('div');
  header.className = 'vh-header';

  const versionTag = document.createElement('span');
  versionTag.className = 'vh-version';
  versionTag.textContent = `v${entry.version}`;

  if (isCurrent) {
    const currentPill = document.createElement('span');
    currentPill.className = 'vh-current';
    currentPill.textContent = 'latest';
    header.append(versionTag, currentPill);
  } else {
    header.append(versionTag);
  }

  if (entry.date) {
    const date = document.createElement('time');
    date.className = 'vh-date';
    date.dateTime = entry.date;
    try {
      date.textContent = new Date(entry.date).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      });
    } catch {
      date.textContent = entry.date;
    }
    header.append(date);
  }

  item.appendChild(header);

  if (entry.notes) {
    const notes = document.createElement('p');
    notes.className = 'vh-notes';
    notes.textContent = entry.notes;
    item.appendChild(notes);
  }

  return item;
}

function renderVersionHistory(app) {
  // Normalize entries: versionHistory array, falling back to current release info
  let entries = Array.isArray(app.versionHistory) ? [...app.versionHistory] : [];

  // Ensure current version always has an entry
  const hasCurrentEntry = entries.some(e => e?.version === app.version);
  if (!hasCurrentEntry && app.version) {
    entries.unshift({
      version: app.version,
      notes: app.releaseNotes || null,
      date: null,
    });
  }

  // Filter and sort newest-first. Prefer explicit date fields; fall back to treating
  // the current app version as the most recent regardless of position in the array.
  const valid = entries
    .filter(e => e && typeof e.version === 'string')
    .sort((a, b) => {
      // Current version always sorts first
      if (a.version === app.version) return -1;
      if (b.version === app.version) return 1;
      // If both have parseable dates, sort by date descending (invalid dates rank last)
      const aDate = Date.parse(a.date);
      const bDate = Date.parse(b.date);
      if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) return bDate - aDate;
      if (Number.isFinite(aDate) !== Number.isFinite(bDate)) return Number.isFinite(aDate) ? -1 : 1;
      return 0;
    });

  detailVersionHistory.hidden = valid.length === 0;
  if (valid.length === 0) return;

  detailVersionHistoryList.replaceChildren();

  // Always show the latest (first) entry prominently
  const latest = valid[0];
  const latestItem = makeVersionEntry(latest, app, true);
  latestItem.classList.add('vh-entry--latest');
  detailVersionHistoryList.appendChild(latestItem);

  if (valid.length <= 1) return;

  // Older entries hidden behind a toggle
  const olderEntries = valid.slice(1);
  const olderList = document.createElement('ol');
  olderList.className = 'vh-older-list';
  olderList.setAttribute('reversed', '');
  olderList.hidden = true;

  for (const entry of olderEntries) {
    olderList.appendChild(makeVersionEntry(entry, app, false));
  }

  const olderCount = olderEntries.length;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'vh-toggle';
  toggleBtn.textContent = `${olderCount} older version${olderCount === 1 ? '' : 's'}`;
  toggleBtn.setAttribute('aria-expanded', 'false');

  toggleBtn.addEventListener('click', () => {
    const expanded = olderList.hidden;
    olderList.hidden = !expanded;
    toggleBtn.setAttribute('aria-expanded', String(expanded));
    toggleBtn.textContent = expanded
      ? `Hide older versions`
      : `${olderCount} older version${olderCount === 1 ? '' : 's'}`;
  });

  detailVersionHistoryList.append(toggleBtn, olderList);
}

let screenshotZoomOrigin = null;
let screenshotZoomAnimation = null;
let screenshotParallaxFrame = 0;
let screenshotPreviewClosing = false;
const screenshotPreviewContent = screenshotPreviewDialog.querySelector('.screenshot-preview-content');
const screenshotPreviewMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

detailScreenshotList.addEventListener('click', event => {
  const trigger = event.target.closest('.detail-screenshot-trigger');
  if (!trigger) return;
  const image = trigger.querySelector('img');
  if (!image) return;
  const origin = image.getBoundingClientRect();
  screenshotZoomOrigin = {
    left: origin.left,
    top: origin.top,
    width: origin.width,
    height: origin.height,
  };
  screenshotPreviewImage.src = image.currentSrc || image.src;
  screenshotPreviewImage.alt = image.alt;
  screenshotPreviewCaption.textContent = image.alt;
  screenshotPreviewClosing = false;
  screenshotPreviewDialog.classList.remove('is-closing');
  screenshotZoomAnimation?.cancel();
  screenshotPreviewImage.style.removeProperty('transform');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-x', '0px');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-y', '0px');
  screenshotPreviewDialog.showModal();
  if (screenshotPreviewMotion.matches) return;
  requestAnimationFrame(() => {
    if (!screenshotPreviewDialog.open || !screenshotZoomOrigin) return;
    const target = screenshotPreviewImage.getBoundingClientRect();
    if (!target.width || !target.height) return;
    screenshotZoomAnimation = screenshotPreviewImage.animate([
      {
        transform: aspectPreservingTransform(screenshotZoomOrigin, target),
        filter: 'brightness(.78) saturate(.82)',
        opacity: 0.82,
      },
      {
        transform: 'translate3d(0, 0, 0) scale(1)',
        filter: 'brightness(1) saturate(1)',
        opacity: 1,
      },
    ], {
      duration: 850,
      easing: 'cubic-bezier(.16, 1, .3, 1)',
    });
  });
});

function closeScreenshotPreview() {
  if (!screenshotPreviewDialog.open || screenshotPreviewClosing) return;
  if (screenshotPreviewMotion.matches || !screenshotZoomOrigin) {
    screenshotZoomAnimation?.cancel();
    screenshotPreviewDialog.close();
    return;
  }

  screenshotPreviewClosing = true;
  screenshotPreviewDialog.classList.add('is-closing');
  const current = screenshotPreviewImage.getBoundingClientRect();
  screenshotZoomAnimation?.cancel();
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-x', '0px');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-y', '0px');
  screenshotPreviewImage.style.transform = 'none';
  const target = screenshotPreviewImage.getBoundingClientRect();
  if (!target.width || !target.height) {
    screenshotPreviewDialog.close();
    return;
  }
  screenshotZoomAnimation = screenshotPreviewImage.animate([
    {
      transform: aspectPreservingTransform(current, target),
      filter: 'brightness(1) saturate(1)',
      borderRadius: '15px',
      opacity: 1,
    },
    {
      transform: aspectPreservingTransform(screenshotZoomOrigin, target),
      filter: 'brightness(.78) saturate(.82)',
      borderRadius: '9px',
      opacity: 0.82,
    },
  ], {
    duration: 720,
    easing: 'cubic-bezier(.76, 0, .24, 1)',
  });
  screenshotZoomAnimation.onfinish = () => {
    if (screenshotPreviewDialog.open) screenshotPreviewDialog.close();
  };
}

screenshotPreviewClose.addEventListener('click', closeScreenshotPreview);
screenshotPreviewDialog.addEventListener('click', event => {
  if (event.target === screenshotPreviewDialog) closeScreenshotPreview();
});
screenshotPreviewDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeScreenshotPreview();
});
screenshotPreviewDialog.addEventListener('close', () => {
  screenshotZoomAnimation?.cancel();
  screenshotZoomAnimation = null;
  screenshotZoomOrigin = null;
  screenshotPreviewClosing = false;
  screenshotPreviewImage.style.removeProperty('transform');
  screenshotPreviewDialog.classList.remove('is-closing');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-x', '0px');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-y', '0px');
});

screenshotPreviewContent.addEventListener('pointermove', event => {
  if (screenshotPreviewMotion.matches || event.pointerType === 'touch') return;
  if (screenshotParallaxFrame) cancelAnimationFrame(screenshotParallaxFrame);
  screenshotParallaxFrame = requestAnimationFrame(() => {
    const bounds = screenshotPreviewContent.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    screenshotPreviewContent.style.setProperty('--screenshot-parallax-x', `${x * 12}px`);
    screenshotPreviewContent.style.setProperty('--screenshot-parallax-y', `${y * 12}px`);
    screenshotParallaxFrame = 0;
  });
});
screenshotPreviewContent.addEventListener('pointerleave', () => {
  if (screenshotParallaxFrame) cancelAnimationFrame(screenshotParallaxFrame);
  screenshotParallaxFrame = 0;
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-x', '0px');
  screenshotPreviewContent.style.setProperty('--screenshot-parallax-y', '0px');
});

function renderCatalogRatings(container, catalogType, itemId, onAuthenticated) {
  const requestKey = catalogRatingKey(catalogType, itemId);
  container.dataset.ratingKey = requestKey;
  container.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'catalog-ratings-heading';
  const copy = document.createElement('div');
  copy.append(
    document.createElement('p'),
    document.createElement('h2'),
  );
  copy.children[0].className = 'detail-kicker';
  copy.children[0].textContent = 'COMMUNITY FEEDBACK';
  copy.children[1].className = 'detail-section-title';
  copy.children[1].textContent = 'Ratings & reviews';
  const summary = document.createElement('div');
  summary.className = 'catalog-ratings-score';
  summary.textContent = 'Loading ratings…';
  heading.append(copy, summary);

  const status = document.createElement('p');
  status.className = 'catalog-ratings-status';
  status.textContent = publisherPortal.configured
    ? 'Ratings are submitted by verified accounts.'
    : 'Community ratings are unavailable until the publisher service is configured.';
  const reviews = document.createElement('div');
  reviews.className = 'catalog-review-list';
  const form = document.createElement('form');
  form.className = 'catalog-rating-form';
  const formHeading = document.createElement('h3');
  formHeading.textContent = 'Your rating';
  const ratingField = document.createElement('fieldset');
  ratingField.className = 'catalog-rating-field';
  const legend = document.createElement('legend');
  legend.textContent = 'Choose a star rating';
  ratingField.appendChild(legend);
  for (let value = 1; value <= 5; value++) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `catalog-rating-${catalogType}`;
    input.value = String(value);
    input.required = value === 1;
    input.setAttribute('aria-label', `${value} out of 5 stars`);
    const stars = document.createElement('span');
    stars.textContent = '★'.repeat(value);
    label.append(input, stars);
    ratingField.appendChild(label);
  }
  const reviewLabel = document.createElement('label');
  reviewLabel.className = 'catalog-review-field';
  reviewLabel.appendChild(document.createTextNode('Review (optional)'));
  const reviewInput = document.createElement('textarea');
  reviewInput.maxLength = 1000;
  reviewInput.placeholder = 'Share a helpful note about your experience.';
  reviewLabel.appendChild(reviewInput);
  const submit = document.createElement('button');
  submit.className = 'detail-download-btn catalog-rating-submit';
  submit.type = 'submit';
  submit.textContent = 'Submit rating';
  submit.disabled = !publisherPortal.configured;
  form.append(formHeading, ratingField, reviewLabel, submit);
  if (!publisherPortal.configured) form.hidden = true;
  container.append(heading, status, reviews, form);

  const saveRating = async (rating, review) => {
    submit.disabled = true;
    status.textContent = 'Saving your rating…';
    try {
      await publisherPortal.submitCatalogRating(catalogType, itemId, rating, review);
      status.textContent = 'Your rating has been saved.';
      renderCatalogRatings(container, catalogType, itemId, onAuthenticated);
    } catch (error) {
      status.textContent = error.message || 'Could not save your rating.';
      submit.disabled = false;
    }
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const selectedRating = form.querySelector('input[type="radio"]:checked');
    if (!selectedRating) {
      status.textContent = 'Choose a star rating before submitting.';
      return;
    }
    const rating = Number(selectedRating.value);
    const review = reviewInput.value.trim();
    void publisherPortal.startRatingAction(async () => {
      if (detailView.classList.contains('hidden') && communityDetailView.classList.contains('hidden')) {
        onAuthenticated();
      }
      await saveRating(rating, review);
    }).catch(error => {
      status.textContent = error.message || 'Could not start the sign-in flow.';
      submit.disabled = false;
    });
  });

  if (!publisherPortal.configured) return;
  Promise.all([
    publisherPortal.fetchCatalogRatingSummaries(catalogType, [itemId]),
    publisherPortal.fetchCatalogRatingReviews(catalogType, itemId),
    publisherPortal.fetchMyCatalogRating(catalogType, itemId),
  ]).then(([summaryRows, reviewRows, myRating]) => {
    if (container.dataset.ratingKey !== requestKey) return;
    if (!Array.isArray(summaryRows) || !Array.isArray(reviewRows)) {
      throw new Error('The rating service returned an invalid response.');
    }
    const summaryRow = summaryRows.find(row => row.item_id === itemId);
    if (summaryRow) {
      const average = Number(summaryRow.average_rating);
      const count = Number(summaryRow.rating_count);
      if (Number.isFinite(average) && Number.isInteger(count) && count > 0) {
        catalogRatingSummaries.set(requestKey, { averageRating: average, ratingCount: count });
        summary.textContent = `${average.toFixed(1)} / 5 · ${count} ${count === 1 ? 'rating' : 'ratings'}`;
      } else {
        summary.textContent = 'No ratings yet';
      }
    } else {
      summary.textContent = 'No ratings yet';
    }
    if (myRating) {
      const existing = form.querySelector(`input[value="${myRating.rating}"]`);
      if (existing) existing.checked = true;
      reviewInput.value = myRating.review || '';
      submit.textContent = 'Update rating';
    }
    if (reviewRows.length) {
      for (const review of reviewRows) {
        const card = document.createElement('article');
        card.className = 'catalog-review';
        const top = document.createElement('div');
        top.className = 'catalog-review-meta';
        const stars = document.createElement('span');
        stars.className = 'catalog-review-stars';
        stars.textContent = `${'★'.repeat(Number(review.rating))}${'☆'.repeat(5 - Number(review.rating))}`;
        const date = document.createElement('time');
        const timestamp = Date.parse(review.created_at);
        date.textContent = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : 'Community review';
        if (Number.isFinite(timestamp)) date.dateTime = new Date(timestamp).toISOString();
        top.append(stars, date);
        card.appendChild(top);
        const text = document.createElement('p');
        text.textContent = review.review;
        card.appendChild(text);
        reviews.appendChild(card);
      }
    } else {
      const empty = document.createElement('p');
      empty.className = 'catalog-ratings-status';
      empty.textContent = 'No written reviews yet.';
      reviews.appendChild(empty);
    }
    if (!publisherPortal.user) {
      submit.textContent = 'Sign in to submit your rating';
      status.textContent = 'Sign in with a verified account to rate this item. Your review is public.';
    }
    renderGrid();
  }).catch(error => {
    if (container.dataset.ratingKey !== requestKey) return;
    console.warn(`[Store] Could not load ratings for ${catalogType} item ${itemId}:`, error);
    summary.textContent = 'Ratings unavailable';
    status.textContent = catalogRatingErrorMessage(error);
    submit.disabled = true;
  });
}

let catalogTransitionActive = false;
let activeCatalogSource = null;
const catalogTransitionBrowser = (() => {
  const userAgent = navigator.userAgent;
  if (/(?:Firefox|FxiOS)\//i.test(userAgent)) return 'firefox';
  if (/\bSafari\//i.test(userAgent)
    && !/(?:Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox|Android)\//i.test(userAgent)) {
    return 'safari';
  }
  return 'native';
})();

function copyComputedStyles(source, clone) {
  const sourceElements = [source, ...source.querySelectorAll('*')];
  const cloneElements = [clone, ...clone.querySelectorAll('*')];
  sourceElements.forEach((element, index) => {
    const computed = window.getComputedStyle(element);
    for (let property = 0; property < computed.length; property += 1) {
      const name = computed.item(property);
      cloneElements[index].style.setProperty(name, computed.getPropertyValue(name));
    }
    cloneElements[index].style.animation = 'none';
    cloneElements[index].style.transition = 'none';
    cloneElements[index].removeAttribute('id');
    cloneElements[index].removeAttribute('tabindex');
  });
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
}

function createTransitionSnapshot(element, rect) {
  const snapshot = document.createElement('div');
  const clone = element.cloneNode(true);
  copyComputedStyles(element, clone);
  snapshot.style.cssText = [
    'position:fixed',
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    `border-radius:${window.getComputedStyle(element).borderRadius}`,
    'overflow:hidden',
    'z-index:9999',
    'pointer-events:none',
    'transform-origin:top left',
    'will-change:transform,opacity',
  ].join(';');
  clone.style.position = 'relative';
  clone.style.inset = 'auto';
  clone.style.width = '100%';
  clone.style.height = '100%';
  clone.style.maxWidth = 'none';
  clone.style.maxHeight = 'none';
  clone.style.margin = '0';
  clone.style.transform = 'none';
  snapshot.appendChild(clone);
  return snapshot;
}

function aspectPreservingTransform(fromRect, toRect) {
  const scale = Math.min(fromRect.width / toRect.width, fromRect.height / toRect.height);
  const left = fromRect.left + (fromRect.width - toRect.width * scale) / 2;
  const top = fromRect.top + (fromRect.height - toRect.height * scale) / 2;
  return `translate3d(${left - toRect.left}px, ${top - toRect.top}px, 0) scale(${scale})`;
}

function runCompatibilityCatalogTransition(sourceElement, update, getDestination, direction) {
  const sourceRect = sourceElement.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || typeof Element.prototype.animate !== 'function') {
    update();
    return false;
  }

  const sourceVisibility = sourceElement.style.visibility;
  const snapshot = createTransitionSnapshot(sourceElement, sourceRect);
  document.body.appendChild(snapshot);
  sourceElement.style.visibility = 'hidden';

  const cleanup = (destination, destinationVisibility) => {
    sourceElement.style.visibility = sourceVisibility;
    if (destination) destination.style.visibility = destinationVisibility;
    snapshot.remove();
    catalogTransitionActive = false;
    if (direction === 'reverse') activeCatalogSource = null;
  };

  try {
    update();
  } catch (error) {
    cleanup(null, '');
    throw error;
  }

  let destination;
  try {
    destination = getDestination();
  } catch (error) {
    cleanup(null, '');
    console.warn(`[Store] Could not find the catalog transition destination in ${catalogTransitionBrowser}:`, error);
    return true;
  }
  if (!destination) {
    cleanup(null, '');
    console.warn(`[Store] ${catalogTransitionBrowser} transition destination was not found.`);
    return true;
  }

  const destinationVisibility = destination.style.visibility;
  const destinationRect = destination.getBoundingClientRect();
  if (!destinationRect.width || !destinationRect.height) {
    cleanup(destination, destinationVisibility);
    return true;
  }

  const transform = aspectPreservingTransform(destinationRect, sourceRect);
  const safari = catalogTransitionBrowser === 'safari';
  let animation;
  let destinationAnimation;
  try {
    animation = snapshot.animate([
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
      { transform, opacity: 0 },
    ], {
      duration: safari ? 900 : 780,
      easing: safari ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.16, 1, .3, 1)',
      fill: 'both',
    });
    destinationAnimation = destination.animate([
      { opacity: 0 },
      { opacity: Number.parseFloat(window.getComputedStyle(destination).opacity) || 1 },
    ], {
      duration: safari ? 900 : 780,
      easing: safari ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.16, 1, .3, 1)',
      fill: 'both',
    });
  } catch (error) {
    destinationAnimation?.cancel();
    animation?.cancel();
    cleanup(destination, destinationVisibility);
    console.warn(`[Store] Could not animate catalog transition in ${catalogTransitionBrowser}:`, error);
    return true;
  }
  animation.finished.then(() => {
    destinationAnimation.cancel();
    cleanup(destination, destinationVisibility);
  }, () => {
    destinationAnimation.cancel();
    cleanup(destination, destinationVisibility);
  });
  return true;
}

function openCatalogDetail(kind, item, sourceCard) {
  activeCatalogSource = sourceCard ? {
    kind,
    itemId: item.id,
    card: sourceCard,
    scrollY: window.scrollY,
  } : null;
  const open = kind === 'apps'
    ? () => openDetail(item)
    : () => openCommunityDetail(item, kind);
  if (!sourceCard || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || catalogTransitionActive) {
    open();
    return;
  }

  if (catalogTransitionBrowser !== 'native') {
    catalogTransitionActive = true;
    const detailViewTarget = kind === 'apps' ? detailView : communityDetailView;
    if (!runCompatibilityCatalogTransition(
      sourceCard,
      open,
      () => detailViewTarget.querySelector('.detail-hero-main'),
      'forward',
    )) catalogTransitionActive = false;
    return;
  }
  if (typeof document.startViewTransition !== 'function') {
    open();
    return;
  }

  const transitionName = 'catalog-detail-card';
  const detailViewTarget = kind === 'apps' ? detailView : communityDetailView;
  sourceCard.style.viewTransitionName = transitionName;
  catalogTransitionActive = true;
  let destination = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    sourceCard.style.viewTransitionName = '';
    if (destination) destination.style.viewTransitionName = '';
    catalogTransitionActive = false;
  };

  const transition = document.startViewTransition(() => {
    open();
    destination = detailViewTarget.querySelector('.detail-hero-main');
    if (destination) destination.style.viewTransitionName = transitionName;
  });
  transition.finished.then(cleanup, cleanup);
}

function openDetail(app) {
  if (catalogMode !== 'apps') setCatalogMode('apps');
  setAppIcon(detailIcon, app);
  const formatBadge = document.createElement('span');
  formatBadge.className = 'package-format-badge';
  formatBadge.textContent = '.novaapp';
  detailName.replaceChildren(document.createTextNode(app.name), detailVerified, formatBadge);
  detailVerified.textContent = '✓ Verified';
  attachVerifiedBadge(detailVerified, app, null, true);
  detailAuthor.textContent = app.author ?? '';
  detailCats.innerHTML = badgesHtml(app.categories);
  detailId.textContent = app.id;
  detailVersion.textContent = `v${app.version}`;
  detailSize.textContent = app.size ?? '—';
  detailDev.textContent = app.author ?? '—';
  const packageFileName = `${app.id}-${app.version}.novaapp`;
  detailDownload.href = packageDownloadUrl(app.file, packageFileName);
  detailDownload.download = packageFileName;
  renderPackageDetails(app, null);

  // Description + read-more
  const desc = app.description ?? '';
  detailDesc.textContent = desc;
  detailDesc.classList.remove('is-expanded');
  readMoreBtn.setAttribute('aria-expanded', 'false');
  readMoreBtn.textContent = 'More';

  // Show "More" button only if text is long enough to get clamped
  // (rough heuristic: >200 chars is almost certainly going to clamp at 4 lines)
  readMoreBtn.classList.toggle('hidden', desc.length <= 200);

  // Hide until permissions are confirmed by renderPackageDetails
  detailRootWarning.hidden = true;

  // Safety confidence bar — pending until verification resolves
  updateSafetyBar('pending');
  verifyCatalogApp(app).then(result => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    updateSafetyBar(result ? 'verified' : 'unverified');
  }).catch(() => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    updateSafetyBar('unverified');
  });

  // Version history from catalog entry
  renderVersionHistory(app);

  siteHeader.classList.add('hidden');
  storeView.classList.add('hidden');
  communityDetailView.classList.add('hidden');
  detailView.classList.remove('hidden');
  scrollToTop();
  backBtn.focus();
  if (location.hash !== `#${app.id}`) {
    history.pushState({ appId: app.id }, '', `#${app.id}`);
  }
  renderCatalogRatings(detailRatings, 'apps', app.id, () => openDetail(app));

  fetchPackage(app).then(pkg => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    renderPackageDetails(app, pkg);
  }).catch(error => {
    console.warn(`[Store] Could not load detail metadata for ${app.id}:`, error);
  });
}

function communityDetailStat(value, label) {
  const item = document.createElement('div');
  item.className = 'stat-item';
  const statValue = document.createElement('span');
  statValue.className = 'stat-value';
  statValue.textContent = value || '—';
  const statLabel = document.createElement('span');
  statLabel.className = 'stat-label';
  statLabel.textContent = label;
  item.append(statValue, statLabel);
  return item;
}

function communityInfoChip(label, value) {
  const item = document.createElement('div');
  item.className = 'chip';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || '—';
  item.append(term, description);
  return item;
}

function formatPackageSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openCommunityDetail(item, catalogType) {
  if (catalogMode !== catalogType) setCatalogMode(catalogType);
  const isPlugin = catalogType === 'plugins';
  const name = item.name || item.id;
  const format = isPlugin ? '.nbplugin' : '.nbtemplate';
  const fileName = `${item.id}-${item.version}${format}`;
  const safeFile = safeWebUrl(item.file);
  const downloadUrl = safeFile ? packageDownloadUrl(safeFile, fileName) : null;
  communityDetailKicker.textContent = isPlugin ? 'NOVABYTE STUDIO PLUGIN' : 'COMMUNITY TEMPLATE';
  communityDetailAboutTitle.textContent = isPlugin ? 'About this plugin' : 'About this template';
  communityDetailName.replaceChildren(document.createTextNode(name));
  const verified = document.createElement('span');
  verified.className = 'verified-badge';
  verified.textContent = '✓ Verified';
  const packageBadge = document.createElement('span');
  packageBadge.className = 'package-format-badge';
  packageBadge.textContent = format;
  communityDetailName.append(verified, packageBadge);
  communityDetailAuthor.textContent = `by ${item.publisher || item.author || 'Community publisher'}`;
  communityDetailCats.innerHTML = badgesHtml(isPlugin
    ? ['Studio plugin']
    : [item.category || 'General']);
  setAppIcon(communityDetailIcon, { ...item, icon: '' });
  communityDetailDownload.hidden = !downloadUrl;
  if (downloadUrl) {
    communityDetailDownload.href = downloadUrl;
    communityDetailDownload.download = fileName;
  } else {
    communityDetailDownload.removeAttribute('href');
    communityDetailDownload.removeAttribute('download');
  }
  communityDetailDownloadLabel.textContent = isPlugin ? 'Download plugin' : 'Download template';
  communityDetailFormat.textContent = format;
  communityDetailStats.replaceChildren(
    communityDetailStat(`v${item.version}`, 'Version'),
    communityDetailStat(formatPackageSize(item.size), 'Download size'),
    communityDetailStat(format, 'Package format'),
  );
  communityDetailTrust.replaceChildren();
  const trustMark = document.createElement('span');
  trustMark.className = 'trust-check';
  trustMark.setAttribute('aria-hidden', 'true');
  trustMark.textContent = '✓';
  const trustText = document.createElement('span');
  trustText.append(
    document.createElement('strong'),
    document.createElement('br'),
    document.createTextNode(isPlugin
      ? 'Plugins run with full access to your computer. Install only publishers you trust.'
      : 'Templates are untrusted JSON bundles. Inspect the publisher and verify the signature in Studio before use.'),
  );
  trustText.children[0].textContent = isPlugin ? 'Reviewed and verified' : 'Reviewed and signed';
  communityDetailTrust.append(trustMark, trustText);
  communityDetailDescription.textContent = item.description || 'No description supplied.';
  communityDetailReleaseSection.hidden = !isPlugin || !item.releaseNotes;
  communityDetailReleaseNotes.textContent = isPlugin ? item.releaseNotes || '' : '';
  communityDetailInfo.replaceChildren(
    communityInfoChip(isPlugin ? 'Publisher' : 'Author', item.publisher || item.author),
    communityInfoChip(isPlugin ? 'Plugin ID' : 'Template ID', item.id),
    communityInfoChip('Published version', `v${item.version}`),
    ...(isPlugin
      ? [communityInfoChip('Studio compatibility', item.compatibleStudio)]
      : [communityInfoChip('Category', item.category)]),
  );
  communityDetailSafety.replaceChildren();
  const safetyKicker = document.createElement('p');
  safetyKicker.className = 'detail-kicker';
  safetyKicker.textContent = isPlugin ? 'IMPORTANT' : 'BEFORE YOU USE IT';
  const safetyHeading = document.createElement('h2');
  safetyHeading.className = 'detail-section-title';
  safetyHeading.textContent = isPlugin ? 'Full system access' : 'Verify the bundle';
  const safetyCopy = document.createElement('p');
  safetyCopy.textContent = isPlugin
    ? 'Studio plugins can access your user account and local files. Review the publisher and only enable plugins you trust.'
    : 'Template bundles are never executed by publisher tooling. Review their contents and confirm the signature in NovaByte Studio before importing.';
  communityDetailSafety.append(safetyKicker, safetyHeading, safetyCopy);

  siteHeader.classList.add('hidden');
  storeView.classList.add('hidden');
  detailView.classList.add('hidden');
  communityDetailView.classList.remove('hidden');
  scrollToTop();
  communityDetailBack.focus();
  const hash = `#${catalogType === 'plugins' ? 'plugin' : 'template'}/${encodeURIComponent(item.id)}`;
  if (location.hash !== hash) history.pushState({ catalogType, itemId: item.id }, '', hash);
  renderCatalogRatings(communityDetailRatings, catalogType, item.id,
    () => openCommunityDetail(item, catalogType));
}

readMoreBtn.addEventListener('click', () => {
  const expanded = detailDesc.classList.toggle('is-expanded');
  readMoreBtn.setAttribute('aria-expanded', String(expanded));
  readMoreBtn.textContent = expanded ? 'Less' : 'More';
});

function finishClosingDetail() {
  detailView.classList.add('hidden');
  communityDetailView.classList.add('hidden');
  siteHeader.classList.remove('hidden');
  storeView.classList.remove('hidden');
  if (location.hash) {
    history.pushState(null, '', location.pathname);
  }
}

function findCatalogSource({ kind, itemId, card }) {
  if (card?.isConnected && card.dataset.catalogItem === itemId && card.dataset.catalogType === kind) {
    return card;
  }
  return [...grid.querySelectorAll('.app-card')].find(candidate =>
    candidate.dataset.catalogItem === itemId && candidate.dataset.catalogType === kind
  ) || null;
}

function closeDetail() {
  const detailTarget = detailView.classList.contains('hidden') ? communityDetailView : detailView;
  const source = activeCatalogSource;
  const sourceCard = source && findCatalogSource(source);
  const detailHero = detailTarget.querySelector('.detail-hero-main');
  if (!sourceCard || !detailHero || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || catalogTransitionActive) {
    finishClosingDetail();
    activeCatalogSource = null;
    return;
  }

  if (catalogTransitionBrowser !== 'native') {
    catalogTransitionActive = true;
    if (!runCompatibilityCatalogTransition(
      detailHero,
      () => {
        finishClosingDetail();
        scrollToPosition(source.scrollY);
      },
      () => sourceCard,
      'reverse',
    )) {
      catalogTransitionActive = false;
      activeCatalogSource = null;
    }
    return;
  }
  if (typeof document.startViewTransition !== 'function') {
    finishClosingDetail();
    activeCatalogSource = null;
    return;
  }

  const transitionName = 'catalog-detail-card';
  detailHero.style.viewTransitionName = transitionName;
  sourceCard.style.viewTransitionName = transitionName;
  catalogTransitionActive = true;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    detailHero.style.viewTransitionName = '';
    sourceCard.style.viewTransitionName = '';
    catalogTransitionActive = false;
    activeCatalogSource = null;
  };
  const transition = document.startViewTransition(() => {
    finishClosingDetail();
    scrollToPosition(source.scrollY);
  });
  transition.finished.then(cleanup, cleanup);
}

backBtn.addEventListener('click', closeDetail);
communityDetailBack.addEventListener('click', closeDetail);

window.addEventListener('popstate', () => {
  activeCatalogSource = null;
  const hash = location.hash.slice(1);
  if (!hash) {
    detailView.classList.add('hidden');
    communityDetailView.classList.add('hidden');
    siteHeader.classList.remove('hidden');
    storeView.classList.remove('hidden');
    return;
  }
  const [kind, ...path] = hash.split('/');
  if (path.length) {
    let itemId;
    try {
      itemId = decodeURIComponent(path.join('/'));
    } catch (error) {
      console.warn('[Store] Could not decode catalog detail route:', error);
      closeDetail();
      return;
    }
    if (kind === 'plugin') {
      const plugin = allStudioPlugins.find(item => item.id === itemId);
      if (plugin) { openCommunityDetail(plugin, 'plugins'); return; }
    }
    if (kind === 'template') {
      const template = allCommunityTemplates.find(item => item.id === itemId);
      if (template) { openCommunityDetail(template, 'templates'); return; }
    }
  } else {
    const app = allApps.find(item => item.id === hash);
    if (app) { openDetail(app); return; }
  }
  detailView.classList.add('hidden');
  communityDetailView.classList.add('hidden');
  siteHeader.classList.remove('hidden');
  storeView.classList.remove('hidden');
});

// ── Category filter ────────────────────────────────────────────────────────

catalogSwitch.addEventListener('click', event => {
  const button = event.target.closest('.catalog-switch-button');
  if (!button) return;
  setCatalogMode(button.dataset.catalog);
});

pluginCollections.addEventListener('click', event => {
  const button = event.target.closest('.plugin-collection-button');
  if (!button) return;
  pluginCollection = button.dataset.collection;
  pluginCollections.querySelectorAll('.plugin-collection-button').forEach(item => {
    const active = item === button;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  renderGrid();
});

for (const filter of [
  pluginSort,
  pluginPublisherFilter,
  pluginCompatibilityFilter,
  pluginRatingFilter,
]) {
  filter.addEventListener('change', renderGrid);
}

document.querySelector('.category-bar').addEventListener('click', e => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  document.querySelectorAll('.cat-btn').forEach(b => {
    b.classList.remove('is-active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('is-active');
  btn.setAttribute('aria-pressed', 'true');
  activeCategory = btn.dataset.cat;
  renderFeatured();
  renderGrid();
});

// ── Search ─────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderFeatured();
  renderGrid();
});

// ── Util ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Header height tracking ─────────────────────────────────────────────────
// The sticky category bar needs to know the real rendered header height,
// which changes at the ≤900px breakpoint when the header wraps to two rows.
// A CSS variable alone can't track this, so we update --header-actual-h
// via ResizeObserver whenever the header resizes.

const syncHeaderHeight = () => {
  const h = siteHeader.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--header-actual-h', `${h}px`);
};

const headerObserver = new ResizeObserver(syncHeaderHeight);
headerObserver.observe(siteHeader);
syncHeaderHeight(); // set immediately so there's no flash on load

// ── Boot ───────────────────────────────────────────────────────────────────

publisherPortal.init({
  onCatalogChanged: loadApps,
  showStore: () => {
    document.getElementById('publisher-view').classList.add('hidden');
    detailView.classList.add('hidden');
    communityDetailView.classList.add('hidden');
    storeView.classList.remove('hidden');
    siteHeader.classList.remove('hidden');
    scrollToTop();
  },
});
const initialView = new URLSearchParams(location.search).get('view');
if (initialView === 'plugins' || initialView === 'templates') setCatalogMode(initialView);
loadApps();