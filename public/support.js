/* ════════════════════════════════════════════════════════════════
   Humarains — Support page
   Owners write to the admin and read the replies here. The admin answers
   from the admin panel (Support tab). Conversations are stored on the
   server (routes/support.js); nothing is kept in the browser.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SupportUI) return;

  var CATEGORIES = [
    ['question', 'A question'], ['problem', 'Something isn\u2019t working'], ['billing', 'Billing'],
    ['feature', 'A feature idea'], ['other', 'Something else'],
  ];
  var CATEGORY_LABEL = {}; CATEGORIES.forEach(function (c) { CATEGORY_LABEL[c[0]] = c[1]; });
  var STATUS_LABEL = { open: 'Waiting for us', answered: 'We replied', resolved: 'Resolved' };
  var MAX = { subject: 200, message: 4000 };

  var $ = function (id) { return document.getElementById(id); };
  var S = { openId: null, lastMsgId: 0, timer: null, unreadTimer: null };

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function csrf() {
    try { var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; }); return m ? decodeURIComponent(m.split('=')[1]) : ''; }
    catch (_) { return ''; }
  }
  function api(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({ credentials: 'include' }, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, opts.headers || {}),
    })).then(function (r) {
      if (r.status === 401) { window.location.href = '/login.html'; }
      return r.json().catch(function () { return { success: false, message: 'Unexpected response from the server.' }; })
        .then(function (d) { d.httpStatus = r.status; return d; });
    }).catch(function () { return { success: false, message: 'Could not reach the server. Check your connection and try again.' }; });
  }
  function when(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var now = new Date(), sameDay = d.toDateString() === now.toDateString();
    var opts = sameDay ? { hour: 'numeric', minute: '2-digit' } : (d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
    return (sameDay ? 'Today, ' : '') + d.toLocaleString(undefined, opts);
  }
  function chip(status) { return el('span', 'sp-chip is-' + status, STATUS_LABEL[status] || status); }
  function isActive() { var v = $('view-support'); return !!(v && v.classList.contains('active')); }
  function setStatus(node, text, isError) { node.textContent = text || ''; node.classList.toggle('is-error', !!isError); }

  // ── Unread markers (sidebar item, account menu, account button) ──────────
  function setBadge(n) {
    n = n || 0;
    ['navBadgeSupport', 'agMenuSupportBadge'].forEach(function (id) {
      var b = $(id); if (!b) return; b.textContent = n > 9 ? '9+' : String(n); b.classList.toggle('is-on', n > 0);
    });
    var me = $('agMeBtn'); if (me) { if (n > 0) me.setAttribute('data-dot', ''); else me.removeAttribute('data-dot'); }
  }
  function refreshUnread() {
    if (document.hidden) return;
    api('/api/support/unread').then(function (d) { if (d && d.success) setBadge(d.unread); });
  }

  // ── Home: new message + list of conversations ───────────────────────────
  function showHome() {
    var root = $('supportRoot'); if (!root) return;
    stopPoll(); S.openId = null; root.textContent = '';
    root.appendChild(el('p', 'sp-lead', 'Ask a question, report a problem or suggest an idea. We reply here, and by email.'));

    var cols = el('div', 'sp-cols'); root.appendChild(cols);

    // New message
    var card = el('section', 'lc-settings-section'); card.appendChild(el('div', 'lc-settings-title', 'Send a message'));
    var form = el('div', 'sp-form'); card.appendChild(form);

    var fCat = el('div', 'lc-field'), lCat = el('label', 'lc-label', 'What is this about?'); lCat.setAttribute('for', 'spCategory');
    var sel = el('select', 'lc-select'); sel.id = 'spCategory';
    CATEGORIES.forEach(function (c) { var o = el('option', null, c[1]); o.value = c[0]; sel.appendChild(o); });
    fCat.appendChild(lCat); fCat.appendChild(sel); form.appendChild(fCat);

    var fSub = el('div', 'lc-field'), lSub = el('label', 'lc-label', 'Subject'); lSub.setAttribute('for', 'spSubject');
    var sub = el('input', 'lc-input'); sub.id = 'spSubject'; sub.type = 'text'; sub.maxLength = MAX.subject; sub.placeholder = 'A short summary'; sub.autocomplete = 'off';
    fSub.appendChild(lSub); fSub.appendChild(sub); form.appendChild(fSub);

    var fMsg = el('div', 'lc-field'), lMsg = el('label', 'lc-label', 'Message'); lMsg.setAttribute('for', 'spMessage');
    var msg = el('textarea', 'lc-input'); msg.id = 'spMessage'; msg.maxLength = MAX.message;
    msg.placeholder = 'Tell us what you need. For a problem, say what you expected and what happened instead.';
    fMsg.appendChild(lMsg); fMsg.appendChild(msg); form.appendChild(fMsg);

    var foot = el('div', 'sp-form-foot');
    var send = el('button', 'lc-btn lc-btn-primary', 'Send message'); send.type = 'button';
    var status = el('span', 'sp-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var count = el('span', 'sp-count', '0 / ' + MAX.message);
    foot.appendChild(send); foot.appendChild(status); foot.appendChild(count); form.appendChild(foot);
    msg.addEventListener('input', function () { count.textContent = msg.value.length + ' / ' + MAX.message; });

    function submit() {
      var subject = sub.value.trim(), message = msg.value.trim();
      if (!subject) { setStatus(status, 'Add a subject so we know what this is about.', true); sub.focus(); return; }
      if (!message) { setStatus(status, 'Write your message.', true); msg.focus(); return; }
      send.disabled = true; setStatus(status, 'Sending\u2026');
      api('/api/support/tickets', { method: 'POST', body: JSON.stringify({ category: sel.value, subject: subject, message: message }) })
        .then(function (d) {
          send.disabled = false;
          if (!d.success) { setStatus(status, d.message || 'Could not send your message.', true); return; }
          openThread(d.id);
        });
    }
    send.addEventListener('click', submit);
    msg.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
    cols.appendChild(card);

    // Conversations
    var listCard = el('section', 'lc-settings-section'); listCard.appendChild(el('div', 'lc-settings-title', 'Your messages'));
    var list = el('div', 'sp-list'); list.id = 'spList'; list.appendChild(el('p', 'sp-empty', 'Loading\u2026'));
    listCard.appendChild(list); cols.appendChild(listCard);
    loadList();
  }

  function loadList() {
    api('/api/support/tickets').then(function (d) {
      var list = $('spList'); if (!list || S.openId) return;
      list.textContent = '';
      if (!d.success) { list.appendChild(el('p', 'sp-empty', d.message || 'Could not load your messages.')); return; }
      setBadge(d.unread);
      if (!d.tickets.length) { list.appendChild(el('p', 'sp-empty', 'Nothing here yet. Messages you send, and our replies, will appear here.')); return; }
      d.tickets.forEach(function (t) {
        var row = el('button', 'sp-row' + (t.unread ? ' is-unread' : '')); row.type = 'button';
        row.setAttribute('aria-label', t.subject + '. ' + (STATUS_LABEL[t.status] || t.status) + (t.unread ? '. New reply.' : ''));
        row.appendChild(el('span', 'sp-dot'));
        var main = el('span', 'sp-row-main');
        main.appendChild(el('span', 'sp-row-subject', t.subject));
        main.appendChild(el('span', 'sp-row-meta', (CATEGORY_LABEL[t.category] || '') + ' \u00b7 ' + when(t.lastMessageAt) + (t.unread ? ' \u00b7 New reply' : '')));
        row.appendChild(main); row.appendChild(chip(t.status));
        row.addEventListener('click', function () { openThread(t.id); });
        list.appendChild(row);
      });
    });
  }

  // ── Thread ──────────────────────────────────────────────────────────────
  function openThread(id) {
    var root = $('supportRoot'); if (!root) return;
    S.openId = id; S.lastMsgId = 0; root.textContent = '';
    var wrap = el('div', 'sp-thread'); root.appendChild(wrap);

    var back = el('button', 'sp-back'); back.type = 'button';
    back.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    back.appendChild(document.createTextNode('All messages'));
    back.addEventListener('click', showHome); wrap.appendChild(back);

    var head = el('div', 'sp-head'); head.id = 'spHead'; wrap.appendChild(head);
    var note = el('p', 'sp-note'); note.id = 'spNote'; note.hidden = true; wrap.appendChild(note);
    var msgs = el('div', 'sp-msgs'); msgs.id = 'spMsgs'; msgs.setAttribute('role', 'log'); msgs.setAttribute('aria-live', 'polite'); wrap.appendChild(msgs);

    var card = el('section', 'lc-settings-section'); var reply = el('div', 'sp-reply'); card.appendChild(reply);
    var f = el('div', 'lc-field'), l = el('label', 'lc-label', 'Your reply'); l.setAttribute('for', 'spReply');
    var ta = el('textarea', 'lc-input'); ta.id = 'spReply'; ta.maxLength = MAX.message; ta.placeholder = 'Write a reply';
    f.appendChild(l); f.appendChild(ta); reply.appendChild(f);
    var foot = el('div', 'sp-reply-foot');
    var send = el('button', 'lc-btn lc-btn-primary', 'Send reply'); send.type = 'button';
    var resolve = el('button', 'lc-btn lc-btn-ghost', 'Mark as resolved'); resolve.type = 'button'; resolve.id = 'spResolve';
    var status = el('span', 'sp-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    foot.appendChild(send); foot.appendChild(resolve); foot.appendChild(status); reply.appendChild(foot);
    wrap.appendChild(card);

    function submit() {
      var message = ta.value.trim();
      if (!message) { setStatus(status, 'Write your reply.', true); ta.focus(); return; }
      send.disabled = true; setStatus(status, 'Sending\u2026');
      api('/api/support/tickets/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: JSON.stringify({ message: message }) })
        .then(function (d) {
          send.disabled = false;
          if (!d.success) { setStatus(status, d.message || 'Could not send your reply.', true); return; }
          ta.value = ''; setStatus(status, ''); loadThread(true);
        });
    }
    send.addEventListener('click', submit);
    ta.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
    resolve.addEventListener('click', function () {
      resolve.disabled = true;
      api('/api/support/tickets/' + encodeURIComponent(id) + '/status', { method: 'POST', body: JSON.stringify({ status: 'resolved' }) })
        .then(function (d) { resolve.disabled = false; if (!d.success) setStatus(status, d.message || 'Could not update this conversation.', true); else loadThread(false); });
    });

    loadThread(true); startPoll();
  }

  function loadThread(scrollToEnd) {
    var id = S.openId; if (!id) return;
    api('/api/support/tickets/' + encodeURIComponent(id)).then(function (d) {
      if (S.openId !== id) return;
      var msgsEl = $('spMsgs'), head = $('spHead'); if (!msgsEl || !head) return;
      if (!d.success) {
        if (d.httpStatus === 404) { showHome(); return; }
        head.textContent = ''; head.appendChild(el('p', 'sp-empty', d.message || 'Could not load this conversation.')); return;
      }
      var t = d.ticket;
      head.textContent = '';
      var titleBox = el('div'); titleBox.style.flex = '1 1 280px';
      titleBox.appendChild(el('h2', 'sp-title', t.subject));
      titleBox.appendChild(el('p', 'sp-sub', (CATEGORY_LABEL[t.category] || '') + ' \u00b7 Started ' + when(t.createdAt)));
      head.appendChild(titleBox); head.appendChild(chip(t.status));

      var note = $('spNote');
      if (t.status === 'resolved') { note.hidden = false; note.textContent = 'This conversation is marked resolved. Send a reply if you still need help and it will reopen.'; }
      else note.hidden = true;
      var rb = $('spResolve'); if (rb) rb.hidden = t.status === 'resolved';

      var last = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
      if (last !== S.lastMsgId) {
        S.lastMsgId = last; msgsEl.textContent = '';
        d.messages.forEach(function (m) {
          var box = el('div', 'sp-msg ' + (m.from === 'admin' ? 'from-admin' : 'from-user'));
          var who = el('p', 'sp-msg-who'); who.appendChild(el('b', null, m.from === 'admin' ? 'Humarains support' : 'You')); who.appendChild(document.createTextNode(' \u00b7 ' + when(m.createdAt)));
          box.appendChild(who); box.appendChild(el('p', 'sp-msg-body', m.body)); msgsEl.appendChild(box);
        });
        if (scrollToEnd) { var lastEl = msgsEl.lastElementChild; if (lastEl && lastEl.scrollIntoView) lastEl.scrollIntoView({ block: 'nearest' }); }
      }
      refreshUnread();
    });
  }

  function startPoll() { stopPoll(); S.timer = setInterval(function () { if (!document.hidden && isActive() && S.openId) loadThread(false); }, 30000); }
  function stopPoll() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  function render() { if (S.openId && $('spMsgs')) { loadThread(false); } else showHome(); }

  window.SupportUI = { render: render };

  // The dashboard tells us when a page opens (see showView in leads.js); also cover a page opened before this script loaded.
  document.addEventListener('lc:view', function (e) { if (e.detail && e.detail.id === 'support') render(); });
  if (isActive()) render();
  refreshUnread();
  S.unreadTimer = setInterval(refreshUnread, 90000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshUnread(); });
})();
