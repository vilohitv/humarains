/**
 * lib/jobs.js — run a background job exactly once across all processes, and
 * record that it ran.
 *
 *   runJob(db, 'inbox_cycle', async () => { ... })
 *
 * • Single owner: a Postgres advisory lock is held while the job runs, so web
 *   instances and the worker can all be started and only one runs a given job.
 *   The lock is transaction-level (pg_advisory_xact_lock family), which is safe
 *   behind Supabase's transaction pooler; a session-level lock is not.
 * • Heartbeat: every run updates job_runs (start, finish, success, error). The
 *   /healthz/jobs endpoint and the admin ops view read it to spot a job that
 *   stopped running.
 * • Errors are logged, sent to Sentry when configured, recorded, and swallowed:
 *   a failing job never takes the process down.
 */
'use strict';

// How often each job should complete. A job is "stale" after 3x its interval.
const EXPECTED_EVERY_MS = {
  background_cycle: 60_000,
  inbox_cycle:      Math.max(5_000, parseInt(process.env.INBOX_POLL_INTERVAL_MS || '10000', 10) || 10_000),
  proactive_tick:   30 * 60_000,
  missed_calls:     30_000,          // text-backs to missed WhatsApp calls
  inbound_queue:    30_000,          // heartbeat written by the queue worker
  whatsapp_sync:    5 * 60_000,      // WhatsApp connection health
  retention:        60 * 60_000,     // first-week setup reminders
  db_backup:        24 * 3600_000,   // daily backup (only when BACKUP_ENABLED=true)
  db_prune:         24 * 3600_000,   // daily retention cleanup
};

function captureError(err, name) {
  try {
    if (process.env.SENTRY_DSN) require('@sentry/node').captureException(err, { tags: { job: name } });
  } catch (_) {}
}

// Run fn while holding the advisory lock `name`. Returns { skipped: true } when another
// process already holds it, otherwise { skipped: false, value }.
async function withLock(db, name, fn) {
  const client = await db.pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const r = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', ['humarains:' + name]);
    if (!r.rows[0].ok) { await client.query('ROLLBACK'); began = false; return { skipped: true }; }
    const value = await fn();
    await client.query('COMMIT'); began = false;
    return { skipped: false, value };
  } finally {
    if (began) { try { await client.query('ROLLBACK'); } catch (_) {} }
    client.release();
  }
}

async function record(db, name, { ok, ms, err }) {
  try {
    await db.query(
      `INSERT INTO job_runs (name, last_started_at, last_finished_at, last_success_at, last_error, last_error_at, last_duration_ms, run_count, fail_count)
       VALUES ($1, now() - ($2::int * interval '1 millisecond'), now(), CASE WHEN $3 THEN now() END, $4, CASE WHEN $3 THEN NULL ELSE now() END, $2, 1, CASE WHEN $3 THEN 0 ELSE 1 END)
       ON CONFLICT (name) DO UPDATE SET
         last_started_at  = EXCLUDED.last_started_at,
         last_finished_at = EXCLUDED.last_finished_at,
         last_success_at  = CASE WHEN $3 THEN now() ELSE job_runs.last_success_at END,
         last_error       = CASE WHEN $3 THEN job_runs.last_error ELSE EXCLUDED.last_error END,
         last_error_at    = CASE WHEN $3 THEN job_runs.last_error_at ELSE now() END,
         last_duration_ms = EXCLUDED.last_duration_ms,
         run_count        = job_runs.run_count + 1,
         fail_count       = job_runs.fail_count + CASE WHEN $3 THEN 0 ELSE 1 END,
         updated_at       = now()`,
      [name, Math.max(0, Math.round(ms)), !!ok, ok ? null : String(err && err.message || err).slice(0, 500)]
    );
  } catch (e) {
    console.error(`[Jobs] could not record run of ${name}:`, e.message);
  }
}

// opts.lock === false skips the advisory lock (for work that is already row-locked, like the inbound queue).
async function runJob(db, name, fn, opts = {}) {
  const t0 = Date.now();
  try {
    const res = opts.lock === false ? { skipped: false, value: await fn() } : await withLock(db, name, fn);
    if (res.skipped) return { skipped: true };
    if (!opts.quiet) await record(db, name, { ok: true, ms: Date.now() - t0 });
    return res.value;
  } catch (err) {
    console.error(`[Jobs] ${name} failed:`, err.message);
    captureError(err, name);
    await record(db, name, { ok: false, ms: Date.now() - t0, err });
    return undefined;
  }
}

// Record a heartbeat without running anything (used by long-lived loops).
async function heartbeat(db, name) { return record(db, name, { ok: true, ms: 0 }); }

// Snapshot for health endpoints: every job, and which look stale.
async function jobStatus(db) {
  const rows = await db.queryAll('SELECT * FROM job_runs ORDER BY name', []);
  const now = Date.now();
  const jobs = rows.map(r => {
    const every = EXPECTED_EVERY_MS[r.name];
    const last = r.last_success_at ? new Date(r.last_success_at).getTime() : null;
    const ageMs = last == null ? null : now - last;
    // 3x the expected interval, with a 3 minute floor so a slow cycle does not flap the health check
    const stale = every != null && (last == null || ageMs > Math.max(every * 3, 180_000));
    return { name: r.name, lastSuccessAt: r.last_success_at, ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
             lastError: r.last_error, lastErrorAt: r.last_error_at, runs: Number(r.run_count), failures: Number(r.fail_count), stale };
  });
  return { jobs, stale: jobs.filter(j => j.stale).map(j => j.name) };
}

module.exports = { runJob, withLock, heartbeat, jobStatus, EXPECTED_EVERY_MS };
