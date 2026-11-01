/* Onboarding wizard: 1 connect email or WhatsApp (required) -> 2 business basics -> 3 what the Agent may do on its own -> 4 try it. */
(function () {
  'use strict';
  var P = window.HumEmailProviders;
  var $ = function (id) { return document.getElementById(id); };

  var state = { step: 1, provider: 'gmail', channel: null, user: null, features: {}, waConfigured: false, tested: false };

  function csrf() {
    try {
      var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; });
      return m ? decodeURIComponent(m.split('=')[1]) : '';
    } catch (_) { return ''; }
  }
  function api(url, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, opts.headers || {});
    return fetch(url, Object.assign({ credentials: 'include' }, opts, { headers: headers })).then(function (r) {
      if (r.status === 401) { window.location.replace('login.html'); return null; }
      return r;
    });
  }
  function json(r) { return r ? r.json().catch(function () { return {}; }) : Promise.resolve(null); }

  function showError(msg) { var e = $('obError'); e.textContent = msg; e.classList.add('show'); e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function clearError() { $('obError').classList.remove('show'); }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="ob-spin"></span>' + (label ? ' ' + label : ''); }
    else { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
  }

  // ── Steps ──────────────────────────────────────────────────
  function go(n) {
    state.step = n; clearError();
    [1, 2, 3, 4].forEach(function (i) { $('ob-' + i).classList.toggle('active', i === n); });
    document.querySelectorAll('.ob-step').forEach(function (el) {
      var s = Number(el.dataset.s);
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
      el.querySelector('.dot').innerHTML = s < n ? '&#10003;' : String(s);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Step 1: channel ────────────────────────────────────────
  function pickChannel(ch) {
    state.channel = ch; clearError();
    $('chEmail').classList.toggle('selected', ch === 'email');
    $('chWa').classList.toggle('selected', ch === 'whatsapp');
    $('subEmail').classList.toggle('show', ch === 'email');
    $('subWa').classList.toggle('show', ch === 'whatsapp');
  }

  function renderChips() {
    var box = $('obChips'); box.innerHTML = '';
    P.PROVIDERS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ob-chip' + (p.key === state.provider ? ' on' : ''); b.textContent = p.name;
      b.addEventListener('click', function () { setProvider(p.key); });
      box.appendChild(b);
    });
  }
  function setProvider(key) {
    state.provider = key;
    var p = P.byKey(key);
    renderChips();
    $('emPassLabel').textContent = p.secretLabel;
    $('emImapHost').value = p.imapHost; $('emImapPort').value = p.imapPort;
    $('emSmtpHost').value = p.smtpHost; $('emSmtpPort').value = p.smtpPort;
    var help = $('obHelp'); help.textContent = p.help + ' ';
    if (p.helpUrl) { var a = document.createElement('a'); a.href = p.helpUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = p.helpLabel; help.appendChild(a); }
    // Servers only need a look when we cannot fill them in.
    $('obAdv').classList.toggle('show', key === 'other');
  }

  function connected(text) {
    $('obConnectedText').textContent = text;
    $('obConnected').classList.add('show');
    $('subEmail').classList.remove('show'); $('subWa').classList.remove('show');
    document.querySelector('.ob-choices').style.display = 'none';
    $('obSub1').textContent = 'You are connected. Next, a few details about your business.';
    $('btnNext1').style.display = '';
    $('btnNext1').focus();
  }

  function connectEmail() {
    clearError();
    var payload = P.buildPayload(state.provider, {
      user: $('emUser').value, pass: $('emPass').value, fromName: $('emFrom').value,
      imapHost: $('emImapHost').value, imapPort: $('emImapPort').value,
      smtpHost: $('emSmtpHost').value, smtpPort: $('emSmtpPort').value,
    });
    var bad = P.validate(payload);
    if (bad) return showError(bad);
    var btn = $('btnEmail');
    busy(btn, true, 'Checking your login');
    api('/api/leads/email-settings', { method: 'POST', body: JSON.stringify(payload) })
      .then(json)
      .then(function (d) {
        if (!d) return;
        if (d.success) connected('Email connected: ' + payload.user);
        else showError(friendlyEmailError(d.message, state.provider));
      })
      .catch(function () { showError('Could not reach the server. Check your connection and try again.'); })
      .then(function () { busy(btn, false); });
  }

  function friendlyEmailError(msg, provider) {
    msg = String(msg || 'Could not connect this inbox.');
    var p = P.byKey(provider);
    if (/auth|credential|password|login|invalid/i.test(msg) && p.key !== 'other') {
      return msg + ' Make sure you used an app password, not your normal password.';
    }
    return msg;
  }

  // ── WhatsApp (Meta Embedded Signup) ────────────────────────
  var fbPromise = null, waCfg = null;
  function loadFb(appId) {
    if (window.FB) return Promise.resolve(window.FB);
    if (fbPromise) return fbPromise;
    fbPromise = new Promise(function (resolve, reject) {
      window.fbAsyncInit = function () { window.FB.init({ appId: appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' }); resolve(window.FB); };
      var s = document.createElement('script');
      s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
      s.onerror = function () { fbPromise = null; reject(new Error('Could not load Facebook. Check your connection or ad-blocker and try again.')); };
      document.body.appendChild(s);
    });
    return fbPromise;
  }
  function getWaCfg() {
    if (waCfg) return Promise.resolve(waCfg);
    return api('/api/leads/whatsapp/embedded-signup/config').then(json).then(function (d) {
      if (!d || !d.success || !d.configured) throw new Error('WhatsApp connection is not available right now. Please connect your email instead.');
      waCfg = d; return d;
    });
  }

  function connectWhatsApp() {
    clearError();
    var btn = $('btnWa');
    busy(btn, true, 'Waiting for WhatsApp');
    var info = null;
    function onMessage(ev) {
      if (ev.origin !== 'https://www.facebook.com' && ev.origin !== 'https://web.facebook.com') return;
      var d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (d.event === 'FINISH' || d.event === 'FINISH_ONLY_WABA') info = { phoneNumberId: d.data && d.data.phone_number_id, wabaId: d.data && d.data.waba_id };
      else if (d.event === 'CANCEL') info = info || { cancelled: true };
      else if (d.event === 'ERROR') info = { error: (d.data && d.data.error_message) || 'WhatsApp reported an error.' };
    }
    window.addEventListener('message', onMessage);
    var fbResp;
    getWaCfg().then(function (cfg) {
      return loadFb(cfg.appId).then(function (FB) {
        return new Promise(function (resolve) {
          FB.login(resolve, { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
        });
      });
    }).then(function (r) {
      fbResp = r;
      if (!r || !r.authResponse || !r.authResponse.code) throw new Error('WhatsApp connection was cancelled or did not finish.');
      return new Promise(function (resolve) {
        var n = 0; (function wait() { if (info || n++ > 50) return resolve(info); setTimeout(wait, 100); })();
      });
    }).then(function (i) {
      if (!i || i.cancelled) throw new Error('WhatsApp connection was cancelled.');
      if (i.error) throw new Error(i.error);
      if (!i.phoneNumberId || !i.wabaId) throw new Error('Did not receive a phone number from Meta. Please try again.');
      return api('/api/leads/whatsapp/embedded-signup', { method: 'POST', body: JSON.stringify({ code: fbResp.authResponse.code, phoneNumberId: i.phoneNumberId, wabaId: i.wabaId }) }).then(json);
    }).then(function (d) {
      if (!d) return;
      if (d.success) connected('WhatsApp connected: ' + (d.displayPhone || d.verifiedName || 'your number'));
      else showError(d.message || 'Could not connect WhatsApp.');
    }).catch(function (e) { showError(e.message); })
      .then(function () { window.removeEventListener('message', onMessage); busy(btn, false); });
  }

  // ── Step 2: business ───────────────────────────────────────
  function saveBusiness() {
    clearError();
    var v = { businessName: $('bzName').value.trim(), businessType: $('bzType').value.trim(), ownerName: $('bzOwner').value.trim(), phone: $('bzPhone').value.trim() };
    if (!v.businessName) return showError('Enter your business name.');
    if (!v.businessType) return showError('Tell us what your business does.');
    if (!v.ownerName) return showError('Enter your name.');
    var tz = detectedTz(); if (tz) v.timezone = tz;
    var btn = $('btnBiz'); busy(btn, true, 'Saving');
    api('/api/leads/settings', { method: 'PUT', body: JSON.stringify(v) }).then(json).then(function (d) {
      if (!d) return;
      if (d.success) openPermissions(); else showError(d.message || 'Could not save. Please try again.');
    }).catch(function () { showError('Could not reach the server. Please try again.'); })
      .then(function () { busy(btn, false); });
  }
  function detectedTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }

  // ── Step 3: what the Agent may do on its own ───────────────
  // The same component as Settings > Agent permissions (autonomy-ui.js). Saving marks the policy as configured, which is what
  // lets a returning owner resume at step 4. "Continue" saves; so the owner has always seen and confirmed every switch.
  var auMounted = false;
  function openPermissions() {
    go(3);
    if (auMounted || !window.HumAutonomy) return;
    auMounted = true;
    window.HumAutonomy.mount($('auOnboard'), { compact: true, onSaved: function () { go(4); } });
  }

  // ── Step 4: practice enquiry ───────────────────────────────
  function sendTest() {
    clearError();
    var btn = $('btnTest'); busy(btn, true, 'Your Agent is replying');
    api('/api/leads/test-lead', { method: 'POST', body: '{}' }).then(json).then(function (d) {
      if (!d) return;
      if (d.success && d.lead && d.lead.aiReply && d.lead.aiReply.body) {
        var l = d.lead;
        $('obWhoThem').textContent = l.fromName || 'Customer';
        $('obThem').textContent = l.rawBody || l.subject || '';
        $('obUs').textContent = (l.aiReply && l.aiReply.body) || '';
        $('obChat').classList.add('show'); $('obChatNote').style.display = '';
        btn.style.display = 'none'; $('btnSkipTest').style.display = 'none';
        finishReady();
      } else {
        showError((d.message || 'Could not generate a practice reply.') + ' Add your services and pricing in Settings, then try again. You can still continue to your dashboard.');
        finishReady();
      }
    }).catch(function () { showError('Could not reach the server. You can still continue to your dashboard.'); finishReady(); })
      .then(function () { busy(btn, false); });
  }
  function finishReady() { $('obNext').style.display = ''; $('btnFinish').style.display = ''; $('btnSkipTest').style.display = 'none'; }
  function toDashboard() { window.location.href = 'dashboard.html'; }

  // ── Boot ───────────────────────────────────────────────────
  function applyFeatures(f) {
    var wa = $('chWa'), bd = $('bdWa');
    if (f.whatsappFeatureEnabled === false) { wa.style.display = 'none'; document.querySelector('.ob-choices').style.gridTemplateColumns = '1fr'; return; }
    if (!f.whatsapp) { wa.disabled = true; bd.textContent = 'Starter plan and above'; bd.style.display = ''; }
  }

  function boot() {
    Promise.all([api('/api/users/me').then(json), api('/api/users/setup-status').then(json)]).then(function (res) {
      var me = res[0], st = res[1];
      if (!me || !me.success || !me.user) return window.location.replace('login.html');
      state.user = me.user; state.features = me.user.features || {};
      applyFeatures(state.features);
      $('emFrom').value = me.user.company || '';
      $('bzOwner').value = (st && st.profile && st.profile.owner_name) || me.user.name || '';
      if (st && st.profile) { $('bzName').value = st.profile.business_name || ''; $('bzType').value = st.profile.business_type || ''; $('bzPhone').value = st.profile.phone || ''; }
      var tz = detectedTz(); $('bzTz').textContent = tz ? 'Time zone: ' + tz.replace(/_/g, ' ') + '. Bookings use this. You can change it in Settings.' : '';

      // Warm up Meta so the popup opens straight from the click.
      if (state.features.whatsapp) getWaCfg().then(function (c) { return loadFb(c.appId); }).catch(function () {});

      var profileDone = !!(st && st.profile && st.profile.business_name && st.profile.business_type && st.profile.owner_name);
      var step = !(st && st.channel_connected) ? 1 : (!profileDone ? 2 : (!(st && st.autonomy_configured) ? 3 : 4));
      if (step > 1) { /* channel already connected earlier */ }
      if (step === 3) openPermissions(); else go(step);
      if (step === 1) { pickChannel('email'); setProvider('gmail'); }
    }).catch(function () { showError('Could not load your account. Refresh the page to try again.'); });
  }

  $('chEmail').addEventListener('click', function () { pickChannel('email'); });
  $('chWa').addEventListener('click', function () { if (!this.disabled) pickChannel('whatsapp'); });
  $('obAdvToggle').addEventListener('click', function () { $('obAdv').classList.toggle('show'); });
  $('emUser').addEventListener('input', function () {
    var guess = P.detect(this.value);
    if (guess && guess !== state.provider && !$('emPass').value) setProvider(guess);
  });
  $('btnEmail').addEventListener('click', connectEmail);
  $('btnWa').addEventListener('click', connectWhatsApp);
  $('btnNext1').addEventListener('click', function () { go(2); $('bzName').focus(); });
  $('btnBiz').addEventListener('click', saveBusiness);
  $('btnTest').addEventListener('click', sendTest);
  $('btnSkipTest').addEventListener('click', toDashboard);
  $('btnFinish').addEventListener('click', toDashboard);
  $('obSignOut').addEventListener('click', function () {
    api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(function () {}).then(function () { window.location.href = 'login.html'; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    if (state.step === 1 && state.channel === 'email' && $('subEmail').classList.contains('show')) connectEmail();
    else if (state.step === 2) saveBusiness();
  });

  boot();
})();
