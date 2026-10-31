/**
 * services/leads/scheduler.js — DB-backed follow-up job queue
 *
 * All follow-up jobs are persisted to lead_followup_jobs before the
 * process returns, so they survive server restarts, crashes, and
 * multi-instance deploys.
 *
 * The poller (services/leads/poller.js) calls processDueJobs() every minute.
 * This module handles scheduling, execution, retry, and cancellation.
 *
 * Retry policy: up to 3 attempts with exponential back-off (5m → 15m → 45m).
 * After 3 failures the job is marked 'failed' and left for manual review.
 */
'use strict';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [5 * 60_000, 15 * 60_000, 45 * 60_000]; // ms

let _db = null;

// ── Initialise with a DB reference ───────────────────────────
const BATCH_LIMIT = Math.max(1, parseInt(process.env.FOLLOWUP_BATCH, 10) || 25);

function init(db) { _db = db; }

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (_) { return null; }
}

// ── Schedule follow-ups for a lead (called after first send) ──
// Creates DB rows for Day 1, 3, and 7 follow-ups.
// Idempotent: cancels any existing pending jobs for this lead first.
// ── Schedule follow-ups for a lead (called after first send) ──
// Creates DB rows for Day 1, 3, and 7 follow-ups.
// Idempotent: cancels any existing pending jobs for this lead first.
//
// Gated on plans.js PLANS[plan].autoFollowUp — Free/Starter don't get
// automatic Day 1/3/7 follow-up sequences; Growth+ does. This is the single
// place every caller (send-reply, process, whatsapp, workflow steps, etc.)
// routes through, so gating here covers all of them without touching each
// call site individually.
async function scheduleFollowUps(lead, businessContext, user, _sendFn) {
  if (!lead.sentAt || !lead.id) return [];

  try {
    const { getPlan } = require('../../config/plans');
    const plan = (user && user.plan) || 'free';
    if (!getPlan(plan).autoFollowUp) {
      console.log(`[Scheduler] Skipping auto follow-ups for lead ${lead.id} — ${plan} plan does not include autoFollowUp`);
      return [];
    }
  } catch (e) {
    // If plans.js can't be loaded for some reason, fail open rather than
    // silently breaking follow-ups for everyone — this matches the rest of
    // the codebase's "don't block on a gating check error" convention.
    console.error('[Scheduler] autoFollowUp plan check error:', e.message);
  }

  const db = _db;
  if (!db) {
    console.warn('[Scheduler] No DB — follow-ups will not persist across restarts');
    return legacySchedule(lead, businessContext, user, _sendFn);
  }

  // Cancel existing pending jobs for this lead
  await db.query(
    "UPDATE lead_followup_jobs SET status='cancelled', updated_at=NOW() WHERE lead_id=$1 AND status='pending'",
    [lead.id]
  ).catch(e => console.error('[Scheduler] Cancel existing jobs error:', e.message));

  const { buildFollowUpSchedule } = require('./engine');
  let schedule = buildFollowUpSchedule(lead.id, lead.sentAt);
  // WhatsApp leads get no automated follow-ups at all. WhatsApp only allows replies within 24 hours of the customer's last message,
  // every follow-up is later than that, and Humarains never starts a WhatsApp conversation. The AI keeps answering whenever they write.
  if (String(lead.source || '').toLowerCase() === 'whatsapp' || lead.whatsappThreadPhone) {
    return [];
  }
  const inserted = [];

  for (const fu of schedule) {
    const scheduledAt = new Date(fu.sendAt);
    if (scheduledAt <= new Date()) {
      console.log(`[Scheduler] Skipping past job ${fu.label} for lead ${lead.id}`);
      continue;
    }
    try {
      await db.query(
        `INSERT INTO lead_followup_jobs
           (id, user_id, lead_id, template, day, label, scheduled_at, status, attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0)
         ON CONFLICT (id) DO NOTHING`,
        [fu.id, user.id, lead.id, fu.template, fu.day, fu.label, scheduledAt.toISOString()]
      );
      inserted.push(fu);
      console.log(`[Scheduler] Queued "${fu.label}" for lead ${lead.id} at ${scheduledAt.toLocaleString()}`);
    } catch (e) {
      console.error(`[Scheduler] Failed to insert job ${fu.id}:`, e.message);
    }
  }

  return inserted;
}

// ── Process all due jobs (called by poller every minute) ──────
async function processDueJobs(db) {
  if (!db) return;

  // A crash mid-send leaves a job in 'processing' forever; hand those back after 10 minutes.
  await db.query(
    "UPDATE lead_followup_jobs SET status='pending', updated_at=NOW() WHERE status='processing' AND updated_at < NOW() - INTERVAL '10 minutes'",
    []
  ).catch(e => console.error('[Scheduler] Stuck-job reclaim error:', e.message));

  // Claim due jobs atomically — prevents double-execution on multi-instance
  let jobs;
  try {
    // At most BATCH_LIMIT per tick, oldest first: a backlog (after downtime or a paused number) drains steadily instead of
    // going out as one burst, which is what gets a WhatsApp number flagged again right after Meta restores it.
    const rows = await db.queryAll(
      `UPDATE lead_followup_jobs
          SET status='processing', attempts=attempts+1, updated_at=NOW()
        WHERE id IN (SELECT id FROM lead_followup_jobs
                      WHERE status='pending' AND scheduled_at <= NOW() AND attempts < $1
                      ORDER BY scheduled_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND status='pending'
       RETURNING *`,
      [MAX_ATTEMPTS, BATCH_LIMIT]
    );
    jobs = rows || [];
  } catch (e) {
    console.error('[Scheduler] Failed to claim due jobs:', e.message);
    return;
  }

  if (!jobs.length) return;
  console.log(`[Scheduler] Processing ${jobs.length} due follow-up job(s)`);

  const claude = getClaude();
  if (!claude) {
    // Release jobs back to pending
    await db.query(
      "UPDATE lead_followup_jobs SET status='pending', attempts=attempts-1 WHERE status='processing'",
      []
    ).catch(() => {});
    console.warn('[Scheduler] AI not available — follow-up jobs released');
    return;
  }

  for (const job of jobs) {
    await executeDbJob(claude, job, db);
  }
}

// ── Execute one DB job row ────────────────────────────────────
async function executeDbJob(claude, job, db) {
  const { generateFollowUp } = require('./engine');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  try {
    // Load lead and business settings
    const leadRow = await db.queryOne('SELECT * FROM leads WHERE id=$1', [job.lead_id]);
    if (!leadRow) throw new Error('Lead not found');

    // Opted out (replied STOP, or the owner marked do-not-contact): never send.
    let rowTags = leadRow.tags;
    if (typeof rowTags === 'string') { try { rowTags = JSON.parse(rowTags); } catch (_) { rowTags = []; } }
    if (Array.isArray(rowTags) && rowTags.includes('do-not-contact')) {
      await db.query("UPDATE lead_followup_jobs SET status='cancelled', updated_at=NOW() WHERE id=$1", [job.id]).catch(() => {});
      return;
    }

    // Waiting for the owner (Review tab or AI paused): no automatic follow-up. It is cancelled, not delayed, because a nudge
    // written before the owner's decision would be stale by the time it could go out.
    if (leadRow.needs_human_review) {
      await db.query("UPDATE lead_followup_jobs SET status='cancelled', last_error=$1, updated_at=NOW() WHERE id=$2",
        ['Lead is waiting for your review: no automatic follow-up.', job.id]).catch(() => {});
      return;
    }

    // A person on the team has this conversation (the AI handed it over): no automated nudges from the AI.
    let ho = leadRow.handover;
    if (typeof ho === 'string') { try { ho = JSON.parse(ho); } catch (_) { ho = null; } }
    if (ho && (ho.status === 'active' || ho.status === 'pending')) {
      await db.query("UPDATE lead_followup_jobs SET status='cancelled', last_error=$1, updated_at=NOW() WHERE id=$2",
        ['Handed over to a person: the AI does not follow up.', job.id]).catch(() => {});
      return;
    }

    // Follow-ups are email only. A WhatsApp conversation is never followed up (see scheduleFollowUps); a job that still exists for
    // one (created before this rule), or for a lead with no email address, is cancelled before any AI text is written.
    const isWa = leadRow.source === 'whatsapp' || !!leadRow.whatsapp_thread_phone;
    if (isWa || !leadRow.from_email) {
      await db.query("UPDATE lead_followup_jobs SET status='cancelled', last_error=$1, updated_at=NOW() WHERE id=$2",
        [isWa ? 'Follow-ups are not sent to WhatsApp conversations.' : 'No email address on this lead.', job.id]).catch(() => {});
      return;
    }

    const userRow = await db.queryOne('SELECT * FROM users WHERE id=$1', [job.user_id]);
    if (!userRow) throw new Error('User not found');

    const settRow = await db.queryOne(
      'SELECT * FROM lead_business_settings WHERE user_id=$1', [job.user_id]
    );

    const parseJ = v => { try { return v && typeof v === 'string' ? JSON.parse(v) : v; } catch(_) { return null; } };

    const lead = {
      id:                  leadRow.id,
      fromEmail:           leadRow.from_email,
      fromPhone:           leadRow.from_phone,
      fromName:            leadRow.from_name,
      customerName:        leadRow.customer_name,
      serviceType:         leadRow.service_type,
      subject:             leadRow.subject,
      sentAt:              leadRow.sent_at,
      conversationHistory: parseJ(leadRow.conversation_history) || [],
    };

    // Full owner configuration (profile, Agent Settings, pricing rules, knowledge base) — the old
    // hand-built context here carried only five fields.
    let fullContext = null;
    try { fullContext = await require('../../routes/leads').getSettings(job.user_id || leadRow.user_id, db); }
    catch (e) { console.warn('[Scheduler] getSettings failed, using basic context:', e.message); }

    const businessContext = fullContext ? fullContext : settRow ? {
      businessName:        settRow.business_name,
      ownerName:           settRow.owner_name,
      phone:               settRow.phone,
      bookingUrl:          settRow.booking_url,
      services:            parseJ(settRow.services) || [],
      specialInstructions: parseJ(settRow.extra_fields || '{}').specialInstructions || '',
    } : {};

    // Generate follow-up body
    const subjectMap = {
      reminder: `Following up on your enquiry`,
      urgency:  `Still available for your job?`,
      closure:  `Keeping the door open`,
    };
    const subject = subjectMap[job.template] || `Following up`;
    const body = await generateFollowUp(claude, model, lead, job.template, businessContext);

    // ── Send by email ────────────────────────────────────────
    // Same monthly quota as every other AI send.
    const { sendWithQuota } = require('../../routes/leads');
    await sendWithQuota(userRow.id, userRow, { user: userRow, to: lead.fromEmail, subject, body }, db, lead);

    // Mark sent
    await db.query(
      "UPDATE lead_followup_jobs SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1",
      [job.id]
    );
    console.log(`[Scheduler] Sent "${job.label}" for lead ${job.lead_id}`);

  } catch (err) {
    console.error(`[Scheduler] Job ${job.id} failed (attempt ${job.attempts}):`, err.message);

    // Out of quota will not fix itself in minutes: fail the job now with the reason instead of retrying 3 times.
    if (err.quotaExceeded) {
      await db.query(
        "UPDATE lead_followup_jobs SET status='failed', last_error=$1, updated_at=NOW() WHERE id=$2",
        [err.message.slice(0, 500), job.id]
      ).catch(() => {});
      return;
    }

    const nextAttempt = job.attempts; // already incremented by the UPDATE
    if (nextAttempt >= MAX_ATTEMPTS) {
      await db.query(
        "UPDATE lead_followup_jobs SET status='failed', last_error=$1, updated_at=NOW() WHERE id=$2",
        [err.message.slice(0, 500), job.id]
      ).catch(() => {});
      console.error(`[Scheduler] Job ${job.id} permanently failed after ${MAX_ATTEMPTS} attempts`);
    } else {
      // Retry with exponential back-off
      const retryDelay = RETRY_DELAYS[nextAttempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      const retryAt = new Date(Date.now() + retryDelay).toISOString();
      await db.query(
        "UPDATE lead_followup_jobs SET status='pending', last_error=$1, scheduled_at=$2, updated_at=NOW() WHERE id=$3",
        [err.message.slice(0, 500), retryAt, job.id]
      ).catch(() => {});
      console.warn(`[Scheduler] Job ${job.id} will retry at ${retryAt}`);
    }
  }
}

// ── Cancel all pending jobs for a lead ───────────────────────
async function cancelFollowUps(leadId, db) {
  const d = db || _db;
  if (!d) return 0;
  try {
    const result = await d.query(
      "UPDATE lead_followup_jobs SET status='cancelled', updated_at=NOW() WHERE lead_id=$1 AND status='pending'",
      [leadId]
    );
    return result && result.rowCount ? result.rowCount : 0;
  } catch (e) {
    console.error('[Scheduler] cancelFollowUps error:', e.message);
    return 0;
  }
}

// ── Legacy in-memory fallback (no DB) ────────────────────────
const _memJobs = new Map();
function legacySchedule(lead, businessContext, user, sendFn) {
  const { buildFollowUpSchedule, generateFollowUp } = require('./engine');
  const { sendLeadReply } = require('./ingestion');
  const schedule = buildFollowUpSchedule(lead.id, lead.sentAt);

  for (const fu of schedule) {
    const delay = new Date(fu.sendAt).getTime() - Date.now();
    if (delay < 0) continue;
    const tid = setTimeout(async () => {
      try {
        const claude = getClaude();
        if (!claude) return;
        const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
        const body  = await generateFollowUp(claude, model, lead, fu.template, businessContext);
        const subject = { reminder:'Following up on your enquiry', urgency:'Still available?', closure:'Keeping the door open' }[fu.template] || 'Following up';
        const fn = sendFn || (async ({lead:l,subject:s,body:b}) => sendLeadReply({user,to:l.fromEmail,subject:s,body:b}));
        await fn({ lead, subject, body, user });
      } catch(e) { console.error('[Scheduler] Legacy follow-up failed:', e.message); }
      finally { _memJobs.delete(fu.id); }
    }, Math.min(delay, 2_147_483_647));
    _memJobs.set(fu.id, tid);
  }
  return schedule;
}

module.exports = {
  init,
  scheduleFollowUps,
  processDueJobs,
  cancelFollowUps,
  // Legacy alias
  executFollowUp: () => {},
  listPendingJobs: () => [],
};
