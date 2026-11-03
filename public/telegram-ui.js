/* Channels > Telegram: connect the owner's phone to the Agent. Talks to /api/telegram (routes/telegram.js). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var timer = null;

  function csrf() { var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; }); return m ? decodeURIComponent(m.split('=')[1]) : ''; }
  function call(path, method, body) {
    return fetch('/api/telegram' + path, {
      method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.httpOk = r.ok; return j; }); });
  }
  function toast(msg, type) { if (window.lcToast) window.lcToast(msg, type); }
  function show(id, on) { var e = $(id); if (e) e.style.display = on ? '' : 'none'; }

  function paint(s) {
    var connected = !!s.connected;
    show('tgConnected', connected); show('tgManage', connected); show('tgSetup', !connected);
    if (connected) {
      var who = s.username ? '@' + s.username : (s.name || 'your Telegram account');
      $('tgConnectedMeta').textContent = who + (s.blocked ? ' - Telegram is not delivering. Open the chat with the Humarains bot and press Start.' : '');
      document.querySelectorAll('input[name="tgNotify"]').forEach(function (r) { r.checked = r.value === s.notify; });
      stopPolling();
    } else {
      show('tgUnavailable', !s.configured); show('tgWaiting', !!s.linkPending);
      var b = $('tgConnect'); if (b) b.disabled = !s.configured;
    }
  }
  function load() { return call('/status').then(function (s) { if (s && s.success) paint(s); }); }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }
  function startPolling() { stopPolling(); var n = 0; timer = setInterval(function () { if (++n > 200) return stopPolling(); load(); }, 3000); }

  function open() {
    load();
    var h = document.querySelector('#lcPageTitle'); if (h) h.textContent = 'Telegram';
  }
  document.addEventListener('lc:view', function (e) { if (e.detail && e.detail.id === 'telegram') open(); else stopPolling(); });
  if (document.querySelector('#view-telegram.active')) open();

  document.addEventListener('click', function (e) {
    var t = e.target.closest('#tgConnect, #tgDisconnect, #tgTest'); if (!t) return;
    if (t.id === 'tgConnect') {
      t.disabled = true;
      call('/link', 'POST').then(function (j) {
        t.disabled = false;
        if (!j.success) return toast(j.message || 'Could not start the connection.', 'error');
        var a = $('tgOpenLink'); a.href = j.url; a.style.display = ''; show('tgWaiting', true);
        window.open(j.url, '_blank', 'noopener');
        startPolling();
      });
    } else if (t.id === 'tgTest') {
      call('/test', 'POST').then(function (j) { toast(j.success ? 'Test message sent.' : (j.message || 'Could not send it.'), j.success ? 'success' : 'error'); });
    } else if (t.id === 'tgDisconnect') {
      if (!window.confirm('Disconnect Telegram? You will stop getting the Agent\'s updates there.')) return;
      call('/disconnect', 'POST').then(function (j) { if (j.success) { toast('Telegram disconnected.', 'success'); load(); } else toast(j.message || 'Could not disconnect.', 'error'); });
    }
  });
  document.addEventListener('change', function (e) {
    if (!e.target.matches('input[name="tgNotify"]')) return;
    call('/notify', 'POST', { level: e.target.value }).then(function (j) { toast(j.success ? 'Saved.' : (j.message || 'Could not save.'), j.success ? 'success' : 'error'); });
  });
})();
