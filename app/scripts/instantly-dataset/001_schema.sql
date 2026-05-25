-- ============================================================================
--  Instantly long-term analytical dataset — schema v1
--
--  Target DB: local Postgres pointed to by $INSTANTLY_DATABASE_URL (not the
--  portal's prod DB — fully isolated, zero risk to production).
--
--  Design philosophy:
--   1. RAW LAYER (raw_*)  — one row per Instantly entity, UPSERT by id.
--      Each table has explicit columns for the most queried fields *plus* a
--      raw_payload JSONB with the full API response so we never lose data
--      when Instantly adds new fields.
--
--   2. SNAPSHOT LAYER (*_snap) — analytics that change over time
--      (campaign/account stats, warmup metrics). APPEND-only, keyed by
--      snapshot_id. This is how we get "multi-year trends".
--
--   3. ANALYTICAL LAYER (v_*) — views that JOIN raw entities with the *latest*
--      snapshot. Optimised for the questions the team actually asks
--      ("subject X open rate", "account Y daily volume", etc.).
--
--   4. dataset_snapshots — provenance: every pull writes one row here.
--
--  All timestamps are TIMESTAMPTZ. All Instantly IDs are TEXT (mixed UUID
--  formats over the years).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- gen_random_uuid()

-- ─── Provenance ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dataset_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  mode            TEXT NOT NULL CHECK (mode IN ('full', 'delta', 'analytics-only')),
  ok              BOOLEAN,
  error           TEXT,
  counts          JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"campaigns": 1700, "emails": 3680000, ...}
  notes           TEXT
);
COMMENT ON TABLE  dataset_snapshots IS 'One row per pull. Every analytics_*_snap row links here via snapshot_id.';
COMMENT ON COLUMN dataset_snapshots.mode IS 'full = wipe-and-refill; delta = incremental upsert; analytics-only = refresh analytics tables without re-pulling entities';

CREATE INDEX IF NOT EXISTS dataset_snapshots_finished_idx ON dataset_snapshots(finished_at DESC) WHERE ok IS TRUE;

-- ============================================================================
--  RAW LAYER  — entities (UPSERT by id)
-- ============================================================================

-- ─── Campaigns ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_campaigns (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  status                   SMALLINT,           -- 0=draft 1=active 2=paused 3=completed 4=running-sub
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,

  daily_limit              INT,
  daily_max_leads          INT,
  email_gap                INT,
  is_evergreen             BOOLEAN,
  open_tracking            BOOLEAN,
  link_tracking            BOOLEAN,
  stop_on_reply            BOOLEAN,

  email_list               TEXT[],             -- mailbox emails attached to this campaign
  email_tag_list           TEXT[],

  -- complex nested structures kept as JSONB for direct querying
  campaign_schedule        JSONB,              -- full schedule object
  sequences                JSONB,              -- exploded into raw_campaign_steps below

  raw_payload              JSONB NOT NULL,     -- complete /campaigns/{id} response
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_campaigns_status_idx ON raw_campaigns(status);
CREATE INDEX IF NOT EXISTS raw_campaigns_updated_idx ON raw_campaigns(timestamp_updated DESC);

-- ─── Campaign steps (exploded sequences[].steps[].variants[]) ───────────────

CREATE TABLE IF NOT EXISTS raw_campaign_steps (
  campaign_id              TEXT NOT NULL REFERENCES raw_campaigns(id) ON DELETE CASCADE,
  sequence_n               SMALLINT NOT NULL,  -- 0-based; usually 0 unless campaign has multiple sequences
  step_n                   SMALLINT NOT NULL,  -- 0-based step in the sequence
  variant_n                SMALLINT NOT NULL,  -- 0 = no A/B; 0,1,2… for A/B/C variants

  subject                  TEXT,
  body_text                TEXT,               -- HTML stripped to plain text (html kept inside raw_payload if ever needed)
  wait_days                INT,
  delay                    INT,
  delay_unit               TEXT,
  step_type                TEXT,               -- 'email', etc.

  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, sequence_n, step_n, variant_n)
);
COMMENT ON TABLE raw_campaign_steps IS 'Exploded sequences. Join with raw_campaign_step_analytics_snap on (campaign_id, step_n, variant_n) to get subject × open/reply rate.';
COMMENT ON COLUMN raw_campaign_steps.body_text IS 'Plain text only. Original HTML is preserved in raw_payload.body if ever needed.';

-- ─── Accounts (sending mailboxes) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_accounts (
  email                    TEXT PRIMARY KEY,
  first_name               TEXT,
  last_name                TEXT,
  organization             TEXT,
  provider_code            SMALLINT,            -- 1=IMAP 2=Google 3=Microsoft 4=AWS 8=AirMail
  status                   SMALLINT,            -- 1=active 2=paused -1/-2/-3 errors
  warmup_status            SMALLINT,            -- 0=paused 1=active -1=banned
  daily_limit              INT,
  sending_gap              INT,
  setup_pending            BOOLEAN,
  is_managed_account       BOOLEAN,
  tracking_domain_name     TEXT,
  tracking_domain_status   TEXT,
  stat_warmup_score        NUMERIC,
  warmup_pool_id           TEXT,

  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  timestamp_last_used      TIMESTAMPTZ,
  timestamp_warmup_start   TIMESTAMPTZ,

  warmup                   JSONB,               -- nested warmup config
  status_message           JSONB,               -- last error/status payload

  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_accounts_status_idx ON raw_accounts(status);

-- ─── Lead lists ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_lead_lists (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Leads ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_leads (
  id                       TEXT PRIMARY KEY,
  email                    TEXT,
  campaign_id              TEXT,
  lead_list_id             TEXT,

  first_name               TEXT,
  last_name                TEXT,
  company_name             TEXT,
  title                    TEXT,
  phone                    TEXT,
  website                  TEXT,
  linkedin_url             TEXT,

  interest_status          SMALLINT,             -- 0/1/-1/-2/-3
  interest_value           TEXT,

  custom_variables         JSONB,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,

  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_leads_campaign_idx       ON raw_leads(campaign_id);
CREATE INDEX IF NOT EXISTS raw_leads_email_idx          ON raw_leads(email);
CREATE INDEX IF NOT EXISTS raw_leads_interest_idx       ON raw_leads(interest_status);

-- ─── Emails (the big one) ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_emails (
  id                       TEXT PRIMARY KEY,
  campaign_id              TEXT,
  lead_id                  TEXT,
  thread_id                TEXT,
  eaccount                 TEXT,                 -- sending mailbox (=raw_accounts.email)

  ue_type                  SMALLINT,             -- 1=we sent  2=lead replied  3=we replied (lookup_ue_types)
  subject                  TEXT,
  body_text                TEXT,                 -- HTML stripped to plain text (raw HTML in raw_payload.body)
  content_preview          TEXT,

  from_email               TEXT,
  to_email                 TEXT,
  from_address_json        JSONB,
  to_address_json          JSONB,

  i_status                 SMALLINT,             -- lookup_interest_status (lead's status at email time)
  ai_interest_value        SMALLINT,             -- Instantly's own AI interest score for this email

  timestamp_email          TIMESTAMPTZ,          -- when the email actually went out / arrived
  timestamp_created        TIMESTAMPTZ,          -- when Instantly recorded the row

  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_emails_campaign_idx      ON raw_emails(campaign_id);
CREATE INDEX IF NOT EXISTS raw_emails_lead_idx          ON raw_emails(lead_id);
CREATE INDEX IF NOT EXISTS raw_emails_thread_idx        ON raw_emails(thread_id);
CREATE INDEX IF NOT EXISTS raw_emails_eaccount_time_idx ON raw_emails(eaccount, timestamp_email);
CREATE INDEX IF NOT EXISTS raw_emails_ue_type_idx       ON raw_emails(ue_type);
CREATE INDEX IF NOT EXISTS raw_emails_time_idx          ON raw_emails(timestamp_email);

-- ─── Subsequences, templates, tags, labels, block list, webhooks ───────────

CREATE TABLE IF NOT EXISTS raw_subsequences (
  id                       TEXT PRIMARY KEY,
  campaign_id              TEXT,
  name                     TEXT,
  status                   SMALLINT,
  sequences                JSONB,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_subsequences_campaign_idx ON raw_subsequences(campaign_id);

CREATE TABLE IF NOT EXISTS raw_email_templates (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  subject                  TEXT,
  body                     TEXT,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_custom_tags (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  description              TEXT,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_custom_tag_mappings (
  id                       TEXT PRIMARY KEY,
  tag_id                   TEXT NOT NULL,
  resource_id              TEXT NOT NULL,
  resource_type            TEXT NOT NULL,        -- 'campaign' | 'lead' | 'account' | ...
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_ctm_resource_idx ON raw_custom_tag_mappings(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS raw_lead_labels (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  color                    TEXT,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_block_list (
  id                       TEXT PRIMARY KEY,
  value                    TEXT,
  type                     TEXT,
  timestamp_created        TIMESTAMPTZ,
  timestamp_updated        TIMESTAMPTZ,
  raw_payload              JSONB NOT NULL,
  pulled_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- raw_webhooks intentionally omitted — dropped in migration 002 as operational-only (zero analytical value)

-- ============================================================================
--  SNAPSHOT LAYER — analytics that change over time (APPEND, keyed by snapshot_id)
-- ============================================================================

-- /campaigns/analytics/overview per campaign (lifetime totals, snapshotted)
CREATE TABLE IF NOT EXISTS raw_campaign_analytics_overview_snap (
  snapshot_id              UUID NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
  campaign_id              TEXT NOT NULL,
  campaign_name            TEXT,

  emails_sent_count        INT,
  contacted_count          INT,
  new_leads_contacted_count INT,
  open_count               INT,
  open_count_unique        INT,
  reply_count              INT,
  bounced_count            INT,
  unsubscribed_count       INT,
  leads_count              INT,

  raw_payload              JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS rcaos_campaign_idx ON raw_campaign_analytics_overview_snap(campaign_id);

-- /campaigns/analytics/daily — one row per (campaign, date) per snapshot
CREATE TABLE IF NOT EXISTS raw_campaign_analytics_daily_snap (
  snapshot_id              UUID NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
  campaign_id              TEXT NOT NULL,
  date                     DATE NOT NULL,
  sent                     INT,
  opened                   INT,
  unique_opened            INT,
  replies                  INT,
  unique_replies           INT,
  clicks                   INT,
  unique_clicks            INT,
  bounced                  INT,
  unsubscribed             INT,
  raw_payload              JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, campaign_id, date)
);
CREATE INDEX IF NOT EXISTS rcads_campaign_date_idx ON raw_campaign_analytics_daily_snap(campaign_id, date);

-- /campaigns/analytics/steps — per step+variant per campaign
CREATE TABLE IF NOT EXISTS raw_campaign_step_analytics_snap (
  snapshot_id              UUID NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
  campaign_id              TEXT NOT NULL,
  step_n                   SMALLINT NOT NULL,
  variant_n                SMALLINT NOT NULL,
  sent                     INT,
  opened                   INT,
  unique_opened            INT,
  replies                  INT,
  unique_replies           INT,
  clicks                   INT,
  unique_clicks            INT,
  opportunities            INT,
  raw_payload              JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, campaign_id, step_n, variant_n)
);

-- /accounts/warmup-analytics — per (account, date)
CREATE TABLE IF NOT EXISTS raw_warmup_analytics_snap (
  snapshot_id              UUID NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
  email                    TEXT NOT NULL,
  date                     DATE NOT NULL,
  sent                     INT,
  received                 INT,
  landed_inbox             INT,
  landed_spam              INT,
  raw_payload              JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, email, date)
);
CREATE INDEX IF NOT EXISTS rwas_email_date_idx ON raw_warmup_analytics_snap(email, date);

-- ============================================================================
--  ANALYTICAL LAYER — views on the latest snapshot
-- ============================================================================

-- Latest successfully-completed snapshot id
CREATE OR REPLACE VIEW v_latest_snapshot AS
SELECT id, started_at, finished_at, counts
FROM dataset_snapshots
WHERE ok IS TRUE AND finished_at IS NOT NULL
ORDER BY finished_at DESC
LIMIT 1;

-- KEY VIEW: subject × campaign × open/reply.
-- Answers: "Какой open/reply rate у такой-то темы в такой-то кампании?"
CREATE OR REPLACE VIEW v_subject_performance AS
SELECT
  s.campaign_id,
  c.name                       AS campaign_name,
  c.status                     AS campaign_status,
  s.sequence_n,
  s.step_n,
  s.variant_n,
  s.subject,
  a.sent,
  a.opened,
  a.unique_opened,
  a.replies,
  a.unique_replies,
  a.clicks,
  a.unique_clicks,
  a.opportunities,
  CASE WHEN COALESCE(a.sent, 0) > 0 THEN ROUND(100.0 * a.unique_opened   / a.sent, 2) END AS open_rate_pct,
  CASE WHEN COALESCE(a.sent, 0) > 0 THEN ROUND(100.0 * a.unique_replies  / a.sent, 2) END AS reply_rate_pct,
  CASE WHEN COALESCE(a.sent, 0) > 0 THEN ROUND(100.0 * a.unique_clicks   / a.sent, 2) END AS click_rate_pct
FROM raw_campaign_steps s
JOIN raw_campaigns c ON c.id = s.campaign_id
LEFT JOIN raw_campaign_step_analytics_snap a
       ON a.campaign_id = s.campaign_id
      AND a.step_n      = s.step_n
      AND a.variant_n   = s.variant_n
      AND a.snapshot_id = (SELECT id FROM v_latest_snapshot);

-- Per-mailbox daily volume (derived from raw_emails)
CREATE OR REPLACE VIEW v_account_daily_volume AS
SELECT
  e.eaccount,
  date_trunc('day', e.timestamp_email)::date AS day,
  COUNT(*) FILTER (WHERE e.ue_type = 1) AS sent,
  COUNT(*) FILTER (WHERE e.ue_type = 2) AS replies_received,
  COUNT(*) FILTER (WHERE e.ue_type = 3) AS our_responses,
  COUNT(DISTINCT e.lead_id) FILTER (WHERE e.ue_type = 1) AS unique_leads_contacted,
  COUNT(DISTINCT e.thread_id)            AS unique_threads
FROM raw_emails e
WHERE e.timestamp_email IS NOT NULL AND e.eaccount IS NOT NULL
GROUP BY 1, 2;

-- Per-thread outcome
CREATE OR REPLACE VIEW v_thread_outcomes AS
SELECT
  e.thread_id,
  MIN(e.campaign_id)                                                       AS campaign_id,
  MIN(e.lead_id)                                                           AS lead_id,
  MIN(e.eaccount)                                                          AS eaccount,
  MIN(e.timestamp_email) FILTER (WHERE e.ue_type = 1)                      AS first_outbound_at,
  MIN(e.timestamp_email) FILTER (WHERE e.ue_type = 2)                      AS first_reply_at,
  MAX(e.timestamp_email)                                                   AS last_event_at,
  COUNT(*) FILTER (WHERE e.ue_type = 1)                                    AS outbound_count,
  COUNT(*) FILTER (WHERE e.ue_type = 2)                                    AS reply_count,
  COUNT(*) FILTER (WHERE e.ue_type = 3)                                    AS our_response_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE e.ue_type = 2) > 0 THEN 'replied'
    WHEN COUNT(*) FILTER (WHERE e.ue_type = 1) > 0 THEN 'sent_no_reply'
    ELSE 'unknown'
  END                                                                      AS outcome
FROM raw_emails e
WHERE e.thread_id IS NOT NULL
GROUP BY e.thread_id;

-- Per-lead chronological journey
CREATE OR REPLACE VIEW v_lead_journey AS
SELECT
  l.id                                          AS lead_id,
  l.email                                       AS lead_email,
  l.company_name,
  l.interest_status,
  e.id                                          AS email_id,
  e.campaign_id,
  e.thread_id,
  e.ue_type,
  e.subject,
  e.timestamp_email,
  ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY e.timestamp_email)         AS event_n,
  EXTRACT(EPOCH FROM (e.timestamp_email - LAG(e.timestamp_email)
                       OVER (PARTITION BY l.id ORDER BY e.timestamp_email)))
                                          / 86400.0                        AS days_since_prev
FROM raw_leads l
LEFT JOIN raw_emails e ON e.lead_id = l.id;

-- Denormalised campaign summary
CREATE OR REPLACE VIEW v_campaign_summary AS
SELECT
  c.id                                                                     AS campaign_id,
  c.name,
  c.status,
  c.timestamp_created,
  c.timestamp_updated,
  c.daily_limit,
  jsonb_array_length(COALESCE(c.sequences, '[]'::jsonb))                   AS sequence_count,
  (SELECT COUNT(*) FROM raw_campaign_steps s WHERE s.campaign_id = c.id)   AS total_step_variants,
  (SELECT COUNT(*) FROM raw_leads l        WHERE l.campaign_id  = c.id)    AS lead_count,
  o.emails_sent_count                                                      AS sent_lifetime,
  o.open_count_unique                                                      AS opens_unique_lifetime,
  o.reply_count                                                            AS replies_lifetime,
  o.bounced_count                                                          AS bounced_lifetime,
  CASE WHEN COALESCE(o.emails_sent_count, 0) > 0
       THEN ROUND(100.0 * o.open_count_unique / o.emails_sent_count, 2) END AS open_rate_pct,
  CASE WHEN COALESCE(o.emails_sent_count, 0) > 0
       THEN ROUND(100.0 * o.reply_count       / o.emails_sent_count, 2) END AS reply_rate_pct
FROM raw_campaigns c
LEFT JOIN raw_campaign_analytics_overview_snap o
       ON o.campaign_id = c.id
      AND o.snapshot_id = (SELECT id FROM v_latest_snapshot);
