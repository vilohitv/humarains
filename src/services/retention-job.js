/** Hourly background job for the activation nudges (see services/retention.js). Runs in the worker, under a DB lock. */
'use strict';
const { runJob } = require('../lib/jobs');
const retention = require('./retention');

const TICK_MS = 60 * 60_000;
let _timer = null;

const tick = db => runJob(db, 'retention', async () => ({ nudges: await retention.sendActivationNudges(db) }));

function start(db) {
  if (_timer) return;
  const run = () => tick(db).catch(e => console.error('[retention] tick failed:', e.message));
  setTimeout(run, 90_000).unref();
  _timer = setInterval(run, TICK_MS);
  _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick };
