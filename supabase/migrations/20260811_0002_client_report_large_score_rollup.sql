-- Additive, versioned rollup for the legacy large-file branch of the client
-- pipeline report. The existing production RPC remains available unchanged;
-- this migration exposes a separate shadow RPC for parity/performance checks.

CREATE TABLE IF NOT EXISTS public.client_report_large_score_rollup_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'failed')),
  source_watermark timestamptz NOT NULL,
  source_rows bigint NOT NULL CHECK (source_rows >= 0),
  source_job_days bigint NOT NULL CHECK (source_job_days >= 0),
  source_fingerprint text NOT NULL
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  error_message text,
  UNIQUE (id),
  PRIMARY KEY (id, client_user_id)
);

CREATE TABLE IF NOT EXISTS public.client_report_large_score_rollup_buckets (
  rollup_run_id uuid NOT NULL,
  client_user_id uuid NOT NULL,
  source_job_id uuid NOT NULL,
  cohort_day date NOT NULL,
  score_code text NOT NULL
    CHECK (score_code IN ('A', 'B', 'C', 'rejected', 'error')),
  domain_count bigint NOT NULL CHECK (domain_count >= 0),
  max_cohort_at timestamptz,
  PRIMARY KEY (rollup_run_id, client_user_id, source_job_id, cohort_day, score_code),
  FOREIGN KEY (rollup_run_id, client_user_id)
    REFERENCES public.client_report_large_score_rollup_runs (id, client_user_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.client_report_large_score_rollup_checkpoints (
  rollup_run_id uuid NOT NULL,
  client_user_id uuid NOT NULL,
  source_job_id uuid NOT NULL,
  cohort_day date NOT NULL,
  source_count bigint NOT NULL CHECK (source_count >= 0),
  bucket_count bigint NOT NULL CHECK (bucket_count >= 0),
  source_max_scored_at timestamptz,
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rollup_run_id, client_user_id, source_job_id, cohort_day),
  FOREIGN KEY (rollup_run_id, client_user_id)
    REFERENCES public.client_report_large_score_rollup_runs (id, client_user_id)
    ON DELETE CASCADE,
  CHECK (source_count = bucket_count)
);

CREATE INDEX IF NOT EXISTS idx_client_report_large_rollup_buckets_period
  ON public.client_report_large_score_rollup_buckets (
    client_user_id,
    rollup_run_id,
    cohort_day,
    score_code
  );

ALTER TABLE public.client_report_large_score_rollup_runs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_report_large_score_rollup_buckets
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_report_large_score_rollup_checkpoints
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.client_report_large_score_rollup_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_runs FROM anon;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_runs FROM authenticated;
GRANT ALL ON TABLE public.client_report_large_score_rollup_runs TO service_role;

REVOKE ALL ON TABLE public.client_report_large_score_rollup_buckets FROM PUBLIC;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_buckets FROM anon;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_buckets FROM authenticated;
GRANT ALL ON TABLE public.client_report_large_score_rollup_buckets TO service_role;

REVOKE ALL ON TABLE public.client_report_large_score_rollup_checkpoints FROM PUBLIC;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_checkpoints FROM anon;
REVOKE ALL ON TABLE public.client_report_large_score_rollup_checkpoints FROM authenticated;
GRANT ALL ON TABLE public.client_report_large_score_rollup_checkpoints TO service_role;

-- A ready generation is immutable and can be selected only after every
-- expected job/day checkpoint and every expected source row are present.
CREATE OR REPLACE FUNCTION public.guard_client_report_large_score_rollup_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_checkpoint_count bigint;
  v_checkpoint_rows bigint;
  v_bucket_rows bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'large-score rollup run is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'ready' THEN
    SELECT
      count(*)::bigint,
      coalesce(sum(checkpoint.source_count), 0)::bigint
    INTO v_checkpoint_count, v_checkpoint_rows
    FROM public.client_report_large_score_rollup_checkpoints AS checkpoint
    WHERE checkpoint.rollup_run_id = NEW.id
      AND checkpoint.client_user_id = NEW.client_user_id;

    SELECT coalesce(sum(bucket.domain_count), 0)::bigint
    INTO v_bucket_rows
    FROM public.client_report_large_score_rollup_buckets AS bucket
    WHERE bucket.rollup_run_id = NEW.id
      AND bucket.client_user_id = NEW.client_user_id;

    IF v_checkpoint_count <> NEW.source_job_days
       OR v_checkpoint_rows <> NEW.source_rows
       OR v_bucket_rows <> NEW.source_rows
    THEN
      RAISE EXCEPTION 'large-score rollup completeness check failed'
        USING ERRCODE = '23514';
    END IF;

    NEW.ready_at := coalesce(NEW.ready_at, now());
    NEW.error_message := NULL;
    NEW.validation := coalesce(NEW.validation, '{}'::jsonb) || jsonb_build_object(
      'checkpoint_count', v_checkpoint_count,
      'source_rows', v_checkpoint_rows,
      'bucket_rows', v_bucket_rows,
      'validated_at', now()
    );
  ELSIF NEW.status = 'failed' THEN
    NEW.ready_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_client_report_large_score_rollup_run
  ON public.client_report_large_score_rollup_runs;
CREATE TRIGGER trg_guard_client_report_large_score_rollup_run
BEFORE INSERT OR UPDATE ON public.client_report_large_score_rollup_runs
FOR EACH ROW
EXECUTE FUNCTION public.guard_client_report_large_score_rollup_run();

REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_run()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_run()
  FROM anon;
REVOKE ALL ON FUNCTION public.guard_client_report_large_score_rollup_run()
  FROM authenticated;

-- Rebuild one absolute bucket partition. A function call is one transaction:
-- a failed invariant leaves neither partial buckets nor a checkpoint behind.
CREATE OR REPLACE FUNCTION public.rebuild_client_report_large_score_rollup_day(
  p_rollup_run_id uuid,
  p_job_id uuid,
  p_cohort_day date
)
RETURNS TABLE (
  source_count bigint,
  bucket_count bigint,
  max_cohort_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_client_user_id uuid;
  v_source_watermark timestamptz;
  v_day_from timestamptz;
  v_day_to timestamptz;
  v_source_count bigint := 0;
  v_bucket_count bigint := 0;
  v_max_cohort_at timestamptz;
BEGIN
  IF p_rollup_run_id IS NULL OR p_job_id IS NULL OR p_cohort_day IS NULL THEN
    RAISE EXCEPTION 'rollup run, job and cohort day are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.client_user_id, run.source_watermark
  INTO v_client_user_id, v_source_watermark
  FROM public.client_report_large_score_rollup_runs AS run
  JOIN public.large_score_jobs AS job
    ON job.id = p_job_id
   AND run.client_user_id = job.client_user_id
  WHERE run.id = p_rollup_run_id
    AND run.status = 'building'
    AND job.status = 'completed'
  FOR UPDATE OF run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollup run or completed job not found'
      USING ERRCODE = '22023';
  END IF;

  v_day_from := p_cohort_day::timestamp AT TIME ZONE 'Europe/Moscow';
  v_day_to := (p_cohort_day + 1)::timestamp AT TIME ZONE 'Europe/Moscow';

  DELETE FROM public.client_report_large_score_rollup_buckets
  WHERE rollup_run_id = p_rollup_run_id
    AND client_user_id = v_client_user_id
    AND source_job_id = p_job_id
    AND cohort_day = p_cohort_day;

  WITH eligible AS MATERIALIZED (
    SELECT
      d.scored_at,
      CASE
        WHEN d.status = 'error' THEN 'error'
        ELSE public.client_report_score_code(cache.score)
      END AS score_code
    FROM public.large_score_domains AS d
    JOIN public.client_report_large_score_rollup_runs AS run
      ON run.id = p_rollup_run_id
     AND run.client_user_id = v_client_user_id
    LEFT JOIN public.mailganer_domain_scores AS cache
      ON cache.domain = lower(btrim(d.domain))
    WHERE d.job_id = p_job_id
      AND d.status IN ('scored', 'error')
      AND nullif(btrim(d.domain), '') IS NOT NULL
      AND d.scored_at >= v_day_from
      AND d.scored_at < v_day_to
      AND d.scored_at <= v_source_watermark
      AND NOT EXISTS (
        SELECT 1
        FROM public.client_pipeline_domain_snapshots AS exact_match
        WHERE exact_match.client_user_id = run.client_user_id
          AND NOT exact_match.legacy_inferred
          AND exact_match.source_kind = 'large_score_file'
          AND exact_match.source_job_id = p_job_id::text
          AND exact_match.source_row_id = d.id::text
      )
  ),
  source_stats AS (
    SELECT
      count(*)::bigint AS source_count,
      max(eligible.scored_at) AS max_cohort_at
    FROM eligible
  ),
  grouped AS (
    SELECT
      eligible.score_code,
      count(*)::bigint AS domain_count,
      max(eligible.scored_at) AS max_cohort_at
    FROM eligible
    GROUP BY eligible.score_code
  ),
  inserted AS (
    INSERT INTO public.client_report_large_score_rollup_buckets (
      rollup_run_id,
      client_user_id,
      source_job_id,
      cohort_day,
      score_code,
      domain_count,
      max_cohort_at
    )
    SELECT
      p_rollup_run_id,
      v_client_user_id,
      p_job_id,
      p_cohort_day,
      grouped.score_code,
      grouped.domain_count,
      grouped.max_cohort_at
    FROM grouped
    RETURNING domain_count
  )
  SELECT
    source_stats.source_count,
    coalesce(sum(inserted.domain_count), 0)::bigint,
    source_stats.max_cohort_at
  INTO v_source_count, v_bucket_count, v_max_cohort_at
  FROM source_stats
  LEFT JOIN inserted ON true
  GROUP BY source_stats.source_count, source_stats.max_cohort_at;

  IF v_source_count <> v_bucket_count THEN
    RAISE EXCEPTION 'large-score rollup count invariant failed'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.client_report_large_score_rollup_checkpoints (
    rollup_run_id,
    client_user_id,
    source_job_id,
    cohort_day,
    source_count,
    bucket_count,
    source_max_scored_at,
    rebuilt_at
  )
  VALUES (
    p_rollup_run_id,
    v_client_user_id,
    p_job_id,
    p_cohort_day,
    v_source_count,
    v_bucket_count,
    v_max_cohort_at,
    now()
  )
  ON CONFLICT (rollup_run_id, client_user_id, source_job_id, cohort_day) DO UPDATE
  SET source_count = EXCLUDED.source_count,
      bucket_count = EXCLUDED.bucket_count,
      source_max_scored_at = EXCLUDED.source_max_scored_at,
      rebuilt_at = EXCLUDED.rebuilt_at;

  RETURN QUERY
  SELECT v_source_count, v_bucket_count, v_max_cohort_at;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_client_report_large_score_rollup_day(uuid, uuid, date) TO service_role;

-- Shadow report: identical public payload and filters, but the legacy
-- large-file source is read only from the selected ready generation.
CREATE OR REPLACE FUNCTION public.client_report_pipeline_summary_shadow(
  p_client_user_id uuid,
  p_rollup_run_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_allowed_campaign_ids text[],
  p_score_code text DEFAULT NULL,
  p_campaign_id text DEFAULT NULL
)
RETURNS TABLE (
  scored_companies bigint,
  working_score_companies bigint,
  email_found_companies bigint,
  validated_emails bigint,
  submitted_contacts bigint,
  confirmed_contacts bigint,
  legacy_submitted_contacts bigint,
  event_confirmed_contacts bigint,
  event_legacy_submitted_contacts bigint,
  legacy_scored_companies bigint,
  unattributed_confirmed_contacts bigint,
  pipeline_at timestamptz,
  by_campaign jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_client_user_id IS NULL THEN
    RAISE EXCEPTION 'client id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_rollup_run_id IS NULL THEN
    RAISE EXCEPTION 'rollup run id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'invalid report period'
      USING ERRCODE = '22023';
  END IF;

  IF p_to - p_from > interval '367 days' THEN
    RAISE EXCEPTION 'report period is too large'
      USING ERRCODE = '22023';
  END IF;

  -- Daily buckets are defined by the same Moscow-midnight boundaries used by
  -- the reports API. Rejecting partial days prevents boundary over-counting.
  IF p_from <> ((p_from AT TIME ZONE 'Europe/Moscow')::date::timestamp
                AT TIME ZONE 'Europe/Moscow')
     OR p_to <> ((p_to AT TIME ZONE 'Europe/Moscow')::date::timestamp
                 AT TIME ZONE 'Europe/Moscow')
  THEN
    RAISE EXCEPTION 'rollup report period must use Moscow day boundaries'
      USING ERRCODE = '22023';
  END IF;

  IF p_score_code IS NOT NULL THEN
    p_score_code := upper(btrim(p_score_code));
    IF p_score_code NOT IN ('A', 'B', 'C') THEN
      RAISE EXCEPTION 'invalid score code'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_allowed_campaign_ids IS NULL
     OR cardinality(p_allowed_campaign_ids) = 0
  THEN
    RAISE EXCEPTION 'allowed campaign ids are required'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_allowed_campaign_ids) AS allowed(allowed_campaign_id)
    WHERE nullif(btrim(allowed_campaign_id), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'allowed campaign ids cannot contain blanks'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT btrim(allowed_campaign_id)
                   ORDER BY btrim(allowed_campaign_id))
  INTO p_allowed_campaign_ids
  FROM unnest(p_allowed_campaign_ids) AS allowed(allowed_campaign_id);

  IF p_campaign_id IS NOT NULL
     AND nullif(btrim(p_campaign_id), '') IS NULL
  THEN
    RAISE EXCEPTION 'invalid campaign id'
      USING ERRCODE = '22023';
  END IF;

  p_campaign_id := nullif(btrim(p_campaign_id), '');

  IF p_campaign_id IS NOT NULL
     AND NOT (p_campaign_id = ANY (p_allowed_campaign_ids))
  THEN
    RAISE EXCEPTION 'campaign id is outside the allowed campaign set'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.client_report_large_score_rollup_runs AS run
    WHERE run.id = p_rollup_run_id
      AND run.client_user_id = p_client_user_id
      AND run.status = 'ready'
  ) THEN
    RAISE EXCEPTION 'ready rollup run not found for client'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH exact_domain_facts AS (
    SELECT
      lower(btrim(s.domain)) AS domain,
      s.score_code,
      s.email_found_count,
      s.email_validated_count,
      s.routed_campaign_id AS campaign_id,
      s.routed_campaign_name_snapshot AS campaign_name,
      s.scored_at AS cohort_at,
      s.routed_at AS legacy_event_at,
      s.source_kind,
      s.source_run_id,
      s.source_job_id,
      s.source_row_id,
      0::integer AS legacy_submitted_count
    FROM public.client_pipeline_domain_snapshots AS s
    WHERE s.client_user_id = p_client_user_id
      AND NOT s.legacy_inferred
      AND (
        (s.scored_at >= p_from AND s.scored_at < p_to)
        OR (s.routed_at >= p_from AND s.routed_at < p_to)
      )
  ),
  legacy_snapshot_domain_facts AS (
    SELECT
      lower(btrim(s.domain)) AS domain,
      s.score_code,
      s.email_found_count,
      s.email_validated_count,
      s.routed_campaign_id AS campaign_id,
      s.routed_campaign_name_snapshot AS campaign_name,
      s.scored_at AS cohort_at,
      CASE
        WHEN s.routed_campaign_id IS NOT NULL
          THEN coalesce(s.routed_at, s.scored_at)
        ELSE NULL
      END AS legacy_event_at,
      'legacy_snapshot'::text AS source_kind,
      s.source_run_id,
      s.source_job_id,
      s.source_row_id,
      CASE
        WHEN s.routed_campaign_id IS NOT NULL
          THEN s.email_validated_count
        ELSE 0
      END AS legacy_submitted_count
    FROM public.client_pipeline_domain_snapshots AS s
    WHERE s.client_user_id = p_client_user_id
      AND s.legacy_inferred
      AND (
        (s.scored_at >= p_from AND s.scored_at < p_to)
        OR (s.routed_at >= p_from AND s.routed_at < p_to)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM exact_domain_facts AS exact_match
        WHERE s.source_row_id IS NOT NULL
          AND exact_match.source_row_id = s.source_row_id
          AND exact_match.source_kind = s.source_kind
          AND exact_match.source_run_id IS NOT DISTINCT FROM s.source_run_id
          AND exact_match.source_job_id IS NOT DISTINCT FROM s.source_job_id
      )
  ),
  legacy_auto_domain_facts AS (
    SELECT
      lower(btrim(a.domain)) AS domain,
      public.client_report_score_code(a.endpoint_score) AS score_code,
      email_counts.found_count AS email_found_count,
      email_counts.validated_count AS email_validated_count,
      a.routed_campaign_id AS campaign_id,
      NULL::text AS campaign_name,
      coalesce(a.processed_at, a.first_seen_at) AS cohort_at,
      CASE
        WHEN a.status = 'routed'
          THEN coalesce(a.processed_at, a.first_seen_at)
        ELSE NULL
      END AS legacy_event_at,
      'legacy_auto'::text AS source_kind,
      NULL::text AS source_run_id,
      NULL::text AS source_job_id,
      a.hh_employer_id AS source_row_id,
      CASE
        WHEN a.status = 'routed' THEN email_counts.validated_count
        ELSE 0
      END AS legacy_submitted_count
    FROM public.client_auto_pipeline_seen_employers AS a
    CROSS JOIN LATERAL (
      SELECT
        count(*)::integer AS found_count,
        count(*) FILTER (WHERE normalized_email.is_ready)::integer
          AS validated_count
      FROM (
        SELECT
          lower(btrim(candidate.email)) AS email,
          bool_or(
            candidate.validation_status IN (
              'valid', 'role_address', 'free_provider', 'catch_all'
            )
          ) AS is_ready
        FROM (
          VALUES
            (
              coalesce(
                nullif(btrim(a.resolved_email), ''),
                nullif(btrim(a.email_found), '')
              ),
              a.email_validation_status
            ),
            (nullif(btrim(a.email2), ''), a.email2_validation_status)
        ) AS candidate(email, validation_status)
        WHERE nullif(btrim(candidate.email), '') IS NOT NULL
        GROUP BY lower(btrim(candidate.email))
      ) AS normalized_email
    ) AS email_counts
    WHERE a.client_user_id = p_client_user_id
      AND nullif(btrim(a.domain), '') IS NOT NULL
      AND coalesce(a.processed_at, a.first_seen_at) >= p_from
      AND coalesce(a.processed_at, a.first_seen_at) < p_to
      AND NOT EXISTS (
        SELECT 1
        FROM exact_domain_facts AS exact_match
        WHERE exact_match.source_kind LIKE 'auto_pipeline%'
          AND exact_match.source_row_id = a.hh_employer_id
      )
  ),
  legacy_manual_domain_facts AS (
    SELECT
      lower(btrim(m.domain)) AS domain,
      public.client_report_score_code(m.score) AS score_code,
      email_counts.found_count AS email_found_count,
      email_counts.validated_count AS email_validated_count,
      NULL::text AS campaign_id,
      NULL::text AS campaign_name,
      m.processed_at AS cohort_at,
      NULL::timestamptz AS legacy_event_at,
      'legacy_manual'::text AS source_kind,
      r.id::text AS source_run_id,
      NULL::text AS source_job_id,
      m.id::text AS source_row_id,
      0::integer AS legacy_submitted_count
    FROM public.client_manual_score_rows AS m
    JOIN public.client_manual_score_runs AS r
      ON r.id = m.run_id
     AND r.client_user_id = p_client_user_id
    CROSS JOIN LATERAL (
      SELECT
        count(*)::integer AS found_count,
        count(*) FILTER (WHERE normalized_email.is_ready)::integer
          AS validated_count
      FROM (
        SELECT
          lower(btrim(candidate.email)) AS email,
          bool_or(
            candidate.validation_status IN (
              'valid', 'role_address', 'free_provider', 'catch_all'
            )
          ) AS is_ready
        FROM (
          VALUES
            (nullif(btrim(m.email), ''), m.email_validation_status),
            (nullif(btrim(m.email2), ''), m.email2_validation_status)
        ) AS candidate(email, validation_status)
        WHERE nullif(btrim(candidate.email), '') IS NOT NULL
        GROUP BY lower(btrim(candidate.email))
      ) AS normalized_email
    ) AS email_counts
    WHERE nullif(btrim(m.domain), '') IS NOT NULL
      AND (m.bucket IS NOT NULL OR m.error_message IS NOT NULL)
      AND m.processed_at >= p_from
      AND m.processed_at < p_to
      AND NOT EXISTS (
        SELECT 1
        FROM exact_domain_facts AS exact_match
        WHERE exact_match.source_kind = 'manual_scoring'
          AND exact_match.source_run_id = r.id::text
          AND exact_match.source_row_id = m.id::text
      )
  ),
  all_domain_facts AS (
    SELECT * FROM exact_domain_facts
    UNION ALL
    SELECT * FROM legacy_snapshot_domain_facts
    UNION ALL
    SELECT * FROM legacy_auto_domain_facts
    UNION ALL
    SELECT * FROM legacy_manual_domain_facts
  ),
  cohort_domain_facts AS (
    SELECT facts.*
    FROM all_domain_facts AS facts
    WHERE facts.cohort_at >= p_from
      AND facts.cohort_at < p_to
      AND (p_score_code IS NULL OR facts.score_code = p_score_code)
  ),
  large_rollup_facts AS (
    SELECT
      bucket.score_code,
      bucket.domain_count,
      bucket.max_cohort_at
    FROM public.client_report_large_score_rollup_buckets AS bucket
    WHERE bucket.rollup_run_id = p_rollup_run_id
      AND bucket.client_user_id = p_client_user_id
      AND bucket.cohort_day >= (p_from AT TIME ZONE 'Europe/Moscow')::date
      AND bucket.cohort_day < (p_to AT TIME ZONE 'Europe/Moscow')::date
      AND (p_score_code IS NULL OR bucket.score_code = p_score_code)
  ),
  exact_contact_cohort AS (
    SELECT DISTINCT ON (contact.id)
      contact.id AS contact_id,
      contact.append_batch_id,
      contact.campaign_id,
      contact.campaign_name_snapshot AS campaign_name,
      contact.score_code,
      contact.append_status,
      contact.submitted_at
    FROM public.client_campaign_contact_ledger AS contact
    JOIN public.client_campaign_append_batches AS source_batch
      ON source_batch.id = contact.append_batch_id
     AND source_batch.status = 'completed'
    JOIN public.client_pipeline_domain_snapshots AS snapshot
      ON snapshot.client_user_id = contact.client_user_id
     AND NOT snapshot.legacy_inferred
     AND snapshot.source_kind = contact.source_kind
     AND snapshot.source_run_id IS NOT DISTINCT FROM contact.source_run_id
     AND snapshot.source_job_id IS NOT DISTINCT FROM contact.source_job_id
     AND snapshot.source_row_id = contact.source_row_id
    WHERE contact.client_user_id = p_client_user_id
      AND contact.append_status IN ('submitted', 'accepted')
      AND snapshot.scored_at >= p_from
      AND snapshot.scored_at < p_to
      AND (p_score_code IS NULL OR snapshot.score_code = p_score_code)
      AND contact.campaign_id = ANY (p_allowed_campaign_ids)
      AND (p_campaign_id IS NULL OR contact.campaign_id = p_campaign_id)
    ORDER BY contact.id, snapshot.scored_at DESC
  ),
  event_completed_batches AS (
    SELECT batch.*
    FROM public.client_campaign_append_batches AS batch
    WHERE batch.client_user_id = p_client_user_id
      AND batch.status = 'completed'
      AND batch.finished_at >= p_from
      AND batch.finished_at < p_to
      AND (p_score_code IS NULL OR batch.score_code = p_score_code)
      AND batch.campaign_id = ANY (p_allowed_campaign_ids)
      AND (p_campaign_id IS NULL OR batch.campaign_id = p_campaign_id)
  ),
  row_funnel_totals AS (
    SELECT
      count(*)::bigint AS scored_count,
      count(*) FILTER (
        WHERE facts.score_code IN ('A', 'B', 'C')
      )::bigint AS working_count,
      count(*) FILTER (
        WHERE facts.score_code IN ('A', 'B', 'C')
          AND facts.email_found_count > 0
      )::bigint AS email_found_count,
      coalesce(sum(facts.email_validated_count) FILTER (
        WHERE facts.score_code IN ('A', 'B', 'C')
      ), 0)::bigint AS validated_count,
      count(*) FILTER (
        WHERE facts.source_kind = 'legacy_snapshot'
           OR facts.source_kind = 'legacy_auto'
           OR facts.source_kind = 'legacy_manual'
      )::bigint AS legacy_scored_count,
      max(facts.cohort_at) AS max_cohort_at
    FROM cohort_domain_facts AS facts
  ),
  large_rollup_totals AS (
    SELECT
      coalesce(sum(rollup.domain_count), 0)::bigint AS scored_count,
      coalesce(sum(rollup.domain_count) FILTER (
        WHERE rollup.score_code IN ('A', 'B', 'C')
      ), 0)::bigint AS working_count,
      coalesce(sum(rollup.domain_count), 0)::bigint AS legacy_scored_count,
      max(rollup.max_cohort_at) AS max_cohort_at
    FROM large_rollup_facts AS rollup
  ),
  funnel_totals AS (
    SELECT
      row_totals.scored_count + rollup.scored_count AS scored_count,
      row_totals.working_count + rollup.working_count AS working_count,
      row_totals.email_found_count,
      row_totals.validated_count,
      row_totals.legacy_scored_count + rollup.legacy_scored_count
        AS legacy_scored_count,
      greatest(row_totals.max_cohort_at, rollup.max_cohort_at) AS max_cohort_at
    FROM row_funnel_totals AS row_totals
    CROSS JOIN large_rollup_totals AS rollup
  ),
  exact_contact_totals AS (
    SELECT
      count(*) FILTER (WHERE append_status = 'submitted')::bigint
        AS submitted_count,
      count(*) FILTER (WHERE append_status = 'accepted')::bigint
        AS confirmed_count,
      max(submitted_at) AS max_contact_at
    FROM exact_contact_cohort
  ),
  legacy_cohort_submission_rows AS (
    SELECT facts.*
    FROM cohort_domain_facts AS facts
    WHERE facts.legacy_submitted_count > 0
      AND facts.campaign_id = ANY (p_allowed_campaign_ids)
      AND (p_campaign_id IS NULL OR facts.campaign_id = p_campaign_id)
  ),
  legacy_cohort_submission_totals AS (
    SELECT
      coalesce(sum(facts.legacy_submitted_count), 0)::bigint
        AS legacy_submitted_count
    FROM legacy_cohort_submission_rows AS facts
  ),
  event_batch_attribution AS (
    SELECT
      batch.id,
      batch.accepted_count::bigint AS accepted_count,
      count(DISTINCT event_contact.id) FILTER (
        WHERE attributed_snapshot.id IS NOT NULL
      )::bigint AS attributed_confirmed_count,
      batch.finished_at
    FROM event_completed_batches AS batch
    LEFT JOIN public.client_campaign_contact_ledger AS event_contact
      ON event_contact.append_batch_id = batch.id
     AND event_contact.append_status = 'accepted'
    LEFT JOIN public.client_pipeline_domain_snapshots AS attributed_snapshot
      ON attributed_snapshot.client_user_id = event_contact.client_user_id
     AND NOT attributed_snapshot.legacy_inferred
     AND attributed_snapshot.source_kind = event_contact.source_kind
     AND attributed_snapshot.source_run_id
           IS NOT DISTINCT FROM event_contact.source_run_id
     AND attributed_snapshot.source_job_id
           IS NOT DISTINCT FROM event_contact.source_job_id
     AND attributed_snapshot.source_row_id = event_contact.source_row_id
    GROUP BY batch.id, batch.accepted_count, batch.finished_at
  ),
  event_totals AS (
    SELECT
      coalesce(sum(batch.accepted_count), 0)::bigint AS event_confirmed_count,
      coalesce(sum(greatest(
        batch.accepted_count - batch.attributed_confirmed_count,
        0::bigint
      )), 0)::bigint AS unattributed_confirmed_count,
      max(batch.finished_at) AS max_batch_at
    FROM event_batch_attribution AS batch
  ),
  legacy_event_submission_totals AS (
    SELECT
      coalesce(sum(facts.legacy_submitted_count), 0)::bigint
        AS event_legacy_submitted_count,
      max(facts.legacy_event_at) AS max_legacy_event_at
    FROM all_domain_facts AS facts
    WHERE facts.legacy_submitted_count > 0
      AND facts.legacy_event_at >= p_from
      AND facts.legacy_event_at < p_to
      AND (p_score_code IS NULL OR facts.score_code = p_score_code)
      AND facts.campaign_id = ANY (p_allowed_campaign_ids)
      AND (p_campaign_id IS NULL OR facts.campaign_id = p_campaign_id)
  ),
  campaign_rows AS (
    SELECT
      contacts.campaign_id,
      coalesce(
        nullif(max(contacts.campaign_name), ''),
        contacts.campaign_id
      ) AS campaign_name,
      contacts.score_code,
      count(*) FILTER (
        WHERE contacts.append_status = 'submitted'
      )::bigint AS submitted,
      count(*) FILTER (
        WHERE contacts.append_status = 'accepted'
      )::bigint AS confirmed
    FROM exact_contact_cohort AS contacts
    GROUP BY contacts.campaign_id, contacts.score_code
    UNION ALL
    SELECT
      facts.campaign_id,
      coalesce(nullif(facts.campaign_name, ''), facts.campaign_id)
        AS campaign_name,
      facts.score_code,
      facts.legacy_submitted_count AS submitted,
      0::bigint AS confirmed
    FROM legacy_cohort_submission_rows AS facts
  ),
  campaign_grouped AS (
    SELECT
      campaign_id,
      max(campaign_name) AS campaign_name,
      score_code,
      sum(submitted)::bigint AS submitted,
      sum(confirmed)::bigint AS confirmed
    FROM campaign_rows
    GROUP BY campaign_id, score_code
  ),
  campaign_breakdown AS (
    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'campaign_id', campaign_id,
        'campaign_name', campaign_name,
        'score_code', score_code,
        'submitted', submitted,
        'confirmed', confirmed
      ) ORDER BY campaign_name, score_code, campaign_id
    ), '[]'::jsonb) AS payload
    FROM campaign_grouped
  )
  SELECT
    funnel.scored_count,
    funnel.working_count,
    funnel.email_found_count,
    funnel.validated_count,
    contacts.submitted_count + legacy_cohort.legacy_submitted_count,
    contacts.confirmed_count,
    legacy_cohort.legacy_submitted_count,
    events.event_confirmed_count,
    legacy_events.event_legacy_submitted_count,
    funnel.legacy_scored_count,
    events.unattributed_confirmed_count,
    greatest(
      funnel.max_cohort_at,
      contacts.max_contact_at,
      events.max_batch_at,
      legacy_events.max_legacy_event_at
    ),
    breakdown.payload
  FROM funnel_totals AS funnel
  CROSS JOIN exact_contact_totals AS contacts
  CROSS JOIN legacy_cohort_submission_totals AS legacy_cohort
  CROSS JOIN event_totals AS events
  CROSS JOIN legacy_event_submission_totals AS legacy_events
  CROSS JOIN campaign_breakdown AS breakdown;
END;
$$;

REVOKE ALL ON FUNCTION public.client_report_pipeline_summary_shadow(uuid, uuid, timestamptz, timestamptz, text[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_report_pipeline_summary_shadow(uuid, uuid, timestamptz, timestamptz, text[], text, text) FROM anon;
REVOKE ALL ON FUNCTION public.client_report_pipeline_summary_shadow(uuid, uuid, timestamptz, timestamptz, text[], text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.client_report_pipeline_summary_shadow(uuid, uuid, timestamptz, timestamptz, text[], text, text) TO service_role;
