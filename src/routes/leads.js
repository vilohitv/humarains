/**
 * routes/leads.js — AI Lead Conversion System API Routes
 *
 * Mounts at /api/leads
 *
 * Endpoints:
 *  POST /api/leads/ingest          — ingest a single lead (form webhook)
 *  POST /api/leads/test-lead       — create a sample lead so a new user can see
 *                                     the AI draft a reply within seconds (onboarding)
 *  POST /api/leads/ingest/email    — poll inbox (IMAP) for new leads
 *  POST /api/leads/process/:id     — run AI processing on a lead
 *  POST /api/leads/send-reply/:id  — send AI reply via connected email
 *  POST /api/leads/followup/:id    — manually trigger a follow-up
 *  PATCH /api/leads/:id/status     — update lead status
 *  GET  /api/leads                 — list all leads for user
 *  GET  /api/leads/:id             — get single lead
 *  GET  /api/leads/settings        — get business settings
 *  PUT  /api/leads/settings        — save business settings
 *  GET  /api/leads/followups/pending — list pending scheduled follow-ups
 *
 *  Google Calendar Integration:
 *  GET  /api/leads/calendar/status     — check if calendar is connected
 *  GET  /api/leads/calendar/events      — list upcoming events on the connected calendar
 *  GET  /api/leads/calendar/connect    — start Google Calendar OAuth
 *  GET  /api/leads/calendar/callback   — OAuth callback (also registered on app)
 *  DELETE /api/leads/calendar          — disconnect Google Calendar
 *  POST /api/leads/calendar/event/:id  — manually create calendar event for a lead
 *  POST /api/leads/calendar/test-event  — create a test event to verify the connection
 */
'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { normalizeSchedule, validateSchedule, legacyFields, validTimezone, isTimezoneConfirmed } = require('../lib/business-hours');

const {
  normalizeLead,
  processLead,
  processReply,
  qualifyLead,
  buildFollowUpSchedule,
  generateFollowUp,
  genLeadId,
  detectConversationStage,
  generateDealInsights,
  scoreLead,
} = require('../services/leads/engine');

const { sendLeadReply, threadingFor } = require('../services/leads/ingestion');
const { scheduleFollowUps, cancelFollowUps } = require('../services/leads/scheduler');

const {
  buildCalendarIntegration,
  getCalendarStatus,
  generateCalendarAuthUrl,
  handleCalendarCallback,
  createCalendarEventForLead,
  createTestCalendarEvent,
  listCalendarEvents,
} = require('../services/google-calendar');

const router = express.Router();

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch(_) { return null; }
}

const leadsLimiter = rateLimit({
  windowMs: 60_000, max: 30,
  keyGenerator: req => req.user ? String(req.user.id) : req.ip,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Test leads are only meant to be used a handful of times while a new
// account is getting set up — much tighter than the general ingest limiter.
const testLeadLimiter = rateLimit({
  windowMs: 60 * 60_000, max: 10,
  keyGenerator: req => req.user ? String(req.user.id) : req.ip,
  message: { success: false, message: 'Too many test leads. Please wait a bit before trying again.' },
});

// ── Helper: load user ─────────────────────────────────────────
async function loadUser(db, userId) {
  if (!db || !db.Users) return null;
  return db.Users.findById(userId).catch(() => null);
}

function getUserIntegrations(user) {
  const raw = user?.integrations;
  if (!raw) return {};
  if (typeof raw === 'object') return raw; // already parsed by pg JSONB
  try {
    const parsed = JSON.parse(raw);
    // Handle double-stringified data from previous bug
    if (typeof parsed === 'string') return JSON.parse(parsed);
    return parsed;
  } catch(_) { return {}; }
}

// Returns an onTokenRefresh callback that persists new Google tokens for a user.
function makeCalendarTokenRefreshFn(db, userId) {
  const { buildCalendarIntegration } = require('../services/google-calendar');
  return async function(newTokens) {
    const user = await db.Users.findById(userId).catch(() => null);
    if (!user) return;
    const intg = getUserIntegrations(user);
    const prev = intg.google_calendar || {};
    // Merge: keep existing refresh token if Google didn't return a new one
    const accessToken  = newTokens.access_token  || null;
    const refreshToken = newTokens.refresh_token  || (prev.enc_refresh ? null : undefined);
    const expiryDate   = newTokens.expiry_date    || null;
    if (!accessToken) return; // nothing useful to save
    intg.google_calendar = buildCalendarIntegration(
      prev.email,
      accessToken,
      // Google only returns a new refresh_token on first grant — keep the existing one
      refreshToken || (prev.enc_refresh ? undefined : null),
      expiryDate,
    );
    // Preserve enc_refresh if we didn't get a new refresh token
    if (!refreshToken && prev.enc_refresh) {
      intg.google_calendar.enc_refresh  = prev.enc_refresh;
      intg.google_calendar.connected_at = prev.connected_at;
    }
    await db.Users.update(userId, { integrations: JSON.stringify(intg) }).catch(() => {});
  };
}

// ── Google Calendar: auto-create event when a lead is closed ──
/**
 * Silently tries to create a Google Calendar event.
 * Never throws — logs errors and returns quietly.
 *
 * @param {object} params
 * @param {object} params.lead           — the lead (camelCase)
 * @param {object} params.user           — DB user row
 * @param {object} params.businessContext — business settings
 * @param {object} params.db             — DB instance (req._db)
 */
async function maybeCreateCalendarEvent({ lead, user, businessContext, db }) {
  // Only called explicitly (via POST /api/leads/calendar/event/:id or consent-queue approve)
  // — never fires automatically. The frontend asks for permission first.
  if (!lead) return;
  // Skip if already has a calendar event
  if (lead.calendarEventId) return;

  const intg = getUserIntegrations(user);
  const calStatus = getCalendarStatus(intg);
  if (!calStatus.connected) return; // user hasn't connected Google Calendar

  const claude = getClaude();
  if (!claude) return;

  try {
    const result = await createCalendarEventForLead({
      lead,
      businessContext,
      userIntg: intg,
      claude,
      model: MODEL,
      onTokenRefresh: makeCalendarTokenRefreshFn(db, user.id),
    });

    if (result.success && result.eventId && db) {
      // Persist the event ID on the lead so we don't double-create
      await db.query(
        `UPDATE leads SET calendar_event_id=$1, calendar_event_link=$2 WHERE id=$3`,
        [result.eventId, result.eventLink || null, lead.id]
      );
      lead.calendarEventId   = result.eventId;
      lead.calendarEventLink = result.eventLink;
      console.log(`[Calendar] ✓ Event created for lead ${lead.id}: ${result.summary}`);
    } else if (!result.success) {
      console.warn(`[Calendar] Could not create event for lead ${lead.id}: ${result.error}`);
    }
  } catch (err) {
    console.error('[Calendar] maybeCreateCalendarEvent error:', err.message);
  }
}

// ── DB-backed lead store ──────────────────────────────────────
// Converts between camelCase JS objects and snake_case DB rows

function rowToLead(row) {
  if (!row) return null;
  const parseJ = v => {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch(_) { return null; }
  };
  return {
    id:               row.id,
    userId:           row.user_id,
    source:           row.source,
    fromEmail:        row.from_email,
    fromName:         row.from_name,
    fromPhone:        row.from_phone        || null,
    whatsappMessageId: row.whatsapp_message_id || null,
    whatsappThreadPhone: row.whatsapp_thread_phone || null,
    subject:          row.subject,
    rawBody:          row.raw_body,
    formData:         parseJ(row.form_data),
    status:           row.status,
    intent:           row.intent,
    serviceType:      row.service_type,
    urgency:          row.urgency,
    quantity:         row.quantity,
    summary:          row.summary,
    customerName:     row.customer_name,
    quote:            parseJ(row.quote),
    aiReply:          parseJ(row.ai_reply),
    followUps:        parseJ(row.follow_ups) || [],
    followUpSchedule: parseJ(row.follow_up_schedule),
    sentAt:             row.sent_at ? new Date(row.sent_at).toISOString() : null,
    emailMessageId:     row.email_message_id,
    pendingApproval:         !!row.pending_approval,
    needsHumanReview:        !!row.needs_human_review,
    humanReviewReason:       row.human_review_reason || null,
    humanReply:              parseJ(row.human_reply),
    agentModeSnapshot:       row.agent_mode_snapshot || null,
    approvedAt:              row.approved_at ? new Date(row.approved_at).toISOString() : null,
    // conversation threading
    conversationHistory:     parseJ(row.conversation_history) || [],
    conversationStage:       row.conversation_stage || 'initial_inquiry',
    turnCount:               row.turn_count || 1,
    threadFromEmail:         row.thread_from_email || null,
    emailThreadId:           row.email_thread_id || null,
    lastCustomerMessage:     row.last_customer_message || null,
    lastCustomerMessageAt:   row.last_customer_message_at ? new Date(row.last_customer_message_at).toISOString() : null,
    calendarEventId:         row.calendar_event_id   || null,
    calendarEventLink:       row.calendar_event_link || null,
    handover:                parseJ(row.handover),
    offer:                   parseJ(row.offer),         // discount the Agent offered (services/agent/autonomy.js)
    tags:                    Array.isArray(row.tags) ? row.tags : (parseJ(row.tags) || []),
    // outcomes dashboard
    dealValue:               row.deal_value != null ? parseFloat(row.deal_value) : null,
    wonAt:                   row.won_at ? new Date(row.won_at).toISOString() : null,
    // AI deal insights (Pro/Max) — null until first generated
    dealInsights:            parseJ(row.deal_insights),
    aiScore:                 parseJ(row.ai_score),
    createdAt:               row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt:               row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

// A customer opted out (replied STOP). Atomic tag append, then stop everything
// that could still message them: pending follow-ups and any running automation.
// Idempotent. The tag is what campaigns, automations and the follow-up
// scheduler all check before sending.
async function applyOptOut(db, userId, leadId) {
  try {
    await db.query(
      `UPDATE leads SET tags = CASE WHEN COALESCE(tags,'[]'::jsonb) @> '["do-not-contact"]'::jsonb THEN tags
                                    ELSE COALESCE(tags,'[]'::jsonb) || '["do-not-contact"]'::jsonb END, updated_at=NOW()
        WHERE id=$1 AND user_id=$2`, [leadId, userId]);
    await db.query("UPDATE lead_followup_jobs SET status='cancelled', updated_at=NOW() WHERE lead_id=$1 AND status='pending'", [leadId]).catch(() => {});
    const runs = await db.queryAll("SELECT id FROM workflow_runs WHERE lead_id=$1 AND user_id=$2 AND status IN ('running','waiting')", [leadId, userId]).catch(() => []);
    const { cancelRun } = require('../services/workflows/engine');
    for (const r of runs) { try { await cancelRun(db, r.id); } catch (_) {} }
    console.log(`[OptOut] lead ${leadId} opted out; follow-ups and ${runs.length} automation run(s) stopped`);
  } catch (e) {
    console.error('[OptOut] could not apply opt-out for lead ' + leadId + ':', e.message);
  }
}

// opts.strict: rethrow DB errors instead of only logging them. The inbox poller uses it, so a lead that
// failed to save is retried instead of being treated as handled (which silently lost the email).
async function storeLead(userId, lead, db, opts = {}) {
  if (!db) return; // no DB available
  const j = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));
  try {
    await db.query(
      `INSERT INTO leads
        (id, user_id, source, from_email, from_name, from_phone, subject, raw_body, form_data,
         status, intent, service_type, urgency, quantity, summary, customer_name,
         quote, ai_reply, follow_ups, follow_up_schedule, sent_at, email_message_id,
         whatsapp_message_id, whatsapp_thread_phone,
         pending_approval, needs_human_review, human_review_reason, human_reply,
         agent_mode_snapshot, approved_at,
         conversation_history, conversation_stage, turn_count,
         thread_from_email, email_thread_id,
         last_customer_message, last_customer_message_at,
         deal_value, won_at, deal_insights, ai_score, handover, offer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, intent=EXCLUDED.intent, service_type=EXCLUDED.service_type,
         urgency=EXCLUDED.urgency, quantity=EXCLUDED.quantity, summary=EXCLUDED.summary,
         customer_name=EXCLUDED.customer_name, quote=EXCLUDED.quote, ai_reply=EXCLUDED.ai_reply,
         follow_ups=EXCLUDED.follow_ups, follow_up_schedule=EXCLUDED.follow_up_schedule,
         sent_at=EXCLUDED.sent_at, pending_approval=EXCLUDED.pending_approval,
         needs_human_review=EXCLUDED.needs_human_review, human_review_reason=EXCLUDED.human_review_reason,
         human_reply=EXCLUDED.human_reply, agent_mode_snapshot=EXCLUDED.agent_mode_snapshot,
         approved_at=EXCLUDED.approved_at,
         conversation_history=EXCLUDED.conversation_history,
         conversation_stage=EXCLUDED.conversation_stage,
         turn_count=EXCLUDED.turn_count,
         last_customer_message=EXCLUDED.last_customer_message,
         last_customer_message_at=EXCLUDED.last_customer_message_at,
         deal_value=EXCLUDED.deal_value,
         won_at=EXCLUDED.won_at,
         deal_insights=EXCLUDED.deal_insights,
         ai_score=EXCLUDED.ai_score,
         handover=COALESCE(EXCLUDED.handover, leads.handover),
         offer=COALESCE(EXCLUDED.offer, leads.offer),
         updated_at=NOW()`,
      [
        lead.id, userId, lead.source || 'form',
        lead.fromEmail || null, lead.fromName || null,
        lead.fromPhone || null,
        lead.subject || null, lead.rawBody || null,
        j(lead.formData), lead.status || 'new',
        lead.intent || null, lead.serviceType || null,
        lead.urgency || null, lead.quantity || null,
        lead.summary || null, lead.customerName || null,
        j(lead.quote), j(lead.aiReply),
        j(lead.followUps || []), j(lead.followUpSchedule),
        lead.sentAt || null, lead.emailMessageId || null,
        lead.whatsappMessageId || null,
        lead.whatsappThreadPhone || (lead.fromPhone ? lead.fromPhone : null),
        lead.pendingApproval || false,
        lead.needsHumanReview || false,
        lead.humanReviewReason || null,
        j(lead.humanReply),
        lead.agentModeSnapshot || null,
        lead.approvedAt || null,
        j(lead.conversationHistory || []),
        lead.conversationStage || 'initial_inquiry',
        lead.turnCount || 1,
        lead.threadFromEmail || (lead.fromEmail ? lead.fromEmail.toLowerCase().trim() : null),
        lead.emailThreadId || null,
        lead.lastCustomerMessage || null,
        lead.lastCustomerMessageAt || null,
        lead.dealValue != null ? parseFloat(lead.dealValue) : null,
        lead.wonAt || null,
        j(lead.dealInsights),
        j(lead.aiScore),
        j(lead.handover),
        j(lead.offer),
      ]
    );
    if (lead.optedOut) await applyOptOut(db, userId, lead.id);
    await require('../services/lead-messages').syncLeadMessages(db, userId, lead);
  } catch(e) {
    console.error('[leads] storeLead DB error:', e.message);
    if (opts.strict) throw e;
  }
}

async function getLeadsForUser(userId, db) {
  if (!db) return [];
  try {
    const rows = await db.queryAll(
      'SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500',
      [userId]
    );
    return rows.map(rowToLead);
  } catch(e) {
    console.error('[leads] getLeadsForUser DB error:', e.message);
    return [];
  }
}

async function getLeadById(userId, leadId, db) {
  if (!db) return null;
  try {
    const row = await db.queryOne(
      'SELECT * FROM leads WHERE id=$1 AND user_id=$2',
      [leadId, userId]
    );
    return rowToLead(row);
  } catch(e) {
    console.error('[leads] getLeadById DB error:', e.message);
    return null;
  }
}

async function updateLead(userId, leadId, updates, db) {
  if (!db) return null;
  try {
    const existing = await getLeadById(userId, leadId, db);
    if (!existing) return null;
    const merged = { ...existing, ...updates };
    await storeLead(userId, merged, db);
    return { ...merged, updatedAt: new Date().toISOString() };
  } catch(e) {
    console.error('[leads] updateLead DB error:', e.message);
    return null;
  }
}

// ── Business settings store ───────────────────────────────────
// Uses DB (lead_business_settings table) when available, falls back to in-memory
const _settingsStore = new Map(); // userId → settings (fallback only)

function defaultSettings() {
  return {
    businessName: '',
    businessType: 'local service business',
    ownerName: '',
    phone: '',
    bookingUrl: '',
    currency: 'USD',
    services: [],
    agentMode: 'autonomous',   // always 'autonomous': replies send on their own; risky ones are held for review
    // extended fields
    website: '',
    address: '',
    description: '',
    targetCustomer: '',
    responseTime: '',
    specialInstructions: '',
    agentInstructions: '',
    agentStyle: 'balanced',
    timezone: 'UTC',
    // Service timing
    defaultAppointmentDuration: 60,   // minutes
    bufferTime: 15,                    // minutes between appointments
    businessHoursStart: '09:00',
    businessHoursEnd: '17:00',
    businessDays: [1, 2, 3, 4, 5],    // Mon–Fri (0=Sun … 6=Sat)
    noticePeriod: 24,                  // hours advance notice required

    // Quote rules
    quoteMode: 'range', estimateRangePercent: 15, siteVisitAbove: 0, siteVisitFee: 0,
    proposalValidityDays: 0, maxDiscountPercent: 0, quoteInfoNeeded: '', neverQuote: '',

    // Photo quotes: estimate a job from photos the customer sends, using the quote rules above
    photoQuoteEnabled: true,
    photoQuoteGuidance: '',     // what to look for / how to size a job from a photo
    photoQuoteDisclaimer: 'This estimate is based on your photos. The final price is confirmed once we see the job in person.',
    photoQuoteMaxValue: 0,      // 0 = no ceiling; above this, no price by photo, offer a site visit
    photoQuoteUnclear: 'ask',   // 'ask' = ask for better photos/details, 'review' = send to the owner

    // Payment, warranty & policies
    standardDepositPercent: 0, paymentTerms: '', paymentMethods: '', cancellationFee: 0,
    warrantyPolicy: '', licenseInsurance: '', cancellationPolicy: '',
  };
}

// ── Company Knowledge AI — compiled into businessContext.knowledgeBase ───────
// Grouped by category, budget-capped so a business that uploads a lot of
// material can't blow out the prompt token budget on every single AI call.
const KNOWLEDGE_CATEGORY_LABELS = {
  pricing: 'Pricing', faq: 'FAQs', product: 'Product Info',
  service: 'Service Info', competitor: 'Competitor Info', process: 'Internal Processes',
};
const KNOWLEDGE_CATEGORY_ORDER = ['pricing', 'faq', 'product', 'service', 'competitor', 'process'];
// Total characters of knowledge shared across all categories. The old 6000 silently dropped
// uploaded material (pricing could starve the FAQs entirely); this is large enough for a real
// knowledge base and, when it is still exceeded, every category keeps a fair share.
const KNOWLEDGE_PROMPT_BUDGET = 24000;

function compileKnowledgeBase(rows) {
  if (!rows || !rows.length) return '';
  const byCategory = {};
  for (const r of rows) (byCategory[r.category] = byCategory[r.category] || []).push(r);

  const render = e => `### ${e.title}\n${String(e.content || '').trim()}`;
  const cats = KNOWLEDGE_CATEGORY_ORDER.filter(c => byCategory[c] && byCategory[c].length);
  // Unknown categories are still included rather than dropped.
  for (const c of Object.keys(byCategory)) if (!cats.includes(c)) cats.push(c);

  // Fair allocation: smallest categories get what they need, the rest split what remains.
  const size = c => byCategory[c].reduce((n, e) => n + render(e).length + 2, 0);
  const caps = {};
  let remaining = KNOWLEDGE_PROMPT_BUDGET;
  [...cats].sort((a, b) => size(a) - size(b)).forEach((c, idx, arr) => {
    const share = Math.floor(remaining / (arr.length - idx));
    caps[c] = Math.min(size(c), share);
    remaining -= caps[c];
  });

  const sections = [];
  let truncated = false;
  for (const cat of cats) {
    let budget = caps[cat];
    const blocks = [];
    for (const e of byCategory[cat]) {
      if (budget <= 0) { truncated = true; break; }
      const full = render(e);
      const block = full.slice(0, budget);
      if (block.length < full.length) truncated = true;
      blocks.push(block);
      budget -= block.length + 2;
    }
    if (blocks.length) sections.push(`## ${KNOWLEDGE_CATEGORY_LABELS[cat] || cat}\n${blocks.join('\n\n')}`);
  }
  if (truncated) console.warn(`[Knowledge] Knowledge base exceeds ${KNOWLEDGE_PROMPT_BUDGET} chars — some entries were trimmed. Consider condensing it.`);
  return sections.join('\n\n');
}

async function getKnowledgeBase(userId, db) {
  if (!db || !db.BusinessKnowledge) return '';
  try {
    return compileKnowledgeBase(await db.BusinessKnowledge.listByUser(userId));
  } catch (e) {
    // business_knowledge table not migrated yet on this instance — degrade
    // silently rather than breaking every AI call that depends on getSettings().
    return '';
  }
}

// Quoting inputs saved from Business Settings (quote rules, policies). Rates,
// call-out, travel, surcharges, materials and tax live on each service now.
// Each key has a type so the PUT route can validate it.
const QUOTE_NUM_KEYS = {
  estimateRangePercent: 100, siteVisitAbove: 1e7, siteVisitFee: 1e5, proposalValidityDays: 365, maxDiscountPercent: 100,
  standardDepositPercent: 100, cancellationFee: 1e5, photoQuoteMaxValue: 1e7 };
const QUOTE_TEXT_KEYS = { quoteInfoNeeded: 1000, photoQuoteGuidance: 1000, photoQuoteDisclaimer: 300,
  neverQuote: 1000, paymentTerms: 300, paymentMethods: 300, warrantyPolicy: 1000, licenseInsurance: 1000, cancellationPolicy: 1000 };
const QUOTE_BOOL_KEYS = ['photoQuoteEnabled'];
const QUOTE_ENUM_KEYS = { quoteMode: ['range', 'firm', 'site_visit'], photoQuoteUnclear: ['ask', 'review'] };
const QUOTE_SETTING_KEYS = [...Object.keys(QUOTE_NUM_KEYS), ...Object.keys(QUOTE_TEXT_KEYS), ...QUOTE_BOOL_KEYS, ...Object.keys(QUOTE_ENUM_KEYS)];

// Pull validated quoting fields out of a request body; unknown/invalid values are dropped.
function pickQuoteSettings(body) {
  const out = {};
  for (const [k, max] of Object.entries(QUOTE_NUM_KEYS)) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]); if (isFinite(n) && n >= 0) out[k] = Math.min(n, max);
  }
  for (const [k, max] of Object.entries(QUOTE_TEXT_KEYS)) {
    if (body[k] !== undefined) out[k] = String(body[k] == null ? '' : body[k]).trim().slice(0, max);
  }
  for (const k of QUOTE_BOOL_KEYS) if (body[k] !== undefined) out[k] = !!body[k];
  for (const [k, allowed] of Object.entries(QUOTE_ENUM_KEYS)) if (allowed.includes(body[k])) out[k] = body[k];
  return out;
}

// ── Per-service pricing fields ───────────────────────────────────
// Every service carries its own pricing, call-out/travel, surcharges, materials,
// tax, add-ons and terms. normalizeService validates one service from the client
// (or the agent) and drops anything unknown or out of range.
const SERVICE_PRICING_TYPES = ['fixed', 'from', 'hourly', 'per_unit', 'site_visit'];
const SERVICE_NUM_KEYS = { basePrice: 1e7, priceMax: 1e7, minCharge: 1e7, pricePerUnit: 1e7, durationHours: 1000, depositPercent: 100,
  callOutFee: 1e5, travelFee: 1e4, emergencySurcharge: 1e6, prioritySurcharge: 1e6, afterHoursSurcharge: 1e6, weekendSurcharge: 1e6,
  holidaySurcharge: 1e6, materialsMarkupPercent: 1000, taxRatePercent: 100 };
const SERVICE_TEXT_KEYS = { name: 80, category: 60, description: 600, unitLabel: 30, travelNote: 200, materialsNote: 400, taxName: 40,
  quoteNotes: 400, exclusions: 400, infoNeeded: 500, warranty: 300 };
const SERVICE_ENUM_KEYS = { surchargeType: ['percent', 'flat'], materialsMode: ['included', 'at_cost', 'markup', 'customer'], taxMode: ['none', 'added', 'included'] };

function normalizeService(sv) {
  if (!sv || typeof sv !== 'object') return sv;
  sv.pricingType = SERVICE_PRICING_TYPES.includes(sv.pricingType) ? sv.pricingType : 'fixed';
  for (const [k, max] of Object.entries(SERVICE_NUM_KEYS)) {
    if (sv[k] == null || sv[k] === '') { sv[k] = k === 'basePrice' ? 0 : null; continue; }
    const n = Number(sv[k]);
    sv[k] = isFinite(n) && n >= 0 ? Math.min(n, max) : (k === 'basePrice' ? 0 : null);
  }
  for (const [k, max] of Object.entries(SERVICE_TEXT_KEYS)) {
    if (sv[k] == null) { sv[k] = k === 'name' ? '' : null; continue; }
    sv[k] = String(sv[k]).trim().slice(0, max) || (k === 'name' ? '' : null);
  }
  for (const [k, allowed] of Object.entries(SERVICE_ENUM_KEYS)) {
    if (!allowed.includes(sv[k])) sv[k] = k === 'surchargeType' ? 'percent' : null;
  }
  sv.callOutWaivedIfBooked = !!sv.callOutWaivedIfBooked;
  sv.addOns = (Array.isArray(sv.addOns) ? sv.addOns : []).slice(0, 20).map(a => {
    const price = Number(a && a.price);
    return { name: String((a && a.name) || '').trim().slice(0, 80), price: isFinite(price) && price >= 0 ? Math.min(price, 1e7) : 0,
      note: a && a.note ? String(a.note).trim().slice(0, 200) : null };
  }).filter(a => a.name);
  return sv;
}

// Rates, call-out/travel, surcharges, materials and tax used to be business-wide
// settings. They now live on each service, so fold any old saved values into the
// services that do not have their own yet, then drop the old keys. Runs on read,
// so existing accounts keep their numbers; the next save persists the result.
const LEGACY_PRICING_KEYS = ['hourlyRate', 'minimumCharge', 'callOutFee', 'callOutWaivedIfBooked', 'serviceRadius', 'travelFee',
  'serviceArea', 'outOfAreaPolicy', 'surchargeType', 'afterHoursSurcharge', 'weekendSurcharge', 'holidaySurcharge',
  'materialsMarkupPercent', 'materialsPolicy', 'taxRatePercent', 'taxName', 'priceIncludesTax'];
function migrateLegacyPricing(settings) {
  if (!settings || !LEGACY_PRICING_KEYS.some(k => settings[k] !== undefined)) return settings;
  const L = settings, has = v => v != null && v !== '' && v !== 0 && v !== false;
  if (Array.isArray(L.services)) {
    L.services.forEach(sv => {
      if (!sv || typeof sv !== 'object') return;
      const fill = (key, val) => { if (has(val) && !has(sv[key])) sv[key] = val; };
      fill('minCharge', L.minimumCharge);
      if (sv.pricingType === 'hourly') fill('basePrice', L.hourlyRate);
      fill('callOutFee', L.callOutFee);
      if (has(L.callOutFee) && !has(sv.callOutWaivedIfBooked)) sv.callOutWaivedIfBooked = !!L.callOutWaivedIfBooked;
      fill('travelFee', L.travelFee);
      if (has(L.travelFee) && !sv.travelNote) sv.travelNote = 'per km/mile beyond the standard service radius' + (L.serviceRadius ? ` (${L.serviceRadius})` : '');
      fill('afterHoursSurcharge', L.afterHoursSurcharge); fill('weekendSurcharge', L.weekendSurcharge); fill('holidaySurcharge', L.holidaySurcharge);
      if ((has(L.afterHoursSurcharge) || has(L.weekendSurcharge) || has(L.holidaySurcharge)) && !sv.surchargeType) sv.surchargeType = L.surchargeType === 'flat' ? 'flat' : 'percent';
      if (has(L.materialsMarkupPercent) && !sv.materialsMode) { sv.materialsMode = 'markup'; sv.materialsMarkupPercent = L.materialsMarkupPercent; }
      if (L.materialsPolicy && !sv.materialsNote) sv.materialsNote = L.materialsPolicy;
      if (has(L.taxRatePercent) && !sv.taxMode) { sv.taxMode = L.priceIncludesTax ? 'included' : 'added'; sv.taxRatePercent = L.taxRatePercent; if (L.taxName) sv.taxName = L.taxName; }
    });
  }
  LEGACY_PRICING_KEYS.forEach(k => { delete L[k]; });
  return settings;
}

async function getSettings(userId, db) {
  let settings;
  // Try DB first
  if (db && db.queryOne) {
    try {
      const row = await db.queryOne('SELECT * FROM lead_business_settings WHERE user_id=$1', [userId]);
      if (row) {
        const services = Array.isArray(row.services) ? row.services : (typeof row.services === 'string' ? JSON.parse(row.services || '[]') : []);
        const extra = (() => {
          // pg returns jsonb columns already parsed; only call JSON.parse for plain strings
          if (!row.extra_fields) return {};
          if (typeof row.extra_fields === 'object') return row.extra_fields;
          try { return JSON.parse(row.extra_fields); } catch(_) { return {}; }
        })();
        settings = { ...defaultSettings(), businessName: row.business_name || '', businessType: row.business_type || 'local service business', ownerName: row.owner_name || '', phone: row.phone || '', bookingUrl: row.booking_url || '', currency: row.currency || 'USD', agentMode: row.agent_mode || 'autonomous', leadSendsUsed: parseInt(row.lead_sends_used || 0, 10), services, ...extra };
      }
    } catch(e) { /* fall through */ }
  }
  if (!settings) settings = _settingsStore.get(userId) || defaultSettings();
  migrateLegacyPricing(settings);
  settings.agentMode = 'autonomous';   // there is no manual-approval mode any more
  // Opening hours always come back as a full per-day schedule, and the time zone says whether the owner has chosen it
  settings.businessHours = normalizeSchedule(settings);
  settings.timezoneConfirmed = isTimezoneConfirmed(settings);
  // The knowledge base and the photo library summary (ids + captions, no bytes, so the reply engine can attach photos
  // when a customer asks to see some) do not depend on each other: fetch them together.
  const [knowledgeBase, mediaLibrary] = await Promise.all([
    getKnowledgeBase(userId, db),
    Promise.resolve().then(() => require('../services/media-library').libraryForContext(db, userId)).catch(() => []),
  ]);
  settings.knowledgeBase = knowledgeBase;
  settings.mediaLibrary  = mediaLibrary;
  return settings;
}

async function saveSettings(userId, settings, db) {
  const merged = { ...defaultSettings(), ...settings };
  const { businessName, businessType, ownerName, phone, bookingUrl, currency, services, agentMode } = merged;
  // Store extra extended fields as JSON
  const extra = {};
  ['website','address','description','targetCustomer','responseTime','specialInstructions','timezone',
   'defaultAppointmentDuration','bufferTime','businessHoursStart','businessHoursEnd','businessDays',
   'noticePeriod', 'businessHours', 'timezoneConfirmed', 'agentInstructions', 'agentStyle',
   ...QUOTE_SETTING_KEYS,
   // Agent onboarding interview finished / dismissed
   'onboardingComplete',
   // Human handover: the team, the moments, the switch
   'handoverEnabled', 'handoverStages', 'handoverContacts', 'handoverCopyOwner',
  ].forEach(k => {
    if (merged[k] !== undefined) extra[k] = merged[k];
  });

  if (db && db.query) {
    // Primary: persist to DB — always throw on failure so caller knows save didn't work
    try {
      await db.query(
        `INSERT INTO lead_business_settings (user_id, business_name, business_type, owner_name, phone, booking_url, currency, services, extra_fields, agent_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id) DO UPDATE SET
           business_name=EXCLUDED.business_name, business_type=EXCLUDED.business_type,
           owner_name=EXCLUDED.owner_name, phone=EXCLUDED.phone, booking_url=EXCLUDED.booking_url,
           currency=EXCLUDED.currency, services=EXCLUDED.services, extra_fields=EXCLUDED.extra_fields,
           agent_mode=EXCLUDED.agent_mode, updated_at=NOW()`,
        [userId, businessName, businessType, ownerName, phone, bookingUrl, currency,
         JSON.stringify(services || []), JSON.stringify(extra), agentMode || 'autonomous']
      );
    } catch(e) {
      console.error('[leads-routes] CRITICAL: DB settings save failed:', e.message);
      throw new Error('Failed to save business settings to database: ' + e.message);
    }
    // Also cache in memory so this process does not need a second DB read
    _settingsStore.set(userId, merged);
    return;
  }
  // No DB available — in-memory only (settings will be lost on restart)
  console.warn('[leads-routes] No DB available — settings stored in memory only and will not persist across restarts.');
  _settingsStore.set(userId, merged);
}

async function hasCompletedSetup(userId, db) {
  const s = await getSettings(userId, db);
  return !!(s.businessName && s.businessType && s.ownerName && s.services && s.services.length > 0);
}

// ══════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════

// ── GET /api/leads — list leads ───────────────────────────────
router.get('/', async (req, res) => {
  const leads = await getLeadsForUser(req.user.id, req._db);
  res.json({ success: true, leads, count: leads.length });
});


// ── GET /api/leads/performance — AI reply & conversion stats ──
// Everything here is computed directly from real lead rows for this user —
// no estimated or simulated figures. `range` is an optional window in days
// (default 30); pass `range=all` for lifetime numbers.
router.get('/performance', async (req, res) => {
  const db = req._db;
  if (!db) return res.json({ success: true, stats: emptyPerformanceStats() });

  const rangeParam = (req.query.range || '30').toString();
  const days = rangeParam === 'all' ? null : Math.max(1, Math.min(365, parseInt(rangeParam, 10) || 30));
  const since = days ? `AND created_at >= NOW() - INTERVAL '${days} days'` : '';

  try {
    // Overall funnel: received → AI replied → booked meeting
    const totals = await db.queryOne(
      `SELECT
         COUNT(*)::int                                              AS total_leads,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int           AS replied_count,
         COUNT(*) FILTER (WHERE calendar_event_id IS NOT NULL)::int AS booked_count,
         COUNT(*) FILTER (WHERE status = 'closed')::int             AS closed_count,
         COUNT(*) FILTER (WHERE pending_approval = true)::int       AS pending_approval_count,
         COUNT(*) FILTER (WHERE needs_human_review = true)::int     AS human_review_count,
         AVG(EXTRACT(EPOCH FROM (sent_at - created_at)))
           FILTER (WHERE sent_at IS NOT NULL)::float                AS avg_response_seconds
       FROM leads
       WHERE user_id = $1 AND source != 'test' ${since}`,
      [req.user.id]
    );

    // Breakdown by source (email / whatsapp / form / etc.)
    const bySource = await db.queryAll(
      `SELECT
         COALESCE(source, 'form')                                   AS source,
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int           AS replied,
         COUNT(*) FILTER (WHERE calendar_event_id IS NOT NULL)::int AS booked
       FROM leads
       WHERE user_id = $1 AND source != 'test' ${since}
       GROUP BY source
       ORDER BY total DESC`,
      [req.user.id]
    );

    // Daily trend for the requested window (capped at 90 points to keep payload small)
    const trendDays = days ? Math.min(days, 90) : 90;
    const trend = await db.queryAll(
      `SELECT
         date_trunc('day', created_at)::date                        AS day,
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int           AS replied,
         COUNT(*) FILTER (WHERE calendar_event_id IS NOT NULL)::int AS booked
       FROM leads
       WHERE user_id = $1 AND source != 'test' AND created_at >= NOW() - INTERVAL '${trendDays} days'
       GROUP BY day
       ORDER BY day ASC`,
      [req.user.id]
    );

    const t = totals || {};
    const totalLeads   = t.total_leads || 0;
    const repliedCount = t.replied_count || 0;
    const bookedCount  = t.booked_count || 0;

    res.json({
      success: true,
      stats: {
        rangeDays: days,
        totalLeads,
        repliedCount,
        bookedCount,
        closedCount: t.closed_count || 0,
        pendingApprovalCount: t.pending_approval_count || 0,
        humanReviewCount: t.human_review_count || 0,
        replyRate:  totalLeads   > 0 ? round2(repliedCount / totalLeads) : null,
        bookingRate: repliedCount > 0 ? round2(bookedCount / repliedCount) : null,
        avgResponseSeconds: t.avg_response_seconds != null ? Math.round(t.avg_response_seconds) : null,
        bySource: (bySource || []).map(r => ({
          source: r.source,
          total: r.total,
          replied: r.replied,
          booked: r.booked,
          replyRate: r.total > 0 ? round2(r.replied / r.total) : null,
        })),
        trend: (trend || []).map(r => ({
          date: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
          total: r.total,
          replied: r.replied,
          booked: r.booked,
        })),
      },
    });
  } catch (e) {
    console.error('[leads] performance stats error:', e.message);
    res.json({ success: true, stats: emptyPerformanceStats() });
  }
});

// ── PATCH /api/leads/:id/deal-value — set or update a closed lead's deal value ──
router.patch('/:id/deal-value', async (req, res) => {
  const { dealValue } = req.body;
  const parsed = parseFloat(dealValue);
  if (isNaN(parsed) || parsed < 0) {
    return res.status(400).json({ success: false, message: 'dealValue must be a non-negative number.' });
  }

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const updated = await updateLead(req.user.id, req.params.id, { dealValue: parsed }, req._db);
  res.json({ success: true, lead: updated });
});

function emptyOutcomes() {
  return {
    rangeDays: 30, closedTotal: 0, valuedCount: 0, revenueTotal: 0,
    avgDealValue: 0, closedThisMonth: 0, revenueThisMonth: 0,
    unveiledCount: 0, monthTrend: [], recentWins: [],
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function emptyPerformanceStats() {
  return {
    rangeDays: 30, totalLeads: 0, repliedCount: 0, bookedCount: 0, closedCount: 0,
    pendingApprovalCount: 0, humanReviewCount: 0, replyRate: null, bookingRate: null,
    avgResponseSeconds: null, bySource: [], trend: [],
  };
}


// ════════════════════════════════════════════════════════════════
// SEND QUOTA SYSTEM — limits come from plans.js (see PLANS[key].leadSendsLimit)
// All plans now reset monthly, including Free (previously a 1-time lifetime cap).
// ════════════════════════════════════════════════════════════════
const { getPlan, isUnlimited: planIsUnlimited } = require('../config/plans');

function getPlanLimit(user) {
  const plan = (user && user.plan) || 'free';
  return { plan, limit: getPlan(plan).leadSendsLimit };
}

// Kept for callers outside this file that still ask "is this a paid plan" —
// now means "plan above Free", not a hardcoded pro/max check.
function isPaidPlan(user) {
  const plan = (user && user.plan) || 'free';
  return plan !== 'free';
}

// Kept for backward compat with any code still importing this constant.
const FREE_SEND_LIMIT = getPlan('free').leadSendsLimit;

async function getLeadSendsUsed(userId, db) {
  if (!db) return 0;
  try {
    const row = await db.queryOne(
      'SELECT lead_sends_used, lead_sends_this_month, sends_reset_at FROM lead_business_settings WHERE user_id=$1',
      [userId]
    );
    if (!row) return 0;
    // Reset monthly counter if we've crossed into a new month — applies to every plan now.
    const resetAt = row.sends_reset_at ? new Date(row.sends_reset_at) : null;
    const now     = new Date();
    if (!resetAt || resetAt.getMonth() !== now.getMonth() || resetAt.getFullYear() !== now.getFullYear()) {
      // New month — reset counter silently (don't await to avoid blocking)
      db.query(
        'UPDATE lead_business_settings SET lead_sends_this_month=0, sends_reset_at=NOW() WHERE user_id=$1',
        [userId]
      ).catch(() => {});
      return 0;
    }
    return parseInt(row.lead_sends_this_month || 0, 10);
  } catch(_) { return 0; }
}

async function incrementLeadSends(userId, user, db) {
  if (!db) return;
  try {
    // Always increment lifetime counter (kept for analytics) AND the monthly counter (the real gate).
    await db.query(
      `INSERT INTO lead_business_settings (user_id, lead_sends_used, lead_sends_this_month, sends_reset_at)
       VALUES ($1, 1, 1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         lead_sends_used        = lead_business_settings.lead_sends_used + 1,
         lead_sends_this_month  = lead_business_settings.lead_sends_this_month + 1`,
      [userId]
    );
  } catch(e) { console.error('[leads] incrementLeadSends error:', e.message); }
}

// Check quota. Returns { allowed, used, limit, plan, unlimited }
async function checkSendQuota(userId, user, db) {
  const { plan, limit } = getPlanLimit(user);
  const used = await getLeadSendsUsed(userId, db); // monthly counter for every plan now
  return { allowed: planIsUnlimited(limit) || used < limit, used, limit, plan, unlimited: planIsUnlimited(limit) };
}

// Enforce quota + send + increment in one call. Over the plan limit, the send is blocked.
//
// `lead` is accepted for call-site compatibility but is no longer used.
async function sendWithQuota(userId, user, sendArgs, db, lead = null) {
  const quota = await checkSendQuota(userId, user, db);
  if (!quota.allowed) {
    throw Object.assign(new Error(quotaExceededMessage(quota)), { quotaExceeded: true, used: quota.used, limit: quota.limit, plan: quota.plan });
  }
  await sendLeadReply(sendArgs);
  await incrementLeadSends(userId, user, db);
  return quota;
}

function quotaExceededMessage(quota) {
  const plan = quota.plan || 'free';
  const nextPlan = plan === 'free' ? 'Starter' : plan === 'starter' ? 'Growth' : plan === 'growth' ? 'Pro for unlimited replies' : 'a higher plan';
  return `You've used all ${quota.limit} AI replies this month on the ${getPlan(plan).name} plan. Upgrade to ${nextPlan} for more.`;
}

// ════════════════════════════════════════════════════════════════
// WHATSAPP SEND QUOTA — separate from the email lead-send quota above.
// Starter gets a limited monthly cap (plans.js whatsappLimit); Growth+
// is unlimited. Mirrors the lead-send pattern and shares its DB row
// (lead_business_settings), but its own counter columns.
// ════════════════════════════════════════════════════════════════
async function getWhatsAppSendsUsed(userId, db) {
  if (!db) return 0;
  try {
    const row = await db.queryOne(
      'SELECT whatsapp_sends_this_month, sends_reset_at FROM lead_business_settings WHERE user_id=$1',
      [userId]
    );
    if (!row) return 0;
    const resetAt = row.sends_reset_at ? new Date(row.sends_reset_at) : null;
    const now     = new Date();
    if (!resetAt || resetAt.getMonth() !== now.getMonth() || resetAt.getFullYear() !== now.getFullYear()) {
      db.query(
        'UPDATE lead_business_settings SET whatsapp_sends_this_month=0, lead_sends_this_month=0, sends_reset_at=NOW() WHERE user_id=$1',
        [userId]
      ).catch(() => {});
      return 0;
    }
    return parseInt(row.whatsapp_sends_this_month || 0, 10);
  } catch(_) { return 0; }
}

async function incrementWhatsAppSends(userId, db) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO lead_business_settings (user_id, whatsapp_sends_used, whatsapp_sends_this_month, sends_reset_at)
       VALUES ($1, 1, 1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         whatsapp_sends_used       = lead_business_settings.whatsapp_sends_used + 1,
         whatsapp_sends_this_month = lead_business_settings.whatsapp_sends_this_month + 1`,
      [userId]
    );
  } catch(e) { console.error('[leads] incrementWhatsAppSends error:', e.message); }
}

// Returns { allowed, used, limit, plan, unlimited }
async function checkWhatsAppQuota(userId, user, db) {
  const plan  = (user && user.plan) || 'free';
  const limit = getPlan(plan).whatsappLimit;
  const used  = await getWhatsAppSendsUsed(userId, db);
  return { allowed: planIsUnlimited(limit) || used < limit, used, limit, plan, unlimited: planIsUnlimited(limit) };
}

function whatsappQuotaExceededMessage(quota) {
  const plan = quota.plan || 'free';
  const nextPlan = plan === 'starter' ? 'Growth' : (plan === 'growth' ? 'Pro for unlimited messages' : 'a higher plan');
  return `You've used all ${quota.limit} WhatsApp messages this month on the ${getPlan(plan).name} plan. Upgrade to ${nextPlan} for more.`;
}

// ════════════════════════════════════════════════════════════════
// OUTBOUND REPLY GATE — single chokepoint every AI-generated reply
// (direct send paths in this file AND the workflow engine's
// send_message step) must pass through before a message actually
// goes out. A per-channel send quota is the one thing that can stop it:
//
//   Per-channel send quota (email leadSends, or WhatsApp).
//
// Returns one of:
//   { verdict: 'blocked_review' }   (the lead is waiting for the owner)
//   { verdict: 'blocked_quota', quota }
//   { verdict: 'allowed', quota }
//
// IMPORTANT: this function only decides — it never sends and never
// increments a quota counter itself. Callers remain responsible for
// actually sending and for calling incrementLeadSends/
// incrementWhatsAppSends afterward, exactly as before. This keeps
// the gate safe to call speculatively (e.g. from a workflow dry run)
// without any risk of double-charging a quota.
//
// `channel` is 'email' or 'whatsapp'.
async function gateOutboundReply({ userId, user, lead, db, channel = 'email', runId = null, note = null, businessContext = null }) {
  channel = channel === 'whatsapp' ? 'whatsapp' : 'email';

  // A lead waiting for the owner (Review tab, or AI paused in the Inbox) gets nothing automatic until the owner acts.
  // Read fresh from the database: the flag is set after the workflow run was queued.
  if (lead && lead.id) {
    let waiting = !!lead.needsHumanReview;
    if (!waiting && db) {
      try {
        const row = await db.queryOne('SELECT needs_human_review FROM leads WHERE id=$1 AND user_id=$2', [lead.id, userId]);
        waiting = !!(row && row.needs_human_review);
      } catch (_) { /* fail open on a read error: the quota gate below still applies */ }
    }
    if (waiting) return { verdict: 'blocked_review' };
  }

  // Quota, per channel.
  if (channel === 'whatsapp') {
    const quota = await checkWhatsAppQuota(userId, user, db);
    if (!quota.allowed) return { verdict: 'blocked_quota', quota };
    return { verdict: 'allowed', quota };
  }

  const quota = await checkSendQuota(userId, user, db);
  if (!quota.allowed) return { verdict: 'blocked_quota', quota };
  return { verdict: 'allowed', quota };
}

// ── GET /api/leads/:id/deal-insights — AI Deal Insights (Pro/Max) ──
// The "why is this stalling / what objections exist / what should happen
// next" read on a single deal — the AI Sales Manager's take on one lead,
// rather than the aggregate stats /intelligence returns.
//
// Gated behind plans.js PLANS[key].dealInsights (Pro/Max only — see
// requireDealInsights below). Result is cached on leads.deal_insights and
// only regenerated when the conversation has actually grown (a new turn
// since the cached read was generated) or the caller passes ?refresh=true.
function requireDealInsights(req, res, next) {
  const plan = getPlan((req.user && req.user.plan) || 'free');
  if (!plan.dealInsights) {
    return res.status(402).json({
      success: false,
      message: 'AI Deal Insights (stall reasons, objections, and next-step recommendations) are available on the Pro and Max plans.',
      upgradeRequired: true,
    });
  }
  next();
}

router.get('/:id/deal-insights', leadsLimiter, requireDealInsights, async (req, res) => {
  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const forceRefresh = req.query.refresh === 'true';
  const cached = lead.dealInsights;
  // Cache is still valid if nothing has changed since it was generated —
  // same number of conversation turns and the lead hasn't been closed/reopened.
  const cacheIsFresh = cached && !forceRefresh
    && cached.turnCountAtGeneration === (lead.turnCount || 1)
    && cached.leadStatusAtGeneration === lead.status;

  if (cacheIsFresh) {
    return res.json({ success: true, insights: cached, cached: true });
  }

  try {
    const businessContext = await getSettings(req.user.id, req._db);
    // Reuse the same stage detector the reply engine uses, so the stage
    // shown here always matches what's driving the AI's actual replies.
    const stageInfo = await detectConversationStage(
      claude, MODEL, lead, { customerName: lead.customerName }, businessContext, lead.conversationHistory
    );
    const result = await generateDealInsights(claude, MODEL, lead, businessContext, stageInfo);

    const insights = {
      ...result,
      generatedAt: new Date().toISOString(),
      turnCountAtGeneration: lead.turnCount || 1,
      leadStatusAtGeneration: lead.status,
    };

    await updateLead(req.user.id, lead.id, { dealInsights: insights }, req._db);
    res.json({ success: true, insights, cached: false });
  } catch (err) {
    console.error('[leads] deal-insights error:', err.message);
    res.status(500).json({ success: false, message: 'Could not generate deal insights.' });
  }
});


// ── GET /api/leads/:id/score — AI Lead Scoring (Growth/Pro/Max) ──
// Returns score 0–100, close probability %, estimated value, and
// five factor breakdowns. Cached on leads.ai_score; only regenerates
// when the conversation has grown since the last score or ?refresh=true.
function requireLeadScoring(req, res, next) {
  const plan = getPlan((req.user && req.user.plan) || 'free');
  if (!plan.leadScoring) {
    return res.status(402).json({
      success: false,
      message: 'AI Lead Scoring is available on the Pro plan.',
      upgradeRequired: true,
    });
  }
  next();
}

router.get('/:id/score', leadsLimiter, requireLeadScoring, async (req, res) => {
  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const forceRefresh = req.query.refresh === 'true';
  const cached = lead.aiScore;
  const cacheIsFresh = cached && !forceRefresh
    && cached.turnCountAtGeneration === (lead.turnCount || 1)
    && cached.leadStatusAtGeneration === lead.status;

  if (cacheIsFresh) {
    return res.json({ success: true, score: cached, cached: true });
  }

  try {
    const businessContext = await getSettings(req.user.id, req._db);
    const result = await scoreLead(claude, MODEL, lead, businessContext);
    if (!result) return res.status(500).json({ success: false, message: 'Could not generate score.' });

    await updateLead(req.user.id, lead.id, { aiScore: result }, req._db);
    res.json({ success: true, score: result, cached: false });
  } catch (err) {
    console.error('[leads] score error:', err.message);
    res.status(500).json({ success: false, message: 'Could not generate lead score.' });
  }
});

// ── GET /api/leads/settings ───────────────────────────────────
router.get('/settings', async (req, res) => {
  // Four independent reads: run them together rather than one after another.
  const [settings, setup_complete, sendsUsed, waUsed] = await Promise.all([
    getSettings(req.user.id, req._db),
    hasCompletedSetup(req.user.id, req._db),
    getLeadSendsUsed(req.user.id, req._db),
    getWhatsAppSendsUsed(req.user.id, req._db),
  ]);
  const { limit: planLimit } = getPlanLimit(req.dbUser);
  const sendQuota = {
    used:      sendsUsed,
    limit:     planIsUnlimited(planLimit) ? null : planLimit,
    unlimited: planIsUnlimited(planLimit),
  };
  const waLimit = getPlan((req.dbUser && req.dbUser.plan) || 'free').whatsappLimit;
  const whatsappQuota = {
    used:      waUsed,
    limit:     planIsUnlimited(waLimit) ? null : waLimit,
    unlimited: planIsUnlimited(waLimit),
  };
  res.json({ success: true, settings: { ...settings, leadSendsUsed: sendsUsed }, setup_complete, sendQuota, whatsappQuota });
});

// ── PUT /api/leads/settings ───────────────────────────────────
router.put('/settings', async (req, res) => {
  const { businessName, businessType, ownerName, phone, bookingUrl, currency, services,
    website, address, description, targetCustomer, responseTime, specialInstructions, timezone, agentMode,
    defaultAppointmentDuration, bufferTime, businessHoursStart, businessHoursEnd, businessDays, noticePeriod,
    businessHours, timezoneConfirmed } = req.body;
  if (timezone !== undefined && !validTimezone(timezone)) {
    return res.status(400).json({ success: false, message: 'That time zone is not recognised. Pick one from the list.' });
  }
  // Opening hours: one entry per weekday. The old single-range fields are kept in step for anything that still reads them.
  let hoursFields = {};
  if (businessHours !== undefined) {
    const v = validateSchedule(businessHours);
    if (!v.ok) return res.status(400).json({ success: false, message: v.error });
    hoursFields = { businessHours: v.schedule, ...legacyFields(v.schedule) };
  }
  if (services && !Array.isArray(services)) {
    return res.status(400).json({ success: false, message: 'services must be an array' });
  }
  if (services) services.forEach(normalizeService);
  // There is no manual-approval mode: replies always send on their own.
  const resolvedAgentMode = 'autonomous';
  try {
    // Merge over what is already saved and ignore fields the client did not send.
    // Without this, saving from one screen silently reset every setting it
    // does not show (agent mode, hours, rules, deal profile...) to defaults.
    const current = await getSettings(req.user.id, req._db);
    const incoming = { businessName, businessType, ownerName, phone, bookingUrl, currency, services,
      website, address, description, targetCustomer, responseTime, specialInstructions, timezone, agentMode: resolvedAgentMode,
      defaultAppointmentDuration, bufferTime, businessHoursStart, businessHoursEnd, businessDays, noticePeriod,
      ...(timezoneConfirmed === true ? { timezoneConfirmed: true } : {}),
      ...pickQuoteSettings(req.body || {}), ...hoursFields };
    Object.keys(incoming).forEach(k => { if (incoming[k] === undefined) delete incoming[k]; });
    await saveSettings(req.user.id, { ...current, ...incoming }, req._db);
  } catch (e) {
    console.error('[PUT /settings] Save error:', e.message);
    return res.status(500).json({ success: false, message: 'Failed to save settings: ' + e.message });
  }
  const saved = await getSettings(req.user.id, req._db);
  const setup_complete = await hasCompletedSetup(req.user.id, req._db);
  const sendsUsed = await getLeadSendsUsed(req.user.id, req._db);
  const { limit: planLimit2 } = getPlanLimit(req.dbUser);
  res.json({ success: true, settings: { ...saved, leadSendsUsed: sendsUsed }, setup_complete, sendQuota: { used: sendsUsed, limit: planIsUnlimited(planLimit2) ? null : planLimit2, unlimited: planIsUnlimited(planLimit2) } });
});

// ── Human handover ────────────────────────────────────────────
// The team the AI hands closing conversations to, and when. See services/handover.js.
router.get('/handover', async (req, res) => {
  const handoverSvc = require('../services/handover');
  const settings = await getSettings(req.user.id, req._db);
  const cfg = handoverSvc.normalizeConfig(settings);
  res.json({
    success: true,
    handover: { enabled: cfg.enabled, stages: cfg.stages, contacts: cfg.contacts, copyOwner: cfg.copyOwner },
    stageChoices: handoverSvc.STAGE_CHOICES,
    services: (settings.services || []).map(sv => sv && sv.name).filter(Boolean),
    maxContacts: handoverSvc.MAX_CONTACTS,
  });
});

router.put('/handover', async (req, res) => {
  const handoverSvc = require('../services/handover');
  const v = handoverSvc.validateConfig(req.body || {});
  if (!v.ok) return res.status(400).json({ success: false, message: v.error });
  try {
    const current = await getSettings(req.user.id, req._db);
    await saveSettings(req.user.id, { ...current, ...v.config }, req._db);
  } catch (e) {
    console.error('[PUT /handover] Save error:', e.message);
    return res.status(500).json({ success: false, message: 'Could not save: ' + e.message });
  }
  const cfg = handoverSvc.normalizeConfig(await getSettings(req.user.id, req._db));
  res.json({ success: true, handover: { enabled: cfg.enabled, stages: cfg.stages, contacts: cfg.contacts, copyOwner: cfg.copyOwner } });
});

// Hand one lead to a person now (any stage). Body: { contactId } — omit it to hand it to yourself.
router.post('/:id/handover', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  const settings = await getSettings(req.user.id, req._db);
  const out = await require('../services/handover').manualHandover({
    db: req._db, user: req.dbUser || { id: req.user.id, email: req.user.email }, lead, businessContext: settings,
    contactId: req.body && req.body.contactId ? String(req.body.contactId) : null,
  });
  if (!out.ok) return res.status(400).json({ success: false, message: out.error });
  const fresh = await getLeadById(req.user.id, req.params.id, req._db);
  res.json({ success: true, delivered: out.delivered !== false, notifyError: out.error || null, lead: fresh });
});

// Give the conversation back to the AI.
router.post('/:id/handover/resume', leadsLimiter, async (req, res) => {
  const ok = await require('../services/handover').resumeAI(req._db, req.user.id, req.params.id);
  if (!ok) return res.status(400).json({ success: false, message: 'This lead is not handed over.' });
  res.json({ success: true, lead: await getLeadById(req.user.id, req.params.id, req._db) });
});

// ── GET /api/leads/followups/pending ─────────────────────────
router.get('/followups/pending', async (req, res) => {
  if (!req._db) return res.json({ success: true, jobs: [] });
  try {
    const rows = await req._db.queryAll(
      `SELECT id, lead_id, template, day, label, scheduled_at, status, attempts, last_error, sent_at, created_at
         FROM lead_followup_jobs
        WHERE user_id=$1 AND status='pending'
        ORDER BY scheduled_at ASC`,
      [req.user.id]
    );
    const jobs = rows.map(r => ({
      id:          r.id,
      leadId:      r.lead_id,
      template:    r.template,
      day:         r.day,
      label:       r.label,
      sendAt:      r.scheduled_at,
      status:      r.status,
      attempts:    r.attempts,
      lastError:   r.last_error,
      sentAt:      r.sent_at,
      createdAt:   r.created_at,
    }));
    res.json({ success: true, jobs });
  } catch (e) {
    console.error('[GET /followups/pending] error:', e.message);
    res.json({ success: true, jobs: [] });
  }
});

// ── GET /api/leads/:id ────────────────────────────────────────
// ── GET /api/leads/email-settings — connection status ─────────
router.get('/email-settings', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const rawIntg = user?.integrations;
  const intg = getUserIntegrations(user);
  const cfg  = intg.pipeline_email || intg.lead_email || null;
  if (!cfg) return res.json({ success: true, connected: false, config: null });
  const safe = { type: 'email', user: cfg.user, fromName: cfg.fromName || cfg.user, imapHost: cfg.imapHost, smtpHost: cfg.smtpHost };
  res.json({ success: true, connected: true, config: safe });
});

// ── POST /api/leads/email-settings — connect IMAP + SMTP ──────
// One combined account: same email/password authenticates both directions.
router.post('/email-settings', leadsLimiter, async (req, res) => {
  const { user: acctUser, pass, imapHost, imapPort, smtpHost, smtpPort, fromName } = req.body;
  if (!acctUser || !pass || !imapHost || !smtpHost) {
    return res.status(400).json({ success: false, message: 'user, pass, imapHost, and smtpHost are required.' });
  }
  // Debug log — helps diagnose browser autofill injecting wrong password.
  // Logs pass length only (never the password itself).
  console.log(`[email-settings] connect attempt: user=${acctUser} imapHost=${imapHost} smtpHost=${smtpHost} pass_length=${pass ? pass.length : 0} pass_has_spaces=${pass ? pass.includes(' ') : false}`);

  const { verifyImap, verifySmtp } = require('../services/mailbox');
  const candidate = {
    user: acctUser, pass,
    imapHost, imapPort: imapPort || '993',
    smtpHost, smtpPort: smtpPort || '587',
  };

  try {
    await verifyImap(candidate);
  } catch (verifyErr) {
    return res.status(400).json({ success: false, message: verifyErr.message });
  }
  try {
    await verifySmtp(candidate);
  } catch (verifyErr) {
    return res.status(400).json({ success: false, message: verifyErr.message });
  }

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg = getUserIntegrations(user);
  const { buildEmailIntegration } = require('../services/mailbox');
  intg.pipeline_email = buildEmailIntegration({ user: acctUser, pass, imapHost, imapPort, smtpHost, smtpPort, fromName });
  delete intg.lead_email; // legacy key, superseded by pipeline_email
  if (req._db && req._db.Users) await req._db.Users.update(user.id, { integrations: JSON.stringify(intg) });
  res.json({ success: true, config: { type: 'email', user: acctUser, fromName: fromName || acctUser, imapHost, smtpHost } });
});

// ── POST /api/leads/email-settings/test — send test ──────────
router.post('/email-settings/test', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg = getUserIntegrations(user);
  const cfg  = intg.pipeline_email || intg.lead_email;
  if (!cfg) return res.status(400).json({ success: false, message: 'No email account connected.' });
  try {
    const { sendLeadReply } = require('../services/leads/ingestion');
    const toAddr = cfg.fromEmail || cfg.user;
    await sendLeadReply({ user, to: toAddr, subject: 'Humarains - email connection test', body: 'Your email account is connected and working.\n\n- Humarains' });
    res.json({ success: true, message: 'Test sent to ' + toAddr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/leads/email-settings — disconnect ─────────────
router.delete('/email-settings', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg = getUserIntegrations(user);
  delete intg.pipeline_email;
  delete intg.lead_email;
  if (req._db && req._db.Users) await req._db.Users.update(user.id, { integrations: JSON.stringify(intg) });
  res.json({ success: true });
});

// ── GET /api/leads/consent-queue — leads awaiting approval ────
// NOTE: must be defined before /:id to prevent Express swallowing it as a wildcard match
router.get('/consent-queue', async (req, res) => {
  if (!req._db) return res.json({ success: true, leads: [] });
  try {
    const rows = await req._db.queryAll(
      `SELECT * FROM leads WHERE user_id=$1 AND pending_approval=true ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, leads: rows.map(rowToLead), count: rows.length });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/leads/human-review — leads needing human response ─
// NOTE: must be defined before /:id to prevent Express swallowing it as a wildcard match
router.get('/human-review', async (req, res) => {
  if (!req._db) return res.json({ success: true, leads: [] });
  try {
    const rows = await req._db.queryAll(
      `SELECT * FROM leads WHERE user_id=$1 AND needs_human_review=true AND COALESCE(human_review_reason,'') <> $2 ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
      [req.user.id, INBOX_PAUSE_REASON]
    );
    res.json({ success: true, leads: rows.map(rowToLead), count: rows.length });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR INTEGRATION
// Routes: /api/leads/calendar/*
// ════════════════════════════════════════════════════════════════

// ── GET /api/leads/calendar/status — is calendar connected? ───
router.get('/calendar/status', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg   = getUserIntegrations(user);
  const status = getCalendarStatus(intg);
  res.json({ success: true, ...status });
});

// ── GET /api/leads/calendar/events — list upcoming events ─────
// Pass ?maxResults=N (default 25) and/or ?timeMin=<ISO date> to override
// the window. Shows everything on the user's primary calendar, not just
// events Humarains created.
router.get('/calendar/events', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  const calStatus = getCalendarStatus(intg);
  if (!calStatus.connected) {
    return res.status(400).json({ success: false, message: 'Google Calendar is not connected.' });
  }

  const maxResults = Math.min(parseInt(req.query.maxResults, 10) || 25, 100);
  const timeMin    = req.query.timeMin || undefined;

  const result = await listCalendarEvents({ userIntg: intg, maxResults, timeMin, onTokenRefresh: makeCalendarTokenRefreshFn(req._db, user.id) });
  if (!result.success) {
    return res.status(500).json({ success: false, message: result.error || 'Failed to fetch calendar events.' });
  }

  res.json({ success: true, events: result.events });
});

// ── GET /api/leads/calendar/connect — start Google OAuth ──────
router.get('/calendar/connect', (req, res) => {
  if (!getPlan((req.dbUser && req.dbUser.plan) || 'free').calendar) {
    return res.status(403).json({
      success: false,
      needsUpgrade: true,
      message: 'Google Calendar booking is available on the Growth plan and above. Upgrade to connect your calendar.',
    });
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ success: false, message: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
  }
  try {
    const { url } = generateCalendarAuthUrl(req.user.id);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ════════════════════════════════════════════════════════════════
// WHATSAPP — GET STATUS ROUTES (moved before /:id wildcard)
// ════════════════════════════════════════════════════════════════

// ── GET /api/leads/whatsapp/status ────────────────────────────
router.get('/whatsapp/status', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  const wa   = intg?.whatsapp;

  if (wa?.phoneNumberId && wa?.accessToken) {
    return res.json({
      success:      true,
      connected:    true,
      source:       'user',
      phoneNumberId: wa.phoneNumberId,
      wabaId:        wa.wabaId        || null,
      displayPhone:  wa.displayPhone || null,
      verifiedName:  wa.verifiedName || null,
      // Stored by the background check (services/whatsapp-maintenance.js); a delivery failure that broke the connection overrides it.
      health: wa.alert
        ? { ok: false, problem: wa.alert.message, needsRegister: false }
        : (wa.health ? { ok: !!wa.health.ok, problem: wa.health.problem || null, needsRegister: !!wa.health.needsRegister } : null),
    });
  }

  // Fall back to server env vars
  if (waIsConfigured()) {
    return res.json({
      success:      true,
      connected:    true,
      source:       'server',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      displayPhone:  null,
      verifiedName:  null,
    });
  }

  res.json({ success: true, connected: false, embeddedSignupConfigured: isEmbeddedSignupConfigured() });
});

// ── GET /api/leads/whatsapp/embedded-signup/config ─────────────
// Public-to-the-tenant config the frontend needs to launch the
// Facebook Embedded Signup popup (no secrets — App ID + Config ID
// are not sensitive; they're meant to be loaded client-side).
router.get('/whatsapp/embedded-signup/config', (req, res) => {
  if (!isEmbeddedSignupConfigured()) {
    return res.json({ success: true, configured: false });
  }
  res.json({
    success:    true,
    configured: true,
    appId:      process.env.META_APP_ID,
    configId:   process.env.META_CONFIG_ID,
  });
});

// ── POST /api/leads/whatsapp/embedded-signup — finish the popup flow ─
// Body: { code, phoneNumberId, wabaId } — from the FB.login() Embedded Signup popup.
// Exchanges the code for a business token, registers the number for Cloud API
// use, subscribes this app to the WABA's webhooks, and saves it to the account.
router.post('/whatsapp/embedded-signup', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if (!getPlan(user.plan || 'free').whatsapp) {
    return res.status(403).json({
      success: false,
      needsUpgrade: true,
      message: 'WhatsApp is available on the Starter plan and above. Upgrade to connect a WhatsApp number.',
    });
  }

  if (!isEmbeddedSignupConfigured()) {
    return res.status(503).json({ success: false, message: 'WhatsApp Embedded Signup is not configured on this server.' });
  }

  const { code, phoneNumberId, wabaId } = req.body;
  if (!code || !phoneNumberId || !wabaId) {
    return res.status(400).json({ success: false, message: 'code, phoneNumberId, and wabaId are required.' });
  }

  try {
    const result = await completeEmbeddedSignup({ code, phoneNumberId, wabaId });

    {
      const intg = getUserIntegrations(user);
      intg.whatsapp = {
        phoneNumberId: result.phoneNumberId,
        wabaId:        result.wabaId,
        accessToken:   result.accessToken,
        displayPhone:  result.displayPhoneNumber || null,
        verifiedName:  result.verifiedName       || null,
        connectedAt:   new Date().toISOString(),
        connectedVia:  'embedded_signup',
      };
      await req._db.Users.update(user.id, { integrations: JSON.stringify(intg) });
      console.log(`[WhatsApp] User ${user.id} connected via Embedded Signup — phone number ID ${result.phoneNumberId}`);
    }

    // Run a first health check in the background so the owner never has to (it also registers the number if Meta has not activated it yet).
    {
      const wm = require('../services/whatsapp-maintenance');
      Promise.resolve()
        .then(() => wm.syncUserHealth(req._db, { id: user.id, wa: { phoneNumberId: result.phoneNumberId, wabaId: result.wabaId, accessToken: result.accessToken } }))
        .catch(e => console.warn('[WhatsApp] post-connect setup failed:', e.message));
    }

    res.json({
      success:      true,
      phoneNumberId: result.phoneNumberId,
      wabaId:        result.wabaId,
      displayPhone:  result.displayPhoneNumber || null,
      verifiedName:  result.verifiedName       || null,
      registerError: result.registerError      || null,
    });
  } catch (err) {
    console.error('[WhatsApp] Embedded Signup failed:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/whatsapp/reregister — activate the number on the Cloud API ─
router.post('/whatsapp/reregister', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const wa = getUserIntegrations(user)?.whatsapp;
  if (!wa?.phoneNumberId || !wa?.accessToken) return res.status(400).json({ success: false, message: 'WhatsApp is not connected.' });
  const w = require('../services/whatsapp');
  // Never re-register a number Meta has flagged (it cannot fix that and looks like probing), and never more than once an hour.
  if (wa.health && wa.health.policy) {
    return res.status(409).json({ success: false, message: 'Meta has flagged this number, so Humarains will not try to re-register it. Open Account Quality in Meta Business Suite to see why and to appeal.' });
  }
  if (wa.health && wa.health.lastRegisterAt && Date.now() - wa.health.lastRegisterAt < 3600_000) {
    return res.status(429).json({ success: false, message: 'This number was registered less than an hour ago. Wait a little before trying again.' });
  }
  await require('../services/wa-state').writeWaKey(req._db, user.id, 'health', { ...(wa.health || {}), lastRegisterAt: Date.now() }).catch(() => {});
  let registerError = null;
  try { await w.registerPhoneNumber({ phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken }); }
  catch (e) { registerError = e.message; console.error('[WhatsApp] re-register failed:', e.message); }
  if (wa.wabaId) { try { await w.subscribeAppToWaba({ wabaId: wa.wabaId, accessToken: wa.accessToken }); } catch (e) { console.warn('[WhatsApp] re-subscribe failed:', e.message); } }
  const health = await w.getNumberHealth({ phoneNumberId: wa.phoneNumberId, wabaId: wa.wabaId, accessToken: wa.accessToken });
  res.json({ success: !registerError && health.ok, registerError, health,
    message: registerError ? 'Registration failed: ' + registerError : (health.problem || 'Number is active on the WhatsApp Cloud API.') });
});

// ── DELETE /api/leads/whatsapp/disconnect ─────────────────────
router.delete('/whatsapp/disconnect', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  delete intg.whatsapp;
  await req._db.Users.update(user.id, { integrations: JSON.stringify(intg) });
  console.log(`[WhatsApp] User ${user.id} disconnected WhatsApp`);
  res.json({ success: true });
});

// The WhatsApp webhook (GET verification and POST inbound messages) lives in server.js, where it is public and feeds the durable
// inbound queue (services/inbound-queue.js -> services/whatsapp-inbound.js). It is deliberately not repeated here.

// ── POST /api/leads/whatsapp/send/:id — send AI reply ────────
router.post('/whatsapp/send/:id', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (!getPlan(user.plan || 'free').whatsapp) {
    return res.status(403).json({ success: false, needsUpgrade: true, message: 'WhatsApp is available on the Starter plan and above. Upgrade to keep sending WhatsApp replies.' });
  }
  if (!userHasWACreds(user)) {
    return res.status(503).json({ success: false, message: 'WhatsApp is not connected. Go to the WhatsApp settings to connect your phone number.' });
  }
  const waQuota = await checkWhatsAppQuota(req.user.id, user, req._db);
  if (!waQuota.allowed) {
    return res.status(403).json({ success: false, quotaExceeded: true, message: whatsappQuotaExceededMessage(waQuota), used: waQuota.used, limit: waQuota.limit });
  }

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (!lead.aiReply) return res.status(400).json({ success: false, message: 'Lead has no AI reply. Process it first.' });

  const to = lead.whatsappThreadPhone || lead.fromPhone;
  if (!to) return res.status(400).json({ success: false, message: 'Lead has no WhatsApp phone number.' });

  const body = typeof lead.aiReply === 'string' ? lead.aiReply : (lead.aiReply.body || '');
  if (!body) return res.status(400).json({ success: false, message: 'AI reply body is empty.' });

  const creds = getWACreds(user);
  try {
    const sentWA = await sendWAAuto({ to, body, creds, db: req._db, userId: req.user.id });
    const waMessageId = sentWA.id;
    await require('../services/media-library').sendReplyPhotosWhatsApp(req._db, req.user.id, lead.aiReply, to, creds);
    const sentAt = new Date().toISOString();

    // WhatsApp conversations get no scheduled follow-ups: the AI simply replies whenever the customer writes again.
    const updatedLead = await updateLead(req.user.id, lead.id, {
      status: 'pending_followup', sentAt,
      whatsappMessageId: waMessageId,
      whatsappThreadPhone: to,
      // The owner has now dealt with this lead. A leftover review flag would stop every later auto-reply.
      needsHumanReview: false, humanReviewReason: null,
    }, req._db);

    await incrementWhatsAppSends(req.user.id, req._db);

    res.json({
      success: true, lead: updatedLead, sentAt, waMessageId,
      whatsappQuota: { used: waQuota.used + 1, limit: planIsUnlimited(waQuota.limit) ? null : waQuota.limit, unlimited: waQuota.unlimited },
    });
  } catch (err) {
    if (err.whatsappBlocked) return res.status(409).json({ success: false, blockedBy: err.blockedBy, message: err.message });
    console.error('[WhatsApp] Send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/whatsapp/test — send a test message ───────
// WhatsApp only lets a business message someone who messaged it in the last 24 hours. So the test goes to the owner's own phone
// after they have sent any message (for example "hi") to the connected number. The consent gate refuses everyone else.
router.post('/whatsapp/test', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (!userHasWACreds(user)) {
    return res.status(503).json({ success: false, message: 'WhatsApp is not connected yet.' });
  }
  const { to } = req.body;
  if (!to) return res.status(400).json({ success: false, message: '`to` phone number is required.' });
  const consent = require('../services/wa-consent');
  const phone = consent.normalisePhone(to);
  if (phone.length < 8) return res.status(400).json({ success: false, message: 'Enter the phone number with its country code, for example +6581234567.' });
  const creds = getWACreds(user);
  const body = 'This is a test message from Humarains. Your WhatsApp integration is working correctly.';
  try {
    const sent = await sendWAAuto({ to: phone, body, creds, db: req._db, userId: req.user.id });
    res.json({ success: true, waMessageId: sent.id, message: 'Test message sent to ' + to });
  } catch (err) {
    if (err.whatsappBlocked) {
      const needsHello = err.blockedBy === 'no_consent' || err.blockedBy === 'window_closed';
      return res.status(409).json({ success: false, blockedBy: err.blockedBy,
        message: needsHello
          ? 'WhatsApp only allows a message to someone who messaged your business number in the last 24 hours. From that phone, send any message (for example "hi") to your WhatsApp Business number, then press Send Test again.'
          : err.message });
    }
    console.error('[WhatsApp] test send failed:', err.message);
    res.status(err.waCode ? 502 : 500).json({ success: false, message: err.message });
  }
});


// ── Factory: create router with db injected ───────────────────
// ════════════════════════════════════════════════════════════════
// Inbox: every customer conversation (WhatsApp and email) as a chat the owner can read and answer.
//   GET  /api/leads/inbox/conversations                  every chat, newest first
//   GET  /api/leads/inbox/conversations/:id              one chat: messages and whether you can reply right now
//   POST /api/leads/inbox/conversations/:id/messages     send a message as the owner
//   POST /api/leads/inbox/conversations/:id/ai           pause or resume the AI on one chat
// These sit above '/:id' so the path is never read as a lead id. WhatsApp messages go through the same
// consent gate as every other outbound path (wa-consent.js): only people who messaged you on WhatsApp,
// never someone who opted out, and only inside WhatsApp's 24-hour reply window. Email replies use your
// connected inbox and count toward your monthly email sends.
// ════════════════════════════════════════════════════════════════
const INBOX_PAUSE_REASON = 'You paused the AI on this chat in the Inbox.';
const INBOX_MESSAGE_MAX  = 1000;
const WA_WINDOW_MS       = 24 * 3600 * 1000;
const isWhatsAppLead     = l => String(l.source || '').toLowerCase() === 'whatsapp' || !!l.whatsappThreadPhone;

// 'customer' | 'owner' | 'ai' for the bubble label; direction decides which side it sits on.
function inboxMessage(turn, index) {
  const customer = turn.role === 'customer';
  return {
    id: index,
    direction: customer ? 'inbound' : 'outbound',
    by: customer ? 'customer' : (turn.source === 'owner' ? 'owner' : 'ai'),
    body: String(turn.body || ''),
    subject: turn.subject || null,
    at: turn.sentAt || null,
    pending: !!turn.pending && !turn.sentAt,   // an AI draft waiting for approval: never sent
    photos: Number(turn.photos) || 0,
  };
}

// Can the owner reply right now? WhatsApp: only inside the 24-hour window and never after an opt-out.
// Email: whenever the customer left an address.
function inboxReplyState(channel, { lastInboundAt, optedOutAt, email } = {}) {
  if (channel === 'email') {
    return { windowOpen: !!email, windowClosesAt: null, optedOut: false, canReply: !!email, blockedReason: email ? null : 'This customer did not leave an email address.' };
  }
  const t = lastInboundAt ? new Date(lastInboundAt).getTime() : 0;
  const closesAt = t ? t + WA_WINDOW_MS : null;
  const windowOpen = !!closesAt && closesAt - 60000 > Date.now();
  const { MESSAGES } = require('../services/wa-consent');
  let blockedReason = null;
  if (!t) blockedReason = MESSAGES.no_consent;
  else if (optedOutAt) blockedReason = MESSAGES.opted_out;
  else if (!windowOpen) blockedReason = MESSAGES.window_closed;
  return { windowOpen, windowClosesAt: closesAt ? new Date(closesAt).toISOString() : null, optedOut: !!optedOutAt, canReply: !blockedReason, blockedReason };
}

router.get('/inbox/conversations', async (req, res) => {
  if (!req._db) return res.json({ success: true, conversations: [] });
  try {
    const rows = await req._db.queryAll(
      `SELECT l.id, l.customer_name, l.from_name, l.from_email, l.from_phone, l.whatsapp_thread_phone, l.source, l.status,
              l.needs_human_review, l.human_review_reason,
              m.body AS last_body, m.direction AS last_direction, COALESCE(m.sent_at, m.created_at) AS last_at,
              c.last_inbound_at, c.opted_out_at
         FROM leads l
         JOIN LATERAL (
           SELECT body, direction, sent_at, created_at FROM lead_messages
            WHERE lead_id = l.id AND user_id = l.user_id AND pending = false
            ORDER BY seq DESC LIMIT 1) m ON true
         LEFT JOIN whatsapp_contacts c
           ON c.user_id = l.user_id
          AND c.phone = '+' || regexp_replace(COALESCE(l.whatsapp_thread_phone, l.from_phone, ''), '[^0-9]', '', 'g')
        WHERE l.user_id = $1
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC
        LIMIT 300`,
      [req.user.id]
    );
    const conversations = rows.map(r => {
      const channel = (String(r.source || '').toLowerCase() === 'whatsapp' || r.whatsapp_thread_phone) ? 'whatsapp' : 'email';
      const paused = !!r.needs_human_review && r.human_review_reason === INBOX_PAUSE_REASON;
      const phone = r.whatsapp_thread_phone || r.from_phone || null;
      const contact = channel === 'whatsapp' ? phone : r.from_email;
      return {
        id: r.id,
        channel,
        name: r.customer_name || r.from_name || contact || 'Unknown contact',
        contact: contact || null,
        status: r.status,
        preview: String(r.last_body || '').replace(/\s+/g, ' ').slice(0, 140),
        lastDirection: r.last_direction || null,
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        aiPaused: paused,
        needsReview: !!r.needs_human_review && !paused,
        ...inboxReplyState(channel, { lastInboundAt: r.last_inbound_at, optedOutAt: r.opted_out_at, email: r.from_email }),
      };
    });
    res.json({ success: true, conversations });
  } catch (e) {
    console.error('[Inbox] list error:', e.message);
    res.status(500).json({ success: false, message: 'Could not load your conversations.' });
  }
});

router.get('/inbox/conversations/:id', async (req, res) => {
  try {
    const lead = await getLeadById(req.user.id, req.params.id, req._db);
    if (!lead) return res.status(404).json({ success: false, message: 'Chat not found.' });
    const channel = isWhatsAppLead(lead) ? 'whatsapp' : 'email';
    const phone = lead.whatsappThreadPhone || lead.fromPhone || null;
    const contact = channel === 'whatsapp' && phone ? await require('../services/wa-consent').getContact(req._db, req.user.id, phone) : null;
    const history = Array.isArray(lead.conversationHistory) ? lead.conversationHistory : [];
    const paused = !!lead.needsHumanReview && lead.humanReviewReason === INBOX_PAUSE_REASON;
    res.json({
      success: true,
      chat: {
        id: lead.id, channel, name: lead.customerName || lead.fromName || (channel === 'whatsapp' ? phone : lead.fromEmail) || 'Unknown contact',
        contact: channel === 'whatsapp' ? phone : (lead.fromEmail || null), status: lead.status,
        aiPaused: paused, needsReview: !!lead.needsHumanReview && !paused, reviewReason: !paused ? (lead.humanReviewReason || null) : null,
        ...inboxReplyState(channel, { lastInboundAt: contact && contact.last_inbound_at, optedOutAt: contact && contact.opted_out_at, email: lead.fromEmail }),
      },
      messages: history.map(inboxMessage).slice(-300),
    });
  } catch (e) {
    console.error('[Inbox] thread error:', e.message);
    res.status(500).json({ success: false, message: 'Could not load this chat.' });
  }
});

router.post('/inbox/conversations/:id/messages', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const body = typeof (req.body && req.body.body) === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ success: false, message: 'Type a message first.' });
  if (body.length > INBOX_MESSAGE_MAX) return res.status(400).json({ success: false, message: `Messages can be up to ${INBOX_MESSAGE_MAX} characters.` });

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Chat not found.' });
  const channel = isWhatsAppLead(lead) ? 'whatsapp' : 'email';

  let sentId = null, subject = null, quotaOut = {};
  if (channel === 'whatsapp') {
    if (!getPlan(user.plan || 'free').whatsapp) {
      return res.status(403).json({ success: false, needsUpgrade: true, message: 'WhatsApp is available on the Starter plan and above.' });
    }
    if (!userHasWACreds(user)) return res.status(503).json({ success: false, message: 'WhatsApp is not connected. Connect your number under Channels first.' });
    const to = lead.whatsappThreadPhone || lead.fromPhone;
    if (!to) return res.status(400).json({ success: false, message: 'This chat has no WhatsApp number.' });
    const waQuota = await checkWhatsAppQuota(req.user.id, user, req._db);
    if (!waQuota.allowed) {
      return res.status(403).json({ success: false, quotaExceeded: true, message: whatsappQuotaExceededMessage(waQuota), used: waQuota.used, limit: waQuota.limit });
    }
    try {
      sentId = (await sendWAAuto({ to, body, creds: getWACreds(user), db: req._db, userId: req.user.id })).id;
    } catch (err) {
      if (err.whatsappBlocked) return res.status(409).json({ success: false, blockedBy: err.blockedBy, message: err.message });
      console.error('[Inbox] WhatsApp send error:', err.message);
      return res.status(502).json({ success: false, message: err.message || 'WhatsApp could not send this message.' });
    }
    quotaOut = { whatsappQuota: { used: waQuota.used + 1, limit: planIsUnlimited(waQuota.limit) ? null : waQuota.limit, unlimited: waQuota.unlimited } };
  } else {
    if (!lead.fromEmail) return res.status(400).json({ success: false, message: 'This customer did not leave an email address.' });
    const quota = await checkSendQuota(req.user.id, user, req._db);
    if (!quota.allowed) return res.status(402).json({ success: false, quotaExceeded: true, message: quotaExceededMessage(quota), used: quota.used, limit: quota.limit });
    const base = (lead.aiReply && lead.aiReply.subject) || lead.subject || 'Your enquiry';
    subject = /^re:/i.test(base) ? base : `Re: ${base}`;
    try {
      await sendLeadReply({ user, to: lead.fromEmail, subject, body, ...threadingFor(lead) });
    } catch (err) {
      console.error('[Inbox] email send error:', err.message);
      return res.status(502).json({ success: false, message: err.message || 'The email could not be sent. Check your email connection under Channels.' });
    }
    await incrementLeadSends(req.user.id, req.dbUser, req._db).catch(() => {});
  }

  // The message is out. Record it on a fresh copy of the lead so a customer message that arrived
  // while we were sending is not overwritten. A failed save must not look like a failed send.
  const sentAt = new Date().toISOString();
  const turn = { role: 'agent', body, ...(subject ? { subject } : {}), sentAt, ...(sentId ? { externalId: sentId } : {}), source: 'owner' };
  let message = inboxMessage(turn, (lead.conversationHistory || []).length);
  try {
    const fresh = (await getLeadById(req.user.id, lead.id, req._db)) || lead;
    const history = [...(Array.isArray(fresh.conversationHistory) ? fresh.conversationHistory : []), turn];
    message = inboxMessage(turn, history.length - 1);
    // Replying yourself settles a review flag the system raised. A pause you chose stays until you resume.
    const settleReview = fresh.needsHumanReview && fresh.humanReviewReason !== INBOX_PAUSE_REASON;
    await updateLead(req.user.id, lead.id, {
      conversationHistory: history, sentAt,
      ...(channel === 'whatsapp' ? { whatsappMessageId: sentId, whatsappThreadPhone: lead.whatsappThreadPhone || lead.fromPhone } : {}),
      status: fresh.status === 'new' ? 'replied' : fresh.status,
      ...(settleReview ? { needsHumanReview: false, humanReviewReason: null } : {}),
    }, req._db);
  } catch (e) {
    console.error('[Inbox] message sent but not saved to the lead:', e.message);
  }
  if (channel === 'whatsapp') await incrementWhatsAppSends(req.user.id, req._db).catch(() => {});
  res.json({ success: true, message, channel, ...quotaOut });
});

router.post('/inbox/conversations/:id/ai', async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Chat not found.' });
  const pause = !!(req.body && req.body.paused);
  const updated = await updateLead(req.user.id, lead.id,
    pause ? { needsHumanReview: true, humanReviewReason: INBOX_PAUSE_REASON } : { needsHumanReview: false, humanReviewReason: null }, req._db);
  if (!updated) return res.status(500).json({ success: false, message: 'Could not update this chat.' });
  res.json({ success: true, aiPaused: pause });
});

function createLeadsRouter(db, requireAuth) {
  const r = express.Router();
  // NOTE: requireAuth is intentionally NOT re-applied here — server.js already
  // runs requireAuth + attachLeadsUser before mounting this router. Re-running
  // requireAuth would overwrite req.user and discard the plan/analyses_used/
  // analyses_limit fields attachLeadsUser attaches. The `requireAuth` param is
  // kept for backward compatibility with callers that may still pass it in.

  // Attach db to every request.
  // NOTE: req.dbUser is already set by attachLeadsUser in server.js —
  // no need to re-fetch the user here, which would double the DB query.
  r.use((req, res, next) => {
    req._db = db;
    next();
  });

  r.use('/', router);
  return r;
}

module.exports = {
  createLeadsRouter,
  normalizeService,
  migrateLegacyPricing,
  // Exported for use by the background poller — single source of truth
  rowToLead,
  storeLead,
  getSettings,
  saveSettings,
  updateLead,
  getLeadById,
  checkSendQuota,
  incrementLeadSends,
  isPaidPlan,
  sendWithQuota,
  // Exported so services/workflows/engine.js's send_message step enforces the exact
  // same approval/consent/quota rules as every direct send path in this
  // file, instead of re-implementing (and inevitably drifting from) them.
  gateOutboundReply,
  checkWhatsAppQuota,
  incrementWhatsAppSends,
  whatsappQuotaExceededMessage,
  quotaExceededMessage,
  // Used by the Agent's calendar tool.
  makeCalendarTokenRefreshFn,
  getUserIntegrations,
  getCalendarStatus,
  applyOptOut,
};

router.get('/:id', async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  res.json({ success: true, lead });
});

// ── GET /api/leads/:id/messages — the conversation as rows (lead_messages) ─
router.get('/:id/messages', async (req, res) => {
  if (!req._db) return res.json({ success: true, messages: [] });
  try {
    const lead = await getLeadById(req.user.id, req.params.id, req._db);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
    const messages = await require('../services/lead-messages').listMessages(req._db, req.user.id, req.params.id, {
      limit: parseInt(req.query.limit, 10) || 200, offset: parseInt(req.query.offset, 10) || 0,
    });
    res.json({ success: true, messages });
  } catch (e) {
    console.error('[leads] messages error:', e.message);
    res.status(500).json({ success: false, message: 'Could not load messages.' });
  }
});

// ── POST /api/leads/ingest — form webhook ─────────────────────
router.post('/ingest', leadsLimiter, async (req, res) => {
  const { fromEmail, fromName, subject, body, formData, source } = req.body;

  if (!fromEmail && !body && !formData) {
    return res.status(400).json({ success: false, message: 'At least one of fromEmail, body, or formData is required.' });
  }

  const lead = normalizeLead({
    source:    source || 'form',
    fromEmail,
    fromName,
    subject,
    body,
    formData,
    businessId: req.user.id,
  });

  await storeLead(req.user.id, lead, req._db);
  console.log(`[Leads] Ingested lead ${lead.id} from ${source || 'form'}`);

  if (req._db) {
    const businessContext = await getSettings(req.user.id, req._db);
    require('../services/workflows/engine').onNewLead({
      db: req._db, user: req.dbUser, businessContext, lead, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onNewLead (ingest) error:', e.message));
  }

  res.status(201).json({ success: true, lead });
});

// ── POST /api/leads/test-lead — onboarding sample lead ─────────
// Creates one realistic sample inquiry and runs it straight through
// processLead() — the same AI-drafting function behind "Process" on a real
// lead — so a brand-new user sees an actual AI-drafted reply, generated from
// their own business profile, within seconds.
//
// Deliberately does NOT go through onNewLead/workflow dispatch: a fresh
// account has no workflows configured yet, so that path would silently do
// nothing. processLead() only drafts a reply — it never sends anything and
// never touches the AI-reply send quota, so trying the product costs a new
// user nothing toward their plan's monthly limit.
const TEST_LEAD_SAMPLES = [
  { subject: 'Interested in your services', body: "Hi, I found your business online and I'm interested in your services. Could someone get in touch with me about next steps? Thanks!", fromName: 'Sample Lead' },
  { subject: 'Getting started', body: "Hello, I'd like to find out more about what you do and how to get started. Please let me know the best way to move forward.", fromName: 'Sample Lead' },
  { subject: 'New enquiry', body: "Hi there, I'm looking for help and came across your business. I'd love to chat about what you can do for me. Thanks!", fromName: 'Sample Lead' },
];

router.post('/test-lead', testLeadLimiter, async (req, res) => {
  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const sample = TEST_LEAD_SAMPLES[Math.floor(Math.random() * TEST_LEAD_SAMPLES.length)];
  const businessContext = await getSettings(req.user.id, req._db);

  try {
    const processed = await processLead(claude, MODEL, {
      source:    'test',
      fromEmail: `test-lead+${Date.now()}@humarains.sample`,
      fromName:  sample.fromName,
      subject:   sample.subject,
      body:      sample.body,
      businessId: req.user.id,
    }, businessContext);

    await storeLead(req.user.id, processed, req._db);
    console.log(`[Leads] Created onboarding test lead ${processed.id} for user ${req.user.id}`);
    // processLead() can return without a drafted reply (disqualified, needs human review, not enough business info).
    // Say why, instead of letting the client fall back to a generic error.
    if (!processed.aiReply || !processed.aiReply.body) {
      const why = processed.humanReviewReason || processed.disqualifyReason || 'The Agent needs a few more business details to reply safely.';
      return res.status(200).json({ success: false, lead: processed, message: why });
    }
    res.status(201).json({ success: true, lead: processed });
  } catch (err) {
    console.error('[Leads] test-lead error:', err.message);
    res.status(500).json({ success: false, message: 'Could not generate a test reply: ' + err.message });
  }
});
// The inbox is read by ONE piece of code: the server-side poller (services/leads/poller.js). This endpoint no longer
// has its own copy of the pipeline; it asks the poller to check now and reports what it handled. (Two readers
// used to race on the unread flag, which could drop mail or send duplicate replies.)
//   body.force  — true for the manual "check now" button: ignore back-off and the recent-check shortcut
//   body.since  — ms timestamp of the previous call; leads the poller handled since then are included
router.post('/ingest/email', leadsLimiter, async (req, res) => {
  if (!getClaude()) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  const emailCfg = intg.pipeline_email || intg.lead_email;
  if (!emailCfg || emailCfg.type !== 'email') {
    return res.status(400).json({ success: false, message: 'Email account not connected.', needsEmail: true });
  }

  try {
    const poller = require('../services/leads/poller');
    const force = !!(req.body && req.body.force);
    const since = parseInt(req.body && req.body.since, 10) || 0;
    const r = await poller.pollUserNow(req.user.id, { force, maxAgeMs: force ? 0 : 15_000 });

    if (!r.ok && (r.reason === 'no_credentials' || r.reason === 'cannot_decrypt')) {
      return res.status(400).json({ success: false, message: (r.error || 'Email password missing or could not be decrypted.') + ' Please reconnect your email account.', needsEmail: true });
    }
    if (!r.ok && r.reason === 'imap_failed') {
      return res.status(502).json({ success: false, message: 'Could not read your inbox: ' + r.error });
    }
    if (!r.ok && r.reason === 'setup_incomplete') {
      return res.status(400).json({ success: false, message: r.error || 'Finish your business setup so replies can be written.' });
    }

    const ids = [...new Set([...(r.leadIds || []), ...poller.recentLeadIds(req.user.id, since)])];
    const leads = [];
    for (const id of ids) {
      const l = await getLeadById(req.user.id, id, req._db);
      if (l) leads.push(l);
    }
    const settings = await getSettings(req.user.id, req._db).catch(() => null);
    res.json({
      success:        true,
      leads,
      count:          leads.length,
      skipped:        r.skipped || 0,
      skippedDetails: r.ignored || [],
      consentQueue:   leads.filter(l => l.pendingApproval).length,
      humanReview:    leads.filter(l => l.needsHumanReview && l.humanReviewReason !== INBOX_PAUSE_REASON).length,
      agentMode:      (settings && settings.agentMode) || 'autonomous',
      reason:         r.reason,
      serverTime:     Date.now(),
    });
  } catch (err) {
    console.error('[Leads] Email ingestion error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/process/:id — AI process ─────────────────
router.post('/process/:id', leadsLimiter, async (req, res) => {
  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const existing = await getLeadById(req.user.id, req.params.id, req._db);
  if (!existing) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const businessContext = await getSettings(req.user.id, req._db);

  try {
    const processed = await processLead(claude, MODEL, {
      source:    existing.source,
      fromEmail: existing.fromEmail,
      fromName:  existing.fromName,
      subject:   existing.subject,
      body:      existing.rawBody,
      formData:  existing.formData,
      businessId: req.user.id,
    }, businessContext);

    processed.id        = existing.id;
    processed.createdAt = existing.createdAt;
    processed.userId    = req.user.id;

    await storeLead(req.user.id, processed, req._db);
    res.json({ success: true, lead: processed });
  } catch (err) {
    console.error('[Leads] Process error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/send-reply/:id — send AI reply ───────────
router.post('/send-reply/:id', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (!lead.aiReply) return res.status(400).json({ success: false, message: 'Lead has no AI reply. Process it first.' });
  if (!lead.fromEmail) return res.status(400).json({ success: false, message: 'Lead has no email address to reply to.' });

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  try {
    const _quota = await checkSendQuota(req.user.id, user, req._db);
    if (!_quota.allowed) {
      return res.status(402).json({ success: false, quotaExceeded: true, message: quotaExceededMessage(_quota), used: _quota.used, limit: _quota.limit });
    }
    // The owner may tweak the wording right before sending (Agent approval cards). What is sent is what is saved.
    const edit = req.body || {};
    if (typeof edit.body === 'string' && edit.body.trim() && typeof lead.aiReply === 'object') {
      const edited = { ...lead.aiReply, body: edit.body.trim().slice(0, 5000) };
      if (typeof edit.subject === 'string' && edit.subject.trim()) edited.subject = edit.subject.trim().slice(0, 200);
      await updateLead(req.user.id, lead.id, { aiReply: edited }, req._db);
      lead.aiReply = edited;
    }
    await sendLeadReply({
      user,
      to:      lead.fromEmail,
      subject: lead.aiReply.subject,
      body:    lead.aiReply.body,
      attachments: await require('../services/media-library').loadReplyPhotos(req._db, req.user.id, lead.aiReply),
      ...threadingFor(lead),
    });
    await incrementLeadSends(req.user.id, req.dbUser, req._db);

    const sentAt = new Date().toISOString();
    const businessContext = await getSettings(req.user.id, req._db);

    // Schedule follow-ups
    const followUpSchedule = buildFollowUpSchedule(lead.id, sentAt);

    const updatedLead = await updateLead(req.user.id, lead.id, {
      status:           'pending_followup',
      sentAt,
      followUpSchedule,
      needsHumanReview: false, humanReviewReason: null,
    }, req._db);

    // Register follow-ups with scheduler
    scheduleFollowUps(
      { ...updatedLead },
      businessContext,
      user,
      async ({ lead: l, subject, body }) => {
        await sendWithQuota(l.userId || req.user.id, user, { user, to: l.fromEmail, subject, body }, req._db, l)
          .catch(err => console.warn(`[Leads] Follow-up quota exceeded for lead`, l.id, err.message));
      }
    );

    require('../services/workflows/engine').onStatusChanged({
      db: req._db, user: req.dbUser, businessContext, lead: updatedLead || lead, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onStatusChanged (send-reply) error:', e.message));

    const sendsUsed = await getLeadSendsUsed(req.user.id, req._db);
    const { limit: _planLimit } = getPlanLimit(user);
    res.json({
      success: true,
      lead:    updatedLead,
      sentAt,
      sendQuota: {
        used:      sendsUsed,
        limit:     planIsUnlimited(_planLimit) ? null : _planLimit,
        unlimited: planIsUnlimited(_planLimit),
      },
    });
  } catch (err) {
    console.error('[Leads] Send reply error:', err.message);
    if (err.quotaExceeded) {
      return res.status(402).json({ success: false, quotaExceeded: true, message: err.message, used: err.used, limit: err.limit });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/followup/:id — manual follow-up ──────────
router.post('/followup/:id', leadsLimiter, async (req, res) => {
  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  // Follow-ups are email only. WhatsApp allows replies within 24 hours of the customer's last message and nothing else, and the AI already
  // answers every WhatsApp message by itself, so there is no follow-up to send on that channel.
  if (lead.source === 'whatsapp' || lead.whatsappThreadPhone) {
    return res.status(400).json({ success: false, message: 'Follow-ups are not sent on WhatsApp. The AI replies whenever this customer writes. To follow up yourself, call or email them.' });
  }
  if (!lead.fromEmail) {
    return res.status(400).json({ success: false, message: 'This lead has no email address to follow up with.' });
  }

  const template = req.body.template || 'reminder';
  const businessContext = await getSettings(req.user.id, req._db);
  const user = req.dbUser;

  try {
    const body = await generateFollowUp(claude, MODEL, lead, template, businessContext);
    const subject = req.body.subject || `Following up — ${lead.aiReply?.subject?.replace(/^Re: /,'') || 'Your enquiry'}`;

    if (!req.body.draftOnly) {
      {
        // Email follow-up
        const _hQuota = await checkSendQuota(req.user.id, user, req._db);
        if (!_hQuota.allowed) {
          return res.status(402).json({ success: false, quotaExceeded: true, message: quotaExceededMessage(_hQuota), used: _hQuota.used, limit: _hQuota.limit });
        }
        await sendLeadReply({ user, to: lead.fromEmail, subject, body, ...threadingFor(lead) });
        await incrementLeadSends(req.user.id, req.dbUser, req._db);
      }
    }

    const fuEntry = {
      id:       `fu_${lead.id}_manual_${Date.now()}`,
      template,
      subject,
      body,
      channel:  'email',
      to:       lead.fromEmail,
      sentAt:   req.body.draftOnly ? null : new Date().toISOString(),
      isDraft:  req.body.draftOnly || false,
    };

    await updateLead(req.user.id, lead.id, {
      followUps: [...(lead.followUps || []), fuEntry],
    }, req._db);

    res.json({ success: true, followUp: fuEntry });
  } catch (err) {
    if (err.whatsappBlocked) return res.status(409).json({ success: false, blockedBy: err.blockedBy, message: err.message });
    console.error('[Leads] Follow-up error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/leads/:id/status ───────────────────────────────
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['new','processing','replied','pending_followup','closed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ success: false, message: `Status must be one of: ${valid.join(', ')}` });
  }

  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  // If closing, cancel follow-ups and stamp won_at (if not already set)
  if (status === 'closed') {
    cancelFollowUps(req.params.id);
    if (!lead.wonAt) {
      await updateLead(req.user.id, req.params.id, { wonAt: new Date() }, req._db);
    }
  }

  const updated = await updateLead(req.user.id, req.params.id, { status }, req._db);

  if (req._db && status !== lead.status) {
    const businessContext = await getSettings(req.user.id, req._db);
    require('../services/workflows/engine').onStatusChanged({
      db: req._db, user: req.dbUser, businessContext, lead: updated || { ...lead, status }, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onStatusChanged error:', e.message));
  }

  // Instead of auto-creating, tell the frontend a calendar event can be created
  let calendarPermissionNeeded = false;
  if (status === 'closed') {
    const user = req.dbUser;
    const intg = getUserIntegrations(user);
    const calStatus = getCalendarStatus(intg);
    if (calStatus.connected && !(updated || lead).calendarEventId) {
      calendarPermissionNeeded = true;
    }
  }

  res.json({ success: true, lead: updated, calendarPermissionNeeded });
});



// ── POST /api/leads/consent-queue/:id/approve and /:id/reject are below ──

// ── Channel-aware send used by consent-approve and human-review send ──
// A WhatsApp lead has a phone number and usually no email address, so the email-only
// checks these routes used to make rejected every WhatsApp lead with "no email".
function leadChannel(lead) {
  const isWA = String(lead.source || '').toLowerCase() === 'whatsapp' || !!lead.whatsappThreadPhone;
  // A WhatsApp-origin lead is answered on WhatsApp even if an email was captured later.
  return isWA && (lead.whatsappThreadPhone || lead.fromPhone) ? 'whatsapp' : 'email';
}

// Returns { ok:true, channel, waMessageId?, to } or { ok:false, status, body } for the route to send back.
async function sendApprovedReply({ req, user, lead, subject, body }) {
  const channel = leadChannel(lead);
  if (channel === 'whatsapp') {
    const to = lead.whatsappThreadPhone || lead.fromPhone;
    if (!getPlan(user.plan || 'free').whatsapp) {
      return { ok: false, status: 403, body: { success: false, needsUpgrade: true, message: 'WhatsApp is available on the Starter plan and above.' } };
    }
    if (!userHasWACreds(user)) {
      return { ok: false, status: 503, body: { success: false, message: 'WhatsApp is not connected. Go to the WhatsApp settings to connect your phone number.' } };
    }
    const waQuota = await checkWhatsAppQuota(req.user.id, user, req._db);
    if (!waQuota.allowed) {
      return { ok: false, status: 403, body: { success: false, quotaExceeded: true, message: whatsappQuotaExceededMessage(waQuota), used: waQuota.used, limit: waQuota.limit } };
    }
    const creds = getWACreds(user);
    let sentWA;
    try { sentWA = await sendWAAuto({ to, body, creds, db: req._db, userId: req.user.id }); }
    catch (e) {
      if (e.whatsappBlocked) return { ok: false, status: 409, body: { success: false, blockedBy: e.blockedBy, message: e.message } };
      throw e;
    }
    const waMessageId = sentWA.id;
    try { await require('../services/media-library').sendReplyPhotosWhatsApp(req._db, req.user.id, lead.aiReply, to, creds); }
    catch (e) { console.warn('[Leads] reply photos failed after WhatsApp send:', e.message); }
    await incrementWhatsAppSends(req.user.id, req._db);
    return { ok: true, channel, to, waMessageId };
  }

  if (!lead.fromEmail) {
    return { ok: false, status: 400, body: { success: false, message: 'Lead has no email address and no WhatsApp number to reply to.' } };
  }
  const quota = await checkSendQuota(req.user.id, user, req._db);
  if (!quota.allowed) {
    return { ok: false, status: 402, body: { success: false, quotaExceeded: true, message: quotaExceededMessage(quota), used: quota.used, limit: quota.limit } };
  }
  await sendLeadReply({
    user, to: lead.fromEmail, subject, body,
    attachments: lead.aiReply && typeof lead.aiReply === 'object'
      ? await require('../services/media-library').loadReplyPhotos(req._db, req.user.id, lead.aiReply) : [],
    ...threadingFor(lead),
  });
  await incrementLeadSends(req.user.id, req.dbUser, req._db);
  return { ok: true, channel, to: lead.fromEmail };
}

// Follow-ups go out on the lead's own channel.
function followUpSender(req, user) {
  return async ({ lead: l, subject, body }) => {
    await sendWithQuota(l.userId || req.user.id, user, { user, to: l.fromEmail, subject, body }, req._db, l)
      .catch(err => console.warn(`[Leads] Follow-up quota exceeded for lead`, l.id, err.message));
  };
}

// ── POST /api/leads/consent-queue/:id/approve — approve & send ─
router.post('/consent-queue/:id/approve', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (!lead.pendingApproval) return res.status(400).json({ success: false, message: 'Lead is not awaiting approval.' });
  if (!lead.aiReply) return res.status(400).json({ success: false, message: 'Lead has no AI reply to send.' });

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  try {
    const body    = typeof lead.aiReply === 'string' ? lead.aiReply : (lead.aiReply.body || '');
    const subject = typeof lead.aiReply === 'object' ? lead.aiReply.subject : undefined;
    if (!body) return res.status(400).json({ success: false, message: 'AI reply body is empty.' });

    const sent = await sendApprovedReply({ req, user, lead, subject, body });
    if (!sent.ok) return res.status(sent.status).json(sent.body);

    const sentAt = new Date().toISOString();
    const businessContext = await getSettings(req.user.id, req._db);
    // WhatsApp conversations are not followed up; only email leads get a schedule.
    const followUpSchedule = sent.channel === 'whatsapp' ? [] : buildFollowUpSchedule(lead.id, sentAt);

    const updatedLead = await updateLead(req.user.id, lead.id, {
      status:           'pending_followup',
      pendingApproval:  false,
      approvedAt:       sentAt,
      sentAt,
      followUpSchedule,
      ...(sent.channel === 'whatsapp' ? { whatsappMessageId: sent.waMessageId, whatsappThreadPhone: sent.to } : {}),
    }, req._db);

    scheduleFollowUps(
      sent.channel === 'whatsapp'
        ? { id: lead.id, sentAt, source: 'whatsapp', whatsappThreadPhone: sent.to, fromPhone: sent.to, fromEmail: lead.fromEmail }
        : (updatedLead || lead),
      businessContext, user,
      sent.channel === 'whatsapp' ? null : followUpSender(req, user)
    ).catch(e => console.error('[Consent] scheduleFollowUps error:', e.message));

    require('../services/workflows/engine').onStatusChanged({
      db: req._db, user: req.dbUser, businessContext, lead: updatedLead || lead, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onStatusChanged (consent-approve) error:', e.message));

    res.json({ success: true, lead: updatedLead, channel: sent.channel });
  } catch(err) {
    console.error('[Consent] Approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/consent-queue/:id/reject — dismiss without sending
router.post('/consent-queue/:id/reject', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  // keepOpen: drop the draft without sending, but leave the lead open (Agent "Don't send").
  const keepOpen = !!(req.body && req.body.keepOpen);
  const updatedLead = await updateLead(req.user.id, lead.id, keepOpen
    ? { pendingApproval: false }
    : { pendingApproval: false, status: 'closed' }, req._db);
  if (req._db && !keepOpen) {
    const businessContext = await getSettings(req.user.id, req._db);
    require('../services/workflows/engine').onStatusChanged({
      db: req._db, user: req.dbUser, businessContext, lead: updatedLead || lead, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onStatusChanged (consent-reject) error:', e.message));
  }
  res.json({ success: true, lead: updatedLead });
});

// ── POST /api/leads/human-review/:id/send is below ──

// ── POST /api/leads/human-review/:id/send — send human reply ──
router.post('/human-review/:id/send', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (!lead.needsHumanReview) return res.status(400).json({ success: false, message: 'Lead is not flagged for human review.' });

  const channel = leadChannel(lead);
  const { subject, body } = req.body || {};
  // WhatsApp has no subject line; only the message text is required there.
  if (!body || (channel === 'email' && !subject)) {
    return res.status(400).json({ success: false, message: channel === 'email' ? 'subject and body are required.' : 'body is required.' });
  }

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  try {
    const sent = await sendApprovedReply({ req, user, lead, subject, body });
    if (!sent.ok) return res.status(sent.status).json(sent.body);

    const sentAt = new Date().toISOString();
    const humanReply = { subject: subject || null, body, sentAt, channel: sent.channel };
    const businessContext = await getSettings(req.user.id, req._db);
    const followUpSchedule = sent.channel === 'whatsapp' ? [] : buildFollowUpSchedule(lead.id, sentAt);

    // Same as the autonomous/consent send paths: move to pending_followup
    // and schedule the Day 1/3/7 follow-ups — a human-sent reply should
    // re-enter the same lifecycle as an AI-sent one, not dead-end at
    // 'replied' with no way to ever reach Follow-Ups or Closed.
    const updatedLead = await updateLead(req.user.id, lead.id, {
      status:           'pending_followup',
      needsHumanReview: false,
      humanReply,
      sentAt,
      followUpSchedule,
      ...(sent.channel === 'whatsapp' ? { whatsappMessageId: sent.waMessageId, whatsappThreadPhone: sent.to } : {}),
    }, req._db);

    scheduleFollowUps(
      sent.channel === 'whatsapp'
        ? { id: lead.id, sentAt, source: 'whatsapp', whatsappThreadPhone: sent.to, fromPhone: sent.to, fromEmail: lead.fromEmail }
        : (updatedLead || lead),
      businessContext, user,
      sent.channel === 'whatsapp' ? null : followUpSender(req, user)
    ).catch(e => console.error('[HumanReview] scheduleFollowUps error:', e.message));

    require('../services/workflows/engine').onStatusChanged({
      db: req._db, user: req.dbUser, businessContext, lead: updatedLead || lead, claude: getClaude(), model: MODEL,
    }).catch(e => console.error('[Workflow] onStatusChanged (human-review-send) error:', e.message));

    res.json({ success: true, lead: updatedLead, channel: sent.channel });
  } catch(err) {
    console.error('[HumanReview] Send error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── DELETE /api/leads/calendar — disconnect calendar ──────────
router.delete('/calendar', async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg = getUserIntegrations(user);
  delete intg.google_calendar;
  if (req._db && req._db.Users) {
    await req._db.Users.update(user.id, { integrations: JSON.stringify(intg) });
  }
  res.json({ success: true, message: 'Google Calendar disconnected.' });
});

// ── POST /api/leads/calendar/event/:id — manually create event ─
// Lets the user trigger a calendar event creation from the UI
router.post('/calendar/event/:id', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  const calStatus = getCalendarStatus(intg);
  if (!calStatus.connected) {
    return res.status(400).json({ success: false, message: 'Google Calendar is not connected. Connect it in Settings.' });
  }

  const claude = getClaude();
  if (!claude) return res.status(503).json({ success: false, message: 'AI service not configured.' });

  const businessContext = await getSettings(req.user.id, req._db);

  const result = await createCalendarEventForLead({
    lead,
    businessContext,
    userIntg: intg,
    claude,
    model: MODEL,
    onTokenRefresh: makeCalendarTokenRefreshFn(req._db, user.id),
  });

  if (!result.success) {
    return res.status(500).json({ success: false, message: result.error || 'Failed to create calendar event.' });
  }

  // Persist event ID + link on the lead
  if (req._db && result.eventId) {
    await req._db.query(
      `UPDATE leads SET calendar_event_id=$1, calendar_event_link=$2 WHERE id=$3`,
      [result.eventId, result.eventLink || null, lead.id]
    );
  }

  res.json({
    success:   true,
    eventId:   result.eventId,
    eventLink: result.eventLink,
    summary:   result.summary,
    details:   result.details,
  });
});

// ── GET /api/leads/:id/appointment — when is this booking? ────
router.get('/:id/appointment', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  if (!lead.calendarEventId) return res.status(404).json({ success: false, message: 'This lead has no calendar booking.' });
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const intg = getUserIntegrations(user);
  if (!getCalendarStatus(intg).connected) return res.status(400).json({ success: false, message: 'Google Calendar is not connected.' });
  const r = await require('../services/google-calendar').getCalendarEventTimes({
    eventId: lead.calendarEventId, userIntg: intg, onTokenRefresh: makeCalendarTokenRefreshFn(req._db, user.id),
  });
  if (!r.success) return res.status(502).json({ success: false, message: r.error });
  const { formatWhen } = require('../services/reschedule');
  res.json({ success: true, appointment: { date: r.date, time: r.time, allDay: r.allDay, timeZone: r.timeZone, durationMinutes: r.durationMinutes,
    when: formatWhen(r.date, r.time), hasAttendees: r.hasAttendees, link: r.link } });
});

// ── POST /api/leads/:id/reschedule — move a booked job ────────
// Body: { date: 'YYYY-MM-DD', time?: 'HH:MM', durationMinutes?: number, notifyCustomer?: boolean }
router.post('/:id/reschedule', leadsLimiter, async (req, res) => {
  const lead = await getLeadById(req.user.id, req.params.id, req._db);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const b = req.body || {};
  const date = typeof b.date === 'string' ? b.date.trim() : '';
  const time = typeof b.time === 'string' ? b.time.trim() : '';
  if (!date) return res.status(400).json({ success: false, message: 'Choose a new date.' });
  const businessContext = await getSettings(req.user.id, req._db);
  const intg = getUserIntegrations(user);
  const out = await require('../services/reschedule').rescheduleLead({
    lead, when: { date, time, durationMinutes: b.durationMinutes }, notifyCustomer: b.notifyCustomer !== false,
    businessContext, userIntg: intg, onTokenRefresh: makeCalendarTokenRefreshFn(req._db, user.id), db: req._db, userId: req.user.id,
  });
  if (!out.ok) return res.status(400).json({ success: false, message: out.error });
  res.json({ success: true, ...out, ok: undefined });
});

// ── POST /api/leads/calendar/test-event — verify connection ───
// Creates a small placeholder event 10 minutes from now on the user's
// primary calendar so they can confirm the integration actually works,
// without needing a real lead.
router.post('/calendar/test-event', leadsLimiter, async (req, res) => {
  const user = req.dbUser;
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  const calStatus = getCalendarStatus(intg);
  if (!calStatus.connected) {
    return res.status(400).json({ success: false, message: 'Google Calendar is not connected. Connect it first.' });
  }

  const result = await createTestCalendarEvent({ userIntg: intg, onTokenRefresh: makeCalendarTokenRefreshFn(req._db, user.id) });

  if (!result.success) {
    return res.status(500).json({ success: false, message: result.error || 'Failed to create test event.' });
  }

  res.json({
    success:   true,
    eventId:   result.eventId,
    eventLink: result.eventLink,
    summary:   result.summary,
  });
});

// ════════════════════════════════════════════════════════════════
// WHATSAPP CLOUD API INTEGRATION
// https://developers.facebook.com/docs/whatsapp/cloud-api
// ════════════════════════════════════════════════════════════════

const {
  sendWhatsAppMessage,
  markMessageRead,
  parseWebhookPayload,
  verifyWebhookChallenge,
  isConfigured: waIsConfigured,
  isEmbeddedSignupConfigured,
  completeEmbeddedSignup,
} = require('../services/whatsapp');

// ── Resolve per-user WhatsApp credentials ─────────────────────
// Per-user creds stored in integrations.whatsapp take priority.
// Falls back to server-level env vars so a self-hosted single-user
// deployment still works without going through the UI.
function getWACreds(user) {
  const intg = getUserIntegrations(user);
  const wa   = intg?.whatsapp || {};
  return {
    phoneNumberId: wa.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    accessToken:   wa.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN   || null,
    displayPhone:  wa.displayPhone  || null,
    verifiedName:  wa.verifiedName  || null,
  };
}

// Send one WhatsApp message from an owner-triggered path (manual send, approve, follow-up now). It is only ever a reply: plain text
// to someone who messaged this number in the last 24 hours. The consent gate (services/wa-consent.js) throws WhatsAppBlocked
// (err.whatsappBlocked, err.blockedBy) for anyone who has not messaged on WhatsApp, has opted out, or is outside the 24-hour window.
async function sendWAAuto({ to, body, creds, db, userId }) {
  const { sendGuarded } = require('../services/wa-consent');
  return sendGuarded({ db, userId, to, body, phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken });
}

function userHasWACreds(user) {
  const c = getWACreds(user);
  return !!(c.phoneNumberId && c.accessToken);
}
