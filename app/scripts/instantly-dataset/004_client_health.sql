-- ============================================================================
-- 004: client health monitoring — dimensional model + daily snapshots
-- Per-client daily health questions (Tier-1 SQL). Source: user spec 2026-05.
--
-- ⚠️ SUPERSEDED BY 006 — everything this migration creates was dropped in
-- 006_drop_system_a.sql. We pivoted from a deterministic SQL calculator
-- ("System A") to an AI-agent-in-the-loop eval loop. The client→campaign map
-- is now queried LIVE from operational DBs (see wiki/concepts/client-health-questions.md).
-- This file is kept only for migration-history continuity; do NOT re-run it.
-- ============================================================================

-- ─── dimensions (synced daily from operational DBs) ────────────────────────

CREATE TABLE IF NOT EXISTS dim_projects (
  project_id    UUID PRIMARY KEY,
  client        TEXT,
  project_name  TEXT,
  status        TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE dim_projects IS
  'Mirror of main-postgres.projects (the Portal client projects). Synced daily.
   status values (RU): Завершен, Тестирование, В работе, Подготовка, На паузе.
   "Active" for health monitoring = В работе + Тестирование.';

CREATE TABLE IF NOT EXISTS dim_project_campaigns (
  project_id        UUID NOT NULL,
  campaign_id       TEXT NOT NULL,
  match_confidence  REAL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, campaign_id)
);
COMMENT ON TABLE dim_project_campaigns IS
  'Mirror of instantly DB.project_instantly_campaigns. Maps a Portal project to its
   Instantly campaign_id(s). JOIN raw_campaigns/raw_emails on campaign_id.';
CREATE INDEX IF NOT EXISTS dim_project_campaigns_campaign_idx ON dim_project_campaigns (campaign_id);

CREATE TABLE IF NOT EXISTS dim_lead_qualifications (
  id            UUID PRIMARY KEY,
  campaign_id   TEXT,
  lead_email    TEXT,
  status        TEXT,                 -- 'lead' | 'objection' | 'not_lead' | 'needs_review' | 'error'
  created_at    TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE dim_lead_qualifications IS
  'Mirror of instantly DB.instantly_lead_qualifications — the AI qualifier output.
   status=''lead'' = a real qualified lead (the money metric). Synced daily.';
CREATE INDEX IF NOT EXISTS dim_lead_qual_campaign_idx ON dim_lead_qualifications (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dim_lead_qual_status_idx ON dim_lead_qualifications (status, created_at DESC);

-- ─── question catalog (the fixed set, versioned) ───────────────────────────

CREATE TABLE IF NOT EXISTS health_questions (
  question_id   TEXT PRIMARY KEY,
  ordinal       INT NOT NULL,
  title_ru      TEXT NOT NULL,
  detects       TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE health_questions IS
  'The fixed set of daily per-client health questions. DO NOT change the meaning of a
   question_id once data is being collected — comparability over time depends on it.
   To revise, add a new question_id and set the old one active=false.';

INSERT INTO health_questions(question_id, ordinal, title_ru, detects) VALUES
  ('volume',          1, 'Объём отправки 7д vs прошлые 7д',        'Заглохшие кампании, проблемы mailbox-ов'),
  ('open_rate',       2, 'Open rate 7д vs baseline',                'Падение deliverability, усталость от темы'),
  ('reply_rate',      3, 'Reply rate 7д vs baseline',               'Эффективность сообщения, качество базы'),
  ('qualified_leads', 4, 'Квалифицированные лиды 7д vs прошлые 7д', 'Бизнес-результат (деньги)'),
  ('mailbox_health',  5, 'Здоровье mailbox-ов',                     'Риск deliverability до просадки'),
  ('bounce_unsub',    6, 'Bounce + unsubscribe rate 7д vs baseline','Качество базы, спам-репутация домена'),
  ('subjects',        7, 'Лучшая/худшая тема недели',               'Что работает / что убить')
ON CONFLICT (question_id) DO UPDATE SET
  ordinal = EXCLUDED.ordinal, title_ru = EXCLUDED.title_ru, detects = EXCLUDED.detects;

-- ─── daily snapshots (the accumulating corpus) ─────────────────────────────

CREATE TABLE IF NOT EXISTS client_health_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  snapshot_date  DATE NOT NULL,
  project_id     UUID NOT NULL,
  client         TEXT,
  project_name   TEXT,
  question_id    TEXT NOT NULL REFERENCES health_questions(question_id),
  structured     JSONB,            -- the numbers (for charts + anomaly detection)
  narrative      TEXT,             -- 1-2 sentence human-readable
  severity       TEXT NOT NULL DEFAULT 'ok',   -- ok | warning | critical | no_data
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, project_id, question_id)
);
COMMENT ON TABLE client_health_snapshots IS
  'One row per (day × client × question). The time-series corpus that future product
   features (health dashboard, proactive insights, anomaly alerts) will be built on.
   Tier-1 (SQL) fills structured + severity daily; Tier-2 (weekly LLM) may enrich narrative.';
COMMENT ON COLUMN client_health_snapshots.structured IS
  'Numeric answer as JSONB, e.g. {"last_7d":1234,"prior_7d":1500,"delta_pct":-17.7,"direction":"down"}.';
COMMENT ON COLUMN client_health_snapshots.severity IS
  'ok | warning | critical | no_data. Drives anomaly views + future alerting.';

CREATE INDEX IF NOT EXISTS chs_date_idx ON client_health_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS chs_project_idx ON client_health_snapshots (project_id, question_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS chs_severity_idx ON client_health_snapshots (severity, snapshot_date DESC) WHERE severity IN ('warning','critical');

-- ─── views ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_client_health_latest AS
SELECT DISTINCT ON (project_id, question_id)
  snapshot_date, project_id, client, project_name, question_id, structured, narrative, severity
FROM client_health_snapshots
ORDER BY project_id, question_id, snapshot_date DESC;
COMMENT ON VIEW v_client_health_latest IS 'Most recent snapshot per (client × question).';

CREATE OR REPLACE VIEW v_client_health_attention AS
SELECT snapshot_date, client, project_name, question_id, severity, narrative, structured
FROM v_client_health_latest
WHERE severity IN ('warning','critical')
ORDER BY CASE severity WHEN 'critical' THEN 1 ELSE 2 END, client;
COMMENT ON VIEW v_client_health_attention IS
  'Clients needing attention right now (latest snapshot is warning/critical). Future: CSM dashboard + TG alerts.';
