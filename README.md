# Humarains

**An AI agent that handles enquiries and bookings for local service businesses.** Plumbers, electricians, cleaners, landscapers and similar trades lose jobs by replying to enquiries too slowly. Humarains watches the owner's inbox and WhatsApp, answers every new enquiry in seconds with a quote taken from the owner's real prices, books the job into the owner's calendar, follows up when the customer goes quiet, and hands the conversation to the owner when a person is needed.

This file is the single reference for the project: what it does, how it is built, how the database works, how to run and deploy it, and what to build next.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Plans](#2-plans)
3. [Architecture](#3-architecture)
4. [Project structure](#4-project-structure)
5. [Database](#5-database)
6. [Getting started](#6-getting-started)
7. [Configuration](#7-configuration)
8. [Deploying](#8-deploying)
9. [Feature reference](#9-feature-reference)
10. [WhatsApp setup](#10-whatsapp-setup)
11. [Testing](#11-testing)
12. [Known limitations and next steps](#12-known-limitations-and-next-steps)

---

## 1. What it does

### The lead lifecycle

```
 enquiry arrives                     email (IMAP poll) · website form (POST /api/leads/ingest) · WhatsApp webhook
        │
        ▼
 AI reads it                         intent, service, urgency, quantity, customer name
        │
        ▼
 quote engine                        deterministic maths from the owner's per-service prices (no invented numbers)
        │
        ▼
 human review check                  needs a person? → parked for the owner, nothing sent
        │
        ▼
 AI reply                            autonomous mode: sent at once · consent mode: waits for the owner's OK
        │
        ▼
 follow-ups                          Day 1 check-in · Day 3 availability nudge · Day 7 graceful close (cancelled if the customer replies)
        │
        ▼
 conversation continues              replies are matched to the thread; booking links and calendar events are offered
```

### Main capabilities

| Area | What it does |
|---|---|
| **Inbox** | Connects to the owner's own mailbox over IMAP/SMTP (credentials encrypted at rest), polls it, and answers from the owner's address. |
| **WhatsApp** | One-click "Connect with WhatsApp" (Meta Embedded Signup). Inbound messages arrive by webhook; replies go out through the owner's number. |
| **Quote engine** | Each service carries its own pricing: fixed, from, hourly, per unit or site-visit-only, plus minimum charge, call-out and travel fees, emergency / after-hours / weekend / holiday surcharges, materials, tax, add-ons, deposit, warranty, exclusions and "what to ask first". The AI quotes only from this list. |
| **Agent modes** | *Autonomous* (replies go out automatically) or *Consent* (every reply waits for approval). Free plans are locked to consent. |
| **Human review** | The AI judges whether a lead needs a person. Those leads are parked in a queue with the reason, and nothing is sent until the owner replies. |
| **Follow-ups** | A durable job queue sends the Day 1 / 3 / 7 sequence, survives restarts, and stops when the customer answers. |
| **Calendar** | Google Calendar connection: shows upcoming appointments and creates events for booked jobs. |
| **Workflows** | A visual builder: trigger → steps (send, wait, wait for reply, AI extract, condition, AI decision, update status, notify owner) with branching, dry-run testing and a per-run event log. |
| **The Agent** | A chat assistant that runs the account for the owner: sets up the business profile and services, searches and edits leads, sends messages and campaigns, reports on the business, manages photos and knowledge. Destructive actions need a confirmation. |
| **Proactive Agent** | Works while the owner is away and recovers revenue that would be lost: follows up quiet leads, offers a discount on a stalled quote, texts back missed WhatsApp calls, asks for reviews and wins past customers back. The owner decides, in onboarding and in Settings, what it may do and how far (off, ask first, or automatic, inside hard limits), and sees everything it did. Also emails a morning briefing and alerts the owner when a customer has waited too long. |
| **Knowledge base** | Pricing, FAQs, processes and competitor notes the AI may draw on. |
| **Photos** | A small library the Agent can attach to messages. |
| **Analytics** | Performance, outcomes (won / lost, deal value), lead scoring and AI deal insights (plan-gated). |
| **Billing** | Stripe subscriptions with an annual option. Plans have fixed monthly limits; there is no overage billing. |
| **Admin** | Maintenance mode, signup switch, user management and bans, demo and support requests. |

---

## 2. Plans

Defined once in `src/config/plans.js`; nothing else hard-codes a limit. The internal key `business` is shown to customers as **Pro**.

| | Free | Starter | Growth | Pro (`business`) |
|---|---|---|---|---|
| Price / month | $0 | $199 | $399 | $599 |
| AI lead replies / month | 10 | 75 | 400 | unlimited |
| WhatsApp messages / month | – | 50 | 500 | unlimited |
| Active workflows | 0 | 1 | 5 | unlimited |
| Branching / AI workflow steps | – | – | yes | yes |
| Google Calendar | – | – | yes | yes |
| Autonomous mode, auto follow-up | – | – | yes | yes |
| AI lead scoring | – | – | – | yes |
| AI deal insights | – | – | – | yes |
| Agent Autopilot (people / day / playbook) | – | – | 10 | 50 |
| Agent campaign size (recipients) | – | 25 | 100 | 500 |

Growth is the recommended plan (badge on the pricing cards): it holds the features owners care about most. Starter is deliberately useful but limited (the cards list what it leaves out), and Pro is a step up on volume, sales intelligence and Agent pace. `test/plans-tiers.test.js` guards this ladder, including that no plan ever drops something a cheaper plan has.

`enterprise` is a retired alias that resolves to `business`.

---

## 3. Architecture

A Node.js (Express) web service, a background worker, a Postgres database, and a static front end. No build step. The web and worker processes run the same code (`PROCESS_ROLE` picks the job) and share only the database.

```
 Browser (public/*.html, vanilla JS)          WhatsApp / Meta
        │  HTTPS                                    │  webhook
        ▼                                           ▼
 WEB   node src/server.js                  POST /api/leads/whatsapp/webhook
   ├─ auth, routes/, services/                 only records the message (unique key) and answers 200
   ├─ /healthz  /readyz  /healthz/jobs
   └─ /api/admin/ops   jobs, queue, dead messages
        │                                           │
        ▼                                           ▼
 PostgreSQL ◄───────────────────────────── inbound_events (durable queue)
        ▲
        │
 WORKER  node src/worker.js            (or the web process itself when PROCESS_ROLE=all)
   ├─ inbound queue    every 2 s       batch a customer's burst, AI, reply; retries, dead-letter, no double replies
   ├─ inbox poll       every 10 s      IMAP, per connected mailbox
   ├─ follow-ups, waits every 60 s     job queue, workflow waits, stalled-lead triggers
   ├─ proactive Agent  every 30 min    opportunity scan, briefing, owner alerts
   └─ daily backup     03:00 UTC       encrypted pg_dump, uploaded off-site (optional)
```

Every job runs under a Postgres advisory lock (`src/lib/jobs.js`) and writes a heartbeat to `job_runs`, so any number of web instances and workers can run at once and only one runs a given job. The inbound queue claims rows with `FOR UPDATE SKIP LOCKED`.

**External services:** Anthropic (the AI), Stripe (billing), Resend or SMTP (system emails), Google (sign-in, Calendar), Meta WhatsApp Cloud API, Sentry (errors, optional).

**Stack:** Node 18+ · Express · `pg` · `imapflow` + `mailparser` + `nodemailer` · `@anthropic-ai/sdk` · `stripe` · `googleapis` · `passport` · `helmet` · `express-rate-limit`.

**Design rules worth knowing**

- Prices in a reply always come from the deterministic quote engine (`services/leads/engine.js → calculateQuote`), never from model free text.
- Plan limits are enforced server-side from `src/config/plans.js`.
- Every tenant table is keyed by `user_id`, and every query is scoped to the signed-in user.
- Stored mailbox passwords are encrypted with a key derived from `JWT_SECRET`. **Do not rotate `JWT_SECRET` after launch** or every connected mailbox must be reconnected.

---

## 4. Project structure

```
humarains/
├── README.md                     this file
├── package.json
├── render.yaml                   Render blueprint (web service, background worker, env vars)
├── Dockerfile                    the worker runs from it (pg_dump and aws-cli for backups); web can too
├── docs/DISASTER_RECOVERY.md     backup, restore drill and recovery runbook
├── .env.example                  every environment variable, documented
│
├── src/
│   ├── server.js                 web entry: middleware, auth, billing, admin, route mounting
│   ├── worker.js                 worker entry: poller, inbound queue, backups (no HTTP)
│   ├── config/
│   │   └── plans.js              plan tiers, limits, feature gates
│   ├── routes/                   HTTP API
│   │   ├── leads.js              leads, settings, inbox (WhatsApp and email chats), WhatsApp, calendar, review (approvals and human review)
│   │   ├── agent.js              Agent chat, opportunities, autopilot, photos
│   │   ├── workflows.js          workflow CRUD, runs, test runs
│   │   ├── knowledge.js          knowledge base
│   │   ├── account.js            the signed-in account: profile, name, password, email change, deletion
│   │   └── demo-chat.js          website demo chat
│   ├── services/
│   │   ├── leads/
│   │   │   ├── engine.js         the AI: extraction, quote maths, replies, review check, prompt building
│   │   │   ├── ingestion.js      turns an inbound message into a stored, processed lead
│   │   │   ├── poller.js         background timers (inbox, jobs, proactive tick)
│   │   │   ├── poller-batch.js   unattended inbox processing for all users
│   │   │   └── scheduler.js      follow-up job queue
│   │   ├── workflows/engine.js   workflow state machine and step executors
│   │   ├── agent/
│   │   │   ├── tools.js          business and lead tools the Agent can call
│   │   │   ├── account-tools.js  account tools (reset, delete, password, name) with confirmations
│   │   │   ├── tasks.js          one-off campaigns and their cleanup
│   │   │   ├── proactive.js      opportunity scan, morning briefing, owner alerts
│   │   │   ├── autonomy.js       the owner's permissions: policy, limits, discount maths, activity log
│   │   │   └── autonomy-tools.js chat tools to read and change those permissions
│   │   ├── mailbox.js            customer IMAP/SMTP: credentials, test, send
│   │   ├── mailer.js             system email: password reset, briefing, alerts (Resend / SMTP)
│   │   ├── whatsapp.js           Meta Cloud API, Embedded Signup, media download, retry-safe sends
│   │   ├── whatsapp-inbound.js   resumable handler for one customer's batch (AI, photo quote, reply once)
│   │   ├── wa-state.js           targeted writes to integrations.whatsapp (health, alerts)
│   │   ├── whatsapp-maintenance.js  background sync: connection health and self-repair, delivery failures, Meta notices
│   │   ├── wa-consent.js         WhatsApp consent, opt-out and the 24-hour window (the send gate)
│   │   ├── retention.js          payment recovery, cancel flow and offer, win-back, first-week nudges
│   │   ├── retention-job.js      hourly worker job for the nudges
│   │   ├── inbound-queue.js      durable inbound queue: dedupe, batching, retries, dead-letter
│   │   ├── lead-messages.js      lead_messages table kept in step with the conversation
│   │   ├── backup-job.js         daily backup schedule
│   │   ├── google-calendar.js    Google Calendar
│   │   ├── media-library.js      photo storage, validation and the /api/media router
│   └── lib/
│       ├── jobs.js               run-once-across-processes lock, heartbeat, job status
│       ├── backup.js             pg_dump, verify, encrypt, upload, rotate
│       ├── ai-style.js           shared writing style and cleanup for AI text
│       ├── email-templates.js    black-and-white HTML emails
│       └── crypto-utils.js       password-reset token hashing
│
├── db/
│   ├── index.js                  pool, query helpers, Users / billing / admin data access
│   ├── setup.js                  creates the database from schema.sql (also a CLI)
│   └── schema.sql                the whole database in one file (single source of truth)
│
├── public/                       static front end (served as-is)
│   ├── index.html, signup.html, login.html, blog.html, privacy/terms/imprint
│   ├── dashboard.html + leads.js, agent.js, workflows.js, intelligence.js, performance.js (+ css)
│   ├── support.js + support.css     Support page (owners write to the admin, read replies)
│   ├── classic.css + ui-mode.js     Agent / Classic view slider (top right); Classic = sidebar + pages
│   ├── leads.html                older standalone dashboard, still routed
│   ├── admin.html + admin.js
│   └── assets/, fonts/, logo, background video
│
├── scripts/
│   ├── seed-admin.js             create or reset the admin account
│   ├── prune.js                  retention: delete old low-value rows
│   ├── backup.js / restore.js / verify-backup.js   backup, restore and the restore drill
│   └── check.js                  syntax-check every JS file
│
```

---

## 5. Database

PostgreSQL 14+ (tested on 16), hosted on Supabase. The whole schema is the single file `db/schema.sql`.

### Tables

| Group | Table | Purpose |
|---|---|---|
| Accounts | `users` | Account, plan, usage counters, Stripe ids, encrypted integrations (`jsonb`: email, WhatsApp, Google) |
| | `billing_history` | Invoice events from Stripe |
| | `admin_settings` | Key/value switches (maintenance mode, signups) |
| | `session` | Express sessions |
| | `security_audit_log` | Sign-in and security events |
| | `onboard_requests` | Demo bookings and support messages from the website |
| Business | `lead_business_settings` | One row per business: profile, per-service pricing (`services` jsonb), quote rules, policies, agent mode, send counters |
| | `business_knowledge` | Knowledge entries |
| | `agent_media` | Photos (bytes stored in the row, 4 MB max, 40 per account) |
| Leads | `leads` | Every enquiry and its whole conversation, quote, AI reply, review state, outcome, and the discount the Agent offered (`offer`) |
| | `email_poll_state` | IMAP cursor per mailbox |
| Automation | `workflows`, `workflow_runs`, `workflow_run_events` | Definitions, one run per lead, and the step-by-step log |
| | `lead_followup_jobs` | Durable follow-up and reminder queue |
| The Agent | `agent_tasks` | Outcome of each one-off campaign |
| | `agent_proposals` | Opportunities the Agent found |
| | `agent_prefs` | The owner's permissions policy for the Agent (`autonomy`), briefing and alert bookkeeping (the older `autopilot` list is kept in step) |
| | `agent_actions` | Everything the Agent did or held back on its own: the activity log, the queue for missed-call text-backs, and what the daily and per-customer limits and the discount budget are counted from |
| System | `schema_migrations` | Which schema version is applied (one row) |

### Conventions

- Ids are application-generated text (`varchar(64)`); timestamps are `timestamptz`; flags are `boolean`; free-form data is `jsonb`.
- Every tenant table has `user_id → users(id) ON DELETE CASCADE`, so deleting a user removes all of their data.
- Enumerations are `text` with `CHECK` constraints, which are easy to extend in `db/schema.sql`.
- `updated_at` is maintained by one trigger function on every table that has the column.
- Every foreign key has an index.

### Database setup (no migrations)

The whole database is one file, `db/schema.sql`. There are no migration files.

```bash
npm run db:setup           # create the schema if the database is empty (the server also does this on startup)
npm run db:status          # show whether the schema is applied
```

- `db/setup.js` runs `db/schema.sql` once, in **one transaction**: it fully applies or not at all. The result is recorded in a single `schema_migrations` row, so later starts skip it.
- A transaction-level advisory lock serialises deploys, so two instances starting together cannot collide. It is transaction-level, so it also works behind Supabase's transaction pooler.
- A failed setup is rolled back and logged. In production the server then **refuses to start**, so the platform keeps the previous release running.
- A database that was created by the old numbered migrations already has this exact schema; setup recognises it and records it without changing anything.
- **Changing the schema while there are no live users:** edit `db/schema.sql`, then recreate the database (drop and recreate the `public` schema, then start the app). Setup warns if `schema.sql` changed after the database was created, because existing databases are never altered automatically.
- **Once real customer data exists,** stop editing the file in place and add versioned migrations again.

### Performance

These queries are served by an index:

| Query | Index |
|---|---|
| Inbound WhatsApp message → which business owns this number | `idx_users_whatsapp_phone` (was a full scan of `users` per message) |
| Inbox poller → which businesses have a mailbox connected | `idx_users_email_polling` (was a full scan every cycle) |
| Sign-in by email, case-insensitive | `idx_users_email_lower` (unique) |
| A business's lead list, newest first | `idx_leads_user_created` (no sort step) |
| Duplicate check by email / WhatsApp message id | `idx_leads_user_email_msg`, `idx_leads_user_wa_msg` |
| Agent cleanup of temporary workflows | `idx_workflows_temporary` |
| Due follow-ups | `idx_followup_jobs_due` |

Run the app with `DATABASE_POOL_MAX` set so that *instances × pool size* stays under your database's connection limit.

### Security

- **Row-level security is on for every table.** Supabase exposes the `public` schema over its REST API; with RLS on and no matching policy, the public anon key can read nothing. Tenant tables also carry an owner policy (`user_id = current_setting('app.user_id')`). Tables with no policy (`session`, `admin_settings`, `security_audit_log`, `onboard_requests`) are closed to everyone except the server.
- The server must connect with a role that **bypasses RLS** (Supabase's default `postgres` role does). The app does not set `app.user_id`; tenant isolation in the app comes from scoping every query by `user_id`. RLS is a second wall, not the first.
- Integration secrets (mailbox passwords, tokens) are encrypted before they reach the database.

### Retention

```bash
npm run db:prune -- --dry-run   # count what would be deleted
npm run db:prune                # delete, in batches of 5,000
```

Removes audit-log rows older than 180 days, finished workflow runs and follow-up jobs older than 90 days, and finished Agent tasks and decided proposals older than 180 days. Leads, settings, billing and knowledge are never touched. Schedule it daily (a Render cron job works well).

---

## 6. Getting started

**Requirements:** Node 18+, a PostgreSQL database (a free Supabase project works), an Anthropic API key.

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, SESSION_SECRET, ANTHROPIC_API_KEY
npm run db:setup               # create the schema (the server would also do it on startup)
npm run seed:admin            # optional: create the admin account from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev                   # http://localhost:3000
```

Without `DATABASE_URL` the server starts in a limited dev mode with no persistence. Without `ANTHROPIC_API_KEY` the AI features return errors. Without Stripe keys, billing runs in demo mode.

**Scripts**

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart (nodemon) |
| `npm run db:setup` / `db:status` | Create the schema / show its status |
| `npm run db:prune` | Retention cleanup |
| `npm run seed:admin` | Create or reset the admin user |
| `npm run check` | Syntax-check every JS file |

---

## 7. Configuration

All variables are documented in `.env.example`. The ones that matter:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Supabase: transaction pooler, port 6543) |
| `JWT_SECRET` | yes | Signs sign-in tokens **and** derives the mailbox-credential encryption key. Never rotate after launch. |
| `SESSION_SECRET` | yes (prod) | Signs session cookies |
| `ANTHROPIC_API_KEY` | yes | The AI |
| `APP_URL`, `ALLOWED_ORIGIN` | yes (prod) | Public URL and CORS origin, no trailing slash |
| `ANTHROPIC_MODEL`, `AGENT_MODEL` | no | Default `claude-haiku-4-5-20251001` |
| `DATABASE_POOL_MAX` | no | Connections per instance (default 10) |
| `DATABASE_SSL` | no | `false` to disable TLS (local hosts are detected automatically) |
| `RESEND_API_KEY` + `RESEND_FROM`, or `SMTP_*` | recommended | System emails (reset, briefing, alerts) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_<PLAN>_PRICE_ID` | for billing | Subscriptions |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | for Google | Sign-in and Calendar |
| `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `WHATSAPP_VERIFY_TOKEN` | for WhatsApp | Embedded Signup and webhook |
| `INBOX_POLL_INTERVAL_MS`, `AGENT_CAMPAIGN_MAX` | no | Inbox poll interval; cap on campaign recipients |
| `PROCESS_ROLE` | no | `all` (default), `web` (HTTP only) or `worker`. See section 8. |
| `INBOUND_QUIET_MS`, `INBOUND_MAX_WAIT_MS`, `INBOUND_MAX_ATTEMPTS` | no | Inbound WhatsApp queue: batch window (6 s), longest wait (20 s), attempts before dead-letter (5) |
| `BACKUP_ENABLED`, `BACKUP_PASSPHRASE`, `BACKUP_S3_URI`, `BACKUP_S3_ENDPOINT`, `AWS_*`, `BACKUP_HOUR_UTC`, `BACKUP_KEEP` | for backups | Daily encrypted backup and its off-site copy. See `docs/DISASTER_RECOVERY.md`. |
| `HEALTH_TOKEN`, `WORKER_HEALTH_PORT` | no | Protect `/healthz/jobs`; optional health port on the worker |
| `SENTRY_DSN` | no | Error reporting |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | for seeding | Used by `npm run seed:admin` |

---

## 8. Deploying

**Render (default).** `render.yaml` defines two services from one repository: `humarains` (web: build `npm install --omit=dev`, start `node src/server.js`, health check `/api/system/status`) and `humarains-worker` (a Docker worker running `node src/worker.js`). Both auto-deploy on push. Fill in the variables marked `sync: false` on **both** services. **`JWT_SECRET` must be identical on both** (it also decrypts stored mailbox passwords), so copy the web value to the worker rather than generating a new one.

Rolling it out safely: deploy with `PROCESS_ROLE=all` on the web service (the default in `render.yaml`). The web service and the worker both do background work, which is safe because every job is locked. Once the worker's logs show `database ready; starting background work`, set `PROCESS_ROLE=web` on the web service so it only serves HTTP.

Monitoring: point an uptime monitor at `https://<your-domain>/healthz/jobs`. It returns 503 when a background job has stopped or the inbound queue is stuck, which is what you want to hear about first. `/readyz` checks the database; `/api/admin/ops` (admin login) lists every job's last run, the queue depth and dead messages, and `POST /api/admin/ops/inbound/:id/retry` puts a dead message back in the queue. Set `SENTRY_DSN` and failed jobs and dead messages are reported there too.

**Docker (optional).** `docker build -t humarains . && docker run -p 3000:3000 --env-file .env humarains`. Same startup behaviour. Run the worker from the same image with `docker run --env-file .env humarains node src/worker.js`.

### Launch checklist

- Set the required variables above; keep `JWT_SECRET` stable from day one.
- Run `npm run check`.
- Test end to end with a fresh account: sign up, set up the profile with the Agent, connect email, receive a test lead, approve a reply, delete a lead, reset the profile.
- Test Stripe in live mode with a real card, and confirm plan limits (messages, automations) behave as advertised.
- Turn on error alerts (Sentry) and database backups; schedule `npm run db:prune`.
- Publish the privacy policy, terms and a support email (`hello@humarains.com` appears in fallback messages).
- Wrap any remaining AI writers (lead replies, follow-ups, scoring) with `withStyle()` and `cleanAiText()` from `src/lib/ai-style.js`.
- If you run more than one server instance, read [Known limitations](#12-known-limitations-and-next-steps) first.

---

## 9. Feature reference

### Quotes and pricing

Each service in `lead_business_settings.services` carries its own pricing; there are no business-wide rates. Fields: category, description, pricing type (`fixed`, `from`, `hourly`, `per_unit`, `site_visit`), base and top price, minimum charge, per-unit price and label, duration, deposit %, call-out fee (optionally waived when the job is booked), travel fee and its rule, emergency and priority surcharges (flat), after-hours / weekend / holiday surcharges (percent or flat), materials mode (included / at cost / cost plus markup / customer supplies), tax mode (none / added / included) with rate and name, add-ons, inclusions, exclusions, details to collect before quoting, and warranty.

`calculateQuote` turns the matched service into line items and a total. Emergency, after-hours, priority, call-out and added tax are priced automatically. Travel, materials, add-ons and weekend / holiday surcharges are passed to the AI as rules, because they need facts (distance, date, customer choices) the calculator does not have. Old business-wide values are folded into services automatically the first time settings load.

Quote style (`range`, `firm` or `site_visit`) and the estimate range are set in Business Settings → Quote Rules.

### New-user onboarding

Every new account (email sign-up or Google) is stamped with `integrations.onboarding.required` by `lib/onboarding.js`. Until the account has connected **email or WhatsApp**, the dashboard (`leads.js` init) redirects it to `/onboarding.html`; connecting either channel releases it for good. Accounts created before this shipped carry no stamp and are never gated.

The wizard (`public/onboarding.html`, `.css`, `.js`) has three steps: **1. Connect** (required: pick Email or WhatsApp), **2. Your business** (name, what it does, owner, phone; the time zone is detected), **3. Try it** (a practice enquiry through the real reply engine, then on to the dashboard, where the Agent's interview collects services and prices). It reopens on the first unfinished step, so refreshing or returning later never loses progress.

- **Email** uses provider presets (`public/email-providers.js`: Gmail, Outlook, Yahoo, iCloud, Other). The address picks the provider, the servers fill in, spaces in a pasted app password are removed, and the existing `POST /api/leads/email-settings` verifies IMAP and SMTP before anything is saved.
- **WhatsApp** reuses Meta Embedded Signup (`/api/leads/whatsapp/embedded-signup`). It stays plan-gated: on Free the tile is disabled ("Starter plan and above"), so Free accounts connect email. It is hidden entirely if the admin switches WhatsApp off.
- `GET /api/users/setup-status` now also returns `onboarding_required` and the saved business `profile` (used to prefill and resume).

### Photo quotes

When a customer sends photos on WhatsApp and asks for a price, the AI estimates the job from them using the owner's services and quote rules. Set in Business Settings → Photo Quotes (`photoQuoteEnabled`, `photoQuoteMaxValue`, `photoQuoteUnclear`, `photoQuoteGuidance`, `photoQuoteDisclaimer`).

Flow, in `server.js` (webhook) and `services/leads/engine.js`:

1. `parseWebhookPayload` accepts `image` messages. Everything one person sends within about 6 seconds (photos and texts, up to 20 seconds in total) is merged and answered once. Message ids already seen are ignored.
2. `downloadMedia` fetches each photo from Meta (max 4 photos, 4 MB each, jpeg / png / webp / gif).
3. `assessCustomerPhotos` sends the photos to the model with the service list and the owner's guidance. It returns what the job is, the likely service, an estimated quantity, complications and a confidence. It never prices anything.
4. `photoAnalysisNote` writes that into the customer's message as a `[Photo analysis ...]` note. The normal intake, `calculateQuote` and reply writer then price it exactly like a written description.
5. `photoQuoteGuard` applies the owner's settings: above `photoQuoteMaxValue` (the top of the range) the AI gives no price and offers a site visit; with `photoQuoteUnclear = review`, low-confidence photos go to Human Review, otherwise the AI asks for better photos or details.

Not covered yet: photos attached to emails (the inbox reader only downloads text parts), voice notes, and keeping the customer's photos for the owner to view (they are analysed, then discarded). The batching buffer is in memory, so it is per web instance.

### Workflows

A workflow is a trigger plus a small JSON tree of steps, not a generic graph:

```
steps: [ Step, Step, ... ]
Step:  { id, type, config, branches?: [{ id, label, steps: [Step, ...] }, ...] }
```

- **Triggers:** `new_lead`, `lead_replied`, `status_changed`, `stalled` (quiet for N hours), `manual`.
- **Steps the builder offers:** `send_message` (AI-written or your own text, **email only**), `wait`, `wait_for_reply` (forks into *Replied* / *No reply*), `notify_owner` (email the owner), `update_status` (mark a lead hot, quoted, booked, won or lost), `add_tag`, `book_appointment` (Google Calendar), and two ready-made checks built on `condition` (*urgent job*, *job was won*). `ai_extract`, `ai_decision`, `remove_tag`, `webhook` and `schedule_reminder` still run in older workflows but cannot be added to new ones.
- **No automation ever messages anyone on WhatsApp.** Workflows, campaigns, the Agent's proposals and scheduled follow-ups are email only; WhatsApp conversations are answered by the AI inside WhatsApp's 24-hour reply window and are never followed up or enrolled in a campaign.
- Branches are terminal: after a fork, only the chosen branch's own `steps` continue.
- A run's position is a flat cursor path (`[stepIndex, branchIndex, stepIndex, …]`) saved on `workflow_runs`, so waits, reply timeouts and restarts resume from a saved coordinate. Paused runs are resumed by the background poller.
- Every step writes a row to `workflow_run_events`. **Test Run** dry-runs against a real lead with nothing sent. Starter automations: Chase quotes that go quiet, Alert me to urgent jobs, Thank customers and ask for a review, Win back cold leads.
- Plan limits: active workflows per plan; branching and AI steps need Growth or above.

### The Agent and the proactive Agent

The chat Agent (`routes/agent.js`, tools in `services/agent/`) acts when the owner types. `services/agent/proactive.js` works while they are away.

- **Scan:** about every 6 hours per business, four playbooks: `quote_followup`, `go_cold`, `review_request`, `winback`. Each finding becomes an *opportunity* (`agent_proposals`) with a drafted message, a count and an estimated value.
- **Approval:** one click on the home screen, or by chat (`list_opportunities`, `approve_opportunity`). Approval runs the normal campaign path, so consent mode, plan quotas and do-not-contact all still apply.
- **Autopilot** (Growth and above, autonomous mode): chosen playbooks send on their own, at most 10 people per day each on Growth and 50 on Pro (`autopilotDailyCap`).
- **Morning briefing:** one email per local day (08:00 to 19:00 in the business's timezone), only when there is news.
- **Owner alerts:** when a customer's last message has gone unanswered for 2 hours or more (up to 3 days), the owner gets a short email classified by what they must do: approve a drafted reply, take over a handed-over conversation, or answer a message nothing has answered. At most one per 4 hours and two per local day, only 07:00 to 21:00, never twice for the same set of customers (enforced atomically in one SQL statement). Switch off with the Agent tool `set_owner_alerts`.
- **Learning:** a playbook dismissed 3 times with no approvals in 60 days stops being proposed; one approved twice with no dismissals is offered for Autopilot.
- **Proof:** "recovered revenue" counts jobs marked won *after* an approved or auto-sent follow-up included that lead (30-day window). It shows timing, not cause, and is worded that way.
- **Safety:** the scanner never sends directly; leads are not re-proposed for 14 days; drafts never reuse lead text; approvals are claimed atomically so a double click cannot double-send.

### Agent permissions: acting on its own, inside limits the owner sets

The owner decides what the Agent may do without asking. It is one policy (`agent_prefs.autonomy`, shape and rules in `services/agent/autonomy.js`), set in **onboarding step 3**, in **Settings > Agent permissions**, or by telling the Agent in chat. All three go through the same validation, so they cannot disagree. Until an account saves a policy it behaves as before (every playbook asks; the playbooks on Autopilot run by themselves).

| Action | What it does | Modes |
| --- | --- | --- |
| `reengage` | Emails quotes and enquiries that went quiet (playbooks `quote_followup`, `go_cold`) after the owner's number of days | off, ask, auto |
| `discount` | Emails a limited-time discount on a stalled quote (playbook `discount_offer`) | off, ask, auto |
| `missed_call` | Texts back a customer whose WhatsApp call nobody answered, in the owner's own words | off, auto |
| `review`, `winback` | The existing review-request and win-back playbooks | off, ask, auto |

`off` never proposes it, `ask` prepares it and waits for the owner's approval, `auto` does it. Around the modes sit limits the Agent cannot cross: messages per day, contacts per customer in 30 days, quiet hours in the business's own time zone (default 20:00 to 08:00), and for discounts the percentage, the smallest quote, how long the offer stays open and a monthly budget. A pause switch stops everything on its own at once. Plan clamps are applied when it runs, not when it is saved: `auto` needs the Growth plan (below it the Agent asks), and `missed_call` needs WhatsApp on the plan.

How it hangs together:

- **One engine.** `scanUser()` in `proactive.js` reads the policy for each playbook. Automatic runs call `executeProposal()` for only the customers `autonomy.admitLeads()` allows (quiet hours, daily limit, per-customer limit, plus the plan's Autopilot cap). Owner approvals are not held to quiet hours or the daily limit: the owner decided.
- **Discounts are arithmetic, not AI.** `computeOffer()` takes the owner's percentage, holds it under the AI-wide ceiling in Quote Rules when one is set, and never goes below the service's minimum charge. The offer is stored on the lead (`leads.offer`), the email's `{{discountPercent}}`, `{{discountedTotal}}` and `{{discountExpiry}}` are filled from it (a draft that does not use the merge field is thrown away), and `processReply()` tells the AI exactly what was offered, so in conversation it honours that offer and nothing larger. A customer is offered a discount once. The monthly budget is a hard stop for automatic sends.
- **Missed calls** (`services/whatsapp-calls.js`). Meta's `calls` webhook (a `terminate` event, direction `USER_INITIATED`, with no `start_time` or with status `FAILED`) is parsed by `parseMissedCalls()`. The webhook (call events are only trusted when Meta's `X-Hub-Signature-256` checks out against `META_APP_SECRET`) only queues a row in `agent_actions` (the call id is the dedupe key, so a repeated webhook queues one text) and records the call as the customer contacting the business (`wa-consent.recordCall`: it opens the 24-hour window but never lifts an opt-out). The worker job `missed_calls` (every 30 s) sends what is due through `sendGuarded`, after the owner's delay. The text is the owner's wording with a few merge fields (`{{customerName}}`, `{{businessName}}`, `{{ownerName}}`, `{{bookingUrl}}`, `{{opensWhen}}`), with a separate wording for when the business is closed; the AI does not write it. It is skipped, with the reason logged, when the owner switched the action off or paused the Agent after it was queued, the customer opted out or is marked do-not-contact, a team member already has the conversation, the customer wrote after calling, the WhatsApp quota is used up, or WhatsApp withheld the number. A send that may have been delivered is never retried. The caller gets (or is attached to) a WhatsApp lead tagged `missed-call`, so their reply continues the same thread and the AI takes over.
- **Activity.** Every automatic action writes `agent_actions` rows (sent, queued, held back with the reason, failed). The Settings page lists them, a queued text can be stopped, the morning briefing says what the Agent did overnight, and "recovered revenue" counts jobs won after anything the Agent sent.
- **API:** `GET/PUT /api/autonomy`, `POST /api/autonomy/pause` and `/resume`, `GET /api/autonomy/activity`, `POST /api/autonomy/activity/:id/cancel`, `GET/POST /api/autonomy/whatsapp-calling`. **Chat tools** (`autonomy-tools.js`): `get_autonomy_settings`, `update_autonomy_settings`, `get_agent_activity`. **UI:** one component, `public/autonomy-ui.js` (+ `autonomy.css`), mounted in Settings (`#auMount` in `dashboard.html` and `leads.html`) and in the onboarding step (`#auOnboard`).

**Emails to the owner** (`src/lib/email-templates.js`): password reset, the morning briefing, and the "customers are waiting" alert. They are plain black and white, table-based HTML that renders in every mail client, with a mobile layout.

---

## 10. WhatsApp setup

Customers connect with one click ("Connect with WhatsApp"), which runs Meta's Embedded Signup in a popup. On your side, once:

1. **Add Facebook Login for Business** to your Meta app (developers.facebook.com → your app → Add Product), and make sure **WhatsApp** is also a product.
2. **Create an Embedded Signup configuration:** Facebook Login for Business → Configurations → Create. Asset type *WhatsApp Business Account*; permissions `whatsapp_business_management` and `whatsapp_business_messaging`. Copy the Configuration ID → `META_CONFIG_ID`. (The WhatsApp → Embedded Signup Builder offers the same.)
3. **Allowed domains:** under Facebook Login for Business → Settings, add your HTTPS domain to *Allowed Domains for the JavaScript SDK* and *Valid OAuth Redirect URIs*. Meta will not load its SDK on plain `http://localhost`; use a tunnel such as ngrok for local testing.
4. **Webhook:** App Dashboard → WhatsApp → Configuration. Callback URL `https://<your-domain>/api/leads/whatsapp/webhook`; verify token = your `WHATSAPP_VERIFY_TOKEN`; subscribe to the **messages** field, and to the **calls** field if you offer missed-call text-back. This is per app, not per customer; Humarains subscribes each customer's WhatsApp Business Account to your app during signup.
5. **Testers:** while the app is in Development mode, only app admins, developers and testers can complete signup. Add yourself under App Roles. You can test fully with Meta's sandbox account (WhatsApp → Quickstart → Testing Integrations).
6. **Credentials:** App Dashboard → Settings → Basic: App ID → `META_APP_ID`; App Secret → `META_APP_SECRET` (server side only).
7. **Go live:** switch the app to Live and submit `whatsapp_business_management` and `whatsapp_business_messaging` for App Review with Advanced Access. Until then you can onboard at most 10 new businesses per rolling 7 days; after Business Verification, App Review and Access Verification the cap rises to 200 per week.

Inbound messages: the webhook (`server.js`) only inserts each message into `inbound_events` (the unique `channel:phone_number_id:message_id` key makes a repeated webhook a no-op) and answers 200, or 500 if it could not store it so Meta retries. The worker waits for the customer's burst to settle, then `services/whatsapp-inbound.js` handles it in resumable steps (AI, save lead, send, bookkeeping, automations), saving progress after each. A failed batch retries with backoff (30 s, 2 min, 8 min, 30 min, 2 h) and is then marked dead; a crash mid-batch resumes where it stopped. Sending is at most once: if a send may have been delivered (timeout, 5xx) or was interrupted, the lead goes to Human Review instead of risking a second message to the customer.

How it works in code: `GET /api/leads/whatsapp/embedded-signup/config` gives the front end the app and config ids (no secrets); `POST /api/leads/whatsapp/embedded-signup` receives `{code, phoneNumberId, wabaId}` from the popup, then the server exchanges the code for a token, registers the number, subscribes the app to the account, and saves the result. The Content-Security-Policy in `src/server.js` allows the Facebook SDK and popup.

**Humarains only replies on WhatsApp.** (A text-back to a missed call is a reply too: the customer's call is them getting in touch, see Agent permissions above.) WhatsApp allows a business to send free-form messages for 24 hours after a customer's last message, and anything else must be an approved Meta message template. Humarains does not use message templates at all: it never starts a conversation, never sends marketing or broadcast messages, and never creates anything on the owner's WhatsApp Business Account. Follow-ups (Day 1 / 3 / 7), workflow steps and campaigns always run later than 24 hours after the customer's last message, so they are email only: a WhatsApp conversation gets no scheduled follow-ups, is left out of campaigns and proposals, and the manual Follow-up button is hidden for it. Replies to a customer who just wrote are sent by the inbound worker.

`services/whatsapp-maintenance.js` (worker job `whatsapp_sync`, every 5 minutes) keeps each connection healthy: it checks the number with Meta every few hours, registers it / re-subscribes the app when Meta reports it inactive, and stores the result in `integrations.whatsapp.health` (shown on the Pipeline WhatsApp card). Delivery receipts on the webhook feed it too: an expired token or missing payment method becomes a visible alert, a customer who cannot be reached on WhatsApp is flagged for human review, and Meta's violation / restriction / quality notices become an alert pointing the owner to Account Quality in Meta Business Suite. Quick-reply button taps on messages sent before templates were removed are still handled like any other customer message.

### Churn reduction (`services/retention.js`, `services/retention-job.js`)

Four small, automatic things, :

- **Payment recovery.** `invoice.payment_failed` (and `customer.subscription.updated` with `past_due`) sets `integrations.billing.status = 'past_due'`, sends one clear email at most every 2 days, and shows a banner in the dashboard with an "Update payment method" button that opens the Stripe card-update screen directly. The email link `dashboard.html?billing=fix` does the same. Access is never cut while Stripe retries; the plan only changes when Stripe finally cancels. `invoice.paid` clears the banner. In Stripe, enable the `invoice.paid` (or `invoice.payment_succeeded`) webhook event and turn on Smart Retries and the card account updater.
- **Cancel flow.** "Cancel subscription" now asks the main reason first (stored in `integrations.billing.cancelIntents`). For "too expensive" it offers a one-time discount (`RETENTION_OFFER_PERCENT`, default 20% for 2 months, once per account, never stacked on an existing discount; 0 disables it). Other reasons get a short helpful message. It then opens Stripe's own cancel screen (falling back to the portal home if the portal is not configured for cancellation flows).
- **Win-back.** When a subscription ends, one email says their leads and settings are kept, with a restart link. Stripe's cancellation reason and comment are stored on `integrations.billing`.
- **First-week activation.** An hourly worker job (`retention`) finds paying customers who, after 2 days and again after 6, have not connected an inbox or WhatsApp, finished the business profile, or seen the AI handle a lead, and emails exactly what is missing. Maximum two reminders, never to customers who finished setup.

**No secrets in the browser.** User data sent to the dashboard (`sanitizeUser` in `server.js`) passes through `lib/redact.js`, which drops every token, password, API key and credential field at any depth (WhatsApp access tokens, mailbox passwords, OAuth tokens). The page never reads them; the server always uses the stored copies. `test/redact.test.js` guards it.

### Keeping the WhatsApp number from being suspended (`services/wa-consent.js`)

Rules come from the WhatsApp Business Messaging Policy (whatsappbusiness.com/policy): contact only people who opted in, honor opt-outs, reply freely only within 24 hours of the person's last message, and keep a clear path to a human when using automation. Every WhatsApp message to a customer passes one gate (`sendGuarded`), used by the follow-up scheduler, workflow steps, Agent campaigns, and the owner's Send / Approve / Follow-up-now buttons. The only exception is the AI's direct reply to a message that just arrived.

- **Consent = the person messaged or called the business on WhatsApp first.** Recorded in `whatsapp_contacts` when the inbound message is processed, or when a call is missed (`recordCall`, which never lifts an opt-out). A phone number from a web form or an email is never messaged on WhatsApp (those leads are followed up by email when they gave one). There is deliberately no backfill.
- **The real 24-hour window** is measured from that WhatsApp message, not from an email timestamp. Outside it nothing is sent on WhatsApp (blocked reason `window_closed`); callers use email when the customer gave an address, otherwise they skip.
- **Opt-out.** STOP, "no thanks", "not right now" and similar block every further message and cancel pending follow-ups until the person writes again. An opt-out is never worked around by email.
- **Meta notices and health.** A quality drop, violation, restriction or ban shows an alert on the dashboard. A restricted or flagged number is never auto re-registered, the Re-register button refuses on it, and re-registering is limited to once a day automatically and once an hour by hand.
- **Late messages.** A follow-up more than 12 hours late is skipped, and an inbound message that arrives after its 24-hour window (the number was down) is kept and flagged for the owner, not answered.
- **Test button.** Works only after the owner has messaged the connected number from their own phone (so it is a reply inside the window).
- **Human escalation.** The AI hands a conversation to a person (Human Review) when it cannot or should not answer. Make sure your WhatsApp Business profile lists a phone, email or website so customers can always reach someone.


### Front-end design system

One typeface, one palette, one set of rules, so no page looks like it came from a different product.

- **Type:** Hanken Grotesk (variable weight), self-hosted in `public/fonts/` and loaded from `fonts/fonts.css` on every page. There are no requests to Google Fonts, and the CSP no longer allows them. A Latin and Latin-extended subset plus italic is included; the licence is `public/fonts/OFL-HankenGrotesk.txt`.
- **Colour:** ink `#0B252A` and white, with a cool off-white canvas `#F4F6F6`. One accent, teal `#12889A` (from the logo), used for focus rings and selection. Green appears only for "booked" or "included", red only for errors and blocked states.
- **Shape:** 10px radius for controls, 14 to 20px for cards. Structure comes from 1px hairline borders; floating shadows are reserved for the one hero element. Fields and secondary buttons always have a visible border.
- **Where it lives:** the landing page (`index.html`) and the auth pages (`login.html`, `signup.html` via `auth.css`) are self-contained. The app is `leads.css`, then `premium.css`, then `polish.css`, which loads last and holds the shared tokens (`--pm-accent`, `--pm-r-card`, `--pm-r-field`, `--pm-hair`, `--pm-ring`). Change a token there rather than adding another override.
- **Agent / Classic view:** a slider in the top right of the dashboard switches between the chat-first Agent view and a traditional layout (labelled sidebar, one page at a time). Both views share the same pages and data. The choice is stored per browser in `localStorage` (`hm_ui_mode`). `ui-mode.js` runs the switch; `classic.css` (loaded last) lays out Classic view under `body.classic-ui`; `agent.js` exposes `window.__agentUIHooks` so the two cooperate. In Classic view the Agent's settings (mode, instructions, reply length) sit under Configuration > Agent settings.
- **No bold in customer text:** everything the AI writes to a lead (email and WhatsApp replies, follow-ups, workflow messages) is told never to use bold or any emphasis, and `cleanCustomerText` in `src/lib/ai-style.js` strips `**bold**`, `__bold__`, `*italic*`, `_italic_`, bold tags and markdown headings from whatever comes back, so a slip never reaches the customer.
- **Time zone and opening hours:** Settings > Time zone, hours & scheduling. The owner picks their time zone from the full list (their device's zone is suggested; new accounts start on a UTC placeholder and are marked unconfirmed until they save one) and sets opening hours for each day, with closed days and different hours per day. Stored as `businessHours` (one entry per weekday) plus `timezoneConfirmed` in the settings JSON, so no migration; the old `businessDays` / `businessHoursStart` / `businessHoursEnd` fields are kept in step, and older accounts are read from them automatically. `src/lib/business-hours.js` holds the rules (validation, "Mon-Fri 09:00-17:00" summary, open/closed right now in the business's own zone, daylight saving safe). The AI sees the weekly hours in the business context and, on each reply, whether the business is open right now. The Agent asks for the time zone while the profile is incomplete and can set per-day hours (`openingHours`).
- **Human handover:** Settings > Human handover. When a conversation reaches a closing stage the owner chose (a quote sent, "they want to book", "they said yes"; default: the last two), the AI stops selling and hands it to the right person on the team, for email and WhatsApp alike. `processReply()` in `src/services/leads/engine.js` decides (after the Human Review checks, which come first): it picks the person by the job (`pickContact` in `src/services/handover.js`: the lead's service and the customer's words against each person's job list, then the person marked "everything else", then the owner), writes a reply that tells the customer who will be in touch (first name only, no contact details, no promised time) and sets `leads.handover = {status:'pending'}` (`db/schema.sql`). The poller and the WhatsApp worker then call `dispatchPending()`, which claims the handover atomically (pending to active, so a retried batch never tells the person twice), emails the person the customer's phone and email, the quote, the reason and the latest messages (the owner is copied unless they turn that off), cancels follow-ups and tags the lead `handed-over`. If the email cannot be sent, the lead goes to Human Review with the customer's number. From then on the AI writes nothing on that thread; each new customer message is forwarded to the person (`forwardCustomerMessage`). The owner can give the conversation back (`POST /api/leads/:id/handover/resume`, after which the AI will not hand that lead over again) or hand a lead over by hand at any stage (`POST /api/leads/:id/handover`). The team and the switch live in the business settings (`/api/leads/handover`). The Settings section is plain HTML in `public/dashboard.html` and `public/leads.html` (`#handoverSection`), wired up by `public/handover-ui.js`. The Agent can do the same from chat through `src/services/agent/handover-tools.js` (`get_handover_settings`, `update_handover_settings`, `add_handover_person`, `remove_handover_person`, `handover_lead`, `resume_lead_ai`), which use the same validation as the Settings page. A lead that closes with a handover stays open so the customer's next message reaches the same thread.
- **Prompt caching:** `src/lib/ai-cache.js`. The owner's business context (profile, settings, pricing rules, knowledge) is sent as a cacheable system block on the human-review check, the knowledge check, the reply and the follow-up, and the Agent's tool list and long system prompt are cached too, so repeated input is billed at a tenth of the normal price. Blocks shorter than the model's minimum (4,096 tokens on Haiku 4.5) are sent as usual, at no extra cost. Set `AI_USAGE_LOG=1` to log `cache_write` and `cache_read` tokens per call and see the real hit rate.
- **Support:** Configuration > Support (and the Support item in the account menu) lets an owner message the admin. Conversations live in `support_tickets` / `support_messages` (`db/schema.sql`) and are served by `src/routes/support.js`: `/api/support` for owners, `/api/admin/support` for the admin panel's Support tab, where you reply, change status (open, answered, resolved) and keep a private note. Replies appear on the owner's Support page and are emailed to them; if `ADMIN_EMAIL` is set you are emailed when an owner writes. This is separate from the public website widget, whose messages stay under Requests.
- **Landing page:** hero with a worked example conversation, a numbered how-it-works sequence, the three plans, a FAQ, and a closing call to action. It shows no customer logos, quotes or statistics because there are none yet; add them only when they are real.

---

## 11. Testing

This release ships without an automated test suite. Run `npm run check` (syntax check of every file) and test end to end with a fresh account before going live.

---

## 12. Known limitations and next steps

Ordered by how soon they matter when growing from a few hundred customers to tens of thousands.

**Before running more than one web instance**

- **Background jobs and the inbound queue are safe across instances.** Each job takes a database lock and the queue uses `SKIP LOCKED`. The lock is held in a transaction while a job runs, so do not set a database-wide `idle_in_transaction_session_timeout` shorter than a few minutes.
- **No uniqueness on email message ids yet.** Duplicate protection for the inbox is a check in code. WhatsApp is covered by the queue's unique key. Add unique indexes on `(user_id, email_message_id)` after cleaning any existing duplicates.
- **Agent delete / reset confirmations are held in memory.** With several instances a confirmation can land on a different instance. Move them to the database. The OAuth bridge tokens in `server.js` have the same limit.
- **Email photos are not read** (WhatsApp photos are), and the inbox reader still downloads only text parts.
- **The WhatsApp webhook does not verify Meta's `X-Hub-Signature-256` header for messages.** Anyone who knows the URL can post a fake message into the queue. Verify it with `META_APP_SECRET` against the raw request body (the body is already kept as `req.rawBody` and `verifyWebhookSignature()` exists; missed-call events already require it, and are ignored when `META_APP_SECRET` is not set).
- **Missed-call text-back depends on Meta's Calling API.** Calling must be switched on for the number (Settings > Agent permissions has a button; it adds a call button to the customer's chat) and the app must be subscribed to the `calls` webhook field. Humarains does not answer calls, so a customer who rings sees "Not answered" and then the text. Whether a call opens the 24-hour window is documented by WhatsApp providers rather than on Meta's own calling pages: if Meta refuses the text, it is logged as held back and not retried. Callers who use a WhatsApp username have no phone number to text.

**Database**

- **Conversations are stored twice.** `lead_messages` (one row per message) is written alongside `leads.conversation_history` (jsonb), which the AI and every screen still read. The next step is to read from `lead_messages`, then drop the jsonb copy so long threads stop making the `leads` row large and hot. This was the biggest structural change still worth making.
- **Photos are stored in the database** (`agent_media.data`). Move them to object storage (Supabase Storage or S3) and keep only the URL.
- **`lead_business_settings.extra_fields`** is a jsonb blob holding profile, quote rules and policies. Fine for now; promote fields to columns if you need to query across businesses.
- **Growing tables:** `leads`, `workflow_run_events`, `security_audit_log` and `lead_followup_jobs` grow without bound. `db:prune` bounds the last three; when `leads` passes tens of millions of rows, partition it by `user_id` hash or by month.
- **Naming debt, kept to avoid risky renames:** `users.analyses_used` / `analyses_limit` are leftover counters from the removed outbound-email (Pipeline) feature and are unused; the `/api/pipeline/email-settings` routes are only the IMAP/SMTP account connection; plan key `business` is shown as "Pro". Rename in a dedicated migration when convenient.

**Code**

- `src/routes/leads.js` is about 2,800 lines and also hosts data helpers (`getSettings`, `storeLead`, `rowToLead`) that services import, which forces lazy `require()` calls to avoid circular imports. Extract those into `src/services/leads/store.js`.
- `src/server.js` is large (auth, billing, admin and user routes inline). Split into `routes/auth.js`, `routes/billing.js`, `routes/admin.js`.
- `public/leads.html` is an older standalone dashboard that overlaps `dashboard.html`; retire it once nothing links to it.
- No CI is configured. Run `npm run check` on every push.

**Product (the levers for revenue per customer)**

- Revenue attribution from the systems where jobs close (Jobber, Housecall Pro, ServiceTitan, QuickBooks).
- Phone intake: missed-call text-back and lead ingestion from Angi, Thumbtack and Google Business messages.
- Multi-location and agency accounts (removed earlier for scope; revisit at scale).
- Compliance for SMS (10DLC / TCPA), GDPR/CCPA deletion, and SOC 2 for larger customers.

---

## Appendix: where things moved

The project was reorganised from a flat root into `src/`, `db/` and `scripts/`.

| Old | New |
|---|---|
| `server.js` | `src/server.js` |
| `db.js`, `supabase/schema.sql`, `supabase/drop-*.sql` | `db/index.js`, `db/setup.js`, `db/schema.sql` |
| `plans.js` | `src/config/plans.js` |
| `*-routes.js` | `src/routes/{leads,agent,workflows,knowledge,account}.js`, `demo-chat-routes.js` → `demo-chat.js` |
| `leads-engine.js`, `leads-ingestion.js`, `leads-poller.js`, `leads-routes-poller.js`, `leads-scheduler.js` | `src/services/leads/{engine,ingestion,poller,poller-batch,scheduler}.js` |
| `workflow-engine.js` | `src/services/workflows/engine.js` |
| `agent-{tools,account-tools,tasks,proactive}.js` | `src/services/agent/{tools,account-tools,tasks,proactive}.js` |
| `pipeline-email.js` | `src/services/mailbox.js` |
| `mailer.js`, `whatsapp.js`, `google-calendar.js`, `media-library.js` | `src/services/` |
| `ai-style.js`, `email-templates.js`, `crypto-utils.js` | `src/lib/` |
| `AGENT_PROACTIVE.md`, `WORKFLOWS_README.md`, `EMBEDDED_SIGNUP_SETUP.md`, `LAUNCH_CHECKLIST.md` | merged into this file |
| `public/dashboard.css`, `public/blog-articles.html`, `public/Employee_Vid.mp4`, `public/ai-employee.png` | removed (referenced nowhere) |


- **Settings page layout:** `public/settings.css` (scoped to `#view-settings`, loaded after `premium.css`) sets the spacing, card padding, field grid and the services and handover sub-cards. `public/settings-nav.js` builds the "On this page" index from every settings card that has a `data-nav` attribute; add `data-nav="Name"` to a new settings section to list it.

- **Dashboard look:** `public/refine.css` is the last stylesheet on `dashboard.html`. It sets one system for the whole app (16px card radius, 10px controls, 8px spacing grid, one type scale, one shadow) and overrides the older layers in `leads.css`, `premium.css` and `classic.css`. To change the look of cards, tables, buttons or the sidebar, edit it there first.

- **Rescheduling:** a booked job can be moved from the lead's Calendar Event card (Reschedule button) or by asking the Agent (`reschedule_booking`). Both call `src/services/reschedule.js`, which moves the same Google Calendar event (`rescheduleCalendarEvent` in `src/services/google-calendar.js`), checks the new slot (not in the past, within two years, keeps the booking length), and has Google email the customer the new time when they were invited. API: `GET /api/leads/:id/appointment` and `POST /api/leads/:id/reschedule`. The pop-up is styled in `public/reschedule.css`.
