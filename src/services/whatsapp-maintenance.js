/**
 * services/whatsapp-maintenance.js — keeps every connected WhatsApp number working without the owner.
 *
 * Runs in the worker (and in the web process when PROCESS_ROLE=all), under a database lock:
 *
 *   • health      every few hours (and right away after a failure) checks the number with Meta and fixes
 *                 what can be fixed itself: registers it on the Cloud API, re-subscribes the app to the
 *                 account's webhooks. The result is stored in integrations.whatsapp.health. A number Meta has
 *                 flagged, restricted or banned is reported to the owner and never re-registered.
 *   • failures    delivery receipts that arrive on the webhook are acted on: a broken connection (expired
 *                 token, no payment method, ...) becomes a visible alert, and a customer who cannot be reached
 *                 on WhatsApp is flagged for the owner.
 *   • notices     quality, violation and restriction notices from Meta become a visible alert on the dashboard.
 */
'use strict';
const { runJob } = require('../lib/jobs');
const { writeWaKey } = require('./wa-state');

const TICK_MS = 5 * 60_000;
const HEALTH_EVERY_MS = 6 * 3600_000;
let _timer = null;

async function syncUserHealth(db, user) {
  const wa = user.wa || {};
  const { checkAndHeal } = require('./whatsapp');
  const lastReg = wa.health && wa.health.lastRegisterAt ? wa.health.lastRegisterAt : 0;
  // Never hammer Meta with register calls: at most one automatic attempt a day.
  const h = await checkAndHeal({ phoneNumberId: wa.phoneNumberId, wabaId: wa.wabaId, accessToken: wa.accessToken, allowRegister: Date.now() - lastReg > 24 * 3600_000 });
  const registeredNow = (h.healed || []).includes('registered');
  const stored = { ok: !!h.ok, problem: h.problem || null, status: h.status || null, platformType: h.platformType || null,
    qualityRating: h.qualityRating || null, policy: !!h.policy,
    subscribed: h.subscribed, needsRegister: !!h.needsRegister, healed: h.healed || [], checkedAt: Date.now(),
    lastRegisterAt: registeredNow ? Date.now() : lastReg };
  await writeWaKey(db, user.id, 'health', stored);

  if (h.ok && wa.alert) await writeWaKey(db, user.id, 'alert', null);
  if (h.healed && h.healed.length) console.log(`[WhatsApp] user ${user.id}: fixed the connection automatically (${h.healed.join(', ')})`);
  else if (!h.ok) console.warn(`[WhatsApp] user ${user.id}: ${h.problem}`);
  return stored;
}

async function tick(db) {
  return runJob(db, 'whatsapp_sync', async () => {
    const rows = await db.queryAll(
      `SELECT id, integrations->'whatsapp' AS wa FROM users
        WHERE integrations->'whatsapp'->>'accessToken' IS NOT NULL AND NOT COALESCE(is_banned, false)
        ORDER BY id LIMIT 1000`, []);
    let health = 0;
    for (const u of rows) {
      const wa = u.wa || {};
      if (!wa.phoneNumberId) continue;
      try {
        const last = wa.health && wa.health.checkedAt ? wa.health.checkedAt : 0;
        if (!last || wa.alert || (wa.health && !wa.health.ok) || Date.now() - last > HEALTH_EVERY_MS) {
          await syncUserHealth(db, { id: u.id, wa }); health++;
        }
      } catch (e) { console.warn(`[WhatsApp] maintenance for user ${u.id} failed:`, e.message); }
    }
    return { users: rows.length, health };
  });
}

// ── Webhook receipts ─────────────────────────────────────────────
async function userByPhoneNumberId(db, pid) {
  if (!pid) return null;
  return db.queryOne(`SELECT id FROM users WHERE integrations->'whatsapp'->>'phoneNumberId' = $1 LIMIT 1`, [String(pid)]).catch(() => null);
}

async function handleStatuses(db, value) {
  const { isAccountLevelError, waErrorHint } = require('./whatsapp');
  const pid = value && value.metadata && value.metadata.phone_number_id;
  for (const st of (value && value.statuses) || []) {
    if (st.status !== 'failed') continue;
    const err = (st.errors || [])[0] || {};
    const code = Number(err.code);
    const user = await userByPhoneNumberId(db, pid);
    if (!user) continue;
    const text = `${err.title || err.message || 'Delivery failed'} (#${code || '?'})`;

    if (isAccountLevelError(code)) {
      // The connection itself is broken: show it on the dashboard and re-check it on the next tick.
      await writeWaKey(db, user.id, 'alert', { code, message: text + waErrorHint(code), at: Date.now() });
      console.warn(`[WhatsApp] user ${user.id}: connection problem from delivery receipt — ${text}`);
      continue;
    }
    // This one customer cannot be reached on WhatsApp (not on WhatsApp, or Meta held the message back).
    if (code === 131026 || code === 131049) {
      const phone = '+' + String(st.recipient_id || '').replace(/^\+/, '');
      await db.query(
        `UPDATE leads SET needs_human_review = true, human_review_reason = $3
          WHERE user_id = $1 AND whatsapp_thread_phone = $2 AND status <> 'closed' AND needs_human_review = false`,
        [user.id, phone, code === 131026
          ? 'WhatsApp could not deliver the last message: this number is not reachable on WhatsApp. Try email or a call.'
          : 'WhatsApp held the last message back to protect the quality of your number. Try again later or contact the customer another way.']
      ).catch(() => {});
    }
  }
}

// Meta tells us about quality drops, violations and restrictions. Anything that looks like trouble becomes a visible alert so the
// owner can open Account Quality in Meta Business Suite; a restoration clears it; an upgrade or approval does nothing.
const TROUBLE = /FLAGGED|DOWNGRADE|VIOLATION|RESTRICT|DISABLE|BANNED|REJECT/i;
async function handleAccountEvent(db, wabaId, change) {
  if (!wabaId) return;
  const v = change.value || {};
  const event = String(v.event || v.decision || v.alert_type || v.current_limit || '').slice(0, 80);
  const raw = JSON.stringify(v).slice(0, 400);
  console.warn(`[WhatsApp] Meta notice (${change.field}) for account ${wabaId}: ${raw}`);
  const restored = /RESTORED|REINSTATED|LIFTED|UNBLOCKED/i.test(event);
  if (!restored && !TROUBLE.test(event) && !TROUBLE.test(raw)) return;
  const user = await db.queryOne(`SELECT id FROM users WHERE integrations->'whatsapp'->>'wabaId' = $1 LIMIT 1`, [String(wabaId)]).catch(() => null);
  if (!user) return;
  if (restored) { await writeWaKey(db, user.id, 'alert', null); return; }
  const reason = `Meta notice: ${event || change.field}.`;
  await writeWaKey(db, user.id, 'alert', { code: 0, message: `${reason} Open Account Quality in Meta Business Suite to see the reason and appeal if it is a mistake.`, at: Date.now() });
}

// Call with the parsed webhook body. Never throws.
async function handleWebhookEvents(db, body) {
  try {
    for (const entry of (body && body.entry) || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') await handleStatuses(db, change.value);
        else if (['phone_number_quality_update', 'account_update', 'account_review_update', 'account_alerts'].includes(change.field)) await handleAccountEvent(db, entry.id, change);
      }
    }
  } catch (e) { console.warn('[WhatsApp] webhook event handling failed:', e.message); }
}

function start(db) {
  if (_timer) return;
  const run = () => tick(db).catch(e => console.error('[WhatsApp] maintenance tick failed:', e.message));
  setTimeout(run, 45_000).unref();
  _timer = setInterval(run, TICK_MS);
  _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick, handleWebhookEvents, handleStatuses, handleAccountEvent, syncUserHealth };
