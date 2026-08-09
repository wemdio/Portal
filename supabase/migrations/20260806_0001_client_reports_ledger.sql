-- Durable client reporting facts.
--
-- These tables deliberately keep provider-independent snapshots. Campaign contacts
-- can therefore be reported and exported after completed contacts are removed from
-- the sending provider. Historical facts are append-only; export jobs are mutable
-- because the worker advances them through an asynchronous lifecycle.

CREATE TABLE IF NOT EXISTS public.client_pipeline_domain_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id),
  source_kind text NOT NULL CHECK (btrim(source_kind) <> ''),
  source_run_id text,
  source_job_id text,
  source_row_id text,
  domain text NOT NULL CHECK (btrim(domain) <> ''),
  company_name text,
  score numeric,
  rating text,
  spf text,
  score_origin text CHECK (score_origin IS NULL OR score_origin IN ('api', 'cache', 'legacy')),
  score_code text NOT NULL
    CHECK (score_code IN ('A', 'B', 'C', 'rejected', 'error')),
  scored_at timestamptz NOT NULL,
  email_found_count integer NOT NULL DEFAULT 0
    CHECK (email_found_count >= 0),
  email_validated_count integer NOT NULL DEFAULT 0
    CHECK (
      email_validated_count >= 0
      AND email_validated_count <= email_found_count
    ),
  routed_campaign_id text,
  routed_campaign_name_snapshot text,
  routed_at timestamptz,
  legacy_inferred boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (routed_at IS NULL OR routed_campaign_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.client_campaign_contact_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id),
  append_batch_id uuid NOT NULL,
  batch_index integer NOT NULL CHECK (batch_index >= 0),
  domain_snapshot_id uuid
    REFERENCES public.client_pipeline_domain_snapshots(id),
  domain text CHECK (domain IS NULL OR btrim(domain) <> ''),
  company_name text,
  email text NOT NULL CHECK (btrim(email) <> ''),
  source_kind text NOT NULL CHECK (btrim(source_kind) <> ''),
  source_run_id text,
  source_job_id text,
  source_row_id text,
  score numeric,
  score_code text NOT NULL
    CHECK (score_code IN ('A', 'B', 'C', 'rejected', 'error')),
  campaign_id text NOT NULL CHECK (btrim(campaign_id) <> ''),
  campaign_name_snapshot text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  append_status text NOT NULL DEFAULT 'submitted'
    CHECK (append_status IN ('submitted', 'accepted', 'skipped', 'failed')),
  skip_reason text,
  external_contact_id text,
  legacy_inferred boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One immutable row per bulk append result. Some provider responses expose exact
-- accepted/skipped totals without exposing the identity of every accepted contact;
-- this table preserves those confirmed aggregates separately from inferred events.
CREATE TABLE IF NOT EXISTS public.client_campaign_append_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id),
  campaign_id text NOT NULL CHECK (btrim(campaign_id) <> ''),
  campaign_name_snapshot text,
  score_code text
    CHECK (score_code IN ('A', 'B', 'C', 'rejected', 'error')),
  source_kind text NOT NULL CHECK (btrim(source_kind) <> ''),
  source_run_id text,
  source_job_id text,
  requested_count integer NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  blocked_count integer NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  tariff_skipped_count integer NOT NULL DEFAULT 0
    CHECK (tariff_skipped_count >= 0),
  identity_complete boolean NOT NULL DEFAULT false,
  accepted_identities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(accepted_identities) = 'array'),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_count <= requested_count),
  CHECK (skipped_count <= requested_count),
  CHECK (
    NOT identity_complete
    OR jsonb_array_length(accepted_identities) = accepted_count
  )
);

DO $$
DECLARE
  existing_constraint record;
  source_column_attnum smallint;
  target_column_attnum smallint;
BEGIN
  SELECT attribute.attnum::smallint
    INTO source_column_attnum
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.client_campaign_contact_ledger'::regclass
     AND attribute.attname = 'append_batch_id'
     AND NOT attribute.attisdropped;

  SELECT attribute.attnum::smallint
    INTO target_column_attnum
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.client_campaign_append_batches'::regclass
     AND attribute.attname = 'id'
     AND NOT attribute.attisdropped;

  IF source_column_attnum IS NULL OR target_column_attnum IS NULL THEN
    RAISE EXCEPTION
      'required columns for client_campaign_contact_ledger_append_batch_id_fkey are missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    c.contype,
    c.confrelid,
    c.conkey,
    c.confkey,
    c.confupdtype,
    c.confdeltype,
    c.confmatchtype,
    c.condeferrable,
    c.condeferred,
    c.convalidated
    INTO existing_constraint
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.client_campaign_contact_ledger'::regclass
     AND c.conname = 'client_campaign_contact_ledger_append_batch_id_fkey';

  IF NOT FOUND THEN
    ALTER TABLE public.client_campaign_contact_ledger
      ADD CONSTRAINT client_campaign_contact_ledger_append_batch_id_fkey
      FOREIGN KEY (append_batch_id)
      REFERENCES public.client_campaign_append_batches(id);
  ELSIF existing_constraint.contype <> 'f'
      OR existing_constraint.confrelid
        <> 'public.client_campaign_append_batches'::regclass
      OR existing_constraint.conkey <> ARRAY[source_column_attnum]
      OR existing_constraint.confkey <> ARRAY[target_column_attnum]
      OR existing_constraint.confupdtype <> 'a'
      OR existing_constraint.confdeltype <> 'a'
      OR existing_constraint.confmatchtype <> 's'
      OR existing_constraint.condeferrable
      OR existing_constraint.condeferred
      OR NOT existing_constraint.convalidated THEN
    RAISE EXCEPTION
      'existing constraint client_campaign_contact_ledger_append_batch_id_fkey does not match the required foreign key'
      USING ERRCODE = '55000';
  END IF;
END
$$;

COMMENT ON COLUMN public.client_campaign_append_batches.identity_complete IS
  'True when accepted_identities contains every accepted contact. False preserves an exact accepted aggregate without inventing partial identities.';

CREATE TABLE IF NOT EXISTS public.client_report_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('rejected', 'working', 'submitted')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(filters) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  storage_key text,
  checksum_sha256 text
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_client_pipeline_domain_snapshots_client_scored
  ON public.client_pipeline_domain_snapshots (client_user_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_pipeline_domain_snapshots_client_code_scored
  ON public.client_pipeline_domain_snapshots (client_user_id, score_code, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_pipeline_domain_snapshots_client_job_code
  ON public.client_pipeline_domain_snapshots (client_user_id, source_job_id, score_code)
  WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_pipeline_domain_snapshots_client_run_code
  ON public.client_pipeline_domain_snapshots (client_user_id, source_run_id, score_code)
  WHERE source_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_pipeline_domain_snapshots_client_routed_campaign
  ON public.client_pipeline_domain_snapshots (client_user_id, routed_campaign_id, routed_at DESC)
  WHERE routed_campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_client_submitted
  ON public.client_campaign_contact_ledger (client_user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_client_campaign_submitted
  ON public.client_campaign_contact_ledger (client_user_id, campaign_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_client_code_submitted
  ON public.client_campaign_contact_ledger (client_user_id, score_code, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_client_job_status
  ON public.client_campaign_contact_ledger (client_user_id, source_job_id, append_status)
  WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_client_email
  ON public.client_campaign_contact_ledger (client_user_id, lower(email), submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_campaign_contact_ledger_batch_index_status
  ON public.client_campaign_contact_ledger (append_batch_id, batch_index, append_status);

CREATE INDEX IF NOT EXISTS idx_client_campaign_append_batches_client_finished
  ON public.client_campaign_append_batches (client_user_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_append_batches_campaign_finished
  ON public.client_campaign_append_batches (campaign_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_append_batches_client_code_finished
  ON public.client_campaign_append_batches (client_user_id, score_code, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_campaign_append_batches_client_run
  ON public.client_campaign_append_batches (client_user_id, source_run_id)
  WHERE source_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_report_export_jobs_client_created
  ON public.client_report_export_jobs (client_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_report_export_jobs_client_kind_created
  ON public.client_report_export_jobs (client_user_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_report_export_jobs_one_active_per_kind
  ON public.client_report_export_jobs (client_user_id, kind)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_client_report_export_jobs_queue
  ON public.client_report_export_jobs (status, created_at)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_client_report_export_jobs_expires
  ON public.client_report_export_jobs (expires_at)
  WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_client_report_export_jobs_updated_at
  ON public.client_report_export_jobs;
CREATE TRIGGER trg_client_report_export_jobs_updated_at
  BEFORE UPDATE ON public.client_report_export_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.prevent_client_report_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'client report history is append-only'
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS prevent_client_pipeline_domain_snapshots_mutation
  ON public.client_pipeline_domain_snapshots;
CREATE TRIGGER prevent_client_pipeline_domain_snapshots_mutation
  BEFORE UPDATE OR DELETE ON public.client_pipeline_domain_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_client_report_history_mutation();
DROP TRIGGER IF EXISTS prevent_client_pipeline_domain_snapshots_truncate
  ON public.client_pipeline_domain_snapshots;
CREATE TRIGGER prevent_client_pipeline_domain_snapshots_truncate
  BEFORE TRUNCATE ON public.client_pipeline_domain_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_client_report_history_mutation();

DROP TRIGGER IF EXISTS prevent_client_campaign_contact_ledger_mutation
  ON public.client_campaign_contact_ledger;
CREATE TRIGGER prevent_client_campaign_contact_ledger_mutation
  BEFORE UPDATE OR DELETE ON public.client_campaign_contact_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_client_report_history_mutation();
DROP TRIGGER IF EXISTS prevent_client_campaign_contact_ledger_truncate
  ON public.client_campaign_contact_ledger;
CREATE TRIGGER prevent_client_campaign_contact_ledger_truncate
  BEFORE TRUNCATE ON public.client_campaign_contact_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_client_report_history_mutation();

CREATE OR REPLACE FUNCTION public.guard_client_campaign_append_batch_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  submitted_count bigint;
  submitted_distinct_index_count bigint;
  submitted_min_index integer;
  submitted_max_index integer;
  accepted_identity_count bigint;
  accepted_distinct_index_count bigint;
BEGIN
  IF NOT (
    OLD.status = 'submitted'
    AND NEW.status IN ('completed', 'failed')
    AND ROW(
      NEW.id,
      NEW.client_user_id,
      NEW.campaign_id,
      NEW.campaign_name_snapshot,
      NEW.score_code,
      NEW.source_kind,
      NEW.source_run_id,
      NEW.source_job_id,
      NEW.requested_count,
      NEW.blocked_count,
      NEW.tariff_skipped_count,
      NEW.started_at,
      NEW.metadata,
      NEW.created_at
    ) IS NOT DISTINCT FROM ROW(
      OLD.id,
      OLD.client_user_id,
      OLD.campaign_id,
      OLD.campaign_name_snapshot,
      OLD.score_code,
      OLD.source_kind,
      OLD.source_run_id,
      OLD.source_job_id,
      OLD.requested_count,
      OLD.blocked_count,
      OLD.tariff_skipped_count,
      OLD.started_at,
      OLD.metadata,
      OLD.created_at
    )
    AND NEW.finished_at IS NOT NULL
    AND (
      (
        NEW.status = 'completed'
        AND NEW.accepted_count + NEW.skipped_count = NEW.requested_count
        AND NEW.error_message IS NULL
      )
      OR (
        NEW.status = 'failed'
        AND NEW.accepted_count = 0
        AND NEW.skipped_count = 0
        AND NEW.identity_complete
        AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'client append batch allows only one submitted-to-terminal transition'
      USING ERRCODE = '55000';
  END IF;

  -- A failed provider call may legitimately have no contact ledger rows. A
  -- completed call, however, must describe exactly the immutable request that
  -- was written before the external side effect.
  IF NEW.status = 'completed' THEN
    SELECT
      count(*),
      count(DISTINCT batch_index),
      min(batch_index),
      max(batch_index)
    INTO
      submitted_count,
      submitted_distinct_index_count,
      submitted_min_index,
      submitted_max_index
    FROM public.client_campaign_contact_ledger
    WHERE append_batch_id = NEW.id
      AND append_status = 'submitted';

    IF submitted_count <> NEW.requested_count
       OR submitted_distinct_index_count <> NEW.requested_count
       OR (
         NEW.requested_count > 0
         AND (
           submitted_min_index <> 0
           OR submitted_max_index <> NEW.requested_count - 1
         )
       )
    THEN
      RAISE EXCEPTION 'completed append batch must have one submitted row for every requested index'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.accepted_identities) AS accepted(identity)
      WHERE jsonb_typeof(identity) <> 'object'
    ) THEN
      RAISE EXCEPTION 'accepted identity must be a JSON object'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.accepted_identities) AS accepted(identity)
      WHERE jsonb_typeof(identity->'index') IS NULL
         OR jsonb_typeof(identity->'index') <> 'number'
         OR (identity->>'index') !~ '^(0|[1-9][0-9]*)$'
    ) THEN
      RAISE EXCEPTION 'accepted identity index must be a nonnegative integer'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.accepted_identities) AS accepted(identity)
      WHERE (identity->>'index')::numeric >= NEW.requested_count
    ) THEN
      RAISE EXCEPTION 'accepted identity index is outside the requested range'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      count(*),
      count(DISTINCT (identity->>'index')::numeric)
    INTO
      accepted_identity_count,
      accepted_distinct_index_count
    FROM jsonb_array_elements(NEW.accepted_identities) AS accepted(identity);

    IF accepted_distinct_index_count <> accepted_identity_count THEN
      RAISE EXCEPTION 'accepted identity indexes must be unique'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.identity_complete
       AND accepted_identity_count <> NEW.accepted_count
    THEN
      RAISE EXCEPTION 'complete accepted identities must match accepted_count'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.accepted_identities) AS accepted(identity)
      LEFT JOIN public.client_campaign_contact_ledger AS source
        ON source.append_batch_id = NEW.id
       AND source.append_status = 'submitted'
       AND source.batch_index::numeric = (identity->>'index')::numeric
      WHERE jsonb_typeof(identity->'email') IS NULL
         OR jsonb_typeof(identity->'email') <> 'string'
         OR NULLIF(btrim(identity->>'email'), '') IS NULL
         OR source.id IS NULL
         OR lower(btrim(identity->>'email')) <> lower(btrim(source.email))
    ) THEN
      RAISE EXCEPTION 'accepted identity email must match the submitted contact at its index'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_client_campaign_terminal_events()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT NEW.identity_complete THEN
    RETURN NEW;
  END IF;

  WITH accepted AS (
    SELECT
      (identity->>'index')::integer AS batch_index,
      NULLIF(identity->>'externalContactId', '') AS external_contact_id
    FROM jsonb_array_elements(NEW.accepted_identities) AS identity
  )
  INSERT INTO public.client_campaign_contact_ledger (
    client_user_id,
    append_batch_id,
    batch_index,
    domain_snapshot_id,
    domain,
    company_name,
    email,
    source_kind,
    source_run_id,
    source_job_id,
    source_row_id,
    score,
    score_code,
    campaign_id,
    campaign_name_snapshot,
    submitted_at,
    append_status,
    skip_reason,
    external_contact_id,
    legacy_inferred,
    metadata,
    created_at
  )
  SELECT
    source.client_user_id,
    source.append_batch_id,
    source.batch_index,
    source.domain_snapshot_id,
    source.domain,
    source.company_name,
    source.email,
    source.source_kind,
    source.source_run_id,
    source.source_job_id,
    source.source_row_id,
    source.score,
    source.score_code,
    source.campaign_id,
    source.campaign_name_snapshot,
    NEW.finished_at,
    CASE
      WHEN NEW.status = 'failed' THEN 'failed'
      WHEN accepted.batch_index IS NOT NULL THEN 'accepted'
      WHEN accepted.batch_index IS NULL THEN 'skipped'
    END,
    CASE
      WHEN NEW.status = 'failed' THEN NEW.error_message
      WHEN accepted.batch_index IS NULL THEN 'external_batch_rejected'
      ELSE NULL
    END,
    accepted.external_contact_id,
    source.legacy_inferred,
    source.metadata || jsonb_build_object('terminal_event', true),
    NEW.finished_at
  FROM public.client_campaign_contact_ledger AS source
  LEFT JOIN accepted ON accepted.batch_index = source.batch_index
  WHERE source.append_batch_id = NEW.id
    AND source.append_status = 'submitted';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_client_campaign_append_batches_update
  ON public.client_campaign_append_batches;
CREATE TRIGGER guard_client_campaign_append_batches_update
  BEFORE UPDATE ON public.client_campaign_append_batches
  FOR EACH ROW EXECUTE FUNCTION public.guard_client_campaign_append_batch_transition();
DROP TRIGGER IF EXISTS append_client_campaign_terminal_events
  ON public.client_campaign_append_batches;
CREATE TRIGGER append_client_campaign_terminal_events
  AFTER UPDATE OF status ON public.client_campaign_append_batches
  FOR EACH ROW EXECUTE FUNCTION public.append_client_campaign_terminal_events();
DROP TRIGGER IF EXISTS prevent_client_campaign_append_batches_delete
  ON public.client_campaign_append_batches;
CREATE TRIGGER prevent_client_campaign_append_batches_delete
  BEFORE DELETE ON public.client_campaign_append_batches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_client_report_history_mutation();
DROP TRIGGER IF EXISTS prevent_client_campaign_append_batches_truncate
  ON public.client_campaign_append_batches;
CREATE TRIGGER prevent_client_campaign_append_batches_truncate
  BEFORE TRUNCATE ON public.client_campaign_append_batches
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_client_report_history_mutation();

ALTER TABLE public.client_pipeline_domain_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_campaign_contact_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_campaign_append_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_report_export_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_pipeline_domain_snapshots_own_select
  ON public.client_pipeline_domain_snapshots;
CREATE POLICY client_pipeline_domain_snapshots_own_select
  ON public.client_pipeline_domain_snapshots
  FOR SELECT TO authenticated
  USING (client_user_id = auth.uid());
DROP POLICY IF EXISTS client_pipeline_domain_snapshots_service_all
  ON public.client_pipeline_domain_snapshots;
CREATE POLICY client_pipeline_domain_snapshots_service_all
  ON public.client_pipeline_domain_snapshots
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS client_campaign_contact_ledger_own_select
  ON public.client_campaign_contact_ledger;
CREATE POLICY client_campaign_contact_ledger_own_select
  ON public.client_campaign_contact_ledger
  FOR SELECT TO authenticated
  USING (client_user_id = auth.uid());
DROP POLICY IF EXISTS client_campaign_contact_ledger_service_all
  ON public.client_campaign_contact_ledger;
CREATE POLICY client_campaign_contact_ledger_service_all
  ON public.client_campaign_contact_ledger
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS client_campaign_append_batches_own_select
  ON public.client_campaign_append_batches;
CREATE POLICY client_campaign_append_batches_own_select
  ON public.client_campaign_append_batches
  FOR SELECT TO authenticated
  USING (client_user_id = auth.uid());
DROP POLICY IF EXISTS client_campaign_append_batches_service_all
  ON public.client_campaign_append_batches;
CREATE POLICY client_campaign_append_batches_service_all
  ON public.client_campaign_append_batches
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS client_report_export_jobs_own_select
  ON public.client_report_export_jobs;
CREATE POLICY client_report_export_jobs_own_select
  ON public.client_report_export_jobs
  FOR SELECT TO authenticated
  USING (client_user_id = auth.uid());
DROP POLICY IF EXISTS client_report_export_jobs_service_all
  ON public.client_report_export_jobs;
CREATE POLICY client_report_export_jobs_service_all
  ON public.client_report_export_jobs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.client_pipeline_domain_snapshots FROM anon;
REVOKE ALL ON public.client_pipeline_domain_snapshots FROM authenticated;
REVOKE ALL ON public.client_campaign_contact_ledger FROM anon;
REVOKE ALL ON public.client_campaign_contact_ledger FROM authenticated;
REVOKE ALL ON public.client_campaign_append_batches FROM anon;
REVOKE ALL ON public.client_campaign_append_batches FROM authenticated;
REVOKE ALL ON public.client_report_export_jobs FROM anon;
REVOKE ALL ON public.client_report_export_jobs FROM authenticated;

GRANT SELECT ON public.client_pipeline_domain_snapshots TO authenticated;
GRANT SELECT ON public.client_campaign_contact_ledger TO authenticated;
GRANT SELECT ON public.client_campaign_append_batches TO authenticated;
GRANT SELECT ON public.client_report_export_jobs TO authenticated;

GRANT ALL ON public.client_pipeline_domain_snapshots TO service_role;
GRANT ALL ON public.client_campaign_contact_ledger TO service_role;
GRANT ALL ON public.client_campaign_append_batches TO service_role;
GRANT ALL ON public.client_report_export_jobs TO service_role;

REVOKE ALL ON FUNCTION public.prevent_client_report_history_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_client_campaign_append_batch_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_client_campaign_terminal_events() FROM PUBLIC;
