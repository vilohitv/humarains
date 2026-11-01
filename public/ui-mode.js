/* ════════════════════════════════════════════════════════════════
   Humarains — Agent / Classic view switch
   One slider, top right. "Agent" is the chat-first dashboard;
   "Classic" is the traditional sidebar + pages layout. The choice is
   remembered in this browser. Both views use the same pages and data,
   so nothing is lost by switching.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__uiMode) return;

  var KEY = 'hm_ui_mode';
  var body = document.body;
  var $ = function (id) { return document.getElementById(id); };

  function read() { try { return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'agent'; } catch (_) { return 'agent'; } }
  function write(m) { try { localStorage.setItem(KEY, m); } catch (_) {} }
  function current() { return body.classList.contains('classic-ui') ? 'classic' : 'agent'; }

  var ICON_AGENT = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v4A1.5 1.5 0 0 1 11.5 10H8l-3 2.5V10h-.5A1.5 1.5 0 0 1 3 8.5v-4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  var ICON_CLASSIC = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.8" stroke="currentColor" stroke-width="1.4"/><path d="M6.2 3v10" stroke="currentColor" stroke-width="1.4"/></svg>';

  function fillSwitch(btn) {
    btn.className = 'ui-switch';
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', 'Classic view');
    btn.innerHTML = '<span class="ui-switch-thumb" aria-hidden="true"></span>' +
      '<span class="ui-switch-opt" aria-hidden="true">' + ICON_AGENT + '<span>Agent</span></span>' +
      '<span class="ui-switch-opt" aria-hidden="true">' + ICON_CLASSIC + '<span>Classic</span></span>';
  }

  // The switch is fixed beside the account button, top right, in both views (markup in dashboard.html).
  var switches = [];
  var stageSwitch = $('uiSwitch');
  if (stageSwitch) { if (!stageSwitch.querySelector('.ui-switch-thumb')) fillSwitch(stageSwitch); switches.push(stageSwitch); }

  function closeDrawer() {
    var sb = $('lcSidebar'), ov = $('lcSidebarOverlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.remove('open');
    body.style.overflow = '';
  }

  function paint(mode) {
    var on = mode === 'classic';
    switches.forEach(function (s) {
      s.setAttribute('aria-checked', String(on));
      s.title = on ? 'Switch to the Agent view' : 'Switch to the Classic view';
    });
  }

  function apply(mode, init) {
    var hooks = window.__agentUIHooks || {};
    if (mode === 'classic') {
      if (hooks.leaveSurface) hooks.leaveSurface();   // an open Agent page sheet becomes the main page
      body.classList.add('classic-ui');
      closeDrawer();
      if (!document.querySelector('.lc-view.active') && window.showView) window.showView('leads', { silent: true });
    } else {
      body.classList.remove('classic-ui');
      closeDrawer();
      if (!init && hooks.enter) hooks.enter();
    }
    paint(mode);
  }

  // Slide between views along a straight horizontal line (no fade). Uses the View Transitions API so the
  // whole screen moves as one piece; browsers without it, or users who prefer reduced motion, switch instantly.
  var vtToken = 0;
  function slide(mode, change) {
    var root = document.documentElement;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduce) { change(); return; }
    var token = ++vtToken;
    var cls = mode === 'classic' ? 'ui-vt-to-classic' : 'ui-vt-to-agent';
    root.classList.remove('ui-vt-to-classic', 'ui-vt-to-agent');
    root.classList.add(cls);
    function done() { if (token === vtToken) root.classList.remove(cls); }
    var t;
    try { t = document.startViewTransition(change); } catch (_) { done(); change(); return; }
    t.finished.then(done, done);
  }

  function set(mode) {
    mode = mode === 'classic' ? 'classic' : 'agent';
    if (mode === current()) return;
    write(mode);
    slide(mode, function () { apply(mode, false); });
  }

  switches.forEach(function (s) {
    s.addEventListener('click', function () { set(current() === 'classic' ? 'agent' : 'classic'); });
    s.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); set('agent'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); set('classic'); }
    });
  });

  // Keep other open tabs in step
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(read(), false); });

  // Classic sidebar: show the account name and plan beside the avatar
  (function userMeta() {
    var avatar = $('lcUserAvatar'), nameEl = $('lcUserName'), planEl = $('lcUserPlan');
    if (!avatar || !nameEl || !planEl) return;
    var meta = document.createElement('div'); meta.className = 'cl-user-meta';
    var b = document.createElement('b'), s = document.createElement('span'); meta.appendChild(b); meta.appendChild(s);
    avatar.insertAdjacentElement('afterend', meta);
    function sync() { b.textContent = nameEl.textContent.trim(); s.textContent = planEl.textContent.trim(); }
    var mo = new MutationObserver(sync);
    [nameEl, planEl].forEach(function (n) { mo.observe(n, { childList: true, characterData: true, subtree: true }); });
    sync();
  })();


  // Classic header: a mono eyebrow and a one-line description under the page title, and the business name under the logo
  (function pageHeader() {
    var titleEl = $('lcPageTitle');
    var SUB = {
      'All Leads': 'Every enquiry your Agent has picked up, and where it stands.',
      'New': 'Enquiries waiting for a first reply.',
      'Follow-Ups': 'Conversations your Agent is following up on.',
      'Closed': 'Finished conversations.',
      'Performance': 'How quickly and how often your Agent turns enquiries into bookings.',
      'Add Lead': 'Add an enquiry by hand and let your Agent reply.',
      'Email Connection': 'The inbox your Agent reads and answers from.',
      'WhatsApp': 'The WhatsApp number your Agent answers on.',
      'Google Calendar': 'Where your Agent books appointments.',
      'Business Settings': 'What your Agent knows about your business.',
      'Review': 'Drafts waiting for your approval and chats your Agent flagged for you.',
      'Inbox': 'Read and reply to your customers\u2019 chats.',
      'Leads': 'Every enquiry your Agent has picked up, and where it stands.',
      'Integrations': 'Connected tools and services.',
      'Workflows': 'Automations that run when enquiries come in.',
      'Company Knowledge': 'Documents and answers your Agent can draw on.',
      'Account': 'Your profile, plan and security.',
      'Support': 'Get help from the Humarains team.',
      'Upgrade': 'Plans and billing.',
      'Getting Started': 'The quickest way to see your Agent working.'
    };
    function paint() {
      if (!titleEl) return;
      var t = titleEl.textContent.trim();
      titleEl.setAttribute('data-t', t);
      titleEl.setAttribute('data-sub', SUB[t] || '');
    }
    if (titleEl) { new MutationObserver(paint).observe(titleEl, { childList: true, characterData: true, subtree: true }); paint(); }

    var logo = document.querySelector('.lc-sidebar-logo');
    if (!logo || logo.querySelector('.cl-brand')) return;
    var brand = document.createElement('div'); brand.className = 'cl-brand';
    var b = document.createElement('b'); b.textContent = 'Humarains';
    var small = document.createElement('small'); small.textContent = 'AI agent';
    brand.appendChild(b); brand.appendChild(small); logo.appendChild(brand);
    // Business name from the saved profile, when there is one
    fetch('/api/leads/settings', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var n = d && d.settings && d.settings.businessName;
      if (n) small.textContent = n;
    }).catch(function () {});
  })();

  window.__uiMode = { get: current, set: set };
  apply(read(), true);
})();
