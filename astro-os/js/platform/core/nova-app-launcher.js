(function () {
  const appManagerPackageFiles = window.__novaUnrestrictedPackage?.files || {};
  const osSvgIcon = window.svgIcon;

  function svgIcon(name, size = 16) {
    if (typeof osSvgIcon !== 'function') {
      throw new Error('AstroOS icon renderer is unavailable');
    }

    return osSvgIcon(name, size).replace(/src="\/assets\/([^"]+)"/g, (attribute, fileName) => {
      const encoded = appManagerPackageFiles[`icons/${fileName}`];
      if (!encoded) return attribute;
      const mime = fileName.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return `src="data:${mime};base64,${encoded}"`;
    });
  }

  // Used only by the legacy launch fallback below. Keep its v2 storage
  // facade aligned with AppSandbox while routing through the fallback bridge.
  function buildNovaOSCompatShim() {
    return `window.novaOS = Object.freeze({
      apiVersion: 2,
      capabilities: Object.freeze({
        has: function(name) { return typeof name === 'string' && name === 'storage.v2'; },
      }),
      storage: Object.freeze({
        get: function(key) {
          return window.nova.ipc('nova:storage:get', { key: key }).then(function(result) {
            return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
          });
        },
        set: function(key, value) {
          return window.nova.ipc('nova:storage:set', { key: key, value: value }).then(function() {});
        },
        remove: function(key) {
          return window.nova.ipc('nova:storage:delete', { key: key }).then(function() {});
        },
        clear: function() {
          return window.nova.ipc('nova:storage:clear', {}).then(function() {});
        },
        keys: function() {
          return window.nova.ipc('nova:storage:keys', {}).then(function(result) {
            return result && Array.isArray(result.keys) ? result.keys : [];
          });
        },
      }),
    });`;
  }

  function resolvePackageIcon(appData) {
    const icon = appData?.icon;
    if (typeof icon !== 'string' || !icon || /^(?:data:|https?:\/\/|\/)/i.test(icon)) {
      return icon || '/assets/no_app_icon.svg';
    }

    const encoded = appData.files?.[icon];
    if (!encoded) return icon;

    const extension = icon.split('.').pop()?.toLowerCase();
    const mime = extension === 'svg' ? 'image/svg+xml'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'gif' ? 'image/gif'
      : extension === 'webp' ? 'image/webp'
      : 'image/png';
    return `data:${mime};base64,${encoded}`;
  }

// ── Shared Nova app launch config (hoisted to module scope) ──────────────
// buildNovaAppConfig() and its helpers used to live entirely inside
// init(content) below, meaning they only existed once a user actually
// opened the App Manager window. boot.js needs the exact same rendering
// logic (files/entry wiring, permission gating, trust/tamper checks,
// sandboxed webview launch) to correctly re-register previously-installed
// apps at boot time — before App Manager has ever been opened. Hoisting
// these to the top level and exposing buildNovaAppConfig on window lets
// boot.js reuse the real implementation instead of a second, incomplete
// hand-rolled one that was missing files/entry/init entirely.
//
// The one thing that doesn't hoist as-is is the AbortController: the
// original version closed over a single `ac` created once per App-Manager-
// window-open and shared across every launch from that window. Each call
// to buildNovaAppConfig() now creates its own AbortController scoped to
// that one launch instead — every call already gets its own webview and
// listeners, so a per-launch controller is more correct than the old
// per-window one, not a shortcut.
    function buildSandboxCSP(appData) {
      const base = "default-src 'self' blob: data: 'unsafe-inline' 'unsafe-eval'; " +
        "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline' blob: data:; " +
        "img-src 'self' blob: data: https:; " +
        "font-src 'self' blob: data:; " +
        "connect-src 'self' blob: http://localhost:* https://localhost:*";

      let frameSrc = '';
      if (appData?.url) {
        try {
          const parsed = new URL(appData.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            // Scope to exactly this app's declared origin — not a wildcard —
            // so one app can't use this allowance to frame arbitrary sites.
            frameSrc = '; frame-src ' + parsed.origin;
          } else {
            console.warn('[AppManager] app declares non-http(s) url, ignoring for frame-src:', appData.url);
          }
        } catch (e) {
          console.warn('[AppManager] app declares invalid url, ignoring for frame-src:', appData.url);
        }
      }

      const escaped = (base + frameSrc).replace(/"/g, '&quot;');
      return '<meta http-equiv="Content-Security-Policy" content="' + escaped + '">\n';
    }
    // ── Text sanitisation: avoid innerHTML with user-controlled strings ──
    function escapeHtml(str) {
      const el = document.createElement('span');
      el.textContent = str;
      return el.innerHTML;
    }
    // ── System-impersonation gate ─────────────────────────────────────────
// A package can claim `manifest.system === true` freely — that field is
// just JSON the installer writes, anyone can set it. What actually makes
// `system` meaningful downstream (isTrustedTransparentSystemApp in
// app-sandbox.js, the System badge here) is verified===true AND
// signer==='Astro System'. So an untrusted OR tampered package that
// also claims system:true isn't an ordinary "unknown publisher" case —
// there's no legitimate reason for a real Astro System package to
// ever fail verification, since js/apps/novaapp-manifest.json (fetched
// below) is the actual, non-installable list of ids allowed to carry that
// claim; nothing an install flow does can add an entry to it. A failure
// on that specific combination means either a bug in a real release, or
// something pretending to be one — both warrant a hard stop, not a
// one-click "Install Anyway" meant for ambiguous unknown-publisher cases.
let _firstPartyManifestCache = null;
async function _getFirstPartyAppIds() {
  if (_firstPartyManifestCache) return _firstPartyManifestCache;
  try {
    const response = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    const parsed = await response.json();
    _firstPartyManifestCache = new Set(
      Array.isArray(parsed) ? parsed.filter(x => x?.id).map(x => x.id) : []
    );
  } catch (e) {
    console.warn('[AppManager] Could not load first-party manifest for impersonation check:', e);
    // Fail closed: if the manifest can't be read, treat the id list as
    // empty rather than skip the check — an empty set still catches any
    // package claiming system:true, since none can match an empty list.
    _firstPartyManifestCache = new Set();
  }
  return _firstPartyManifestCache;
}

/**
 * Returns true if this package should be hard-blocked as a suspected
 * system-app impersonation attempt, rather than routed through the
 * ordinary untrusted/tamper dialogs.
 *
 * Fires when the package claims manifest.system===true AND either:
 *   - its id matches a real first-party id but verification/integrity
 *     failed (a genuine Astro System package should never fail this), or
 *   - its id does NOT match any first-party id at all (nothing but the
 *     four ids in novaapp-manifest.json has any legitimate claim to
 *     system:true — a fifth id claiming it has no honest explanation).
 */
async function isSuspectedSystemImpersonation(pkg, { verified, integrityStatus }) {
  if (pkg?.manifest?.system !== true) return false;
  const firstPartyIds = await _getFirstPartyAppIds();
  const claimedId = pkg?.manifest?.id;
  const isKnownId = firstPartyIds.has(claimedId);
  const trustOk = verified === true;
  const integrityOk = integrityStatus !== 'failed';
  if (!isKnownId) return true;
  return !(trustOk && integrityOk);
}

function showSystemImpersonationDialog(appData) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

    const box = document.createElement('div');
    box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.55);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.04) inset,0 0 50px rgba(248,81,73,0.12);animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

    const safeName = escapeHtml(appData?.name || appData?.id || 'This package');
    const safeId = escapeHtml(appData?.id || '(none)');

    box.innerHTML = `
      <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
        <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.14);border:1px solid rgba(248,81,73,0.5);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDEAB</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">Blocked — Suspected System Impersonation</div>
          <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
            <b>${safeName}</b> <span style="color:var(--text-muted,#888);">(${safeId})</span> declares itself a Astro System package but does not hold a valid, matching System signature and intact contents.
          </div>
        </div>
      </div>
      <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
        <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);border-radius:8px;">
          <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
          <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
            <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">Why this is blocked, not just a warning</div>
            A real Astro System package has no legitimate reason to fail signature or integrity verification. This combination — claiming the System badge while failing that check — is a defining sign of an attempt to impersonate a trusted system component rather than an ordinary publishing mistake. AstroOS does not offer an override for this case.
          </div>
        </div>
      </div>
      <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;">
        <button id="nb-impersonation-ack-btn" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:600;">Okay</button>
      </div>
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      #nb-impersonation-ack-btn:hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.6); }
      #nb-impersonation-ack-btn:active { transform:scale(0.97); }
    `;
    document.head.appendChild(styleEl);

    overlay.appendChild(backdrop);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => { overlay.remove(); styleEl.remove(); };
    box.querySelector('#nb-impersonation-ack-btn').addEventListener('click', () => { cleanup(); resolve(false); });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { cleanup(); resolve(false); } });
  });
}

function showUntrustedAppDialog(appData, { onLaunchAnyway } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border,#333);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const isRevoked = !!appData.revoked;
        const hasSignature = !!appData.signature;
        const integrityStatus = appData.integrityStatus || 'unavailable';
        const integrityLabel = integrityStatus === 'ok' ? 'passed — contents match build-time hash'
          : integrityStatus === 'failed' ? '\u26A0\uFE0F failed — contents do not match build-time hash'
          : 'not available — package has no integrity hash to check against';
        const integrityColor = integrityStatus === 'failed' ? '#f85149' : 'var(--text-primary,#eee)';

        let title, summary, cautionText, cautionBorderColor, cautionBgColor, cautionDotColor, cautionTitle, iconEmoji;

        if (isRevoked) {
          iconEmoji = '\uD83D\uDD34';
          title = 'Revoked Package — Do Not Install';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} carries a signature that has been individually revoked by AstroOS.
            This package was previously verified as signed by a trusted authority, but was subsequently pulled from the trust list — most likely because it was found to be harmful, deceptive, or non-compliant after review.`;
          cautionTitle = 'Why this is serious';
          cautionText = 'A revoked signature means AstroOS once recognised the publisher, but has since decided this specific package should not be trusted. Other packages from the same publisher may still be trusted, but this one is not. Installing it bypasses an explicit security decision.';
          cautionBorderColor = 'rgba(248,81,73,0.35)';
          cautionBgColor = 'rgba(248,81,73,0.1)';
          cautionDotColor = '#f85149';
        } else if (hasSignature) {
          iconEmoji = '\u26A0\uFE0F';
          title = 'Untrusted App — Unknown Publisher';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} is signed, but the signer is not in AstroOS's trust store.
            This usually means the app is self-signed by an individual developer, or signed by an authority that hasn't been reviewed and added to the system trust list.`;
          cautionTitle = 'What this means';
          cautionText = `AstroOS cannot confirm the identity of the publisher or guarantee that the package has not been modified since it was signed. This doesn't prove the app is malicious — it just means nobody vetted the publisher on your behalf. Proceed only if you obtained the package directly from a developer or source you personally trust.`;
          cautionBorderColor = 'rgba(210,153,34,0.3)';
          cautionBgColor = 'rgba(210,153,34,0.08)';
          cautionDotColor = '#d29922';
        } else {
          iconEmoji = '\u26A0\uFE0F';
          title = 'Untrusted App — Not Signed';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} is not digitally signed.
            AstroOS cannot verify who created the package, when it was built, or whether it has been altered since distribution.`;
          cautionTitle = 'What this means';
          cautionText = 'An unsigned package provides no cryptographic proof of origin. Anyone could have created or modified it. Only proceed if you inspected the package yourself and trust its source completely.';
          cautionBorderColor = 'rgba(210,153,34,0.25)';
          cautionBgColor = 'rgba(210,153,34,0.06)';
          cautionDotColor = '#d29922';
        }

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid ${cautionBorderColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">${iconEmoji}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">${title}</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">${summary}</div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:${cautionBgColor};border:1px solid ${cautionBorderColor};border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:${cautionDotColor};flex-shrink:0;margin-top:7px;box-shadow:0 0 6px ${cautionDotColor};"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">${cautionTitle}</div>
                ${cautionText}
              </div>
            </div>

            <div id="nb-untrusted-more" style="display:none;padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;animation:nb-fade-in 150ms ease-out;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">${isRevoked ? 'present, but revoked by AstroOS' : hasSignature ? 'present, but not from a recognised signer' : 'none — package is not signed'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:${integrityColor};text-align:right;">${integrityLabel}</span></div>
                ${isRevoked ? '<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Revocation reason</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;">Removed from trust list by AstroOS</span></div>' : ''}
              </div>
              <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));font-size:12px;color:var(--text-muted,#999);line-height:1.6;">
                Only install or run apps obtained from sources you trust. A missing or unrecognised signature means AstroOS cannot confirm who published this app or guarantee it has not been modified since distribution.${isRevoked ? ' A revoked signature means AstroOS reviewed this package and explicitly decided it should no longer be trusted — installing it overrides that decision.' : ''} If you do not trust the source, cancel this operation and remove the package.
              </div>
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <button id="nb-untrusted-more-btn" style="background:none;border:1px solid var(--border,#444);color:var(--text-muted,#ccc);padding:7px 14px;border-radius:7px;font-size:12px;cursor:pointer;transition:all 0.12s;font-weight:500;">More Info</button>
            <div style="display:flex;gap:8px;">
              <button id="nb-untrusted-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
              <button id="nb-untrusted-launch-btn" style="display:none;background:rgba(248,81,73,0.15);border:1px solid ${isRevoked ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.3)'};color:#f85149;padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:${isRevoked ? 700 : 600};">${isRevoked ? 'Install Despite Revocation' : 'Install Anyway'}</button>
            </div>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-untrusted-more-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-untrusted-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-untrusted-launch-btn:hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-untrusted-launch-btn:active { transform:scale(0.97); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        box.querySelector('#nb-untrusted-more-btn').addEventListener('click', () => {
          const panel = box.querySelector('#nb-untrusted-more');
          const isHidden = panel.style.display === 'none';
          panel.style.display = isHidden ? 'block' : 'none';
          box.querySelector('#nb-untrusted-more-btn').textContent = isHidden ? 'Less Info' : 'More Info';
          box.querySelector('#nb-untrusted-launch-btn').style.display = isHidden ? 'inline-block' : 'none';
        });
        box.querySelector('#nb-untrusted-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        box.querySelector('#nb-untrusted-launch-btn').addEventListener('click', () => {
          cleanup();
          if (typeof onLaunchAnyway === 'function') onLaunchAnyway();
          resolve(true);
        });

        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) {
            cleanup();
            resolve(false);
          }
        });
      });
    }

    // ── Tamper-detected dialog ────────────────────────────────────────
    // Shown when AppPackage.verifyIntegrity() fails — i.e. the package's
    // contents no longer match the BLAKE3/SHA hash that was embedded at
    // build time. This is a DIFFERENT risk from showUntrustedAppDialog:
    // that dialog answers "do we know who signed this?", this one answers
    // "does the content match what was signed?". A package can be validly
    // signed by a fully trusted publisher and still fail this check if it
    // was corrupted or altered after signing — so a trusted signer does
    // NOT make this warning go away, and the two dialogs are intentionally
    // not merged.
    //
    // Because this indicates the file itself may have been altered
    // (rather than just "nobody vouched for the publisher"), there is no
    // one-click "Install Anyway" to match showUntrustedAppDialog's pattern.
    // Proceeding requires typing a confirmation phrase — friction that's
    // proportionate to "this specific file may not be what it claims to be."
    function showTamperDetectedDialog(appData, { mismatchedFiles = [] } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.4);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const fileList = mismatchedFiles.slice(0, 8).map(f => escapeHtml(f)).join(', ')
          + (mismatchedFiles.length > 8 ? `, and ${mismatchedFiles.length - 8} more` : '');

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">Tamper Detected — Package Modified</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} failed its integrity check.
                The package's contents no longer match the hash that was recorded when it was built. This is true regardless of whether the package is signed by a trusted publisher — a valid signature only proves who signed the <i>original</i> file, not that these are still its unmodified contents.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">Why this is serious</div>
                A mismatch here usually means the file was altered after it was packaged — by corruption in transit, or by someone modifying it deliberately. AstroOS cannot tell which. Installing this package means running code that is provably different from what its integrity hash says it should be.
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:#f85149;text-align:right;">\u26A0\uFE0F failed — contents do not match build-time hash</span></div>
                ${fileList ? `<div style="display:flex;flex-direction:column;gap:4px;"><span style="color:var(--text-muted,#999);">Affected file(s)</span><span style="font-weight:500;color:var(--text-primary,#eee);word-break:break-all;">${fileList}</span></div>` : ''}
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <label for="nb-tamper-confirm-input" style="font-size:12px;color:var(--text-muted,#999);">To install anyway, type <b style="color:var(--text-primary,#ddd);">install tampered</b> below:</label>
              <input id="nb-tamper-confirm-input" type="text" autocomplete="off" spellcheck="false" style="background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid var(--border,#444);border-radius:7px;padding:8px 10px;font-size:12.5px;color:var(--text-primary,#eee);font-family:inherit;outline:none;" placeholder="install tampered" />
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-tamper-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
            <button id="nb-tamper-install-btn" disabled style="background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.25);color:rgba(248,81,73,0.5);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:not-allowed;transition:all 0.12s;font-weight:700;">Install Despite Tampering</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-tamper-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-tamper-install-btn:not(:disabled):hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-tamper-install-btn:not(:disabled):active { transform:scale(0.97); }
          #nb-tamper-confirm-input:focus { border-color:rgba(248,81,73,0.5); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        const input = box.querySelector('#nb-tamper-confirm-input');
        const installBtn = box.querySelector('#nb-tamper-install-btn');
        input.addEventListener('input', () => {
          const match = input.value.trim().toLowerCase() === 'install tampered';
          installBtn.disabled = !match;
          installBtn.style.cursor = match ? 'pointer' : 'not-allowed';
          installBtn.style.color = match ? '#f85149' : 'rgba(248,81,73,0.5)';
          installBtn.style.borderColor = match ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.25)';
        });

        box.querySelector('#nb-tamper-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        installBtn.addEventListener('click', () => {
          if (installBtn.disabled) return;
          cleanup();
          resolve(true);
        });
      });
    }

    // ── Malicious file dialog ──────────────────────────────────────────
    // Shown when Scanner.scanText() flags a file inside a .novaapp package
    // during install. Deliberately NOT the same shape as the trust/tamper
    // dialogs above: those are "proceed at your own risk" gates with a
    // type-to-confirm override, because a valid-but-untrusted signature or
    // a hash mismatch is ambiguous — it could be a legitimate publishing
    // mistake. A Scanner hit is not ambiguous in the same way: it means a
    // file inside the package matched a known-bad pattern (disguised
    // executable, embedded script in a rendered file, obfuscated code,
    // packed binary masquerading as text). There's no legitimate reason
    // for that to be present, so this dialog only acknowledges and cancels
    // — no path to install anyway.
    function showMaliciousFileDialog(appData, { fileName, reason } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.5);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.04) inset,0 0 40px rgba(248,81,73,0.08);animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData?.name || appData?.id || 'This app');
        const safeId = escapeHtml(appData?.id || '');
        const safeFile = escapeHtml(fileName || 'a file in this package');
        const safeReason = escapeHtml(reason || 'It matched a pattern associated with malicious files.');

        box.innerHTML = `
          <div style="padding:20px 24px 16px;background:linear-gradient(180deg,rgba(248,81,73,0.12),transparent);border-bottom:1px solid rgba(248,81,73,0.25);display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.5);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:#f85149;margin-bottom:5px;letter-spacing:-0.01em;">Malicious File</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} was blocked before install. This application may cause damage to your device, steal data, or behave in ways you didn't authorize — installation cannot continue.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">What was found</div>
                <span style="color:var(--text-primary,#eee);font-weight:500;">${safeFile}</span> — ${safeReason}
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.55;">
                This scan is a heuristic check, not a full antivirus — it looks for known red flags like disguised executables, hidden scripts inside files that shouldn't have any, and obfuscated or packed code. A block here means something concrete tripped that check. If you trust the source and believe this is a false positive, get an updated package from the publisher rather than forcing this one through — AstroOS won't install a file that fails this check.
              </div>
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-malware-ok-btn" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.5);color:#f85149;padding:7px 18px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:700;">Cancel Install</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-malware-ok-btn:hover { background:rgba(248,81,73,0.28);border-color:rgba(248,81,73,0.7);box-shadow:0 0 14px rgba(248,81,73,0.2); }
          #nb-malware-ok-btn:active { transform:scale(0.97); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        box.querySelector('#nb-malware-ok-btn').addEventListener('click', () => {
          cleanup();
          resolve();
        });
      });
    }

    // ── Combined trust + integrity dialog ─────────────────────────────
    // Used ONLY when BOTH checks fail at once — i.e. exactly the 3 real
    // combos: unsigned+tampered, untrusted-signer+tampered, revoked+tampered.
    // (verified+tampered has no trust problem, so it still uses the plain
    // showTamperDetectedDialog alone — no combo needed there.)
    // This is a single popup with two distinct labeled sections (trust
    // issue, then integrity issue) rather than two dialogs chained, and
    // rather than one blended paragraph — the two questions ("who signed
    // this?" and "does it match what was signed?") stay visually separate
    // so neither reads as explaining away the other. Always requires
    // typing "install tampered" to proceed, same bar as tamper alone,
    // since tampering is present in every case this dialog covers.
    function showCombinedTrustIntegrityDialog(appData, { mismatchedFiles = [] } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.4);border-radius:14px;max-width:540px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const isRevoked = !!appData.revoked;
        const hasSignature = !!appData.signature;
        const fileList = mismatchedFiles.slice(0, 8).map(f => escapeHtml(f)).join(', ')
          + (mismatchedFiles.length > 8 ? `, and ${mismatchedFiles.length - 8} more` : '');

        // Same 3-way trust sub-state branch as showUntrustedAppDialog,
        // reused here for the top section's copy only.
        let trustTitle, trustSummary, trustSignatureLabel;
        if (isRevoked) {
          trustTitle = 'Revoked Signature';
          trustSummary = `This package's signature was individually revoked by AstroOS — it was previously trusted, but has since been pulled from the trust list, most likely because it was found to be harmful, deceptive, or non-compliant after review.`;
          trustSignatureLabel = 'present, but revoked by AstroOS';
        } else if (hasSignature) {
          trustTitle = 'Unknown Publisher';
          trustSummary = `This package is signed, but the signer is not in AstroOS's trust store. AstroOS cannot confirm the identity of the publisher.`;
          trustSignatureLabel = 'present, but not from a recognised signer';
        } else {
          trustTitle = 'Not Signed';
          trustSummary = `This package is not digitally signed. AstroOS cannot verify who created it or whether it has been altered since distribution.`;
          trustSignatureLabel = 'none — package is not signed';
        }

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">Two Problems Found — ${escapeHtml(trustTitle)} &amp; Tamper Detected</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} failed two independent checks: AstroOS cannot confirm who published it, <i>and</i> its contents no longer match the hash recorded at build time. These are separate risks — either one alone would be worth pausing on; together, proceed only if you're certain of both the source and the copy you have.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);">Trust issue — ${escapeHtml(trustTitle)}</div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(210,153,34,0.08);border:1px solid rgba(210,153,34,0.3);border-radius:8px;">
                <div style="width:6px;height:6px;border-radius:50%;background:#d29922;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #d29922;"></div>
                <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">${trustSummary}</div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);">Integrity issue — Tamper Detected</div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
                <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
                <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                  The package's contents no longer match the hash recorded when it was built. This is true regardless of who signed it — a valid signature only proves who signed the <i>original</i> file, not that these are still its unmodified contents.
                </div>
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">${trustSignatureLabel}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:#f85149;text-align:right;">\u26A0\uFE0F failed — contents do not match build-time hash</span></div>
                ${fileList ? `<div style="display:flex;flex-direction:column;gap:4px;"><span style="color:var(--text-muted,#999);">Affected file(s)</span><span style="font-weight:500;color:var(--text-primary,#eee);word-break:break-all;">${fileList}</span></div>` : ''}
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <label for="nb-combo-confirm-input" style="font-size:12px;color:var(--text-muted,#999);">To install anyway, type <b style="color:var(--text-primary,#ddd);">install tampered</b> below:</label>
              <input id="nb-combo-confirm-input" type="text" autocomplete="off" spellcheck="false" style="background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid var(--border,#444);border-radius:7px;padding:8px 10px;font-size:12.5px;color:var(--text-primary,#eee);font-family:inherit;outline:none;" placeholder="install tampered" />
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-combo-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
            <button id="nb-combo-install-btn" disabled style="background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.25);color:rgba(248,81,73,0.5);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:not-allowed;transition:all 0.12s;font-weight:700;">Install Despite Both</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-combo-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-combo-install-btn:not(:disabled):hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-combo-install-btn:not(:disabled):active { transform:scale(0.97); }
          #nb-combo-confirm-input:focus { border-color:rgba(248,81,73,0.5); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        const input = box.querySelector('#nb-combo-confirm-input');
        const installBtn = box.querySelector('#nb-combo-install-btn');
        input.addEventListener('input', () => {
          const match = input.value.trim().toLowerCase() === 'install tampered';
          installBtn.disabled = !match;
          installBtn.style.cursor = match ? 'pointer' : 'not-allowed';
          installBtn.style.color = match ? '#f85149' : 'rgba(248,81,73,0.5)';
          installBtn.style.borderColor = match ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.25)';
        });

        box.querySelector('#nb-combo-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        installBtn.addEventListener('click', () => {
          if (installBtn.disabled) return;
          cleanup();
          resolve(true);
        });

        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) {
            cleanup();
            resolve(false);
          }
        });
      });
    }
    function buildNovaAppConfig(appData) {
      const appId = appData.id;
      console.log('[AppManager][DIAG] launch appId=', JSON.stringify(appId), 'partition=', 'persist:app_' + appId);

      const isSystemSigned = appData.verified === true &&
        appData.signer === 'Astro System' &&
        appData.manifest?.system === true;

      return {
        id: appId,
        name: appData.name,
        icon: resolvePackageIcon(appData),
        description: appData.description || '',
        defaultSize: appData.defaultSize || [800, 560],
        minSize: appData.minSize || [400, 300],
        minSecurityPatch: appData.minSecurityPatch || null,
        permissions: appData.permissions || [],
        optionalPermissions: appData.optionalPermissions || [],
        entry: appData.entry || 'index.html',
        unrestrictedEntry: appData.unrestrictedEntry || appData.manifest?.unrestrictedEntry || null,
        files: appData.files || {},
        sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
        type: appData.type || 'package',
        // Keep developer tools hidden and unlaunchable unless Developer Mode is enabled.
        devOnly: appData.devOnly === true || appData.manifest?.devOnly === true,
        // Preserve the package lifecycle/trust metadata on the live OS.app
        // object. Boot and App Manager hydrate the same package record, but
        // previously this config builder dropped verified/signer/source, so
        // apps loaded from js/apps/*.novaapp appeared Unverified after restart
        // and were treated as built-ins by IPC uninstall.
        source: appData.source || 'file',
        verified: appData.verified === true,
        signer: appData.signer || null,
        revoked: appData.revoked === true,
        tampered: appData.tampered === true,
        system: isSystemSigned,
        signature: appData.signature || null,
        signing: appData.signing || null,
        integrity: appData.integrity || null,
        novabyte_app: appData.novabyte_app,
        compiled_at: appData.compiled_at,
        manifest: appData.manifest || undefined,
        resizable: appData.resizable !== false,
        transparent: !!appData.transparent,
        alwaysOnTop: !!appData.alwaysOnTop,
        startMinimized: !!appData.startMinimized,
        frame: appData.frame !== false,
        // Capability manifest (js/apps/default-apps/service.js reads this
        // to offer the app as a Default Apps candidate). Was missing here —
        // same bug class as app-registry.js's registerApp()/initialize(),
        // just in this install path's separate config builder instead.
        handles: appData.handles ?? appData.manifest?.handles ?? undefined,

        async init(contentEl, state, options) {
          // Scoped to this one launch — see the header comment above for
          // why this replaced the old per-window `ac` from init(content).
          const ac = new AbortController();
          try { await window.AppDirs?.ensureAppDataFolder?.(appId); } catch (_e) { /* best-effort */ }
          console.log('[AM.init]', appId, 'AppSandbox?', typeof AppSandbox, 'FrameSecurity?', typeof FrameSecurity);

          // ── Permission gate (parent-side, before iframe loads) ──
          // Matches the pattern already used for built-in apps (see
          // app-permissions-bootstrap.js's _wrapAppInit): prompt for any
          // missing permission so the user's decision gets recorded, but
          // never block the app from launching on a denial. A denied
          // permission just means that specific capability fails
          // gracefully at call time — every host-side handler already
          // checks AppPermissionManager.isGranted() before acting and
          // returns PERMISSION_DENIED if not, so there's nothing left
          // for this gate to protect by refusing to launch at all.
          //
          // This previously called requestAll() and refused to launch the
          // app if any permission — required or optional — came back
          // denied, which meant denying even one optional permission
          // (e.g. notifications) made the entire app unusable rather than
          // just disabling that one feature.
          const requiredPerms = appData.permissions || [];
          const optionalPerms = appData.optionalPermissions || [];
          const allDeclared = [...new Set([...requiredPerms, ...optionalPerms])];

          if (allDeclared.length > 0 && typeof AppPermissionManager !== 'undefined') {
            const mgr = AppPermissionManager;
            for (const permission of allDeclared) {
              await mgr.autoGrantLowRisk?.(permission, appId);
            }
            // Optional permissions are requested by the app at the point a
            // feature needs them. Only missing required medium-or-higher
            // permissions enter the launch consent queue.
            const requiredSensitive = requiredPerms.filter(permission =>
              mgr.PERMISSION_CATEGORIES?.[permission]?.risk !== 'low'
            );
            const missing = requiredSensitive.filter(permission =>
              !mgr.isGranted(permission, appId)
              && !(mgr.isDenied && mgr.isDenied(permission, appId))
            );
            if (missing.length > 0) {
              await mgr.requestAll(missing, appId, appData.name || appId);
            }
          }

          if (typeof AppSandbox !== 'undefined' && typeof AppSandbox.launch === 'function') {
            console.log('[AM.init] TAKING AppSandbox.launch branch for', appId);
            const sandboxApp = {
              id: appId,
              name: appData.name,
              icon: resolvePackageIcon(appData),
              entry: appData.entry || 'index.html',
              unrestrictedEntry: appData.unrestrictedEntry || appData.manifest?.unrestrictedEntry || null,
              files: appData.files || {},
              handles: appData.handles ?? appData.manifest?.handles ?? undefined,
              sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
              permissions: appData.permissions || [],
              optionalPermissions: appData.optionalPermissions || [],
              type: appData.type || 'package',
              // Keep developer tools hidden and unlaunchable unless Developer Mode is enabled.
              devOnly: appData.devOnly === true || appData.manifest?.devOnly === true,
              // Preserve the signed-package identity required by the unrestricted
              // gate. Without these fields the gate rejects the app and silently
              // leaves the sandboxed entry active.
              source: appData.source || 'file',
              verified: appData.verified === true,
              signer: appData.signer || null,
              revoked: appData.revoked === true,
              tampered: appData.tampered === true,
              integrity: appData.integrity || null,
              signature: appData.signature || null,
              signing: appData.signing || null,
              novabyte_app: appData.novabyte_app,
              compiled_at: appData.compiled_at,
              // Manifest opt-in for nested <webview> creation — see
              // isNestedWebviewPermitted() in app-sandbox.js. Must also hold
              // the 'sandbox:nested-webview' grant; this alone doesn't enable it.
              allowNestedWebview: appData.allowNestedWebview === true
                || appData.manifest?.allowNestedWebview === true,
              // These three were previously dropped here, so app-sandbox.js's
              // app.transparent check (the html/body background injection)
              // and isTrustedTransparentSystemApp() gate (transparent + system
              // + verified + signer) could never pass regardless of what the
              // manifest declared — the window chrome (wm.js) reads a
              // different, separately-populated app object and had these
              // fields all along, which is why the titlebar alone looked
              // right while the content stayed opaque.
              transparent: appData.transparent === true,
              system: appData.manifest?.system === true,
              verified: appData.verified === true,
              signer: appData.signer,
              manifest: appData.manifest,
            };
            try {
              return await AppSandbox.launch(sandboxApp, contentEl, state || {}, options || {});
            } catch (launchErr) {
              console.error('[AM.init] AppSandbox.launch THREW for', appId, '- falling through to legacy path:', launchErr);
              throw launchErr;
            }
          }
          console.log('[AM.init] TAKING LEGACY FALLBACK branch for', appId, '- AppSandbox was', typeof AppSandbox, typeof AppSandbox !== 'undefined' ? '(launch: ' + typeof AppSandbox.launch + ')' : '');

          // ── Private data shim injected into iframe ────────────
          const fsDir = (() => { try { return window.AppDirs?.getFSDir?.(appId, 'files'); } catch { return null; } })();
          const safeAppId = JSON.stringify(appId);
          const safeFsDir = JSON.stringify(fsDir);

          const bridgeScript = `(function(){
            try{
              if(!window.__novaPrivateStore) window.__novaPrivateStore={};
              var s=window.__novaPrivateStore;
              s.appId=${safeAppId};
              s.fsDir=${safeFsDir};
              s.getFSDir=function(){return ${safeFsDir}};
              s.lsKey=function(k){return'nova_app_'+${safeAppId}+'_'+k};
              s.get=function(k){try{var v=localStorage.getItem(this.lsKey(k));return v?JSON.parse(v):null}catch{return null}};
              s.set=function(k,v){try{localStorage.setItem(this.lsKey(k),JSON.stringify(v))}catch{/*quota*/}};
              s.del=function(k){localStorage.removeItem(this.lsKey(k))};
            }catch(e){console.warn('[NovaAppBridge] init failed:',e)}
          })();`;

          const bridgeStyle = '<style>#nv-bridge-shim{display:none}</style>';
          const bridgeScriptTag = '<script id="nv-bridge-shim">' + bridgeScript + '<\/script>';

          const entryKey = appData.entry || 'index.html';
          const entryB64 = appData.files?.[entryKey];

          if (!entryB64) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>';
            return;
          }

          // ── Blob URL tracking for memory cleanup ──
          let blobUrl = null;

          // SECURITY (2026-11-12 audit, finding M7): this legacy fallback
          // used to create <webview>s with NO sandbox attribute for any
          // installed package — untrusted .novaapp content running
          // same-origin with the Node-context host page. Only a genuine
          // System signer triple keeps host-tier here (the same rule the
          // modern AppSandbox applies through the UnrestrictedGate);
          // everything else gets the default restrictive sandbox tokens.
          const legacyHostTier = appData.verified === true &&
            appData.signer === 'Astro System' &&
            appData.manifest?.system === true;

          try {
            let html = decodeURIComponent(escape(atob(entryB64)));
            let pkgData = null;

            // ── SECURITY: Removed require('vm').runInThisContext() — this executes
            //    arbitrary untrusted code in the main context, equivalent to eval().
            //    Obfuscated packages that aren't valid JSON are now rejected outright. ──
            if (appData._wasObfuscated) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">\uD83D\uDD12 App blocked: obfuscated packages cannot be loaded. Install only apps from trusted sources.</div>';
                }
                console.warn('[AppManager] Obfuscated package blocked:', appId);
                return;
            }

            // Re-verify integrity at every launch, not just at install time —
            // stored files can be altered after install (storage corruption,
            // a bad sync/restore, manual tampering with installedApps), and
            // a package that was fine when installed is not guaranteed to
            // still be fine now. Mirrors the same up-front computation the
            // install path does, so both dialogs below can reflect the
            // CURRENT state rather than a stale install-time snapshot.
            let launchIntegrityStatus = 'unavailable'; // 'ok' | 'failed' | 'unavailable'
            let launchMismatchedFiles = [];
            if (appData.integrity && typeof AppPackage !== 'undefined' && typeof AppPackage.verifyIntegrity === 'function') {
                // Reconstruct the same pkg shape the install path verifies
                // against (manifest + files + signature + integrity), not a
                // narrower subset — AppPackage's internals aren't in this
                // file, so there's no way to confirm it only reads files+integrity.
                const pkgLike = { manifest: appData, files: appData.files, signature: appData.signature, integrity: appData.integrity };
                try {
                    const integrityOk = await AppPackage.verifyIntegrity(pkgLike);
                    launchIntegrityStatus = integrityOk ? 'ok' : 'failed';
                } catch (_) { launchIntegrityStatus = 'failed'; }

                if (launchIntegrityStatus === 'failed' && typeof AppPackage.computeIntegrity === 'function') {
                    try {
                        const fresh = await AppPackage.computeIntegrity(pkgLike, appData.integrity.method);
                        launchMismatchedFiles = Object.keys(appData.integrity.fileHashes || {})
                            .filter(f => fresh.fileHashes?.[f] !== appData.integrity.fileHashes[f]);
                    } catch (_) { /* best-effort only */ }
                }
            }

            // Trust and/or integrity failure gate. Four shapes possible:
            //  - both pass              -> no dialog, launches straight through
            //  - trust fails only       -> showUntrustedAppDialog alone
            //  - integrity fails only   -> showTamperDetectedDialog alone
            //  - both fail              -> showCombinedTrustIntegrityDialog
            //    (one popup, not two chained) — this is the only case that
            //    needs the combined dialog; a trusted-but-tampered app has
            //    no trust problem to combine, so it still uses tamper alone.
            const trustFailed = appData.verified === false;
            const integrityFailed = launchIntegrityStatus === 'failed';

            if (trustFailed && integrityFailed && !options?.userAllowedUnverified && !options?.userAllowedTampered) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showCombinedTrustIntegrityDialog(appData, { mismatchedFiles: launchMismatchedFiles });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedUnverified: true, userAllowedTampered: true });
            }

            // Unverified (unsigned, or signed by no one in the trust store)
            // apps now get a dialog with a real choice instead of a dead
             // end. `options.userAllowedUnverified` lets the "Install Anyway"
            // path re-enter init() without looping the dialog forever.
            // Only reached here if integrity is NOT also failing (the
            // combo case above already handled that and returned).
            if (trustFailed && !options?.userAllowedUnverified) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showUntrustedAppDialog({ ...appData, integrityStatus: launchIntegrityStatus });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                // Re-run init with the user's explicit one-time override.
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedUnverified: true });
            }

            // Tamper block — separate from signature trust, same as the
            // install path. Only reached here if trust is NOT also failing
            // (the combo case above already handled that). A trusted
            // signer does NOT skip this: trust and tamper are independent
            // axes, so it's possible to see only this dialog (trusted
            // publisher, corrupted local copy), only the one above
            // (untrusted publisher, unmodified files), the combined dialog
            // (both at once), or neither (the common case).
            if (integrityFailed && !options?.userAllowedTampered) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showTamperDetectedDialog(appData, { mismatchedFiles: launchMismatchedFiles });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedTampered: true });
            }

            if (pkgData && !appData.manifest) {
              appData.manifest = pkgData;
              appData.name = appData.name || pkgData.name || appData.id;
              appData.description = appData.description || pkgData.description || '';
              appData.icon = appData.icon || pkgData.icon || '/assets/no_app_icon.svg';
              appData.defaultSize = appData.defaultSize || pkgData.defaultSize || [800, 560];
              appData.minSize = appData.minSize || pkgData.minSize || [400, 300];
            }

            // Canonical session-key shape, matching generateSandboxId() in
            // app-sandbox.js: sandbox_<appId>_<unique>. The previous version
            // mangled dots to underscores here — pointless (the server's
            // registry regex accepts dots) and, worse, it made this session
            // key fail the server's appId ownership binding for the stable
            // per-app serving alias, which compares the key prefix against
            // the literal app id.
            const sandboxId = 'sandbox_' + appId + '_' + Date.now();
            // Stable per-app serving alias eligibility (server/core/index.js
            // also publishes these files under sandbox_<appId> with no unique
            // suffix so bundled files keep a URL that survives relaunches —
            // pre-registered OAuth/redirect callback URLs need that). Only
            // platform-shaped app ids qualify; anything else degrades to
            // session-only serving, exactly as before the alias existed.
            const stableAppId = (typeof appId === 'string' && appId.length <= 128
              && /^(?:webapp_[a-z0-9._-]{1,112}|[a-z][a-z0-9]*(?:\.[a-z0-9]+)+)$/.test(appId)) ? appId : null;

            // ── Attempt sandboxed serve via API ──
            let serveFailed = false;
            try {
              const shimmedFiles = Object.assign({}, appData.files);
              let serveHtml = html;
              const relaxed = buildSandboxCSP(appData);
              const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};' + buildNovaOSCompatShim() + 'var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
              if (!/<head[\s>]/i.test(serveHtml)) {
                serveHtml = inline + '\n' + relaxed + '\n' + serveHtml;
              } else {
                serveHtml = serveHtml.replace(/<head(\s[^>]*)?>/i, function(m){return m+"\n"+relaxed+inline});
              }
              console.log('[AppManager] shim injected, len now:', serveHtml.length, 'has shim marker:', serveHtml.includes('__novaPrivateStore'));
              shimmedFiles[entryKey] = btoa(
                encodeURIComponent(serveHtml).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
              );

              const regRes = await fetch('/api/apps/serve/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sandboxId, files: shimmedFiles, appId: stableAppId || undefined })
              });

              if (regRes.ok) {
                const regData = await regRes.json();
                console.log('[AppManager] serve registered, baseUrl:', regData.baseUrl);
                // IMPORTANT: partition must be set on the <webview> BEFORE src.
                // Chromium's guest_view (shared by both Electron and NW.js
                // webviews) provisions the guest process's storage partition
                // at first-navigation time. If src is present when the
                // element is created/attached and partition is applied a
                // moment later in the same attribute pass, the guest can
                // already be resolving navigation against the default
                // ephemeral/unpartitioned session — so the attribute exists
                // in the DOM (looks correct on inspection) but never
                // actually took effect, and storage keeps resetting every
                // launch despite this code looking right. Setting partition
                // first, then src as a separate step, avoids that race.
                const webview = createEl('webview', {
                  // "persist:" + a stable per-app key reuses the same
                  // on-disk partition every launch, so app-local storage
                  // (localStorage/IndexedDB/__novaPrivateStore) actually
                  // persists like a real installed app. Keyed by appId
                  // (not sandboxId, which is intentionally unique per
                  // launch via Date.now() and would defeat this entirely)
                  // so every launch of the same app lands in the same
                  // partition.
                  partition: 'persist:app_' + appId,
                  style: 'width:100%;height:100%;border:none;display:block;'
                });

                if (!legacyHostTier) {
                  webview.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
                }
                if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
                  FrameSecurity.securifyFrame(webview);
                }

                contentEl.style.padding = '0';
                contentEl.appendChild(webview);
                // src set AFTER DOM attachment — matches browser.js's
                // getOrCreateWebview/navigate pattern (the one place in
                // this codebase where webview partitioning is confirmed to
                // actually persist). NW.js's <webview> custom element only
                // seems to fully back its guest process once connected to
                // the document; setting src pre-append can start
                // navigation against an unpartitioned session even with
                // partition already present as an attribute.
                webview.src = window.location.origin + regData.baseUrl + '/' + entryKey;

                webview.addEventListener('load', () => {
                  if (pkgData) {
                    try {
                      // SECURITY: Use specific origin instead of '*' for postMessage
                      const origin = new URL(webview.src).origin;
                      webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                    } catch (_e) { /* cross-origin — expected */ }
                  }
                }, { once: true, signal: ac.signal });

                return;
              }
              serveFailed = true;
            } catch (_regErr) {
              serveFailed = true;
            }

            // ── Fallback: inline HTML with blob URL ──
            console.log('[AppManager] serve failed, falling back to blob URL');
            let wrappedHtml = html
              .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
              .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '');

            for (const [relPath, raw] of Object.entries(appData.files)) {
              if (relPath === entryKey || !raw || typeof raw !== 'string') continue;
              const lower = relPath.toLowerCase();
              let tag = null;
              if (lower.endsWith('.css')) {
                tag = '<style data-ninline>\n' + raw + '\n</style>';
              } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
                tag = '<script data-ninline>\n' + raw + '\n<\/script>';
              }
              if (!tag) continue;
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + tag);
            }

            const relaxed = buildSandboxCSP(appData);
            const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};' + buildNovaOSCompatShim() + 'var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
            if (!/<head[\s>]/i.test(wrappedHtml)) {
              wrappedHtml = inline + '\n' + relaxed + '\n' + wrappedHtml;
            } else {
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + inline);
            }
            wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + bridgeScriptTag);

            const blob = new Blob([wrappedHtml], { type: 'text/html' });
            blobUrl = URL.createObjectURL(blob);
            // partition must be set before src — see the register-success
            // branch above for why (guest storage session is provisioned
            // at first navigation, not on later attribute updates).
            const webview = createEl('webview', {
              // Same persistent partition as the primary path for
              // consistency, but be aware this fallback likely still won't
              // actually persist storage: blob: URLs get a fresh unique
              // origin every single createObjectURL() call, and localStorage
              // is partitioned by origin first — the webview partition
              // controls which disk-backed session cookies/storage live
              // in, but only helps if the origin asking for that storage
              // is itself stable across launches, which a blob: URL isn't.
              // This path only runs when /api/apps/serve/register fails,
              // so it's a degraded fallback, not the persistence fix —
              // if apps are landing here regularly, that failure itself
              // is the bug to chase next.
              partition: 'persist:app_' + appId,
              style: 'width:100%;height:100%;border:none;display:block;'
            });

            if (!legacyHostTier) {
              webview.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
            }
            if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
              FrameSecurity.securifyFrame(webview);
            }

            contentEl.style.padding = '0';
            contentEl.appendChild(webview);
            // src set after DOM attachment — see primary path above.
            webview.src = blobUrl;

            // ── Revoke blob URL after load to free memory ──
            webview.addEventListener('load', () => {
              if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
              if (pkgData) {
                try {
                  const origin = new URL(webview.src).origin;
                  webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                } catch (_e) { /* cross-origin */ }
              }
            }, { once: true, signal: ac.signal });

          } catch (e) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ' + escapeHtml(e.message) + '</div>';
          }
        }
      };
    }

    // Exposed so boot.js can reuse the exact same launch logic when
    // re-registering previously-installed apps at boot time, instead of a
    // separate incomplete implementation that never carried files/entry
    // through. See the header comment above for the full story.
    window.buildNovaAppConfig = buildNovaAppConfig;
})();
