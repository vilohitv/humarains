/**
 * Humarains — database setup
 *
 * Creates the database from db/schema.sql, the single source of truth.
 *
 *   • The file runs once, in one transaction: it fully applies or not at all.
 *   • A transaction-level advisory lock serialises deploys, so two instances
 *     starting at once cannot both create the schema. (Transaction-level, not
 *     session-level, so it is also safe behind a transaction pooler.)
 *   • The result is recorded in schema_migrations (one row), so later starts
 *     skip it and backups can be checked against the current schema version.
 *   • A database that was built by the old numbered migrations already has this
 *     exact schema; it is recognised and recorded without re-running anything.
 *
 * CLI:   node db/setup.js           create the schema if it is missing
 *        node db/setup.js status    show whether it is applied
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const SCHEMA_VERSION = '0001';
const SCHEMA_NAME = '0001_schema';
const LOCK_KEY = 727001;   // arbitrary, fixed id for pg_advisory_xact_lock

function readSchema(file = SCHEMA_FILE) {
  const sql = fs.readFileSync(file, 'utf8');
  return { sql, checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16) };
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text        PRIMARY KEY,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      duration_ms integer     NOT NULL DEFAULT 0,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
}

async function status(pool, { file } = {}) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const row = (await client.query('SELECT checksum, applied_at FROM schema_migrations WHERE version = $1', [SCHEMA_VERSION])).rows[0];
    return {
      name: SCHEMA_NAME,
      applied: !!row,
      appliedAt: row ? row.applied_at : null,
      changedSinceApplied: !!row && row.checksum !== readSchema(file).checksum,
    };
  } finally {
    client.release();
  }
}

/**
 * Create the schema if it has not been created yet. Resolves with [name] when it
 * ran and [] when there was nothing to do. Throws (after rolling back) on failure.
 */
async function setup(pool, { log = console, file } = {}) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const done = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [SCHEMA_VERSION]);
      const { sql, checksum } = readSchema(file);
      if (done.rows.length) {                                 // created earlier, or by another instance while we waited
        await client.query('ROLLBACK');
        if (done.rows[0].checksum !== checksum) {
          log.warn('[DB] db/schema.sql changed after the database was created. Existing databases are not altered automatically; recreate the database to apply the change.');
        }
        return [];
      }
      const existing = await client.query("SELECT to_regclass('public.users') AS users, (SELECT count(*) FROM schema_migrations) AS n");
      let ran = [];
      if (existing.rows[0].users) {
        // Built by the retired numbered migrations (same schema): record it, change nothing.
        log.log('[DB] Existing schema detected; recording it as current.');
      } else {
        await client.query("SET LOCAL statement_timeout = 0");
        await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query(sql);
        ran = [SCHEMA_NAME];
        log.log(`[DB] Created schema (${Date.now() - t0} ms)`);
      }
      await client.query('DELETE FROM schema_migrations');    // drop the retired per-migration rows
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
        [SCHEMA_VERSION, SCHEMA_NAME, checksum, Date.now() - t0]
      );
      await client.query('COMMIT');
      return ran;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      err.message = `Database setup failed and was rolled back: ${err.message}`;
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { setup, status, readSchema, SCHEMA_FILE, SCHEMA_VERSION, SCHEMA_NAME };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try { require('dotenv').config(); } catch (_) { /* dotenv is optional here */ }
  const db = require('./index');
  (async () => {
    if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
    try {
      if (process.argv[2] === 'status') {
        const s = await status(db.pool);
        console.log(`${s.applied ? '✓' : '·'} ${s.name}${s.applied ? '  ' + new Date(s.appliedAt).toISOString() : '  (not applied)'}${s.changedSinceApplied ? '  (schema.sql changed since)' : ''}`);
      } else {
        const ran = await setup(db.pool);
        console.log(ran.length ? 'Database schema created.' : 'Database is up to date.');
      }
      await db.pool.end();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
