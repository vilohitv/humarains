/**
 * services/workflows/engine.js — Visual Workflow Automation Engine
 *
 * Lets each business define its own sales automation logic:
 *   TRIGGER  → an event that starts a run (new lead, reply, status change, stalled lead)
 *   STEPS    → an ordered chain of actions, waits, conditions, and AI decisions
 *
 * A workflow definition is stored as a small JSON tree:
 *   { trigger: { type, config }, steps: [ Step, ... ] }
 *
 * Step:
 *   { id, type, config, branches? }
 *   - branches (only for 'condition' | 'ai_decision' | 'wait_for_reply') is an
 *     array of { id, label, steps: [Step, ...] } — execution forks into exactly
 *     one branch and continues inside it. Branches are terminal: nothing after
 *     a fork in the parent chain runs once a branch is taken.
 *
 * A run is one lead's journey through one workflow. Its position is stored as
 * a "cursor path" — a flat array that alternates [stepIndex, branchIndex, stepIndex, ...].
 * This lets a run pause (e.g. on a wait) and resume exactly where it left off,
 * across server restarts, via the DB-backed workflow_runs table.
 *
 * Integration points (see hooks called from routes/leads.js / server.js):
 *   onNewLead(), onLeadReplied(), onStatusChanged()        — event-driven triggers
 *   processDueWaits(), processStalledTriggers()            — poller-driven (services/leads/poller.js)
 */
'use strict';

const crypto = require('crypto');
const { cleanCustomerText } = require('../../lib/ai-style');
const { cleanBody, formatHistory, knowledgeBlock } = require('../leads/engine');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_STEPS_PER_TICK = 25;

const VALID_TRIGGER_TYPES = ['new_lead', 'lead_replied', 'status_changed', 'stalled', 'manual'];
const VALID_STEP_TYPES = [
  'send_message', 'wait', 'wait_for_reply', 'ai_extract',
  'condition', 'ai_decision', 'update_status', 'notify_owner',
  'book_appointment', 'add_tag', 'remove_tag', 'webhook',
  'schedule_reminder',
];
const VALID_LEAD_STATUSES = ['new', 'processing', 'replied', 'pending_followup', 'closed'];

// ── ID generators ──────────────────────────────────────────────
function genId(prefix) { return `${prefix}_${crypto.randomBytes(10).toString('hex')}`; }
const genWorkflowId = () => genId('wf');
const genRunId      = () => genId('run');
const genEventId     = () => genId('wfev');
const genStepId      = () => genId('step');
const genBranchId    = () => genId('br');

// ── Misc helpers ───────────────────────────────────────────────
function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return null; }
}

function parseJ(v) {
  if (v == null) return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseAiJson(raw) {
  const cleaned = String(raw || '')
    .replace(/^```json[\r\n]*/i, '')
    .replace(/[\r\n]*```$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in AI response');
  return JSON.parse(match[0]);
}

async function updateLeadRow(db, leadId, fields) {
  if (!db || !Object.keys(fields).length) return;
  const sets = []; const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=$${i++}`); vals.push(v); }
  vals.push(leadId);
  await db.query(`UPDATE leads SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${i}`, vals);
}

// ── Merge-field interpolation for custom message templates ─────
// "12 November", in the business's own time zone.
function offerDate(iso, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: tz || 'UTC' }).format(new Date(iso)); }
  catch (_) { return new Date(iso).toISOString().slice(0, 10); }
}

function interpolate(tpl, lead, businessContext, context) {
  if (!tpl) return '';
  const scope = {
    customerName: lead.customerName || lead.fromName || 'there',
    businessName: businessContext.businessName || 'us',
    ownerName:    businessContext.ownerName || 'The Team',
    serviceType:  lead.serviceType || '',
    urgency:      lead.urgency || '',
    summary:      lead.summary || '',
    phone:        businessContext.phone || '',
    bookingUrl:   businessContext.bookingUrl || '',
    quoteTotal:   (lead.quote && lead.quote.total != null) ? `${lead.quote.currency || ''} ${Number(lead.quote.total).toFixed(2)}`.trim() : '',
    // The discount the Agent offered this customer (leads.offer). Empty when there is none, so a template never prints a made-up number.
    discountPercent: lead.offer && lead.offer.percent ? String(lead.offer.percent) : '',
    discountedTotal: lead.offer && lead.offer.discountedTotal != null ? `${lead.offer.currency || ''} ${Number(lead.offer.discountedTotal).toFixed(2)}`.trim() : '',
    discountExpiry:  lead.offer && lead.offer.expiresAt ? offerDate(lead.offer.expiresAt, businessContext.timezone) : '',
  };
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    if (key in scope) return scope[key] != null ? String(scope[key]) : '';
    if (key.startsWith('context.')) { const v = getPath(context, key.slice(8)); return v != null ? String(v) : ''; }
    if (key.startsWith('lead.'))    { const v = getPath(lead, key.slice(5));    return v != null ? String(v) : ''; }
    return '';
  });
}

// ════════════════════════════════════════════════════════════════
// TREE NAVIGATION — cursor path = [stepIdx, branchIdx, stepIdx, ...]
// ════════════════════════════════════════════════════════════════
function locatePath(steps, path) {
  let arr = steps || [];
  for (let i = 0; i < path.length - 1; i += 2) {
    const node = arr[path[i]];
    if (!node) return null;
    const branch = (node.branches || [])[path[i + 1]];
    if (!branch) return null;
    arr = branch.steps || [];
  }
  const idx = path[path.length - 1];
  return { steps: arr, index: idx, node: arr ? arr[idx] : undefined };
}

function nextPath(path) {
  const copy = path.slice();
  copy[copy.length - 1] += 1;
  return copy;
}

// ════════════════════════════════════════════════════════════════
// FIELD RESOLUTION + CONDITION EVALUATION
// ════════════════════════════════════════════════════════════════
function resolveField(fieldPath, lead, context) {
  if (!fieldPath) return undefined;
  if (fieldPath.startsWith('context.')) return getPath(context, fieldPath.slice(8));
  if (fieldPath === 'quote.total') return lead.quote && lead.quote.total;
  if (fieldPath.startsWith('lead.')) return getPath(lead, fieldPath.slice(5));
  return getPath(lead, fieldPath);
}

function evalCondition(operator, actual, expected) {
  if (operator === 'is_set')     return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'is_not_set') return !(actual !== undefined && actual !== null && actual !== '');
  if (actual === undefined || actual === null) return false;
  const aNum = Number(actual), eNum = Number(expected);
  const bothNumeric = expected !== '' && !isNaN(aNum) && !isNaN(eNum);
  switch (operator) {
    case 'equals':       return bothNumeric ? aNum === eNum : String(actual).toLowerCase() === String(expected).toLowerCase();
    case 'not_equals':   return bothNumeric ? aNum !== eNum : String(actual).toLowerCase() !== String(expected).toLowerCase();
    case 'contains':      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'greater_than':  return bothNumeric ? aNum > eNum : String(actual) > String(expected);
    case 'less_than':     return bothNumeric ? aNum < eNum : String(actual) < String(expected);
    default: return false;
  }
}

function computeWaitUntil(durationCfg) {
  const value = Number(durationCfg && durationCfg.value) || 1;
  const unit  = (durationCfg && durationCfg.unit) || 'hours';
  const ms = unit === 'minutes' ? value * 60_000 : unit === 'days' ? value * 86_400_000 : value * 3_600_000;
  return new Date(Date.now() + ms);
}

// ════════════════════════════════════════════════════════════════
// AI HELPERS
// ════════════════════════════════════════════════════════════════
async function generateWorkflowMessage(claude, model, { instructions, lead, businessContext, conversationHistory }) {
  const businessName = businessContext.businessName || 'our team';
  const ownerName    = businessContext.ownerName    || 'The Team';
  const customerName = lead.customerName || lead.fromName || null;
  const history = conversationHistory && conversationHistory.length
    ? `\nCONVERSATION SO FAR:\n${formatHistory(conversationHistory.slice(-10), businessName)}\n`
    : '';
  const contactCta = businessContext.phone && businessContext.bookingUrl
    ? `call us on ${businessContext.phone} or book at ${businessContext.bookingUrl}`
    : businessContext.phone ? `call or text ${businessContext.phone}`
    : businessContext.bookingUrl ? `book at ${businessContext.bookingUrl}`
    : 'reply to this message';

  if (!claude) return instructions || 'Following up on your enquiry.';

  const prompt = `You are ${ownerName}, owner of ${businessName}, writing a message to a customer as one step of an automated sales workflow.
${history}
CUSTOMER: ${customerName || 'unknown — open with "Hi" and no name'}
WHAT THIS MESSAGE SHOULD ACCOMPLISH: ${instructions || 'Send a relevant, friendly message that moves the conversation forward.'}
${knowledgeBlock(businessContext)}
RULES:
- Plain text only — no markdown, never bold or any emphasis (no asterisks or underscores around words), no subject line, no preamble.
- Max 120 words.
- If relevant, end with one clear next step: "${contactCta}"
- Sign off with first name only: ${ownerName.split(' ')[0]}
- FORBIDDEN PHRASES: "I hope this email finds you well", "Please don't hesitate", "Feel free to reach out", "Just following up", "Best regards"`;

  const res = await claude.messages.create({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  return cleanCustomerText(res.content.map(b => b.text || '').join(''));
}

function buildAiDecisionPrompt(instructions, labels, lead, businessContext) {
  return `You are making a branching decision inside a sales automation workflow for ${businessContext.businessName || 'a business'}.

LEAD CONTEXT:
- Intent: ${lead.intent || 'unknown'}
- Service: ${lead.serviceType || 'unknown'}
- Urgency: ${lead.urgency || 'unknown'}
- Summary: ${lead.summary || 'unknown'}
- Latest message: ${cleanBody(lead.rawBody || lead.lastCustomerMessage || '').slice(0, 800)}

DECISION TO MAKE: ${instructions || 'Choose the branch that best fits this lead.'}

Choose EXACTLY ONE of these labels: ${labels.map(l => `"${l}"`).join(', ')}

Respond ONLY with valid JSON: {"label": "<one of the labels above, exactly>", "reason": "one short phrase"}`;
}

// ════════════════════════════════════════════════════════════════
// STEP EXECUTORS
// Each returns: { action: 'continue'|'fork'|'wait'|'complete',
//                  branchIndex?, waitUntil?, waitReason?,
//                  summary, detail?, contextPatch?, eventStatus? }
// ════════════════════════════════════════════════════════════════
async function execSendMessage(node, ctx) {
  const { lead, user, businessContext, claude, model, dryRun, db, run } = ctx;
  const cfg = node.config || {};
  // Automations send EMAIL only. WhatsApp conversations are answered automatically by the AI (replies inside WhatsApp's
  // 24-hour window, see services/whatsapp-inbound.js); no workflow, campaign or follow-up ever starts a WhatsApp message.
  const channel = 'email';
  if (!lead.fromEmail) {
    const isWa = !!(lead.whatsappThreadPhone || String(lead.source || '').toLowerCase() === 'whatsapp');
    return { action: 'continue', eventStatus: 'skipped', summary: isWa
      ? 'Not sent: automations send email only, and this WhatsApp contact has no email address. The AI already replies to their WhatsApp messages by itself.'
      : 'No email address on this lead — message skipped.' };
  }

  // Owner (or the lead) opted out: never message someone tagged do-not-contact.
  if (!dryRun) {
    let tg = lead.tags;
    if (typeof tg === 'string') { try { tg = JSON.parse(tg || '[]'); } catch (_) { tg = []; } }
    if (Array.isArray(tg) && tg.includes('do-not-contact')) {
      return { action: 'continue', eventStatus: 'skipped', summary: 'Lead is marked do-not-contact — message skipped.' };
    }
  }

  let subject = null, body;
  if (cfg.mode === 'custom') {
    body = interpolate(cfg.template || '', lead, businessContext, ctx.run.context);
    subject = cfg.subject
      ? interpolate(cfg.subject, lead, businessContext, ctx.run.context)
      : (lead.subject ? `Re: ${String(lead.subject).replace(/^Re:\s*/i, '')}` : 'Following up');
  } else {
    body = await generateWorkflowMessage(claude, model, {
      instructions: cfg.aiInstructions || 'Write a brief, friendly message that continues this conversation naturally.',
      lead, businessContext, conversationHistory: lead.conversationHistory || [],
    });
    subject = cfg.subject
      ? interpolate(cfg.subject, lead, businessContext, ctx.run.context)
      : (lead.subject ? (String(lead.subject).toLowerCase().startsWith('re:') ? lead.subject : `Re: ${lead.subject}`) : 'Following up');
  }

  if (!body || !body.trim()) return { action: 'continue', eventStatus: 'skipped', summary: 'Generated message was empty — skipped.' };

  if (dryRun) {
    return {
      action: 'continue',
      summary: `[Test run] Would send via ${channel}: "${body.slice(0, 90)}${body.length > 90 ? '…' : ''}"`,
      detail: { channel, subject, body },
    };
  }


  // ── Same gate every direct send path in routes/leads.js goes through:
  // the per-channel quota. A workflow is not a side door around any of these. ──
  const { gateOutboundReply } = require('../../routes/leads');
  let gate;
  try {
    gate = await gateOutboundReply({
      userId: user.id, user, lead, db, channel, businessContext,
      runId: run.id, note: `Workflow step: ${node.id}`,
    });
  } catch (e) {
    return { action: 'continue', eventStatus: 'error', summary: 'Could not check send permissions: ' + e.message };
  }

  if (gate.verdict === 'blocked_review') {
    return { action: 'continue', eventStatus: 'skipped',
      summary: 'Held back: this lead is waiting for your review, so nothing was sent automatically.' };
  }

  if (gate.verdict === 'blocked_quota') {
    return { action: 'continue', eventStatus: 'skipped',
      summary: 'Email send quota exceeded — message skipped.' };
  }

  return finishSend(channel, subject, body, node, ctx, gate, cfg.mediaIds);
}

// Actually sends the email, increments the quota counter, and records the turn in conversation history.
// Split out from execSendMessage.
async function finishSend(channel, subject, body, node, ctx, gate, mediaIds) {
  const { lead, user, db } = ctx;
  // Photos picked for this step (owner-uploaded library). Loaded only now, at
  // send time, and only ones this user owns.
  let photos = [];
  if (Array.isArray(mediaIds) && mediaIds.length) {
    try { photos = await require('../media-library').loadForSend(db, user.id, mediaIds); }
    catch (e) { console.error('[Workflow] could not load photos:', e.message); }
  }

  const { incrementLeadSends } = require('../../routes/leads');
  const { sendLeadReply } = require('../leads/ingestion');
  await sendLeadReply({ user, to: lead.fromEmail, subject, body, attachments: photos });
  await incrementLeadSends(user.id, user, db);

  const newTurn = { role: 'agent', body, subject, sentAt: new Date().toISOString(), source: 'workflow', workflowStepId: node.id, ...(photos.length ? { photos: photos.length } : {}) };
  const updatedHistory = [...(lead.conversationHistory || []), newTurn];
  lead.conversationHistory = updatedHistory;
  await updateLeadRow(db, lead.id, { conversation_history: JSON.stringify(updatedHistory) });

  return {
    action: 'continue',
    summary: `Sent via ${channel}${photos.length ? ` with ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}: "${body.slice(0, 100)}${body.length > 100 ? '…' : ''}"`,
    // Clear pendingSend now that it's been sent, so a stale draft can't
    // linger in run.context if this same run somehow ticks again.
    contextPatch: { pendingSend: null },
  };
}

async function execWait(node, ctx) {
  if (ctx.resumeReason) return { action: 'continue', summary: 'Wait elapsed — continuing.' };
  const waitUntil = computeWaitUntil(node.config && node.config.duration);
  return { action: 'wait', waitUntil, waitReason: 'timer', summary: `Waiting until ${waitUntil.toLocaleString()}` };
}

async function execWaitForReply(node, ctx) {
  const branches = node.branches || [];
  if (ctx.resumeReason === 'reply') {
    return { action: 'fork', branchIndex: 0, summary: 'Customer replied — continuing on the Replied path.' };
  }
  if (ctx.resumeReason === 'timeout') {
    return { action: 'fork', branchIndex: branches.length > 1 ? 1 : 0, summary: 'No reply within the timeout — continuing on the No Reply path.' };
  }
  const waitUntil = computeWaitUntil((node.config && node.config.timeout) || { value: 3, unit: 'days' });
  return { action: 'wait', waitUntil, waitReason: 'reply_or_timeout', summary: `Waiting for a reply (times out ${waitUntil.toLocaleString()})` };
}

async function execAiExtract(node, ctx) {
  const cfg = node.config || {};
  const fieldName = cfg.fieldName || 'extracted_value';
  if (!ctx.claude) return { action: 'continue', eventStatus: 'skipped', summary: 'AI not available — extraction skipped.' };

  const history = formatHistory((ctx.lead.conversationHistory || []).slice(-8), ctx.businessContext.businessName);
  const prompt = `You are extracting structured information from a sales conversation.
${history ? 'Conversation so far:\n' + history + '\n\n' : ''}Latest message from customer:
---
${cleanBody(ctx.lead.rawBody || ctx.lead.lastCustomerMessage || '').slice(0, 1200)}
---

TASK: ${cfg.instructions || 'Extract the relevant value.'}

Respond ONLY with valid JSON: {"value": <string, number, or null if not mentioned>}`;

  try {
    const res = await ctx.claude.messages.create({ model: ctx.model, max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    const text = res.content.map(b => b.text || '').join('');
    const parsed = parseAiJson(text);
    return { action: 'continue', summary: `Extracted "${fieldName}" = ${JSON.stringify(parsed.value)}`, contextPatch: { [fieldName]: parsed.value } };
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'AI extraction failed: ' + err.message };
  }
}

async function execCondition(node, ctx) {
  const { field, operator, value } = node.config || {};
  const actual = resolveField(field, ctx.lead, ctx.run.context);
  const result = evalCondition(operator, actual, value);
  return {
    action: 'fork',
    branchIndex: result ? 0 : 1,
    summary: `Condition "${field} ${operator} ${value !== undefined ? value : ''}" → ${result ? 'Yes' : 'No'} (actual: ${JSON.stringify(actual)})`,
  };
}

async function execAiDecision(node, ctx) {
  const branches = node.branches || [];
  const labels = branches.map(b => b.label);
  if (!labels.length) return { action: 'complete', eventStatus: 'error', summary: 'AI decision step has no branches configured.' };
  if (!ctx.claude) return { action: 'fork', branchIndex: labels.length - 1, summary: 'AI unavailable — defaulted to last branch.' };

  try {
    const prompt = buildAiDecisionPrompt(node.config && node.config.instructions, labels, ctx.lead, ctx.businessContext);
    const res = await ctx.claude.messages.create({ model: ctx.model, max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    const text = res.content.map(b => b.text || '').join('');
    const parsed = parseAiJson(text);
    let idx = labels.findIndex(l => l.toLowerCase() === String(parsed.label || '').toLowerCase());
    if (idx === -1) idx = labels.length - 1;
    return {
      action: 'fork', branchIndex: idx,
      summary: `AI decided: "${labels[idx]}"${parsed.reason ? ' — ' + parsed.reason : ''}`,
      contextPatch: { [`decision_${node.id}`]: labels[idx] },
    };
  } catch (err) {
    return { action: 'fork', branchIndex: labels.length - 1, summary: 'AI decision failed, defaulted to last branch: ' + err.message };
  }
}

async function execUpdateStatus(node, ctx) {
  const cfg = node.config || {};
  const fields = {};
  const summaryParts = [];
  if (cfg.status && VALID_LEAD_STATUSES.includes(cfg.status)) { fields.status = cfg.status; summaryParts.push(`status → ${cfg.status}`); }
  if (cfg.stage !== undefined) { fields.workflow_stage = cfg.stage || null; summaryParts.push(`stage → ${cfg.stage || '(cleared)'}`); }
  if (!Object.keys(fields).length) return { action: 'continue', eventStatus: 'skipped', summary: 'No status/stage configured — skipped.' };

  if (!ctx.dryRun) {
    await updateLeadRow(ctx.db, ctx.lead.id, fields);
    if (fields.status) ctx.lead.status = fields.status;
    if ('workflow_stage' in fields) ctx.lead.workflowStage = fields.workflow_stage;
  }
  return { action: 'continue', summary: `Updated lead: ${summaryParts.join(', ')}${ctx.dryRun ? ' [test run]' : ''}` };
}

async function execNotifyOwner(node, ctx) {
  const cfg = node.config || {};
  const { user, lead, dryRun } = ctx;
  const subject = cfg.subject || `Workflow alert: ${lead.customerName || lead.fromName || lead.fromEmail || 'a lead'} needs attention`;
  const note = cfg.message || 'A lead in your automation workflow reached this step and needs your attention.';
  if (dryRun) return { action: 'continue', summary: `[Test run] Would notify owner: "${subject}"` };

  try {
    const { sendMail } = require('../mailer');
    const { leadAlert } = require('../../lib/email-templates');
    const { dashboardUrl } = require('../../lib/deeplink');
    const appUrl = process.env.APP_URL || 'https://humarains.com';
    // The button opens this lead's conversation, not the Agent's home screen.
    const mail = leadAlert({
      subject, note, appUrl,
      lead: { name: lead.customerName || lead.fromName, contact: lead.fromEmail || lead.fromPhone, service: lead.serviceType, summary: lead.summary },
      link: { href: dashboardUrl(appUrl, { view: lead.needsHumanReview ? 'humanreview' : 'leads', lead: lead.id }), label: 'Open this lead' },
    });
    await sendMail({ to: user.email, subject: mail.subject, html: mail.html });
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'Failed to notify owner: ' + err.message };
  }
  return { action: 'continue', summary: `Notified owner by email: "${subject}"` };
}

// ── NEW STEP: book_appointment ─────────────────────────────────
// Auto-creates a Google Calendar event for the lead using the
// existing createCalendarEventForLead helper. Requires Google
// Calendar to be connected. Idempotent: skips if lead already
// has a calendar_event_id.
async function execBookAppointment(node, ctx) {
  const { lead, user, claude, model, db, dryRun, businessContext } = ctx;

  if (dryRun) {
    return {
      action: 'continue',
      summary: `[Test run] Would book a Google Calendar appointment for ${lead.customerName || lead.fromName || lead.fromEmail || 'this lead'}.`,
    };
  }

  if (!db) return { action: 'continue', eventStatus: 'skipped', summary: 'No database connection — appointment booking skipped.' };

  // Idempotency: if a calendar event was already created (by the AI agent
  // or a prior run of this step), don't create a duplicate.
  if (lead.calendar_event_id) {
    return {
      action: 'continue',
      summary: `Appointment already booked (event ${lead.calendar_event_id}) — skipped.`,
    };
  }

  let userIntg;
  try {
    userIntg = typeof user.integrations === 'object' ? (user.integrations || {}) : JSON.parse(user.integrations || '{}');
  } catch (_) { userIntg = {}; }
  if (typeof userIntg === 'string') { try { userIntg = JSON.parse(userIntg); } catch (_) { userIntg = {}; } }

  if (!userIntg.google_calendar || !userIntg.google_calendar.tokens) {
    return { action: 'continue', eventStatus: 'skipped', summary: 'Google Calendar is not connected — appointment booking skipped.' };
  }

  try {
    const { createCalendarEventForLead } = require('../google-calendar');
    const result = await createCalendarEventForLead({
      lead, businessContext: businessContext || {}, userIntg,
      claude: claude || null, model: model || null,
      onTokenRefresh: async (newTokens) => {
        try {
          userIntg.google_calendar = { ...userIntg.google_calendar, tokens: newTokens };
          await db.query('UPDATE users SET integrations=$1 WHERE id=$2', [JSON.stringify(userIntg), user.id]);
        } catch (_) {}
      },
    });

    if (result && result.eventId) {
      await updateLeadRow(db, lead.id, {
        calendar_event_id:   result.eventId,
        calendar_event_link: result.eventLink || null,
      });
      lead.calendar_event_id   = result.eventId;
      lead.calendar_event_link = result.eventLink || null;

      return {
        action: 'continue',
        summary: `Appointment booked${result.summary ? ': ' + result.summary : ''}.`,
        detail: { eventId: result.eventId, eventLink: result.eventLink },
      };
    }

    return { action: 'continue', eventStatus: 'skipped', summary: 'Calendar returned no event — skipped.' };
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'Appointment booking failed: ' + err.message };
  }
}

// ── NEW STEP: add_tag ──────────────────────────────────────────
// Adds one or more comma-separated tags to leads.tags (jsonb []).
async function execAddTag(node, ctx) {
  const { lead, db, dryRun } = ctx;
  const cfg = node.config || {};
  const rawTags = (cfg.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!rawTags.length) return { action: 'continue', eventStatus: 'skipped', summary: 'No tags configured — skipped.' };

  if (dryRun) {
    return { action: 'continue', summary: `[Test run] Would add tag(s): ${rawTags.join(', ')}` };
  }

  if (!db) return { action: 'continue', eventStatus: 'skipped', summary: 'No database connection — tag step skipped.' };

  try {
    for (const tag of rawTags) {
      await db.query(
        `UPDATE leads SET tags = COALESCE(
           (SELECT jsonb_agg(DISTINCT elem)
            FROM (SELECT elem FROM jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb)) elem
                  UNION ALL SELECT $1) sub),
           jsonb_build_array($1)
         ), updated_at = NOW()
         WHERE id = $2`,
        [tag, lead.id],
      );
    }
    const existing = Array.isArray(lead.tags) ? lead.tags
      : (typeof lead.tags === 'string' ? JSON.parse(lead.tags || '[]') : []);
    lead.tags = [...new Set([...existing, ...rawTags])];

    return { action: 'continue', summary: `Tag(s) added: ${rawTags.join(', ')}` };
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'Failed to add tag(s): ' + err.message };
  }
}

// ── NEW STEP: remove_tag ───────────────────────────────────────
async function execRemoveTag(node, ctx) {
  const { lead, db, dryRun } = ctx;
  const cfg = node.config || {};
  const rawTags = (cfg.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!rawTags.length) return { action: 'continue', eventStatus: 'skipped', summary: 'No tags configured — skipped.' };

  if (dryRun) {
    return { action: 'continue', summary: `[Test run] Would remove tag(s): ${rawTags.join(', ')}` };
  }

  if (!db) return { action: 'continue', eventStatus: 'skipped', summary: 'No database connection — tag step skipped.' };

  try {
    for (const tag of rawTags) {
      await db.query(
        `UPDATE leads SET tags = COALESCE(
           (SELECT jsonb_agg(elem)
            FROM jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb)) elem
            WHERE elem <> $1),
           '[]'::jsonb
         ), updated_at = NOW()
         WHERE id = $2`,
        [tag, lead.id],
      );
    }
    const existing = Array.isArray(lead.tags) ? lead.tags
      : (typeof lead.tags === 'string' ? JSON.parse(lead.tags || '[]') : []);
    lead.tags = existing.filter(t => !rawTags.includes(t));

    return { action: 'continue', summary: `Tag(s) removed: ${rawTags.join(', ')}` };
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'Failed to remove tag(s): ' + err.message };
  }
}

// ── NEW STEP: webhook ──────────────────────────────────────────
// POSTs lead + context to an external URL (Zapier / Make / n8n).
// If cfg.responseKey is set, a JSON response is merged into
// run.context[responseKey] so subsequent condition steps can act on it.
async function execWebhook(node, ctx) {
  const { lead, run, dryRun } = ctx;
  const cfg = node.config || {};
  const url = (cfg.url || '').trim();
  if (!url) return { action: 'continue', eventStatus: 'skipped', summary: 'No webhook URL configured — skipped.' };

  const payload = {
    event:   'workflow_step',
    stepId:  node.id,
    runId:   run && run.id,
    lead: {
      id:                lead.id,
      customerName:      lead.customerName || lead.fromName,
      fromEmail:         lead.fromEmail,
      fromPhone:         lead.fromPhone,
      serviceType:       lead.serviceType,
      urgency:           lead.urgency,
      intent:            lead.intent,
      status:            lead.status,
      summary:           lead.summary,
      quote:             lead.quote,
      tags:              lead.tags || [],
      workflowStage:     lead.workflow_stage,
      calendarEventLink: lead.calendar_event_link,
    },
    context: (run && run.context) || {},
  };

  if (dryRun) {
    return {
      action: 'continue',
      summary: `[Test run] Would POST to ${url}`,
      detail: { payload },
    };
  }

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10_000);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Humarains-Workflow/1.0' };
    if (cfg.secret) headers['X-Webhook-Secret'] = cfg.secret;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(tid);

    const text = await res.text().catch(() => '');
    let responseBody = null;
    try { responseBody = JSON.parse(text); } catch (_) { responseBody = text || null; }

    if (!res.ok) {
      return {
        action: 'continue', eventStatus: 'error',
        summary: `Webhook responded ${res.status} — ${String(text).slice(0, 120)}`,
      };
    }

    const contextPatch = {};
    if (cfg.responseKey && typeof responseBody === 'object' && responseBody !== null) {
      contextPatch[cfg.responseKey] = responseBody;
    }

    return {
      action: 'continue',
      summary: `Webhook delivered to ${url} — ${res.status} OK`,
      detail: { status: res.status, responseBody },
      ...(Object.keys(contextPatch).length ? { contextPatch } : {}),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { action: 'continue', eventStatus: 'error', summary: `Webhook timed out after 10 s: ${url}` };
    }
    return { action: 'continue', eventStatus: 'error', summary: 'Webhook failed: ' + err.message };
  }
}

// ── NEW STEP: schedule_reminder ────────────────────────────────
// Schedules a future email message by inserting a row
// into lead_followup_jobs (picked up by the existing poller).
// This lets you say "send a reminder in 2 days" without blocking
// the workflow run itself — the run continues immediately and the
// reminder fires independently at the right time.
async function execScheduleReminder(node, ctx) {
  const { lead, user, db, dryRun, run, businessContext } = ctx;
  const cfg = node.config || {};
  const delay   = { value: Number(cfg.delay && cfg.delay.value) || 1, unit: (cfg.delay && cfg.delay.unit) || 'days' };
  const mode    = cfg.mode    || 'ai';
  const label   = cfg.label   || 'Workflow reminder';

  const scheduledAt = computeWaitUntil(delay);
  // Reminders go by email only (automations never start WhatsApp messages).
  const channelResolved = lead.fromEmail ? 'email' : null;

  if (!channelResolved) {
    return { action: 'continue', eventStatus: 'skipped', summary: 'No contact channel available — reminder skipped.' };
  }

  if (dryRun) {
    const when = scheduledAt.toLocaleString();
    return {
      action: 'continue',
      summary: `[Test run] Would schedule a ${channelResolved} reminder in ${delay.value} ${delay.unit} (${when}): "${label}"`,
    };
  }

  if (!db) return { action: 'continue', eventStatus: 'skipped', summary: 'No database — reminder skipped.' };

  // Build the message body now so the poller has it ready.
  // For AI-mode reminders we store the instructions; the poller generates
  // the actual message text at send time using the current conversation state.
  const messageBody = mode === 'custom'
    ? interpolate(cfg.template || '', lead, businessContext || {}, (run && run.context) || {})
    : null;

  try {
    const jobId = genId('flwjob');
    await db.query(
      `INSERT INTO lead_followup_jobs
         (id, user_id, lead_id, template, day, label, scheduled_at, status,
          channel, message_body, ai_instructions, workflow_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        jobId, user.id, lead.id,
        'reminder',   // template type — consumed by the poller
        0,            // day = 0 means it fires at scheduled_at, not relative day N
        label,
        scheduledAt,
        channelResolved,
        messageBody,
        mode === 'ai' ? (cfg.aiInstructions || 'Send a friendly reminder to check in on the status of their inquiry.') : null,
        run ? run.id : null,
      ],
    );
    return {
      action: 'continue',
      summary: `Reminder scheduled via ${channelResolved} in ${delay.value} ${delay.unit}: "${label}"`,
      detail: { jobId, scheduledAt, channel: channelResolved },
    };
  } catch (err) {
    return { action: 'continue', eventStatus: 'error', summary: 'Failed to schedule reminder: ' + err.message };
  }
}

async function executeStep(node, ctx) {
  switch (node.type) {
    case 'send_message':    return execSendMessage(node, ctx);
    case 'wait':             return execWait(node, ctx);
    case 'wait_for_reply':   return execWaitForReply(node, ctx);
    case 'ai_extract':       return execAiExtract(node, ctx);
    case 'condition':        return execCondition(node, ctx);
    case 'ai_decision':      return execAiDecision(node, ctx);
    case 'update_status':    return execUpdateStatus(node, ctx);
    case 'notify_owner':     return execNotifyOwner(node, ctx);
    case 'book_appointment': return execBookAppointment(node, ctx);
    case 'add_tag':          return execAddTag(node, ctx);
    case 'remove_tag':       return execRemoveTag(node, ctx);
    case 'webhook':          return execWebhook(node, ctx);
    case 'schedule_reminder': return execScheduleReminder(node, ctx);
    default:
      return { action: 'continue', eventStatus: 'skipped', summary: `Unknown step type "${node.type}" — skipped.` };
  }
}

// ════════════════════════════════════════════════════════════════
// RUN STATE MACHINE
// ════════════════════════════════════════════════════════════════
async function logEvent(db, runId, node, status, summary, detail) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO workflow_run_events (id, run_id, step_id, step_type, status, summary, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [genEventId(), runId, node && node.id || null, node && node.type || null, status || 'ok', summary || null, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.error('[Workflow] logEvent error:', e.message); }
}

async function persistRun(db, run) {
  if (!db) return;
  try {
    await db.query(
      `UPDATE workflow_runs SET status=$1, cursor_path=$2, context=$3, wait_until=$4, wait_reason=$5,
         error_message=$6, completed_at=$7, updated_at=NOW() WHERE id=$8`,
      [run.status, JSON.stringify(run.cursor_path || []), JSON.stringify(run.context || {}),
       run.wait_until || null, run.wait_reason || null, run.error_message || null, run.completed_at || null, run.id]
    );
  } catch (e) { console.error('[Workflow] persistRun error:', e.message); }
}

/**
 * Advance a run as far as it will go in one tick: executes steps until it
 * hits a wait, completes, fails, or exhausts the per-tick step budget.
 * `resumeReason` ('reply' | 'timeout' | null) is only honoured on the FIRST
 * node visited in this tick — it tells a paused wait/wait_for_reply step why
 * it's being resumed.
 */
async function tick(db, run, workflow, baseCtx, resumeReason) {
  let path = (run.cursor_path && run.cursor_path.length) ? run.cursor_path.slice() : [0];
  let steps = 0;
  let firstIter = true;
  run.status = 'running';

  while (steps < MAX_STEPS_PER_TICK) {
    steps++;
    const loc = locatePath(workflow.steps, path);
    if (!loc || !loc.node) {
      run.status = 'completed'; run.completed_at = new Date(); run.cursor_path = path;
      await persistRun(db, run);
      return run;
    }

    const node = loc.node;
    const myResume = firstIter ? resumeReason : null;
    firstIter = false;

    const stepCtx = {
      db, run, workflow,
      lead: baseCtx.lead, user: baseCtx.user, businessContext: baseCtx.businessContext,
      claude: baseCtx.claude, model: baseCtx.model || MODEL, dryRun: !!baseCtx.dryRun,
      resumeReason: myResume,
    };

    let result;
    try {
      result = await executeStep(node, stepCtx);
    } catch (err) {
      await logEvent(db, run.id, node, 'error', err.message);
      run.status = 'failed'; run.error_message = String(err.message || err).slice(0, 500); run.cursor_path = path;
      await persistRun(db, run);
      return run;
    }

    await logEvent(db, run.id, node, result.eventStatus || 'ok', result.summary || null, result.detail || null);
    if (result.contextPatch) run.context = { ...(run.context || {}), ...result.contextPatch };

    if (result.action === 'wait') {
      run.status = 'waiting'; run.wait_until = result.waitUntil; run.wait_reason = result.waitReason; run.cursor_path = path;
      await persistRun(db, run);
      return run;
    }
    if (result.action === 'complete') {
      run.status = 'completed'; run.completed_at = new Date(); run.cursor_path = path;
      await persistRun(db, run);
      return run;
    }
    if (result.action === 'fork') {
      path = [...path, result.branchIndex, 0];
      continue;
    }
    // 'continue' — advance to the next sibling step
    const np = nextPath(path);
    const nloc = locatePath(workflow.steps, np);
    if (!nloc || !nloc.node) {
      run.status = 'completed'; run.completed_at = new Date(); run.cursor_path = path;
      await persistRun(db, run);
      return run;
    }
    path = np;
  }

  // Hit the per-tick step budget while still actively running (rare —
  // a long pure-linear chain). Schedule a near-immediate resume via the
  // poller instead of blocking the calling request.
  run.status = 'waiting'; run.wait_until = new Date(Date.now() + 3000); run.wait_reason = 'timer'; run.cursor_path = path;
  await persistRun(db, run);
  return run;
}

async function startRun(db, { workflow, lead, user, businessContext, claude, model, dryRun }) {
  const run = {
    id: genRunId(), workflow_id: workflow.id, user_id: user.id, lead_id: lead.id,
    status: 'running', cursor_path: [], context: {}, wait_until: null, wait_reason: null,
    error_message: null, dry_run: !!dryRun, completed_at: null,
  };
  if (db) {
    try {
      await db.query(
        `INSERT INTO workflow_runs (id, workflow_id, user_id, lead_id, status, cursor_path, context, dry_run)
         VALUES ($1,$2,$3,$4,'running','[]','{}',$5)`,
        [run.id, run.workflow_id, run.user_id, run.lead_id, run.dry_run]
      );
      await db.query(`UPDATE workflows SET run_count = run_count + 1, last_triggered_at = NOW() WHERE id=$1`, [workflow.id]);
    } catch (e) {
      console.error('[Workflow] startRun insert error:', e.message);
      return null;
    }
  }
  return tick(db, run, workflow, { lead, user, businessContext, claude, model, dryRun: !!dryRun }, null);
}

// ════════════════════════════════════════════════════════════════
// ROW MAPPERS
// ════════════════════════════════════════════════════════════════
function rowToRun(row) {
  return {
    id: row.id, workflow_id: row.workflow_id, user_id: row.user_id, lead_id: row.lead_id,
    status: row.status, cursor_path: parseJ(row.cursor_path) || [], context: parseJ(row.context) || {},
    wait_until: row.wait_until, wait_reason: row.wait_reason, error_message: row.error_message,
    dry_run: !!row.dry_run, started_at: row.started_at, updated_at: row.updated_at, completed_at: row.completed_at,
  };
}

function rowToWorkflow(row) {
  return {
    id: row.id, user_id: row.user_id, name: row.name, description: row.description,
    status: row.status, trigger_type: row.trigger_type, trigger_config: parseJ(row.trigger_config) || {},
    steps: parseJ(row.steps) || [], run_count: row.run_count, last_triggered_at: row.last_triggered_at,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// ════════════════════════════════════════════════════════════════
// TRIGGER DISPATCH — called from routes/leads.js / server.js hooks
// ════════════════════════════════════════════════════════════════
async function hasExistingRun(db, workflowId, leadId, activeOnly) {
  if (!db) return false;
  const sql = activeOnly
    ? `SELECT 1 FROM workflow_runs WHERE workflow_id=$1 AND lead_id=$2 AND status IN ('running','waiting') LIMIT 1`
    : `SELECT 1 FROM workflow_runs WHERE workflow_id=$1 AND lead_id=$2 LIMIT 1`;
  const row = await db.queryOne(sql, [workflowId, leadId]).catch(() => null);
  return !!row;
}

async function dispatchTrigger({ db, user, businessContext, lead, claude, model, triggerType, onceOnly, matches }) {
  if (!db || !user || !lead) return [];
  let rows;
  try {
    rows = await db.queryAll(`SELECT * FROM workflows WHERE user_id=$1 AND status='active' AND trigger_type=$2`, [user.id, triggerType]);
  } catch (e) {
    console.error('[Workflow] dispatchTrigger query error:', e.message);
    return [];
  }

  const started = [];
  for (const row of rows) {
    const wf = rowToWorkflow(row);
    try {
      if (!matches(wf)) continue;
      const exists = await hasExistingRun(db, wf.id, lead.id, !onceOnly);
      if (exists) continue;
      const run = await startRun(db, { workflow: wf, lead, user, businessContext, claude, model });
      if (run) started.push(run);
    } catch (e) {
      console.error(`[Workflow] Failed to start workflow ${wf.id} for lead ${lead.id}:`, e.message);
    }
  }
  return started;
}

async function resumeWaitingForReply(db, lead, { user, businessContext, claude, model }) {
  if (!db || !lead) return [];
  let rows;
  try {
    rows = await db.queryAll(
      `SELECT wr.*, w.id as w_id, w.name as w_name, w.status as w_status, w.user_id as w_user_id,
              w.trigger_type as w_trigger_type, w.trigger_config as w_trigger_config, w.steps as w_steps
         FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id
        WHERE wr.lead_id=$1 AND wr.status='waiting' AND wr.wait_reason='reply_or_timeout'`,
      [lead.id]
    );
  } catch (e) {
    console.error('[Workflow] resumeWaitingForReply query error:', e.message);
    return [];
  }

  const resumed = [];
  for (const row of rows) {
    const run = rowToRun(row);
    const workflow = rowToWorkflow({
      id: row.w_id, name: row.w_name, status: row.w_status, user_id: row.w_user_id,
      trigger_type: row.w_trigger_type, trigger_config: row.w_trigger_config, steps: row.w_steps,
    });
    try {
      const updated = await tick(db, run, workflow, { lead, user, businessContext, claude, model, dryRun: run.dry_run }, 'reply');
      resumed.push(updated);
    } catch (e) {
      console.error(`[Workflow] Resume (reply) failed for run ${run.id}:`, e.message);
    }
  }
  return resumed;
}

async function onNewLead({ db, user, businessContext, lead, claude, model }) {
  return dispatchTrigger({
    db, user, businessContext, lead, claude, model, triggerType: 'new_lead', onceOnly: true,
    matches: (wf) => {
      const src = wf.trigger_config && wf.trigger_config.source;
      // 'gmail' is a legacy source value from workflows saved before the
      // Gmail API was replaced with IMAP/SMTP — treat it as 'email'.
      const normalisedSrc = src === 'gmail' ? 'email' : src;
      return !normalisedSrc || normalisedSrc === 'any' || normalisedSrc === lead.source;
    },
  });
}

async function onLeadReplied({ db, user, businessContext, lead, claude, model }) {
  const resumed = await resumeWaitingForReply(db, lead, { user, businessContext, claude, model });
  const started = await dispatchTrigger({
    db, user, businessContext, lead, claude, model, triggerType: 'lead_replied', onceOnly: false,
    matches: () => true,
  });
  return [...resumed, ...started];
}

async function onStatusChanged({ db, user, businessContext, lead, claude, model }) {
  return dispatchTrigger({
    db, user, businessContext, lead, claude, model, triggerType: 'status_changed', onceOnly: false,
    matches: (wf) => wf.trigger_config && wf.trigger_config.toStatus === lead.status,
  });
}

// ════════════════════════════════════════════════════════════════
// POLLER-DRIVEN ENTRY POINTS (called from services/leads/poller.js every cycle)
// ════════════════════════════════════════════════════════════════
async function processDueWaits(db) {
  if (!db) return;
  let rows;
  try {
    rows = await db.queryAll(
      `SELECT wr.*, w.id as w_id, w.name as w_name, w.status as w_status, w.user_id as w_user_id,
              w.trigger_type as w_trigger_type, w.trigger_config as w_trigger_config, w.steps as w_steps
         FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id
        WHERE wr.status='waiting' AND wr.wait_until IS NOT NULL AND wr.wait_until <= NOW()
        LIMIT 50`
    );
  } catch (e) { console.error('[Workflow] processDueWaits query error:', e.message); return; }
  if (!rows.length) return;

  const claude = getClaude();
  const { rowToLead, getSettings } = require('../../routes/leads');

  for (const row of rows) {
    const run = rowToRun(row);
    const workflow = rowToWorkflow({
      id: row.w_id, name: row.w_name, status: row.w_status, user_id: row.w_user_id,
      trigger_type: row.w_trigger_type, trigger_config: row.w_trigger_config, steps: row.w_steps,
    });
    try {
      const leadRow = await db.queryOne('SELECT * FROM leads WHERE id=$1', [run.lead_id]);
      if (!leadRow) { run.status = 'failed'; run.error_message = 'Lead no longer exists'; await persistRun(db, run); continue; }
      const userRow = await db.queryOne('SELECT * FROM users WHERE id=$1', [run.user_id]);
      if (!userRow) continue;
      const lead = rowToLead(leadRow);
      const businessContext = await getSettings(run.user_id, db);
      await tick(db, run, workflow, { lead, user: userRow, businessContext, claude, model: MODEL, dryRun: run.dry_run }, 'timeout');
    } catch (e) {
      console.error(`[Workflow] processDueWaits run ${run.id} error:`, e.message);
    }
  }
}

async function processStalledTriggers(db) {
  if (!db) return;
  let rows;
  try {
    rows = await db.queryAll(`SELECT * FROM workflows WHERE status='active' AND trigger_type='stalled'`);
  } catch (e) { console.error('[Workflow] processStalledTriggers query error:', e.message); return; }
  if (!rows.length) return;

  const claude = getClaude();
  const { rowToLead, getSettings } = require('../../routes/leads');

  for (const wfRow of rows) {
    const wf = rowToWorkflow(wfRow);
    const afterHours = (wf.trigger_config && Number(wf.trigger_config.afterHours)) || 24;
    let leadRows;
    try {
      leadRows = await db.queryAll(
        `SELECT * FROM leads
          WHERE user_id=$1 AND status='pending_followup'
            AND from_email IS NOT NULL AND from_email <> '' AND source <> 'whatsapp'
            AND COALESCE(last_customer_message_at, updated_at) < NOW() - (INTERVAL '1 hour' * $2)
            AND id NOT IN (SELECT lead_id FROM workflow_runs WHERE workflow_id=$3)
          LIMIT 25`,
        [wf.user_id, afterHours, wf.id]
      );
    } catch (e) { console.error(`[Workflow] stalled query error for workflow ${wf.id}:`, e.message); continue; }
    if (!leadRows.length) continue;

    const userRow = await db.queryOne('SELECT * FROM users WHERE id=$1', [wf.user_id]).catch(() => null);
    if (!userRow) continue;
    const businessContext = await getSettings(wf.user_id, db).catch(() => ({}));

    for (const leadRow of leadRows) {
      const lead = rowToLead(leadRow);
      try { await startRun(db, { workflow: wf, lead, user: userRow, businessContext, claude, model: MODEL }); }
      catch (e) { console.error(`[Workflow] stalled startRun error for lead ${lead.id}:`, e.message); }
    }
  }
}

// ════════════════════════════════════════════════════════════════
// RUN MANAGEMENT (used by routes/workflows.js)
// ════════════════════════════════════════════════════════════════
async function listRunsForWorkflow(db, workflowId, limit = 100) {
  return db.queryAll(
    `SELECT wr.*, l.from_name, l.from_email, l.customer_name, l.from_phone
       FROM workflow_runs wr LEFT JOIN leads l ON l.id = wr.lead_id
      WHERE wr.workflow_id=$1 ORDER BY wr.started_at DESC LIMIT $2`,
    [workflowId, limit]
  );
}

async function listRunsForUser(db, userId, limit = 50) {
  return db.queryAll(
    `SELECT wr.*, w.name as workflow_name, l.from_name, l.from_email, l.customer_name
       FROM workflow_runs wr
       JOIN workflows w ON w.id = wr.workflow_id
       LEFT JOIN leads l ON l.id = wr.lead_id
      WHERE wr.user_id=$1 ORDER BY wr.started_at DESC LIMIT $2`,
    [userId, limit]
  );
}

async function getRun(db, runId) { return db.queryOne(`SELECT * FROM workflow_runs WHERE id=$1`, [runId]); }
async function listEventsForRun(db, runId) { return db.queryAll(`SELECT * FROM workflow_run_events WHERE run_id=$1 ORDER BY created_at ASC`, [runId]); }

async function cancelRun(db, runId) {
  return db.query(`UPDATE workflow_runs SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status IN ('running','waiting')`, [runId]);
}

async function retryRun(db, runId, ctx) {
  const row = await db.queryOne(`SELECT * FROM workflow_runs WHERE id=$1`, [runId]);
  if (!row) return null;
  const run = rowToRun(row);
  const wfRow = await db.queryOne(`SELECT * FROM workflows WHERE id=$1`, [run.workflow_id]);
  if (!wfRow) return null;
  const workflow = rowToWorkflow(wfRow);
  run.error_message = null;
  return tick(db, run, workflow, ctx, null);
}

async function testRun(db, { workflow, lead, user, businessContext, claude, model }) {
  return startRun(db, { workflow, lead, user, businessContext, claude, model, dryRun: true });
}

// ════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════
function validateSteps(steps, errors, depth) {
  if (depth > 8) { errors.push('Workflow nesting is too deep.'); return; }
  for (const s of steps || []) {
    if (!s || !VALID_STEP_TYPES.includes(s.type)) { errors.push(`Unknown step type: ${s && s.type}`); continue; }
    if (s.type === 'condition' && (!s.branches || s.branches.length !== 2)) errors.push('Condition steps need exactly two branches (Yes / No).');
    if ((s.type === 'ai_decision') && (!s.branches || s.branches.length < 1)) errors.push('AI decision steps need at least one branch.');
    if ((s.type === 'wait_for_reply') && (!s.branches || s.branches.length !== 2)) errors.push('Wait-for-reply steps need exactly two branches (Replied / No Reply).');
    if (s.branches) for (const b of s.branches) validateSteps(b.steps || [], errors, depth + 1);
  }
}

function validateWorkflow(wf) {
  const errors = [];
  if (!wf || typeof wf !== 'object') return { valid: false, errors: ['Workflow payload missing.'] };
  if (!wf.name || !String(wf.name).trim()) errors.push('Name is required.');
  if (!wf.trigger || !VALID_TRIGGER_TYPES.includes(wf.trigger.type)) errors.push('A valid trigger type is required.');
  if (!Array.isArray(wf.steps)) errors.push('Steps must be an array.');
  else validateSteps(wf.steps, errors, 0);
  return { valid: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════════════════
// STARTER TEMPLATES
// ════════════════════════════════════════════════════════════════
function getTemplates() {
  // Starter automations for a service business. All of them email the customer or alert the owner; none contact anyone on WhatsApp
  // (the AI already answers every WhatsApp message by itself).
  return [
    {
      key: 'chase_quiet_quotes',
      name: 'Chase quotes that go quiet',
      description: 'If a customer has not answered your quote after 2 days, send a friendly check-in. If there is still no reply, send one last note and close the lead.',
      trigger: { type: 'stalled', config: { afterHours: 48 } },
      steps: [
        { id: genStepId(), type: 'send_message', config: { channel: 'email', mode: 'ai', aiInstructions: 'Write a short, friendly check-in about the quote we sent. Ask if they have any questions or want to book a time. Do not sound pushy.' } },
        {
          id: genStepId(), type: 'wait_for_reply', config: { timeout: { value: 3, unit: 'days' } },
          branches: [
            { id: genBranchId(), label: 'Replied', steps: [] },
            {
              id: genBranchId(), label: 'No Reply', steps: [
                { id: genStepId(), type: 'send_message', config: { channel: 'email', mode: 'ai', aiInstructions: 'Write a brief, warm last note. Say the quote stays open if they change their mind and they are welcome to get in touch any time. Do not chase further.' } },
                { id: genStepId(), type: 'update_status', config: { status: 'closed', stage: 'lost' } },
              ],
            },
          ],
        },
      ],
    },
    {
      key: 'alert_urgent_jobs',
      name: 'Alert me to urgent jobs',
      description: 'When a new enquiry looks like an emergency, email you straight away and mark it as a hot lead so you can call them first.',
      trigger: { type: 'new_lead', config: { source: 'any' } },
      steps: [
        {
          id: genStepId(), type: 'condition', config: { field: 'lead.urgency', operator: 'equals', value: 'emergency' },
          branches: [
            {
              id: genBranchId(), label: 'Urgent', steps: [
                { id: genStepId(), type: 'notify_owner', config: { subject: 'Urgent job just came in', message: 'This enquiry looks urgent. It is worth calling them personally right away.' } },
                { id: genStepId(), type: 'update_status', config: { stage: 'hot_lead' } },
              ],
            },
            { id: genBranchId(), label: 'Not urgent', steps: [] },
          ],
        },
      ],
    },
    {
      key: 'ask_for_review',
      name: 'Thank customers and ask for a review',
      description: 'A few days after you mark a job as won, email the customer to say thanks and ask for a review.',
      trigger: { type: 'status_changed', config: { toStatus: 'closed' } },
      steps: [
        { id: genStepId(), type: 'wait', config: { duration: { value: 3, unit: 'days' } } },
        {
          id: genStepId(), type: 'condition', config: { field: 'lead.wonAt', operator: 'is_set', value: '' },
          branches: [
            {
              id: genBranchId(), label: 'Job was won', steps: [
                { id: genStepId(), type: 'send_message', config: { channel: 'email', mode: 'ai', aiInstructions: 'Thank the customer for choosing us. Ask them to share a short review of how the job went, mentioning where to leave one if a review link is available. Keep it to a few sentences.' } },
              ],
            },
            { id: genBranchId(), label: 'Not won', steps: [] },
          ],
        },
      ],
    },
    {
      key: 'win_back_cold_leads',
      name: 'Win back cold leads',
      description: 'Two weeks after a lead goes quiet, send one friendly message asking whether they still need help.',
      trigger: { type: 'stalled', config: { afterHours: 336 } },
      steps: [
        { id: genStepId(), type: 'send_message', config: { channel: 'email', mode: 'ai', aiInstructions: 'Write a short, friendly note asking whether they still need help with what they enquired about, and that we would be glad to help. One question only.' } },
        { id: genStepId(), type: 'add_tag', config: { tags: 'win-back-sent' } },
      ],
    },
  ];
}

module.exports = {
  // ids
  genWorkflowId, genRunId, genStepId, genBranchId,
  // constants
  VALID_TRIGGER_TYPES, VALID_STEP_TYPES, VALID_LEAD_STATUSES,
  // validation
  validateWorkflow,
  // templates
  getTemplates,
  // triggers (event-driven hooks)
  onNewLead, onLeadReplied, onStatusChanged,
  // triggers (poller-driven)
  processDueWaits, processStalledTriggers,
  // run management
  startRun, testRun, retryRun, cancelRun,
  getRun, listRunsForWorkflow, listRunsForUser, listEventsForRun,
  // row mappers (used by routes layer)
  rowToRun, rowToWorkflow,
  // exposed for testing
  _internal: { locatePath, nextPath, evalCondition, resolveField, interpolate, tick },
};
