/**
 * services/leads/poller.js — Automatic inbox polling for all connected users
 *
 * Inbox: every INBOX_POLL_INTERVAL_MS (default 10 seconds, minimum 5s) for every
 * user with an email account connected (IMAP + SMTP) and business settings
 * configured. Runs the full AI pipeline (thread matching → qualification →
 * conversation-aware reply → send or queue).
 *
 * This is the ONLY code that reads the inbox. The dashboard's "check email" call
 * (POST /api/leads/ingest/email) and the Agent's check_email tool both go through
 * pollForUser(), so two readers can never race on the same message.
 *
 * Detection: a per-mailbox UID cursor (table email_poll_state), NOT the unread flag.
 * Mail the owner already opened on their phone is still picked up, and the owner's
 * mailbox is never modified (nothing is marked read). See fetchNewMail().
 *
 * Background jobs (follow-up jobs, workflow waits, stalled-lead triggers,
 * agent task sweep) stay on a 60s cycle — they do not need 10s resolution.
 *
 * Design:
 *  - Per-user in-flight lock: a slow mailbox never stacks polls, and never
 *    delays other users (users are polled in parallel, CONCURRENCY at a time).
 *  - One persistent IMAP connection per mailbox (services/leads/ingestion.js).
 *  - Failures back off (30s → 5min) so a wrong password is not hammered.
 *  - Messages are processed oldest first, one at a time. The cursor only moves past
 *    a message once it is saved (or deliberately skipped). If the AI, the database or
 *    SMTP fails, the cursor stays put and the message is retried, up to MAX_ATTEMPTS,
 *    then skipped so one bad message cannot block the mailbox.
 *  - Every early exit records a reason (getStatus / pollUserNow), instead of
 *    returning silently, so "why is nothing happening" has an answer.
 *  - All logging is prefixed [Poller] for easy log filtering.
 */
'use strict';
const { runJob } = require('../../lib/jobs');

const POLL_INTERVAL_MS = Math.max(5_000, parseInt(process.env.INBOX_POLL_INTERVAL_MS || '10000', 10) || 10_000);
const BACKGROUND_INTERVAL_MS = 60_000;
const MAX_MESSAGES_PER_POLL = 20;
const CONCURRENCY = 5;
const MAX_ATTEMPTS = 3;
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000];

// userId → true while a poll for that user is running
const _inFlight = new Set();
// userId → { lastPollAt, lastOkAt, reason, error, fetched, processed, failCount, nextAllowedAt }
const _status = new Map();
// `${userId}:${messageKey}` → failed processing attempts
const _attempts = new Map();
// `${userId}:${messageId}` already processed this process lifetime (guards a failed mark-as-read)
const _handled = new Set();
const HANDLED_CAP = 5000;
// `${userId}` → { mailbox, uidValidity, lastUid } — in-memory copy of the cursor, so a missing
// email_poll_state table degrades to "cursor lives in memory" instead of re-baselining every poll.
const _cursors = new Map();
// userId → [{ id, at }] leads created/updated by the poller recently; the dashboard asks for these
// so it can show "2 leads processed" for mail the server handled while the page was open.
const _recent = new Map();

let _db = null;
let _inboxTimer = null;
let _bgTimer = null;
let _proTimer = null;
let _callTimer = null;
let _bootTimers = [];
let _inboxRunning = false;
let _bgRunning = false;
let _lastUserCount = -1;

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    return new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (_) { return null; }
}

// ── Status bookkeeping ────────────────────────────────────────
function record(userId, reason, extra = {}) {
  const prev = _status.get(userId) || {};
  const next = { ...prev, lastPollAt: new Date().toISOString(), lastPollMs: Date.now(), reason, ...extra };
  if (reason === 'ok') next.lastOkAt = next.lastPollAt;
  _status.set(userId, next);
  // Log only when the state changes, so a broken mailbox does not log every 10s.
  if (reason !== 'ok' && reason !== prev.reason) {
    console.warn(`[Poller] user ${userId}: ${reason}${extra.error ? ' — ' + extra.error : ''}`);
  }
  return next;
}

function getStatus(userId) {
  const s = _status.get(userId);
  return s ? { ...s } : null;
}

function rememberHandled(key) {
  _handled.add(key);
  if (_handled.size > HANDLED_CAP) {
    // Sets iterate in insertion order: drop the oldest quarter.
    let n = Math.floor(HANDLED_CAP / 4);
    for (const k of _handled) { _handled.delete(k); if (--n <= 0) break; }
  }
}

// ── Background (non-inbox) jobs, every 60s ────────────────────
async function runBackgroundCycle() {
  if (!_db || _bgRunning) return;
  _bgRunning = true;
  try {
    // One owner across every web instance and the worker (database lock), with a heartbeat for monitoring.
    await runJob(_db, 'background_cycle', async () => {
      const { processDueJobs } = require('./scheduler');
      const { processDueWaits, processStalledTriggers } = require('../workflows/engine');
      const steps = [
        // Due follow-up jobs first (DB-backed, survive restarts)
        ['processDueJobs',          () => processDueJobs(_db)],
        // Workflow waits (timers + reply-or-timeout fallbacks) and stalled-lead triggers
        ['processDueWaits',         () => processDueWaits(_db)],
        ['processStalledTriggers',  () => processStalledTriggers(_db)],
        // Remove temporary automations (agent one-off jobs) whose work is finished
        ['agent task sweep',        () => require('../agent/tasks').sweepAll(_db)],
      ];
      const results = await Promise.allSettled(steps.map(([, fn]) => fn()));
      const failed = [];
      results.forEach((r, i) => { if (r.status === 'rejected') { failed.push(steps[i][0]); console.error(`[Poller] ${steps[i][0]} error:`, r.reason && r.reason.message); } });
      if (failed.length) throw new Error(`${failed.length} background step(s) failed: ${failed.join(', ')}`);
    });
  } finally {
    _bgRunning = false;
  }
}

// ── Inbox cycle, every POLL_INTERVAL_MS ───────────────────────
async function runInboxCycle() {
  if (!_db || _inboxRunning) return; // previous cycle still running: skip, never stack
  _inboxRunning = true;
  try {
    // One owner across every web instance and the worker: two processes can no longer fetch the same mailbox.
    await runJob(_db, 'inbox_cycle', () => inboxCycleBody());
  } finally {
    _inboxRunning = false;
  }
}

async function inboxCycleBody() {
  {
    const claude = getAnthropicClient();
    if (!claude) {
      console.warn('[Poller] ANTHROPIC_API_KEY missing or SDK unavailable — inbox polling is paused.');
      return;
    }

    let users;
    try {
      // Only users that actually have stored email credentials. Email is on
      // every plan (Free included); per-plan reply quotas are enforced
      // downstream in routes/leads.js (checkSendQuota), not here.
      // SELECT u.* so the user object carries plan: the send
      // quota check reads them, and without them everyone was treated as Free.
      users = await _db.queryAll(
        `SELECT u.*
           FROM users u
          WHERE NOT u.is_banned
            AND ((u.integrations->'pipeline_email'->>'enc_pass') IS NOT NULL
              OR (u.integrations->'lead_email'->>'enc_pass') IS NOT NULL)   -- matches idx_users_email_polling
          ORDER BY u.created_at ASC`,
        []
      );
    } catch (err) {
      console.error('[Poller] Could not fetch users:', err.message);
      return;
    }

    // Heartbeat: log when the number of polled mailboxes changes, so "nothing is being polled" is visible in the logs.
    if (users.length !== _lastUserCount) {
      console.log(`[Poller] ${users.length} connected mailbox(es) to poll.`);
      _lastUserCount = users.length;
    }

    let next = 0;
    const worker = async () => {
      while (next < users.length) {
        const userRow = users[next++];
        try {
          await pollForUser(claude, userRow);
        } catch (err) {
          console.error(`[Poller] Unhandled error for user ${userRow.id}:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker));

    require('./ingestion').sweepIdleImap();
  }
}

// Kept for backward compatibility with callers of the old single cycle.
async function runPollCycle() {
  await runBackgroundCycle();
  await runInboxCycle();
}

// ── Poll inbox for a single user ──────────────────────────────
// Returns { ok, reason, fetched, processed, error? }. Never throws for expected
// problems; reasons: ok | busy | backoff | no_email_connected | no_credentials |
// setup_incomplete | cannot_decrypt | imap_failed
async function pollForUser(claude, userRow, { force = false, maxAgeMs = 0 } = {}) {
  const userId = userRow.id;
  if (_inFlight.has(userId)) return { ok: false, reason: 'busy', fetched: 0, processed: 0 };

  const st = _status.get(userId) || {};
  // Dashboard auto-checks pass maxAgeMs: if the server poller looked a moment ago, don't hit IMAP again.
  if (!force && maxAgeMs && st.reason === 'ok' && st.lastPollMs && Date.now() - st.lastPollMs < maxAgeMs) {
    return { ok: true, reason: 'recent', fetched: 0, processed: 0, skipped: 0, leadIds: [] };
  }
  if (!force && st.nextAllowedAt && Date.now() < st.nextAllowedAt) {
    return { ok: false, reason: 'backoff', fetched: 0, processed: 0, error: st.error };
  }

  _inFlight.add(userId);
  try {
    return await pollInner(claude, userRow);
  } finally {
    _inFlight.delete(userId);
  }
}

async function pollInner(claude, userRow) {
  const userId = userRow.id;
  const fail = (reason, extra = {}) => {
    record(userId, reason, { fetched: 0, processed: 0, ...extra });
    return { ok: false, reason, fetched: 0, processed: 0, ...extra };
  };

  // Parse integrations
  let intg = {};
  try {
    const raw = userRow.integrations;
    intg = typeof raw === 'object' ? (raw || {}) : JSON.parse(raw || '{}');
    if (typeof intg === 'string') intg = JSON.parse(intg);
  } catch (_) {}

  const emailCfg = intg.pipeline_email || intg.lead_email;
  if (!emailCfg || emailCfg.type !== 'email') return fail('no_email_connected');
  if (!emailCfg.enc_pass) return fail('no_credentials', { error: 'No stored email password. Reconnect the email account.' });

  // Cheap setup check every poll (one tiny query). The full settings load
  // (knowledge base, photo library...) only happens when there is mail to process.
  const { getSettings, processInboxBatch } = require('./poller-batch');
  try {
    const biz = await _db.queryOne('SELECT business_name FROM lead_business_settings WHERE user_id=$1', [userId]);
    if (!biz || !biz.business_name) {
      return fail('setup_incomplete', { error: 'Business name is not set, so replies cannot be written yet.' });
    }
  } catch (_) { /* fall through; the full load below decides */ }

  // Decrypt credentials
  const { decrypt } = require('../mailbox');
  let pass = null;
  try { pass = decrypt(emailCfg.enc_pass); } catch (_) {}
  if (!pass) {
    return fail('cannot_decrypt', { error: 'Stored email password could not be decrypted (JWT_SECRET changed?). Reconnect the email account.' });
  }

  const imapCfg = { user: emailCfg.user, pass, host: emailCfg.imapHost, port: emailCfg.imapPort };

  const mailboxKey = `${String(emailCfg.user).toLowerCase()}|${emailCfg.imapHost}|${emailCfg.imapPort || 993}`;
  const cursor = await loadCursor(userId, mailboxKey);

  // Fetch everything after the cursor (read or unread; the mailbox is never modified)
  const { fetchNewMail } = require('./ingestion');
  let batch;
  try {
    batch = await fetchNewMail(imapCfg, cursor, { maxResults: MAX_MESSAGES_PER_POLL, connectedAt: emailCfg.connectedAt });
  } catch (err) {
    const failCount = ((_status.get(userId) || {}).failCount || 0) + 1;
    const wait = BACKOFF_STEPS_MS[Math.min(failCount - 1, BACKOFF_STEPS_MS.length - 1)];
    console.error(`[Poller] IMAP fetch failed for ${userId} (attempt ${failCount}, retry in ${wait / 1000}s):`, err.message);
    return fail('imap_failed', { error: err.message, failCount, nextAllowedAt: Date.now() + wait });
  }

  const msgs = batch.messages;
  let lastUid = batch.startUid;
  let processed = 0, skipped = 0, stopped = false;
  const leadIds = [];
  const ignored = [];   // mail that was seen but deliberately not turned into a lead, with the reason
  const key = m => `${userId}:${m.messageId || 'uid' + m.uid}`;
  const ownAddress = String(emailCfg.user || '').toLowerCase().trim();

  if (msgs.length) {
    const actionable = msgs.filter(m => !m.skip);
    console.log(`[Poller] ${msgs.length} new message(s) for user ${userId} (${userRow.email})${batch.baseline ? ' [first poll of this mailbox]' : ''}, ${actionable.length} to process`);

    let businessContext = null;
    if (actionable.length) {
      businessContext = await getSettings(userId, _db).catch(() => null);
      if (!businessContext || !businessContext.businessName) {
        // Cursor is NOT moved: the mail is picked up once setup is finished.
        return fail('setup_incomplete', { fetched: msgs.length, error: 'Business name is not set, so replies cannot be written yet.' });
      }
    }

    for (const m of msgs) {
      const k = key(m);
      // Deliberate skips: machine mail, bounces, too old, unreadable, already handled in this process,
      // and mail from the connected address itself (answering your own mailbox would loop forever).
      if (m.skip || _handled.has(k) || (m.fromEmail && m.fromEmail.toLowerCase() === ownAddress)) {
        if (!m.skip && m.fromEmail && m.fromEmail.toLowerCase() === ownAddress) console.log(`[Poller] Ignoring mail from the connected address itself (${ownAddress}).`);
        if (m.skip) ignored.push({ from: m.fromEmail || '', subject: (m.subject || '').slice(0, 80), reason: m.skip });
        skipped++; lastUid = m.uid; continue;
      }
      // Already turned into a lead before (a restart, or a cursor that failed to save).
      if (m.messageId) {
        const dup = await _db.queryOne('SELECT 1 AS x FROM leads WHERE user_id=$1 AND email_message_id=$2', [userId, m.messageId]).catch(() => null);
        if (dup) { rememberHandled(k); skipped++; lastUid = m.uid; continue; }
      }

      let done = [];
      try {
        done = await processInboxBatch(claude, userRow, [m], businessContext, _db);
      } catch (err) {
        console.error(`[Poller] processInboxBatch threw for ${m.fromEmail}:`, err.message);
      }

      if (done.length) {
        rememberHandled(k); _attempts.delete(k);
        if (m.outcome === 'not_a_lead') { skipped++; ignored.push({ from: m.fromEmail || '', subject: (m.subject || '').slice(0, 80), reason: m.ignoredReason || 'not a lead' }); } else processed++;
        if (m.leadId) { leadIds.push(m.leadId); noteRecent(userId, m.leadId); }
        lastUid = m.uid;
        continue;
      }

      const n = (_attempts.get(k) || 0) + 1;
      _attempts.set(k, n);
      if (n >= MAX_ATTEMPTS) {
        console.error(`[Poller] Giving up on message from ${m.fromEmail} ("${(m.subject || '').slice(0, 60)}") after ${n} failed attempts.`);
        _attempts.delete(k); rememberHandled(k); skipped++; lastUid = m.uid;
        continue;
      }
      stopped = true;   // keep order: retry this one next poll before touching anything after it
      break;
    }
  }

  // Commit the cursor. A first poll with nothing left to retry jumps to the top of the mailbox, so
  // mail that was already there (and deliberately not answered) is never revisited.
  let newLast = lastUid;
  if (batch.baseline && !stopped) newLast = Math.max(newLast, batch.top);
  const changed = batch.baseline || !cursor || newLast !== cursor.lastUid;
  if (changed) await saveCursor(userId, mailboxKey, { uidValidity: batch.uidValidity, lastUid: newLast });

  record(userId, 'ok', { error: null, failCount: 0, nextAllowedAt: 0, fetched: msgs.length, processed, skipped, cursor: newLast, ...(ignored.length ? { ignored: ignored.slice(-20) } : {}) });
  return { ok: true, reason: 'ok', fetched: msgs.length, processed, skipped, leadIds, ignored };
}

// ── Cursor persistence ────────────────────────────────────────
async function loadCursor(userId, mailboxKey) {
  const mem = _cursors.get(userId);
  if (mem && mem.mailbox === mailboxKey) return mem;
  try {
    const row = await _db.queryOne('SELECT mailbox, uid_validity, last_uid FROM email_poll_state WHERE user_id=$1', [userId]);
    if (row && row.mailbox === mailboxKey) {
      const cur = { mailbox: mailboxKey, uidValidity: row.uid_validity || '', lastUid: parseInt(row.last_uid || 0, 10) || 0 };
      _cursors.set(userId, cur);
      return cur;
    }
  } catch (err) {
    console.warn('[Poller] Could not read email_poll_state (is the table created?):', err.message);
  }
  return null;   // never polled, or a different mailbox was connected: baseline
}

async function saveCursor(userId, mailboxKey, cur) {
  _cursors.set(userId, { mailbox: mailboxKey, uidValidity: cur.uidValidity, lastUid: cur.lastUid });
  try {
    await _db.query(
      `INSERT INTO email_poll_state (user_id, mailbox, uid_validity, last_uid, updated_at)
            VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
            mailbox=EXCLUDED.mailbox, uid_validity=EXCLUDED.uid_validity,
            last_uid=EXCLUDED.last_uid, updated_at=NOW()`,
      [userId, mailboxKey, cur.uidValidity, cur.lastUid]
    );
  } catch (err) {
    console.warn('[Poller] Could not save email_poll_state (cursor kept in memory):', err.message);
  }
}

// ── Recently processed leads (for the dashboard's "N leads processed" toast) ──
function noteRecent(userId, leadId) {
  const now = Date.now();
  const list = (_recent.get(userId) || []).filter(r => now - r.at < 10 * 60_000);
  list.push({ id: leadId, at: now });
  _recent.set(userId, list.slice(-50));
}
function recentLeadIds(userId, sinceMs = 0) {
  return (_recent.get(userId) || []).filter(r => r.at > sinceMs).map(r => r.id);
}

/**
 * Check one user's inbox right now (used by the Agent's check_email tool).
 * Ignores backoff so the owner gets the real, current answer.
 */
async function pollUserNow(userId, opts = {}) {
  if (!_db) return { ok: false, reason: 'not_ready', fetched: 0, processed: 0 };
  const claude = getAnthropicClient();
  if (!claude) return { ok: false, reason: 'no_ai', fetched: 0, processed: 0, error: 'AI service is not configured.' };
  const row = await _db.queryOne('SELECT * FROM users WHERE id=$1 AND NOT is_banned', [userId]);
  if (!row) return { ok: false, reason: 'no_user', fetched: 0, processed: 0 };
  return pollForUser(claude, row, { force: opts.force !== false, maxAgeMs: opts.maxAgeMs || 0 });
}

// ── Start the poller ──────────────────────────────────────────
function start(db) {
  if (_inboxTimer) return; // already running
  _db = db;
  // Give the scheduler a DB reference so follow-up jobs persist across restarts
  const { init: initScheduler } = require('./scheduler');
  initScheduler(db);

  // First polls shortly after boot (let the server fully start first)
  _bootTimers.push(setTimeout(() => {
    runPollCycle().catch(err => console.error('[Poller] Initial cycle error:', err.message));
  }, 10_000));

  _inboxTimer = setInterval(() => {
    runInboxCycle().catch(err => console.error('[Poller] Inbox cycle error:', err.message));
  }, POLL_INTERVAL_MS);

  _bgTimer = setInterval(() => {
    runBackgroundCycle().catch(err => console.error('[Poller] Background cycle error:', err.message));
  }, BACKGROUND_INTERVAL_MS);

  // Proactive Agent: opportunity scans + morning briefings (services/agent/proactive.js).
  // Cheap when idle; per-user work is claimed atomically in the database.
  _bootTimers.push(setTimeout(() => runJob(db, 'proactive_tick', () => require('../agent/proactive').tick(db)), 90_000));
  _proTimer = setInterval(() => runJob(db, 'proactive_tick', () => require('../agent/proactive').tick(db)), 30 * 60_000);

  // Missed WhatsApp calls: send the owner's text-back once its delay has passed (services/whatsapp-calls.js).
  _callTimer = setInterval(() => runJob(db, 'missed_calls', () => require('../whatsapp-calls').tick(db)), 30_000);

  console.log(`[Poller] Auto-polling inbox (IMAP) every ${POLL_INTERVAL_MS / 1000}s; background jobs every ${BACKGROUND_INTERVAL_MS / 1000}s`);
}

// ── Stop the poller ───────────────────────────────────────────
function stop() {
  if (_inboxTimer) { clearInterval(_inboxTimer); _inboxTimer = null; }
  if (_bgTimer)    { clearInterval(_bgTimer);    _bgTimer = null; }
  if (_proTimer)   { clearInterval(_proTimer);   _proTimer = null; }
  if (_callTimer)  { clearInterval(_callTimer);  _callTimer = null; }
  _bootTimers.forEach(clearTimeout); _bootTimers = [];
  try { require('./ingestion').closeAllImap(); } catch (_) {}
  console.log('[Poller] Stopped');
}

module.exports = { start, stop, runPollCycle, runInboxCycle, pollUserNow, getStatus, recentLeadIds };
