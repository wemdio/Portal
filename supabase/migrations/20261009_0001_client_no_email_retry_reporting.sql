-- A repeat email search is an outreach attempt, not another newly scored company.
-- Keep its domain snapshot for contact attribution and the audit trail, while
-- allowing the client funnel to remove repeat attempts from acquisition counts.
ALTER TABLE public.client_manual_score_runs
  ADD COLUMN IF NOT EXISTS is_no_email_retry boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_manual_score_runs.is_no_email_retry IS
  'Repeat search for email on an already scored domain. Its domain snapshot remains attributable to accepted contacts but must not count as a newly scored company.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_no_email_retry_source
  ON public.client_manual_score_runs (client_user_id, source_filename)
  WHERE is_no_email_retry;

CREATE OR REPLACE FUNCTION public.client_report_no_email_retry_delta(
  p_client_user_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_score_code text DEFAULT NULL
)
RETURNS TABLE (
  scored_companies bigint,
  working_score_companies bigint,
  email_found_companies bigint,
  validated_emails bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH retry_facts AS (
    SELECT
      s.score_code,
      s.email_found_count,
      s.email_validated_count
    FROM public.client_pipeline_domain_snapshots AS s
    JOIN public.client_manual_score_runs AS r
      ON s.source_kind = 'manual_scoring'
     AND s.source_run_id = r.id::text
     AND s.client_user_id = r.client_user_id
    WHERE s.client_user_id = p_client_user_id
      AND NOT s.legacy_inferred
      AND s.scored_at >= p_from
      AND s.scored_at < p_to
      AND (r.is_no_email_retry OR r.source_filename LIKE 'no-email-retry-%-20261008.txt')

    UNION ALL

    -- The existing report exposes processed manual rows before their immutable
    -- snapshots are persisted. Subtract those interim rows exactly once too.
    SELECT
      public.client_report_score_code(m.score),
      ((m.email IS NOT NULL)::int + (m.email2 IS NOT NULL)::int),
      ((m.email_validation_status IN ('valid','role_address','free_provider','catch_all'))::int
        + (m.email2_validation_status IN ('valid','role_address','free_provider','catch_all'))::int)
    FROM public.client_manual_score_rows AS m
    JOIN public.client_manual_score_runs AS r ON r.id = m.run_id
    WHERE r.client_user_id = p_client_user_id
      AND (r.is_no_email_retry OR r.source_filename LIKE 'no-email-retry-%-20261008.txt')
      AND m.processed_at >= p_from
      AND m.processed_at < p_to
      AND (m.bucket IS NOT NULL OR m.error_message IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public.client_pipeline_domain_snapshots AS s
        WHERE s.client_user_id = r.client_user_id
          AND s.source_kind = 'manual_scoring'
          AND s.source_run_id = r.id::text
          AND s.source_row_id = m.id::text
      )
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE s.score_code IN ('A', 'B', 'C'))::bigint,
    count(*) FILTER (
      WHERE s.score_code IN ('A', 'B', 'C') AND s.email_found_count > 0
    )::bigint,
    coalesce(sum(s.email_validated_count) FILTER (
      WHERE s.score_code IN ('A', 'B', 'C')
    ), 0)::bigint
  FROM retry_facts AS s
  WHERE p_score_code IS NULL OR s.score_code = upper(btrim(p_score_code));
$$;

REVOKE ALL ON FUNCTION public.client_report_no_email_retry_delta(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_report_no_email_retry_delta(uuid, timestamptz, timestamptz, text) FROM anon;
REVOKE ALL ON FUNCTION public.client_report_no_email_retry_delta(uuid, timestamptz, timestamptz, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.client_report_no_email_retry_delta(uuid, timestamptz, timestamptz, text) TO service_role;
