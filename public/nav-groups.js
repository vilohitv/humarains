/* One sidebar item, several pages: Channels (Email, WhatsApp, Google Calendar) and Settings (Business, Knowledge,
   Agent, Support, Account). leads.js calls NavGroups.sync(viewId) every time a page opens. Also keeps the Review
   badge on the sidebar (drafts waiting for approval + chats that need a person) in step. */
(function () {
  'use strict';
  var GROUPS = { channels: ['email', 'whatsapp', 'calendar', 'integrations'], settings: ['settings', 'knowledge', 'support', 'account'] };
  var strips = {};
  ['channels', 'settings'].forEach(function (g) { strips[g] = document.querySelector('.lc-tabs[data-group="' + g + '"]'); });

  function sync(id) {
    Object.keys(GROUPS).forEach(function (g) {
      var strip = strips[g]; if (!strip) return;
      var inGroup = GROUPS[g].indexOf(id) >= 0;
      strip.hidden = !inGroup;
      strip.querySelectorAll('.lc-tab').forEach(function (t) {
        var on = t.getAttribute('data-tab') === id || (id === 'integrations' && t.getAttribute('data-tab') === 'email');
        t.classList.toggle('active', on); t.setAttribute('aria-current', on ? 'page' : 'false');
      });
    });
  }

  document.addEventListener('click', function (e) {
    var tab = e.target.closest('.lc-tab'); if (!tab) return;
    var v = tab.getAttribute('data-tab');
    if (window.showView) window.showView(v);
  });

  // Sidebar Review badge = drafts waiting for approval + chats that need a person
  (function reviewBadge() {
    var a = document.getElementById('navBadgeConsent'), b = document.getElementById('navBadgeHuman');
    if (!a || !b) return;
    function paint() {
      var n = (parseInt(a.textContent, 10) || 0) + (parseInt(b.textContent, 10) || 0);
      var dot = document.getElementById('navDotReview'); if (dot) { dot.style.display = n ? '' : 'none'; dot.textContent = n > 9 ? '9+' : (n || ''); }
      var bb = document.getElementById('bottomBadgeHuman'); if (bb) { bb.textContent = n || ''; bb.style.display = n ? 'flex' : 'none'; }
    }
    var mo = new MutationObserver(paint);
    [a, b].forEach(function (x) { mo.observe(x, { childList: true, characterData: true, subtree: true }); });
    paint();
  })();

  // Unread dot on the Inbox item, checked shortly after load and then every minute
  function dot() { if (window.Inbox && !document.hidden) window.Inbox.refreshDot(); }
  setTimeout(dot, 1500); setInterval(dot, 60000);

  window.NavGroups = { sync: sync };
  var active = document.querySelector('.lc-view.active'); if (active) sync(active.id.replace('view-', ''));
})();
