/**
 * services/agent/autonomy.js — what the Agent may do on its own, and the limits around it.
 *
 * The owner decides, once in onboarding and any time in Settings > Agent permissions (or by telling the Agent in
 * chat), which recovery actions the Agent may take and how much freedom each one gets:
 *
 *   reengage     email enquiries and quotes that went quiet        (playbooks quote_followup, go_cold)
 *   discount     offer a limited-time discount on a quote that stalled   (playbook discount_offer)
 *   missed_call  text back a customer whose WhatsApp call was missed     (services/whatsapp-calls.js)
 *   review       ask a happy customer for a review                       (playbook review_request)
 *   winback      check in with a past customer                           (playbook winback)
 *
 * Each action has a mode:  off  = never,  ask = the Agent prepares it and the owner approves,  auto = it just does it.
 * Around the modes sit hard limits the Agent cannot cross: messages per day, contacts per customer, quiet hours,
 * the discount percentage, the smallest quote a discount may apply to, a monthly discount budget, and a pause switch.
 *
 * This file is the single source of truth for that policy: the data shape, validation (used by the Settings API, the
 * onboarding step and the Agent's chat tools alike), the plan clamps, the limit checks, the discount arithmetic and the
 * action log. Nothing in here sends anything. It has no top-level dependency on the rest of the Agent, so everything
 * else can require it.
 *
 * Storage: agent_prefs.autonomy (jsonb, null = never configured). Log and queue: agent_actions.
 */
'use strict';

// ── Catalogue ────────────────────────────────────────────────────
const ACTIONS = {
  reengage: {
    label: 'Follow up with quiet leads',
    help: 'Email people who asked for a quote or enquired and then went silent.',
    channel: 'email', modes: ['off', 'ask', 'auto'], playbooks: ['quote_followup', 'go_cold'],
  },
  discount: {
    label: 'Offer a discount to close a stalled quote',
    help: 'Email a limited-time discount to someone who has not answered their quote. Never above your cap, once per customer.',
    channel: 'email', modes: ['off', 'ask', 'auto'], playbooks: ['discount_offer'],
  },
  missed_call: {
    label: 'Text back missed WhatsApp calls',
    help: 'When a customer calls your WhatsApp number and nobody picks up, send them a message straight away so the job is not lost.',
    channel: 'whatsapp', modes: ['off', 'auto'], playbooks: [],
  },
  review: {
    label: 'Ask happy customers for a review',
    help: 'A short thank-you with your review link a couple of days after a job is won.',
    channel: 'email', modes: ['off', 'ask', 'auto'], playbooks: ['review_request'],
  },
  winback: {
    label: 'Win back past customers',
    help: 'A friendly check-in with customers you have not spoken to for a while.',
    channel: 'email', modes: ['off', 'ask', 'auto'], playbooks: ['winback'],
  },
};
const ACTION_KEYS = Object.keys(ACTIONS);
const PLAYBOOK_ACTION = {};
for (const k of ACTION_KEYS) for (const p of ACTIONS[k].playbooks) PLAYBOOK_ACTION[p] = k;
const MODES = ['off', 'ask', 'auto'];

// Fields a missed-call message may use. Anything else would be sent blank, so it is rejected.
const CALL_FIELDS = ['customerName', 'businessName', 'ownerName', 'bookingUrl', 'opensWhen'];
const DEFAULT_CALL_MESSAGE = 'Hi {{customerName}}, this is {{businessName}}. Sorry we missed your call! What can we help you with? Reply here and we will get straight back to you.';
const DEFAULT_CALL_MESSAGE_CLOSED = 'Hi {{customerName}}, this is {{businessName}}. Sorry we missed your call, we are closed right now. Tell us what you need here and we will get back to you {{opensWhen}}.';

// Hard ceilings: whatever is typed, nothing above these is ever stored.
const BOUNDS = {
  quoteAfterDays: [1, 30], coldAfterDays: [2, 60],
  percent: [1, 50], afterDays: [1, 30], validDays: [1, 60], minQuoteValue: [0, 1e7], monthlyBudget: [0, 1e7],
  delayMinutes: [0, 60],
  dailyMessages: [1, 200], maxTouchesPer30d: [1, 10], quietFrom: [0, 23], quietTo: [0, 23],
};

function defaultPolicy() {
  return {
    paused: false,
    configuredAt: null,
    actions: {
      reengage:    { mode: 'ask', quoteAfterDays: 3, coldAfterDays: 7 },
      discount:    { mode: 'off', percent: 10, afterDays: 5, validDays: 7, minQuoteValue: 0, monthlyBudget: 0 },
      missed_call: { mode: 'off', delayMinutes: 1, message: DEFAULT_CALL_MESSAGE, afterHoursMessage: DEFAULT_CALL_MESSAGE_CLOSED },
      review:      { mode: 'ask' },
      winback:     { mode: 'ask' },
    },
    limits: { dailyMessages: 20, maxTouchesPer30d: 2, quietFrom: 20, quietTo: 8 },
  };
}

// Starting points shown in onboarding and Settings. They only fill the form; the owner sees every switch before saving.
const PRESETS = {
  ask_first: {
    label: 'Ask me first',
    help: 'The Agent prepares everything and waits for your approval. Nothing goes out until you say so.',
    actions: { reengage: { mode: 'ask' }, discount: { mode: 'off' }, missed_call: { mode: 'off' }, review: { mode: 'ask' }, winback: { mode: 'ask' } },
  },
  balanced: {
    label: 'Balanced',
    help: 'Follow-ups, reviews and missed-call texts run by themselves. Discounts and win-backs still need your OK.',
    actions: { reengage: { mode: 'auto' }, discount: { mode: 'ask' }, missed_call: { mode: 'auto' }, review: { mode: 'auto' }, winback: { mode: 'ask' } },
  },
  hands_off: {
    label: 'Hands-off',
    help: 'The Agent does all of it on its own, inside your limits, and tells you in your daily briefing.',
    actions: { reengage: { mode: 'auto' }, discount: { mode: 'auto' }, missed_call: { mode: 'auto' }, review: { mode: 'auto' }, winback: { mode: 'auto' } },
  },
};

// ── Normalising and validating ───────────────────────────────────
const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const clampNum = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : fallback;
};
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);

/** Merge fields used in a template that are not in the allowed list. */
function unknownFields(text, allowed) {
  const bad = new Set();
  String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => { if (!allowed.includes(k)) bad.add(k); return m; });
  return [...bad];
}

/**
 * Turn anything (stored JSON, a request body, a half-filled form) into a complete, in-range policy.
 * `base` is what to fall back to for anything missing; unknown keys are dropped. Never throws.
 */
function normalizePolicy(raw, base) {
  const def = base || defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = defaultPolicy();
  out.paused = src.paused !== undefined ? !!src.paused : !!def.paused;
  out.configuredAt = src.configuredAt !== undefined ? (src.configuredAt || null) : (def.configuredAt || null);

  const a = src.actions && typeof src.actions === 'object' ? src.actions : {};
  const d = (def.actions || {});
  for (const key of ACTION_KEYS) {
    const spec = ACTIONS[key], inn = a[key] && typeof a[key] === 'object' ? a[key] : {}, was = d[key] || out.actions[key];
    const cur = out.actions[key];
    cur.mode = spec.modes.includes(inn.mode) ? inn.mode : (spec.modes.includes(was.mode) ? was.mode : cur.mode);
    if (key === 'reengage') {
      cur.quoteAfterDays = clampInt(inn.quoteAfterDays !== undefined ? inn.quoteAfterDays : was.quoteAfterDays, BOUNDS.quoteAfterDays, 3);
      cur.coldAfterDays  = clampInt(inn.coldAfterDays  !== undefined ? inn.coldAfterDays  : was.coldAfterDays,  BOUNDS.coldAfterDays, 7);
    } else if (key === 'discount') {
      cur.percent       = clampInt(inn.percent       !== undefined ? inn.percent       : was.percent,       BOUNDS.percent, 10);
      cur.afterDays     = clampInt(inn.afterDays     !== undefined ? inn.afterDays     : was.afterDays,     BOUNDS.afterDays, 5);
      cur.validDays     = clampInt(inn.validDays     !== undefined ? inn.validDays     : was.validDays,     BOUNDS.validDays, 7);
      cur.minQuoteValue = clampNum(inn.minQuoteValue !== undefined ? inn.minQuoteValue : was.minQuoteValue, BOUNDS.minQuoteValue, 0);
      cur.monthlyBudget = clampNum(inn.monthlyBudget !== undefined ? inn.monthlyBudget : was.monthlyBudget, BOUNDS.monthlyBudget, 0);
    } else if (key === 'missed_call') {
      cur.delayMinutes = clampInt(inn.delayMinutes !== undefined ? inn.delayMinutes : was.delayMinutes, BOUNDS.delayMinutes, 1);
      const msg = inn.message !== undefined ? cleanText(inn.message, 600) : cleanText(was.message, 600);
      const closed = inn.afterHoursMessage !== undefined ? cleanText(inn.afterHoursMessage, 600) : cleanText(was.afterHoursMessage, 600);
      // An empty box means "use the standard wording", and a template with an unknown field falls back to it too.
      cur.message = msg && !unknownFields(msg, CALL_FIELDS).length ? msg : DEFAULT_CALL_MESSAGE;
      cur.afterHoursMessage = closed && !unknownFields(closed, CALL_FIELDS).length ? closed : DEFAULT_CALL_MESSAGE_CLOSED;
    }
  }

  const l = src.limits && typeof src.limits === 'object' ? src.limits : {};
  const dl = def.limits || out.limits;
  for (const k of Object.keys(BOUNDS)) {
    if (!(k in out.limits)) continue;
    out.limits[k] = clampInt(l[k] !== undefined ? l[k] : dl[k], BOUNDS[k], out.limits[k]);
  }
  return out;
}

/**
 * Validate a request to change the policy. Unlike normalizePolicy this reports problems instead of silently fixing
 * them, so the owner (or the Agent) learns what was changed. `current` is the saved policy; the patch is merged on it.
 * Returns { ok, policy, notes: [plain-English corrections], error }.
 */
function validatePatch(patch, current) {
  const p = patch && typeof patch === 'object' ? patch : null;
  if (!p) return { ok: false, error: 'Nothing to save.' };
  const cur = normalizePolicy(current);
  const notes = [];

  if (p.actions !== undefined && (typeof p.actions !== 'object' || p.actions === null)) return { ok: false, error: 'actions must be an object.' };
  for (const [key, val] of Object.entries(p.actions || {})) {
    if (!ACTIONS[key]) return { ok: false, error: `Unknown action "${key}". Choose from: ${ACTION_KEYS.join(', ')}.` };
    if (!val || typeof val !== 'object') return { ok: false, error: `Settings for "${key}" must be an object.` };
    if (val.mode !== undefined && !ACTIONS[key].modes.includes(val.mode)) {
      return { ok: false, error: `${ACTIONS[key].label}: mode must be ${ACTIONS[key].modes.join(', ')}.` };
    }
    const range = (field, label, unit = '') => {
      if (val[field] === undefined) return;
      const n = Number(val[field]);
      if (!Number.isFinite(n)) { notes.push(`${label} was not a number and was left as it was.`); delete val[field]; return; }
      const [lo, hi] = BOUNDS[field];
      if (n < lo || n > hi) notes.push(`${label} must be between ${lo}${unit} and ${hi}${unit}; it was set to ${Math.min(hi, Math.max(lo, n))}${unit}.`);
    };
    if (key === 'discount') {
      range('percent', 'Discount', '%'); range('afterDays', 'Days of silence before a discount'); range('validDays', 'Days an offer stays open');
    }
    if (key === 'reengage') { range('quoteAfterDays', 'Days before chasing a quote'); range('coldAfterDays', 'Days before chasing a quiet enquiry'); }
    if (key === 'missed_call') {
      range('delayMinutes', 'Minutes before the text-back');
      for (const f of ['message', 'afterHoursMessage']) {
        if (val[f] === undefined) continue;
        const bad = unknownFields(val[f], CALL_FIELDS);
        if (bad.length) return { ok: false, error: `The missed-call message uses {{${bad[0]}}}, which does not exist. You can use: ${CALL_FIELDS.map(x => '{{' + x + '}}').join(', ')}.` };
      }
    }
  }
  for (const k of Object.keys(p.limits || {})) {
    if (!(k in BOUNDS)) return { ok: false, error: `Unknown limit "${k}".` };
  }

  const merged = normalizePolicy({ ...p, actions: mergeActions(cur.actions, p.actions), limits: { ...cur.limits, ...(p.limits || {}) } }, cur);
  return { ok: true, policy: merged, notes };
}
function mergeActions(cur, patch) {
  const out = {};
  for (const k of ACTION_KEYS) out[k] = { ...(cur[k] || {}), ...((patch && patch[k]) || {}) };
  return out;
}

/** The policy a preset describes, applied on top of `current` (the owner's other numbers are kept). */
function applyPreset(name, current) {
  const preset = PRESETS[name];
  if (!preset) return null;
  const cur = normalizePolicy(current);
  return normalizePolicy({ actions: mergeActions(cur.actions, preset.actions) }, cur);
}

// ── What is actually allowed right now ───────────────────────────
function planOf(user) {
  const { getPlan } = require('../../config/plans');
  return getPlan((user && user.plan) || 'free');
}

/**
 * The mode the Agent really runs in: the owner's choice, held back by the pause switch and by what the plan includes.
 * `auto` needs autonomous mode (Growth and above); missed-call text-back needs WhatsApp on the plan.
 */
function effectiveMode(policy, key, user) {
  const spec = ACTIONS[key];
  if (!spec) return 'off';
  const chosen = ((policy && policy.actions && policy.actions[key]) || {}).mode || 'off';
  const plan = planOf(user);
  if (key === 'missed_call') return (chosen === 'auto' && !policy.paused && plan.whatsapp) ? 'auto' : 'off';
  if (chosen === 'auto' && (policy.paused || !plan.autonomousMode)) return 'ask';
  return chosen;
}

/** Why an action cannot run at the mode the owner chose (for the Settings page), or null. */
function lockReason(policy, key, user) {
  const chosen = ((policy.actions || {})[key] || {}).mode || 'off';
  const eff = effectiveMode(policy, key, user);
  if (chosen === eff) return null;
  const plan = planOf(user);
  if (policy.paused) return 'Paused: nothing runs on its own until you resume.';
  if (key === 'missed_call') return plan.whatsapp ? null : `Needs WhatsApp, which starts on the Starter plan.`;
  if (chosen === 'auto' && !plan.autonomousMode) return 'Automatic mode needs the Growth plan. Until then it asks for your approval.';
  return null;
}

/** The mode for one playbook (quote_followup, discount_offer, ...). */
function playbookMode(policy, playbook, user) {
  return effectiveMode(policy, PLAYBOOK_ACTION[playbook], user);
}

// ── Time ─────────────────────────────────────────────────────────
function localHour(tz, now = new Date()) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', hour12: false }).formatToParts(now).find(x => x.type === 'hour');
    return (+p.value) % 24;
  } catch (_) { return localHour('UTC', now); }
}
/** True while the owner's quiet hours are on. 20 -> 8 wraps midnight; equal numbers mean no quiet hours. */
function inQuietHours(limits, tz, now = new Date()) {
  const from = limits.quietFrom, to = limits.quietTo;
  if (from === to) return false;
  const h = localHour(tz, now);
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// ── Discounts ────────────────────────────────────────────────────
const round2 = n => Math.round(n * 100) / 100;

/**
 * The discount to offer on one quote, or null when none is allowed. Pure and deterministic: the AI never chooses the
 * number. Rules, in order: the quote must reach the owner's minimum; the percentage is the owner's, held down by the
 * AI-wide discount ceiling in Quote Rules when one is set; the price never drops below the service's minimum charge
 * (the percentage is reduced to fit, and no offer is made if that leaves under 1%).
 */
function computeOffer(cfg, quote, service, settings, now = new Date()) {
  if (!cfg || !quote) return null;
  const total = Number(quote.total);
  if (!(total > 0)) return null;
  if (cfg.minQuoteValue > 0 && total < cfg.minQuoteValue) return null;
  let percent = cfg.percent;
  const ceiling = Number(settings && settings.maxDiscountPercent);
  if (ceiling > 0) percent = Math.min(percent, ceiling);
  let discounted = round2(total * (1 - percent / 100));
  const floor = Number(service && service.minCharge) || 0;
  if (floor > 0 && discounted < floor) {
    discounted = Math.min(total, floor);
    percent = Math.round((1 - discounted / total) * 1000) / 10;     // the percentage that lands exactly on the floor
  }
  if (!(percent >= 1)) return null;
  const amount = round2(total - discounted);
  if (!(amount > 0)) return null;
  return {
    percent, originalTotal: round2(total), discountedTotal: discounted, amount,
    currency: quote.currency || (settings && settings.currency) || 'USD',
    offeredAt: now.toISOString(), expiresAt: new Date(now.getTime() + cfg.validDays * 86400000).toISOString(),
    source: 'agent',
  };
}
const offerActive = (offer, now = Date.now()) => !!(offer && offer.expiresAt && new Date(offer.expiresAt).getTime() > now && offer.percent > 0);

/** The sentence added to the reply prompt so the AI honours exactly the offer the Agent made, and nothing more. */
function offerPromptNote(offer, now = Date.now()) {
  if (!offerActive(offer, now)) return '';
  const until = new Date(offer.expiresAt).toISOString().slice(0, 10);
  return `OWNER-APPROVED OFFER for this customer only: ${offer.percent}% off their quote (${offer.currency} ${offer.originalTotal} becomes ${offer.currency} ${offer.discountedTotal}), valid until ${until}. ` +
    `If they say yes or ask about price, you may mention it and honour it. Apply ${offer.percent}% to the quote total if the job changes. Never offer more than this, never extend the date, and never offer it to anyone else. If they ask for a bigger discount, say the owner would need to approve that.`;
}

// ── Messages ─────────────────────────────────────────────────────
function fillTemplate(tpl, scope) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (scope[k] != null ? String(scope[k]) : ''))
    .replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

// ── Storage ──────────────────────────────────────────────────────
const parseJ = v => { if (v == null) return v; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };

/** The saved policy. Accounts that never configured one get today's behaviour: every playbook asks, and the playbooks
 *  already on Autopilot (agent_prefs.autopilot) run by themselves. */
async function getPolicy(db, userId) {
  const row = await db.queryOne('SELECT autonomy, autopilot FROM agent_prefs WHERE user_id=$1', [userId]).catch(() => null);
  const stored = row && parseJ(row.autonomy);
  if (stored && typeof stored === 'object') return normalizePolicy(stored);
  const base = defaultPolicy();
  const legacy = row ? parseJ(row.autopilot) : [];
  const on = new Set((Array.isArray(legacy) ? legacy : []).map(p => PLAYBOOK_ACTION[p]).filter(Boolean));
  for (const k of on) base.actions[k].mode = 'auto';
  return base;
}

async function savePolicy(db, userId, policy, { markConfigured = true } = {}) {
  const next = normalizePolicy({ ...policy, configuredAt: markConfigured ? new Date().toISOString() : (policy.configuredAt || null) }, policy);
  // agent_prefs.autopilot (the older switch the dashboard cards and tools still read) is kept in step.
  const autopilot = ACTION_KEYS.filter(k => next.actions[k].mode === 'auto').flatMap(k => ACTIONS[k].playbooks);
  await db.query(
    `INSERT INTO agent_prefs (user_id, autonomy, autopilot) VALUES ($1, $2::jsonb, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET autonomy = EXCLUDED.autonomy, autopilot = EXCLUDED.autopilot, updated_at = NOW()`,
    [userId, JSON.stringify(next), JSON.stringify(autopilot)]);
  return next;
}

// ── Action log and limits ────────────────────────────────────────
const SENT_LIKE = `('sent','queued','sending')`;

/** Record something the Agent did, or chose not to do. Returns the new row id, or null when dedupe_key already exists. */
async function logAction(db, { userId, leadId = null, kind, channel = 'email', status = 'sent', reason = null, dedupeKey = null, runAfter = null, detail = {} }) {
  const r = await db.queryOne(
    `INSERT INTO agent_actions (user_id, lead_id, kind, channel, status, reason, dedupe_key, run_after, detail, done_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()), $9::jsonb, CASE WHEN $5 IN ('sent','skipped','failed','cancelled') THEN NOW() END)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, leadId, kind, channel, status, reason, dedupeKey, runAfter, JSON.stringify(detail || {})]);
  return r ? Number(r.id) : null;
}

/** Customer-facing outbound the Agent started on its own in the last 24 hours (missed-call replies are not counted: they answer the customer). */
async function sentToday(db, userId) {
  const r = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM agent_actions WHERE user_id=$1 AND kind <> 'missed_call' AND status IN ${SENT_LIKE} AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]).catch(() => null);
  return (r && r.n) || 0;
}

/** Of these leads, which the Agent has already contacted `max` times in the last 30 days. */
async function overTouched(db, userId, leadIds, max) {
  if (!leadIds.length) return new Set();
  const rows = await db.queryAll(
    `SELECT lead_id FROM agent_actions WHERE user_id=$1 AND lead_id = ANY($2::text[]) AND kind <> 'missed_call'
        AND status IN ${SENT_LIKE} AND created_at > NOW() - INTERVAL '30 days' GROUP BY lead_id HAVING COUNT(*) >= $3`,
    [userId, leadIds, max]).catch(() => []);
  return new Set(rows.map(r => r.lead_id));
}

/** Total value of discounts offered in the last 30 days. */
async function discountOfferedThisMonth(db, userId) {
  const r = await db.queryOne(
    `SELECT COALESCE(SUM((detail->>'amount')::numeric),0)::float AS v FROM agent_actions
      WHERE user_id=$1 AND kind='discount' AND status IN ${SENT_LIKE} AND created_at > NOW() - INTERVAL '30 days'`, [userId]).catch(() => null);
  return (r && r.v) || 0;
}

/**
 * Which of these leads the Agent may contact on its own right now, under the owner's limits. Used for every automatic
 * email action. Returns { ids, blocked: reason|null } where `blocked` explains why nobody (or only some) can go.
 */
async function admitLeads(db, { user, policy, settings, leadIds, now = new Date() }) {
  const l = policy.limits;
  if (inQuietHours(l, settings && settings.timezone, now)) return { ids: [], blocked: 'quiet_hours' };
  const used = await sentToday(db, user.id);
  const room = l.dailyMessages - used;
  if (room <= 0) return { ids: [], blocked: 'daily_limit' };
  const touched = await overTouched(db, user.id, leadIds, l.maxTouchesPer30d);
  const ids = leadIds.filter(id => !touched.has(id)).slice(0, room);
  return { ids, blocked: ids.length ? null : (touched.size ? 'touch_limit' : null) };
}

const BLOCK_TEXT = {
  quiet_hours: 'It is inside your quiet hours, so the Agent waited.',
  daily_limit: 'The daily message limit you set has been reached.',
  touch_limit: 'Every one of these customers has already been contacted as often as your limit allows.',
};

/** The activity feed for the Settings page. */
async function listActivity(db, userId, { limit = 30 } = {}) {
  const rows = await db.queryAll(
    `SELECT a.id, a.lead_id, a.kind, a.channel, a.status, a.reason, a.detail, a.run_after, a.created_at, a.done_at,
            l.customer_name, l.from_name, l.from_email, l.from_phone
       FROM agent_actions a LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.user_id=$1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(100, limit))]).catch(() => []);
  return rows.map(r => ({
    id: Number(r.id), leadId: r.lead_id, kind: r.kind, channel: r.channel, status: r.status, reason: r.reason || null,
    who: r.customer_name || r.from_name || r.from_email || r.from_phone || null,
    detail: parseJ(r.detail) || {}, at: r.created_at, runAfter: r.run_after, doneAt: r.done_at,
  }));
}

/** Counts for the header of the activity feed. */
async function activitySummary(db, userId, days = 30) {
  const rows = await db.queryAll(
    `SELECT kind, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status IN ('queued','sending'))::int AS waiting,
            COUNT(*) FILTER (WHERE status IN ('skipped','failed'))::int AS held
       FROM agent_actions WHERE user_id=$1 AND created_at > NOW() - ($2 || ' days')::interval GROUP BY kind`,
    [userId, String(days)]).catch(() => []);
  const out = { days, sent: 0, waiting: 0, held: 0, byKind: {} };
  for (const r of rows) { out.byKind[r.kind] = { sent: r.sent, waiting: r.waiting, held: r.held }; out.sent += r.sent; out.waiting += r.waiting; out.held += r.held; }
  return out;
}

/** Stop a queued action (a text-back that has not gone out yet). */
async function cancelQueued(db, userId, id) {
  const r = await db.query(
    `UPDATE agent_actions SET status='cancelled', reason='Stopped by you before it was sent.', done_at=NOW() WHERE id=$1 AND user_id=$2 AND status='queued'`,
    [Number(id), userId]);
  return !!(r && r.rowCount);
}

module.exports = {
  ACTIONS, ACTION_KEYS, MODES, PLAYBOOK_ACTION, PRESETS, BOUNDS, CALL_FIELDS, DEFAULT_CALL_MESSAGE, DEFAULT_CALL_MESSAGE_CLOSED, BLOCK_TEXT,
  defaultPolicy, normalizePolicy, validatePatch, applyPreset, unknownFields,
  effectiveMode, lockReason, playbookMode, inQuietHours, localHour,
  computeOffer, offerActive, offerPromptNote, fillTemplate,
  getPolicy, savePolicy, logAction, sentToday, overTouched, discountOfferedThisMonth, admitLeads, listActivity, activitySummary, cancelQueued,
};
