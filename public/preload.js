/* Sign-in preload. Right after a successful login, fetch everything the dashboard shows when it opens, in parallel,
   while the "signing in" screen is still up. The responses are parked in sessionStorage for a short while; the dashboard
   (see the top of dashboard.html) picks them up instead of asking the server again, so it opens with real data.
   Best effort only: anything that is slow, fails or does not fit is simply fetched by the dashboard as before. */
(function () {
  'use strict';
  var KEY = 'bp_preload';
  var URLS = [
    '/api/users/me', '/api/users/setup-status', '/api/leads', '/api/leads/settings', '/api/leads/email-settings',
    '/api/account/me', '/api/agent/brief', '/api/leads/consent-queue', '/api/leads/human-review'
  ];
  var MAX_CHARS = 3000000;   // sessionStorage allows roughly 5 MB; stay well under it

  function clear() { try { sessionStorage.removeItem(KEY); } catch (_) {} }

  function save(results) {
    var payload = { t: Date.now(), d: results };
    var s;
    try {
      s = JSON.stringify(payload);
      if (s.length > MAX_CHARS) { delete results['/api/leads']; s = JSON.stringify(payload); }   // the lead list is the big one
      sessionStorage.setItem(KEY, s);
    } catch (_) { clear(); }
  }

  function grab(url, results) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        if (r.ok && body) results[url] = { ok: true, status: r.status, body: body };
        return body;
      });
    }).catch(function () { return null; });
  }

  // Loads everything and stores it. Resolves when all of it is in, or after maxMs with whatever has arrived. Never rejects.
  function run(maxMs) {
    clear();
    var results = {};
    var all = Promise.all(URLS.map(function (u) {
      var p = grab(u, results);
      // The approvals list is only on screen when the brief says there are drafts waiting.
      if (u === '/api/agent/brief') p = p.then(function (b) { return b && b.drafts > 0 ? grab('/api/agent/approvals', results) : null; });
      return p;
    }));
    var cap = new Promise(function (res) { setTimeout(res, maxMs || 8000); });
    return Promise.race([all, cap]).then(function () { save(results); }, function () { save(results); });
  }

  window.HumPreload = { run: run, clear: clear, KEY: KEY };
})();
