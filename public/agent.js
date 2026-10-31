/* ════════════════════════════════════════════════════════════════
   Humarains — Agent-first UI controller
   The Agent is the interface. Pages (surfaces) open only when the Agent
   (or the user) asks for them, then the interface returns to the stage.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__agentUI) return;
  window.__agentUI = true;

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('agStage'), input = $('agInput'), box = $('agBox'), thread = $('agThread');
  if (!stage || !input) return;

  // Pages the Agent may open. Mirrors real view ids in dashboard.html.
  var VIEWS = ['leads', 'new', 'pending', 'closed', 'ingest', 'email', 'whatsapp', 'calendar', 'settings',
    'payment', 'humanreview', 'inbox', 'performance', 'workflows', 'knowledge',
    'locations', 'account', 'support', 'getting-started'];

  var EXAMPLES = ['Run a spring promotion for past customers', 'Show me yesterday\u2019s leads', 'Connect my WhatsApp', 'Create a follow-up for leads who don\u2019t reply',
    'Pause follow-ups for Sarah', 'What\u2019s waiting on me?', 'Never offer more than 10% off'];
  // Same ideas, short enough for one line inside the input on a phone.
  var EXAMPLES_SHORT = ['Run a spring promotion', 'Show yesterday\u2019s leads', 'Connect my WhatsApp', 'Follow up on quiet leads',
    'Pause follow-ups for Sam', 'What\u2019s waiting on me?', 'Cap discounts at 10%'];
  // Only offer phrases that fit on one line in the input as it is right now (any phone width, any zoom).
  var measure = document.createElement('canvas').getContext('2d');
  function fitsInput(t) {
    var cs = getComputedStyle(input), w = input.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!w || !measure) return true;
    measure.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return measure.measureText(t).width <= w - 6;
  }
  function examples() {
    var ok = (window.innerWidth <= 520 ? EXAMPLES_SHORT : EXAMPLES).filter(fitsInput);
    return ok.length ? ok : ['Ask your Agent'];
  }

  var S = {
    busy: false, history: [], brief: null, user: null,
    agentWaiting: false, surface: false, restTimer: null, phTimer: null, flashTimer: null, pushed: false,
    photos: [], uploading: 0, shownNotes: {}, kicked: false, turn: 0,
  };

  // ── helpers ──────────────────────────────────────────────────
  function csrf() {
    try { var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; }); return m ? decodeURIComponent(m.split('=')[1]) : ''; }
    catch (_) { return ''; }
  }
  function api(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({ credentials: 'include' }, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, opts.headers || {}),
    })).then(function (r) { if (r.status === 401) { window.location.href = '/login.html'; } return r; });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── glow state ───────────────────────────────────────────────
  function setState(s) { stage.dataset.state = s; }
  function baseState() {
    var b = S.brief;
    return (S.agentWaiting || (b && b.waiting > 0)) ? 'waiting' : 'idle';
  }
  function settle() { setState(baseState()); }
  function flash() {
    clearTimeout(S.flashTimer);
    stage.classList.remove('ag-flash'); void stage.offsetWidth; stage.classList.add('ag-flash');
    S.flashTimer = setTimeout(function () { stage.classList.remove('ag-flash'); }, 1250);
  }

  function loadBrief() {
    // The first request is started while the page loads (top of dashboard.html); later refreshes go to the network.
    var early = window.__early && window.__early.take('/api/agent/brief');
    var first = early ? early.then(function (r) { return r ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
    return first.then(function (d) { return d || api('/api/agent/brief').then(function (r) { return r.json(); }); }).then(function (d) {
      if (d && d.success) {
        S.brief = d; if (d.agentMode) setMode(d.agentMode, true); if (!S.busy) settle();
        showNotes(d.notes); maybeKickoff(d);
        syncApprovals(d.drafts || 0);
      }
    }).catch(function () {});
  }

  // Results of one-off jobs that finished while the owner was away: shown once, then acknowledged.
  function showNotes(notes) {
    var fresh = (notes || []).filter(function (n) { return n && n.id && !S.shownNotes[n.id]; });
    if (!fresh.length) return;
    fresh.forEach(function (n) {
      S.shownNotes[n.id] = 1;
      var m = el('div', 'ag-msg agent ag-note', n.text); thread.appendChild(m);
    });
    document.body.classList.add('ag-has-thread'); trimThread(); scrollEnd(); unrest();
    api('/api/agent/notes/ack', { method: 'POST', body: JSON.stringify({ ids: fresh.map(function (n) { return n.id; }) }) }).catch(function () {});
  }

  // First run: the Agent opens the conversation and interviews the owner about the business.
  function maybeKickoff(d) {
    if (S.kicked || S.busy || !d.onboarding || !d.onboarding.needed || S.history.length) return;
    var last = 0; try { last = parseInt(localStorage.getItem('ag_onb') || '0', 10) || 0; } catch (_) {}
    if (Date.now() - last < 12 * 3600 * 1000) return;
    S.kicked = true;
    try { localStorage.setItem('ag_onb', String(Date.now())); } catch (_) {}
    send('', { kickoff: true });
  }

  // ── thread ───────────────────────────────────────────────────
  function trimThread() { while (thread.children.length > 14) thread.removeChild(thread.firstChild); }
  function scrollEnd() { thread.scrollTo({ top: thread.scrollHeight, behavior: reduced ? 'auto' : 'smooth' }); }
  function addYou(text, photos) {
    var m = el('div', 'ag-msg you', text || (photos && photos.length ? 'Photos attached' : ''));
    if (photos && photos.length) {
      var row = el('div', 'ag-shots');
      photos.forEach(function (p) { var im = document.createElement('img'); im.src = p.url; im.alt = ''; row.appendChild(im); });
      m.appendChild(row);
    }
    thread.appendChild(m); trimThread(); scrollEnd(); return m;
  }

  // ── photos ───────────────────────────────────────────────────
  var fileInput = $('agFile'), attachBtn = $('agAttach'), tray = $('agTray');
  var MAX_SHOTS = 4;
  function pickFiles() { if (fileInput && S.photos.length + S.uploading < MAX_SHOTS) fileInput.click(); }
  function syncPhotos() {
    box.classList.toggle('ag-has-photos', S.photos.length > 0);
    tray.hidden = !(S.photos.length || S.uploading);
    attachBtn.disabled = S.photos.length + S.uploading >= MAX_SHOTS;
  }
  function renderTray() {
    tray.textContent = '';
    S.photos.forEach(function (p, i) {
      var t = el('div', 'ag-thumb'); var im = document.createElement('img'); im.src = p.url; im.alt = p.name || 'Attached photo'; t.appendChild(im);
      var x = el('button', null, '\u00d7'); x.type = 'button'; x.setAttribute('aria-label', 'Remove photo');
      x.addEventListener('click', function () { S.photos.splice(i, 1); renderTray(); });
      t.appendChild(x); tray.appendChild(t);
    });
    for (var k = 0; k < S.uploading; k++) tray.appendChild(el('div', 'ag-thumb up'));
    syncPhotos();
  }
  // Downscale in the browser (max 1600px, JPEG) so phone photos fit and upload fast.
  function prepare(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Only JPEG, PNG or WebP photos work (not ' + (file.type || 'that file type') + ').'));
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        var ctx2 = c.getContext('2d'); ctx2.fillStyle = '#fff'; ctx2.fillRect(0, 0, c.width, c.height); ctx2.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ name: file.name, dataBase64: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('I couldn\u2019t read that photo.')); };
      img.src = url;
    });
  }
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []).slice(0, MAX_SHOTS - S.photos.length - S.uploading);
    list.forEach(function (f) {
      S.uploading++; renderTray();
      prepare(f).then(function (p) {
        return api('/api/media', { method: 'POST', body: JSON.stringify({ fileName: p.name, dataBase64: p.dataBase64 }) })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok || !x.d || !x.d.success) throw new Error((x.d && x.d.message) || 'That photo could not be saved.');
            S.photos.push({ id: x.d.photo.id, url: x.d.photo.url, name: x.d.photo.fileName });
          });
      }).catch(function (e) { note(e.message || 'That photo could not be added.'); })
        .then(function () { S.uploading--; renderTray(); try { input.focus({ preventScroll: true }); } catch (_) {} });
    });
  }
  attachBtn.addEventListener('click', pickFiles);
  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });
  input.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.files) || [];
    if (items.length) { e.preventDefault(); addFiles(items); }
  });
  box.addEventListener('dragover', function (e) { e.preventDefault(); });
  box.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  function addPending() {
    var m = el('div', 'ag-msg agent'); var d = el('span', 'ag-dots'); d.appendChild(el('i')); d.appendChild(el('i')); d.appendChild(el('i'));
    d.setAttribute('aria-label', 'Thinking'); m.appendChild(d); thread.appendChild(m); scrollEnd(); return m;
  }

  // ── Formatted replies ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // The Agent writes light markdown: "## Heading" / "### Subheading", "- " bullets, "1. " steps and **bold**. Built from DOM nodes with
  // textContent only (never innerHTML), so nothing the model writes can inject markup. Each word still fades in, as before.
  function renderRich(m, text) {
    var n = 0, lastWord = null;
    function words(parent, str) {
      String(str).split(/(\s+)/).forEach(function (w) {
        if (!w) return;
        if (/^\s+$/.test(w)) { parent.appendChild(document.createTextNode(w)); return; }
        var s = el('span', null, w);
        if (!reduced) { s.style.animation = 'ag-rise .5s var(--ag-ease) both'; s.style.animationDelay = Math.min(n * 28, 900) + 'ms'; }
        parent.appendChild(s); n++; lastWord = s;
      });
    }
    function inline(parent, str) {
      String(str).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).forEach(function (p) {
        if (!p) return;
        if (/^\*\*[^*\n]+\*\*$/.test(p)) { var b = el('strong'); words(b, p.slice(2, -2)); parent.appendChild(b); }
        else if (/^`[^`\n]+`$/.test(p)) { parent.appendChild(el('code', null, p.slice(1, -1))); }
        else words(parent, p.replace(/\*\*/g, ''));
      });
    }
    var para = null, list = null;
    function endPara() { para = null; }
    function endList() { list = null; }
    String(text).replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
      var line = raw.replace(/\s+$/, ''), mm;
      if (!line.trim()) { endPara(); endList(); return; }
      if ((mm = /^(#{1,3})\s+(.+)$/.exec(line))) {
        endPara(); endList();
        var h = el('div', 'ag-h ' + (mm[1].length >= 3 ? 'ag-h3' : 'ag-h2')); h.setAttribute('role', 'heading'); h.setAttribute('aria-level', mm[1].length >= 3 ? '4' : '3');
        inline(h, mm[2]); m.appendChild(h); return;
      }
      if ((mm = /^\s*(?:[-*\u2022]\s+(.+)|(\d+)[.)]\s+(.+))$/.exec(line))) {
        endPara();
        var ordered = !!mm[2];
        if (!list || list.ordered !== ordered) { list = { node: el(ordered ? 'ol' : 'ul', 'ag-list'), ordered: ordered }; m.appendChild(list.node); }
        var li = el('li'); inline(li, mm[1] || mm[3]); list.node.appendChild(li); return;
      }
      endList();
      if (!para) { para = el('p', 'ag-p'); m.appendChild(para); } else para.appendChild(el('br'));
      inline(para, line.trim());
    });
    return { count: n, last: lastWord };
  }
  function fillAgent(m, data, isErr) {
    m.textContent = '';
    if (isErr) m.classList.add('err');
    var rich = renderRich(m, String(data.reply || ''));
    var i = rich.count, lastWord = rich.last;
    // Resolves once the last word has finished appearing, so nothing (like opening a page)
    // happens while the owner is still reading the reply. The timer is only a safety net.
    var shown = new Promise(function (resolve) {
      if (!lastWord || reduced) { resolve(); return; }
      var done = false;
      function end() { if (done) return; done = true; resolve(); }
      lastWord.addEventListener('animationend', end);
      setTimeout(end, Math.min((i - 1) * 28, 900) + 500 + 400);
    });
    if (data.actions && data.actions.length) {
      var a = el('span', 'ag-acts'); a.textContent = data.actions.join(' \u00b7 '); m.appendChild(a);
    }
    if (data.leads && data.leads.length) m.appendChild(leadList(data.leads));
    (data.ui || []).forEach(function (u) {
      if (u.type === 'form' && u.form) m.appendChild(formCard(u.form));
      if (u.type === 'confirm' && u.confirm) m.appendChild(confirmCard(u.confirm));
    });
    scrollEnd();
    return shown;
  }

  // ── input form the Agent asks for (request_input) ───────────
  function formCard(f) {
    var card = el('form', 'ag-card'); card.noValidate = true; card.setAttribute('aria-label', f.title);
    card.appendChild(el('h3', null, f.title));
    if (f.description) card.appendChild(el('p', 'ag-card-desc', f.description));
    var grid = el('div', 'ag-form'), inputs = {};
    f.fields.forEach(function (fd, i) {
      var wrap = el('div', 'ag-fld'), id = f.id + '_' + fd.key;
      var lab = el('label', null, fd.label); lab.htmlFor = id;
      if (fd.required) lab.appendChild(el('i', null, '*'));
      wrap.appendChild(lab);
      var inp;
      if (fd.type === 'textarea') { inp = el('textarea'); inp.rows = 3; }
      else if (fd.type === 'select') {
        inp = el('select');
        if (!fd.required || !fd.default) { var o0 = el('option', null, 'Choose\u2026'); o0.value = ''; inp.appendChild(o0); }
        (fd.options || []).forEach(function (o) { var op = el('option', null, o); op.value = o; inp.appendChild(op); });
      } else { inp = el('input'); inp.type = fd.type === 'number' ? 'number' : fd.type === 'date' ? 'date' : fd.type === 'email' ? 'email' : fd.type === 'url' ? 'url' : 'text'; if (fd.type === 'number') inp.step = 'any'; }
      inp.id = id; inp.name = fd.key; if (fd.placeholder) inp.placeholder = fd.placeholder;
      if (fd.default) inp.value = fd.default;
      inp.maxLength = fd.type === 'textarea' ? 1000 : 300;
      if (fd.required) inp.setAttribute('aria-required', 'true');
      inp.addEventListener('input', function () { wrap.classList.remove('bad'); var e = wrap.querySelector('.ag-err'); if (e) e.remove(); });
      inputs[fd.key] = { inp: inp, fd: fd, wrap: wrap };
      wrap.appendChild(inp);
      if (fd.help) wrap.appendChild(el('small', null, fd.help));
      grid.appendChild(wrap);
      if (i === 0) setTimeout(function () { try { inp.focus({ preventScroll: true }); } catch (_) {} }, 120);
    });
    card.appendChild(grid);
    var acts = el('div', 'ag-card-actions');
    var go = el('button', 'ag-btn primary', f.submitLabel || 'Continue'); go.type = 'submit';
    var skip = el('button', 'ag-btn ghost', 'Not now'); skip.type = 'button';
    acts.appendChild(go); acts.appendChild(skip); card.appendChild(acts);

    function markDone(text) {
      var d = el('div', 'ag-card done'); d.appendChild(document.createTextNode(text));
      card.replaceWith(d); scrollEnd();
    }
    skip.addEventListener('click', function () { markDone('Dismissed.'); input.focus(); });
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      if (S.busy) return;
      var bad = null, lines = [];
      f.fields.forEach(function (fd) {
        var r = inputs[fd.key], v = String(r.inp.value || '').trim();
        var e2 = r.wrap.querySelector('.ag-err'); if (e2) e2.remove(); r.wrap.classList.remove('bad');
        var msg = null;
        if (fd.required && !v) msg = 'Required';
        else if (v && fd.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) msg = 'Enter a valid email';
        else if (v && fd.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) msg = 'Start with http:// or https://';
        else if (v && fd.type === 'number' && !isFinite(Number(v))) msg = 'Enter a number';
        if (msg) { r.wrap.classList.add('bad'); r.wrap.appendChild(el('small', 'ag-err', msg)); if (!bad) bad = r.inp; }
        if (v) lines.push(fd.label + ': ' + v);
      });
      if (bad) { bad.focus(); return; }
      markDone('Details sent.');
      var body = lines.length ? lines.join('\n') : '(no details given)';
      send('Details provided for \u201c' + f.title + '\u201d:\n' + body, { shown: lines.join('\n') || f.title });
    });
    return card;
  }

  // ── Launch card (manual mode: owner presses go) ─────────────
  function confirmCard(c) {
    var card = el('div', 'ag-card');
    card.appendChild(el('h3', null, c.title));
    card.appendChild(el('p', 'ag-sum', c.summary));
    var ta = null;
    if (c.message) {
      var prev = el('div', 'ag-prev');
      var lab = el('label', null, c.editable ? 'Message (you can edit it)' : 'Message'); lab.htmlFor = 'agprev' + c.workflowId; prev.appendChild(lab);
      ta = document.createElement('textarea'); ta.id = 'agprev' + c.workflowId; ta.value = c.message; ta.maxLength = 4000; ta.readOnly = !c.editable;
      prev.appendChild(ta);
      var meta = [];
      if (c.photoCount) meta.push(c.photoCount + (c.photoCount === 1 ? ' photo' : ' photos') + ' attached');
      meta.push('Sent exactly as shown');
      prev.appendChild(el('small', null, meta.join(' \u00b7 ')));
      card.appendChild(prev);
    }
    var acts = el('div', 'ag-card-actions');
    var go = el('button', 'ag-btn primary', c.confirmLabel || 'Launch'); go.type = 'button';
    var tst = null;
    if (c.canTest) { tst = el('button', 'ag-btn ghost', 'Send me a test'); tst.type = 'button'; }
    var rev = el('button', 'ag-btn ghost', 'Review first'); rev.type = 'button';
    acts.appendChild(go); if (tst) acts.appendChild(tst); acts.appendChild(rev); card.appendChild(acts);
    rev.addEventListener('click', function () { openSurface(c.reviewPage || 'workflows'); });
    function clearMsg() { card.querySelectorAll('.ag-card-msg, .ag-card-ok').forEach(function (n) { n.remove(); }); }
    function text() { return ta ? ta.value.trim() : ''; }
    if (tst) tst.addEventListener('click', function () {
      clearMsg(); tst.disabled = true; var old = tst.textContent; tst.textContent = 'Sending\u2026';
      api('/api/agent/campaigns/' + encodeURIComponent(c.workflowId) + '/test', { method: 'POST', body: JSON.stringify({ message: text() }) })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok || !x.d || !x.d.success) throw new Error((x.d && x.d.message) || 'Could not send the test.');
          card.appendChild(el('p', 'ag-card-ok', 'Test sent to ' + x.d.sentTo + '.'));
        })
        .catch(function (e) { card.appendChild(el('p', 'ag-card-msg', e.message || 'Could not send the test.')); })
        .then(function () { tst.disabled = false; tst.textContent = old; });
    });
    go.addEventListener('click', function () {
      if (c.editable && !text()) { clearMsg(); card.appendChild(el('p', 'ag-card-msg', 'The message cannot be empty.')); return; }
      go.disabled = true; rev.disabled = true; if (tst) tst.disabled = true; if (ta) ta.readOnly = true; go.textContent = 'Launching\u2026';
      clearMsg();
      var payload = c.editable ? { message: text() } : {};
      api('/api/agent/campaigns/' + encodeURIComponent(c.workflowId) + '/launch', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok || !x.d || !x.d.success) throw new Error((x.d && x.d.message) || 'Could not launch.');
          var d = el('div', 'ag-card done'); var b = el('b', null, c.title);
          d.appendChild(b);
          var manual = false;
          d.appendChild(document.createTextNode(' started for ' + x.d.recipients + (x.d.recipients === 1 ? ' lead' : ' leads') + '. ' +
            (manual ? 'Each message will show up here for your OK before it sends. ' : '') + 'It runs once and removes itself when finished \u2014 I\u2019ll tell you how it went.'));
          card.replaceWith(d); scrollEnd();
          S.agentWaiting = true; settle(); loadBrief();
        })
        .catch(function (e) {
          go.disabled = false; rev.disabled = false; if (tst) tst.disabled = false; if (ta) ta.readOnly = !c.editable; go.textContent = c.confirmLabel || 'Launch';
          card.appendChild(el('p', 'ag-card-msg', e.message || 'Could not launch.'));
        });
    });
    return card;
  }
  function ago(iso) {
    var t = new Date(iso).getTime(); if (!t) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
  }
  var STATUS = { 'new': 'New', processing: 'Processing', replied: 'Replied', pending_followup: 'Following up', closed: 'Closed' };
  function leadList(leads) {
    var wrap = el('div', 'ag-leads');
    leads.slice(0, 8).forEach(function (l) {
      var b = el('button', 'ag-lead'); b.type = 'button';
      b.appendChild(el('b', null, l.name || 'Unknown'));
      var meta = [l.needsYou ? 'needs you' : (l.awaitingApproval ? 'awaiting approval' : (STATUS[l.status] || l.status)), ago(l.createdAt)].filter(Boolean).join(' \u00b7 ');
      b.appendChild(el('span', null, meta));
      if (l.summary || l.service) b.appendChild(el('small', null, l.summary || l.service));
      b.addEventListener('click', function () { openLead(l.id); });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function openLead(id) { if (window.openLeadById) window.openLeadById(id); }

  // ── resting: after 20s without typing, fade the thread and show the greeting again ──
  var REST_MS = 20000;
  function unrest() { document.body.classList.remove('ag-resting'); clearTimeout(S.restTimer); S.restTimer = setTimeout(rest, REST_MS); }
  function rest() {
    if (S.busy || S.surface || input.value.trim() || document.activeElement === input && thread.matches(':hover')) { S.restTimer = setTimeout(rest, 8000); return; }
    if (document.body.classList.contains('ag-has-thread')) {
      document.body.classList.add('ag-resting');
      greetIdx = 0; nextGreeting(true); greetIdx = 1;   // fresh greeting
    }
  }

  // ── sending ──────────────────────────────────────────────────
  function send(text, opts) {
    text = String(text || '').trim();
    var kick = !!(opts && opts.kickoff);
    var shots = kick ? [] : S.photos.slice();
    if ((!text && !shots.length && !kick) || S.busy || (!kick && S.uploading)) return;
    S.busy = true; S.turn++;
    document.body.classList.remove('ag-appr-open'); setApprOpen(false);
    document.body.classList.add('ag-has-thread'); unrest();
    input.placeholder = 'Ask your Agent';
    if (!kick) addYou((opts && opts.shown) || text, shots);
    var pending = addPending();
    setState('thinking');
    if (!kick) { input.value = ''; autosize(); syncHasText(); S.photos = []; renderTray(); }

    var body = kick ? { kickoff: 'onboarding', history: [] }
                    : { message: text, history: S.history, photos: shots.map(function (p) { return p.id; }) };
    var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 70000);
    api('/api/agent/chat', { method: 'POST', body: JSON.stringify(body), signal: ctl.signal })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok || !d || !d.success) throw new Error((d && d.message) || 'Something went wrong on my side.');
          return d;
        });
      })
      .then(function (d) {
        if (d.skipped || (kick && !d.reply)) { pending.remove(); if (!thread.children.length) document.body.classList.remove('ag-has-thread'); settle(); return; }
        var shown = fillAgent(pending, d);
        var turn = S.turn;
        // History must start with a user turn, so the interview opener gets a stand-in.
        S.history.push({ role: 'user', content: kick ? '(Opened Humarains: start the setup interview.)' : (text || 'I attached some photos.') + (shots.length ? ' [attached ' + shots.length + ' photo' + (shots.length === 1 ? '' : 's') + ']' : '') },
          { role: 'assistant', content: d.reply || '' });
        S.history = S.history.slice(-10);
        S.agentWaiting = d.state === 'waiting';

        var acted = (d.actions && d.actions.length) || d.modeChanged || d.profileUpdated;
        if (acted && window.refreshFromServer) window.refreshFromServer().catch(function () {});
        if (d.modeChanged && window.syncAgentMode) window.syncAgentMode(d.modeChanged);
        if (d.agentMode) setMode(d.agentMode, true);

        // Execute interface directives only AFTER the whole reply has been shown (plus a short beat to
        // let it be read). If the owner has already sent something newer, the directive is stale: skip it.
        (d.ui || []).forEach(function (u) {
          var run = null;
          if (u.type === 'open' && u.page === 'agent') run = function () { openPrefs(); };
          else if (u.type === 'open' && VIEWS.indexOf(u.page) !== -1) run = function () { openSurface(u.page); };
          else if (u.type === 'lead' && u.id) run = function () { openLead(u.id); };
          else if (u.type === 'approvals') run = function () { showApprovals(true); };
          if (!run) return;
          shown.then(function () {
            setTimeout(function () { if (turn === S.turn) run(); }, reduced ? 0 : 400);
          });
        });

        settle();
        if (acted && !S.agentWaiting) flash();
        loadBrief();
      })
      .catch(function (e) {
        S.agentWaiting = false;
        var msg = e && e.name === 'AbortError' ? 'That took too long. Try again in a moment.' : (e && e.message) || 'I couldn\u2019t reach the server.';
        fillAgent(pending, { reply: msg }, true);
        settle();
      })
      .then(function () { clearTimeout(to); S.busy = false; unrest(); });
  }

  // ── surfaces ─────────────────────────────────────────────────
  function isClassic() { return document.body.classList.contains('classic-ui'); }
  function openSurface(id) {
    if (!id) return;
    // Classic view has no page sheet: pages are just the main content, so only switch the page.
    if (isClassic()) {
      if (VIEWS.indexOf(id) !== -1 && window.showView && !(arguments[1] === 'from-event')) window.showView(id);
      return;
    }
    if (!S.surface) {
      S.surface = true;
      document.body.classList.add('ag-surface-open');
      stage.setAttribute('inert', ''); stage.setAttribute('aria-hidden', 'true');
      try { history.pushState({ ag: 1 }, ''); S.pushed = true; } catch (_) { S.pushed = false; }
      var c = $('agClose'); if (c) setTimeout(function () { c.focus({ preventScroll: true }); }, 60);
    }
    if (VIEWS.indexOf(id) !== -1 && window.showView && !(arguments[1] === 'from-event')) window.showView(id);
  }
  function closeSurface(fromPop) {
    if (!S.surface) return;
    S.surface = false;
    document.body.classList.remove('ag-surface-open');
    stage.removeAttribute('inert'); stage.removeAttribute('aria-hidden');
    if (S.pushed && !fromPop) { S.pushed = false; try { history.back(); } catch (_) {} }
    S.pushed = false;
    S.agentWaiting = false;
    unrest();
    settle();
    loadBrief();
    setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (_) {} }, 350);
  }
  // Any code path that calls showView (nav links inside pages, Agent actions, paywall) lands here
  document.addEventListener('lc:view', function (e) { openSurface(e.detail && e.detail.id, 'from-event'); });
  window.addEventListener('popstate', function () { if (S.surface) closeSurface(true); });
  // Used by ui-mode.js (Agent / Classic switch) and the Classic sidebar
  window.__agentUIHooks = {
    leaveSurface: function () {
      if (!S.surface) return;
      S.surface = false; S.pushed = false; S.agentWaiting = false;
      document.body.classList.remove('ag-surface-open');
      stage.removeAttribute('inert'); stage.removeAttribute('aria-hidden');
    },
    enter: function () { unrest(); settle(); loadBrief(); setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (_) {} }, 200); },
  };
  document.addEventListener('ag:open-prefs', function () { openPrefs(); });
  $('agScrim') && $('agScrim').addEventListener('click', function () { closeSurface(); });

  // Close button lives in the page header so it reads as part of the sheet
  (function injectClose() {
    var bar = document.querySelector('.lc-topbar'); if (!bar) return;
    var b = el('button', null); b.id = 'agClose'; b.type = 'button'; b.className = 'ag-close';
    b.setAttribute('aria-label', 'Close and return to your Agent');
    b.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Agent';
    b.addEventListener('click', function () { closeSurface(); });
    bar.insertBefore(b, bar.firstChild);
  })();

  // ── input behaviour ──────────────────────────────────────────
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 132) + 'px'; }
  function syncHasText() { box.classList.toggle('ag-has-text', !!input.value.trim()); }
  input.addEventListener('input', function () { autosize(); syncHasText(); unrest(); });
  input.addEventListener('focus', function () { unrest(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  $('agSend').addEventListener('click', function () { send(input.value); });
  // typing anywhere wakes the view; mouse movement alone does not, so the greeting stays up until you type
  document.addEventListener('keydown', function () { if (document.body.classList.contains('ag-resting')) unrest(); }, { passive: true });


  // ── voice input (browser dictation; text lands in the box, you still press send) ──
  (function voiceInput() {
    var mic = $('agMic'), SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!mic || !SR) return; // unsupported browser (e.g. Firefox): button stays hidden
    var rec = null, listening = false, base = '', finalText = '';
    function join(a, b) { a = String(a || '').replace(/\s+$/, ''); b = String(b || '').trim(); return a && b ? a + ' ' + b : a + b; }
    function paint(on) { listening = on; mic.classList.toggle('listening', on); mic.setAttribute('aria-pressed', String(on)); mic.title = on ? 'Stop dictating' : 'Speak instead of typing'; }
    function stop(discard) { if (rec) { if (discard === true) rec.onresult = null; try { rec.stop(); } catch (_) {} } }
    function start() {
      if (S.busy) return;
      rec = new SR();
      rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      base = input.value; finalText = '';
      rec.onstart = function () { paint(true); unrest(); };
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var r = e.results[i];
          if (r.isFinal) finalText = join(finalText, r[0].transcript); else interim = join(interim, r[0].transcript);
        }
        input.value = join(base, join(finalText, interim)).slice(0, input.maxLength > 0 ? input.maxLength : 3000);
        autosize(); syncHasText(); unrest();
      };
      rec.onerror = function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { note('Microphone access is blocked. Allow it in your browser\u2019s site settings to dictate.'); }
        else if (e.error === 'audio-capture') { note('I couldn\u2019t find a microphone.'); }
        else if (e.error === 'network') { note('Voice input needs an internet connection.'); }
      };
      rec.onend = function () { paint(false); rec = null; try { input.focus({ preventScroll: true }); } catch (_) {} };
      try { rec.start(); } catch (_) { paint(false); rec = null; }
    }
    mic.hidden = false;
    mic.addEventListener('click', function () { if (listening) stop(); else start(); });
    // sending (button, Enter, or a card) ends dictation first so late results can't refill the box
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && listening) { stop(true); } });
    $('agSend').addEventListener('click', function () { stop(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && listening) stop(); });
  })();

  // rotating placeholder: three or four things you can just say
  var phi = 0;
  function rotatePlaceholder() {
    if (document.activeElement === input || input.value || document.body.classList.contains('ag-has-thread')) return;
    input.classList.add('ph-fade');
    setTimeout(function () { var ex = examples(); phi = (phi + 1) % ex.length; input.placeholder = ex[phi]; input.classList.remove('ph-fade'); }, 420);
  }
  input.placeholder = examples()[0];
  if (!reduced) S.phTimer = setInterval(rotatePlaceholder, 4600);

  // global keys
  document.addEventListener('keydown', function (e) {
    if (isClassic() && e.key !== 'Escape') return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); if (S.surface) closeSurface(); setTimeout(function () { input.focus(); }, S.surface ? 380 : 0); return;
    }
    if (e.key === '/' && !typing && !S.surface) { e.preventDefault(); input.focus(); return; }
    if (e.key === 'Escape') {
      if (document.querySelector('.lc-slideover.open, .wf-slideover.open')) return; // let those close first
      if (!$('agPrefs').hidden) { closePrefs(); return; }
      var menu = $('agMenu'); if (menu && menu.classList.contains('open')) { menu.classList.remove('open'); return; }
      if (S.surface) closeSurface();
    }
  });

  // ── the one corner menu ──────────────────────────────────────
  var meBtn = $('agMeBtn'), menu = $('agMenu');
  function toggleMenu(open) {
    var o = open == null ? !menu.classList.contains('open') : open;
    menu.classList.toggle('open', o); meBtn.setAttribute('aria-expanded', String(o));
  }
  meBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) toggleMenu(false); });
  menu.addEventListener('click', function (e) {
    var t = e.target.closest('button[data-go]'); if (!t) return;
    toggleMenu(false);
    var go = t.dataset.go;
    if (go === 'logout') {
      api('/api/auth/logout', { method: 'POST' }).catch(function () {}).then(function () { window.location.href = '/login.html'; });
    } else if (go === 'agentsettings') { openPrefs(); }
    else { openSurface(go); }
  });

  // ── Agent settings panel (special instructions, reply length) ──
  S.mode = 'autonomous';   // the Agent always works on its own; there is no manual mode
  function setMode() { S.mode = 'autonomous'; if (S.brief) S.brief.agentMode = 'autonomous'; }
  function note(text) {
    document.body.classList.add('ag-has-thread'); unrest();
    var m = el('div', 'ag-msg agent', text); thread.appendChild(m); trimThread(); scrollEnd();
  }
  var prefs = $('agPrefs'), prefsStatus = $('agPrefsStatus'), prefsSave = $('agPrefsSave'), prefsLoaded = null, prefsFocusBack = null;
  function prefsMsg(text, bad) { prefsStatus.textContent = text || ''; prefsStatus.classList.toggle('err', !!bad); }
  function openPrefs() {
    prefsFocusBack = document.activeElement;
    prefs.hidden = false; prefsMsg('Loading\u2026'); prefsSave.disabled = true;
    api('/api/agent/prefs').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.success) throw new Error('load');
      prefsLoaded = d;
      $('agPrefInstr').value = d.agentInstructions || '';
      $('agPrefRules').value = d.specialInstructions || '';
      $('agPrefStyle').value = d.agentStyle || 'balanced';
      setMode(d.agentMode, true);
      prefsMsg(''); prefsSave.disabled = false;
      $('agPrefInstr').focus({ preventScroll: true });
    }).catch(function () { prefsMsg('Could not load your settings. Close this and try again.', true); });
  }
  function closePrefs() {
    prefs.hidden = true; prefsMsg('');
    try { if (prefsFocusBack && prefsFocusBack.focus) prefsFocusBack.focus({ preventScroll: true }); } catch (_) {}
  }
  function savePrefs() {
    var body = { agentInstructions: $('agPrefInstr').value, specialInstructions: $('agPrefRules').value, agentStyle: $('agPrefStyle').value };
    prefsSave.disabled = true; prefsMsg('Saving\u2026');
    api('/api/agent/prefs', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d || !x.d.success) { prefsMsg((x.d && x.d.message) || 'We could not save your changes.', true); prefsSave.disabled = false; return; }
        prefsSave.disabled = false;
        closePrefs(); note('Saved. I\u2019ll follow these from now on.'); loadBrief();
      })
      .catch(function () { prefsMsg('Could not save. Check your connection and try again.', true); prefsSave.disabled = false; });
  }
  $('agPrefsClose').addEventListener('click', closePrefs);
  $('agPrefsCancel').addEventListener('click', closePrefs);
  prefsSave.addEventListener('click', savePrefs);
  prefs.addEventListener('mousedown', function (e) { if (e.target === prefs) closePrefs(); });
  prefs.addEventListener('keydown', function (e) {   // keep Tab inside the dialog
    if (e.key !== 'Tab') return;
    var f = Array.prototype.slice.call(prefs.querySelectorAll('textarea, select, input, button')).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // the dashboard's own mode switch (leads.js) tells us when it changes
  


  // ── Rotating greeting above the input ────────────────────────
  var greetEl = $('agGreetText'), greetIdx = 0, greetTimer = null;
  function firstName() {
    var u = S.user; if (!u) return '';
    var n = String(u.name || '').trim().split(/\s+/)[0];
    if (!n && u.email) n = String(u.email).split('@')[0].split(/[._\-+]/)[0];
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
  }
  function dayPart() {
    var h = new Date().getHours();
    return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
  function greetings(n) {
    // each entry: [text before name, text after name]
    if (!n) return [['Welcome', ''], [dayPart(), ''], ['Welcome back', ''], ['Great to see you', ''], ['Ready when you are', ''], ['How can I help today?', '']];
    return [
      ['Welcome, ', ''],
      [dayPart() + ', ', ''],
      ['Welcome back, ', ''],
      ['Great to see you, ', ''],
      ['Ready when you are, ', ''],
      ['Hi ', ' \u2014 what shall we get done?'],
      ['How can I help today, ', '?'],
    ];
  }
  function paintGreeting(g, n) {
    greetEl.textContent = '';
    greetEl.appendChild(document.createTextNode(g[0]));
    if (n) { var b = document.createElement('b'); b.textContent = n; greetEl.appendChild(b); }
    if (g[1]) greetEl.appendChild(document.createTextNode(g[1]));
  }
  function nextGreeting(first) {
    if (!greetEl) return;
    var n = firstName(), list = greetings(n);
    if (document.hidden || document.body.classList.contains('ag-has-thread') || document.body.classList.contains('ag-surface-open')) { if (!first) return; }
    var g = list[greetIdx % list.length]; greetIdx++;
    if (first || reduced) { paintGreeting(g, n); return; }
    greetEl.classList.add('out');
    setTimeout(function () { paintGreeting(g, n); greetEl.classList.remove('out'); }, 560);
  }
  nextGreeting(true);
  greetTimer = setInterval(function () { nextGreeting(false); }, 5200);


  // ── Replies waiting for approval (manual mode) ───────────────
  // Drafts the AI wrote appear here on their own, with Send / Edit / Don't send, so the owner never has to
  // ask for the approval queue. The count comes from the brief; the cards are loaded when it changes.
  var qBox = $('agQ'), qList = $('agQList'), qCount = $('agQCount'), qTitle = $('agQTitle'), qAll = $('agQAll');
  var Q = { total: -1, items: [], loading: false, again: false, sending: false, armTimer: null, openAfter: false };

  function setApprOpen(open) {
    document.body.classList.toggle('ag-appr-open', !!open);
    if (qTitle) qTitle.setAttribute('aria-expanded', String(!!open || !document.body.classList.contains('ag-has-thread') || document.body.classList.contains('ag-resting')));
  }
  function showApprovals(open) { Q.openAfter = !!open; syncApprovals(Q.total < 0 ? 1 : Q.total, true); }
  if (qTitle) qTitle.addEventListener('click', function () {
    var threadOn = document.body.classList.contains('ag-has-thread') && !document.body.classList.contains('ag-resting');
    if (threadOn) setApprOpen(!document.body.classList.contains('ag-appr-open'));
    else { var hidden = qList.hidden; qList.hidden = !hidden; qTitle.setAttribute('aria-expanded', String(hidden)); if (qAll) qAll.hidden = !hidden || Q.items.length < 2; }
  });

  function syncApprovals(total, force) {
    if (!qBox) return;
    if (total === 0) { Q.total = 0; Q.items = []; qList.textContent = ''; qBox.hidden = true; document.body.classList.remove('ag-appr-open'); return; }
    if (!force && total === Q.total) return;
    Q.total = total;
    loadApprovals();
  }
  function loadApprovals() {
    if (Q.loading) { Q.again = true; return; }
    Q.loading = true;
    api('/api/agent/approvals').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.success) return;
      Q.total = d.total; Q.items = d.drafts || []; renderApprovals();
      if (Q.openAfter && Q.items.length) setApprOpen(true);
      Q.openAfter = false;
    }).catch(function () {}).then(function () { Q.loading = false; if (Q.again) { Q.again = false; loadApprovals(); } });
  }
  function qWord(n) { return n === 1 ? 'reply' : 'replies'; }
  function renderApprovals() {
    var items = Q.items;
    if (!items.length) { qBox.hidden = true; qList.textContent = ''; return; }
    qBox.hidden = false;
    var n = Math.max(Q.total, items.length);
    qCount.textContent = n + ' ' + qWord(n) + ' ready to send' + (Q.total > items.length ? ' (showing ' + items.length + ')' : '');
    qAll.hidden = items.filter(function (i) { return i.canSend; }).length < 2;
    // keep cards the owner is working on; add new ones; drop the ones that are gone
    var have = {}; Array.prototype.forEach.call(qList.children, function (c) { have[c.dataset.id] = c; });
    var want = {}; items.forEach(function (i) { want[i.id] = true; });
    Object.keys(have).forEach(function (id) { if (!want[id]) have[id].remove(); });
    var prev = null;
    items.forEach(function (it) {
      var card = have[it.id] || approvalCard(it);
      if (!have[it.id]) { if (prev) prev.after(card); else qList.insertBefore(card, qList.firstChild); }
      prev = card;
    });
    setApprOpen(document.body.classList.contains('ag-appr-open'));
    hintScroll();
  }
  // Soft fade at the bottom of the list while there is more to scroll to.
  function hintScroll() {
    requestAnimationFrame(function () {
      qList.classList.toggle('scrolls', qList.scrollHeight > qList.clientHeight + 2);
      qList.classList.toggle('at-end', qList.scrollTop + qList.clientHeight >= qList.scrollHeight - 6);
    });
  }
  if (qList) { qList.addEventListener('scroll', hintScroll, { passive: true }); window.addEventListener('resize', hintScroll); }

  function approvalCard(it) {
    var card = el('article', 'ag-q-card'); card.dataset.id = it.id;
    var top = el('div', 'ag-q-top'); top.appendChild(el('b', null, it.name)); if (it.contact) top.appendChild(el('span', null, it.contact)); card.appendChild(top);
    if (it.theirMessage) card.appendChild(el('div', 'ag-q-they', 'They wrote: ' + it.theirMessage));
    if (it.subject) card.appendChild(el('div', 'ag-q-subj', it.subject));
    // Preview collapses blank lines so the clamp shows more of the reply; "Show full reply" restores the original.
    var short = it.body.replace(/\n{2,}/g, '\n'), draft = el('div', 'ag-q-draft', short); card.appendChild(draft);
    var long = it.body.length > 240 || it.body.split('\n').length > 5, more = null;
    if (long) {
      more = el('button', 'ag-q-more', 'Show full reply'); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', function () {
        var full = card.classList.toggle('full');
        draft.textContent = full ? it.body : short; more.textContent = full ? 'Show less' : 'Show full reply'; more.setAttribute('aria-expanded', String(full)); hintScroll();
      });
      card.appendChild(more);
    }
    var edit = el('div', 'ag-q-edit'); var ta = document.createElement('textarea'); ta.value = it.body; ta.maxLength = 5000;
    ta.setAttribute('aria-label', 'Reply to ' + it.name); edit.appendChild(ta); edit.appendChild(el('small', null, 'Sent exactly as shown.')); card.appendChild(edit);
    if (it.photoCount) card.appendChild(el('div', 'ag-q-meta', it.photoCount + (it.photoCount === 1 ? ' photo' : ' photos') + ' attached'));
    if (!it.canSend) card.appendChild(el('div', 'ag-q-meta', 'This lead has no email address, so the reply can\u2019t be sent from here.'));
    var acts = el('div', 'ag-q-acts');
    var send = el('button', 'ag-btn primary', 'Send'); send.type = 'button';
    var ed = el('button', 'ag-btn ghost', 'Edit'); ed.type = 'button';
    var skip = el('button', 'ag-btn link', 'Don\u2019t send'); skip.type = 'button'; skip.title = 'Discard this draft. The lead stays open.';
    if (!it.canSend) { send.disabled = true; send.title = 'This lead has no email address'; }
    acts.appendChild(send); acts.appendChild(ed); acts.appendChild(skip); card.appendChild(acts);
    card._item = it; card._ta = ta; card._send = send;

    ed.addEventListener('click', function () { card.classList.add('open'); ed.hidden = true; if (more) more.hidden = true; ta.focus({ preventScroll: true }); hintScroll(); });
    send.addEventListener('click', function () { sendOne(card); });
    skip.addEventListener('click', function () {
      skip.disabled = send.disabled = ed.disabled = true; clearQMsg(card);
      qPost(it.id, 'reject', { keepOpen: true }).then(function (x) {
        if (!x.ok) { skip.disabled = ed.disabled = false; send.disabled = !it.canSend; return qMsg(card, (x.d && x.d.message) || 'Could not discard this draft.'); }
        removeCard(card); afterApprovalChange();
      });
    });
    return card;
  }
  function clearQMsg(card) { var m = card.querySelector('.ag-q-msg'); if (m) m.remove(); }
  function qMsg(card, text, upgrade) {
    clearQMsg(card);
    var m = el('p', 'ag-q-msg', text);
    if (upgrade) { var b = el('button', null, 'See plans'); b.type = 'button'; b.addEventListener('click', function () { openSurface('payment'); }); m.appendChild(b); }
    card.appendChild(m);
  }
  function qPost(id, what, body) {
    return api('/api/leads/consent-queue/' + encodeURIComponent(id) + '/' + what, { method: 'POST', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok && d && d.success, d: d, status: r.status }; }); })
      .catch(function () { return { ok: false, d: { message: 'I couldn\u2019t reach the server. Check your connection and try again.' } }; });
  }
  function removeCard(card) {
    var id = card._item && card._item.id;
    Q.items = Q.items.filter(function (i) { return i.id !== id; }); Q.total = Math.max(0, Q.total - 1);
    card.classList.add('gone'); setTimeout(function () { card.remove(); }, reduced ? 0 : 300);
  }
  function afterApprovalChange() {
    if (!Q.items.length) { qBox.hidden = true; document.body.classList.remove('ag-appr-open'); } else renderApprovals();
    if (window.refreshFromServer) window.refreshFromServer().catch(function () {});
    loadBrief();
  }
  // One send. Resolves true when sent; false (with the reason shown on the card) when not.
  function sendOne(card) {
    var it = card._item, ta = card._ta, btn = card._send;
    var text = ta.value.trim();
    if (!text) { qMsg(card, 'The reply cannot be empty.'); return Promise.resolve(false); }
    btn.disabled = true; btn.textContent = 'Sending\u2026'; clearQMsg(card);
    var payload = text !== it.body.trim() ? { body: text } : {};
    return qPost(it.id, 'approve', payload).then(function (x) {
      if (!x.ok) {
        btn.disabled = false; btn.textContent = 'Send';
        qMsg(card, (x.d && x.d.message) || 'Could not send this reply.', x.status === 402 || (x.d && x.d.quotaExceeded));
        return false;
      }
      var done = el('div', 'ag-q-sent', 'Sent to ' + it.name + '.');
      card.textContent = ''; card.appendChild(done);
      setTimeout(function () { removeCard(card); afterApprovalChange(); }, reduced ? 0 : 900);
      return true;
    });
  }
  // Send all: asks once more on the button itself, then goes through the cards one at a time.
  if (qAll) qAll.addEventListener('click', function () {
    if (Q.sending) return;
    if (!qAll.classList.contains('sure')) {
      var n = Array.prototype.filter.call(qList.children, function (c) { return c._item && c._item.canSend; }).length;
      qAll.classList.add('sure'); qAll.textContent = 'Send ' + n + '? Tap again';
      clearTimeout(Q.armTimer); Q.armTimer = setTimeout(disarmAll, 4000); return;
    }
    clearTimeout(Q.armTimer); Q.sending = true; qAll.disabled = true;
    var cards = Array.prototype.filter.call(qList.children, function (c) { return c._item && c._item.canSend; }), i = 0, sent = 0;
    (function next() {
      if (i >= cards.length) return finish();
      qAll.textContent = 'Sending ' + (i + 1) + ' of ' + cards.length + '\u2026';
      sendOne(cards[i++]).then(function (ok) {
        if (ok) { sent++; return next(); }
        finish();   // stop at the first problem (limit reached, bad address); the card says why
      });
    })();
    function finish() {
      Q.sending = false; qAll.disabled = false; disarmAll();
      if (!sent) return;
      var msg = sent === 1 ? 'Sent 1 reply.' : 'Sent ' + sent + ' replies.';
      // Everything cleared: say so in the conversation. Otherwise keep the panel open and report in its header,
      // so a card that still needs attention is never tucked away.
      setTimeout(function () {
        if (!Q.items.length) { note(msg + ' Nothing else is waiting on you.'); return; }
        qCount.textContent = msg + ' ' + Q.items.length + ' still waiting.';
        setTimeout(function () { if (Q.items.length) renderApprovals(); }, 4000);
      }, reduced ? 0 : 1000);
    }
  });
  function disarmAll() { qAll.classList.remove('sure'); qAll.textContent = 'Send all'; }

  // ── boot ─────────────────────────────────────────────────────
  api('/api/users/me').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.success && d.user) {
      S.user = d.user;
      var name = d.user.name || d.user.email || 'You';
      var initials = String(name).split(' ').filter(Boolean).map(function (n) { return n[0]; }).join('').slice(0, 2).toUpperCase() || '?';
      meBtn.textContent = initials;
      $('agMenuName').textContent = name;
      var PL = { free: 'Free plan', starter: 'Starter plan', growth: 'Growth plan', business: 'Pro plan' };
      $('agMenuPlan').textContent = PL[d.user.plan] || '';
      greetIdx = 0; nextGreeting(true); greetIdx = 1;
    }
  }).catch(function () {});
  // ── Links from emails: open the exact page / lead / request they are about, not just the Agent's home screen ──────────────
  // ?view=<page>  opens that page      ?lead=<id>  opens that lead's conversation      ?ask=opportunities  asks the Agent for the follow-ups
  // waiting for approval. The parameters were saved by leads.js so they survive a login. Only known values are used.
  var ASKS = { opportunities: 'Show me the follow-ups that are ready for my approval.' };
  function readDeepLink() {
    var raw = null;
    try { var saved = JSON.parse(sessionStorage.getItem('hm_go') || 'null'); if (saved && Date.now() - saved.t < 30 * 60 * 1000) raw = saved.q; sessionStorage.removeItem('hm_go'); } catch (_) {}
    if (!raw) raw = window.location.search || '';
    var p; try { p = new URLSearchParams(raw); } catch (_) { return null; }
    var go = { view: p.get('view') || '', lead: p.get('lead') || '', ask: p.get('ask') || '' };
    if (VIEWS.indexOf(go.view) === -1) go.view = '';
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(go.lead)) go.lead = '';
    if (!ASKS[go.ask]) go.ask = '';
    return (go.view || go.lead || go.ask) ? go : null;
  }
  function openDeepLink() {
    var go = readDeepLink();
    if (!go) return;
    try { var u = new URL(window.location.href); ['view', 'lead', 'ask'].forEach(function (k) { u.searchParams.delete(k); }); history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash); } catch (_) {}
    var tries = 0;
    (function waitReady() {
      if (window.showView && (!go.lead || window.openLeadById)) {
        if (go.view) openSurface(go.view);
        else if (go.lead) openSurface('leads');
        if (go.lead) setTimeout(function () { window.openLeadById(go.lead); }, 350);
        if (go.ask && !go.view && !go.lead) setTimeout(function () { if (!S.busy) send(ASKS[go.ask]); }, 600);
        return;
      }
      if (++tries < 150) setTimeout(waitReady, 100);   // up to 15 s while the dashboard finishes loading
    })();
  }
  openDeepLink();

  loadBrief();
  setState('idle');
  setInterval(function () { if (!S.surface && !isClassic() && !document.hidden && !S.busy) loadBrief(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !S.surface && !isClassic()) loadBrief(); });
  setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (_) {} }, 400);
})();
