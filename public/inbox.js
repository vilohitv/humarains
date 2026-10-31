/* Inbox: every customer conversation (WhatsApp and email) as a chat you can read and answer, like WhatsApp.
   Talks to /api/leads/inbox/conversations (routes/leads.js). leads.js calls Inbox.open() when the page opens. */
(function () {
  'use strict';
  var BASE = '/api/leads/inbox/conversations';
  var MAX = 1000;
  var root, started = false;
  var S = { chats: [], active: null, thread: null, filter: 'all', q: '', sending: false, drafts: {} };
  var seen = {};
  try { seen = JSON.parse(localStorage.getItem('wai_seen') || '{}') || {}; } catch (_) { seen = {}; }

  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  function csrf() { try { var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; }); return m ? decodeURIComponent(m.split('=')[1]) : ''; } catch (_) { return ''; } }
  function api(path, opts) {
    opts = opts || {};
    return fetch(BASE + path, Object.assign({ credentials: 'include' }, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, opts.headers || {})
    })).then(function (r) {
      if (r.status === 401) { location.href = '/login.html'; return { ok: false, status: 401, data: {} }; }
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }
  var initials = function (n) { return String(n || '?').replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?'; };
  var chanName = function (c) { return c === 'whatsapp' ? 'WhatsApp' : 'Email'; };
  var isUnread = function (c) { return c.lastDirection === 'inbound' && c.lastAt && (!seen[c.id] || new Date(c.lastAt) > new Date(seen[c.id])); };
  var markSeen = function (id, at) { seen[id] = at || new Date().toISOString(); try { localStorage.setItem('wai_seen', JSON.stringify(seen)); } catch (_) {} };
  var clock = function (iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date(), day = 86400000;
    if (d.toDateString() === now.toDateString()) return clock(iso);
    if (now - d < 6 * day) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function dayLabel(iso) {
    var d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (new Date(now - 86400000).toDateString() === d.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function closesIn(iso) {
    var ms = new Date(iso) - Date.now(); if (ms <= 0) return '';
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  function build() {
    root.innerHTML =
      '<aside class="wai-list-pane" aria-label="Conversations">' +
        '<div class="wai-top"><div class="wai-title">Inbox</div>' +
        '<input class="wai-search" id="waiSearch" type="search" placeholder="Search by name, number or email" aria-label="Search conversations" autocomplete="off">' +
        '<div class="wai-filters" role="group" aria-label="Filter conversations">' +
          ['all:All', 'unread:Unread', 'whatsapp:WhatsApp', 'email:Email'].map(function (x, i) { var p = x.split(':'); return '<button class="wai-filter" type="button" data-f="' + p[0] + '" aria-pressed="' + (i === 0) + '">' + p[1] + '</button>'; }).join('') +
        '</div></div>' +
        '<ul class="wai-list" id="waiList"></ul></aside>' +
      '<section class="wai-pane" id="waiPane" aria-label="Conversation"></section>';
    root.querySelector('#waiSearch').addEventListener('input', function (e) { S.q = e.target.value.trim().toLowerCase(); renderList(); });
    root.querySelector('.wai-filters').addEventListener('click', function (e) {
      var b = e.target.closest('.wai-filter'); if (!b) return;
      S.filter = b.getAttribute('data-f');
      root.querySelectorAll('.wai-filter').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      renderList();
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.wai-more'); if (!b) return;
      var q = b.nextElementSibling; if (!q) return;
      var open = q.hasAttribute('hidden');
      if (open) q.removeAttribute('hidden'); else q.setAttribute('hidden', '');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    root.querySelector('#waiList').addEventListener('click', function (e) { var b = e.target.closest('.wai-item'); if (b) openChat(b.getAttribute('data-id')); });
    renderPane();
  }

  function renderList() {
    var ul = root.querySelector('#waiList'); if (!ul) return;
    var rows = S.chats.filter(function (c) {
      if (S.q && (c.name + ' ' + (c.contact || '')).toLowerCase().indexOf(S.q) < 0) return false;
      if (S.filter === 'unread') return isUnread(c);
      if (S.filter === 'whatsapp' || S.filter === 'email') return c.channel === S.filter;
      return true;
    });
    var unread = S.chats.filter(isUnread).length, dot = document.getElementById('navDotInbox');
    if (dot) dot.style.display = unread ? '' : 'none';
    if (!rows.length) {
      ul.innerHTML = '<li class="wai-none">' + (S.chats.length ? 'No conversations match.' : 'No conversations yet. Messages from WhatsApp and email show up here as chats.') + '</li>';
      return;
    }
    ul.innerHTML = rows.map(function (c) {
      var un = isUnread(c);
      var prev = (c.lastDirection === 'outbound' ? 'You: ' : '') + (c.preview || 'No messages yet');
      return '<li><button type="button" class="wai-item' + (un ? ' unread' : '') + '" data-id="' + esc(c.id) + '"' + (c.id === S.active ? ' aria-current="true"' : '') + '>' +
        '<span class="wai-avatar" aria-hidden="true">' + esc(initials(c.name)) + '</span>' +
        '<span><span class="wai-name-row"><span class="wai-name">' + esc(c.name) + '</span><span class="wai-chan">' + chanName(c.channel) + '</span></span><span class="wai-prev">' + esc(prev) + '</span></span>' +
        '<span class="wai-meta"><span>' + esc(when(c.lastAt)) + '</span>' + (un ? '<span class="wai-dot" role="img" aria-label="Unread"></span>' : '') + '</span></button></li>';
    }).join('');
  }

  function windowChip(c) {
    if (c.channel === 'email') return '<span class="wai-chip">Email</span>';
    return c.windowOpen ? '<span class="wai-chip">Reply window open, ' + esc(closesIn(c.windowClosesAt)) + ' left</span>' : '<span class="wai-chip off">Reply window closed</span>';
  }

  function renderPane() {
    var pane = root.querySelector('#waiPane'); if (!pane) return;
    var t = S.thread;
    if (!S.active || !t) {
      pane.innerHTML = '<div class="wai-blank">' + (S.active ? 'Opening conversation' : 'Choose a conversation to read it and reply.') + '</div>';
      root.classList.remove('open');
      return;
    }
    root.classList.add('open');
    var c = t.chat, canSend = !!c.canReply;
    pane.innerHTML =
      '<div class="wai-head"><button class="wai-back" type="button" id="waiBack" aria-label="Back to conversations">&larr;</button>' +
        '<span class="wai-avatar" aria-hidden="true">' + esc(initials(c.name)) + '</span>' +
        '<div class="wai-who"><strong>' + esc(c.name) + '</strong><span>' + esc(c.contact || '') + '</span></div><span id="waiChip">' + windowChip(c) + '</span>' +
        '<button class="wai-ai' + (c.aiPaused ? ' paused' : '') + '" type="button" id="waiAi" title="' + (c.aiPaused ? 'The AI is not answering this conversation' : 'The AI answers new messages in this conversation') + '">' + (c.aiPaused ? 'Resume AI' : 'Pause AI') + '</button></div>' +
      '<div class="wai-log" id="waiLog" role="log" aria-live="polite" aria-label="Messages"></div>' +
      '<div class="wai-compose">' + (!canSend && c.blockedReason ? '<div class="wai-note" id="waiNote">' + esc(c.blockedReason) + '</div>' : '') +
        '<div class="wai-row"><textarea class="wai-input" id="waiInput" rows="1" maxlength="' + MAX + '" placeholder="' + (c.channel === 'email' ? 'Write an email reply' : 'Type a message') + '" aria-label="Message"' + (canSend ? '' : ' disabled') + '></textarea>' +
        '<button class="wai-send" type="button" id="waiSend" disabled>Send</button></div>' +
        '<div class="wai-foot"><span id="waiMsg" class="wai-err" role="alert"></span><span id="waiCount"></span></div></div>';
    pane.querySelector('#waiBack').addEventListener('click', function () { S.active = null; S.thread = null; renderPane(); renderList(); });
    pane.querySelector('#waiAi').addEventListener('click', toggleAi);
    var input = pane.querySelector('#waiInput'), send = pane.querySelector('#waiSend');
    input.value = S.drafts[S.active] || '';
    var sync = function () {
      S.drafts[S.active] = input.value;
      send.disabled = !canSend || S.sending || !input.value.trim();
      pane.querySelector('#waiCount').textContent = input.value.length > MAX - 200 ? input.value.length + ' / ' + MAX : '';
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) sendMessage(); } });
    send.addEventListener('click', sendMessage);
    sync(); renderLog(true);
  }


  // Email bodies arrive with the whole reply chain attached ("On Fri, ... wrote:" and "> quoted" lines).
  // Show only what the person actually wrote; keep the rest one tap away.
  function splitEmail(body) {
    var text = String(body == null ? '' : body).replace(/\r\n?/g, '\n').trim();
    var re = /^[ \t]*(On\s[^\n]{0,200}?(?:\n[^\n]{0,120})?\swrote:[ \t]*|-{2,}\s*Original Message\s*-{2,}.*|_{5,}|From:\s.+\nSent:\s.+|>.*)$/m;
    var m = re.exec(text), main = text, quote = '';
    if (m) { main = text.slice(0, m.index).trim(); quote = text.slice(m.index).trim(); }
    if (!main && quote) { main = text; quote = ''; }          // never show an empty bubble
    main = main.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    quote = quote.split('\n').map(function (l) { return l.replace(/^[ \t]*(>[ \t]?)+/, ''); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { main: main, quote: quote };
  }
  var cleanSubject = function (s) { return String(s || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').trim(); };

  function renderLog(toBottom) {
    var log = root.querySelector('#waiLog'); if (!log || !S.thread) return;
    var nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    var html = '', lastDay = '', lastSubj = null, email = S.thread.chat.channel === 'email';
    S.thread.messages.forEach(function (m, i) {
      if (m.at) { var d = dayLabel(m.at); if (d !== lastDay) { html += '<div class="wai-day">' + esc(d) + '</div>'; lastDay = d; } }
      var out = m.direction === 'outbound';
      var cls = 'wai-msg ' + (out ? 'out' : 'in') + (m.pending ? ' draft' : '') + (m.failed ? ' fail' : '');
      var who = !out ? '' : (m.pending ? 'AI draft, waiting for approval. Not sent.' : (m.by === 'owner' ? 'You' : 'Humarains AI'));
      var time = m.sending ? 'Sending' : (m.at && !m.pending ? clock(m.at) : '');
      var parts = email ? splitEmail(m.body) : { main: String(m.body == null ? '' : m.body), quote: '' };
      var subj = email ? cleanSubject(m.subject) : '';
      var showSubj = subj && subj.toLowerCase() !== lastSubj;   // say the subject once per thread, not on every bubble
      if (subj) lastSubj = subj.toLowerCase();
      html += '<div class="' + cls + '">' + (who ? '<span class="wai-sub">' + esc(who) + '</span>' : '') +
        '<div class="wai-bubble">' +
        (showSubj ? '<span class="wai-subject">' + esc(subj) + '</span>' : '') +
        '<div class="wai-text">' + esc(parts.main) + (m.photos ? '\n[' + m.photos + ' photo' + (m.photos > 1 ? 's' : '') + ' sent]' : '') + '</div>' +
        (parts.quote ? '<button type="button" class="wai-more" aria-expanded="false" title="Show earlier messages in this email">&middot;&middot;&middot;</button><div class="wai-quote" hidden>' + esc(parts.quote) + '</div>' : '') +
        (time ? '<span class="wai-time">' + esc(time) + '</span>' : '') + '</div></div>';
    });
    log.innerHTML = html || '<div class="wai-blank">No messages yet.</div>';
    if (toBottom || nearEnd) log.scrollTop = log.scrollHeight;
  }

  function loadList() {
    return api('').then(function (r) {
      if (!r.ok || !r.data.success) return;
      S.chats = r.data.conversations || [];
      renderList();
    });
  }
  function loadThread(id, toBottom) {
    return api('/' + encodeURIComponent(id)).then(function (r) {
      if (id !== S.active) return;
      if (!r.ok || !r.data.success) { var m = root.querySelector('#waiMsg'); if (m) m.textContent = r.data.message || 'Could not load this conversation.'; return; }
      var keep = (S.thread && S.thread.messages || []).filter(function (m) { return m.sending; });
      var firstLoad = !S.thread, wasOpen = S.thread && S.thread.chat.canReply;
      S.thread = { chat: r.data.chat, messages: r.data.messages.concat(keep) };
      var last = r.data.messages[r.data.messages.length - 1];
      markSeen(id, last && last.at);
      if (firstLoad || wasOpen !== S.thread.chat.canReply) renderPane(); else { patchHeader(); renderLog(toBottom); }
      renderList();
    });
  }
  function patchHeader() {
    var c = S.thread.chat, chip = root.querySelector('#waiChip'), ai = root.querySelector('#waiAi');
    if (chip) chip.innerHTML = windowChip(c);
    if (ai) { ai.className = 'wai-ai' + (c.aiPaused ? ' paused' : ''); ai.textContent = c.aiPaused ? 'Resume AI' : 'Pause AI'; }
  }
  function openChat(id) { S.active = id; S.thread = null; renderPane(); renderList(); loadThread(id, true); }

  function sendMessage() {
    var input = root.querySelector('#waiInput'), msg = root.querySelector('#waiMsg'); if (!input || S.sending) return;
    var body = input.value.trim(); if (!body) return;
    var id = S.active, temp = { id: 'tmp' + Date.now(), direction: 'outbound', by: 'owner', body: body, at: new Date().toISOString(), sending: true };
    S.sending = true; msg.textContent = '';
    S.thread.messages.push(temp); S.drafts[id] = ''; input.value = ''; input.dispatchEvent(new Event('input'));
    renderLog(true);
    var giveBack = function (text) {
      S.drafts[id] = body;                                     // give the text back so nothing is lost
      var el = root.querySelector('#waiInput'); if (el) { el.value = body; el.dispatchEvent(new Event('input')); }
      var m2 = root.querySelector('#waiMsg'); if (m2) m2.textContent = text;
    };
    api('/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: JSON.stringify({ body: body }) }).then(function (r) {
      S.sending = false;
      if (id !== S.active) { loadList(); return; }
      S.thread.messages = S.thread.messages.filter(function (m) { return m !== temp; });
      if (r.ok && r.data.success) { S.thread.messages.push(r.data.message); renderLog(true); loadList(); }
      else { giveBack(r.data.message || 'This message could not be sent.'); renderLog(true); if (r.status === 409) loadThread(id); }
    }).catch(function () {
      S.sending = false; S.thread.messages = S.thread.messages.filter(function (m) { return m !== temp; });
      giveBack('You appear to be offline. Your message was not sent.'); renderLog(true);
    });
  }

  function toggleAi() {
    var c = S.thread && S.thread.chat; if (!c) return;
    var next = !c.aiPaused, btn = root.querySelector('#waiAi'); if (btn) btn.disabled = true;
    api('/' + encodeURIComponent(S.active) + '/ai', { method: 'POST', body: JSON.stringify({ paused: next }) }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.ok && r.data.success) { c.aiPaused = next; patchHeader(); loadList(); }
      else { var m = root.querySelector('#waiMsg'); if (m) m.textContent = r.data.message || 'Could not change the AI setting.'; }
    });
  }

  function visible() { var v = document.getElementById('view-inbox'); return root && !document.hidden && v && v.classList.contains('active'); }
  var tickN = 0;
  function tick() {
    if (!visible()) return;
    if (tickN++ % 2 === 0) loadList();                         // every 16s
    if (S.active && !S.sending) loadThread(S.active, false);   // every 8s
  }

  window.Inbox = {
    // Opens the page. Pass a lead id to jump straight into that conversation.
    open: function (leadId) {
      root = root || document.getElementById('inboxApp'); if (!root) return;
      if (!started) { started = true; build(); setInterval(tick, 8000); }
      loadList().then(function () { if (leadId) openChat(leadId); });
    },
    // Quietly checks for unread chats so the sidebar dot is right before the page is opened.
    refreshDot: function () {
      root = root || document.getElementById('inboxApp'); if (!root) return;
      if (!started) { started = true; build(); setInterval(tick, 8000); }
      loadList();
    }
  };
})();
