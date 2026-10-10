-- Match the normal/rollup report's interim manual-row email calculation.
-- Nullable status arithmetic lost ready single-address rows until snapshots
-- were persisted, temporarily counting their validation as new acquisition.
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
    LEFT JOIN public.client_manual_score_runs AS r
      ON s.source_kind = 'manual_scoring'
     AND s.source_run_id = r.id::text
     AND s.client_user_id = r.client_user_id
    WHERE s.client_user_id = p_client_user_id
      AND s.source_kind = 'manual_scoring'
      AND NOT s.legacy_inferred
      AND s.scored_at >= p_from
      AND s.scored_at < p_to
      AND (s.metadata->>'is_no_email_retry' = 'true'
        OR r.is_no_email_retry
        OR s.metadata->>'source_filename' LIKE 'no-email-retry-%')

    UNION ALL

    SELECT
      public.client_report_score_code(m.score),
      email_counts.found_count,
      email_counts.validated_count
    FROM public.client_manual_score_rows AS m
    JOIN public.client_manual_score_runs AS r ON r.id = m.run_id
    CROSS JOIN LATERAL (
      SELECT
        count(*)::integer AS found_count,
        count(*) FILTER (WHERE normalized_email.is_ready)::integer AS validated_count
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
    WHERE r.client_user_id = p_client_user_id
      AND nullif(btrim(m.domain), '') IS NOT NULL
      AND (r.is_no_email_retry OR r.source_filename LIKE 'no-email-retry-%')
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
