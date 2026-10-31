/**
 * Take a database backup now.
 *
 *   node scripts/backup.js
 *
 * Env: DATABASE_URL (required), BACKUP_DIR (default ./backups), BACKUP_KEEP (default 14),
 *      BACKUP_PASSPHRASE (encrypt the file), BACKUP_S3_URI + BACKUP_S3_ENDPOINT (upload with the AWS CLI).
 * Needs the PostgreSQL client tools (pg_dump, pg_restore) on the machine. See docs/DISASTER_RECOVERY.md.
 */
'use strict';
try { require('dotenv').config(); } catch (_) { /* optional */ }
const { createBackup } = require('../src/lib/backup');

createBackup().then(r => {
  console.log(`Backup written: ${r.file}`);
  console.log(`  size ${(r.bytes / 1048576).toFixed(2)} MB, ${r.objects} objects, sha256 ${r.sha256.slice(0, 16)}…, ${r.encrypted ? 'encrypted' : 'NOT encrypted (set BACKUP_PASSPHRASE)'}, ${r.seconds}s`);
  if (r.offsite) console.log(r.uploaded ? '  uploaded off-site' : `  UPLOAD FAILED: ${r.uploadError}`);
  else console.log('  not uploaded off-site (set BACKUP_S3_URI): a local copy does not survive losing the host');
  if (r.rotatedOut) console.log(`  removed ${r.rotatedOut} old local backup(s)`);
  if (r.offsite && !r.uploaded) process.exitCode = 2;
}).catch(e => { console.error('Backup FAILED:', e.message); process.exit(1); });
