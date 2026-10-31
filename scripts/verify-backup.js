/**
 * Restore drill: prove the newest backup can really be restored.
 *
 *   node scripts/verify-backup.js --scratch <postgres-url> [--file <backup>]
 *
 * Restores into a SCRATCH database (never production), then checks that the schema is at the
 * current migration, that core tables exist and that row counts are plausible against the live
 * database. Run it monthly, and after changing how backups are made. Exit code 0 = pass.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* optional */ }
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { listBackups, describeTarget } = require('../src/lib/backup');
const { SCHEMA_VERSION } = require('../db/setup');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const scratch = opt('--scratch') || process.env.VERIFY_DATABASE_URL;

const poolFor = cs => new Pool({ connectionString: cs, ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(cs) ? false : { rejectUnauthorized: false } });

(async () => {
  if (!scratch) { console.error('Usage: node scripts/verify-backup.js --scratch <postgres-url> [--file <backup>]'); process.exit(1); }
  if (process.env.DATABASE_URL && describeTarget(scratch) === describeTarget(process.env.DATABASE_URL)) {
    console.error('Refusing: the scratch database is the production database.'); process.exit(1);
  }
  const dir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
  const file = opt('--file') || listBackups(dir).pop();
  if (!file) { console.error(`No backup found in ${dir}.`); process.exit(1); }
  console.log('Verifying', file, 'into', describeTarget(scratch));

  await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'restore.js'), file, '--target', scratch, '--yes'], { stdio: 'inherit', env: process.env });
    c.on('close', code => code === 0 ? resolve() : reject(new Error('restore step failed')));
  });

  const sp = poolFor(scratch);
  const problems = [];
  try {
    const latest = SCHEMA_VERSION;
    const got = (await sp.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v;
    if (got !== latest) problems.push(`schema is at version ${got}, expected ${latest}`);
    const counts = {};
    for (const t of ['users', 'leads', 'lead_messages', 'workflows']) {
      counts[t] = Number((await sp.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    }
    console.log('Restored row counts:', counts);
    if (process.env.DATABASE_URL) {
      const lp = poolFor(process.env.DATABASE_URL);
      try {
        const live = Number((await lp.query('SELECT count(*) AS n FROM users')).rows[0].n);
        if (live > 0 && counts.users < live * 0.5) problems.push(`backup has ${counts.users} users but the live database has ${live}`);
      } finally { await lp.end(); }
    }
  } finally { await sp.end(); }

  if (problems.length) { console.error('\nVERIFY FAILED:\n - ' + problems.join('\n - ')); process.exit(1); }
  console.log('\nVERIFY PASSED: the backup restores cleanly and matches the current schema.');
})().catch(e => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
