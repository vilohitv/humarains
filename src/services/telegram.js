/**
 * services/telegram.js — the owner's Telegram line to the Agent.
 *
 * What it does
 *   1. Connect   The owner presses Connect in the dashboard (Channels > Telegram), opens a one-time link to the Humarains
 *                bot and taps Start. No bot token to copy: Humarains runs one bot (TELEGRAM_BOT_TOKEN) and each owner is
 *                linked to it by a single-use code that expires after 10 minutes.
 *   2. Talk      Anything the owner types goes to the same Agent as the dashboard chat (routes/agent.js runAgentTurn), with
 *                the same tools, limits and safety rules. Commands give quick answers without an AI call:
 *                /status /activity /waiting /opportunities /notify /disconnect /help
 *   3. Updates   The Agent tells the owner what it did: new enquiries, replies it sent, bookings, jobs won, recovery
 *                follow-ups, finished jobs, and anything that needs the owner (a draft waiting for approval, a chat handed
 *                over). Proposed follow-ups arrive with Send / Dismiss buttons. The owner picks how much they hear:
 *                all, important only, or off.
 *
 * How it runs (no new tables, no public webhook)
 *   - Messages arrive by long polling (getUpdates) in the worker, one process at a time (database lock, lib/jobs.js), so
 *     the bot needs no public URL and no webhook secret. The update offset lives in admin_settings.
 *   - The link and the owner's choices live in users.integrations.telegram. Update cursor, de-duplication keys and the
 *     last few chat turns live in admin_settings (tg_state:<user>, tg_hist:<user>), so the schema is untouched.
 *   - Updates to the owner are found by looking at the database since a per-owner cursor (leads, lead_messages,
 *     agent_actions, agent_proposals, agent_tasks). Nothing in the reply or booking paths had to change, and a restart can
 *     not lose or repeat an update beyond the one in flight.
 *
 * Safety
 *   - Only a chat that was linked from a logged-in dashboard session can act for an account. Group chats are ignored.
 *   - Deleting leads, resetting data and passwords stay dashboard-only (routes/agent.js TELEGRAM_BLOCKED).
 *   - Lead text shown to the owner is sent as plain text (no parse mode), so a customer cannot inject formatting or buttons.
 *   - The bot token never appears in logs or errors.
 *
 * Plain text everywhere: no emojis, no Markdown.
 */
'use strict';

const crypto = require('crypto');
const { runJob } = require('../lib/jobs');
const { dashboardUrl } = require('../lib/deeplink');

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 20;                         // long-poll length
const NOTIFY_EVERY_MS = 20_000;                    // how often the owner updates are looked for
const SETTLE_MS = 2_000;                           // ignore rows newer than this: their transaction may not be visible yet
const LOOKBACK_MS = 2 * 3600_000;                  // never report anything older than this (a long outage is not replayed)
const FULL_SWEEP_MS = 10 * 60_000;                 // every owner is checked at least this often, whatever the activity probe says
const LINK_TTL_MS = 10 * 60_000;
const HISTORY_TTL_MS = 12 * 3600_000;
const MAX_LINES_PER_MESSAGE = 8;
const RATE_PER_MIN = 15;                           // messages per chat per minute that reach the Agent (each one costs an AI call)
const NOTIFY_LEVELS = ['all', 'important', 'off'];

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const enabled = () => !!token();
const appUrl = () => (process.env.APP_URL || 'https://humarains.com').replace(/\/+$/, '');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const md5 = s => crypto.createHash('md5').update(String(s == null ? '' : s)).digest('hex').slice(0, 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// Bot API client
// ══════════════════════════════════════════════════════════════
let _apiOverride = null;                           // tests replace the network
function _setApi(fn) { _apiOverride = fn; }

function scrub(msg) {
  const t = token();
  return String(msg || '').split(t && t.length > 8 ? t : '\u0000').join('***');
}

async function api(method, body = {}, { timeoutMs = 15_000 } = {}) {
  if (_apiOverride) return _apiOverride(method, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/bot${token()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const e = new Error(`Telegram ${method} failed: ${scrub(data.description) || res.status}`);
      e.code = data.error_code || res.status;
      e.retryAfter = data.parameters && data.parameters.retry_after;
      throw e;
    }
    return data.result;
  } catch (e) {
    if (e.code !== undefined) throw e;
    const x = new Error(`Telegram ${method} ${e.name === 'AbortError' ? 'timed out' : 'could not be reached: ' + scrub(e.message)}`);
    x.code = 0;
    throw x;
  } finally { clearTimeout(timer); }
}

// File downloads (photos the owner sends). Tests replace the network with a function (path) => Buffer.
let _fileOverride = null;
function _setFileFetcher(fn) { _fileOverride = fn; }
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;       // same limit as the photo library

async function downloadFile(fileId) {
  const info = await api('getFile', { file_id: fileId });
  if (!info || !info.file_path) throw new Error('Telegram gave no file path.');
  if (info.file_size && info.file_size > MAX_PHOTO_BYTES) { const e = new Error('too big'); e.tooBig = true; throw e; }
  if (_fileOverride) return _fileOverride(info.file_path);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25_000);
  try {
    const res = await fetch(`${API_BASE}/file/bot${token()}/${info.file_path}`, { signal: ctl.signal });
    if (!res.ok) throw new Error('download failed: ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PHOTO_BYTES) { const e = new Error('too big'); e.tooBig = true; throw e; }
    return buf;
  } catch (e) { if (e.tooBig) throw e; throw new Error('Telegram photo ' + (e.name === 'AbortError' ? 'download timed out' : scrub(e.message))); }
  finally { clearTimeout(timer); }
}

/** The best photo in a Telegram message: the largest size under the library limit, or an image sent as a file. */
function photoOf(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const sizes = msg.photo.filter(p => p && p.file_id).sort((a, b) => (a.file_size || a.width * a.height || 0) - (b.file_size || b.width * b.height || 0));
    const ok = sizes.filter(p => !p.file_size || p.file_size <= MAX_PHOTO_BYTES);
    const pick = ok.length ? ok[ok.length - 1] : null;
    return pick ? { fileId: pick.file_id } : { tooBig: true };
  }
  const d = msg.document;
  if (d && d.file_id && /^image\/(jpeg|png|webp)$/i.test(d.mime_type || '')) {
    return d.file_size && d.file_size > MAX_PHOTO_BYTES ? { tooBig: true } : { fileId: d.file_id };
  }
  return null;
}

let _bot = null;
async function botInfo() {
  if (_bot && Date.now() - _bot.at < 3600_000) return _bot.info;
  const info = await api('getMe');
  _bot = { info, at: Date.now() };
  return info;
}

const canLink = url => /^https:\/\/[^\s]+$/i.test(String(url || ''));

/**
 * Send text (split below Telegram's 4096 limit). buttons: [{ text, url } | { text, data }] one per row, or an array of
 * those for several on one row. opts.silent delivers without a sound or buzz. Returns the last message sent.
 */
async function send(chatId, text, buttons, opts = {}) {
  const body = String(text == null ? '' : text).trim() || '.';
  const parts = [];
  for (let i = 0; i < body.length; i += 3900) parts.push(body.slice(i, i + 3900));
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const payload = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
    if (opts.silent) payload.disable_notification = true;
    if (i === parts.length - 1 && buttons && buttons.length) {
      const toBtn = b => (b.url ? { text: String(b.text).slice(0, 60), url: b.url } : { text: String(b.text).slice(0, 60), callback_data: String(b.data).slice(0, 64) });
      const rows = buttons
        .map(r => (Array.isArray(r) ? r : [r]).filter(b => b && b.text && ((b.url && canLink(b.url)) || b.data)).map(toBtn))
        .filter(r => r.length);
      if (rows.length) payload.reply_markup = { inline_keyboard: rows };
    }
    last = await api('sendMessage', payload);
  }
  return last;
}

// ══════════════════════════════════════════════════════════════
// Small stores (users.integrations.telegram, admin_settings)
// ══════════════════════════════════════════════════════════════
async function getKV(db, key) {
  const r = await db.queryOne('SELECT value FROM admin_settings WHERE key = $1', [key]);
  return r ? r.value : null;
}
async function setKV(db, key, value) {
  await db.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]);
}
const delKV = (db, key) => db.query('DELETE FROM admin_settings WHERE key = $1', [key]).catch(() => {});

function tgOf(user) {
  let i = user && user.integrations;
  if (typeof i === 'string') { try { i = JSON.parse(i); } catch (_) { i = null; } }
  return (i && i.telegram) || null;
}

/** Merge fields into users.integrations.telegram in one statement (other integrations are untouched). */
async function patchTelegram(db, userId, patch) {
  const r = await db.query(
    `UPDATE users SET integrations = jsonb_set(COALESCE(integrations, '{}'::jsonb), '{telegram}',
                                               COALESCE(integrations->'telegram', '{}'::jsonb) || $2::jsonb, true),
                      updated_at = now()
      WHERE id = $1 AND (integrations IS NULL OR jsonb_typeof(integrations) = 'object')`,
    [userId, JSON.stringify(patch)]);
  if (!r.rowCount) throw new Error('Could not save the Telegram settings.');
}

const userByChat = (db, chatId) =>
  db.queryOne(`SELECT * FROM users WHERE integrations->'telegram'->>'chatId' = $1`, [String(chatId)]);
const userById = (db, id) => db.queryOne('SELECT * FROM users WHERE id = $1', [id]);

// ══════════════════════════════════════════════════════════════
// Connecting
// ══════════════════════════════════════════════════════════════
async function createLink(db, userId) {
  if (!enabled()) throw new Error('Telegram is not set up on this server yet.');
  const info = await botInfo();
  const code = crypto.randomBytes(18).toString('base64url');           // 24 characters of [A-Za-z0-9_-], valid for ?start=
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  await patchTelegram(db, userId, { pending: { hash: sha(code), expiresAt } });
  return { url: `https://t.me/${info.username}?start=${code}`, expiresAt, botUsername: info.username };
}

/** Single-use: the UPDATE only matches an unexpired code and removes it in the same statement. */
async function redeemLink(db, code, chat, from) {
  const fullName = [from && from.first_name, from && from.last_name].filter(Boolean).join(' ').trim();
  const link = { chatId: String(chat.id), username: (from && from.username) || null, name: fullName || null,
                 linkedAt: new Date().toISOString(), notify: 'all', blocked: false };
  const r = await db.queryOne(
    `UPDATE users SET integrations = jsonb_set(integrations, '{telegram}', ((integrations->'telegram') - 'pending'::text) || $2::jsonb, true),
                      updated_at = now()
      WHERE integrations->'telegram'->'pending'->>'hash' = $1
        AND (integrations->'telegram'->'pending'->>'expiresAt')::timestamptz > now()
        AND is_banned = false
      RETURNING id`, [sha(code), JSON.stringify(link)]);
  if (!r) return null;
  // One chat, one account: a chat that was linked to another account is released from it.
  await db.query(
    `UPDATE users SET integrations = integrations - 'telegram', updated_at = now()
      WHERE integrations->'telegram'->>'chatId' = $1 AND id <> $2`, [String(chat.id), r.id]).catch(() => {});
  await setKV(db, `tg_state:${r.id}`, JSON.stringify({ cursor: new Date().toISOString(), seen: {} })).catch(() => {});
  await delKV(db, `tg_hist:${r.id}`); await delKV(db, `tg_msgs:${r.id}`);
  return r.id;
}

async function unlink(db, userId, { tell = true } = {}) {
  const user = await userById(db, userId);
  const tg = tgOf(user);
  if (tg && tg.chatId && tell && enabled()) await send(tg.chatId, 'Telegram is disconnected from your Humarains account. You will not get updates here any more. Connect it again from Channels > Telegram in the dashboard whenever you like.').catch(() => {});
  await db.query(`UPDATE users SET integrations = integrations - 'telegram', updated_at = now() WHERE id = $1 AND jsonb_typeof(integrations) = 'object'`, [userId]);
  await delKV(db, `tg_state:${userId}`); await delKV(db, `tg_hist:${userId}`); await delKV(db, `tg_msgs:${userId}`);
}

async function setNotify(db, userId, level) {
  if (!NOTIFY_LEVELS.includes(level)) throw new Error('Choose all, important or off.');
  await patchTelegram(db, userId, { notify: level });
  return level;
}

async function status(db, user) {
  const tg = tgOf(user);
  const out = { configured: enabled(), connected: false, notify: 'all' };
  if (enabled()) { try { out.botUsername = (await botInfo()).username; } catch (_) { out.botError = true; } }
  if (tg && tg.chatId) {
    Object.assign(out, { connected: true, name: tg.name || null, username: tg.username || null, linkedAt: tg.linkedAt || null,
                         notify: NOTIFY_LEVELS.includes(tg.notify) ? tg.notify : 'all', blocked: !!tg.blocked });
  } else if (tg && tg.pending && new Date(tg.pending.expiresAt).getTime() > Date.now()) {
    out.linkPending = true;
  }
  return out;
}

async function sendTest(db, user) {
  const tg = tgOf(user);
  if (!tg || !tg.chatId) throw new Error('Telegram is not connected.');
  await send(tg.chatId, 'Test message from Humarains. Telegram is connected: you will get the Agent\'s updates here, and you can message me to give it tasks.');
  if (tg.blocked) await patchTelegram(db, user.id, { blocked: false }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// Text helpers
// ══════════════════════════════════════════════════════════════
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const leadName = r => r.customer_name || r.from_name || r.from_email || r.from_phone || 'a customer';
const isWhatsApp = r => String(r.source || r.channel || '').toLowerCase() === 'whatsapp' || !!r.whatsapp_thread_phone;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const CUR = { USD: '$', EUR: '€', GBP: '£', SGD: 'S$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$' };
const money = (settings, n) => {
  const v = Math.round(Number(n) || 0);
  if (!v) return '';
  const c = (settings && settings.currency) || 'USD';
  return (CUR[c] || c + ' ') + v.toLocaleString('en-US');
};
const KIND_LABEL = { reengage: 'follow-up', discount: 'discount offer', missed_call: 'missed-call text', review: 'review request', winback: 'win-back message' };
const leadLink = (view, id) => dashboardUrl(appUrl(), { view, lead: id });

const HELP = [
  'I am the Humarains Agent, on Telegram. Message me like you would in the dashboard: ask what is happening, or give me a task ("follow up with everyone who asked for a quote this week").',
  '',
  'Send me photos and I will save them to your photo library and look at them. Tell me who to send them to ("send these to Ann") and I will send them on the customer\'s channel.',
  '',
  'When I hand a chat to you, reply to my message and I will send your answer to the customer. When I draft a reply, tap Send it or Do not send.',
  '',
  'Quick commands',
  '/status  the last 24 hours at a glance',
  '/activity  what I did recently',
  '/waiting  customers waiting on you, with buttons to act',
  '/today  your appointments today and tomorrow',
  '/opportunities  follow-ups I have ready',
  '/notify all | important | off  how much I tell you',
  '/quiet 22:00 07:00  no sound overnight (/quiet off to switch off)',
  '/disconnect  stop using Telegram',
  '',
  'Deleting leads, resetting data and passwords can only be done in the dashboard.',
].join('\n');

// ══════════════════════════════════════════════════════════════
// Events: what the Agent did (read from the database)
// ══════════════════════════════════════════════════════════════
/**
 * Everything worth telling this owner that happened in (from, upper]. Returns
 *   { events: [{ at, text, important, button? }], proposals: [row], seen }
 * `seen` is the owner's de-duplication map (keys for things that can be updated repeatedly, such as a draft or a handover).
 * Pure reads; nothing is sent here.
 */
async function collectEvents(db, user, from, upper, seen = {}, opts = {}) {
  const uid = user.id;
  const f = from instanceof Date ? from : new Date(from);
  const u = upper instanceof Date ? upper : new Date(upper);
  const events = [];
  const newSeen = { ...seen };
  const once = key => { if (newSeen[key]) return false; newSeen[key] = Date.now(); return true; };
  const q = (sql, params) => db.queryAll(sql, params).catch(e => { console.error('[Telegram] event query failed:', e.message); return []; });

  const [fresh, replies, review, drafts, booked, won, actions, props, tasks, inbound] = await Promise.all([
    q(`SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, last_customer_message, raw_body, subject, created_at
         FROM leads WHERE user_id = $1 AND source <> 'test' AND created_at > $2 AND created_at <= $3 ORDER BY created_at LIMIT 25`, [uid, f, u]),
    q(`SELECT m.lead_id, m.channel, m.body, COALESCE(m.sent_at, m.created_at) AS evt_at,
              l.customer_name, l.from_name, l.from_email, l.from_phone
         FROM lead_messages m JOIN leads l ON l.id = m.lead_id
        WHERE m.user_id = $1 AND m.direction = 'outbound' AND m.pending = false AND l.source <> 'test'
          AND COALESCE(m.sent_at, m.created_at) > $2 AND COALESCE(m.sent_at, m.created_at) <= $3
          AND COALESCE(l.human_reply->>'body', '') <> m.body
          AND m.body <> ''
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.conversation_history) = 'array' THEN l.conversation_history ELSE '[]'::jsonb END) t
                           WHERE t->>'source' = 'owner' AND t->>'body' = m.body)
          AND NOT (l.approved_at IS NOT NULL AND ABS(EXTRACT(EPOCH FROM (COALESCE(m.sent_at, m.created_at) - l.approved_at))) < 60)
        ORDER BY evt_at LIMIT 40`, [uid, f, u]),
    q(`SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, human_review_reason, last_customer_message, updated_at
         FROM leads WHERE user_id = $1 AND source <> 'test' AND needs_human_review = true AND updated_at > $2 AND updated_at <= $3
          AND COALESCE(human_review_reason, '') <> 'You paused the AI on this chat in the Inbox.' ORDER BY updated_at LIMIT 15`, [uid, f, u]),
    q(`SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, ai_reply->>'body' AS draft_body, last_customer_message, updated_at
         FROM leads WHERE user_id = $1 AND source <> 'test' AND pending_approval = true AND updated_at > $2 AND updated_at <= $3 ORDER BY updated_at LIMIT 15`, [uid, f, u]),
    q(`SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, calendar_event_id, calendar_event_link, updated_at
         FROM leads WHERE user_id = $1 AND source <> 'test' AND calendar_event_id IS NOT NULL AND updated_at > $2 AND updated_at <= $3 ORDER BY updated_at LIMIT 15`, [uid, f, u]),
    q(`SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, deal_value, won_at
         FROM leads WHERE user_id = $1 AND source <> 'test' AND won_at > $2 AND won_at <= $3 ORDER BY won_at LIMIT 15`, [uid, f, u]),
    q(`SELECT a.id, a.kind, a.status, a.channel, a.reason, a.done_at, l.customer_name, l.from_name, l.from_email, l.from_phone
         FROM agent_actions a LEFT JOIN leads l ON l.id = a.lead_id
        WHERE a.user_id = $1 AND a.status IN ('sent', 'failed') AND a.done_at > $2 AND a.done_at <= $3 ORDER BY a.done_at LIMIT 25`, [uid, f, u]),
    q(`SELECT id, kind, title, rationale, est_value, draft, created_at FROM agent_proposals
        WHERE user_id = $1 AND status = 'pending' AND created_at > $2 AND created_at <= $3 ORDER BY created_at LIMIT 4`, [uid, f, u]),
    q(`SELECT id, name, status, sent, queued, skipped, failed, finished_at FROM agent_tasks
        WHERE user_id = $1 AND finished_at > $2 AND finished_at <= $3 AND status IN ('completed', 'cancelled') ORDER BY finished_at LIMIT 10`, [uid, f, u]),
    // A customer writing back on an existing chat (the first message of a new lead is the "new enquiry" line instead).
    q(`SELECT m.lead_id, m.channel, m.body, m.created_at AS evt_at, l.customer_name, l.from_name, l.from_email, l.from_phone
         FROM lead_messages m JOIN leads l ON l.id = m.lead_id
        WHERE m.user_id = $1 AND m.direction = 'inbound' AND l.source <> 'test' AND m.created_at > $2 AND m.created_at <= $3
          AND l.created_at < $2 AND l.needs_human_review IS NOT TRUE AND l.pending_approval IS NOT TRUE
        ORDER BY m.created_at LIMIT 30`, [uid, f, u]),
  ]);

  let settings = null;
  const needSettings = async () => settings || (settings = await require('../routes/leads').getSettings(uid, db).catch(() => ({})));

  for (const r of fresh) {
    const what = clip(r.last_customer_message || r.raw_body || r.subject || '', 140);
    events.push({ at: r.created_at, important: true,
      text: `New enquiry from ${leadName(r)}${isWhatsApp(r) ? ' on WhatsApp' : r.from_email ? ' by email' : ''}${what ? `: "${what}"` : '.'}` });
  }
  for (const r of replies) {
    events.push({ at: r.evt_at, important: false,
      text: `Replied to ${leadName(r)} on ${String(r.channel) === 'whatsapp' ? 'WhatsApp' : 'email'}: "${clip(r.body, 150)}"` });
  }
  for (const r of inbound) {
    events.push({ at: r.evt_at, important: false,
      text: `${leadName(r)} wrote back${String(r.channel) === 'whatsapp' ? ' on WhatsApp' : ''}: "${clip(r.body, 150)}"` });
  }
  // These two need the owner, so they are sent as their own messages with buttons / a reply prompt (see sendInteractive).
  for (const r of review) {
    if (!once(`review:${r.id}:${md5(r.human_review_reason)}`)) continue;
    events.push({ at: r.updated_at, important: true, kind: 'review', leadId: r.id, name: leadName(r), via: isWhatsApp(r) ? 'WhatsApp' : 'email',
      reason: r.human_review_reason, customerMsg: r.last_customer_message,
      text: `Needs you: ${leadName(r)}. ${clip(r.human_review_reason || 'I handed this chat to you.', 200)}` });
  }
  for (const r of drafts) {
    if (!r.draft_body || !once(`draft:${r.id}:${md5(r.draft_body)}`)) continue;
    events.push({ at: r.updated_at, important: true, kind: 'draft', leadId: r.id, name: leadName(r), via: isWhatsApp(r) ? 'WhatsApp' : 'email',
      draft: r.draft_body, customerMsg: r.last_customer_message,
      text: `Draft waiting for your OK for ${leadName(r)}: "${clip(r.draft_body, 160)}"` });
  }
  for (const r of booked) {
    if (!once(`booked:${r.id}:${r.calendar_event_id}`)) continue;
    events.push({ at: r.updated_at, important: true,
      button: r.calendar_event_link ? { text: `Open ${clip(leadName(r), 24)} in calendar`, url: r.calendar_event_link } : undefined,
      text: `Booked ${leadName(r)} in your calendar.` });
  }
  for (const r of won) {
    const v = r.deal_value ? money(await needSettings(), r.deal_value) : '';
    events.push({ at: r.won_at, important: true, text: `Marked won: ${leadName(r)}${v ? ' (' + v + ')' : ''}.` });
  }
  for (const r of actions) {
    const label = KIND_LABEL[r.kind] || 'message';
    const who = leadName(r);
    events.push({ at: r.done_at, important: true,
      text: r.status === 'sent'
        ? `Sent a ${label} to ${who} by ${r.channel === 'whatsapp' ? 'WhatsApp' : 'email'}.`
        : `Could not send a ${label} to ${who}${r.reason ? ': ' + clip(r.reason, 120) : '.'}` });
  }
  for (const r of tasks) {
    const bits = [];
    if (r.sent) bits.push(`${r.sent} sent`);
    if (r.queued) bits.push(`${r.queued} waiting for your approval`);
    if (r.skipped) bits.push(`${r.skipped} skipped`);
    if (r.failed) bits.push(`${r.failed} failed`);
    events.push({ at: r.finished_at, important: true,
      text: `${r.status === 'cancelled' ? 'Stopped' : 'Finished'} "${clip(r.name, 60)}"${bits.length ? ': ' + bits.join(', ') : '.'}` });
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  const proposals = [];
  if (!opts.noProposals) {
    const cur = await needSettings().catch(() => ({}));
    for (const p of props) proposals.push({ ...p, valueText: money(cur, p.est_value) });
  }
  // Keep the de-duplication map small: forget keys older than a week.
  for (const k of Object.keys(newSeen)) if (Date.now() - newSeen[k] > 7 * 86400_000) delete newSeen[k];
  return { events, proposals, seen: newSeen };
}

/** One message for a batch of events: each on its own line, or a count and the latest few when there are many. */
function composeDigest(events) {
  if (!events.length) return null;
  const lines = events.map(e => '- ' + e.text);
  let text;
  if (events.length === 1) text = events[0].text;
  else if (events.length <= MAX_LINES_PER_MESSAGE) text = `${events.length} updates from your Agent\n\n` + lines.join('\n');
  else {
    const n = c => events.filter(e => c.test(e.text)).length;
    const parts = [
      [n(/^New enquiry/), 'new enquiries'], [n(/^Replied/), 'replies sent'], [n(/^Booked/), 'bookings'],
      [n(/^Marked won/), 'jobs won'], [n(/^(Needs you|Draft waiting)/), 'waiting on you'],
      [n(/^(Sent a|Could not send)/), 'follow-ups'], [n(/^(Finished|Stopped)/), 'finished jobs'],
    ].filter(([c]) => c).map(([c, l]) => `${c} ${l}`);
    text = `${events.length} updates from your Agent: ${parts.join(', ')}.\n\nLatest\n` + lines.slice(-5).join('\n');
  }
  const buttons = events.filter(e => e.button).map(e => e.button).slice(-3);
  return { text: text.slice(0, 3800), buttons };
}

async function sendProposal(chatId, p, opts = {}) {
  const value = p.valueText ? ` Worth about ${p.valueText}.` : '';
  const text = `${clip(p.title, 120)}\n${clip(p.rationale, 220)}${value}\n\nDraft: "${clip(p.draft, 320)}"`;
  const buttons = String(p.id).length <= 56
    ? [[{ text: 'Send it', data: `opp:a:${p.id}` }, { text: 'Dismiss', data: `opp:d:${p.id}` }]]
    : [{ text: 'Open in the dashboard', url: dashboardUrl(appUrl(), { view: 'leads', ask: 'opportunities' }) }];
  return send(chatId, text, buttons, opts);
}

/**
 * A draft waiting for approval, or a chat handed over to the owner: each is its own message so the owner can act on it.
 *   draft   Send it / Do not send buttons (the same send path as the dashboard), plus a link to open it.
 *   review  Reply to this message to answer the customer, or tap Hand back to let the Agent carry on.
 */
async function sendInteractive(db, userId, chatId, e, opts = {}) {
  const said = e.customerMsg ? `${e.name} wrote: "${clip(e.customerMsg, 220)}"\n\n` : '';
  if (e.kind === 'draft') {
    return send(chatId, `Draft ready for ${e.name} (${e.via})\n\n${said}My reply: "${clip(e.draft, 500)}"`, [
      [{ text: 'Send it', data: `dr:a:${e.leadId}` }, { text: 'Do not send', data: `dr:r:${e.leadId}` }],
      { text: 'Open in dashboard', url: leadLink('humanreview', e.leadId) },
    ], opts);
  }
  const m = await send(chatId, `Needs you: ${e.name} (${e.via})\n${clip(e.reason || 'I handed this chat to you.', 240)}\n\n${said}Reply to this message and I will send your answer to ${e.name} on ${e.via}.`, [
    { text: 'Hand back to the Agent', data: `hb:${e.leadId}` },
    { text: 'Open in dashboard', url: leadLink('humanreview', e.leadId) },
  ], opts);
  if (m && m.message_id) await rememberReply(db, userId, m.message_id, e.leadId);
  return m;
}

// ── Quiet hours: updates still arrive, but without a sound, between the owner's chosen times (their business time zone) ──
function parseClock(str) {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/i.exec(String(str || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = m[2] ? parseInt(m[2], 10) : 0; const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
function localMinutes(tz, now = new Date()) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now); }
  catch (_) { parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now); }
  const g = t => parseInt((parts.find(p => p.type === t) || {}).value, 10) || 0;
  return (g('hour') % 24) * 60 + g('minute');
}
function isQuiet(quiet, tz, now = new Date()) {
  if (!quiet || !quiet.from || !quiet.to) return false;
  const a = toMin(quiet.from), b = toMin(quiet.to), t = localMinutes(tz, now);
  if (a === b) return false;
  return a < b ? (t >= a && t < b) : (t >= a || t < b);
}
async function ownerTimezone(db, userId) {
  try { return (await require('../routes/leads').getSettings(userId, db)).timezone || 'UTC'; } catch (_) { return 'UTC'; }
}

// ── Notifier ────────────────────────────────────────────────────────────────
// "Reply to this message to answer the customer": Telegram message id -> lead. Its own key, so the notifier's state
// writes can never overwrite a mapping made while it was running. Only the newest 80 are kept.
async function rememberReply(db, userId, messageId, leadId) {
  if (!messageId || !leadId) return;
  let map = {};
  try { map = JSON.parse((await getKV(db, `tg_msgs:${userId}`)) || '{}') || {}; } catch (_) {}
  map[String(messageId)] = leadId;
  const keys = Object.keys(map);
  if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete map[k];
  await setKV(db, `tg_msgs:${userId}`, JSON.stringify(map)).catch(() => {});
}
async function lookupReply(db, userId, messageId) {
  try { return (JSON.parse((await getKV(db, `tg_msgs:${userId}`)) || '{}') || {})[String(messageId)] || null; } catch (_) { return null; }
}

async function loadState(db, userId) {
  try { const raw = await getKV(db, `tg_state:${userId}`); const s = raw ? JSON.parse(raw) : null; return s && typeof s === 'object' ? s : {}; }
  catch (_) { return {}; }
}
const memCursor = new Map();                       // userId -> Date: where the last look ended (not persisted unless something was sent)

async function notifyUser(db, user) {
  const tg = tgOf(user);
  if (!tg || !tg.chatId || tg.blocked) return 0;
  const level = NOTIFY_LEVELS.includes(tg.notify) ? tg.notify : 'all';
  if (level === 'off') return 0;

  const state = await loadState(db, user.id);
  const upper = new Date(Date.now() - SETTLE_MS);
  // Newest of: this process's last look, and the cursor saved after the last send (which another process may have written).
  let from = new Date(Math.max(
    memCursor.get(user.id) ? memCursor.get(user.id).getTime() : 0,
    state.cursor ? new Date(state.cursor).getTime() : 0,
    new Date(tg.linkedAt || Date.now()).getTime()));
  const floor = new Date(Date.now() - LOOKBACK_MS);
  if (from < floor) from = floor;
  if (tg.linkedAt && from < new Date(tg.linkedAt)) from = new Date(tg.linkedAt);   // never report what happened before the link
  if (from >= upper) return 0;

  const { events, proposals, seen } = await collectEvents(db, user, from, upper, state.seen || {});
  const chosen = level === 'important' ? events.filter(e => e.important) : events;
  if (!chosen.length && !proposals.length) { memCursor.set(user.id, upper); return 0; }

  const quiet = isQuiet(tg.quiet, tg.quiet ? await ownerTimezone(db, user.id) : null);   // inside the owner's quiet hours everything is silent
  try {
    const interactive = chosen.filter(e => e.kind === 'review' || e.kind === 'draft');
    const rest = chosen.filter(e => !interactive.includes(e));
    const digest = composeDigest(rest);
    // Routine news arrives silently; anything that matters or needs the owner makes a sound.
    if (digest) await send(tg.chatId, digest.text, digest.buttons, { silent: quiet || !rest.some(e => e.important) });
    for (const e of interactive) await sendInteractive(db, user.id, tg.chatId, e, { silent: quiet });
    for (const p of proposals) await sendProposal(tg.chatId, p, { silent: quiet });
  } catch (e) {
    if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
      await patchTelegram(db, user.id, { blocked: true }).catch(() => {});
      console.log(`[Telegram] user ${user.id} blocked the bot; updates paused until they message it again`);
      return 0;
    }
    if (e.code === 429) { await sleep(Math.min(5000, (e.retryAfter || 1) * 1000)); return 0; }
    throw e;                                       // cursor not advanced: the next cycle tries again
  }
  // Send first, then record. A crash in between repeats one batch rather than losing it.
  await setKV(db, `tg_state:${user.id}`, JSON.stringify({ cursor: upper.toISOString(), seen }));
  memCursor.set(user.id, upper);
  return chosen.length + proposals.length;
}

let _lastSweep = 0;
async function notifyCycle(db) {
  if (!enabled()) return 0;
  const sweep = Date.now() - _lastSweep > FULL_SWEEP_MS;
  let users;
  if (sweep) {
    users = await db.queryAll(`SELECT * FROM users WHERE integrations->'telegram'->>'chatId' IS NOT NULL AND is_banned = false`, []);
    _lastSweep = Date.now();
  } else {
    // Cheap probe: only owners with something new in the last couple of minutes are looked at in full.
    users = await db.queryAll(
      `SELECT u.* FROM users u WHERE u.integrations->'telegram'->>'chatId' IS NOT NULL AND u.is_banned = false AND u.id IN (
         SELECT user_id FROM leads WHERE updated_at > now() - interval '3 minutes' OR won_at > now() - interval '3 minutes'
         UNION SELECT user_id FROM lead_messages WHERE created_at > now() - interval '3 minutes' OR sent_at > now() - interval '3 minutes'
         UNION SELECT user_id FROM agent_actions WHERE done_at > now() - interval '3 minutes'
         UNION SELECT user_id FROM agent_proposals WHERE created_at > now() - interval '3 minutes'
         UNION SELECT user_id FROM agent_tasks WHERE finished_at > now() - interval '3 minutes')`, []);
  }
  let sent = 0;
  for (const u of users) {
    try { sent += await notifyUser(db, u); }
    catch (e) { console.error(`[Telegram] update for user ${u.id} failed:`, scrub(e.message)); }
  }
  return sent;
}

/** The morning briefing, on Telegram as well as by email (called from services/agent/proactive.js). */
async function sendBriefing(db, user, data, settings) {
  if (!enabled()) return false;
  const row = await userById(db, user.id);
  const tg = tgOf(row);
  if (!tg || !tg.chatId || tg.blocked || tg.notify === 'off') return false;
  const worth = (data.opportunities || []).reduce((n, o) => n + (Number(o.estValue) || 0), 0);
  const lines = ['Good morning. Here is where things stand.', ''];
  lines.push(`New enquiries: ${data.newLeads}`, `Replies sent: ${data.replied}`);
  if (data.won) lines.push(`Won: ${data.won}${data.wonValue ? ' (' + money(settings, data.wonValue) + ')' : ''}`);
  if (data.agentDid && data.agentDid.total) lines.push(`Follow-ups I sent on my own: ${data.agentDid.total}`);
  lines.push(`Waiting on you: ${data.waiting}${data.waiting ? ` (${plural(data.waitingApprovals, 'draft')}, ${plural(data.waitingHuman, 'handed-over chat')})` : ''}`);
  if ((data.opportunities || []).length) lines.push(`Follow-ups ready: ${data.opportunities.length}${worth ? ', worth about ' + money(settings, worth) : ''}`);
  if (data.waiting || (data.opportunities || []).length) lines.push('', 'Send /waiting or /opportunities and I will show you.');
  await send(tg.chatId, lines.join('\n'), data.waiting ? [{ text: 'Open Review', url: dashboardUrl(appUrl(), { view: 'humanreview' }) }] : null, { silent: true })
    .catch(e => console.error('[Telegram] briefing failed:', scrub(e.message)));
  return true;
}

// ══════════════════════════════════════════════════════════════
// Incoming messages
// ══════════════════════════════════════════════════════════════
const rate = new Map();                            // chatId -> [timestamps]
function limited(chatId) {
  const now = Date.now();
  const arr = (rate.get(chatId) || []).filter(t => now - t < 60_000);
  arr.push(now); rate.set(chatId, arr);
  if (rate.size > 5000) for (const [k, v] of rate) if (!v.some(t => now - t < 60_000)) rate.delete(k);
  return arr.length > RATE_PER_MIN;
}

async function loadHistory(db, userId) {
  try {
    const raw = await getKV(db, `tg_hist:${userId}`);
    const h = raw ? JSON.parse(raw) : null;
    if (!h || !Array.isArray(h.m) || Date.now() - h.t > HISTORY_TTL_MS) return [];
    return h.m;
  } catch (_) { return []; }
}
async function saveHistory(db, userId, history, userText, reply) {
  const m = [...history, { role: 'user', content: String(userText).slice(0, 1500) }, { role: 'assistant', content: String(reply).slice(0, 1500) }].slice(-10);
  await setKV(db, `tg_hist:${userId}`, JSON.stringify({ t: Date.now(), m })).catch(() => {});
}

async function handleLinkStart(db, msg, code) {
  const chat = msg.chat;
  const userId = await redeemLink(db, code, chat, msg.from);
  if (!userId) {
    return send(chat.id, 'That connection link is invalid or has expired. Open Channels > Telegram in the Humarains dashboard and press Connect to get a new one.');
  }
  let business = '';
  try { business = (await require('../routes/leads').getSettings(userId, db)).businessName || ''; } catch (_) {}
  return send(chat.id, [
    `Connected${business ? ' to ' + business : ''}. I am your Humarains Agent.`,
    '',
    'From now on I will tell you here what I do: new enquiries, replies I send, bookings, and anything that needs you. You can also message me to give me tasks or ask how things are going.',
    '',
    'Send /help to see the quick commands, or /notify to change how much I tell you.',
  ].join('\n'));
}

async function cmdStatus(db, user, chatId) {
  const one = async (sql) => { const r = await db.queryOne(sql, [user.id]).catch(() => null); return r ? Number(r.c) || 0 : 0; };
  const [fresh, replies, drafts, handed] = await Promise.all([
    one(`SELECT COUNT(*)::int AS c FROM leads WHERE user_id = $1 AND source <> 'test' AND created_at > now() - interval '24 hours'`),
    one(`SELECT COUNT(*)::int AS c FROM lead_messages m JOIN leads l ON l.id = m.lead_id WHERE m.user_id = $1 AND m.direction = 'outbound' AND m.pending = false AND l.source <> 'test' AND COALESCE(m.sent_at, m.created_at) > now() - interval '24 hours'`),
    one(`SELECT COUNT(*)::int AS c FROM leads WHERE user_id = $1 AND source <> 'test' AND status <> 'closed' AND pending_approval = true`),
    one(`SELECT COUNT(*)::int AS c FROM leads WHERE user_id = $1 AND source <> 'test' AND status <> 'closed' AND needs_human_review = true AND COALESCE(human_review_reason, '') <> 'You paused the AI on this chat in the Inbox.'`),
  ]);
  let opp = 0;
  try { opp = (await require('./agent/proactive').listOpportunities(db, user.id, { includeRecent: false })).pending.length; } catch (_) {}
  const waiting = drafts + handed;
  return send(chatId, [
    'Last 24 hours',
    `New enquiries: ${fresh}`,
    `Replies sent: ${replies}`,
    `Waiting on you: ${waiting}${waiting ? ` (${plural(drafts, 'draft')}, ${plural(handed, 'handed-over chat')})` : ''}`,
    `Follow-ups I have ready: ${opp}`,
  ].join('\n'), waiting ? [{ text: 'Open Review', url: dashboardUrl(appUrl(), { view: 'humanreview' }) }] : null);
}

async function cmdActivity(db, user, chatId) {
  const now = new Date(Date.now() - SETTLE_MS);
  const { events } = await collectEvents(db, user, new Date(Date.now() - 24 * 3600_000), now, {}, { noProposals: true });
  if (!events.length) return send(chatId, 'Nothing has happened in the last 24 hours.');
  const last = events.slice(-10);
  return send(chatId, `Latest activity (${last.length} of ${events.length} in the last 24 hours)\n\n` + last.map(e => '- ' + e.text).join('\n'));
}

/** Everyone waiting on the owner (handed over, or a draft to approve), oldest first, shaped like the update events. */
async function waitingEvents(db, user, limit = 6) {
  const rows = await db.queryAll(
    `SELECT id, source, customer_name, from_name, from_email, from_phone, whatsapp_thread_phone, pending_approval, needs_human_review,
            human_review_reason, last_customer_message, last_customer_message_at, ai_reply->>'body' AS draft_body
       FROM leads WHERE user_id = $1 AND source <> 'test' AND status <> 'closed' AND (pending_approval = true OR needs_human_review = true)
        AND COALESCE(human_review_reason, '') <> 'You paused the AI on this chat in the Inbox.'
      ORDER BY last_customer_message_at ASC NULLS LAST LIMIT $2`, [user.id, limit + 1]).catch(() => []);
  const events = rows.slice(0, limit).map(r => {
    const base = { leadId: r.id, name: leadName(r), via: isWhatsApp(r) ? 'WhatsApp' : 'email', customerMsg: r.last_customer_message, waitingSince: r.last_customer_message_at };
    return r.needs_human_review ? { ...base, kind: 'review', reason: r.human_review_reason }
                                : { ...base, kind: 'draft', draft: r.draft_body || '' };
  }).filter(e => e.kind === 'review' || e.draft);
  return { events, more: rows.length > limit };
}

/** The waiting customers as messages the owner can act on. Returns how many were sent. */
async function sendWaitingCards(db, user, chatId, limit = 5) {
  const { events, more } = await waitingEvents(db, user, limit);
  for (const e of events) await sendInteractive(db, user.id, chatId, e);
  if (more) await send(chatId, 'There are more waiting. Open Review in the dashboard to see them all.', [{ text: 'Open Review', url: dashboardUrl(appUrl(), { view: 'humanreview' }) }]);
  return events.length;
}

async function cmdWaiting(db, user, chatId) {
  const { events } = await waitingEvents(db, user, 5);
  if (!events.length) return send(chatId, 'Nobody is waiting on you right now.');
  const drafts = events.filter(e => e.kind === 'draft').length, handed = events.length - drafts;
  await send(chatId, `${plural(events.length, 'customer is', 'customers are')} waiting on you: ${plural(drafts, 'draft')} to approve, ${plural(handed, 'chat')} handed over.`, null, { silent: true });
  return sendWaitingCards(db, user, chatId, 5);
}

async function cmdOpportunities(db, user, chatId) {
  const o = await require('./agent/proactive').listOpportunities(db, user.id, { includeRecent: false });
  if (!o.pending.length) return send(chatId, 'No follow-ups ready right now. I re-check every few hours.');
  const cur = await require('../routes/leads').getSettings(user.id, db).catch(() => ({}));
  for (const p of o.pending.slice(0, 4)) {
    await sendProposal(chatId, { id: p.id, title: p.title, rationale: p.rationale, draft: p.draft, valueText: money(cur, p.estValue) });
  }
}

/** Today's and tomorrow's appointments from the connected Google Calendar, with no AI call. */
async function cmdToday(db, user, chatId) {
  const { HANDLERS, makeCtx } = require('../routes/agent')._internal;
  const settings = await require('../routes/leads').getSettings(user.id, db).catch(() => ({}));
  const ctx = makeCtx(db, user, settings); ctx.channel = 'telegram';
  const r = await HANDLERS.upcoming_appointments(ctx, { days: 3 });
  if (!r.ok) {
    return send(chatId, /not connected/i.test(r.error || '') ? 'Google Calendar is not connected yet, so I cannot show your day. Connect it in the dashboard and send /today again.' : (r.error || 'I could not read your calendar right now.'),
      /not connected/i.test(r.error || '') ? [{ text: 'Connect Google Calendar', url: dashboardUrl(appUrl(), { view: 'calendar' }) }] : null);
  }
  const tz = settings.timezone || 'UTC';
  const dayKey = d => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); } catch (_) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(d); } };
  const today = dayKey(new Date()), tomorrow = dayKey(new Date(Date.now() + 86400_000));
  const clock = d => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d); } catch (_) { return ''; } };
  const lineFor = e => {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(e.start));
    return `${allDay ? 'All day' : clock(new Date(e.start))}  ${e.title || 'Appointment'}${e.location ? ' (' + e.location + ')' : ''}`;
  };
  const dayOf = e => (/^\d{4}-\d{2}-\d{2}$/.test(String(e.start)) ? String(e.start) : dayKey(new Date(e.start)));
  const mine = r.events.filter(e => e.start);
  const t = mine.filter(e => dayOf(e) === today), n = mine.filter(e => dayOf(e) === tomorrow);
  const out = [t.length ? `Today (${plural(t.length, 'appointment')})\n` + t.map(lineFor).join('\n') : 'Nothing on your calendar today.'];
  if (n.length) out.push(`Tomorrow (${plural(n.length, 'appointment')})\n` + n.map(lineFor).join('\n'));
  return send(chatId, out.join('\n\n'));
}

async function cmdQuiet(db, user, chatId, arg) {
  const tg = tgOf(user) || {};
  const a = String(arg || '').trim().toLowerCase();
  if (!a) {
    return send(chatId, tg.quiet && tg.quiet.from
      ? `Quiet hours are ${tg.quiet.from} to ${tg.quiet.to} (your business time zone). Updates still arrive, without a sound.\n\n/quiet off turns them off, or send /quiet 22:00 07:00 to change them.`
      : 'Quiet hours are off. To get updates without a sound overnight, send for example /quiet 22:00 07:00.');
  }
  if (a === 'off' || a === 'none') { await patchTelegram(db, user.id, { quiet: null }); return send(chatId, 'Quiet hours are off. Anything that needs you will make a sound again.'); }
  const bits = a.replace(/\s*(?:-|–|to|until)\s*/g, ' ').split(/\s+/).filter(Boolean);
  const from = parseClock(bits[0]), to = parseClock(bits[1]);
  if (bits.length !== 2 || !from || !to || from === to) return send(chatId, 'Send two different times, for example /quiet 22:00 07:00 or /quiet 10pm 7am. Use /quiet off to switch it off.');
  await patchTelegram(db, user.id, { quiet: { from, to } });
  return send(chatId, `Quiet hours set: ${from} to ${to}. Updates still arrive in that time, just without a sound.`);
}

async function cmdNotify(db, user, chatId, arg) {
  const tg = tgOf(user) || {};
  const want = String(arg || '').toLowerCase().trim();
  if (!want) {
    return send(chatId, `I currently tell you about: ${NOTIFY_LEVELS.includes(tg.notify) ? tg.notify : 'all'}.\n\n/notify all  everything I do\n/notify important  only what needs you or matters (new enquiries, bookings, wins, follow-ups)\n/notify off  nothing (you can still message me)`);
  }
  if (!NOTIFY_LEVELS.includes(want)) return send(chatId, 'Use /notify all, /notify important or /notify off.');
  await setNotify(db, user.id, want);
  return send(chatId, want === 'off' ? 'Updates are off. You can still message me any time, and turn them back on with /notify all.'
    : want === 'important' ? 'Got it. I will only tell you what needs you or really matters.' : 'Got it. I will tell you about everything I do.');
}

/** Turn what the Agent returned into a Telegram reply: its text, plus links for the pages and leads it would have opened. */
function agentPayload(out) {
  const { PAGES } = require('../routes/agent');
  const buttons = []; const seen = new Set(); const cards = [];
  for (const ui of out.ui || []) {
    if (ui.type === 'approvals') cards.push({ type: 'approvals' });
    else if (ui.type === 'confirm' && ui.confirm && ui.confirm.workflowId) cards.push({ type: 'confirm', confirm: ui.confirm });
    else if (ui.type === 'open' && PAGES[ui.page] && !seen.has('p:' + ui.page)) {
      seen.add('p:' + ui.page);
      buttons.push({ text: 'Open ' + PAGES[ui.page].split(/[:—]/)[0].trim().toLowerCase(), url: dashboardUrl(appUrl(), { view: ui.page }) });
    } else if (ui.type === 'lead' && ui.id && !seen.has('l:' + ui.id)) {
      seen.add('l:' + ui.id);
      buttons.push({ text: 'Open this lead', url: leadLink('leads', ui.id) });
    }
  }
  let text = String(out.reply || '').trim();
  const leads = cards.some(c => c.type === 'approvals') ? [] : (out.leads || []).slice(0, 6);   // the drafts arrive as their own messages
  if (leads.length) {
    text += '\n\n' + leads.map(l => `- ${l.name}${l.status ? ' (' + String(l.status).replace('_', ' ') + ')' : ''}${l.needsYou ? ', needs you' : l.awaitingApproval ? ', draft waiting' : ''}${l.summary ? ': ' + clip(l.summary, 80) : ''}`).join('\n');
    if ((out.leads || []).length > leads.length) text += `\n...and ${(out.leads || []).length - leads.length} more in the dashboard.`;
  }
  return { text, buttons: buttons.slice(0, 3), cards };
}

async function agentTurn(db, user, chatId, text, extra = {}) {
  const ping = () => api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4000);
  try {
    const history = await loadHistory(db, user.id);
    const out = await require('../routes/agent').runAgentTurn(db, user, { message: text, history, channel: 'telegram', photoIds: extra.photoIds || [], images: extra.images || [] });
    const { text: reply, buttons, cards } = agentPayload(out);
    // The ids stay in the history so a later "send that photo to Ann" can name them.
    const note = extra.photoIds && extra.photoIds.length ? ` [attached photos: ${extra.photoIds.join(', ')}]` : '';
    await saveHistory(db, user.id, history, text + note, out.reply || '');
    await send(chatId, reply || 'Done.', buttons);
    for (const c of cards || []) {
      if (c.type === 'approvals') await sendWaitingCards(db, user, chatId, 5);
      else if (c.type === 'confirm') await sendCampaignCard(chatId, c.confirm);
    }
  } catch (e) {
    console.error('[Telegram] agent turn failed:', scrub(e.message));
    await send(chatId, 'Sorry, something went wrong on my side. Please try again in a moment.').catch(() => {});
  } finally { clearInterval(timer); }
}

/** A campaign the Agent drafted, for the owner to launch: what it says, who gets it, Launch / Not now. */
async function sendCampaignCard(chatId, c) {
  const text = `${clip(c.title, 80)}\n${clip(c.summary, 220)}${c.message ? `\n\nThe message: "${clip(c.message, 600)}"` : ''}${c.photoCount ? `\n\nWith ${plural(c.photoCount, 'photo')}.` : ''}`;
  const id = String(c.workflowId);
  return send(chatId, text, id.length <= 56 ? [
    [{ text: 'Launch campaign', data: `cp:l:${id}` }, { text: 'Not now', data: `cp:x:${id}` }],
    { text: 'Open to edit', url: dashboardUrl(appUrl(), { view: c.reviewPage || 'workflows' }) },
  ] : [{ text: 'Open to review and launch', url: dashboardUrl(appUrl(), { view: c.reviewPage || 'workflows' }) }]);
}

const camelName = l => (l && (l.customerName || l.fromName || l.fromEmail || l.fromPhone)) || 'the customer';
const sentVia = r => (r && r.channel === 'whatsapp' ? 'WhatsApp' : 'email');

/** Send it / Do not send on a drafted reply: the dashboard's own approve and reject, run for this owner. */
async function draftDecision(db, user, chatId, action, leadId, clearButtons) {
  const leads = require('../routes/leads');
  const r = await leads.runLeadAction(action, { db, user, leadId, body: action === 'reject' ? { keepOpen: true } : {} });
  if (r.body && r.body.success) {
    await clearButtons();
    return send(chatId, action === 'approve' ? `Sent to ${camelName(r.body.lead)} on ${sentVia(r.body)}.` : `Not sent. I left ${camelName(r.body.lead)} open.`);
  }
  const msg = clip((r.body && r.body.message) || 'That did not work.', 300);
  if (/not awaiting approval/i.test(msg)) { await clearButtons(); return send(chatId, 'That draft was already handled.'); }
  return send(chatId, msg, r.body && r.body.needsUpgrade ? [{ text: 'Open plans and billing', url: dashboardUrl(appUrl(), { view: 'payment' }) }] : null);
}

/** Hand back to the Agent: the chat is no longer flagged for the owner, so the Agent answers the customer's next message. */
async function handBack(db, user, chatId, leadId, clearButtons) {
  const leads = require('../routes/leads');
  const lead = await leads.getLeadById(user.id, leadId, db).catch(() => null);
  if (!lead) return send(chatId, 'I cannot find that customer any more.');
  const r = await leads.runLeadAction('inboxAi', { db, user, leadId, body: { paused: false } });
  await clearButtons();
  return send(chatId, r.body && r.body.success ? `Handed back. I will answer ${camelName(lead)} from here.` : 'I could not hand that back. Open it in the dashboard.');
}

/** Launch (or leave as a draft) a campaign the Agent prepared, with the same launcher the dashboard button uses. */
async function campaignDecision(db, user, chatId, launch, workflowId, clearButtons) {
  await clearButtons();
  if (!launch) return send(chatId, 'Okay, I left it as a draft. You can launch it later from Automations in the dashboard.', [{ text: 'Open Automations', url: dashboardUrl(appUrl(), { view: 'workflows' }) }]);
  const agent = require('../routes/agent');
  const settings = await require('../routes/leads').getSettings(user.id, db).catch(() => ({}));
  const ctx = agent._internal.makeCtx(db, user, settings); ctx.channel = 'telegram';
  const r = await agent._internal.launchCampaign(ctx, workflowId);
  if (r.ok) return send(chatId, `Launched to ${plural(r.recipients, 'lead')}. It runs as a one-time job and I will tell you when it finishes.`);
  return send(chatId, clip(r.message || 'I could not launch that one.', 300), [{ text: 'Open Automations', url: dashboardUrl(appUrl(), { view: 'workflows' }) }]);
}

/** The owner replied to a "Needs you" message: send their words to that customer through the dashboard's own send path. */
async function replyToCustomer(db, user, chatId, leadId, text) {
  const leads = require('../routes/leads');
  const lead = await leads.getLeadById(user.id, leadId, db).catch(() => null);
  if (!lead) return send(chatId, 'I cannot find that customer any more.');
  if (!lead.needsHumanReview) return send(chatId, `${camelName(lead)} is no longer waiting on you, so I did not send that. Open the chat in the dashboard if you want to write to them.`,
    [{ text: 'Open in dashboard', url: leadLink('leads', leadId) }]);
  const body = String(text).slice(0, 2000);
  const r = await leads.runLeadAction('humanReply', { db, user, leadId, body: { subject: `Re: ${clip(lead.subject || 'your enquiry', 80)}`, body } });
  if (r.body && r.body.success) return send(chatId, `Sent to ${camelName(lead)} on ${sentVia(r.body)}.`);
  return send(chatId, clip((r.body && r.body.message) || 'I could not send that.', 300),
    r.body && r.body.needsUpgrade ? [{ text: 'Open plans and billing', url: dashboardUrl(appUrl(), { view: 'payment' }) }] : null);
}

/**
 * Photos from the owner (one message, or an album merged by pollOnce). Each is saved to the photo library, the same place
 * the dashboard's paperclip puts them, and shown to the Agent so it can describe, caption and use them.
 */
async function handlePhotos(db, user, chatId, msgs) {
  const media = require('../services/media-library');
  const caption = (msgs.map(m => String(m.caption || '').trim()).find(Boolean) || '').slice(0, 1500);
  const wanted = msgs.map(photoOf).filter(Boolean);
  const take = wanted.slice(0, media.MAX_PER_MESSAGE);
  const ids = [], images = [], problems = [];
  if (wanted.length > take.length) problems.push(`I can take up to ${media.MAX_PER_MESSAGE} photos at a time, so I used the first ${media.MAX_PER_MESSAGE}.`);
  for (const w of take) {
    if (w.tooBig) { problems.push('One photo is over 4 MB, so I skipped it.'); continue; }
    try {
      const buf = await downloadFile(w.fileId);
      const kind = media.detectImage(buf);
      if (!kind) { problems.push('One file was not a JPEG, PNG or WebP photo, so I skipped it.'); continue; }
      const r = await media.saveImage(db, user.id, { fileName: 'telegram-photo', dataBase64: buf.toString('base64') });
      if (!r.ok) { problems.push(r.message); continue; }
      ids.push(r.photo.id); images.push({ mime: kind.mime, data: buf.toString('base64') });
    } catch (e) {
      problems.push(e.tooBig ? 'One photo is over 4 MB, so I skipped it.' : 'I could not download one of the photos. Please try sending it again.');
      if (!e.tooBig) console.error('[Telegram] photo failed:', scrub(e.message));
    }
  }
  const uniqueProblems = [...new Set(problems)];
  if (!ids.length) return send(chatId, uniqueProblems.length ? uniqueProblems.join(' ') : 'I could not read that photo.');
  if (uniqueProblems.length) await send(chatId, uniqueProblems.join(' '), null, { silent: true }).catch(() => {});
  if (limited(chatId)) return send(chatId, 'You are sending messages a little too fast. Give me a moment.');
  return agentTurn(db, user, chatId, caption, { photoIds: ids, images });
}

async function handleCallback(db, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const answer = (t) => api('answerCallbackQuery', { callback_query_id: cq.id, text: t ? String(t).slice(0, 190) : undefined }).catch(() => {});
  const d = /^dr:([ar]):([A-Za-z0-9_-]{3,60})$/.exec(String(cq.data || ''));
  const hb = /^hb:([A-Za-z0-9_-]{3,60})$/.exec(String(cq.data || ''));
  const cp = /^cp:([lx]):([A-Za-z0-9_-]{3,60})$/.exec(String(cq.data || ''));
  const m = /^opp:([ad]):(.+)$/.exec(String(cq.data || ''));
  if (!chatId || (!m && !d && !hb && !cp)) return answer();
  const user = await userByChat(db, chatId);
  if (!user || user.is_banned) return answer('This chat is not connected.');
  await answer('Working on it');
  const clearBtns = () => api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (d) return draftDecision(db, user, chatId, d[1] === 'a' ? 'approve' : 'reject', d[2], clearBtns);
  if (hb) return handBack(db, user, chatId, hb[1], clearBtns);
  if (cp) return campaignDecision(db, user, chatId, cp[1] === 'l', cp[2], clearBtns);

  const agent = require('../routes/agent');
  const { HANDLERS, makeCtx } = agent._internal;
  const settings = await require('../routes/leads').getSettings(user.id, db).catch(() => ({}));
  const ctx = makeCtx(db, user, settings); ctx.channel = 'telegram';
  const clearButtons = () => api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

  if (m[1] === 'a') {
    const r = await HANDLERS.approve_opportunity(ctx, { id: m[2] });
    await clearButtons();
    if (r.ok) return send(chatId, `Sent to ${plural(r.recipients, 'person', 'people')}. It runs as a one-time job and I will tell you when it finishes.`);
    if (r.locked) return send(chatId, 'That needs a higher plan.', [{ text: 'Open plans and billing', url: dashboardUrl(appUrl(), { view: 'payment' }) }]);
    return send(chatId, clip(r.error || r.message || 'I could not send that one.', 300));
  }
  const r = await HANDLERS.dismiss_opportunity(ctx, { id: m[2] });
  await clearButtons();
  return send(chatId, r.ok ? 'Dismissed. I will not suggest it again for two weeks.' : 'That one was already handled.');
}

async function handleUpdate(db, update) {
  if (update.callback_query) return handleCallback(db, update.callback_query);
  // An album arrives as several messages; pollOnce merges them into one update so the Agent answers once.
  if (Array.isArray(update.photos) && update.photos.length) {
    const first = update.photos[0];
    if (!first.chat || first.chat.type !== 'private' || !first.from || first.from.is_bot) return;
    const owner = await userByChat(db, first.chat.id);
    if (!owner) return send(first.chat.id, 'This chat is not connected to a Humarains account yet. Open Channels > Telegram in the Humarains dashboard and press Connect.');
    if (owner.is_banned) return;
    return handlePhotos(db, owner, first.chat.id, update.photos);
  }
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;   // private chats only
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();

  // /start <code> connects this chat to an account.
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
  if (start && start[1]) return handleLinkStart(db, msg, start[1]);

  const user = await userByChat(db, chatId);
  if (!user) {
    return send(chatId, 'This chat is not connected to a Humarains account yet. Open Channels > Telegram in the Humarains dashboard and press Connect.');
  }
  if (user.is_banned) return;
  const tg = tgOf(user);
  if (tg && tg.blocked) await patchTelegram(db, user.id, { blocked: false }).catch(() => {});      // they are talking to us again

  if (photoOf(msg)) return handlePhotos(db, user, chatId, [msg]);
  if (!text) return send(chatId, 'I can read text messages and photos here. Voice notes and other files are not supported yet.');

  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (cmd) {
    const name = cmd[1].toLowerCase(), arg = (cmd[2] || '').trim();
    switch (name) {
      case 'start': case 'help': return send(chatId, HELP);
      case 'status': return cmdStatus(db, user, chatId);
      case 'activity': return cmdActivity(db, user, chatId);
      case 'waiting': return cmdWaiting(db, user, chatId);
      case 'today': return cmdToday(db, user, chatId);
      case 'quiet': return cmdQuiet(db, user, chatId, arg);
      case 'opportunities': return cmdOpportunities(db, user, chatId);
      case 'notify': return cmdNotify(db, user, chatId, arg);
      case 'disconnect': await unlink(db, user.id); return;
      default: return send(chatId, 'I do not know that command. Send /help to see them, or just tell me what you need.');
    }
  }

  // Replying to a "Needs you" message answers that customer.
  const replied = msg.reply_to_message && msg.reply_to_message.message_id;
  if (replied) {
    const leadId = await lookupReply(db, user.id, replied);
    if (leadId) return replyToCustomer(db, user, chatId, leadId, text);
  }

  if (limited(chatId)) return send(chatId, 'You are sending messages a little too fast. Give me a moment.');
  return agentTurn(db, user, chatId, text);
}

// ══════════════════════════════════════════════════════════════
// Polling loop (worker)
// ══════════════════════════════════════════════════════════════
let running = false;
let notifyTimer = null;

const ALBUM_WAIT_MS = 1200;
/** Photos sent together (same media_group_id, same chat) become one update { update_id, photos: [message, ...] }. */
function mergeAlbums(updates) {
  const out = [], groups = new Map();
  for (const u of updates) {
    const m = u.message;
    if (m && m.media_group_id && m.chat && photoOf(m)) {
      const key = m.chat.id + ':' + m.media_group_id;
      if (groups.has(key)) { const g = groups.get(key); g.photos.push(m); g.update_id = Math.max(g.update_id, u.update_id); continue; }
      const g = { update_id: u.update_id, photos: [m] }; groups.set(key, g); out.push(g);
    } else out.push(u);
  }
  return out;
}
const chatOf = u => (u.photos && u.photos[0] && u.photos[0].chat && u.photos[0].chat.id) || (u.message && u.message.chat && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat && u.callback_query.message.chat.id) || 0;

async function pollOnce(db) {
  const raw = await getKV(db, 'telegram_offset');
  const offset = raw ? parseInt(raw, 10) : 0;
  let updates;
  try {
    updates = await api('getUpdates', { offset: offset || undefined, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: (POLL_TIMEOUT_S + 10) * 1000 });
  } catch (e) {
    if (e.code === 401) { console.error('[Telegram] TELEGRAM_BOT_TOKEN was rejected by Telegram. The bot is stopped until it is fixed.'); stop(); return { handled: 0 }; }
    if (e.code === 409) await api('deleteWebhook', {}).catch(() => {});          // a webhook was set somewhere: polling needs it removed
    throw e;
  }
  if (!updates.length) return { handled: 0 };
  // An album is several updates a moment apart; if one has arrived, wait briefly for the rest of it.
  if (updates.some(u => u.message && u.message.media_group_id)) {
    await sleep(ALBUM_WAIT_MS);
    const more = await api('getUpdates', { offset: Math.max(...updates.map(u => u.update_id)) + 1, timeout: 0, allowed_updates: ['message', 'callback_query'] }).catch(() => []);
    updates = updates.concat(more || []);
  }
  const lastId = Math.max(...updates.map(u => u.update_id));
  updates = mergeAlbums(updates);
  // Different chats in parallel, one chat in order.
  const groups = new Map();
  for (const u of updates) { const c = chatOf(u); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(u); }
  await Promise.all([...groups.values()].map(async list => {
    for (const u of list) {
      try { await handleUpdate(db, u); }
      catch (e) { console.error('[Telegram] could not handle an update:', scrub(e.message)); }       // one bad message never blocks the rest
    }
  }));
  await setKV(db, 'telegram_offset', String(lastId + 1));
  return { handled: updates.length };
}

async function pollLoop(db) {
  let failures = 0;
  while (running) {
    const res = await runJob(db, 'telegram_poll', () => pollOnce(db));
    if (!running) break;
    if (res && res.skipped) { await sleep(5000); continue; }                      // another process is polling
    if (res === undefined) { failures++; await sleep(Math.min(30_000, 2000 * failures)); continue; }
    failures = 0;
  }
}

function start(db) {
  if (running) return;
  if (!enabled()) { console.log('[Telegram] TELEGRAM_BOT_TOKEN is not set: the Telegram bot is off.'); return; }
  running = true;
  api('deleteWebhook', {}).catch(() => {});                                      // polling and webhooks exclude each other
  db.query(`CREATE INDEX IF NOT EXISTS users_telegram_chat_idx ON users ((integrations->'telegram'->>'chatId'))`).catch(() => {});
  pollLoop(db).catch(e => console.error('[Telegram] poll loop ended:', scrub(e.message)));
  notifyTimer = setInterval(() => { runJob(db, 'telegram_notify', () => notifyCycle(db)); }, NOTIFY_EVERY_MS);
  notifyTimer.unref();
  console.log('[Telegram] bot started (long polling)');
}

function stop() {
  running = false;
  if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
}

module.exports = {
  enabled, start, stop, status, createLink, unlink, setNotify, sendTest, sendBriefing,
  handleUpdate, notifyCycle, notifyUser, collectEvents, composeDigest, pollOnce,
  _setApi, _setFileFetcher,
  _internal: { isQuiet, parseClock, rememberReply, lookupReply, waitingEvents, mergeAlbums, photoOf, redeemLink, tgOf, send, clip, agentPayload, loadState, memCursor, scrub, rate },
};
