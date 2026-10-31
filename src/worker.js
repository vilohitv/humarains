/**
 * humarains — background worker
 *
 *   node src/worker.js
 *
 * Runs everything that is not an HTTP request: the inbox poller, follow-up jobs, workflow
 * waits, the Proactive Agent, the inbound WhatsApp message queue and the daily backup. The web
 * process then only serves the app (set PROCESS_ROLE=web on it), so a slow AI call or a long
 * mailbox sync can never make the site feel slow, and each side can be restarted and scaled on
 * its own.
 *
 * It is safe to run more than one worker, or to leave background work on in the web process
 * as well: every job takes a database lock (lib/jobs.js) and the queue claims rows with
 * FOR UPDATE SKIP LOCKED.
 *
 * Optional: WORKER_HEALTH_PORT starts a tiny HTTP server with /healthz and /healthz/jobs for
 * platforms that need an HTTP check.
 */
'use strict';
require('dotenv').config();
process.env.PROCESS_ROLE = 'worker';

const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production', tracesSampleRate: 0.1 });
}
process.on('unhandledRejection', reason => {
  console.error('[Worker] UnhandledRejection:', reason && reason.message ? reason.message : reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});
process.on('uncaughtException', err => {
  console.error('[Worker] UncaughtException:', err.message);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});

const db            = require('../db');
const leadsPoller   = require('./services/leads/poller');
const inboundQueue  = require('./services/inbound-queue');
const backupJob     = require('./services/backup-job');
const maintenanceJob = require('./services/maintenance-job');
const waMaintenance = require('./services/whatsapp-maintenance');
const retentionJob = require('./services/retention-job');
const { jobStatus } = require('./lib/jobs');
const { processWhatsAppBatch } = require('./services/whatsapp-inbound');

(async () => {
  const ok = await db.init();                    // creates the schema if missing (serialised by a database lock)
  if (!ok) {
    console.error('[Worker] The database is not ready (missing DATABASE_URL or database setup failed). Exiting.');
    process.exit(1);
  }
  console.log('[Worker] database ready; starting background work');

  leadsPoller.start(db);
  inboundQueue.start(db, (msg, ctx) => processWhatsAppBatch(db, msg, ctx));
  backupJob.start(db);
  maintenanceJob.start(db);
  waMaintenance.start(db);
  retentionJob.start(db);

  let health = null;
  if (process.env.WORKER_HEALTH_PORT) {
    health = require('http').createServer(async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (req.url === '/healthz') return send(200, { ok: true });
        if (req.url === '/healthz/jobs') {
          const st = await jobStatus(db);
          return send(st.stale.length ? 503 : 200, { ok: !st.stale.length, stale: st.stale });
        }
        send(404, { ok: false });
      } catch (e) { send(500, { ok: false, error: e.message }); }
    }).listen(parseInt(process.env.WORKER_HEALTH_PORT, 10), () => console.log('[Worker] health endpoint on port', process.env.WORKER_HEALTH_PORT));
  }

  const shutdown = signal => {
    console.log(`[Worker] ${signal} received — stopping`);
    leadsPoller.stop(); inboundQueue.stop(); backupJob.stop(); maintenanceJob.stop(); waMaintenance.stop(); retentionJob.stop();
    if (health) health.close();
    // Give an in-flight batch a few seconds to finish; unfinished work stays in the queue and is retried.
    setTimeout(() => db.pool.end().catch(() => {}).finally(() => process.exit(0)), 5000);
    setTimeout(() => process.exit(0), 9000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})().catch(e => { console.error('[Worker] failed to start:', e.message); process.exit(1); });
