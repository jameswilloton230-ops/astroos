(function () {
'use strict';
registerApp({
  id: 'com.astroos.settings',
  name: 'Settings',
  icon: 'settings',
  version: '3.0.2',
  description: 'System Settings',
  defaultSize: [700, 500],
  minSize: [500, 400],
  init(content, state, options) {
    'use strict';

    const systemSettings = window.AstroOSSystem?.settings;
    if (!systemSettings) {
      console.error('[Settings] Astro System settings API is unavailable');
      content.textContent = 'System settings are unavailable. Restart AstroOS and try again.';
      return;
    }

    // Runtime guard — this app needs AstroOS's filesystem services
    if ((typeof process === 'undefined' || process.platform !== 'linux')
        && !window.AppDirs?.getAppDataPath('com.astroos.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      const iconEl = createEl('div', { style: 'font-size:32px', textContent: '\u26A0\uFE0F' });
      const msg = createEl('div', { style: 'font-size:14px;text-align:center' });
      msg.appendChild(createEl('b', { textContent: 'com.astroos.settings' }));
      msg.appendChild(createEl('br'));
      msg.appendChild(document.createTextNode('App data directory missing.'));
      msg.appendChild(createEl('br'));
      msg.appendChild(document.createTextNode('This app requires AstroOS.'));
      content.append(iconEl, msg);
      return;
    }

    // Sidebar sections
    const SECTIONS = [
      { id: 'appearance',      name: 'Appearance',      icon: 'image'         },
      { id: 'accessibility',   name: 'Accessibility',   icon: 'eye'           },
      { id: 'desktop',         name: 'Desktop',         icon: 'layers'        },
      { id: 'system',          name: 'System',           icon: 'processor'     },
      { id: 'date-and-region', name: 'Date and Region',  icon: 'calendar'      },
      { id: 'connectivity',    name: 'Connectivity',     icon: 'globe'         },
      { id: 'storage',         name: 'Storage',          icon: 'database'      },
      { id: 'notifications',   name: 'Notifications',    icon: 'bell'          },
      { id: 'privacy',         name: 'Privacy',          icon: 'lock'          },
      { id: 'root',            name: 'Root Access',      icon: 'shield'        },
      { id: 'default-apps',    name: 'Default Apps',     icon: 'default-apps'  },
      { id: 'about',           name: 'About',            icon: 'info'          }
    ];

    const THEMES      = ['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox'];
    const THEME_NAMES = ['Nova Dark', 'Nova Light', 'Nord', 'Dracula', 'Catppuccin', 'Tokyo Night', 'Gruvbox'];

    const ACCENT_COLORS = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#ff7b72', '#79c0ff', '#56d4dd'];

    const PRESET_WALLPAPERS = window.WallpaperService.getPresets();

    const TASKBAR_SIZES = [
      { value: 'compact', label: 'Compact' },
      { value: 'normal',  label: 'Normal' },
      { value: 'large',   label: 'Large' }
    ];

    const ICON_SIZES = [
      { value: 'normal', label: 'Normal',  transform: 'scale(1)'   },
      { value: 'large',  label: 'Large',   transform: 'scale(1.5)' },
      { value: 'xlarge', label: 'X-Large', transform: 'scale(2)'   }
    ];

    const KEYBOARD_LAYOUTS = [
      { code: 'us', label: 'English (US)' },
      { code: 'gb', label: 'English (UK)' },
      { code: 'ca', label: 'English (Canada)' },
      { code: 'au', label: 'English (Australia)' },
      { code: 'de', label: 'German' },
      { code: 'fr', label: 'French' },
      { code: 'be', label: 'Belgian' },
      { code: 'es', label: 'Spanish' },
      { code: 'it', label: 'Italian' },
      { code: 'pt', label: 'Portuguese' },
      { code: 'br', label: 'Portuguese (Brazil)' },
      { code: 'nl', label: 'Dutch' },
      { code: 'se', label: 'Swedish' },
      { code: 'no', label: 'Norwegian' },
      { code: 'dk', label: 'Danish' },
      { code: 'fi', label: 'Finnish' },
      { code: 'pl', label: 'Polish' },
      { code: 'tr', label: 'Turkish' },
      { code: 'ru', label: 'Russian' },
      { code: 'ua', label: 'Ukrainian' },
      { code: 'jp', label: 'Japanese' }
    ];

    const SHORTCUTS_LIST = [
      { action: 'Open File Manager', key: 'Win+E'        },
      { action: 'Open Terminal',     key: 'Win+T'        },
      { action: 'Open Launchpad',    key: 'Win+Space'    },
      { action: 'Lock Screen',       key: 'Win+L'        },
      { action: 'Show Desktop',      key: 'Win+D'        },
      { action: 'Switch Apps',       key: 'Alt+Tab'      },
      { action: 'Close Window',      key: 'Alt+F4'       },
      { action: 'Fullscreen',        key: 'F11'          },
      { action: 'Screenshot',        key: 'Print Screen' },
      { action: 'New Tab (Browser)', key: 'Ctrl+T'       },
      { action: 'Close Tab',         key: 'Ctrl+W'       },
      { action: 'Find in Page',      key: 'Ctrl+F'       },
      { action: 'Quick Commands',    key: 'Ctrl+K'       }
    ];

    function getThirdPartyHomeApp() {
      const activeHomeAppId = window.__NOVA_ACTIVE_HOME_APP_ID__;
      const homeAppId = typeof activeHomeAppId === 'string' && activeHomeAppId
        ? activeHomeAppId
        : typeof DefaultApps !== 'undefined' ? DefaultApps.getDefault('home') : null;
      if (!homeAppId || homeAppId === 'com.astroos.launcher') return null;
      return {
        id: homeAppId,
        name: (typeof OS !== 'undefined' && OS.apps?.[homeAppId]?.name) || homeAppId
      };
    }

    function createThirdPartyLauncherNotice(homeApp) {
      const notice = createEl('div', {
        role: 'status',
        style: 'padding:10px 12px;margin:0 0 12px;background:var(--accent-muted,rgba(88,166,255,0.12));border:1px solid var(--accent);border-radius:8px;color:var(--text-primary);font-size:12px;'
      });
      notice.textContent = `${homeApp.name} is your active third-party launcher. These controls only apply to AstroOS Launcher.`;
      return notice;
    }

    function disableBundledLauncherControls(group, homeApp) {
      if (!homeApp) return;
      for (const control of group.querySelectorAll('button, input, select')) {
        control.disabled = true;
      }
      for (const row of group.querySelectorAll('.nook-row, .nook-toggle-row')) {
        row.style.opacity = '0.55';
      }
      group.setAttribute('aria-disabled', 'true');
      group.insertBefore(createThirdPartyLauncherNotice(homeApp), group.children[1] || null);
    }

    const PERM_LABELS = {
      'fs:access': 'Manage all files (special access)', 'fs:metadata': 'Read shared file metadata', 'fs:watch': 'File change alerts',
      'fs:read:images': 'Read shared images', 'fs:read:video': 'Read shared videos', 'fs:read:audio': 'Read shared audio',
      'net:internal': 'Internal network', 'net:external': 'Public internet', 'net:websocket': 'Public WebSocket',
      'clipboard:read': 'Read clipboard', 'clipboard:write': 'Write clipboard',
      'data:export': 'Export this app\u2019s data', 'data:backup': 'Back up and restore this app\u2019s data', 'secrets:store': 'Secure secrets storage',
      'mail:read': 'Read emails', 'mail:write': 'Compose emails', 'mail:send': 'Send emails', 'mail:delete': 'Delete emails',
      'calendar:read': 'Read calendar', 'calendar:write': 'Edit calendar', 'calendar:delete': 'Delete events',
      'contacts:read': 'Read contacts', 'contacts:write': 'Edit contacts',
      'device:camera': 'Camera', 'device:microphone': 'Microphone',
      'device:geolocation': 'Location', 'device:notifications': 'Notifications',
      'system:info': 'System info', 'system:settings': 'System settings', 'system:apps': 'Manage apps', 'system:app-launch': 'Launch apps',
      'apps:communicate': 'Communicate with other apps',
      'system:background': 'Background tasks', 'system:background:live': 'Keep running in background', 'system:autostart': 'Start at launch',
      'system:badge': 'Taskbar badge', 'system:schedule': 'Named alarms', 'system:share-target': 'Receive shared content',
      'push:receive': 'Push from its own server',
      'admin:apps': 'Manage apps (admin)', 'admin:system': 'System administration', 'admin:users': 'Manage users', 'admin:audit': 'Audit logs'
    };

    const RISK_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149' };
    const RISK_BG    = { low: 'rgba(63,185,80,0.1)', medium: 'rgba(210,153,34,0.1)', high: 'rgba(240,136,62,0.1)', critical: 'rgba(248,81,73,0.1)' };

    // Region data — declared once here, not rebuilt on every render.
    // Previously these lived inside renderDateAndRegion(), so every visit
    // to that tab re-allocated ~200 region entries, ~200 currency mappings,
    // ~400 timezone strings, and ~200 region→timezone pairs.
    const REGIONS = [
      { code: 'fa-AF', name: '\u0627\u0641\u063A\u0627\u0646\u0633\u062A\u0627\u0646' },
      { code: 'sv-AX', name: '\u00C5land' },
      { code: 'sq-AL', name: 'Albania' },
      { code: 'fr-DZ', name: 'Alg\u00E9rie' },
      { code: 'pt-AO', name: 'Angola' },
      { code: 'en-AG', name: 'Antigua and Barbuda' },
      { code: 'es-AR', name: 'Argentina' },
      { code: 'hy-AM', name: 'Hayast\u00E1n' },
      { code: 'en-AU', name: 'Australia' },
      { code: 'de-AT', name: '\u00D6sterreich' },
      { code: 'az-AZ', name: 'Az\u0259rbaycan' },
      { code: 'en-BS', name: 'Bahamas' },
      { code: 'ar-BH', name: '\u0627\u0644\u0628\u062D\u0631\u064A\u0646' },
      { code: 'bn-BD', name: '\u09AC\u09BE\u0982\u09B2\u09BE\u09A6\u09C7\u09B6' },
      { code: 'en-BB', name: 'Barbados' },
      { code: 'be-BY', name: '\u0411\u0435\u043B\u0430\u0440\u0443\u0441\u044C' },
      { code: 'fr-BE', name: 'Belgique' },
      { code: 'en-BZ', name: 'Belize' },
      { code: 'en-BM', name: 'Bermuda' },
      { code: 'dz-BT', name: '\u0F60\u0F56\u0FB2\u0F74\u0F42\u0F0B\u0F61\u0F74\u0F62' },
      { code: 'es-BO', name: 'Bolivia' },
      { code: 'bs-BA', name: 'Bosna i Hercegovina' },
      { code: 'tn-BW', name: 'Botswana' },
      { code: 'pt-BR', name: 'Brasil' },
      { code: 'ms-BN', name: 'Brunei' },
      { code: 'bg-BG', name: '\u0411\u044A\u043B\u0433\u0430\u0440\u0438\u044F' },
      { code: 'fr-BF', name: 'Burkina Faso' },
      { code: 'fr-BI', name: 'Burundi' },
      { code: 'pt-CV', name: 'Cabo Verde' },
      { code: 'km-KH', name: '\u1780\u1798\u17D2\u1796\u17BB\u1787\u17B6' },
      { code: 'fr-CM', name: 'Cameroun' },
      { code: 'fr-CA', name: 'Canada' },
      { code: 'en-KY', name: 'Cayman Islands' },
      { code: 'fr-CF', name: 'RCA' },
      { code: 'fr-TD', name: 'Tchad' },
      { code: 'es-CL', name: 'Chile' },
      { code: 'zh-CN', name: '\u4E2D\u56FD' },
      { code: 'es-CO', name: 'Colombia' },
      { code: 'fr-CG', name: 'Congo' },
      { code: 'es-CR', name: 'Costa Rica' },
      { code: 'fr-CI', name: 'C\u00F4te d\'Ivoire' },
      { code: 'hr-HR', name: 'Hrvatska' },
      { code: 'es-CU', name: 'Cuba' },
      { code: 'el-CY', name: '\u039A\u03CD\u03C0\u03C1\u03BF\u03C2' },
      { code: 'cs-CZ', name: '\u010Cesk\u00E1 republika' },
      { code: 'da-DK', name: 'Danmark' },
      { code: 'ar-DJ', name: '\u062C\u064A\u0628\u0648\u062A\u064A' },
      { code: 'en-DM', name: 'Dominica' },
      { code: 'es-DO', name: 'Rep\u00FAblica Dominicana' },
      { code: 'fr-CD', name: 'RDC' },
      { code: 'es-EC', name: 'Ecuador' },
      { code: 'ar-EG', name: '\u0645\u0635\u0631' },
      { code: 'es-SV', name: 'El Salvador' },
      { code: 'ti-ER', name: 'Eritrea' },
      { code: 'et-EE', name: 'Eesti' },
      { code: 'am-ET', name: '\u12A2\u1275\u12EE\u1335\u12EB' },
      { code: 'fo-FO', name: 'F\u00F8royar' },
      { code: 'fj-FJ', name: 'Fiji' },
      { code: 'fi-FI', name: 'Suomi' },
      { code: 'fr-FR', name: 'France' },
      { code: 'ty-PF', name: 'Polyn\u00E9sie fran\u00E7aise' },
      { code: 'fr-GA', name: 'Gabon' },
      { code: 'en-GM', name: 'Gambia' },
      { code: 'ka-GE', name: '\u10E1\u10D0\u10E5\u10D0\u10E0\u10D7\u10D5\u10D4\u10DA\u10DD' },
      { code: 'de-DE', name: 'Deutschland' },
      { code: 'en-GH', name: 'Ghana' },
      { code: 'el-GR', name: '\u0395\u03BB\u03BB\u03AC\u03B4\u03B1' },
      { code: 'kl-GL', name: 'Kalaallit Nunaat' },
      { code: 'en-GD', name: 'Grenada' },
      { code: 'es-GT', name: 'Guatemala' },
      { code: 'fr-GG', name: 'Guernesey' },
      { code: 'pt-GW', name: 'Guin\u00E9-Bissau' },
      { code: 'fr-GY', name: 'Guyane' },
      { code: 'es-HN', name: 'Honduras' },
      { code: 'zh-HK', name: '\u9999\u6E2F' },
      { code: 'hu-HU', name: 'Magyarorsz\u00E1g' },
      { code: 'is-IS', name: '\u00CDsland' },
      { code: 'hi-IN', name: '\u092D\u093E\u0930\u0924' },
      { code: 'id-ID', name: 'Indonesia' },
      { code: 'fa-IR', name: '\u0627\u06CC\u0631\u0627\u0646' },
      { code: 'ar-IQ', name: '\u0627\u0644\u0639\u0631\u0627\u0642' },
      { code: 'ga-IE', name: '\u00C9ire' },
      { code: 'gv-IM', name: 'Ellan Vannin' },
      { code: 'he-IL', name: '\u05D9\u05E9\u05E8\u05D0\u05DC' },
      { code: 'it-IT', name: 'Italia' },
      { code: 'en-JM', name: 'Jamaica' },
      { code: 'ja-JP', name: '\u65E5\u672C' },
      { code: 'fr-JE', name: 'Jersey' },
      { code: 'ar-JO', name: '\u0627\u0644\u0623\u0631\u062F\u0646' },
      { code: 'kk-KZ', name: '\u049A\u0430\u0437\u0430\u049B\u0441\u0442\u0430\u043D' },
      { code: 'sw-KE', name: 'Kenya' },
      { code: 'en-KI', name: 'Kiribati' },
      { code: 'ar-KW', name: '\u0627\u0644\u0643\u0648\u064A\u062A' },
      { code: 'ky-KG', name: '\u041A\u044B\u0440\u0433\u044B\u0437\u0441\u0442\u0430\u043D' },
      { code: 'lo-LA', name: '\u0E9B\u0EB0\u0E97\u0EB4\u0E94\u0EA5\u0EB2\u0EA7' },
      { code: 'lv-LV', name: 'Latvija' },
      { code: 'ar-LB', name: '\u0644\u0628\u0646\u0627\u0646' },
      { code: 'en-LR', name: 'Liberia' },
      { code: 'ar-LY', name: '\u0644\u064A\u0628\u064A\u0627' },
      { code: 'lt-LT', name: 'Lietuva' },
      { code: 'lb-LU', name: 'L\u00EBtzebuerg' },
      { code: 'zh-MO', name: '\u6FB3\u9580' },
      { code: 'mg-MG', name: 'Madagascar' },
      { code: 'en-MW', name: 'Malawi' },
      { code: 'ms-MY', name: 'Malaysia' },
      { code: 'dv-MV', name: '\u078B\u07A8\u0788\u07AC\u0780\u07A8\u0783\u07A7\u0787\u07B0\u0796\u07AC' },
      { code: 'fr-ML', name: 'Mali' },
      { code: 'mt-MT', name: 'Malta' },
      { code: 'en-MH', name: 'Marshall Islands' },
      { code: 'ar-MR', name: '\u0645\u0648\u0631\u064A\u062A\u0627\u0646\u064A\u0627' },
      { code: 'fr-MU', name: 'Maurice' },
      { code: 'es-MX', name: 'M\u00E9xico' },
      { code: 'en-FM', name: 'Micronesia' },
      { code: 'ru-MD', name: 'Moldova' },
      { code: 'mn-MN', name: '\u041C\u043E\u043D\u0433\u043E\u043B' },
      { code: 'ar-MA', name: '\u0627\u0644\u0645\u063A\u0631\u0628' },
      { code: 'pt-MZ', name: 'Mo\u00E7ambique' },
      { code: 'my-MM', name: '\u1019\u103C\u1014\u103A\u1019\u102C' },
      { code: 'af-NA', name: 'Afrika (Namibi\u00EB)' },
      { code: 'en-NR', name: 'Nauru' },
      { code: 'ne-NP', name: '\u0928\u0947\u092A\u093E\u0932' },
      { code: 'nl-NL', name: 'Nederland' },
      { code: 'fr-NC', name: 'Nouvelle-Cal\u00E9donie' },
      { code: 'mi-NZ', name: 'Aotearoa' },
      { code: 'es-NI', name: 'Nicaragua' },
      { code: 'fr-NE', name: 'Niger' },
      { code: 'en-NG', name: 'Nigeria' },
      { code: 'ko-KP', name: '\uC870\uC120\uBBFC\uC8FC\uC8FC\uC758\uC778\uBBFC\uACF5\uD654\uAD6D' },
      { code: 'mk-MK', name: '\u041C\u0430\u043A\u0435\u0434\u043E\u043D\u0438\u0458\u0430' },
      { code: 'nb-NO', name: 'Norge' },
      { code: 'ar-OM', name: '\u0639\u064F\u0645\u0627\u0646' },
      { code: 'ur-PK', name: '\u067E\u0627\u06A9\u0633\u062A\u0627\u0646' },
      { code: 'en-PW', name: 'Palau' },
      { code: 'ar-PS', name: '\u0641\u0644\u0633\u0637\u064A\u0646' },
      { code: 'es-PA', name: 'Panam\u00E1' },
      { code: 'en-PG', name: 'Papua New Guinea' },
      { code: 'gn-PY', name: 'Paragu\u00E1i' },
      { code: 'es-PE', name: 'Per\u00FA' },
      { code: 'fil-PH', name: 'Pilipinas' },
      { code: 'pl-PL', name: 'Polska' },
      { code: 'pt-PT', name: 'Portugal' },
      { code: 'es-PR', name: 'Puerto Rico' },
      { code: 'ar-QA', name: '\u0642\u0637\u0631' },
      { code: 'fr-RE', name: 'R\u00E9union' },
      { code: 'ro-RO', name: 'Rom\u00E2nia' },
      { code: 'ru-RU', name: '\u0420\u043E\u0441\u0441\u0438\u044F' },
      { code: 'fr-RW', name: 'Rwanda' },
      { code: 'en-KN', name: 'Saint Kitts and Nevis' },
      { code: 'en-LC', name: 'Saint Lucia' },
      { code: 'en-VC', name: 'Saint Vincent' },
      { code: 'sm-WS', name: 'S\u0101moa' },
      { code: 'pt-ST', name: 'S\u00E3o Tom\u00E9 e Pr\u00EDncipe' },
      { code: 'ar-SA', name: 'Arab Saudi' },
      { code: 'fr-SN', name: 'S\u00E9n\u00E9gal' },
      { code: 'sr-RS', name: '\u0421\u0440\u0431\u0438\u0458\u0430' },
      { code: 'fr-SC', name: 'Seychelles' },
      { code: 'en-SL', name: 'Sierra Leone' },
      { code: 'zh-SG', name: '\u65B0\u52A0\u5761' },
      { code: 'sk-SK', name: 'Slovensko' },
      { code: 'sl-SI', name: 'Slovenija' },
      { code: 'en-SB', name: 'Solomon Islands' },
      { code: 'so-SO', name: 'Soomaaliya' },
      { code: 'zu-ZA', name: 'South Africa' },
      { code: 'ko-KR', name: '\uB300\uD55C\uBBFC\uAD6D' },
      { code: 'ar-SS', name: 'South Sudan' },
      { code: 'es-ES', name: 'Espa\u00F1a' },
      { code: 'si-LK', name: '\u0DC1\u0DCA\u200D\u0DBB\u0DD3 \u0DBD\u0D82\u0D9A\u0DCF' },
      { code: 'ar-SD', name: '\u0627\u0644\u0633\u0648\u062F\u0627\u0646' },
      { code: 'nl-SR', name: 'Suriname' },
      { code: 'sv-SE', name: 'Sverige' },
      { code: 'de-CH', name: 'Schweiz' },
      { code: 'ar-SY', name: '\u0633\u0648\u0631\u064A\u0627' },
      { code: 'zh-TW', name: '\u53F0\u7063' },
      { code: 'tg-TJ', name: '\u0422\u043E\u04B7\u0438\u043A\u0438\u0441\u0442\u043E\u043D' },
      { code: 'sw-TZ', name: 'Tanzania' },
      { code: 'th-TH', name: '\u0E44\u0E17\u0E22' },
      { code: 'pt-TL', name: 'Timor-Leste' },
      { code: 'to-TO', name: 'Tonga' },
      { code: 'en-TT', name: 'Trinidad and Tobago' },
      { code: 'ar-TN', name: '\u062A\u0648\u0646\u0633' },
      { code: 'tr-TR', name: 'T\u00FCrkiye' },
      { code: 'tk-TM', name: 'T\u00FCrkmenistan' },
      { code: 'en-TV', name: 'Tuvalu' },
      { code: 'sw-UG', name: 'Uganda' },
      { code: 'uk-UA', name: '\u0423\u043A\u0440\u0430\u0457\u043D\u0430' },
      { code: 'ar-AE', name: '\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062A' },
      { code: 'en-GB', name: 'United Kingdom' },
      { code: 'en-US', name: 'United States' },
      { code: 'es-UY', name: 'Uruguay' },
      { code: 'uz-UZ', name: 'O\'zbekiston' },
      { code: 'en-VU', name: 'Vanuatu' },
      { code: 'es-VE', name: 'Venezuela' },
      { code: 'vi-VN', name: 'Vi\u1EC7t Nam' },
      { code: 'fr-WF', name: 'Wallis et Futuna' },
      { code: 'ar-YE', name: '\u0627\u0644\u064A\u0645\u0646' },
      { code: 'en-ZM', name: 'Zambia' },
      { code: 'en-ZW', name: 'Zimbabwe' }
    ];

    // Maps a country code (the part after the hyphen in a region code,
    // e.g. 'DE' in 'de-DE') to its ISO 4217 currency code, so the region
    // preview reflects the selected region instead of always showing USD.
    const REGION_CURRENCY = {
      AE: 'AED', AF: 'AFN', AG: 'XCD', AL: 'ALL', AM: 'AMD', AO: 'AOA', AR: 'ARS', AT: 'EUR', AU: 'AUD', AX: 'EUR',
      AZ: 'AZN', BA: 'BAM', BB: 'BBD', BD: 'BDT', BE: 'EUR', BF: 'XOF', BG: 'BGN', BH: 'BHD', BI: 'BIF', BM: 'BMD',
      BN: 'BND', BO: 'BOB', BR: 'BRL', BS: 'BSD', BT: 'BTN', BW: 'BWP', BY: 'BYN', BZ: 'BZD', CA: 'CAD', CD: 'CDF',
      CF: 'XAF', CG: 'XAF', CH: 'CHF', CI: 'XOF', CL: 'CLP', CM: 'XAF', CN: 'CNY', CO: 'COP', CR: 'CRC', CU: 'CUP',
      CV: 'CVE', CY: 'EUR', CZ: 'CZK', DE: 'EUR', DJ: 'DJF', DK: 'DKK', DM: 'XCD', DO: 'DOP', DZ: 'DZD', EC: 'USD',
      EE: 'EUR', EG: 'EGP', ER: 'ERN', ES: 'EUR', ET: 'ETB', FI: 'EUR', FJ: 'FJD', FM: 'USD', FO: 'DKK', FR: 'EUR',
      GA: 'XAF', GB: 'GBP', GD: 'XCD', GE: 'GEL', GG: 'GBP', GH: 'GHS', GL: 'DKK', GM: 'GMD', GR: 'EUR', GT: 'GTQ',
      GW: 'XOF', GY: 'GYD', HK: 'HKD', HN: 'HNL', HR: 'EUR', HU: 'HUF', ID: 'IDR', IE: 'EUR', IL: 'ILS', IM: 'GBP',
      IN: 'INR', IQ: 'IQD', IR: 'IRR', IS: 'ISK', IT: 'EUR', JE: 'GBP', JM: 'JMD', JO: 'JOD', JP: 'JPY', KE: 'KES',
      KG: 'KGS', KH: 'KHR', KI: 'AUD', KN: 'XCD', KP: 'KPW', KR: 'KRW', KW: 'KWD', KY: 'KYD', KZ: 'KZT', LA: 'LAK',
      LB: 'LBP', LC: 'XCD', LK: 'LKR', LR: 'LRD', LT: 'EUR', LU: 'EUR', LV: 'EUR', LY: 'LYD', MA: 'MAD', MD: 'MDL',
      MG: 'MGA', MH: 'USD', MK: 'MKD', ML: 'XOF', MM: 'MMK', MN: 'MNT', MO: 'MOP', MR: 'MRU', MT: 'EUR', MU: 'MUR',
      MV: 'MVR', MW: 'MWK', MX: 'MXN', MY: 'MYR', MZ: 'MZN', NA: 'NAD', NC: 'XPF', NE: 'XOF', NG: 'NGN', NI: 'NIO',
      NL: 'EUR', NO: 'NOK', NP: 'NPR', NR: 'AUD', NZ: 'NZD', OM: 'OMR', PA: 'PAB', PE: 'PEN', PF: 'XPF', PG: 'PGK',
      PH: 'PHP', PK: 'PKR', PL: 'PLN', PR: 'USD', PS: 'ILS', PT: 'EUR', PW: 'USD', PY: 'PYG', QA: 'QAR', RE: 'EUR',
      RO: 'RON', RS: 'RSD', RU: 'RUB', RW: 'RWF', SA: 'SAR', SB: 'SBD', SC: 'SCR', SD: 'SDG', SE: 'SEK', SG: 'SGD',
      SI: 'EUR', SK: 'EUR', SL: 'SLE', SN: 'XOF', SO: 'SOS', SR: 'SRD', SS: 'SSP', ST: 'STN', SV: 'USD', SY: 'SYP',
      TD: 'XAF', TH: 'THB', TJ: 'TJS', TL: 'USD', TM: 'TMT', TN: 'TND', TO: 'TOP', TR: 'TRY', TT: 'TTD', TV: 'AUD',
      TW: 'TWD', TZ: 'TZS', UA: 'UAH', UG: 'UGX', US: 'USD', UY: 'UYU', UZ: 'UZS', VC: 'XCD', VE: 'VES', VN: 'VND',
      VU: 'VUV', WF: 'XPF', WS: 'WST', YE: 'YER', ZA: 'ZAR', ZM: 'ZMW', ZW: 'ZWL'
    };

    const TIMEZONES = [
      'Africa/Abidjan', 'Africa/Accra', 'Africa/Addis_Ababa', 'Africa/Algiers',
      'Africa/Asmara', 'Africa/Bamako', 'Africa/Bangui', 'Africa/Banjul',
      'Africa/Bissau', 'Africa/Blantyre', 'Africa/Brazzaville', 'Africa/Bujumbura',
      'Africa/Cairo', 'Africa/Casablanca', 'Africa/Dakar', 'Africa/Dar_es_Salaam',
      'Africa/Djibouti', 'Africa/Douala', 'Africa/Freetown', 'Africa/Gaborone',
      'Africa/Harare', 'Africa/Johannesburg', 'Africa/Juba', 'Africa/Kampala',
      'Africa/Khartoum', 'Africa/Kigali', 'Africa/Kinshasa', 'Africa/Lagos',
      'Africa/Libreville', 'Africa/Luanda', 'Africa/Lusaka', 'Africa/Maputo',
      'Africa/Mogadishu', 'Africa/Monrovia', 'Africa/Nairobi', 'Africa/Ndjamena',
      'Africa/Niamey', 'Africa/Nouakchott', 'Africa/Ouagadougou', 'Africa/Sao_Tome',
      'Africa/Tripoli', 'Africa/Tunis', 'Africa/Windhoek', 'America/Anchorage',
      'America/Antigua', 'America/Argentina/Buenos_Aires', 'America/Asuncion', 'America/Barbados',
      'America/Belize', 'America/Bogota', 'America/Caracas', 'America/Cayman',
      'America/Chicago', 'America/Costa_Rica', 'America/Denver', 'America/Dominica',
      'America/El_Salvador', 'America/Grenada', 'America/Guatemala', 'America/Guayaquil',
      'America/Guyana', 'America/Havana', 'America/Jamaica', 'America/La_Paz',
      'America/Lima', 'America/Los_Angeles', 'America/Managua', 'America/Mexico_City',
      'America/Montevideo', 'America/Nassau', 'America/New_York', 'America/Noronha',
      'America/Nuuk', 'America/Panama', 'America/Paramaribo', 'America/Phoenix',
      'America/Port_of_Spain', 'America/Puerto_Rico', 'America/Regina', 'America/Santiago',
      'America/Santo_Domingo', 'America/Sao_Paulo', 'America/St_Johns', 'America/St_Kitts',
      'America/St_Lucia', 'America/St_Vincent', 'America/Tegucigalpa', 'America/Tijuana',
      'America/Toronto', 'America/Vancouver', 'Antarctica/Casey', 'Antarctica/Davis',
      'Antarctica/DumontDUrville', 'Antarctica/Macquarie', 'Antarctica/Mawson', 'Antarctica/McMurdo',
      'Antarctica/Palmer', 'Antarctica/Rothera', 'Antarctica/South_Pole', 'Antarctica/Syowa',
      'Antarctica/Troll', 'Antarctica/Vostok', 'Asia/Aden', 'Asia/Almaty',
      'Asia/Amman', 'Asia/Anadyr', 'Asia/Ashgabat', 'Asia/Baghdad',
      'Asia/Bahrain', 'Asia/Baku', 'Asia/Bangkok', 'Asia/Barnaul',
      'Asia/Beirut', 'Asia/Bishkek', 'Asia/Brunei', 'Asia/Calcutta',
      'Asia/Chongqing', 'Asia/Colombo', 'Asia/Dacca', 'Asia/Damascus',
      'Asia/Dhaka', 'Asia/Dili', 'Asia/Dubai', 'Asia/Dushanbe',
      'Asia/Gaza', 'Asia/Harbin', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong',
      'Asia/Irkutsk', 'Asia/Jakarta', 'Asia/Jayapura', 'Asia/Jerusalem',
      'Asia/Kabul', 'Asia/Kamchatka', 'Asia/Karachi', 'Asia/Kashgar',
      'Asia/Kathmandu', 'Asia/Katmandu', 'Asia/Kolkata', 'Asia/Krasnoyarsk',
      'Asia/Kuala_Lumpur', 'Asia/Kuwait', 'Asia/Macao', 'Asia/Macau',
      'Asia/Magadan', 'Asia/Makassar', 'Asia/Manila', 'Asia/Muscat',
      'Asia/Nicosia', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Omsk',
      'Asia/Phnom_Penh', 'Asia/Pyongyang', 'Asia/Qatar', 'Asia/Rangoon',
      'Asia/Riyadh', 'Asia/Sakhalin', 'Asia/Seoul', 'Asia/Shanghai',
      'Asia/Singapore', 'Asia/Taipei', 'Asia/Tashkent', 'Asia/Tbilisi',
      'Asia/Tehran', 'Asia/Thimbu', 'Asia/Thimphu', 'Asia/Tokyo',
      'Asia/Tomsk', 'Asia/Ulaanbaatar', 'Asia/Urumqi', 'Asia/Vientiane',
      'Asia/Vladivostok', 'Asia/Yakutsk', 'Asia/Yangon', 'Asia/Yekaterinburg',
      'Asia/Yerevan', 'Atlantic/Azores', 'Atlantic/Bermuda', 'Atlantic/Cape_Verde',
      'Atlantic/Faroe', 'Atlantic/Reykjavik', 'Atlantic/South_Georgia', 'Australia/Adelaide',
      'Australia/Brisbane', 'Australia/Currie', 'Australia/Darwin', 'Australia/Eucla',
      'Australia/Hobart', 'Australia/Lindeman', 'Australia/Lord_Howe', 'Australia/Melbourne',
      'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Astrakhan',
      'Europe/Athens', 'Europe/Belfast', 'Europe/Belgrade', 'Europe/Berlin',
      'Europe/Bratislava', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest',
      'Europe/Chisinau', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Guernsey',
      'Europe/Helsinki', 'Europe/Isle_of_Man', 'Europe/Istanbul', 'Europe/Jersey',
      'Europe/Kaliningrad', 'Europe/Kyiv', 'Europe/Lisbon', 'Europe/Ljubljana',
      'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta',
      'Europe/Minsk', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris',
      'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Sarajevo',
      'Europe/Saratov', 'Europe/Skopje', 'Europe/Sofia', 'Europe/Stockholm',
      'Europe/Tallinn', 'Europe/Tirane', 'Europe/Ulyanovsk', 'Europe/Vienna',
      'Europe/Vilnius', 'Europe/Volgograd', 'Europe/Warsaw', 'Europe/Zagreb',
      'Europe/Zurich', 'Indian/Antananarivo', 'Indian/Chagos', 'Indian/Christmas',
      'Indian/Cocos', 'Indian/Kerguelen', 'Indian/Mahe', 'Indian/Maldives',
      'Indian/Mauritius', 'Indian/Reunion', 'Pacific/Apia', 'Pacific/Auckland',
      'Pacific/Chuuk', 'Pacific/Efate', 'Pacific/Fiji', 'Pacific/Funafuti',
      'Pacific/Gambier', 'Pacific/Guadalcanal', 'Pacific/Guam', 'Pacific/Honolulu',
      'Pacific/Johnston', 'Pacific/Kiritimati', 'Pacific/Kosrae', 'Pacific/Kwajalein',
      'Pacific/Majuro', 'Pacific/Marquesas', 'Pacific/Midway', 'Pacific/Nauru',
      'Pacific/Niue', 'Pacific/Norfolk', 'Pacific/Noumea', 'Pacific/Pago_Pago',
      'Pacific/Palau', 'Pacific/Pohnpei', 'Pacific/Ponape', 'Pacific/Port_Moresby',
      'Pacific/Rarotonga', 'Pacific/Saipan', 'Pacific/Tahiti', 'Pacific/Tarawa',
      'Pacific/Tongatapu', 'Pacific/Truk', 'Pacific/Wallis', 'Pacific/Yap'
    ];

    // Region code → canonical IANA timezone, used to auto-switch the timezone
    // select when the user picks a new region.
    const REGION_TO_TIMEZONE = {
      'fa-AF': 'Asia/Kabul', 'sv-AX': 'Europe/Helsinki', 'sq-AL': 'Europe/Tirane', 'fr-DZ': 'Africa/Algiers',
      'pt-AO': 'Africa/Luanda', 'en-AG': 'America/Antigua', 'es-AR': 'America/Argentina/Buenos_Aires',
      'hy-AM': 'Asia/Yerevan', 'en-AU': 'Australia/Sydney', 'de-AT': 'Europe/Vienna', 'az-AZ': 'Asia/Baku',
      'en-BS': 'America/Nassau', 'ar-BH': 'Asia/Bahrain', 'bn-BD': 'Asia/Dhaka', 'en-BB': 'America/Barbados',
      'be-BY': 'Europe/Minsk', 'fr-BE': 'Europe/Brussels', 'en-BZ': 'America/Belize', 'en-BM': 'Atlantic/Bermuda',
      'dz-BT': 'Asia/Thimphu', 'es-BO': 'America/La_Paz', 'bs-BA': 'Europe/Sarajevo', 'tn-BW': 'Africa/Gaborone',
      'pt-BR': 'America/Sao_Paulo', 'ms-BN': 'Asia/Brunei', 'bg-BG': 'Europe/Sofia', 'fr-BF': 'Africa/Ouagadougou',
      'fr-BI': 'Africa/Bujumbura', 'pt-CV': 'Atlantic/Cape_Verde', 'km-KH': 'Asia/Phnom_Penh',
      'fr-CM': 'Africa/Douala', 'fr-CA': 'America/Toronto', 'en-KY': 'America/Cayman', 'fr-CF': 'Africa/Bangui',
      'fr-TD': 'Africa/Ndjamena', 'es-CL': 'America/Santiago', 'zh-CN': 'Asia/Shanghai', 'es-CO': 'America/Bogota',
      'fr-CG': 'Africa/Brazzaville', 'es-CR': 'America/Costa_Rica', 'fr-CI': 'Africa/Abidjan', 'hr-HR': 'Europe/Zagreb',
      'es-CU': 'America/Havana', 'el-CY': 'Asia/Nicosia', 'cs-CZ': 'Europe/Prague', 'da-DK': 'Europe/Copenhagen',
      'ar-DJ': 'Africa/Djibouti', 'en-DM': 'America/Dominica', 'es-DO': 'America/Santo_Domingo',
      'fr-CD': 'Africa/Kinshasa', 'es-EC': 'America/Guayaquil', 'ar-EG': 'Africa/Cairo', 'es-SV': 'America/El_Salvador',
      'ti-ER': 'Africa/Asmara', 'et-EE': 'Europe/Tallinn', 'am-ET': 'Africa/Addis_Ababa', 'fo-FO': 'Atlantic/Faroe',
      'fj-FJ': 'Pacific/Fiji', 'fi-FI': 'Europe/Helsinki', 'fr-FR': 'Europe/Paris', 'ty-PF': 'Pacific/Tahiti',
      'fr-GA': 'Africa/Libreville', 'en-GM': 'Africa/Banjul', 'ka-GE': 'Asia/Tbilisi', 'de-DE': 'Europe/Berlin',
      'en-GH': 'Africa/Accra', 'el-GR': 'Europe/Athens', 'kl-GL': 'America/Nuuk', 'en-GD': 'America/Grenada',
      'es-GT': 'America/Guatemala', 'fr-GG': 'Europe/Guernsey', 'pt-GW': 'Africa/Bissau', 'fr-GY': 'America/Guyana',
      'es-HN': 'America/Tegucigalpa', 'zh-HK': 'Asia/Hong_Kong', 'hu-HU': 'Europe/Budapest', 'is-IS': 'Atlantic/Reykjavik',
      'hi-IN': 'Asia/Kolkata', 'id-ID': 'Asia/Jakarta', 'fa-IR': 'Asia/Tehran', 'ar-IQ': 'Asia/Baghdad',
      'ga-IE': 'Europe/Dublin', 'gv-IM': 'Europe/Isle_of_Man', 'he-IL': 'Asia/Jerusalem', 'it-IT': 'Europe/Rome',
      'en-JM': 'America/Jamaica', 'ja-JP': 'Asia/Tokyo', 'fr-JE': 'Europe/Jersey', 'ar-JO': 'Asia/Amman',
      'kk-KZ': 'Asia/Almaty', 'sw-KE': 'Africa/Nairobi', 'en-KI': 'Pacific/Tarawa', 'ar-KW': 'Asia/Kuwait',
      'ky-KG': 'Asia/Bishkek', 'lo-LA': 'Asia/Vientiane', 'lv-LV': 'Europe/Riga', 'ar-LB': 'Asia/Beirut',
      'en-LR': 'Africa/Monrovia', 'ar-LY': 'Africa/Tripoli', 'lt-LT': 'Europe/Vilnius', 'lb-LU': 'Europe/Luxembourg',
      'zh-MO': 'Asia/Macau', 'mg-MG': 'Indian/Antananarivo', 'en-MW': 'Africa/Blantyre', 'ms-MY': 'Asia/Kuala_Lumpur',
      'dv-MV': 'Indian/Maldives', 'fr-ML': 'Africa/Bamako', 'mt-MT': 'Europe/Malta', 'en-MH': 'Pacific/Majuro',
      'ar-MR': 'Africa/Nouakchott', 'fr-MU': 'Indian/Mauritius', 'es-MX': 'America/Mexico_City', 'en-FM': 'Pacific/Chuuk',
      'ru-MD': 'Europe/Chisinau', 'mn-MN': 'Asia/Ulaanbaatar', 'ar-MA': 'Africa/Casablanca', 'pt-MZ': 'Africa/Maputo',
      'my-MM': 'Asia/Yangon', 'af-NA': 'Africa/Windhoek', 'en-NR': 'Pacific/Nauru', 'ne-NP': 'Asia/Kathmandu',
      'nl-NL': 'Europe/Amsterdam', 'fr-NC': 'Pacific/Noumea', 'mi-NZ': 'Pacific/Auckland', 'es-NI': 'America/Managua',
      'fr-NE': 'Africa/Niamey', 'en-NG': 'Africa/Lagos', 'ko-KP': 'Asia/Pyongyang', 'mk-MK': 'Europe/Skopje',
      'nb-NO': 'Europe/Oslo', 'ar-OM': 'Asia/Muscat', 'ur-PK': 'Asia/Karachi', 'en-PW': 'Pacific/Palau',
      'ar-PS': 'Asia/Gaza', 'es-PA': 'America/Panama', 'en-PG': 'Pacific/Port_Moresby', 'gn-PY': 'America/Asuncion',
      'es-PE': 'America/Lima', 'fil-PH': 'Asia/Manila', 'pl-PL': 'Europe/Warsaw', 'pt-PT': 'Europe/Lisbon',
      'es-PR': 'America/Puerto_Rico', 'ar-QA': 'Asia/Qatar', 'fr-RE': 'Indian/Reunion', 'ro-RO': 'Europe/Bucharest',
      'ru-RU': 'Europe/Moscow', 'fr-RW': 'Africa/Kigali', 'en-KN': 'America/St_Kitts', 'en-LC': 'America/St_Lucia',
      'en-VC': 'America/St_Vincent', 'sm-WS': 'Pacific/Apia', 'pt-ST': 'Africa/Sao_Tome', 'ar-SA': 'Asia/Riyadh',
      'fr-SN': 'Africa/Dakar', 'sr-RS': 'Europe/Belgrade', 'fr-SC': 'Indian/Mahe', 'en-SL': 'Africa/Freetown',
      'zh-SG': 'Asia/Singapore', 'sk-SK': 'Europe/Bratislava', 'sl-SI': 'Europe/Ljubljana', 'en-SB': 'Pacific/Guadalcanal',
      'so-SO': 'Africa/Mogadishu', 'zu-ZA': 'Africa/Johannesburg', 'ko-KR': 'Asia/Seoul', 'ar-SS': 'Africa/Juba',
      'es-ES': 'Europe/Madrid', 'si-LK': 'Asia/Colombo', 'ar-SD': 'Africa/Khartoum', 'nl-SR': 'America/Paramaribo',
      'sv-SE': 'Europe/Stockholm', 'de-CH': 'Europe/Zurich', 'ar-SY': 'Asia/Damascus', 'zh-TW': 'Asia/Taipei',
      'tg-TJ': 'Asia/Dushanbe', 'sw-TZ': 'Africa/Dar_es_Salaam', 'th-TH': 'Asia/Bangkok', 'pt-TL': 'Asia/Dili',
      'to-TO': 'Pacific/Tongatapu', 'en-TT': 'America/Port_of_Spain', 'ar-TN': 'Africa/Tunis', 'tr-TR': 'Europe/Istanbul',
      'tk-TM': 'Asia/Ashgabat', 'en-TV': 'Pacific/Funafuti', 'sw-UG': 'Africa/Kampala', 'uk-UA': 'Europe/Kyiv',
      'ar-AE': 'Asia/Dubai', 'en-GB': 'Europe/London', 'en-US': 'America/New_York', 'es-UY': 'America/Montevideo',
      'uz-UZ': 'Asia/Tashkent', 'en-VU': 'Pacific/Efate', 'es-VE': 'America/Caracas', 'vi-VN': 'Asia/Ho_Chi_Minh',
      'fr-WF': 'Pacific/Wallis', 'ar-YE': 'Asia/Aden', 'en-ZM': 'Africa/Lusaka', 'en-ZW': 'Africa/Harare'
    };

    // Keys that must never be restored from an imported JSON file — they're
    // machine/session-specific and overwriting them from an untrusted file
    // would be a security or stability hole.
    const IMPORT_PROTECTED_KEYS = new Set([
      'nova_manual_recovery', 'nova_safe_mode', 'nova_boot_attempts', 'nova_force_recovery'
    ]);
    // i18next is optional — load it once at init, not on every render
    let i18n = null;
    try { i18n = require('i18next'); } catch { /* i18next not installed */ }

    // State
    const validIds = new Set(SECTIONS.map(s => s.id));
    const opts = options || {};
    let currentSection = validIds.has(opts.section) ? opts.section : 'appearance';
    // Set when another app opened us via apps.openDefaultAppsSettings() —
    // used only to highlight a row / show an informational banner.
    const highlightCategory = typeof opts.highlightCategory === 'string' ? opts.highlightCategory : null;
    const requestingAppId   = typeof opts.requestingAppId   === 'string' ? opts.requestingAppId   : null;

    // Lifecycle — AbortController fires when init returns its cleanup.
    // Every addEventListener in this file passes { signal } so listeners
    // are torn down automatically. Async callbacks check isAlive() before
    // touching the DOM so a slow fetch can't update a detached tree.
    const lifecycle = new AbortController();
    const isAlive = () => !lifecycle.signal.aborted && content.isConnected;

    // Tracks overlays (pickers, dialogs, key-capture) mounted on document.body
    // so we can close them when the section changes or the app closes.
    const trackedOverlays = new Map(); // element -> AbortController
    let rootAuditRefreshTimer = null;

    function mountOverlay(el) {
      const ac = new AbortController();
      trackedOverlays.set(el, ac);
      document.body.appendChild(el);
      return ac;
    }

    function dismissOverlay(el) {
      const ac = trackedOverlays.get(el);
      if (ac) ac.abort();
      trackedOverlays.delete(el);
      if (el.isConnected) el.remove();
    }

    function closeAllOverlays() {
      for (const [el, ac] of trackedOverlays) {
        ac.abort();
        if (el.isConnected) el.remove();
      }
      trackedOverlays.clear();
    }

    // Small helper to log in dev mode only — replaces silent catch blocks
    const devLog = (...args) => {
      try { if (typeof OS !== 'undefined' && systemSettings.get('devMode')) console.warn('[Settings]', ...args); } catch { /* settings not ready */ }
    };

    // DOM skeleton
    const container   = createEl('div', { className: 'nook-container' });
    const sidebar     = createEl('nav', { className: 'nook-sidebar', 'aria-label': 'Settings sections' });
    const mainContent = createEl('div', { className: 'nook-content' });

    // Sidebar — built once; only the active class changes on navigation
    const sidebarBtns = new Map();

    function buildSidebar() {
      const frag = document.createDocumentFragment();
      for (const s of SECTIONS) {
        const btn = createEl('button', {
          className: 'nook-section-btn',
          'aria-label': s.name,
          'aria-current': currentSection === s.id ? 'true' : 'false'
        });
        const iconSpan = createEl('span', { 'aria-hidden': 'true', style: 'display:flex;align-items:center;' });
        iconSpan.innerHTML = svgIcon(s.icon, 20);
        btn.append(iconSpan, createEl('span', { textContent: s.name }));
        btn.addEventListener('click', () => {
          currentSection = s.id;
          updateSidebarActive();
          renderContent();
        }, { signal: lifecycle.signal });
        sidebarBtns.set(s.id, btn);
        frag.appendChild(btn);
      }
      sidebar.appendChild(frag);
      updateSidebarActive();
    }

    function updateSidebarActive() {
      for (const [id, btn] of sidebarBtns) {
        const active = id === currentSection;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-current', active ? 'true' : 'false');
      }
    }

    // Content router
    function renderContent() {
      if (!isAlive()) return;
      closeAllOverlays();
      mainContent.replaceChildren();
      // renderAbout sets padding to '0' — reset so other sections get their
      // default padding back (previously it stayed at '0' after visiting About)
      mainContent.style.padding = '';
      mainContent.dataset.currentTab = currentSection;
      switch (currentSection) {
        case 'appearance':        renderAppearance();      break;
        case 'accessibility':     renderAccessibility();   break;
        case 'system':            renderSystem();          break;
        case 'date-and-region':   renderDateAndRegion();   break;
        case 'connectivity':      renderConnectivity();   break;
        case 'storage':           renderStorage();         break;
        case 'notifications':     renderNotifications();   break;
        case 'shortcuts':         renderShortcuts();       break;
        case 'privacy':           renderPrivacy();         break;
        case 'root':              renderRootAccess();      break;
        case 'default-apps':      renderDefaultApps();     break;
        case 'desktop':           renderDesktop();         break;
        case 'about':             renderAbout();           break;
        default:
          mainContent.appendChild(createEl('div', { className: 'empty-state', textContent: 'Section coming soon' }));
      }
    }

    // Appearance
    function renderAppearance() {
      mainContent.appendChild(createEl('h2', { textContent: 'Appearance', style: { marginBottom: '20px' } }));

      const wallpaperLocked = systemSettings.get('prohibitWallpaperChange');
      const currentTheme    = systemSettings.get('theme');
      const currentAccent   = systemSettings.get('accentColor');

      // Theme
      const themeGroup = createEl('div', { className: 'nook-group' });
      themeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Theme' }));
      for (let i = 0; i < THEMES.length; i++) {
        const t = THEMES[i];
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { className: 'nook-row-label', textContent: THEME_NAMES[i] }));
        const isActive = currentTheme === t;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (isActive ? ' btn-primary' : ''),
          textContent: isActive ? 'Active' : 'Select',
          'aria-pressed': String(isActive)
        });
        btn.addEventListener('click', () => {
          systemSettings.set('theme', t);
          renderContent();
        }, { signal: lifecycle.signal });
        row.appendChild(btn);
        themeGroup.appendChild(row);
      }
      mainContent.appendChild(themeGroup);

      // Accent color
      const accentGroup = createEl('div', { className: 'nook-group' });
      accentGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Accent Color' }));
      if (wallpaperLocked) {
        accentGroup.appendChild(createEl('div', {
          style: 'font-size:11px;color:var(--text-warning,#d29922);padding:4px 0;',
          textContent: '\uD83D\uDD12 Accent colour changes are restricted by policy.'
        }));
      }
      const colorRow = createEl('div', { className: 'nook-row' });
      for (const c of ACCENT_COLORS) {
        const selected = currentAccent === c;
        const btn = createEl('button', {
          className: 'btn btn-sm',
          style: {
            width: '32px', height: '32px', background: c,
            border: selected ? '2px solid white' : 'none',
            borderRadius: '50%', padding: '0',
            opacity: wallpaperLocked ? '0.4' : '1',
            cursor: wallpaperLocked ? 'not-allowed' : 'pointer'
          },
          'aria-label': 'Color ' + c,
          'aria-pressed': String(selected),
          disabled: !!wallpaperLocked
        });
        if (!wallpaperLocked) {
          btn.addEventListener('click', () => {
            systemSettings.set('accentColor', c);
            renderContent();
          }, { signal: lifecycle.signal });
        }
        colorRow.appendChild(btn);
      }
      accentGroup.appendChild(colorRow);
      mainContent.appendChild(accentGroup);

      // Clock format
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clock' }));
      const clockRow = createEl('div', { className: 'nook-row' });
      clockRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Time Format' }));
      const is24h = systemSettings.get('clockFormat') === '24h';
      const clockToggle = createEl('button', {
        className: 'toggle' + (is24h ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(is24h),
        'aria-label': 'Toggle 24-hour time'
      });
      clockToggle.addEventListener('click', () => {
        const was24 = systemSettings.get('clockFormat') === '24h';
        systemSettings.set('clockFormat', was24 ? '12h' : '24h');
        clockToggle.classList.toggle('active', !was24);
        clockToggle.setAttribute('aria-checked', String(!was24));
      }, { signal: lifecycle.signal });
      clockRow.appendChild(clockToggle);
      clockGroup.appendChild(clockRow);
      mainContent.appendChild(clockGroup);
    }

    // System
    function renderSystem() {
      mainContent.appendChild(createEl('h2', { textContent: 'System', style: { marginBottom: '20px' } }));

      // User
      const userGroup = createEl('div', { className: 'nook-group' });
      userGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'User' }));
      const userRow = createEl('div', { className: 'nook-row' });
      const userLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'system-username-input', textContent: 'Username' });
      userRow.appendChild(userLabel);
      const userInput = createEl('input', {
        className: 'input', id: 'system-username-input', name: 'system-username',
        style: { width: '150px' }, value: OS.username
      });
      userInput.addEventListener('change', () => {
        systemSettings.set('username', userInput.value || 'user');
      }, { signal: lifecycle.signal });
      userRow.appendChild(userInput);
      userGroup.appendChild(userRow);
      mainContent.appendChild(userGroup);

      // Lock screen
      const lockGroup = createEl('div', { className: 'nook-group' });
      lockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Lock Screen' }));
      const pinRow = createEl('div', { className: 'nook-row' });
      pinRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'PIN Lock' }));

      const pinBtn = createEl('button', { className: 'btn btn-sm', textContent: OS.lockPin ? 'Change PIN' : 'Set PIN' });
      pinBtn.addEventListener('click', async () => {
        if (OS.lockPin) {
          const currentPin = await showModal('Change PIN', 'Enter current PIN:', [
            { label: 'Cancel' }, { label: 'Next', value: 'next' }
          ], 'password');
          if (!isAlive()) return;
          if (!currentPin) return;
          const hash = await OS.workers.crypto.call('pbkdf2', currentPin, getPinSalt());
          if (hash !== OS.lockPin) {
            showModal('Incorrect PIN', 'The current PIN you entered is incorrect.');
            return;
          }
        }

        const pin1 = await showModal(OS.lockPin ? 'New PIN' : 'Set PIN', 'Enter a 4-digit PIN:', [
          { label: 'Cancel' }, { label: 'Next', value: 'next' }
        ], 'password');
        if (!isAlive()) return;
        if (!pin1 || pin1.length !== 4 || !/^\d{4}$/.test(pin1)) {
          if (pin1) showModal('Invalid PIN', 'PIN must be exactly 4 digits.');
          return;
        }

        const pin2 = await showModal('Confirm PIN', 'Re-enter your PIN:', [
          { label: 'Cancel' }, { label: 'Set PIN', value: 'confirm' }
        ], 'password');
        if (!isAlive()) return;
        if (pin1 !== pin2) {
          showModal('PIN Mismatch', 'The PINs do not match. Please try again.');
          return;
        }

        const wasSet  = !!OS.lockPin;
        const newHash = await OS.workers.crypto.call('pbkdf2', pin1, getPinSalt());
        if (!isAlive()) return;
        window.AstroOSSystem.security.setLockPin(newHash);
        Notify.show({ title: wasSet ? 'PIN Updated' : 'PIN Set', body: wasSet ? 'Lock screen PIN has been updated' : 'Lock screen PIN has been set', type: 'success', appName: 'Settings' });
        renderContent();
      }, { signal: lifecycle.signal });
      pinRow.appendChild(pinBtn);

      if (OS.lockPin) {
        const removePinBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Remove', style: { marginLeft: '8px' } });
        removePinBtn.addEventListener('click', async () => {
          const result = await showModal('Remove PIN', 'Are you sure you want to remove PIN lock?', [
            { label: 'Cancel' }, { label: 'Remove PIN', danger: true, value: 'confirm' }
          ]);
          if (!isAlive()) return;
          if (result === 'confirm') {
            window.AstroOSSystem.security.setLockPin(null);
            Notify.show({ title: 'PIN Removed', body: 'PIN lock has been disabled', type: 'success', appName: 'Settings' });
            renderContent();
          }
        }, { signal: lifecycle.signal });
        pinRow.appendChild(removePinBtn);
      }
      lockGroup.appendChild(pinRow);
      mainContent.appendChild(lockGroup);

      // Recovery
      const recoveryGroup = createEl('div', { className: 'nook-group' });
      recoveryGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Recovery' }));
      const recoveryRow = createEl('div', { className: 'nook-row' });
      recoveryRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Recovery Environment' }));
      const recoveryBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Boot to Recovery', style: { background: '#6c5ce7' } });
      recoveryBtn.addEventListener('click', async () => {
        const confirmed = await showModal(
          'Boot to Recovery Environment',
          'This will restart the machine into the Linux recovery environment, where you can start in safe mode, clear caches, back up or restore data, or reset the system.',
          [{ label: 'Cancel' }, { label: 'Boot to Recovery', value: 'confirm', primary: true }]
        );
        if (!isAlive()) return;
        if (confirmed !== 'confirm') return;
        // Set the manual recovery flag so init.js knows this is intentional.
        // Registry-backed (HKNS/system/boot/manualRecovery via BootState —
        // the legacy key is kept in step as the pre-boot handoff shadow).
        // init.js's manual-recovery branch clears boot attempts itself,
        // so we don't write fake boot-attempt entries here.
        try {
          if (typeof RegistryBootState !== 'undefined') {
            RegistryBootState.setFlag('manualRecovery', true);
            RegistryBootState.clearFlag('safeMode');
          } else {
            localStorage.setItem('nova_manual_recovery', '1');
            localStorage.removeItem('nova_safe_mode');
          }
        } catch (e) { console.warn('[Settings] could not stage recovery flag:', e); }
        location.reload();
      }, { signal: lifecycle.signal });
      recoveryRow.appendChild(recoveryBtn);
      recoveryGroup.appendChild(recoveryRow);
      mainContent.appendChild(recoveryGroup);

      // Developer Mode
      const devGroup = createEl('div', { className: 'nook-group' });
      devGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Developer' }));
      const devRow = createEl('div', { className: 'nook-toggle-row' });
      devRow.appendChild(createEl('span', { textContent: 'Developer Mode' }));
      const devOn = !!systemSettings.get('devMode');
      const devToggle = createEl('button', {
        className: 'toggle' + (devOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(devOn),
        'aria-label': 'Toggle developer mode'
      });
      devToggle.addEventListener('click', async () => {
        const next = !systemSettings.get('devMode');
        if (next) {
          const confirmed = await showDevModeWarning();
          if (!isAlive()) return;
          if (confirmed !== 'confirm') return;
        }
        window.AstroOSSystem.developer.setMode(next);
        devToggle.classList.toggle('active', next);
        devToggle.setAttribute('aria-checked', String(next));
        Notify.show({
          title: next ? 'Developer Mode Enabled' : 'Developer Mode Disabled',
          body: next ? 'Press F3 to toggle debug overlay' : undefined,
          type: 'info',
          appName: 'Settings'
        });
      }, { signal: lifecycle.signal });
      devRow.appendChild(devToggle);
      devGroup.appendChild(devRow);
      mainContent.appendChild(devGroup);
    }

    // Developer mode confirmation dialog — built with DOM nodes, tracked
    // for cleanup if the section changes while it's open.
    function showDevModeWarning() {
      return new Promise(resolve => {
        const overlay = createEl('div', {
          style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;animation:fadeIn 150ms ease;'
        });
        const ac = mountOverlay(overlay);
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          dismissOverlay(overlay);
          resolve(v);
        };
        ac.signal.addEventListener('abort', () => finish(null));

        const dialog = createEl('div', {
          style: 'background:var(--bg-elevated,#1b1f23);border:1px solid var(--text-danger,#f85149);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(248,81,73,0.25);padding:28px;max-width:520px;width:92%;animation:modalIn 200ms ease-out;'
        });

        const header = createEl('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:16px;' });
        header.appendChild(createEl('span', { textContent: '\u26A0\uFE0F', style: 'font-size:22px;line-height:1;' }));
        header.appendChild(createEl('div', {
          textContent: 'Developer Mode — Security Warning',
          style: 'font-size:17px;font-weight:700;color:var(--text-danger,#f85149);letter-spacing:0.2px;'
        }));
        dialog.appendChild(header);

        const body = createEl('div', {
          style: 'font-size:14px;color:var(--text-secondary,#aaa);line-height:1.55;margin-bottom:18px;white-space:pre-line;max-height:340px;overflow-y:auto;padding-right:4px;'
        });
        body.textContent =
          'WARNING: Developer Mode lowers the system\'s security posture and grants elevated access to internal components.\n\n' +
          'When enabled, the following restrictions are relaxed:\n' +
          '\u2022 Unrestricted access to the filesystem, networks, and system APIs\n' +
          '\u2022 Elevated permissions to internal system modules and runtime internals\n' +
          '\u2022 Visibility into running processes, memory, and module state\n' +
          '\u2022 The ability to inspect, alter, or revoke app permissions\n' +
          '\u2022 The ability to install, remove, or modify system packages\n\n' +
          'Developer Mode also makes it possible to enable Root Access in Settings. Root Access is a separate device-wide switch, and each app still needs its own explicit grant. A root-approved app runs directly inside the OS page without a sandbox and can read or change system data and UI. Only grant it to apps you fully trust.\n\n' +
          'The following internal apps and tools become accessible:\n' +
          '\u2022 Console — runs arbitrary JavaScript in the full OS context with no sandboxing\n' +
          '\u2022 Inspector — can force-close arbitrary windows and export app state\n' +
          '\u2022 Packages — can install unsigned or unverified packages into the live registry, and can add a locally-generated signing key to this device\u2019s trust store for the current session (only affects installs on this machine; never affects other clones, forks, or devices)\n' +
          '\u2022 Modules — can dynamically import arbitrary module paths for live code execution\n' +
          '\u2022 Permissions — can bulk-grant or revoke permissions for any app without user consent\n' +
          '\u2022 Perf — exposes detailed runtime performance data, memory usage, and per-window DOM breakdowns\n' +
          '\u2022 SysAccess — can read the virtual filesystem and probe internal network/SSRF configuration\n' +
          '\u2022 Events — full visibility into all system-wide activity, including console output, permission checks, package operations, and app event data payloads across every app and OS component\n' +
          '\u2022 Debug Overlay — persistent always-on-top diagnostics overlay exposing GPU, memory, URLs, and OS internals (F3)\n\n' +
          'Developer Mode is intended solely for development, debugging, and system maintenance. Enable it only when you understand the risks. Leave it disabled during normal use.';
        dialog.appendChild(body);

        const actions = createEl('div', { style: 'display:flex;gap:10px;justify-content:flex-end;' });
        const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
        const confirmBtn = createEl('button', { className: 'btn btn-danger', textContent: 'Turn On Anyway' });
        actions.append(cancelBtn, confirmBtn);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { finish(null); return; }
          const btn = e.target.closest('button');
          if (btn && actions.contains(btn)) {
            finish(btn === confirmBtn ? 'confirm' : null);
          }
        }, { signal: ac.signal });

        confirmBtn.focus();
      });
    }

    // Date and Region
    function renderDateAndRegion() {
      mainContent.appendChild(createEl('h2', { textContent: 'Date and Region', style: { marginBottom: '20px' } }));

      const savedRegion = systemSettings.get('region') || navigator.language || 'en-US';
      const currentRegion = REGIONS.some(r => r.code === savedRegion) ? savedRegion : 'en-US';

      const detectedTz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
      const savedTimezone = systemSettings.get('timezone') || detectedTz;
      const currentTimezone = TIMEZONES.includes(savedTimezone) ? savedTimezone : detectedTz;

      // Region select
      const regionGroup = createEl('div', { className: 'nook-group' });
      regionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Region' }));
      const regionRow = createEl('div', { className: 'nook-row' });
      const regionLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'region-select', textContent: 'Date & Currency Format' });
      regionRow.appendChild(regionLabel);

      const regionSelect = document.createElement('select');
      regionSelect.className = 'input';
      regionSelect.id = 'region-select';
      for (const r of REGIONS) {
        const opt = document.createElement('option');
        opt.value = r.code;
        opt.textContent = r.name;
        if (r.code === currentRegion) opt.selected = true;
        regionSelect.appendChild(opt);
      }
      regionRow.appendChild(regionSelect);
      regionGroup.appendChild(regionRow);
      mainContent.appendChild(regionGroup);

      // Timezone select
      const timezoneSelect = document.createElement('select');
      timezoneSelect.className = 'input';
      timezoneSelect.id = 'timezone-select';
      for (const tz of TIMEZONES) {
        const opt = document.createElement('option');
        opt.value = tz;
        opt.textContent = tz;
        if (tz === currentTimezone) opt.selected = true;
        timezoneSelect.appendChild(opt);
      }
      timezoneSelect.addEventListener('change', () => {
        systemSettings.set('timezone', timezoneSelect.value);
        renderContent();
      }, { signal: lifecycle.signal });

      const timezoneGroup = createEl('div', { className: 'nook-group' });
      timezoneGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Timezone' }));
      const timezoneRow = createEl('div', { className: 'nook-row' });
      const tzLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'timezone-select', textContent: 'Current Timezone' });
      timezoneRow.appendChild(tzLabel);
      timezoneRow.appendChild(timezoneSelect);
      timezoneGroup.appendChild(timezoneRow);
      mainContent.appendChild(timezoneGroup);

      regionSelect.addEventListener('change', async () => {
        const selected = regionSelect.value;
        systemSettings.set('region', selected);
        const mappedTz = REGION_TO_TIMEZONE[selected];
        if (mappedTz && TIMEZONES.includes(mappedTz)) {
          systemSettings.set('timezone', mappedTz);
          timezoneSelect.value = mappedTz;
        }
        if (i18n) {
          try { await i18n.changeLanguage(selected); } catch (err) { devLog('i18next changeLanguage failed:', err); }
        }
        try { document.documentElement.lang = selected; } catch { /* read-only */ }
        renderContent();
      }, { signal: lifecycle.signal });

      // Keyboard layout
      const kbGroup = createEl('div', { className: 'nook-group' });
      kbGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Keyboard Layout' }));
      const kbRow = createEl('div', { className: 'nook-row' });
      const isLinux = typeof process !== 'undefined' && process.platform === 'linux';
      if (isLinux) {
        const kbSelect = document.createElement('select');
        kbSelect.className = 'input';
        kbSelect.id = 'keyboard-layout-select';
        kbSelect.setAttribute('aria-label', 'Keyboard layout');
        const configuredLayout = systemSettings.get('keyboardLayout');
        const savedLayout = KEYBOARD_LAYOUTS.some(layout => layout.code === configuredLayout)
          ? configuredLayout
          : 'us';
        for (const layout of KEYBOARD_LAYOUTS) {
          const option = document.createElement('option');
          option.value = layout.code;
          option.textContent = layout.label;
          option.selected = layout.code === savedLayout;
          kbSelect.appendChild(option);
        }
        const kbLabel = createEl('label', {
          className: 'nook-row-label',
          htmlFor: 'keyboard-layout-select',
          textContent: 'Input layout'
        });
        kbSelect.addEventListener('change', () => {
          const layout = KEYBOARD_LAYOUTS.find(item => item.code === kbSelect.value);
          if (!layout) return;
          try {
            systemSettings.set('keyboardLayout', layout.code);
            Notify.show({
              title: 'Keyboard Layout Saved',
              body: `${layout.label} will be used after restarting AstroOS.`,
              type: 'success',
              appName: 'Settings'
            });
          } catch (error) {
            console.error('[Settings] Failed to save keyboard layout:', error);
            Notify.show({
              title: 'Keyboard Layout Not Saved',
              body: String(error?.message || error),
              type: 'error',
              appName: 'Settings'
            });
            kbSelect.value = systemSettings.get('keyboardLayout') || 'us';
          }
        }, { signal: lifecycle.signal });
        kbRow.append(kbLabel, kbSelect);
        kbGroup.appendChild(kbRow);
        kbGroup.appendChild(createEl('p', {
          style: 'font-size:11px;color:var(--text-muted);padding:4px 0;',
          textContent: 'Restart AstroOS for the new keyboard layout to take effect.'
        }));
      } else {
        kbRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Detected Layout' }));
        const kbValue = createEl('span', {
          style: 'color:var(--text-primary);font-weight:500;',
          textContent: 'Detecting...'
        });
        kbRow.appendChild(kbValue);
        kbGroup.appendChild(kbRow);

        if (navigator.keyboard && typeof navigator.keyboard.getLayoutMap === 'function') {
          navigator.keyboard.getLayoutMap().then(map => {
            if (!isAlive()) return;
            const a = map.get('KeyA');
            const q = map.get('KeyQ');
            let detected = 'Unknown';
            if (a === 'a' && q === 'q') detected = 'QWERTY';
            else if (a === 'q' && q === 'a') detected = 'AZERTY';
            else if (a === 'a' && q === 'w') detected = 'QWERTZ';
            else if (a) detected = 'Custom (' + a + ')';
            kbValue.textContent = detected;
          }).catch(() => { if (isAlive()) kbValue.textContent = 'Not available'; });
        } else {
          kbValue.textContent = 'Not supported';
        }
      }
      mainContent.appendChild(kbGroup);

      // Live preview
      const previewGroup = createEl('div', { className: 'nook-group' });
      previewGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Live Preview' }));
      const previewRow = createEl('div', { style: 'padding:12px 0;font-size:12.5px;color:var(--text-secondary);', id: 'region-preview' });
      previewGroup.appendChild(previewRow);
      mainContent.appendChild(previewGroup);

      function getEffectiveLocale() {
        if (i18n && typeof i18n.language === 'string' && i18n.language) return i18n.language;
        return systemSettings.get('region') || navigator.language || 'en-US';
      }

      function updatePreview(region, timezone) {
        const previewEl = document.getElementById('region-preview');
        if (!previewEl || !isAlive()) return;
        const now = new Date();
        const locale = getEffectiveLocale();
        const tz = timezone || systemSettings.get('timezone');
        const opts = { dateStyle: 'full', timeStyle: 'long' };
        if (tz) opts.timeZone = tz;
        const dateStr = new Intl.DateTimeFormat(locale, opts).format(now);
        // Derive currency from the selected region's country code instead
        // of hardcoding USD, falling back to the locale and then USD.
        const effectiveRegion = region || locale;
        const countryCode = String(effectiveRegion).split('-')[1]?.toUpperCase();
        const currencyCode = (countryCode && REGION_CURRENCY[countryCode]) || 'USD';
        let currencyStr;
        try {
          currencyStr = new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(1234.56);
        } catch {
          // Intl throws on unrecognized currency codes — fall back to USD
          currencyStr = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(1234.56);
        }
        // Build via DOM nodes — safe even if date/currency strings contained markup
        const dtDiv = createEl('div', { style: 'margin-bottom:8px;' });
        dtDiv.appendChild(createEl('strong', { textContent: 'Date & Time: ' }));
        dtDiv.appendChild(document.createTextNode(dateStr));
        const curDiv = createEl('div');
        curDiv.appendChild(createEl('strong', { textContent: 'Currency: ' }));
        curDiv.appendChild(document.createTextNode(currencyStr));
        previewEl.replaceChildren(dtDiv, curDiv);
      }

      updatePreview(currentRegion);
    }

    // Connectivity
    function renderConnectivity() {
      mainContent.appendChild(createEl('h2', { textContent: 'Connectivity', style: { marginBottom: '8px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Manage Wi-Fi, wired internet, and Bluetooth devices.',
        style: 'margin:0 0 20px;color:var(--text-muted);font-size:13px;'
      }));

      const connectivity = window.AstroOSSystem.hardware.network;
      const statusText = createEl('div', {
        role: 'status',
        'aria-live': 'polite',
        style: 'font-size:13px;color:var(--text-muted);'
      });
      const networkGroup = createEl('section', { className: 'nook-group' });
      networkGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Internet connection' }));
      const networkToggle = createEl('button', {
        className: 'btn btn-sm',
        textContent: 'Networking: checking…',
        disabled: true
      });
      const refreshNetwork = createEl('button', { className: 'btn btn-sm', textContent: 'Refresh status' });
      const networkControls = createEl('div', { className: 'nook-row', style: 'gap:8px;flex-wrap:wrap;' });
      networkControls.append(networkToggle, refreshNetwork);
      networkGroup.appendChild(networkControls);

      const wifiGroup = createEl('section', { className: 'nook-group' });
      wifiGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Internet and Wi-Fi' }));
      const wifiControls = createEl('div', { className: 'nook-row', style: 'gap:8px;flex-wrap:wrap;' });
      const wifiToggle = createEl('button', { className: 'btn btn-sm', textContent: 'Wi-Fi: checking…', disabled: true });
      const wifiScan = createEl('button', { className: 'btn btn-sm', textContent: 'Scan for networks' });
      const wifiDisconnect = createEl('button', { className: 'btn btn-sm', textContent: 'Disconnect Wi-Fi' });
      wifiControls.append(wifiToggle, wifiScan, wifiDisconnect);
      wifiGroup.appendChild(wifiControls);

      const wifiPassword = createEl('input', {
        type: 'password',
        autocomplete: 'current-password',
        placeholder: 'Wi-Fi password (if required)',
        'aria-label': 'Wi-Fi password',
        style: 'width:100%;max-width:320px;margin:8px 0;'
      });
      wifiGroup.appendChild(wifiPassword);
      const wifiList = createEl('div', { style: 'display:grid;gap:8px;margin-top:8px;' });
      wifiGroup.appendChild(wifiList);

      const bluetoothGroup = createEl('section', { className: 'nook-group' });
      bluetoothGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Bluetooth' }));
      const bluetoothControls = createEl('div', { className: 'nook-row', style: 'gap:8px;flex-wrap:wrap;' });
      const bluetoothToggle = createEl('button', { className: 'btn btn-sm', textContent: 'Bluetooth: checking…', disabled: true });
      const bluetoothScan = createEl('button', { className: 'btn btn-sm', textContent: 'Scan for devices' });
      bluetoothControls.append(bluetoothToggle, bluetoothScan);
      bluetoothGroup.appendChild(bluetoothControls);
      const bluetoothList = createEl('div', { style: 'display:grid;gap:8px;margin-top:8px;' });
      bluetoothGroup.appendChild(bluetoothList);

      mainContent.append(statusText, networkGroup, wifiGroup, bluetoothGroup);

      if (!connectivity) {
        statusText.textContent = 'Connectivity service is not available in this build.';
        return;
      }

      const setStatus = (message, isError = false) => {
        statusText.textContent = message;
        statusText.style.color = isError ? 'var(--text-danger)' : 'var(--text-muted)';
      };
      const runAction = async (action, successMessage) => {
        setStatus('Working…');
        try {
          await action();
          if (!isAlive()) return;
          await refreshStatus();
          const summary = statusText.textContent;
          setStatus(`${successMessage}${summary ? ` ${summary}` : ''}`);
        } catch (error) {
          if (isAlive()) setStatus(error.message || String(error), true);
        }
      };

      async function refreshStatus() {
        try {
          const status = await connectivity.getStatus();
          if (!isAlive()) return;
          if (!status.supported) {
            setStatus(status.reason);
            return;
          }
          statusText.textContent = `Internet: ${status.connectivity} · Network: ${status.networkState}`;
          networkToggle.disabled = status.networkEnabled === null;
          networkToggle.textContent = status.networkEnabled === null
            ? 'Networking unavailable'
            : `Networking: ${status.networkEnabled ? 'On' : 'Off'}`;
          networkToggle.setAttribute('aria-pressed', String(status.networkEnabled === true));
          wifiToggle.disabled = status.wifiEnabled === null;
          wifiToggle.textContent = status.wifiEnabled === null
            ? 'Wi-Fi unavailable'
            : `Wi-Fi: ${status.wifiEnabled ? 'On' : 'Off'}`;
          wifiToggle.setAttribute('aria-pressed', String(status.wifiEnabled === true));
          bluetoothToggle.disabled = status.bluetoothEnabled === null;
          bluetoothToggle.textContent = status.bluetoothEnabled === null
            ? 'Bluetooth unavailable'
            : `Bluetooth: ${status.bluetoothEnabled ? 'On' : 'Off'}`;
          bluetoothToggle.setAttribute('aria-pressed', String(status.bluetoothEnabled === true));
          const errors = [status.wifiError, status.bluetoothError].filter(Boolean);
          if (errors.length) setStatus(`Internet: ${status.connectivity} · ${errors.join(' · ')}`, true);
        } catch (error) {
          if (isAlive()) setStatus(error.message || String(error), true);
        }
      }

      networkToggle.addEventListener('click', () => {
        const currentlyEnabled = networkToggle.getAttribute('aria-pressed') === 'true';
        void runAction(() => connectivity.setNetworkingEnabled(!currentlyEnabled), 'Networking setting updated.');
      }, { signal: lifecycle.signal });
      refreshNetwork.addEventListener('click', () => { void refreshStatus(); }, { signal: lifecycle.signal });

      wifiToggle.addEventListener('click', () => {
        const currentlyEnabled = wifiToggle.getAttribute('aria-pressed') === 'true';
        void runAction(() => connectivity.setWifiEnabled(!currentlyEnabled), 'Wi-Fi setting updated.');
      }, { signal: lifecycle.signal });

      wifiScan.addEventListener('click', async () => {
        wifiScan.disabled = true;
        wifiList.replaceChildren();
        setStatus('Scanning for Wi-Fi networks…');
        try {
          const networks = await connectivity.getWifiNetworks();
          if (!isAlive()) return;
          if (!networks.length) {
            wifiList.appendChild(createEl('div', {
              className: 'nook-row-label',
              textContent: 'No Wi-Fi networks found. Check that a wireless adapter is available.'
            }));
          }
          for (const network of networks) {
            const row = createEl('div', {
              className: 'nook-row',
              style: 'gap:10px;flex-wrap:wrap;align-items:center;'
            });
            row.appendChild(createEl('span', {
              className: 'nook-row-label',
              textContent: `${network.ssid} · ${network.security} · ${network.signal}%`
            }));
            const connect = createEl('button', { className: 'btn btn-sm', textContent: 'Connect' });
            connect.addEventListener('click', () => {
              void runAction(
                () => connectivity.connectWifi(network.ssid, wifiPassword.value),
                `Connected to ${network.ssid}.`
              ).finally(() => { if (isAlive()) wifiPassword.value = ''; });
            }, { signal: lifecycle.signal });
            row.appendChild(connect);
            wifiList.appendChild(row);
          }
          setStatus(`Found ${networks.length} Wi-Fi network(s).`);
        } catch (error) {
          if (isAlive()) setStatus(error.message || String(error), true);
        } finally {
          wifiScan.disabled = false;
        }
      }, { signal: lifecycle.signal });

      wifiDisconnect.addEventListener('click', () => {
        void runAction(() => connectivity.disconnectWifi(), 'Wi-Fi disconnected.');
      }, { signal: lifecycle.signal });

      bluetoothToggle.addEventListener('click', () => {
        const currentlyEnabled = bluetoothToggle.getAttribute('aria-pressed') === 'true';
        void runAction(() => connectivity.setBluetoothEnabled(!currentlyEnabled), 'Bluetooth setting updated.');
      }, { signal: lifecycle.signal });

      bluetoothScan.addEventListener('click', async () => {
        bluetoothScan.disabled = true;
        bluetoothList.replaceChildren();
        setStatus('Scanning for Bluetooth devices…');
        try {
          const devices = await connectivity.scanBluetooth();
          if (!isAlive()) return;
          if (!devices.length) {
            bluetoothList.appendChild(createEl('div', {
              className: 'nook-row-label',
              textContent: 'No Bluetooth devices found. Make sure the device is discoverable.'
            }));
          }
          for (const device of devices) {
            const row = createEl('div', {
              className: 'nook-row',
              style: 'gap:8px;flex-wrap:wrap;align-items:center;'
            });
            row.appendChild(createEl('span', {
              className: 'nook-row-label',
              textContent: `${device.name} · ${device.address}`
            }));
            const pair = createEl('button', { className: 'btn btn-sm', textContent: 'Pair' });
            if (device.paired) {
              const connect = createEl('button', {
                className: 'btn btn-sm',
                textContent: device.connected ? 'Connected' : 'Connect',
                disabled: device.connected
              });
              if (!device.connected) {
                connect.addEventListener('click', () => {
                  void runAction(() => connectivity.connectBluetooth(device.address), `Connected to ${device.name}.`);
                }, { signal: lifecycle.signal });
              }
              const disconnect = createEl('button', {
                className: 'btn btn-sm',
                textContent: 'Disconnect',
                disabled: !device.connected
              });
              if (device.connected) {
                disconnect.addEventListener('click', () => {
                  void runAction(() => connectivity.disconnectBluetooth(device.address), `Disconnected from ${device.name}.`);
                }, { signal: lifecycle.signal });
              }
              const forget = createEl('button', { className: 'btn btn-sm', textContent: 'Forget' });
              forget.addEventListener('click', () => {
                void runAction(() => connectivity.forgetBluetooth(device.address), `Forgot ${device.name}.`);
              }, { signal: lifecycle.signal });
              row.append(connect, disconnect, forget);
            } else {
              pair.addEventListener('click', () => {
                void runAction(() => connectivity.pairBluetooth(device.address), `Paired and connected to ${device.name}.`);
              }, { signal: lifecycle.signal });
              row.appendChild(pair);
            }
            bluetoothList.appendChild(row);
          }
          setStatus(`Found ${devices.length} Bluetooth device(s).`);
        } catch (error) {
          if (isAlive()) setStatus(error.message || String(error), true);
        } finally {
          bluetoothScan.disabled = false;
        }
      }, { signal: lifecycle.signal });

      void refreshStatus();
    }

    // Storage
    async function renderStorage() {
      mainContent.appendChild(createEl('h2', { textContent: 'Storage', style: { marginBottom: '20px' } }));

      try {
        const est = await navigator.storage.estimate();
        if (!isAlive()) return;

        const usageGroup = createEl('div', { className: 'nook-group' });
        usageGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Storage Usage' }));

        const usedRow = createEl('div', { className: 'nook-row' });
        usedRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Used' }));
        usedRow.appendChild(createEl('span', { textContent: formatBytes(est.usage || 0) }));
        usageGroup.appendChild(usedRow);

        const quotaRow = createEl('div', { className: 'nook-row' });
        quotaRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Quota' }));
        quotaRow.appendChild(createEl('span', { textContent: formatBytes(est.quota || 0) }));
        usageGroup.appendChild(quotaRow);

        const ratio = Math.min(100, (est.usage || 0) / (est.quota || 1) * 100);
        const bar  = createEl('div', { className: 'lens-bar' });
        const fill = createEl('div', { className: 'lens-bar-fill', style: { width: ratio + '%' } });
        bar.appendChild(fill);
        usageGroup.appendChild(bar);
        mainContent.appendChild(usageGroup);
      } catch (err) {
        devLog('storage.estimate() failed:', err);
        mainContent.appendChild(createEl('p', { textContent: 'Unable to retrieve storage information.' }));
      }

      // Per-app storage ledger (the "logical UID" accounting layer).
      // Settings reads AppSandbox.storageLedgerSnapshot() directly — trusted
      // host-tier access; apps can never see each other's numbers over IPC.
      const perAppGroup = createEl('div', { className: 'nook-group' });
      perAppGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Per-App Storage' }));
      perAppGroup.appendChild(createEl('p', {
        textContent: 'Key-value usage against each app\'s own budget, plus lifetime bytes moved and request counts. Budgets are enforced by the system, not by the app.',
        style: { margin: '0 0 8px', opacity: '0.75', fontSize: '12px' },
      }));
      mainContent.appendChild(perAppGroup);
      (async () => {
        let snapshot = null;
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.storageLedgerSnapshot) {
            snapshot = await AppSandbox.storageLedgerSnapshot();
          }
        } catch (err) {
          devLog('storage ledger snapshot failed:', err);
        }
        if (!isAlive()) return;
        const apps = snapshot?.apps || [];
        if (!apps.length) {
          perAppGroup.appendChild(createEl('p', {
            textContent: 'No per-app storage recorded yet. Apps appear here once they store data through the platform API.',
            style: { margin: '0', opacity: '0.65', fontSize: '12px' },
          }));
          return;
        }
        for (const app of apps) {
          const knownName = (typeof OS !== 'undefined' && OS.apps?.[app.appId]?.name) || app.appId;
          const row = createEl('div', { className: 'nook-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } });
          const top = createEl('div', { style: { display: 'flex', justifyContent: 'space-between', width: '100%' } });
          top.appendChild(createEl('span', { className: 'nook-row-label', textContent: knownName, title: app.appId }));
          top.appendChild(createEl('span', {
            textContent: formatBytes(app.kvUsage || 0) + ' / ' + formatBytes(app.budgets?.storageQuotaBytes || 0),
          }));
          row.appendChild(top);
          row.appendChild(createEl('div', {
            textContent: formatBytes(app.bytesWritten || 0) + ' written · ' + formatBytes(app.bytesRead || 0) + ' read · ' + (app.requestCount || 0) + ' requests',
            style: { opacity: '0.65', fontSize: '11px' },
          }));
          const barRatio = Math.min(100, (app.kvUsage || 0) / (app.budgets?.storageQuotaBytes || 1) * 100);
          const bar = createEl('div', { className: 'lens-bar', style: { width: '100%' } });
          bar.appendChild(createEl('div', { className: 'lens-bar-fill', style: { width: barRatio + '%' } }));
          row.appendChild(bar);
          perAppGroup.appendChild(row);
        }
      })();

      // Clear data buttons
      const clearGroup = createEl('div', { className: 'nook-group' });
      clearGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clear Data' }));

      const clearCacheBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear Cache' });
      clearCacheBtn.addEventListener('click', async () => {
        const cleared = [];

        if ('caches' in window) {
          try {
            const cacheNames = await caches.keys();
            if (cacheNames.length) {
              await Promise.all(cacheNames.map(n => caches.delete(n)));
              cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length > 1 ? 's' : ''));
            }
          } catch (err) { devLog('caches.keys() failed:', err); }
        }

        try {
          const tempKeys = Object.keys(localStorage).filter(k =>
            k.includes('_cache') || k.includes('_temp') ||
            k === 'nova_boot_attempts' || k === 'nova_force_recovery'
          );
          if (tempKeys.length) {
            for (const k of tempKeys) localStorage.removeItem(k);
            cleared.push(tempKeys.length + ' temp key' + (tempKeys.length > 1 ? 's' : ''));
          }
          // Registry copies of the same transient boot state (HKNS/system/boot/*).
          if (typeof RegistryBootState !== 'undefined') {
            RegistryBootState.clearFlags('attempts', 'forceRecovery', 'timeoutFlag');
          }
        } catch (err) { devLog('localStorage sweep failed:', err); }

        if (!isAlive()) return;
        if (cleared.length) {
          Notify.show({ title: 'Cache Cleared', body: 'Removed: ' + cleared.join(', '), type: 'success', appName: 'Settings' });
        } else {
          Notify.show({ title: 'Nothing to Clear', body: 'Cache is already empty', type: 'info', appName: 'Settings' });
        }
      }, { signal: lifecycle.signal });
      clearGroup.appendChild(clearCacheBtn);

      const wipeBtn = createEl('button', { className: 'btn btn-danger btn-sm', style: { marginLeft: '8px' }, textContent: 'Wipe All Data' });
      wipeBtn.addEventListener('click', async () => {
        const wipeConfirm = await showModal('Wipe All Data', 'This permanently deletes your files, settings, installed apps, and app data. On AstroOS, the system will restart after clearing your user profile. The installed operating system files are not removed.', [
          { label: 'Cancel' }, { label: 'Wipe Everything', danger: true, value: 'wipe' }
        ]);
        if (!isAlive()) return;
        if (wipeConfirm !== 'wipe') return;
        Notify.show({ title: 'Wiping Data', body: 'Please wait...', type: 'warning', appName: 'Settings' });
        try {
          await window.performFactoryReset();
        } catch (err) {
          devLog('Factory reset failed:', err);
          if (isAlive()) Notify.show({ title: 'Reset Failed', body: err.message, type: 'error', appName: 'Settings' });
        }
      }, { signal: lifecycle.signal });
      clearGroup.appendChild(wipeBtn);
      mainContent.appendChild(clearGroup);
    }

    // Desktop
    function renderDesktop() {
      mainContent.appendChild(createEl('h2', { textContent: 'Desktop', style: { marginBottom: '20px' } }));

      // Wallpaper
      const wallpaperGroup = createEl('div', { className: 'nook-group' });
      wallpaperGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Wallpaper' }));

      const presetRow = createEl('div', { className: 'nook-row' });
      presetRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Preset Wallpapers' }));
      const presetContainer = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });

      const savedWallpaperId = systemSettings.get('wallpaperId');
      const currentWallpaperId = systemSettings.get('customWallpaper')
        ? null
        : PRESET_WALLPAPERS.some(wp => wp.id === savedWallpaperId) ? savedWallpaperId : 'stock-blue';

      // Direct references to cards for O(1) visual updates on click
      const wpCards = [];

      PRESET_WALLPAPERS.forEach((wp, idx) => {
        const isActive = currentWallpaperId === wp.id;
        const wpCard = createEl('div', {
          role: 'button',
          tabindex: '0',
          'aria-label': 'Wallpaper: ' + wp.name + (isActive ? ' (active)' : ''),
          'aria-pressed': String(isActive),
          title: wp.name,
          style: 'width:64px;height:48px;border-radius:6px;cursor:pointer;border:2px solid ' + (isActive ? 'var(--accent)' : 'transparent') + ';background:' + wp.gradient + ';transition:all 0.15s;' + (isActive ? 'box-shadow:0 0 0 2px var(--window-bg), 0 0 8px var(--accent);' : 'opacity:0.7;')
        });

        function applyWallpaper() {
          if (systemSettings.set('wallpaperId', wp.id) === false ||
              systemSettings.set('customWallpaper', null) === false ||
              systemSettings.set('customWallpaperName', null) === false) {
            Notify.show({ title: 'Wallpaper Not Changed', body: 'Wallpaper changes are disabled by system policy.', type: 'error', appName: 'Settings' });
            return;
          }
          wallpaperName.textContent = 'No custom image selected';
          for (let i = 0; i < wpCards.length; i++) {
            const on = i === idx;
            wpCards[i].style.borderColor = on ? 'var(--accent)' : 'transparent';
            wpCards[i].style.boxShadow   = on ? '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)' : 'none';
            wpCards[i].style.opacity     = on ? '1' : '0.7';
            wpCards[i].setAttribute('aria-pressed', String(on));
          }
          Notify.show({ title: 'Wallpaper Changed', body: 'Applied ' + wp.name, type: 'success', appName: 'Settings' });
        }

        wpCard.addEventListener('click', applyWallpaper, { signal: lifecycle.signal });
        wpCard.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyWallpaper(); }
        }, { signal: lifecycle.signal });

        wpCards.push(wpCard);
        presetContainer.appendChild(wpCard);
      });

      presetRow.appendChild(presetContainer);
      wallpaperGroup.appendChild(presetRow);

      const wallpaperRow = createEl('div', { className: 'nook-row', style: 'margin-top:16px;' });
      wallpaperRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Custom Image' }));
      const wallpaperName = createEl('span', {
        id: 'custom-wallpaper-name',
        textContent: systemSettings.get('customWallpaper')
          ? (systemSettings.get('customWallpaperName') || 'Custom image')
          : 'No custom image selected',
        style: 'margin-left:8px;color:var(--text-secondary);font-size:12px;'
      });

      const wallpaperBtn = createEl('button', { className: 'btn btn-sm', id: 'wallpaper-upload', textContent: 'Choose Image…' });
      wallpaperBtn.addEventListener('click', async () => {
        const file = await SystemDialogs.open({
          title: 'Choose Wallpaper',
          filter: (name, isDir) => isDir || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name),
        });
        if (!file || !isAlive()) return;
        const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
        const mime = file.mimeType && file.mimeType.startsWith('image/') ? file.mimeType : 'image/png';
        const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        try {
          if (systemSettings.set('customWallpaper', dataUrl) === false ||
              systemSettings.set('customWallpaperName', file.name) === false ||
              systemSettings.set('wallpaperId', null) === false) {
            Notify.show({ title: 'Wallpaper Not Changed', body: 'Wallpaper changes are disabled by system policy.', type: 'error', appName: 'Settings' });
            return;
          }
        } catch (error) {
          Notify.show({ title: 'Wallpaper Not Changed', body: error?.message || 'The selected image is not supported.', type: 'error', appName: 'Settings' });
          return;
        }
        wallpaperName.textContent = file.name;
        Notify.show({ title: 'Wallpaper Changed', body: 'Custom wallpaper applied', type: 'success', appName: 'Settings' });
      }, { signal: lifecycle.signal });
      wallpaperRow.appendChild(wallpaperBtn);
      wallpaperRow.appendChild(wallpaperName);

      const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset to Default', style: { marginLeft: '8px' } });
      resetBtn.addEventListener('click', () => {
        if (systemSettings.set('customWallpaper', null) === false ||
            systemSettings.set('customWallpaperName', null) === false ||
            systemSettings.set('wallpaperId', 'stock-blue') === false) {
          Notify.show({ title: 'Wallpaper Not Changed', body: 'Wallpaper changes are disabled by system policy.', type: 'error', appName: 'Settings' });
          return;
        }
        wallpaperName.textContent = 'No custom image selected';
        for (let i = 0; i < wpCards.length; i++) {
          const on = i === 0;
          wpCards[i].style.borderColor = on ? 'var(--accent)' : 'transparent';
          wpCards[i].style.boxShadow   = on ? '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)' : 'none';
          wpCards[i].style.opacity     = on ? '1' : '0.7';
          wpCards[i].setAttribute('aria-pressed', String(on));
        }
        Notify.show({ title: 'Wallpaper Reset', body: 'Default wallpaper restored', type: 'success', appName: 'Settings' });
      }, { signal: lifecycle.signal });
      wallpaperRow.appendChild(resetBtn);
      wallpaperGroup.appendChild(wallpaperRow);
      mainContent.appendChild(wallpaperGroup);

      // Taskbar
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Taskbar' }));

      const tbClockRow = createEl('div', { className: 'nook-toggle-row' });
      tbClockRow.appendChild(createEl('span', { textContent: 'Show Clock in Taskbar' }));
      const clockVisible = systemSettings.get('showTaskbarClock') !== false;
      const clockToggle = createEl('button', {
        className: 'toggle' + (clockVisible ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(clockVisible),
        'aria-label': 'Toggle clock in taskbar'
      });
      clockToggle.addEventListener('click', () => {
        const wasVisible = systemSettings.get('showTaskbarClock') !== false;
        systemSettings.set('showTaskbarClock', !wasVisible);
        clockToggle.classList.toggle('active', !wasVisible);
        clockToggle.setAttribute('aria-checked', String(!wasVisible));
        const clockEl = document.getElementById('tray-clock');
        if (clockEl) clockEl.style.display = wasVisible ? 'none' : 'flex';
      }, { signal: lifecycle.signal });
      tbClockRow.appendChild(clockToggle);
      clockGroup.appendChild(tbClockRow);

      // Taskbar size
      const sizeRow = createEl('div', { className: 'nook-row' });
      sizeRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Size' }));
      const currentSize = systemSettings.get('taskbarSize') || 'normal';
      for (const sz of TASKBAR_SIZES) {
        const active = currentSize === sz.value;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (active ? ' btn-primary' : ''),
          textContent: sz.label, style: { marginRight: '8px' },
          'aria-pressed': String(active)
        });
        btn.addEventListener('click', () => {
          systemSettings.set('taskbarSize', sz.value);
          renderContent();
        }, { signal: lifecycle.signal });
        sizeRow.appendChild(btn);
      }
      clockGroup.appendChild(sizeRow);
      disableBundledLauncherControls(clockGroup, getThirdPartyHomeApp());

      mainContent.appendChild(clockGroup);
    }

    // Accessibility
    function renderAccessibility() {
      mainContent.appendChild(createEl('h2', { textContent: 'Accessibility', style: { marginBottom: '20px' } }));

      // Reduce Motion
      const motionGroup = createEl('div', { className: 'nook-group' });
      motionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Motion' }));
      const motionRow = createEl('div', { className: 'nook-toggle-row' });
      motionRow.appendChild(createEl('span', { textContent: 'Reduce Motion' }));
      const motionOn = !!systemSettings.get('reduceMotion');
      const motionToggle = createEl('button', {
        className: 'toggle' + (motionOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(motionOn),
        'aria-label': 'Toggle reduced motion'
      });
      motionToggle.addEventListener('click', () => {
        const next = !systemSettings.get('reduceMotion');
        systemSettings.set('reduceMotion', next);
        motionToggle.classList.toggle('active', next);
        motionToggle.setAttribute('aria-checked', String(next));
      }, { signal: lifecycle.signal });
      motionRow.appendChild(motionToggle);
      motionGroup.appendChild(motionRow);
      mainContent.appendChild(motionGroup);

      // Transparency
      const transparencyGroup = createEl('div', { className: 'nook-group' });
      transparencyGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Transparency' }));
      const transparencyRow = createEl('div', { className: 'nook-toggle-row' });
      transparencyRow.appendChild(createEl('span', { textContent: 'Remove Transparency' }));
      const transOn = !!systemSettings.get('removeTransparency');
      const transparencyToggle = createEl('button', {
        className: 'toggle' + (transOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(transOn),
        'aria-label': 'Toggle transparency removal'
      });
      transparencyToggle.addEventListener('click', () => {
        const next = !systemSettings.get('removeTransparency');
        systemSettings.set('removeTransparency', next);
        transparencyToggle.classList.toggle('active', next);
        transparencyToggle.setAttribute('aria-checked', String(next));
      }, { signal: lifecycle.signal });
      transparencyRow.appendChild(transparencyToggle);
      transparencyGroup.appendChild(transparencyRow);
      mainContent.appendChild(transparencyGroup);
      mainContent.appendChild(createEl('p', {
        textContent: 'Makes windows, menus, and panels fully solid — removes blur and see-through backgrounds everywhere.',
        style: { color: 'var(--text-secondary)', fontSize: '12px', marginTop: '-8px', marginBottom: '20px' }
      }));

      // Icon Size
      const iconSizeGroup = createEl('div', { className: 'nook-group' });
      iconSizeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Icon Size' }));
      const currentIconSize = systemSettings.get('cursorSize') || 'normal';
      for (const opt of ICON_SIZES) {
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { textContent: opt.label }));
        const active = currentIconSize === opt.value;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (active ? ' btn-primary' : ''),
          textContent: active ? 'Active' : 'Select',
          'aria-pressed': String(active)
        });
        btn.addEventListener('click', () => {
          systemSettings.set('cursorSize', opt.value);
          let cursorStyles = document.getElementById('cursor-custom-styles');
          if (!cursorStyles) {
            cursorStyles = document.createElement('style');
            cursorStyles.id = 'cursor-custom-styles';
            document.head.appendChild(cursorStyles);
          }
          cursorStyles.textContent = '#desktop .desktop-icon { transform: ' + opt.transform + ' }';
          renderContent();
        }, { signal: lifecycle.signal });
        row.appendChild(btn);
        iconSizeGroup.appendChild(row);
      }
      disableBundledLauncherControls(iconSizeGroup, getThirdPartyHomeApp());
      mainContent.appendChild(iconSizeGroup);
    }

    // Notifications
    function renderNotifications() {
      mainContent.appendChild(createEl('h2', { textContent: 'Notifications', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Do Not Disturb and per-app notification channels.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      // Do Not Disturb
      const dndGroup = createEl('div', { className: 'nook-group' });
      dndGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Do Not Disturb' }));
      const dndRow = createEl('div', { className: 'nook-toggle-row' });
      dndRow.appendChild(createEl('span', { textContent: 'Hide notification toasts' }));
      const dndOn = !!OS.dnd;
      const dndToggle = createEl('button', {
        className: 'toggle' + (dndOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(dndOn),
        'aria-label': 'Toggle Do Not Disturb'
      });
      dndToggle.addEventListener('click', () => {
        const next = !OS.dnd;
        OS.dnd = next;
        systemSettings.set('doNotDisturb', next);
        dndToggle.classList.toggle('active', next);
        dndToggle.setAttribute('aria-checked', String(next));
      }, { signal: lifecycle.signal });
      dndRow.appendChild(dndToggle);
      dndGroup.appendChild(dndRow);
      mainContent.appendChild(dndGroup);
      mainContent.appendChild(createEl('p', {
        textContent: 'While on, new notifications skip the toast and land silently in the notification panel instead.',
        style: { color: 'var(--text-secondary)', fontSize: '12px', marginTop: '-8px', marginBottom: '20px' }
      }));

      // Notification channels
      mainContent.appendChild(createEl('h3', { textContent: 'App Channels', style: { marginBottom: '8px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Apps sort their notifications into channels (Messages, Promos, …). Pick an importance per channel — Blocked silences it completely.',
        style: { color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '14px' }
      }));

      const notify = (typeof Notify !== 'undefined' && Notify.listAppsWithChannels) ? Notify : null;
      if (!notify) {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Notification channel system not available.';
        mainContent.appendChild(warn);
        return;
      }

      const devMode = !!systemSettings.get('devMode');
      const appIds = notify.listAppsWithChannels().filter(id => {
        if (devMode) return true;
        return !OS.apps?.[id]?.devOnly;
      }).sort();

      if (!appIds.length) {
        const empty = createEl('div', {
          style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-muted);font-size:13px;'
        });
        empty.textContent = 'No apps have created notification channels yet. Channels appear here once an app declares them in its manifest or creates them through the notifications API.';
        mainContent.appendChild(empty);
        return;
      }

      // Segmented importance picker per channel, matching the button-group
      // pattern used elsewhere (Icon Size, taskbar size). Values mirror the
      // channel importance model in notifications/service.js.
      const IMPORTANCE_OPTIONS = [
        { value: 'none',    label: 'Off',   title: 'Blocked — nothing is shown' },
        { value: 'low',     label: 'Low',   title: 'Panel only, no toast' },
        { value: 'default', label: 'Norm',  title: 'Normal — toast + panel' },
        { value: 'high',    label: 'High',  title: 'High — long-lived toast' }
      ];

      for (const appId of appIds) {
        const entry   = OS.apps?.[appId];
        const appName = entry?.name || appId;
        const channels = notify.listChannels(appId);

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;'
        });
        const header = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;' });
        header.appendChild(createEl('div', { style: 'font-weight:600;font-size:13px;', textContent: appName }));
        const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset' });
        resetBtn.addEventListener('click', () => {
          // Clear every override for this app — channels fall back to the
          // importances the developer declared.
          for (const ch of channels) notify.setChannelOverride(appId, ch.id, null);
          renderContent();
        }, { signal: lifecycle.signal });
        header.appendChild(resetBtn);
        card.appendChild(header);

        for (const ch of channels) {
          const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--border-subtle);' });
          const info = createEl('div', { style: 'flex:1;min-width:0;' });
          info.appendChild(createEl('div', { style: 'font-size:13px;', textContent: ch.name }));
          if (ch.description) {
            info.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: ch.description }));
          }
          row.appendChild(info);

          const group = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
          for (const opt of IMPORTANCE_OPTIONS) {
            const active = ch.importance === opt.value;
            const btn = createEl('button', {
              className: 'btn btn-sm' + (active ? ' btn-primary' : ''),
              textContent: opt.label,
              title: opt.title,
              'aria-pressed': String(active)
            });
            btn.addEventListener('click', () => {
              if (active) return;
              // Picking the channel's own declared importance clears the
              // override entirely, so a future app-side declaration wins
              // again instead of being pinned by the user's old choice.
              if (opt.value === ch.declaredImportance) {
                notify.setChannelOverride(appId, ch.id, null);
              } else {
                notify.setChannelOverride(appId, ch.id, { enabled: ch.enabled, importance: opt.value });
              }
              renderContent();
            }, { signal: lifecycle.signal });
            group.appendChild(btn);
          }
          row.appendChild(group);
          card.appendChild(row);
        }
        mainContent.appendChild(card);
      }
    }

    // Apps
    function renderApps() {
      mainContent.appendChild(createEl('h2', { textContent: 'App Permissions', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Manage what each app is allowed to access. Denied permissions can be re-enabled here.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      const mgr  = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
      const pmap = typeof AppPermissionsMap    !== 'undefined' ? AppPermissionsMap    : null;

      if (!mgr || !pmap) {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Permission system not available.';
        mainContent.appendChild(warn);
        return;
      }

      const appIds = new Set(Object.keys(pmap));
      if (typeof OS !== 'undefined' && OS.apps) {
        for (const id of Object.keys(OS.apps)) {
          if (id.startsWith('wa_')) appIds.add(id);
        }
      }

      let novaApps = [];
      try { novaApps = (window.NovaAppPackageStore?.loadRegistry?.()) ?? JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); }
      catch (err) { devLog('nova_installed_apps parse failed:', err); novaApps = []; }
      const novaAppIds = new Set(novaApps.map(a => a.id));

      // System apps (manifest.system === true) are part of the OS image, not
      // user-installed packages. They render under BUILT-IN APPS (where the
      // rest of the built-ins live) rather than under INSTALLED PACKAGES,
      // so the user isn't misled into thinking they installed them.
      const systemNovaApps = novaApps.filter(a => a.system === true);
      const userNovaApps  = novaApps.filter(a => a.system !== true);
      const builtIns = [...appIds].filter(id => !id.startsWith('wa_') && !novaAppIds.has(id)).sort();
      const webApps  = [...appIds].filter(id =>  id.startsWith('wa_')).sort();

      const devMode = !!systemSettings.get('devMode');
      const visibleBuiltIns = builtIns.filter(id => {
        if (devMode) return true;
        const entry = OS.apps?.[id];
        return !entry?.devOnly;
      });

      // Dev-only apps (devconsole, sysaccess, packages, perf, …) are hidden
      // from every section unless Developer Mode is on — same rule the
      // launchpad and WM.createWindow use, applied here too so they don't
      // surface in the Permissions UI just because they're installed.
      const filterDev = list => devMode ? list : list.filter(a => !a.devOnly);
      const visibleSystemNovaApps = filterDev(systemNovaApps);
      const visibleUserNovaApps  = filterDev(userNovaApps);

      function buildAppCard(appId, novaData) {
        const entry   = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[appId] : null;
        const appName = novaData?.name ?? entry?.name ?? appId;

        let dangerous, normal, appVersion, appVerified, appAuthor;
        if (novaData) {
          dangerous   = [...(novaData.permissions || []), ...(novaData.optionalPermissions || [])];
          normal      = [];
          appVersion  = novaData.version  || null;
          appVerified = novaData.verified  ?? false;
          appAuthor   = novaData.author    || null;
        } else {
          const mapEntry = pmap[appId];
          dangerous   = mapEntry?.dangerous ?? ['device:camera', 'device:microphone', 'device:geolocation'];
          normal      = mapEntry?.normal    ?? [];
          appVersion  = null;
          appVerified = null;
          appAuthor   = null;
        }

        if (dangerous.length === 0 && normal.length === 0 && !novaData && !appId.startsWith('wa_')) return null;

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;'
        });

        const header     = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;user-select:none;' });
        const headerLeft = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });

        // App icon — built via DOM API to avoid XSS from app-provided data URIs
        const iconEl = createEl('div', {
          style: 'width:34px;height:34px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);flex-shrink:0;overflow:hidden;'
        });
        const iconVal  = novaData?.icon ?? entry?.icon ?? null;
        const isEmoji  = iconVal && /\p{Emoji}/u.test(iconVal) && iconVal.length <= 4;
        const isSvgKey = iconVal && !isEmoji && /^[a-z][a-z0-9-]*$/.test(iconVal);
        const isDataUri = iconVal && typeof iconVal === 'string' && iconVal.startsWith('data:image/svg+xml;base64,');
        if (isSvgKey && typeof svgIcon === 'function') {
          iconEl.innerHTML = svgIcon(iconVal, 18);
          iconEl.style.color = 'var(--accent)';
        } else if (isEmoji) {
          iconEl.style.fontSize = '20px';
          iconEl.textContent = iconVal;
        } else if (isDataUri) {
          // Use DOM API + src property — safe even if the data URI contains quote chars
          iconEl.style.background = 'transparent';
          const img = createEl('img', { src: iconVal, width: 18, height: 18, alt: '', draggable: false });
          img.style.display = 'block';
          iconEl.replaceChildren(img);
        } else {
          iconEl.textContent = appName.charAt(0).toUpperCase();
        }
        headerLeft.appendChild(iconEl);

        const nameEl = createEl('div');
        nameEl.appendChild(createEl('div', { textContent: appName, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));

        // Badge row — refreshed in-place on toggle
        const badgeRow = createEl('div', { style: 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;' });
        function refreshBadges() {
          badgeRow.replaceChildren();
          const grantedCount = dangerous.filter(p => mgr.isGranted(p, appId)).length;
          const deniedCount  = dangerous.filter(p => mgr.isDenied ? mgr.isDenied(p, appId) : false).length;
          const pendingCount = dangerous.length - grantedCount - deniedCount;
          if (grantedCount > 0) badgeRow.appendChild(createEl('span', { textContent: grantedCount + ' allowed',    style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.3);' }));
          if (deniedCount  > 0) badgeRow.appendChild(createEl('span', { textContent: deniedCount  + ' denied',     style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(248,81,73,0.12);color:#f85149;border:1px solid rgba(248,81,73,0.3);' }));
          if (pendingCount > 0) badgeRow.appendChild(createEl('span', { textContent: pendingCount + ' not asked',  style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          if (dangerous.length === 0 && normal.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No permissions',           style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          else if (dangerous.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No sensitive permissions', style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
        }
        refreshBadges();

        if (appVersion || appAuthor || appVerified !== null) {
          const metaRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:3px;align-items:center;flex-wrap:wrap;' });
          if (appVersion)        metaRow.appendChild(createEl('span', { textContent: 'v' + appVersion,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
          if (appAuthor)         metaRow.appendChild(createEl('span', { textContent: 'by ' + appAuthor, style: 'font-size:10px;color:var(--text-muted);' }));
          if (appVerified === true)  metaRow.appendChild(createEl('span', { textContent: '\u2713 Verified',   style: 'font-size:10px;color:#3fb950;' }));
          if (appVerified === false) metaRow.appendChild(createEl('span', { textContent: '\u26A0 Unverified', style: 'font-size:10px;color:#d29922;' }));
          nameEl.appendChild(metaRow);
        }
        nameEl.appendChild(badgeRow);
        headerLeft.appendChild(nameEl);
        header.appendChild(headerLeft);

        const chevron = createEl('span', { style: 'color:var(--text-muted);font-size:12px;transition:transform 0.2s;', textContent: '\u25B6', 'aria-hidden': 'true' });
        header.appendChild(chevron);
        card.appendChild(header);

        // Expandable body
        const body = createEl('div', { style: 'display:none;border-top:1px solid var(--border-subtle);' });

        // References to each permission's toggle for in-place sync
        const toggleEls = {};

        if (dangerous.length > 0) {
          const section = createEl('div', { style: 'padding:10px 14px 6px;' });
          section.appendChild(createEl('div', {
            textContent: 'SENSITIVE PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:8px;'
          }));

          for (const perm of dangerous) {
            const cat       = AppPermissionManager.PERMISSION_CATEGORIES?.[perm];
            const risk      = cat?.risk ?? 'medium';
            const label     = PERM_LABELS[perm] ?? perm;
            const isGranted = mgr.isGranted(perm, appId);
            const isDenied  = mgr.isDenied ? mgr.isDenied(perm, appId) : false;

            const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);' });
            const left = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });

            const riskBadge = createEl('span', {
              textContent: risk.charAt(0).toUpperCase() + risk.slice(1),
              style: 'font-size:9px;padding:1px 6px;border-radius:20px;background:' + RISK_BG[risk] + ';color:' + RISK_COLOR[risk] + ';border:1px solid ' + RISK_COLOR[risk] + '40;font-weight:600;'
            });
            const labelEl = createEl('div');
            labelEl.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);font-weight:500;' }));
            labelEl.appendChild(createEl('div', { textContent: perm,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
            if (cat?.specialAccess) {
              labelEl.appendChild(createEl('div', {
                textContent: 'Special access: enable or revoke here; apps cannot prompt for it.',
                style: 'font-size:10px;color:var(--text-muted);margin-top:2px;',
              }));
            }
            left.append(riskBadge, labelEl);
            row.appendChild(left);

            const toggleWrap  = createEl('label', { style: 'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;' });
            const toggleInput = createEl('input', { type: 'checkbox' });
            toggleInput.style.cssText = 'opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2;';
            toggleInput.checked = isGranted;
            toggleInput.setAttribute('aria-label', label);
            const slider = createEl('span', {
              style: 'position:absolute;inset:0;border-radius:22px;transition:background 0.2s;background:' + (isGranted ? 'var(--accent)' : (isDenied ? 'rgba(248,81,73,0.3)' : 'var(--bg-elevated)')) + ';border:1px solid var(--border-subtle);'
            });
            const knob = createEl('span', {
              style: 'position:absolute;top:2px;left:' + (isGranted ? '20px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);'
            });
            slider.appendChild(knob);
            toggleWrap.append(toggleInput, slider);

            toggleEls[perm] = { toggleInput, slider, knob };

            toggleInput.addEventListener('change', async () => {
              if (toggleInput.checked) {
                // Clear any prior denial, then grant once
                if (mgr.resetPermission) await Promise.resolve(mgr.resetPermission(perm, appId)).catch(err => devLog('resetPermission failed:', err));
                await mgr.grantPermission(perm, appId, { permanent: true, reason: 'Manually granted via Settings', grantedBy: 'user' });
                slider.style.background = 'var(--accent)';
                knob.style.left = '20px';
              } else {
                await mgr.revokePermission(perm, appId);
                slider.style.background = 'rgba(248,81,73,0.3)';
                knob.style.left = '2px';
              }
              refreshBadges();
            });

            row.appendChild(toggleWrap);
            section.appendChild(row);
          }
          body.appendChild(section);
        }

        if (normal.length > 0) {
          const normSection = createEl('div', { style: 'padding:8px 14px 10px;' });
          normSection.appendChild(createEl('div', {
            textContent: 'AUTOMATIC PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:6px;'
          }));
          const normList = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;' });
          for (const perm of normal) {
            normList.appendChild(createEl('span', {
              textContent: PERM_LABELS[perm] ?? perm,
              style: 'font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(63,185,80,0.08);color:#3fb950;border:1px solid rgba(63,185,80,0.2);'
            }));
          }
          normSection.appendChild(normList);
          body.appendChild(normSection);
        }

        // Live per-app resource counts for the newer surfaces — visible in
        // the same detail view as the grants, never the values themselves
        // (secret VALUES are unreadable even here, by design).
        try {
          const liveCounts = [];
          if (mgr.isGranted && mgr.isGranted('secrets:store', appId) && typeof AppSecrets !== 'undefined' && AppSecrets.count) {
            const n = AppSecrets.count(appId);
            liveCounts.push(n + (n === 1 ? ' secret' : ' secrets'));
          }
          if (mgr.isGranted && mgr.isGranted('system:schedule', appId)) {
            let alarmCount = 0;
            try {
              // Registry-backed (HKNS/apps/alarms); the localStorage key is
              // the pre-registry fallback.
              const state = (window.RegistrySystemState?.alarms?.())
                ?? JSON.parse(localStorage.getItem('nova_app_alarms') || '{"apps":{}}');
              const rec = state && state.apps && state.apps[appId];
              if (rec && rec.alarms) alarmCount = Object.keys(rec.alarms).length;
            } catch (_) {}
            liveCounts.push(alarmCount + (alarmCount === 1 ? ' alarm' : ' alarms'));
          }
          if (mgr.isGranted && mgr.isGranted('fs:watch', appId) && typeof AppSandbox !== 'undefined' && AppSandbox._internal && AppSandbox._internal.fsWatchers) {
            let watcherCount = 0;
            for (const w of AppSandbox._internal.fsWatchers.values()) if (w.appId === appId) watcherCount++;
            liveCounts.push(watcherCount + (watcherCount === 1 ? ' watcher' : ' watchers'));
          }
          if (mgr.isGranted && mgr.isGranted('push:receive', appId) && typeof AppSandbox !== 'undefined'
            && AppSandbox._internal && AppSandbox._internal.loadPushState) {
            // Registration state + queued-message count — the token VALUE is
            // never shown here, same policy as secret values above.
            let pushState = { tokens: {}, queue: {} };
            try { pushState = AppSandbox._internal.loadPushState() || pushState; } catch (_) {}
            const registered = !!(pushState.tokens && pushState.tokens[appId]);
            const pushQueue = pushState.queue && Array.isArray(pushState.queue[appId]) ? pushState.queue[appId].length : 0;
            if (registered) liveCounts.push('push registered');
            if (pushQueue > 0) liveCounts.push(pushQueue + (pushQueue === 1 ? ' queued push' : ' queued pushes'));
          }
          if (liveCounts.length > 0) {
            const liveSection = createEl('div', { style: 'padding:0 14px 10px;' });
            liveSection.appendChild(createEl('div', {
              textContent: 'IN USE',
              style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:4px;'
            }));
            liveSection.appendChild(createEl('div', {
              textContent: liveCounts.join(' · '),
              style: 'font-size:11px;color:var(--text-muted);'
            }));
            body.appendChild(liveSection);
          }
        } catch (_) { /* counts are informational; never block the page */ }

        if (dangerous.length > 0) {
          const footer   = createEl('div', { style: 'padding:8px 14px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;' });
          const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset All Permissions', style: 'font-size:11px;' });
          resetBtn.addEventListener('click', async () => {
            if (mgr.resetPermission) {
              for (const p of dangerous) await mgr.resetPermission(p, appId);
            } else {
              await mgr.revokeAllPermissions(appId);
            }
            // Sync every toggle's checked state + slider/knob visuals now
            // that the underlying grants have been cleared.
            for (const p of dangerous) {
              const t = toggleEls[p];
              if (!t) continue;
              t.toggleInput.checked = false;
              t.slider.style.background = 'var(--bg-elevated)';
              t.knob.style.left = '2px';
            }
            Notify.show({ title: 'Permissions Reset', body: appName + ' will be asked again next launch.', type: 'info', appName: 'Settings' });
            refreshBadges();
          }, { signal: lifecycle.signal });
          footer.appendChild(resetBtn);
          body.appendChild(footer);
        }

        card.appendChild(body);

        let expanded = false;
        header.addEventListener('click', () => {
          expanded = !expanded;
          body.style.display       = expanded ? 'block' : 'none';
          chevron.style.transform  = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
        }, { signal: lifecycle.signal });

        return card;
      }

      if (visibleBuiltIns.length > 0 || visibleSystemNovaApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'BUILT-IN APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:10px;' }));
        for (const id of visibleBuiltIns) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
        // Bundled .novaapp packages (manifest.system === true) are shipped
        // with the OS image — same tier as the built-ins, not user-installed.
        for (const novaData of visibleSystemNovaApps) {
          const card = buildAppCard(novaData.id, novaData);
          if (card) mainContent.appendChild(card);
        }
      }

      if (visibleUserNovaApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'INSTALLED PACKAGES', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const novaData of visibleUserNovaApps) {
          const card = buildAppCard(novaData.id, novaData);
          if (card) mainContent.appendChild(card);
        }
      }

      if (webApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'WEB APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const id of webApps) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
      }

      if (visibleBuiltIns.length === 0 && webApps.length === 0 && visibleSystemNovaApps.length === 0 && visibleUserNovaApps.length === 0) {
        const empty = createEl('div', { style: 'text-align:center;color:var(--text-muted);padding:40px 0;font-size:13px;' });
        empty.textContent = 'No apps found.';
        mainContent.appendChild(empty);
      }
    }

    // Default Apps
    function renderDefaultApps() {
      mainContent.appendChild(createEl('h2', { textContent: 'Default Apps', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Choose which app opens each type of file or link. Only apps that support a category are shown.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      if (typeof DefaultApps === 'undefined') {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Default apps system not available.';
        mainContent.appendChild(warn);
        return;
      }

      // Banner shown when another app deep-linked here via
      // apps.openDefaultAppsSettings() — purely informational.
      if (requestingAppId && highlightCategory && DefaultApps.CATEGORIES[highlightCategory]) {
        const requestingName = (typeof OS !== 'undefined' && OS.apps?.[requestingAppId]?.name) || requestingAppId;
        const banner = createEl('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--accent-muted,rgba(88,166,255,0.12));border:1px solid var(--accent);border-radius:8px;margin-bottom:16px;font-size:12.5px;color:var(--text-primary);'
        });
        banner.textContent = requestingName + ' would like to be your default ' + DefaultApps.CATEGORIES[highlightCategory].name + '.';
        mainContent.appendChild(banner);
      }

      const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
      mainContent.appendChild(list);

      function iconFor(iconVal, name) {
        const el = createEl('div', {
          style: 'width:32px;height:32px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;color:var(--accent);'
        });
        if (iconVal && typeof svgIcon === 'function') {
          el.innerHTML = svgIcon(iconVal, 16);
        } else {
          el.style.fontSize = '14px';
          el.style.fontWeight = '700';
          el.textContent = (name || '?').charAt(0).toUpperCase();
        }
        return el;
      }

      // One row per category: icon, category name, current default, Change button.
      // Rows self-refresh after a choice is made — no full section re-render.
      function buildCategoryRow(categoryId, category) {
        const isHighlighted = categoryId === highlightCategory;
        const row = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg-elevated);border:1px solid ' + (isHighlighted ? 'var(--accent)' : 'var(--border)') + ';border-radius:10px;margin-bottom:8px;'
        });

        const left = createEl('div', { style: 'display:flex;align-items:center;gap:12px;' });
        const iconWrap = createEl('div');
        left.appendChild(iconWrap);

        const textWrap = createEl('div');
        textWrap.appendChild(createEl('div', { textContent: category.name, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));
        const currentLabel = createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:2px;' });
        textWrap.appendChild(currentLabel);
        left.appendChild(textWrap);
        row.appendChild(left);

        const changeBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Change' });
        row.appendChild(changeBtn);

        function refreshCurrent() {
          const candidates = DefaultApps.getAppsForCategory(categoryId);
          const chosenId   = DefaultApps.getDefault(categoryId);
          const chosen     = candidates.find(a => a.id === chosenId) || candidates[0] || null;

          iconWrap.replaceChildren();
          iconWrap.appendChild(iconFor(chosen?.icon, chosen?.name));

          if (chosen) {
            currentLabel.textContent = chosen.name + (chosenId ? '' : ' (system default)');
          } else {
            currentLabel.textContent = 'No app available';
          }
          changeBtn.disabled = candidates.length === 0;
          changeBtn.style.opacity = candidates.length === 0 ? '0.5' : '';
        }
        refreshCurrent();

        changeBtn.addEventListener('click', () => openPicker(categoryId, category, refreshCurrent), { signal: lifecycle.signal });

        return row;
      }

      // Picker popup — lists every app that declared support for this category.
      function openPicker(categoryId, category, onChosen) {
        const candidates = DefaultApps.getAppsForCategory(categoryId);
        const currentId  = DefaultApps.getDefault(categoryId);
        const selectedId = currentId || candidates[0]?.id || null;

        const overlay = createEl('div', {
          tabIndex: -1,
          style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;'
        });
        const ac = mountOverlay(overlay);

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;width:360px;max-height:70vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);'
        });

        const header = createEl('div', { style: 'padding:16px 18px 12px;border-bottom:1px solid var(--border-subtle);' });
        header.appendChild(createEl('div', { textContent: 'Default ' + category.name, style: 'font-weight:600;font-size:14px;color:var(--text-primary);' }));
        header.appendChild(createEl('div', { textContent: 'Detected from installed apps that support this type.', style: 'font-size:11.5px;color:var(--text-muted);margin-top:2px;' }));
        card.appendChild(header);

        const body = createEl('div', { style: 'padding:8px;' });

        if (candidates.length === 0) {
          body.appendChild(createEl('div', {
            textContent: 'No installed apps support this category yet.',
            style: 'padding:16px;text-align:center;color:var(--text-muted);font-size:12.5px;'
          }));
        }

        for (const app of candidates) {
          const optRow = createEl('div', {
            role: 'radio',
            tabindex: '0',
            'aria-checked': String(app.id === selectedId),
            style: `display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:8px;cursor:pointer;background:${app.id === selectedId ? 'var(--accent-muted, rgba(59,130,246,0.14))' : 'transparent'};`
          });
          optRow.addEventListener('mouseenter', () => {
            if (app.id !== selectedId) optRow.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))';
          });
          optRow.addEventListener('mouseleave', () => {
            if (app.id !== selectedId) optRow.style.background = 'transparent';
          });

          optRow.appendChild(iconFor(app.icon, app.name));

          optRow.appendChild(createEl('div', { textContent: app.name, style: 'flex:1;font-size:13px;color:var(--text-primary);' }));

          const radio = createEl('div', {
            style: 'width:16px;height:16px;border-radius:50%;border:2px solid ' + (app.id === selectedId ? 'var(--accent)' : 'var(--border)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;'
          });
          if (app.id === selectedId) {
            radio.appendChild(createEl('div', { style: 'width:8px;height:8px;border-radius:50%;background:var(--accent);' }));
          }
          optRow.appendChild(radio);

          const choose = () => {
            try {
              if (!DefaultApps.setDefault(categoryId, app.id)) {
                Notify.show({ title: 'Default App Not Changed', body: 'This app is no longer available for this category.', type: 'error', appName: 'Nook' });
                return;
              }
              dismissOverlay(overlay);
              onChosen();
            } catch (err) {
              Notify.show({ title: 'Default App Not Changed', body: err?.message || 'Could not save the default app.', type: 'error', appName: 'Nook' });
            }
          };
          optRow.addEventListener('click', choose, { signal: ac.signal });
          optRow.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
          }, { signal: ac.signal });

          body.appendChild(optRow);
        }

        const resetRow = createEl('button', {
          type: 'button',
          textContent: 'Use system default',
          style: 'width:100%;text-align:left;padding:10px;border:0;border-radius:8px;background:transparent;color:var(--text-secondary);font-size:12.5px;cursor:pointer;'
        });
        resetRow.addEventListener('click', () => {
          try {
            if (!DefaultApps.setDefault(categoryId, null)) {
              Notify.show({ title: 'Default App Not Changed', body: 'Could not restore the system default.', type: 'error', appName: 'Nook' });
              return;
            }
            dismissOverlay(overlay);
            onChosen();
          } catch (err) {
            Notify.show({ title: 'Default App Not Changed', body: err?.message || 'Could not restore the system default.', type: 'error', appName: 'Nook' });
          }
        }, { signal: ac.signal });
        body.appendChild(resetRow);

        card.appendChild(body);
        overlay.appendChild(card);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) dismissOverlay(overlay);
        }, { signal: ac.signal });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') dismissOverlay(overlay);
        }, { signal: ac.signal });
      }

      for (const [categoryId, category] of Object.entries(DefaultApps.CATEGORIES)) {
        list.appendChild(buildCategoryRow(categoryId, category));
      }
    }

    // Privacy & Security
    function renderPrivacy() {
      mainContent.appendChild(createEl('h2', { textContent: 'Privacy & Security', style: { marginBottom: '20px' } }));

      // Shared-file access audit (from the storage ledger). Shows which apps
      // touched files outside their own sandbox — the Android privacy
      // dashboard equivalent for the shared tree.
      const auditGroup = createEl('div', { className: 'nook-privacy-section' });
      auditGroup.appendChild(createEl('h3', { textContent: 'File Access Audit' }));
      auditGroup.appendChild(createEl('p', {
        textContent: 'Apps reading or writing files outside their own storage (shared files, picked files) are logged here. Entries appear after the access happens.',
        style: { margin: '0 0 8px', opacity: '0.75', fontSize: '12px' },
      }));
      mainContent.appendChild(auditGroup);
      (async () => {
        let snapshot = null;
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.storageLedgerSnapshot) {
            snapshot = await AppSandbox.storageLedgerSnapshot();
          }
        } catch (err) {
          devLog('access audit snapshot failed:', err);
        }
        if (!isAlive()) return;
        const events = snapshot?.accessLog || [];
        if (!events.length) {
          auditGroup.appendChild(createEl('p', {
            textContent: 'No shared-file access recorded. This is good — apps have stayed in their own storage.',
            style: { margin: '0', opacity: '0.65', fontSize: '12px' },
          }));
          return;
        }
        const KIND_LABELS = {
          'shared-file-read': 'Read shared file',
          'shared-file-write': 'Wrote shared file',
          'picked-file-read': 'Read picked file',
          'picked-file-write': 'Wrote picked file',
        };
        for (const ev of events.slice(0, 50)) {
          const appName = (typeof OS !== 'undefined' && OS.apps?.[ev.appId]?.name) || ev.appId;
          const when = new Date(ev.t).toLocaleString();
          const row = createEl('div', { className: 'nook-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } });
          const top = createEl('div', { style: { display: 'flex', justifyContent: 'space-between', width: '100%' } });
          top.appendChild(createEl('span', { className: 'nook-row-label', textContent: appName, title: ev.appId }));
          top.appendChild(createEl('span', { textContent: KIND_LABELS[ev.kind] || ev.kind, style: { opacity: '0.8' } }));
          row.appendChild(top);
          row.appendChild(createEl('div', {
            textContent: (ev.detail || '') + ' · ' + when,
            style: { opacity: '0.65', fontSize: '11px', wordBreak: 'break-all' },
          }));
          auditGroup.appendChild(row);
        }
      })();

      // Security policy (NB-MAC). Shows the mandatory-access-control layer's
      // mode, rule coverage, and the avc denial feed. Settings reads
      // AppSandbox.macPolicySnapshot() directly — trusted host tier; the
      // snapshot is deliberately not reachable over app IPC.
      const macGroup = createEl('div', { className: 'nook-privacy-section' });
      macGroup.appendChild(createEl('h3', { textContent: 'Security Policy (MAC)' }));
      macGroup.appendChild(createEl('p', {
        textContent: 'Every app call passes a mandatory access control check before it reaches a system handler. Enforcing domains are refused unless policy allows; permissive domains are only logged.',
        style: { margin: '0 0 8px', opacity: '0.75', fontSize: '12px' },
      }));
      mainContent.appendChild(macGroup);
      (async () => {
        let snap = null;
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.macPolicySnapshot) {
            snap = await AppSandbox.macPolicySnapshot();
          }
        } catch (err) {
          devLog('mac policy snapshot failed:', err);
        }
        if (!isAlive()) return;
        if (!snap || !snap.info) {
          macGroup.appendChild(createEl('p', {
            textContent: 'Security policy information is unavailable in this session.',
            style: { margin: '0', opacity: '0.65', fontSize: '12px' },
          }));
          return;
        }
        const info = snap.info;
        const modeLabel = (m) => (m === 'enforcing' ? 'Enforcing' : 'Permissive (log only)');
        const statusRow = createEl('div', { className: 'nook-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } });
        statusRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Policy v' + info.policyVersion }));
        statusRow.appendChild(createEl('span', {
          textContent: 'Apps: ' + modeLabel(info.domains?.untrusted_app) + ' · Platform: ' + modeLabel(info.domains?.platform_module),
          style: { opacity: '0.8' },
        }));
        statusRow.appendChild(createEl('div', {
          textContent: info.grantCoupledEndpoints + ' grant-coupled endpoints · ' + info.advisoryEndpoints
            + ' advisory endpoints · ' + info.advisoryFamilies + ' advisory families · '
            + info.neverallow + ' neverallow rules',
          style: { opacity: '0.65', fontSize: '11px' },
        }));
        statusRow.appendChild(createEl('div', {
          textContent: info.denialsToday + ' enforced denial' + (info.denialsToday === 1 ? '' : 's') + ' today'
            + (info.auditDropped ? ' · ' + info.auditDropped + ' audit entries dropped (rate limit)' : ''),
          style: { opacity: '0.65', fontSize: '11px' },
        }));
        macGroup.appendChild(statusRow);
        const denials = snap.denials || [];
        if (!denials.length) {
          macGroup.appendChild(createEl('p', {
            textContent: 'No policy denials recorded. Apps are staying inside their allowed capabilities.',
            style: { margin: '0', opacity: '0.65', fontSize: '12px' },
          }));
          return;
        }
        for (const d of denials.slice(0, 25)) {
          const appName = (typeof OS !== 'undefined' && OS.apps?.[d.appId]?.name) || d.appId || '(unknown)';
          const when = new Date(d.t).toLocaleString();
          const row = createEl('div', { className: 'nook-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' } });
          const top = createEl('div', { style: { display: 'flex', justifyContent: 'space-between', width: '100%' } });
          top.appendChild(createEl('span', { className: 'nook-row-label', textContent: appName, title: d.appId || '' }));
          top.appendChild(createEl('span', {
            textContent: (d.enforced ? 'Denied' : 'Would deny (permissive)') + ' · ' + (d.endpoint || ''),
            style: { opacity: '0.8' },
          }));
          row.appendChild(top);
          row.appendChild(createEl('div', {
            textContent: (d.perms && d.perms.length ? 'requires ' + d.perms.join(' | ') : 'no policy rule') + ' · ' + when,
            style: { opacity: '0.65', fontSize: '11px', wordBreak: 'break-all' },
          }));
          macGroup.appendChild(row);
        }
      })();

      // Data management
      const exportSection = createEl('div', { className: 'nook-privacy-section' });
      exportSection.appendChild(createEl('h3', { textContent: 'Data Management' }));
      const exportActions = createEl('div', { className: 'nook-data-actions' });

      const exportBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Export All Data (JSON)' });
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        const prevLabel = exportBtn.textContent;
        exportBtn.textContent = 'Exporting\u2026';
        try {
          // Pull every real data domain, not just the in-memory settings cache.
          const isLinux = typeof process !== 'undefined' && process.platform === 'linux';
          const settings = systemSettings.exportSnapshot();
          const files = isLinux
            ? await FS.exportNodes()
            : await OS.workers.fs.call('getAllFiles');
          if (!isAlive()) return;

          // localStorage holds per-app data with no shared key prefix —
          // sweep it wholesale (this is a dedicated app window, not a shared origin).
          const localStorageData = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            localStorageData[key] = localStorage.getItem(key);
          }

          const data = {
            settings,
            files,
            localStorage: localStorageData,
            version:    OS.version,
            exportDate: new Date().toISOString()
          };
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url  = URL.createObjectURL(blob);
          const a    = createEl('a', { href: url, download: 'novabyte-export.json' });
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          Notify.show({ title: 'Data Exported', body: 'All data has been exported', type: 'success', appName: 'Nook' });
        } catch (err) {
          Notify.show({ title: 'Export Failed', body: err?.message || 'Could not export data', type: 'error', appName: 'Nook' });
        } finally {
          if (isAlive()) {
            exportBtn.disabled = false;
            exportBtn.textContent = prevLabel;
          }
        }
      }, { signal: lifecycle.signal });
      exportActions.appendChild(exportBtn);

      const importBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Import Data' });
      importBtn.addEventListener('click', async () => {
        try {
          const picked = await SystemDialogs.open({
            title: 'Import Data',
            startPath: (typeof os !== 'undefined' ? os.homedir() : null) || '/home/astroos',
            filter: (name, isDir) => isDir || name.endsWith('.json'),
          });
          if (!picked) return;
          const text = typeof picked.content === 'string' ? picked.content : picked.content.toString('utf8');
          const data = JSON.parse(text);

          const writes = [];
          let skippedSettings = [];
          const isLinux = typeof process !== 'undefined' && process.platform === 'linux';
          if (data.settings && typeof data.settings === 'object') {
            const result = await systemSettings.import(data.settings);
            skippedSettings = result.skipped;
          }
          if (Array.isArray(data.files) && data.files.length) {
            writes.push(isLinux
              ? FS.importNodes(data.files)
              : OS.workers.fs.call('putFiles', data.files));
          }

          // Wait for every fs-backed write to actually land before reporting success
          const results = await Promise.allSettled(writes);
          if (!isAlive()) return;
          const failed = results.some(r => r.status === 'rejected');

          if (data.localStorage && typeof data.localStorage === 'object') {
            for (const [k, v] of Object.entries(data.localStorage)) {
              // Skip machine/session-specific keys that must never be
              // restored from an untrusted file
              if (IMPORT_PROTECTED_KEYS.has(k)) {
                devLog('Skipping protected key during import:', k);
                continue;
              }
              try { localStorage.setItem(k, v); } catch (err) { devLog('localStorage.setItem failed for', k, err); }
            }
          }

          if (!isAlive()) return;
          if (failed || skippedSettings.length) {
            const details = [];
            if (failed) details.push('Some data could not be saved.');
            if (skippedSettings.length) details.push(`${skippedSettings.length} unsupported or protected setting(s) were skipped.`);
            Notify.show({ title: 'Import Incomplete', body: details.join(' '), type: 'error', appName: 'Nook' });
          } else {
            Notify.show({ title: 'Data Imported', body: 'All data has been imported. Restart to apply fully.', type: 'success', appName: 'Nook' });
          }
        } catch (err) {
          devLog('Import failed:', err);
          Notify.show({ title: 'Import Failed', body: err?.message || 'Could not import the selected file', type: 'error', appName: 'Nook' });
        }
      }, { signal: lifecycle.signal });
      exportActions.appendChild(importBtn);
      exportSection.appendChild(exportActions);
      mainContent.appendChild(exportSection);

      // Admin access — controls the server-side admin-state flag that
      // req.user.role derives from. Off by default. Turning this on doesn't
      // itself give any app access; it just makes the machine capable of
      // honoring an admin:*-granted app's requests.
      const adminSection = createEl('div', { className: 'nook-privacy-section' });
      adminSection.appendChild(createEl('h3', { textContent: 'Admin Access' }));
      adminSection.appendChild(createEl('p', {
        textContent: 'Lets apps you\u2019ve granted admin permissions to (audit logs, system settings, sessions) actually use them. Off by default — most people never need this.',
        style: { color: 'var(--text-secondary, #8b949e)', fontSize: '13px', marginBottom: '12px' }
      }));
      const adminRow = createEl('div', { className: 'nook-toggle-row' });
      adminRow.appendChild(createEl('span', { textContent: 'Enable admin mode on this device' }));
      const adminToggle = createEl('button', {
        className: 'toggle',
        role: 'switch',
        'aria-checked': 'false',
        'aria-label': 'Toggle admin mode',
        disabled: true
      });
      adminRow.appendChild(adminToggle);
      adminSection.appendChild(adminRow);
      mainContent.appendChild(adminSection);

      // State lives server-side (not OS.settings/localStorage), so fetch the
      // current value and enable the control once known, rather than flash
      // an incorrect initial state.
      (async () => {
        try {
          const res = await fetch('/api/security/admin-mode');
          const json = await res.json();
          if (!isAlive()) return;
          if (json && json.success) {
            adminToggle.classList.toggle('active', !!json.adminEnabled);
            adminToggle.setAttribute('aria-checked', String(!!json.adminEnabled));
          }
        } catch {
          if (!isAlive()) return;
          // Leave disabled — can't safely toggle a value we couldn't confirm.
          adminSection.appendChild(createEl('p', {
            textContent: 'Could not reach the server to check admin status.',
            style: { color: 'var(--danger, #f85149)', fontSize: '12px', marginTop: '8px' }
          }));
          return;
        }
        if (isAlive()) adminToggle.disabled = false;
      })();

      adminToggle.addEventListener('click', async () => {
        if (adminToggle.disabled) return;
        const next = !adminToggle.classList.contains('active');
        adminToggle.disabled = true;
        try {
          const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
          const res = await fetch('/api/security/admin-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ enabled: next })
          });
          const json = await res.json();
          if (!isAlive()) return;
          if (json && json.success) {
            adminToggle.classList.toggle('active', !!json.adminEnabled);
            adminToggle.setAttribute('aria-checked', String(!!json.adminEnabled));
            Notify.show({
              title: json.adminEnabled ? 'Admin Mode Enabled' : 'Admin Mode Disabled',
              body: json.adminEnabled
                ? 'Apps granted admin permissions can now use them.'
                : 'Admin permission grants are now inert again.',
              type: 'success', appName: 'Nook'
            });
          } else {
            throw new Error(json?.message || 'Request failed');
          }
        } catch (err) {
          if (!isAlive()) return;
          Notify.show({ title: 'Could Not Update Admin Mode', body: err?.message || 'Try again', type: 'error', appName: 'Nook' });
        } finally {
          if (isAlive()) adminToggle.disabled = false;
        }
      }, { signal: lifecycle.signal });
    }

    function renderRootAccess() {
      mainContent.appendChild(createEl('h2', { textContent: 'Root Access', style: { marginBottom: '8px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Root apps run directly in the OS page with unrestricted access and can perform real administrator (root) operations. Every root app first asks for your confirmation inside a AstroOS prompt — never inside the app — and every privileged operation runs through audited, passwordless sudo (NOPASSWD) and is written to the security log. This is not a sandbox or a normal app permission.',
        style: { color: 'var(--text-secondary, #8b949e)', fontSize: '13px', lineHeight: '1.55', marginBottom: '18px' }
      }));

      const devMode = systemSettings.get('devMode') === true;
      const rootEnabled = systemSettings.get('rootAccessEnabled') === true;
      const masterGroup = createEl('div', { className: 'nook-group' });
      masterGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Root mode' }));

      if (!devMode) {
        masterGroup.appendChild(createEl('p', {
          textContent: 'Enable Developer Mode before Root Access can be turned on.',
          style: { color: 'var(--text-warning, #d29922)', fontSize: '13px', margin: '0' }
        }));
      } else {
        const masterRow = createEl('div', { className: 'nook-toggle-row' });
        masterRow.appendChild(createEl('span', { textContent: 'Enable Root Access for this device' }));
        const masterToggle = createEl('button', {
          className: 'toggle' + (rootEnabled ? ' active' : ''),
          role: 'switch',
          'aria-checked': String(rootEnabled),
          'aria-label': 'Enable Root Access'
        });
        masterToggle.addEventListener('click', async () => {
          const enable = !systemSettings.get('rootAccessEnabled');
          if (enable && await showRootModeWarning() !== 'confirm') return;
          if (!isAlive()) return;
          window.AstroOSSystem.developer.setRootAccess(enable);
          masterToggle.classList.toggle('active', enable);
          masterToggle.setAttribute('aria-checked', String(enable));
          Notify.show({
            title: enable ? 'Root Access Enabled' : 'Root Access Disabled',
            body: enable
              ? 'Apps still need an individual root grant before they run in the OS page.'
              : 'Root grants are inactive until Root Access is enabled again.',
            type: enable ? 'warn' : 'info',
            appName: 'Settings'
          });
          if (!enable && typeof AppSandbox !== 'undefined'
            && AppSandbox.reloadAfterRootRevocation?.('Root Access was disabled')) return;
          renderContent();
        }, { signal: lifecycle.signal });
        masterRow.appendChild(masterToggle);
        masterGroup.appendChild(masterRow);
      }
      mainContent.appendChild(masterGroup);

      // Active root session (NovaRoot broker) — polkit-style session indicator.
      try {
        const ns = window.NovaRoot;
        if (ns && typeof ns.status === 'function') {
          const st = ns.status();
          const sessGroup = createEl('div', { className: 'nook-group' });
          sessGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Root session' }));
          const sessRow = createEl('div', { className: 'nook-toggle-row' });
          sessRow.appendChild(createEl('span', {
            textContent: st.sessionActive
              ? 'Active — privileged operations are authorized until the session expires.'
              : 'No active root session. Root apps ask for your confirmation in a AstroOS prompt when they need it.'
          }));
          if (st.sessionActive) {
            const endBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'End session' });
            endBtn.addEventListener('click', async () => {
              try { await window.NovaRoot.endSession(); } catch (error) {
                console.warn('[Settings] Ending root session failed:', error);
              }
              Notify.show({
                title: 'Root session ended',
                body: 'Cached root authorization was invalidated. Apps will ask again.',
                type: 'info',
                appName: 'Settings'
              });
              renderContent();
            }, { signal: lifecycle.signal });
            sessRow.appendChild(endBtn);
          }
          sessGroup.appendChild(sessRow);
          mainContent.appendChild(sessGroup);
        }
      } catch (error) {
        console.warn('[Settings] NovaRoot status unavailable:', error);
      }

      if (!devMode || !rootEnabled) {
        mainContent.appendChild(createEl('div', {
          className: 'empty-state',
          textContent: !devMode
            ? 'Root execution is disabled until Developer Mode and Root Access are both enabled.'
            : 'Root execution is disabled. Turn on Root Access to manage root-enabled apps and activity.'
        }));
        return;
      }

      const rootAppsById = new Map();
      for (const app of (typeof AppRegistry !== 'undefined' ? AppRegistry.getAllApps() : [])) {
        if (app?.id) rootAppsById.set(app.id, app);
      }
      try {
        const installedPackages = (window.NovaAppPackageStore?.loadRegistry?.()) ?? JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
        if (Array.isArray(installedPackages)) {
          for (const app of installedPackages) {
            if (app?.id && !rootAppsById.has(app.id)) rootAppsById.set(app.id, app);
          }
        }
      } catch (error) {
        console.error('[Settings] Could not read installed packages for Root Access:', error);
      }
      const rootApps = [...rootAppsById.values()].filter(app => {
        const declared = [
          ...(Array.isArray(app.permissions) ? app.permissions : []),
          ...(Array.isArray(app.manifest?.permissions) ? app.manifest.permissions : [])
        ].includes('system:root');
        const granted = AppPermissionManager.getAppPermissions(app.id)
          .some(grant => grant.permission === 'system:root' && grant.granted === true);
        return declared || granted;
      });
      const appGroup = createEl('div', { className: 'nook-group' });
      appGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Apps requesting root access' }));
      if (!rootApps.length) {
        appGroup.appendChild(createEl('p', {
          textContent: 'No installed apps request or currently have a root access grant.',
          style: { color: 'var(--text-secondary, #8b949e)', fontSize: '13px', margin: '0' }
        }));
      }
      for (const app of rootApps) {
        const row = createEl('div', { className: 'nook-toggle-row' });
        const details = createEl('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
        details.appendChild(createEl('span', { textContent: app.name || app.id }));
        details.appendChild(createEl('span', {
          textContent: app.id,
          style: { color: 'var(--text-secondary, #8b949e)', fontSize: '11px' }
        }));
        const rootGrant = AppPermissionManager.getAppPermissions(app.id)
          .find(grant => grant.permission === 'system:root' && grant.granted === true);
        const granted = !!rootGrant;
        const toggle = createEl('button', {
          className: 'toggle' + (granted ? ' active' : ''),
          role: 'switch',
          'aria-checked': String(granted),
          'aria-label': `Root access for ${app.name || app.id}`,
          disabled: !granted && (!devMode || !rootEnabled)
        });
        toggle.addEventListener('click', async () => {
          toggle.disabled = true;
          try {
            const existingGrant = AppPermissionManager.getAppPermissions(app.id)
              .some(grant => grant.permission === 'system:root' && grant.granted === true);
            if (existingGrant) {
              await AppPermissionManager.revokePermission('system:root', app.id);
              Notify.show({ title: 'Root Access Revoked', body: `${app.name} can no longer launch with root access.`, type: 'success', appName: 'Settings' });
              if (typeof AppSandbox !== 'undefined'
                && AppSandbox.reloadAfterRootRevocation?.(`Root access for ${app.id} was revoked`)) return;
            } else {
              if (!devMode || !rootEnabled) return;
              const grantedNow = await AppPermissionManager.requestPermission('system:root', app.id, { appName: app.name });
              if (!grantedNow) return;
            }
          } catch (err) {
            Notify.show({ title: 'Could Not Update Root Access', body: err?.message || 'Try again.', type: 'error', appName: 'Settings' });
          } finally {
            if (isAlive()) renderContent();
          }
        }, { signal: lifecycle.signal });
        row.append(details, toggle);
        appGroup.appendChild(row);
      }
      mainContent.appendChild(appGroup);

      const auditGroup = createEl('div', { className: 'nook-group' });
      auditGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Root API audit log' }));
      auditGroup.appendChild(createEl('p', {
        textContent: 'Up to 1,000 recent calls are retained; the latest 100 are displayed here. This is not a complete record of direct JavaScript or browser activity, and root apps may alter same-origin logs.',
        style: { color: 'var(--text-secondary, #8b949e)', fontSize: '12px', lineHeight: '1.5' }
      }));
      const auditEntries = (typeof AppSandbox !== 'undefined' ? AppSandbox.getRootAuditLog?.() || [] : []).slice(0, 100);
      if (!auditEntries.length) {
        auditGroup.appendChild(createEl('p', {
          textContent: 'No root activity has been recorded.',
          style: { color: 'var(--text-secondary, #8b949e)', fontSize: '12px', margin: '0' }
        }));
      } else {
        for (const entry of auditEntries) {
          const item = createEl('div', { className: 'nook-row' });
          const when = new Date(entry.timestamp).toLocaleString();
          item.appendChild(createEl('span', {
            textContent: `${when} — ${entry.appName || entry.appId}: ${entry.api}`,
            style: { fontSize: '12px', lineHeight: '1.45', overflowWrap: 'anywhere' }
          }));
          auditGroup.appendChild(item);
        }
      }
      mainContent.appendChild(auditGroup);
    }

    function showRootModeWarning() {
      return new Promise(resolve => {
        const overlay = createEl('div', {
          style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;'
        });
        const ac = mountOverlay(overlay);
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          dismissOverlay(overlay);
          resolve(value);
        };
        ac.signal.addEventListener('abort', () => finish(null));
        const card = createEl('div', {
          style: 'background:var(--bg-elevated,#1b1f23);border:2px solid var(--text-danger,#f85149);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.65);padding:24px;max-width:540px;width:100%;'
        });
        card.appendChild(createEl('h2', {
          textContent: 'Enable Root Access?',
          style: { color: 'var(--text-danger, #f85149)', margin: '0 0 12px' }
        }));
        card.appendChild(createEl('p', {
          textContent: 'This allows individually approved .novaapp packages to execute JavaScript in the OS page instead of their sandbox. A root app can read and change OS data, manipulate system UI, and interfere with other apps.',
          style: { color: 'var(--text-secondary, #c9d1d9)', fontSize: '13px', lineHeight: '1.55' }
        }));
        card.appendChild(createEl('p', {
          textContent: 'Root API calls are logged, but arbitrary JavaScript and browser activity cannot be fully observed. Only enable this on a development device and grant root only to apps you trust.',
          style: { color: 'var(--text-danger, #ff7b72)', fontSize: '13px', lineHeight: '1.55' }
        }));
        const actions = createEl('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' } });
        const cancel = createEl('button', { className: 'btn', textContent: 'Cancel' });
        const enable = createEl('button', { className: 'btn btn-danger', textContent: 'Enable Root Access' });
        actions.append(cancel, enable);
        card.appendChild(actions);
        overlay.appendChild(card);
        overlay.addEventListener('click', event => {
          if (event.target === overlay || event.target === cancel) finish(null);
          else if (event.target === enable) finish('confirm');
        }, { signal: ac.signal });
        enable.focus();
      });
    }

    // Shortcuts
    function renderShortcuts() {
      mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts', style: { marginBottom: '20px' } }));
      const thirdPartyHomeApp = getThirdPartyHomeApp();
      if (thirdPartyHomeApp) mainContent.appendChild(createThirdPartyLauncherNotice(thirdPartyHomeApp));

      const searchWrapper = createEl('div', { className: 'nook-shortcuts-search' });
      const search        = createEl('input', { id: 'shortcuts-search-input', name: 'shortcuts-search', placeholder: 'Search shortcuts...', type: 'search' });
      searchWrapper.appendChild(search);
      mainContent.appendChild(searchWrapper);

      const table = createEl('table', { className: 'nook-shortcuts-table' });
      const thead = createEl('thead');
      const hRow  = createEl('tr');
      for (const text of ['Action', 'Shortcut', '']) hRow.appendChild(createEl('th', { textContent: text }));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = createEl('tbody');

      // Parse custom shortcuts once — corrupt storage no longer crashes.
      // Registry-backed (HKNU/shell/shortcuts) via RegistryPrefs.
      let customShortcuts;
      try { customShortcuts = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.shortcuts) ? RegistryPrefs.shortcuts() : {}; }
      catch (err) { devLog('custom shortcuts read failed:', err); customShortcuts = {}; }

      function captureKeyBinding(action) {
        return new Promise(resolve => {
          const overlay = createEl('div', {
            tabIndex: -1,
            style: 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;outline:none'
          });
          const ac = mountOverlay(overlay);
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            dismissOverlay(overlay);
            resolve(value);
          };
          ac.signal.addEventListener('abort', () => finish(null));

          const msg      = createEl('div', { style: 'background:var(--bg-elevated);padding:30px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)' });
          const title    = createEl('h3', { style: 'margin-bottom:15px;color:var(--text-primary)', textContent: 'Rebind: ' + action });
          const subtitle = createEl('p',   { textContent: 'Press any key combination...', style: 'color:var(--text-secondary);margin-bottom:20px' });
          const captureEl = createEl('div', {
            textContent: 'Waiting...',
            style: 'font-family:var(--font-mono);font-size:18px;padding:10px 20px;background:var(--bg-sunken);border-radius:6px;color:var(--accent)'
          });
          msg.append(title, subtitle, captureEl);
          overlay.appendChild(msg);

          function keyHandler(e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { finish(null); return; }
            const parts = [];
            if (e.ctrlKey)  parts.push('Ctrl');
            if (e.altKey)   parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey)  parts.push('Win');
            if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
              parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
            }
            if (parts.length > 0) {
              captureEl.textContent = parts.join('+');
              setTimeout(() => finish(parts.join('+')), 400);
            }
          }

          overlay.addEventListener('keydown', keyHandler, true);
          overlay.style.cursor = 'wait';
          requestAnimationFrame(() => overlay.focus());
        });
      }

      // Build rows and cache their text for fast search filtering
      const rows = [];
      const rowTexts = [];

      for (const s of SHORTCUTS_LIST) {
        const row      = createEl('tr');
        const actionTd = createEl('td', { textContent: s.action });
        const keyTd  = createEl('td');
        const keySpan = createEl('span', { className: 'nook-shortcut-key', textContent: customShortcuts[s.action] || s.key });
        keyTd.appendChild(keySpan);
        const rebindTd = createEl('td');
        const btn = createEl('button', { className: 'btn btn-sm nook-rebind-btn', textContent: 'Rebind' });
        const launcherOnlyShortcut = ['Open Launchpad', 'Show Desktop'].includes(s.action);
        if (thirdPartyHomeApp && launcherOnlyShortcut) {
          btn.disabled = true;
          row.style.opacity = '0.55';
          row.setAttribute('aria-disabled', 'true');
        }
        btn.addEventListener('click', async () => {
          const newKey = await captureKeyBinding(s.action);
          if (!isAlive()) return;
          if (newKey) {
            customShortcuts[s.action] = newKey;
            try { if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setShortcuts) RegistryPrefs.setShortcuts(customShortcuts); } catch (err) { devLog('shortcut save failed:', err); }
            keySpan.textContent = newKey;
            // Update cached search text so the new binding is findable
            const idx = rows.indexOf(row);
            if (idx !== -1) rowTexts[idx] = (s.action + ' ' + newKey).toLowerCase();
          }
        }, { signal: lifecycle.signal });
        rebindTd.appendChild(btn);
        row.append(actionTd, keyTd, rebindTd);
        tbody.appendChild(row);
        rows.push(row);
        rowTexts.push((s.action + ' ' + (customShortcuts[s.action] || s.key)).toLowerCase());
      }

      table.appendChild(tbody);
      mainContent.appendChild(table);

      // Search — uses cached text instead of re-reading textContent per keystroke
      search.addEventListener('input', () => {
        const query = search.value.toLowerCase();
        for (let i = 0; i < rows.length; i++) {
          rows[i].style.display = rowTexts[i].includes(query) ? '' : 'none';
        }
      }, { signal: lifecycle.signal });
    }

    // About
    // About — the redesigned About page from the previous AstroOS release
    // (centered hero, organised cards with Material icon headers, and the
    // Asteroid Dodger easter egg), merged with the richer hardware and
    // environment data the current platform exposes.
    function renderAbout() {
      mainContent.style.padding = '0';
      const body = createEl('div', { style: 'padding:20px 24px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;flex:1;' });

      const linuxInfo = {
        distribution: 'Not running on Linux',
        kernel: 'Unavailable',
        architecture: 'Unavailable'
      };
      if (typeof process !== 'undefined' && process.platform === 'linux') {
        try {
          const os = require('os');
          const fs = require('fs');
          linuxInfo.kernel = os.release();
          linuxInfo.architecture = os.arch();
          linuxInfo.distribution = 'AstroOS (Buildroot)';
          const releaseFile = fs.readFileSync('/etc/os-release', 'utf8');
          const prettyName = releaseFile.match(/^PRETTY_NAME=(.*)$/m)?.[1];
          if (prettyName) {
            linuxInfo.distribution = prettyName.replace(/^["']|["']$/g, '');
          }
        } catch (error) {
          console.warn('[Settings] Could not read Linux release details:', error);
        }
      }

      // ── helpers ──────────────────────────────────────────────────────────
      function mkCard(title, iconName) {
        const wrap = createEl('div', { style: 'background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;' });
        const hdr = createEl('div', { style: 'padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px;' });
        hdr.innerHTML = '<span class="material-symbols-rounded" style="font-size:15px;color:#4dd0e1;font-variation-settings:\'FILL\' 1,\'wght\' 400,\'GRAD\' 0,\'opsz\' 24;">' + iconName + '</span>';
        hdr.appendChild(createEl('span', { textContent: title, style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.4);' }));
        const rows = createEl('div', { style: 'padding:0 16px;' });
        wrap.append(hdr, rows);
        return { wrap, rows };
      }

      function mkRow(label, value, last) {
        const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;' + (last ? '' : 'border-bottom:1px solid rgba(255,255,255,0.05);') });
        row.appendChild(createEl('span', { textContent: label, style: 'color:rgba(255,255,255,0.5);' }));
        const val = createEl('span', { textContent: value, style: 'color:rgba(255,255,255,0.9);font-weight:500;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
        row.appendChild(val);
        return row;
      }

      // ── HERO ─────────────────────────────────────────────────────────────
      const hero = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;padding:28px 16px 20px;text-align:center;gap:10px;' });

      // Hexagon logo
      const logoWrap = createEl('div', { style: 'width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,#0a84ff 0%,#5e5ce6 50%,#bf5af2 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(94,92,230,0.45),0 2px 8px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.2);margin-bottom:4px;' });
      logoWrap.innerHTML = '<svg viewBox="0 0 80 80" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><polygon points="40,6 68,22 68,58 40,74 12,58 12,22" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2.5"/><polygon points="40,16 60,28 60,52 40,64 20,52 20,28" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.5"/><circle cx="40" cy="40" r="6" fill="white" opacity="0.9"/><line x1="40" y1="6" x2="40" y2="16" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="68" y1="22" x2="60" y2="28" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="68" y1="58" x2="60" y2="52" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="40" y1="74" x2="40" y2="64" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="12" y1="58" x2="20" y2="52" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><line x1="12" y1="22" x2="20" y2="28" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/></svg>';

      const osName = createEl('div', { style: 'font-size:26px;font-weight:800;letter-spacing:-0.5px;background:linear-gradient(130deg,#ffffff 30%,#bf5af2 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;' });
      osName.textContent = 'AstroOS';

      const verPill = createEl('div', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(94,92,230,0.18);border:1px solid rgba(94,92,230,0.4);border-radius:20px;padding:3px 14px;font-size:11px;font-weight:700;color:#a39df5;' });
      verPill.textContent = 'AstroOS v' + OS.version + ' \u00B7 NovaByte v' + OS.version;

      const tagline = createEl('div', { style: 'font-size:11px;color:rgba(255,255,255,0.3);font-style:italic;' });
      tagline.textContent = '\u201CExplore beyond limits.\u201D';

      hero.append(logoWrap, osName, verPill, tagline);
      body.appendChild(hero);

      // ── CARD 1: SOFTWARE ──────────────────────────────────────────────────
      const { wrap: swWrap, rows: swRows } = mkCard('Software', 'deployed_code');

      // Build number row — tap 7x for Asteroid Dodger
      const buildRow = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;border-radius:14px;transition:background 0.15s;user-select:none;' });
      buildRow.appendChild(createEl('span', { textContent: 'Build number', style: 'color:rgba(255,255,255,0.5);' }));
      const buildRight = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
      const buildVal = createEl('span', { textContent: 'astro-' + OS.version + '-stable', style: 'color:rgba(255,255,255,0.9);font-weight:500;font-family:monospace;font-size:11.5px;' });
      const buildHint = createEl('span', { textContent: '', style: 'font-size:10px;color:#4dd0e1;min-width:60px;text-align:right;transition:opacity 0.2s;' });
      buildRight.append(buildVal, buildHint);
      buildRow.appendChild(buildRight);

      let _tapCount = 0, _tapTimer = null;
      buildRow.addEventListener('mouseenter', () => { buildRow.style.background = 'rgba(77,208,225,0.06)'; buildRow.style.paddingLeft = '6px'; buildRow.style.paddingRight = '6px'; }, { signal: lifecycle.signal });
      buildRow.addEventListener('mouseleave', () => { buildRow.style.background = 'transparent'; buildRow.style.paddingLeft = ''; buildRow.style.paddingRight = ''; }, { signal: lifecycle.signal });
      buildRow.addEventListener('click', () => {
        _tapCount++;
        const left = 7 - _tapCount;
        if (_tapCount >= 7) {
          _tapCount = 0;
          clearTimeout(_tapTimer);
          buildHint.textContent = '';
          launchAsteroidGame();
          return;
        }
        buildHint.textContent = left + ' tap' + (left === 1 ? '' : 's') + ' left';
        clearTimeout(_tapTimer);
        _tapTimer = setTimeout(() => { _tapCount = 0; buildHint.textContent = ''; }, 2000);
      }, { signal: lifecycle.signal });

      swRows.appendChild(buildRow);

      // AstroOS version row
      swRows.appendChild(mkRow('AstroOS version', 'v' + OS.version, false));
      // NovaByte base version row
      swRows.appendChild(mkRow('NovaByte base', 'v' + OS.version, false));

      // Platform rows (from the current platform: real OS image details)
      swRows.appendChild(mkRow('Operating System', linuxInfo.distribution, false));
      swRows.appendChild(mkRow('Linux Kernel', linuxInfo.kernel, false));
      swRows.appendChild(mkRow('Architecture', linuxInfo.architecture, false));
      swRows.appendChild(mkRow('Source Date', '2026-11-04', false));

      // Security patch row
      const patchRow = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;font-size:12.5px;' });
      patchRow.appendChild(createEl('span', { textContent: 'Security patch level', style: 'color:rgba(255,255,255,0.5);' }));
      const patchBadge = createEl('span', { style: 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.3);border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;color:#3fb950;' });
      patchBadge.textContent = '\uD83D\uDD12 2026-08-02';
      patchRow.appendChild(patchBadge);
      swRows.appendChild(patchRow);

      body.appendChild(swWrap);

      // ── CARD 2: DEVICE ────────────────────────────────────────────────────
      const { wrap: hwWrap, rows: hwRows } = mkCard('Device', 'devices');
      const hardware = window.AstroOSSystem.hardware.getInventory();
      const graphicsSummary = hardware.supported
        ? hardware.graphics.map(device => [device.vendor, device.driver].filter(Boolean).join(' ')).filter(Boolean).join(', ') || 'No graphics device reported'
        : 'Unavailable';
      const uptimeSec = Math.floor(performance.now() / 1000);
      const uptimeStr = uptimeSec < 60 ? uptimeSec + 's'
        : uptimeSec < 3600 ? Math.floor(uptimeSec / 60) + 'm ' + (uptimeSec % 60) + 's'
          : Math.floor(uptimeSec / 3600) + 'h ' + Math.floor((uptimeSec % 3600) / 60) + 'm';
      [
        ['Screen', hardware.display?.resolution
          ? hardware.display.resolution.width + ' \u00D7 ' + hardware.display.resolution.height
          : screen.width + ' \u00D7 ' + screen.height],
        ['Pixel ratio', window.devicePixelRatio + '\u00D7'],
        ['CPU cores', String(hardware.cpu?.logicalCores || navigator.hardwareConcurrency || 'Unknown')],
        ['Graphics device', graphicsSummary],
        ['Virtualization', hardware.virtualization?.vendor || 'Not identified'],
        ['VMware Tools', hardware.vmwareTools?.running ? 'Running' : hardware.vmwareTools?.installed ? 'Installed, not running' : 'Not detected'],
        ['Device memory', hardware.memory?.totalBytes
          ? (hardware.memory.totalBytes / (1024 ** 3)).toFixed(1) + ' GB'
          : navigator.deviceMemory ? navigator.deviceMemory + ' GB (est.)' : 'Not reported'],
        ['Session uptime', uptimeStr],
      ].forEach(([l, v], i, a) => hwRows.appendChild(mkRow(l, v, i === a.length - 1)));
      body.appendChild(hwWrap);

      // ── CARD 3: ENVIRONMENT ───────────────────────────────────────────────
      const { wrap: envWrap, rows: envRows } = mkCard('Environment', 'language');
      let tz = 'Unknown';
      try { tz = systemSettings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
      [
        ['Language', systemSettings.get('region') || navigator.language],
        ['Timezone', tz],
        ['Do Not Track', navigator.doNotTrack === '1' ? 'On \u2713' : 'Off'],
        ['Cookies', navigator.cookieEnabled ? 'Enabled \u2713' : 'Disabled'],
        ['Service Workers', ('serviceWorker' in navigator) ? 'Supported \u2713' : 'Not supported'],
      ].forEach(([l, v], i, a) => envRows.appendChild(mkRow(l, v, i === a.length - 1)));
      body.appendChild(envWrap);

      // ── CARD 4: LEGAL ─────────────────────────────────────────────────────
      const { wrap: lgWrap, rows: lgRows } = mkCard('Legal', 'gavel');
      [
        ['Licence', 'MIT'],
        ['NBOSP base licence', 'Apache 2.0'],
        ['Copyright', '\u00A9 2026 jameswilloton230-ops'],
        ['Telemetry', 'Zero. None. Zilch.'],
      ].forEach(([l, v], i, a) => lgRows.appendChild(mkRow(l, v, i === a.length - 1)));
      body.appendChild(lgWrap);

      // ── Copy button ───────────────────────────────────────────────────────
      const copyBtn = createEl('button', { className: 'btn btn-sm', style: 'align-self:flex-start;display:flex;align-items:center;gap:6px;' });
      copyBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px;">content_copy</span> Copy system info';
      copyBtn.addEventListener('click', () => {
        let tzCopy = 'Unknown';
        try { tzCopy = systemSettings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
        const lines = [
          'AstroOS v' + OS.version + ' (based on NovaByte v' + OS.version + ')',
          'Build: astro-' + OS.version + '-stable',
          'Security patch: 2026-08-02',
          'Operating System: ' + linuxInfo.distribution,
          'Linux Kernel: ' + linuxInfo.kernel,
          'Architecture: ' + linuxInfo.architecture,
          'Screen: ' + screen.width + '\u00D7' + screen.height,
          'CPU cores: ' + (hardware.cpu?.logicalCores || navigator.hardwareConcurrency || 'Unknown'),
          'Graphics: ' + graphicsSummary,
          'Language: ' + (systemSettings.get('region') || navigator.language),
          'Timezone: ' + tzCopy,
        ];
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(lines.join('\n')).then(
            () => Notify.show({ title: 'Copied', body: 'System info copied to clipboard', type: 'success', appName: 'Settings' }),
            (err) => { devLog('clipboard.writeText failed:', err); Notify.show({ title: 'Copy Failed', body: 'Clipboard not available', type: 'error', appName: 'Settings' }); }
          );
        } else {
          Notify.show({ title: 'Copy Failed', body: 'Clipboard not available', type: 'error', appName: 'Settings' });
        }
      }, { signal: lifecycle.signal });
      body.appendChild(copyBtn);
      mainContent.appendChild(body);
            // ── ASTEROID DODGER ───────────────────────────────────────────────────
            function launchAsteroidGame() {
              const overlay = createEl('div', { style: 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);' });

              const panel = createEl('div', { style: 'background:#0a0a1a;border:1px solid rgba(94,92,230,0.4);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:20px;gap:12px;box-shadow:0 24px 80px rgba(0,0,0,0.8),0 0 40px rgba(94,92,230,0.2);' });

              const titleRow = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;width:100%;' });
              titleRow.appendChild(createEl('div', { textContent: '\u2604\uFE0F Asteroid Dodger', style: 'font-size:15px;font-weight:700;color:#fff;letter-spacing:0.5px;' }));

              const scoreEl = createEl('div', { textContent: 'Score: 0', style: 'font-size:12px;color:#a39df5;font-weight:600;' });
              titleRow.appendChild(scoreEl);
              panel.appendChild(titleRow);

              const canvas = createEl('canvas');
              canvas.width = 320;
              canvas.height = 420;
              canvas.style.cssText = 'border-radius:12px;border:1px solid rgba(255,255,255,0.08);display:block;cursor:none;';
              panel.appendChild(canvas);

              const hint = createEl('div', { textContent: 'Move mouse or use \u2190\u2192 arrow keys to dodge', style: 'font-size:10.5px;color:rgba(255,255,255,0.35);' });
              panel.appendChild(hint);

              const closeBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Close', style: 'margin-top:4px;' });
              closeBtn.addEventListener('click', () => overlay.remove());
              panel.appendChild(closeBtn);

              overlay.appendChild(panel);
              document.body.appendChild(overlay);

              const ctx = canvas.getContext('2d');
              const W = canvas.width, H = canvas.height;

              // Stars background
              const stars = Array.from({ length: 80 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.5 + 0.3, spd: Math.random() * 0.4 + 0.1 }));

              // Ship
              const ship = { x: W / 2, y: H - 60, w: 22, h: 30, speed: 0, vx: 0 };
              const keys = {};
              let asteroids = [], particles = [], score = 0, lives = 3, gameOver = false, frame = 0, spawnRate = 80;

              function spawnAsteroid() {
                const sz = 14 + Math.random() * 18;
                asteroids.push({ x: sz + Math.random() * (W - sz * 2), y: -sz, r: sz, vy: 1.2 + Math.random() * 1.5 + score * 0.003, vx: (Math.random() - 0.5) * 1.2, rot: 0, rotSpd: (Math.random() - 0.5) * 0.06, sides: 6 + Math.floor(Math.random() * 3), color: ['#a39df5', '#4dd0e1', '#bf5af2', '#ff453a'][Math.floor(Math.random() * 4)] });
              }

              function spawnParticles(x, y, color) {
                for (let i = 0; i < 12; i++) {
                  const a = (Math.PI * 2 / 12) * i + Math.random() * 0.5;
                  const spd = 2 + Math.random() * 3;
                  particles.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, life: 1, color });
                }
              }

              function drawShip(x, y) {
                ctx.save();
                ctx.translate(x, y);
                // Engine glow
                ctx.shadowBlur = 18; ctx.shadowColor = '#5e5ce6';
                ctx.fillStyle = 'rgba(94,92,230,0.5)';
                ctx.beginPath(); ctx.ellipse(0, 14, 5, 8, 0, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;
                // Body
                ctx.fillStyle = '#e0e0ff';
                ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(11, 12); ctx.lineTo(0, 8); ctx.lineTo(-11, 12); ctx.closePath(); ctx.fill();
                // Cockpit
                ctx.fillStyle = '#4dd0e1';
                ctx.beginPath(); ctx.ellipse(0, -4, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
                // Wings accent
                ctx.fillStyle = '#a39df5';
                ctx.beginPath(); ctx.moveTo(-11, 12); ctx.lineTo(-16, 16); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(11, 12); ctx.lineTo(16, 16); ctx.lineTo(8, 10); ctx.closePath(); ctx.fill();
                ctx.restore();
              }

              function drawAsteroid(a) {
                ctx.save();
                ctx.translate(a.x, a.y);
                ctx.rotate(a.rot);
                ctx.strokeStyle = a.color;
                ctx.lineWidth = 2;
                ctx.shadowBlur = 8; ctx.shadowColor = a.color;
                ctx.beginPath();
                for (let i = 0; i < a.sides; i++) {
                  const ang = (Math.PI * 2 / a.sides) * i;
                  const jitter = a.r * (0.78 + Math.random() * 0.0); // stable shape
                  const px = Math.cos(ang) * a.r * (0.8 + ((i * 7) % 5) * 0.06);
                  const py = Math.sin(ang) * a.r * (0.8 + ((i * 5) % 4) * 0.07);
                  i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
                }
                ctx.closePath(); ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.restore();
              }

              // Input
              window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey);
              function onKey(e) { keys[e.code] = e.type === 'keydown'; }

              canvas.addEventListener('mousemove', (e) => {
                const rect = canvas.getBoundingClientRect();
                ship.x = Math.max(ship.w, Math.min(W - ship.w, e.clientX - rect.left));
              });

              function loop() {
                if (!document.body.contains(overlay)) { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); return; }
                requestAnimationFrame(loop);
                frame++;

                // Stars
                ctx.fillStyle = '#040410';
                ctx.fillRect(0, 0, W, H);
                stars.forEach(s => {
                  s.y = (s.y + s.spd) % H;
                  ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + s.r * 0.3) + ')';
                  ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
                });

                if (gameOver) {
                  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H);
                  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px system-ui'; ctx.textAlign = 'center';
                  ctx.fillText('GAME OVER', W / 2, H / 2 - 30);
                  ctx.font = '14px system-ui'; ctx.fillStyle = '#a39df5';
                  ctx.fillText('Score: ' + score, W / 2, H / 2);
                  ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '12px system-ui';
                  ctx.fillText('Close and tap build number again to replay', W / 2, H / 2 + 30);
                  return;
                }

                // Keyboard movement
                if (keys['ArrowLeft']) ship.vx = Math.max(ship.vx - 0.8, -5);
                else if (keys['ArrowRight']) ship.vx = Math.min(ship.vx + 0.8, 5);
                else ship.vx *= 0.85;
                ship.x = Math.max(ship.w, Math.min(W - ship.w, ship.x + ship.vx));

                // Spawn
                if (frame % Math.max(25, spawnRate - Math.floor(score / 8)) === 0) spawnAsteroid();
                score = Math.floor(frame / 6);
                scoreEl.textContent = 'Score: ' + score;
                spawnRate = Math.max(28, 80 - Math.floor(score / 5));

                // Asteroids
                asteroids = asteroids.filter(a => a.y - a.r < H + 20);
                asteroids.forEach(a => {
                  a.x += a.vx; a.y += a.vy; a.rot += a.rotSpd;
                  drawAsteroid(a);
                  // Collision
                  const dx = a.x - ship.x, dy = a.y - ship.y;
                  if (Math.sqrt(dx * dx + dy * dy) < a.r * 0.7 + 10) {
                    spawnParticles(ship.x, ship.y, '#ff453a');
                    a.y = H + 100; lives--;
                    if (lives <= 0) gameOver = true;
                  }
                });

                // Particles
                particles = particles.filter(p => p.life > 0);
                particles.forEach(p => {
                  p.x += p.vx; p.y += p.vy; p.life -= 0.04; p.vy += 0.08;
                  ctx.globalAlpha = p.life;
                  ctx.fillStyle = p.color;
                  ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
                  ctx.globalAlpha = 1;
                });

                // Ship
                drawShip(ship.x, ship.y);

                // Lives
                for (let i = 0; i < 3; i++) {
                  ctx.globalAlpha = i < lives ? 1 : 0.18;
                  ctx.fillStyle = '#ff453a';
                  ctx.font = '14px system-ui';
                  ctx.fillText('\u2665', 8 + i * 20, 22);
                }
                ctx.globalAlpha = 1;
              }

              loop();
            }
    }

    // Bootstrap
    container.append(sidebar, mainContent);
    content.appendChild(container);

    buildSidebar();
    renderContent();

    // Re-render when relevant settings change elsewhere in the system.
    // Guarded with isAlive() so the handler is a no-op once this window
    // is closed (the listener itself is removed by the returned cleanup).
    if (typeof OS !== 'undefined' && OS.events && typeof OS.events.on === 'function') {
      const settingsHandler = ({ key }) => {
        if (!isAlive()) return;
        if (key === 'devMode' && ['apps', 'root'].includes(currentSection)) renderContent();
        if (key === 'region' && currentSection === 'about') renderContent();
      };
      OS.events.on('settings:changed', settingsHandler);
      const unsubscribeRootAudit = typeof AppSandbox !== 'undefined' && AppSandbox.subscribeRootAudit
        ? AppSandbox.subscribeRootAudit(() => {
          if (!isAlive() || currentSection !== 'root' || rootAuditRefreshTimer) return;
          rootAuditRefreshTimer = setTimeout(() => {
            rootAuditRefreshTimer = null;
            if (isAlive() && currentSection === 'root') renderContent();
          }, 750);
        })
        : null;

      // Return cleanup so the host can tear us down cleanly
      return () => {
        lifecycle.abort();
        closeAllOverlays();
        if (rootAuditRefreshTimer) clearTimeout(rootAuditRefreshTimer);
        unsubscribeRootAudit?.();
        try {
          if (typeof OS.events.off === 'function') OS.events.off('settings:changed', settingsHandler);
        } catch { /* off may not exist — listener is isAlive-guarded */ }
      };
    }
  }
});

})();
