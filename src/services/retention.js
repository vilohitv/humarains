/**
 * services/retention.js — small, automatic things that keep paying customers from leaving.
 *
 *   Payment recovery   a failed payment becomes one clear email and a banner in the dashboard until it is
 *                      fixed. Access is NOT cut during Stripe's retries (the plan only changes when Stripe
 *                      finally cancels), so a customer with an expired card never loses their AI by surprise.
 *   Cancel flow        asks why, and for a price objection offers a one-time discount instead of losing the
 *                      customer. The reason is stored so you can see what is driving churn.
 *   Win-back           when a subscription ends, one email saying their data is kept.
 *   Activation         the first week decides most churn: paying customers who have not connected an inbox or
 *                      WhatsApp, or finished their business profile, get up to two reminders (retention-job.js).
 *
 * State lives in integrations.billing and integrations.nudges, written with targeted JSONB updates so it never
 * overwrites other integration data. Stripe and the mailer are passed in, so all of this is testable offline.
 */
'use strict';

const DAY = 86400_000;
const PAYMENT_EMAIL_EVERY_MS = 48 * 3600_000;   // Stripe retries several times; one email per 2 days is plenty
const OFFER_MONTHS = 2;

const offerPercent = () => {
  const v = parseInt(process.env.RETENTION_OFFER_PERCENT, 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(50, v)) : 20;   // 0 turns the offer off
};

const REASONS = {
  too_expensive:  'It is too expensive',
  not_enough:     'I am not getting enough leads or results',
  hard_to_use:    'It is too hard to set up or use',
  missing:        'It is missing something I need',
  closing:        'My business is closing or seasonal',
  other:          'Something else',
};

function parseIntg(user) {
  const raw = user && user.integrations;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const p = JSON.parse(raw); return typeof p === 'string' ? JSON.parse(p) : p; } catch (_) { return {}; }
}
const getBilling = user => parseIntg(user).billing || {};

// Merge `patch` into integrations.<key> with one atomic UPDATE (never rewrites the whole integrations object).
async function patchIntg(db, userId, key, patch) {
  await db.query(
    `UPDATE users
        SET integrations = jsonb_set(COALESCE(integrations, '{}'::jsonb), ARRAY[$2::text],
                                     COALESCE(integrations->$2::text, '{}'::jsonb) || $3::jsonb, true)
      WHERE id = $1 AND (integrations IS NULL OR jsonb_typeof(integrations) = 'object')`,
    [userId, key, JSON.stringify(patch)]
  );
}

const firstName = u => String((u && u.name) || '').split(/\s+/)[0] || 'there';
const appUrl = () => process.env.APP_URL || 'https://humarains.com';
async function defaultSend(mail) { return require('./mailer').sendMail(mail); }

// ── Payment recovery ─────────────────────────────────────────────
async function markPaymentFailed(db, user, { sendMail = defaultSend, now = Date.now() } = {}) {
  const b = getBilling(user);
  const since = b.status === 'past_due' && b.since ? b.since : now;
  const patch = { status: 'past_due', since, failedCount: (b.status === 'past_due' ? (b.failedCount || 0) : 0) + 1 };
  const due = !b.lastPaymentEmailAt || now - b.lastPaymentEmailAt >= PAYMENT_EMAIL_EVERY_MS;
  let emailed = false;
  if (due && user.email) {
    const { paymentFailed } = require('../lib/email-templates');
    const mail = paymentFailed({ name: firstName(user), appUrl: appUrl() });
    try { emailed = !!(await sendMail({ to: user.email, subject: mail.subject, html: mail.html })); }
    catch (e) { console.error('[retention] payment-failed email failed:', e.message); }
    if (emailed) patch.lastPaymentEmailAt = now;
  }
  await patchIntg(db, user.id, 'billing', patch);
  return { emailed };
}

async function markPaymentRecovered(db, user) {
  const b = getBilling(user);
  if (b.status !== 'past_due') return false;
  await patchIntg(db, user.id, 'billing', { status: 'ok', since: null, failedCount: 0, recoveredAt: Date.now() });
  return true;
}

// ── Cancel flow ──────────────────────────────────────────────────
async function recordCancelIntent(db, user, { reason, note }, now = Date.now()) {
  const key = Object.prototype.hasOwnProperty.call(REASONS, reason) ? reason : 'other';
  const b = getBilling(user);
  const entry = { reason: key, note: String(note || '').slice(0, 500), at: now };
  const history = [...(Array.isArray(b.cancelIntents) ? b.cancelIntents : []), entry].slice(-5);
  await patchIntg(db, user.id, 'billing', { cancelIntents: history });
  console.log(`[retention] cancel intent from user ${user.id}: ${key}`);
  return key;
}

// What to say and offer for each reason. The discount is only for price objections, once per account.
function offerFor(user, reason) {
  const pct = offerPercent();
  const b = getBilling(user);
  const eligible = reason === 'too_expensive' && pct > 0 && !b.offerUsedAt && !!user.stripe_subscription_id;
  const messages = {
    too_expensive: 'We would rather keep you than lose you.',
    not_enough: 'Humarains answers the enquiries you already get, so check that your email inbox and WhatsApp number are both connected in the dashboard. If they are and results are still low, reply to any of our emails and tell us.',
    hard_to_use: 'We are sorry it has been hard. Reply to any of our emails and we will help you finish the setup.',
    missing: 'Tell us what is missing by replying to any of our emails. Most of what we build comes from customer requests.',
    closing: 'Sorry to hear that. Your leads and settings are kept for free if you want to come back.',
    other: '',
  };
  return { available: eligible, percent: pct, months: OFFER_MONTHS, message: messages[reason] || '' };
}

// One-time discount on the existing subscription (Stripe coupon, 2 months). Never throws.
async function applyStayOffer({ stripe, db, user, now = Date.now() }) {
  const offer = offerFor(user, 'too_expensive');
  if (!offer.available) return { ok: false, reason: 'not_eligible' };
  try {
    const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
    if (!sub || ['canceled', 'incomplete_expired'].includes(sub.status)) return { ok: false, reason: 'no_active_subscription' };
    if (sub.discount || (Array.isArray(sub.discounts) && sub.discounts.length)) return { ok: false, reason: 'already_discounted' };
    const coupon = await stripe.coupons.create({
      percent_off: offer.percent, duration: 'repeating', duration_in_months: OFFER_MONTHS,
      name: `Stay offer ${offer.percent}% for ${OFFER_MONTHS} months`, metadata: { userId: user.id, kind: 'retention' },
    });
    await stripe.subscriptions.update(user.stripe_subscription_id, { discounts: [{ coupon: coupon.id }] });
    await patchIntg(db, user.id, 'billing', { offerUsedAt: now, offerPercent: offer.percent });
    return { ok: true, percent: offer.percent, months: OFFER_MONTHS };
  } catch (e) {
    console.error('[retention] stay offer failed:', e.message);
    return { ok: false, reason: 'stripe_error' };
  }
}

// Stripe portal link. flow: 'cancel' opens the cancellation screen, 'payment' the card update screen, otherwise the
// portal home. If the portal is not configured for that flow, falls back to the portal home instead of failing.
async function portalUrl({ stripe, user, returnUrl, flow }) {
  const base = { customer: user.stripe_customer_id, return_url: returnUrl };
  const after = { type: 'redirect', redirect: { return_url: returnUrl } };
  let flow_data = null;
  if (flow === 'cancel' && user.stripe_subscription_id) flow_data = { type: 'subscription_cancel', subscription_cancel: { subscription: user.stripe_subscription_id }, after_completion: after };
  if (flow === 'payment') flow_data = { type: 'payment_method_update', after_completion: after };
  if (flow_data) {
    try { return (await stripe.billingPortal.sessions.create({ ...base, flow_data })).url; }
    catch (e) { console.warn('[retention] portal flow unavailable, using portal home:', e.message); }
  }
  return (await stripe.billingPortal.sessions.create(base)).url;
}

// Called from the subscription.deleted webhook, after the plan has been moved to free.
async function recordCancellation(db, user, subscription, { sendMail = defaultSend, now = Date.now() } = {}) {
  const b = getBilling(user);
  const cd = (subscription && subscription.cancellation_details) || {};
  const patch = { status: 'ok', since: null, canceledAt: now,
    stripeReason: cd.reason || null, stripeFeedback: cd.feedback || null, stripeComment: cd.comment ? String(cd.comment).slice(0, 500) : null };
  let emailed = false;
  if (!b.winbackSentAt && user.email) {
    const { subscriptionEnded } = require('../lib/email-templates');
    const mail = subscriptionEnded({ name: firstName(user), appUrl: appUrl() });
    try { emailed = !!(await sendMail({ to: user.email, subject: mail.subject, html: mail.html })); }
    catch (e) { console.error('[retention] win-back email failed:', e.message); }
    if (emailed) patch.winbackSentAt = now;
  }
  await patchIntg(db, user.id, 'billing', patch);
  return { emailed };
}

// ── Activation nudges ────────────────────────────────────────────
// What a paying customer still has to do before the AI can work for them. Only real gaps are returned.
function setupGaps(user, settingsRow, leadCount) {
  const intg = parseIntg(user);
  const gaps = [];
  const wa = intg.whatsapp && intg.whatsapp.phoneNumberId && intg.whatsapp.accessToken;
  if (!(intg.pipeline_email || intg.lead_email) && !wa) gaps.push('Connect your email inbox or your WhatsApp number so the AI can see your enquiries');
  let services = settingsRow && settingsRow.services;
  if (typeof services === 'string') { try { services = JSON.parse(services); } catch (_) { services = []; } }
  if (!settingsRow || !settingsRow.business_name || !Array.isArray(services) || !services.length) gaps.push('Add your business name and your services and prices so the AI can quote correctly');
  if (!leadCount) gaps.push('Send yourself a test enquiry to see the AI reply');
  return gaps;
}

async function sendActivationNudges(db, { sendMail = defaultSend, now = Date.now() } = {}) {
  const rows = await db.queryAll(
    `SELECT u.id, u.name, u.email, u.integrations,
            COALESCE((SELECT MIN(bh.created_at) FROM billing_history bh WHERE bh.user_id = u.id AND bh.event = 'subscription.created'), u.created_at) AS started_at
       FROM users u
      WHERE u.plan <> 'free' AND u.stripe_subscription_id IS NOT NULL AND NOT u.is_banned AND u.email IS NOT NULL
      LIMIT 2000`, []);
  const { setupNudge } = require('../lib/email-templates');
  let sent = 0;
  for (const u of rows) {
    try {
      const days = (now - new Date(u.started_at).getTime()) / DAY;
      const n = parseIntg(u).nudges || {};
      const stage = days >= 6 && !n.setup2At ? 2 : (days >= 2 && !n.setup1At ? 1 : 0);
      if (!stage || days > 21) continue;                         // nothing due, or far too late to be useful
      const [settingsRow, cnt] = await Promise.all([
        db.queryOne('SELECT business_name, services FROM lead_business_settings WHERE user_id = $1', [u.id]),
        db.queryOne('SELECT COUNT(*)::int AS n FROM leads WHERE user_id = $1', [u.id]),
      ]);
      const gaps = setupGaps(u, settingsRow, cnt && cnt.n);   // any lead, test or real, counts as "has seen the AI work"
      // Set up properly: nothing to chase, and never ask again.
      if (!gaps.length) { await patchIntg(db, u.id, 'nudges', { setup1At: n.setup1At || now, setup2At: now }); continue; }
      // The button opens the first missing thing: the inbox / WhatsApp connection, the business settings, or the page to add a test enquiry.
      const { dashboardUrl } = require('../lib/deeplink');
      const gap0 = String(gaps[0] || '');
      const view = /Connect your email/.test(gap0) ? 'email' : /business name/.test(gap0) ? 'settings' : /test enquiry/.test(gap0) ? 'ingest' : null;
      const label = view === 'email' ? 'Connect my inbox' : view === 'settings' ? 'Add my business details' : view === 'ingest' ? 'Send a test enquiry' : 'Finish setup';
      const mail = setupNudge({ name: firstName(u), gaps, second: stage === 2, appUrl: appUrl(), link: { href: dashboardUrl(appUrl(), view ? { view } : {}), label } });
      if (await sendMail({ to: u.email, subject: mail.subject, html: mail.html })) {
        await patchIntg(db, u.id, 'nudges', stage === 2 ? { setup1At: n.setup1At || now, setup2At: now } : { setup1At: now });
        sent++;
      }
    } catch (e) { console.error('[retention] nudge failed for', u.id, e.message); }
  }
  return sent;
}

module.exports = { REASONS, offerPercent, getBilling, patchIntg, markPaymentFailed, markPaymentRecovered, recordCancelIntent,
  offerFor, applyStayOffer, portalUrl, recordCancellation, setupGaps, sendActivationNudges };
