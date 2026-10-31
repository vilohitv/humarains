/**
 * Retention — deletes old, low-value rows so the busiest tables stay small.
 *
 *   node scripts/prune.js             delete
 *   node scripts/prune.js --dry-run   only count what would go
 *
 * The worker runs it daily on its own (services/maintenance-job.js); run it by hand any time. Deletes happen in batches of
 * 5,000 so no single statement holds locks for long. Leads, settings, billing
 * and knowledge are never touched.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* optional */ }
const db = require('../db');

const DRY = process.argv.includes('--dry-run');
const BATCH = 5000;

const RULES = [
  { name: 'security_audit_log (older than 180 days)', table: 'security_audit_log',
    where: "created_at < now() - interval '180 days'" },
  { name: 'workflow_runs finished more than 90 days ago (events go with them)', table: 'workflow_runs',
    where: "status IN ('completed','failed','cancelled') AND COALESCE(completed_at, updated_at) < now() - interval '90 days'" },
  { name: 'lead_followup_jobs finished more than 90 days ago', table: 'lead_followup_jobs',
    where: "status IN ('sent','failed','cancelled') AND updated_at < now() - interval '90 days'" },
  { name: 'agent_tasks finished more than 180 days ago', table: 'agent_tasks',
    where: "status <> 'running' AND created_at < now() - interval '180 days'" },
  { name: 'agent_proposals decided more than 180 days ago', table: 'agent_proposals',
    where: "status <> 'pending' AND created_at < now() - interval '180 days'" },
  { name: 'inbound_events handled more than 30 days ago', table: 'inbound_events',
    where: "status = 'done' AND processed_at < now() - interval '30 days'" },
  { name: 'inbound_events given up on more than 90 days ago', table: 'inbound_events',
    where: "status = 'dead' AND processed_at < now() - interval '90 days'" },
];

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  let total = 0;
  try {
    for (const r of RULES) {
      let n = 0;
      if (DRY) {
        n = parseInt((await db.queryOne(`SELECT count(*) AS n FROM ${r.table} WHERE ${r.where}`)).n, 10);
      } else {
        for (;;) {
          const res = await db.query(
            `DELETE FROM ${r.table} WHERE ctid IN (SELECT ctid FROM ${r.table} WHERE ${r.where} LIMIT ${BATCH})`);
          n += res.rowCount;
          if (res.rowCount < BATCH) break;
        }
      }
      total += n;
      console.log(`${DRY ? 'would delete' : 'deleted'} ${String(n).padStart(7)}  ${r.name}`);
    }
    console.log(`${DRY ? 'Dry run: ' : ''}${total} row(s) ${DRY ? 'eligible' : 'removed'}.`);
  } catch (err) {
    console.error(err.message); process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
