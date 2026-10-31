/* ════════════════════════════════════════════════════════════════
   Humarains — time zone and opening hours (Settings)
   The owner picks their own time zone from the full list, with their device's zone suggested,
   and sets opening hours for each day. leads.js calls fill() when settings load and collect() on save.
   The same rules are checked again on the server (src/lib/business-hours.js).
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.TimingUI) return;

  var WEEK = [1, 2, 3, 4, 5, 6, 0];
  var NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  var $ = function (id) { return document.getElementById(id); };
  var clockTimer = null, built = false;

  // Browsers still list a few places under their old names; show the current ones when the browser accepts them.
  var MODERN = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires' };
  var FALLBACK = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
    'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin',
    'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Athens', 'Africa/Johannesburg', 'Africa/Lagos', 'Asia/Dubai',
    'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Australia/Perth',
    'Australia/Sydney', 'Pacific/Auckland'];

  function isZone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } }
  function modern(tz) { return MODERN[tz] && isZone(MODERN[tz]) ? MODERN[tz] : tz; }
  function deviceZone() { try { return modern(Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) { return ''; } }

  function offsetMinutes(tz, d) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  }
  function offsetLabel(tz) {
    var m = offsetMinutes(tz, new Date()), sign = m < 0 ? '-' : '+', a = Math.abs(m);
    return 'UTC' + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  }
  function placeName(tz) { return tz.split('/').slice(1).join(' / ').replace(/_/g, ' ') || tz; }

  function allZones() {
    var zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) {}
    if (!zones || !zones.length) zones = FALLBACK;
    var seen = {}, out = [];
    zones.forEach(function (z) { z = modern(z); if (z !== 'UTC' && z.indexOf('/') > 0 && !seen[z]) { seen[z] = 1; out.push(z); } });
    return out;
  }

  function addOption(parent, tz, label) { var o = document.createElement('option'); o.value = tz; o.textContent = label; parent.appendChild(o); return o; }

  function buildSelect(sel) {
    if (built) return; built = true;
    sel.textContent = '';
    var groups = {};
    allZones().forEach(function (tz) { var r = tz.split('/')[0]; (groups[r] = groups[r] || []).push(tz); });
    Object.keys(groups).sort().forEach(function (region) {
      var g = document.createElement('optgroup'); g.label = region.replace(/_/g, ' ');
      groups[region].sort(function (a, b) { return placeName(a).localeCompare(placeName(b)); })
        .forEach(function (tz) { addOption(g, tz, placeName(tz) + ' (' + offsetLabel(tz) + ')'); });
      sel.appendChild(g);
    });
    var other = document.createElement('optgroup'); other.label = 'Other';
    addOption(other, 'UTC', 'UTC (no daylight saving)'); sel.appendChild(other);
  }
  function selectZone(sel, tz) {
    tz = modern(tz || 'UTC');
    if (![].some.call(sel.options, function (o) { return o.value === tz; })) {
      if (!isZone(tz)) tz = 'UTC';
      else addOption(sel, tz, placeName(tz) + ' (' + offsetLabel(tz) + ')');
    }
    sel.value = tz;
  }

  // ── Live clock and open/closed line ─────────────────────────────────────
  function parts(tz, now) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).forEach(function (x) { p[x.type] = x.value; });
    var hh = Number(p.hour) % 24, mm = Number(p.minute);
    return { day: SHORT.indexOf(p.weekday), minutes: hh * 60 + mm, hh: hh, mm: p.minute };
  }
  var mins = function (t) { var a = t.split(':'); return +a[0] * 60 + +a[1]; };

  function readGrid() {
    var s = {};
    document.querySelectorAll('#settHoursGrid .hours-row').forEach(function (row) {
      s[row.dataset.day] = { open: row.querySelector('.hours-open').checked,
        start: row.querySelector('.hours-start').value, end: row.querySelector('.hours-end').value };
    });
    return s;
  }
  function statusText(schedule, tz) {
    var now = new Date(), lp = parts(tz, now), t = schedule[lp.day];
    if (t && t.open && TIME.test(t.start) && TIME.test(t.end) && lp.minutes >= mins(t.start) && lp.minutes < mins(t.end)) return 'Open now, until ' + t.end + '.';
    if (t && t.open && TIME.test(t.start) && lp.minutes < mins(t.start)) return 'Closed now. Opens today at ' + t.start + '.';
    for (var i = 1; i <= 7; i++) {
      var d = (lp.day + i) % 7, e = schedule[d];
      if (e && e.open && TIME.test(e.start)) return 'Closed now. Opens ' + (i === 1 ? 'tomorrow' : 'on ' + NAMES[d]) + ' at ' + e.start + '.';
    }
    return 'Closed now.';
  }
  function updateClock() {
    var sel = $('settTimezone'), now = $('tzNow'), st = $('hoursStatus');
    if (!sel || !sel.value) return;
    var tz = sel.value, text = '';
    try { text = new Date().toLocaleString(undefined, { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (_) {}
    if (now) now.textContent = text ? 'Right now it is ' + text + ' there.' : '';
    if (st) { try { st.textContent = statusText(readGrid(), tz); } catch (_) { st.textContent = ''; } }
  }

  // ── Hours grid ──────────────────────────────────────────────────────────
  function buildGrid(schedule) {
    var grid = $('settHoursGrid'); if (!grid) return;
    grid.textContent = '';
    WEEK.forEach(function (d) {
      var e = schedule[d] || { open: false, start: '09:00', end: '17:00' };
      var row = document.createElement('div'); row.className = 'hours-row'; row.dataset.day = d;
      var lab = document.createElement('label'); lab.className = 'hours-day';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'hours-open'; cb.checked = !!e.open;
      cb.setAttribute('aria-label', 'Open on ' + NAMES[d]);
      var nm = document.createElement('span'); nm.textContent = NAMES[d];
      lab.appendChild(cb); lab.appendChild(nm);
      var times = document.createElement('div'); times.className = 'hours-times';
      var a = document.createElement('input'); a.type = 'time'; a.className = 'lc-input hours-start'; a.value = e.start || '09:00'; a.setAttribute('aria-label', NAMES[d] + ' opens');
      var to = document.createElement('span'); to.textContent = 'to'; to.setAttribute('aria-hidden', 'true');
      var b = document.createElement('input'); b.type = 'time'; b.className = 'lc-input hours-end'; b.value = e.end || '17:00'; b.setAttribute('aria-label', NAMES[d] + ' closes');
      times.appendChild(a); times.appendChild(to); times.appendChild(b);
      var closed = document.createElement('span'); closed.className = 'hours-closed'; closed.textContent = 'Closed';
      row.appendChild(lab); row.appendChild(times); row.appendChild(closed);
      grid.appendChild(row);
      var sync = function () { row.classList.toggle('is-closed', !cb.checked); a.disabled = b.disabled = !cb.checked; updateClock(); };
      cb.addEventListener('change', sync); a.addEventListener('input', updateClock); b.addEventListener('input', updateClock);
      row.classList.toggle('is-closed', !cb.checked); a.disabled = b.disabled = !cb.checked;
    });
  }

  function copyToAll() {
    var rows = [].slice.call(document.querySelectorAll('#settHoursGrid .hours-row'));
    var first = rows.filter(function (r) { return r.querySelector('.hours-open').checked; })[0];
    if (!first) return;
    var s = first.querySelector('.hours-start').value, e = first.querySelector('.hours-end').value;
    rows.forEach(function (r) { if (r.querySelector('.hours-open').checked) { r.querySelector('.hours-start').value = s; r.querySelector('.hours-end').value = e; } });
    updateClock();
  }

  // ── Public API ──────────────────────────────────────────────────────────
  function fill(settings) {
    settings = settings || {};
    var sel = $('settTimezone'); if (!sel) return;
    buildSelect(sel);
    var note = $('tzNote'), dev = deviceZone();
    if (settings.timezoneConfirmed === false) {
      var guess = dev && isZone(dev) ? dev : 'UTC';
      selectZone(sel, guess);
      if (note) { note.hidden = false; note.textContent = 'Your time zone has not been set yet. We picked ' + placeName(guess) + ' from this device. Check that it is right, then save.'; }
    } else {
      selectZone(sel, settings.timezone);
      if (note) note.hidden = true;
    }
    buildGrid(settings.businessHours || fallbackSchedule(settings));
    var det = $('btnDetectTz');
    if (det && !det.dataset.bound) {
      det.dataset.bound = '1';
      det.addEventListener('click', function () {
        var z = deviceZone();
        if (!z || !isZone(z)) { if (note) { note.hidden = false; note.textContent = 'This device did not report a time zone. Choose one from the list.'; } return; }
        selectZone(sel, z); if (note) note.hidden = true; updateClock();
      });
    }
    var cp = $('btnHoursCopy'); if (cp && !cp.dataset.bound) { cp.dataset.bound = '1'; cp.addEventListener('click', copyToAll); }
    if (!sel.dataset.bound) { sel.dataset.bound = '1'; sel.addEventListener('change', updateClock); }
    updateClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function () { if (!document.hidden) updateClock(); }, 30000);
  }

  // Only used if the server did not send a per-day schedule (it always does now)
  function fallbackSchedule(st) {
    var days = Array.isArray(st.businessDays) ? st.businessDays : [1, 2, 3, 4, 5], s = {};
    for (var d = 0; d < 7; d++) s[d] = { open: days.indexOf(d) !== -1, start: st.businessHoursStart || '09:00', end: st.businessHoursEnd || '17:00' };
    return s;
  }

  function collect() {
    var sel = $('settTimezone'); if (!sel) return { ok: true, partial: true };
    var schedule = readGrid(), any = false;
    for (var i = 0; i < WEEK.length; i++) {
      var d = WEEK[i], e = schedule[d];
      if (!e.open) continue;
      any = true;
      if (!TIME.test(e.start) || !TIME.test(e.end)) return { ok: false, error: NAMES[d] + ': choose an opening and a closing time.' };
      if (mins(e.end) <= mins(e.start)) return { ok: false, error: NAMES[d] + ': closing time must be after opening time.' };
    }
    if (!any) return { ok: false, error: 'Choose at least one day the business is open.' };
    if (!sel.value || !isZone(sel.value)) return { ok: false, error: 'Choose your time zone.' };
    return { ok: true, timezone: sel.value, timezoneConfirmed: true, businessHours: schedule };
  }

  window.TimingUI = { fill: fill, collect: collect };
})();
