/**
 * humarains — Admin Seed Script
 *
 * Creates or updates the admin user using credentials from .env.
 * Run once after setting up the database:
 *
 *   npm run seed:admin
 *
 * Required .env variables:
 *   ADMIN_EMAIL     — admin login email
 *   ADMIN_PASSWORD  — admin login password (will be bcrypt-hashed)
 *
 * The script is idempotent: running it again updates the password
 * if the account already exists.
 */

'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { getPlan, UNLIMITED } = require('../src/config/plans');

const BCRYPT_ROUNDS = 12;
const ADMIN_PLAN    = 'business'; // "Pro" — top tier since 'enterprise' was retired/merged into it
const ADMIN_LIMIT   = UNLIMITED; // unlimited Pipeline emails/leads for admin

async function seedAdmin() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('[seed-admin] Error: ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  console.log('[seed-admin] Initialising database schema…');
  const ready = await db.init();
  if (!ready) {
    console.error('[seed-admin] Could not connect to the database. Check your DB_* variables in .env');
    process.exit(1);
  }

  console.log('[seed-admin] Hashing password…');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const existing = await db.Users.findByEmail(email);

  if (existing) {
    console.log(`[seed-admin] Account found (id: ${existing.id}) — updating password and plan…`);
    await db.Users.updatePassword(existing.id, passwordHash);
    await db.Users.update(existing.id, {
      plan:                 ADMIN_PLAN,
      analyses_limit:       ADMIN_LIMIT,
      pipeline_leads_limit: ADMIN_LIMIT,
    });
    console.log(`[seed-admin] ✓ Admin account updated: ${email}`);
  } else {
    const id = crypto.randomBytes(16).toString('hex');
    await db.Users.create({
      id,
      name:         'Admin',
      email,
      passwordHash,
      plan:         ADMIN_PLAN,
    });
    // Set the admin-level limits after creation
    await db.Users.update(id, { analyses_limit: ADMIN_LIMIT, pipeline_leads_limit: ADMIN_LIMIT });
    console.log(`[seed-admin] ✓ Admin account created: ${email} (id: ${id})`);
  }

  await db.pool.end();
  console.log('[seed-admin] Done.');
}

seedAdmin().catch(err => {
  console.error('[seed-admin] Fatal error:', err.message);
  process.exit(1);
});
