/**
 * services/maintenance-job.js — daily retention cleanup (scripts/prune.js).
 *
 * The privacy policy promises that processing records are not kept indefinitely
 * (handled inbound messages: 30 days; failed ones: 90 days; audit log, finished
 * workflow runs, follow-up jobs and so on are bounded too). That only holds if the
 * cleanup really runs, so the worker runs it every day instead of relying on someone
 * remembering to schedule a cron job. Takes the database lock, so several processes
 * cannot run it at once; the schedule lives in job_runs, so restarts do not repeat it.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { runJob } = require('../lib/jobs');

const HOUR_UTC = 4;
let _timer = null;

function runPrune() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'prune.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim().split('\n').pop()) : reject(new Error(`prune exited with ${code}: ${(err || out).trim().slice(-300)}`)));
  });
}

async function check(db) {
  const row = await db.queryOne(`SELECT last_success_at, last_finished_at FROM job_runs WHERE name = 'db_prune'`, []);
  const lastOk = row && row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
  const lastTry = row && row.last_finished_at ? new Date(row.last_finished_at).getTime() : 0;
  if (Date.now() - lastOk < 23 * 3600_000) return;                // done today
  if (Date.now() - lastTry < 3600_000) return;                    // failed recently: wait an hour
  if (lastOk && new Date().getUTCHours() < HOUR_UTC) return;      // wait for the quiet hour (the first run goes ahead at once)
  await runJob(db, 'db_prune', async () => { console.log('[Maintenance] retention cleanup:', await runPrune()); });
}

function start(db) {
  if (_timer) return;
  const tick = () => check(db).catch(e => console.error('[Maintenance] check failed:', e.message));
  setTimeout(tick, 3 * 60_000).unref();
  _timer = setInterval(tick, 15 * 60_000);
  _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, check };
