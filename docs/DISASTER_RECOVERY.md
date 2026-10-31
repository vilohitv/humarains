# Backup and disaster recovery

This is the runbook. Read it once now, not during an outage.

## What can go wrong, and what saves you

| Failure | Protection | Typical recovery time |
|---|---|---|
| A bad deploy | Render keeps the previous release; roll back in the dashboard | minutes |
| A bad query or a wrongly deleted row | Provider point-in-time recovery (if enabled), else the latest daily backup | 30 to 90 min |
| The database is corrupted or deleted | Latest backup restored into a new database | 1 to 2 hours |
| The database provider has an outage or loses the project | Off-site encrypted backup restored at another provider | 2 to 4 hours |
| The web host is lost | `render.yaml` rebuilds both services from git; data lives in the database | 30 to 60 min |
| A secret is lost (see below) | Only a copy kept outside the app saves you | n/a |

**Targets this setup gives you.** Recovery point: up to 24 hours of data with the daily backup alone; minutes if your database provider's point-in-time recovery is switched on (strongly recommended, it is the only thing that covers "yesterday 15:00"). Recovery time: 1 to 4 hours, depending on database size and who is at the keyboard.

## 1. What is backed up, and what is not

**In the backup (the whole Postgres database):** users, plans and billing records, leads, every message (`lead_messages` and the history on each lead), business settings and knowledge, workflows, follow-up jobs, the agent's data, and the encrypted WhatsApp and email credentials.

**Not in the backup, and so needed separately:**

1. **`JWT_SECRET`.** It signs logins *and* is the key that encrypts the stored email passwords. Restore the database with a different value and every connected mailbox becomes unreadable (customers must reconnect). Keep a copy in a password manager.
2. **`BACKUP_PASSPHRASE`.** Without it the encrypted backups cannot be opened. Keep it outside the database, the host and the bucket that holds the backups.
3. **Your other environment variables** (Stripe, Meta, Google, Resend, Anthropic, Sentry). `render.yaml` lists every name. Keep the values in a password manager.
4. **Third-party configuration:** the Meta webhook URL and verify token, the Stripe webhook endpoint, and Google OAuth redirect URLs. They point at your domain, so they survive a rebuild on the same domain and need updating if the domain changes.

Customer photos are analysed and not stored, so there are no files to back up.

## 2. Turn the backups on

1. **Provider backups first.** In your database provider (Supabase: Database, Backups), turn on daily backups, and point-in-time recovery if your plan allows it. This is your fastest recovery.
2. **Our own encrypted, off-site copy.** This is what protects you if the provider itself is the problem. On the `humarains-worker` service set:
   - `BACKUP_ENABLED=true`
   - `BACKUP_PASSPHRASE`: a long random string. Save it in your password manager *before* the first backup.
   - `BACKUP_S3_URI` (for example `s3://humarains-backups/db`), plus `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `BACKUP_S3_ENDPOINT` for non-AWS providers (Cloudflare R2, Backblaze B2). Use a bucket in a different company and region from the database, with a lifecycle rule that deletes files after **no more than 90 days**. The Privacy Policy promises that deleted data leaves backups within 90 days, so do not keep them longer (and do not turn on bucket versioning that retains old copies past that).
3. The worker takes one backup a day at `BACKUP_HOUR_UTC` (default 03:00 UTC). The first one runs a few minutes after it starts. The schedule is stored in the database, so restarts and extra workers never cause duplicates.
4. Check it: `/api/admin/ops` lists the `db_backup` job with its last success; `/healthz/jobs` turns red if it stops.

Take one by hand any time: `npm run backup` (needs `pg_dump` and `pg_restore`; the Docker image has them).

What a backup is: a `pg_dump` in custom format, compressed, checked with `pg_restore --list` straight after it is written, given a SHA-256 file, then encrypted with AES-256-GCM. Local copies are rotated (`BACKUP_KEEP`); the bucket's lifecycle rule handles old off-site copies.

## 3. Restore drill (do this monthly, and after changing backups)

A backup you have never restored is a hope, not a backup.

```
# a scratch database that is NOT production (a free Supabase project or a local Postgres works)
export VERIFY_DATABASE_URL=postgres://...scratch...
# download the newest file and its .sha256 from the bucket into ./backups, then
export BACKUP_PASSPHRASE=...
npm run backup:verify -- --scratch "$VERIFY_DATABASE_URL"
```

It restores the newest backup into the scratch database, records the schema version, checks that the schema is current, that the tables exist, and that the user count is plausible against production. Exit code 0 and the line `VERIFY PASSED` mean it works. Write the date and result in your ops log. If it fails, fix that before anything else: you currently have no working backup.

## 4. Recovery procedures

### A. A bad change you want to undo (data still there)
1. If point-in-time recovery is on, restore to just before the change from the provider's dashboard into a **new** database, copy the affected rows back, and leave the live database running.
2. Otherwise restore the latest backup into a scratch database (section 3), read the rows you need, and put them back with SQL. Do not restore over the live database for a small problem.

### B. The database is gone or corrupt
1. **Stop the writers** so nothing writes to a broken or half-restored database: set `PROCESS_ROLE=web` on the web service and suspend `humarains-worker`. Or put the site in maintenance mode from the admin panel.
2. **Create a new empty Postgres database** (same provider, or another). Note its connection string.
3. **Get the newest backup**: from the bucket, or from your provider's own backups if they are newer. Download the `.dump.enc` file and its `.sha256` next to it.
4. **Restore it:**
   ```
   export BACKUP_PASSPHRASE=...
   node scripts/restore.js ./backups/humarains-YYYYMMDDTHHMMSSZ.dump.enc --target "postgres://NEW-DATABASE-URL" --yes
   ```
   It checks the checksum, decrypts, restores in a single transaction (all or nothing), then runs the schema setup (which records the version). It will not touch the database named in `DATABASE_URL` unless you add `--allow-production`.
5. **Point the app at it.** Set `DATABASE_URL` on the web service **and** the worker to the new database. Make sure `JWT_SECRET` is unchanged.
6. **Start everything**, worker first, then web. Set `PROCESS_ROLE` back as it was.
7. **Smoke test** (section 5).
8. **Catch up on what was lost.** Messages that arrived after the backup are not in it. Meta retries webhooks the app did not acknowledge for a few days, so messages that arrived while the app was down usually come through once it is back; messages it had already been told were received before the failure will not be re-sent, so ask affected customers if needed. Check the Stripe dashboard for subscription changes made in the gap (replay the webhook events for that period from Stripe's dashboard).

### C. The database provider or region is down for a long time
Same as B, restoring the off-site backup into a database at a different provider. This is the case the off-site copy exists for.

### D. The web host is lost
Create a new Blueprint from `render.yaml` (it recreates both services), fill in the environment variables from your password manager, and keep the same domain. The database is unaffected.

## 5. After any restore: smoke test

1. `GET /readyz` returns 200, and `GET /healthz/jobs` returns 200 a few minutes after the worker starts.
2. Log in as a real account and open Leads: recent leads and their conversations are there.
3. Send a WhatsApp message to a connected number from another phone. Within about 10 seconds the reply arrives, and the message shows under the lead.
4. In `/api/admin/ops`: no stale jobs, the queue is empty, and `deadMessages` is empty or understood.
5. A connected mailbox polls without a decryption error in the logs (this confirms `JWT_SECRET`).
6. Re-check the Meta webhook URL, the Stripe endpoint and the Google redirect URLs if the domain changed.

## 6. Roles and contacts (fill in)

- Who decides to start a restore: __________
- Who has the password manager with the secrets: __________
- Database provider support link and project id: __________
- Where customer communication goes during an incident: __________

## 7. Known limits

- A daily backup can lose up to a day of data. Point-in-time recovery at the provider is what closes that gap.
- The backup is logical (`pg_dump`). It scales fine into the tens of gigabytes; beyond that, rely on the provider's physical backups and keep ours as the off-site copy.
- A stuck job holds a database transaction while it runs. Do not set a database-wide `idle_in_transaction_session_timeout` shorter than a few minutes.
