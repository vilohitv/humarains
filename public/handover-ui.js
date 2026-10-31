/**
 * handover-ui.js — human handover in the Classic dashboard.
 *
 *   Settings → "Human handover": switch it on, choose the moments, list the people and the jobs each one handles.
 *   A lead's panel: who the conversation was handed to (and whether they were told), a button to give it back to the AI,
 *   and a button to hand a lead over by hand.
 *
 * The Settings section is written into dashboard.html and leads.html; this file wires it up (and builds it itself if a page lacks it). Talks to /api/leads/handover.
 */
(function () {
  'use strict';

  const esc = s => (s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const $ = id => document.getElementById(id);

  function csrf() {
    try { const m = document.cookie.split('; ').find(r => r.startsWith('bp_csrf=')); return m ? decodeURIComponent(m.split('=')[1]) : ''; } catch (_) { return ''; }
  }
  async function api(path, opts) {
    const res = await fetch('/api/leads' + path, { credentials: 'include', ...(opts || {}),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf(), ...((opts && opts.headers) || {}) } });
    let data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || data.success === false) throw new Error((data && data.message) || 'Something went wrong. Please try again.');
    return data;
  }
  // A small toast of its own: the dashboard's toast lives inside leads.js and is not reachable from here.
  function say(msg, type) {
    let box = $('hoToast');
    if (!box) {
      box = document.createElement('div'); box.id = 'hoToast';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      box.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10000;max-width:340px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.45;box-shadow:0 6px 24px rgba(0,0,0,.18);display:none;background:#111;color:#fff;';
      document.body.appendChild(box);
    }
    box.style.background = type === 'error' ? '#b3261e' : '#111';
    box.textContent = msg; box.style.display = 'block';
    clearTimeout(box._t); box._t = setTimeout(() => { box.style.display = 'none'; }, 4200);
  }

  const STAGE_LABELS = {
    quoted:            ['A quote has been sent', 'Early: hand over as soon as they have a quote.'],
    booking_requested: ['They want to book', 'Recommended: they have said they want to go ahead.'],
    deal_closed:       ['They have said yes', 'They confirmed. Use this on its own if you want the AI to run the whole sale.'],
  };

  let state = { enabled: false, stages: ['booking_requested', 'deal_closed'], contacts: [], copyOwner: true };
  let services = [];
  let stageChoices = Object.keys(STAGE_LABELS);
  let loaded = false;

  // ───────────────────────── Settings panel ─────────────────────────

  function sectionHtml() {
    return `
      <div class="lc-settings-title">Human handover</div>
      <div class="lc-settings-sub">When a customer is ready to book, the AI stops replying and passes the conversation to the right person on your team, with the customer's phone number and email. The AI tells the customer who will be in touch.</div>
      <label style="display:flex;align-items:center;gap:10px;margin:14px 0 4px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="hoEnabled"> <span>Hand over to a person when a customer is ready to book</span>
      </label>
      <div id="hoBody">
        <div class="lc-label" style="margin-top:18px;">Hand over when</div>
        <div id="hoStages" style="display:grid;gap:8px;margin:6px 0 4px;"></div>

        <div class="lc-label" style="margin-top:20px;">Your team</div>
        <div style="font-size:12px;color:var(--text3);line-height:1.5;margin-bottom:10px;">
          List the jobs each person handles (for example "roof repair, gutters"). The AI matches the customer's job to a person.
          Someone marked "everything else" gets leads that match nobody. If there is no match and no such person, the handover comes to you.
        </div>
        <div id="hoContacts"></div>
        <button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" id="hoAdd">+ Add a person</button>

        <label style="display:flex;align-items:center;gap:10px;margin:18px 0 0;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="hoCopy"> <span>Copy me (the owner) on every handover</span>
        </label>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:18px;">
        <button type="button" class="lc-btn lc-btn-primary" id="hoSave">Save handover settings</button>
        <span id="hoMsg" style="font-size:12px;color:var(--text3);"></span>
      </div>`;
  }

  function contactCard(c, i) {
    const chips = services.filter(sv => !(c.jobs || []).includes(String(sv).toLowerCase()))
      .slice(0, 8).map(sv => `<button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" data-ho-chip="${i}" data-job="${esc(sv)}" style="padding:2px 8px;font-size:11px;">+ ${esc(sv)}</button>`).join(' ');
    return `
      <div class="ho-card" data-i="${i}" style="border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:10px;background:var(--bg2, transparent);">
        <div class="lc-settings-grid">
          <div class="lc-field"><label class="lc-label">Name</label><input class="lc-input" data-f="name" value="${esc(c.name)}" placeholder="Sam Rivera"></div>
          <div class="lc-field"><label class="lc-label">Role (optional)</label><input class="lc-input" data-f="role" value="${esc(c.role)}" placeholder="Roofing lead"></div>
          <div class="lc-field"><label class="lc-label">Email</label><input class="lc-input" data-f="email" type="email" value="${esc(c.email)}" placeholder="sam@yourbusiness.com"></div>
          <div class="lc-field"><label class="lc-label">Phone</label><input class="lc-input" data-f="phone" value="${esc(c.phone)}" placeholder="+1 555 000 1234"></div>
        </div>
        <div class="lc-field"><label class="lc-label">Jobs they handle (separate with commas)</label>
          <input class="lc-input" data-f="jobs" value="${esc((c.jobs || []).join(', '))}" placeholder="roof repair, gutters">
          ${chips ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;"><input type="checkbox" data-f="isDefault" ${c.isDefault ? 'checked' : ''}> Handles everything else</label>
          <button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" data-ho-remove="${i}">Remove</button>
        </div>
      </div>`;
  }

  function readCards() {
    return Array.from(document.querySelectorAll('#hoContacts .ho-card')).map((card, i) => {
      const prev = state.contacts[i] || {};
      const val = f => { const e = card.querySelector(`[data-f="${f}"]`); return e ? e.value : ''; };
      const def = card.querySelector('[data-f="isDefault"]');
      return { id: prev.id, name: val('name'), role: val('role'), email: val('email'), phone: val('phone'), jobs: val('jobs').split(',').map(j => j.trim()).filter(Boolean), isDefault: !!(def && def.checked), active: prev.active !== false };
    });
  }

  function renderSettings() {
    const sec = $('handoverSection'); if (!sec) return;
    $('hoEnabled').checked = !!state.enabled;
    $('hoCopy').checked = state.copyOwner !== false;
    $('hoBody').style.opacity = state.enabled ? '1' : '.5';
    $('hoStages').innerHTML = stageChoices.map(k => {
      const [label, hint] = STAGE_LABELS[k] || [k, ''];
      return `<label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-ho-stage="${esc(k)}" ${state.stages.includes(k) ? 'checked' : ''} style="margin-top:3px;">
        <span>${esc(label)}<span style="display:block;font-size:11px;color:var(--text3);">${esc(hint)}</span></span></label>`;
    }).join('');
    $('hoContacts').innerHTML = state.contacts.length
      ? state.contacts.map(contactCard).join('')
      : '<div style="font-size:12px;color:var(--text3);margin-bottom:10px;">No one added yet. Until you add someone, handovers come to you.</div>';
  }

  function injectSection() {
    const view = $('view-settings'); if (!view) return false;
    let sec = $('handoverSection');
    if (sec && sec.dataset.hoWired) return true;
    if (!sec) {                       // Fallback only: the section is normally written straight into the page.
      sec = document.createElement('div');
      sec.className = 'lc-settings-section';
      sec.id = 'handoverSection';
      const anchor = $('serviceTimingSection');
      if (anchor && anchor.parentNode === view) view.insertBefore(sec, anchor); else view.appendChild(sec);
    }
    if (!sec.querySelector('#hoEnabled')) sec.innerHTML = sectionHtml();
    sec.dataset.hoWired = '1';

    sec.addEventListener('change', e => {
      if (e.target.id === 'hoEnabled') { state.enabled = e.target.checked; $('hoBody').style.opacity = state.enabled ? '1' : '.5'; }
      if (e.target.dataset && e.target.dataset.hoStage) {
        const k = e.target.dataset.hoStage;
        state.stages = e.target.checked ? [...new Set([...state.stages, k])] : state.stages.filter(x => x !== k);
      }
      if (e.target.id === 'hoCopy') state.copyOwner = e.target.checked;
      if (e.target.dataset && e.target.dataset.f === 'isDefault' && e.target.checked) {       // only one person handles "everything else"
        sec.querySelectorAll('[data-f="isDefault"]').forEach(o => { if (o !== e.target) o.checked = false; });
      }
    });
    sec.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'hoAdd') {
        state.contacts = readCards();
        if (state.contacts.length >= 20) { $('hoMsg').textContent = 'You can add up to 20 people.'; return; }
        state.contacts.push({ name: '', role: '', email: '', phone: '', jobs: [], isDefault: false, active: true });
        renderSettings();
      } else if (t.dataset.hoRemove != null) {
        state.contacts = readCards(); state.contacts.splice(Number(t.dataset.hoRemove), 1); renderSettings();
      } else if (t.dataset.hoChip != null) {
        const i = Number(t.dataset.hoChip); state.contacts = readCards();
        const c = state.contacts[i]; c.jobs = [...(c.jobs || []), t.dataset.job];
        renderSettings();
      } else if (t.id === 'hoSave') save();
    });
    return true;
  }

  async function save() {
    const btn = $('hoSave'), msg = $('hoMsg');
    state.contacts = readCards();
    btn.disabled = true; msg.style.color = 'var(--text3)'; msg.textContent = 'Saving...';
    try {
      const out = await api('/handover', { method: 'PUT', body: JSON.stringify({ enabled: state.enabled, stages: state.stages, contacts: state.contacts, copyOwner: state.copyOwner }) });
      state = { ...out.handover };
      renderSettings();
      $('hoMsg').style.color = 'var(--text2)'; $('hoMsg').textContent = 'Saved.';
      say('Handover settings saved', 'success');
      cache = null;
    } catch (e) { msg.style.color = '#b3261e'; msg.textContent = e.message; }
    finally { btn.disabled = false; }
  }

  async function loadSettings() {
    if (!injectSection()) return;
    try {
      const out = await api('/handover');
      state = { ...out.handover }; services = out.services || []; stageChoices = out.stageChoices || stageChoices; loaded = true;
      renderSettings();
    } catch (e) { const m = $('hoMsg'); if (m) m.textContent = e.message; }
  }

  // ───────────────────────── A lead's panel ─────────────────────────

  let cache = null;       // the team, for the "hand over" picker
  async function team() { if (!cache) { try { cache = (await api('/handover')).handover.contacts || []; } catch (_) { cache = []; } } return cache; }

  function when(iso) { try { return iso ? new Date(iso).toLocaleString() : ''; } catch (_) { return ''; } }
  const HOW = { job: 'matched to the job', default: 'handles everything else', owner: 'no one matched, so it came to you', manual: 'handed over by you' };

  function blockHtml(lead, people) {
    const h = lead.handover;
    const wrap = inner => `<div class="lc-detail-label">Handover</div>${inner}`;
    if (h && (h.status === 'active' || h.status === 'pending')) {
      const who = esc(h.contactName || 'you');
      const warn = h.notifyError
        ? `<div style="margin-top:8px;font-size:12px;color:#b3261e;line-height:1.5;">They could not be told: ${esc(h.notifyError)}. Contact the customer yourself.</div>`
        : (h.notifiedAt ? `<div style="margin-top:6px;font-size:11px;color:var(--text3);">${who} was emailed the customer's details on ${esc(when(h.notifiedAt))}.</div>` : '');
      return wrap(`
        <div style="padding:12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg3);">
          <div style="font-size:13px;font-weight:600;">Handed to ${who}</div>
          <div style="font-size:12px;color:var(--text3);margin-top:2px;">${esc(HOW[h.matchedBy] || '')}. The AI is no longer replying on this conversation.</div>
          ${warn}
          <div style="margin-top:10px;"><button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" id="hoResume">Give it back to the AI</button></div>
        </div>`);
    }
    if (h && h.status === 'resumed') {
      return wrap(`<div style="font-size:12px;color:var(--text3);line-height:1.5;">This conversation was handed to ${esc(h.contactName || 'a person')} and then given back to the AI.</div>`);
    }
    const opts = ['<option value="">Me (the owner)</option>'].concat(people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.role ? ' — ' + esc(p.role) : ''}</option>`)).join('');
    return wrap(`
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <select class="lc-select" id="hoPick" style="max-width:240px;">${opts}</select>
        <button type="button" class="lc-btn lc-btn-ghost lc-btn-sm" id="hoNow">Hand over now</button>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--text3);">They get an email with the customer's phone and email. The AI stops replying.</div>`);
  }

  async function mountBlock() {
    const body = $('lcSlideoverBody'); const lead = window.HM_ACTIVE_LEAD;
    if (!body || !lead || body.querySelector('#hoBlock')) return;
    const first = body.querySelector('.lc-detail-section'); if (!first) return;
    const box = document.createElement('div');
    box.className = 'lc-detail-section'; box.id = 'hoBlock';
    first.after(box);                                           // placed first so the guard above stops a second one
    const people = (lead.handover && ['active', 'pending'].includes(lead.handover.status)) ? [] : await team();
    box.innerHTML = blockHtml(lead, people);
    wireBlock(box, lead);
  }

  function wireBlock(box, lead) {
    const resume = box.querySelector('#hoResume');
    if (resume) resume.addEventListener('click', async () => {
      resume.disabled = true;
      try { const out = await api('/' + encodeURIComponent(lead.id) + '/handover/resume', { method: 'POST', body: '{}' }); lead.handover = out.lead.handover; say('The AI is handling this conversation again', 'success'); }
      catch (e) { say(e.message, 'error'); resume.disabled = false; return; }
      box.innerHTML = blockHtml(lead, []); wireBlock(box, lead);
    });
    const now = box.querySelector('#hoNow');
    if (now) now.addEventListener('click', async () => {
      const contactId = box.querySelector('#hoPick').value || null;
      now.disabled = true; now.textContent = 'Handing over...';
      try {
        const out = await api('/' + encodeURIComponent(lead.id) + '/handover', { method: 'POST', body: JSON.stringify({ contactId }) });
        lead.handover = out.lead.handover; lead.tags = out.lead.tags || lead.tags;
        say(out.delivered ? 'Handed over. They have been emailed the customer\'s details.' : 'Handed over, but they could not be emailed. Contact the customer yourself.', out.delivered ? 'success' : 'error');
      } catch (e) { say(e.message, 'error'); now.disabled = false; now.textContent = 'Hand over now'; return; }
      box.innerHTML = blockHtml(lead, []); wireBlock(box, lead);
    });
  }

  // ───────────────────────── Wiring ─────────────────────────

  function init() {
    const view = $('view-settings');
    if (view) {
      injectSection();
      new MutationObserver(() => { if (view.classList.contains('active')) loadSettings(); }).observe(view, { attributes: true, attributeFilter: ['class'] });
      if (view.classList.contains('active')) loadSettings();
    }
    const body = $('lcSlideoverBody');
    if (body) new MutationObserver(() => { mountBlock(); }).observe(body, { childList: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
