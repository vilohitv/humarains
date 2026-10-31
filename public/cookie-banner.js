/**
 * cookie-banner.js — GDPR/PECR cookie consent banner
 * Light theme: white banner and modal.
 */
(function () {
  'use strict';

  var CONSENT_KEY  = 'humarains_cookie_consent';
  var CONSENT_DAYS = 365;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days) {
    var exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + exp + '; path=/; SameSite=Lax';
  }

  window.CookieConsent = {
    hasConsented: function () { return getCookie(CONSENT_KEY) === 'accepted'; },
    hasDeclined:  function () { return getCookie(CONSENT_KEY) === 'declined'; },
    isSet:        function () { return !!getCookie(CONSENT_KEY); },
  };

  if (window.CookieConsent.isSet()) return;

  // ── Styles ────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#cc-banner{',
      'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;',
      'width:calc(100% - 48px);max-width:640px;',
      'background:#ffffff;',
      'border:1px solid #e4e4e7;',
      'border-radius:12px;',
      'box-shadow:0 8px 32px rgba(0,0,0,0.18);',
      'padding:16px 18px;',
      'display:flex;align-items:center;gap:14px;',
      'font-family:\"Hanken Grotesk\",system-ui,sans-serif;',
      'font-size:12.5px;line-height:1.55;color:#52525b;',
      'animation:ccUp 0.25s ease;',
    '}',
    '@keyframes ccUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}',
    '@media(prefers-reduced-motion:reduce){#cc-banner{animation:none}}',
    '#cc-text{flex:1;min-width:0}',
    '#cc-text a{color:#18181b;text-decoration:underline;text-underline-offset:2px;text-decoration-color:#a1a1aa}',
    '#cc-text a:hover{color:#000}',
    '#cc-actions{display:flex;gap:7px;flex-shrink:0}',
    '.cc-btn{',
      'border:none;border-radius:7px;padding:7px 14px;',
      'font-size:12px;font-weight:500;cursor:pointer;',
      'font-family:inherit;white-space:nowrap;',
      'transition:background .15s,color .15s;',
    '}',
    '.cc-btn-accept{background:#18181b;color:#ffffff;}',
    '.cc-btn-accept:hover{background:#000;color:#ffffff}',
    '.cc-btn-decline{background:#ffffff;color:#52525b;border:1px solid #d4d4d8}',
    '.cc-btn-decline:hover{background:#f4f4f5;color:#18181b}',
    '.cc-btn-manage{background:transparent;color:#52525b;padding:6px 10px;font-size:11.5px;border:1px solid #d4d4d8}',
    '.cc-btn-manage:hover{color:#18181b;border-color:#a1a1aa}',

    // Modal backdrop
    '#cc-modal-bg{',
      'position:fixed;inset:0;z-index:100000;',
      'background:rgba(0,0,0,0.45);',
      'display:flex;align-items:center;justify-content:center;',
      'padding:20px;',
      'animation:ccFade .18s ease;',
    '}',
    '@keyframes ccFade{from{opacity:0}to{opacity:1}}',

    // Modal box
    '#cc-modal{',
      'background:#ffffff;',
      'border:1px solid #e4e4e7;',
      'border-radius:14px;',
      'padding:28px 24px 24px;',
      'width:100%;max-width:460px;',
      'font-family:\"Hanken Grotesk\",system-ui,sans-serif;',
      'box-shadow:0 24px 64px rgba(0,0,0,0.25);',
    '}',
    '#cc-modal h2{font-size:15px;font-weight:600;margin:0 0 6px;color:#09090b}',
    '#cc-modal > p{font-size:12.5px;color:#52525b;margin:0 0 18px;line-height:1.6}',

    // Preference rows
    '.cc-pref{display:flex;align-items:flex-start;gap:14px;padding:13px 0;border-top:1px solid #e4e4e7}',
    '.cc-pref-info{flex:1;min-width:0}',
    '.cc-pref-info strong{display:block;font-size:12.5px;font-weight:600;color:#18181b;margin-bottom:3px}',
    '.cc-pref-info span{font-size:11.5px;color:#71717a;line-height:1.5}',

    // Toggle
    '.cc-toggle{position:relative;flex-shrink:0;width:36px;height:20px;margin-top:2px}',
    '.cc-toggle input{opacity:0;width:0;height:0;position:absolute}',
    '.cc-toggle-track{',
      'position:absolute;inset:0;border-radius:10px;',
      'background:#e4e4e7;border:1px solid #d4d4d8;',
      'transition:background .2s,border-color .2s;cursor:pointer;',
    '}',
    '.cc-toggle input:checked+.cc-toggle-track{background:#18181b;border-color:#18181b}',
    '.cc-toggle input:disabled+.cc-toggle-track{opacity:0.45;cursor:not-allowed}',
    '.cc-toggle-track::after{',
      'content:"";position:absolute;top:3px;left:3px;',
      'width:12px;height:12px;border-radius:50%;',
      'background:#a1a1aa;transition:transform .2s,background .2s;',
    '}',
    '.cc-toggle input:checked+.cc-toggle-track::after{transform:translateX(16px);background:#ffffff}',

    // Modal actions
    '#cc-modal-actions{display:flex;gap:8px;margin-top:20px}',
    '#cc-modal-actions .cc-btn{flex:1;text-align:center;padding:8px 12px}',

    // Mobile
    '@media(max-width:520px){',
      '#cc-banner{flex-direction:column;align-items:stretch;bottom:0;border-radius:12px 12px 0 0;width:100%;max-width:100%;left:0;transform:none}',
      '@keyframes ccUp{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:translateY(0)}}',
      '#cc-actions{justify-content:flex-end}',
    '}',
  ].join('');
  document.head.appendChild(style);

  // ── Banner ────────────────────────────────────────────────────
  var banner = document.createElement('div');
  banner.id = 'cc-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML =
    '<div id="cc-text">We use essential cookies to keep you signed in. No tracking or advertising cookies. ' +
    '<a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></div>' +
    '<div id="cc-actions">' +
      '<button class="cc-btn cc-btn-manage" id="cc-manage">Manage</button>' +
      '<button class="cc-btn cc-btn-decline" id="cc-decline">Decline</button>' +
      '<button class="cc-btn cc-btn-accept" id="cc-accept">Accept</button>' +
    '</div>';
  document.body.appendChild(banner);

  function dismiss() {
    var reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    if (!reduce) {
      banner.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      banner.style.opacity = '0';
      banner.style.transform = 'translateX(-50%) translateY(8px)';
    }
    setTimeout(function () { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 220);
  }

  document.getElementById('cc-accept').addEventListener('click', function () {
    setCookie(CONSENT_KEY, 'accepted', CONSENT_DAYS);
    dismiss();
  });

  document.getElementById('cc-decline').addEventListener('click', function () {
    setCookie(CONSENT_KEY, 'declined', CONSENT_DAYS);
    dismiss();
  });

  // ── Manage modal ──────────────────────────────────────────────
  document.getElementById('cc-manage').addEventListener('click', function () {
    var bg = document.createElement('div');
    bg.id = 'cc-modal-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-label', 'Cookie preferences');
    bg.innerHTML =
      '<div id="cc-modal">' +
        '<h2>Cookie Preferences</h2>' +
        '<p>Necessary cookies cannot be disabled — the site requires them to function.</p>' +

        '<div class="cc-pref">' +
          '<div class="cc-pref-info">' +
            '<strong>Necessary</strong>' +
            '<span>Session authentication, CSRF protection, and OAuth state. Required to log in.</span>' +
          '</div>' +
          '<label class="cc-toggle" aria-label="Necessary cookies — always on">' +
            '<input type="checkbox" checked disabled>' +
            '<div class="cc-toggle-track"></div>' +
          '</label>' +
        '</div>' +

        '<div class="cc-pref">' +
          '<div class="cc-pref-info">' +
            '<strong>Functional</strong>' +
            '<span>Remembers your preferences. Stored server-side in your account, not as tracking cookies.</span>' +
          '</div>' +
          '<label class="cc-toggle" aria-label="Functional cookies">' +
            '<input type="checkbox" id="cc-pref-functional" checked>' +
            '<div class="cc-toggle-track"></div>' +
          '</label>' +
        '</div>' +

        '<div id="cc-modal-actions">' +
          '<button class="cc-btn cc-btn-decline" id="cc-modal-decline">Decline optional</button>' +
          '<button class="cc-btn cc-btn-accept" id="cc-modal-save">Save</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(bg);

    function closeModal() {
      bg.style.transition = 'opacity 0.15s ease';
      bg.style.opacity = '0';
      setTimeout(function () { if (bg.parentNode) bg.parentNode.removeChild(bg); }, 160);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e) { if (e.key === 'Escape') closeModal(); }
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', function (e) { if (e.target === bg) closeModal(); });

    document.getElementById('cc-modal-decline').addEventListener('click', function () {
      setCookie(CONSENT_KEY, 'declined', CONSENT_DAYS);
      closeModal();
      dismiss();
    });

    document.getElementById('cc-modal-save').addEventListener('click', function () {
      setCookie(CONSENT_KEY, 'accepted', CONSENT_DAYS);
      closeModal();
      dismiss();
    });
  });

})();
