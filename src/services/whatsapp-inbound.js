/**
 * services/whatsapp-inbound.js — handle one customer's batch of WhatsApp messages.
 *
 * Called by the inbound queue worker (services/inbound-queue.js), never by the
 * webhook. The work is split into steps whose completion is saved to the queue
 * row (`progress`), so a retry after a crash or a transient failure carries on from
 * the last finished step and never produces a second reply:
 *
 *   generated     the AI ran and the lead (with the drafted reply) is saved
 *   sending       about to call WhatsApp; set before the call
 *   replySent     WhatsApp accepted the reply; set right after
 *   bookkept      the lead record shows the reply as sent, follow-ups scheduled
 *   workflowsFired
 *
 * Sending is at-most-once. If a send fails in a way where the message may still have
 * been delivered (timeout, 5xx) or a previous attempt stopped mid-send, the lead goes
 * to Human Review instead of risking a duplicate to the customer. A send that was
 * definitely refused for a transient reason (429/503, no connection) is retried.
 */
'use strict';

const MODEL_ID = () => process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function replyText(aiReply) {
  if (!aiReply) return '';
  return typeof aiReply === 'string' ? aiReply : (aiReply.body || '');
}

async function flagReview(updateLead, userId, leadId, db, reason) {
  await updateLead(userId, leadId, { needsHumanReview: true, humanReviewReason: reason }, db);
}

async function processWhatsAppBatch(db, msg, ctx) {
  const { progress, saveProgress } = ctx;
  const { storeLead, getSettings, updateLead, getLeadById, rowToLead } = require('../routes/leads');
  const { sendWhatsAppMessage, markMessageRead, downloadMedia } = require('./whatsapp');
  const { normalizeLead, processLead, processReply, assessCustomerPhotos, photoAnalysisNote } = require('./leads/engine');

  // ── Which account owns this WhatsApp number? ───────────────
  const pid = msg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  let userRows = await db.queryAll(`SELECT * FROM users WHERE integrations->'whatsapp'->>'phoneNumberId' = $1 LIMIT 1`, [pid]);
  if (!userRows.length && pid) userRows = await db.queryAll(`SELECT * FROM users WHERE integrations::text LIKE $1 LIMIT 1`, [`%${pid}%`]);
  if (!userRows.length) { console.warn('[WhatsApp] No user found for phoneNumberId', pid); return; }   // permanent: nothing to retry
  const user = userRows[0];
  const userId = user.id;

  const intg = (() => { try { const r = user.integrations; return typeof r === 'object' ? r : JSON.parse(r || '{}'); } catch (_) { return {}; } })();
  const waPid   = intg?.whatsapp?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const waToken = intg?.whatsapp?.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
  const creds = { phoneNumberId: waPid, accessToken: waToken };

  // ── Already finished, or interrupted mid-send ──────────────
  if (progress.replySent && progress.bookkept && progress.workflowsFired) return;
  if (progress.sending && !progress.replySent && !progress.sendFailed) {
    // A previous attempt stopped between "about to send" and "sent". We cannot know whether the customer got it.
    console.warn(`[WhatsApp] Not resending: a previous attempt for lead ${progress.leadId} stopped mid-send`);
    await flagReview(updateLead, userId, progress.leadId, db, 'A reply was being sent when processing was interrupted, so it may or may not have reached the customer. Check the conversation before replying.');
    return;
  }

  if (!progress.read) {
    (msg.messageIds || [msg.messageId]).forEach(id => markMessageRead({ messageId: id, phoneNumberId: waPid, accessToken: waToken }).catch(() => {}));
    await saveProgress({ read: true });
  }

  // Their message is their opt-in, and the start of the real 24-hour window (services/wa-consent.js). "Not right now",
  // "no thanks" and the template buttons mean: no follow-ups. A normal message re-opens a previous opt-out.
  const consent = require('./wa-consent');
  const negative = consent.isNegativeReply(msg.body);
  // Use the time the customer actually wrote, not "now": after an outage or a paused number old messages are processed late,
  // and treating them as fresh would open a reply window that closed long ago.
  const wroteAt = msg.timestamp ? new Date(msg.timestamp) : new Date();
  const at = (!isNaN(wroteAt) && wroteAt.getTime() <= Date.now()) ? wroteAt : new Date();
  const stale = Date.now() - at.getTime() > 23 * 3600_000;
  await consent.recordInbound(db, userId, msg.fromPhone, { optOut: negative, now: at }).catch(e => console.error('[WhatsApp] consent record failed:', e.message));

  const businessContext = { ...(await getSettings(userId, db)), agentMode: 'autonomous' };   // WhatsApp is always fully autonomous
  const agentMode = 'autonomous';
  let claude = null;
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[WhatsApp] ANTHROPIC_API_KEY is not set — the AI cannot qualify or reply to leads');
  try { claude = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) {}

  // ── Step 1: understand the message and draft the reply ─────
  let lead = null;
  if (progress.generated) {
    if (progress.skipped) return;
    lead = await getLeadById(userId, progress.leadId, db);          // resume: the saved lead already holds the drafted reply
    if (!lead) { await saveProgress({ generated: false }); throw new Error(`lead ${progress.leadId} not found while resuming`); }
  } else {
    // Photos: have the AI describe the job (it never prices it); the note goes in front of the customer's words.
    let bodyForAI = msg.body, photoAssessment = null;
    const imgs = msg.images || [];
    if (imgs.length) {
      if (businessContext.photoQuoteEnabled === false) {
        bodyForAI = `[Photo analysis: the customer sent ${imgs.length} photo(s). Photo estimates are turned off, so they were not analysed.]` + (msg.body ? `\n${msg.body}` : '');
        console.log(`[WhatsApp] ${imgs.length} photo(s) from ${msg.fromPhone}: photo quotes are off, not analysed`);
      } else {
        const shots = (await Promise.all(imgs.slice(0, 4).map(i => downloadMedia({ mediaId: i.id, accessToken: waToken })))).filter(Boolean);
        photoAssessment = (shots.length && claude) ? await assessCustomerPhotos(claude, MODEL_ID(), { images: shots, caption: msg.body, businessContext }) : null;
        console.log(`[WhatsApp] ${imgs.length} photo(s) from ${msg.fromPhone}: ${shots.length} downloaded, ` + (photoAssessment ? `assessed (confidence ${photoAssessment.confidence}, service ${photoAssessment.likelyService || 'none'})` : 'could not be analysed'));
        bodyForAI = photoAnalysisNote(photoAssessment, imgs.length) + (msg.body ? `\nCustomer message: ${msg.body}` : '');
        if (!photoAssessment) photoAssessment = { confidence: 'low', missing: 'photos could not be analysed' };
      }
    }
    const externalId = (msg.messageIds && msg.messageIds[0]) || msg.messageId || null;

    const threadRow = await db.queryOne(
      `SELECT * FROM leads WHERE user_id=$1 AND whatsapp_thread_phone=$2 AND status NOT IN ('closed') ORDER BY created_at DESC LIMIT 1`,
      [userId, msg.fromPhone]
    );
    const existingLead = threadRow ? rowToLead(threadRow) : null;

    if (existingLead) {
      console.log(`[WhatsApp] Thread reply from ${msg.fromPhone} → lead ${existingLead.id}`);
      lead = await processReply(claude, MODEL_ID(), existingLead, bodyForAI, null, businessContext, agentMode, { photoAssessment, externalId });
    } else {
      console.log(`[WhatsApp] New lead from ${msg.fromPhone}`);
      const rawLead = {
        ...normalizeLead({ source: 'whatsapp', fromPhone: msg.fromPhone, fromName: msg.fromName, body: bodyForAI }),
        whatsappMessageId: externalId, whatsappThreadPhone: msg.fromPhone, photoAssessment,
      };
      lead = await processLead(claude, MODEL_ID(), rawLead, businessContext, agentMode);
      if (lead.intent === 'not_a_lead') {
        console.log(`[WhatsApp] No reply: message from ${msg.fromPhone} was judged NOT a lead — ${lead.disqualifyReason || 'no reason given'} (message: "${String(msg.body).slice(0, 80)}")`);
        await saveProgress({ generated: true, skipped: true });
        return;
      }
    }
    // The 24-hour reply window has already closed (it arrived while WhatsApp was unavailable). A late "reply" would fail or, worse,
    // pile onto a number that has just been restored. Keep the lead and ask the owner to follow up another way.
    if (stale && !lead.needsHumanReview) {
      lead.needsHumanReview = true;
      lead.humanReviewReason = 'This WhatsApp message arrived while WhatsApp was unavailable and the 24-hour reply window has passed. Contact the customer by phone or email.';
    }
    await storeLead(userId, lead, db, { strict: true });             // a failed save throws, so the batch is retried
    // STOP / unsubscribe (detected by the engine) or "no thanks": no more business-initiated messages, no pending follow-ups.
    if (lead.optedOut || negative) {
      await consent.recordInbound(db, userId, msg.fromPhone, { optOut: true, now: at }).catch(() => {});
      await require('./leads/scheduler').cancelFollowUps(lead.id, db).catch(() => {});
    }
    // Human handover: tell the person the AI chose (a closing stage was reached), or pass a new customer message on to the
    // person who already has this conversation. Both are idempotent, so a retried batch does not tell them twice.
    try {
      const handoverSvc = require('./handover');
      if (lead.handover && lead.handover.status === 'pending') await handoverSvc.dispatchPending({ db, user, lead, businessContext });
      else if (lead.handoverActive) await handoverSvc.forwardCustomerMessage({ db, user, lead, businessContext });
    } catch (e) { console.error('[Handover] (whatsapp) error:', e.message); }
    await saveProgress({ generated: true, leadId: lead.id, isNew: !existingLead });
    progress.isNew = !existingLead;
  }

  // ── Step 2: send the reply (at most once) ──────────────────
  const body = replyText(lead.aiReply);
  if (lead.needsHumanReview) console.log(`[WhatsApp] No auto-reply: lead ${lead.id} flagged for human review — ${lead.humanReviewReason || 'no reason given'}`);
  else if (!body) console.log(`[WhatsApp] No auto-reply: the AI produced no reply for lead ${lead.id}`);
  const willSend = !lead.needsHumanReview && !lead.optedOut && !!body;

  if (willSend && !progress.replySent && !progress.sendFailed) {
    await saveProgress({ sending: true });
    let wid = null;
    try {
      wid = await sendWhatsAppMessage({ to: msg.fromPhone, body, phoneNumberId: waPid, accessToken: waToken });
    } catch (sendErr) {
      if (sendErr.retryable) {                                        // refused for a transient reason: safe to retry the batch later
        await saveProgress({ sending: false });
        throw sendErr;
      }
      console.error('[WhatsApp] Auto-send failed:', sendErr.message);
      await saveProgress({ sendFailed: true });
      await flagReview(updateLead, userId, lead.id, db, sendErr.ambiguous
        ? `Auto-send may or may not have been delivered: ${sendErr.message}. Check before replying.`
        : `Auto-send failed: ${sendErr.message}`);
    }
    if (wid) await saveProgress({ replySent: true, wid, sentAt: new Date().toISOString() });
  }

  // ── Step 3: photos from the owner's library, then update the lead ──
  if (progress.replySent && !progress.bookkept) {
    if (!progress.photosSent) {
      try { await require('./media-library').sendReplyPhotosWhatsApp(db, userId, lead.aiReply, msg.fromPhone, creds); }
      catch (e) { console.warn('[WhatsApp] reply photos failed:', e.message); }
      await saveProgress({ photosSent: true });
    }
    const sentAt = progress.sentAt || new Date().toISOString();
    // The drafted reply is now a sent reply, for new leads and for replies in an existing thread.
    const confirmedHistory = (lead.conversationHistory || []).map(t => (t.role === 'agent' && t.pending) ? { ...t, pending: false, sentAt } : t);
    const saved = progress.isNew
      ? await updateLead(userId, lead.id, { status: 'pending_followup', sentAt, followUpSchedule: [], whatsappMessageId: progress.wid, conversationHistory: confirmedHistory }, db)
      : await updateLead(userId, lead.id, { status: lead.status === 'closed' ? 'closed' : 'pending_followup', sentAt, conversationHistory: confirmedHistory, whatsappMessageId: progress.wid }, db);
    if (!saved) throw new Error('reply was sent but the lead could not be updated');   // retry finishes this step only
    await saveProgress({ bookkept: true });
  }

  // ── Step 4: automations (once) ─────────────────────────────
  if (!progress.workflowsFired) {
    await saveProgress({ workflowsFired: true });
    const wf = require('./workflows/engine');
    const args = { db, user, businessContext, lead, claude, model: MODEL_ID() };
    (progress.isNew ? wf.onNewLead(args) : wf.onLeadReplied(args))
      .catch(e => console.error(`[Workflow] ${progress.isNew ? 'onNewLead' : 'onLeadReplied'} (whatsapp) error:`, e.message));
  }
}

module.exports = { processWhatsAppBatch };
