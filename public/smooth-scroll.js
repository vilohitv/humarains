/* smooth-scroll.js: inertial, eased scrolling for the landing page (the same feel as Lenis on 11x.ai).

   How it works: the page keeps its NATIVE scroll (sticky header, scroll reveals, find-in-page and anchors all keep working).
   We only intercept mouse-wheel / trackpad / keyboard input, and instead of jumping, ease the real scroll position
   toward a target on every animation frame, frame-rate independent so 60, 120 and 144 Hz displays feel the same.

   - Wheel:  exponential easing (lerp). Mouse notches glide; trackpads, which already have OS inertia, get a lighter
             touch so they stay responsive instead of feeling floaty.
   - Keys:   Space, Page Up/Down, Home, End, arrows ease with a timed curve.
   - Links:  in-page #anchors glide to their section with a duration scaled to distance, offset for the sticky header.
   - Native: touch, pinch-zoom, horizontal gestures, nested scrollers (menus, dialogs, textareas), open modals,
             and anyone with "reduce motion" switched on are left completely alone.
   - Cost:   the animation loop runs only while the page is moving, then stops. */
(function () {
  'use strict';
  var root = document.documentElement;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var LERP_WHEEL = 0.085;      /* mouse wheel: lower = floatier */
  var LERP_PAD = 0.18;         /* trackpad: it is already smoothed by the OS */
  var HEADER = 68;             /* sticky header height, for anchor offsets */

  /* Some older browsers reject { behavior: 'instant' }, so check once */
  var instant = true;
  try { window.scrollTo({ top: window.scrollY, left: 0, behavior: 'instant' }); } catch (e) { instant = false; }
  function setScroll(y) { if (instant) window.scrollTo({ top: y, left: 0, behavior: 'instant' }); else window.scrollTo(0, y); }

  var current = window.scrollY, target = current, lastSet = current;
  var lerp = LERP_WHEEL, tween = null, raf = 0, last = 0;

  var limit = function () { return Math.max(0, root.scrollHeight - window.innerHeight); };
  var clamp = function (v) { return Math.min(Math.max(v, 0), limit()); };
  var locked = function () { return document.body.style.overflow === 'hidden'; };   /* a dialog is open */
  var easeOutExpo = function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  var easeInOutQuart = function (t) { return t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2; };

  function frame(now) {
    var dt = Math.min((now - last) / 16.667, 3) || 1; last = now;
    if (tween) {
      var p = Math.min(1, (now - tween.t0) / tween.dur);
      current = tween.from + (tween.to - tween.from) * tween.ease(p);
      if (p >= 1) { current = target = tween.to; tween = null; }
    } else {
      current += (target - current) * (1 - Math.pow(1 - lerp, dt));
      if (Math.abs(target - current) < 0.05) current = target;
    }
    lastSet = current;
    setScroll(current);
    raf = (tween || current !== target) ? requestAnimationFrame(frame) : 0;
  }
  function run() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function halt() { if (raf) cancelAnimationFrame(raf); raf = 0; tween = null; current = target = lastSet = window.scrollY; }

  /* Timed glide to a position (anchors, keyboard) */
  function glide(y, opts) {
    opts = opts || {};
    y = clamp(y);
    var from = window.scrollY, dist = Math.abs(y - from);
    if (dist < 1) return;
    current = from; target = y;
    tween = { from: from, to: y, t0: performance.now(), ease: opts.ease || easeInOutQuart,
              dur: opts.duration || Math.min(1800, Math.max(700, 600 + dist * 0.45)) };
    run();
  }

  /* Leave scrollable children (mobile menu, textareas, the dashboard demo) to scroll themselves */
  function insideScroller(node, dy) {
    while (node && node !== document.body && node !== root) {
      if (node.nodeType === 1) {
        if (node.hasAttribute && node.hasAttribute('data-smooth-prevent')) return true;
        var cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1) {
          var atTop = node.scrollTop <= 0, atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if (!((dy < 0 && atTop) || (dy > 0 && atEnd))) return true;
        }
      }
      node = node.parentNode;
    }
    return false;
  }

  window.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.defaultPrevented || locked()) return;                    /* pinch-zoom, dialogs */
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;                         /* horizontal swipe: native */
    if (insideScroller(e.target, e.deltaY)) return;
    var dy = e.deltaMode === 1 ? e.deltaY * 34 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
    var pad = e.deltaMode === 0 && Math.abs(e.deltaY) < 36;                      /* small pixel deltas: a trackpad */
    lerp = pad ? LERP_PAD : LERP_WHEEL;
    if (tween) { tween = null; current = window.scrollY; target = current; }
    else if (!raf) { current = target = window.scrollY; }
    target = clamp(target + dy);
    e.preventDefault();
    run();
  }, { passive: false });

  /* Keyboard: same glide, only when the focus is not somewhere that needs the key */
  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || locked()) return;
    var el = document.activeElement, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || (el && el.isContentEditable)) return;
    var vh = window.innerHeight, y = window.scrollY, dest = null;
    switch (e.key) {
      case 'ArrowDown': dest = y + 80; break;
      case 'ArrowUp': dest = y - 80; break;
      case 'PageDown': dest = y + vh * 0.88; break;
      case 'PageUp': dest = y - vh * 0.88; break;
      case ' ': case 'Spacebar': dest = y + (e.shiftKey ? -1 : 1) * vh * 0.88; break;
      case 'Home': dest = 0; break;
      case 'End': dest = limit(); break;
      default: return;
    }
    e.preventDefault();
    glide(dest, { duration: Math.abs(dest - y) < 120 ? 450 : 850, ease: easeOutExpo });
  });

  /* Anything else that moves the page (scrollbar drag, find-in-page, a focus jump) wins: drop our animation and re-sync */
  window.addEventListener('scroll', function () {
    var y = window.scrollY;
    if (!raf) { current = target = lastSet = y; return; }
    if (Math.abs(y - lastSet) > 2) halt();
  }, { passive: true });
  window.addEventListener('resize', function () { if (!raf) { current = target = window.scrollY; } else target = clamp(target); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) halt(); });

  /* In-page links glide to their section, offset for the sticky header */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var id = a.getAttribute('href');
    if (id.length < 2) return;
    var el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    glide(el.getBoundingClientRect().top + window.scrollY - HEADER + 1);
    try { history.replaceState(null, '', id); } catch (err) { /* sandboxed previews block this; scrolling still works */ }
  });

  window.humSmooth = { to: function (y, o) { glide(typeof y === 'number' ? y : y.getBoundingClientRect().top + window.scrollY - HEADER, o); }, stop: halt };
})();
