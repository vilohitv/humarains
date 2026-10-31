/**
 * services/leads/poller-batch.js
 *
 * Shared batch-processing logic used by the background auto-poller (services/leads/poller.js).
 * DB helpers (storeLead, rowToLead, getSettings) are imported from routes/leads.js
 * — single source of truth, no duplication.
 */
'use strict';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_MESSAGES_PER_POLL = 20;

const {
  getCalendarStatus,
  createCalendarEventForLead,
} = require('../google-calendar');

// Import from leads-routes — avoids duplicating storeLead / rowToLead / getSettings
const {
  rowToLead,
  storeLead,
  getSettings,
  updateLead,
  isPaidPlan,
  sendWithQuota,
} = require('../../routes/leads');

// ── Helper: silently attempt a Google Calendar event ──────────
async function tryCreateCalendarEvent(lead, user, businessContext, db) {
  if (!lead || lead.calendarEventId) return;
  let intg = {};
  try {
    const raw = user?.integrations;
    intg = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : {};
    if (typeof intg === 'string') intg = JSON.parse(intg);
  } catch (_) {}

  const calStatus = getCalendarStatus(intg);
  if (!calStatus.connected) return;

  let claude = null;
  try { claude = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return; }

  try {
    const result = await createCalendarEventForLead({ lead, businessContext, userIntg: intg, claude, model: MODEL });
    if (result.success && result.eventId && db) {
      await db.query(
        `UPDATE leads SET calendar_event_id=$1, calendar_event_link=$2 WHERE id=$3`,
        [result.eventId, result.eventLink || null, lead.id]
      );
      console.log(`[Poller/Calendar] ✓ Event created for lead ${lead.id}: ${result.summary}`);
    }
  } catch (err) {
    console.error('[Poller/Calendar] tryCreateCalendarEvent error:', err.message);
  }
}

// ── Process a batch of raw inbox (IMAP) messages for one user ─
async function processInboxBatch(claude, user, rawMessages, businessContext, db) {
  const { processLead, processReply, normalizeLead, buildFollowUpSchedule } = require('./engine');
  const scheduler = require('./scheduler');
  const { scheduleFollowUps } = scheduler;
  const agentMode = 'autonomous';   // replies always send on their own; risky ones are flagged for review
  const userId    = user.id;
  // Messages fully handled (stored, replied to, queued, or judged not a lead).
  // The poller marks only these as read; the rest stay unread and are retried.
  const handled = [];

  for (const rawMsg of rawMessages) {
    try {
      // Thread matching
      let existingLead = null;

      if (rawMsg.threadId && db) {
        const row = await db.queryOne(
          'SELECT * FROM leads WHERE user_id=$1 AND email_thread_id=$2 ORDER BY created_at DESC LIMIT 1',
          [userId, rawMsg.threadId]
        );
        if (row) existingLead = rowToLead(row);
      }

      if (!existingLead && rawMsg.isReply && rawMsg.fromEmail && db) {
        const normalised = rawMsg.fromEmail.toLowerCase().trim();
        const row = await db.queryOne(
          `SELECT * FROM leads WHERE user_id=$1 AND thread_from_email=$2
           AND status NOT IN ('closed') ORDER BY created_at DESC LIMIT 1`,
          [userId, normalised]
        );
        if (row) existingLead = rowToLead(row);
      }

      let lead;

      if (existingLead) {
        console.log(`[Poller] Thread reply → lead ${existingLead.id} turn ${(existingLead.turnCount||1)+1}`);
        // The customer answered: stop the pending Day 1/3/7 nudges (WhatsApp replies already do this).
        scheduler.cancelFollowUps(existingLead.id, db).catch(e => console.warn('[Poller] cancelFollowUps error:', e.message));
        lead = await processReply(claude, MODEL, existingLead, rawMsg.body, rawMsg.subject, businessContext, agentMode);
        if (rawMsg.threadId && !lead.emailThreadId) lead.emailThreadId = rawMsg.threadId;
      } else {
        const rawLead = {
          ...normalizeLead({ source: 'email', fromEmail: rawMsg.fromEmail, fromName: rawMsg.fromName, subject: rawMsg.subject, body: rawMsg.body }),
          emailMessageId: rawMsg.messageId,
          emailThreadId:  rawMsg.threadId,
        };
        lead = await processLead(claude, MODEL, rawLead, businessContext, agentMode);
        if (rawMsg.threadId && !lead.emailThreadId) lead.emailThreadId = rawMsg.threadId;
      }

      if (lead.intent === 'not_a_lead') {
        console.log(`[Poller] Not a lead: ${rawMsg.fromEmail} — "${(rawMsg.subject || '').slice(0, 60)}" (${lead.disqualifyReason || 'no reason'})`);
        rawMsg.outcome = 'not_a_lead';
        rawMsg.ignoredReason = lead.disqualifyReason || 'not a lead';
        handled.push(rawMsg);
        continue;
      }

      // strict: a failed save throws, so the message is retried instead of counted as handled
      await storeLead(userId, lead, db, { strict: true });
      rawMsg.leadId  = lead.id;
      rawMsg.outcome = existingLead ? 'reply' : 'new_lead';
      handled.push(rawMsg); // lead is saved; nothing below may cause it to be reprocessed

      // Human handover: tell the person the AI chose (a closing stage was reached), or pass a new customer message on
      // to the person who already has this conversation. Never lets a failure here cause the message to be reprocessed.
      try {
        const handoverSvc = require('../handover');
        if (lead.handover && lead.handover.status === 'pending') await handoverSvc.dispatchPending({ db, user, lead, businessContext });
        else if (lead.handoverActive) await handoverSvc.forwardCustomerMessage({ db, user, lead, businessContext });
      } catch (e) { console.error('[Handover] (poller) error:', e.message); }

      const { onNewLead, onLeadReplied } = require('../workflows/engine');
      if (existingLead) {
        onLeadReplied({ db, user, businessContext, lead, claude, model: MODEL })
          .catch(e => console.error('[Workflow] onLeadReplied (poller) error:', e.message));
      } else {
        onNewLead({ db, user, businessContext, lead, claude, model: MODEL })
          .catch(e => console.error('[Workflow] onNewLead (poller) error:', e.message));
      }

      if (lead.needsHumanReview) continue;

      // Autonomous: gateOutboundReply (approval chain + quota) then send
      if (lead.aiReply && lead.fromEmail) {
        let emailWentOut = false;
        try {
          // Photos the AI chose to show the customer are attached, same as a manual send.
          const attachments = await require('../media-library').loadReplyPhotos(db, userId, lead.aiReply).catch(() => undefined);
          // Thread the reply under the customer's message that triggered it.
          const threading = rawMsg.messageId
            ? { inReplyTo: rawMsg.messageId, references: [rawMsg.references, rawMsg.messageId].filter(Boolean).join(' ') }
            : {};
          await sendWithQuota(userId, user, { user, to: lead.fromEmail, subject: lead.aiReply.subject, body: lead.aiReply.body, attachments, ...threading }, db, lead);
          emailWentOut = true;   // from here on, a failure is bookkeeping, not a failed send
          const sentAt = new Date().toISOString();
          const confirmedHistory = (lead.conversationHistory || []).map(t =>
            (t.role === 'agent' && t.pending) ? { ...t, pending: false, sentAt } : t
          );
          const updates = { sentAt, conversationHistory: confirmedHistory };
          if (!existingLead) {
            updates.status = 'pending_followup';
            updates.followUpSchedule = buildFollowUpSchedule(lead.id, sentAt);
          } else {
            updates.status = lead.status === 'closed' ? 'closed' : 'pending_followup';
          }
          const updatedLead = await storeLead(userId, { ...lead, ...updates }, db) || { ...lead, ...updates };
          // Auto-create Google Calendar event when deal is closed
          if (updates.status === 'closed') {
            await tryCreateCalendarEvent(updatedLead, user, businessContext, db);
          }
          if (!existingLead) {
            await scheduleFollowUps(updatedLead, businessContext, user, async ({ lead: l, subject, body }) => {
              await sendWithQuota(l.userId || userId, user, { user, to: l.fromEmail, subject, body }, db, l)
                .catch(err => console.warn(`[Poller] Follow-up quota exceeded for lead`, l.id, err.message));
            });
          }
        } catch (sendErr) {
          if (emailWentOut) {
            // The customer already has this reply. Do not flag the lead as needing review (that is what made one email
            // show up as both sent and waiting); record what we can and move on.
            console.error(`[Poller] Reply to lead ${lead.id} was sent, but a step after sending failed:`, sendErr.message);
            await updateLead(userId, lead.id, { sentAt: new Date().toISOString(), status: 'pending_followup', pendingApproval: false }, db)
              .catch(e => console.error('[Poller] Could not record the sent reply:', e.message));
            continue;
          }
          console.error(`[Poller] Send failed for lead ${lead.id}:`, sendErr.message);
          // Delivery failed (bad mailbox credentials, SMTP error, etc). Don't
          // leave the lead stranded at 'processing' with no way to ever reach
          // Follow-Ups or Closed — surface it to Human Review with the AI's
          // draft reply intact so a person can fix and send it manually.
          await updateLead(userId, lead.id, {
            needsHumanReview:  true,
            humanReviewReason: `Auto-send failed: ${sendErr.message}`,
          }, db).catch(e => console.error('[Poller] Failed to flag lead for human review:', e.message));
        }
      }
    } catch (msgErr) {
      console.error(`[Poller] Error processing message from ${rawMsg.fromEmail}:`, msgErr.message);
    }
  }
  return handled;
}

module.exports = { getSettings, processInboxBatch };
