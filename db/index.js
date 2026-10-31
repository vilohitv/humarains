/**
 * Humarains — Database Layer (Supabase / PostgreSQL)
 *
 * Requires: DATABASE_URL  (Supabase connection string, Transaction pooler recommended)
 *   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
 *
 * Optional:
 *   DATABASE_POOL_MAX   connections per app instance (default 10)
 *   DATABASE_SSL=false  turn TLS off (local Postgres). Local hosts are detected automatically.
 *
 * The schema is the single file db/schema.sql, applied once on startup by db/setup.js.
 */
'use strict';
const { Pool } = require('pg');
const { setup } = require('./setup');

// ── Connection pool ───────────────────────────────────────────────────────────
let pool = null;

function getPool() {
  if (pool) return pool;

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error(
      '[DB] DATABASE_URL is not set. Add it to your Render environment variables.\n' +
      '     Get it from: Supabase Dashboard → Settings → Database → Connection string (URI)'
    );
  }

  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
  const useSsl  = process.env.DATABASE_SSL !== 'false' && !isLocal;

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DATABASE_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });

  return pool;
}

// ── Helper: convert ? placeholders → $1, $2, … for PostgreSQL ────────────────
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── JSON field parser ─────────────────────────────────────────────────────────
// PostgreSQL returns jsonb columns already parsed; guard for any text columns.
function parseJsonFields(row) {
  if (!row) return row;
  const JSON_FIELDS = ['metadata', 'integrations'];
  const out = { ...row };
  for (const f of JSON_FIELDS) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch (_) {}
    }
  }
  return out;
}

// ── Core query helpers ────────────────────────────────────────────────────────
async function query(sql, params = []) {
  const pg = getPool();
  const pgSql = convertPlaceholders(sql);
  const result = await pg.query(pgSql, params);
  return result;
}

async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return parseJsonFields(result.rows[0] || null);
}

async function queryAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows.map(parseJsonFields);
}

// ── Health check ──────────────────────────────────────────────────────────────
async function ping() {
  try {
    const res = await query('SELECT version() AS version');
    return { ok: true, version: res.rows[0]?.version };
  } catch (err) {
    console.error('[DB] Ping failed:', err.message);
    return { ok: false, error: err.message };
  }
}


// ── Schema ────────────────────────────────────────────────────────────────────
// Creates the schema from db/schema.sql if the database is empty. Returns true when
// the database is ready, false when there is no DATABASE_URL (dev mode) or setup
// failed (the error is logged and the database is left untouched).
async function init() {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set — skipping schema setup (dev mode).');
    return false;
  }
  try {
    const ran = await setup(getPool());
    console.log(ran.length ? '[DB] Schema created.' : '[DB] Schema is up to date.');
    return true;
  } catch (err) {
    console.error('[DB] ' + err.message);
    return false;
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────
const { getPlan } = require('../src/config/plans');

const Users = {
  async create({ id, name, email, passwordHash, googleId, avatarUrl, plan, analysesLimit, company, industry, integrations }) {
    const planConf = getPlan(plan || 'free');
    await query(
      `INSERT INTO users (id, name, email, password_hash, google_id, avatar_url, plan, analyses_limit, company, industry, integrations)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, email, passwordHash || null, googleId || null, avatarUrl || null, plan || 'free',
       analysesLimit !== undefined ? analysesLimit : 0,
       company || null, industry || null, integrations ? JSON.stringify(integrations) : null]
    );
    return queryOne('SELECT * FROM users WHERE id=?', [id]);
  },
  async findById(id) {
    return queryOne('SELECT * FROM users WHERE id=?', [id]);
  },
  async findByEmail(email) {
    return queryOne('SELECT * FROM users WHERE LOWER(email)=LOWER(?)', [email]);
  },
  async findByGoogleId(googleId) {
    return queryOne('SELECT * FROM users WHERE google_id=?', [googleId]);
  },
  async findByStripeCustomerId(stripeCustomerId) {
    return queryOne('SELECT * FROM users WHERE stripe_customer_id=?', [stripeCustomerId]);
  },
  async update(id, fields) {
    const allowed = ['name', 'email', 'password_hash', 'plan', 'analyses_limit', 'analyses_used',
      'usage_reset_at',
      'stripe_customer_id', 'stripe_subscription_id', 'company', 'industry',
      'is_banned', 'google_id', 'avatar_url', 'integrations',
    ];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k) || v === undefined) continue;
      // integrations is already stringified by saveUserIntegrations — don't double-stringify
      if (k === 'integrations' && typeof v === 'string') {
        vals.push(v);
      } else {
        vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
      }
      sets.push(`${k}=?`);
    }
    if (!sets.length) return queryOne('SELECT * FROM users WHERE id=?', [id]);
    sets.push('updated_at=NOW()');
    vals.push(id);
    await query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, vals);
    return queryOne('SELECT * FROM users WHERE id=?', [id]);
  },
  async incrementAnalyses(id) {
    await query('UPDATE users SET analyses_used=analyses_used+1, updated_at=NOW() WHERE id=?', [id]);
    return queryOne('SELECT * FROM users WHERE id=?', [id]);
  },
  // Resets analyses_used (Pipeline cold-email sends)
  // (Pipeline lead-discovery count) once a new calendar month has started.
  // Returns the user row, refreshed if a reset happened.
  async resetMonthlyUsageIfNeeded(user) {
    if (!user) return user;
    const resetAt = user.usage_reset_at ? new Date(user.usage_reset_at) : null;
    const now = new Date();
    if (resetAt && resetAt.getMonth() === now.getMonth() && resetAt.getFullYear() === now.getFullYear()) {
      return user;
    }
    return this.update(user.id, {
      analyses_used: 0,
      usage_reset_at: now.toISOString(),
    });
  },
  async updatePassword(id, passwordHash) {
    return query('UPDATE users SET password_hash=?, updated_at=NOW() WHERE id=?', [passwordHash, id]);
  },
  async listAll(limit = 200) {
    return queryAll(
      'SELECT id, name, email, plan, analyses_used, analyses_limit, company, industry, is_banned, integrations, created_at FROM users ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
  },
  async count() {
    const r = await queryOne('SELECT COUNT(*) AS n FROM users');
    return parseInt(r?.n ?? r?.count ?? 0, 10);
  },
  async delete(id) { return query('DELETE FROM users WHERE id=?', [id]); },
};

// ── Billing History ───────────────────────────────────────────────────────────
const BillingHistory = {
  async create({ id, userId, stripeInvoiceId, event, amount, currency, status, description, metadata }) {
    await query(
      `INSERT INTO billing_history (id, user_id, stripe_invoice_id, event, amount, currency, status, description, metadata)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, userId, stripeInvoiceId || null, event || null, amount || 0, currency || 'usd',
       status || 'succeeded', description || null, metadata ? JSON.stringify(metadata) : null]
    );
    return queryOne('SELECT * FROM billing_history WHERE id=?', [id]);
  },
  async listByUser(userId) {
    return queryAll('SELECT * FROM billing_history WHERE user_id=? ORDER BY created_at DESC', [userId]);
  },
};

// ── Admin Settings ────────────────────────────────────────────────────────────
const AdminSettings = {
  async get(key) {
    const row = await queryOne('SELECT value FROM admin_settings WHERE key=?', [key]);
    return row ? row.value : null;
  },
  async set(key, value) {
    await query(
      `INSERT INTO admin_settings (key, value) VALUES (?,?)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value]
    );
  },
  async getAll() {
    const rows = await queryAll('SELECT key, value FROM admin_settings');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  async isMaintenanceMode() {
    const v = await this.get('maintenance_mode');
    return v === '1' || v === 'true';
  },
  async isSignupsEnabled() {
    const v = await this.get('signups_enabled');
    return v === null || v === '1' || v === 'true'; // default open
  },
  async isFreeTierEnabled() {
    const v = await this.get('free_tier_analyses');
    return v === null || v === '1' || v === 'true'; // default on
  },
};

async function runRaw(statements) {
  const stmts = Array.isArray(statements) ? statements : [statements];
  for (const s of stmts) {
    if (s && s.trim()) {
      await getPool().query(s.trim()).catch(err => {
        // "already exists" / "does not exist" are acceptable for IF NOT EXISTS
        if (!err.message.includes('already exists') && !err.message.includes('does not exist')) throw err;
      });
    }
  }
}

// ── Business Knowledge (Company Knowledge AI) ─────────────────────────────
const KNOWLEDGE_CATEGORIES = ['pricing', 'faq', 'product', 'service', 'competitor', 'process'];

const BusinessKnowledge = {
  CATEGORIES: KNOWLEDGE_CATEGORIES,
  async create({ id, userId, category, title, content, fileName }) {
    await query(
      `INSERT INTO business_knowledge (id, user_id, category, title, content, file_name) VALUES (?,?,?,?,?,?)`,
      [id, userId, KNOWLEDGE_CATEGORIES.includes(category) ? category : 'faq', title, content, fileName || null]
    );
    return this.findById(id, userId);
  },
  async findById(id, userId) {
    return queryOne('SELECT * FROM business_knowledge WHERE id=? AND user_id=?', [id, userId]);
  },
  async listByUser(userId) {
    return queryAll('SELECT * FROM business_knowledge WHERE user_id=? ORDER BY category ASC, updated_at DESC', [userId]);
  },
  async update(id, userId, fields) {
    const allowed = ['category', 'title', 'content', 'file_name'];
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields || {})) {
      if (!allowed.includes(k) || v === undefined) continue;
      if (k === 'category' && !KNOWLEDGE_CATEGORIES.includes(v)) continue;
      sets.push(`${k}=?`); vals.push(v);
    }
    if (!sets.length) return this.findById(id, userId);
    sets.push('updated_at=NOW()');
    await query(`UPDATE business_knowledge SET ${sets.join(',')} WHERE id=? AND user_id=?`, [...vals, id, userId]);
    return this.findById(id, userId);
  },
  async delete(id, userId) {
    await query('DELETE FROM business_knowledge WHERE id=? AND user_id=?', [id, userId]);
  },
  async countByUser(userId) {
    const r = await queryOne('SELECT COUNT(*) AS n FROM business_knowledge WHERE user_id=?', [userId]);
    return parseInt(r?.n ?? 0, 10);
  },
};

module.exports = {
  query, queryOne, queryAll,
  Users, BillingHistory, AdminSettings,
  BusinessKnowledge,
  init, ping, runRaw,
  get pool() { return getPool(); },
};
