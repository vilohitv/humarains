-- ==================================================================================
-- Humarains — database schema (single source of truth)
--
-- This one file creates the whole database. There are no migrations.
--   • Applied automatically on startup (db/setup.js), once, inside a single
--     transaction: it fully applies or not at all.
--   • Manual:  npm run db:setup      (status: npm run db:status)
--   • Safe to re-run: setup skips this file once the schema is recorded.
--
-- While the product has no live users, change the schema by EDITING THIS FILE
-- and recreating the database (drop and recreate the Supabase/Postgres schema,
-- then start the app). Once real customer data exists, add versioned
-- migrations again instead of editing this file.
--
-- Conventions: ids are text, timestamps are timestamptz, enumerations are text
-- with CHECK constraints, every table has row-level security enabled (the app
-- connects as the table owner, which bypasses it; the policies protect against
-- direct access through Supabase's public API).
-- ==================================================================================

SET check_function_bodies = false;


-- ============================================================================
-- Functions
-- ============================================================================

-- update_updated_at_column()
CREATE FUNCTION update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- ============================================================================
-- Tables
-- ============================================================================

-- admin_settings
CREATE TABLE admin_settings (
    key character varying(100) NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- agent_actions
CREATE TABLE agent_actions (
    id bigint NOT NULL,
    user_id character varying(64) NOT NULL,
    lead_id character varying(64),
    kind text NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    reason text,
    dedupe_key text,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone,
    CONSTRAINT agent_actions_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'whatsapp'::text]))),
    CONSTRAINT agent_actions_kind_check CHECK ((kind = ANY (ARRAY['reengage'::text, 'discount'::text, 'missed_call'::text, 'review'::text, 'winback'::text]))),
    CONSTRAINT agent_actions_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'skipped'::text, 'failed'::text, 'cancelled'::text])))
);

-- agent_media
CREATE TABLE agent_media (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    file_name text NOT NULL,
    mime text NOT NULL,
    size_bytes integer NOT NULL,
    caption text,
    tags text,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- agent_prefs
CREATE TABLE agent_prefs (
    user_id character varying(64) NOT NULL,
    autopilot jsonb DEFAULT '[]'::jsonb NOT NULL,
    daily_briefing boolean DEFAULT true NOT NULL,
    review_url text,
    last_scan_at timestamp with time zone,
    last_brief_date text,
    alerts_enabled boolean DEFAULT true NOT NULL,
    last_alert_at timestamp with time zone,
    last_alert_sig text,
    alert_day text,
    alerts_today integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    autonomy jsonb
);

-- agent_proposals
CREATE TABLE agent_proposals (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    rationale text,
    lead_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    sample_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    est_value numeric(14,2) DEFAULT 0 NOT NULL,
    draft text,
    drafted_by text DEFAULT 'template'::text NOT NULL,
    edited boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT agent_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'auto_sent'::text, 'dismissed'::text, 'expired'::text])))
);

-- agent_tasks
CREATE TABLE agent_tasks (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    workflow_id character varying(64),
    kind text DEFAULT 'campaign'::text NOT NULL,
    name text NOT NULL,
    audience_label text,
    recipients integer DEFAULT 0 NOT NULL,
    message_preview text,
    status text DEFAULT 'running'::text NOT NULL,
    runs_started integer DEFAULT 0 NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    queued integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_tasks_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'cancelled'::text, 'expired'::text])))
);

-- billing_history
CREATE TABLE billing_history (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    stripe_invoice_id character varying(255),
    event text,
    amount numeric(10,2) DEFAULT 0 NOT NULL,
    currency character varying(3) DEFAULT 'usd'::character varying NOT NULL,
    status text DEFAULT 'succeeded'::text NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_history_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);

-- business_knowledge
CREATE TABLE business_knowledge (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    category text DEFAULT 'faq'::text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    file_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_knowledge_category_check CHECK ((category = ANY (ARRAY['pricing'::text, 'faq'::text, 'product'::text, 'service'::text, 'competitor'::text, 'process'::text])))
);

-- email_poll_state
CREATE TABLE email_poll_state (
    user_id character varying(64) NOT NULL,
    mailbox text,
    uid_validity text,
    last_uid bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- inbound_events
CREATE TABLE inbound_events (
    id bigint NOT NULL,
    dedupe_key text NOT NULL,
    channel text DEFAULT 'whatsapp'::text NOT NULL,
    sender_key text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT inbound_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'dead'::text])))
);

-- job_runs
CREATE TABLE job_runs (
    name text NOT NULL,
    last_started_at timestamp with time zone,
    last_finished_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    last_error_at timestamp with time zone,
    last_duration_ms integer,
    run_count bigint DEFAULT 0 NOT NULL,
    fail_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- lead_business_settings
CREATE TABLE lead_business_settings (
    user_id character varying(64) NOT NULL,
    business_name text,
    business_type text,
    owner_name text,
    phone character varying(50),
    booking_url text,
    currency character varying(10) DEFAULT 'USD'::character varying NOT NULL,
    services jsonb DEFAULT '[]'::jsonb NOT NULL,
    extra_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_mode text DEFAULT 'autonomous'::text NOT NULL,
    lead_sends_used integer DEFAULT 0 NOT NULL,
    lead_sends_this_month integer DEFAULT 0 NOT NULL,
    whatsapp_sends_used integer DEFAULT 0 NOT NULL,
    whatsapp_sends_this_month integer DEFAULT 0 NOT NULL,
    sends_reset_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_business_settings_agent_mode_check CHECK ((agent_mode = ANY (ARRAY['autonomous'::text, 'consent'::text])))
);

-- lead_followup_jobs
CREATE TABLE lead_followup_jobs (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    lead_id character varying(64) NOT NULL,
    template text NOT NULL,
    day integer NOT NULL,
    label text NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    sent_at timestamp with time zone,
    channel text,
    message_body text,
    ai_instructions text,
    workflow_run_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_followup_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT lead_followup_jobs_template_check CHECK ((template = ANY (ARRAY['reminder'::text, 'urgency'::text, 'closure'::text])))
);

-- lead_messages
CREATE TABLE lead_messages (
    id bigint NOT NULL,
    lead_id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    seq integer NOT NULL,
    direction text NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    subject text,
    external_id character varying(255),
    pending boolean DEFAULT false NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);

-- leads
CREATE TABLE leads (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    source text DEFAULT 'form'::text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    from_email character varying(320),
    from_name text,
    from_phone character varying(30),
    customer_name text,
    subject text,
    raw_body text,
    form_data jsonb,
    intent text,
    service_type text,
    urgency text,
    quantity numeric,
    summary text,
    quote jsonb,
    ai_reply jsonb,
    deal_insights jsonb,
    ai_score jsonb,
    conversation_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    conversation_stage text DEFAULT 'initial_inquiry'::text,
    turn_count integer DEFAULT 1 NOT NULL,
    last_customer_message text,
    last_customer_message_at timestamp with time zone,
    thread_from_email character varying(320),
    email_message_id character varying(255),
    email_thread_id character varying(255),
    whatsapp_message_id character varying(255),
    whatsapp_thread_phone character varying(30),
    follow_ups jsonb DEFAULT '[]'::jsonb NOT NULL,
    follow_up_schedule jsonb,
    sent_at timestamp with time zone,
    agent_mode_snapshot text,
    pending_approval boolean DEFAULT false NOT NULL,
    needs_human_review boolean DEFAULT false NOT NULL,
    human_review_reason text,
    human_reply jsonb,
    approved_at timestamp with time zone,
    deal_value numeric(12,2),
    won_at timestamp with time zone,
    workflow_stage text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    calendar_event_id character varying(255),
    calendar_event_link text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    handover jsonb,
    offer jsonb,
    CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['new'::text, 'processing'::text, 'replied'::text, 'pending_followup'::text, 'closed'::text])))
);

-- onboard_requests
CREATE TABLE onboard_requests (
    id character varying(64) NOT NULL,
    type character varying(16) NOT NULL,
    name character varying(200),
    email character varying(300) NOT NULL,
    message text,
    requested_slot timestamp with time zone,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    admin_note text,
    business_name character varying(200),
    industry character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT onboard_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'resolved'::character varying])::text[]))),
    CONSTRAINT onboard_requests_type_check CHECK (((type)::text = ANY ((ARRAY['demo'::character varying, 'support'::character varying])::text[])))
);

-- security_audit_log
CREATE TABLE security_audit_log (
    id character varying(64) NOT NULL,
    user_id character varying(64),
    event character varying(64) NOT NULL,
    ip_address character varying(64),
    user_agent text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- session
CREATE TABLE session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);

-- support_messages
CREATE TABLE support_messages (
    id bigint NOT NULL,
    ticket_id character varying(64) NOT NULL,
    sender text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_messages_sender_check CHECK ((sender = ANY (ARRAY['user'::text, 'admin'::text])))
);

-- support_tickets
CREATE TABLE support_tickets (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    subject character varying(200) NOT NULL,
    category character varying(24) DEFAULT 'other'::character varying NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    admin_unread boolean DEFAULT true NOT NULL,
    user_unread boolean DEFAULT false NOT NULL,
    admin_note text,
    last_message_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_tickets_category_check CHECK (((category)::text = ANY ((ARRAY['question'::character varying, 'problem'::character varying, 'billing'::character varying, 'feature'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT support_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'answered'::character varying, 'resolved'::character varying])::text[])))
);

-- users
CREATE TABLE users (
    id character varying(64) NOT NULL,
    name text,
    email character varying(320),
    password_hash text,
    google_id character varying(128),
    avatar_url text,
    plan text DEFAULT 'free'::text NOT NULL,
    analyses_used integer DEFAULT 0 NOT NULL,
    analyses_limit integer DEFAULT 3 NOT NULL,
    usage_reset_at timestamp with time zone DEFAULT now() NOT NULL,
    company text,
    industry text,
    is_banned boolean DEFAULT false NOT NULL,
    integrations jsonb,
    stripe_customer_id character varying(255),
    stripe_subscription_id character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'starter'::text, 'growth'::text, 'business'::text])))
);

-- whatsapp_contacts
CREATE TABLE whatsapp_contacts (
    user_id character varying(64) NOT NULL,
    phone character varying(32) NOT NULL,
    opted_in_at timestamp with time zone DEFAULT now() NOT NULL,
    last_inbound_at timestamp with time zone DEFAULT now() NOT NULL,
    opted_out_at timestamp with time zone
);

-- workflow_run_events
CREATE TABLE workflow_run_events (
    id character varying(64) NOT NULL,
    run_id character varying(64) NOT NULL,
    step_id text,
    step_type text,
    status text DEFAULT 'ok'::text NOT NULL,
    summary text,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_events_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text, 'skipped'::text])))
);

-- workflow_runs
CREATE TABLE workflow_runs (
    id character varying(64) NOT NULL,
    workflow_id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    lead_id character varying(64) NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    cursor_path jsonb DEFAULT '[]'::jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    wait_until timestamp with time zone,
    wait_reason text,
    error_message text,
    dry_run boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workflow_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'waiting'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);

-- workflows
CREATE TABLE workflows (
    id character varying(64) NOT NULL,
    user_id character varying(64) NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    trigger_type text DEFAULT 'new_lead'::text NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_triggered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text]))),
    CONSTRAINT workflows_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['new_lead'::text, 'lead_replied'::text, 'status_changed'::text, 'stalled'::text, 'manual'::text])))
);


-- ============================================================================
-- Sequences
-- ============================================================================

-- agent_actions_id_seq
CREATE SEQUENCE agent_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- inbound_events_id_seq
CREATE SEQUENCE inbound_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- lead_messages_id_seq
CREATE SEQUENCE lead_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- support_messages_id_seq
CREATE SEQUENCE support_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


-- ============================================================================
-- Sequence ownership
-- ============================================================================

-- agent_actions_id_seq
ALTER SEQUENCE agent_actions_id_seq OWNED BY agent_actions.id;

-- inbound_events_id_seq
ALTER SEQUENCE inbound_events_id_seq OWNED BY inbound_events.id;

-- lead_messages_id_seq
ALTER SEQUENCE lead_messages_id_seq OWNED BY lead_messages.id;

-- support_messages_id_seq
ALTER SEQUENCE support_messages_id_seq OWNED BY support_messages.id;


-- ============================================================================
-- Column defaults
-- ============================================================================

-- agent_actions id
ALTER TABLE agent_actions ALTER COLUMN id SET DEFAULT nextval('agent_actions_id_seq'::regclass);

-- inbound_events id
ALTER TABLE inbound_events ALTER COLUMN id SET DEFAULT nextval('inbound_events_id_seq'::regclass);

-- lead_messages id
ALTER TABLE lead_messages ALTER COLUMN id SET DEFAULT nextval('lead_messages_id_seq'::regclass);

-- support_messages id
ALTER TABLE support_messages ALTER COLUMN id SET DEFAULT nextval('support_messages_id_seq'::regclass);


-- ============================================================================
-- Primary keys, unique and check constraints
-- ============================================================================

-- admin_settings admin_settings_pkey
ALTER TABLE admin_settings
    ADD CONSTRAINT admin_settings_pkey PRIMARY KEY (key);

-- agent_actions agent_actions_pkey
ALTER TABLE agent_actions
    ADD CONSTRAINT agent_actions_pkey PRIMARY KEY (id);

-- agent_media agent_media_pkey
ALTER TABLE agent_media
    ADD CONSTRAINT agent_media_pkey PRIMARY KEY (id);

-- agent_prefs agent_prefs_pkey
ALTER TABLE agent_prefs
    ADD CONSTRAINT agent_prefs_pkey PRIMARY KEY (user_id);

-- agent_proposals agent_proposals_pkey
ALTER TABLE agent_proposals
    ADD CONSTRAINT agent_proposals_pkey PRIMARY KEY (id);

-- agent_tasks agent_tasks_pkey
ALTER TABLE agent_tasks
    ADD CONSTRAINT agent_tasks_pkey PRIMARY KEY (id);

-- billing_history billing_history_pkey
ALTER TABLE billing_history
    ADD CONSTRAINT billing_history_pkey PRIMARY KEY (id);

-- business_knowledge business_knowledge_pkey
ALTER TABLE business_knowledge
    ADD CONSTRAINT business_knowledge_pkey PRIMARY KEY (id);

-- email_poll_state email_poll_state_pkey
ALTER TABLE email_poll_state
    ADD CONSTRAINT email_poll_state_pkey PRIMARY KEY (user_id);

-- inbound_events inbound_events_dedupe_key_key
ALTER TABLE inbound_events
    ADD CONSTRAINT inbound_events_dedupe_key_key UNIQUE (dedupe_key);

-- inbound_events inbound_events_pkey
ALTER TABLE inbound_events
    ADD CONSTRAINT inbound_events_pkey PRIMARY KEY (id);

-- job_runs job_runs_pkey
ALTER TABLE job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (name);

-- lead_business_settings lead_business_settings_pkey
ALTER TABLE lead_business_settings
    ADD CONSTRAINT lead_business_settings_pkey PRIMARY KEY (user_id);

-- lead_followup_jobs lead_followup_jobs_pkey
ALTER TABLE lead_followup_jobs
    ADD CONSTRAINT lead_followup_jobs_pkey PRIMARY KEY (id);

-- lead_messages lead_messages_lead_id_seq_key
ALTER TABLE lead_messages
    ADD CONSTRAINT lead_messages_lead_id_seq_key UNIQUE (lead_id, seq);

-- lead_messages lead_messages_pkey
ALTER TABLE lead_messages
    ADD CONSTRAINT lead_messages_pkey PRIMARY KEY (id);

-- leads leads_pkey
ALTER TABLE leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

-- onboard_requests onboard_requests_pkey
ALTER TABLE onboard_requests
    ADD CONSTRAINT onboard_requests_pkey PRIMARY KEY (id);

-- security_audit_log security_audit_log_pkey
ALTER TABLE security_audit_log
    ADD CONSTRAINT security_audit_log_pkey PRIMARY KEY (id);

-- session session_pkey
ALTER TABLE session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);

-- support_messages support_messages_pkey
ALTER TABLE support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);

-- support_tickets support_tickets_pkey
ALTER TABLE support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);

-- users users_email_key
ALTER TABLE users
    ADD CONSTRAINT users_email_key UNIQUE (email);

-- users users_google_id_key
ALTER TABLE users
    ADD CONSTRAINT users_google_id_key UNIQUE (google_id);

-- users users_pkey
ALTER TABLE users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- whatsapp_contacts whatsapp_contacts_pkey
ALTER TABLE whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_pkey PRIMARY KEY (user_id, phone);

-- workflow_run_events workflow_run_events_pkey
ALTER TABLE workflow_run_events
    ADD CONSTRAINT workflow_run_events_pkey PRIMARY KEY (id);

-- workflow_runs workflow_runs_pkey
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);

-- workflows workflows_pkey
ALTER TABLE workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


-- ============================================================================
-- Foreign keys
-- ============================================================================

-- agent_actions agent_actions_lead_id_fkey
ALTER TABLE agent_actions
    ADD CONSTRAINT agent_actions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- agent_actions agent_actions_user_id_fkey
ALTER TABLE agent_actions
    ADD CONSTRAINT agent_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_media agent_media_user_id_fkey
ALTER TABLE agent_media
    ADD CONSTRAINT agent_media_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_prefs agent_prefs_user_id_fkey
ALTER TABLE agent_prefs
    ADD CONSTRAINT agent_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_proposals agent_proposals_user_id_fkey
ALTER TABLE agent_proposals
    ADD CONSTRAINT agent_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_tasks agent_tasks_user_id_fkey
ALTER TABLE agent_tasks
    ADD CONSTRAINT agent_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- billing_history billing_history_user_id_fkey
ALTER TABLE billing_history
    ADD CONSTRAINT billing_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- business_knowledge business_knowledge_user_id_fkey
ALTER TABLE business_knowledge
    ADD CONSTRAINT business_knowledge_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- email_poll_state email_poll_state_user_id_fkey
ALTER TABLE email_poll_state
    ADD CONSTRAINT email_poll_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- lead_business_settings lead_business_settings_user_id_fkey
ALTER TABLE lead_business_settings
    ADD CONSTRAINT lead_business_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- lead_followup_jobs lead_followup_jobs_lead_id_fkey
ALTER TABLE lead_followup_jobs
    ADD CONSTRAINT lead_followup_jobs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- lead_followup_jobs lead_followup_jobs_user_id_fkey
ALTER TABLE lead_followup_jobs
    ADD CONSTRAINT lead_followup_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- lead_followup_jobs lead_followup_jobs_workflow_run_id_fkey
ALTER TABLE lead_followup_jobs
    ADD CONSTRAINT lead_followup_jobs_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL;

-- lead_messages lead_messages_lead_id_fkey
ALTER TABLE lead_messages
    ADD CONSTRAINT lead_messages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- lead_messages lead_messages_user_id_fkey
ALTER TABLE lead_messages
    ADD CONSTRAINT lead_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- leads leads_user_id_fkey
ALTER TABLE leads
    ADD CONSTRAINT leads_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- security_audit_log security_audit_log_user_id_fkey
ALTER TABLE security_audit_log
    ADD CONSTRAINT security_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- support_messages support_messages_ticket_id_fkey
ALTER TABLE support_messages
    ADD CONSTRAINT support_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;

-- support_tickets support_tickets_user_id_fkey
ALTER TABLE support_tickets
    ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- whatsapp_contacts whatsapp_contacts_user_id_fkey
ALTER TABLE whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- workflow_run_events workflow_run_events_run_id_fkey
ALTER TABLE workflow_run_events
    ADD CONSTRAINT workflow_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

-- workflow_runs workflow_runs_lead_id_fkey
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;

-- workflow_runs workflow_runs_user_id_fkey
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- workflow_runs workflow_runs_workflow_id_fkey
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE;

-- workflows workflows_user_id_fkey
ALTER TABLE workflows
    ADD CONSTRAINT workflows_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;


-- ============================================================================
-- Indexes
-- ============================================================================

-- idx_agent_actions_due
CREATE INDEX idx_agent_actions_due ON agent_actions USING btree (run_after) WHERE (status = 'queued'::text);

-- idx_agent_actions_lead
CREATE INDEX idx_agent_actions_lead ON agent_actions USING btree (lead_id, created_at DESC);

-- idx_agent_actions_user_time
CREATE INDEX idx_agent_actions_user_time ON agent_actions USING btree (user_id, created_at DESC);

-- idx_agent_media_user
CREATE INDEX idx_agent_media_user ON agent_media USING btree (user_id, created_at DESC);

-- idx_agent_proposals_user_status
CREATE INDEX idx_agent_proposals_user_status ON agent_proposals USING btree (user_id, status, created_at DESC);

-- idx_agent_tasks_unnotified
CREATE INDEX idx_agent_tasks_unnotified ON agent_tasks USING btree (user_id) WHERE ((notified_at IS NULL) AND (status <> 'running'::text));

-- idx_agent_tasks_user
CREATE INDEX idx_agent_tasks_user ON agent_tasks USING btree (user_id, created_at DESC);

-- idx_billing_user_created
CREATE INDEX idx_billing_user_created ON billing_history USING btree (user_id, created_at DESC);

-- idx_business_knowledge_user
CREATE INDEX idx_business_knowledge_user ON business_knowledge USING btree (user_id, category);

-- idx_followup_jobs_due
CREATE INDEX idx_followup_jobs_due ON lead_followup_jobs USING btree (scheduled_at) WHERE (status = 'pending'::text);

-- idx_followup_jobs_lead
CREATE INDEX idx_followup_jobs_lead ON lead_followup_jobs USING btree (lead_id);

-- idx_followup_jobs_run
CREATE INDEX idx_followup_jobs_run ON lead_followup_jobs USING btree (workflow_run_id) WHERE (workflow_run_id IS NOT NULL);

-- idx_followup_jobs_user_status
CREATE INDEX idx_followup_jobs_user_status ON lead_followup_jobs USING btree (user_id, status);

-- idx_inbound_events_closed
CREATE INDEX idx_inbound_events_closed ON inbound_events USING btree (processed_at) WHERE (status = ANY (ARRAY['done'::text, 'dead'::text]));

-- idx_inbound_events_locked
CREATE INDEX idx_inbound_events_locked ON inbound_events USING btree (locked_at) WHERE (status = 'processing'::text);

-- idx_inbound_events_ready
CREATE INDEX idx_inbound_events_ready ON inbound_events USING btree (next_attempt_at) WHERE (status = 'pending'::text);

-- idx_inbound_events_sender
CREATE INDEX idx_inbound_events_sender ON inbound_events USING btree (sender_key, id) WHERE (status = 'pending'::text);

-- idx_lead_messages_external
CREATE INDEX idx_lead_messages_external ON lead_messages USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);

-- idx_lead_messages_user_time
CREATE INDEX idx_lead_messages_user_time ON lead_messages USING btree (user_id, created_at DESC);

-- idx_leads_created_at
CREATE INDEX idx_leads_created_at ON leads USING btree (created_at DESC);

-- idx_leads_needs_human_review
CREATE INDEX idx_leads_needs_human_review ON leads USING btree (user_id, needs_human_review) WHERE (needs_human_review = true);

-- idx_leads_pending_approval
CREATE INDEX idx_leads_pending_approval ON leads USING btree (user_id, pending_approval) WHERE (pending_approval = true);

-- idx_leads_thread_email
CREATE INDEX idx_leads_thread_email ON leads USING btree (user_id, thread_from_email);

-- idx_leads_user_created
CREATE INDEX idx_leads_user_created ON leads USING btree (user_id, created_at DESC);

-- idx_leads_user_email_msg
CREATE INDEX idx_leads_user_email_msg ON leads USING btree (user_id, email_message_id) WHERE (email_message_id IS NOT NULL);

-- idx_leads_user_email_thread
CREATE INDEX idx_leads_user_email_thread ON leads USING btree (user_id, email_thread_id) WHERE (email_thread_id IS NOT NULL);

-- idx_leads_user_status
CREATE INDEX idx_leads_user_status ON leads USING btree (user_id, status);

-- idx_leads_user_wa_msg
CREATE INDEX idx_leads_user_wa_msg ON leads USING btree (user_id, whatsapp_message_id) WHERE (whatsapp_message_id IS NOT NULL);

-- idx_leads_whatsapp_thread
CREATE INDEX idx_leads_whatsapp_thread ON leads USING btree (user_id, whatsapp_thread_phone) WHERE (whatsapp_thread_phone IS NOT NULL);

-- idx_leads_won_at
CREATE INDEX idx_leads_won_at ON leads USING btree (user_id, won_at) WHERE (won_at IS NOT NULL);

-- idx_leads_workflow_stage
CREATE INDEX idx_leads_workflow_stage ON leads USING btree (user_id, workflow_stage) WHERE (workflow_stage IS NOT NULL);

-- idx_onboard_requests_status
CREATE INDEX idx_onboard_requests_status ON onboard_requests USING btree (status, created_at DESC);

-- idx_onboard_requests_type
CREATE INDEX idx_onboard_requests_type ON onboard_requests USING btree (type, created_at DESC);

-- idx_security_audit_created
CREATE INDEX idx_security_audit_created ON security_audit_log USING btree (created_at);

-- idx_security_audit_event
CREATE INDEX idx_security_audit_event ON security_audit_log USING btree (event, created_at DESC);

-- idx_security_audit_ip
CREATE INDEX idx_security_audit_ip ON security_audit_log USING btree (ip_address, created_at DESC);

-- idx_security_audit_user
CREATE INDEX idx_security_audit_user ON security_audit_log USING btree (user_id, created_at DESC);

-- idx_session_expire
CREATE INDEX idx_session_expire ON session USING btree (expire);

-- idx_support_messages_ticket
CREATE INDEX idx_support_messages_ticket ON support_messages USING btree (ticket_id, id);

-- idx_support_tickets_inbox
CREATE INDEX idx_support_tickets_inbox ON support_tickets USING btree (status, last_message_at DESC);

-- idx_support_tickets_user
CREATE INDEX idx_support_tickets_user ON support_tickets USING btree (user_id, last_message_at DESC);

-- idx_users_created_at
CREATE INDEX idx_users_created_at ON users USING btree (created_at DESC);

-- idx_users_email_lower
CREATE UNIQUE INDEX idx_users_email_lower ON users USING btree (lower((email)::text));

-- idx_users_email_polling
CREATE INDEX idx_users_email_polling ON users USING btree (created_at) WHERE ((NOT is_banned) AND ((((integrations -> 'pipeline_email'::text) ->> 'enc_pass'::text) IS NOT NULL) OR (((integrations -> 'lead_email'::text) ->> 'enc_pass'::text) IS NOT NULL)));

-- idx_users_stripe_customer
CREATE INDEX idx_users_stripe_customer ON users USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);

-- idx_users_whatsapp_phone
CREATE INDEX idx_users_whatsapp_phone ON users USING btree ((((integrations -> 'whatsapp'::text) ->> 'phoneNumberId'::text))) WHERE (((integrations -> 'whatsapp'::text) ->> 'phoneNumberId'::text) IS NOT NULL);

-- idx_wfevents_run
CREATE INDEX idx_wfevents_run ON workflow_run_events USING btree (run_id, created_at);

-- idx_wfruns_active_per_combo
CREATE INDEX idx_wfruns_active_per_combo ON workflow_runs USING btree (workflow_id, lead_id) WHERE (status = ANY (ARRAY['running'::text, 'waiting'::text]));

-- idx_wfruns_lead
CREATE INDEX idx_wfruns_lead ON workflow_runs USING btree (lead_id);

-- idx_wfruns_user
CREATE INDEX idx_wfruns_user ON workflow_runs USING btree (user_id);

-- idx_wfruns_waiting_due
CREATE INDEX idx_wfruns_waiting_due ON workflow_runs USING btree (wait_until) WHERE (status = 'waiting'::text);

-- idx_wfruns_waiting_reply
CREATE INDEX idx_wfruns_waiting_reply ON workflow_runs USING btree (lead_id, status, wait_reason) WHERE (status = 'waiting'::text);

-- idx_wfruns_workflow
CREATE INDEX idx_wfruns_workflow ON workflow_runs USING btree (workflow_id);

-- idx_workflows_active_trigger
CREATE INDEX idx_workflows_active_trigger ON workflows USING btree (user_id, status, trigger_type) WHERE (status = 'active'::text);

-- idx_workflows_temporary
CREATE INDEX idx_workflows_temporary ON workflows USING btree (updated_at) WHERE ((trigger_config ->> 'temporary'::text) = 'true'::text);

-- idx_workflows_user_updated
CREATE INDEX idx_workflows_user_updated ON workflows USING btree (user_id, updated_at DESC);

-- uq_agent_actions_dedupe
CREATE UNIQUE INDEX uq_agent_actions_dedupe ON agent_actions USING btree (user_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


-- ============================================================================
-- updated_at triggers
-- ============================================================================

-- admin_settings trg_admin_settings_updated_at
CREATE TRIGGER trg_admin_settings_updated_at BEFORE UPDATE ON admin_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- agent_actions trg_agent_actions_updated_at
CREATE TRIGGER trg_agent_actions_updated_at BEFORE UPDATE ON agent_actions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- agent_prefs trg_agent_prefs_updated_at
CREATE TRIGGER trg_agent_prefs_updated_at BEFORE UPDATE ON agent_prefs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- agent_proposals trg_agent_proposals_updated_at
CREATE TRIGGER trg_agent_proposals_updated_at BEFORE UPDATE ON agent_proposals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- business_knowledge trg_business_knowledge_updated_at
CREATE TRIGGER trg_business_knowledge_updated_at BEFORE UPDATE ON business_knowledge FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- email_poll_state trg_email_poll_state_updated_at
CREATE TRIGGER trg_email_poll_state_updated_at BEFORE UPDATE ON email_poll_state FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- lead_business_settings trg_lead_business_settings_updated_at
CREATE TRIGGER trg_lead_business_settings_updated_at BEFORE UPDATE ON lead_business_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- lead_followup_jobs trg_lead_followup_jobs_updated_at
CREATE TRIGGER trg_lead_followup_jobs_updated_at BEFORE UPDATE ON lead_followup_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- leads trg_leads_updated_at
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- support_tickets trg_support_tickets_updated_at
CREATE TRIGGER trg_support_tickets_updated_at BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- users trg_users_updated_at
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- workflow_runs trg_workflow_runs_updated_at
CREATE TRIGGER trg_workflow_runs_updated_at BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- workflows trg_workflows_updated_at
CREATE TRIGGER trg_workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================================
-- Row-level security
-- ============================================================================

-- admin_settings
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

-- agent_actions
ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;

-- agent_media
ALTER TABLE agent_media ENABLE ROW LEVEL SECURITY;

-- agent_prefs
ALTER TABLE agent_prefs ENABLE ROW LEVEL SECURITY;

-- agent_proposals
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;

-- agent_tasks
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

-- billing_history
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;

-- business_knowledge
ALTER TABLE business_knowledge ENABLE ROW LEVEL SECURITY;

-- email_poll_state
ALTER TABLE email_poll_state ENABLE ROW LEVEL SECURITY;

-- inbound_events
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;

-- job_runs
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;

-- lead_business_settings
ALTER TABLE lead_business_settings ENABLE ROW LEVEL SECURITY;

-- lead_followup_jobs
ALTER TABLE lead_followup_jobs ENABLE ROW LEVEL SECURITY;

-- lead_messages
ALTER TABLE lead_messages ENABLE ROW LEVEL SECURITY;

-- leads
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- onboard_requests
ALTER TABLE onboard_requests ENABLE ROW LEVEL SECURITY;

-- security_audit_log
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;

-- session
ALTER TABLE session ENABLE ROW LEVEL SECURITY;

-- support_messages
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- support_tickets
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- whatsapp_contacts
ALTER TABLE whatsapp_contacts ENABLE ROW LEVEL SECURITY;

-- workflow_run_events
ALTER TABLE workflow_run_events ENABLE ROW LEVEL SECURITY;

-- workflow_runs
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;

-- workflows
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- Row-level security policies
-- ============================================================================

-- agent_actions agent_actions_owner_only
CREATE POLICY agent_actions_owner_only ON agent_actions USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- agent_media agent_media_owner_only
CREATE POLICY agent_media_owner_only ON agent_media USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- agent_prefs agent_prefs_owner_only
CREATE POLICY agent_prefs_owner_only ON agent_prefs USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- agent_proposals agent_proposals_owner_only
CREATE POLICY agent_proposals_owner_only ON agent_proposals USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- agent_tasks agent_tasks_owner_only
CREATE POLICY agent_tasks_owner_only ON agent_tasks USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- billing_history billing_history_owner_read
CREATE POLICY billing_history_owner_read ON billing_history FOR SELECT USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- business_knowledge business_knowledge_owner_only
CREATE POLICY business_knowledge_owner_only ON business_knowledge USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- email_poll_state email_poll_state_owner_only
CREATE POLICY email_poll_state_owner_only ON email_poll_state USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- lead_followup_jobs followup_jobs_owner_only
CREATE POLICY followup_jobs_owner_only ON lead_followup_jobs USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- lead_messages lead_messages_owner_only
CREATE POLICY lead_messages_owner_only ON lead_messages USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- lead_business_settings lead_settings_owner_only
CREATE POLICY lead_settings_owner_only ON lead_business_settings USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- leads leads_owner_only
CREATE POLICY leads_owner_only ON leads USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- support_tickets support_tickets_owner_only
CREATE POLICY support_tickets_owner_only ON support_tickets USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- users users_self_access
CREATE POLICY users_self_access ON users USING (((id)::text = current_setting('app.user_id'::text, true)));

-- whatsapp_contacts whatsapp_contacts_owner_only
CREATE POLICY whatsapp_contacts_owner_only ON whatsapp_contacts USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- workflow_run_events workflow_run_events_owner_only
CREATE POLICY workflow_run_events_owner_only ON workflow_run_events USING (((run_id)::text IN ( SELECT workflow_runs.id
   FROM workflow_runs
  WHERE ((workflow_runs.user_id)::text = current_setting('app.user_id'::text, true)))));

-- workflow_runs workflow_runs_owner_only
CREATE POLICY workflow_runs_owner_only ON workflow_runs USING (((user_id)::text = current_setting('app.user_id'::text, true)));

-- workflows workflows_owner_only
CREATE POLICY workflows_owner_only ON workflows USING (((user_id)::text = current_setting('app.user_id'::text, true)));


-- ==================================================================================
-- Seed data
-- ==================================================================================
INSERT INTO admin_settings (key, value) VALUES ('maintenance_mode', '0'), ('signups_enabled', '1')
  ON CONFLICT (key) DO NOTHING;
