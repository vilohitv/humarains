/* demo-mode.js: runs the REAL dashboard (dashboard.html) on seeded example data.
   Active only for dashboard.html?demo=1, which is what the landing page embeds in its "One calm dashboard" section.

   - Answers /api/* requests in the browser, so nothing reaches the server and nobody's real data is touched.
   - Keeps localStorage / sessionStorage in memory, so a signed-in owner's own dashboard settings are never overwritten.
   - Lets the landing page switch views with postMessage({ type: 'hm-demo-view', view }).
   - Everything is read-only: any write (POST, PATCH, DELETE) is answered with a harmless success.
   The dashboard's own scripts run unchanged, so what visitors see is the product itself. */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  if (qs.get('demo') !== '1') return;
  window.__HM_DEMO = true;

  /* ── 1. Storage lives in memory only ─────────────────────────── */
  function memoryStorage(seed) {
    var m = Object.assign({}, seed || {});
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      clear: function () { m = {}; },
      key: function (i) { return Object.keys(m)[i] || null; },
      get length() { return Object.keys(m).length; }
    };
  }
  try {
    /* 'classic' is the console with Leads / Inbox / Insights as full views, which is what the demo shows */
    Object.defineProperty(window, 'localStorage', { value: memoryStorage({ hm_ui_mode: qs.get('ui') === 'agent' ? 'agent' : 'classic' }), configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: true });
  } catch (e) { /* storage stays native if the browser refuses; the demo still works */ }

  /* ── 2. Example data, always relative to "now" so dates look current ── */
  var NOW = Date.now(), H = 3600e3, D = 24 * H;
  var iso = function (t) { return new Date(t).toISOString(); };
  var ago = function (hours) { return NOW - hours * H; };

  var seed = 20261030;
  function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  var pick = function (a) { return a[Math.floor(rnd() * a.length)]; };

  var HANDWRITTEN = [
    { n: 'Maria Santos',   svc: 'Kitchen tap repair',    intent: 'booking',      urg: 'medium', q: 150, st: 'replied',          src: 'whatsapp', h: 0.2,  booked: true  },
    { n: 'Dana Whitfield', svc: 'Whole-house repipe',    intent: 'pricing',      urg: 'low',    q: null, st: 'processing',      src: 'email',    h: 3.1,  review: true  },
    { n: 'Tom Okafor',     svc: 'Blocked drain',         intent: 'urgent_issue', urg: 'high',   q: 195, st: 'replied',          src: 'whatsapp', h: 1.4,  booked: true  },
    { n: 'Priya Nair',     svc: 'Water heater service',  intent: 'pricing',      urg: 'medium', q: 890, st: 'pending_followup', src: 'email',    h: 26 },
    { n: 'Chen Wei',       svc: 'Bathroom leak',         intent: 'urgent_issue', urg: 'high',   q: 285, st: 'replied',          src: 'email',    h: 5.5,  booked: true  },
    { n: 'Hannah Brooks',  svc: 'Toilet keeps running',  intent: 'booking',      urg: 'low',    q: 120, st: 'new',              src: 'whatsapp', h: 0.05 }
  ];
  var FIRST = ['Liam', 'Sofia', 'Marcus', 'Aisha', 'Jack', 'Elena', 'Noah', 'Grace', 'Omar', 'Zoe', 'Ben', 'Isla', 'Raj', 'Chloe', 'Mateo', 'Ruth', 'Kai', 'Nina', 'Sam', 'Leila'];
  var LAST = ['Patel', 'Nguyen', 'Murphy', 'Costa', 'Kim', 'Rossi', 'Walker', 'Haddad', 'Dubois', 'Ivanov', 'Reed', 'Silva', 'Novak', 'Hughes', 'Tanaka'];
  var JOBS = [['Dripping shower head', 'booking', 95], ['Gas hob not lighting', 'inquiry', 130], ['Outdoor tap install', 'pricing', 220], ['Dishwasher hook-up', 'booking', 110], ['Low water pressure', 'inquiry', 140], ['Burst pipe under sink', 'urgent_issue', 260], ['Hot water system quote', 'pricing', 1450], ['Bathroom tap replacement', 'booking', 180], ['Sewer smell in laundry', 'inquiry', 160], ['Washing machine hose', 'booking', 105]];

  var leadsList = [], convScripts = {};
  function mkLead(o, i) {
    var wa = o.src === 'whatsapp', phone = '+1 555 01' + (10 + Math.floor(rnd() * 89)) + ' ' + (1000 + Math.floor(rnd() * 8999));
    var email = o.n.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com';
    var lead = {
      id: 'demo-' + (i + 1), fromName: o.n, customerName: o.n, fromEmail: wa ? '' : email, fromPhone: wa ? phone : '',
      whatsappThreadPhone: wa ? phone : null, source: o.src, intent: o.intent, urgency: o.urg,
      status: o.st, createdAt: iso(ago(o.h)), sentAt: o.st === 'new' ? null : iso(ago(o.h) + 14e3),
      subject: o.svc, needsHumanReview: !!o.review, humanReviewReason: o.review ? 'Large job: needs your quote' : null,
      quote: o.review ? { currency: 'USD', total: 0, requiresSiteVisit: true } : (o.q ? { currency: 'USD', total: o.q } : null),
      calendarEventId: o.booked ? 'ev-' + i : null, calendarEventLink: o.booked ? '#' : null, conversationHistory: []
    };
    return lead;
  }
  HANDWRITTEN.forEach(function (o, i) { leadsList.push(mkLead(o, i)); });
  /* About 100 more across the last 30 days, placed on calendar days so the 14-day chart has no empty bars */
  var statusPool = ['closed', 'closed', 'closed', 'closed', 'replied', 'replied', 'pending_followup', 'replied'];
  var k = HANDWRITTEN.length;
  for (var daysAgo = 29; daysAgo >= 0; daysAgo--) {
    var count = 2 + Math.floor(rnd() * 3) + (daysAgo < 14 ? 1 : 0);
    for (var j = 0; j < count; j++) {
      var job = pick(JOBS), status = daysAgo === 0 ? 'replied' : pick(statusPool);
      var day = new Date(NOW); day.setDate(day.getDate() - daysAgo); day.setHours(8 + Math.floor(rnd() * 10), Math.floor(rnd() * 60), 0, 0);
      var hoursAgo = Math.max(0.5, (NOW - day.getTime()) / H);
      if (daysAgo === 0 && hoursAgo < 1) hoursAgo = 4 + rnd() * 3;
      leadsList.push(mkLead({
        n: pick(FIRST) + ' ' + pick(LAST), svc: job[0], intent: job[1], urg: pick(['low', 'medium', 'medium', 'high']),
        q: job[2], st: status, src: pick(['email', 'whatsapp', 'whatsapp', 'form']), h: hoursAgo, booked: rnd() < 0.42 && status !== 'pending_followup'
      }, k++));
    }
  }
  leadsList.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

  /* Conversations for the Inbox, scripted for the five customers we want to show */
  function T(minAgo) { return iso(NOW - minAgo * 60e3); }
  var SCRIPT = {
    'Maria Santos': { ch: 'whatsapp', msgs: [
      ['c', 'Hi, my kitchen tap will not stop dripping and it is getting worse. Can someone come tomorrow?', 22],
      ['a', 'Hi Maria, sorry about the tap. A call-out and repair is usually $120 to $180, depending on the part. I have tomorrow at 9:00 am or 2:30 pm. Which suits you?', 21.8],
      ['c', '9 am please.', 19],
      ['a', 'Booked for tomorrow at 9:00 am. A plumber will text you when they are on the way.', 18.8]] },
    'Tom Okafor': { ch: 'whatsapp', msgs: [
      ['c', 'Kitchen sink is completely blocked and starting to smell. Can you come today?', 96],
      ['a', 'Sorry to hear that, Tom. A blocked drain call-out is usually $150 to $240. I can have someone there at 11:30 am. Shall I book it?', 95.8],
      ['c', 'Yes please', 90],
      ['a', 'Done. You are booked for 11:30 am. Reply here if anything changes.', 89.8],
      ['c', 'Great, see you then.', 85]] },
    'Dana Whitfield': { ch: 'email', msgs: [
      ['c', 'Hello, we are renovating a 1960s house and want all the old pipes replaced. Could you quote for the whole house?', 186]] },
    'Priya Nair': { ch: 'email', msgs: [
      ['c', 'How much for servicing a gas water heater? Mine is about 9 years old.', 1560],
      ['a', 'Hi Priya, a full service on a gas water heater is $890 including parts for a unit that age. I have Friday at 10:00 am or Monday at 8:00 am free.', 1559.8],
      ['a', 'Just checking in, Priya. Would Friday at 10:00 am still suit you for the water heater service?', 1440]] },
    'Chen Wei': { ch: 'email', msgs: [
      ['c', 'There is water coming through the ceiling under our upstairs bathroom. Please help.', 330],
      ['a', 'Chen, that sounds urgent. A bathroom leak repair is usually $240 to $330. I can send someone at 8:00 am on Monday. Should I book that?', 329.8],
      ['c', 'Yes, and please tell them to bring a ladder.', 300],
      ['a', 'Booked for Monday at 8:00 am, and I have added the note about the ladder.', 299.8]] },
    'Hannah Brooks': { ch: 'whatsapp', msgs: [
      ['c', 'Hi, the toilet keeps running after every flush. Is that expensive to fix?', 3]] }
  };
  Object.keys(SCRIPT).forEach(function (name) {
    var lead = leadsList.filter(function (l) { return l.fromName === name; })[0];
    if (!lead) return;
    lead.conversationHistory = SCRIPT[name].msgs.map(function (m) {
      return { role: m[0] === 'c' ? 'customer' : 'assistant', source: m[0] === 'c' ? undefined : 'ai', body: m[1], sentAt: T(m[2]), subject: null };
    });
    convScripts[lead.id] = { lead: lead, ch: SCRIPT[name].ch };
  });

  function conversationRow(id) {
    var s = convScripts[id], last = s.lead.conversationHistory[s.lead.conversationHistory.length - 1];
    var wa = s.ch === 'whatsapp', contact = wa ? s.lead.fromPhone : s.lead.fromEmail;
    return {
      id: id, channel: s.ch, name: s.lead.fromName, contact: contact, status: s.lead.status,
      preview: last.body.slice(0, 140), lastDirection: last.role === 'customer' ? 'inbound' : 'outbound', lastAt: last.sentAt,
      aiPaused: false, needsReview: !!s.lead.needsHumanReview,
      windowOpen: true, windowClosesAt: iso(NOW + 20 * H), optedOut: false, canReply: true, blockedReason: null
    };
  }
  function conversationThread(id) {
    var s = convScripts[id]; if (!s) return null;
    var row = conversationRow(id);
    var msgs = s.lead.conversationHistory.map(function (t, i) {
      var cust = t.role === 'customer';
      return { id: i, direction: cust ? 'inbound' : 'outbound', by: cust ? 'customer' : 'ai', body: t.body, subject: null, at: t.sentAt, pending: false, photos: 0 };
    });
    return { success: true, chat: Object.assign({}, row, { reviewReason: s.lead.needsHumanReview ? s.lead.humanReviewReason : null }), messages: msgs };
  }

  /* Insights: computed from the same leads, so every number agrees with the Leads page */
  function performance() {
    var byDay = {}, bySrc = {}, replied = 0, booked = 0, closed = 0;
    leadsList.forEach(function (l) {
      var day = l.createdAt.slice(0, 10), src = l.source === 'form' ? 'form' : l.source;
      var d = byDay[day] = byDay[day] || { date: day, total: 0, replied: 0, booked: 0 };
      var s = bySrc[src] = bySrc[src] || { source: src, total: 0, replied: 0, booked: 0 };
      d.total++; s.total++;
      if (l.sentAt) { d.replied++; s.replied++; replied++; }
      if (l.calendarEventId) { d.booked++; s.booked++; booked++; }
      if (l.status === 'closed') closed++;
    });
    var total = leadsList.length;
    return { success: true, stats: {
      rangeDays: 30, totalLeads: total, repliedCount: replied, bookedCount: booked, closedCount: closed,
      pendingApprovalCount: 0, humanReviewCount: 1, replyRate: Math.round(replied / total * 100) / 100, bookingRate: Math.round(booked / replied * 100) / 100, avgResponseSeconds: 14,
      bySource: Object.keys(bySrc).map(function (k) { var r = bySrc[k]; r.replyRate = Math.round(r.replied / r.total * 100) / 100; return r; }).sort(function (a, b) { return b.total - a.total; }),
      trend: Object.keys(byDay).sort().map(function (k) { return byDay[k]; }) } };
  }

  /* Calendar: the jobs Humarains booked */
  function atDay(offset, hour, min) { var d = new Date(NOW); d.setDate(d.getDate() + offset); d.setHours(hour, min || 0, 0, 0); return d.getTime(); }
  var CAL = [
    ['Kitchen tap repair: Maria Santos', atDay(1, 9), 'Riverside'],
    ['Blocked drain: Tom Okafor', atDay(1, 11, 30), 'Maple Heights'],
    ['Water heater service: Priya Nair', atDay(1, 14, 30), 'Oakdale'],
    ['Bathroom leak: Chen Wei', atDay(4, 8), 'Eastgate'],
    ['Dishwasher hook-up: Ben Reed', atDay(4, 10, 30), 'Lakeview'],
    ['Outdoor tap install: Zoe Haddad', atDay(5, 13), 'Hillcrest'],
    ['Hot water system quote: Raj Silva', atDay(6, 9, 30), 'Westfield']
  ].map(function (c, i) { return { id: 'cal-' + i, summary: c[0], start: iso(c[1]), end: iso(c[1] + 3600e3), allDay: false, location: c[2], link: '#' }; });

  var USER = { id: 'demo-user', name: 'Northside Plumbing', email: 'alex@northsideplumbing.example', plan: 'growth', features: { whatsappFeatureEnabled: true }, onboarding_required: false };
  var SETTINGS = {
    businessName: 'Northside Plumbing', businessType: 'Plumbing', ownerName: 'Alex Morgan', phone: '', bookingUrl: '', website: '', address: '',
    responseTime: '', description: 'Local plumbers for repairs, drains and hot water.', targetCustomer: 'Homeowners and landlords', specialInstructions: '',
    currency: 'USD', services: [{ name: 'Call-out and repair', price: 150 }, { name: 'Blocked drain', price: 195 }, { name: 'Hot water service', price: 890 }]
  };

  /* ── 3. Route table ─────────────────────────────────────────── */
  function route(path, method) {
    var u = path.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/+$/, '');
    if (method !== 'GET') return { success: true, message: 'This is an example account, so nothing was changed.' };
    if (u === '/api/users/me' || u === '/api/account/me') return { success: true, user: USER };
    if (u === '/api/users/setup-status') return { onboarding_required: false, success: true };
    if (u === '/api/leads') return { success: true, leads: leadsList };
    if (u === '/api/leads/settings') return { success: true, settings: SETTINGS, sendQuota: { used: 214, limit: 400, unlimited: false } };
    if (u === '/api/leads/performance') return performance();
    if (u === '/api/leads/inbox/conversations') {
      return { success: true, conversations: Object.keys(convScripts).map(conversationRow).sort(function (a, b) { return new Date(b.lastAt) - new Date(a.lastAt); }) };
    }
    var m = u.match(/^\/api\/leads\/inbox\/conversations\/([^/]+)$/);
    if (m) return conversationThread(decodeURIComponent(m[1])) || { success: false, message: 'Chat not found.' };
    if (u === '/api/leads/calendar/status') return { success: true, connected: true, email: 'bookings@northsideplumbing.example' };
    if (u === '/api/leads/calendar/events') return { success: true, events: CAL };
    if (u === '/api/leads/email-settings') return { success: true, connected: true, config: { email: 'hello@northsideplumbing.example', provider: 'google' } };
    if (u === '/api/leads/whatsapp/status') return { success: true, connected: true, configured: true, displayPhone: '+61 400 000 000' };
    if (u === '/api/leads/human-review' || u === '/api/leads/consent-queue') return { success: true, leads: [], count: 0 };
    if (u === '/api/workflows') return { success: true, workflows: [] };
    if (u === '/api/agent/prefs') return { success: true, prefs: {} };
    if (u === '/api/settings/public') return { features: { whatsapp: true } };
    if (window.console && console.debug) console.debug('[demo] unhandled', method, u);
    return { success: true };
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') === -1) return realFetch ? realFetch(input, init) : Promise.reject(new Error('offline'));
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var body = route(url, method);
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }, 60 + Math.random() * 90);
    });
  };

  /* ── 4. Presentation: no cookie banner, no pointer clutter, view switching ── */
  var css = document.createElement('style');
  css.textContent = '#cc-banner,#cc-modal-overlay,#lcToast{display:none!important}html,body{overflow:hidden}#calConnectedCard>.lc-settings-section:nth-child(2){display:none}';
  (document.head || document.documentElement).appendChild(css);

  var VIEWS = {
    leads: function () { click('.lc-nav-item[data-view="leads"]'); },
    inbox: function () { click('.lc-nav-item[data-view="inbox"]'); openChat('Maria Santos'); },
    insights: function () { click('.lc-nav-item[data-view="performance"]'); },
    calendar: function () { click('.lc-nav-item[data-view="email"]'); setTimeout(function () { click('.lc-tab[data-tab="calendar"]'); }, 40); }
  };
  function openChat(name, tries) {
    var items = [].slice.call(document.querySelectorAll('.wai-item')), hit = items.filter(function (n) { return n.textContent.indexOf(name) > -1; })[0];
    if (hit) { if (!hit.classList.contains('active') && hit.getAttribute('aria-current') !== 'true') hit.click(); return; }
    if ((tries || 0) < 20) setTimeout(function () { openChat(name, (tries || 0) + 1); }, 150);
  }
  function click(sel) { var n = document.querySelector(sel); if (n) n.click(); }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (d && d.type === 'hm-demo-view' && VIEWS[d.view]) VIEWS[d.view]();
  });
  window.addEventListener('load', function () {
    try { parent.postMessage({ type: 'hm-demo-ready' }, location.origin); } catch (_) { /* not embedded */ }
  });
})();
