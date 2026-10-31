/**
 * Restore a backup into a database.
 *
 *   node scripts/restore.js <backup-file> --target <postgres-url> --yes [--allow-production]
 *
 * Safety:
 *   • --target is required. It never silently uses DATABASE_URL.
 *   • Restoring over the database named in DATABASE_URL needs --allow-production.
 *   • The SHA-256 next to the file is checked first; encrypted files need BACKUP_PASSPHRASE.
 *   • The restore is one transaction: it fully applies or the target is left as it was.
 *   • Afterwards db/setup.js runs, so the restored database is recorded at the
 *     current schema version (backups carry the schema, so nothing is altered).
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* optional */ }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, pgEnv, describeTarget, sha256File, decryptFile } = require('../src/lib/backup');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const file = args.find(a => !a.startsWith('--') && a !== opt('--target'));
const target = opt('--target');

(async () => {
  if (!file || !target) { console.error('Usage: node scripts/restore.js <backup-file> --target <postgres-url> --yes [--allow-production]'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('Backup file not found:', file); process.exit(1); }
  const desc = describeTarget(target);
  if (process.env.DATABASE_URL && describeTarget(process.env.DATABASE_URL) === desc && !flag('--allow-production')) {
    console.error(`Refusing: ${desc} is the database in DATABASE_URL. Pass --allow-production if you really mean to overwrite it.`); process.exit(1);
  }
  if (!flag('--yes')) { console.error(`This replaces the contents of ${desc} with ${path.basename(file)}. Re-run with --yes to continue.`); process.exit(1); }

  // 1. integrity
  const shaFile = file + '.sha256';
  if (fs.existsSync(shaFile)) {
    const want = fs.readFileSync(shaFile, 'utf8').split(/\s+/)[0];
    const got = await sha256File(file);
    if (want !== got) { console.error('Checksum mismatch: the backup file is damaged. Use an older backup.'); process.exit(1); }
    console.log('Checksum OK');
  } else console.warn('No .sha256 file next to the backup: integrity not checked.');

  // 2. decrypt if needed
  let dump = file, tmp = null;
  if (file.endsWith('.enc')) {
    if (!process.env.BACKUP_PASSPHRASE) { console.error('This backup is encrypted: set BACKUP_PASSPHRASE.'); process.exit(1); }
    tmp = path.join(os.tmpdir(), `humarains-restore-${process.pid}.dump`);
    await decryptFile(file, tmp, process.env.BACKUP_PASSPHRASE);
    dump = tmp; console.log('Decrypted');
  }

  // 3. restore (one transaction)
  console.log(`Restoring into ${desc} …`);
  try {
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', `--dbname=${pgEnv(target).PGDATABASE}`, dump], pgEnv(target));
  } finally { if (tmp) try { fs.unlinkSync(tmp); } catch (_) {} }
  console.log('Data restored.');

  // 4. bring the schema up to the current release
  await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'db', 'setup.js')], { env: { ...process.env, DATABASE_URL: target }, stdio: 'inherit' });
    c.on('close', code => code === 0 ? resolve() : reject(new Error('schema setup failed after restore')));
  });
  console.log('\nDone. Next: point DATABASE_URL at this database, redeploy, then follow the checklist in docs/DISASTER_RECOVERY.md (webhooks, secrets, smoke test).');
})().catch(e => { console.error('Restore FAILED:', e.message); process.exit(1); });
