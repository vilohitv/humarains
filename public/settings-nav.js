/**
 * settings-nav.js — a short index for the Settings page.
 * Lists each section (anything in #view-settings with data-nav), scrolls to it on click and marks the one in view.
 * Uses buttons and scrollIntoView, not #links, so the browser history (which the Agent sheet listens to) is untouched.
 */
(function () {
  'use strict';
  var view = document.getElementById('view-settings');
  if (!view || view.querySelector('.set-nav')) return;
  var sections = Array.prototype.slice.call(view.querySelectorAll(':scope > .lc-settings-section[data-nav]'));
  if (sections.length < 2) return;

  var nav = document.createElement('nav');
  nav.className = 'set-nav';
  nav.setAttribute('aria-label', 'Settings sections');
  var label = document.createElement('div');
  label.className = 'set-nav-label';
  label.textContent = 'On this page';
  nav.appendChild(label);

  var buttons = sections.map(function (sec) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = sec.getAttribute('data-nav');
    b.addEventListener('click', function () {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      sec.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      mark(sec);
    });
    nav.appendChild(b);
    return b;
  });

  function mark(active) {
    sections.forEach(function (s, i) {
      var on = s === active;
      buttons[i].classList.toggle('on', on);
      if (on) buttons[i].setAttribute('aria-current', 'true'); else buttons[i].removeAttribute('aria-current');
    });
  }

  // A section a script hides (for example one that does not apply to this account) leaves the index too.
  function sync() {
    sections.forEach(function (s, i) { buttons[i].style.display = s.offsetParent === null && view.classList.contains('active') ? 'none' : ''; });
  }

  view.insertBefore(nav, view.firstChild);
  mark(sections[0]);

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) mark(e.target); });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }
  new MutationObserver(function () { if (view.classList.contains('active')) sync(); })
    .observe(view, { attributes: true, attributeFilter: ['class'] });
  sync();
})();
