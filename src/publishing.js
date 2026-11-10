import { PUBLISHING_CONFIG } from './publishing-config.js';
import { scrollToTop } from './smooth-scroll.js';
import { normalizeSignedTemplateFile } from './template-upload.js';

const SESSION_KEY = 'novabyte-publisher-session';
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOTS = 5;

function errorMessage(payload, fallback) {
  if (typeof payload === 'string' && payload) return payload;
  return payload?.msg || payload?.message || payload?.error_description || payload?.error || fallback;
}

function emailFailureNotice(reason) {
  if (reason === 'not_configured') {
    return 'Email was not sent: configure RESEND_API_KEY and PUBLISHER_NOTIFICATION_FROM in Supabase Edge Function secrets.';
  }
  if (reason === 'provider_rejected') {
    return 'Email was not sent: Resend rejected the message. Check the API key and verify the sender address/domain in Resend.';
  }
  if (reason === 'network_error') {
    return 'Email was not sent because the email service could not be reached. Check the publisher-api logs and try again.';
  }
  return 'Email notification could not be sent.';
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function packageDownloadUrl(value, fileName) {
  const url = new URL(value, location.href);
  url.searchParams.set('download', fileName);
  return url.href;
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendAutomatedReview(container, report, { includeManualChecks = false } = {}) {
  if (!report || typeof report !== 'object') return;
  const section = makeElement('section', 'publisher-automated-review');
  section.appendChild(makeElement('h3', '', report.passed
    ? 'Automated checks passed'
    : 'Automated checks failed (sent for review anyway)'));
  if (report.checked_at) {
    section.appendChild(makeElement('p', 'publisher-review-line',
      `Checked ${new Date(report.checked_at).toLocaleString()}`));
  }
  for (const [label, findings] of [
    ['Blocking findings', report.errors],
    ['Review warnings', report.warnings],
  ]) {
    if (!Array.isArray(findings) || !findings.length) continue;
    section.appendChild(makeElement('strong', '', label));
    const list = makeElement('ul', 'publisher-automated-findings');
    for (const finding of findings) {
      const location = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})`
        : '';
      list.appendChild(makeElement('li', '', `${finding.message || 'Finding'}${location}`));
    }
    section.appendChild(list);
  }
  if (includeManualChecks && Array.isArray(report.manual_checks) && report.manual_checks.length) {
    section.appendChild(makeElement('strong', '', 'Human review checklist'));
    const list = makeElement('ul', 'publisher-automated-findings');
    for (const item of report.manual_checks) list.appendChild(makeElement('li', '', item));
    section.appendChild(list);
  }
  container.appendChild(section);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Store requirement: every declared permission (required and optional) must
// have a permissionReasons entry — the text the OS shows in its grant dialogs.
// Mirrors the server-side automated review (supabase/functions/_shared/
// automated-review.js) and the OS package validator (app-package.js): legacy
// vfs:* reason keys count for their fs:* equivalents, values must be non-empty
// strings within the OS display cap. Enforcement happens when a package is
// submitted, so listings published before this rule stay up until their next
// update. Returns a list of human-readable problems; empty means compliant.
function permissionReasonProblems(manifest) {
  const declared = [
    ...(Array.isArray(manifest?.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest?.optionalPermissions) ? manifest.optionalPermissions : []),
  ].filter(permission => typeof permission === 'string' && permission.trim());
  if (!declared.length) return [];
  const problems = [];
  const reasons = manifest.permissionReasons;
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
    const unique = [...new Set(declared)];
    problems.push(
      'The NovaByte Store requires a declared reason for every permission. '
      + 'Add a "permissionReasons" object to the manifest mapping each permission to a short human-readable justification '
      + `(missing for: ${unique.slice(0, 10).join(', ')}${unique.length > 10 ? ', …' : ''}).`
    );
    return problems;
  }
  const legacyAliases = {
    'vfs:access': 'fs:access',
    'vfs:read': 'fs:access',
    'vfs:write': 'fs:access',
    'vfs:delete': 'fs:access',
    'vfs:metadata': 'fs:metadata',
  };
  const missing = [...new Set(declared)].filter(permission => !Object.entries(reasons).some(([key, value]) => {
    const canonical = Object.prototype.hasOwnProperty.call(legacyAliases, key) ? legacyAliases[key] : key;
    return (key === permission || canonical === permission)
      && typeof value === 'string' && Boolean(value.trim());
  }));
  if (missing.length) {
    problems.push(
      'The NovaByte Store requires a declared reason for every permission. '
      + `Missing reasons for: ${missing.join(', ')}.`
    );
  }
  for (const [key, value] of Object.entries(reasons)) {
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`permissionReasons["${key}"] must be a non-empty string.`);
    } else if (value.trim().length > 500) {
      problems.push(`permissionReasons["${key}"] exceeds the 500-character limit for permission reasons.`);
    }
  }
  return problems;
}

function makeField(labelText, { id, type = 'text', required = true, value = '', placeholder = '', maxLength } = {}) {
  const label = makeElement('label', 'publisher-field', labelText);
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  input.name = id;
  if (type !== 'textarea') input.type = type;
  input.required = required;
  input.value = value;
  input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  label.appendChild(input);
  return { label, input };
}

class PublisherPortal {
  constructor() {
    this.baseUrl = String(PUBLISHING_CONFIG.supabaseUrl || '').replace(/\/+$/, '');
    this.anonKey = String(PUBLISHING_CONFIG.supabaseAnonKey || '');
    this.authRedirectUrl = String(PUBLISHING_CONFIG.authRedirectUrl || '').trim();
    this.adminEmail = String(PUBLISHING_CONFIG.adminEmail || '').trim().toLowerCase();
    this.user = null;
    this.session = this.readSession();
    this.onCatalogChanged = () => {};
    this.showStore = () => {};
    this.currentMode = 'signin';
    this.activeMenu = null;
    this.contentCleanup = null;
    this.afterAuthAction = null;
    this.nodes = {
      header: document.querySelector('.site-header'),
      nav: document.getElementById('publisher-nav'),
      store: document.getElementById('store-view'),
      detail: document.getElementById('detail-view'),
      communityDetail: document.getElementById('community-detail-view'),
      view: document.getElementById('publisher-view'),
      content: document.getElementById('publisher-content'),
      title: document.getElementById('publisher-title'),
      subtitle: document.getElementById('publisher-subtitle'),
      notice: document.getElementById('publisher-notice'),
      back: document.getElementById('publisher-back'),
      signIn: document.getElementById('publisher-signin'),
      signUp: document.getElementById('publisher-signup'),
      publish: document.getElementById('publisher-publish'),
      myApps: document.getElementById('publisher-my-apps'),
      publishPlugin: document.getElementById('publisher-publish-plugin'),
      myPlugins: document.getElementById('publisher-my-plugins'),
      publishTemplate: document.getElementById('publisher-publish-template'),
      myTemplates: document.getElementById('publisher-my-templates'),
      account: document.getElementById('publisher-account'),
      review: document.getElementById('publisher-review'),
      signOut: document.getElementById('publisher-signout'),
    };
  }

  get configured() {
    try {
      const url = new URL(this.baseUrl);
      return url.protocol === 'https:' && url.origin === this.baseUrl && this.anonKey.length > 20;
    } catch {
      return false;
    }
  }

  readSession() {
    try {
      const stored = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      const value = JSON.parse(stored || 'null');
      if (value && !localStorage.getItem(SESSION_KEY)) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(value));
        sessionStorage.removeItem(SESSION_KEY);
      }
      return value && typeof value.access_token === 'string' ? value : null;
    } catch (error) {
      console.warn('[Publisher] Could not restore the browser session:', error);
      return null;
    }
  }

  saveSession(session) {
    if (!session?.access_token || !session?.refresh_token) {
      throw new Error('The authentication service returned an incomplete session.');
    }
    const expiresIn = Number(session.expires_in) || 3600;
    this.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    sessionStorage.removeItem(SESSION_KEY);
  }

  clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    this.session = null;
    this.user = null;
  }

  async request(path, { method = 'GET', body, token, headers = {}, rawBody } = {}) {
    if (!this.configured) throw new Error('Publisher accounts are not configured yet.');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.anonKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(rawBody !== undefined ? { body: rawBody } : {}),
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    if (!response.ok) {
      const error = new Error(errorMessage(result, `Request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async refreshSession() {
    try {
      const refreshed = await this.request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: this.session.refresh_token },
      });
      this.saveSession(refreshed);
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) this.clearSession();
      throw error;
    }
  }

  async ensureSession() {
    if (!this.session) return null;
    if (this.session.expires_at <= Math.floor(Date.now() / 1000) + 30) {
      await this.refreshSession();
    }
    let user;
    try {
      user = await this.request('/auth/v1/user', { token: this.session.access_token });
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.refreshSession();
      user = await this.request('/auth/v1/user', { token: this.session.access_token });
    }
    if (!user?.email_confirmed_at && !user?.confirmed_at) {
      this.clearSession();
      return null;
    }
    this.user = user;
    return user;
  }

  async captureVerificationCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (params.has('error')) {
      const message = params.get('error_description') || params.get('error');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.open('signin');
      this.setNotice(message, 'error');
      return false;
    }
    if (!accessToken || !refreshToken) return false;
    this.saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: params.get('expires_in'),
    });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    await this.ensureSession();
    return Boolean(this.user);
  }

  async auth(mode, values) {
    if (mode === 'signup') {
      const redirectTo = this.authRedirectUrl || `${location.origin}${location.pathname}`;
      let result;
      try {
        result = await this.request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
          method: 'POST',
          body: {
            email: values.email,
            password: values.password,
            data: { display_name: values.name },
          },
        });
      } catch (error) {
        if (/already registered|already exists|user_already_exists|email_exists/i.test(error.message || '')) {
          throw new Error('This email is already being used. Sign in or use a different email.');
        }
        throw error;
      }
      if (Array.isArray(result?.user?.identities) && result.user.identities.length === 0) {
        throw new Error('This email is already being used. Sign in or use a different email.');
      }
      if (result?.session?.access_token) {
        this.saveSession(result.session);
        const user = await this.request('/auth/v1/user', { token: this.session.access_token });
        if (user?.email_confirmed_at || user?.confirmed_at) {
          this.user = user;
          if (this.afterAuthAction) {
            const action = this.afterAuthAction;
            this.afterAuthAction = null;
            this.showStore();
            await action();
            return;
          }
          await this.open('my-apps');
          this.setNotice('Your account is verified and ready to publish.', 'success');
          return;
        }
        this.clearSession();
      }
      this.renderAuth('signin');
      this.setNotice('Account created. Check your email and follow the verification link before signing in.', 'success');
      return;
    }

    const result = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: values.email, password: values.password },
    });
    this.saveSession(result);
    const user = await this.request('/auth/v1/user', { token: this.session.access_token });
    if (!user?.email_confirmed_at && !user?.confirmed_at) {
      this.clearSession();
      throw new Error('Verify your email before signing in.');
    }
    this.user = user;
    this.updateNavigation();
    if (this.afterAuthAction) {
      const action = this.afterAuthAction;
      this.afterAuthAction = null;
      this.showStore();
      await action();
      return;
    }
    await this.open(user.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps');
    this.setNotice(`Signed in as ${user.email}.`, 'success');
  }

  async call(action, payload = {}) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    try {
      return await this.request('/functions/v1/publisher-api', {
        method: 'POST',
        token: this.session.access_token,
        body: { action, ...payload },
      });
    } catch (error) {
      if (error.message === 'Unknown publisher action.' && [
        'hosted-apps', 'dehost-app', 'submit-plugin', 'my-plugins',
        'plugin-review-list', 'review-plugin', 'withdraw-plugin',
        'submit-template', 'my-templates', 'template-review-list',
        'review-template', 'withdraw-template',
      ].includes(action)) {
        throw new Error('The publisher API is outdated. Deploy the latest function with: npx supabase functions deploy publisher-api --project-ref jcrptxtmieveoijdbtqa');
      }
      throw error;
    }
  }

  async uploadReviewedPackage(submissionId, file) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    const params = new URLSearchParams({
      action: 'upload-reviewed-package',
      submissionId,
    });
    const response = await fetch(`${this.baseUrl}/functions/v1/publisher-api?${params}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    if (!response.ok) throw new Error(errorMessage(result, `Package upload failed (${response.status}).`));
    return result;
  }

  async uploadReviewedPlugin(submissionId, file) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    const params = new URLSearchParams({ action: 'upload-reviewed-plugin', submissionId });
    const response = await fetch(`${this.baseUrl}/functions/v1/publisher-api?${params}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try { result = JSON.parse(text); } catch { result = text; }
    }
    if (!response.ok) throw new Error(errorMessage(result, `Plugin upload failed (${response.status}).`));
    return result;
  }

  async uploadReviewedTemplate(submissionId, file) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    const uploadBody = await normalizeSignedTemplateFile(file);
    const params = new URLSearchParams({ action: 'upload-reviewed-template', submissionId });
    const response = await fetch(`${this.baseUrl}/functions/v1/publisher-api?${params}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: uploadBody,
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try { result = JSON.parse(text); } catch { result = text; }
    }
    if (!response.ok) throw new Error(errorMessage(result, `Template upload failed (${response.status}).`));
    return result;
  }

  async fetchPublishedApps() {
    if (!this.configured) return [];
    const params = new URLSearchParams({
      select: 'app_id,name,version,author,description,categories,icon,file,size,screenshots,links,release_notes,version_history',
      order: 'published_at.desc',
    });
    const result = await this.request(`/rest/v1/publisher_catalog_apps?${params}`);
    if (!Array.isArray(result)) throw new Error('The published app catalog returned an invalid response.');
    return result.map(app => ({
      id: app.app_id,
      name: app.name,
      version: app.version,
      author: app.author,
      description: app.description,
      categories: app.categories,
      icon: app.icon,
      file: app.file,
      size: app.size,
      screenshots: app.screenshots,
      links: app.links,
      releaseNotes: app.release_notes,
      versionHistory: app.version_history,
    }));
  }

  async fetchPublishedPlugins() {
    if (!this.configured) return [];
    const params = new URLSearchParams({
      select: 'plugin_id,name,version,publisher,description,compatible_studio,file,size,release_notes,published_at',
      order: 'published_at.desc',
    });
    const result = await this.request(`/rest/v1/publisher_catalog_plugins?${params}`);
    if (!Array.isArray(result)) throw new Error('The Studio plugin catalog returned an invalid response.');
    return result.map(plugin => ({
      id: plugin.plugin_id,
      name: plugin.name,
      version: plugin.version,
      publisher: plugin.publisher,
      description: plugin.description,
      compatibleStudio: plugin.compatible_studio,
      file: plugin.file,
      size: plugin.size,
      releaseNotes: plugin.release_notes,
      publishedAt: plugin.published_at,
    }));
  }

  async fetchPublishedTemplates() {
    if (!this.configured) return [];
    const params = new URLSearchParams({
      select: 'template_id,name,version,author,description,category,file,size,published_at',
      order: 'published_at.desc',
    });
    const result = await this.request(`/rest/v1/publisher_catalog_templates?${params}`);
    if (!Array.isArray(result)) throw new Error('The Studio community template catalog returned an invalid response.');
    return result.map(template => ({
      id: template.template_id,
      name: template.name,
      version: template.version,
      author: template.author,
      description: template.description,
      category: template.category,
      file: template.file,
      size: template.size,
      publishedAt: template.published_at,
    }));
  }

  async fetchCatalogRatingSummaries(catalogType, itemIds) {
    if (!['apps', 'plugins', 'templates'].includes(catalogType)) {
      throw new Error('Unsupported rating catalog.');
    }
    if (!Array.isArray(itemIds) || itemIds.some(id => typeof id !== 'string')) {
      throw new Error('Rating item IDs must be a list of strings.');
    }
    if (!this.configured || !itemIds.length) return [];
    return this.request('/rest/v1/rpc/get_catalog_rating_summaries', {
      method: 'POST',
      body: { p_catalog_type: catalogType, p_item_ids: itemIds },
    });
  }

  async fetchCatalogRatingReviews(catalogType, itemId) {
    if (!['apps', 'plugins', 'templates'].includes(catalogType)) {
      throw new Error('Unsupported rating catalog.');
    }
    if (!this.configured) return [];
    return this.request('/rest/v1/rpc/get_catalog_rating_reviews', {
      method: 'POST',
      body: { p_catalog_type: catalogType, p_item_id: itemId },
    });
  }

  async fetchMyCatalogRating(catalogType, itemId) {
    const user = await this.ensureSession();
    if (!user || !this.session) return null;
    const params = new URLSearchParams({
      select: 'rating,review',
      catalog_type: `eq.${catalogType}`,
      item_id: `eq.${itemId}`,
      user_id: `eq.${user.id}`,
      limit: '1',
    });
    const result = await this.request(`/rest/v1/publisher_catalog_ratings?${params}`, {
      token: this.session.access_token,
    });
    if (!Array.isArray(result)) throw new Error('Could not load your existing rating.');
    return result[0] || null;
  }

  async submitCatalogRating(catalogType, itemId, rating, review) {
    const user = await this.ensureSession();
    if (!user || !this.session) throw new Error('Sign in with a verified email to rate catalog items.');
    return this.request('/rest/v1/rpc/submit_catalog_rating', {
      method: 'POST',
      token: this.session.access_token,
      body: {
        p_catalog_type: catalogType,
        p_item_id: itemId,
        p_rating: rating,
        p_review: review,
      },
    });
  }

  async startRatingAction(action) {
    const user = await this.ensureSession();
    if (user) {
      await action();
      return;
    }
    this.afterAuthAction = action;
    await this.open('signin');
  }

  setNotice(message, kind = 'info') {
    const notice = this.nodes.notice;
    notice.textContent = message;
    notice.className = `publisher-notice is-${kind}`;
    notice.hidden = !message;
  }

  updateNavigation() {
    const signedIn = Boolean(this.user);
    this.nodes.signIn.classList.toggle('hidden', signedIn);
    this.nodes.signUp.classList.toggle('hidden', signedIn);
    this.nodes.publish.classList.toggle('hidden', !signedIn);
    this.nodes.myApps.classList.toggle('hidden', !signedIn);
    this.nodes.publishPlugin.classList.toggle('hidden', !signedIn);
    this.nodes.myPlugins.classList.toggle('hidden', !signedIn);
    this.nodes.publishTemplate.classList.toggle('hidden', !signedIn);
    this.nodes.myTemplates.classList.toggle('hidden', !signedIn);
    this.nodes.account.classList.toggle('hidden', !signedIn);
    this.nodes.signOut.classList.toggle('hidden', !signedIn);
    this.nodes.review.classList.toggle(
      'hidden',
      !signedIn || this.user?.email?.trim().toLowerCase() !== this.adminEmail
    );
    this.nodes.signOut.textContent = 'Sign out';
  }

  setPage(title, subtitle) {
    this.contentCleanup?.();
    this.contentCleanup = null;
    this.nodes.title.textContent = title;
    this.nodes.subtitle.textContent = subtitle;
    this.nodes.content.replaceChildren();
    this.setNotice('');
  }

  async open(page) {
    if (!this.configured) {
      this.nodes.view.classList.remove('hidden');
      this.nodes.store.classList.add('hidden');
      this.nodes.detail.classList.add('hidden');
      this.nodes.communityDetail.classList.add('hidden');
      this.nodes.title.textContent = 'Publisher portal setup required';
      this.nodes.subtitle.textContent = 'Account publishing is not enabled until the site is connected to its Supabase project.';
      this.nodes.content.replaceChildren();
      const help = makeElement('p', 'publisher-help', 'Set the public Supabase project URL and anon key in src/publishing-config.js, then deploy the Supabase migration and Edge Function secrets described in supabase/README.md.');
      this.nodes.content.appendChild(help);
      this.updateNavigation();
      return;
    }

    if (!this.user) {
      await this.ensureSession();
    }
    if (page !== 'signin' && page !== 'signup' && !this.user) {
      this.renderAuth('signin');
      page = 'signin';
    }

    this.nodes.view.classList.remove('hidden');
    this.nodes.store.classList.add('hidden');
    this.nodes.detail.classList.add('hidden');
    this.nodes.communityDetail.classList.add('hidden');
    this.nodes.header.classList.remove('hidden');
    scrollToTop();
    this.updateNavigation();

    if (page === 'signin' || page === 'signup') {
      this.renderAuth(page);
    } else if (page === 'publish') {
      this.renderPublish();
    } else if (page === 'my-apps') {
      await this.renderMyApps();
    } else if (page === 'publish-plugin') {
      this.renderStudioPluginForm({ type: 'new' });
    } else if (page === 'my-plugins') {
      await this.renderMyStudioPlugins();
    } else if (page === 'publish-template') {
      this.renderCommunityTemplateForm({ type: 'new' });
    } else if (page === 'my-templates') {
      await this.renderMyCommunityTemplates();
    } else if (page === 'account') {
      this.renderAccount();
    } else if (page === 'review') {
      this.renderReviewQueue();
    }
  }

  renderAccount() {
    const displayName = this.user?.user_metadata?.display_name || '';
    this.setPage('Manage account', 'Update your publisher profile and password.');
    const form = makeElement('form', 'publisher-card publisher-account-form');
    const identity = makeElement('div', 'publisher-account-identity');
    const avatar = makeElement('span', 'publisher-account-avatar',
      (displayName || this.user?.email || 'N').trim().charAt(0).toUpperCase());
    const identityCopy = makeElement('div', 'publisher-account-identity-copy');
    identity.append(
      avatar,
      identityCopy,
    );
    identityCopy.append(
      makeElement('span', 'publisher-account-label', 'SIGNED IN AS'),
      makeElement('strong', 'publisher-account-email', this.user?.email || ''),
    );
    const verified = makeElement('p', 'publisher-account-verified',
      this.user?.email_confirmed_at || this.user?.confirmed_at ? 'Email verified' : 'Email not verified');
    verified.classList.toggle('is-unverified', !(this.user?.email_confirmed_at || this.user?.confirmed_at));
    identity.appendChild(verified);
    const accountHeading = makeElement('div', 'publisher-account-heading');
    accountHeading.append(
      makeElement('p', 'publisher-review-eyebrow', 'ACCOUNT SETTINGS'),
      makeElement('h2', '', 'Your publisher profile'),
      makeElement('p', '', 'Keep your public identity up to date and protect your account.'),
    );
    const name = makeField('Display name', {
      id: 'publisher-account-name',
      value: displayName,
      placeholder: 'Your name or publisher name',
      maxLength: 80,
    });
    const section = makeElement('div', 'publisher-account-section');
    section.append(
      makeElement('h2', '', 'Profile'),
      makeElement('p', 'publisher-form-intro', 'This name appears on your publisher profile and listings.'),
      name.label
    );
    form.append(accountHeading, identity, section);

    const passwordSection = makeElement('div', 'publisher-account-section publisher-account-password');
    passwordSection.append(
      makeElement('h2', '', 'Change password'),
      makeElement('p', 'publisher-form-intro', 'Leave both fields blank to keep your current password.')
    );
    const password = makeField('New password', {
      id: 'publisher-account-password',
      type: 'password',
      required: false,
      placeholder: 'At least 10 characters',
    });
    password.input.autocomplete = 'new-password';
    password.input.minLength = 10;
    const confirmPassword = makeField('Confirm new password', {
      id: 'publisher-account-password-confirm',
      type: 'password',
      required: false,
      placeholder: 'Enter the new password again',
    });
    confirmPassword.input.autocomplete = 'new-password';
    passwordSection.append(password.label, confirmPassword.label);
    form.appendChild(passwordSection);

    const actions = makeElement('div', 'publisher-account-actions');
    const save = makeElement('button', 'publisher-submit', 'Save changes');
    save.type = 'submit';
    actions.append(
      save,
      makeElement('p', 'publisher-account-save-note', 'Your changes apply to future submissions and listings.'),
    );
    form.appendChild(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (password.input.value !== confirmPassword.input.value) {
        this.setNotice('The new passwords do not match.', 'error');
        confirmPassword.input.focus();
        return;
      }
      if (password.input.value && password.input.value.length < 10) {
        this.setNotice('The new password must be at least 10 characters.', 'error');
        password.input.focus();
        return;
      }
      if (!name.input.value.trim()) {
        this.setNotice('Display name cannot be empty.', 'error');
        name.input.focus();
        return;
      }
      const updates = {
        user_metadata: {
          ...(this.user?.user_metadata || {}),
          display_name: name.input.value.trim(),
        },
      };
      if (password.input.value) updates.password = password.input.value;
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const updatedUser = await this.request('/auth/v1/user', {
          method: 'PUT',
          token: this.session.access_token,
          body: updates,
        });
        this.user = updatedUser;
        password.input.value = '';
        confirmPassword.input.value = '';
        this.setNotice('Account changes saved.', 'success');
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      } finally {
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    });
    this.nodes.content.appendChild(form);
  }

  renderAuth(mode) {
    this.currentMode = mode;
    const signup = mode === 'signup';
    this.setPage(signup ? 'Create publisher account' : 'Sign in', signup
      ? 'Join the NovaByte community of creators and publishers.'
      : 'Welcome back to your NovaByte publisher account.');
    const layout = makeElement('div', 'publisher-auth-layout');
    const info = makeElement('aside', 'publisher-auth-info');
    info.append(
      makeElement('p', 'publisher-review-eyebrow', signup ? 'CREATE YOUR ACCOUNT' : 'PUBLISHER PORTAL'),
      makeElement('h2', '', signup ? 'Share your work with NovaByte.' : 'Your publishing workspace, all in one place.'),
      makeElement('p', '', signup
        ? 'One account lets you publish apps, Studio plugins, and community templates for review.'
        : 'Sign in to manage your profile, submissions, and published content.'),
    );
    const benefits = makeElement('ul', 'publisher-auth-benefits');
    for (const benefit of signup
      ? ['Verified email protects publishing actions', 'Every release gets a human review', 'You stay in control of your listings']
      : ['Track your submissions and releases', 'Update your publisher profile', 'Keep publishing access protected']) {
      benefits.appendChild(makeElement('li', '', benefit));
    }
    info.appendChild(benefits);
    const form = makeElement('form', 'publisher-card publisher-auth-form');
    const formHeading = makeElement('div', 'publisher-auth-form-heading');
    formHeading.append(
      makeElement('h2', '', signup ? 'Create your account' : 'Sign in'),
      makeElement('p', '', signup ? 'Use a verified email to publish.' : 'Use the email address linked to your publisher account.'),
    );
    form.appendChild(formHeading);

    if (signup) {
      const name = makeField('Your name or publisher name', {
        id: 'publisher-name',
        required: true,
        maxLength: 80,
        placeholder: 'Studio or developer name',
      });
      form.appendChild(name.label);
    }
    const email = makeField('Email address', {
      id: 'publisher-email',
      type: 'email',
      placeholder: 'you@example.com',
    });
    const password = makeField('Password', {
      id: 'publisher-password',
      type: 'password',
      placeholder: signup ? 'At least 10 characters' : 'Your password',
    });
    password.input.autocomplete = signup ? 'new-password' : 'current-password';
    password.input.minLength = signup ? 10 : 1;
    email.input.autocomplete = 'email';
    form.append(email.label, password.label);
    const submit = makeElement('button', 'publisher-submit', signup ? 'Create account' : 'Sign in');
    submit.type = 'submit';
    form.appendChild(submit);
    const alternate = makeElement('p', 'publisher-form-alternate');
    alternate.append(
      document.createTextNode(signup ? 'Already registered? ' : 'New here? '),
      this.makeAction(signup ? 'Sign in' : 'Create an account', () => this.renderAuth(signup ? 'signin' : 'signup'))
    );
    form.appendChild(alternate);
    if (!signup) {
      const tools = makeElement('div', 'publisher-auth-tools');
      tools.append(
        makeElement('p', '', 'Didn’t receive a verification email?'),
        this.makeAction('Resend verification email', () => this.resendVerification(email.input.value.trim())),
      );
      form.appendChild(tools);
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      submit.textContent = signup ? 'Creating account…' : 'Signing in…';
      try {
        await this.auth(signup ? 'signup' : 'signin', {
          name: form.elements['publisher-name']?.value.trim(),
          email: email.input.value.trim(),
          password: password.input.value,
        });
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = signup ? 'Create account' : 'Sign in';
      }
    });
    layout.append(info, form);
    if (signup) {
      layout.appendChild(makeElement('p', 'publisher-security-note', 'A verified email is required before publishing. Never upload signing keys; NovaByte signs packages only after review.'));
    }
    this.nodes.content.appendChild(layout);
  }

  makeAction(text, action, className = '') {
    const button = makeElement('button', `publisher-inline-action ${className}`.trim(), text);
    button.type = 'button';
    button.addEventListener('click', action);
    return button;
  }

  async resendVerification(email) {
    if (!email) {
      this.setNotice('Enter your email address first.', 'error');
      return;
    }
    try {
      await this.request('/auth/v1/resend', {
        method: 'POST',
        body: {
          type: 'signup',
          email,
          options: { emailRedirectTo: this.authRedirectUrl || `${location.origin}${location.pathname}` },
        },
      });
      this.setNotice('If the account needs verification, a new confirmation email has been sent.', 'success');
    } catch (error) {
      this.setNotice(error.message || String(error), 'error');
    }
  }

  makeSubmissionLayout(form, { kind, eyebrow, intro }) {
    form.classList.add('publisher-submission-form', `publisher-submission-form-${kind}`);
    const overview = makeElement('div', 'publisher-submission-intro');
    overview.append(
      makeElement('span', 'publisher-submission-type', eyebrow),
      makeElement('p', 'publisher-form-intro', intro),
    );
    const layout = makeElement('div', 'publisher-submission-layout');
    const main = makeElement('div', 'publisher-submission-main');
    const aside = makeElement('aside', 'publisher-submission-aside');
    const actions = makeElement('div', 'publisher-submission-actions');
    layout.append(main, aside);
    form.append(overview, layout, actions);
    return { main, aside, actions };
  }

  makeSubmissionSection(step, title, description = '') {
    const section = makeElement('section', 'publisher-submission-section');
    const heading = makeElement('div', 'publisher-submission-section-heading');
    const copy = makeElement('div', 'publisher-submission-section-copy');
    heading.append(
      makeElement('span', 'publisher-submission-step', step),
      copy,
    );
    copy.appendChild(makeElement('h2', '', title));
    if (description) copy.appendChild(makeElement('p', '', description));
    const fields = makeElement('div', 'publisher-submission-fields');
    section.append(heading, fields);
    return { section, fields };
  }

  makePackagePicker(onPackage) {
    const field = makeField('NovaByte app package (.novaapp)', {
      id: 'publisher-package',
      type: 'file',
      placeholder: '',
    });
    field.input.accept = '.novaapp,application/json';
    field.input.addEventListener('change', async () => {
      const file = field.input.files?.[0];
      if (!file) return;
      try {
        if (file.size > MAX_PACKAGE_BYTES) throw new Error('The package exceeds the 25 MB upload limit.');
        const pkg = JSON.parse(await file.text());
        if (
          !pkg ||
          (pkg.novabyte_app !== undefined && pkg.novabyte_app !== true) ||
          !pkg.manifest ||
          !pkg.files ||
          typeof pkg.files !== 'object' ||
          Array.isArray(pkg.files)
        ) {
          throw new Error('This file is not a valid .novaapp package.');
        }
        // Don't block here: a package that fails the permission-reason rule is still
        // submitted, flagged, and sent to the reviewer. Just warn the publisher.
        const reasonProblems = permissionReasonProblems(pkg.manifest);
        onPackage({ file, pkg });
        this.setNotice(reasonProblems.length
          ? `Loaded ${file.name}, but it will fail the automated checks. ${reasonProblems.join(' ')} It will still be sent for human review.`
          : `Loaded ${file.name} (${(file.size / 1024).toFixed(0)} KB).`, reasonProblems.length ? 'warning' : 'success');
      } catch (error) {
        field.input.value = '';
        this.setNotice(error.message || 'Could not read the package.', 'error');
      }
    });
    return { field, input: field.input };
  }

  makeAppForm({ type, app } = {}) {
    const update = type === 'update';
    this.setPage(update ? `Update ${app.name}` : 'Publish an app', update
      ? 'Upload a newer package version. Automated checks run first, then human review. Anything they flag goes to the reviewer.'
      : 'Complete the listing details. Automated checks run first, then human review. Anything they flag goes to the reviewer.');
    const form = makeElement('form', 'publisher-card publisher-app-form');
    const status = update
      ? `Updating ${app.name} (${app.id}). The submitted package must contain a newer version. Automated checks run first, then human review.`
      : 'Add the details people need to understand your app, then upload the exact .novaapp build for review.';
    const submission = this.makeSubmissionLayout(form, {
      kind: 'app',
      eyebrow: update ? 'APP UPDATE' : 'NOVABYTE APP LISTING',
      intro: status,
    });
    const listingSection = this.makeSubmissionSection('01', update ? 'Release details' : 'App details',
      update ? 'Describe this release and what has changed.' : 'Give your listing a clear identity and explain what the app does.');
    const packageSection = this.makeSubmissionSection('02', 'Package',
      'Upload the build that matches the version submitted for review.');
    const screenshotSection = this.makeSubmissionSection('03', 'Screenshots',
      'Show a few useful screens so people know what to expect.');
    submission.main.append(listingSection.section, screenshotSection.section);
    submission.aside.appendChild(packageSection.section);

    if (!update) {
      const rules = makeElement('details', 'publisher-rules');
      const summary = makeElement('summary', 'publisher-rules-summary', '');
      const summaryIcon = makeElement('span', 'publisher-rules-icon', '📋');
      const summaryText = makeElement('span', '', 'Store requirements — read before submitting');
      summary.append(summaryIcon, summaryText);
      rules.appendChild(summary);

      const sections = [
        {
          heading: 'Signing & integrity',
          items: [
            'Must be digitally signed by NovaByte. Self-signed packages will not be listed.',
            'Must include tamper protection. Packages that can be modified after signing will not be accepted.',
            'The exact build submitted must be the one that gets signed and listed. Submitting a different package after approval means the listing will be removed.',
          ],
        },
        {
          heading: 'Code',
          items: [
            'No minification or obfuscation. Obfuscated packages are blocked at runtime — submit readable code.',
            'No dynamic code execution: eval, new Function, or setTimeout/setInterval called with a string.',
            'No bundled binaries or executables. The package may only contain web assets.',
          ],
        },
        {
          heading: 'Network',
          items: [
            'No network requests to domains not declared in the manifest. Apps may not phone home to anything not approved during review.',
            'No remote script loading. All dependencies must be bundled inside the .novaapp.',
            'Third-party dependencies must be pinned to an exact version, not a range.',
          ],
        },
        {
          heading: 'Permissions',
          items: [
            'Every declared permission — required and optional — must have a matching entry in the manifest\'s "permissionReasons" object: a short human-readable justification the OS shows before granting. Submissions missing a reason for any permission are rejected automatically.',
            'Apps may not request permissions at runtime beyond what is declared in the manifest.',
            'Apps declaring system:root won\'t be published unless there is a specific, compelling reason the app cannot function inside the sandbox. Every system:root submission is held for manual scrutiny.',
          ],
        },
        {
          heading: 'Content & behaviour',
          items: [
            'No ads, trackers, or analytics of any kind. No third-party SDKs that phone home.',
            'Apps must not silently run in the background after the user closes them unless a background permission is declared and the user is informed at install time.',
            'Apps must not auto-launch on boot without explicit user consent at install time.',
          ],
        },
        {
          heading: 'Data handling',
          items: [
            'Apps must not persist or transmit user data beyond what is needed for their stated purpose.',
            'Data written directly by an app must be scoped to its own directory.',
            'Apps must not store credentials — passwords, tokens, keys — in plaintext in app files.',
          ],
        },
        {
          heading: 'Manifest hygiene',
          items: [
            'App name, description, and declared permissions must accurately reflect what the app actually does. Misrepresentation means the app won\'t be published, and any existing listing will be removed.',
            'Version numbers must follow a consistent scheme — semver is recommended.',
          ],
        },
        {
          heading: 'Abuse prevention',
          items: [
            'Apps must not attempt to detect whether they are being reviewed. If this is found, the submission won\'t be accepted.',
            'No UI that mimics NovaByte OS system dialogs or NovaByte branding.',
            'No cryptocurrency mining or use of the user\'s hardware for anything outside the app\'s stated purpose.',
          ],
        },
        {
          heading: 'Updates',
          items: [
            'Every update, including patch releases, goes through full review again from scratch. No fast-track exemptions.',
            'Apps published before permission reasons were required stay listed, but every new submission and every update must declare a reason for every permission.',
          ],
        },
      ];

      for (const section of sections) {
        const heading = makeElement('p', 'publisher-rules-heading', section.heading);
        const list = makeElement('ul', 'publisher-rules-list');
        for (const text of section.items) {
          const item = makeElement('li', 'publisher-rules-item', text);
          list.appendChild(item);
        }
        rules.append(heading, list);
      }

      const note = makeElement('p', 'publisher-rules-note',
        'These rules apply to store listings only. Apps reviewed and signed for self-hosting are not subject to them.');
      rules.appendChild(note);
      submission.aside.appendChild(rules);
    }

    let packageData = null;

    const packagePicker = this.makePackagePicker(data => {
      packageData = data;
      if (!update) {
        fields.name.input.value ||= data.pkg.manifest.name || '';
        fields.appId.input.value ||= data.pkg.manifest.id || '';
        fields.author.input.value ||= data.pkg.manifest.author || '';
        fields.version.input.value ||= data.pkg.manifest.version || '';
        fields.description.input.value ||= data.pkg.manifest.description || '';
        fields.categories.input.value ||= Array.isArray(data.pkg.manifest.categories)
          ? data.pkg.manifest.categories.join(', ')
          : '';
      } else {
        fields.version.input.value = data.pkg.manifest.version || '';
      }
    });
    packageSection.fields.appendChild(packagePicker.field.label);

    // ── Screenshot manager ──────────────────────────────────────────────────
    // For updates: shows existing screenshots with individual delete + add new.
    // For new apps: plain multi-file picker.

    const screenshotsSection = makeElement('div', 'publisher-screenshots-section');
    const screenshotsHeading = makeElement('p', 'publisher-field-label', update
      ? 'Screenshots — existing (click × to remove, or add new below)'
      : 'Screenshots (up to 5 images)');
    screenshotsSection.appendChild(screenshotsHeading);

    const screenshotHelp = makeElement('p', 'publisher-form-intro', update
      ? 'Screenshots are optional. Existing ones are kept unless you remove them. You can add new ones below — combined total may not exceed 5.'
      : 'Optional. PNG, JPEG, WebP, or GIF; each image may be up to 5 MB.');

    // Existing screenshots state (for update mode) — list of { path, dataUrl } kept from the app
    let existingScreenshots = [];
    let deletedExistingPaths = new Set();

    if (update && Array.isArray(app.screenshots) && app.screenshots.length) {
      existingScreenshots = app.screenshots.map((src, index) => ({
        path: typeof src === 'string' ? src : `screenshots/screenshot-${index + 1}`,
        src: typeof src === 'string' ? src : null,
      }));
    }

    const existingGrid = makeElement('div', 'publisher-screenshot-preview publisher-screenshot-existing');
    const screenshotPreview = makeElement('div', 'publisher-screenshot-preview');
    let screenshotObjectUrls = [];

    const renderExistingScreenshots = () => {
      existingGrid.replaceChildren();
      if (!existingScreenshots.length) {
        existingGrid.hidden = true;
        return;
      }
      existingGrid.hidden = false;
      for (const item of existingScreenshots) {
        if (deletedExistingPaths.has(item.path)) continue;
        const figure = makeElement('figure', 'publisher-screenshot-item');
        if (item.src) {
          const img = document.createElement('img');
          img.src = item.src;
          img.alt = item.path;
          figure.appendChild(img);
        }
        const deleteBtn = makeElement('button', 'publisher-screenshot-delete', '×');
        deleteBtn.type = 'button';
        deleteBtn.title = `Remove ${item.path}`;
        deleteBtn.setAttribute('aria-label', `Remove screenshot ${item.path}`);
        deleteBtn.addEventListener('click', () => {
          deletedExistingPaths.add(item.path);
          renderExistingScreenshots();
        });
        const caption = makeElement('figcaption', '', item.path.split('/').pop());
        figure.append(deleteBtn, caption);
        existingGrid.appendChild(figure);
      }
      if (existingGrid.childElementCount === 0) existingGrid.hidden = true;
    };

    renderExistingScreenshots();

    const screenshots = makeField(update ? 'Add new screenshots' : '', {
      id: 'listing-screenshots',
      type: 'file',
      required: false,
    });
    screenshots.input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    screenshots.input.multiple = true;

    screenshots.input.addEventListener('change', () => {
      for (const url of screenshotObjectUrls) URL.revokeObjectURL(url);
      screenshotObjectUrls = [];
      screenshotPreview.replaceChildren();
      const selected = [...(screenshots.input.files || [])];
      const kept = existingScreenshots.filter(item => !deletedExistingPaths.has(item.path)).length;
      const total = kept + selected.length;
      if (total > MAX_SCREENSHOTS) {
        screenshots.input.value = '';
        this.setNotice(`Total screenshots cannot exceed ${MAX_SCREENSHOTS} (you have ${kept} existing + ${selected.length} new).`, 'error');
        return;
      }
      if (selected.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
        screenshots.input.value = '';
        this.setNotice('Screenshots must be PNG, JPEG, WebP, or GIF images.', 'error');
        return;
      }
      if (selected.some(file => file.size > MAX_SCREENSHOT_BYTES)) {
        screenshots.input.value = '';
        this.setNotice('Each screenshot must be no larger than 5 MB.', 'error');
        return;
      }
      for (const file of selected) {
        const url = URL.createObjectURL(file);
        screenshotObjectUrls.push(url);
        const preview = makeElement('figure', 'publisher-screenshot-item');
        const image = document.createElement('img');
        image.src = url;
        image.alt = file.name;
        const caption = makeElement('figcaption', '', file.name);
        preview.append(image, caption);
        screenshotPreview.appendChild(preview);
      }
      if (selected.length) this.setNotice(`${selected.length} new screenshot${selected.length === 1 ? '' : 's'} selected.`, 'info');
    });

    screenshotsSection.append(screenshotHelp, existingGrid, screenshots.label, screenshotPreview);
    screenshotSection.fields.appendChild(screenshotsSection);
    this.contentCleanup = () => {
      for (const url of screenshotObjectUrls) URL.revokeObjectURL(url);
      screenshotObjectUrls = [];
    };

    const fields = {};
    if (!update) {
      fields.name = makeField('App name', { id: 'listing-name', value: '', placeholder: 'My NovaByte app', maxLength: 80 });
      fields.appId = makeField('Unique app ID', { id: 'listing-id', value: '', placeholder: 'com.example.myapp', maxLength: 120 });
      fields.author = makeField('Publisher / developer', { id: 'listing-author', value: '', placeholder: 'Your publisher name', maxLength: 80 });
      fields.version = makeField('Version', { id: 'listing-version', value: '', placeholder: '1.0.0', maxLength: 40 });
      fields.description = makeField('Description', { id: 'listing-description', type: 'textarea', value: '', placeholder: 'What does the app do?', maxLength: 1000 });
      fields.categories = makeField('Categories (comma-separated)', { id: 'listing-categories', value: '', placeholder: 'utilities, productivity', maxLength: 160 });
      fields.website = makeField('Website URL', { id: 'listing-website', value: '', required: false, placeholder: 'https://example.com', maxLength: 500 });
      fields.source = makeField('Source code URL', { id: 'listing-source', value: '', required: false, placeholder: 'https://github.com/…', maxLength: 500 });
      fields.support = makeField('Support URL', { id: 'listing-support', value: '', required: false, placeholder: 'https://example.com/support', maxLength: 500 });
      listingSection.fields.append(fields.name.label, fields.appId.label, fields.author.label, fields.version.label,
        fields.description.label, fields.categories.label, fields.website.label, fields.source.label, fields.support.label);
      fields.changelog = makeField('Release notes / changelog', { id: 'listing-changelog', type: 'textarea', placeholder: 'Describe the first release.', maxLength: 4000 });
      listingSection.fields.appendChild(fields.changelog.label);
    } else {
      fields.version = makeField('New version', { id: 'update-version', value: '', placeholder: 'Read from .novaapp package', maxLength: 40 });

      // Optional description override — pre-filled with current so publisher can edit or leave as-is
      const descOverrideWrap = makeElement('div', 'publisher-optional-field-wrap');
      const descToggle = makeElement('button', 'publisher-inline-action publisher-optional-toggle', '＋ Update app description (optional)');
      descToggle.type = 'button';
      fields.description = makeField('Updated description', {
        id: 'update-description',
        type: 'textarea',
        required: false,
        value: app.description || '',
        placeholder: 'Leave blank to keep the current description.',
        maxLength: 1000,
      });
      const descLabel = fields.description.label;
      descLabel.classList.add('hidden');
      descToggle.addEventListener('click', () => {
        const hidden = descLabel.classList.toggle('hidden');
        descToggle.textContent = hidden
          ? '＋ Update app description (optional)'
          : '− Hide description field';
        if (!hidden) fields.description.input.focus();
      });
      descOverrideWrap.append(descToggle, descLabel);

      fields.changelog = makeField('What\'s new in this version?', { id: 'update-changelog', type: 'textarea', placeholder: 'Describe the changes in this release.', maxLength: 4000 });
      listingSection.fields.append(fields.version.label, descOverrideWrap, fields.changelog.label);
    }

    const submit = makeElement('button', 'publisher-submit',
      update ? 'Submit update for review' : 'Submit app for review');
    submit.type = 'submit';
    const cancel = this.makeAction('Cancel', () => this.open('my-apps'), 'publisher-cancel');
    submission.actions.append(submit, cancel);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (!packageData) {
        this.setNotice('Choose a .novaapp package before submitting.', 'error');
        return;
      }
      const version = fields.version.input.value.trim();
      if (packageData.pkg.manifest.version !== version) {
        this.setNotice('The version in the .novaapp package must match the version field.', 'error');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Uploading package…';
      let packagePath;
      let submitted = false;
      try {
        const submissionId = crypto.randomUUID();
        packagePath = `${this.user.id}/${submissionId}.novaapp`;
        const packageForUpload = JSON.parse(JSON.stringify(packageData.pkg));
        // Strip store-only data before upload — none of this belongs in the installable package.
        // Screenshot image data: paths in manifest.screenshots cover the store listing, and the
        // server backfills kept screenshots from the previously published package on updates.
        for (const path of Object.keys(packageForUpload.files)) {
          if (path.startsWith('screenshots/')) delete packageForUpload.files[path];
        }
        // Store metadata fields injected into the manifest during submission: the runtime
        // doesn't use them and they shouldn't be in what the OS reads as the app manifest.
        for (const field of ['screenshots', 'links', 'releaseNotes']) {
          delete packageForUpload.manifest[field];
        }
        const selectedScreenshots = [...(screenshots.input.files || [])];
        if (selectedScreenshots.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
          throw new Error('Screenshots must be PNG, JPEG, WebP, or GIF images.');
        }
        if (selectedScreenshots.some(file => file.size > MAX_SCREENSHOT_BYTES)) {
          throw new Error('Each screenshot must be no larger than 5 MB.');
        }

        // Build the final screenshots list: kept existing + newly added
        const screenshotPaths = [];
        if (update) {
          // Keep existing paths that weren't deleted
          for (const item of existingScreenshots) {
            if (!deletedExistingPaths.has(item.path)) screenshotPaths.push(item.path);
          }
          // Remove deleted package-relative screenshot files from the package
          for (const path of deletedExistingPaths) {
            // Only delete package-relative paths (not external URLs)
            if (!path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('/')) {
              delete packageForUpload.files[path];
            }
          }
        }
        // Append new screenshots — use a unique suffix per file to avoid colliding with
        // any existing package-relative path (e.g. screenshots/publisher-2.png)
        const uploadId = Date.now();
        for (const [index, file] of selectedScreenshots.entries()) {
          const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[file.type];
          const path = `screenshots/publisher-${uploadId}-${index + 1}.${extension}`;
          packageForUpload.files[path] = arrayBufferToBase64(await file.arrayBuffer());
          screenshotPaths.push(path);
        }
        const totalScreenshots = screenshotPaths.length;
        if (totalScreenshots > MAX_SCREENSHOTS) {
          throw new Error(`Total screenshots cannot exceed ${MAX_SCREENSHOTS}.`);
        }
        if (totalScreenshots > 0) {
          packageForUpload.manifest.screenshots = screenshotPaths;
        }
        const uploadFile = new File([JSON.stringify(packageForUpload)], packageData.file.name, {
          type: 'application/json',
        });
        if (uploadFile.size > MAX_PACKAGE_BYTES) {
          throw new Error('The package plus screenshots exceeds the 25 MB upload limit.');
        }
        await this.request(`/storage/v1/object/publisher-submissions/${encodePath(packagePath)}`, {
          method: 'POST',
          token: this.session.access_token,
          rawBody: uploadFile,
          headers: {
            'Content-Type': 'application/json',
            'x-upsert': 'true',
          },
        });
        submit.textContent = 'Running automated checks…';
        const metadata = update ? {
          type: 'update',
          appId: app.id,
          version,
          packagePath,
          changelog: fields.changelog.input.value.trim(),
          ...(fields.description?.input.value.trim()
            ? { description: fields.description.input.value.trim() }
            : {}),
        } : {
          type: 'new',
          appId: fields.appId.input.value.trim(),
          name: fields.name.input.value.trim(),
          author: fields.author.input.value.trim(),
          version,
          description: fields.description.input.value.trim(),
          categories: fields.categories.input.value.split(',').map(value => value.trim()).filter(Boolean),
          links: {
            ...(fields.website.input.value.trim() ? { website: fields.website.input.value.trim() } : {}),
            ...(fields.source.input.value.trim() ? { source: fields.source.input.value.trim() } : {}),
            ...(fields.support.input.value.trim() ? { support: fields.support.input.value.trim() } : {}),
          },
          packagePath,
          changelog: fields.changelog.input.value.trim(),
        };
        const result = await this.call('submit', { submissionId, submission: metadata });
        submitted = true;
        await this.open('my-apps');
        if (result.automatedReview?.passed === false) {
          this.setNotice(
            result.notificationSent === false
              ? `Automated checks found issues, but your submission is still waiting for human review. See My Apps for details. ${emailFailureNotice(result.notificationError)}`
              : 'Automated checks found issues, but your submission is still waiting for human review. See My Apps for the findings. Fixing them and resubmitting will speed things up.',
            'warning',
          );
        } else {
          this.setNotice(result.notificationSent === false
            ? `Automated checks passed; the package is waiting for human review. ${emailFailureNotice(result.notificationError)}`
            : 'Automated checks passed. Your submission is waiting for human review.', result.notificationSent === false ? 'warning' : 'success');
        }
      } catch (error) {
        // The upload happened before the submit call; if submission failed, remove
        // the orphaned private file so rejected packages never pile up in storage.
        if (packagePath && !submitted) {
          try {
            await this.request(`/storage/v1/object/publisher-submissions/${encodePath(packagePath)}`, {
              method: 'DELETE',
              token: this.session.access_token,
            });
          } catch {
            // The private upload may be cleaned up later if storage is temporarily unavailable.
          }
        }
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = update ? 'Submit update for review' : 'Submit app for review';
      }
    });
    this.nodes.content.appendChild(form);
  }

  renderPublish() {
    this.makeAppForm({ type: 'new' });
  }

  renderStudioPluginForm({ type, plugin } = {}) {
    const update = type === 'update';
    this.setPage(update ? `Update ${plugin.name}` : 'Publish a Studio plugin', update
      ? 'Submit a newer .nbplugin for human review. NovaByte signs the reviewed plugin contents after approval.'
      : 'Submit an .nbplugin for human review. Studio plugins run with full access to the user account, so every submission is manually reviewed.');
    const form = makeElement('form', 'publisher-card publisher-app-form');
    const submission = this.makeSubmissionLayout(form, {
      kind: 'plugin',
      eyebrow: update ? 'STUDIO PLUGIN UPDATE' : 'STUDIO PLUGIN LISTING',
      intro: update
        ? 'Update your plugin listing and provide the matching archive and release notes for review.'
        : 'Share your Studio extension with the community. Plugin submissions are manually reviewed before signing.',
    });
    const detailsSection = this.makeSubmissionSection('01', 'Plugin details',
      'These values must match the plugin.json inside your archive.');
    const packageSection = this.makeSubmissionSection('02', 'Plugin package',
      'Upload a ZIP archive containing plugin.json at its root.');
    submission.main.appendChild(detailsSection.section);
    submission.aside.appendChild(packageSection.section);
    submission.aside.appendChild(makeElement('p', 'publisher-security-note',
      'Plugins have full Node.js, filesystem, process, and network access. Upload readable code, disclose capabilities accurately, and never include private signing keys. NovaByte signs only the reviewed plugin contents.'));
    const fields = {
      pluginId: makeField('Plugin ID (must match plugin.json)', {
        id: 'studio-plugin-id', value: plugin?.plugin_id || '', required: true, maxLength: 128,
        placeholder: 'com.example.plugin',
      }),
      name: makeField('Plugin name (must match plugin.json)', {
        id: 'studio-plugin-name', value: plugin?.name || '', required: true, maxLength: 100,
      }),
      publisher: makeField('Publisher name', {
        id: 'studio-plugin-publisher', value: plugin?.publisher || this.user?.user_metadata?.display_name || '',
        required: true, maxLength: 80,
      }),
      version: makeField('Version (must match plugin.json)', {
        id: 'studio-plugin-version', value: '', required: true, maxLength: 40,
        placeholder: '1.0.0',
      }),
      compatibleStudio: makeField('Compatible Studio versions (must match engines.studio)', {
        id: 'studio-plugin-compatible', value: plugin?.compatible_studio || '', required: true, maxLength: 120,
        placeholder: '>=1.2.0 <2.0.0',
      }),
      description: makeField('Description', {
        id: 'studio-plugin-description', type: 'textarea', value: plugin?.description || '',
        required: true, maxLength: 500,
      }),
      changelog: makeField('Release notes', {
        id: 'studio-plugin-changelog', type: 'textarea', required: true, maxLength: 2000,
        placeholder: 'Describe the changes and important behavior in this release.',
      }),
      package: makeField('Plugin package (.nbplugin ZIP, max 25 MB)', {
        id: 'studio-plugin-package', type: 'file', required: true,
      }),
    };
    fields.pluginId.input.readOnly = update;
    fields.package.input.accept = '.nbplugin,application/zip,application/octet-stream';
    detailsSection.fields.append(
      fields.pluginId.label,
      fields.name.label,
      fields.publisher.label,
      fields.version.label,
      fields.compatibleStudio.label,
      fields.description.label,
      fields.changelog.label,
    );
    packageSection.fields.appendChild(fields.package.label);
    const submit = makeElement('button', 'publisher-submit', update ? 'Submit plugin update for review' : 'Submit Studio plugin for review');
    submit.type = 'submit';
    submission.actions.append(
      submit,
      this.makeAction('Cancel', () => this.open('my-plugins'), 'is-secondary'),
    );
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const file = fields.package.input.files?.[0];
      if (!file) {
        this.setNotice('Choose an .nbplugin archive first.', 'error');
        fields.package.input.focus();
        return;
      }
      if (file.size > MAX_PACKAGE_BYTES) {
        this.setNotice('The plugin archive must be no larger than 25 MB.', 'error');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Uploading plugin…';
      let pluginPackagePath;
      let pluginSubmitted = false;
      try {
        const submissionId = crypto.randomUUID();
        pluginPackagePath = `${this.user.id}/${submissionId}.nbplugin`;
        await this.request(`/storage/v1/object/publisher-submissions/${encodePath(pluginPackagePath)}`, {
          method: 'POST',
          token: this.session.access_token,
          rawBody: file,
          headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        });
        submit.textContent = 'Sending for review…';
        const result = await this.call('submit-plugin', {
          submissionId,
          submission: {
            type: update ? 'update' : 'new',
            pluginId: fields.pluginId.input.value.trim(),
            name: fields.name.input.value.trim(),
            publisher: fields.publisher.input.value.trim(),
            version: fields.version.input.value.trim(),
            compatibleStudio: fields.compatibleStudio.input.value.trim(),
            description: fields.description.input.value.trim(),
            changelog: fields.changelog.input.value.trim(),
            packagePath: pluginPackagePath,
          },
        });
        pluginSubmitted = true;
        await this.open('my-plugins');
        this.setNotice(result.notificationSent === false
          ? `Plugin submitted for review. ${emailFailureNotice(result.notificationError)}`
          : 'Studio plugin submitted. It will be published only after human review.', result.notificationSent === false ? 'warning' : 'success');
      } catch (error) {
        if (pluginPackagePath && !pluginSubmitted) {
          try {
            await this.request(`/storage/v1/object/publisher-submissions/${encodePath(pluginPackagePath)}`, {
              method: 'DELETE',
              token: this.session.access_token,
            });
          } catch {
            // The private upload may be cleaned up later if storage is temporarily unavailable.
          }
        }
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = update ? 'Submit plugin update for review' : 'Submit Studio plugin for review';
      }
    });
    this.nodes.content.appendChild(form);
  }

  renderCommunityTemplateForm({ type, template } = {}) {
    const update = type === 'update';
    this.setPage(update ? `Update ${template.name}` : 'Submit a community template', update
      ? 'Submit a newer Studio .nbtemplate for human review. The reviewer will upload the signed .nbtemplate that is published to Studio.'
      : 'Submit a Studio .nbtemplate for human review. The reviewer will upload the signed .nbtemplate that is published to Studio.');
    const form = makeElement('form', 'publisher-card publisher-app-form');
    const submission = this.makeSubmissionLayout(form, {
      kind: 'template',
      eyebrow: update ? 'STUDIO TEMPLATE UPDATE' : 'COMMUNITY TEMPLATE LISTING',
      intro: 'Submit an unsigned Studio template bundle. A reviewer validates and signs the approved version before it is published.',
    });
    const detailsSection = this.makeSubmissionSection('01', 'Template details',
      'Use the stable ID for this template. It cannot be changed in an update.');
    const packageSection = this.makeSubmissionSection('02', 'Template bundle',
      'Choose the unsigned .nbtemplate exported from Studio.');
    submission.main.appendChild(detailsSection.section);
    submission.aside.appendChild(packageSection.section);
    submission.aside.appendChild(makeElement('p', 'publisher-security-note',
      'Templates are untrusted content. The publisher service validates the .nbtemplate but never executes its files. NovaByte staff must inspect the complete signed .nbtemplate before approval. Do not include secrets, binaries, screenshots, hidden files, or node_modules. Only text files are accepted. Limits: 4 MiB bundle, 2 MiB expanded text, 500 files.'));
    const templateId = makeField('Template ID (lowercase letters, digits, dots, and hyphens)', {
      id: 'community-template-id',
      value: template?.template_id || '',
      required: true,
      maxLength: 128,
      placeholder: 'com.example.starter',
    });
    templateId.input.pattern = '[a-z0-9][a-z0-9.\\-]{2,127}';
    templateId.input.readOnly = update;
    const file = makeField('Unsigned Studio template (.nbtemplate, max 4 MiB)', {
      id: 'community-template-json',
      type: 'file',
      required: true,
    });
    file.input.accept = '.nbtemplate';
    const submit = makeElement('button', 'publisher-submit', update ? 'Submit template update for review' : 'Submit community template for review');
    submit.type = 'submit';
    detailsSection.fields.appendChild(templateId.label);
    packageSection.fields.appendChild(file.label);
    packageSection.fields.appendChild(makeElement('p', 'publisher-form-intro',
      'Bundle contents are kept intact; unsupported binary files are rejected during validation. Metadata comes from the bundle, and releaseVersion must be valid semantic versioning.'));
    submission.actions.append(
      submit,
      this.makeAction('Cancel', () => this.open('my-templates'), 'is-secondary'),
    );
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const upload = file.input.files?.[0];
      if (!upload) {
        this.setNotice('Choose an unsigned Studio .nbtemplate file first.', 'error');
        file.input.focus();
        return;
      }
      if (upload.size > 4 * 1024 * 1024) {
        this.setNotice('The .nbtemplate must be no larger than 4 MiB.', 'error');
        return;
      }
      if (!upload.name.toLowerCase().endsWith('.nbtemplate')) {
        this.setNotice('Choose a .nbtemplate template bundle.', 'error');
        return;
      }
      let bundle;
      try {
        bundle = JSON.parse(await upload.text());
      } catch {
        this.setNotice('The selected .nbtemplate is not valid JSON.', 'error');
        return;
      }
      if (bundle?.format !== 'novapack-studio-user-template' || bundle?.version !== 1
        || !bundle.template || typeof bundle.template !== 'object' || Array.isArray(bundle.template)
        || Object.hasOwn(bundle, 'signature')) {
        this.setNotice('Choose an unsigned Studio .nbtemplate using format version 1. Signed files belong in the reviewer upload step.', 'error');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Uploading template…';
      let packagePath;
      let submitted = false;
      try {
        const submissionId = crypto.randomUUID();
        packagePath = `${this.user.id}/${submissionId}.nbtemplate`;
        await this.request(`/storage/v1/object/publisher-submissions/${encodePath(packagePath)}`, {
          method: 'POST',
          token: this.session.access_token,
          rawBody: upload,
          headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        });
        submit.textContent = 'Sending for review…';
        const result = await this.call('submit-template', {
          submissionId,
          submission: {
            type: update ? 'update' : 'new',
            templateId: templateId.input.value.trim(),
            packagePath,
          },
        });
        submitted = true;
        await this.open('my-templates');
        this.setNotice(result.notificationSent === false
          ? `Template submitted for human review. ${emailFailureNotice(result.notificationError)}`
          : 'Community template submitted. It will be published only after human review and signed-bundle verification.',
        result.notificationSent === false ? 'warning' : 'success');
      } catch (error) {
        if (packagePath && !submitted) {
          try {
            await this.request(`/storage/v1/object/publisher-submissions/${encodePath(packagePath)}`, {
              method: 'DELETE',
              token: this.session.access_token,
            });
          } catch {
            // The private upload may be cleaned up later if storage is temporarily unavailable.
          }
        }
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = update ? 'Submit template update for review' : 'Submit community template for review';
      }
    });
    this.nodes.content.appendChild(form);
  }

  activeSubmissions(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter(submission => {
      if (!submission || submission.status === 'published') return false;
      const key = submission.id || [
        submission.app_id || submission.plugin_id || submission.template_id,
        submission.version,
        submission.type,
        submission.status,
      ].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  createContentDashboard({ kind, published, submissions, actionLabel, action }) {
    const dashboard = makeElement('div', 'publisher-content-dashboard');
    const overview = makeElement('section', 'publisher-content-overview');
    const copy = makeElement('div', 'publisher-content-overview-copy');
    copy.append(
      makeElement('p', 'publisher-review-eyebrow', 'PUBLISHER WORKSPACE'),
      makeElement('h2', '', `Your ${kind}`),
      makeElement('p', '', 'Published listings and active reviews are organized separately so it is easy to see what needs attention.'),
    );
    const metrics = makeElement('div', 'publisher-content-metrics');
    const needsAttention = submissions.filter(submission =>
      ['changes_requested', 'rejected', 'automated_rejected'].includes(submission.status)
    ).length;
    for (const [label, count] of [
      ['Published', published],
      ['In review', submissions.length],
      ['Needs attention', needsAttention],
    ]) {
      const metric = makeElement('div', 'publisher-content-metric');
      metric.append(makeElement('span', '', label), makeElement('strong', '', String(count)));
      metrics.appendChild(metric);
    }
    overview.append(copy, metrics);
    const toolbar = makeElement('div', 'publisher-content-toolbar');
    toolbar.appendChild(this.makeAction(actionLabel, action, 'publisher-submit'));
    dashboard.append(overview, toolbar);
    return dashboard;
  }

  createContentSection(dashboard, title, count) {
    const section = makeElement('section', 'publisher-content-section');
    const heading = makeElement('div', 'publisher-content-section-heading');
    heading.append(
      makeElement('h2', '', title),
      makeElement('span', 'publisher-review-count', String(count)),
    );
    const list = makeElement('div', 'publisher-app-list publisher-content-list');
    section.append(heading, list);
    dashboard.appendChild(section);
    return list;
  }

  createContentEmptyState(title, description) {
    const empty = makeElement('div', 'publisher-review-empty publisher-content-empty');
    empty.append(
      makeElement('span', 'publisher-review-empty-mark', '✦'),
      makeElement('h3', '', title),
      makeElement('p', '', description),
    );
    return empty;
  }

  contentCardActions(...actions) {
    const container = makeElement('div', 'publisher-content-card-actions');
    container.append(...actions);
    return container;
  }

  submissionStatusBadge(status) {
    const label = String(status || 'pending').replace(/_/g, ' ');
    return makeElement('span', `publisher-submission-status is-${status || 'pending'}`, label);
  }

  async renderMyCommunityTemplates() {
    this.setPage('My community templates', `Signed in as ${this.user.email}. Manage published templates and follow each release through human review.`);
    const loading = makeElement('p', 'publisher-help', 'Loading your community templates…');
    this.nodes.content.appendChild(loading);
    try {
      const result = await this.call('my-templates');
      const templates = Array.isArray(result.templates) ? result.templates : [];
      const submissions = this.activeSubmissions(result.submissions);
      this.nodes.content.replaceChildren();
      const dashboard = this.createContentDashboard({
        kind: 'community templates',
        published: templates.length,
        submissions,
        actionLabel: '＋ Submit a community template',
        action: () => this.open('publish-template'),
      });
      if (!templates.length && !submissions.length) {
        dashboard.appendChild(this.createContentEmptyState('Your template workspace is ready', 'Submit a community template to start building your publisher catalog.'));
        this.nodes.content.appendChild(dashboard);
        return;
      }
      const publishedList = templates.length
        ? this.createContentSection(dashboard, 'Published templates', templates.length)
        : null;
      for (const template of templates) {
        const card = makeElement('article', 'publisher-app-card');
        const details = makeElement('div', 'publisher-app-main');
        const title = makeElement('div', 'publisher-content-card-heading');
        details.append(
          title,
          makeElement('p', 'publisher-app-meta', `${template.template_id} · v${template.version} · ${template.category} · Published`),
          makeElement('p', 'publisher-app-description', template.description),
        );
        title.append(makeElement('h2', '', template.name), this.submissionStatusBadge('published'));
        const action = this.makeAction('Submit update', () => this.renderCommunityTemplateForm({ type: 'update', template }));
        card.append(details, this.contentCardActions(action));
        publishedList.appendChild(card);
      }
      const submissionsList = submissions.length
        ? this.createContentSection(dashboard, 'Submission activity', submissions.length)
        : null;
      for (const submission of submissions) {
        const metadata = submission.metadata || {};
        const card = makeElement('article', 'publisher-app-card is-submission');
        const details = makeElement('div', 'publisher-app-main');
        const title = makeElement('div', 'publisher-content-card-heading');
        details.append(
          title,
          makeElement('p', 'publisher-app-meta', `${submission.template_id} · v${submission.version} · ${submission.type} · ${submission.status.replace(/_/g, ' ')}`),
          makeElement('p', 'publisher-app-description', submission.review_note || 'Waiting for human review.'),
        );
        title.append(
          makeElement('h2', '', metadata.name || submission.template_id),
          this.submissionStatusBadge(submission.status),
        );
        card.appendChild(details);
        if (['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
          card.appendChild(this.contentCardActions(this.makeAction('Withdraw submission', async () => {
            if (!window.confirm('Withdraw this community template submission?')) return;
            try {
              await this.call('withdraw-template', { submissionId: submission.id });
              await this.renderMyCommunityTemplates();
              this.setNotice('Community template submission withdrawn.', 'success');
            } catch (error) {
              this.setNotice(error.message || String(error), 'error');
            }
          }, 'is-danger')));
        } else {
          card.appendChild(this.contentCardActions());
        }
        submissionsList.appendChild(card);
      }
      this.nodes.content.appendChild(dashboard);
    } catch (error) {
      loading.textContent = error.message || 'Could not load your community templates.';
      loading.classList.add('is-error');
    }
  }

  async renderMyStudioPlugins() {
    this.setPage('My Studio plugins', `Signed in as ${this.user.email}. Manage published plugins and keep track of their review status.`);
    const loading = makeElement('p', 'publisher-help', 'Loading your Studio plugins…');
    this.nodes.content.appendChild(loading);
    try {
      const result = await this.call('my-plugins');
      const plugins = Array.isArray(result.plugins) ? result.plugins : [];
      const submissions = this.activeSubmissions(result.submissions);
      this.nodes.content.replaceChildren();
      const dashboard = this.createContentDashboard({
        kind: 'Studio plugins',
        published: plugins.length,
        submissions,
        actionLabel: '＋ Publish a Studio plugin',
        action: () => this.open('publish-plugin'),
      });
      if (!plugins.length && !submissions.length) {
        dashboard.appendChild(this.createContentEmptyState('Your plugin workspace is ready', 'Publish a Studio plugin to share it with NovaByte Studio users.'));
        this.nodes.content.appendChild(dashboard);
        return;
      }
      const publishedList = plugins.length
        ? this.createContentSection(dashboard, 'Published plugins', plugins.length)
        : null;
      for (const plugin of plugins) {
        const card = makeElement('article', 'publisher-app-card');
        const details = makeElement('div', 'publisher-app-main');
        const title = makeElement('div', 'publisher-content-card-heading');
        details.append(
          title,
          makeElement('p', 'publisher-app-meta', `${plugin.plugin_id} · v${plugin.version} · Published`),
          makeElement('p', 'publisher-app-description', plugin.description),
        );
        title.append(makeElement('h2', '', plugin.name), this.submissionStatusBadge('published'));
        const action = this.makeAction('Submit update', () => this.renderStudioPluginForm({ type: 'update', plugin }));
        card.append(details, this.contentCardActions(action));
        publishedList.appendChild(card);
      }
      const submissionsList = submissions.length
        ? this.createContentSection(dashboard, 'Submission activity', submissions.length)
        : null;
      for (const submission of submissions) {
        const metadata = submission.metadata || {};
        const card = makeElement('article', 'publisher-app-card is-submission');
        const details = makeElement('div', 'publisher-app-main');
        const title = makeElement('div', 'publisher-content-card-heading');
        details.append(
          title,
          makeElement('p', 'publisher-app-meta', `${submission.plugin_id} · v${submission.version} · ${submission.type} · ${submission.status.replace(/_/g, ' ')}`),
          makeElement('p', 'publisher-app-description', submission.review_note || submission.changelog || 'Waiting for review.'),
        );
        title.append(
          makeElement('h2', '', metadata.name || submission.plugin_id),
          this.submissionStatusBadge(submission.status),
        );
        card.appendChild(details);
        if (['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
          card.appendChild(this.contentCardActions(this.makeAction('Withdraw submission', async () => {
            if (!window.confirm('Withdraw this Studio plugin submission?')) return;
            try {
              await this.call('withdraw-plugin', { submissionId: submission.id });
              await this.renderMyStudioPlugins();
              this.setNotice('Studio plugin submission withdrawn.', 'success');
            } catch (error) {
              this.setNotice(error.message || String(error), 'error');
            }
          }, 'is-danger')));
        } else {
          card.appendChild(this.contentCardActions());
        }
        submissionsList.appendChild(card);
      }
      this.nodes.content.appendChild(dashboard);
    } catch (error) {
      loading.textContent = error.message || 'Could not load your Studio plugins.';
      loading.classList.add('is-error');
    }
  }

  async renderMyApps() {
    this.setPage('My apps', `Signed in as ${this.user.email}. Manage published apps and review activity from one place.`);
    const loading = makeElement('p', 'publisher-help', 'Loading your apps…');
    this.nodes.content.appendChild(loading);
    try {
      const result = await this.call('my-apps');
      const published = Array.isArray(result.apps)
        ? result.apps.map(app => ({ ...app, id: app.id || app.app_id }))
        : [];
      const submissions = this.activeSubmissions(result.submissions);
      this.nodes.content.replaceChildren();
      const dashboard = this.createContentDashboard({
        kind: 'NovaByte apps',
        published: published.length,
        submissions,
        actionLabel: '＋ Publish a new app',
        action: () => this.open('publish'),
      });
      if (!published.length && !submissions.length) {
        dashboard.appendChild(this.createContentEmptyState('Your app workspace is ready', 'Publish an app to create your first listing in the NovaByte Store.'));
        this.nodes.content.appendChild(dashboard);
        return;
      }
      const publishedList = published.length
        ? this.createContentSection(dashboard, 'Published apps', published.length)
        : null;
      for (const app of published) publishedList.appendChild(this.renderOwnedApp(app));
      if (submissions.length) {
        const submissionsList = this.createContentSection(dashboard, 'Submission activity', submissions.length);
        for (const submission of submissions) submissionsList.appendChild(this.renderSubmission(submission));
      }
      this.nodes.content.appendChild(dashboard);
    } catch (error) {
      loading.textContent = error.message || 'Could not load your apps.';
      loading.classList.add('is-error');
    }
  }

  renderOwnedApp(app) {
    const card = makeElement('article', 'publisher-app-card');
    const details = makeElement('div', 'publisher-app-main');
    const title = makeElement('div', 'publisher-content-card-heading');
    details.append(
      title,
      makeElement('p', 'publisher-app-meta', `${app.id} · v${app.version} · Published`),
      makeElement('p', 'publisher-app-description', app.description)
    );
    title.append(makeElement('h2', '', app.name), this.submissionStatusBadge('published'));
    const menuButton = makeElement('button', 'publisher-menu-trigger', 'Options');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', `Options for ${app.name}`);
    const menu = makeElement('div', 'publisher-context-menu hidden');
    const update = this.makeAction('Submit update', () => this.makeAppForm({ type: 'update', app }));
    const remove = this.makeAction('Delete from publish', async () => {
      if (!window.confirm(`Remove ${app.name} from the public catalog? This cannot be undone.`)) return;
      try {
        await this.call('delete-app', { appId: app.id });
        await this.renderMyApps();
        this.setNotice(`${app.name} was removed from the public catalog.`, 'success');
        this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      }
    }, 'is-danger');
    menu.append(update, remove);
    const toggleMenu = event => {
      event?.preventDefault();
      event?.stopPropagation();
      this.closeMenus();
      menu.classList.remove('hidden');
      this.activeMenu = menu;
    };
    card.addEventListener('contextmenu', toggleMenu);
    menuButton.addEventListener('click', toggleMenu);
    card.append(details, this.contentCardActions(menuButton, menu));
    return card;
  }

  renderSubmission(submission) {
    const card = makeElement('article', 'publisher-app-card is-submission');
    const details = makeElement('div', 'publisher-app-main');
    const app = submission.metadata || {};
    const title = makeElement('div', 'publisher-content-card-heading');
    details.append(
      title,
      makeElement('p', 'publisher-app-meta', `${submission.app_id} · v${submission.version} · ${submission.type} · ${submission.status.replace(/_/g, ' ')}`),
      makeElement('p', 'publisher-app-description', submission.review_note || submission.changelog || 'Waiting for review.')
    );
    title.append(
      makeElement('h2', '', app.name || submission.app_id),
      this.submissionStatusBadge(submission.status),
    );
    card.appendChild(details);
    if (submission.automated_review) {
      const report = makeElement('div', 'publisher-content-card-report');
      appendAutomatedReview(report, submission.automated_review);
      card.appendChild(report);
    }
    const actions = [];
    if (['pending', 'changes_requested', 'rejected', 'automated_rejected'].includes(submission.status)) {
      const withdraw = this.makeAction('Withdraw submission', async () => {
        if (!window.confirm('Withdraw this submission?')) return;
        try {
          await this.call('withdraw', { submissionId: submission.id });
          await this.renderMyApps();
          this.setNotice('Submission withdrawn.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
        }
      }, 'is-danger');
      actions.push(withdraw);
    }
    card.appendChild(this.contentCardActions(...actions));
    return card;
  }

  closeMenus() {
    this.activeMenu?.classList.add('hidden');
    this.activeMenu = null;
  }

  async renderReviewQueue() {
    if (this.user?.email?.trim().toLowerCase() !== this.adminEmail) {
      this.setPage('Review access denied', 'This page is only available to the authorized reviewer.');
      this.setNotice('Your verified account is not authorized to review submissions.', 'error');
      return;
    }
    this.setPage('Review submissions', 'A focused workspace for reviewing releases, Studio extensions, and community templates.');
    const loading = makeElement('p', 'publisher-help', 'Loading review queue…');
    this.nodes.content.appendChild(loading);
    try {
      const [result, hostedResult, pluginResult, templateResult] = await Promise.all([
        this.call('review-list'),
        this.call('hosted-apps'),
        this.call('plugin-review-list'),
        this.call('template-review-list'),
      ]);
      this.nodes.content.replaceChildren();
      const queue = Array.isArray(result.submissions) ? result.submissions : [];
      const hostedApps = Array.isArray(hostedResult.apps) ? hostedResult.apps : [];
      const pluginQueue = Array.isArray(pluginResult.submissions) ? pluginResult.submissions : [];
      const templateQueue = Array.isArray(templateResult.submissions) ? templateResult.submissions : [];
      const reviewCount = queue.length + pluginQueue.length + templateQueue.length;
      const failedChecks = queue.filter(submission => submission.automated_review?.passed === false).length;
      const dashboard = makeElement('div', 'publisher-review-dashboard');
      const overview = makeElement('section', 'publisher-review-overview');
      const overviewCopy = makeElement('div', 'publisher-review-overview-copy');
      overviewCopy.append(
        makeElement('p', 'publisher-review-eyebrow', 'REVIEW WORKSPACE'),
        makeElement('h2', '', reviewCount
          ? `${reviewCount} submission${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} review`
          : 'You’re all caught up'),
        makeElement('p', '', reviewCount
          ? 'Review each package and its details before making a decision.'
          : hostedApps.length
            ? 'There are no pending submissions. You can still manage hosted community apps below.'
            : 'There are no pending submissions or hosted apps to manage.'),
      );
      const metrics = makeElement('div', 'publisher-review-metrics');
      const metricItems = [
        ['App releases', queue.length],
        ['Studio plugins', pluginQueue.length],
        ['Community templates', templateQueue.length],
        ['Hosted apps', hostedApps.length],
      ];
      for (const [label, count] of metricItems) {
        const metric = makeElement('div', 'publisher-review-metric');
        metric.append(
          makeElement('span', '', label),
          makeElement('strong', '', String(count)),
        );
        metrics.appendChild(metric);
      }
      overview.append(overviewCopy, metrics);
      dashboard.appendChild(overview);
      if (failedChecks) {
        const alert = makeElement('p', 'publisher-review-alert');
        alert.append(
          makeElement('strong', '', `${failedChecks} app submission${failedChecks === 1 ? '' : 's'} failed automated checks`),
          document.createTextNode(' — inspect the findings carefully before taking action.'),
        );
        dashboard.appendChild(alert);
      }
      if (!reviewCount && !hostedApps.length) {
        const empty = makeElement('div', 'publisher-review-empty');
        empty.append(
          makeElement('span', 'publisher-review-empty-mark', '✓'),
          makeElement('h3', '', 'The review queue is clear'),
          makeElement('p', '', 'New submissions will appear here when they are ready for review.'),
        );
        dashboard.appendChild(empty);
        this.nodes.content.appendChild(dashboard);
        return;
      }
      const makeReviewSection = (title, count, description = '') => {
        const section = makeElement('section', 'publisher-review-section');
        const heading = makeElement('div', 'publisher-review-section-heading');
        const titleElement = makeElement('h2', '', title);
        const countElement = makeElement('span', 'publisher-review-count', String(count));
        countElement.setAttribute('aria-label', `${count} ${count === 1 ? 'item' : 'items'}`);
        heading.append(titleElement, countElement);
        section.appendChild(heading);
        if (description) section.appendChild(makeElement('p', 'publisher-review-section-description', description));
        const list = makeElement('div', 'publisher-app-list publisher-review-list');
        section.appendChild(list);
        dashboard.appendChild(section);
        return list;
      };
      if (queue.length) {
        const list = makeReviewSection('App submissions', queue.length);
        for (const submission of queue) {
          const item = makeElement('article', 'publisher-review-card');
          const info = submission.metadata || {};
          item.append(
            makeElement('p', 'detail-kicker', `${submission.type} · ${submission.status}${submission.automated_review?.passed === false ? ' · FAILED AUTOMATED CHECKS' : ''}`),
            makeElement('h2', '', `${info.name || submission.app_id} v${submission.version}`),
            makeElement('p', 'publisher-app-meta', `${submission.app_id} · submitted ${new Date(submission.created_at).toLocaleString()}`),
            makeElement('p', 'publisher-app-description', info.description || ''),
            makeElement('p', 'publisher-review-changelog', submission.changelog || 'No changelog supplied.')
          );
          appendAutomatedReview(item, submission.automated_review);
          if (submission.download_url) {
            const download = makeElement('a', 'publisher-download', 'Download package for review');
            download.href = packageDownloadUrl(
              submission.download_url,
              `${submission.app_id}-${submission.version}.novaapp`,
            );
            download.download = `${submission.app_id}-${submission.version}.novaapp`;
            item.appendChild(download);
          }
          const reviewButton = this.makeAction('Review submission', () => this.renderReviewForm(submission));
          item.appendChild(reviewButton);
          list.appendChild(item);
        }
      }
      if (hostedApps.length) {
        const list = makeReviewSection(
          'Hosted community apps',
          hostedApps.length,
          'Dehosting removes an app from the public catalog and deletes its published package files.',
        );
        for (const app of hostedApps) {
          const item = makeElement('article', 'publisher-review-card');
          item.append(
            makeElement('h3', '', `${app.name} v${app.version}`),
            makeElement('p', 'publisher-app-meta', `${app.app_id} · by ${app.author || 'unknown publisher'}`),
          );
          const dehost = this.makeAction('Dehost app', async () => {
            if (!window.confirm(`Dehost ${app.name} (${app.app_id})? It will be removed from the public catalog and its hosted package files will be deleted.`)) return;
            dehost.disabled = true;
            try {
              await this.call('dehost-app', { appId: app.app_id });
              await this.renderReviewQueue();
              this.setNotice(`${app.name} was removed from the public catalog.`, 'success');
              this.onCatalogChanged();
            } catch (error) {
              this.setNotice(error.message || String(error), 'error');
              dehost.disabled = false;
            }
          }, 'is-danger');
          item.appendChild(dehost);
          list.appendChild(item);
        }
      }
      if (pluginQueue.length) {
        const list = makeReviewSection(
          'Studio plugin submissions',
          pluginQueue.length,
          'Studio plugins run with full user-account access. Inspect the complete archive, verify its declared behavior, upload the exact reviewed .nbplugin, then record your safety confidence before publishing.',
        );
        for (const submission of pluginQueue) {
          const metadata = submission.metadata || {};
          const item = makeElement('article', 'publisher-review-card');
          item.append(
            makeElement('p', 'detail-kicker', `${submission.type} · ${submission.status} · STUDIO PLUGIN`),
            makeElement('h2', '', `${metadata.name || submission.plugin_id} v${submission.version}`),
            makeElement('p', 'publisher-app-meta', `${submission.plugin_id} · by ${metadata.publisher || 'unknown publisher'} · submitted ${new Date(submission.created_at).toLocaleString()}`),
            makeElement('p', 'publisher-app-description', metadata.description || ''),
            makeElement('p', 'publisher-review-line', `Compatible Studio versions: ${metadata.compatible_studio || 'not declared'}`),
            makeElement('p', 'publisher-review-changelog', submission.changelog || 'No release notes supplied.'),
          );
          const reviewButton = this.makeAction('Review Studio plugin', () => this.renderStudioPluginReviewForm(submission));
          item.appendChild(reviewButton);
          list.appendChild(item);
        }
      }
      if (templateQueue.length) {
        const list = makeReviewSection(
          'Community template submissions',
          templateQueue.length,
          'Template bundles are untrusted JSON and are never executed by publisher tooling. Inspect every manifest field and text file, including the reviewed version, before approval. Screenshots are unsupported.',
        );
        for (const submission of templateQueue) {
          const metadata = submission.metadata || {};
          const item = makeElement('article', 'publisher-review-card');
          item.append(
            makeElement('p', 'detail-kicker', `${submission.type} · ${submission.status} · COMMUNITY TEMPLATE`),
            makeElement('h2', '', `${metadata.name || submission.template_id} v${submission.version}`),
            makeElement('p', 'publisher-app-meta', `${submission.template_id} · by ${metadata.author || 'unknown author'} · submitted ${new Date(submission.created_at).toLocaleString()}`),
            makeElement('p', 'publisher-app-description', metadata.description || ''),
            makeElement('p', 'publisher-review-line', `Category: ${metadata.category || 'not specified'} · Publisher: ${submission.owner_email || 'verified publisher'}`),
          );
          if (submission.download_url) {
            const download = makeElement('a', 'publisher-download', 'Download .nbtemplate for inspection');
            download.href = packageDownloadUrl(
              submission.download_url,
              `${submission.template_id}-${submission.version}.nbtemplate`,
            );
            download.download = `${submission.template_id}-${submission.version}.nbtemplate`;
            item.appendChild(download);
          }
          item.appendChild(this.makeAction(
            'Review community template',
            () => this.renderCommunityTemplateReviewForm(submission),
          ));
          list.appendChild(item);
        }
      }
      this.nodes.content.appendChild(dashboard);
    } catch (error) {
      loading.textContent = error.message || 'Could not load the review queue.';
      loading.classList.add('is-error');
    }
  }

  renderStudioPluginReviewForm(submission) {
    const metadata = submission.metadata || {};
    this.setPage(`Review ${metadata.name || submission.plugin_id}`,
      `Studio plugin · submitted by ${submission.owner_email || 'verified publisher'} · v${submission.version}`);
    const card = makeElement('article', 'publisher-card publisher-review-form');
    for (const line of [
      `Plugin ID: ${submission.plugin_id}`,
      `Version: ${submission.version}`,
      `Publisher: ${metadata.publisher || '—'}`,
      `Compatible Studio versions: ${metadata.compatible_studio || '—'}`,
      `Description: ${metadata.description || '—'}`,
      `Release notes: ${submission.changelog || '—'}`,
    ]) card.appendChild(makeElement('p', 'publisher-review-line', line));
    if (submission.download_url) {
      const download = makeElement('a', 'publisher-download', 'Download .nbplugin for inspection');
      download.href = packageDownloadUrl(submission.download_url, `${submission.plugin_id}-${submission.version}.nbplugin`);
      download.download = `${submission.plugin_id}-${submission.version}.nbplugin`;
      card.appendChild(download);
    }
    card.appendChild(makeElement('p', 'publisher-review-upload-help',
      submission.has_reviewed_package
        ? 'Reviewed package uploaded. Upload another inspected archive to replace it before approval.'
        : 'Inspect the full plugin source and behavior before approving. Upload the inspected .nbplugin; NovaByte signs those plugin files only after approval.'));
    const uploadField = makeField('Reviewed plugin (.nbplugin)', {
      id: 'reviewed-studio-plugin', type: 'file', required: false,
    });
    uploadField.input.accept = '.nbplugin,application/zip,application/octet-stream';
    const upload = this.makeAction(
      submission.has_reviewed_package ? 'Replace reviewed plugin' : 'Upload reviewed plugin',
      async () => {
        const file = uploadField.input.files?.[0];
        if (!file) {
          this.setNotice('Choose the inspected .nbplugin first.', 'error');
          uploadField.input.focus();
          return;
        }
        if (file.size > MAX_PACKAGE_BYTES) {
          this.setNotice('The reviewed plugin must be no larger than 25 MB.', 'error');
          return;
        }
        upload.disabled = true;
        upload.textContent = 'Uploading reviewed plugin…';
        try {
          await this.uploadReviewedPlugin(submission.id, file);
          submission.has_reviewed_package = true;
          this.renderStudioPluginReviewForm(submission);
          this.setNotice('Reviewed .nbplugin uploaded. Approval will sign these exact plugin files.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
          upload.disabled = false;
          upload.textContent = submission.has_reviewed_package ? 'Replace reviewed plugin' : 'Upload reviewed plugin';
        }
      },
      'is-secondary',
    );
    upload.disabled = !uploadField.input.files?.length;
    uploadField.input.addEventListener('change', () => { upload.disabled = !uploadField.input.files?.length; });
    card.append(uploadField.label, upload);

    let safetyRating = Number.isInteger(submission.safety_rating) ? submission.safety_rating : null;
    const ratingField = makeElement('label', 'publisher-field publisher-rating', 'Safety confidence rating');
    const ratingControl = makeElement('div', 'publisher-rating-control');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(safetyRating ?? 50);
    const readout = makeElement('output', 'publisher-rating-value');
    const showRating = () => {
      readout.textContent = safetyRating === null ? 'Not set' : `${safetyRating}%`;
      readout.dataset.set = String(safetyRating !== null);
    };
    slider.addEventListener('input', () => { safetyRating = Number(slider.value); showRating(); });
    showRating();
    ratingControl.append(slider, readout);
    ratingField.appendChild(ratingControl);
    card.append(ratingField, makeElement('p', 'publisher-help',
      'How confident are you this full-access plugin is safe after inspecting it? Required to publish.'));
    const note = makeField('Reviewer note (required for rejection or change requests)', {
      id: 'studio-plugin-review-note', type: 'textarea', required: false, maxLength: 2000,
    });
    card.appendChild(note.label);
    const buttons = makeElement('div', 'publisher-review-actions');
    const perform = async (decision, label) => {
      const reviewNote = note.input.value.trim();
      if (decision !== 'publish' && !reviewNote) {
        this.setNotice('Add a reviewer note before requesting changes or rejecting.', 'error');
        note.input.focus();
        return;
      }
      if (decision === 'publish' && !submission.has_reviewed_package) {
        this.setNotice('Upload the exact inspected .nbplugin before approval.', 'error');
        return;
      }
      if (decision === 'publish' && safetyRating === null) {
        this.setNotice('Set a safety confidence rating before publishing.', 'error');
        slider.focus();
        return;
      }
      buttons.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const result = await this.call('review-plugin', {
          submissionId: submission.id, decision, reviewNote, safetyRating,
        });
        await this.renderReviewQueue();
        this.setNotice(result.notificationSent === false
          ? `${label}. ${emailFailureNotice(result.notificationError)}`
          : `${label}.`, result.notificationSent === false ? 'warning' : 'success');
        if (decision === 'publish') this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
        buttons.querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    };
    buttons.append(
      this.makeAction('Request changes', () => perform('request-changes', 'Changes requested'), 'is-secondary'),
      this.makeAction('Reject', () => perform('reject', 'Studio plugin submission rejected'), 'is-danger'),
      this.makeAction('Approve & sign', () => perform('publish', 'Studio plugin approved and signed'), 'publisher-submit'),
    );
    card.append(buttons, this.makeAction('Back to review queue', () => this.renderReviewQueue()));
    this.nodes.content.appendChild(card);
  }

  renderCommunityTemplateReviewForm(submission) {
    const metadata = submission.metadata || {};
    this.setPage(`Review ${metadata.name || submission.template_id}`,
      `Community template · submitted by ${submission.owner_email || 'verified publisher'} · ${submission.type} · v${submission.version}`);
    const card = makeElement('article', 'publisher-card publisher-review-form');
    for (const line of [
      `Template ID: ${submission.template_id}`,
      `Version: ${submission.version}`,
      `Author: ${metadata.author || '—'}`,
      `Category: ${metadata.category || '—'}`,
      `Description: ${metadata.description || '—'}`,
    ]) card.appendChild(makeElement('p', 'publisher-review-line', line));
    card.appendChild(makeElement('p', 'publisher-security-note',
      'Treat every field and text file as untrusted. Inspect every path and file in the complete signed .nbtemplate; do not execute or import anything from it. Approval publishes this exact signed bundle without converting or re-signing it.'));
    if (submission.download_url) {
      const download = makeElement('a', 'publisher-download', 'Download original .nbtemplate for inspection');
      download.href = packageDownloadUrl(
        submission.download_url,
        `${submission.template_id}-${submission.version}.nbtemplate`,
      );
      download.download = `${submission.template_id}-${submission.version}.nbtemplate`;
      card.appendChild(download);
    }
    card.appendChild(makeElement('p', 'publisher-review-upload-help',
      submission.has_reviewed_package
        ? 'Signed .nbtemplate uploaded and verified. You may replace it with another inspected file before approval.'
        : 'Upload the exact inspected signed .nbtemplate. Approval stays disabled until this human-review step is complete.'));
    const uploadField = makeField('Reviewed signed template (.nbtemplate)', {
      id: 'reviewed-community-template',
      type: 'file',
      required: false,
    });
    uploadField.input.accept = '.nbtemplate';
    const upload = this.makeAction(
      submission.has_reviewed_package ? 'Replace signed .nbtemplate' : 'Upload signed .nbtemplate',
      async () => {
        const file = uploadField.input.files?.[0];
        if (!file) {
          this.setNotice('Choose the inspected signed .nbtemplate first.', 'error');
          uploadField.input.focus();
          return;
        }
        if (file.size > Math.ceil((4 * 1024 * 1024) / 3) * 4) {
          this.setNotice('The signed .nbtemplate must be no larger than 5.34 MiB.', 'error');
          return;
        }
        if (!file.name.toLowerCase().endsWith('.nbtemplate')) {
          this.setNotice('Choose a signed .nbtemplate bundle.', 'error');
          return;
        }
        upload.disabled = true;
        upload.textContent = 'Uploading signed .nbtemplate…';
        try {
          await this.uploadReviewedTemplate(submission.id, file);
          submission.has_reviewed_package = true;
          this.renderCommunityTemplateReviewForm(submission);
          this.setNotice('Signed .nbtemplate uploaded, signature verified, and contents matched to the submission.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
          upload.disabled = false;
          upload.textContent = submission.has_reviewed_package
            ? 'Replace signed .nbtemplate'
            : 'Upload signed .nbtemplate';
        }
      },
      'is-secondary',
    );
    upload.disabled = !uploadField.input.files?.length;
    uploadField.input.addEventListener('change', () => { upload.disabled = !uploadField.input.files?.length; });
    card.append(uploadField.label, upload);

    const note = makeField('Reviewer note (required for rejection or change requests)', {
      id: 'community-template-review-note',
      type: 'textarea',
      required: false,
      maxLength: 2000,
    });
    card.appendChild(note.label);
    const buttons = makeElement('div', 'publisher-review-actions');
    const perform = async (decision, label) => {
      const reviewNote = note.input.value.trim();
      if (decision !== 'publish' && !reviewNote) {
        this.setNotice('Add a reviewer note before requesting changes or rejecting.', 'error');
        note.input.focus();
        return;
      }
      if (decision === 'publish' && !submission.has_reviewed_package) {
        this.setNotice('Upload the complete inspected signed .nbtemplate before approval.', 'error');
        return;
      }
      buttons.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const result = await this.call('review-template', {
          submissionId: submission.id,
          decision,
          reviewNote,
        });
        await this.renderReviewQueue();
        this.setNotice(result.notificationSent === false
          ? `${label}. ${emailFailureNotice(result.notificationError)}`
          : `${label}.`, result.notificationSent === false ? 'warning' : 'success');
        if (decision === 'publish') this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
        buttons.querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    };
    const approve = this.makeAction(
      'Approve & publish signed template',
      () => perform('publish', 'Community template approved and published'),
      'publisher-submit',
    );
    approve.disabled = !submission.has_reviewed_package;
    buttons.append(
      this.makeAction('Request changes', () => perform('request-changes', 'Changes requested'), 'is-secondary'),
      this.makeAction('Reject', () => perform('reject', 'Community template rejected'), 'is-danger'),
      approve,
    );
    card.append(buttons, this.makeAction('Back to review queue', () => this.renderReviewQueue()));
    this.nodes.content.appendChild(card);
  }

  renderReviewForm(submission) {
    const info = submission.metadata || {};
    this.setPage(`Review ${info.name || submission.app_id}`, `Submitted by ${submission.owner_email || 'verified publisher'} · ${submission.type} · v${submission.version}`);
    const card = makeElement('article', 'publisher-card publisher-review-form');
    const lines = [
      `App ID: ${submission.app_id}`,
      `Version: ${submission.version}`,
      `Publisher: ${info.author || '—'}`,
      `Categories: ${(info.categories || []).join(', ') || '—'}`,
      `Description: ${info.description || '—'}`,
      `Changelog: ${submission.changelog || '—'}`,
    ];
    for (const line of lines) card.appendChild(makeElement('p', 'publisher-review-line', line));
    appendAutomatedReview(card, submission.automated_review, { includeManualChecks: true });
    if (submission.download_url) {
      const download = makeElement('a', 'publisher-download', 'Download package for review');
      download.href = packageDownloadUrl(
        submission.download_url,
        `${submission.app_id}-${submission.version}.novaapp`,
      );
      download.download = `${submission.app_id}-${submission.version}.novaapp`;
      card.appendChild(download);
    }
    const uploadIntro = makeElement('p', 'publisher-review-upload-help',
      submission.has_reviewed_package
        ? 'Reviewed package uploaded. You can upload another version to replace it before approval.'
        : 'After inspecting the download, upload the reviewed .novaapp. Approval is enabled only after this step; the server signs it when you publish.');
    const uploadField = makeField('Reviewed package (.novaapp)', {
      id: 'reviewed-package',
      type: 'file',
      required: false,
    });
    uploadField.input.accept = '.novaapp,application/json';
    uploadField.input.disabled = false;
    const uploadButton = this.makeAction(
      submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package',
      async () => {
        const file = uploadField.input.files?.[0];
        if (!file) {
          this.setNotice('Choose the reviewed .novaapp file first.', 'error');
          uploadField.input.focus();
          return;
        }
        if (file.size > MAX_PACKAGE_BYTES) {
          this.setNotice('The reviewed package must be no larger than 25 MB.', 'error');
          return;
        }
        uploadButton.disabled = true;
        uploadButton.textContent = 'Uploading package…';
        try {
          await this.uploadReviewedPackage(submission.id, file);
          submission.has_reviewed_package = true;
          this.renderReviewForm(submission);
          this.setNotice('Reviewed package uploaded. Approve & publish when your inspection is complete.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
          uploadButton.disabled = false;
          uploadButton.textContent = submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package';
        }
      },
      'is-secondary'
    );
    uploadButton.disabled = true;
    uploadField.input.addEventListener('change', () => {
      uploadButton.disabled = !uploadField.input.files?.length;
      uploadButton.textContent = submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package';
    });
    card.append(uploadIntro, uploadField.label, uploadButton);

    // Starts unset on purpose: a silent default of 50 would end up recorded as a real judgment.
    let safetyRating = Number.isInteger(submission.safety_rating) ? submission.safety_rating : null;
    const ratingField = makeElement('label', 'publisher-field publisher-rating', 'Safety confidence rating');
    const ratingControl = makeElement('div', 'publisher-rating-control');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'safety-rating';
    slider.name = 'safety-rating';
    slider.min = '1';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(safetyRating ?? 50);
    const readout = makeElement('output', 'publisher-rating-value');
    readout.htmlFor = slider.id;
    const showRating = () => {
      readout.textContent = safetyRating === null ? 'Not set' : `${safetyRating}%`;
      readout.dataset.set = String(safetyRating !== null);
      slider.setAttribute('aria-valuetext', safetyRating === null ? 'Not set' : `${safetyRating} percent`);
    };
    slider.addEventListener('input', () => {
      safetyRating = Number(slider.value);
      showRating();
    });
    showRating();
    ratingControl.append(slider, readout);
    ratingField.appendChild(ratingControl);
    card.append(
      ratingField,
      makeElement('p', 'publisher-help', 'How confident you are that this app is safe, after inspecting the package. Required to publish.'),
    );

    const note = makeField('Reviewer note (required for rejection or change requests)', {
      id: 'review-note',
      type: 'textarea',
      required: false,
      maxLength: 2000,
      placeholder: 'Private note sent to the publisher.',
    });
    card.appendChild(note.label);
    const buttons = makeElement('div', 'publisher-review-actions');
    const perform = async (action, label) => {
      const text = note.input.value.trim();
      if (['reject', 'request-changes'].includes(action) && !text) {
        this.setNotice('Add a reviewer note before requesting changes or rejecting.', 'error');
        note.input.focus();
        return;
      }
      if (action === 'publish' && !submission.has_reviewed_package) {
        this.setNotice('Upload the inspected .novaapp before approving this submission.', 'error');
        return;
      }
      if (action === 'publish' && safetyRating === null) {
        this.setNotice('Set a safety confidence rating before publishing.', 'error');
        slider.focus();
        return;
      }
      buttons.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const result = await this.call('review', {
          submissionId: submission.id,
          decision: action,
          reviewNote: text,
          safetyRating,
        });
        await this.renderReviewQueue();
        this.setNotice(result.notificationSent === false
          ? `${label}. ${emailFailureNotice(result.notificationError)}`
          : `${label}.`, result.notificationSent === false ? 'warning' : 'success');
        if (action === 'publish') this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
        buttons.querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    };
    buttons.append(
      this.makeAction('Request changes', () => perform('request-changes', 'Changes requested'), 'is-secondary'),
      this.makeAction('Reject', () => perform('reject', 'Submission rejected'), 'is-danger'),
      this.makeAction('Approve & publish', () => perform('publish', 'App published'), 'publisher-submit')
    );
    card.appendChild(buttons);
    card.appendChild(this.makeAction('Back to review queue', () => this.renderReviewQueue()));
    this.nodes.content.appendChild(card);
  }

  init({ onCatalogChanged, showStore }) {
    this.onCatalogChanged = onCatalogChanged || this.onCatalogChanged;
    this.showStore = showStore || this.showStore;
    const navigate = page => this.open(page).catch(error => {
      console.error(`[Publisher] Could not open ${page}:`, error);
      this.setNotice(error.message || String(error), 'error');
    });
    this.nodes.signIn.addEventListener('click', () => navigate('signin'));
    this.nodes.signUp.addEventListener('click', () => navigate('signup'));
    this.nodes.publish.addEventListener('click', () => navigate('publish'));
    this.nodes.myApps.addEventListener('click', () => navigate('my-apps'));
    this.nodes.publishPlugin.addEventListener('click', () => navigate('publish-plugin'));
    this.nodes.myPlugins.addEventListener('click', () => navigate('my-plugins'));
    this.nodes.publishTemplate.addEventListener('click', () => navigate('publish-template'));
    this.nodes.myTemplates.addEventListener('click', () => navigate('my-templates'));
    this.nodes.account.addEventListener('click', () => navigate('account'));
    this.nodes.review.addEventListener('click', () => navigate('review'));
    this.nodes.signOut.addEventListener('click', async () => {
      try {
        if (this.session) {
          await this.request('/auth/v1/logout', { method: 'POST', token: this.session.access_token });
        }
      } catch (error) {
        console.warn('[Publisher] Remote sign-out failed; clearing local session:', error);
      } finally {
        this.clearSession();
        this.updateNavigation();
        this.showStore();
      }
    });
    this.nodes.nav.addEventListener('click', event => {
      if (!event.target.closest('.publisher-nav-button')) return;
      this.nodes.nav.querySelectorAll('details[open]').forEach(menu => {
        menu.open = false;
      });
    });
    this.nodes.back.addEventListener('click', () => this.showStore());
    document.addEventListener('click', event => {
      if (this.activeMenu && !this.activeMenu.parentElement.contains(event.target)) this.closeMenus();
    });

    this.updateNavigation();
    if (this.configured) {
      this.captureVerificationCallback()
        .then(verified => {
          if (verified) {
            this.updateNavigation();
            const page = this.user?.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps';
            this.open(page).then(() => this.setNotice('Email verified. Your publisher account is ready.', 'success'));
          } else {
            return this.ensureSession().then(user => {
              this.updateNavigation();
              // Don't clobber a deep-link hash — if the URL points at a specific
              // app (e.g. #com.dirazcoder.focus), let the store open it instead.
              // Supabase callback hashes always contain '='; app IDs never do.
              const hasAppHash = location.hash.length > 1 && !location.hash.includes('=');
              if (user && !hasAppHash) this.open(user.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps');
            });
          }
        })
        .catch(error => {
          console.error('[Publisher] Could not restore authentication:', error);
          this.setNotice(`Could not restore your sign-in right now: ${error.message || String(error)} Your saved session was kept; reload to retry.`, 'error');
        });
    }
  }
}

export const publisherPortal = new PublisherPortal();