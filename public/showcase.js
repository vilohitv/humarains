/* showcase.js: the two blue-panel sections on the landing page.

   1. Hero story (#heroShow): one conversation told in four stages (Asked, Went quiet, Followed up, Booked).
      The messages arrive one by one, then the next stage starts. The stage bar under the chat shows progress
      and can be clicked to jump to any stage.
   2. How it works (#how): an accordion on the left; each item shows its own card on the blue panel. The first card
      also cycles through the channels an enquiry can come from.

   The full content is in index.html, so the page reads correctly without JavaScript.
   - Plays only while the section is on screen and the tab is visible, and pauses while the pointer is over it.
   - Any click on a stage or an accordion item stops the automatic play for good.
   - "Reduce motion": no automatic play and no animation; the visitor moves through it themselves. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function watch(el, cb) {
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { cb(es[0].isIntersecting); }, { threshold: 0.35 }).observe(el);
    else cb(true);
  }

  /* ── 1. Hero story ───────────────────────────────────────── */
  (function () {
    var root = document.getElementById('heroShow');
    if (!root) return;
    var chat = root.querySelector('.sc-chat');
    var items = [].slice.call(chat.querySelectorAll('.sc-item'));
    var stages = [].slice.call(root.querySelectorAll('.sc-stage'));
    var N = stages.length;
    var STEP = 1300, HOLD = 2600;               // ms between messages; ms to linger before the next stage
    var cur = 0, timers = [], auto = !reduce, visible = false, hover = false, started = false;

    function clear() { timers.forEach(clearTimeout); timers = []; }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

    /* Keep the chat the same height in every stage, so nothing below it jumps */
    function lock() {
      chat.style.minHeight = '';
      chat.classList.add('measure');
      var h = chat.offsetHeight;
      chat.classList.remove('measure');
      if (h) chat.style.minHeight = h + 'px';
    }

    function paint(n, play) {
      cur = n;
      stages.forEach(function (b, k) {
        b.classList.toggle('done', k < n);
        b.classList.toggle('on', k === n);
        if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      var mine = [];
      items.forEach(function (it) {
        var s = +it.getAttribute('data-s');
        it.classList.remove('pop');
        if (s < n) it.classList.add('on');
        else if (s === n) { if (play) it.classList.remove('on'); else it.classList.add('on'); mine.push(it); }
        else it.classList.remove('on');
      });
      if (!play) { root.classList.remove('sc-run'); return; }
      var total = 250 + (mine.length - 1) * STEP + HOLD;
      root.style.setProperty('--dur', total + 'ms');
      root.classList.remove('sc-run'); void root.offsetWidth; root.classList.add('sc-run');
      mine.forEach(function (it, k) {
        later(function () { it.classList.add('on', 'pop'); }, 250 + k * STEP);
      });
      later(next, total);
    }

    function next() {
      if (!auto) return;
      if (!visible || hover || document.hidden) { later(next, 500); return; }
      paint((cur + 1) % N, true);
    }

    function stop() { auto = false; clear(); root.classList.remove('sc-run'); }

    stages.forEach(function (b, k) {
      b.addEventListener('click', function () { stop(); paint(k, false); });
    });
    root.addEventListener('mouseenter', function () { hover = true; });
    root.addEventListener('mouseleave', function () { hover = false; });

    lock();
    if ('ResizeObserver' in window) new ResizeObserver(function () { lock(); }).observe(root); else window.addEventListener('resize', lock);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(lock);

    if (reduce) { paint(N - 1, false); return; }
    paint(0, false);
    watch(root, function (v) {
      visible = v;
      if (v && !started && auto) {
        // First view: the opening messages are already on screen, so just let them sit before moving on
        started = true; clear(); paint(0, false);
        var first = HOLD + 1200;
        root.style.setProperty('--dur', first + 'ms'); root.classList.add('sc-run');
        later(next, first);
      }
    });
  })();

  /* ── 2. How it works ─────────────────────────────────────── */
  (function () {
    var root = document.getElementById('how');
    if (!root) return;
    var rows = [].slice.call(root.querySelectorAll('.acc-item'));
    var btns = [].slice.call(root.querySelectorAll('.acc-btn'));
    var panes = [].slice.call(root.querySelectorAll('.sc-pane'));
    var N = rows.length, cur = 0, auto = !reduce, visible = false, hover = false, t = 0;
    var ADV = 9000;

    function open(n) {
      cur = n;
      rows.forEach(function (r, k) {
        r.classList.toggle('open', k === n);
        btns[k].setAttribute('aria-expanded', k === n ? 'true' : 'false');
      });
      panes.forEach(function (p, k) { p.classList.toggle('on', k === n); });
      chans(n === 0);
    }

    function schedule() {
      clearTimeout(t);
      if (!auto) return;
      t = setTimeout(function () {
        if (!visible || hover || document.hidden) { schedule(); return; }
        open((cur + 1) % N); schedule();
      }, ADV);
    }

    btns.forEach(function (b, k) {
      b.addEventListener('click', function () {
        auto = false; clearTimeout(t); chanAuto = false;
        if (k === cur) return;          // the open item stays open: there is always one card showing
        open(k);
      });
    });
    root.addEventListener('mouseenter', function () { hover = true; });
    root.addEventListener('mouseleave', function () { hover = false; });

    /* The first card: the same enquiry arriving by each channel */
    var VARIANTS = [
      { where: 'Email, just now',        via: 'Email',        msg: 'Hi, my bathroom drain is blocked and the water is not going down. What would it cost to fix?' },
      { where: 'WhatsApp, just now',     via: 'WhatsApp',     msg: 'Hi, our bathroom drain is blocked again. Can someone come today, and how much would it be?' },
      { where: 'Added by you, just now', via: 'Phone call',   msg: 'Called the office about a blocked bathroom drain. Wants a price and the earliest time.' }
    ];
    var chanEl = document.getElementById('hwChans');
    var chanBtns = chanEl ? [].slice.call(chanEl.querySelectorAll('.hw-chan')) : [];
    var elWhere = document.getElementById('hwWhere'), elVia = document.getElementById('hwVia'), elMsg = document.getElementById('hwMsg');
    var chanAuto = !reduce, ci = 0, ct = 0, CH = 2600;

    function usable() { return chanBtns.filter(function (b) { return b.offsetParent !== null; }); }   // WhatsApp may be switched off
    function showChan(btn) {
      var k = +btn.getAttribute('data-k'), v = VARIANTS[k];
      chanBtns.forEach(function (b) { var on = b === btn; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.remove('run'); });
      if (elWhere) elWhere.textContent = v.where;
      if (elVia) elVia.textContent = v.via;
      if (elMsg) elMsg.textContent = v.msg;
      if (chanAuto) { chanEl.style.setProperty('--dur', CH + 'ms'); void btn.offsetWidth; btn.classList.add('run'); }
    }
    function chans(on) {
      clearTimeout(ct);
      if (!chanBtns.length) return;
      var list = usable();
      if (!list.length) return;
      if (!on) return;
      ci = 0; showChan(list[0]);
      if (!chanAuto) return;
      (function tick() {
        ct = setTimeout(function () {
          if (!chanAuto || !on) return;
          if (!visible || hover || document.hidden) { tick(); return; }
          var l = usable(); ci = (ci + 1) % l.length; showChan(l[ci]); tick();
        }, CH);
      })();
    }
    chanBtns.forEach(function (b) {
      b.addEventListener('click', function () { chanAuto = false; auto = false; clearTimeout(ct); clearTimeout(t); showChan(b); });
    });

    open(0);
    watch(root, function (v) { visible = v; if (v) schedule(); });
  })();
})();
