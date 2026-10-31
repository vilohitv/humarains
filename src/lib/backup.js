/**
 * lib/backup.js — logical database backups (pg_dump) you can actually restore from.
 *
 * createBackup():
 *   1. pg_dump --format=custom into BACKUP_DIR (credentials go through PG* environment
 *      variables, never on the command line where other users could see them)
 *   2. pg_restore --list on the result: a truncated or corrupt dump fails here, not
 *      during an emergency
 *   3. SHA-256 written next to the file
 *   4. optional AES-256-GCM encryption (BACKUP_PASSPHRASE): dumps contain customer data
 *      and the encrypted integration tokens, so they should never sit around in clear
 *   5. optional upload with the AWS CLI to any S3-compatible bucket (BACKUP_S3_URI)
 *   6. keep only the newest BACKUP_KEEP local files
 *
 * Local disk on most hosts is wiped on every deploy: set BACKUP_S3_URI, or the backup
 * only protects you against a bad query, not against losing the host or the database.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAGIC = Buffer.from('HMRBK1');      // file header for encrypted backups

// ── Child process helper (no shell, output captured) ────────────
function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed on this machine (install the PostgreSQL client tools)`) : e));
    child.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)));
  });
}

// postgres://user:pass@host:port/db  ->  PG* variables
function pgEnv(connectionString) {
  const u = new URL(connectionString);
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  const env = {
    PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode');
  env.PGSSLMODE = ssl || (process.env.DATABASE_SSL === 'false' || isLocal ? 'disable' : 'require');
  return env;
}
const describeTarget = cs => { const u = new URL(cs); return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, '')}`; };

// ── Hash and (de)crypt files ────────────────────────────────────
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// file layout: MAGIC | salt(16) | iv(12) | ciphertext | authTag(16)
function encryptFile(inFile, outFile, passphrase) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = fs.createWriteStream(outFile);
    out.write(Buffer.concat([MAGIC, salt, iv]));
    const input = fs.createReadStream(inFile);
    input.on('error', reject); out.on('error', reject);
    input.pipe(cipher, { end: true });
    cipher.on('data', d => out.write(d));
    cipher.on('end', () => { out.end(cipher.getAuthTag(), () => resolve(outFile)); });
    cipher.on('error', reject);
  });
}

async function decryptFile(inFile, outFile, passphrase) {
  const fd = fs.openSync(inFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(MAGIC.length + 28);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted Humarains backup (wrong header).');
    const salt = head.subarray(MAGIC.length, MAGIC.length + 16), iv = head.subarray(MAGIC.length + 16);
    const tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
    decipher.setAuthTag(tag);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(inFile, { start: head.length, end: size - 17 });
      const out = fs.createWriteStream(outFile);
      input.on('error', reject); out.on('error', reject); decipher.on('error', reject);
      out.on('finish', resolve);
      input.pipe(decipher).pipe(out);
    });
    return outFile;
  } catch (e) {
    try { fs.unlinkSync(outFile); } catch (_) {}
    throw new Error(/Unsupported state|auth/i.test(e.message) ? 'Could not decrypt: wrong passphrase or damaged file.' : e.message);
  } finally { fs.closeSync(fd); }
}

// ── Listing and rotation ────────────────────────────────────────
const BACKUP_RE = /^humarains-\d{8}T\d{6}Z\.dump(\.enc)?$/;
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => BACKUP_RE.test(f)).sort().map(f => path.join(dir, f));
}
function rotate(dir, keep) {
  const files = listBackups(dir);
  const drop = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  drop.forEach(f => { try { fs.unlinkSync(f); fs.unlinkSync(f + '.sha256'); } catch (_) {} });
  return drop.length;
}

// ── The backup ───────────────────────────────────────────────────
async function createBackup(opts = {}) {
  const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  const dir        = opts.dir        || process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
  const keep       = opts.keep       || parseInt(process.env.BACKUP_KEEP, 10) || 14;
  const passphrase = opts.passphrase !== undefined ? opts.passphrase : process.env.BACKUP_PASSPHRASE;
  const s3Uri      = opts.s3Uri      !== undefined ? opts.s3Uri      : process.env.BACKUP_S3_URI;
  const endpoint   = opts.s3Endpoint !== undefined ? opts.s3Endpoint : process.env.BACKUP_S3_ENDPOINT;
  const env = pgEnv(databaseUrl);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let file = path.join(dir, `humarains-${stamp}.dump`);
  const t0 = Date.now();

  try {
    await run('pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-acl', `--file=${file}`], env);
    const listing = await run('pg_restore', ['--list', file]);                        // proves the dump is readable
    const entries = listing.out.split('\n').filter(l => l && !l.startsWith(';')).length;
    if (entries < 10) throw new Error(`dump looks empty (${entries} objects)`);

    if (passphrase) {
      const enc = file + '.enc';
      await encryptFile(file, enc, passphrase);
      fs.unlinkSync(file);
      file = enc;
    }
    const sha = await sha256File(file);
    fs.writeFileSync(file + '.sha256', `${sha}  ${path.basename(file)}\n`);

    let uploaded = false, uploadError = null;
    if (s3Uri) {
      try {
        const base = s3Uri.replace(/\/+$/, '');
        const args = ['s3', 'cp', file, `${base}/${path.basename(file)}`, '--only-show-errors'];
        const args2 = ['s3', 'cp', file + '.sha256', `${base}/${path.basename(file)}.sha256`, '--only-show-errors'];
        if (endpoint) { args.push('--endpoint-url', endpoint); args2.push('--endpoint-url', endpoint); }
        await run('aws', args); await run('aws', args2);
        uploaded = true;
      } catch (e) { uploadError = e.message; }
    }
    const removed = rotate(dir, keep);
    return { file, bytes: fs.statSync(file).size, sha256: sha, objects: entries, encrypted: !!passphrase,
             uploaded, uploadError, offsite: !!s3Uri, rotatedOut: removed, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    try { fs.unlinkSync(file); } catch (_) {}
    throw e;
  }
}

module.exports = { createBackup, listBackups, rotate, encryptFile, decryptFile, sha256File, pgEnv, describeTarget, run };
