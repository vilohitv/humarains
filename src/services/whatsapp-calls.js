/**
 * services/whatsapp-calls.js — text back customers whose WhatsApp call was missed.
 *
 * Flow
 *   1. Meta's `calls` webhook reports a customer call that ended without being answered (parseMissedCalls in
 *      services/whatsapp.js). handleCallEvents() records the call as the customer contacting the business (it opens the
 *      24-hour window and is their opt-in) and queues a text-back in agent_actions. The queue key is the call id, so a
 *      webhook Meta delivers twice produces one text-back. The webhook does nothing else and always answers 200.
 *   2. The worker (job `missed_calls`, every 30 s) sends whatever is due: the owner's wording, in their own words, after
 *      the delay they chose. The customer then replies into the normal WhatsApp flow and the AI takes the conversation.
 *
 * Rules, all enforced here and not by the caller
 *   - Only when the owner switched "Text back missed WhatsApp calls" on (and the plan has WhatsApp). The switch is re-read at
 *     send time, so turning it off or pausing the Agent stops text-backs that were already queued.
 *   - Every message goes through sendGuarded (services/wa-consent.js): consent, opt-out and the 24-hour window.
 *   - The owner's monthly WhatsApp message quota applies.
 *   - Nobody is texted who opted out, is marked do-not-contact, already has a person from the team on their conversation, or
 *     wrote to the business after the call (the AI has already answered them).
 *   - At most once: a send that may have been delivered (timeout, server error, a crash mid-send) is never retried.
 *
 * The text is fixed wording with a few merge fields (see CALL_FIELDS in autonomy.js). The AI does not write it, so what a
 * customer receives is exactly what the owner approved.
 */
'use strict';

const autonomy = require('./agent/autonomy');

const MAX_ATTEMPTS = 3;
const RETRY_MS = 2 * 60_000;
const STUCK_MS = 10 * 60_000;
const BATCH = 20;
const CALL_MARKER = '[Missed WhatsApp call]';

const parseJ = v => { if (v == null) return v; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };

async function userByPhoneNumberId(db, pid) {
  if (!pid) return null;
  return db.queryOne(`SELECT * FROM users WHERE integrations->'whatsapp'->>'phoneNumberId' = $1 AND NOT COALESCE(is_banned,false) LIMIT 1`, [String(pid)]).catch(() => null);
}
function waCreds(user) {
  const intg = parseJ(user.integrations) || {};
  const wa = intg.whatsapp || {};
  return { phoneNumberId: wa.phoneNumberId || null, accessToken: wa.accessToken || null };
}

// ── 1. Webhook ───────────────────────────────────────────────────
/** Record missed calls from a webhook body and queue their text-backs. Never throws. Returns how many were queued. */
async function handleCallEvents(db, body) {
  let queued = 0;
  try {
    const { parseMissedCalls } = require('./whatsapp');
    const consent = require('./wa-consent');
    for (const call of parseMissedCalls(body)) {
      try {
        const user = await userByPhoneNumberId(db, call.phoneNumberId);
        if (!user) continue;
        const calledAt = new Date(call.at);
        const at = (!isNaN(calledAt) && calledAt.getTime() <= Date.now()) ? calledAt : new Date();
        // Their call is contact from them: it opens the window, whether or not we text back.
        if (call.phone) await consent.recordCall(db, user.id, call.phone, { now: at });
        const policy = await autonomy.getPolicy(db, user.id);
        if (autonomy.effectiveMode(policy, 'missed_call', user) !== 'auto') continue;     // switched off, paused, or no WhatsApp on the plan
        if (!call.phone) {
          await autonomy.logAction(db, { userId: user.id, kind: 'missed_call', channel: 'whatsapp', status: 'skipped', dedupeKey: 'call:' + call.callId,
            reason: 'WhatsApp did not share this caller\'s number (they use a WhatsApp username), so there is nothing to text.', detail: { callId: call.callId, name: call.name } });
          continue;
        }
        const delay = policy.actions.missed_call.delayMinutes;
        const runAfter = new Date(Math.max(Date.now(), at.getTime()) + delay * 60_000);
        const id = await autonomy.logAction(db, { userId: user.id, kind: 'missed_call', channel: 'whatsapp', status: 'queued', dedupeKey: 'call:' + call.callId,
          runAfter: runAfter.toISOString(), detail: { callId: call.callId, phone: call.phone, name: call.name, calledAt: at.toISOString() } });
        if (id) queued++;
      } catch (e) { console.error('[Calls] could not queue a missed call:', e.message); }
    }
  } catch (e) { console.warn('[Calls] webhook handling failed:', e.message); }
  return queued;
}

// ── 2. Sending ───────────────────────────────────────────────────
function opensWhen(settings, now) {
  try {
    const { normalizeSchedule, openStatus } = require('../lib/business-hours');
    const st = openStatus(normalizeSchedule(settings), settings.timezone, now);
    return { open: !!st.open, when: !st.open && st.next ? `${st.next.when} at ${st.next.time}` : 'as soon as we can' };
  } catch (_) { return { open: true, when: 'as soon as we can' }; }
}

/** The text for this caller, from the owner's wording. Pure; exported for tests. */
function composeTextBack(cfg, settings, name, now = new Date()) {
  const hours = opensWhen(settings, now);
  const tpl = hours.open ? cfg.message : cfg.afterHoursMessage;
  const first = String(name || '').trim().split(/\s+/)[0];
  const body = autonomy.fillTemplate(tpl, {
    customerName: first || 'there', businessName: settings.businessName || 'us', ownerName: settings.ownerName || '',
    bookingUrl: settings.bookingUrl || '', opensWhen: hours.when,
  });
  return body.slice(0, 900);
}

async function finish(db, id, status, reason, extra) {
  await db.query(
    `UPDATE agent_actions SET status=$2, reason=$3, done_at=NOW(), detail = detail || $4::jsonb WHERE id=$1`,
    [id, status, reason || null, JSON.stringify(extra || {})]);
}

/** The lead for this caller: their open WhatsApp conversation, or a new one created for the call. */
async function leadForCall(db, user, row, detail, settings) {
  const { rowToLead, storeLead } = require('../routes/leads');
  const { normalizeLead } = require('./leads/engine');
  const existing = await db.queryOne(
    `SELECT * FROM leads WHERE user_id=$1 AND whatsapp_thread_phone=$2 AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`, [user.id, detail.phone]);
  if (existing) return rowToLead(existing);
  const lead = normalizeLead({ source: 'whatsapp', fromPhone: detail.phone, fromName: detail.name, body: CALL_MARKER, whatsappThreadPhone: detail.phone });
  const calledAt = detail.calledAt || new Date().toISOString();
  Object.assign(lead, {
    customerName: detail.name || null, summary: 'Missed WhatsApp call', status: 'new',
    lastCustomerMessage: CALL_MARKER, lastCustomerMessageAt: calledAt,
    conversationHistory: [{ role: 'customer', body: CALL_MARKER, sentAt: calledAt }],
  });
  await storeLead(user.id, lead, db, { strict: true });
  return lead;
}

/** Send one queued text-back. Returns the final status. */
async function sendOne(db, row) {
  const detail = parseJ(row.detail) || {};
  const user = await db.queryOne('SELECT * FROM users WHERE id=$1 AND NOT COALESCE(is_banned,false)', [row.user_id]).catch(() => null);
  if (!user) { await finish(db, row.id, 'cancelled', 'The account is no longer active.'); return 'cancelled'; }

  const leadsApi = require('../routes/leads');
  const policy = await autonomy.getPolicy(db, user.id);
  if (autonomy.effectiveMode(policy, 'missed_call', user) !== 'auto') { await finish(db, row.id, 'cancelled', 'Text-back for missed calls was switched off or paused before this was sent.'); return 'cancelled'; }
  const creds = waCreds(user);
  if (!creds.phoneNumberId || !creds.accessToken) { await finish(db, row.id, 'skipped', 'WhatsApp is not connected.'); return 'skipped'; }

  const quota = await leadsApi.checkWhatsAppQuota(user.id, user, db);
  if (!quota.allowed) { await finish(db, row.id, 'skipped', leadsApi.whatsappQuotaExceededMessage(quota)); return 'skipped'; }

  const settings = await leadsApi.getSettings(user.id, db).catch(() => ({}));
  const lead = await leadForCall(db, user, row, detail, settings);

  const tags = Array.isArray(lead.tags) ? lead.tags : [];
  if (tags.includes('do-not-contact')) { await finish(db, row.id, 'skipped', 'This customer asked not to be contacted.', { leadId: lead.id }); await db.query('UPDATE agent_actions SET lead_id=$2 WHERE id=$1', [row.id, lead.id]); return 'skipped'; }
  await db.query('UPDATE agent_actions SET lead_id=$2 WHERE id=$1', [row.id, lead.id]);
  if (lead.handover && lead.handover.status === 'active') { await finish(db, row.id, 'skipped', 'A person on your team already has this customer\'s conversation.'); return 'skipped'; }
  const calledAt = new Date(detail.calledAt || row.created_at).getTime();
  if (lead.lastCustomerMessageAt && new Date(lead.lastCustomerMessageAt).getTime() > calledAt + 1000) { await finish(db, row.id, 'skipped', 'The customer wrote to you after calling, so the AI has already replied.'); return 'skipped'; }

  const body = composeTextBack(policy.actions.missed_call, settings, detail.name || lead.customerName);
  const { sendGuarded, WhatsAppBlocked } = require('./wa-consent');
  let wid;
  try {
    wid = (await sendGuarded({ db, userId: user.id, to: detail.phone, body, phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken })).id;
  } catch (e) {
    if (e instanceof WhatsAppBlocked || e.whatsappBlocked) { await finish(db, row.id, 'skipped', e.message); return 'skipped'; }
    if (e.retryable && row.attempts < MAX_ATTEMPTS) {                       // refused for a transient reason: nothing was sent, try again shortly
      await db.query(`UPDATE agent_actions SET status='queued', run_after=$2, reason=$3 WHERE id=$1`, [row.id, new Date(Date.now() + RETRY_MS).toISOString(), 'Retrying: ' + e.message]);
      return 'queued';
    }
    await finish(db, row.id, 'failed', e.ambiguous ? `May or may not have been delivered, so it was not sent again: ${e.message}` : e.message);
    return 'failed';
  }

  // Sent. Keep the conversation record straight so the customer's reply lands in the same thread.
  const nowIso = new Date().toISOString();
  const history = Array.isArray(lead.conversationHistory) ? lead.conversationHistory.slice() : [];
  if (!history.some(t => t.role === 'customer' && t.body === CALL_MARKER && t.sentAt === detail.calledAt)) history.push({ role: 'customer', body: CALL_MARKER, sentAt: detail.calledAt || nowIso });
  history.push({ role: 'agent', body, sentAt: nowIso, pending: false, via: 'missed_call' });
  await leadsApi.updateLead(user.id, lead.id, {
    conversationHistory: history, sentAt: nowIso, status: lead.status === 'closed' ? 'closed' : 'pending_followup',
    lastCustomerMessage: CALL_MARKER, lastCustomerMessageAt: detail.calledAt || nowIso,
  }, db).catch(e => console.error('[Calls] sent, but the lead could not be updated:', e.message));
  // Tags are not part of storeLead; they are set directly (like the follow-up and do-not-contact tags).
  await db.query(`UPDATE leads SET tags = COALESCE(tags,'[]'::jsonb) || '["missed-call"]'::jsonb WHERE id=$1 AND user_id=$2 AND NOT (COALESCE(tags,'[]'::jsonb) @> '["missed-call"]'::jsonb)`, [lead.id, user.id]).catch(() => {});
  await leadsApi.incrementWhatsAppSends(user.id, db);
  await finish(db, row.id, 'sent', null, { message: body, wid });
  return 'sent';
}

/** Send everything that is due. Safe to run from several processes at once. */
async function processDue(db) {
  // A row left "sending" by a crash may or may not have gone out. It is never sent again.
  await db.query(
    `UPDATE agent_actions SET status='failed', reason='Interrupted while sending, so it may or may not have been delivered. It was not sent again.', done_at=NOW()
      WHERE kind='missed_call' AND status='sending' AND updated_at < NOW() - ($1 || ' milliseconds')::interval`, [String(STUCK_MS)]).catch(() => {});
  const claimed = await db.queryAll(
    `UPDATE agent_actions SET status='sending', attempts = attempts + 1
      WHERE id IN (SELECT id FROM agent_actions WHERE kind='missed_call' AND status='queued' AND run_after <= NOW() ORDER BY run_after LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING *`, []);
  const results = { sent: 0, skipped: 0, failed: 0, cancelled: 0, queued: 0 };
  for (const row of claimed) {
    try { results[await sendOne(db, row)]++; }
    catch (e) {
      console.error('[Calls] text-back failed:', e.message);
      await finish(db, row.id, 'failed', 'Something went wrong before it was sent: ' + e.message).catch(() => {});
      results.failed++;
    }
  }
  return { claimed: claimed.length, ...results };
}

const tick = db => processDue(db);

module.exports = { handleCallEvents, processDue, tick, sendOne, composeTextBack, CALL_MARKER };
