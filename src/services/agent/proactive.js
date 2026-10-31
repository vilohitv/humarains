/**
 * services/agent/proactive.js — the Agent works while the owner is away.
 *
 * The chat Agent (routes/agent.js) only acts when the owner types. This module
 * is its proactive half. On a schedule it looks through each business's leads
 * for money that is being left on the table, writes a ready-to-send follow-up
 * for each, and queues it as an OPPORTUNITY the owner can approve in one click.
 * Playbooks the owner has switched to Autopilot run without waiting.
 *
 * Playbooks (KINDS)
 *   quote_followup  – a quote went out and the customer never answered
 *   go_cold         – an enquiry went quiet before a quote was sent
 *   review_request  – a job was won recently; ask the happy customer for a review
 *   winback         – a past customer who has not been in touch for a while
 *   discount_offer  – a quote nobody answered: offer the owner's discount (capped, once per customer)
 *
 * What each playbook may do is the owner's call (services/agent/autonomy.js): off, ask (an opportunity the owner
 * approves) or auto (the Agent just does it). Automatic runs also obey the owner's limits: messages per day, contacts
 * per customer, quiet hours, and the discount ceiling and monthly budget.
 *
 * Safety
 *  - Nothing is ever sent from here directly. Approval hands the audience and
 *    message to the same run_campaign / launchCampaign path the chat Agent uses,
 *    so consent mode, plan quotas, do-not-contact and the send gate all apply.
 *  - Do-not-contact leads and leads with no reachable channel are never included.
 *  - A lead is not proposed again for the same playbook for COOLDOWN_DAYS.
 *  - Autopilot only runs on plans with autonomous mode, only when the account is
 *    in autonomous mode, and is capped per playbook per day.
 *  - Lead text is untrusted: drafts are written from the business profile and
 *    playbook goal only, never from lead content.
 *
 * Also here: the morning briefing email (sendDueBriefings).
 * tick(db) is called every ~30 min from services/leads/poller.js. All claims are atomic
 * in the database so multiple instances never double-send.
 */
'use strict';

const crypto = require('crypto');
const autonomy = require('./autonomy');

const COOLDOWN_DAYS      = 14;
const SCAN_EVERY_HOURS   = 6;
const MAX_LEADS_PER_PROP = 25;
const AUTOPILOT_DAILY_CAP = 10;     // fallback; the real cap per plan is plans.js autopilotDailyCap (Growth 10, Pro 50)
const USERS_PER_TICK     = 25;
const BRIEFING_HOUR      = 8;       // local hour at/after which the briefing goes out
const BRIEFING_LAST_HOUR = 19;      // ...and not after this (don't send a "morning" mail at night)
const DNC                = 'do-not-contact';
const ALERT_WAIT_HOURS   = 2;       // a customer who wrote last and has waited this long is worth a ping
const ALERT_MAX_AGE_DAYS = 3;       // ...but not forever; older ones are the follow-up playbooks' job
const ALERT_MIN_GAP_H    = 4;       // at most one alert per owner every N hours
const ALERT_DAILY_CAP    = 2;       // and at most this many per local day
const ALERT_FIRST_HOUR   = 7;       // quiet hours: only between these local hours
const ALERT_LAST_HOUR    = 21;
const SUPPRESS_AFTER_DISMISSALS = 3;  // dismissed this many times with zero approvals -> stop proposing that playbook
const SUPPRESS_WINDOW_DAYS = 60;
const SUGGEST_AUTOPILOT_AFTER = 2;    // approvals (no dismissals) before the Agent offers Autopilot
const MODEL = process.env.AGENT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// Merge fields the campaign engine fills in per lead (see workflow-engine interpolate()).
const ALLOWED_FIELDS = new Set(['customerName', 'serviceType', 'businessName', 'ownerName', 'bookingUrl', 'phone', 'quoteTotal',
  'discountPercent', 'discountedTotal', 'discountExpiry']);

const KINDS = {
  quote_followup: {
    label: 'Quotes waiting on an answer',
    goal: 'Gently check whether the customer has had a chance to look at the quote we sent them, offer to answer questions or adjust it, and make saying yes easy.',
    fallback: 'Hi {{customerName}}, it\'s {{ownerName}} from {{businessName}}. I wanted to check in on the quote we sent over for {{serviceType}}. Happy to answer any questions or adjust anything — would you like to go ahead?',
    tag: 'quote-nudged',
  },
  go_cold: {
    label: 'Enquiries that went quiet',
    goal: 'Reach out to someone who enquired but never replied again. Ask if they are still interested, keep it light and pressure-free, and offer a next step.',
    fallback: 'Hi {{customerName}}, it\'s {{ownerName}} from {{businessName}}. Just checking in on your {{serviceType}} enquiry — is it still something you\'re looking to do? Happy to help whenever you\'re ready.',
    tag: 'revived',
  },
  review_request: {
    label: 'Happy customers to ask for a review',
    goal: 'Thank a customer whose job was recently completed and ask, warmly and briefly, if they would leave a short review. Include {{reviewLink}} exactly once if one is provided.',
    fallback: 'Hi {{customerName}}, it\'s {{ownerName}} from {{businessName}}. Thank you again for choosing us! If you were happy with the work, a quick review would mean a lot to a small business like ours.',
    tag: 'review-asked',
  },
  winback: {
    label: 'Past customers worth a check-in',
    goal: 'Check in with a past customer we have not spoken to in a while. Thank them, ask if they have anything coming up, and mention that we would love to help again.',
    fallback: 'Hi {{customerName}}, it\'s {{ownerName}} from {{businessName}}. It\'s been a while since we worked together — do you have anything coming up we could help with? We\'d love to look after you again.',
    tag: 'winback-asked',
  },
  discount_offer: {
    label: 'Quotes that could close with a discount',
    goal: 'Follow up on a quote that has had no answer. Offer the discount using the merge fields {{discountPercent}} (a number, write it as "{{discountPercent}}% off"), {{discountedTotal}} and {{discountExpiry}} exactly as given, say it is for a limited time, and make saying yes easy. Do not invent any other number or date.',
    fallback: 'Hi {{customerName}}, it\'s {{ownerName}} from {{businessName}}. I wanted to follow up on your {{serviceType}} quote. If you would like to go ahead, I can take {{discountPercent}}% off, which brings it to {{discountedTotal}}, until {{discountExpiry}}. Just reply and we will get you booked in.',
    tag: 'discount-offered',
    required: ['discountPercent'],
  },
};
const KIND_KEYS = Object.keys(KINDS);

const genId = () => 'opp_' + crypto.randomBytes(8).toString('hex');
const parseJ = v => { if (v == null) return v; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return v; } };
const asTags = v => { const t = parseJ(v); return Array.isArray(t) ? t : []; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const apiBase = () => process.env.APP_URL || 'https://humarains.com';
const { dashboardUrl } = require('../../lib/deeplink');

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch (_) { return null; }
}

// ══════════════════════════════════════════════════════════════
// Preferences (autopilot playbooks, briefing, review link)
// ══════════════════════════════════════════════════════════════
async function getPrefs(db, userId) {
  const row = await db.queryOne('SELECT * FROM agent_prefs WHERE user_id=$1', [userId]).catch(() => null);
  const policy = await autonomy.getPolicy(db, userId);
  return {
    // The playbooks the owner has set to run by themselves. Derived from the permissions policy, so the older
    // Autopilot switches on the home screen and the Agent's set_autopilot tool always agree with Settings.
    autopilot: KIND_KEYS.filter(k => policy.actions[autonomy.PLAYBOOK_ACTION[k]].mode === 'auto'),
    policy,
    dailyBriefing: row ? row.daily_briefing !== false : true,
    reviewUrl: (row && row.review_url) || '',
    alertsEnabled: row ? row.alerts_enabled !== false : true,
    lastScanAt: row ? row.last_scan_at : null,
  };
}

async function savePrefs(db, userId, patch) {
  const cur = await getPrefs(db, userId);
  // An Autopilot change is a change to the permissions policy: each playbook's action goes to auto, or back to ask.
  if (patch.autopilot !== undefined) {
    const want = new Set(patch.autopilot.filter(k => KINDS[k]).map(k => autonomy.PLAYBOOK_ACTION[k]));
    const next = autonomy.normalizePolicy(cur.policy);
    for (const key of autonomy.ACTION_KEYS) {
      const spec = autonomy.ACTIONS[key];
      if (!spec.playbooks.length) continue;
      if (want.has(key)) next.actions[key].mode = 'auto';
      else if (next.actions[key].mode === 'auto') next.actions[key].mode = 'ask';
    }
    cur.policy = await autonomy.savePolicy(db, userId, next, { markConfigured: false });
  }
  const next = {
    dailyBriefing: patch.dailyBriefing !== undefined ? !!patch.dailyBriefing : cur.dailyBriefing,
    reviewUrl: patch.reviewUrl !== undefined ? String(patch.reviewUrl || '').trim().slice(0, 500) : cur.reviewUrl,
    alertsEnabled: patch.alertsEnabled !== undefined ? !!patch.alertsEnabled : cur.alertsEnabled,
  };
  await db.query(
    `INSERT INTO agent_prefs (user_id, daily_briefing, review_url, alerts_enabled) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET daily_briefing=EXCLUDED.daily_briefing,
       review_url=EXCLUDED.review_url, alerts_enabled=EXCLUDED.alerts_enabled, updated_at=NOW()`,
    [userId, next.dailyBriefing, next.reviewUrl || null, next.alertsEnabled]);
  const policy = cur.policy;
  return { ...cur, ...next, policy, autopilot: KIND_KEYS.filter(k => policy.actions[autonomy.PLAYBOOK_ACTION[k]].mode === 'auto') };
}

function autopilotEligibility(user, settings) {
  const { getPlan } = require('../../config/plans');
  const plan = getPlan((user && user.plan) || 'free');
  if (!plan.autonomousMode) return { ok: false, reason: 'plan', message: 'Autopilot needs the Growth plan or above.' };
  if (false) return { ok: false, reason: 'mode', message: 'Autopilot only runs while the Agent is in autonomous mode.' };
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// Detection
// ══════════════════════════════════════════════════════════════
function reachable(row, conn) {
  // Proposals are follow-ups and win-backs, which go by email only. WhatsApp is never used to start or restart a conversation.
  return !!(row.from_email && conn.email.connected);
}

/**
 * Pure: given lead rows and the clock, return { kind: [{row, ...}] }. Exported for tests.
 * `opts` carries the owner's timing (services/agent/autonomy.js); the defaults are the original fixed values.
 *   quoteAfterDays / coldAfterDays   how long a quote / an enquiry must be quiet before it is chased
 *   discount                         { enabled, afterDays, minQuoteValue } when the owner allows discount offers
 *   nudgeFirst                       true when a plain follow-up goes before any discount (the follow-up playbook is on)
 */
function detect(rows, now, opts = {}) {
  const day = 86400000;
  const quoteAfter = opts.quoteAfterDays || 3, coldAfter = opts.coldAfterDays || 7;
  const disc = opts.discount && opts.discount.enabled ? opts.discount : null;
  const age = d => (d ? (now - new Date(d).getTime()) / day : Infinity);
  const out = { quote_followup: [], go_cold: [], review_request: [], winback: [], discount_offer: [] };
  for (const r of rows) {
    const tags = asTags(r.tags);
    if (tags.includes(DNC) || r.pending_approval || r.needs_human_review) continue;
    const lastTouch = Math.min(age(r.last_customer_message_at), age(r.sent_at), age(r.updated_at));
    const quiet = Math.min(age(r.last_customer_message_at), age(r.updated_at));
    const quote = parseJ(r.quote);
    const hasQuote = !!(quote && typeof quote === 'object' && num(quote.total) > 0);
    const won = !!r.won_at || (r.status === 'closed' && num(r.deal_value) > 0);

    if (won) {
      const wonAge = age(r.won_at || r.updated_at);
      if (wonAge >= 2 && wonAge <= 14 && !tags.includes(KINDS.review_request.tag)) out.review_request.push({ row: r, value: num(r.deal_value) });
      else if (wonAge >= 60 && wonAge <= 540 && quiet >= 45 && !tags.includes(KINDS.winback.tag)) out.winback.push({ row: r, value: num(r.deal_value) });
      continue;
    }
    if (r.status === 'closed') continue;               // lost / finished, not won
    if (!r.sent_at) continue;                           // we never replied; that's the reply engine's job
    // A customer is offered a discount once, and only after the owner's number of quiet days. When plain follow-ups are on,
    // the follow-up goes first and the discount is the second attempt.
    const offered = !!(r.offer && typeof parseJ(r.offer) === 'object' && parseJ(r.offer) && parseJ(r.offer).percent);
    if (disc && hasQuote && !offered && quiet >= disc.afterDays && quiet <= 45 && num(quote.total) >= (disc.minQuoteValue || 0)
        && !tags.includes(KINDS.discount_offer.tag) && (!opts.nudgeFirst || tags.includes(KINDS.quote_followup.tag))) {
      out.discount_offer.push({ row: r, value: num(quote.total), quiet });
      continue;
    }
    if (hasQuote && lastTouch >= quoteAfter && quiet >= quoteAfter && quiet <= 30 && !tags.includes(KINDS.quote_followup.tag)) {
      out.quote_followup.push({ row: r, value: num(quote.total), quiet });
    } else if (!hasQuote && quiet >= coldAfter && quiet <= 60 && !tags.includes(KINDS.go_cold.tag)) {
      out.go_cold.push({ row: r, value: 0, quiet });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// Drafting
// ══════════════════════════════════════════════════════════════
function sanitizeTemplate(text, kind) {
  let t = String(text || '').trim().replace(/^["“]|["”]$/g, '').slice(0, 900);
  if (!t) return null;
  // Only merge fields the engine knows; anything else would be sent blank.
  let bad = false;
  t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => { if (!ALLOWED_FIELDS.has(k) && k !== 'reviewLink') bad = true; return m; });
  if (bad) return null;
  // A playbook that carries a number (the discount) must take it from the merge field, never from the model's own words.
  for (const f of ((KINDS[kind] && KINDS[kind].required) || [])) if (!new RegExp('\\{\\{\\s*' + f + '\\s*\\}\\}').test(t)) return null;
  if (!/\{\{\s*customerName\s*\}\}/.test(t)) t = 'Hi {{customerName}}, ' + t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}

async function draftTemplate(kind, settings, prefs, { ai = true } = {}) {
  const def = KINDS[kind];
  const link = prefs && prefs.reviewUrl;
  const finish = (t, by) => {
    let out = t;
    if (kind === 'review_request') {
      out = link ? (/\{\{\s*reviewLink\s*\}\}/.test(out) ? out : `${out} ${link}`).replace(/\{\{\s*reviewLink\s*\}\}/g, link)
                 : out.replace(/\s*\{\{\s*reviewLink\s*\}\}/g, '');
    }
    return { text: out, by };
  };
  const base = kind === 'review_request' && link ? `${def.fallback} ${link}` : def.fallback;
  const claude = ai ? getClaude() : null;
  if (!claude) return finish(base, 'template');
  try {
    const prompt = `Write ONE short message (max 60 words) from a small business owner to a customer.\n` +
      `Goal: ${def.goal}\n` +
      `Business: ${settings.businessName || 'the business'} (${settings.businessType || 'local service business'}). ${String(settings.description || '').slice(0, 300)}\n` +
      `Tone: ${settings.tone || settings.replyTone || 'friendly, professional, human'}. Plain text, no emojis unless natural, no subject line, no sign-off block.\n` +
      `Use these merge fields exactly where they fit: {{customerName}} (required, greeting), {{serviceType}}, {{businessName}}, {{ownerName}}${kind === 'review_request' && link ? ', {{reviewLink}} (once)' : ''}${kind === 'discount_offer' ? ', {{discountPercent}} (required), {{discountedTotal}}, {{discountExpiry}}' : ''}. Invent no other fields, prices, dates or promises.\n` +
      `Return only the message text.`;
    const res = await claude.messages.create({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const text = res.content && res.content[0] && res.content[0].text;
    const clean = sanitizeTemplate(text, kind);
    return clean ? finish(clean, 'ai') : finish(base, 'template');
  } catch (e) {
    console.error('[proactive] draft failed:', e.message);
    return finish(base, 'template');
  }
}

// ══════════════════════════════════════════════════════════════
// Learning + proof: what the owner does with proposals, and what it earned
// ══════════════════════════════════════════════════════════════

/** Per-playbook approvals and dismissals over the last SUPPRESS_WINDOW_DAYS. */
async function playbookStats(db, userId) {
  const rows = await db.queryAll(
    `SELECT kind, status, COUNT(*)::int AS n FROM agent_proposals
      WHERE user_id=$1 AND status IN ('approved','auto_sent','dismissed')
        AND decided_at > NOW() - ($2 || ' days')::interval GROUP BY kind, status`,
    [userId, String(SUPPRESS_WINDOW_DAYS)]).catch(() => []);
  const out = {}; KIND_KEYS.forEach(k => { out[k] = { approved: 0, dismissed: 0 }; });
  for (const r of rows || []) {
    if (!out[r.kind]) continue;
    if (r.status === 'dismissed') out[r.kind].dismissed += num(r.n); else out[r.kind].approved += num(r.n);
  }
  return out;
}

/** Pure. A playbook the owner keeps dismissing and never approves stops being proposed. */
function suppressedKinds(stats) {
  return KIND_KEYS.filter(k => stats[k] && stats[k].approved === 0 && stats[k].dismissed >= SUPPRESS_AFTER_DISMISSALS);
}

/** Pure. Playbooks the owner keeps approving unedited-by-dismissal: worth offering Autopilot for. */
function autopilotSuggestions(stats, autopilot) {
  return KIND_KEYS.filter(k => stats[k] && stats[k].approved >= SUGGEST_AUTOPILOT_AFTER && stats[k].dismissed === 0 && !(autopilot || []).includes(k));
}

/**
 * Jobs won after the Agent followed up: leads in an approved/auto-sent
 * proposal that were marked won AFTER that proposal went out. This is "won
 * after our follow-up", not proof of cause, and the copy says so.
 */
async function recoveredRevenue(db, userId, days = 30) {
  // Won after the Agent reached out: an approved or automatic follow-up proposal that included the lead, or anything the
  // Agent logged as sent to it (a missed-call text-back, a discount) in the 60 days before the win.
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(v),0)::float AS value FROM (
       SELECT l.id, MAX(l.deal_value) AS v FROM leads l
        WHERE l.user_id=$1 AND l.won_at IS NOT NULL AND l.won_at > NOW() - ($2 || ' days')::interval
          AND ( EXISTS (SELECT 1 FROM agent_proposals p WHERE p.user_id = l.user_id AND p.status IN ('approved','auto_sent')
                         AND p.decided_at > NOW() - ($2 || ' days')::interval AND p.lead_ids @> to_jsonb(l.id::text) AND l.won_at > p.decided_at)
             OR EXISTS (SELECT 1 FROM agent_actions a WHERE a.lead_id = l.id AND a.status = 'sent'
                         AND a.done_at < l.won_at AND a.done_at > l.won_at - INTERVAL '60 days') )
        GROUP BY l.id) t`, [userId, String(days)]).catch(() => null);
  return { count: num(row && row.n), value: Math.round(num(row && row.value)), days };
}

// ══════════════════════════════════════════════════════════════
// Owner alerts: speed matters more than any follow-up
// ══════════════════════════════════════════════════════════════

/**
 * Pure. Customers whose last message is unanswered. Three causes, because the
 * owner's action differs:
 *   stuckApprovals – a drafted reply is waiting for the owner's OK
 *   needsYou       – the Agent handed the conversation to the owner
 *   unanswered     – nothing was sent and nothing is pending (engine lag or failure)
 */
function detectAlerts(rows, now) {
  const hour = 3600000;
  const out = { stuckApprovals: [], needsYou: [], unanswered: [] };
  for (const r of rows || []) {
    if (asTags(r.tags).includes(DNC) || r.status === 'closed') continue;
    const last = r.last_customer_message_at ? new Date(r.last_customer_message_at).getTime() : NaN;
    if (!Number.isFinite(last)) continue;
    const waitH = (now - last) / hour;
    if (waitH < ALERT_WAIT_HOURS || waitH > ALERT_MAX_AGE_DAYS * 24) continue;
    if (r.sent_at && new Date(r.sent_at).getTime() >= last) continue;          // we answered after their last message
    const human = r.human_reply != null && String(r.human_reply) !== 'null' && String(r.human_reply) !== '';
    const quote = parseJ(r.quote);
    const item = { row: r, waitH, value: quote && typeof quote === 'object' ? num(quote.total) : 0 };
    if (r.pending_approval) out.stuckApprovals.push(item);
    else if (r.needs_human_review) { if (!human) out.needsYou.push(item); }
    else if (!human) out.unanswered.push(item);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.waitH - a.waitH);
  return out;
}

const alertTotal = f => f.stuckApprovals.length + f.needsYou.length + f.unanswered.length;

function loadAlertRows(db, userId) {
  return db.queryAll(
    `SELECT id, customer_name, from_name, from_email, from_phone, status, quote, sent_at, last_customer_message_at,
            tags, pending_approval, needs_human_review, human_reply
       FROM leads WHERE user_id=$1 AND source <> 'test' AND status <> 'closed'
        AND last_customer_message_at < NOW() - INTERVAL '${ALERT_WAIT_HOURS} hours'
        AND last_customer_message_at > NOW() - INTERVAL '${ALERT_MAX_AGE_DAYS} days'
        AND (sent_at IS NULL OR sent_at < last_customer_message_at)
      ORDER BY last_customer_message_at ASC LIMIT 100`, [userId]).catch(() => []);
}

/** Light summary for the chat Agent to lead with. */
async function alertSummary(db, userId) {
  const f = detectAlerts(await loadAlertRows(db, userId), Date.now());
  const all = [...f.stuckApprovals, ...f.needsYou, ...f.unanswered];
  return { total: all.length, stuckApprovals: f.stuckApprovals.length, needsYou: f.needsYou.length, unanswered: f.unanswered.length,
    oldestHours: all.length ? Math.round(Math.max(...all.map(i => i.waitH))) : 0 };
}

async function sendOwnerAlerts(db, users) {
  const { sendMail } = require('../mailer');
  const { ownerAlert } = require('../../lib/email-templates');
  const leadsApi = require('../../routes/leads');
  let sent = 0;
  for (const user of users) {
    try {
      if (!user.email) continue;
      const prefs = await getPrefs(db, user.id);
      if (!prefs.alertsEnabled) continue;
      const settings = await leadsApi.getSettings(user.id, db).catch(() => ({}));
      const lp = localParts(settings.timezone);
      if (lp.hour < ALERT_FIRST_HOUR || lp.hour > ALERT_LAST_HOUR) continue;
      const found = detectAlerts(await loadAlertRows(db, user.id), Date.now());
      if (!alertTotal(found)) continue;
      const ids = [...found.stuckApprovals, ...found.needsYou, ...found.unanswered].map(i => i.row.id).sort();
      const sig = crypto.createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 16);
      // Atomic: gap since last alert, daily cap, and "something new since last time", all enforced in one statement.
      const claim = await db.query(
        `INSERT INTO agent_prefs (user_id, last_alert_at, last_alert_sig, alert_day, alerts_today) VALUES ($1, NOW(), $2, $3, 1)
         ON CONFLICT (user_id) DO UPDATE SET last_alert_at = NOW(), last_alert_sig = EXCLUDED.last_alert_sig,
           alerts_today = CASE WHEN agent_prefs.alert_day = EXCLUDED.alert_day THEN agent_prefs.alerts_today + 1 ELSE 1 END,
           alert_day = EXCLUDED.alert_day
         WHERE (agent_prefs.last_alert_at IS NULL OR agent_prefs.last_alert_at < NOW() - INTERVAL '${ALERT_MIN_GAP_H} hours')
           AND agent_prefs.last_alert_sig IS DISTINCT FROM EXCLUDED.last_alert_sig
           AND (agent_prefs.alert_day IS DISTINCT FROM EXCLUDED.alert_day OR agent_prefs.alerts_today < ${ALERT_DAILY_CAP})`,
        [user.id, sig, lp.date]);
      if (!claim || claim.rowCount === 0) continue;
      const names = [...found.needsYou, ...found.stuckApprovals, ...found.unanswered].slice(0, 3).map(i => leadName(i.row));
      // The button opens the page where this is actually fixed: Human Review for conversations handed to the owner, the Consent
      // Queue for drafted replies waiting for an OK, otherwise the lead list. A single waiting customer opens that conversation.
      const everyone = [...found.needsYou, ...found.stuckApprovals, ...found.unanswered];
      const view = found.needsYou.length ? 'humanreview' : found.stuckApprovals.length ? 'consent' : 'leads';
      const first = (found.needsYou[0] || found.stuckApprovals[0] || found.unanswered[0]).row;
      const link = everyone.length === 1
        ? { href: dashboardUrl(apiBase(), { view, lead: first.id }), label: 'Open and reply' }
        : { href: dashboardUrl(apiBase(), { view }), label: view === 'humanreview' ? 'Open Human Review' : view === 'consent' ? 'Review the drafts' : 'Open my leads' };
      const mail = ownerAlert({
        link,
        name: String(user.name || '').split(/\s+/)[0] || 'there', business: settings.businessName || '',
        counts: { stuckApprovals: found.stuckApprovals.length, needsYou: found.needsYou.length, unanswered: found.unanswered.length },
        oldestHours: Math.round(Math.max(...[...found.stuckApprovals, ...found.needsYou, ...found.unanswered].map(i => i.waitH))),
        names, appUrl: apiBase(),
      });
      if (await sendMail({ to: user.email, subject: mail.subject, html: mail.html })) sent++;
      else await db.query(`UPDATE agent_prefs SET last_alert_at=NULL, last_alert_sig=NULL, alerts_today=GREATEST(alerts_today-1,0) WHERE user_id=$1`, [user.id]).catch(() => {});
    } catch (e) { console.error('[proactive] alert failed for', user.id, e.message); }
  }
  return sent;
}

// ══════════════════════════════════════════════════════════════
// Scan
// ══════════════════════════════════════════════════════════════
async function loadCandidateRows(db, userId) {
  return db.queryAll(
    `SELECT id, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, status, service_type,
            quote, sent_at, last_customer_message_at, updated_at, created_at, won_at, deal_value, tags,
            pending_approval, needs_human_review, offer
       FROM leads WHERE user_id=$1 AND source <> 'test' ORDER BY updated_at DESC LIMIT 3000`, [userId]);
}

function leadName(r) { return r.customer_name || r.from_name || r.from_email || r.from_phone || 'a lead'; }

function rationale(kind, n, value, cur) {
  const money = value > 0 ? ` worth about ${cur || ''}${Math.round(value).toLocaleString('en-US')}`.replace('  ', ' ') : '';
  switch (kind) {
    case 'quote_followup': return `${n} customer${n === 1 ? ' has' : 's have'} had a quote and gone quiet${money}. A quick check-in usually wins these back.`;
    case 'go_cold': return `${n} enquir${n === 1 ? 'y' : 'ies'} went quiet after our first reply. A light nudge often restarts the conversation.`;
    case 'review_request': return `${n} job${n === 1 ? ' was' : 's were'} completed recently${money}. The best time to ask for a review is right now.`;
    case 'winback': return `${n} past customer${n === 1 ? '' : 's'}${money} ${n === 1 ? 'has' : 'have'} not been in touch for a while. A friendly check-in brings repeat work.`;
    case 'discount_offer': return `${n} quote${n === 1 ? ' has' : 's have'} had no answer${money}. A limited-time discount, within the limit you set, can tip them into saying yes.`;
  }
  return '';
}

/**
 * Scan one business and create/refresh pending opportunities.
 * Returns { created, refreshed, auto }.
 *
 * The owner's permissions (services/agent/autonomy.js) decide what happens to each playbook:
 *   off   nothing is proposed (and an open proposal is withdrawn)
 *   ask   an opportunity waits for the owner's approval
 *   auto  the opportunity is executed straight away, but only for the customers the owner's limits allow right now
 *         (quiet hours, messages per day, contacts per customer, the plan's Autopilot cap, the discount budget)
 */
async function scanUser(db, user, { ai = true } = {}) {
  const { connections } = internal();
  const leadsApi = require('../../routes/leads');
  const settings = await leadsApi.getSettings(user.id, db).catch(() => ({}));
  const conn = connections(user);
  const result = { created: 0, refreshed: 0, auto: 0 };
  if (!conn.email.connected) return result;

  const prefs = await getPrefs(db, user.id);
  const policy = prefs.policy;
  const modeOf = kind => autonomy.playbookMode(policy, kind, user);
  const chosenOff = kind => policy.actions[autonomy.PLAYBOOK_ACTION[kind]].mode === 'off';
  const rows = (await loadCandidateRows(db, user.id)).filter(r => reachable(r, conn));
  if (!rows.length) return result;
  const re = policy.actions.reengage, dc = policy.actions.discount;
  const found = detect(rows, Date.now(), {
    quoteAfterDays: re.quoteAfterDays, coldAfterDays: re.coldAfterDays,
    discount: { enabled: dc.mode !== 'off', afterDays: dc.afterDays, minQuoteValue: dc.minQuoteValue },
    nudgeFirst: re.mode !== 'off',
  });

  // A discount is only worth proposing when the rules allow one for that quote (minimum value, ceiling, the service's minimum charge).
  if (found.discount_offer.length) {
    found.discount_offer = found.discount_offer.filter(it => {
      const q = parseJ(it.row.quote);
      return !!autonomy.computeOffer(dc, q, serviceFor(settings, q), settings);
    });
  }

  // Cooldown: leads already proposed for this playbook recently.
  const recent = await db.queryAll(
    `SELECT kind, lead_ids FROM agent_proposals WHERE user_id=$1 AND created_at > NOW() - ($2 || ' days')::interval AND status <> 'pending'`,
    [user.id, String(COOLDOWN_DAYS)]).catch(() => []);
  const cooled = {}; KIND_KEYS.forEach(k => { cooled[k] = new Set(); });
  for (const p of recent) for (const id of (parseJ(p.lead_ids) || [])) if (cooled[p.kind]) cooled[p.kind].add(id);

  const pending = await db.queryAll(`SELECT * FROM agent_proposals WHERE user_id=$1 AND status='pending'`, [user.id]).catch(() => []);
  const muted = new Set(suppressedKinds(await playbookStats(db, user.id)));   // owner keeps dismissing these
  const cur = settings.currency && settings.currency !== 'USD' ? settings.currency + ' ' : (settings.currency === 'USD' ? '$' : '');

  for (const kind of KIND_KEYS) {
    const existing = pending.find(p => p.kind === kind);
    // The owner switched this action off: propose nothing, and withdraw what was waiting.
    const items = (chosenOff(kind) || muted.has(kind)) ? [] : found[kind].filter(it => !cooled[kind].has(it.row.id))
      .sort((a, b) => (b.value - a.value) || ((a.quiet || 0) - (b.quiet || 0))).slice(0, MAX_LEADS_PER_PROP);
    if (!items.length) {
      if (existing) await db.query(`UPDATE agent_proposals SET status='expired', decided_at=NOW() WHERE id=$1`, [existing.id]).catch(() => {});
      continue;
    }
    const ids = items.map(it => it.row.id);
    const value = items.reduce((s, it) => s + it.value, 0);
    const sample = items.slice(0, 3).map(it => leadName(it.row));
    const why = rationale(kind, items.length, value, cur);

    let proposal;
    if (existing) {
      const upgrade = ai && existing.drafted_by === 'template' && !existing.edited;
      const d = upgrade ? await draftTemplate(kind, settings, prefs, { ai }) : null;
      await db.query(
        `UPDATE agent_proposals SET lead_ids=$1::jsonb, sample_names=$2::jsonb, est_value=$3, rationale=$4,
                draft = COALESCE($5, draft), drafted_by = COALESCE($6, drafted_by), updated_at=NOW() WHERE id=$7`,
        [JSON.stringify(ids), JSON.stringify(sample), value, why, d && d.text, d && d.by, existing.id]);
      proposal = { ...existing, id: existing.id, kind, lead_ids: ids, draft: (d && d.text) || existing.draft };
      result.refreshed++;
    } else {
      const d = await draftTemplate(kind, settings, prefs, { ai });
      const id = genId();
      await db.query(
        `INSERT INTO agent_proposals (id, user_id, kind, title, rationale, lead_ids, sample_names, est_value, draft, drafted_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
        [id, user.id, kind, KINDS[kind].label, why, JSON.stringify(ids), JSON.stringify(sample), value, d.text, d.by]);
      proposal = { id, user_id: user.id, kind, lead_ids: ids, draft: d.text };
      result.created++;
    }

    // Automatic: the owner let this action run on its own, and the plan allows it.
    if (modeOf(kind) === 'auto') {
      const used = await db.queryOne(
        `SELECT COALESCE(SUM(jsonb_array_length(lead_ids)),0)::int AS n FROM agent_proposals
          WHERE user_id=$1 AND kind=$2 AND status='auto_sent' AND decided_at > NOW() - INTERVAL '24 hours'`, [user.id, kind]).catch(() => ({ n: 0 }));
      const cap = require('../../config/plans').getPlan(user.plan || 'free').autopilotDailyCap || AUTOPILOT_DAILY_CAP;
      const room = cap - ((used && used.n) || 0);
      if (room > 0) {
        // The owner's own limits, on top of the plan's: quiet hours, messages today, contacts per customer.
        const admitted = await autonomy.admitLeads(db, { user, policy, settings, leadIds: ids.slice(0, room) });
        if (admitted.ids.length) {
          const r = await executeProposal(db, user, { ...proposal, lead_ids: admitted.ids }, { auto: true });
          if (r.ok) result.auto++;
        } else if (admitted.blocked) {
          console.log(`[proactive] ${user.id} ${kind} held: ${admitted.blocked}`);
        }
      }
    }
  }
  return result;
}

/** The service a quote was written for (its minimum charge is the floor for any discount). */
function serviceFor(settings, quote) {
  const name = String((quote && quote.serviceMatched) || '').toLowerCase();
  if (!name) return null;
  return (settings.services || []).find(sv => sv && String(sv.name || '').toLowerCase() === name) || null;
}

// ══════════════════════════════════════════════════════════════
// Execute / dismiss
// ══════════════════════════════════════════════════════════════
function internal() {
  // Lazy: agent-routes requires this file's helpers at request time.
  return require('../../routes/agent')._internal;
}

async function getProposal(db, userId, id) {
  return db.queryOne('SELECT * FROM agent_proposals WHERE id=$1 AND user_id=$2', [String(id), userId]).catch(() => null);
}

/**
 * Give each of these leads the discount the owner allows, and remember it on the lead so the reply engine honours exactly
 * that offer. A customer is offered a discount once, ever. When `enforceBudget` is set (the Agent acting on its own) the
 * owner's monthly discount budget is a hard stop. Returns { ids, offers: {leadId: offer}, stamp }.
 */
async function prepareOffers(db, user, settings, policy, leadIds, { enforceBudget }) {
  const cfg = policy.actions.discount;
  const rows = await db.queryAll(`SELECT id, quote, offer FROM leads WHERE user_id=$1 AND id = ANY($2::text[])`, [user.id, leadIds]);
  const byId = new Map(rows.map(r => [r.id, r]));
  let budgetLeft = Infinity;
  if (enforceBudget && cfg.monthlyBudget > 0) budgetLeft = cfg.monthlyBudget - await autonomy.discountOfferedThisMonth(db, user.id);
  const now = new Date(), offers = {}, ids = [];
  for (const id of leadIds) {                                    // already ordered biggest quote first
    const r = byId.get(id); if (!r) continue;
    const prior = parseJ(r.offer);
    if (prior && prior.percent) continue;                         // once per customer
    const q = parseJ(r.quote);
    const offer = autonomy.computeOffer(cfg, q, serviceFor(settings, q), settings, now);
    if (!offer) continue;
    if (offer.amount > budgetLeft) continue;                      // would pass the owner's monthly budget; a smaller quote may still fit
    const set = await db.query(`UPDATE leads SET offer=$1::jsonb, updated_at=NOW() WHERE id=$2 AND user_id=$3 AND offer IS NULL`, [JSON.stringify(offer), id, user.id]);
    if (set && set.rowCount === 0) continue;
    if (budgetLeft !== Infinity) budgetLeft -= offer.amount;
    offers[id] = offer; ids.push(id);
  }
  return { ids, offers, stamp: now.toISOString() };
}

/** Undo prepareOffers for leads whose campaign never started, so no customer holds an offer they were never sent. */
async function withdrawOffers(db, userId, prep) {
  if (!prep || !prep.ids.length) return;
  await db.query(`UPDATE leads SET offer=NULL, updated_at=NOW() WHERE user_id=$1 AND id = ANY($2::text[]) AND offer->>'offeredAt' = $3`, [userId, prep.ids, prep.stamp]).catch(() => {});
}

/**
 * Turn an opportunity into a real campaign and launch it. `message` is the
 * owner's edit of the draft (optional). Returns { ok, ... } with a plain message.
 */
async function executeProposal(db, user, proposal, { message = null, auto = false } = {}) {
  const { HANDLERS, launchCampaign, makeCtx } = internal();
  const leadsApi = require('../../routes/leads');
  const kind = proposal.kind;
  const def = KINDS[kind];
  if (!def) return { ok: false, message: 'Unknown playbook.' };

  // Atomic claim so a double-click or two instances cannot send twice.
  const claim = await db.query(
    `UPDATE agent_proposals SET status=$1, decided_at=NOW() WHERE id=$2 AND user_id=$3 AND status='pending'`,
    [auto ? 'auto_sent' : 'approved', proposal.id, user.id]);
  if (claim && claim.rowCount === 0) return { ok: false, message: 'That opportunity was already handled.' };

  let prep = null;
  const release = async (why) => {
    await withdrawOffers(db, user.id, prep);
    await db.query(`UPDATE agent_proposals SET status='pending', decided_at=NULL WHERE id=$1 AND user_id=$2`, [proposal.id, user.id]).catch(() => {});
    return why;
  };

  try {
    const settings = await leadsApi.getSettings(user.id, db).catch(() => ({}));
    const ctx = makeCtx(db, user, settings);
    const text = String(message || proposal.draft || def.fallback).slice(0, 900);
    let ids = (Array.isArray(proposal.lead_ids) ? proposal.lead_ids : parseJ(proposal.lead_ids)) || [];

    // A discount playbook: fix the offer for each customer first (the message's {{discountPercent}} etc. read it back).
    if (kind === 'discount_offer') {
      const policy = await autonomy.getPolicy(db, user.id);
      prep = await prepareOffers(db, user, settings, policy, ids, { enforceBudget: auto });
      ids = prep.ids;
      if (!ids.length) return await release({ ok: false, message: 'None of these quotes can be given a discount within your rules (minimum quote, budget, or the service\'s minimum price).' });
    }

    const label = `${def.label} (${ids.length})`;
    const r = await HANDLERS.run_campaign(ctx, {
      name: def.label.slice(0, 100), description: `Agent opportunity: ${def.label}.`,
      audience: { leadIds: ids, label, channel: 'email' },
      steps: [{ type: 'send_message', message: text, written_by: 'agent' }],
    });
    if (!r || !r.ok) return await release({ ok: false, locked: !!(r && r.locked), requiresPlan: r && r.requiresPlan, message: (r && (r.message || r.error)) || 'Could not start this.' });

    let recipients = r.recipients, status = r.status;
    if (r.status === 'draft') {
      const launched = await launchCampaign(ctx, r.id, { message: text });
      if (!launched.ok) return await release({ ok: false, message: launched.message || 'Could not launch.' });
      recipients = launched.recipients; status = 'running';
    }
    await db.query(`UPDATE agent_proposals SET result=$1::jsonb, edited=$2, draft=$3, lead_ids=$4::jsonb, updated_at=NOW() WHERE id=$5 AND user_id=$6`,
      [JSON.stringify({ campaignId: r.id, taskId: r.taskId, recipients, status }), !!message, text, JSON.stringify(ids), proposal.id, user.id]).catch(() => {});
    // Remember who was contacted so detectors don't pick them up again.
    const tags = [def.tag];
    await db.query(
      `UPDATE leads SET tags = (COALESCE(tags,'[]'::jsonb) || $1::jsonb), updated_at=NOW()
        WHERE user_id=$2 AND id = ANY($3::text[]) AND NOT (COALESCE(tags,'[]'::jsonb) @> $1::jsonb)`,
      [JSON.stringify(tags), user.id, ids]).catch(() => {});
    // The activity log: one line per customer, so the owner can see what the Agent did and the limits can be counted.
    for (const id of ids) {
      const o = prep && prep.offers[id];
      await autonomy.logAction(db, {
        userId: user.id, leadId: id, kind: autonomy.PLAYBOOK_ACTION[kind], channel: 'email', status: 'sent',
        detail: { via: 'campaign', playbook: kind, proposalId: proposal.id, campaignId: r.id, auto: !!auto, message: text.slice(0, 600),
                  ...(o ? { percent: o.percent, amount: o.amount, discountedTotal: o.discountedTotal, expiresAt: o.expiresAt } : {}) },
      }).catch(e => console.warn('[proactive] activity log failed:', e.message));
    }
    return { ok: true, recipients, message: `${recipients} message${recipients === 1 ? '' : 's'} on the way.` };
  } catch (e) {
    console.error('[proactive] execute failed:', e.message);
    return await release({ ok: false, message: 'Something went wrong starting that. Nothing was sent.' });
  }
}

async function dismissProposal(db, userId, id) {
  const r = await db.query(`UPDATE agent_proposals SET status='dismissed', decided_at=NOW() WHERE id=$1 AND user_id=$2 AND status='pending'`, [String(id), userId]);
  return !!(r && r.rowCount);
}

function publicProposal(p) {
  return {
    id: p.id, kind: p.kind, title: p.title, rationale: p.rationale,
    count: (parseJ(p.lead_ids) || []).length, sample: parseJ(p.sample_names) || [],
    estValue: Math.round(num(p.est_value)), draft: p.draft, status: p.status,
    createdAt: p.created_at, result: parseJ(p.result) || null,
  };
}

async function listOpportunities(db, userId, { includeRecent = true } = {}) {
  const pending = await db.queryAll(`SELECT * FROM agent_proposals WHERE user_id=$1 AND status='pending' ORDER BY est_value DESC, created_at DESC LIMIT 10`, [userId]).catch(() => []);
  let recent = [];
  if (includeRecent) recent = await db.queryAll(
    `SELECT * FROM agent_proposals WHERE user_id=$1 AND status IN ('approved','auto_sent') AND decided_at > NOW() - INTERVAL '7 days' ORDER BY decided_at DESC LIMIT 5`, [userId]).catch(() => []);
  const out = { pending: pending.map(publicProposal), recent: recent.map(publicProposal) };
  if (includeRecent) {
    const [recovered, stats, prefs] = await Promise.all([recoveredRevenue(db, userId), playbookStats(db, userId), getPrefs(db, userId)]);
    out.recovered = recovered;
    out.suggestAutopilot = autopilotSuggestions(stats, prefs.autopilot);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// Morning briefing
// ══════════════════════════════════════════════════════════════
function localParts(tz, date = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(date).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: (+p.hour) % 24 };
  } catch (_) { return localParts('UTC', date); }
}

async function gatherBriefing(db, user) {
  const q = async (sql) => (await db.queryOne(sql, [user.id]).catch(() => null)) || {};
  const newLeads = await q(`SELECT COUNT(*)::int AS n FROM leads WHERE user_id=$1 AND source<>'test' AND created_at > NOW() - INTERVAL '24 hours'`);
  const replied  = await q(`SELECT COUNT(*)::int AS n FROM leads WHERE user_id=$1 AND source<>'test' AND sent_at > NOW() - INTERVAL '24 hours'`);
  const won      = await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(deal_value),0)::float AS v FROM leads WHERE user_id=$1 AND won_at > NOW() - INTERVAL '24 hours'`);
  const waiting  = await q(`SELECT COUNT(*) FILTER (WHERE pending_approval=true)::int AS approvals,
                                    COUNT(*) FILTER (WHERE pending_approval IS NOT TRUE AND needs_human_review=true AND (human_reply IS NULL OR human_reply::text='null'))::int AS human
                               FROM leads WHERE user_id=$1 AND source<>'test' AND status<>'closed'`);
  const opp = await listOpportunities(db, user.id, { includeRecent: false });
  const recovered = await recoveredRevenue(db, user.id);
  // Everything the Agent did on its own in the last 24 hours, by kind (services/agent/autonomy.js).
  const didRows = await db.queryAll(
    `SELECT kind, COUNT(*) FILTER (WHERE status='sent')::int AS sent, COUNT(*) FILTER (WHERE status IN ('skipped','failed'))::int AS held
       FROM agent_actions WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours' GROUP BY kind`, [user.id]).catch(() => []);
  const agentDid = { total: 0, held: 0 };
  for (const r of didRows || []) { agentDid[r.kind] = r.sent; agentDid.total += r.sent; agentDid.held += r.held; }
  return { agentDid, recovered, newLeads: newLeads.n || 0, replied: replied.n || 0, won: won.n || 0, wonValue: won.v || 0, waitingApprovals: waiting.approvals || 0, waitingHuman: waiting.human || 0,
    waiting: (waiting.approvals || 0) + (waiting.human || 0), opportunities: opp.pending };
}

async function sendDueBriefings(db, users) {
  const { sendMail } = require('../mailer');
  const { dailyBriefing } = require('../../lib/email-templates');
  const leadsApi = require('../../routes/leads');
  let sent = 0;
  for (const user of users) {
    try {
      if (!user.email) continue;
      const prefs = await getPrefs(db, user.id);
      if (!prefs.dailyBriefing) continue;
      const settings = await leadsApi.getSettings(user.id, db).catch(() => ({}));
      const lp = localParts(settings.timezone);
      if (lp.hour < BRIEFING_HOUR || lp.hour > BRIEFING_LAST_HOUR) continue;
      const claim = await db.query(
        `INSERT INTO agent_prefs (user_id, last_brief_date) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET last_brief_date=EXCLUDED.last_brief_date
           WHERE agent_prefs.last_brief_date IS DISTINCT FROM EXCLUDED.last_brief_date`, [user.id, lp.date]);
      if (!claim || claim.rowCount === 0) continue;
      const data = await gatherBriefing(db, user);
      const quiet = !data.newLeads && !data.won && !data.waiting && !data.opportunities.length && !data.agentDid.total;
      if (quiet) continue;                                   // never send an empty "nothing happened" email
      // The main button goes to whatever needs the owner most, and a second link covers the next thing:
      // conversations handed over -> drafted replies waiting -> follow-ups ready to approve -> the lead list.
      const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
      const targets = [];
      if (data.waitingHuman)     targets.push({ href: dashboardUrl(apiBase(), { view: 'humanreview' }), label: 'Answer ' + plural(data.waitingHuman, 'customer', 'customers') });
      if (data.waitingApprovals) targets.push({ href: dashboardUrl(apiBase(), { view: 'consent' }), label: 'Approve ' + plural(data.waitingApprovals, 'drafted reply', 'drafted replies') });
      if (data.opportunities.length) targets.push({ href: dashboardUrl(apiBase(), { ask: 'opportunities' }), label: 'Review &amp; approve' });
      if (!targets.length) targets.push({ href: dashboardUrl(apiBase(), { view: 'leads' }), label: 'Open my leads' });
      const mail = dailyBriefing({
        name: String(user.name || '').split(/\s+/)[0] || 'there', business: settings.businessName || '',
        data, currency: settings.currency, appUrl: apiBase(),
        link: targets[0],
        secondaryLink: targets[1] ? { href: targets[1].href, label: targets[1].label.replace('&amp;', '&amp;') + ' &rarr;' } : null,
      });
      if (await sendMail({ to: user.email, subject: mail.subject, html: mail.html })) sent++;
    } catch (e) { console.error('[proactive] briefing failed for', user.id, e.message); }
  }
  return sent;
}

// ══════════════════════════════════════════════════════════════
// Scheduler entry
// ══════════════════════════════════════════════════════════════
let _running = false;
async function tick(db) {
  if (_running || !db) return;
  _running = true;
  try {
    // 1. Users whose scan is due: atomic claim per user.
    const cands = await db.queryAll(
      `SELECT u.* FROM users u
        LEFT JOIN agent_prefs p ON p.user_id = u.id
       WHERE NOT u.is_banned
         AND (p.last_scan_at IS NULL OR p.last_scan_at < NOW() - ($1 || ' hours')::interval)
         AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id = u.id AND l.created_at > NOW() - INTERVAL '120 days')
       LIMIT $2`, [String(SCAN_EVERY_HOURS), USERS_PER_TICK]).catch(e => { console.error('[proactive] candidate query failed:', e.message); return []; });
    for (const user of cands) {
      const claim = await db.query(
        `INSERT INTO agent_prefs (user_id, last_scan_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_scan_at = NOW()
           WHERE agent_prefs.last_scan_at IS NULL OR agent_prefs.last_scan_at < NOW() - ($2 || ' hours')::interval`,
        [user.id, String(SCAN_EVERY_HOURS)]).catch(() => null);
      if (!claim || claim.rowCount === 0) continue;
      try { await scanUser(db, user, { ai: true }); }
      catch (e) { console.error('[proactive] scan failed for', user.id, e.message); }
    }
    // 2. Morning briefings (cheap; dedupes per local day).
    const active = await db.queryAll(
      `SELECT u.* FROM users u LEFT JOIN agent_prefs p ON p.user_id=u.id
        WHERE NOT u.is_banned AND COALESCE(p.daily_briefing,true)=true
          AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id=u.id AND l.created_at > NOW() - INTERVAL '30 days')
        LIMIT 500`).catch(() => []);
    await sendDueBriefings(db, active);
    // 3. Owner alerts: customers waiting on the owner. Only owners who have such a lead right now.
    const waiting = await db.queryAll(
      `SELECT u.* FROM users u LEFT JOIN agent_prefs p ON p.user_id=u.id
        WHERE NOT u.is_banned AND COALESCE(p.alerts_enabled,true)=true
          AND (p.last_alert_at IS NULL OR p.last_alert_at < NOW() - INTERVAL '${ALERT_MIN_GAP_H} hours')
          AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id=u.id AND l.source<>'test' AND l.status<>'closed'
                AND l.last_customer_message_at < NOW() - INTERVAL '${ALERT_WAIT_HOURS} hours'
                AND l.last_customer_message_at > NOW() - INTERVAL '${ALERT_MAX_AGE_DAYS} days'
                AND (l.sent_at IS NULL OR l.sent_at < l.last_customer_message_at))
        LIMIT 200`).catch(() => []);
    await sendOwnerAlerts(db, waiting);
  } catch (e) { console.error('[proactive] tick error:', e.message); }
  finally { _running = false; }
}

module.exports = {
  KINDS, KIND_KEYS, tick, scanUser, detect, sanitizeTemplate, draftTemplate, executeProposal, dismissProposal,
  getProposal, listOpportunities, getPrefs, savePrefs, autopilotEligibility, publicProposal, gatherBriefing, sendDueBriefings, localParts,
  detectAlerts, alertSummary, sendOwnerAlerts, playbookStats, suppressedKinds, autopilotSuggestions, recoveredRevenue,
};
