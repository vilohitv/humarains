/**
 * services/backup-job.js — daily database backup, started by the worker (or by the web
 * process when no separate worker exists). Off unless BACKUP_ENABLED=true.
 *
 *   BACKUP_HOUR_UTC   hour of day (UTC) to take it, default 3
 *   everything else   see lib/backup.js (BACKUP_DIR, BACKUP_KEEP, BACKUP_PASSPHRASE, BACKUP_S3_URI …)
 *
 * The schedule lives in the database (job_runs), so restarts and several processes
 * cannot cause a second backup the same day. A failed attempt is retried after an hour.
 */
'use strict';
const { runJob } = require('../lib/jobs');
const { createBackup } = require('../lib/backup');

let _timer = null;

async function check(db) {
  const hour = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR_UTC, 10) || 3));
  const row = await db.queryOne(`SELECT last_success_at, last_finished_at FROM job_runs WHERE name = 'db_backup'`, []);
  const lastOk = row && row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
  const lastTry = row && row.last_finished_at ? new Date(row.last_finished_at).getTime() : 0;
  if (Date.now() - lastOk < 23 * 3600_000) return;                      // already backed up today
  if (Date.now() - lastTry < 3600_000) return;                          // failed recently: wait an hour
  if (lastOk && new Date().getUTCHours() < hour) return;                // wait for the quiet hour (first ever backup runs at once)
  await runJob(db, 'db_backup', async () => {
    const r = await createBackup();
    console.log(`[Backup] ${r.file} — ${(r.bytes / 1048576).toFixed(1)} MB, ${r.encrypted ? 'encrypted' : 'NOT encrypted'}, ${r.offsite ? (r.uploaded ? 'uploaded off-site' : 'UPLOAD FAILED') : 'local only'}`);
    if (r.offsite && !r.uploaded) throw new Error('backup was made but the off-site upload failed: ' + r.uploadError);
    return r;
  });
}

function start(db) {
  if (process.env.BACKUP_ENABLED !== 'true' || _timer) return;
  if (!process.env.BACKUP_S3_URI) console.warn('[Backup] BACKUP_S3_URI is not set: backups stay on this machine and will not survive losing it.');
  if (!process.env.BACKUP_PASSPHRASE) console.warn('[Backup] BACKUP_PASSPHRASE is not set: backups will not be encrypted.');
  const tick = () => check(db).catch(e => console.error('[Backup] check failed:', e.message));
  setTimeout(tick, 2 * 60_000).unref();
  _timer = setInterval(tick, 10 * 60_000);
  _timer.unref();
  console.log('[Backup] daily backup enabled');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, check };
