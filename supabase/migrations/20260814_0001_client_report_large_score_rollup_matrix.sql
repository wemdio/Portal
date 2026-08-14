-- Set-based branch-equivalence proof for the large-score report rollup.
--
-- The verifier is deliberately owner-only. It has no activation side effect:
-- the release operator must inspect all 96 logical cells and activate in the
-- same transaction only after this function returns a complete passing matrix.

CREATE OR REPLACE FUNCTION public.verify_client_report_large_score_rollup_matrix(
  p_client_user_id uuid,
  p_rollup_run_id uuid,
  p_windows jsonb,
  p_allowed_campaign_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allowed_campaign_ids text[];
  v_contract_verified boolean := false;
  v_expected_cells CONSTANT integer := 96;
  v_checked_cells integer := 0;
  v_unique_contexts integer := 0;
  v_outside_full_count bigint := 0;
  v_cells jsonb := '[]'::jsonb;
  v_mismatches jsonb := '[]'::jsonb;
BEGIN
  IF p_client_user_id IS NULL OR p_rollup_run_id IS NULL THEN
    RAISE EXCEPTION 'client id and rollup run id are required'
      USING ERRCODE = '22023';
  END IF;

  -- All verifier/activator processes use the same client-scoped transaction
  -- lock. A concurrent attempt fails immediately instead of comparing a
  -- different operational moment or waiting without a bounded diagnosis.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'client-report-large-score-rollup:' || p_client_user_id::text,
      0
    )
  ) THEN
    RAISE EXCEPTION 'client report parity verification is already running'
      USING ERRCODE = '55P03';
  END IF;

  -- The proof below is valid only while the two audited report functions keep
  -- their known bodies and execution/result contracts. Exact input signatures
  -- are resolved by to_regprocedure; the remaining catalog checks cover the
  -- table result, volatility, invoker rights and pinned search_path.
  WITH expected_contract(
    proc_oid,
    expected_body_hash,
    input_count
  ) AS (
    VALUES
      (
        pg_catalog.to_regprocedure(
          'public.client_report_pipeline_summary(uuid,timestamptz,timestamptz,text[],text,text)'
        ),
        '948f5463fd7d60c9fa4fa806102b4de0'::text,
        6
      ),
      (
        pg_catalog.to_regprocedure(
          'public.client_report_pipeline_summary_shadow(uuid,uuid,timestamptz,timestamptz,text[],text,text)'
        ),
        '833ef7d93567b7b5fdbd579c9563f909'::text,
        7
      )
  )
  SELECT coalesce(bool_and(
    contract_proc.oid IS NOT NULL
    AND pg_catalog.md5(pg_catalog.btrim(pg_catalog.regexp_replace(
      contract_proc.prosrc,
      '\s+',
      ' ',
      'g'
    ))) = expected_contract.expected_body_hash
    AND contract_proc.provolatile = 's'
    AND NOT contract_proc.prosecdef
    AND contract_proc.proconfig =
      ARRAY['search_path=pg_catalog, public']::text[]
    AND contract_proc.proretset
    AND contract_proc.prorettype = 'record'::pg_catalog.regtype
    AND contract_proc.proallargtypes[
      expected_contract.input_count + 1:
      expected_contract.input_count + 13
    ] = ARRAY[
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'bigint'::pg_catalog.regtype::oid,
      'timestamptz'::pg_catalog.regtype::oid,
      'jsonb'::pg_catalog.regtype::oid
    ]::oid[]
    AND contract_proc.proargmodes[
      expected_contract.input_count + 1:
      expected_contract.input_count + 13
    ] = pg_catalog.array_fill('t'::"char", ARRAY[13])
    AND contract_proc.proargnames[
      expected_contract.input_count + 1:
      expected_contract.input_count + 13
    ] = ARRAY[
      'scored_companies',
      'working_score_companies',
      'email_found_companies',
      'validated_emails',
      'submitted_contacts',
      'confirmed_contacts',
      'legacy_submitted_contacts',
      'event_confirmed_contacts',
      'event_legacy_submitted_contacts',
      'legacy_scored_companies',
      'unattributed_confirmed_contacts',
      'pipeline_at',
      'by_campaign'
    ]::text[]
  ), false)
  INTO v_contract_verified
  FROM expected_contract
  LEFT JOIN pg_catalog.pg_proc AS contract_proc
    ON contract_proc.oid = expected_contract.proc_oid;

  IF NOT v_contract_verified THEN
    RAISE EXCEPTION 'client report parity contract drifted'
      USING ERRCODE = '55000';
  END IF;

  IF p_windows IS NULL
     OR pg_catalog.jsonb_typeof(p_windows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_windows) <> 6
  THEN
    RAISE EXCEPTION 'invalid parity matrix windows'
      USING ERRCODE = '22023';
  END IF;

  IF p_allowed_campaign_ids IS NULL
     OR pg_catalog.cardinality(p_allowed_campaign_ids) <> 3
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_allowed_campaign_ids)
         AS allowed(allowed_campaign_id)
       WHERE nullif(
         pg_catalog.btrim(allowed_campaign_id),
         ''
       ) IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_allowed_campaign_ids)
         AS allowed(allowed_campaign_id)
       HAVING pg_catalog.count(
         DISTINCT pg_catalog.btrim(allowed_campaign_id)
       ) <> 3
     )
  THEN
    RAISE EXCEPTION 'parity matrix requires three unique campaigns'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(
    DISTINCT pg_catalog.btrim(allowed_campaign_id)
    ORDER BY pg_catalog.btrim(allowed_campaign_id)
  )
  INTO v_allowed_campaign_ids
  FROM pg_catalog.unnest(p_allowed_campaign_ids)
    AS allowed(allowed_campaign_id);

  -- Labels are part of the proof contract, not display-only metadata. Requiring
  -- the six known presets prevents a caller from obtaining a misleading 96/96
  -- result over arbitrary or duplicated ranges.
  IF EXISTS (
    WITH input_windows AS MATERIALIZED (
      SELECT
        window_item.ordinality,
        window_item.window_value,
        nullif(
          pg_catalog.btrim(window_item.window_value->>'key'),
          ''
        ) AS window_key,
        (window_item.window_value->>'from_utc')::timestamptz AS from_at,
        (window_item.window_value->>'to_utc')::timestamptz AS to_at
      FROM pg_catalog.jsonb_array_elements(p_windows)
        WITH ORDINALITY AS window_item(window_value, ordinality)
    ),
    window_stats AS (
      SELECT
        pg_catalog.count(*) AS window_count,
        pg_catalog.count(DISTINCT window_key) AS distinct_keys,
        pg_catalog.count(DISTINCT (from_at, to_at)) AS distinct_ranges,
        pg_catalog.bool_and(coalesce(
          window_key IS NOT NULL
          AND from_at IS NOT NULL
          AND to_at IS NOT NULL
          AND from_at < to_at
          AND to_at - from_at <= interval '367 days'
          AND from_at = (
            (from_at AT TIME ZONE 'Europe/Moscow')::date::timestamp
              AT TIME ZONE 'Europe/Moscow'
          )
          AND to_at = (
            (to_at AT TIME ZONE 'Europe/Moscow')::date::timestamp
              AT TIME ZONE 'Europe/Moscow'
          )
          AND pg_catalog.jsonb_typeof(
            window_value->'labels'
          ) = 'array'
          AND pg_catalog.jsonb_array_length(
            window_value->'labels'
          ) > 0,
          false
        )) AS windows_valid
      FROM input_windows
    ),
    label_rows AS (
      SELECT
        label_item.label_value,
        label_item.label_value #>> '{}' AS label_text
      FROM input_windows
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        CASE
          WHEN pg_catalog.jsonb_typeof(
            input_windows.window_value->'labels'
          ) = 'array'
          THEN input_windows.window_value->'labels'
          ELSE '[]'::jsonb
        END
      ) AS label_item(label_value)
    ),
    label_stats AS (
      SELECT
        pg_catalog.count(*) AS label_count,
        pg_catalog.count(DISTINCT label_text) AS distinct_labels,
        pg_catalog.array_agg(label_text ORDER BY label_text) AS labels,
        pg_catalog.bool_and(
          pg_catalog.jsonb_typeof(label_value) = 'string'
          AND nullif(pg_catalog.btrim(label_text), '') IS NOT NULL
        ) AS labels_valid
      FROM label_rows
    ),
    required_labels AS (
      SELECT ARRAY[
        '1d',
        '7d',
        '30d',
        'current_month',
        'previous_month',
        'full'
      ]::text[] AS labels
    )
    SELECT 1
    FROM window_stats
    CROSS JOIN label_stats
    CROSS JOIN required_labels
    WHERE window_stats.window_count <> 6
       OR window_stats.distinct_keys <> 6
       OR window_stats.distinct_ranges <> 6
       OR NOT coalesce(window_stats.windows_valid, false)
       OR label_stats.label_count <> 6
       OR label_stats.distinct_labels <> 6
       OR NOT coalesce(label_stats.labels_valid, false)
       OR NOT (label_stats.labels @> required_labels.labels)
       OR NOT (required_labels.labels @> label_stats.labels)
  ) THEN
    RAISE EXCEPTION 'invalid parity matrix windows'
      USING ERRCODE = '22023';
  END IF;

  -- Pin the labels to the exact dashboard presets. Short periods end at the
  -- immutable coverage boundary; month periods are anchored to this RR
  -- transaction's Moscow calendar and all candidates are clipped to full.
  IF EXISTS (
    WITH input_windows AS MATERIALIZED (
      SELECT
        window_item.window_value,
        (window_item.window_value->>'from_utc')::timestamptz AS from_at,
        (window_item.window_value->>'to_utc')::timestamptz AS to_at
      FROM pg_catalog.jsonb_array_elements(p_windows)
        AS window_item(window_value)
    ),
    labeled_windows AS (
      SELECT
        label_item.label_value #>> '{}' AS label,
        input_windows.from_at,
        input_windows.to_at
      FROM input_windows
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        input_windows.window_value->'labels'
      ) AS label_item(label_value)
    ),
    full_bounds AS (
      SELECT labeled.from_at, labeled.to_at
      FROM labeled_windows AS labeled
      WHERE labeled.label = 'full'
    ),
    month_bounds AS (
      SELECT
        pg_catalog.date_trunc(
          'month',
          transaction_timestamp() AT TIME ZONE 'Europe/Moscow'
        ) AT TIME ZONE 'Europe/Moscow' AS current_month_from,
        (
          pg_catalog.date_trunc(
            'month',
            transaction_timestamp() AT TIME ZONE 'Europe/Moscow'
          ) - interval '1 month'
        ) AT TIME ZONE 'Europe/Moscow' AS previous_month_from
    ),
    expected_presets AS (
      SELECT
        preset.label,
        CASE preset.label
          WHEN '1d' THEN greatest(
            full_bounds.from_at,
            full_bounds.to_at - interval '1 day'
          )
          WHEN '7d' THEN greatest(
            full_bounds.from_at,
            full_bounds.to_at - interval '7 days'
          )
          WHEN '30d' THEN greatest(
            full_bounds.from_at,
            full_bounds.to_at - interval '30 days'
          )
          WHEN 'current_month' THEN greatest(
            full_bounds.from_at,
            month_bounds.current_month_from
          )
          WHEN 'previous_month' THEN greatest(
            full_bounds.from_at,
            month_bounds.previous_month_from
          )
          WHEN 'full' THEN full_bounds.from_at
        END AS from_at,
        CASE preset.label
          WHEN 'previous_month' THEN least(
            full_bounds.to_at,
            month_bounds.current_month_from
          )
          ELSE full_bounds.to_at
        END AS to_at
      FROM full_bounds
      CROSS JOIN month_bounds
      CROSS JOIN (
        VALUES
          ('1d'::text),
          ('7d'::text),
          ('30d'::text),
          ('current_month'::text),
          ('previous_month'::text),
          ('full'::text)
      ) AS preset(label)
    )
    SELECT 1
    FROM labeled_windows AS actual
    JOIN expected_presets AS expected
      ON expected.label = actual.label
    WHERE actual.from_at IS DISTINCT FROM expected.from_at
       OR actual.to_at IS DISTINCT FROM expected.to_at
  ) THEN
    RAISE EXCEPTION 'parity matrix windows do not match dashboard presets'
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

  WITH window_rows AS MATERIALIZED (
    SELECT
      window_item.ordinality::integer AS window_order,
      pg_catalog.btrim(window_item.window_value->>'key') AS window_key,
      window_item.window_value->'labels' AS labels,
      (window_item.window_value->>'from_utc')::timestamptz AS from_at,
      (window_item.window_value->>'to_utc')::timestamptz AS to_at
    FROM pg_catalog.jsonb_array_elements(p_windows)
      WITH ORDINALITY AS window_item(window_value, ordinality)
  ),
  full_window AS MATERIALIZED (
    SELECT window_row.from_at, window_row.to_at
    FROM window_rows AS window_row
    WHERE window_row.labels @> '["full"]'::jsonb
  ),
  -- This is the only physical scan of the multi-million-row live source.
  -- It deliberately has neither a build watermark nor a completed-job gate:
  -- the production legacy RPC has neither, so any drift must fail parity.
  large_source AS MATERIALIZED (
    SELECT
      job.id AS source_job_id,
      domain_row.id AS source_row_id,
      domain_row.scored_at,
      CASE
        WHEN domain_row.status = 'error' THEN 'error'
        ELSE public.client_report_score_code(cache.score)
      END AS score_code
    FROM public.large_score_domains AS domain_row
    JOIN public.large_score_jobs AS job
      ON job.id = domain_row.job_id
     AND job.client_user_id = p_client_user_id
    LEFT JOIN public.mailganer_domain_scores AS cache
      ON cache.domain = pg_catalog.lower(
        pg_catalog.btrim(domain_row.domain)
      )
    WHERE domain_row.status IN ('scored', 'error')
      AND nullif(
        pg_catalog.btrim(domain_row.domain),
        ''
      ) IS NOT NULL
  ),
  outside_full AS (
    SELECT pg_catalog.count(*)::bigint AS outside_full_count
    FROM large_source AS source
    CROSS JOIN full_window
    WHERE source.scored_at < full_window.from_at
       OR source.scored_at >= full_window.to_at
  ),
  source_window_facts AS (
    SELECT
      window_row.window_order,
      window_row.window_key,
      source.score_code,
      source.scored_at
    FROM window_rows AS window_row
    JOIN large_source AS source
      ON source.scored_at >= window_row.from_at
     AND source.scored_at < window_row.to_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.client_pipeline_domain_snapshots AS exact_match
      WHERE exact_match.client_user_id = p_client_user_id
        AND NOT exact_match.legacy_inferred
        AND exact_match.source_kind = 'large_score_file'
        AND exact_match.source_job_id = source.source_job_id::text
        AND exact_match.source_row_id = source.source_row_id::text
        AND (
          (
            exact_match.scored_at >= window_row.from_at
            AND exact_match.scored_at < window_row.to_at
          )
          OR (
            exact_match.routed_at >= window_row.from_at
            AND exact_match.routed_at < window_row.to_at
          )
        )
    )
  ),
  source_stats AS (
    SELECT
      source.window_order,
      source.window_key,
      source.score_code,
      pg_catalog.count(*)::bigint AS domain_count,
      pg_catalog.max(source.scored_at) AS max_cohort_at
    FROM source_window_facts AS source
    WHERE source.score_code IN ('A', 'B', 'C', 'rejected', 'error')
    GROUP BY
      source.window_order,
      source.window_key,
      source.score_code
  ),
  rollup_stats AS (
    SELECT
      window_row.window_order,
      window_row.window_key,
      bucket.score_code,
      pg_catalog.sum(bucket.domain_count)::bigint AS domain_count,
      pg_catalog.max(bucket.max_cohort_at) AS max_cohort_at
    FROM window_rows AS window_row
    JOIN public.client_report_large_score_rollup_buckets AS bucket
      ON bucket.rollup_run_id = p_rollup_run_id
     AND bucket.client_user_id = p_client_user_id
     AND bucket.cohort_day >= (
       window_row.from_at AT TIME ZONE 'Europe/Moscow'
     )::date
     AND bucket.cohort_day < (
       window_row.to_at AT TIME ZONE 'Europe/Moscow'
     )::date
     AND bucket.score_code IN ('A', 'B', 'C', 'rejected', 'error')
    GROUP BY
      window_row.window_order,
      window_row.window_key,
      bucket.score_code
  ),
  score_filters(score_order, score_code) AS (
    VALUES
      (0, NULL::text),
      (1, 'A'::text),
      (2, 'B'::text),
      (3, 'C'::text)
  ),
  campaign_filters(campaign_order, campaign_id) AS MATERIALIZED (
    SELECT 0, NULL::text
    UNION ALL
    SELECT campaign.ordinality::integer,
           campaign.allowed_campaign_id
    FROM pg_catalog.unnest(v_allowed_campaign_ids)
      WITH ORDINALITY AS campaign(allowed_campaign_id, ordinality)
  ),
  source_by_filter AS (
    SELECT
      window_row.window_order,
      window_row.window_key,
      score_filters.score_order,
      score_filters.score_code,
      coalesce(pg_catalog.sum(source.domain_count) FILTER (
        WHERE score_filters.score_code IS NULL
           OR source.score_code = score_filters.score_code
      ), 0)::bigint AS scored_companies,
      coalesce(pg_catalog.sum(source.domain_count) FILTER (
        WHERE source.score_code IN ('A', 'B', 'C')
          AND (
            score_filters.score_code IS NULL
            OR source.score_code = score_filters.score_code
          )
      ), 0)::bigint AS working_score_companies,
      coalesce(pg_catalog.sum(source.domain_count) FILTER (
        WHERE score_filters.score_code IS NULL
           OR source.score_code = score_filters.score_code
      ), 0)::bigint AS legacy_scored_companies,
      pg_catalog.max(source.max_cohort_at) FILTER (
        WHERE score_filters.score_code IS NULL
           OR source.score_code = score_filters.score_code
      ) AS pipeline_at,
      '[]'::jsonb AS by_campaign
    FROM window_rows AS window_row
    CROSS JOIN score_filters
    LEFT JOIN source_stats AS source
      ON source.window_order = window_row.window_order
     AND source.window_key = window_row.window_key
    GROUP BY
      window_row.window_order,
      window_row.window_key,
      score_filters.score_order,
      score_filters.score_code
  ),
  rollup_by_filter AS (
    SELECT
      window_row.window_order,
      window_row.window_key,
      score_filters.score_order,
      score_filters.score_code,
      coalesce(pg_catalog.sum(rollup.domain_count) FILTER (
        WHERE score_filters.score_code IS NULL
           OR rollup.score_code = score_filters.score_code
      ), 0)::bigint AS scored_companies,
      coalesce(pg_catalog.sum(rollup.domain_count) FILTER (
        WHERE rollup.score_code IN ('A', 'B', 'C')
          AND (
            score_filters.score_code IS NULL
            OR rollup.score_code = score_filters.score_code
          )
      ), 0)::bigint AS working_score_companies,
      coalesce(pg_catalog.sum(rollup.domain_count) FILTER (
        WHERE score_filters.score_code IS NULL
           OR rollup.score_code = score_filters.score_code
      ), 0)::bigint AS legacy_scored_companies,
      pg_catalog.max(rollup.max_cohort_at) FILTER (
        WHERE score_filters.score_code IS NULL
           OR rollup.score_code = score_filters.score_code
      ) AS pipeline_at,
      '[]'::jsonb AS by_campaign
    FROM window_rows AS window_row
    CROSS JOIN score_filters
    LEFT JOIN rollup_stats AS rollup
      ON rollup.window_order = window_row.window_order
     AND rollup.window_key = window_row.window_key
    GROUP BY
      window_row.window_order,
      window_row.window_key,
      score_filters.score_order,
      score_filters.score_code
  ),
  matrix_compared AS MATERIALIZED (
    SELECT
      window_row.window_order,
      window_row.window_key,
      window_row.labels,
      window_row.from_at,
      window_row.to_at,
      source.score_order,
      source.score_code,
      campaign_filters.campaign_order,
      campaign_filters.campaign_id,
      source.scored_companies AS legacy_scored,
      source.working_score_companies AS legacy_working,
      source.legacy_scored_companies AS legacy_legacy_scored,
      source.pipeline_at AS legacy_pipeline_at,
      source.by_campaign AS legacy_by_campaign,
      rollup.scored_companies AS shadow_scored,
      rollup.working_score_companies AS shadow_working,
      rollup.legacy_scored_companies AS shadow_legacy_scored,
      rollup.pipeline_at AS shadow_pipeline_at,
      rollup.by_campaign AS shadow_by_campaign,
      source.scored_companies IS NOT DISTINCT FROM rollup.scored_companies
        AND source.working_score_companies
          IS NOT DISTINCT FROM rollup.working_score_companies
        AND source.legacy_scored_companies
          IS NOT DISTINCT FROM rollup.legacy_scored_companies
        AND source.pipeline_at IS NOT DISTINCT FROM rollup.pipeline_at
        AND source.by_campaign IS NOT DISTINCT FROM rollup.by_campaign
        AS matched
    FROM window_rows AS window_row
    JOIN source_by_filter AS source
      ON source.window_order = window_row.window_order
     AND source.window_key = window_row.window_key
    JOIN rollup_by_filter AS rollup
      ON rollup.window_order = source.window_order
     AND rollup.window_key = source.window_key
     AND rollup.score_order = source.score_order
     AND rollup.score_code IS NOT DISTINCT FROM source.score_code
    CROSS JOIN campaign_filters
  ),
  matrix_cells AS MATERIALIZED (
    SELECT
      compared.*,
      pg_catalog.jsonb_build_object(
        'window_key', compared.window_key,
        'labels', compared.labels,
        'from_utc', pg_catalog.to_char(
          compared.from_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'to_utc', pg_catalog.to_char(
          compared.to_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'score_code', compared.score_code,
        'campaign_id', compared.campaign_id,
        'matched', compared.matched,
        'legacy', pg_catalog.jsonb_build_object(
          'scored_companies', compared.legacy_scored,
          'working_score_companies', compared.legacy_working,
          'legacy_scored_companies', compared.legacy_legacy_scored,
          'pipeline_at', compared.legacy_pipeline_at,
          'by_campaign', '[]'::jsonb
        ),
        'shadow', pg_catalog.jsonb_build_object(
          'scored_companies', compared.shadow_scored,
          'working_score_companies', compared.shadow_working,
          'legacy_scored_companies', compared.shadow_legacy_scored,
          'pipeline_at', compared.shadow_pipeline_at,
          'by_campaign', '[]'::jsonb
        )
      ) || CASE
        WHEN compared.matched THEN '{}'::jsonb
        ELSE pg_catalog.jsonb_build_object(
          'mismatch_context', pg_catalog.jsonb_build_object(
            'legacy', pg_catalog.jsonb_build_object(
              'scored_companies', compared.legacy_scored,
              'working_score_companies', compared.legacy_working,
              'legacy_scored_companies', compared.legacy_legacy_scored,
              'pipeline_at', compared.legacy_pipeline_at,
              'by_campaign', '[]'::jsonb
            ),
            'shadow', pg_catalog.jsonb_build_object(
              'scored_companies', compared.shadow_scored,
              'working_score_companies', compared.shadow_working,
              'legacy_scored_companies', compared.shadow_legacy_scored,
              'pipeline_at', compared.shadow_pipeline_at,
              'by_campaign', '[]'::jsonb
            )
          )
        )
      END AS cell_payload
    FROM matrix_compared AS compared
  )
  SELECT
    pg_catalog.count(*)::integer,
    (
      SELECT pg_catalog.count(*)::integer
      FROM (
        SELECT DISTINCT
          unique_cell.window_key,
          unique_cell.score_code,
          unique_cell.campaign_id
        FROM matrix_cells AS unique_cell
      ) AS unique_context
    ),
    coalesce(
      pg_catalog.jsonb_agg(
        matrix_cells.cell_payload
        ORDER BY
          matrix_cells.window_order,
          matrix_cells.score_order,
          matrix_cells.campaign_order
      ),
      '[]'::jsonb
    ),
    coalesce(
      pg_catalog.jsonb_agg(
        matrix_cells.cell_payload
        ORDER BY
          matrix_cells.window_order,
          matrix_cells.score_order,
          matrix_cells.campaign_order
      ) FILTER (WHERE NOT matrix_cells.matched),
      '[]'::jsonb
    ),
    (SELECT outside_full.outside_full_count FROM outside_full)
  INTO
    v_checked_cells,
    v_unique_contexts,
    v_cells,
    v_mismatches,
    v_outside_full_count
  FROM matrix_cells;

  IF v_outside_full_count <> 0 THEN
    RAISE EXCEPTION 'live large-score source falls outside full parity window'
      USING
        ERRCODE = '23514',
        DETAIL = pg_catalog.format(
          'outside_full_count=%s',
          v_outside_full_count
        );
  END IF;

  IF v_checked_cells <> v_expected_cells
     OR v_unique_contexts <> v_expected_cells
     OR pg_catalog.jsonb_array_length(v_cells) <> v_expected_cells
  THEN
    RAISE EXCEPTION 'parity matrix cardinality invariant failed'
      USING
        ERRCODE = '23514',
        DETAIL = pg_catalog.format(
          'expected=%s checked=%s unique=%s',
          v_expected_cells,
          v_checked_cells,
          v_unique_contexts
        );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'checked_cells', v_checked_cells,
    'cells', v_cells,
    'mismatches', v_mismatches,
    'source_scans', 1,
    'contract_verified', v_contract_verified,
    'coverage_verified', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_client_report_large_score_rollup_matrix(uuid, uuid, jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_client_report_large_score_rollup_matrix(uuid, uuid, jsonb, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.verify_client_report_large_score_rollup_matrix(uuid, uuid, jsonb, text[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.verify_client_report_large_score_rollup_matrix(uuid, uuid, jsonb, text[]) FROM service_role;
