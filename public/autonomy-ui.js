/**
 * autonomy-ui.js — "What your Agent can do on its own".
 *
 * One component, two homes:
 *   Settings > Agent permissions   (#auMount in dashboard.html and leads.html): the full form plus the activity feed
 *   Onboarding step 3              (#auOnboard in onboarding.html): the same form, compact, with a Continue button
 *
 * Everything is read from and saved to /api/autonomy (src/routes/autonomy.js), which validates with the same code the
 * Agent's chat tools use. The page never decides what is allowed: the server returns what each action really runs as on
 * this plan ("effectiveMode") and why, and this file only shows it.
 */
(function () {
  'use strict';

  var esc = function (s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  function csrf() {
    try { var m = document.cookie.split('; ').find(function (r) { return r.indexOf('bp_csrf=') === 0; }); return m ? decodeURIComponent(m.split('=')[1]) : ''; } catch (_) { return ''; }
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch('/api/autonomy' + path, Object.assign({ credentials: 'include' }, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, opts.headers || {}),
    })).then(function (res) {
      if (res.status === 401) { window.location.replace('login.html'); return new Promise(function () {}); }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || data.success === false) throw new Error((data && data.message) || 'Something went wrong. Please try again.');
        return data;
      });
    });
  }

  var MODE_LABEL = { off: 'Off', ask: 'Ask me first', auto: 'Automatic' };
  var KIND_LABEL = { reengage: 'Followed up with', discount: 'Offered a discount to', missed_call: 'Texted back a missed call from', review: 'Asked for a review from', winback: 'Checked in with' };
  var STATUS_LABEL = { sent: 'Sent', queued: 'Waiting', sending: 'Sending', skipped: 'Held back', failed: 'Failed', cancelled: 'Stopped' };

  function hourOptions(sel) {
    var out = '';
    for (var h = 0; h < 24; h++) out += '<option value="' + h + '"' + (h === sel ? ' selected' : '') + '>' + (h < 10 ? '0' : '') + h + ':00</option>';
    return out;
  }

  function mount(el, opts) {
    opts = opts || {};
    if (!el) return null;
    var S = null;               // the server's state
    var P = null;               // the policy being edited
    var calling = null;         // WhatsApp calling status from Meta: 'ENABLED' | 'DISABLED' | null
    var busy = false;
    el.classList.add('au');

    function say(text, bad) { var m = el.querySelector('.au-msg'); if (m) { m.textContent = text || ''; m.className = 'au-msg' + (bad ? ' err' : ''); } }

    function load() {
      return api('/').then(function (d) {
        S = d; P = JSON.parse(JSON.stringify(d.policy));
        if (S.channels.whatsapp) api('/whatsapp-calling').then(function (c) { calling = c.status; render(); }).catch(function () {});
        render();
        if (!opts.compact) loadActivity();
      }).catch(function (e) { el.innerHTML = '<div class="au-empty">' + esc(e.message) + '</div>'; });
    }

    // ── Reading the form back into the policy ──────────────────
    function num(name, key) {
      var i = el.querySelector('[data-f="' + name + '"]'); if (!i) return;
      var v = i.value === '' ? 0 : Number(i.value);
      var parts = name.split('.');
      if (parts[0] === 'limits') P.limits[parts[1]] = v; else P.actions[parts[0]][parts[1]] = v;
    }
    function readForm() {
      ['reengage.quoteAfterDays', 'reengage.coldAfterDays', 'discount.percent', 'discount.afterDays', 'discount.validDays', 'discount.minQuoteValue',
        'discount.monthlyBudget', 'missed_call.delayMinutes', 'limits.dailyMessages', 'limits.maxTouchesPer30d'].forEach(function (n) { num(n); });
      var anyHour = el.querySelector('[data-f="anyHour"]');
      if (anyHour) {
        if (anyHour.checked) { P.limits.quietFrom = 0; P.limits.quietTo = 0; }
        else { P.limits.quietFrom = Number(el.querySelector('[data-f="quietFrom"]').value); P.limits.quietTo = Number(el.querySelector('[data-f="quietTo"]').value); if (P.limits.quietFrom === P.limits.quietTo) P.limits.quietTo = (P.limits.quietFrom + 12) % 24; }
      }
      var m = el.querySelector('[data-f="callMessage"]'), c = el.querySelector('[data-f="callMessageClosed"]');
      if (m) P.actions.missed_call.message = m.value;
      if (c) P.actions.missed_call.afterHoursMessage = c.value;
    }

    // ── Rendering ──────────────────────────────────────────────
    function field(label, name, val, unit, bound) {
      return '<label>' + esc(label) + ' <input type="number" data-f="' + name + '" value="' + esc(val) + '"' + (bound ? ' min="' + bound[0] + '" max="' + bound[1] + '"' : '') + '> ' + (unit ? esc(unit) : '') + '</label>';
    }

    function detail(a) {
      var b = S.bounds, cfg = P.actions[a.key], cur = S.currency;
      if (a.key === 'reengage') return '<div class="au-row">' + field('Chase a quote after', 'reengage.quoteAfterDays', cfg.quoteAfterDays, 'days of silence', b.quoteAfterDays) + '</div>' +
        '<div class="au-row">' + field('Chase an enquiry that never got a quote after', 'reengage.coldAfterDays', cfg.coldAfterDays, 'days of silence', b.coldAfterDays) + '</div>' +
        '<div class="au-note">Sent by email, from your own address. Anyone who asked not to be contacted is always left out.</div>';
      if (a.key === 'discount') {
        var ceil = S.aiDiscountCeiling ? '<div class="au-note warn">Your Quote Rules cap AI discounts at ' + S.aiDiscountCeiling + '%, so offers will never be above that.</div>' : '';
        return '<div class="au-row">' + field('Take', 'discount.percent', cfg.percent, '% off. This is the most the Agent will ever offer.', b.percent) + '</div>' +
          '<div class="au-row">' + field('Offer it after', 'discount.afterDays', cfg.afterDays, 'days of silence on a quote', b.afterDays) + field('Keep it open for', 'discount.validDays', cfg.validDays, 'days', b.validDays) + '</div>' +
          '<div class="au-row">' + field('Only quotes of at least', 'discount.minQuoteValue', cfg.minQuoteValue, cur, b.minQuoteValue) + field('Offer at most', 'discount.monthlyBudget', cfg.monthlyBudget, cur + ' in total per month (0 = no limit)', b.monthlyBudget) + '</div>' +
          '<div class="au-note">Each customer is offered a discount once. The price never goes below that service\'s minimum charge, and the AI honours exactly this offer in the conversation and nothing more.</div>' + ceil;
      }
      if (a.key === 'missed_call') {
        var h = '<div class="au-row">' + field('Send the text', 'missed_call.delayMinutes', cfg.delayMinutes, 'minutes after the missed call', b.delayMinutes) + '</div>' +
          '<div class="au-row"><span class="au-label">What it says while you are open</span><textarea data-f="callMessage" maxlength="600">' + esc(cfg.message) + '</textarea></div>' +
          '<div class="au-row"><span class="au-label">What it says while you are closed</span><textarea data-f="callMessageClosed" maxlength="600">' + esc(cfg.afterHoursMessage) + '</textarea>' +
          '<span class="au-note">You can use ' + S.callFields.map(function (f) { return '{{' + f + '}}'; }).join(', ') + '. Exactly these words are sent: the AI does not rewrite them. When the customer replies, the AI takes over the conversation.</span></div>';
        if (!S.channels.whatsapp) h += '<div class="au-note warn">Connect WhatsApp (Pipeline) for this to work.</div>';
        else if (calling === 'ENABLED') h += '<div class="au-note">WhatsApp calling is on for your number, so missed calls reach the Agent. <button type="button" class="au-btn sm" data-act="calloff">Turn calling off</button></div>';
        else if (calling === 'DISABLED') h += '<div class="au-note warn">WhatsApp calling is off for your number, so Meta never tells us about missed calls. <button type="button" class="au-btn sm" data-act="callon">Turn calling on</button><br>This adds a call button to your WhatsApp chat. Humarains does not answer calls: a customer who rings sees "Not answered" and gets your text straight after.</div>';
        return h;
      }
      return '';
    }

    function card(a) {
      var on = P.actions[a.key].mode;
      var seg = a.modes.map(function (m) { return '<button type="button" data-act="mode" data-key="' + a.key + '" data-mode="' + m + '" class="' + (on === m ? 'on' : '') + '" aria-pressed="' + (on === m) + '">' + MODE_LABEL[m] + '</button>'; }).join('');
      return '<div class="au-card' + (on === 'off' ? ' off' : '') + '"><div class="au-head"><div><div class="au-title">' + esc(a.label) + '</div><div class="au-help">' + esc(a.help) + '</div></div>' +
        '<div class="au-seg" role="group" aria-label="' + esc(a.label) + '">' + seg + '</div></div>' +
        (a.lock ? '<div class="au-lock">' + esc(a.lock) + '</div>' : '') +
        (on !== 'off' ? '<div class="au-body">' + (detail(a) || '<div class="au-note">' + (on === 'auto' ? 'The Agent does this on its own, inside the limits below.' : 'The Agent prepares it and waits for your approval on the home screen.') + '</div>') + '</div>' : '') + '</div>';
    }

    function render() {
      if (!S) return;
      var scroll = el.scrollTop;
      var quiet = P.limits.quietFrom === P.limits.quietTo;
      var html = '';
      if (!opts.compact) {
        html += '<div class="au-banner' + (P.paused ? ' paused' : '') + '"><div>' + (P.paused ? '<b>Paused.</b> Nothing runs on its own until you resume. Replies to customers who write to you are not affected.' : '<b>Working inside the limits you set.</b> You can pause everything at any time.') + '</div>' +
          '<button type="button" class="au-btn sm" data-act="' + (P.paused ? 'resume' : 'pause') + '">' + (P.paused ? 'Resume' : 'Pause everything') + '</button></div>';
      }
      html += '<div class="au-presets">' + S.presets.map(function (p) { return '<button type="button" class="au-preset" data-act="preset" data-key="' + p.key + '"><b>' + esc(p.label) + '</b><span>' + esc(p.help) + '</span></button>'; }).join('') + '</div>' +
        '<div class="au-hint">A preset only fills in the switches below. Nothing is saved until you press ' + (opts.compact ? '"Continue"' : '"Save"') + '.</div>';
      html += S.actions.map(card).join('');
      html += '<div class="au-limits"><h4>Limits the Agent cannot cross</h4><div class="au-note" style="margin-bottom:10px">These apply to everything it starts on its own. Replies to customers who write to you, and your own approvals, are not counted.</div>' +
        '<div class="au-row">' + field('At most', 'limits.dailyMessages', P.limits.dailyMessages, 'messages a day', S.bounds.dailyMessages) + '</div>' +
        '<div class="au-row" style="margin-top:8px">' + field('Contact one customer at most', 'limits.maxTouchesPer30d', P.limits.maxTouchesPer30d, 'times in 30 days', S.bounds.maxTouchesPer30d) + '</div>' +
        '<div class="au-row" style="margin-top:8px"><label><input type="checkbox" data-f="anyHour"' + (quiet ? ' checked' : '') + '> Allow it at any hour</label></div>' +
        (quiet ? '' : '<div class="au-row" style="margin-top:8px">Stay quiet from <select data-f="quietFrom">' + hourOptions(P.limits.quietFrom) + '</select> to <select data-f="quietTo">' + hourOptions(P.limits.quietTo) + '</select> <span class="au-note">(' + esc(S.timezone.replace(/_/g, ' ')) + ')</span></div>') +
        '<div class="au-note" style="margin-top:6px">Today: ' + S.usage.sentToday + ' of ' + S.usage.dailyMessages + ' messages used.' + (S.usage.discountOffered30d ? ' Discounts offered in the last 30 days: ' + esc(S.currency) + ' ' + S.usage.discountOffered30d + '.' : '') + '</div></div>';
      html += '<div class="au-save"><button type="button" class="au-btn primary" data-act="save"' + (busy ? ' disabled' : '') + '>' + (opts.compact ? 'Continue' : 'Save') + '</button><span class="au-msg"></span></div><ul class="au-notes" data-notes></ul>';
      if (!opts.compact) html += '<div class="au-act"><h4>What your Agent has done</h4><div id="auActivity"><div class="au-note">Loading</div></div></div>';
      el.innerHTML = html;
      el.scrollTop = scroll;
      el.querySelector('[data-f="anyHour"]') && el.querySelector('[data-f="anyHour"]').addEventListener('change', function () { readForm(); if (!this.checked && P.limits.quietFrom === P.limits.quietTo) { P.limits.quietFrom = 20; P.limits.quietTo = 8; } render(); if (!opts.compact) loadActivity(); });
    }

    // ── Activity feed ──────────────────────────────────────────
    function ago(iso) {
      var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
      return Math.round(s / 86400) + ' d ago';
    }
    function loadActivity() {
      api('/activity?limit=25').then(function (d) {
        var box = el.querySelector('#auActivity'); if (!box) return;
        var sm = d.summary;
        var head = '<div class="au-sum">Last ' + sm.days + ' days: <b>' + sm.sent + '</b> sent' + (sm.waiting ? ', ' + sm.waiting + ' waiting' : '') + (sm.held ? ', ' + sm.held + ' held back' : '') + '.</div>';
        if (!d.items.length) { box.innerHTML = head + '<div class="au-empty">Nothing yet. When the Agent acts on its own, every action is listed here.</div>'; return; }
        box.innerHTML = head + '<ul class="au-list">' + d.items.map(function (i) {
          var who = i.who ? esc(i.who) : 'a customer';
          var extra = i.detail && i.detail.percent ? ' (' + i.detail.percent + '% off)' : '';
          var why = i.reason ? '<span class="why">' + esc(i.reason) + '</span>' : '';
          var stop = i.status === 'queued' ? ' <button type="button" class="au-btn sm" data-act="stop" data-id="' + i.id + '">Stop</button>' : '';
          return '<li><span class="what">' + esc(KIND_LABEL[i.kind] || i.kind) + ' ' + who + extra + ' <span class="au-note">' + (i.channel === 'whatsapp' ? 'WhatsApp' : 'email') + ' · ' + ago(i.at) + '</span>' + why + '</span><span>' + stop + ' <span class="au-pill ' + esc(i.status) + '">' + esc(STATUS_LABEL[i.status] || i.status) + '</span></span></li>';
        }).join('') + '</ul>';
      }).catch(function () { var box = el.querySelector('#auActivity'); if (box) box.innerHTML = '<div class="au-note">Could not load the activity.</div>'; });
    }

    // ── Actions ────────────────────────────────────────────────
    function save() {
      readForm(); busy = true; say('Saving'); var btn = el.querySelector('[data-act="save"]'); if (btn) btn.disabled = true;
      return api('/', { method: 'PUT', body: JSON.stringify({ actions: P.actions, limits: P.limits }) }).then(function (d) {
        S = d; P = JSON.parse(JSON.stringify(d.policy)); busy = false; render();
        var ul = el.querySelector('[data-notes]');
        if (ul && d.notes && d.notes.length) ul.innerHTML = d.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
        say('Saved.'); if (!opts.compact) loadActivity();
        if (opts.onSaved) opts.onSaved(d);
        return d;
      }).catch(function (e) { busy = false; var b = el.querySelector('[data-act="save"]'); if (b) b.disabled = false; say(e.message, true); });
    }

    el.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-act]'); if (!t || !el.contains(t)) return;
      var act = t.getAttribute('data-act');
      if (act === 'mode') { readForm(); P.actions[t.getAttribute('data-key')].mode = t.getAttribute('data-mode'); render(); if (!opts.compact) loadActivity(); }
      else if (act === 'preset') {
        readForm();
        var key = t.getAttribute('data-key'), preset = S.presets.filter(function (p) { return p.key === key; })[0].modes;
        Object.keys(preset).forEach(function (k) { P.actions[k].mode = preset[k]; });
        render(); if (!opts.compact) loadActivity();
        var chosen = el.querySelector('.au-preset[data-key="' + key + '"]'); if (chosen) chosen.classList.add('on');
      }
      else if (act === 'save') save();
      else if (act === 'pause' || act === 'resume') api('/' + act, { method: 'POST', body: '{}' }).then(function (d) { S = d; P = JSON.parse(JSON.stringify(d.policy)); render(); loadActivity(); }).catch(function (e) { say(e.message, true); });
      else if (act === 'stop') api('/activity/' + t.getAttribute('data-id') + '/cancel', { method: 'POST', body: '{}' }).then(function () { loadActivity(); }).catch(function (e) { say(e.message, true); });
      else if (act === 'callon' || act === 'calloff') {
        var on = act === 'callon';
        if (on && !window.confirm('Turn on WhatsApp calling for your number?\n\nCustomers will see a call button in your WhatsApp chat. Humarains does not answer calls: someone who rings sees "Not answered" and then receives your text-back.')) return;
        api('/whatsapp-calling', { method: 'POST', body: JSON.stringify({ enabled: on }) }).then(function (d) { calling = d.status; render(); if (!opts.compact) loadActivity(); }).catch(function (e) { say(e.message, true); });
      }
    });

    load();
    return { save: save, reload: load };
  }

  window.HumAutonomy = { mount: mount };

  // Settings pages: mount where the section exists.
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('auMount');
    if (el) mount(el, { compact: false });
  });
})();
