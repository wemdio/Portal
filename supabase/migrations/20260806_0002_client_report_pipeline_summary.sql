-- Cohort- and event-based pipeline reporting for the client statistics cabinet.
--
-- Early funnel stages belong to a scoring cohort. Final contact stages are
-- reconstructed from immutable per-contact facts, while provider-confirmed
-- events are reported separately by the time the append completed.

-- This table is introduced by the immediately preceding migration, so this
-- transactional index cannot lock a populated legacy relation.
CREATE INDEX IF NOT EXISTS idx_client_pipeline_snapshots_source_row_period
  ON public.client_pipeline_domain_snapshots (
    client_user_id,
    source_kind,
    source_row_id,
    scored_at DESC
  )
  WHERE NOT legacy_inferred;

CREATE INDEX IF NOT EXISTS idx_client_campaign_contact_ledger_source_row_status
  ON public.client_campaign_contact_ledger (
    client_user_id,
    source_kind,
    source_row_id,
    append_status
  )
  WHERE source_row_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.client_report_score_code(score numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN score IS NULL THEN 'error'
    WHEN score > 1000000 THEN 'A'
    WHEN score >= 15001 THEN 'B'
    WHEN score >= 1001 THEN 'C'
    ELSE 'rejected'
  END
$$;

-- Remove the draft signature if an environment applied an earlier revision of
-- this migration. The replacement requires an explicit campaign allow-list.
DROP FUNCTION IF EXISTS public.client_report_pipeline_summary(
  uuid, timestamptz, timestamptz, text, text
);

CREATE OR REPLACE FUNCTION public.client_report_pipeline_summary(
  p_client_user_id uuid,
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

  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'invalid report period'
      USING ERRCODE = '22023';
  END IF;

  IF p_to - p_from > interval '367 days' THEN
    RAISE EXCEPTION 'report period is too large'
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

  RETURN QUERY
  -- One company is one immutable source row inside the selected scoring
  -- cohort. During cut-over, each legacy branch suppresses only its exact
  -- journal counterpart; independent runs remain independent observations.
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
  legacy_large_domain_facts AS (
    SELECT
      lower(btrim(d.domain)) AS domain,
      CASE
        WHEN d.status = 'error' THEN 'error'
        ELSE public.client_report_score_code(cache.score)
      END AS score_code,
      0::integer AS email_found_count,
      0::integer AS email_validated_count,
      NULL::text AS campaign_id,
      NULL::text AS campaign_name,
      d.scored_at AS cohort_at,
      NULL::timestamptz AS legacy_event_at,
      'legacy_large'::text AS source_kind,
      NULL::text AS source_run_id,
      j.id::text AS source_job_id,
      d.id::text AS source_row_id,
      0::integer AS legacy_submitted_count
    FROM public.large_score_domains AS d
    JOIN public.large_score_jobs AS j
      ON j.id = d.job_id
     AND j.client_user_id = p_client_user_id
    LEFT JOIN public.mailganer_domain_scores AS cache
      ON cache.domain = lower(btrim(d.domain))
    WHERE d.status IN ('scored', 'error')
      AND nullif(btrim(d.domain), '') IS NOT NULL
      AND d.scored_at >= p_from
      AND d.scored_at < p_to
      AND NOT EXISTS (
        SELECT 1
        FROM exact_domain_facts AS exact_match
        WHERE exact_match.source_kind = 'large_score_file'
          AND exact_match.source_job_id = j.id::text
          AND exact_match.source_row_id = d.id::text
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
    UNION ALL
    SELECT * FROM legacy_large_domain_facts
  ),
  cohort_domain_facts AS (
    SELECT facts.*
    FROM all_domain_facts AS facts
    WHERE facts.cohort_at >= p_from
      AND facts.cohort_at < p_to
      AND (p_score_code IS NULL OR facts.score_code = p_score_code)
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
  funnel_totals AS (
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
           OR facts.source_kind = 'legacy_large'
      )::bigint AS legacy_scored_count,
      max(facts.cohort_at) AS max_cohort_at
    FROM cohort_domain_facts AS facts
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
      coalesce(nullif(facts.campaign_name, ''), facts.campaign_id) AS campaign_name,
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

REVOKE ALL ON FUNCTION public.client_report_score_code(numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_report_score_code(numeric) FROM anon;
REVOKE ALL ON FUNCTION public.client_report_score_code(numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.client_report_score_code(numeric) TO service_role;

REVOKE ALL ON FUNCTION public.client_report_pipeline_summary(
  uuid, timestamptz, timestamptz, text[], text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_report_pipeline_summary(
  uuid, timestamptz, timestamptz, text[], text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.client_report_pipeline_summary(
  uuid, timestamptz, timestamptz, text[], text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.client_report_pipeline_summary(
  uuid, timestamptz, timestamptz, text[], text, text
) TO service_role;
