/* ═══════════════════════════════════════════════════════════════
   WORKFLOWS.JS — Visual Workflow Builder
   Renders into #view-workflows-content. Shares the auth/toast/esc
   helpers pattern used by leads.js but is fully self-contained.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────
  let workflows   = [];
  let templates   = [];
  let current     = null;      // the workflow object currently open in the editor (API shape)
  let editorTab   = 'builder'; // 'builder' | 'runs'
  let runsCache   = [];
  let slideover   = null;      // { mode:'trigger'|'step'|'run', path?:[], runId?:string }
  let leadsCache  = null;      // for the "test against which lead" picker

  // ── Helpers (mirrors leads.js conventions) ───────────────────
  const el  = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const truncate = (s, n) => { s = String(s||''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const genId = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

  function getCsrf() {
    try {
      const m = document.cookie.split('; ').find(r => r.startsWith('bp_csrf='));
      return m ? decodeURIComponent(m.split('=')[1]) : '';
    } catch (_) { return ''; }
  }
  async function api(url, opts = {}) {
    const res = await fetch(url, {
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
    try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return String(d); }
  }

  // ── Icons (inline SVG, 16x16, matches sidebar icon style) ────
  const I = {
    plus:    '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    edit:    '<svg viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-7.5 7.5L3 13l.5-3.5L11 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    trash:   '<svg viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    message: '<svg viewBox="0 0 20 20" fill="none"><path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V5z" stroke="currentColor" stroke-width="1.4"/></svg>',
    clock:   '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6.5V10l3 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    search:  '<svg viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M15 15l-3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    fork:    '<svg viewBox="0 0 20 20" fill="none"><circle cx="5" cy="5" r="2.1" stroke="currentColor" stroke-width="1.4"/><circle cx="15" cy="5" r="2.1" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="15" r="2.1" stroke="currentColor" stroke-width="1.4"/><path d="M7 6.1L13 6.1M6.3 7.1L9 13M13.7 7.1L11 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    sparkle: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5l1.6 4.9 4.9 1.6-4.9 1.6L10 15.5l-1.6-4.9-4.9-1.6 4.9-1.6L10 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    tag:     '<svg viewBox="0 0 20 20" fill="none"><path d="M11 3H5a2 2 0 0 0-2 2v6l8 8 8-8-8-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.1" fill="currentColor"/></svg>',
    bell:    '<svg viewBox="0 0 20 20" fill="none"><path d="M5 8a5 5 0 0 1 10 0v3l1.5 2.5h-13L5 11V8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 15.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.4"/></svg>',
    play:    '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2.5l9 5.5-9 5.5v-11z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    back:    '<svg viewBox="0 0 16 16" fill="none" width="13"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    newlead: '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 7v6M7 10h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    reply:   '<svg viewBox="0 0 20 20" fill="none"><path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V5z" stroke="currentColor" stroke-width="1.4"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" fill="none"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.5 2.5v3h-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    calendar:'<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="4.5" width="14" height="13" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="13" r="1.2" fill="currentColor"/></svg>',
    tagplus: '<svg viewBox="0 0 20 20" fill="none"><path d="M11 3H5a2 2 0 0 0-2 2v6l8 8 8-8-6-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.1" fill="currentColor"/><path d="M15.5 4.5v4M13.5 6.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    tagminus:'<svg viewBox="0 0 20 20" fill="none"><path d="M11 3H5a2 2 0 0 0-2 2v6l8 8 8-8-6-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.1" fill="currentColor"/><path d="M13.5 6.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    webhook: '<svg viewBox="0 0 20 20" fill="none"><path d="M3.5 10a6.5 6.5 0 1 1 13 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10 14.5l-4-3h8l-4 3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 16.5v-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    reminder:'<svg viewBox="0 0 20 20" fill="none"><path d="M5 8a5 5 0 0 1 10 0v3l1.5 2.5h-13L5 11V8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 15.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.4"/><path d="M10 4V2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="15.5" cy="5.5" r="2.5" fill="currentColor"/></svg>',
  };

  // ── Step + trigger metadata ───────────────────────────────────
  // The steps an owner can add. `simple: true` steps appear in the picker; the others only exist so that older workflows still open and
  // run (the editor shows them, but they cannot be added to a new workflow).
  const STATUS_LABELS = { new: 'New', processing: 'Being handled', replied: 'Replied', pending_followup: 'Waiting for the customer', closed: 'Closed' };
  const OUTCOMES = [
    { v: '',         label: 'No change',            status: '',                 stage: undefined },
    { v: 'hot_lead', label: 'Hot lead',             status: '',                 stage: 'hot_lead' },
    { v: 'quoted',   label: 'Quote sent',           status: 'pending_followup', stage: 'quoted' },
    { v: 'booked',   label: 'Booked in',            status: '',                 stage: 'booked' },
    { v: 'won',      label: 'Won (job confirmed)',  status: 'closed',           stage: 'won' },
    { v: 'lost',     label: 'Lost',                 status: 'closed',           stage: 'lost' },
  ];
  function outcomeOf(c) { return OUTCOMES.find(o => (o.status || '') === (c.status || '') && (o.stage || '') === (c.stage || '')) || null; }
  const STEP_TYPES = {
    send_message:   { simple: true, label: 'Email the customer', blurb: 'Send a message by email. AI writes it, or you do.', icon: I.message, forking: false, title: () => 'Email the customer',
      summary: s => s.config.mode === 'custom'
        ? `Your message: "${truncate(s.config.template, 70)}"`
        : `AI writes it: ${truncate(s.config.aiInstructions || 'a friendly follow-up to the conversation', 70)}` },
    wait:           { simple: true, label: 'Wait', blurb: 'Pause for a while before the next step.', icon: I.clock, forking: false, title: () => 'Wait',
      summary: s => `Wait ${(s.config.duration && s.config.duration.value) || 1} ${(s.config.duration && s.config.duration.unit) || 'hours'}, then continue` },
    wait_for_reply: { simple: true, label: 'Wait for a reply', blurb: 'Pause until they answer. Do one thing if they reply, another if they do not.', icon: I.clock, forking: true, title: () => 'Wait for a reply',
      summary: s => `Wait up to ${(s.config.timeout && s.config.timeout.value) || 3} ${(s.config.timeout && s.config.timeout.unit) || 'days'} for an answer` },
    notify_owner:   { simple: true, label: 'Alert me', blurb: 'Email yourself so you can step in.', icon: I.bell, forking: false, title: () => 'Alert me by email',
      summary: s => s.config.subject || 'Email me about this lead' },
    update_status:  { simple: true, label: 'Mark the lead', blurb: 'Set the lead as hot, quoted, booked, won or lost.', icon: I.tag, forking: false, title: () => 'Mark the lead',
      summary: s => { const o = outcomeOf(s.config || {}); if (o) return o.v ? `Mark as: ${o.label}` : 'No change configured yet';
        const parts = []; if (s.config.status) parts.push(STATUS_LABELS[s.config.status] || s.config.status); if (s.config.stage) parts.push(s.config.stage); return parts.length ? 'Set to: ' + parts.join(', ') : 'No change configured yet'; } },
    add_tag:        { simple: true, label: 'Add a label', blurb: 'Tag the lead so you can find it later.', icon: I.tagplus, forking: false, title: () => 'Add a label',
      summary: s => s.config.tags ? `Add: ${s.config.tags}` : 'No label chosen yet' },
    book_appointment: { simple: true, label: 'Book a visit', blurb: 'Add the agreed time to your Google Calendar.', icon: I.calendar, forking: false, title: () => 'Book a visit in Google Calendar',
      summary: () => 'Adds a calendar event from the conversation (skipped if already booked)' },
    condition:      { simple: false, label: 'Check', icon: I.fork, forking: true, title: s => conditionTitle(s.config),
      summary: s => conditionSummary(s.config) },
    // Older workflows only. Not offered for new ones.
    ai_extract:     { simple: false, label: 'AI Extract',     icon: I.search,  forking: false, title: s => `Extract "${s.config.fieldName || 'value'}"`,
      summary: s => truncate(s.config.instructions || 'Extract a value from the conversation', 90) },
    ai_decision:    { simple: false, label: 'AI Decision',    icon: I.sparkle, forking: true,  title: () => 'AI decides the path',
      summary: s => truncate(s.config.instructions || 'Let AI choose a branch', 90) },
    remove_tag:     { simple: false, label: 'Remove a label',  icon: I.tagminus, forking: false, title: () => 'Remove a label',
      summary: s => s.config.tags ? `Remove: ${s.config.tags}` : 'No label chosen yet' },
    webhook:        { simple: false, label: 'Webhook',         icon: I.webhook,  forking: false, title: () => 'Send webhook',
      summary: s => s.config.url ? `POST to ${s.config.url.slice(0, 60)}${s.config.url.length > 60 ? '...' : ''}` : 'No URL configured yet' },
    schedule_reminder: { simple: false, label: 'Schedule Reminder', icon: I.reminder, forking: false, title: () => 'Schedule a reminder',
      summary: s => { const d = s.config.delay || {}; return `Email a reminder in ${d.value || 1} ${d.unit || 'days'}: "${s.config.label || 'Reminder'}"`; } },
  };

  // "If ..." checks owners can add. Each is a ready-made condition, so nobody has to pick fields and operators.
  const CHECKS = {
    urgent: { label: "If it's an urgent job", blurb: 'Do one thing for emergencies, another for everything else.', yes: 'Urgent', no: 'Not urgent',
      config: { field: 'lead.urgency', operator: 'equals', value: 'emergency' }, text: "Checks whether the customer's request looks urgent (an emergency)." },
    won:    { label: 'If the job was won', blurb: 'Do one thing for jobs you won, another for the rest.', yes: 'Job was won', no: 'Not won',
      config: { field: 'lead.wonAt', operator: 'is_set', value: '' }, text: 'Checks whether you marked this job as won.' },
  };
  function checkOf(c) { c = c || {}; return Object.entries(CHECKS).find(([, k]) => k.config.field === c.field && k.config.operator === c.operator && String(k.config.value || '') === String(c.value || '')) || null; }
  function conditionTitle(c) { const k = checkOf(c); return k ? k[1].label : 'If / else'; }
  function conditionSummary(c) { const k = checkOf(c); return k ? k[1].text : `${fieldLabel(c.field)} ${opLabel(c.operator)}${needsValue(c.operator) ? ' "' + ((c.value) == null ? '' : c.value) + '"' : ''}`; }


  const TRIGGER_TYPES = {
    new_lead:       { label: 'A new enquiry comes in', icon: I.newlead, summary: t => `A new enquiry comes in${t.config.source && t.config.source !== 'any' ? ' by ' + t.config.source : ''}` },
    lead_replied:   { label: 'A customer replies',      icon: I.reply,   summary: () => 'A customer replies to your message' },
    status_changed: { label: 'A lead changes status',   icon: I.refresh, summary: t => `A lead becomes "${STATUS_LABELS[t.config.toStatus] || t.config.toStatus || '?'}"` },
    stalled:        { label: 'A lead goes quiet',       icon: I.clock,   summary: t => `A lead has not answered for ${t.config.afterHours || 24} hours` },
    manual:         { label: 'Campaign (run on demand)', icon: I.newlead, hidden: true, summary: t => `Runs once for ${(t.config.audience && t.config.audience.label) || 'a chosen audience'}` },
  };
  // Triggers an owner can choose. A campaign trigger only shows up on automations the Agent already created.
  const pickableTriggers = (cur) => Object.entries(TRIGGER_TYPES).filter(([k, v]) => !v.hidden || k === cur);

  const FIELD_OPTIONS = [
    { v: 'lead.urgency', label: 'Urgency' },
    { v: 'lead.intent', label: 'Intent' },
    { v: 'lead.serviceType', label: 'Service Type' },
    { v: 'lead.conversationStage', label: 'Conversation Stage' },
    { v: 'lead.status', label: 'Status' },
    { v: 'lead.turnCount', label: 'Turn Count' },
    { v: 'quote.total', label: 'Quote Total' },
  ];
  function fieldLabel(v) {
    const f = FIELD_OPTIONS.find(o => o.v === v);
    if (f) return f.label;
    if (v && v.startsWith('context.')) return v.slice(8) + ' (extracted)';
    return v || '—';
  }
  const OPERATORS = [
    { v: 'equals', label: 'Equals' }, { v: 'not_equals', label: 'Does not equal' },
    { v: 'contains', label: 'Contains' }, { v: 'greater_than', label: 'Greater than' },
    { v: 'less_than', label: 'Less than' }, { v: 'is_set', label: 'Is set' }, { v: 'is_not_set', label: 'Is not set' },
  ];
  function opLabel(v) { const o = OPERATORS.find(x => x.v === v); return o ? o.label.toLowerCase() : v; }
  function needsValue(op) { return op !== 'is_set' && op !== 'is_not_set'; }

  function collectExtractFields(steps, out) {
    out = out || [];
    (steps || []).forEach(s => {
      if (s.type === 'ai_extract' && s.config && s.config.fieldName) out.push(s.config.fieldName);
      (s.branches || []).forEach(b => collectExtractFields(b.steps, out));
    });
    return out;
  }

  function defaultStep(type) {
    const base = { id: genId('step'), type, config: {} };
    switch (type) {
      case 'send_message':   base.config = { channel: 'email', mode: 'ai', aiInstructions: '' }; break;
      case 'wait':            base.config = { duration: { value: 1, unit: 'hours' } }; break;
      case 'wait_for_reply':   base.config = { timeout: { value: 3, unit: 'days' } };
        base.branches = [{ id: genId('br'), label: 'Replied', steps: [] }, { id: genId('br'), label: 'No Reply', steps: [] }]; break;
      case 'ai_extract':       base.config = { fieldName: '', instructions: '' }; break;
      case 'condition':        base.config = { field: 'lead.urgency', operator: 'equals', value: '' };
        base.branches = [{ id: genId('br'), label: 'Yes', steps: [] }, { id: genId('br'), label: 'No', steps: [] }]; break;
      case 'ai_decision':      base.config = { instructions: '' };
        base.branches = [{ id: genId('br'), label: 'Option A', steps: [] }, { id: genId('br'), label: 'Option B', steps: [] }]; break;
      case 'update_status':    base.config = { status: '', stage: 'hot_lead' }; break;
      case 'notify_owner':     base.config = { subject: '', message: '' }; break;
      case 'book_appointment': base.config = {}; break;
      case 'add_tag':          base.config = { tags: '' }; break;
      case 'remove_tag':       base.config = { tags: '' }; break;
      case 'webhook':          base.config = { url: '', secret: '', responseKey: '' }; break;
      case 'schedule_reminder': base.config = { delay: { value: 1, unit: 'days' }, channel: 'auto', mode: 'ai', aiInstructions: '', label: 'Reminder' }; break;
    }
    return base;
  }

  // ── Tree helpers (operate on current.steps, path = [idx, branchIdx, idx, ...]) ──
  function parsePath(str) { return str === '' ? [] : String(str).split(',').map(Number); }
  function getContainer(path) {
    let arr = current.steps;
    for (let i = 0; i < path.length - 1; i += 2) {
      const node = arr[path[i]];
      arr = node.branches[path[i + 1]].steps;
    }
    return { arr, index: path[path.length - 1] };
  }
  function getStepAt(path) { const { arr, index } = getContainer(path); return arr[index]; }
  function resolveStepsArray(pathPrefix) {
    if (!pathPrefix.length) return current.steps;
    const branchIndex = pathPrefix[pathPrefix.length - 1];
    const stepPath = pathPrefix.slice(0, -1);
    const forkStep = getStepAt(stepPath);
    return forkStep.branches[branchIndex].steps;
  }

  // ══════════════════════════════════════════════════════════════
  // ENTRY POINT
  // ══════════════════════════════════════════════════════════════
  async function render() {
    const root = el('view-workflows-content');
    if (!root) return;
    root.innerHTML = `<div class="lc-empty" style="margin-top:60px"><div class="lc-spinner" style="margin:0 auto 14px"></div><div class="lc-empty-text">Loading workflows…</div></div>`;
    try {
      const [wfRes, tplRes] = await Promise.all([api('/api/workflows'), api('/api/workflows/templates')]);
      workflows = (wfRes && wfRes.workflows) || [];
      templates = (tplRes && tplRes.templates) || [];
    } catch (e) {
      root.innerHTML = `<div class="lc-empty" style="margin-top:60px"><div class="lc-empty-title">Couldn't load workflows</div><div class="lc-empty-text">${esc(e.message)}</div></div>`;
      return;
    }
    current = null;
    renderList();
    wireOverlayClose();
  }

  // ══════════════════════════════════════════════════════════════
  // LIST VIEW
  // ══════════════════════════════════════════════════════════════
  function renderList() {
    const root = el('view-workflows-content');

    const templatesHtml = templates.length ? `
      <div class="wf-toolbar-sub" style="margin-bottom:10px">Ready-made automations (one click, then edit if you like)</div>
      <div class="wf-templates-row">
        ${templates.map(t => `
          <div class="wf-template-card" onclick="window.WorkflowsUI._useTemplate('${esc(t.key)}')">
            <div class="wf-template-name">${esc(t.name)}</div>
            <div class="wf-template-desc">${esc(t.description)}</div>
          </div>`).join('')}
      </div>` : '';

    const gridHtml = workflows.length ? `
      <div class="wf-grid">
        ${workflows.map(w => `
          <div class="wf-card">
            <div class="wf-card-top">
              <div>
                <div class="wf-card-name" onclick="window.WorkflowsUI._open('${w.id}')">${esc(w.name)}</div>
                <div class="wf-card-trigger">${esc((TRIGGER_TYPES[w.trigger.type] || {}).label || w.trigger.type)}</div>
              </div>
              <span class="wf-pill ${w.status}">${esc(w.status)}</span>
            </div>
            <div class="wf-card-stats">
              <span><b>${w.runCount || 0}</b> total runs</span>
              <span><b>${w.activeRuns || 0}</b> active</span>
            </div>
            <div class="wf-card-actions">
              <button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._open('${w.id}')">Edit</button>
              ${w.status === 'active'
                ? `<button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._pause('${w.id}')">Pause</button>`
                : `<button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._activate('${w.id}')">Activate</button>`}
              <button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._deleteWorkflow('${w.id}')">Delete</button>
            </div>
          </div>`).join('')}
      </div>` : `
      <div class="lc-empty" style="margin-top:20px">
        <svg class="lc-empty-icon" viewBox="0 0 48 48" fill="none"><circle cx="16" cy="14" r="5" stroke="currentColor" stroke-width="1.6"/><circle cx="32" cy="14" r="5" stroke="currentColor" stroke-width="1.6"/><circle cx="24" cy="34" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M19 17l10 0M17.5 19l5 12M30.5 19l-5 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <div class="lc-empty-title">No workflows yet</div>
        <div class="lc-empty-text">Pick a ready-made automation above, or press New Workflow to build your own.</div>
      </div>`;

    root.innerHTML = `
      <div class="wf-toolbar">
        <div>
          <div class="wf-toolbar-title">Workflows</div>
          <div class="wf-toolbar-sub">Set up simple automatic steps: email a customer, wait for a reply, alert you, or mark a lead. Pick a ready-made one below or build your own.</div>
        </div>
        <button class="lc-btn lc-btn-primary lc-btn-sm" onclick="window.WorkflowsUI._openNewModal()">${I.plus} New Workflow</button>
      </div>
      ${templatesHtml}
      <div class="wf-toolbar-sub" style="margin-bottom:10px">${workflows.length ? 'Your workflows' : ''}</div>
      ${gridHtml}
    `;
  }

  // ── New workflow modal ────────────────────────────────────────
  function openNewModal() {
    const wrap = document.createElement('div');
    wrap.className = 'wf-modal-overlay';
    wrap.id = 'wfNewModal';
    wrap.innerHTML = `
      <div class="wf-modal">
        <div class="wf-modal-title">New Workflow</div>
        <div class="lc-field">
          <label class="lc-label">Name</label>
          <input class="lc-input" id="wfNewName" placeholder="e.g. Chase quotes that go quiet" autofocus>
        </div>
        <div class="lc-field">
          <label class="lc-label">Start when</label>
          <select class="lc-select" id="wfNewTrigger">
            ${pickableTriggers().map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}
          </select>
        </div>
        <div class="wf-modal-actions">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfNewCancel">Cancel</button>
          <button class="lc-btn lc-btn-primary lc-btn-sm" id="wfNewCreate">Create</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    el('wfNewCancel').addEventListener('click', () => wrap.remove());
    el('wfNewCreate').addEventListener('click', async () => {
      const name = el('wfNewName').value.trim();
      if (!name) { toast('Name is required', 'error'); return; }
      const triggerType = el('wfNewTrigger').value;
      try {
        const res = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ name, trigger: { type: triggerType, config: {} }, steps: [] }) });
        wrap.remove();
        workflows.unshift(res.workflow);
        openEditor(res.workflow);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function useTemplate(key) {
    const t = templates.find(x => x.key === key);
    if (!t) return;
    try {
      const res = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ name: t.name, description: t.description, trigger: t.trigger, steps: t.steps }) });
      workflows.unshift(res.workflow);
      openEditor(res.workflow);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function openWorkflow(id) {
    try {
      const res = await api('/api/workflows/' + id);
      openEditor(res.workflow);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteWorkflow(id) {
    if (!confirm('Delete this workflow? This cannot be undone.')) return;
    try { await api('/api/workflows/' + id, { method: 'DELETE' }); await render(); toast('Workflow deleted'); }
    catch (e) { toast(e.message, 'error'); }
  }

  // ══════════════════════════════════════════════════════════════
  // EDITOR VIEW
  // ══════════════════════════════════════════════════════════════
  function openEditor(workflow) {
    current = workflow;
    editorTab = 'builder';
    renderEditor();
  }

  function renderEditor() {
    const root = el('view-workflows-content');
    root.innerHTML = `
      <div class="wf-editor-top">
        <button class="wf-back-btn" onclick="window.WorkflowsUI._backToList()">${I.back} Workflows</button>
        <input class="wf-name-input" id="wfEditName" value="${esc(current.name)}">
        <span class="wf-pill ${current.status}">${esc(current.status)}</span>
        <div class="wf-editor-actions">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._openTestModal()">${I.play} Test Run</button>
          ${current.status === 'active'
            ? `<button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._pause('${current.id}')">Pause</button>`
            : `<button class="lc-btn lc-btn-ghost lc-btn-sm" onclick="window.WorkflowsUI._activate('${current.id}')">Activate</button>`}
          <button class="lc-btn lc-btn-primary lc-btn-sm" onclick="window.WorkflowsUI._save()">Save</button>
        </div>
      </div>
      <textarea class="wf-editor-desc" id="wfEditDesc" placeholder="What does this workflow do? (optional)" rows="1">${esc(current.description || '')}</textarea>

      <div class="wf-tabs">
        <button class="wf-tab ${editorTab === 'builder' ? 'active' : ''}" onclick="window.WorkflowsUI._switchTab('builder')">Builder</button>
        <button class="wf-tab ${editorTab === 'runs' ? 'active' : ''}" onclick="window.WorkflowsUI._switchTab('runs')">Activity</button>
      </div>

      <div id="wfEditorBody"></div>
    `;
    if (editorTab === 'builder') renderBuilderTab();
    else renderRunsTab();
  }

  function renderBuilderTab() {
    const body = el('wfEditorBody');
    const tinfo = TRIGGER_TYPES[current.trigger.type] || { label: current.trigger.type, icon: I.newlead, summary: () => current.trigger.type };
    body.innerHTML = `
      <div class="wf-canvas">
        <div class="wf-trigger-card" onclick="window.WorkflowsUI._editTrigger()">
          <div class="wf-trigger-icon">${tinfo.icon}</div>
          <div class="wf-trigger-body">
            <div class="wf-trigger-label">Trigger</div>
            <div class="wf-trigger-title">${esc(tinfo.summary(current.trigger))}</div>
          </div>
          <div class="wf-trigger-edit">${I.edit}</div>
        </div>
        ${renderConnector([], 0)}
        ${renderStepChain(current.steps, [])}
      </div>
    `;
  }

  function renderConnector(pathPrefix, insertIndex) {
    return `<div class="wf-connector"><button class="wf-add-btn" title="Add step" onclick="window.WorkflowsUI._openAddStep('${pathPrefix.join(',')}', ${insertIndex})">${I.plus}</button></div>`;
  }

  function renderStepChain(steps, pathPrefix) {
    if (!steps || !steps.length) {
      return renderConnector(pathPrefix, 0) + `<div class="wf-end-marker">End</div>`;
    }
    let html = '';
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const path = [...pathPrefix, i];
      html += renderStepCard(step, path);
      const meta = STEP_TYPES[step.type];
      if (meta && meta.forking) {
        html += renderForkBranches(step, path);
        return html; // chain ends at a fork — nothing after it executes
      }
      html += renderConnector(pathPrefix, i + 1);
    }
    html += `<div class="wf-end-marker">End</div>`;
    return html;
  }

  function renderStepCard(step, path) {
    const meta = STEP_TYPES[step.type] || { label: step.type, icon: '', title: () => step.type, summary: () => '' };
    const pathStr = path.join(',');
    return `
      <div class="wf-step">
        <div class="wf-step-icon">${meta.icon}</div>
        <div class="wf-step-body" onclick="window.WorkflowsUI._editStep('${pathStr}')">
          <div class="wf-step-type">${esc(meta.label)}</div>
          <div class="wf-step-title">${esc(meta.title(step))}</div>
          <div class="wf-step-summary">${esc(meta.summary(step))}</div>
        </div>
        <div class="wf-step-actions">
          <button class="wf-icon-btn" title="Edit" onclick="window.WorkflowsUI._editStep('${pathStr}')">${I.edit}</button>
          <button class="wf-icon-btn" title="Delete" onclick="window.WorkflowsUI._deleteStep('${pathStr}')">${I.trash}</button>
        </div>
      </div>`;
  }

  function renderForkBranches(step, path) {
    const pathStr = path.join(',');
    const branches = step.branches || [];
    const canManageBranches = step.type === 'ai_decision';
    const cols = branches.map((b, bi) => {
      const branchPath = [...path, bi];
      const removeBtn = (canManageBranches && branches.length > 1)
        ? `<button class="wf-icon-btn" title="Remove branch" onclick="window.WorkflowsUI._removeBranch('${pathStr}',${bi})">${I.trash}</button>` : '';
      return `
        <div class="wf-branch-col">
          <div class="wf-branch-header">
            <input class="wf-branch-label-input" value="${esc(b.label)}" onchange="window.WorkflowsUI._renameBranch('${pathStr}', ${bi}, this.value)">
            ${removeBtn}
          </div>
          <div class="wf-step-chain">${renderStepChain(b.steps, branchPath)}</div>
        </div>`;
    }).join('');
    const addBranchBtn = canManageBranches
      ? `<button class="lc-btn lc-btn-ghost lc-btn-sm" style="margin-top:10px" onclick="window.WorkflowsUI._addBranch('${pathStr}')">${I.plus} Add branch</button>` : '';
    return `<div class="wf-fork-label">Branches</div><div class="wf-branch-row">${cols}</div>${addBranchBtn}`;
  }

  // ── Step tree mutations ────────────────────────────────────────
  function deleteStep(pathStr) {
    const path = parsePath(pathStr);
    const { arr, index } = getContainer(path);
    const step = arr[index];
    const isFork = step && STEP_TYPES[step.type] && STEP_TYPES[step.type].forking;
    if (isFork && !confirm('This step has branches with steps inside them. Delete it and everything inside its branches?')) return;
    arr.splice(index, 1);
    renderBuilderTab();
  }
  function renameBranch(pathStr, branchIndex, value) {
    const step = getStepAt(parsePath(pathStr));
    step.branches[branchIndex].label = value || step.branches[branchIndex].label;
  }
  function addBranch(pathStr) {
    const step = getStepAt(parsePath(pathStr));
    step.branches.push({ id: genId('br'), label: `Option ${step.branches.length + 1}`, steps: [] });
    renderBuilderTab();
  }
  function removeBranch(pathStr, branchIndex) {
    const step = getStepAt(parsePath(pathStr));
    if (step.branches.length <= 1) return;
    if (!confirm('Remove this branch and everything inside it?')) return;
    step.branches.splice(branchIndex, 1);
    renderBuilderTab();
  }

  // ══════════════════════════════════════════════════════════════
  // SLIDE-OVER: trigger / step config
  // ══════════════════════════════════════════════════════════════
  function openSlideoverShell(title) {
    el('wfSlideoverTitle').textContent = title;
    el('wfOverlay').classList.add('open');
    el('wfSlideover').classList.add('open');
  }
  function closeSlideover() {
    el('wfOverlay').classList.remove('open');
    el('wfSlideover').classList.remove('open');
    slideover = null;
  }
  function wireOverlayClose() {
    const overlay = el('wfOverlay');
    const closeBtn = el('wfSlideoverClose');
    if (overlay && !overlay._wired) { overlay._wired = true; overlay.addEventListener('click', onSlideoverCancel); }
    if (closeBtn && !closeBtn._wired) { closeBtn._wired = true; closeBtn.addEventListener('click', onSlideoverCancel); }
  }
  function onSlideoverCancel() {
    if (slideover && slideover.mode === 'new-step') {
      const { arr, index } = getContainer(slideover.path);
      arr.splice(index, 1);
      renderBuilderTab();
    }
    closeSlideover();
  }

  function formVal(name) {
    const node = document.querySelector('#wfSlideoverBody [name="' + name + '"]');
    return node ? node.value : undefined;
  }

  // ── Trigger editor ─────────────────────────────────────────────
  function editTrigger() {
    slideover = { mode: 'trigger' };
    openSlideoverShell('Configure Trigger');
    const t = current.trigger;
    el('wfSlideoverBody').innerHTML = `
      <div class="lc-field">
        <label class="lc-label">When this happens</label>
        <select class="lc-select" name="triggerType" id="wfTriggerType">
          ${pickableTriggers(t.type).map(([k, v]) => `<option value="${k}" ${k === t.type ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>
      </div>
      <div id="wfTriggerFields"></div>
    `;
    el('wfTriggerType').addEventListener('change', e => renderTriggerFields(e.target.value, {}));
    renderTriggerFields(t.type, t.config || {});
    el('wfSlideoverFooter').innerHTML = `
      <button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfSOCancel">Cancel</button>
      <button class="lc-btn lc-btn-primary lc-btn-sm" id="wfSOSave">Save</button>
    `;
    el('wfSOCancel').onclick = onSlideoverCancel;
    el('wfSOSave').onclick = () => {
      const type = el('wfTriggerType').value;
      const config = {};
      if (type === 'new_lead') config.source = formVal('source') || 'any';
      if (type === 'status_changed') config.toStatus = formVal('toStatus') || 'closed';
      if (type === 'stalled') config.afterHours = Number(formVal('afterHours')) || 24;
      current.trigger = { type, config };
      closeSlideover();
      renderBuilderTab();
    };
  }
  function renderTriggerFields(type, cfg) {
    const box = el('wfTriggerFields');
    if (type === 'new_lead') {
      box.innerHTML = `<div class="lc-field"><label class="lc-label">Only for enquiries that arrive by</label>
        <select class="lc-select" name="source">
          <option value="any" ${(!cfg.source || cfg.source === 'any') ? 'selected' : ''}>Any way</option>
          <option value="form" ${cfg.source === 'form' ? 'selected' : ''}>Form</option>
          <option value="email" ${cfg.source === 'email' ? 'selected' : ''}>Email</option>
        </select></div>`;
    } else if (type === 'status_changed') {
      const opts = ['new', 'processing', 'replied', 'pending_followup', 'closed'];
      box.innerHTML = `<div class="lc-field"><label class="lc-label">When a lead becomes</label>
        <select class="lc-select" name="toStatus">${opts.map(o => `<option value="${o}" ${cfg.toStatus === o ? 'selected' : ''}>${esc(STATUS_LABELS[o] || o)}</option>`).join('')}</select></div>`;
    } else if (type === 'stalled') {
      box.innerHTML = `<div class="lc-field"><label class="lc-label">How many hours without an answer?</label>
        <input class="lc-input" name="afterHours" type="number" min="1" value="${cfg.afterHours || 24}"></div>`;
    } else {
      box.innerHTML = `<div style="font-size:12px;color:var(--text3)">Nothing to set up. This runs every time a customer replies.</div>`;
    }
  }

  // ── Add-step picker ─────────────────────────────────────────────
  async function openAddStep(pathPrefixStr, insertIndex) {
    const pathPrefix = parsePath(pathPrefixStr);
    slideover = { mode: 'picker', pathPrefix, insertIndex };
    openSlideoverShell('Add a Step');
    el('wfSlideoverBody').innerHTML = `<div class="lc-empty" style="margin-top:20px"><div class="lc-spinner" style="margin:0 auto"></div></div>`;
    el('wfSlideoverFooter').innerHTML = `<button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfSOCancel">Cancel</button>`;
    el('wfSOCancel').onclick = onSlideoverCancel;

    const items = [
      ...Object.entries(STEP_TYPES).filter(([, v]) => v.simple).map(([k, v]) => ({ key: k, label: v.label, blurb: v.blurb, icon: v.icon })),
      ...Object.entries(CHECKS).map(([k, v]) => ({ key: 'check:' + k, label: v.label, blurb: v.blurb, icon: I.fork })),
    ];
    el('wfSlideoverBody').innerHTML = `
      <div class="wf-type-grid">
        ${items.map(it => `
          <button class="wf-type-option" onclick="window.WorkflowsUI._pickType('${it.key}')">
            <div class="wf-type-option-icon">${it.icon}</div>
            <div><div class="wf-type-option-name">${esc(it.label)}</div>
              <div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.35">${esc(it.blurb)}</div></div>
          </button>`).join('')}
      </div>
    `;
  }

  function pickType(key) {
    const { pathPrefix, insertIndex } = slideover;
    const arr = resolveStepsArray(pathPrefix);
    let type = key, check = null;
    if (key.startsWith('check:')) { type = 'condition'; check = CHECKS[key.slice(6)]; }
    const step = defaultStep(type);
    if (check) { step.config = { ...check.config }; step.branches = [{ id: genId('br'), label: check.yes, steps: [] }, { id: genId('br'), label: check.no, steps: [] }]; }
    const meta = STEP_TYPES[type];
    if (meta && meta.forking && arr.length > insertIndex) {
      arr.length = insertIndex; // a fork ends the chain — drop now-unreachable steps after it
    }
    arr.splice(insertIndex, 0, step);
    const path = [...pathPrefix, insertIndex];
    slideover = { mode: 'new-step', path };
    renderBuilderTab();
    openStepForm(step, path, true);
  }

  // ── Step editor ──────────────────────────────────────────────────
  function editStep(pathStr) {
    const path = parsePath(pathStr);
    const step = getStepAt(path);
    slideover = { mode: 'edit-step', path };
    openStepForm(step, path, false);
  }

  function openStepForm(step, path, isNew) {
    finishOpenStepForm(step, path, isNew);
  }

  function finishOpenStepForm(step, path, isNew) {
    openSlideoverShell(STEP_TYPES[step.type].label);
    el('wfSlideoverBody').innerHTML = renderStepForm(step);
    wireStepFormBehaviour(step);
    const pathStr = path.join(',');
    el('wfSlideoverFooter').innerHTML = `
      <button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfSOCancel">Cancel</button>
      ${!isNew ? `<button class="lc-btn lc-btn-danger lc-btn-sm" id="wfSODelete" style="margin-right:auto">Delete</button>` : ''}
      <button class="lc-btn lc-btn-primary lc-btn-sm" id="wfSOSave">Save</button>
    `;
    el('wfSOCancel').onclick = onSlideoverCancel;
    if (!isNew) el('wfSODelete').onclick = () => { closeSlideover(); deleteStep(pathStr); };
    el('wfSOSave').onclick = () => {
      collectStepForm(step);
      closeSlideover();
      renderBuilderTab();
    };
  }

  function renderStepForm(step) {
    switch (step.type) {
      case 'send_message': {
        const c = step.config;
        return `
          <input type="hidden" name="channel" value="email">
          <div class="lc-field"><label class="lc-label">Who writes it?</label>
            <select class="lc-select" name="mode" id="wfMsgMode">
              <option value="ai" ${c.mode !== 'custom' ? 'selected' : ''}>AI writes it (recommended)</option>
              <option value="custom" ${c.mode === 'custom' ? 'selected' : ''}>I will write it</option>
            </select></div>
          <div id="wfMsgAiFields" style="${c.mode === 'custom' ? 'display:none' : ''}">
            <div class="lc-field"><label class="lc-label">What should this message do?</label>
              <textarea class="lc-textarea" name="aiInstructions" placeholder="e.g. Thank them for their patience and ask if they'd like to schedule a call this week.">${esc(c.aiInstructions)}</textarea></div>
          </div>
          <div class="lc-field"><div style="font-size:11px;color:var(--text3);line-height:1.5">Sent by email to the customer. WhatsApp chats are answered automatically by the AI as soon as the customer writes, so this step does not send on WhatsApp.</div></div>
          <div id="wfMsgCustomFields" style="${c.mode === 'custom' ? '' : 'display:none'}">
            <div class="lc-field"><label class="lc-label">Subject (email only, optional)</label>
              <input class="lc-input" name="subject" value="${esc(c.subject)}" placeholder="Following up"></div>
            <div class="lc-field"><label class="lc-label">Message</label>
              <textarea class="lc-textarea" name="template" placeholder="Hi {{customerName}}, ...">${esc(c.template)}</textarea>
              <div style="font-size:11px;color:var(--text3);margin-top:6px">Merge fields: {{customerName}}, {{businessName}}, {{ownerName}}, {{serviceType}}, {{quoteTotal}}, {{phone}}, {{bookingUrl}}</div></div>
          </div>`;
      }
      case 'wait': {
        const d = step.config.duration || {};
        return `
          <div class="lc-field"><label class="lc-label">Wait duration</label>
            <div class="wf-cond-row">
              <input class="lc-input" name="durationValue" type="number" min="1" value="${d.value || 1}">
              <select class="lc-select" name="durationUnit">
                <option value="minutes" ${d.unit === 'minutes' ? 'selected' : ''}>Minutes</option>
                <option value="hours" ${(!d.unit || d.unit === 'hours') ? 'selected' : ''}>Hours</option>
                <option value="days" ${d.unit === 'days' ? 'selected' : ''}>Days</option>
              </select>
            </div></div>`;
      }
      case 'wait_for_reply': {
        const t = step.config.timeout || {};
        return `
          <div class="lc-field"><label class="lc-label">Time out after</label>
            <div class="wf-cond-row">
              <input class="lc-input" name="timeoutValue" type="number" min="1" value="${t.value || 3}">
              <select class="lc-select" name="timeoutUnit">
                <option value="hours" ${t.unit === 'hours' ? 'selected' : ''}>Hours</option>
                <option value="days" ${(!t.unit || t.unit === 'days') ? 'selected' : ''}>Days</option>
              </select>
            </div></div>
          <div style="font-size:11px;color:var(--text3)">This pauses the workflow. It creates two paths on the canvas: <b>Replied</b> and <b>No Reply</b> (after the timeout).</div>`;
      }
      case 'ai_extract': {
        const c = step.config;
        return `
          <div class="lc-field"><label class="lc-label">Field name</label>
            <input class="lc-input" name="fieldName" value="${esc(c.fieldName)}" placeholder="budget"></div>
          <div class="lc-field"><label class="lc-label">What should AI look for?</label>
            <textarea class="lc-textarea" name="instructions" placeholder="Extract any specific budget or price the customer mentioned.">${esc(c.instructions)}</textarea></div>
          <div style="font-size:11px;color:var(--text3)">Stored as <code>context.&lt;field name&gt;</code> — reference it later in a Condition step.</div>`;
      }
      case 'condition': {
        const c = step.config;
        const known = checkOf(c);
        if (known) {
          return `
            <input type="hidden" name="field" value="${esc(c.field)}"><input type="hidden" name="operator" value="${esc(c.operator)}"><input type="hidden" name="value" value="${esc(c.value)}">
            <div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:8px">${esc(known[1].text)}</div>
            <div style="font-size:11px;color:var(--text3)">Creates two paths below: <b>${esc(known[1].yes)}</b> and <b>${esc(known[1].no)}</b>. Add the steps you want on each.</div>`;
        }
        // A check from an older workflow: keep it editable exactly as before.
        const extracted = collectExtractFields(current.steps);
        return `
          <div class="lc-field"><label class="lc-label">If</label>
            <select class="lc-select" name="field">
              ${FIELD_OPTIONS.map(o => `<option value="${o.v}" ${c.field === o.v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
              ${extracted.map(f => `<option value="context.${esc(f)}" ${c.field === 'context.' + f ? 'selected' : ''}>${esc(f)} (extracted)</option>`).join('')}
            </select></div>
          <div class="wf-cond-row">
            <select class="lc-select" name="operator">
              ${OPERATORS.map(o => `<option value="${o.v}" ${c.operator === o.v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select>
            <input class="lc-input" name="value" value="${esc(c.value)}" placeholder="value">
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:8px">Creates two paths on the canvas: <b>Yes</b> and <b>No</b>.</div>`;
      }
      case 'ai_decision': {
        return `
          <div class="lc-field"><label class="lc-label">What should AI decide?</label>
            <textarea class="lc-textarea" name="instructions" placeholder="Classify how urgent this lead's request is.">${esc(step.config.instructions)}</textarea></div>
          <div style="font-size:11px;color:var(--text3)">Branches are managed on the canvas, below this step — rename them inline or use "Add branch". AI will pick exactly one branch label that best fits.</div>`;
      }
      case 'update_status': {
        const c = step.config;
        const cur = outcomeOf(c);
        const legacy = !cur ? `<option value="__keep" selected>Keep the current setting${c.status || c.stage ? ' (' + esc([c.status && (STATUS_LABELS[c.status] || c.status), c.stage].filter(Boolean).join(', ')) + ')' : ''}</option>` : '';
        return `
          <div class="lc-field"><label class="lc-label">Mark the lead as</label>
            <select class="lc-select" name="outcome">
              ${legacy}
              ${OUTCOMES.map(o => `<option value="${o.v}" ${cur && cur.v === o.v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select></div>
          <div style="font-size:11px;color:var(--text3)">Shows on the lead in your pipeline. "Won" and "Lost" close the lead.</div>`;
      }
      case 'notify_owner': {
        const c = step.config;
        return `
          <div class="lc-field"><label class="lc-label">Subject of the email to you</label>
            <input class="lc-input" name="subject" value="${esc(c.subject)}" placeholder="A lead needs your attention"></div>
          <div class="lc-field"><label class="lc-label">Message</label>
            <textarea class="lc-textarea" name="message" placeholder="Add any context for yourself here.">${esc(c.message)}</textarea></div>
          <div style="font-size:11px;color:var(--text3)">Goes to the email address on your account.</div>`;
      }
      case 'book_appointment': {
        return `
          <div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:6px">
            Creates a Google Calendar appointment for this lead by reading the conversation to extract date, time, and service details.
            Skipped automatically if an appointment is already booked for the lead.
          </div>
          <div style="font-size:11px;color:var(--text3)">Requires Google Calendar to be connected in Settings → Integrations.</div>`;
      }
      case 'add_tag':
      case 'remove_tag': {
        const c = step.config;
        const isAdd = step.type === 'add_tag';
        return `
          <div class="lc-field"><label class="lc-label">Label(s), separated by commas</label>
            <input class="lc-input" name="tags" value="${esc(c.tags)}" placeholder="e.g. qualified, high-value, follow-up"></div>
          <div style="font-size:11px;color:var(--text3)">Tags are lowercased and stored on the lead. Use a Condition step to branch on them via <code>lead.tags</code>.</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">${isAdd ? 'Adds' : 'Removes'} the listed tag(s) — ${isAdd ? 'existing tags are kept' : 'other tags are unaffected'}.</div>`;
      }
      case 'webhook': {
        const c = step.config;
        return `
          <div class="lc-field"><label class="lc-label">URL <span style="color:var(--danger)">*</span></label>
            <input class="lc-input" name="url" type="url" value="${esc(c.url)}" placeholder="https://hooks.zapier.com/hooks/catch/…"></div>
          <div class="lc-field"><label class="lc-label">Secret / token (sent as <code>X-Webhook-Secret</code> header)</label>
            <input class="lc-input" name="secret" value="${esc(c.secret)}" placeholder="optional — for signature verification at your endpoint"></div>
          <div class="lc-field"><label class="lc-label">Save response as context key (optional)</label>
            <input class="lc-input" name="responseKey" value="${esc(c.responseKey)}" placeholder="e.g. crmResult — access via context.crmResult in a Condition step"></div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">
            POSTs lead data + workflow context as JSON. If your endpoint returns JSON and you set a context key above, the response is available in subsequent Condition steps via <code>context.&lt;key&gt;.field</code>.
            Times out after 10 seconds.
          </div>`;
      }
      case 'schedule_reminder': {
        const c = step.config;
        const isCustom = c.mode === 'custom';
        return `
          <div class="lc-field"><label class="lc-label">Reminder label (internal)</label>
            <input class="lc-input" name="label" value="${esc(c.label || 'Reminder')}" placeholder="e.g. 3-day follow-up"></div>
          <div class="lc-field"><label class="lc-label">Send after</label>
            <div style="display:flex;gap:8px">
              <input class="lc-input" name="delayValue" type="number" min="1" value="${c.delay && c.delay.value != null ? c.delay.value : 1}" style="width:80px">
              <select class="lc-select" name="delayUnit" style="flex:1">
                ${['minutes','hours','days'].map(u => `<option value="${u}" ${(c.delay && c.delay.unit) === u ? 'selected' : ''}>${u}</option>`).join('')}
              </select>
            </div></div>
          <input type="hidden" name="channel" value="email">
          <div class="lc-field"><label class="lc-label">Message mode</label>
            <select class="lc-select" name="reminderMode">
              <option value="ai" ${!isCustom ? 'selected' : ''}>AI-written</option>
              <option value="custom" ${isCustom ? 'selected' : ''}>Custom message</option>
            </select></div>
          <div id="wfReminderAiFields" style="${isCustom ? 'display:none' : ''}">
            <div class="lc-field"><label class="lc-label">AI instructions</label>
              <textarea class="lc-textarea" name="aiInstructions" placeholder="e.g. Send a brief friendly check-in, mention we're still available to help.">${esc(c.aiInstructions)}</textarea></div>
          </div>
          <div id="wfReminderCustomFields" style="${!isCustom ? 'display:none' : ''}">
            <div class="lc-field"><label class="lc-label">Custom message</label>
              <textarea class="lc-textarea" name="template" placeholder="Hi {{customerName}}, just checking in…">${esc(c.template)}</textarea></div>
          </div>
          <div style="font-size:11px;color:var(--text3)">Schedules a future message without pausing the workflow. Picked up by the background poller at the right time.</div>`;
      }
      default: return '';
    }
  }

  function wireStepFormBehaviour(step) {
    if (step.type === 'send_message') {
      const sel = el('wfMsgMode');
      sel.addEventListener('change', () => {
        const isCustom = sel.value === 'custom';
        el('wfMsgAiFields').style.display = isCustom ? 'none' : '';
        el('wfMsgCustomFields').style.display = isCustom ? '' : 'none';
      });
    }
    if (step.type === 'schedule_reminder') {
      const sel = document.querySelector('[name="reminderMode"]');
      if (sel) sel.addEventListener('change', () => {
        const isCustom = sel.value === 'custom';
        const ai = el('wfReminderAiFields'); const cu = el('wfReminderCustomFields');
        if (ai) ai.style.display = isCustom ? 'none' : '';
        if (cu) cu.style.display = isCustom ? '' : 'none';
      });
    }
  }

  function collectStepForm(step) {
    switch (step.type) {
      case 'send_message':
        step.config = {
          channel: 'email',
          mode: formVal('mode') || 'ai',
          aiInstructions: formVal('aiInstructions') || '',
          subject: formVal('subject') || '',
          template: formVal('template') || '',
          ...(step.config && Array.isArray(step.config.mediaIds) && step.config.mediaIds.length ? { mediaIds: step.config.mediaIds } : {}),
        };
        break;
      case 'wait':
        step.config = { duration: { value: Number(formVal('durationValue')) || 1, unit: formVal('durationUnit') || 'hours' } };
        break;
      case 'wait_for_reply':
        step.config = { timeout: { value: Number(formVal('timeoutValue')) || 3, unit: formVal('timeoutUnit') || 'days' } };
        break;
      case 'ai_extract':
        step.config = { fieldName: (formVal('fieldName') || '').trim(), instructions: formVal('instructions') || '' };
        break;
      case 'condition':
        step.config = { field: formVal('field'), operator: formVal('operator'), value: formVal('value') || '' };
        break;
      case 'ai_decision':
        step.config = { instructions: formVal('instructions') || '' };
        break;
      case 'update_status':
        { const v = formVal('outcome');
          if (v !== '__keep') { const o = OUTCOMES.find(x => x.v === v) || OUTCOMES[0]; step.config = o.v ? { status: o.status, stage: o.stage } : { status: '', stage: undefined }; } }
        break;
      case 'notify_owner':
        step.config = { subject: formVal('subject') || '', message: formVal('message') || '' };
        break;
      case 'book_appointment':
        step.config = {};
        break;
      case 'add_tag':
      case 'remove_tag':
        step.config = { tags: (formVal('tags') || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean).join(', ') };
        break;
      case 'webhook':
        step.config = { url: (formVal('url') || '').trim(), secret: (formVal('secret') || '').trim(), responseKey: (formVal('responseKey') || '').trim() };
        break;
      case 'schedule_reminder': {
        const mode = formVal('reminderMode') || 'ai';
        step.config = {
          label:          (formVal('label') || 'Reminder').trim(),
          delay:          { value: Number(formVal('delayValue')) || 1, unit: formVal('delayUnit') || 'days' },
          channel:        'email',
          mode,
          aiInstructions: formVal('aiInstructions') || '',
          template:       formVal('template') || '',
        };
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // SAVE / ACTIVATE / PAUSE (from inside the editor)
  // ══════════════════════════════════════════════════════════════
  async function saveWorkflow() {
    current.name = el('wfEditName').value.trim() || current.name;
    current.description = el('wfEditDesc').value;
    try {
      const res = await api('/api/workflows/' + current.id, {
        method: 'PUT',
        body: JSON.stringify({ name: current.name, description: current.description, trigger: current.trigger, steps: current.steps }),
      });
      current = res.workflow;
      const idx = workflows.findIndex(w => w.id === current.id);
      if (idx > -1) workflows[idx] = current;
      toast('Workflow saved');
      renderEditor();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ══════════════════════════════════════════════════════════════
  // TEST RUN
  // ══════════════════════════════════════════════════════════════
  async function openTestModal() {
    if (!leadsCache) {
      try { const r = await api('/api/leads'); leadsCache = (r && r.leads) || []; } catch (_) { leadsCache = []; }
    }
    const wrap = document.createElement('div');
    wrap.className = 'wf-modal-overlay';
    wrap.innerHTML = `
      <div class="wf-modal">
        <div class="wf-modal-title">Test Run</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:14px">Runs this workflow against a real lead's data, but never actually sends a message or notification.</div>
        <div class="lc-field">
          <label class="lc-label">Test against</label>
          <select class="lc-select" id="wfTestLead">
            <option value="">Most recent lead</option>
            ${(leadsCache || []).map(l => `<option value="${l.id}">${esc(l.customerName || l.fromName || l.fromEmail || l.fromPhone || l.id)}</option>`).join('')}
          </select>
        </div>
        <div class="wf-modal-actions">
          <button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfTestCancel">Cancel</button>
          <button class="lc-btn lc-btn-primary lc-btn-sm" id="wfTestRun">Run Test</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    el('wfTestCancel').addEventListener('click', () => wrap.remove());
    el('wfTestRun').addEventListener('click', async () => {
      const leadId = el('wfTestLead').value;
      el('wfTestRun').disabled = true;
      el('wfTestRun').textContent = 'Running…';
      try {
        const res = await api(`/api/workflows/${current.id}/test`, { method: 'POST', body: JSON.stringify(leadId ? { leadId } : {}) });
        wrap.remove();
        showRunResult(res.run, res.events, true);
      } catch (e) { toast(e.message, 'error'); wrap.remove(); }
    });
  }

  function showRunResult(run, events, isTest) {
    slideover = { mode: 'run' };
    openSlideoverShell(isTest ? 'Test Run Result' : 'Run Detail');
    el('wfSlideoverBody').innerHTML = `
      ${isTest ? `<div style="font-size:12px;color:var(--text3);margin-bottom:16px;padding:10px 12px;background:var(--bg3);border-radius:8px">Test run — no real messages or notifications were sent.</div>` : ''}
      <div class="lc-detail-section">
        <div class="lc-detail-grid">
          <div><div class="lc-detail-key">Status</div><div class="lc-detail-val wf-run-status ${esc(run.status)}">${esc(run.status)}</div></div>
          <div><div class="lc-detail-key">Lead</div><div class="lc-detail-val">${esc(run.leadName || run.lead_id || '—')}</div></div>
        </div>
      </div>
      <div class="lc-detail-label">Step-by-step log</div>
      <div class="wf-timeline">
        ${events.length ? events.map(ev => `
          <div class="wf-timeline-item">
            <div class="wf-timeline-dot ${esc(ev.status)}"></div>
            <div>
              <div class="wf-timeline-label">${esc(ev.summary || ev.stepType || 'Step')}</div>
              <div class="wf-timeline-meta">${esc(ev.stepType || '')} · ${fmtDate(ev.createdAt)}</div>
            </div>
          </div>`).join('') : `<div class="lc-empty-text">No steps executed yet.</div>`}
      </div>
    `;
    el('wfSlideoverFooter').innerHTML = `<button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfSOClose">Close</button>`;
    el('wfSOClose').onclick = closeSlideover;
  }

  // ══════════════════════════════════════════════════════════════
  // ACTIVITY (run history) TAB
  // ══════════════════════════════════════════════════════════════
  async function renderRunsTab() {
    const body = el('wfEditorBody');
    body.innerHTML = `<div class="lc-empty" style="margin-top:30px"><div class="lc-spinner" style="margin:0 auto"></div></div>`;
    try {
      const res = await api(`/api/workflows/${current.id}/runs`);
      runsCache = (res && res.runs) || [];
    } catch (e) {
      body.innerHTML = `<div class="lc-empty"><div class="lc-empty-text">${esc(e.message)}</div></div>`;
      return;
    }
    if (!runsCache.length) {
      body.innerHTML = `<div class="lc-empty" style="margin-top:30px">
        <div class="lc-empty-title">No activity yet</div>
        <div class="lc-empty-text">Once this workflow is active, every lead it runs for will show up here.</div>
      </div>`;
      return;
    }
    body.innerHTML = `<div>${runsCache.map(r => `
      <div class="wf-run-row" onclick="window.WorkflowsUI._viewRun('${r.id}')">
        <div style="flex:1;min-width:0">
          <div class="wf-run-lead">${esc(r.leadName)}</div>
          <div class="wf-run-meta">Started ${fmtDate(r.startedAt)}${r.dryRun ? ' · test run' : ''}</div>
        </div>
        <span class="wf-run-status ${esc(r.status)}">${esc(r.status)}</span>
      </div>`).join('')}</div>`;
  }

  async function viewRun(runId) {
    try {
      const res = await api('/api/workflows/runs/' + runId);
      showRunResultFull(res.run, res.events);
    } catch (e) { toast(e.message, 'error'); }
  }

  function showRunResultFull(run, events) {
    slideover = { mode: 'run' };
    openSlideoverShell('Run Detail');
    const canCancel = run.status === 'running' || run.status === 'waiting';
    const canRetry = run.status === 'failed';
    el('wfSlideoverBody').innerHTML = `
      <div class="lc-detail-section">
        <div class="lc-detail-grid">
          <div><div class="lc-detail-key">Status</div><div class="lc-detail-val wf-run-status ${esc(run.status)}">${esc(run.status)}</div></div>
          <div><div class="lc-detail-key">Lead</div><div class="lc-detail-val">${esc(run.leadName || '—')}</div></div>
          <div><div class="lc-detail-key">Started</div><div class="lc-detail-val">${fmtDate(run.startedAt)}</div></div>
          <div><div class="lc-detail-key">Updated</div><div class="lc-detail-val">${fmtDate(run.updatedAt)}</div></div>
        </div>
        ${run.errorMessage ? `<div style="margin-top:12px;font-size:12px;color:var(--text2);background:var(--bg3);border-radius:8px;padding:10px 12px">${esc(run.errorMessage)}</div>` : ''}
      </div>
      <div class="lc-detail-label">Step-by-step log</div>
      <div class="wf-timeline">
        ${events.length ? events.map(ev => `
          <div class="wf-timeline-item">
            <div class="wf-timeline-dot ${esc(ev.status)}"></div>
            <div>
              <div class="wf-timeline-label">${esc(ev.summary || ev.stepType || 'Step')}</div>
              <div class="wf-timeline-meta">${esc(ev.stepType || '')} · ${fmtDate(ev.createdAt)}</div>
            </div>
          </div>`).join('') : `<div class="lc-empty-text">No steps executed yet.</div>`}
      </div>
    `;
    el('wfSlideoverFooter').innerHTML = `
      ${canCancel ? `<button class="lc-btn lc-btn-danger lc-btn-sm" id="wfRunCancel">Cancel Run</button>` : ''}
      ${canRetry ? `<button class="lc-btn lc-btn-primary lc-btn-sm" id="wfRunRetry">Retry</button>` : ''}
      <button class="lc-btn lc-btn-ghost lc-btn-sm" id="wfSOClose" style="margin-left:auto">Close</button>
    `;
    el('wfSOClose').onclick = closeSlideover;
    if (canCancel) el('wfRunCancel').onclick = async () => {
      try { await api(`/api/workflows/runs/${run.id}/cancel`, { method: 'POST' }); toast('Run cancelled'); closeSlideover(); renderRunsTab(); }
      catch (e) { toast(e.message, 'error'); }
    };
    if (canRetry) el('wfRunRetry').onclick = async () => {
      try { await api(`/api/workflows/runs/${run.id}/retry`, { method: 'POST' }); toast('Run retried'); closeSlideover(); renderRunsTab(); }
      catch (e) { toast(e.message, 'error'); }
    };
  }

  function switchTab(tab) { editorTab = tab; renderEditor(); }
  function backToList() { current = null; render(); }

  async function pauseWorkflow(id) {
    try {
      await api(`/api/workflows/${id}/pause`, { method: 'POST' });
      toast('Workflow paused');
      if (current && current.id === id) { const r = await api('/api/workflows/' + id); current = r.workflow; renderEditor(); }
      else { await render(); }
    } catch (e) { toast(e.message, 'error'); }
  }
  async function activateWorkflow(id) {
    try {
      const res = await api(`/api/workflows/${id}/activate`, { method: 'POST' });
      toast('Workflow activated');
      if (current && current.id === id) { current = res.workflow; renderEditor(); }
      else { await render(); }
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Public API (used by inline onclick handlers above) ───────
  window.WorkflowsUI = {
    render,
    _open: openWorkflow,
    _openNewModal: openNewModal,
    _useTemplate: useTemplate,
    _pause: pauseWorkflow,
    _activate: activateWorkflow,
    _deleteWorkflow: deleteWorkflow,
    _backToList: backToList,
    _save: saveWorkflow,
    _switchTab: switchTab,
    _editTrigger: editTrigger,
    _openAddStep: openAddStep,
    _pickType: pickType,
    _editStep: editStep,
    _deleteStep: deleteStep,
    _renameBranch: renameBranch,
    _addBranch: addBranch,
    _removeBranch: removeBranch,
    _openTestModal: openTestModal,
    _viewRun: viewRun,
  };
})();
