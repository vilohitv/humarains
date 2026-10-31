/**
 * services/inbound-queue.js — durable queue for inbound customer messages.
 *
 * Why it exists: the webhook used to do all the work (AI, quote, send) in the
 * request process, kept a burst of photos in memory, and lost everything on a
 * restart. Now:
 *
 *   1. enqueue()  the webhook only records the message. The unique dedupe_key
 *                 makes this idempotent: Meta re-sending a webhook is a no-op.
 *   2. runTick()  the worker groups everything one person sent in a short window,
 *                 claims it with FOR UPDATE SKIP LOCKED (safe with several workers),
 *                 and hands one merged message to the handler.
 *   3. retries    a failed batch goes back to 'pending' with exponential backoff.
 *                 After MAX_ATTEMPTS it becomes 'dead' (kept for inspection, reported
 *                 to Sentry and to the ops endpoint).
 *   4. resume     handlers save progress (progress jsonb) so a retry continues after
 *                 the last completed step instead of redoing it (no double replies).
 *   5. recovery   a batch stuck in 'processing' (worker crashed) is released after
 *                 STALE_LOCK_MS and retried.
 */
'use strict';
const crypto = require('crypto');
const { runJob, heartbeat } = require('../lib/jobs');

const QUIET_MS       = Number(process.env.INBOUND_QUIET_MS)    || 6000;    // wait for a burst to finish
const MAX_WAIT_MS    = Number(process.env.INBOUND_MAX_WAIT_MS) || 20000;   // never hold a message longer than this
const MAX_ATTEMPTS   = Number(process.env.INBOUND_MAX_ATTEMPTS) || 5;
const STALE_LOCK_MS  = 10 * 60_000;
const TICK_MS        = 2000;
const CONCURRENCY    = 3;
const BACKOFF_MS     = [30_000, 2 * 60_000, 8 * 60_000, 30 * 60_000, 2 * 3600_000];

const backoffFor = attempts => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

function keysFor(msg, channel = 'whatsapp') {
  const id = msg.messageId || crypto.createHash('sha1').update(JSON.stringify(msg)).digest('hex');
  return {
    dedupeKey: `${channel}:${msg.phoneNumberId || ''}:${id}`,
    senderKey: `${channel}:${msg.phoneNumberId || ''}:${msg.fromPhone}`,
  };
}

// Record an inbound message. Returns true when it was new, false when it was a duplicate.
async function enqueue(db, msg, channel = 'whatsapp') {
  const { dedupeKey, senderKey } = keysFor(msg, channel);
  const r = await db.query(
    `INSERT INTO inbound_events (dedupe_key, channel, sender_key, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [dedupeKey, channel, senderKey, JSON.stringify(msg)]
  );
  return r.rowCount === 1;
}

// One merged message per batch: text joined, photos combined, ids kept.
function mergeBatch(rows) {
  const msgs = rows.map(r => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  return {
    ...msgs[0],
    body:       msgs.map(m => m.body).filter(Boolean).join('\n'),
    images:     msgs.flatMap(m => m.images || []),
    messageIds: msgs.map(m => m.messageId).filter(Boolean),
  };
}

async function recoverStale(db) {
  const r = await db.query(
    `UPDATE inbound_events
        SET status = 'pending', locked_at = NULL,
            last_error = left(COALESCE(last_error, '') || ' [released: worker stopped mid-processing]', 500)
      WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond')`,
    [STALE_LOCK_MS]
  );
  if (r.rowCount) console.warn(`[Inbound] released ${r.rowCount} message(s) left in processing by a stopped worker`);
}

// Claim one sender's ready messages. Returns the claimed rows (possibly none).
async function claim(db, senderKey) {
  const r = await db.query(
    `UPDATE inbound_events
        SET status = 'processing', locked_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM inbound_events
                    WHERE sender_key = $1 AND status = 'pending' AND next_attempt_at <= now()
                    ORDER BY id
                    FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [senderKey]
  );
  return r.rows.sort((a, b) => Number(a.id) - Number(b.id));
}

async function finishOk(db, ids) {
  await db.query(`UPDATE inbound_events SET status = 'done', processed_at = now(), locked_at = NULL, last_error = NULL WHERE id = ANY($1::bigint[])`, [ids]);
}

async function finishFail(db, rows, err) {
  const ids = rows.map(r => r.id);
  const attempts = Math.max(...rows.map(r => r.attempts));
  const msg = String(err && err.message || err).slice(0, 500);
  if (attempts >= MAX_ATTEMPTS) {
    await db.query(`UPDATE inbound_events SET status = 'dead', processed_at = now(), locked_at = NULL, last_error = $2 WHERE id = ANY($1::bigint[])`, [ids, msg]);
    console.error(`[Inbound] giving up on ${ids.length} message(s) after ${attempts} attempts: ${msg}`);
    try { if (process.env.SENTRY_DSN) require('@sentry/node').captureException(err, { tags: { job: 'inbound_queue', dead: 'true' } }); } catch (_) {}
  } else {
    const wait = backoffFor(attempts);
    await db.query(
      `UPDATE inbound_events SET status = 'pending', locked_at = NULL, last_error = $2,
              next_attempt_at = now() + ($3::int * interval '1 millisecond')
        WHERE id = ANY($1::bigint[])`, [ids, msg, wait]);
    console.warn(`[Inbound] attempt ${attempts}/${MAX_ATTEMPTS} failed (${msg}); retrying in ${Math.round(wait / 1000)}s`);
  }
}

// Process one sender's batch with the handler. Never throws.
async function processSender(db, senderKey, handler) {
  const rows = await claim(db, senderKey);
  if (!rows.length) return 0;
  const ids = rows.map(r => r.id);
  const progress = Object.assign({}, ...rows.map(r => (typeof r.progress === 'string' ? JSON.parse(r.progress) : r.progress) || {}));
  const saveProgress = async patch => {
    Object.assign(progress, patch);
    await db.query(`UPDATE inbound_events SET progress = progress || $2::jsonb WHERE id = ANY($1::bigint[])`, [ids, JSON.stringify(patch)]);
  };
  try {
    await handler(mergeBatch(rows), { progress, saveProgress, attempt: Math.max(...rows.map(r => r.attempts)) });
    await finishOk(db, ids);
  } catch (err) {
    await finishFail(db, rows, err);
  }
  return rows.length;
}

// One pass: release stuck work, find senders whose burst has settled, process them.
async function runTick(db, handler) {
  await recoverStale(db);
  const ready = await db.queryAll(
    `SELECT sender_key FROM inbound_events
      WHERE status = 'pending' AND next_attempt_at <= now()
      GROUP BY sender_key
     HAVING max(received_at) <= now() - ($1::int * interval '1 millisecond')
         OR min(received_at) <= now() - ($2::int * interval '1 millisecond')
      LIMIT 25`,
    [QUIET_MS, MAX_WAIT_MS]
  );
  let next = 0, handled = 0;
  const lane = async () => {
    while (next < ready.length) handled += await processSender(db, ready[next++].sender_key, handler);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ready.length) }, lane));
  return handled;
}

// Queue health for the ops endpoint.
async function stats(db) {
  const r = await db.queryOne(
    `SELECT count(*) FILTER (WHERE status = 'pending')    AS pending,
            count(*) FILTER (WHERE status = 'processing') AS processing,
            count(*) FILTER (WHERE status = 'dead')       AS dead,
            count(*) FILTER (WHERE status = 'done' AND processed_at > now() - interval '24 hours') AS done_24h,
            COALESCE(extract(epoch FROM now() - min(received_at) FILTER (WHERE status IN ('pending','processing')))::int, 0) AS oldest_waiting_seconds
       FROM inbound_events`, []);
  return { pending: Number(r.pending), processing: Number(r.processing), dead: Number(r.dead),
           done24h: Number(r.done_24h), oldestWaitingSeconds: Number(r.oldest_waiting_seconds) };
}

// ── Worker loop ────────────────────────────────────────────────
let _timer = null, _running = false, _lastBeat = 0;
function start(db, handler) {
  if (_timer) return;
  _timer = setInterval(async () => {
    if (_running) return;
    _running = true;
    try {
      await runJob(db, 'inbound_queue', () => runTick(db, handler), { lock: false, quiet: true });
      if (Date.now() - _lastBeat > 30_000) { _lastBeat = Date.now(); await heartbeat(db, 'inbound_queue'); }
    } finally { _running = false; }
  }, TICK_MS);
  console.log(`[Inbound] queue worker started (batch window ${QUIET_MS / 1000}s, ${MAX_ATTEMPTS} attempts)`);
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { enqueue, runTick, stats, start, stop, mergeBatch, keysFor, backoffFor, MAX_ATTEMPTS };
