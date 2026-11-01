// Email links open a specific page or lead (?view=...&lead=...&ask=...). Remember them for this browser tab before anything can send the
// visitor to the login page, so they still land in the right place after logging in. agent.js (openDeepLink) uses them.
(function () {
  try {
    var q = window.location.search || '';
    if (/[?&](view|lead|ask)=/.test(q)) sessionStorage.setItem('hm_go', JSON.stringify({ q: q, t: Date.now() }));
  } catch (_) {}
})();
/* ═══════════════════════════════════════════════════════════════
   LEADS.JS — Humarains AI Lead Conversion System
   All API calls are real. No demo data. No fallbacks.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  let currentUser  = null;
  let leads        = [];
  let settings     = { businessName:'', businessType:'', ownerName:'', phone:'', bookingUrl:'', website:'', address:'', responseTime:'', description:'', targetCustomer:'', specialInstructions:'', currency:'USD', timezone:'UTC', services:[], agentMode:'autonomous' };
  let _cachedEmailConfig = undefined; // undefined = not loaded yet, null = not connected
  let activeFilter = 'all';
  let activeLead   = null;
  let agentMode    = 'autonomous'; // fixed: there is no manual-approval mode

  const SETT_KEY = 'lc_settings_v1';

  // ── Helpers ───────────────────────────────────────────────────
  const el  = id => document.getElementById(id);
  const esc = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt = n  => n == null ? '—' : Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

  // settings key -> [input id, kind]. kind: num | text | bool. Drives load + save
  // for the Quote Rules and Policies sections.
  const QUOTE_FIELDS = {
    estimateRangePercent:['settEstimateRangePercent','num'], siteVisitAbove:['settSiteVisitAbove','num'], siteVisitFee:['settSiteVisitFee','num'],
    proposalValidityDays:['settProposalValidityDays','num'], maxDiscountPercent:['settMaxDiscountPercent','num'],
    quoteInfoNeeded:['settQuoteInfoNeeded','text'], neverQuote:['settNeverQuote','text'],
    standardDepositPercent:['settStandardDepositPercent','num'], paymentTerms:['settPaymentTerms','text'], paymentMethods:['settPaymentMethods','text'],
    cancellationFee:['settCancellationFee','num'], warrantyPolicy:['settWarrantyPolicy','text'], licenseInsurance:['settLicenseInsurance','text'],
    cancellationPolicy:['settCancellationPolicy','text'],
    photoQuoteEnabled:['settPhotoQuoteEnabled','bool'], photoQuoteMaxValue:['settPhotoQuoteMaxValue','num'],
    photoQuoteUnclear:['settPhotoQuoteUnclear','text'], photoQuoteGuidance:['settPhotoQuoteGuidance','text'],
    photoQuoteDisclaimer:['settPhotoQuoteDisclaimer','text'],
  };
  function collectQuoteFields(keys) {
    keys.forEach(k => {
      const [id, kind] = QUOTE_FIELDS[k]; const e = el(id); if (!e) return;
      if (kind === 'bool') settings[k] = !!e.checked;
      else if (kind === 'num') settings[k] = parseFloat(e.value) || 0;
      else settings[k] = e.value.trim();
    });
    const qm  = el('settQuoteMode');     if (qm  && keys.includes('estimateRangePercent')) settings.quoteMode = qm.value;
  }

  function saveSettings() { try { localStorage.setItem(SETT_KEY, JSON.stringify(settings)); } catch(_){} }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETT_KEY)||'{}');
      settings = Object.assign({businessName:'',businessType:'',ownerName:'',phone:'',bookingUrl:'',website:'',address:'',responseTime:'',description:'',targetCustomer:'',specialInstructions:'',currency:'USD',timezone:'UTC',services:[]}, s);
    } catch(_) {}
  }

  // ── Auth ──────────────────────────────────────────────────────
  function getCsrf() {
    try {
      const m = document.cookie.split('; ').find(r => r.startsWith('bp_csrf='));
      return m ? decodeURIComponent(m.split('=')[1]) : '';
    } catch(_) { return ''; }
  }

  async function apiFetch(url, opts={}) {
    const res = await fetch(url, {
      credentials:'include', ...opts,
      headers:{'Content-Type':'application/json','x-csrf-token':getCsrf(),...(opts.headers||{})},
    });
    if (res && res.status === 401) { window.location.href='/login.html'; return null; }
    return res;
  }

  // Requests the page started while it was still loading (see the top of dashboard.html). Null when there is none.
  async function earlyGet(url) {
    const p = window.__early && window.__early.take(url);
    if (!p) return null;
    try {
      const r = await p;
      if (r && r.status === 401) { window.location.href='/login.html'; }
      return r || null;
    } catch (_) { return null; }
  }
  const fastGet = async url => (await earlyGet(url)) || apiFetch(url);

  async function initAuth() {
    const res = (await earlyGet('/api/users/me')) || await fetch('/api/users/me', {credentials:'include'});
    if (!res.ok) { window.location.href='/login.html'; return false; }
    const data = await res.json();
    if (!data.success||!data.user) { window.location.href='/login.html'; return false; }
    currentUser = data.user;
    renderUser();
    return true;
  }

  function renderUser() {
    if (!currentUser) return;
    const name = currentUser.name||currentUser.email||'User';
    const initials = name.split(' ').filter(Boolean).map(n=>n[0]).join('').slice(0,2).toUpperCase()||'?';
    el('lcUserAvatar').textContent = initials;
    el('lcUserName').textContent   = name;
    const PLAN_LABELS = { free:'Free', starter:'Starter', growth:'Growth', business:'Pro' };
    el('lcUserPlan').textContent  = PLAN_LABELS[currentUser.plan] || (currentUser.plan||'free').toUpperCase();
    const plan = currentUser.plan||'free';
    const feats = (currentUser && currentUser.features) || {};
    // Apply nav gating for all features based on plan
    if (window.applyNavGating) window.applyNavGating(plan, feats);
    const manageRow = el('manageSubRow');
    if (manageRow) manageRow.style.display = plan!=='free' ? 'flex' : 'none';
    // Hide "You're on the Free plan" upgrade pitch for paying users
    const paywallMsg = el('paywallMsg');
    if (paywallMsg) paywallMsg.style.display = plan === 'free' ? '' : 'none';
    // Update the "You're on the ___ plan" label in the manage subscription row
    const planLabelEl = el('currentPlanLabel');
    if (planLabelEl) planLabelEl.textContent = PLAN_LABELS[plan] || plan;
    ['starter','growth','business'].forEach(p => {
      const btn = el('checkoutBtn-'+p);
      if (btn && plan===p) { btn.disabled=true; btn.textContent='Current plan'; btn.style.opacity='0.4'; }
    });

    // If the admin has globally disabled the WhatsApp feature, hide the nav
    // item and its full view so users never see any WhatsApp UI.
    const waNav  = document.querySelector('.lc-nav-item[data-view="whatsapp"]');
    const waView = el('view-whatsapp');
    if (feats.whatsappFeatureEnabled === false) {
      if (waNav)  waNav.style.display  = 'none';
      if (waView) waView.style.display = 'none';
      // Also hide the WhatsApp row in the Integrations/Settings view
      document.querySelectorAll('[data-whatsapp-feature]').forEach(function(el) {
        el.style.display = 'none';
      });
    }
  }

  // ── Toast ─────────────────────────────────────────────────────
  function toast(msg, type='info', dur=3500) {
    const c = el('lcToast'); if (!c) return;
    const t = document.createElement('div');
    t.className = 'lc-toast'+(type==='error'?' error':'');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity 0.25s'; setTimeout(()=>t.remove(),260); }, dur);
  }

  // ── Labels ────────────────────────────────────────────────────
  const statusLabel  = s => ({new:'New',processing:'Processing',replied:'Replied',pending_followup:'Follow-up pending',closed:'Closed'}[s]||s);
  const intentLabel  = i => ({pricing:'Pricing',booking:'Booking',inquiry:'Inquiry',urgent_issue:'Urgent',complaint:'Complaint',other:'Other'}[i]||(i ? String(i).replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()) : '—'));
  const urgencyLabel = u => u ? u.charAt(0).toUpperCase()+u.slice(1) : '—';

  // ── Stats ─────────────────────────────────────────────────────
  function updateStats() {
    const total   = leads.length;
    const newL    = leads.filter(l=>l.status==='new'||l.status==='processing').length;
    const pending = leads.filter(l=>l.status==='pending_followup').length;
    const closed  = leads.filter(l=>l.status==='closed').length;
    const open    = total - closed;
    el('statTotal').textContent   = total;
    el('statNew').textContent     = newL;
    el('statPending').textContent = pending;
    el('statClosed').textContent  = closed;
    { const b = el('navBadgeAll'); if (b) b.textContent = open||''; }
    { const b = el('navBadgeNew'); if (b) b.textContent = newL||''; }
    { const b = el('navBadgePending'); if (b) b.textContent = pending||''; }
    renderLeadsCharts();
  }

  // ── Charts: leads received (14d bar chart) + status breakdown (donut) ──
  function renderLeadsTimeline() {
    const wrap = el('lcLeadsTimeline');
    if (!wrap) return;
    const days = 14;
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setHours(0,0,0,0);
      d.setDate(d.getDate() - (days - 1 - i));
      return { date: d, count: 0 };
    });
    leads.forEach(lead => {
      if (!lead.createdAt) return;
      const d = new Date(lead.createdAt);
      d.setHours(0,0,0,0);
      const t = d.getTime();
      const bucket = buckets.find(b => b.date.getTime() === t);
      if (bucket) bucket.count++;
    });
    const max = Math.max(1, ...buckets.map(b => b.count));
    wrap.innerHTML = buckets.map(b => {
      const pct = Math.max(Math.round((b.count / max) * 100), b.count > 0 ? 6 : 2);
      const dayNum = b.date.getDate();
      const full = b.date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
      return `<div class="lc-bar-col" title="${esc(full)}: ${b.count} lead${b.count===1?'':'s'}">
        <div class="lc-bar-track"><div class="lc-bar-fill" style="height:${pct}%"></div></div>
        <div class="lc-bar-label">${dayNum}</div>
      </div>`;
    }).join('');
  }

  function renderStatusBreakdown() {
    const donut  = el('lcStatusDonut');
    const legend = el('lcStatusLegend');
    if (!donut || !legend) return;
    const groups = [
      { label: 'Awaiting reply', color: 'var(--brand)', count: leads.filter(l=>l.status==='new'||l.status==='processing').length },
      { label: 'Follow-up',      color: 'var(--warn)',  count: leads.filter(l=>l.status==='pending_followup').length },
      { label: 'Replied',        color: 'var(--ok)',    count: leads.filter(l=>l.status==='replied').length },
      { label: 'Closed',         color: 'var(--text3)', count: leads.filter(l=>l.status==='closed').length },
    ];
    const total = groups.reduce((s,g)=>s+g.count, 0);
    const r = 15.9155; // circumference ≈ 100, so stroke-dasharray can use percentages directly
    let offset = 25; // start at 12 o'clock
    const segments = total ? groups.map(g => {
      const pct = (g.count / total) * 100;
      const circle = `<circle cx="21" cy="21" r="${r}" fill="transparent" stroke="${g.color}" stroke-width="6" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="${offset}"></circle>`;
      offset -= pct;
      return circle;
    }).join('') : '';
    donut.innerHTML = `<svg viewBox="0 0 42 42" width="112" height="112">
      <circle cx="21" cy="21" r="${r}" fill="transparent" stroke="var(--bg3)" stroke-width="6"></circle>
      ${segments}
    </svg>`;
    legend.innerHTML = groups.map(g => `
      <div class="lc-legend-row">
        <span class="lc-legend-dot" style="background:${g.color}"></span>
        <span class="lc-legend-label">${esc(g.label)}</span>
        <span class="lc-legend-count">${g.count}</span>
      </div>`).join('');
  }

  function renderLeadsCharts() {
    renderLeadsTimeline();
    renderStatusBreakdown();
  }

  // ── Table ─────────────────────────────────────────────────────
  function filteredLeads() {
    if (activeFilter==='all') return leads;
    if (activeFilter==='pending_followup') return leads.filter(l=>l.status==='pending_followup');
    // 'processing' leads (e.g. escalated to human review after a failed
    // auto-send) belong in the same "Awaiting Reply" bucket as 'new' —
    // keep this in sync with updateStats()'s newL calculation, or these
    // leads silently vanish from the New tab while still being counted
    // in its badge.
    if (activeFilter==='new') return leads.filter(l=>l.status==='new'||l.status==='processing');
    return leads.filter(l=>l.status===activeFilter);
  }

  function renderLeadsTable() {
    updateStats();
    const body   = el('lcLeadsBody');
    const subset = filteredLeads();
    if (!subset.length) {
      body.innerHTML = `<div class="lc-empty">
        <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none">
          <rect x="8" y="8" width="32" height="32" rx="5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M16 20h16M16 28h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <div class="lc-empty-title">No leads</div>
        <div class="lc-empty-text">Add a lead manually or connect your email to import enquiries.</div>
      </div>`;
      return;
    }
    body.innerHTML = subset.map(lead=>{
      const isWA = lead.source==='whatsapp'||!!(lead.whatsappThreadPhone);
      const sourceBadge = isWA
        ? `<span title="WhatsApp lead" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 6px;border-radius:20px;background:rgba(255,255,255,0.10);color:#ffffff;font-weight:700;margin-left:6px;vertical-align:middle;border:1px solid rgba(255,255,255,0.18)">WA</span>`
        : '';
      const contactLine = isWA
        ? `<span style="font-family:var(--mono);font-size:12px;color:var(--text3)">${esc(lead.fromPhone||'—')}</span>`
        : `<span class="lc-lead-email">${esc(lead.fromEmail||'—')}</span>`;
      return `<div class="lc-lead-row" data-id="${lead.id}">
        <div>
          <div class="lc-lead-name">${esc(lead.fromName||lead.customerName||'Unknown')}${sourceBadge}</div>
          ${contactLine}
        </div>
        <div class="lc-td">${esc(intentLabel(lead.intent))}</div>
        <div class="lc-td"><span class="lc-urgency ${esc(lead.urgency||'')}">${esc(urgencyLabel(lead.urgency))}</span></div>
        <div class="lc-td" style="font-family:var(--mono);font-size:12px">${lead.quote?((lead.quote.requiresSiteVisit&&!lead.quote.total)?'Site visit':esc(lead.quote.currency)+' '+fmt(lead.quote.total)):'—'}</div>
        <div class="lc-td"><span class="lc-status ${esc(lead.status)}">${esc(statusLabel(lead.status))}</span>${lead.calendarEventId ? ` <a href="${esc(lead.calendarEventLink||'#')}" target="_blank" title="View Google Calendar event" style="margin-left:4px;font-size:11px;vertical-align:middle;opacity:0.75;text-decoration:underline">Event</a>` : ''}</div>
        <div class="lc-table-actions">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" data-open="${lead.id}">Open</button>
        </div>
      </div>`;
    }).join('');
    body.querySelectorAll('.lc-lead-row').forEach(row=>row.addEventListener('click',()=>openLead(row.dataset.id)));
    body.querySelectorAll('[data-open]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();openLead(btn.dataset.open);}));
  }

  // ── Sub-views ─────────────────────────────────────────────────
  function renderSubLeads(statusFilter) {
    const ids = {new:'view-new-content',pending_followup:'view-pending-content',closed:'view-closed-content'};
    const c = el(ids[statusFilter]); if (!c) return;
    // Same fix as filteredLeads(): 'processing' leads are counted into the
    // 'new' badge/stat, so they must also appear in the 'new' sub-view —
    // otherwise leads stuck at 'processing' (e.g. awaiting human review)
    // are uncounted-for-but-invisible in the New section.
    const subset = statusFilter==='new'
      ? leads.filter(l=>l.status==='new'||l.status==='processing')
      : leads.filter(l=>l.status===statusFilter);
    if (!subset.length) { c.innerHTML='<div class="lc-empty"><div class="lc-empty-title">None</div></div>'; return; }
    c.innerHTML = `<div class="lc-leads-table">
      <div class="lc-table-head">
        <div class="lc-th">Lead</div><div class="lc-th">Intent</div>
        <div class="lc-th">Urgency</div><div class="lc-th">Quote</div>
        <div class="lc-th">Status</div><div class="lc-th"></div>
      </div>
      <div>${subset.map(lead=>{
          const isWA = lead.source==='whatsapp'||!!(lead.whatsappThreadPhone);
          const sourceBadge = isWA
            ? `<span title="WhatsApp lead" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 6px;border-radius:20px;background:rgba(255,255,255,0.10);color:#ffffff;font-weight:700;margin-left:6px;vertical-align:middle;border:1px solid rgba(255,255,255,0.18)">WA</span>`
            : '';
          const contactLine = isWA
            ? `<span style="font-family:var(--mono);font-size:12px;color:var(--text3)">${esc(lead.fromPhone||'—')}</span>`
            : `<div class="lc-lead-email">${esc(lead.fromEmail||'—')}</div>`;
          return `<div class="lc-lead-row" data-id="${lead.id}">
            <div>
              <div class="lc-lead-name">${esc(lead.fromName||lead.customerName||'Unknown')}${sourceBadge}</div>
              ${contactLine}
            </div>
            <div class="lc-td">${esc(intentLabel(lead.intent))}</div>
            <div class="lc-td"><span class="lc-urgency ${esc(lead.urgency||'')}">${esc(urgencyLabel(lead.urgency))}</span></div>
            <div class="lc-td" style="font-family:var(--mono);font-size:12px">${lead.quote?((lead.quote.requiresSiteVisit&&!lead.quote.total)?'Site visit':esc(lead.quote.currency)+' '+fmt(lead.quote.total)):'—'}</div>
            <div class="lc-td"><span class="lc-status ${esc(lead.status)}">${esc(statusLabel(lead.status))}</span></div>
            <div class="lc-table-actions"><button class="lc-btn lc-btn-ghost lc-btn-sm" data-open="${lead.id}">Open</button></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
    c.querySelectorAll('.lc-lead-row').forEach(row=>row.addEventListener('click',()=>openLead(row.dataset.id)));
    c.querySelectorAll('[data-open]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();openLead(btn.dataset.open);}));
  }

  // ── Slide-over ────────────────────────────────────────────────
  function openLead(id) {
    const lead = leads.find(l=>l.id===id); if (!lead) return;
    activeLead = lead;
    window.HM_ACTIVE_LEAD = lead;   // read by handover-ui.js
    renderSlideover(lead);
    el('lcSlideover').classList.add('open');
    el('lcOverlay').classList.add('open');
  }

  function closeSlideover() {
    el('lcSlideover').classList.remove('open');
    el('lcOverlay').classList.remove('open');
    activeLead = null;
    window.HM_ACTIVE_LEAD = null;
  }


  // ══════════════════════════════════════════════════════════════
  // CONVERSATION THREAD RENDERER
  // ══════════════════════════════════════════════════════════════
  const STAGE_LABELS = {
    initial_inquiry:   'First Contact',
    quoted:            'Quote Sent',
    objection:         'Objection',
    clarifying:        'Clarifying',
    booking_requested: 'Booking Requested',
    deal_closed:       'Deal Closed ✓',
    post_sale:         'Post-Sale',
    stalled:           'Stalled',
  };

  function buildConversationThread(lead) {
    const history = lead.conversationHistory || [];

    // If no history but there is a raw body + aiReply, render the old way as a single turn each
    if (!history.length) {
      if (!lead.rawBody && !lead.aiReply) return '';
      const syntheticHistory = [];
      if (lead.rawBody) syntheticHistory.push({ role: 'customer', body: lead.rawBody, sentAt: lead.createdAt });
      if (lead.aiReply) syntheticHistory.push({ role: 'agent', body: lead.aiReply.body, subject: lead.aiReply.subject, sentAt: lead.sentAt, pending: !lead.sentAt });
      return renderThread(lead, syntheticHistory);
    }

    return renderThread(lead, history);
  }

  function renderThread(lead, history) {
    const customerInitials = (lead.fromName || lead.fromEmail || 'C').slice(0, 2).toUpperCase();
    const agentInitials    = (settings.ownerName || settings.businessName || 'AI').slice(0, 2).toUpperCase();
    const stage            = lead.conversationStage || 'initial_inquiry';
    const turnCount        = lead.turnCount || history.filter(t => t.role === 'customer').length || 1;

    const stageEl = `<div class="lc-thread-stage ${esc(stage)}">
      <svg viewBox="0 0 8 8" fill="none" width="7"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg>
      ${esc(STAGE_LABELS[stage] || stage)} · ${turnCount} turn${turnCount !== 1 ? 's' : ''}
    </div>`;

    const isWALead = lead.source === 'whatsapp' || !!(lead.whatsappThreadPhone);

    const turns = history.map(turn => {
      const isAgent    = turn.role === 'agent';
      const isPending  = isAgent && (turn.pending || !turn.sentAt);
      const initials   = isAgent ? agentInitials : customerInitials;
      const when       = turn.sentAt ? new Date(turn.sentAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : (isPending ? 'Pending send' : '');
      const rawBody    = (turn.body || '').trim();

      // Split off quoted reply thread ("On ... wrote:" / "> ..." lines)
      const quoteStartRe = /^(On .+wrote:\s*$|>)/m;
      const quoteMatch   = rawBody.match(quoteStartRe);
      let mainText  = rawBody;
      let quoteText = '';
      if (quoteMatch && quoteMatch.index > 0) {
        mainText  = rawBody.slice(0, quoteMatch.index).trim();
        quoteText = rawBody.slice(quoteMatch.index).trim();
      }

      // Render main text: collapse 3+ consecutive newlines → 2, then wrap paragraphs
      function formatEmailBody(text) {
        const normalised = text.replace(/(\n[ \t]*){3,}/g, '\n\n');
        return normalised.split('\n\n')
          .map(para => `<p style="margin:0 0 8px">${esc(para).replace(/\n/g,'<br>')}</p>`)
          .join('');
      }

      const bodyHtml = formatEmailBody(mainText);
      const quoteId  = 'q' + Math.random().toString(36).slice(2);
      const quoteHtml = quoteText
        ? `<div style="margin-top:4px">
             <button onclick="var q=document.getElementById('${quoteId}');q.style.display=q.style.display==='none'?'block':'none'" style="background:none;border:none;padding:0;font-size:11px;color:var(--text3);cursor:pointer">··· show quoted</button>
             <div id="${quoteId}" style="display:none;margin-top:6px;padding:8px 10px;border-left:2px solid var(--border2);font-size:11px;color:var(--text3);white-space:pre-wrap;word-break:break-word">${esc(quoteText)}</div>
           </div>`
        : '';

      const channelTag = isWALead
        ? `<span style="font-size:9px;opacity:0.55;margin-left:4px">${isAgent ? 'sent' : 'received'}</span>`
        : '';

      return `<div class="lc-thread-turn ${esc(isAgent ? 'agent' : 'customer')} ${isPending ? 'pending' : ''}">
        <div class="lc-thread-avatar">${esc(initials)}</div>
        <div style="flex:1;min-width:0">
          ${turn.subject && !isWALead ? `<div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-bottom:4px">${esc(turn.subject)}</div>` : ''}
          <div class="lc-thread-bubble" style="font-size:13px;line-height:1.55">${bodyHtml}${quoteHtml}</div>
          <div class="lc-thread-meta">${esc(when)}${isPending ? ' · draft' : ''}${channelTag}</div>
        </div>
      </div>`;
    }).join('');

    const copyBtn = (lead.aiReply && lead.conversationHistory && lead.conversationHistory.length)
      ? `<button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:10px" id="btnCopyReply">Copy latest reply</button>`
      : lead.aiReply
      ? `<button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:10px" id="btnCopyReply">Copy reply</button>`
      : '';

    return `<div class="lc-detail-section">
      <div class="lc-detail-label">Conversation</div>
      ${stageEl}
      <div class="lc-thread">${turns}</div>
      ${copyBtn}
    </div>`;
  }


  // ══════════════════════════════════════════════════════════════
  // AI LEAD SCORING — score, close probability, estimated value
  // Growth/Pro/Max only.
  // ══════════════════════════════════════════════════════════════

  function scoreUpgradeHtml() {
    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="none" width="13"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11" r="0.7" fill="currentColor"/></svg>
        AI Lead Score
      </div>
      <div style="font-size:12px;color:var(--text3);line-height:1.5">
        Score every lead by budget, urgency, sentiment and more — available on the Pro plan.
        <a href="#" onclick="window.showView('payment');return false;" style="color:var(--text2);text-decoration:underline">Upgrade to unlock</a>.
      </div>`;
  }

  function scoreLoadingHtml() {
    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="none" width="13"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 8h6M8 5l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        AI Lead Score
      </div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3)">
        <span class="lc-spinner" style="width:14px;height:14px"></span> Scoring this lead…
      </div>`;
  }

  function scoreErrorHtml(msg) {
    return `
      <div class="lc-detail-label">AI Lead Score</div>
      <div style="font-size:12px;color:var(--text3)">${esc(msg || "Couldn't score this lead.")}</div>
      <button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:8px" id="btnRetryScore">Try again</button>`;
  }

  function scoreResultHtml(s) {
    const score = s.score || 0;
    const scoreColor = score >= 75 ? 'var(--green)' : score >= 45 ? 'var(--amber)' : 'var(--red)';
    const barPct = Math.max(3, Math.min(100, score));
    const closePct = s.closeProbability != null ? s.closeProbability + '%' : '—';
    const valStr = s.estimatedValue != null
      ? (s.currency || '') + ' ' + s.estimatedValue.toLocaleString()
      : '—';

    const factorsHtml = (s.factors || []).map(f => {
      const fc = f.score >= 70 ? 'var(--green)' : f.score >= 40 ? 'var(--amber)' : 'var(--red)';
      return `
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
            <span style="font-size:12px;color:var(--text2);font-weight:500">${esc(f.name)}</span>
            <span style="font-size:11px;font-family:var(--mono);color:${fc};font-weight:600">${f.score}</span>
          </div>
          <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${Math.max(2,f.score)}%;background:${fc};border-radius:2px;transition:width .4s ease"></div>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:3px">${esc(f.note)}</div>
        </div>`;
    }).join('');

    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:6px">
          <svg viewBox="0 0 16 16" fill="none" width="13" style="color:${scoreColor}"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11" r="0.7" fill="currentColor"/></svg>
          AI Lead Score
        </span>
        <button class="lc-btn lc-btn-ghost lc-btn-sm" id="btnRefreshScore" style="font-size:10px;padding:2px 8px">Refresh</button>
      </div>

      <div style="display:flex;align-items:center;gap:14px;margin:10px 0 12px">
        <div style="text-align:center;flex-shrink:0">
          <div style="font-size:34px;font-weight:700;color:${scoreColor};font-family:var(--mono);line-height:1">${score}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">/ 100</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:10px">
            <div style="height:100%;width:${barPct}%;background:${scoreColor};border-radius:3px;transition:width .5s ease"></div>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:600">Close prob.</div>
              <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text)">${closePct}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:600">Est. value</div>
              <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text)">${esc(valStr)}</div>
            </div>
          </div>
        </div>
      </div>

      ${s.summary ? `<div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:12px;font-style:italic">${esc(s.summary)}</div>` : ''}

      <div style="border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:8px">Score factors</div>
        ${factorsHtml}
      </div>`;
  }

  async function loadLeadScore(lead, forceRefresh) {
    const section = el('sdLeadScoreSection');
    if (!section) return;

    const feats = (currentUser && currentUser.features) || {};
    if (!feats.leadScoring) {
      section.style.display = '';
      section.innerHTML = scoreUpgradeHtml();
      return;
    }

    const hasBody = lead.rawBody || (lead.conversationHistory && lead.conversationHistory.length);
    if (!hasBody) { section.style.display = 'none'; return; }

    section.style.display = '';
    section.innerHTML = scoreLoadingHtml();

    try {
      const url = `/api/leads/${lead.id}/score${forceRefresh ? '?refresh=true' : ''}`;
      const res = await apiFetch(url);
      if (!res) return;
      const d = await res.json();
      if (!res.ok || !d.success) {
        if (d.upgradeRequired) { section.innerHTML = scoreUpgradeHtml(); return; }
        section.innerHTML = scoreErrorHtml(d.message);
      } else {
        section.innerHTML = scoreResultHtml(d.score);
      }
    } catch (e) {
      section.innerHTML = scoreErrorHtml(e.message);
    }

    const retryBtn = el('btnRetryScore');
    if (retryBtn) retryBtn.addEventListener('click', () => loadLeadScore(lead, false));
    const refreshBtn = el('btnRefreshScore');
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadLeadScore(lead, true));
  }

  // ══════════════════════════════════════════════════════════════
  // DEAL INSIGHTS — "AI Sales Manager" read on this one lead.
  // Why is this deal stalling, what objections came up, what's next.
  // Pro/Max only — gated via currentUser.features.dealInsights (server
  // re-checks this on every call too, this is just to skip a wasted request
  // and show the upgrade nudge instead).
  // ══════════════════════════════════════════════════════════════
  const CONFIDENCE_LABELS = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

  function dealInsightsUpgradeHtml() {
    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="none" width="13"><path d="M8 2C5 6 3 7 4 10c.5 1.5 2 3 4 3s3.5-1.5 4-3c1-3-1-4-4-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        Deal Insights
      </div>
      <div style="font-size:12px;color:var(--text3);line-height:1.5">
        See why this deal is stalling, what objections came up, and what to do next — available on the Pro and Max plans.
        <a href="#" onclick="window.showView('payment');return false;" style="color:var(--text2);text-decoration:underline">Upgrade to unlock</a>.
      </div>`;
  }

  function dealInsightsLoadingHtml() {
    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="none" width="13"><path d="M8 2C5 6 3 7 4 10c.5 1.5 2 3 4 3s3.5-1.5 4-3c1-3-1-4-4-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        Deal Insights
      </div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3)">
        <span class="lc-spinner" style="width:14px;height:14px"></span> Reading the conversation…
      </div>`;
  }

  function dealInsightsErrorHtml(message) {
    return `
      <div class="lc-detail-label">Deal Insights</div>
      <div style="font-size:12px;color:var(--text3)">${esc(message || "Couldn't load deal insights.")}</div>
      <button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:8px" id="btnRetryDealInsights">Try again</button>`;
  }

  function dealInsightsResultHtml(lead, insights) {
    if (!insights.hasEnoughSignal) {
      return `
        <div class="lc-detail-label" style="display:flex;align-items:center;gap:6px">
          <svg viewBox="0 0 16 16" fill="none" width="13"><path d="M8 2C5 6 3 7 4 10c.5 1.5 2 3 4 3s3.5-1.5 4-3c1-3-1-4-4-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Deal Insights
        </div>
        <div style="font-size:13px;color:var(--text2)">${esc(insights.nextAction || 'Not enough conversation yet to read this deal — check back after the customer replies.')}</div>`;
    }

    const stallColor = insights.isStalling ? 'var(--amber)' : 'var(--green)';
    const stallIcon = insights.isStalling
      ? `<svg viewBox="0 0 16 16" fill="none" width="13" style="color:${stallColor}"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.5l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 16 16" fill="none" width="13" style="color:${stallColor}"><path d="M2 9l3-3 2.5 2.5L13 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const objectionsHtml = insights.objections && insights.objections.length
      ? `<div style="margin-top:10px">
          ${insights.objections.map(o => `
            <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-top:1px solid var(--border)">
              <span style="font-family:var(--mono);font-size:11px;color:var(--text3);flex-shrink:0;margin-top:1px">${o.count > 1 ? `×${o.count}` : '•'}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;color:var(--text);font-weight:600">${esc(o.text)}</div>
                ${o.evidence ? `<div style="font-size:12px;color:var(--text3);margin-top:2px">"${esc(o.evidence)}"</div>` : ''}
              </div>
            </div>`).join('')}
        </div>`
      : `<div style="margin-top:8px;font-size:12px;color:var(--text3)">No specific objections raised yet.</div>`;

    return `
      <div class="lc-detail-label" style="display:flex;align-items:center;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:6px">
          <svg viewBox="0 0 16 16" fill="none" width="13"><path d="M8 2C5 6 3 7 4 10c.5 1.5 2 3 4 3s3.5-1.5 4-3c1-3-1-4-4-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Deal Insights
        </span>
        <span style="font-size:10px;color:var(--text3);font-weight:500">${esc(CONFIDENCE_LABELS[insights.confidence] || '')}</span>
      </div>

      <div style="display:flex;align-items:flex-start;gap:8px;margin-top:6px">
        ${stallIcon}
        <div style="flex:1;font-size:13px;color:var(--text2);line-height:1.55">${esc(insights.stallReason || '—')}</div>
      </div>

      ${objectionsHtml}

      ${insights.nextAction ? `
      <div style="margin-top:12px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);font-weight:600;margin-bottom:4px">Next step</div>
        <div style="font-size:13px;color:var(--text);line-height:1.5">${esc(insights.nextAction)}</div>
      </div>` : ''}

      <button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:10px" id="btnRefreshDealInsights">Refresh</button>
    `;
  }

  async function loadDealInsights(lead, forceRefresh) {
    const section = el('sdDealInsightsSection');
    if (!section) return;

    const feats = (currentUser && currentUser.features) || {};
    if (!feats.dealInsights) {
      section.style.display = '';
      section.innerHTML = dealInsightsUpgradeHtml();
      return;
    }

    // Skip the call entirely for a brand-new lead with no conversation —
    // there's nothing for the AI to read yet, and it just clutters the panel.
    const hasConversation = (lead.conversationHistory && lead.conversationHistory.length) || lead.rawBody;
    if (!hasConversation) { section.style.display = 'none'; return; }

    section.style.display = '';
    section.innerHTML = dealInsightsLoadingHtml();

    try {
      const url = `/api/leads/${lead.id}/deal-insights${forceRefresh ? '?refresh=true' : ''}`;
      const res = await apiFetch(url);
      if (!res) return; // 401 already redirected
      const d = await res.json();
      if (!res.ok || !d.success) {
        if (d.upgradeRequired) { section.innerHTML = dealInsightsUpgradeHtml(); return; }
        section.innerHTML = dealInsightsErrorHtml(d.message);
      } else {
        section.innerHTML = dealInsightsResultHtml(lead, d.insights);
      }
    } catch (e) {
      section.innerHTML = dealInsightsErrorHtml(e.message);
    }

    const retryBtn = el('btnRetryDealInsights');
    if (retryBtn) retryBtn.addEventListener('click', () => loadDealInsights(lead, false));
    const refreshBtn = el('btnRefreshDealInsights');
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadDealInsights(lead, true));
  }

  function renderSlideover(lead) {
    el('lcSlideoverTitle').textContent = lead.fromName||lead.fromEmail||'Lead';
    el('lcSlideoverBody').innerHTML = `
      <div class="lc-detail-section">
        <div class="lc-detail-label">Contact</div>
        <div class="lc-detail-grid">
          <div><div class="lc-detail-key">Name</div><div class="lc-detail-val">${esc(lead.fromName||lead.customerName||'—')}</div></div>
          <div><div class="lc-detail-key">Email</div><div class="lc-detail-val" style="font-family:var(--mono);font-size:12px">${esc(lead.fromEmail||'—')}</div></div>
          <div><div class="lc-detail-key">Source</div><div class="lc-detail-val">${lead.source==='whatsapp'?`<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text);font-weight:600">WhatsApp</span>`:esc(lead.source||'—')}</div></div>
          ${(lead.fromPhone||lead.whatsappThreadPhone) ? `<div><div class="lc-detail-key">WhatsApp #</div><div class="lc-detail-val" style="font-family:var(--mono);font-size:12px">${esc(lead.whatsappThreadPhone||lead.fromPhone)}</div></div>` : ''}
          <div><div class="lc-detail-key">Received</div><div class="lc-detail-val" style="font-family:var(--mono);font-size:11px">${lead.createdAt?new Date(lead.createdAt).toLocaleString():'—'}</div></div>
        </div>
      </div>
      ${lead.rawBody?`
      <div class="lc-detail-section">
        <div class="lc-detail-label">Message</div>
        ${lead.subject?`<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:8px">Subject: ${esc(lead.subject)}</div>`:''}
        <div class="lc-reply-box" style="max-height:110px">${esc(lead.rawBody).replace(/\n/g,'<br>')}</div>
      </div>`:''}
      ${lead.intent?`
      <div class="lc-detail-section">
        <div class="lc-detail-label">AI Analysis</div>
        <div class="lc-detail-grid">
          <div><div class="lc-detail-key">Intent</div><div class="lc-detail-val">${esc(intentLabel(lead.intent))}</div></div>
          <div><div class="lc-detail-key">Urgency</div><div class="lc-detail-val">${esc(urgencyLabel(lead.urgency))}</div></div>
          <div><div class="lc-detail-key">Service</div><div class="lc-detail-val">${esc(lead.serviceType||'—')}</div></div>
          <div><div class="lc-detail-key">Quantity</div><div class="lc-detail-val">${esc(String(lead.quantity||'—'))}</div></div>
        </div>
        ${lead.summary?`<div style="margin-top:10px;padding:10px 12px;background:var(--bg3);border-radius:var(--r);font-size:13px;color:var(--text2);line-height:1.55">${esc(lead.summary)}</div>`:''}
      </div>`:''}
      <div class="lc-detail-section" id="sdLeadScoreSection" style="display:none"></div>
      <div class="lc-detail-section" id="sdDealInsightsSection" style="display:none"></div>
      ${lead.quote?`
      <div class="lc-detail-section">
        <div class="lc-detail-label">Quote</div>
        <div class="lc-quote-box">
          ${lead.quote.lineItems.map(li=>`<div class="lc-quote-row"><span>${esc(li.label)}</span><span style="font-family:var(--mono)">${esc(lead.quote.currency)} ${fmt(li.amount)}</span></div>`).join('')}
          ${lead.quote.range?`<div class="lc-quote-row"><span>Estimate range</span><span style="font-family:var(--mono)">${esc(lead.quote.currency)} ${fmt(lead.quote.range.low)} – ${fmt(lead.quote.range.high)}</span></div>`:''}
          ${lead.quote.requiresSiteVisit&&!lead.quote.lineItems.length?`<div class="lc-quote-total"><span>Site visit required before pricing</span></div>`:`<div class="lc-quote-total"><span>Total</span><span>${esc(lead.quote.currency)} ${fmt(lead.quote.total)}</span></div>`}
          ${lead.quote.requiresSiteVisit&&lead.quote.lineItems.length?`<div style="margin-top:9px;font-size:11px;color:var(--text3)">Site visit recommended before the price is final.</div>`:''}
          ${lead.quote.notes?`<div style="margin-top:9px;font-size:11px;color:var(--text3)">${esc(lead.quote.notes)}</div>`:''}
        </div>
      </div>`:''}
      ${buildConversationThread(lead)}
      ${lead.followUpSchedule&&lead.followUpSchedule.length?`
      <div class="lc-detail-section">
        <div class="lc-detail-label">Follow-up schedule</div>
        <div class="lc-fu-timeline">
          ${lead.followUpSchedule.map(fu=>`
          <div class="lc-fu-item">
            <div class="lc-fu-dot ${fu.status==='sent'?'sent':'pending'}"></div>
            <div>
              <div class="lc-fu-label">${esc(fu.label)}</div>
              <div class="lc-fu-meta">Day ${fu.day} &middot; ${esc(fu.status)}${fu.sendAt?' &middot; '+new Date(fu.sendAt).toLocaleDateString():''}</div>
            </div>
          </div>`).join('')}
        </div>
      </div>`:''}
      ${lead.followUps&&lead.followUps.length?`
      <div class="lc-detail-section">
        <div class="lc-detail-label">Sent follow-ups (${lead.followUps.length})</div>
        ${lead.followUps.map(fu=>`
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:7px">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:5px">${esc(fu.template)} &middot; ${fu.sentAt?new Date(fu.sentAt).toLocaleString():'draft'}</div>
          <div style="font-size:13px;color:var(--text2);white-space:pre-wrap">${esc((fu.body||'').slice(0,200))}</div>
        </div>`).join('')}
      </div>`:''}
      <div class="lc-detail-section">
        <div class="lc-detail-label">Status</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${['new','replied','pending_followup','closed'].map(s=>`
          <button class="lc-btn lc-btn-ghost lc-btn-sm" ${lead.status===s?'style="background:var(--bg4);color:var(--text)"':''} data-setstatus="${s}">${esc(statusLabel(s))}</button>`).join('')}
        </div>
      </div>
      ${lead.calendarEventId ? `
      <div class="lc-detail-section">
        <div class="lc-detail-label">Calendar Event</div>
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;font-size:13px">
          <svg viewBox="0 0 16 16" fill="none" width="14" style="color:var(--text);flex-shrink:0">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span style="color:var(--text2)">Event added to Google Calendar</span>
          <button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-left:auto" data-reschedule>Reschedule</button>
          ${lead.calendarEventLink ? `<a href="${esc(lead.calendarEventLink)}" target="_blank" style="margin-left:4px;font-size:11px;color:var(--text);text-decoration:underline;font-weight:600">View →</a>` : ''}
        </div>
      </div>` : ''}`;

    const cpBtn = el('btnCopyReply');
    if (cpBtn) {
      const latestReply = (() => {
        const history = lead.conversationHistory || [];
        // Find last agent turn
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'agent' && history[i].body) return history[i].body;
        }
        return lead.aiReply ? lead.aiReply.body : null;
      })();
      if (latestReply) cpBtn.addEventListener('click', () => navigator.clipboard.writeText(latestReply).then(() => toast('Copied')));
    }
    el('lcSlideoverBody').querySelectorAll('[data-setstatus]').forEach(btn=>btn.addEventListener('click',()=>setStatus(lead.id,btn.dataset.setstatus)));
    el('lcSlideoverBody').querySelectorAll('[data-reschedule]').forEach(btn=>btn.addEventListener('click',()=>openRescheduleModal(lead.id)));

    loadLeadScore(lead);
    loadDealInsights(lead);

    const btnProcess = el('lcBtnProcessLead');
    if (btnProcess) btnProcess.style.display = !lead.aiReply ? '' : 'none';
    // Show "Send Reply" for email OR WhatsApp leads — label reflects channel
    const canSend = !!(lead.aiReply && !lead.sentAt && (lead.fromEmail || lead.fromPhone || lead.whatsappThreadPhone));
    const btnSend = el('lcBtnSendReply');
    if (btnSend) {
      btnSend.style.display = canSend ? '' : 'none';
      if (canSend) {
        const isWALead = lead.source === 'whatsapp' || !!(lead.whatsappThreadPhone);
        btnSend.textContent = isWALead ? 'Send via WhatsApp' : 'Send Reply';
      }
    }
    const btnFollowUp = el('lcBtnFollowUp');
    // Follow-ups are email only: never offered on a WhatsApp conversation (the AI replies whenever the customer writes).
    const isWAConv = lead.source === 'whatsapp' || !!(lead.whatsappThreadPhone);
    if (btnFollowUp) btnFollowUp.style.display = (lead.sentAt&&lead.status!=='closed'&&!isWAConv&&lead.fromEmail) ? '' : 'none';
    const btnCloseLead = el('lcBtnCloseLead');
    if (btnCloseLead) btnCloseLead.style.display = lead.status!=='closed' ? '' : 'none';
    // Show "Add to Calendar" for closed leads that don't yet have a calendar event
    const btnAddCal = el('lcBtnAddToCalendar');
    if (btnAddCal) btnAddCal.style.display = (lead.status==='closed' && !lead.calendarEventId) ? '' : 'none';
  }

  // ── Lead operations ───────────────────────────────────────────
  async function processLead(id) {
    const lead = leads.find(l=>l.id===id); if (!lead) return;
    el('lcBtnProcessLead').disabled = true;
    el('processSpinner').style.display = '';
    updateLeadLocal(id,{status:'processing'});
    renderLeadsTable();
    try {
      const res = await apiFetch('/api/leads/process/'+id,{method:'POST'});
      if (!res) return;
      const data = await res.json();
      if (data.success&&data.lead) {
        mergeLeadFromServer(data.lead);
        toast('AI processing complete');
      } else {
        updateLeadLocal(id,{status:'new'});
        toast(data.message||'Processing failed','error');
      }
    } catch(err) {
      updateLeadLocal(id,{status:'new'});
      toast(err.message,'error');
    }
    el('lcBtnProcessLead').disabled = false;
    el('processSpinner').style.display = 'none';
    renderLeadsTable();
    const updated = leads.find(l=>l.id===id);
    if (updated&&activeLead?.id===id) renderSlideover(updated);
  }

  async function sendReply(id) {
    const lead = leads.find(l=>l.id===id); if (!lead||!lead.aiReply) return;
    el('lcBtnSendReply').disabled = true;
    // Use the correct endpoint depending on lead source
    const isWA = lead.source === 'whatsapp' || !!(lead.whatsappThreadPhone);
    const endpoint = isWA ? `/api/leads/whatsapp/send/${id}` : `/api/leads/send-reply/${id}`;
    toast('Sending reply...');
    try {
      const res = await apiFetch(endpoint,{method:'POST'});
      if (!res) return;
      const data = await res.json();
      if (data.success&&data.lead) {
        mergeLeadFromServer(data.lead);
        toast('Reply sent ✓');
        // Update quota state — if free user, they're now locked
        if (data.sendQuota) {
          _sendQuota = data.sendQuota;
          refreshGating();
        }
      } else if (data.quotaExceeded) {
        _sendQuota = { used: data.used !== undefined ? data.used : 1, limit: data.limit || 1 };
        toast('Free send used — upgrade to Pro to continue sending', 'error');
        applyPlanGating();
      } else {
        toast(data.message||'Failed to send','error');
      }
    } catch(err) { toast(err.message,'error'); }
    el('lcBtnSendReply').disabled = false;
    renderLeadsTable();
    const updated = leads.find(l=>l.id===id);
    if (updated&&activeLead?.id===id) renderSlideover(updated);
  }

  async function sendFollowUp(id) {
    const lead = leads.find(l=>l.id===id); if (!lead) return;
    el('lcBtnFollowUp').disabled = true;
    toast('Generating follow-up...');
    const template = ['reminder','urgency','closure'][Math.min((lead.followUps||[]).length,2)];
    try {
      const res = await apiFetch('/api/leads/followup/'+id,{method:'POST',body:JSON.stringify({template})});
      if (!res) return;
      const data = await res.json();
      if (data.success) { updateLeadLocal(id,{followUps:[...(lead.followUps||[]),data.followUp]}); toast('Follow-up sent'); }
      else toast(data.message||'Failed','error');
    } catch(err) { toast(err.message,'error'); }
    el('lcBtnFollowUp').disabled = false;
    const updated = leads.find(l=>l.id===id);
    if (updated&&activeLead?.id===id) renderSlideover(updated);
  }

  async function setStatus(id,status) {
    updateLeadLocal(id,{status});
    renderLeadsTable();
    const updated = leads.find(l=>l.id===id);
    if (updated&&activeLead?.id===id) renderSlideover(updated);
    toast('Status: '+statusLabel(status));
    try {
      const res = await apiFetch('/api/leads/'+id+'/status',{method:'PATCH',body:JSON.stringify({status})});
      if (res && res.ok) {
        const d = await res.json();
        if (d && d.lead) mergeLeadFromServer(d.lead);
        // Ask permission before adding to Google Calendar
        if (d && d.calendarPermissionNeeded && typeof window._showCalPermModal === 'function') {
          window._showCalPermModal(id);
        }
      }
    } catch(_) {}
  }

  function updateLeadLocal(id,updates) {
    const idx = leads.findIndex(l=>l.id===id); if (idx<0) return;
    leads[idx] = {...leads[idx],...updates,updatedAt:new Date().toISOString()};
  }

  function mergeLeadFromServer(serverLead) {
    const idx = leads.findIndex(l=>l.id===serverLead.id);
    if (idx>=0) leads[idx]={...leads[idx],...serverLead};
    else leads.unshift(serverLead);
  }

  // ── Ingest ────────────────────────────────────────────────────
  async function ingestLead(withProcess) {
    const email = el('ingestEmail').value.trim();
    const body  = el('ingestBody').value.trim();
    if (!email&&!body) { toast('Email address or message body required','error'); return; }

    const payload = {
      fromEmail: email||null,
      fromName:  el('ingestName').value.trim()||null,
      subject:   el('ingestSubject').value.trim()||null,
      body,
      source:    el('ingestSource').value,
    };

    el('btnIngestOnly').disabled = true;
    el('btnIngestAndProcess').disabled = true;
    if (withProcess) el('ingestSpinner').style.display = '';

    try {
      const res = await apiFetch('/api/leads/ingest',{method:'POST',body:JSON.stringify(payload)});
      if (!res) return;
      const data = await res.json();
      if (!data.success) { toast(data.message||'Ingest failed','error'); return; }
      mergeLeadFromServer(data.lead);
      renderLeadsTable();
      toast('Lead saved');
      clearIngestForm();
      if (withProcess&&data.lead) {
        showView('leads');
        await processLead(data.lead.id);
        const lead = leads.find(l=>l.id===data.lead.id);
        if (lead) openLead(lead.id);
      } else {
        showView('leads');
      }
    } catch(err) { toast(err.message,'error'); }
    finally {
      el('btnIngestOnly').disabled = false;
      el('btnIngestAndProcess').disabled = false;
      el('ingestSpinner').style.display = 'none';
    }
  }

  function clearIngestForm() {
    ['ingestName','ingestEmail','ingestSubject','ingestBody'].forEach(id=>{const e=el(id);if(e)e.value='';});
  }

  // ── Inbox poll (IMAP) ────────────────────────────────────────
  function showPollProgress(text) {
    const bar  = el('lcPollProgress');
    const txt  = el('lcPollProgressText');
    if (bar) { bar.style.display = 'flex'; }
    if (txt) txt.textContent = text;
  }
  function hidePollProgress() {
    const bar = el('lcPollProgress');
    if (bar) bar.style.display = 'none';
  }

  // silent=true is used by the auto-poll — suppresses progress bar and
  // "no new leads" toast so the UI isn't noisy every 10 seconds.
  // New leads and errors always surface regardless of silent mode.
  let _pollSince = Date.now();   // leads the server handled after this moment are reported by the next poll
  async function pollEmail(silent = false) {
    if (!silent) showPollProgress('Connecting to your inbox…');
    try {
      if (!silent) showPollProgress('Checking for new emails…');
      // Manual checks (not silent) force a fresh look at the inbox; the 10s auto-poll just asks the server what it handled.
      const res = await apiFetch('/api/leads/ingest/email',{method:'POST',body:JSON.stringify({force:!silent,since:_pollSince})});
      if (!res) { hidePollProgress(); return; }
      if (!silent) showPollProgress('AI is analysing emails…');
      const data = await res.json();
      hidePollProgress();
      if (data.success && data.serverTime) _pollSince = data.serverTime;
      if (data.success) {
        const newLeads = (data.leads||[]).filter(l => l.intent !== 'not_a_lead');
        if (newLeads.length) {
          newLeads.forEach(l=>mergeLeadFromServer(l));
          renderLeadsTable(); updateStats();
          const parts = [`${newLeads.length} lead${newLeads.length!==1?'s':''} processed`];
          if (data.consentQueue) parts.push(`${data.consentQueue} in consent queue`);
          if (data.humanReview)  parts.push(`${data.humanReview} need review`);
          if (data.skipped)      parts.push(`${data.skipped} filtered`);
          toast(parts.join(' · '));
          refreshBadgeCounts();
          _gsCheckSetupStatus();
          const calPending = newLeads.filter(l => l._calendarPermissionNeeded);
          if (calPending.length && typeof window._showCalPermModal === 'function') {
            window._showCalPermModal(calPending[0].id);
          }
        } else if (data.needsEmail) {
          if (!silent) {
            toast('Email not connected — set it up in Email Connection','error');
            showView('email');
          }
        } else {
          // Silent auto-polls don't toast "no new leads" — too noisy every 10s
          if (!silent) {
            const skippedNote = data.skipped ? ` (${data.skipped} filtered)` : '';
            toast('Inbox checked — no new leads' + skippedNote);
          }
        }
      } else {
        // Always show errors even on silent polls
        toast(data.message||'Poll failed','error');
      }
    } catch(err) { hidePollProgress(); if (!silent) toast(err.message,'error'); }
  }

  // ── Email connection view ─────────────────────────────────────
  async function renderEmailView() {
    // Step 1: show instantly from cache or localStorage — zero delay
    const savedAddress = localStorage.getItem('lc_email_address');
    if (_cachedEmailConfig !== undefined) {
      showEmailStatus(_cachedEmailConfig);
    } else if (savedAddress) {
      showEmailStatus({ type: 'email', user: savedAddress });
    }
    // Step 2: verify with server in background and update if needed
    try {
      const res = await apiFetch('/api/leads/email-settings');
      if (!res) { console.log('[email-settings] no response'); return; }
      const data = await res.json();
      console.log('[email-settings] status:', res.status, 'data:', JSON.stringify(data));
      const config = data.connected ? data.config : null;
      // If server says disconnected but localStorage says connected, trust the server
      if (!config) localStorage.removeItem('lc_email_address');
      _cachedEmailConfig = config;
      showEmailStatus(config);
    } catch(err) {
      console.log('[email-settings] error:', err.message);
    }
  }

  function showEmailStatus(config) {
    const statusCard  = el('emailStatusCard');
    const connectCard = el('emailConnectCard');
    if (!statusCard||!connectCard) return;

    if (config) {
      statusCard.style.display  = 'flex';
      connectCard.style.display = 'none';
      // Show auto-poll indicator
      const ind = el('autoPollIndicator');
      if (ind) ind.style.display = 'flex';
      const titleEl = el('emailConnectedTitle');
      const addrEl  = el('emailConnectedAddress');
      if (titleEl) titleEl.textContent = 'Email Connected';
      if (addrEl)  addrEl.textContent  = config.user || config.fromName || '—';
    } else {
      statusCard.style.display  = 'none';
      connectCard.style.display = 'block';
      const ind = el('autoPollIndicator');
      if (ind) ind.style.display = 'none';
    }
  }

  // ── Google Calendar status UI ─────────────────────────────────
  function showCalendarStatus(connected, email) {
    const connCard = el('calConnectedCard');
    const discCard = el('calDisconnectedCard');
    if (!connCard || !discCard) return;
    if (connected) {
      connCard.style.display = '';
      discCard.style.display = 'none';
      const emailEl = el('calConnectedEmail');
      if (emailEl) emailEl.textContent = email || 'Connected';
    } else {
      connCard.style.display = 'none';
      discCard.style.display = '';
    }
  }

  async function loadCalendarStatus() {
    try {
      const res = await apiFetch('/api/leads/calendar/status');
      if (!res || !res.ok) return;
      const d = await res.json();
      showCalendarStatus(d.connected, d.email);
      if (d.connected) loadCalendarEvents();
    } catch (_) {}
  }

  // ── Upcoming calendar events list ─────────────────────────────
  function fmtEventTime(iso, allDay) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (allDay) return dt.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    return dt.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function calEventsSkeleton(count = 3) {
    return Array.from({ length: count }, () => '<div class="lc-skeleton-row"></div>').join('');
  }

  function renderCalendarEvents(events) {
    const list = el('calEventsList');
    if (!list) return;
    if (!events || !events.length) {
      list.innerHTML = `<div class="lc-empty" style="padding:32px 20px">
        <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none">
          <rect x="8" y="10" width="32" height="30" rx="4" stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 19h32" stroke="currentColor" stroke-width="1.5"/>
          <path d="M16 6v7M32 6v7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <div class="lc-empty-title">No upcoming events</div>
        <div class="lc-empty-text">Anything on this calendar will show up here.</div>
      </div>`;
      return;
    }
    list.innerHTML = events.map(ev => `
      <a href="${esc(ev.link || '#')}" target="_blank" class="lc-cal-event">
        <div class="lc-cal-event-icon">
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
            <path d="M3 8h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M7 2v3M13 2v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="lc-cal-event-body">
          <div class="lc-cal-event-title">${esc(ev.summary || '(No title)')}</div>
          <div class="lc-cal-event-meta">${esc(fmtEventTime(ev.start, ev.allDay))}${ev.location ? ' · ' + esc(ev.location) : ''}</div>
        </div>
      </a>
    `).join('');
  }

  async function loadCalendarEvents() {
    const list = el('calEventsList');
    if (list) list.innerHTML = calEventsSkeleton();
    try {
      const res = await apiFetch('/api/leads/calendar/events');
      if (!res) return;
      const d = await res.json();
      if (d.success) {
        renderCalendarEvents(d.events);
      } else if (list) {
        list.innerHTML = `<div class="lc-empty" style="padding:32px 20px">
          <div class="lc-empty-title">Couldn't load events</div>
          <div class="lc-empty-text">${esc(d.message || 'Something went wrong loading your calendar.')}</div>
        </div>`;
      }
    } catch (err) {
      if (list) list.innerHTML = `<div class="lc-empty" style="padding:32px 20px">
        <div class="lc-empty-title">Couldn't load events</div>
        <div class="lc-empty-text">Check your connection and try refreshing.</div>
      </div>`;
    }
  }

  // ── Reschedule a booked job ───────────────────────────────────
  function closeRescheduleModal() {
    const ov = document.getElementById('rsOverlay');
    if (ov) ov.remove();
    document.removeEventListener('keydown', onRescheduleKey);
  }
  function onRescheduleKey(e) { if (e.key === 'Escape') closeRescheduleModal(); }

  async function openRescheduleModal(id) {
    const lead = leads.find(l => l.id === id); if (!lead || !lead.calendarEventId) return;
    closeRescheduleModal();
    const ov = document.createElement('div');
    ov.className = 'rs-overlay'; ov.id = 'rsOverlay';
    ov.innerHTML = `
      <div class="rs-modal" role="dialog" aria-modal="true" aria-labelledby="rsTitle">
        <div class="rs-head"><h3 id="rsTitle">Reschedule booking</h3><button type="button" class="rs-x" aria-label="Close" data-rs-close>&times;</button></div>
        <p class="rs-sub">${esc(lead.customerName || lead.fromName || 'Customer')}${lead.serviceType && lead.serviceType !== 'unknown' ? ' &middot; ' + esc(lead.serviceType) : ''}</p>
        <div class="rs-current" id="rsCurrent">Checking the current time&hellip;</div>
        <div class="rs-grid">
          <div><label class="lc-label" for="rsDate">New date</label><input type="date" id="rsDate" class="lc-input"></div>
          <div><label class="lc-label" for="rsTime">New time</label><input type="time" id="rsTime" class="lc-input"></div>
        </div>
        <label class="rs-check"><input type="checkbox" id="rsNotify" checked><span id="rsNotifyText">Email the customer the new time (Google Calendar sends it)</span></label>
        <div class="rs-err" id="rsErr" role="alert" hidden></div>
        <div class="rs-result" id="rsResult" hidden></div>
        <div class="rs-actions"><button type="button" class="lc-btn lc-btn-ghost" data-rs-close id="rsCancel">Cancel</button><button type="button" class="lc-btn lc-btn-primary" id="rsSave">Move booking</button></div>
      </div>`;
    document.body.appendChild(ov);
    document.addEventListener('keydown', onRescheduleKey);
    ov.addEventListener('mousedown', e => { if (e.target === ov) closeRescheduleModal(); });
    ov.querySelectorAll('[data-rs-close]').forEach(b => b.addEventListener('click', closeRescheduleModal));

    const d0 = new Date(); const pad = n => String(n).padStart(2, '0');
    el('rsDate').min = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
    el('rsDate').focus();
    const showErr = m => { const e = el('rsErr'); e.textContent = m || ''; e.hidden = !m; };

    // Show where the booking is now, and prefill the pickers with it.
    try {
      const res = await apiFetch('/api/leads/' + encodeURIComponent(id) + '/appointment');
      const d = res ? await res.json() : null;
      if (!document.getElementById('rsOverlay')) return;
      if (d && d.success && d.appointment) {
        const a = d.appointment;
        el('rsCurrent').innerHTML = 'Now booked for <strong>' + esc(a.when || 'an unknown time') + '</strong>' + (a.timeZone ? ' <span class="rs-tz">(' + esc(a.timeZone) + ')</span>' : '');
        if (a.date) el('rsDate').value = a.date;
        if (a.time) el('rsTime').value = a.time;
        if (!a.hasAttendees) {
          el('rsNotify').checked = false; el('rsNotify').disabled = true;
          el('rsNotifyText').textContent = 'No email on file for this customer, so Google cannot notify them. You will get a message to send yourself.';
        }
      } else {
        el('rsCurrent').textContent = (d && d.message) || 'Could not read the current time from your calendar.';
      }
    } catch (_) { if (el('rsCurrent')) el('rsCurrent').textContent = 'Could not read the current time from your calendar.'; }

    el('rsSave').addEventListener('click', async () => {
      const date = el('rsDate').value, time = el('rsTime').value;
      showErr('');
      if (!date) { showErr('Choose a new date.'); return; }
      const btn = el('rsSave'); btn.disabled = true; btn.textContent = 'Moving…';
      try {
        const res = await apiFetch('/api/leads/' + encodeURIComponent(id) + '/reschedule', { method: 'POST', body: JSON.stringify({ date, time, notifyCustomer: el('rsNotify').checked }) });
        if (!res) return;
        const d = await res.json();
        if (!d.success) { showErr(d.message || 'Could not move the booking.'); btn.disabled = false; btn.textContent = 'Move booking'; return; }
        if (d.eventLink) updateLeadLocal(id, { calendarEventLink: d.eventLink });
        el('rsCurrent').innerHTML = 'Moved to <strong>' + esc(d.when || date) + '</strong>' + (d.previousWhen ? ' <span class="rs-tz">(was ' + esc(d.previousWhen) + ')</span>' : '');
        el('rsResult').hidden = false;
        el('rsResult').innerHTML = (d.notified ? '<p class="rs-ok">Google Calendar emailed the customer the new time.</p>' : '<p class="rs-note">The customer has not been told yet.</p>')
          + '<label class="lc-label" for="rsMsg">Message you can send them</label><textarea id="rsMsg" class="lc-input" rows="3" readonly>' + esc(d.message || '') + '</textarea>'
          + '<button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" id="rsCopy">Copy message</button>';
        el('rsCopy').addEventListener('click', () => navigator.clipboard.writeText(d.message || '').then(() => toast('Copied')));
        ['rsDate', 'rsTime', 'rsNotify'].forEach(x => { el(x).disabled = true; });
        btn.style.display = 'none'; el('rsCancel').textContent = 'Done';
        toast('Booking moved to ' + (d.when || date));
        if (activeLead && activeLead.id === id) { activeLead = leads.find(l => l.id === id) || activeLead; }
      } catch (err) {
        showErr(err.message || 'Could not move the booking.'); btn.disabled = false; btn.textContent = 'Move booking';
      }
    });
  }

  // ── Add to Calendar (manual trigger from slideover) ──────────
  async function addToCalendar(id) {
    const btn = el('lcBtnAddToCalendar');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
      const res = await apiFetch('/api/leads/calendar/event/' + id, { method: 'POST' });
      if (!res) return;
      const d = await res.json();
      if (d.success) {
        // Update the local lead record with the new event info
        updateLeadLocal(id, { calendarEventId: d.eventId, calendarEventLink: d.eventLink });
        activeLead = leads.find(l => l.id === id) || activeLead;
        openLead(id); // re-render the slideover to show the event badge
        toast('Calendar event created' + (d.summary ? ': ' + d.summary : ''));
      } else {
        toast(d.message || 'Failed to create calendar event', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="12"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.5 1.5v2M10.5 1.5v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 9v2.5M6.5 10.5H10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> Add to Calendar'; }
      }
    } catch (err) {
      toast(err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Add to Calendar'; }
    }
  }

  // ── Settings view ─────────────────────────────────────────────
  function renderSettingsView() {
    const setVal = (id, val) => { const e = el(id); if (e) e.value = val || ''; };
    setVal('settBusinessName', settings.businessName);
    setVal('settBusinessType', settings.businessType);
    setVal('settOwnerName',    settings.ownerName);
    setVal('settPhone',        settings.phone);
    setVal('settBookingUrl',   settings.bookingUrl);
    setVal('settWebsite',      settings.website);
    setVal('settAddress',      settings.address);
    setVal('settResponseTime', settings.responseTime);
    setVal('settDescription',  settings.description);
    setVal('settTargetCustomer', settings.targetCustomer);
    setVal('settSpecialInstructions', settings.specialInstructions);
    const cur = el('settCurrency'); if (cur) cur.value = settings.currency || 'USD';
    if (window.TimingUI) TimingUI.fill(settings);
    // Service timing fields
    setVal('settApptDuration', settings.defaultAppointmentDuration ?? 60);
    setVal('settBufferTime',   settings.bufferTime ?? 15);
    setVal('settNoticePeriod', settings.noticePeriod ?? 24);

    // Quote rules and policies (service-business quoting inputs)
    Object.keys(QUOTE_FIELDS).forEach(k => {
      const [id, kind] = QUOTE_FIELDS[k];
      const e = el(id); if (!e) return;
      if (kind === 'bool') e.checked = !!settings[k];
      else e.value = (settings[k] === undefined || settings[k] === null || (kind === 'num' && settings[k] === 0)) ? '' : settings[k];
    });
    const qm  = el('settQuoteMode');     if (qm)  qm.value  = settings.quoteMode || 'range';
    const pqe = el('settPhotoQuoteEnabled'); if (pqe) pqe.checked = settings.photoQuoteEnabled !== false;
    const pqu = el('settPhotoQuoteUnclear'); if (pqu) pqu.value = settings.photoQuoteUnclear || 'ask';

    const banner = el('settingsSetupBanner');
    const isComplete = !!(settings.businessName && settings.businessType && settings.ownerName &&
      settings.description && settings.targetCustomer && settings.services && settings.services.length > 0);
    if (banner) banner.style.display = isComplete ? 'none' : 'flex';
    renderServicesList();
  }

  function renderServicesList() {
    const list = el('settServicesList');
    if (!list) return;
    const svcs = settings.services || [];

    // Keep pill in sync — it only exists on the leads settings page (not dashboard)
    const pill = el('svcRequiredPill');
    if (pill) pill.style.display = svcs.length ? 'none' : 'inline-flex';

    if (!svcs.length) {
      list.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">No services defined yet — add at least one so the AI can calculate quotes.</div>';
      return;
    }
    const currency  = settings.currency || 'USD';
    const chip = (t, strong) => `<span style="font-size:10px;font-weight:${strong?700:600};background:${strong?'var(--bg4)':'transparent'};border:1px ${strong?'solid var(--border3)':'dashed var(--border2)'};border-radius:4px;padding:1px 7px;color:${strong?'var(--text)':'var(--text2)'}">${t}</span>`;
    const mono = (t, c) => `<span style="font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 7px;color:${c||'var(--text3)'}">${t}</span>`;
    const sur = (s, v) => s.surchargeType === 'flat' ? fmt(v) : (v + '%');
    list.innerHTML = svcs.map((s, i) => {
      const emergency = s.emergencySurcharge || s.emergency || 0;
      const priority  = s.prioritySurcharge  || s.priority  || 0;
      const addons = Array.isArray(s.addOns) ? s.addOns : [];
      const matLabel = ({included:'Materials included', at_cost:'Materials at cost', markup:'Materials +' + (s.materialsMarkupPercent||0) + '%', customer:'Customer supplies materials'})[s.materialsMode];
      const taxLabel = ({none:'No tax', added:'+' + (s.taxName||'Tax') + (s.taxRatePercent ? ' ' + s.taxRatePercent + '%' : ''), included:'Tax included'})[s.taxMode];
      return `
      <div class="lc-service-item">
        <div style="flex:1;min-width:0">
          <div class="lc-service-name">${esc(s.name)}${s.category ? ` <span style="font-size:11px;font-weight:500;color:var(--text3)">· ${esc(s.category)}</span>` : ''}</div>
          ${s.description ? `<div style="font-size:12px;color:var(--text2);margin-top:2px">${esc(s.description)}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center">
            ${mono(`${esc(currency)} ${fmt(s.basePrice)}${s.priceMax?' – '+fmt(s.priceMax):''}${({from:' (from)',hourly:' /hr',per_unit:' /unit',site_visit:' (after site visit)'})[s.pricingType]||''}`, 'var(--text2)')}
            ${s.minCharge ? mono('min ' + fmt(s.minCharge)) : ''}
            ${s.pricePerUnit ? mono(`+${fmt(s.pricePerUnit)}/${esc(s.unitLabel||'unit')}`) : ''}
            ${s.durationHours ? mono('~' + s.durationHours + 'h') : ''}
            ${s.depositPercent ? mono(s.depositPercent + '% deposit') : ''}
            ${s.callOutFee ? chip('Call-out ' + fmt(s.callOutFee) + (s.callOutWaivedIfBooked ? ' (waived if booked)' : '')) : ''}
            ${s.travelFee ? chip('Travel ' + fmt(s.travelFee)) : ''}
            ${emergency ? chip('Emergency +' + fmt(emergency), true) : ''}
            ${priority  ? chip('Priority +' + fmt(priority)) : ''}
            ${s.afterHoursSurcharge ? chip('After-hours +' + sur(s, s.afterHoursSurcharge)) : ''}
            ${s.weekendSurcharge ? chip('Weekend +' + sur(s, s.weekendSurcharge)) : ''}
            ${s.holidaySurcharge ? chip('Holiday +' + sur(s, s.holidaySurcharge)) : ''}
            ${matLabel ? chip(esc(matLabel)) : ''}
            ${taxLabel ? chip(esc(taxLabel)) : ''}
            ${addons.length ? chip(addons.length + ' add-on' + (addons.length > 1 ? 's' : '')) : ''}
          </div>
          ${addons.length ? `<div style="font-size:11px;color:var(--text3);margin-top:4px">Options: ${addons.map(a => esc(a.name) + ' (' + fmt(a.price) + ')').join(', ')}</div>` : ''}
          ${s.quoteNotes||s.notes ? `<div style="font-size:11px;color:var(--text3);margin-top:4px;font-style:italic">${esc(s.quoteNotes||s.notes)}</div>` : ''}
          ${s.exclusions ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">Not included: ${esc(s.exclusions)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" data-editsvc="${i}">Edit</button>
          <button class="lc-btn lc-btn-danger lc-btn-sm" data-delsvc="${i}">Remove</button>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-editsvc]').forEach(btn => btn.addEventListener('click', () => {
      if (window._editService) window._editService(parseInt(btn.dataset.editsvc));
    }));
    list.querySelectorAll('[data-delsvc]').forEach(btn => btn.addEventListener('click', () => {
      settings.services.splice(parseInt(btn.dataset.delsvc), 1);
      renderServicesList();
      apiFetch('/api/leads/settings', { method: 'PUT', body: JSON.stringify(settings) }).catch(() => {});
    }));
  }


  // ══════════════════════════════════════════════════════════════
  // CONSENT QUEUE
  // ══════════════════════════════════════════════════════════════
  // Review page: drafts waiting for approval (only shown when there are some) and chats that need a person.
  async function loadReview() { await Promise.all([loadConsentQueue(), loadHumanReview()]); }

  async function loadConsentQueue() {
    const body = el('consentQueueBody');
    if (!body) return;
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Loading…</div>';
    try {
      const res  = await apiFetch('/api/leads/consent-queue');
      if (!res) return;
      const data = res ? await res.json() : null;
      if (!data || !data.success) { body.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px">Failed to load consent queue.</div>'; return; }

      // Update badge
      const badge = el('navBadgeConsent');
      if (badge) {
        badge.textContent = data.count || '';
        badge.style.display = data.count ? 'inline-flex' : 'none';
      }
      const approveAll = el('btnApproveAll');
      if (approveAll) approveAll.style.display = data.count ? '' : 'none';
      const approvals = el('reviewApprovals'); if (approvals) approvals.hidden = !data.count;

      if (!data.leads || !data.leads.length) {
        body.innerHTML = `<div class="lc-empty" style="margin-top:40px">
          <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="16" stroke="currentColor" stroke-width="1.5"/>
            <path d="M16 24l6 6 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="lc-empty-title">Queue is empty</div>
          <div class="lc-empty-text">No replies are waiting for your approval.</div>
        </div>`;
        return;
      }

      body.innerHTML = data.leads.map(lead => `
        <div class="lc-consent-card" id="ccard-${esc(lead.id)}">
          <div class="lc-consent-card-head">
            <div style="min-width:0">
              <div class="lc-consent-from">${esc(lead.fromName || lead.fromEmail || 'Unknown sender')}</div>
              <div class="lc-consent-subject">${esc(lead.fromEmail || '')} ${lead.subject ? '· ' + esc(lead.subject.slice(0,60)) : ''}</div>
            </div>
            <div class="lc-consent-actions">
              <button class="lc-btn lc-btn-sm lc-btn-approve" data-approve="${esc(lead.id)}">
                <svg viewBox="0 0 14 14" fill="none" width="11" style="margin-right:4px"><path d="M2 7l4 4 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Send Reply
              </button>
              <button class="lc-btn lc-btn-sm lc-btn-dismiss" data-dismiss="${esc(lead.id)}">Dismiss</button>
            </div>
          </div>
          <div class="lc-consent-body">
            ${lead.rawBody ? `<div class="lc-consent-original">
              <div class="lc-consent-original-label">Customer's email</div>
              <div class="lc-consent-original-text">${esc((lead.rawBody||'').slice(0,400))}</div>
            </div>` : ''}
            ${lead.aiReply ? `<div class="lc-consent-draft">
              <div class="lc-consent-draft-label">AI draft reply</div>
              <div class="lc-consent-draft-subject">Subject: ${esc(lead.aiReply.subject)}</div>
              <div class="lc-consent-draft-text">${esc(lead.aiReply.body)}</div>
            </div>` : '<div style="color:var(--text3);font-size:12px;padding:8px 0">No AI reply generated yet.</div>'}
          </div>
        </div>
      `).join('');

      // Wire approve/dismiss buttons
      body.querySelectorAll('[data-approve]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.approve;
          btn.disabled = true; btn.textContent = 'Sending…';
          try {
            const r = await apiFetch(`/api/leads/consent-queue/${id}/approve`, { method: 'POST' });
            if (!r) return;
            const d = r ? await r.json() : null;
            if (d && d.success) {
              const card = el('ccard-' + id);
              if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; setTimeout(() => card.remove(), 400); }
              toast('Reply sent ✓');
              loadConsentQueue();
              if (d.lead) mergeLeadFromServer(d.lead);
              renderLeadsTable();
            } else {
              toast((d && d.message) || 'Failed to send', 'error');
              btn.disabled = false; btn.textContent = 'Send Reply';
            }
          } catch(err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Send Reply'; }
        });
      });

      body.querySelectorAll('[data-dismiss]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.dismiss;
          btn.disabled = true; btn.textContent = 'Dismissing…';
          try {
            await apiFetch(`/api/leads/consent-queue/${id}/reject`, { method: 'POST' });
            const card = el('ccard-' + id);
            if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; setTimeout(() => card.remove(), 300); }
            loadConsentQueue();
          } catch(err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Dismiss'; }
        });
      });

    } catch(err) { body.innerHTML = '<div style="padding:20px;color:var(--text);font-weight:600;font-size:13px">' + esc(err.message) + '</div>'; }
  }

  async function approveAll() {
    const body = el('consentQueueBody');
    if (!body) return;
    const ids = [...body.querySelectorAll('[data-approve]')].map(b => b.dataset.approve);
    if (!ids.length) return;
    const btn = el('btnApproveAll');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending all…'; }
    for (const id of ids) {
      try {
        const r = await apiFetch(`/api/leads/consent-queue/${id}/approve`, { method: 'POST' });
        if (!r) return;
        const d = r ? await r.json() : null;
        if (d && d.success && d.lead) mergeLeadFromServer(d.lead);
      } catch(_) {}
    }
    toast('All replies sent');
    loadConsentQueue();
    renderLeadsTable();
    if (btn) { btn.disabled = false; btn.textContent = 'Approve All'; }
  }

  // ══════════════════════════════════════════════════════════════
  // HUMAN REVIEW
  // ══════════════════════════════════════════════════════════════
  async function loadHumanReview() {
    const body = el('humanReviewBody');
    if (!body) return;
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Loading…</div>';
    try {
      const res  = await apiFetch('/api/leads/human-review');
      if (!res) return;
      const data = res ? await res.json() : null;
      if (!data || !data.success) { body.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px">Failed to load.</div>'; return; }

      const badge = el('navBadgeHuman');
      if (badge) {
        badge.textContent = data.count || '';
        badge.style.display = data.count ? 'inline-flex' : 'none';
      }

      if (!data.leads || !data.leads.length) {
        body.innerHTML = `<div class="lc-empty" style="margin-top:40px">
          <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="16" r="6" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10 40c0-7.73 6.27-14 14-14s14 6.27 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <div class="lc-empty-title">No escalations</div>
          <div class="lc-empty-text">All leads are within AI's handling capability.</div>
        </div>`;
        return;
      }

      body.innerHTML = data.leads.map(lead => {
        const draftSubject = lead.aiReply ? (typeof lead.aiReply === 'string' ? '' : (lead.aiReply.subject || '')) : '';
        const draftBody    = lead.aiReply ? (typeof lead.aiReply === 'string' ? lead.aiReply : (lead.aiReply.body || '')) : '';
        const subjectValue = draftSubject || (lead.subject ? 'Re: ' + lead.subject.replace(/^Re:\s*/i,'') : 'Re: Your enquiry');
        const isWA = String(lead.source || '').toLowerCase() === 'whatsapp' || !!lead.whatsappThreadPhone;
        const contactLine = isWA ? (lead.whatsappThreadPhone || lead.fromPhone || '') : (lead.fromEmail || '');
        return `
        <div class="lc-human-card" id="hcard-${esc(lead.id)}">
          <div class="lc-human-card-head">
            <div style="min-width:0;flex:1">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(lead.fromName || contactLine || 'Unknown')}</div>
              <div style="font-size:12px;color:var(--text3);margin-top:1px">${isWA ? 'WhatsApp · ' : ''}${esc(contactLine)} ${!isWA && lead.subject ? '· ' + esc(lead.subject.slice(0,55)) : ''}</div>
            </div>
            <div style="font-size:11px;color:var(--text3);white-space:nowrap">${new Date(lead.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="lc-human-compose">
            ${lead.rawBody ? `<div class="lc-consent-original" style="margin-bottom:14px">
              <div class="lc-consent-original-label">Customer's message</div>
              <div class="lc-consent-original-text" style="max-height:120px">${esc((lead.rawBody||'').slice(0,600))}</div>
            </div>` : ''}
            <div class="lc-human-compose-label">Your reply${draftBody ? ' <span style="font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0">— AI drafted this, review before sending</span>' : ''}</div>
            ${isWA ? '' : `<input class="lc-human-subject-input" id="hsubject-${esc(lead.id)}"
              placeholder="Subject line…"
              value="${esc(subjectValue)}" />`}
            <textarea class="lc-human-reply-textarea" id="hbody-${esc(lead.id)}"
              placeholder="Write your personal reply here…">${esc(draftBody)}</textarea>
            <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
              <button class="lc-btn lc-btn-sm lc-human-send-btn" data-hrsend="${esc(lead.id)}">
                <svg viewBox="0 0 16 16" fill="none" width="11" style="margin-right:4px"><path d="M2 8l12-6-6 12-2-4-4-2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
                Send My Reply
              </button>
              <span style="font-size:11px;color:var(--text3)">${isWA ? 'Sent from your connected WhatsApp number' : 'Sent from your connected email account'}</span>
            </div>
          </div>
        </div>
      `;
      }).join('');

      // Wire send buttons
      body.querySelectorAll('[data-hrsend]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id      = btn.dataset.hrsend;
          const subject = (el('hsubject-' + id) || {}).value || '';
          const replyBody = (el('hbody-' + id) || {}).value || '';
          if (!replyBody.trim()) { toast('Please write a reply before sending', 'error'); return; }
          btn.disabled = true; btn.textContent = 'Sending…';
          try {
            const r = await apiFetch(`/api/leads/human-review/${id}/send`, {
              method: 'POST',
              body:   JSON.stringify({ subject: subject || 'Re: Your enquiry', body: replyBody }),   // subject is ignored for WhatsApp leads
            });
            const d = r ? await r.json() : null;
            if (d && d.success) {
              toast('Your reply has been sent ✓');
              const card = el('hcard-' + id);
              if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; setTimeout(() => card.remove(), 400); }
              loadHumanReview();
              if (d.lead) mergeLeadFromServer(d.lead);
              renderLeadsTable();
            } else {
              toast((d && d.message) || 'Failed to send', 'error');
              btn.disabled = false; btn.textContent = 'Send My Reply';
            }
          } catch(err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Send My Reply'; }
        });
      });

    } catch(err) { body.innerHTML = '<div style="padding:20px;color:var(--text);font-weight:600;font-size:13px">' + esc(err.message) + '</div>'; }
  }

  // Refresh badge counts from server (called on init)
  async function refreshBadgeCounts() {
    try {
      const [cr, hr] = await Promise.all([
        fastGet('/api/leads/consent-queue'),
        fastGet('/api/leads/human-review'),
      ]);
      if (cr) {
        const d = await cr.json();
        const badge = el('navBadgeConsent');
        if (badge && d.count !== undefined) {
          badge.textContent = d.count || '';
          badge.style.display = d.count ? 'inline-flex' : 'none';
        }
      }
      if (hr) {
        const d = await hr.json();
        const badge = el('navBadgeHuman');
        if (badge && d.count !== undefined) {
          badge.textContent = d.count || '';
          badge.style.display = d.count ? 'inline-flex' : 'none';
        }
      }
      syncBottomNavBadges();
    } catch(_) {}
  }


  // ══════════════════════════════════════════════════════════════
  // MOBILE — sidebar drawer, bottom nav, touch helpers
  // ══════════════════════════════════════════════════════════════
  function initMobile() {
    const hamburger = el('lcHamburger');
    const sidebar   = el('lcSidebar');
    const overlay   = el('lcSidebarOverlay');
    if (!hamburger || !sidebar || !overlay) return;

    function openSidebar() {
      sidebar.classList.add('open');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    hamburger.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Close sidebar when a nav item is tapped on mobile
    sidebar.querySelectorAll('.lc-nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 600) closeSidebar();
      });
    });

    // Swipe left to close sidebar
    let touchStartX = 0;
    sidebar.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    sidebar.addEventListener('touchend', e => {
      if (touchStartX - e.changedTouches[0].clientX > 60) closeSidebar();
    }, { passive: true });

    // Bottom nav wiring
    const bottomNav = el('lcBottomNav');
    if (bottomNav) {
      bottomNav.querySelectorAll('.lc-bottom-nav-item[data-view]').forEach(item => {
        item.addEventListener('click', () => {
          showView(item.dataset.view);
          // Update active state on bottom nav
          bottomNav.querySelectorAll('.lc-bottom-nav-item').forEach(b => b.classList.remove('active'));
          item.classList.add('active');
        });
      });
    }

    // Keep bottom nav in sync when sidebar nav is used
    const origShowView = showView;
  }

  // Sync bottom nav active state whenever showView is called
  function syncBottomNav(id) {
    const bottomNav = el('lcBottomNav');
    if (!bottomNav) return;
    bottomNav.querySelectorAll('.lc-bottom-nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === id);
    });
  }

  // Sync bottom nav badge counts
  function syncBottomNavBadges() {}   // the Review badge is kept in step by nav-groups.js

  // ── Expose navigation to inline onclick handlers ──────────────
  // dashboard.html uses onclick="showView(...)" and onclick="window.switchView(...)"
  // These need to be on window since they're in inline HTML attributes outside the closure
  window.showView    = function(id) { showView(id); };
  window.switchView  = function(id) { showView(id); };
  // The Agent calls this after it changes data so the surfaces behind it stay current
  window.refreshFromServer = function() { return syncFromServer().then(() => { try { renderLeadsTable(); updateStats(); } catch(_){} refreshBadgeCounts(); }); };
  window.openLeadById = async function(id) {
    try {
      const r = await fetch('/api/leads/' + id, { credentials: 'include' });
      const d = await r.json();
      if (d && d.lead) {
        // Keep the local cache in sync so subsequent table renders / status
        // changes for this lead reflect the freshly-fetched data.
        const idx = leads.findIndex(l => l.id === d.lead.id);
        if (idx !== -1) leads[idx] = d.lead; else leads.push(d.lead);
        openLead(d.lead.id);
      }
    } catch (err) { console.error('openLeadById failed:', err); }
  };
  window.lcToast = function(msg, type) { toast(msg, type); };

  // ── Navigation ────────────────────────────────────────────────
  const VIEW_TITLES = {
    leads:'Leads',new:'New',pending:'Follow-Ups',closed:'Closed',performance:'Performance',inbox:'Inbox',
    ingest:'Add Lead',email:'Email Connection',whatsapp:'WhatsApp',calendar:'Google Calendar',settings:'Business Settings',payment:'Upgrade',
    humanreview:'Review',integrations:'Integrations',workflows:'Workflows',
    knowledge:'Company Knowledge',account:'Account',support:'Support','getting-started':'Getting Started',
  };

  // ── Getting Started ───────────────────────────────────────────
  let _gsSetupStatus = null;

  async function _gsCheckSetupStatus() {
    try {
      const res = await apiFetch('/api/users/setup-status');
      if (!res.ok) return;
      const data = await res.json();
      _gsSetupStatus = data || null;
    } catch(e) {}
    _gsUpdateBadge();
  }

  function _gsSteps() {
    const s = _gsSetupStatus || {};
    return [
      { done: !!s.setup_complete,    label: 'Business profile' },
      { done: !!s.channel_connected, label: 'Connect email or WhatsApp' },
      { done: !!s.has_seen_ai_reply, label: 'See your first AI reply' },
    ];
  }

  function _gsUpdateBadge() {
    const badge = el('navBadgeGettingStarted');
    if (!badge) return;
    const remaining = _gsSteps().filter(s => !s.done).length;
    badge.textContent = String(remaining);
    badge.style.display = remaining > 0 ? '' : 'none';
  }

  async function loadGettingStarted() {
    const root = el('gettingStartedContent');
    if (!root) return;
    root.innerHTML = '<div style="text-align:center;padding:60px 0"><div class="lc-spinner" style="margin:0 auto"></div></div>';
    await _gsCheckSetupStatus();
    _gsRender();
  }

  function _gsRender() {
    const root = el('gettingStartedContent');
    if (!root) return;
    const steps = _gsSteps();
    const allDone = steps.every(function(s) { return s.done; });

    function stepRow(step, idx, action) {
      var circle = step.done
        ? '<div style="width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid #ffffff;background:#ffffff;color:#000;font-size:13px;font-weight:600">&#10003;</div>'
        : '<div style="width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--border2);background:transparent;color:var(--text2);font-size:13px;font-weight:600">' + (idx + 1) + '</div>';
      return '<div style="display:flex;align-items:center;gap:14px;padding:16px 18px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;' + (step.done ? 'opacity:0.55' : '') + '">'
        + circle
        + '<div style="flex:1"><div style="font-size:15px;font-weight:600;color:var(--text)">' + step.label + '</div></div>'
        + (!step.done ? action : '')
        + '</div>';
    }

    var btnProfile = '<button class="lc-btn lc-btn-primary lc-btn-sm" onclick="window.showView(\'settings\')">Set up profile \u2192</button>';
    var btnConnect = '<button class="lc-btn lc-btn-primary lc-btn-sm" onclick="window.showView(\'email\')">Connect \u2192</button>';
    var testDisabled = !steps[0].done ? ' disabled title="Finish your business profile first"' : '';
    var btnTest = '<button class="lc-btn lc-btn-primary lc-btn-sm" id="btnSendTestLead"' + testDisabled + '>Send a test lead \u2192</button>';

    var allDoneHtml = allDone ? (
      '<div style="margin-top:20px;padding:16px 18px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2)">'
      + '<div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">You\'re all set \uD83C\uDF89</div>'
      + '<div style="font-size:13px;color:var(--text2)">New leads will get an AI-drafted reply automatically. Head to <a href="#" onclick="window.showView(\'leads\');return false;" style="color:var(--text);text-decoration:underline">All Leads</a> to see them come in.</div>'
      + '</div>'
    ) : '';

    root.innerHTML =
      '<div style="margin-bottom:24px">'
      + '<h2 style="font-size:20px;font-weight:600;margin-bottom:6px;color:var(--text)">Getting started</h2>'
      + '<p style="font-size:14px;color:var(--text2);line-height:1.6">Three steps to see Humarains actually reply to a lead with your own business details.</p>'
      + '</div>'
      + stepRow(steps[0], 0, btnProfile)
      + stepRow(steps[1], 1, btnConnect)
      + stepRow(steps[2], 2, btnTest)
      + allDoneHtml
      + '<div id="testLeadResult" style="margin-top:16px"></div>';

    var btn = el('btnSendTestLead');
    if (btn) btn.addEventListener('click', _gsSendTestLead);
  }

  async function _gsSendTestLead() {
    var btn = el('btnSendTestLead');
    var resultEl = el('testLeadResult');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating reply\u2026'; }
    if (resultEl) resultEl.innerHTML = '<div style="font-size:13px;color:var(--text2);padding:10px 0">AI is drafting a reply using your business profile\u2026</div>';
    try {
      const res = await apiFetch('/api/leads/test-lead', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error((data && data.message) || 'Could not generate a test reply.');
      const lead = data.lead;
      if (resultEl) resultEl.innerHTML = '<div style="font-size:13px;color:var(--text);padding:10px 0">Your AI reply is ready. <a href="#" onclick="window.showView(\'leads\');window.openLeadById&&window.openLeadById(\'' + lead.id + '\');return false;" style="color:var(--text);text-decoration:underline;font-weight:600">View it \u2192</a></div>';
      await _gsCheckSetupStatus();
      _gsRender();
    } catch(e) {
      if (resultEl) resultEl.innerHTML = '<div style="font-size:13px;color:var(--text);padding:10px 0">' + ((e && e.message) || 'Something went wrong.') + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = 'Send a test lead \u2192'; }
    }
  }

  window.loadGettingStarted = loadGettingStarted;

  function showView(id, opts) {
    if (id === 'consent') id = 'humanreview';                          // approvals now live on the Review page
    if (id === 'outcomes' || id === 'intelligence') id = 'performance'; // those pages no longer exist
    // If admin has disabled WhatsApp globally, redirect to getting-started
    if (id === 'whatsapp') {
      const feats = (currentUser && currentUser.features) || {};
      if (feats.whatsappFeatureEnabled === false) { id = el('view-getting-started') ? 'getting-started' : 'leads'; }
    }
    document.querySelectorAll('.lc-view').forEach(v=>v.classList.remove('active'));
    document.querySelectorAll('.lc-nav-item').forEach(n=>n.classList.remove('active'));
    const view = el('view-'+id); if (view) view.classList.add('active');
    const nav  = document.querySelector('.lc-nav-item[data-view="'+id+'"]') ||
      Array.from(document.querySelectorAll('.lc-nav-item[data-also]')).find(n => (' ' + n.dataset.also + ' ').includes(' ' + id + ' '));
    if (nav) nav.classList.add('active');
    if (window.NavGroups) window.NavGroups.sync(id);
    if (el('lcPageTitle')) el('lcPageTitle').textContent = VIEW_TITLES[id]||id;
    // Poll + Add Lead buttons: only shown on lead-list views
    const topbarActions = el('lcTopbarActions');
    if (topbarActions) topbarActions.style.display = ['leads','new','pending','closed'].includes(id) ? 'flex' : 'none';
    // Close mobile sidebar drawer on any navigation
    const sidebar = el('lcSidebar');
    const overlay = el('lcSidebarOverlay');
    if (sidebar && window.innerWidth <= 600) {
      sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      document.body.style.overflow = '';
    }
    // Sync bottom nav active state
    syncBottomNav(id);
    if (id==='new')         renderSubLeads('new');
    if (id==='pending')     renderSubLeads('pending_followup');
    if (id==='closed')      renderSubLeads('closed');
    if (id==='leads')       renderLeadsTable();
    if (id==='email')       renderEmailView();
    if (id==='whatsapp')    renderWhatsAppView();
    if (id==='settings')      { renderSettingsView(); }
    if (id==='integrations' || id==='calendar') { loadCalendarStatus(); }
    if (id==='humanreview') loadReview();
    if (id==='inbox' && window.Inbox) window.Inbox.open();
    if (id==='workflows' && window.WorkflowsUI) window.WorkflowsUI.render();
    if (id==='knowledge' && window.KnowledgeUI) window.KnowledgeUI.render();
    if (id==='getting-started' && window.loadGettingStarted) window.loadGettingStarted();
    if (id==='performance' && window.PerformanceUI) window.PerformanceUI.render();
    // Tell the Agent shell which surface just opened (silent = initial boot render)
    if (!(opts && opts.silent)) document.dispatchEvent(new CustomEvent('lc:view', { detail: { id } }));
  }

  // ── WhatsApp view ─────────────────────────────────────────────
  async function renderWhatsAppView() {
    const webhookUrl = window.location.origin + '/api/leads/whatsapp/webhook';
    const urlEl = el('waWebhookUrl');
    if (urlEl) urlEl.textContent = webhookUrl;
    const urlInlineEl = el('waWebhookUrlInline');
    if (urlInlineEl) urlInlineEl.textContent = webhookUrl;

    await loadWAStatus();

    // ── Connect button — launches WhatsApp Embedded Signup ───────
    const connectBtn = el('btnWAConnect');
    if (connectBtn && !connectBtn._init) {
      connectBtn._init = true;
      connectBtn.addEventListener('click', () => startWAEmbeddedSignup(connectBtn));
    }

    // ── Disconnect button ───────────────────────────────────────
    const disconnectBtn = el('btnDisconnectWA');
    if (disconnectBtn && !disconnectBtn._init) {
      disconnectBtn._init = true;
      disconnectBtn.addEventListener('click', async () => {
        if (!confirm('Disconnect WhatsApp? Humarains will stop receiving WhatsApp messages.')) return;
        disconnectBtn.disabled = true;
        try {
          const res = await apiFetch('/api/leads/whatsapp/disconnect', { method: 'DELETE' });
          if (!res) throw new Error('No response');
          const d = await res.json();
          if (d.success) { toast('WhatsApp disconnected'); await loadWAStatus(); }
          else toast(d.message || 'Failed', 'error');
        } catch(err) { toast(err.message, 'error'); }
        disconnectBtn.disabled = false;
      });
    }

    // ── Test button ─────────────────────────────────────────────
    const testBtn = el('btnWATest');
    if (testBtn && !testBtn._init) {
      testBtn._init = true;
      testBtn.addEventListener('click', async () => {
        const phone = (el('waTestPhone')?.value || '').trim();
        if (!phone) { toast('Enter a phone number', 'error'); return; }
        testBtn.disabled = true;
        const orig = testBtn.innerHTML;
        testBtn.textContent = 'Sending…';
        try {
          const res = await apiFetch('/api/leads/whatsapp/test', {
            method: 'POST',
            body: JSON.stringify({ to: phone }),
          });
          if (!res) throw new Error('No response');
          const d = await res.json();
          if (d.success) toast('✓ ' + (d.message || ('Test message sent to ' + phone)));
          else toast(d.message || 'Failed', 'error');
        } catch(err) { toast(err.message, 'error'); }
        testBtn.disabled = false;
        testBtn.innerHTML = orig;
      });
    }
  }

  function showWAError(msg) {
    const errEl = el('waConnectError');
    if (!errEl) return;
    const span = errEl.querySelector('span');
    if (span) span.textContent = msg; else errEl.textContent = msg;
    errEl.style.display = 'flex';
  }

  // ── WhatsApp Embedded Signup ───────────────────────────────────
  // Loads the Facebook JS SDK on demand, opens the Embedded Signup
  // popup via FB.login(), listens for the postMessage the popup sends
  // back with the phone_number_id/waba_id, then completes setup
  // server-side by posting the auth code to our backend.
  let _fbSdkPromise = null;
  let _waEsConfig = null;

  function loadFacebookSdk(appId) {
    if (window.FB) return Promise.resolve(window.FB);
    if (_fbSdkPromise) return _fbSdkPromise;

    _fbSdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = function () {
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
        resolve(window.FB);
      };
      const s = document.createElement('script');
      s.src = 'https://connect.facebook.net/en_US/sdk.js';
      s.async = true;
      s.defer = true;
      s.crossOrigin = 'anonymous';
      s.onerror = () => reject(new Error('Could not load the Facebook SDK. Check your network/ad-blocker and try again.'));
      document.body.appendChild(s);
    });
    return _fbSdkPromise;
  }

  async function getWAEmbeddedSignupConfig() {
    if (_waEsConfig) return _waEsConfig;
    const res = await apiFetch('/api/leads/whatsapp/embedded-signup/config');
    if (!res) throw new Error('No response from server.');
    const d = await res.json();
    if (!d.success || !d.configured) {
      throw new Error('WhatsApp Embedded Signup is not configured yet. Contact support.');
    }
    _waEsConfig = d;
    return d;
  }

  async function startWAEmbeddedSignup(connectBtn, extra) {
    extra = extra || {};
    const isLocationConnect = !!extra.locationId;
    const errEl = isLocationConnect ? null : el('waConnectError');
    const spinner = isLocationConnect ? null : el('waConnectSpinner');
    if (errEl) errEl.style.display = 'none';

    const showErr = (msg) => {
      if (errEl) showWAError(msg); else toast(msg, 'error');
    };

    const origBtnText = connectBtn.textContent;
    connectBtn.disabled = true;
    if (isLocationConnect) connectBtn.textContent = 'Connecting…';
    if (spinner) spinner.style.display = '';

    // Captures { phone_number_id, waba_id } once the popup finishes.
    let sessionInfo = null;

    function onMessage(event) {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
        sessionInfo = { phoneNumberId: data.data?.phone_number_id, wabaId: data.data?.waba_id };
      } else if (data.event === 'CANCEL') {
        sessionInfo = sessionInfo || { cancelled: true };
      } else if (data.event === 'ERROR') {
        sessionInfo = { error: data.data?.error_message || 'Embedded Signup reported an error.' };
      }
    }

    window.addEventListener('message', onMessage);

    try {
      const cfg = await getWAEmbeddedSignupConfig();
      const FB = await loadFacebookSdk(cfg.appId);

      const fbResponse = await new Promise((resolve) => {
        FB.login(resolve, {
          config_id: cfg.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
        });
      });

      // With response_type=code, Meta may not set status to 'connected' — the code is what matters.
      if (!fbResponse?.authResponse?.code) {
        throw new Error('WhatsApp connection was cancelled or did not complete.');
      }

      // The FINISH postMessage can arrive slightly before or after the
      // FB.login() promise resolves — give it a brief window either way.
      const waitForSessionInfo = async () => {
        for (let i = 0; i < 50; i++) { // up to ~5s
          if (sessionInfo) return sessionInfo;
          await new Promise(r => setTimeout(r, 100));
        }
        return sessionInfo;
      };
      const info = await waitForSessionInfo();

      if (!info || info.cancelled) throw new Error('WhatsApp connection was cancelled.');
      if (info.error) throw new Error(info.error);
      if (!info.phoneNumberId || !info.wabaId) {
        throw new Error('Did not receive a phone number from Meta. Please try again.');
      }

      const res = await apiFetch('/api/leads/whatsapp/embedded-signup', {
        method: 'POST',
        body: JSON.stringify({
          code: fbResponse.authResponse.code,
          phoneNumberId: info.phoneNumberId,
          wabaId: info.wabaId,
        }),
      });
      if (!res) throw new Error('No response from server.');
      const d = await res.json();
      if (d.success) {
        toast('✓ WhatsApp connected — ' + (d.displayPhone || d.phoneNumberId));
        if (isLocationConnect) { extra.onSuccess && extra.onSuccess(d); }
        else { await loadWAStatus(); }
      } else {
        showErr(d.message || 'Connection failed.');
      }
    } catch (err) {
      showErr(err.message);
    } finally {
      window.removeEventListener('message', onMessage);
      connectBtn.disabled = false;
      if (isLocationConnect) connectBtn.textContent = origBtnText;
      if (spinner) spinner.style.display = 'none';
    }
  }
  window.startWAEmbeddedSignup = startWAEmbeddedSignup;

  // ── WhatsApp leads thread list ────────────────────────────────
  let waFilter = 'all';

  function renderWALeads() {
    const section = el('waLeadsSection');
    const list    = el('waLeadsList');
    if (!section || !list) return;

    const waLeads = leads.filter(l => l.source === 'whatsapp' || !!(l.whatsappThreadPhone));

    // Update sidebar badge
    const badge = el('navBadgeWhatsapp');
    if (badge) {
      const active = waLeads.filter(l => l.status !== 'closed').length;
      badge.textContent = active;
      badge.style.display = active > 0 ? '' : 'none';
    }

    if (waLeads.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const filtered = waFilter === 'all' ? waLeads : waLeads.filter(l => l.status === waFilter);

    const STAGE_SHORT = {
      initial_inquiry:      'Inquiry',
      qualification:        'Qualifying',
      quote_provided:       'Quoted',
      negotiation:          'Negotiating',
      scheduling:           'Scheduling',
      deal_closed:          'Closed ✓',
      objection_handling:   'Objection',
      follow_up:            'Follow-up',
    };

    const statusColour = {
      new:              'var(--bg4)',
      pending_followup: 'var(--bg3)',
      closed:           'transparent',
      replied:          'var(--bg3)',
    };
    const statusTextColour = {
      new:              'var(--text)',
      pending_followup: 'var(--text2)',
      closed:           'var(--text3)',
      replied:          'var(--text2)',
    };

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text3);font-size:13px">No ${waFilter === 'all' ? '' : waFilter.replace('_',' ')+' '}conversations</div>`;
      return;
    }

    list.innerHTML = filtered.map(lead => {
      const history      = lead.conversationHistory || [];
      const lastTurn     = history[history.length - 1];
      const lastMsg      = lastTurn ? (lastTurn.body || '').replace(/\n/g,' ').slice(0, 90) : (lead.body || '').slice(0, 90);
      const lastIsCustomer = lastTurn && lastTurn.role === 'customer';
      const turnCount    = history.length;
      const stage        = STAGE_SHORT[lead.conversationStage] || 'Inquiry';
      const phone        = lead.whatsappThreadPhone || lead.fromPhone || '—';
      const name         = lead.fromName || lead.customerName || phone;
      const when         = lastTurn?.sentAt
        ? new Date(lastTurn.sentAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
        : (lead.receivedAt ? new Date(lead.receivedAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '');
      const statBg   = statusColour[lead.status]     || 'var(--bg3)';
      const statText = statusTextColour[lead.status] || 'var(--text3)';
      const unread   = lastIsCustomer && lead.status !== 'closed';

      return `<div class="lc-wa-thread" data-id="${esc(lead.id)}" style="
          display:flex;align-items:flex-start;gap:14px;
          padding:14px 16px;border-radius:10px;margin-bottom:8px;
          background:${unread ? 'var(--bg4)' : 'var(--bg3)'};
          border:1px solid ${unread ? 'var(--border3)' : 'var(--border)'};
          cursor:pointer;transition:all .15s;
        "
        onmouseenter="this.style.borderColor='var(--text2)'"
        onmouseleave="this.style.borderColor='${unread ? 'var(--border3)' : 'var(--border)'}'"
      >
        <!-- Avatar -->
        <div style="
          width:40px;height:40px;border-radius:50%;flex-shrink:0;
          background:${unread ? '#ffffff' : 'var(--bg4)'};border:1.5px solid var(--border2);
          display:flex;align-items:center;justify-content:center;
          font-size:15px;font-weight:700;color:${unread ? '#000000' : 'var(--text2)'};
          position:relative;
        ">
          ${esc((name[0]||'?').toUpperCase())}
          ${unread ? `<span style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;background:#ffffff;border:2px solid var(--bg2)"></span>` : ''}
        </div>

        <!-- Body -->
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="font-size:14px;font-weight:${unread ? 700 : 600};color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">${esc(name)}</span>
            <span style="font-size:10px;font-family:var(--mono);color:var(--text3);flex-shrink:0">${esc(phone)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text3);flex-shrink:0;white-space:nowrap">${esc(when)}</span>
          </div>
          <div style="font-size:13px;color:${unread ? 'var(--text2)' : 'var(--text3)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px">
            ${lastTurn ? `<span style="color:var(--text3);font-size:11px">${lastIsCustomer ? '← ' : '→ '}</span>` : ''}${esc(lastMsg || 'No messages yet')}${lastMsg && lastMsg.length >= 90 ? '…' : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:${statBg};color:${statText};border:1px solid var(--border2)">${esc(statusLabel(lead.status))}</span>
            <span style="font-size:10px;padding:2px 8px;border-radius:20px;background:transparent;color:var(--text3);border:1px dashed var(--border2)">${esc(stage)}</span>
            ${turnCount > 0 ? `<span style="font-size:10px;color:var(--text3)">${turnCount} message${turnCount !== 1 ? 's' : ''}</span>` : ''}
            ${lead.quote ? `<span style="font-size:10px;font-weight:700;color:var(--text);margin-left:auto">${esc(lead.quote.currency||'')} ${fmt(lead.quote.total)}</span>` : ''}
          </div>
        </div>

        <!-- Arrow -->
        <div style="color:var(--text3);flex-shrink:0;align-self:center">
          <svg viewBox="0 0 16 16" fill="none" width="14"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>`;
    }).join('');

    // Click handlers — open lead in slideover
    list.querySelectorAll('.lc-wa-thread').forEach(row => {
      row.addEventListener('click', () => {
        const lead = leads.find(l => l.id === row.dataset.id);
        if (lead) openLead(lead.id);
      });
    });
  }

  // Wire up filter buttons in WhatsApp view
  document.addEventListener('click', e => {
    const btn = e.target.closest('.wa-filter-btn');
    if (!btn) return;
    document.querySelectorAll('.wa-filter-btn').forEach(b => {
      b.style.background = 'none';
      b.style.color = 'var(--text2)';
      b.classList.remove('active');
    });
    btn.style.background = '#ffffff';
    btn.style.color = '#000000';
    btn.classList.add('active');
    waFilter = btn.dataset.waf;
    renderWALeads();
  });

  async function loadWAStatus() {
    const connCard  = el('waConnectedCard');
    const connForm  = el('waConnectCard');
    const testSec   = el('waTestSection');
    const metaEl    = el('waConnectedMeta');

    try {
      const res = await apiFetch('/api/leads/whatsapp/status');
      if (!res) return;
      const d = await res.json();

      if (d.connected) {
        if (connCard) connCard.style.display = 'flex';
        if (connForm) connForm.style.display = 'none';
        if (testSec)  testSec.style.display  = '';
        const rulesOn = el('waRulesSection'); if (rulesOn) rulesOn.style.display = '';
        if (metaEl) {
          const parts = [];
          if (d.displayPhone) parts.push(d.displayPhone);
          if (d.verifiedName) parts.push(d.verifiedName);
          if (d.source === 'server') parts.push('(server env vars)');
          let txt = parts.join(' · ') || ('ID: ' + d.phoneNumberId);
          if (d.health && d.health.problem) txt += ' — Warning: ' + d.health.problem;
          metaEl.textContent = txt;
        }
        // Number connected but not active on Meta's side → try to activate it once per page load.
        if (d.health && d.health.needsRegister && !window._waReregTried) {
          window._waReregTried = true;
          try {
            const rr = await apiFetch('/api/leads/whatsapp/reregister', { method: 'POST', body: '{}' });
            const rd = rr && await rr.json();
            if (rd) {
              toast(rd.success ? '✓ WhatsApp number activated' : (rd.message || 'Could not activate the WhatsApp number'), rd.success ? undefined : 'error');
              if (rd.success) return loadWAStatus();
            }
          } catch (_) {}
        }
      } else {
        if (connCard) connCard.style.display = 'none';
        if (connForm) connForm.style.display = '';
        if (testSec)  testSec.style.display  = 'none';
        const rulesOff = el('waRulesSection'); if (rulesOff) rulesOff.style.display = 'none';
      }

      // Always render the thread list (even while disconnected, existing leads still show)
      renderWALeads();
    } catch(err) {
      console.warn('[WhatsApp] loadWAStatus error:', err.message);
    }
  }


  // ── Server sync ───────────────────────────────────────────────
  async function syncFromServer() {
    try {
      const [leadsRes,settRes] = await Promise.all([fastGet('/api/leads'),fastGet('/api/leads/settings')]);
      if (leadsRes&&leadsRes.ok) {
        const d = await leadsRes.json();
        if (d.success&&d.leads) leads = d.leads;
      }
      if (settRes&&settRes.ok) {
        const d = await settRes.json();
        if (d.success&&d.settings) {
          // Merge server settings over local defaults (server is source of truth)
          settings = Object.assign(settings, d.settings);
          saveSettings();
          // Capture send quota from server
          if (d.sendQuota) _sendQuota = d.sendQuota;
          // If the settings view is open, re-render it now that we have authoritative data
          const settView = el('view-settings');
          if (settView && settView.classList.contains('active')) renderSettingsView();
          // Update setup indicator
          const isComplete = !!(settings.businessName && settings.ownerName &&
            settings.description && settings.targetCustomer && settings.services && settings.services.length > 0);
          const ind = el('setupIndicator');
          if (ind) ind.style.display = isComplete ? 'none' : 'flex';
        }
      }
    } catch(_) {}
    // Pre-fetch email config so Email tab shows instantly when opened
    fastGet('/api/leads/email-settings').then(async r => {
      if (!r) return;
      const d = await r.json();
      _cachedEmailConfig = d.connected ? d.config : null;
    }).catch(() => {});
    renderLeadsTable(); updateStats(); renderWALeads();
    document.body.classList.remove('lc-booting');   // first data is in: show the real numbers and list
  }

  // ── URL param handling ────────────────────────────────────────
  function checkUrlParams() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('upgraded')==='1') toast('Plan upgraded successfully');

    // Google Calendar OAuth callback params
    if (p.get('cal_connected')==='1') {
      const calEmail = p.get('cal_email') || '';
      setTimeout(() => {
        showView('integrations');
        showCalendarStatus(true, calEmail);
        toast('Google Calendar connected: ' + calEmail);
        loadCalendarEvents();
      }, 100);
    }
    if (p.get('cal_error')) toast('Google Calendar connection failed: ' + p.get('cal_error'), 'error', 6000);

    // Deep link to a specific lead, e.g. /leads.html?lead=<id>
    const leadId = p.get('lead');
    if (leadId) {
      showView('leads');
      setTimeout(() => { window.openLeadById && window.openLeadById(leadId); }, 100);
    }

    if (p.has('upgraded')||p.has('cal_connected')||p.has('cal_error')||p.has('lead'))
      window.history.replaceState({},'',window.location.pathname);
  }

  // ── Event wiring ──────────────────────────────────────────────
  function wireEvents() {
    // Nav
    document.querySelectorAll('.lc-nav-item[data-view]').forEach(item=>item.addEventListener('click',()=>showView(item.dataset.view)));

    // Slideover
    el('lcSlideoverClose').addEventListener('click',closeSlideover);
    el('lcOverlay').addEventListener('click',closeSlideover);
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSlideover();});

    // Topbar
    // Auto-poll every 10 seconds — no manual button needed.
    // Only fires when email is connected (pollEmail checks for needsEmail internally).
    // Uses a flag to prevent overlapping calls if a poll takes longer than 10s.
    let _pollInFlight = false;
    async function autoPoll() {
      if (_pollInFlight) return;
      // Only poll if email is connected
      if (!_cachedEmailConfig) return;
      _pollInFlight = true;
      try { await pollEmail(true); } catch(_) {} // silent=true suppresses progress bar and no-leads toast
      _pollInFlight = false;
    }
    setInterval(autoPoll, 10_000);
    el('btnNewLead').addEventListener('click',()=>showView('ingest'));

    // Logout
    el('lcLogoutBtn').addEventListener('click',async()=>{
      try{await apiFetch('/api/auth/logout',{method:'POST'});}catch(_){}
      window.location.href='/login.html';
    });

    // Footer buttons
    if(el('lcBtnProcessLead')) el('lcBtnProcessLead').addEventListener('click',()=>{if(activeLead)processLead(activeLead.id);});
    if(el('lcBtnSendReply'))   el('lcBtnSendReply').addEventListener('click',  ()=>{if(activeLead)sendReply(activeLead.id);});
    if(el('lcBtnFollowUp'))    el('lcBtnFollowUp').addEventListener('click',   ()=>{if(activeLead)sendFollowUp(activeLead.id);});
    if(el('lcBtnCloseLead'))   el('lcBtnCloseLead').addEventListener('click',  ()=>{if(activeLead)setStatus(activeLead.id,'closed');});
    if(el('lcBtnAddToCalendar')) el('lcBtnAddToCalendar').addEventListener('click', ()=>{if(activeLead)addToCalendar(activeLead.id);});

    // Filters
    document.querySelectorAll('.lc-filter-btn').forEach(btn=>btn.addEventListener('click',()=>{
      document.querySelectorAll('.lc-filter-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); activeFilter=btn.dataset.filter; renderLeadsTable();
    }));

    // Ingest
    el('btnIngestOnly').addEventListener('click',()=>ingestLead(false));
    el('btnIngestAndProcess').addEventListener('click',()=>ingestLead(true));

    // Connect a different email account (from connected state — dashboard.html only)
    const btnEmail2 = el('btnSaveEmail2');
    if (btnEmail2) btnEmail2.addEventListener('click',async()=>{
      const user     = el('emailUser2')&&el('emailUser2').value.trim();
      const pass     = el('emailPass2')&&el('emailPass2').value;
      const imapHost = el('emailImapHost2')&&el('emailImapHost2').value.trim();
      const imapPort = (el('emailImapPort2')&&el('emailImapPort2').value.trim())||'993';
      const smtpHost = el('emailSmtpHost2')&&el('emailSmtpHost2').value.trim();
      const smtpPort = (el('emailSmtpPort2')&&el('emailSmtpPort2').value.trim())||'587';
      const fromName = (el('emailFromName2')&&el('emailFromName2').value.trim())||'';
      if (!user||!pass||!imapHost||!smtpHost){toast('Email, password, IMAP host, and SMTP host are required','error');return;}
      btnEmail2.disabled=true; btnEmail2.textContent='Verifying...';
      try {
        const res = await apiFetch('/api/leads/email-settings',{
          method:'POST',
          body:JSON.stringify({user,pass,imapHost,imapPort,smtpHost,smtpPort,fromName}),
        });
        const d = res?await res.json():null;
        if (d&&d.success) {
          localStorage.setItem('lc_email_address', user);
          _cachedEmailConfig = d.config;
          showEmailStatus(d.config);
          toast('Email account updated');
        }
        else toast((d&&d.message)||'Connection failed','error');
      } catch(err){toast(err.message,'error');}
      btnEmail2.disabled=false; btnEmail2.textContent='Connect Email';
    });

    // Disconnect email
    const _btnDisc = el('btnDisconnectEmail');
    if (_btnDisc) _btnDisc.addEventListener('click',async()=>{
      _btnDisc.disabled=true;
      try {
        await apiFetch('/api/leads/email-settings',{method:'DELETE'});
        localStorage.removeItem('lc_email_address');
        _cachedEmailConfig = null;
        showEmailStatus(null);
        toast('Email account disconnected');
      } catch(err){toast(err.message,'error');}
      _btnDisc.disabled=false;
    });

    // Google Calendar — Connect
    const _btnCalConnect = el('btnConnectCalendar');
    if (_btnCalConnect) _btnCalConnect.addEventListener('click', async () => {
      _btnCalConnect.disabled = true;
      _btnCalConnect.textContent = 'Redirecting…';
      try {
        const res = await apiFetch('/api/leads/calendar/connect');
        if (res) {
          const d = await res.json().catch(() => ({}));
          if (res.ok && d.url) { window.location.href = d.url; return; }
          if (d.needsUpgrade) {
            toast(d.message || 'Google Calendar requires the Growth plan or above — tap Upgrade to unlock it', 'error', 6000);
            setTimeout(() => showView('payment'), 1200);
          } else {
            toast(d.message || 'Could not start Google Calendar connection', 'error');
          }
        } else {
          toast('Could not start Google Calendar connection', 'error');
        }
      } catch (err) { toast(err.message, 'error'); }
      _btnCalConnect.disabled = false;
      _btnCalConnect.textContent = 'Connect Google Calendar';
    });

    // Google Calendar — Disconnect
    const _btnCalDisc = el('btnDisconnectCalendar');
    if (_btnCalDisc) _btnCalDisc.addEventListener('click', async () => {
      _btnCalDisc.disabled = true;
      try {
        await apiFetch('/api/leads/calendar', { method: 'DELETE' });
        showCalendarStatus(false, null);
        const list = el('calEventsList');
        if (list) list.innerHTML = '';
        toast('Google Calendar disconnected');
      } catch (err) { toast(err.message, 'error'); }
      _btnCalDisc.disabled = false;
    });

    // Google Calendar — Create Test Event
    const _btnCalTest = el('btnTestCalendarEvent');
    if (_btnCalTest) _btnCalTest.addEventListener('click', async () => {
      _btnCalTest.disabled = true;
      const _origLabel = _btnCalTest.innerHTML;
      _btnCalTest.textContent = 'Creating…';
      try {
        const res = await apiFetch('/api/leads/calendar/test-event', { method: 'POST' });
        if (!res) return;
        const d = await res.json();
        if (d.success) {
          toast('Test event created' + (d.eventLink ? ' — check your calendar' : ''));
          if (d.eventLink) window.open(d.eventLink, '_blank');
          loadCalendarEvents();
        } else {
          toast(d.message || 'Failed to create test event', 'error');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
      _btnCalTest.disabled = false;
      _btnCalTest.innerHTML = _origLabel;
    });

    // Google Calendar — Refresh events list
    const _btnCalRefresh = el('btnRefreshCalEvents');
    if (_btnCalRefresh) _btnCalRefresh.addEventListener('click', () => loadCalendarEvents());

    // Test email (from connected state)
    const _btnTest = el('btnTestEmail');
    if (_btnTest) _btnTest.addEventListener('click',async()=>{
      _btnTest.disabled=true; _btnTest.textContent='Sending...';
      try {
        const res = await apiFetch('/api/leads/email-settings/test',{method:'POST'});
        if (!res) return;
        const d = res?await res.json():null;
        toast(d?d.message:'Test failed', d&&d.success?'info':'error');
      } catch(err){toast(err.message,'error');}
      _btnTest.disabled=false; _btnTest.textContent='Send test';
    });

    // Connect email (IMAP + SMTP, combined form)
    el('btnSaveEmail').addEventListener('click',async()=>{
      const user     = el('emailUser').value.trim();
      const pass     = el('emailPass').value;
      const imapHost = el('emailImapHost').value.trim();
      const imapPort = el('emailImapPort').value.trim()||'993';
      const smtpHost = el('emailSmtpHost').value.trim();
      const smtpPort = el('emailSmtpPort').value.trim()||'587';
      const fromName = el('emailFromName').value.trim();
      if (!user||!pass||!imapHost||!smtpHost){toast('Email, password, IMAP host, and SMTP host are required','error');return;}
      el('btnSaveEmail').disabled=true; el('btnSaveEmail').textContent='Verifying...';
      try {
        const res = await apiFetch('/api/leads/email-settings',{
          method:'POST',
          body:JSON.stringify({user,pass,imapHost,imapPort,smtpHost,smtpPort,fromName}),
        });
        const d = res?await res.json():null;
        if (d&&d.success) {
          localStorage.setItem('lc_email_address', user);
          _cachedEmailConfig = d.config;
          showEmailStatus(d.config);
          toast('Email connected');
        }
        else toast((d&&d.message)||'Connection failed','error');
      } catch(err){toast(err.message,'error');}
      el('btnSaveEmail').disabled=false; el('btnSaveEmail').textContent='Connect Email';
    });

    // Test email (from setup/connect card, before status card is shown)
    const _btnTestSetup = el('btnTestEmailSetup');
    if (_btnTestSetup) _btnTestSetup.addEventListener('click',async()=>{
      _btnTestSetup.disabled=true; _btnTestSetup.textContent='Sending...';
      try {
        const res = await apiFetch('/api/leads/email-settings/test',{method:'POST'});
        if (!res) return;
        const d = res?await res.json():null;
        toast(d?d.message:'Test failed', d&&d.success?'info':'error');
      } catch(err){toast(err.message,'error');}
      _btnTestSetup.disabled=false; _btnTestSetup.textContent='Send Test Email';
    });

    // Settings
    el('btnSaveSettings').addEventListener('click',async()=>{
      const g = id => { const e = el(id); return e ? e.value.trim() : ''; };
      settings.businessName        = g('settBusinessName');
      settings.businessType        = g('settBusinessType');
      settings.ownerName           = g('settOwnerName');
      settings.phone               = g('settPhone');
      settings.bookingUrl          = g('settBookingUrl');
      settings.website             = g('settWebsite');
      settings.address             = g('settAddress');
      settings.responseTime        = g('settResponseTime');
      settings.description         = g('settDescription');
      settings.targetCustomer      = g('settTargetCustomer');
      settings.specialInstructions = g('settSpecialInstructions');
      settings.currency = el('settCurrency') ? el('settCurrency').value : (settings.currency||'USD');
      // Validate required fields
      const missing = [];
      if (!settings.businessName) missing.push('Business name');
      if (!settings.businessType) missing.push('Business type');
      if (!settings.ownerName)    missing.push('Owner name');
      if (!settings.description)  missing.push('Business description');
      if (!settings.targetCustomer) missing.push('Target customer');
      if (missing.length) { toast('Required: ' + missing.join(', '),'error',4000); return; }
      saveSettings();
      try {
        const res = await apiFetch('/api/leads/settings',{method:'PUT',body:JSON.stringify(settings)});
        if (!res) return;
        const d = res?await res.json():null;
        if (d&&d.success) {
          toast('Business profile saved');
          // Use server-authoritative setup_complete flag (not local heuristics)
          const isComplete = !!(d.setup_complete);
          const banner = el('settingsSetupBanner');
          if (banner) banner.style.display = isComplete ? 'none' : 'flex';
          const ind = el('setupIndicator');
          if (ind) ind.style.display = isComplete ? 'none' : 'flex';
        } else toast((d&&d.message)||'Save failed','error');
      } catch(err){toast(err.message,'error');}
    });

    el('btnSavePricing').addEventListener('click',async()=>{
      const g = id => { const e = el(id); return e ? e.value.trim() : ''; };
      settings.currency = el('settCurrency') ? el('settCurrency').value : (settings.currency||'USD');
      // Also pick up any profile fields that may have been edited
      settings.businessName        = g('settBusinessName') || settings.businessName;
      settings.businessType        = g('settBusinessType') || settings.businessType;
      settings.ownerName           = g('settOwnerName')    || settings.ownerName;
      settings.phone               = g('settPhone')        || settings.phone;
      settings.bookingUrl          = g('settBookingUrl')   || settings.bookingUrl;
      settings.website             = g('settWebsite')      || settings.website;
      settings.address             = g('settAddress')      || settings.address;
      settings.responseTime        = g('settResponseTime') || settings.responseTime;
      settings.description         = g('settDescription')  || settings.description;
      settings.targetCustomer      = g('settTargetCustomer') || settings.targetCustomer;
      settings.specialInstructions = g('settSpecialInstructions') || settings.specialInstructions;
      saveSettings();
      try {
        const res = await apiFetch('/api/leads/settings',{method:'PUT',body:JSON.stringify(settings)});
        if (!res) return;
        const d = res?await res.json():null;
        if (d&&d.success) {
          toast('Services saved');
          // Use server-authoritative setup_complete flag
          const isComplete = !!(d.setup_complete);
          const ind = el('setupIndicator');
          if (ind) ind.style.display = isComplete ? 'none' : 'flex';
        } else toast((d&&d.message)||'Save failed','error');
      } catch(err){toast(err.message,'error');}
    });

    // Service Timing — Save
    const _btnSaveTiming = el('btnSaveTiming');
    if (_btnSaveTiming) _btnSaveTiming.addEventListener('click', async () => {
      const g = id => { const e = el(id); return e ? e.value.trim() : ''; };
      settings.defaultAppointmentDuration = parseInt(g('settApptDuration')) || 60;
      settings.bufferTime          = parseInt(g('settBufferTime')) || 15;
      settings.noticePeriod        = parseInt(g('settNoticePeriod')) || 24;
      const tzHours = window.TimingUI ? TimingUI.collect() : { ok: true, partial: true };
      if (!tzHours.ok) { toast(tzHours.error, 'error'); return; }
      if (!tzHours.partial) {
        settings.timezone = tzHours.timezone;
        settings.timezoneConfirmed = true;
        settings.businessHours = tzHours.businessHours;
      }
      _btnSaveTiming.disabled = true; _btnSaveTiming.textContent = 'Saving…';
      try {
        const res = await apiFetch('/api/leads/settings', { method: 'PUT', body: JSON.stringify(settings) });
        if (!res) return;
        const d = res ? await res.json() : null;
        if (d && d.success) {
          toast('Time zone and hours saved');
          if (d.settings) {
            ['businessHours', 'timezoneConfirmed', 'businessDays', 'businessHoursStart', 'businessHoursEnd'].forEach(k => { settings[k] = d.settings[k]; });
            if (window.TimingUI) TimingUI.fill(settings);
          }
        }
        else toast((d && d.message) || 'Save failed', 'error');
      } catch(err) { toast(err.message, 'error'); }
      _btnSaveTiming.disabled = false; _btnSaveTiming.textContent = 'Save time zone and hours';
    });

    // ── Deep settings for low-volume / high-value / long-cycle businesses ──
    function genericSectionSave(btnId, collectFn, label) {
      const btn = el(btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        collectFn();
        const original = btn.textContent;
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          const res = await apiFetch('/api/leads/settings', { method: 'PUT', body: JSON.stringify(settings) });
          if (res) {
            const d = await res.json();
            if (d && d.success) toast(label + ' saved');
            else toast((d && d.message) || 'Save failed', 'error');
          }
        } catch (err) { toast(err.message, 'error'); }
        btn.disabled = false; btn.textContent = original;
      });
    }

    genericSectionSave('btnSaveQuoteRules', () => {
      collectQuoteFields(['estimateRangePercent','siteVisitAbove','siteVisitFee','proposalValidityDays','maxDiscountPercent','quoteInfoNeeded','neverQuote']);
      saveSettings();
    }, 'Quote rules');

    genericSectionSave('btnSavePhotoQuotes', () => {
      collectQuoteFields(['photoQuoteEnabled','photoQuoteMaxValue','photoQuoteUnclear','photoQuoteGuidance','photoQuoteDisclaimer']);
      saveSettings();
    }, 'Photo quotes');

    genericSectionSave('btnSavePolicies', () => {
      collectQuoteFields(['standardDepositPercent','paymentTerms','paymentMethods','cancellationFee','warrantyPolicy','licenseInsurance','cancellationPolicy']);
      saveSettings();
    }, 'Policies');

    // ── Calendar Permission Modal ─────────────────────────────
    let _calPermLeadId = null;
    function showCalPermModal(leadId) {
      _calPermLeadId = leadId;
      const modal = el('calPermModal');
      if (modal) { modal.style.display = 'flex'; }
    }
    function hideCalPermModal() {
      const modal = el('calPermModal');
      if (modal) { modal.style.display = 'none'; }
      _calPermLeadId = null;
    }
    const _calPermDecline = el('calPermDecline');
    if (_calPermDecline) _calPermDecline.addEventListener('click', () => {
      hideCalPermModal();
      toast('Calendar event skipped');
    });
    const _calPermConfirm = el('calPermConfirm');
    if (_calPermConfirm) _calPermConfirm.addEventListener('click', async () => {
      if (!_calPermLeadId) { hideCalPermModal(); return; }
      const leadId = _calPermLeadId;
      hideCalPermModal();
      await addToCalendar(leadId);
    });
    // Close on backdrop click
    const _calPermModal = el('calPermModal');
    if (_calPermModal) _calPermModal.addEventListener('click', (e) => {
      if (e.target === _calPermModal) hideCalPermModal();
    });

    // Expose showCalPermModal so status-change handlers can use it
    window._showCalPermModal = showCalPermModal;

    // Consent queue
    const _btnApproveAll = el('btnApproveAll');
    if (_btnApproveAll) _btnApproveAll.addEventListener('click', approveAll);
    const _btnRefreshConsent = el('btnRefreshConsent');

    // Human review
    const _btnRefreshHuman = el('btnRefreshHuman');
    if (_btnRefreshHuman) _btnRefreshHuman.addEventListener('click', loadReview);

    // ── Services & Pricing form (add + edit) ──────────────────
    const SVC_NUM  = { svcBasePrice:'basePrice', svcPriceMax:'priceMax', svcMinCharge:'minCharge', svcPricePerUnit:'pricePerUnit',
      svcDurationHours:'durationHours', svcDepositPercent:'depositPercent', svcCallOutFee:'callOutFee', svcTravelFee:'travelFee',
      svcEmergency:'emergencySurcharge', svcPriority:'prioritySurcharge', svcAfterHours:'afterHoursSurcharge',
      svcWeekend:'weekendSurcharge', svcHoliday:'holidaySurcharge', svcMaterialsMarkup:'materialsMarkupPercent', svcTaxRate:'taxRatePercent' };
    const SVC_TEXT = { svcName:'name', svcCategory:'category', svcDescription:'description', svcUnitLabel:'unitLabel', svcTravelNote:'travelNote',
      svcMaterialsNote:'materialsNote', svcTaxName:'taxName', svcNotes:'quoteNotes', svcExclusions:'exclusions', svcInfoNeeded:'infoNeeded', svcWarranty:'warranty' };
    const SVC_SEL  = { svcPricingType:['pricingType','fixed'], svcSurchargeType:['surchargeType','percent'], svcMaterialsMode:['materialsMode',''], svcTaxMode:['taxMode',''] };
    let _editingSvc = -1;

    function addonRow(a) {
      const row = document.createElement('div');
      row.className = 'svc-addon-row';
      row.innerHTML = `<input class="lc-input" data-ao="name" placeholder="Replacement tap" value="${esc(a && a.name)}">
        <input class="lc-input" data-ao="price" type="number" min="0" placeholder="40" value="${a && a.price != null ? esc(a.price) : ''}">
        <input class="lc-input" data-ao="note" placeholder="Note (optional)" value="${esc(a && a.note)}">
        <button type="button" class="lc-btn lc-btn-danger lc-btn-sm" data-ao="remove">×</button>`;
      row.querySelector('[data-ao="remove"]').addEventListener('click', () => row.remove());
      return row;
    }
    function readAddons() {
      const box = el('svcAddonsList'); if (!box) return [];
      return [...box.querySelectorAll('.svc-addon-row')].map(r => ({
        name:  r.querySelector('[data-ao="name"]').value.trim(),
        price: parseFloat(r.querySelector('[data-ao="price"]').value) || 0,
        note:  r.querySelector('[data-ao="note"]').value.trim() || null,
      })).filter(a => a.name);
    }
    function resetServiceForm() {
      Object.keys(SVC_NUM).concat(Object.keys(SVC_TEXT)).forEach(id => { const e = el(id); if (e) e.value = ''; });
      Object.entries(SVC_SEL).forEach(([id, [, dflt]]) => { const e = el(id); if (e) e.value = dflt; });
      const w = el('svcCallOutWaived'); if (w) w.checked = false;
      const box = el('svcAddonsList'); if (box) box.innerHTML = '';
      _editingSvc = -1;
      const t = el('svcFormTitle'); if (t) t.textContent = 'New service';
      const b = el('btnSaveService'); if (b) b.textContent = 'Add service';
    }
    function closeServiceForm() {
      resetServiceForm();
      el('addServiceForm').style.display = 'none'; el('btnAddService').style.display = '';
    }
    window._editService = function (i) {
      const sv = (settings.services || [])[i]; if (!sv) return;
      resetServiceForm();
      _editingSvc = i;
      Object.entries(SVC_NUM).forEach(([id, k]) => { const e = el(id); if (e && sv[k] != null) e.value = sv[k]; });
      Object.entries(SVC_TEXT).forEach(([id, k]) => { const e = el(id); if (e && sv[k] != null) e.value = sv[k]; });
      Object.entries(SVC_SEL).forEach(([id, [k, dflt]]) => { const e = el(id); if (e) e.value = sv[k] || dflt; });
      const w = el('svcCallOutWaived'); if (w) w.checked = !!sv.callOutWaivedIfBooked;
      const box = el('svcAddonsList'); if (box) (sv.addOns || []).forEach(a => box.appendChild(addonRow(a)));
      const t = el('svcFormTitle'); if (t) t.textContent = 'Edit service';
      const b = el('btnSaveService'); if (b) b.textContent = 'Save changes';
      el('addServiceForm').style.display = ''; el('btnAddService').style.display = 'none';
      el('addServiceForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    el('btnAddService').addEventListener('click',()=>{
      resetServiceForm();
      el('addServiceForm').style.display=''; el('btnAddService').style.display='none';
    });
    const _btnAddAddon = el('btnAddAddon');
    if (_btnAddAddon) _btnAddAddon.addEventListener('click', () => { const box = el('svcAddonsList'); if (box) box.appendChild(addonRow()); });

    el('btnCancelService').addEventListener('click', closeServiceForm);

    el('btnSaveService').addEventListener('click',()=>{
      const name = el('svcName').value.trim();
      const base = parseFloat(el('svcBasePrice').value);
      const ptype = el('svcPricingType').value;
      if (!name||(!base && ptype!=='site_visit')){toast('Service name and base price required','error');return;}
      const dupe = (settings.services||[]).findIndex(s => String(s.name).toLowerCase() === name.toLowerCase());
      if (dupe !== -1 && dupe !== _editingSvc) { toast('A service with that name already exists','error'); return; }
      const svc = {};
      Object.entries(SVC_NUM).forEach(([id, k]) => { const e = el(id); svc[k] = e ? (parseFloat(e.value) || null) : null; });
      Object.entries(SVC_TEXT).forEach(([id, k]) => { const e = el(id); svc[k] = e ? (e.value.trim() || null) : null; });
      Object.entries(SVC_SEL).forEach(([id, [k, dflt]]) => { const e = el(id); svc[k] = e ? (e.value || dflt) : dflt; });
      svc.name = name; svc.basePrice = base || 0; svc.pricingType = ptype || 'fixed';
      svc.materialsMode = svc.materialsMode || null; svc.taxMode = svc.taxMode || null;
      const w = el('svcCallOutWaived'); svc.callOutWaivedIfBooked = !!(w && w.checked);
      svc.addOns = readAddons();
      if (!settings.services) settings.services=[];
      const wasEdit = _editingSvc >= 0;
      if (wasEdit) settings.services[_editingSvc] = svc; else settings.services.push(svc);
      saveSettings(); renderServicesList();
      closeServiceForm();
      toast(wasEdit ? 'Service updated' : 'Service added');
      // Persist to server immediately so service is not lost on refresh
      apiFetch('/api/leads/settings',{method:'PUT',body:JSON.stringify(settings)}).then(async r=>{
        const d=r?await r.json():null;
        if(!d||!d.success) toast('Service saved locally but server sync failed — please save pricing rules','error',5000);
      }).catch(()=>toast('Service saved locally but server sync failed — please save pricing rules','error',5000));
    });
  }

  // ── Plan gating ───────────────────────────────────────────────
  // Locks the UI when the AI-reply send quota for the current plan is used up.
  // Every plan (including Free) now has a real monthly quota from plans.js —
  // _sendQuota.limit/used/unlimited come straight from /api/leads/settings.
  let _sendQuota = null; // populated after syncFromServer

  function isLocked() {
    if (!_sendQuota) return false; // not loaded yet — optimistic
    if (_sendQuota.unlimited) return false;
    return _sendQuota.used >= _sendQuota.limit;
  }

  function applyPlanGating() {
    if (!isLocked()) return; // nothing to do

    // Only gate send-related views — config/setup pages always stay accessible
    const freeViews = new Set(['payment','whatsapp','email','integrations','settings','webhook']);

    // Dim and intercept send-related nav items only
    document.querySelectorAll('.lc-nav-item[data-view]').forEach(function(navEl) {
      const view = navEl.dataset.view;
      if (freeViews.has(view)) return; // always accessible
      navEl.style.opacity = '0.35';
      navEl.title = 'Upgrade your plan for more AI replies';
      navEl.addEventListener('click', function(e) {
        e.stopImmediatePropagation();
        showView('payment');
      }, true);
    });

    // Agent mode dropdown remains accessible — it's a UI preference, not quota-gated

    // Show upgrade wall
    showView('payment');
    const msg = el('paywallMsg');
    if (msg) msg.style.display = 'block';

    // Show a persistent banner at the top of the leads view
    const banner = el('freeLimitBanner');
    if (banner) banner.style.display = 'flex';
  }

  // Called after every send (or on sync) to re-evaluate lock state
  function refreshGating() {
    if (!isLocked()) return;
    applyPlanGating();
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    setTimeout(() => document.body.classList.remove('lc-booting'), 12000);   // never leave the skeleton up if a request hangs
    loadSettings();
    checkUrlParams();
    const ok = await initAuth(); if (!ok) return;
    // New accounts must connect email or WhatsApp first. The server stamps them at sign-up and
    // clears the requirement as soon as either channel is connected, so existing users never see this.
    try {
      const gate = (await earlyGet('/api/users/setup-status')) || await fetch('/api/users/setup-status', { credentials: 'include' });
      if (gate.ok) {
        const g = await gate.json();
        if (g && g.onboarding_required) { window.location.replace('onboarding.html'); return; }
      }
    } catch (_) { /* if the check fails, let them into the dashboard rather than lock them out */ }
    wireEvents();

    // Warm the WhatsApp Embedded Signup config + Facebook SDK ahead of time.
    // If we only fetch these inside the "Connect with WhatsApp" click handler,
    // the network round-trip (config fetch) + script load (FB SDK) happen
    // *after* the click, so by the time FB.login() finally runs and tries to
    // open its popup, the browser no longer considers it a direct result of
    // the user's click — and blocks it as an unexpected popup. Pre-fetching
    // here means both are already resolved/cached by click time, so
    // startWAEmbeddedSignup() can call FB.login() essentially immediately,
    // keeping it inside the browser's "user activation" window.
    // It is a third-party script: start it once the dashboard has had its turn, not in competition with it.
    const warmWA = () => getWAEmbeddedSignupConfig().then(cfg => loadFacebookSdk(cfg.appId)).catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(warmWA, { timeout: 4000 }); else setTimeout(warmWA, 2500);

    const plan   = currentUser && currentUser.plan;
    const isPaid = !!plan && plan !== 'free';

    // All users get access to the app — load it first (silent: the Agent view stays in front)
    showView('leads', { silent: true });
    initMobile();
    const syncing = syncFromServer();   // populates _sendQuota
    refreshBadgeCounts();               // its two requests run alongside the sync, not after it
    await syncing;

    // After settings loaded, apply gating if needed
    applyPlanGating();

    // After sync, check setup indicator
    const isComplete = !!(settings.businessName && settings.ownerName &&
      settings.description && settings.targetCustomer && settings.services && settings.services.length > 0);
    const ind = el('setupIndicator');
    if (ind) ind.style.display = isComplete ? 'none' : 'flex';

    // Show free trial banner if on free plan and not yet locked
    if (!isPaid && _sendQuota && _sendQuota.used < _sendQuota.limit) {
      const trialBanner = el('freeTrialBanner');
      if (trialBanner) trialBanner.style.display = 'flex';
    }


    // Client-side refresh every 30s
    setInterval(async () => {
      try {
        const r = await apiFetch('/api/leads');
        if (!r) return;
        const d = await r.json();
        if (d.success && d.leads) { leads = d.leads; renderLeadsTable(); updateStats(); }
        refreshBadgeCounts();
      } catch(_) {}
    }, 30_000);
  }

  init();
})();

// ══════════════════════════════════════════════════════════════════════════
// KnowledgeUI — Company Knowledge AI
// Renders into #view-knowledge-content. Businesses add pricing sheets, FAQs,
// product/service info, competitor notes, and internal processes here.
// routes/leads.js's getSettings() compiles every entry into
// businessContext.knowledgeBase, which services/leads/engine.js / services/workflows/engine.js
// inject into every AI prompt — so replies answer from the business's own
// material instead of guessing. Self-contained.
// ══════════════════════════════════════════════════════════════════════════
const KnowledgeUI = (() => {
  'use strict';
  const el  = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));
  const truncate = (s, n) => { s = String(s||''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function getCsrf() {
    try {
      const m = document.cookie.split('; ').find(r => r.startsWith('bp_csrf='));
      return m ? decodeURIComponent(m.split('=')[1]) : '';
    } catch (_) { return ''; }
  }
  async function api(path, opts = {}) {
    const res = await fetch('/api/knowledge' + path, {
      credentials: 'include', ...opts,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrf(), ...(opts.headers || {}) },
    });
    if (res.status === 401) { window.location.href = '/login.html'; return null; }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data) throw new Error((data && data.message) || `Request failed (${res.status})`);
    return data;
  }
  function toast(msg, type) {
    const c = el('lcToast'); if (!c) return;
    const t = document.createElement('div');
    t.className = 'lc-toast' + (type === 'error' ? ' error' : '');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.25s'; setTimeout(() => t.remove(), 260); }, 3800);
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return String(d); }
  }

  const CATEGORIES = [
    { key: 'pricing',    label: 'Pricing',           hint: 'Price lists, rate cards, discount rules.' },
    { key: 'faq',        label: 'FAQs',               hint: 'Common questions customers ask, answered the way you want the AI to answer them.' },
    { key: 'product',    label: 'Product Info',       hint: 'What you sell — specs, materials, what\u2019s included.' },
    { key: 'service',    label: 'Service Info',       hint: 'How your service works — process, turnaround, guarantees.' },
    { key: 'competitor', label: 'Competitor Info',    hint: 'How you compare, talking points if customers mention a competitor.' },
    { key: 'process',    label: 'Internal Processes', hint: 'Internal policies the AI should follow but never quote verbatim.' },
  ];

  let _entries = [];
  let _activeCategory = 'all';
  let _loaded = false;
  let _editingId = null;

  async function load() {
    el('view-knowledge-content').innerHTML = `<div class="lc-empty" style="margin-top:40px"><div class="lc-spinner" style="margin:0 auto"></div></div>`;
    try {
      const d = await api('');
      _entries = d.entries || [];
      _loaded = true;
    } catch (e) {
      el('view-knowledge-content').innerHTML = `<div class="lc-empty" style="margin-top:40px"><div class="lc-empty-text">${esc(e.message)}</div></div>`;
      return;
    }
    render();
  }

  function render() {
    if (!_loaded) { load(); return; }
    const wrap = el('view-knowledge-content');
    const visible = _activeCategory === 'all' ? _entries : _entries.filter(e => e.category === _activeCategory);

    wrap.innerHTML = `
      <div class="lc-section-header">
        <div>
          <div class="lc-section-title">Company Knowledge AI</div>
          <div class="lc-section-sub">Upload pricing, FAQs, product/service info, competitor notes, and internal processes — the AI uses all of it to understand your business and answer customers accurately.</div>
        </div>
        <button class="lc-btn lc-btn-primary lc-btn-sm" id="kbAddBtn">+ Add Document</button>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px">
        <button class="lc-filter-btn kb-cat-btn ${_activeCategory==='all'?'active':''}" data-cat="all">All (${_entries.length})</button>
        ${CATEGORIES.map(c => {
          const n = _entries.filter(e => e.category === c.key).length;
          return `<button class="lc-filter-btn kb-cat-btn ${_activeCategory===c.key?'active':''}" data-cat="${c.key}">${esc(c.label)} (${n})</button>`;
        }).join('')}
      </div>

      <div id="kbList">
        ${!visible.length ? `
          <div class="lc-empty" style="margin-top:30px">
            <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none"><path d="M12 8h16l8 8v22a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.5"/><path d="M28 8v8h8" stroke="currentColor" stroke-width="1.5"/></svg>
            <div class="lc-empty-title">No documents yet</div>
            <div class="lc-empty-text">Add your pricing, FAQs, or anything else the AI should know before it replies to customers.</div>
          </div>` : `
          <div class="lc-table-wrap">
            <table class="lc-table">
              <thead><tr><th>Title</th><th>Category</th><th>Preview</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                ${visible.map(e => `
                  <tr>
                    <td style="font-weight:600;color:var(--text)">${esc(e.title)}</td>
                    <td><span class="lc-role-chip">${esc((CATEGORIES.find(c=>c.key===e.category)||{}).label || e.category)}</span></td>
                    <td style="color:var(--text3)">${esc(truncate(e.content, 80))}</td>
                    <td style="color:var(--text3);white-space:nowrap">${fmtDate(e.updatedAt)}</td>
                    <td style="text-align:right;white-space:nowrap">
                      <button class="lc-btn lc-btn-ghost lc-btn-sm kb-edit-btn" data-id="${esc(e.id)}">Edit</button>
                      <button class="lc-btn lc-btn-ghost lc-btn-sm kb-del-btn" data-id="${esc(e.id)}" style="color:var(--red)">Delete</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`}
      </div>
    `;

    el('kbAddBtn').addEventListener('click', () => openModal(null));
    wrap.querySelectorAll('.kb-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => { _activeCategory = btn.dataset.cat; render(); });
    });
    wrap.querySelectorAll('.kb-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = _entries.find(e => e.id === btn.dataset.id);
        if (entry) openModal(entry);
      });
    });
    wrap.querySelectorAll('.kb-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this document? The AI will stop using it immediately.')) return;
        try {
          await api(`/${btn.dataset.id}`, { method: 'DELETE' });
          _entries = _entries.filter(e => e.id !== btn.dataset.id);
          render();
          toast('Document deleted');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  // ── Add / Edit modal ──────────────────────────────────────────────────
  function openModal(entry) {
    _editingId = entry ? entry.id : null;
    const wrap = document.createElement('div');
    wrap.className = 'wf-modal-overlay';
    wrap.id = 'kbModalOverlay';
    wrap.innerHTML = `
      <div class="wf-modal" style="max-width:560px">
        <div class="wf-modal-title">${entry ? 'Edit Document' : 'Add Document'}</div>
        <div class="lc-field">
          <label class="lc-label">Category</label>
          <select class="lc-select" id="kbCategory">
            ${CATEGORIES.map(c => `<option value="${c.key}" ${entry && entry.category===c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
          <div id="kbCategoryHint" class="kb-hint"></div>
        </div>
        <div class="lc-field">
          <label class="lc-label">Title</label>
          <input class="lc-input" id="kbTitle" maxlength="200" placeholder="e.g. Standard Pricing 2026" value="${esc(entry ? entry.title : '')}">
        </div>
        <div class="lc-field">
          <label class="lc-label">Content</label>
          <textarea class="lc-input kb-content" id="kbContent" rows="9" placeholder="Paste or type the document content here — pricing tables, FAQ Q&amp;As, policies, anything the AI should know.">${esc(entry ? entry.content : '')}</textarea>
          <div class="kb-hint">
            <span id="kbCharCount">0</span> / 20,000 characters
          </div>
        </div>
        <div id="kbModalError" class="kb-error" style="color:var(--red);display:none"></div>
        <div class="wf-modal-actions">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" id="kbCancel">Cancel</button>
          <button class="lc-btn lc-btn-primary lc-btn-sm" id="kbSave">${entry ? 'Save Changes' : 'Add Document'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });

    const updateHint = () => {
      const cat = CATEGORIES.find(c => c.key === el('kbCategory').value);
      el('kbCategoryHint').textContent = cat ? cat.hint : '';
    };
    updateHint();
    el('kbCategory').addEventListener('change', updateHint);

    const updateCount = () => { el('kbCharCount').textContent = el('kbContent').value.length.toLocaleString(); };
    updateCount();
    el('kbContent').addEventListener('input', updateCount);

    el('kbCancel').addEventListener('click', () => wrap.remove());
    el('kbSave').addEventListener('click', () => saveModal(wrap));
  }

  async function saveModal(wrap) {
    const errEl = el('kbModalError');
    errEl.style.display = 'none';
    const category = el('kbCategory').value;
    const title = el('kbTitle').value.trim();
    const content = el('kbContent').value.trim();
    if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = ''; return; }
    if (!content) { errEl.textContent = 'Content is required.'; errEl.style.display = ''; return; }

    const btn = el('kbSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let d;
      if (_editingId) {
        d = await api(`/${_editingId}`, { method: 'PUT', body: JSON.stringify({ category, title, content }) });
        _entries = _entries.map(e => e.id === _editingId ? d.entry : e);
      } else {
        d = await api('', { method: 'POST', body: JSON.stringify({ category, title, content }) });
        _entries = [d.entry, ..._entries];
      }
      wrap.remove();
      render();
      toast(_editingId ? 'Document updated' : 'Document added');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
      btn.disabled = false; btn.textContent = _editingId ? 'Save Changes' : 'Add Document';
    }
  }

  return { render: () => { _loaded ? render() : load(); } };
})();
window.KnowledgeUI = KnowledgeUI;
