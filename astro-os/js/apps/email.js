registerApp({
        id: 'nbosp-email', name: 'Email', icon: 'mail',
        description: 'IMAP · POP3 · Exchange',
        defaultSize: [860, 580], minSize: [600, 420],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.email', 'files')) {
            const guardStyle = document.createElement('style');
            guardStyle.setAttribute('nonce', window.__cspNonce || '');
            guardStyle.textContent = `.em-guard{display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);}.em-guard>div:first-child{font-size:32px;}.em-guard>div:last-child{font-size:14px;text-align:center;}`;
            document.head.appendChild(guardStyle);
            content.className = 'em-guard';
            // Use DOM methods instead of innerHTML to avoid any parser overhead
            const iconDiv = document.createElement('div');
            iconDiv.textContent = '⚠️';
            const msgDiv = document.createElement('div');
            const b = document.createElement('b');
            b.textContent = 'com.nbosp.email';
            const br1 = document.createElement('br');
            const br2 = document.createElement('br');
            msgDiv.append(b, br1, document.createTextNode('App data directory missing.'), br2, document.createTextNode('This app requires NovaByte OS.'));
            content.append(iconDiv, msgDiv);
            return;
          }

          // ── CSS
          const _style = document.createElement('style');
          _style.setAttribute('nonce', window.__cspNonce || '');
          _style.textContent = `
      .em-root{display:flex;flex-direction:column;height:100%;overflow:hidden;font-size:13px;}
      .em-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--bg-elevated);flex-shrink:0;}
      .em-tb-btn{background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:5px 8px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap;transition:background .12s,color .12s;}
      .em-tb-btn:hover{background:var(--bg-elevated-2,rgba(255,255,255,.06));color:var(--text-primary);}
      .em-tb-btn.em-primary{background:var(--accent);color:#fff;}
      .em-tb-btn.em-primary:hover{opacity:.88;}
      .em-tb-sep{flex:1;}
      .em-main{display:flex;flex:1;overflow:hidden;}
      /* Sidebar */
      .em-sidebar{width:196px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--bg-elevated);transition:width .18s;}
      .em-sidebar.hidden{width:0;overflow:hidden;}
      .em-sb-section{font-size:10px;font-weight:700;color:var(--text-secondary);letter-spacing:.07em;padding:12px 12px 3px;text-transform:uppercase;}
      .em-sb-row{display:flex;align-items:center;gap:7px;padding:7px 14px;font-size:13px;cursor:pointer;color:var(--text-secondary);white-space:nowrap;transition:background .1s;}
      .em-sb-row:hover{background:rgba(255,255,255,.05);}
      .em-sb-row.active{background:rgba(99,102,241,.15);color:var(--accent);}
      .em-sb-badge{margin-left:auto;background:var(--accent);color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700;}
      /* List column */
      .em-list-col{width:280px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
      .em-list-tb{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-search{flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:5px 9px;color:var(--text-primary);font-size:12px;outline:none;}
      .em-search:focus{border-color:var(--accent);}
      .em-batch-bar{display:none;align-items:center;gap:6px;padding:5px 10px;background:rgba(99,102,241,.1);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-primary);flex-shrink:0;}
      .em-msg-list{flex:1;overflow-y:auto;}
      .em-msg-row{display:flex;align-items:flex-start;gap:7px;padding:9px 10px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s,transform .18s;position:relative;}
      .em-msg-row:hover{background:var(--bg-elevated);}
      .em-msg-row.active{background:rgba(99,102,241,.13);}
      .em-msg-row.unread .em-msg-from{font-weight:700;color:var(--text-primary);}
      .em-msg-row.unread .em-msg-subj{font-weight:600;color:var(--text-secondary);}
      .em-msg-check{width:14px;height:14px;flex-shrink:0;accent-color:var(--accent);cursor:pointer;margin-top:3px;}
      .em-avatar{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;}
      .em-msg-meta{flex:1;min-width:0;}
      .em-msg-from{font-size:12px;font-weight:500;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .em-msg-subj{font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
      .em-msg-acct{font-size:10px;color:var(--text-secondary);opacity:.7;margin-top:1px;}
      .em-msg-date{font-size:10px;color:var(--text-secondary);flex-shrink:0;margin-top:2px;}
      .em-pagination{display:none;align-items:center;justify-content:center;gap:8px;padding:7px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);flex-shrink:0;}
      /* Reader */
      .em-reader{flex:1;display:flex;flex-direction:column;overflow:hidden;}
      .em-reader-hdr{padding:14px 18px 10px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-reader-subj{font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:7px;line-height:1.3;}
      .em-reader-meta{font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:2px;}
      .em-reader-actions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap;}
      .em-reader-body{flex:1;overflow:hidden;}
      .em-reader-body iframe{width:100%;height:100%;border:none;background:#fff;}
      .em-text-body{padding:14px 18px;font-size:13px;line-height:1.65;color:var(--text-primary);white-space:pre-wrap;overflow-y:auto;height:100%;box-sizing:border-box;}
      .em-attachments{padding:8px 18px;border-top:1px solid var(--border);display:flex;gap:7px;flex-wrap:wrap;flex-shrink:0;}
      .em-attach-chip{display:flex;align-items:center;gap:5px;padding:4px 9px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary);}
      /* Empty / spinner */
      .em-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--text-secondary);gap:8px;font-size:13px;height:100%;}
      @keyframes em-spin{to{transform:rotate(360deg);}}
      .em-spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:em-spin .6s linear infinite;}
      /* Buttons */
      .em-btn{background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-secondary);padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;transition:background .1s;}
      .em-btn:hover{background:var(--bg-elevated-2,rgba(255,255,255,.08));color:var(--text-primary);}
      .em-btn:disabled{opacity:.4;cursor:default;}
      .em-btn.danger{color:#e55;border-color:rgba(229,85,85,.4);}
      .em-btn.danger:hover{background:rgba(229,85,85,.1);}
      /* Setup */
      .em-setup{flex:1;padding:24px;overflow-y:auto;}
      .em-setup-card{width:100%;max-width:430px;margin:0 auto;display:flex;flex-direction:column;gap:10px;}
      .em-setup-title{font-size:17px;font-weight:700;color:var(--text-primary);margin-bottom:4px;}
      .em-lbl{font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px;}
      .em-input{background:var(--bg-elevated);border:1px solid var(--border);border-radius:7px;padding:8px 11px;color:var(--text-primary);font-size:13px;outline:none;width:100%;box-sizing:border-box;transition:border-color .12s;}
      .em-input:focus{border-color:var(--accent);}
      .em-proto-row{display:flex;gap:6px;}
      .em-proto-btn{flex:1;padding:7px 0;border:1px solid var(--border);border-radius:7px;background:var(--bg-elevated);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;}
      .em-proto-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);}
      .em-row2{display:flex;gap:8px;}
      .em-row2>*{flex:1;}
      /* Compose */
      .em-compose-overlay{position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:flex-end;justify-content:flex-end;}
      .em-compose-win{width:460px;max-width:100%;background:var(--bg-elevated);border-radius:12px 12px 0 0;border:1px solid var(--border);border-bottom:none;display:flex;flex-direction:column;max-height:88%;overflow:hidden;}
      .em-compose-hdr{display:flex;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;color:var(--text-primary);flex-shrink:0;}
      .em-cfield{display:flex;align-items:center;gap:8px;padding:6px 13px;border-bottom:1px solid var(--border);}
      .em-cfield-lbl{font-size:11px;color:var(--text-secondary);width:32px;flex-shrink:0;}
      .em-cinput{flex:1;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;}
      .em-cbody{flex:1;padding:10px 13px;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;resize:none;font-family:inherit;min-height:110px;}
      .em-compose-foot{display:flex;align-items:center;gap:7px;padding:8px 11px;border-top:1px solid var(--border);flex-shrink:0;}
    `;
          content.appendChild(_style);

          // ── Constants
          const SK = 'nbosp_email_accts_v2';
          const SK_DRAFT = 'nbosp_email_drafts_v1';
          const COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#3b82f6'];
          const FICONS = { inbox: '📥', sent: '📤', drafts: '📝', trash: '🗑️', spam: '⚠️', junk: '⚠️', archive: '📦', starred: '⭐', all: '📬' };

          // ── Hoisted utilities — defined once, referenced throughout
          // FIX: was recreated on every setInterval tick for every account.
          function decodeEntities(str) {
            if (!str) return str;
            return str
              .replace(/&#x27;/gi, "'").replace(/&#39;/gi, "'")
              .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
              .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
              .replace(/&amp;/gi, '&');
          }

          // FIX: was called on line 812 but never defined anywhere in the file.
          function parseMailto(url) {
            try {
              const u = new URL(url);
              if (u.protocol !== 'mailto:') return {};
              const params = u.searchParams;
              return {
                to: decodeURIComponent(u.pathname),
                subject: params.get('subject') || '',
                body: params.get('body') || '',
                cc: params.get('cc') || '',
                bcc: params.get('bcc') || '',
              };
            } catch {
              return {};
            }
          }

          // ── State
          let accounts = [];
          let activeAcctId = 'all';
          let activeFolder = 'INBOX';
          let messages = [];
          let page = 1, pages = 1;
          let activeMsgUid = null;
          let loading = false;
          let searchQ = '';
          // FIX: selectedUids and unreadMap are never reassigned — const is correct.
          const selectedUids = new Set();
          let syncTimers = {};
          const unreadMap = {};   // "acctId|folder" → count
          const emailBg = window.__NBOSP_BG?.email || null;

          // ── Instance cleanup
          // FIX: closing and reopening the app called init() again, creating a new closure
          // while the old syncTimers kept firing and OS.openMailto pointed at the stale
          // closure's openCompose. This tears down the previous instance before setting up
          // the new one.
          window.__nbospEmailCleanup?.();
          const _prevOpenMailto = OS.openMailto;
          window.__nbospEmailCleanup = () => {
            Object.values(syncTimers).forEach(clearInterval);
            syncTimers = {};
            if (typeof _prevOpenMailto === 'function') OS.openMailto = _prevOpenMailto;
          };

          // ── Storage
          // Passwords are kept only in memory (credCache) and in the server-side
          // session via /connect. localStorage holds everything EXCEPT pass so that
          // credentials are never written to disk in plaintext.
          const credCache = {};  // acctId → { user, pass }

          const loadAccts = () => {
            try {
              return JSON.parse(localStorage.getItem(SK) || '[]');
            } catch { return []; }
          };
          const saveAccts = () => {
            try {
              // Strip pass before persisting; credCache holds it in-memory.
              const safe = accounts.map(({ pass: _omit, ...rest }) => rest);
              localStorage.setItem(SK, JSON.stringify(safe));
              if (emailBg?.setAccounts) emailBg.setAccounts(accounts);
            } catch { }
          };

          // ── CSRF token — read once at init rather than querying the DOM on every request.
          // FIX: api() was calling document.querySelector('meta[name="csrf-token"]') on every
          // non-GET request. The meta tag doesn't change, so one read and a local variable is
          // correct. Falls back to a server endpoint if the meta tag is absent.
          let _csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || window.__csrfToken || '';
          if (!_csrfToken) {
            fetch('/api/email/csrf-token', { credentials: 'include' })
              .then(r => r.ok ? r.json() : null)
              .then(d => { if (d?.csrfToken) { _csrfToken = d.csrfToken; window.__csrfToken = d.csrfToken; } })
              .catch(() => { });
          }

          // ── API helper
          async function api(method, path, body, params) {
            let url = '/api/email' + path;
            if (params) { const qs = new URLSearchParams(params).toString(); if (qs) url += '?' + qs; }
            const opts = { method, credentials: 'include', headers: {} };
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
              opts.headers['X-CSRF-Token'] = _csrfToken;
            }
            if (body && !(body instanceof FormData)) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
            else if (body instanceof FormData) opts.body = body;
            const r = await fetch(url, opts);
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || r.statusText);
            return d;
          }

          async function ensureConnected(acct) {
            // Use credCache if available (fresh login). If not (e.g. after page refresh),
            // skip re-connecting — the server session is already warm from /restore.
            const pass = credCache[acct.id]?.pass;
            if (pass) {
              await api('POST', '/connect', { type: acct.type, host: acct.host, port: acct.port, ssl: acct.ssl, user: acct.user, pass });
            }
            // If no pass in credCache, trust that /restore already re-established the session.
            // If the session has actually expired, the subsequent API call will 401 and
            // the error will surface naturally to the user.
          }

          function getActiveAcct() {
            if (activeAcctId === 'all') return accounts[0] || null;
            return accounts.find(a => a.id === activeAcctId) || null;
          }

          // FIX: original used plain multiplication `h * 31` before the `& 0xffffffff` mask.
          // JS numbers are 64-bit floats, so large values of h lose integer precision before
          // the bitwise mask is applied, producing a biased colour distribution. Math.imul
          // performs correct 32-bit integer multiplication without floating-point rounding.
          function avatarColor(s) {
            let h = 0;
            for (let i = 0; i < (s || '').length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
            return COLORS[Math.abs(h) % COLORS.length];
          }

          function fmtDate(iso) {
            if (!iso) return '';
            const d = new Date(iso), now = new Date();
            if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (now - d < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          }

          // ── Root
          const root = createEl('div', { className: 'em-root' });
          content.appendChild(root);

          // ────────────────────────────────────────────────────────────────────────
          // TOOLBAR
          // ────────────────────────────────────────────────────────────────────────
          const toolbar = createEl('div', { className: 'em-toolbar' });
          const menuBtn = createEl('button', { className: 'em-tb-btn', title: 'Toggle sidebar', innerHTML: '&#9776;' });
          const acctLabel = createEl('span', { style: 'font-size:13px;font-weight:600;color:var(--text-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
          const tbSep = createEl('div', { className: 'em-tb-sep' });
           const refreshBtn = createEl('button', { className: 'em-tb-btn', title: 'Refresh', innerHTML: svgIcon('refresh', 14) });
           const composeBtn = createEl('button', { className: 'em-tb-btn em-primary', innerHTML: '&#9998; Compose' });
          toolbar.append(menuBtn, acctLabel, tbSep, refreshBtn, composeBtn);
          root.appendChild(toolbar);

          // ────────────────────────────────────────────────────────────────────────
          // MAIN
          // ────────────────────────────────────────────────────────────────────────
          const mainEl = createEl('div', { className: 'em-main' });
          root.appendChild(mainEl);

          // ── Sidebar
          const sidebar = createEl('div', { className: 'em-sidebar' });
          mainEl.appendChild(sidebar);
          let sidebarHidden = false;
          menuBtn.addEventListener('click', () => {
            sidebarHidden = !sidebarHidden;
            sidebar.classList.toggle('hidden', sidebarHidden);
          });

          // ── List column
          const listCol = createEl('div', { className: 'em-list-col' });
          mainEl.appendChild(listCol);

          const listTb = createEl('div', { className: 'em-list-tb' });
          const selectAllChk = createEl('input', { type: 'checkbox', title: 'Select all', style: 'accent-color:var(--accent);cursor:pointer;flex-shrink:0;' });
          const searchInp = createEl('input', { className: 'em-search', type: 'search', placeholder: 'Search…' });
          listTb.append(selectAllChk, searchInp);
          listCol.appendChild(listTb);

          const batchBar = createEl('div', { className: 'em-batch-bar' });
          const batchLbl = createEl('span', { style: 'flex:1' });
          const batchReadBtn = createEl('button', { className: 'em-btn', textContent: 'Mark read' });
          const batchTrashBtn = createEl('button', { className: 'em-btn danger', textContent: 'Delete' });
          batchBar.append(batchLbl, batchReadBtn, batchTrashBtn);
          listCol.appendChild(batchBar);

          const msgListEl = createEl('div', { className: 'em-msg-list' });
          listCol.appendChild(msgListEl);

          const paginationEl = createEl('div', { className: 'em-pagination' });
          const prevBtn = createEl('button', { className: 'em-btn', textContent: '‹ Prev' });
          const pageLbl = createEl('span');
          const nextBtn = createEl('button', { className: 'em-btn', textContent: 'Next ›' });
          paginationEl.append(prevBtn, pageLbl, nextBtn);
          listCol.appendChild(paginationEl);

          // ── Reader pane
          const readerEl = createEl('div', { className: 'em-reader' });
          mainEl.appendChild(readerEl);

          // ── Setup screen (overlays main)
          const setupScreen = createEl('div', { className: 'em-setup', style: 'display:none;' });
          root.appendChild(setupScreen);

          // ────────────────────────────────────────────────────────────────────────
          // SIDEBAR RENDER
          // ────────────────────────────────────────────────────────────────────────
          function buildSidebar() {
            sidebar.innerHTML = '';

            if (accounts.length > 1) {
              sidebar.appendChild(createEl('div', { className: 'em-sb-section', textContent: 'Accounts' }));
              const row = createEl('div', { className: 'em-sb-row' + (activeAcctId === 'all' ? ' active' : '') });
              row.textContent = '📬 Combined Inbox';
              row.addEventListener('click', () => { activeAcctId = 'all'; activeFolder = 'INBOX'; page = 1; searchQ = ''; searchInp.value = ''; buildSidebar(); loadMessages(); });
              sidebar.appendChild(row);
            }

            accounts.forEach(acct => {
              const hdr = createEl('div', { className: 'em-sb-section', style: `color:${acct.color};` });
              hdr.textContent = acct.name || acct.email;
              sidebar.appendChild(hdr);

              const stdFolders = acct.folders || [
                { path: 'INBOX', name: 'Inbox' }, { path: 'SENT', name: 'Sent' },
                { path: 'DRAFTS', name: 'Drafts' }, { path: 'TRASH', name: 'Trash' }, { path: 'SPAM', name: 'Spam' }
              ];
              stdFolders.forEach(f => {
                const icon = FICONS[(f.name || f.path).toLowerCase()] || '📁';
                const active = activeAcctId === acct.id && activeFolder === f.path;
                const row = createEl('div', { className: 'em-sb-row' + (active ? ' active' : '') });
                const nameSpan = createEl('span', { textContent: `${icon} ${f.name}`, style: 'flex:1' });
                row.appendChild(nameSpan);
                const key = acct.id + '|' + f.path;
                if (unreadMap[key]) row.appendChild(createEl('span', { className: 'em-sb-badge', textContent: unreadMap[key] }));
                row.addEventListener('click', () => { activeAcctId = acct.id; activeFolder = f.path; page = 1; searchQ = ''; searchInp.value = ''; buildSidebar(); loadMessages(); });
                sidebar.appendChild(row);
              });
            });

            const addRow = createEl('div', { className: 'em-sb-row', style: 'color:var(--accent);margin-top:6px;' });
            addRow.textContent = '＋ Add Account';
            addRow.addEventListener('click', () => buildSetup(null));
            sidebar.appendChild(addRow);

            if (accounts.length) {
              const settRow = createEl('div', { className: 'em-sb-row', style: 'color:var(--text-secondary);' });
              settRow.textContent = '⚙ Settings';
              settRow.addEventListener('click', () => {
                const acct = accounts.find(a => a.id === activeAcctId) || accounts[0];
                buildSetup(acct);
              });
              sidebar.appendChild(settRow);
            }

            acctLabel.textContent = activeAcctId === 'all'
              ? 'Combined Inbox'
              : (accounts.find(a => a.id === activeAcctId)?.name || 'Email');
          }

          // ────────────────────────────────────────────────────────────────────────
          // SETUP WIZARD
          // ────────────────────────────────────────────────────────────────────────
          function buildSetup(existing) {
            setupScreen.innerHTML = '';
            mainEl.style.display = 'none';
            setupScreen.style.display = '';

            const card = createEl('div', { className: 'em-setup-card' });
            card.appendChild(createEl('div', { className: 'em-setup-title', textContent: existing ? 'Edit Account' : 'Add Email Account' }));

            // Protocol
            card.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Protocol' }));
            const protoRow = createEl('div', { className: 'em-proto-row' });
            let proto = existing?.type || 'imap';
            ['imap', 'pop3', 'exchange'].forEach(p => {
              const b = createEl('button', { className: 'em-proto-btn' + (proto === p ? ' active' : ''), textContent: p === 'exchange' ? 'Exchange' : p.toUpperCase() });
              b.addEventListener('click', () => {
                proto = p;
                protoRow.querySelectorAll('.em-proto-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                const defs = { imap: ['993', ''], pop3: ['995', ''], exchange: ['443', ''] };
                portInp.value = defs[p][0];
                sslChk.checked = true;
              });
              protoRow.appendChild(b);
            });
            card.appendChild(protoRow);

            function fldRow(label, type, ph, val) {
              const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
              w.appendChild(createEl('div', { className: 'em-lbl', textContent: label }));
              const inp = createEl('input', { className: 'em-input', type, placeholder: ph, value: val || '' });
              w.appendChild(inp);
              return { w, inp };
            }

            const { w: nameW, inp: nameInp } = fldRow('Display Name', 'text', 'Work Email', existing?.name || '');
            const { w: hostW, inp: hostInp } = fldRow('Incoming Server (IMAP/POP3/EWS Host)', 'text', 'mail.example.com', existing?.host || '');
            const { w: userW, inp: userInp } = fldRow('Username / Email', 'email', 'user@example.com', existing?.user || '');
            const { w: passW, inp: passInp } = fldRow('Password', 'password', '••••••••', (existing && credCache[existing.id]?.pass) || '');

            const row2 = createEl('div', { className: 'em-row2' });
            const { w: portW, inp: portInp } = fldRow('Port', 'number', '993', existing?.port || '993');
            const sslW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
            sslW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'SSL/TLS' }));
            const sslR = createEl('div', { style: 'display:flex;align-items:center;gap:6px;padding-top:10px;' });
            const sslChk = createEl('input', { type: 'checkbox', style: 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer;', checked: existing?.ssl !== false });
            sslR.append(sslChk, createEl('span', { textContent: 'Enabled', style: 'font-size:12px;color:var(--text-secondary);' }));
            sslW.appendChild(sslR);
            row2.append(portW, sslW);

            // SMTP (for sending, IMAP/POP3 only)
            const smtpSection = createEl('div', { style: 'display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid var(--border);' });
            smtpSection.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Outgoing Mail (SMTP) — optional' }));
            const smtpRow = createEl('div', { className: 'em-row2' });
            const { w: smtpHostW, inp: smtpHostInp } = fldRow('SMTP Host', 'text', 'smtp.example.com', existing?.smtpHost || '');
            const { w: smtpPortW, inp: smtpPortInp } = fldRow('SMTP Port', 'number', '587', existing?.smtpPort || '587');
            smtpRow.append(smtpHostW, smtpPortW);
            smtpSection.appendChild(smtpRow);

            const { w: syncW, inp: syncInp } = fldRow('Check every (mins, 0 = manual)', 'number', '15', String(existing?.syncInterval ?? 15));
            const sigW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
            sigW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Signature' }));
            const sigTa = createEl('textarea', { className: 'em-input', id: 'email-signature-input', name: 'email-signature', placeholder: 'Sent from NBOSP Email', style: 'min-height:56px;resize:vertical;', value: existing?.signature || '' });
            sigW.appendChild(sigTa);

            const errEl = createEl('div', { style: 'color:#e55;font-size:12px;min-height:14px;' });
            const footRow = createEl('div', { style: 'display:flex;gap:8px;' });
            const cancelBtn = createEl('button', { className: 'em-btn', textContent: 'Cancel', style: 'flex-shrink:0;' });
            const saveBtn = createEl('button', {
              textContent: existing ? 'Save' : 'Add Account',
              style: 'flex:1;padding:9px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;'
            });

            if (existing) {
              const delBtn = createEl('button', { className: 'em-btn danger', textContent: 'Remove', style: 'flex-shrink:0;' });
              delBtn.addEventListener('click', async () => {
                delete credCache[existing.id];
                accounts = accounts.filter(a => a.id !== existing.id);
                saveAccts();
                // Clear session credentials for the removed account so the server
                // doesn't retain them in req.session.emailCreds after removal.
                api('POST', '/disconnect').catch(() => { });
                if (!accounts.length) { setupScreen.style.display = 'none'; mainEl.style.display = ''; showEmpty(); buildSetup(null); }
                else { activeAcctId = accounts[0].id; showMain(); }
              });
              footRow.appendChild(delBtn);
            }

            cancelBtn.addEventListener('click', () => {
              if (accounts.length) showMain();
              else { setupScreen.style.display = 'none'; mainEl.style.display = ''; }
            });

            saveBtn.addEventListener('click', async () => {
              const host = hostInp.value.trim(), user = userInp.value.trim(), pass = passInp.value;
              if (!host || !user || !pass) { errEl.textContent = 'Host, username and password are required.'; return; }
              errEl.textContent = '';
              saveBtn.textContent = 'Connecting…'; saveBtn.disabled = true;
              try {
                await api('POST', '/connect', { type: proto, host, port: portInp.value, ssl: sslChk.checked, user, pass });
                const acctId = existing?.id || Date.now().toString(36);
                // Store pass only in credCache (in-memory), never on the acct object.
                credCache[acctId] = { user, pass };
                const acct = {
                  id: acctId,
                  name: nameInp.value.trim() || user,
                  email: user, type: proto, host,
                  port: portInp.value,
                  ssl: sslChk.checked, user,
                  smtpHost: smtpHostInp.value.trim(),
                  smtpPort: smtpPortInp.value,
                  signature: sigTa.value.trim(),
                  // FIX: parseInt without radix — explicitly pass base 10.
                  syncInterval: parseInt(syncInp.value, 10) || 0,
                  color: existing?.color || COLORS[accounts.length % COLORS.length],
                  folders: null
                };
                if (existing) accounts = accounts.map(a => a.id === acct.id ? acct : a);
                else accounts.push(acct);
                saveAccts();
                // Fetch real folder list
                try {
                  const fd = await api('GET', '/folders');
                  acct.folders = fd.folders;
                  saveAccts();
                } catch { }
                activeAcctId = acct.id; activeFolder = 'INBOX';
                showMain(); scheduleSyncAll();
                Notify.show({ title: 'Email', body: `"${acct.name}" connected.`, type: 'success', appName: 'Email' });
              } catch (e) {
                errEl.textContent = e.message;
              } finally {
                saveBtn.textContent = existing ? 'Save' : 'Add Account'; saveBtn.disabled = false;
              }
            });

            footRow.append(cancelBtn, saveBtn);
            card.append(nameW, hostW, userW, passW, row2, smtpSection, syncW, sigW, errEl, footRow);
            setupScreen.appendChild(card);
          }

          // ────────────────────────────────────────────────────────────────────────
          // LOAD MESSAGES
          // ────────────────────────────────────────────────────────────────────────
          async function loadMessages() {
            if (!AppPermissionManager?.isGranted('mail:read', 'nbosp-email')) {
              Notify.show({ title: 'Permission denied', body: 'Email needs mail:read permission.', type: 'error', appName: 'Email' });
              messages = []; renderMsgList(); return;
            }
            if (!accounts.length) return;
            loading = true; messages = [];
            renderMsgList();
            try {
              if (activeAcctId === 'all') {
                const results = await Promise.allSettled(accounts.map(async acct => {
                  await ensureConnected(acct);
                  const d = await api('GET', '/messages', null, { folder: 'INBOX', page: 1, limit: 20 });
                  return (d.messages || []).map(m => ({ ...m, _acctId: acct.id, _acctName: acct.name || acct.email }));
                }));
                const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
                all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
                messages = all.slice(0, 60); pages = 1;
              } else {
                const acct = getActiveAcct();
                if (!acct) return;
                await ensureConnected(acct);
                const params = { folder: activeFolder, page, limit: 20 };
                if (searchQ) params.q = searchQ;
                const d = await api('GET', searchQ ? '/search' : '/messages', null, params);
                messages = d.messages || []; pages = d.pages || 1;
                unreadMap[acct.id + '|' + activeFolder] = messages.filter(m => !m.seen).length;
                // Fetch folders once if missing
                if (!acct.folders) {
                  api('GET', '/folders').then(fd => { acct.folders = fd.folders; saveAccts(); buildSidebar(); }).catch(() => { });
                }
                buildSidebar();
              }
            } catch (e) {
              messages = [];
              Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' });
            } finally {
              loading = false; renderMsgList();
            }
          }

          // ────────────────────────────────────────────────────────────────────────
          // RENDER MESSAGE LIST
          // ────────────────────────────────────────────────────────────────────────
          function renderMsgList() {
            msgListEl.innerHTML = '';
            selectedUids.clear();
            selectAllChk.checked = false;
            batchBar.style.display = 'none';

            if (loading) {
              const w = createEl('div', { style: 'display:flex;align-items:center;justify-content:center;padding:36px;' });
              w.appendChild(createEl('div', { className: 'em-spinner' }));
              msgListEl.appendChild(w); return;
            }
            if (!messages.length) {
              const w = createEl('div', { className: 'em-empty' });
              w.appendChild(document.createTextNode('📭'));
              w.appendChild(document.createElement('br'));
              w.appendChild(createEl('span', { textContent: searchQ ? 'No results' : 'No messages' }));
              msgListEl.appendChild(w);
              paginationEl.style.display = 'none'; return;
            }

            messages.forEach(msg => {
              const row = createEl('div', { className: 'em-msg-row' + (!msg.seen ? ' unread' : '') + (msg.uid === activeMsgUid ? ' active' : '') });
              row.dataset.uid = String(msg.uid);

              const cb = createEl('input', { type: 'checkbox', className: 'em-msg-check' });
              cb.addEventListener('change', e => {
                e.stopPropagation();
                if (cb.checked) selectedUids.add(msg.uid); else selectedUids.delete(msg.uid);
                updateBatchBar();
              });

              const av = createEl('div', { className: 'em-avatar', textContent: (msg.from || '?')[0].toUpperCase(), style: `background:${avatarColor(msg.from || '')};` });

              const meta = createEl('div', { className: 'em-msg-meta' });
              meta.appendChild(createEl('div', { className: 'em-msg-from', textContent: msg.from || '(unknown)' }));
              meta.appendChild(createEl('div', { className: 'em-msg-subj', textContent: msg.subject || '(no subject)' }));
              if (msg._acctName) meta.appendChild(createEl('div', { className: 'em-msg-acct', textContent: msg._acctName }));

              const date = createEl('div', { className: 'em-msg-date', textContent: fmtDate(msg.date) });
              row.append(cb, av, meta, date);

              // Swipe gestures
              let tx0 = 0;
              row.addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; }, { passive: true });
              row.addEventListener('touchend', e => {
                const dx = e.changedTouches[0].clientX - tx0;
                if (dx < -70) doDeleteMsg(msg, row);
                else if (dx > 70) doArchiveMsg(msg, row);
              }, { passive: true });

              row.addEventListener('click', () => openMsg(msg));
              msgListEl.appendChild(row);
            });

            paginationEl.style.display = pages > 1 ? 'flex' : 'none';
            if (pages > 1) { pageLbl.textContent = `${page} / ${pages}`; prevBtn.disabled = page <= 1; nextBtn.disabled = page >= pages; }
          }

          function updateBatchBar() {
            const n = selectedUids.size;
            batchBar.style.display = n ? 'flex' : 'none';
            if (n) { batchLbl.textContent = `${n} selected`; selectAllChk.checked = n === messages.length; }
            else selectAllChk.checked = false;
          }

          selectAllChk.addEventListener('change', () => {
            if (selectAllChk.checked) messages.forEach(m => selectedUids.add(m.uid));
            else selectedUids.clear();
            updateBatchBar();
            msgListEl.querySelectorAll('.em-msg-check').forEach(cb => { cb.checked = selectAllChk.checked; });
          });

          batchTrashBtn.addEventListener('click', async () => {
            if (!selectedUids.size) return;
            const uids = [...selectedUids];
            const acct = getActiveAcct(); if (!acct) return;
            try { await ensureConnected(acct); await api('POST', '/batch', { op: 'delete', uids, folder: activeFolder }); messages = messages.filter(m => !selectedUids.has(m.uid)); selectedUids.clear(); renderMsgList(); Notify.show({ title: 'Email', body: `${uids.length} deleted.`, type: 'info', appName: 'Email' }); }
            catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          });

          batchReadBtn.addEventListener('click', async () => {
            if (!selectedUids.size) return;
            const uids = [...selectedUids];
            const acct = getActiveAcct(); if (!acct) return;
            try { await ensureConnected(acct); await api('POST', '/batch', { op: 'read', uids, folder: activeFolder }); messages = messages.map(m => selectedUids.has(m.uid) ? { ...m, seen: true } : m); selectedUids.clear(); renderMsgList(); }
            catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          });

          // ────────────────────────────────────────────────────────────────────────
          // MESSAGE READER
          // ────────────────────────────────────────────────────────────────────────
          function showEmpty() {
            readerEl.innerHTML = '';
            const w = createEl('div', { className: 'em-empty' });
            w.innerHTML = '&#9993;<br><span>Select a message to read</span>';
            readerEl.appendChild(w);
          }

          async function openMsg(msg) {
            activeMsgUid = msg.uid;
            msgListEl.querySelectorAll('.em-msg-row').forEach(r => r.classList.toggle('active', r.dataset.uid === String(msg.uid)));
            readerEl.innerHTML = '';
            const sp = createEl('div', { className: 'em-empty' });
            sp.appendChild(createEl('div', { className: 'em-spinner' }));
            readerEl.appendChild(sp);

            try {
              const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
              if (!acct) throw new Error('Account not found');
              await ensureConnected(acct);
              const full = await api('GET', '/message', null, { folder: activeFolder, uid: msg.uid });
              msg.seen = true;
              // FIX: msg.uid used raw in querySelector attribute selector. CSS.escape prevents
              // a malformed UID from breaking the selector or enabling selector injection.
              msgListEl.querySelector(`.em-msg-row[data-uid="${CSS.escape(String(msg.uid))}"]`)?.classList.remove('unread');
              renderReader(full, msg, acct);
            } catch (e) {
              readerEl.innerHTML = '';
              const w = createEl('div', { className: 'em-empty', style: 'color:#e55;' });
              w.textContent = e.message; readerEl.appendChild(w);
            }
          }

          async function renderReader(full, msg, acct) {
            readerEl.innerHTML = '';

            const hdr = createEl('div', { className: 'em-reader-hdr' });
            hdr.appendChild(createEl('div', { className: 'em-reader-subj', textContent: full.subject || '(no subject)' }));
            const meta = createEl('div', { className: 'em-reader-meta' });
            if (full.from) meta.appendChild(createEl('span', { textContent: 'From: ' + full.from }));
            if (full.to) meta.appendChild(createEl('span', { textContent: 'To: ' + full.to }));
            if (full.cc) meta.appendChild(createEl('span', { textContent: 'CC: ' + full.cc }));
            if (full.date) meta.appendChild(createEl('span', { textContent: new Date(full.date).toLocaleString() }));
            hdr.appendChild(meta);

            const acts = createEl('div', { className: 'em-reader-actions' });
            const replyBtn = createEl('button', { className: 'em-btn' });
            replyBtn.innerHTML = svgIcon('corner-up-left', 13) + ' Reply';
            const fwdBtn = createEl('button', { className: 'em-btn' });
            fwdBtn.innerHTML = svgIcon('corner-up-right', 13) + ' Forward';
            const delBtn = createEl('button', { className: 'em-btn danger' });
            delBtn.innerHTML = svgIcon('x', 13) + ' Delete';
            acts.append(replyBtn, fwdBtn, delBtn);
            hdr.appendChild(acts);
            readerEl.appendChild(hdr);

            replyBtn.addEventListener('click', () => openCompose({
              to: full.from, subject: 'Re: ' + (full.subject || ''),
              body: '\n\n----\nOn ' + new Date(full.date).toLocaleString() + ', ' + full.from + ' wrote:\n' + (full.text || '')
            }, acct));
            fwdBtn.addEventListener('click', () => openCompose({
              subject: 'Fwd: ' + (full.subject || ''),
              body: '\n\n----\nFrom: ' + full.from + '\nDate: ' + new Date(full.date).toLocaleString() + '\nSubject: ' + full.subject + '\n\n' + (full.text || '')
            }, acct));
            // FIX: same CSS.escape fix applied here for the delete button's querySelector.
            delBtn.addEventListener('click', () => doDeleteMsg(msg, msgListEl.querySelector(`.em-msg-row[data-uid="${CSS.escape(String(msg.uid))}"]`)));

            // Body
            const bodyEl = createEl('div', { className: 'em-reader-body' });
            if (full.html) {
              // The server sanitises full.html in GET /message before returning it
              // (rewriteEmailImages + rewriteEmailLinks + sanitizeEmailHtml).
              // Set srcdoc directly — no token round-trip, no NW.js iframe-src issues.
              const iframe = createEl('iframe', {
                sandbox: 'allow-popups allow-popups-to-escape-sandbox',
                title: 'Email body', referrerpolicy: 'no-referrer'
              });
              const html = full.html;
              // FIX: DOMPurify.addHook was called without a matching removeHook in a
              // try/finally, so if sanitize() threw, the hook stayed permanently attached
              // to DOMPurify's global hook registry for the lifetime of the page.
              const sanitized = (() => {
                if (typeof DOMPurify === 'undefined') return html;
                DOMPurify.addHook('afterSanitizeAttributes', node => {
                  if (node.tagName === 'A') {
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                  }
                });
                try {
                  return DOMPurify.sanitize(html);
                } finally {
                  DOMPurify.removeHook('afterSanitizeAttributes');
                }
              })();
              const hasDoc = /^<!doctype/i.test(html.trimStart()) || /^<html[\s>]/i.test(html.trimStart());
              iframe.srcdoc = hasDoc ? sanitized
                : '<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:0;word-wrap:break-word}</style></head><body>' + sanitized + '</body></html>';
              bodyEl.appendChild(iframe);
              readerEl.appendChild(bodyEl);
            } else {
              const pre = createEl('div', { className: 'em-text-body', textContent: full.text || '(empty message)' });
              bodyEl.appendChild(pre);
              readerEl.appendChild(bodyEl);
            }

            // Attachments
            if (full.attachments?.length) {
              const row = createEl('div', { className: 'em-attachments' });
              full.attachments.forEach(a => {
                const chip = createEl('div', { className: 'em-attach-chip' });
                chip.appendChild(document.createTextNode('\uD83D\uDCC4 ' + (a.filename || 'attachment')));
                if (a.size) {
                  const sz = createEl('span', { textContent: ' ' + Math.round(a.size / 1024) + 'KB' });
                  sz.style.opacity = '0.6';
                  chip.appendChild(sz);
                }
                row.appendChild(chip);
              });
              readerEl.appendChild(row);
            }
          }

          // ────────────────────────────────────────────────────────────────────────
          // DELETE / ARCHIVE
          // ────────────────────────────────────────────────────────────────────────
          async function doDeleteMsg(msg, rowEl) {
              if (!AppPermissionManager?.isGranted('mail:delete', 'nbosp-email')) {
                Notify.show({ title: 'Permission denied', body: 'Email needs mail:delete to remove messages.', type: 'error', appName: 'Email' });
                return;
              }
              try {
                const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
                if (!acct) return;
              await ensureConnected(acct);
              await api('POST', '/batch', { op: 'delete', uids: [msg.uid], folder: activeFolder });
              if (rowEl) { rowEl.style.transition = 'opacity .18s,transform .18s'; rowEl.style.opacity = '0'; rowEl.style.transform = 'translateX(40px)'; setTimeout(() => rowEl.remove(), 200); }
              messages = messages.filter(m => m.uid !== msg.uid);
              if (activeMsgUid === msg.uid) { activeMsgUid = null; showEmpty(); }
              Notify.show({ title: 'Email', body: 'Deleted.', type: 'info', appName: 'Email' });
            } catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          }

          async function doArchiveMsg(msg, rowEl) {
              if (!AppPermissionManager?.isGranted('mail:delete', 'nbosp-email')) {
                Notify.show({ title: 'Permission denied', body: 'Email needs mail:delete to archive messages.', type: 'error', appName: 'Email' });
                return;
              }
              try {
                const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
                if (!acct) return;
              await ensureConnected(acct);
              await api('POST', '/batch', { op: 'move', uids: [msg.uid], folder: activeFolder, dest: 'Archive' });
              if (rowEl) { rowEl.style.transition = 'opacity .18s,transform .18s'; rowEl.style.opacity = '0'; rowEl.style.transform = 'translateX(-40px)'; setTimeout(() => rowEl.remove(), 200); }
              messages = messages.filter(m => m.uid !== msg.uid);
              Notify.show({ title: 'Email', body: 'Archived.', type: 'info', appName: 'Email' });
            } catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          }

          // ────────────────────────────────────────────────────────────────────────
          // COMPOSE
          // ────────────────────────────────────────────────────────────────────────
          function openCompose(prefill = {}, fromAcct = null) {
            if (!AppPermissionManager?.isGranted('mail:write', 'nbosp-email')) {
              Notify.show({ title: 'Permission denied', body: 'Email needs mail:write to compose.', type: 'error', appName: 'Email' });
              return;
            }
            root.querySelector('.em-compose-overlay')?.remove();
            const overlay = createEl('div', { className: 'em-compose-overlay' });
            const win = createEl('div', { className: 'em-compose-win' });

            const hdr = createEl('div', { className: 'em-compose-hdr' });
            hdr.appendChild(createEl('span', { textContent: 'New Message', style: 'flex:1' }));
            const minBtn = createEl('button', { className: 'em-tb-btn', textContent: '−', title: 'Minimize' });
            const closeXB = createEl('button', { className: 'em-tb-btn', textContent: '✕', title: 'Close' });
            hdr.append(minBtn, closeXB);

            let minimized = false;
            minBtn.addEventListener('click', () => {
              minimized = !minimized;
              win.style.maxHeight = minimized ? '44px' : '88%';
            });
            closeXB.addEventListener('click', () => {
              const body = bodyTa.value.trim();
              if (body || toInp.value.trim()) {
                const drafts = JSON.parse(localStorage.getItem(SK_DRAFT) || '[]');
                drafts.unshift({ id: Date.now().toString(36), to: toInp.value, cc: ccInp.value, bcc: bccInp.value, subject: subjInp.value, body, savedAt: new Date().toISOString() });
                localStorage.setItem(SK_DRAFT, JSON.stringify(drafts.slice(0, 50)));
                Notify.show({ title: 'Email', body: 'Draft saved.', type: 'info', appName: 'Email' });
              }
              overlay.remove();
            });

            const fieldsEl = createEl('div', { style: 'flex-shrink:0;' });
            function cf(lbl, type, ph) {
              const row = createEl('div', { className: 'em-cfield' });
              row.appendChild(createEl('span', { className: 'em-cfield-lbl', textContent: lbl }));
              const inp = createEl('input', { className: 'em-cinput', type, placeholder: ph });
              row.appendChild(inp);
              return { row, inp };
            }
            const { row: toRow, inp: toInp } = cf('To', 'email', 'recipient@example.com');
            const { row: ccRow, inp: ccInp } = cf('Cc', 'email', '');
            const { row: bccRow, inp: bccInp } = cf('Bcc', 'email', '');
            const { row: subjRow, inp: subjInp } = cf('Subject', 'text', 'Subject');

            if (prefill.to) toInp.value = prefill.to;
            if (prefill.subject) subjInp.value = prefill.subject;

            // Cc/Bcc toggle
            ccRow.style.display = 'none'; bccRow.style.display = 'none';
            const ccToggle = createEl('button', { className: 'em-btn', textContent: 'Cc/Bcc', style: 'font-size:10px;padding:2px 6px;' });
            toRow.appendChild(ccToggle);
            ccToggle.addEventListener('click', () => { const s = ccRow.style.display === 'none'; ccRow.style.display = s ? '' : 'none'; bccRow.style.display = s ? '' : 'none'; });

            fieldsEl.append(toRow, ccRow, bccRow, subjRow);

            const acct = fromAcct || getActiveAcct();
            const sig = acct?.signature ? '\n\n--\n' + acct.signature : '';
            const bodyTa = createEl('textarea', { className: 'em-cbody', id: 'email-body-input', name: 'email-body', placeholder: 'Write your message…', value: (prefill.body || '') + sig });

            // Attachments
            const fileInp = createEl('input', { type: 'file', multiple: true, style: 'display:none;' });
            const attachListEl = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 4px;flex-shrink:0;' });
            let attachedFiles = [];
            fileInp.addEventListener('change', () => {
              attachedFiles = [...fileInp.files];
              attachListEl.innerHTML = '';
              attachedFiles.forEach(f => attachListEl.appendChild(createEl('span', { className: 'em-attach-chip', textContent: '📎 ' + f.name })));
            });

            const foot = createEl('div', { className: 'em-compose-foot' });
            const sendBtn = createEl('button', { textContent: 'Send', style: 'background:var(--accent);color:#fff;border:none;border-radius:7px;padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer;' });
            const attachBtn = createEl('button', { className: 'em-btn', innerHTML: '&#128206;', title: 'Attach file' });
            const errSpan = createEl('span', { style: 'font-size:11px;color:#e55;flex:1;' });
            attachBtn.addEventListener('click', () => fileInp.click());

            sendBtn.addEventListener('click', async () => {
              if (!AppPermissionManager?.isGranted('mail:send', 'nbosp-email')) {
                Notify.show({ title: 'Permission denied', body: 'Email needs mail:send permission.', type: 'error', appName: 'Email' });
                return;
              }
              if (!AppPermissionManager?.isGranted('mail:write', 'nbosp-email')) {
                Notify.show({ title: 'Permission denied', body: 'Email needs mail:write permission to compose.', type: 'error', appName: 'Email' });
                return;
              }
              const to = toInp.value.trim();
              if (!to) { errSpan.textContent = 'Recipient required.'; return; }
              if (!acct) { errSpan.textContent = 'No account selected.'; return; }
              errSpan.textContent = '';
              sendBtn.textContent = 'Sending…'; sendBtn.disabled = true;
              try {
                const smtpPort = parseInt(acct.smtpPort, 10) || (acct.ssl ? 465 : 587);
                // Don't send pass in the request body — server pulls it from the
                // session (req.session.emailCreds.pass) which is already set by /connect or /restore.
                const payload = {
                  host: acct.smtpHost || acct.host,
                  port: smtpPort,
                  ssl: smtpPort === 465,
                  user: acct.user,
                  to, cc: ccInp.value, bcc: bccInp.value,
                  subject: subjInp.value,
                  text: bodyTa.value
                };
                await api('POST', '/send', payload);
                Notify.show({ title: 'Email', body: 'Sent.', type: 'success', appName: 'Email' });
                overlay.remove();
              } catch (e) {
                errSpan.textContent = e.message;
                sendBtn.textContent = 'Send'; sendBtn.disabled = false;
              }
            });

            foot.append(sendBtn, attachBtn, fileInp, errSpan);
            win.append(hdr, fieldsEl, attachListEl, bodyTa, foot);
            overlay.appendChild(win);
            root.appendChild(overlay);
            toInp.focus();
          }

          composeBtn.addEventListener('click', () => openCompose());

          // While email app is running, intercept OS.openMailto so compose
          // opens inline without re-launching the app.
          // FIX: parseMailto was called here but never defined. It is now defined at the
          // top of init(). The previous handler is also restored by __nbospEmailCleanup.
          OS.openMailto = (url) => openCompose(parseMailto(url));

          // Support WM.createWindow('nbosp-email', { compose: { to, subject, … } })
          if (options?.compose) openCompose(options.compose);

          // ────────────────────────────────────────────────────────────────────────
          // SEARCH / PAGINATION
          // ────────────────────────────────────────────────────────────────────────
          let searchTimer;
          searchInp.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQ = searchInp.value.trim(); page = 1; loadMessages(); }, 420); });
          prevBtn.addEventListener('click', () => { if (page > 1) { page--; loadMessages(); } });
          nextBtn.addEventListener('click', () => { if (page < pages) { page++; loadMessages(); } });
          refreshBtn.addEventListener('click', () => loadMessages());

          // ────────────────────────────────────────────────────────────────────────
          // SYNC ENGINE + NOTIFICATIONS
          // ────────────────────────────────────────────────────────────────────────
          function scheduleSyncAll() {
            emailBg?.ensureBooted?.();
            if (emailBg?.setAccounts) {
              emailBg.onChange = () => {
                if (activeAcctId === 'all' || activeFolder === 'INBOX') {
                  try { buildSidebar(); } catch { }
                }
              };
              emailBg.setAccounts(accounts);
            }
            Object.values(syncTimers).forEach(clearInterval);
            syncTimers = {};
            accounts.forEach(acct => {
              // FIX: parseInt without radix.
              const mins = parseInt(acct.syncInterval, 10) || 0;
              if (!mins) return;
              syncTimers[acct.id] = setInterval(async () => {
                try {
                  await ensureConnected(acct);
                  const d = await api('GET', '/messages', null, { folder: 'INBOX', page: 1, limit: 10 });
                  const newUnread = (d.messages || []).filter(m => !m.seen);
                  if (!newUnread.length) return;
                  if (Notification.permission === 'granted') {
                    // FIX: decodeEntities was defined inline here, creating a new function
                    // object on every interval tick for every account. It is now hoisted.
                    new Notification(`${acct.name || acct.email} — ${newUnread.length} new`, {
                      body: decodeEntities(newUnread[0].subject), icon: '/assets/apple-touch-icon.svg'
                    });
                  }
                  Notify.show({ title: 'Email', body: `${newUnread.length} new in ${acct.name || acct.email}`, type: 'info', appName: 'Email' });
                  if (activeAcctId === acct.id && activeFolder === 'INBOX') loadMessages();
                } catch { }
              }, mins * 60000);
            });
          }

          if (Notification.permission === 'default') Notification.requestPermission().catch(() => { });

          // ────────────────────────────────────────────────────────────────────────
          // BOOTSTRAP
          // ────────────────────────────────────────────────────────────────────────
          function showMain() {
            setupScreen.style.display = 'none';
            mainEl.style.display = '';
            buildSidebar();
            loadMessages();
            showEmpty();
          }

          // Read CSRF token from the server-injected meta tag. If the meta tag is
          // absent (e.g. loaded as a standalone file without the server's HTML pass),
          // fall back to GET /api/email/csrf-token so POST requests still work.
          // (Token initialisation is handled above at the top of init, before any API call.)
          window.__csrfToken = _csrfToken;

          accounts = loadAccts();
          emailBg?.ensureBooted?.();

          // Show UI structure immediately, but delay message loading until after
          // credentials are restored from persistent storage (non-blocking).
          // This avoids the spinner when reopening the app.
          if (!accounts.length) {
            mainEl.style.display = '';
            buildSetup(null);
          } else {
            activeAcctId = accounts.length > 1 ? 'all' : accounts[0].id;
            // Show sidebar and structure without loading messages yet
            setupScreen.style.display = 'none';
            mainEl.style.display = '';
            buildSidebar();
            showEmpty();


            // Restore credentials in background, then load messages
            api('GET', '/restore')
              .then(restore => {
                if (restore?.restored) {
                  console.log('[Email] Credentials auto-restored');
                }
                scheduleSyncAll();
                // Load messages now that credentials are restored
                loadMessages();
              })
              .catch(e => {
                console.warn('[Email] Auto-restore failed, messages may not load:', e.message);
                // Still try to load messages — ensureConnected will handle it
                loadMessages();
              });
          }
        }
      });