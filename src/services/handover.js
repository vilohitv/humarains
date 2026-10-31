/**
 * services/handover.js — the AI hands a conversation to a person on the team.
 *
 * When a lead reaches the closing stages (the customer wants to book, or has said yes) the AI stops
 * selling and a person takes over. This module decides WHO (by the job), tells them, and gives them the
 * lead's phone number and / or email. It works the same for email and WhatsApp conversations.
 *
 *   The team and the switch   settings.handoverEnabled / handoverStages / handoverContacts / handoverCopyOwner
 *                             (saved with the business settings, so no table of their own)
 *   The state on the lead     leads.handover = null | pending | active | resumed   (see db/schema.sql)
 *
 *   engine.processReply()     decides: sets lead.handover = {status:'pending', ...} and writes a reply that tells the
 *                             customer who will be in touch
 *   dispatchPending()         delivers: pending → active (claimed atomically, so it happens once), emails the person,
 *                             stops follow-ups, tags the lead
 *   forwardCustomerMessage()  after the handover the AI no longer replies; new customer messages go to the person
 *   resumeAI()                the owner gives the conversation back to the AI
 *
 * Pure helpers (normalizeConfig, validateConfig, pickContact, shouldHandover, ...) have no I/O, so they are unit-tested directly.
 */
'use strict';

const crypto = require('crypto');

// Stages in which the AI hands over. These are the closing stages from engine.detectConversationStage().
const STAGE_CHOICES = ['quoted', 'booking_requested', 'deal_closed'];
const DEFAULT_STAGES = ['booking_requested', 'deal_closed'];
const MAX_CONTACTS = 20;
const MAX_JOBS = 25;

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;

function genContactId() { return 'hc_' + crypto.randomBytes(5).toString('hex'); }

/** Keep digits and a leading +, so a number can go in a tel: link and a wa.me link. */
function cleanPhone(v) {
  const s = String(v == null ? '' : v).trim();
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d]/g, '').slice(0, 18);
}
const phoneOk = p => p.replace(/^\+/, '').length >= 7;

// ── Settings ─────────────────────────────────────────────────

function normalizeContact(c) {
  c = c || {};
  const jobs = (Array.isArray(c.jobs) ? c.jobs : String(c.jobs || '').split(','))
    .map(j => clip(j, 60)).filter(Boolean);
  return {
    id:        /^hc_[a-z0-9]{4,20}$/.test(String(c.id || '')) ? c.id : genContactId(),
    name:      clip(c.name, 80),
    role:      clip(c.role, 80),
    email:     clip(c.email, 254).toLowerCase(),
    phone:     cleanPhone(c.phone),
    jobs:      [...new Set(jobs.map(j => j.toLowerCase()))].slice(0, MAX_JOBS),
    isDefault: !!c.isDefault,
    active:    c.active !== false,
  };
}

/** The handover settings as saved (or the defaults), always in a safe shape. */
function normalizeConfig(settings) {
  const s = settings || {};
  const stages = (Array.isArray(s.handoverStages) ? s.handoverStages : DEFAULT_STAGES).filter(x => STAGE_CHOICES.includes(x));
  const contacts = (Array.isArray(s.handoverContacts) ? s.handoverContacts : []).slice(0, MAX_CONTACTS).map(normalizeContact)
    .filter(c => c.name && (c.email || c.phone));
  // At most one default: the first one marked wins.
  let seenDefault = false;
  contacts.forEach(c => { if (c.isDefault && !seenDefault) seenDefault = true; else c.isDefault = false; });
  return {
    enabled:   s.handoverEnabled === true,
    stages:    stages.length ? stages : DEFAULT_STAGES.slice(),
    contacts,
    copyOwner: s.handoverCopyOwner !== false,   // the owner is copied on every handover unless they turn it off
  };
}

/** Check what the owner submitted. Returns { ok:true, config } or { ok:false, error }. */
function validateConfig(body) {
  const b = body || {};
  if (b.contacts !== undefined && !Array.isArray(b.contacts)) return { ok: false, error: 'contacts must be a list.' };
  if (b.stages !== undefined && !Array.isArray(b.stages)) return { ok: false, error: 'stages must be a list.' };
  const raw = (b.contacts || []).slice(0, MAX_CONTACTS + 1);
  if (raw.length > MAX_CONTACTS) return { ok: false, error: `You can add up to ${MAX_CONTACTS} people.` };
  const contacts = [];
  for (const r of raw) {
    const c = normalizeContact(r);
    if (!c.name) return { ok: false, error: 'Every person needs a name.' };
    if (!c.email && !c.phone) return { ok: false, error: `${c.name} needs an email or a phone number so they can be reached.` };
    if (c.email && !EMAIL_RE.test(c.email)) return { ok: false, error: `${c.name}'s email address does not look right.` };
    if (c.phone && !phoneOk(c.phone)) return { ok: false, error: `${c.name}'s phone number does not look right.` };
    contacts.push(c);
  }
  const stages = (b.stages || DEFAULT_STAGES).filter(x => STAGE_CHOICES.includes(x));
  if (b.enabled === true && !stages.length) return { ok: false, error: 'Choose at least one moment to hand over.' };
  return {
    ok: true,
    config: {
      handoverEnabled:   b.enabled === true,
      handoverStages:    stages.length ? stages : DEFAULT_STAGES.slice(),
      handoverContacts:  normalizeConfig({ handoverContacts: contacts }).contacts,
      handoverCopyOwner: b.copyOwner !== false,
    },
  };
}

// ── Who takes it ─────────────────────────────────────────────

function shouldHandover(config, stage) {
  return !!(config && config.enabled && stage && config.stages.includes(stage));
}

/**
 * Choose the person by the job. Each person lists the jobs they handle ("roof repair", "boiler"). A lead matches
 * on its service (strongest) or on those words anywhere in what the customer wrote. No match: the default person.
 * No default: null, which means the owner (resolved when the handover is delivered).
 */
function pickContact(config, lead) {
  const contacts = ((config && config.contacts) || []).filter(c => c.active !== false);
  const svc = String((lead && lead.serviceType) || '').toLowerCase().trim();
  const text = [lead && lead.serviceType, lead && lead.subject, lead && lead.summary, lead && lead.lastCustomerMessage]
    .filter(Boolean).join(' ').toLowerCase();

  let best = null, bestScore = 0;
  for (const c of contacts) {
    let score = 0;
    for (const job of c.jobs || []) {
      if (!job) continue;
      if (svc && svc === job) score += 4;
      else if (svc && (svc.includes(job) || job.includes(svc))) score += 3;
      else if (text.includes(job)) score += 1;
    }
    if (score > bestScore) { best = c; bestScore = score; }     // a tie goes to whoever is listed first
  }
  if (best) return { contact: best, matchedBy: 'job' };
  const def = contacts.find(c => c.isDefault);
  if (def) return { contact: def, matchedBy: 'default' };
  return { contact: null, matchedBy: 'owner' };
}

/** The first name the AI may use when it tells the customer who is in touch. */
function firstName(name) { return clip(name, 80).split(' ')[0] || ''; }

/** The line added to the AI's reply prompt so the customer is told who will contact them. */
function handoverPromptNote(name, channel) {
  const n = firstName(name);
  const who = n ? `${n} from the team` : 'a member of the team';
  const how = channel === 'whatsapp' ? 'on WhatsApp or by phone' : 'by email or phone';
  return `HANDOVER: ${who} is taking over this conversation personally from here. Tell the customer that ${n || 'someone from the team'} will be in touch shortly ${how}, `
    + 'and thank them. Do not promise an exact time, do not ask any more sales or qualifying questions, and do not give out anyone\'s phone number or email.';
}

/** What the engine stores on the lead at decision time. */
function planHandover(config, lead, stage) {
  const { contact, matchedBy } = pickContact(config, lead);
  return {
    status:      'pending',
    contactId:   contact ? contact.id : null,
    contactName: contact ? contact.name : null,
    matchedBy,
    stage,
    plannedAt:   new Date().toISOString(),
  };
}

// ── The lead's contact details ───────────────────────────────

function leadChannel(lead) { return String((lead && lead.source) || '').toLowerCase() === 'whatsapp' ? 'whatsapp' : 'email'; }

/** The phone and email the person needs. Either may be missing; at least one nearly always exists. */
function leadContactDetails(lead) {
  const phone = cleanPhone((lead && (lead.whatsappThreadPhone || lead.fromPhone)) || '');
  return {
    name:  (lead && (lead.customerName || lead.fromName)) || '',
    phone: phone ? (phone.startsWith('+') ? phone : '+' + phone) : '',
    email: (lead && lead.fromEmail) || '',
  };
}

function money(q) {
  if (!q) return '';
  if (q.total != null && q.total !== '' && !(q.requiresSiteVisit && !(q.lineItems || []).length)) return `${q.currency || ''} ${Number(q.total).toLocaleString('en-US')}`.trim();
  if (q.range && q.range.low != null) return `${q.currency || ''} ${Number(q.range.low).toLocaleString('en-US')} - ${Number(q.range.high).toLocaleString('en-US')}`.trim();
  return q.requiresSiteVisit ? 'Site visit needed before pricing' : '';
}

const STAGE_REASON = {
  quoted:            'They have been sent a quote.',
  booking_requested: 'They told us they want to book.',
  deal_closed:       'They confirmed they are going ahead.',
};

function recentHistory(lead, businessName) {
  return (lead.conversationHistory || []).slice(-6).map(t => ({
    who:  t.role === 'customer' ? 'Customer' : (businessName || 'Us'),
    text: clip(t.body, 280),
  })).filter(h => h.text);
}

// ── Delivery ─────────────────────────────────────────────────

async function patchHandover(db, userId, leadId, patch) {
  await db.query(
    `UPDATE leads SET handover = COALESCE(handover,'{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id=$2 AND user_id=$3`,
    [JSON.stringify(patch), leadId, userId]);
}

/** The person for a handover that is being delivered: the chosen team member, or the owner when none was chosen. */
function resolveRecipient(config, handover, user, settings) {
  const contact = (config.contacts || []).find(c => c.id === (handover && handover.contactId));
  if (contact) return { ...contact, isOwner: false };
  return {
    id: null, isOwner: true,
    name:  (settings && settings.ownerName) || (user && user.name) || 'there',
    email: (user && user.email) || '',
    phone: (settings && settings.phone) || '',
  };
}

/** Who gets the email: the person, plus the owner (copied) unless the person IS the owner or the owner opted out. */
function recipientsFor(recipient, config, user) {
  const to = [];
  if (recipient.email) to.push(recipient.email);
  const ownerEmail = user && user.email;
  if (ownerEmail && !to.includes(ownerEmail) && (config.copyOwner || !to.length)) to.push(ownerEmail);
  return to;
}

/**
 * Deliver a pending handover. Safe to call more than once for the same lead (a retried batch, a crash): the
 * pending → active step is one atomic UPDATE, so only one caller wins and the person is told once.
 */
async function dispatchPending({ db, user, lead, businessContext }) {
  if (!db || !lead || !lead.handover || lead.handover.status !== 'pending') return { skipped: true };
  const claimed = await db.queryOne(
    `UPDATE leads SET handover = handover || $1::jsonb, updated_at = NOW()
      WHERE id=$2 AND user_id=$3 AND handover->>'status' = 'pending' RETURNING id`,
    [JSON.stringify({ status: 'active', startedAt: new Date().toISOString() }), lead.id, user.id]);
  if (!claimed) return { skipped: true };

  const config = normalizeConfig(businessContext);
  const recipient = resolveRecipient(config, lead.handover, user, businessContext);
  const to = recipientsFor(recipient, config, user);
  const details = leadContactDetails(lead);
  const channel = leadChannel(lead);

  // The handover is real even if the email cannot be sent: the AI has told the customer someone will be in touch.
  // So a failure is loud: the lead goes to Human Review with the reason.
  let notified = false, error = null;
  try {
    if (!to.length) throw new Error(`${recipient.name} has no email address, so nobody could be emailed`);
    const { handoverNotice } = require('../lib/email-templates');
    const { dashboardUrl } = require('../lib/deeplink');
    const appUrl = process.env.APP_URL || 'https://humarains.com';
    const mail = handoverNotice({
      kind: 'handover', toName: recipient.isOwner ? '' : firstName(recipient.name),
      lead: { ...details, channel, service: lead.serviceType, urgency: lead.urgency, summary: lead.summary, quote: money(lead.quote) },
      reason: STAGE_REASON[lead.handover.stage] || 'They are close to a decision.',
      history: recentHistory(lead, businessContext && businessContext.businessName),
      link: { href: dashboardUrl(appUrl, { view: 'leads', lead: lead.id }), label: 'Open the full conversation' },
      appUrl,
    });
    notified = await require('./mailer').sendMail({ to: to.join(', '), subject: mail.subject, html: mail.html });
    if (!notified) throw new Error('no email provider is configured');
  } catch (e) { error = e.message; }

  try {
    await patchHandover(db, user.id, lead.id, {
      contactId: recipient.id, contactName: recipient.name, contactEmail: recipient.email || null, contactPhone: recipient.phone || null,
      ownerFallback: recipient.isOwner,
      notifiedAt: notified ? new Date().toISOString() : null, notifyError: error,
    });
    // No more nudges from the AI, and a tag the dashboard can filter on.
    await db.query(
      `UPDATE leads SET tags = CASE WHEN COALESCE(tags,'[]'::jsonb) @> '["handed-over"]'::jsonb THEN tags
                                    ELSE COALESCE(tags,'[]'::jsonb) || '["handed-over"]'::jsonb END WHERE id=$1 AND user_id=$2`, [lead.id, user.id]);
    await require('./leads/scheduler').cancelFollowUps(lead.id, db).catch(() => {});
    if (error) {
      await db.query(
        `UPDATE leads SET needs_human_review = true, human_review_reason = $1 WHERE id=$2 AND user_id=$3`,
        [`The AI handed this lead to ${recipient.name} but could not tell them: ${error}. Contact the customer yourself${details.phone ? ' on ' + details.phone : details.email ? ' at ' + details.email : ''}.`, lead.id, user.id]);
    }
  } catch (e) { console.error('[Handover] bookkeeping failed for lead ' + lead.id + ':', e.message); }

  console.log(`[Handover] lead ${lead.id} → ${recipient.name}${recipient.isOwner ? ' (owner)' : ''} via ${lead.handover.matchedBy}; ${notified ? 'emailed' : 'NOT emailed: ' + error}`);
  return { delivered: !error, recipient: recipient.name, error };
}

/** After a handover the AI is silent. The customer's new message goes straight to the person. */
async function forwardCustomerMessage({ db, user, lead, businessContext }) {
  const h = lead && lead.handover;
  if (!db || !h || h.status !== 'active') return { skipped: true };
  const key = lead.lastCustomerMessageAt || String((lead.conversationHistory || []).length);
  if (h.lastForwardedKey === key) return { skipped: true };       // this message was already passed on (a retried batch)
  const config = normalizeConfig(businessContext);
  const recipient = resolveRecipient(config, h, user, businessContext);
  const to = recipientsFor(recipient, config, user);
  if (!to.length) return { skipped: true };
  try {
    const { handoverNotice } = require('../lib/email-templates');
    const { dashboardUrl } = require('../lib/deeplink');
    const appUrl = process.env.APP_URL || 'https://humarains.com';
    const mail = handoverNotice({
      kind: 'message', toName: recipient.isOwner ? '' : firstName(recipient.name),
      lead: { ...leadContactDetails(lead), channel: leadChannel(lead), service: lead.serviceType },
      message: clip(lead.lastCustomerMessage, 1500),
      link: { href: dashboardUrl(appUrl, { view: 'leads', lead: lead.id }), label: 'Open the conversation' }, appUrl,
    });
    const ok = await require('./mailer').sendMail({ to: to.join(', '), subject: mail.subject, html: mail.html });
    if (ok) await patchHandover(db, user.id, lead.id, { lastForwardedKey: key, lastForwardedAt: new Date().toISOString() });
    return { forwarded: !!ok };
  } catch (e) {
    console.error('[Handover] forwarding failed for lead ' + lead.id + ':', e.message);
    return { forwarded: false, error: e.message };
  }
}

/** The owner gives the conversation back: the AI replies again. It will not hand this lead over a second time. */
async function resumeAI(db, userId, leadId) {
  const row = await db.queryOne(
    `UPDATE leads SET handover = handover || $1::jsonb, updated_at = NOW()
      WHERE id=$2 AND user_id=$3 AND handover->>'status' IN ('active','pending') RETURNING id`,
    [JSON.stringify({ status: 'resumed', resumedAt: new Date().toISOString() }), leadId, userId]);
  return !!row;
}

/** The owner hands a lead over by hand (any time, any stage) to a chosen person. */
async function manualHandover({ db, user, lead, businessContext, contactId }) {
  const config = normalizeConfig(businessContext);
  const contact = contactId ? config.contacts.find(c => c.id === contactId) : null;
  if (contactId && !contact) return { ok: false, error: 'That person is not on your team list.' };
  if (lead.handover && lead.handover.status === 'active') return { ok: false, error: 'This lead is already handed over.' };
  const handover = {
    status: 'pending', contactId: contact ? contact.id : null, contactName: contact ? contact.name : null,
    matchedBy: 'manual', stage: lead.conversationStage || null, plannedAt: new Date().toISOString(),
  };
  await db.query(`UPDATE leads SET handover = $1::jsonb, updated_at = NOW() WHERE id=$2 AND user_id=$3`, [JSON.stringify(handover), lead.id, user.id]);
  const res = await dispatchPending({ db, user, lead: { ...lead, handover }, businessContext });
  return { ok: true, ...res };
}

module.exports = {
  STAGE_CHOICES, DEFAULT_STAGES, MAX_CONTACTS,
  normalizeContact, normalizeConfig, validateConfig,
  shouldHandover, pickContact, planHandover, handoverPromptNote,
  leadContactDetails, leadChannel, firstName, cleanPhone,
  resolveRecipient, recipientsFor,
  dispatchPending, forwardCustomerMessage, resumeAI, manualHandover,
};
