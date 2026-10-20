-- A read-only, service-only candidate selector. Enrichment history is excluded
-- BEFORE LIMIT, so an already-seen newest 50k cannot hide older eligible reserve.
-- Score-only large_score_file snapshots/jobs deliberately do not consume reserve.
CREATE OR REPLACE FUNCTION public.mailganer_cache_topup_candidates(
  p_client_user_id uuid,
  p_page_size integer DEFAULT 500,
  p_after_scored_at timestamptz DEFAULT NULL,
  p_after_domain text DEFAULT NULL,
  p_excluded_suffixes text[] DEFAULT ARRAY[]::text[],
  p_excluded_domains text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 500), 500));
  v_result jsonb;
BEGIN
  IF p_client_user_id IS NULL
     OR (p_after_scored_at IS NULL) <> (p_after_domain IS NULL) THEN
    RAISE EXCEPTION 'Invalid cache candidate scope/cursor' USING ERRCODE = '22023';
  END IF;
  IF cardinality(coalesce(p_excluded_domains, ARRAY[]::text[])) > 50000
     OR cardinality(coalesce(p_excluded_suffixes, ARRAY[]::text[])) > 20 THEN
    RAISE EXCEPTION 'Cache candidate exclusion budget exceeded' USING ERRCODE = '22023';
  END IF;

  WITH dry_runs AS MATERIALIZED (
    SELECT r.id::text AS run_id
    FROM public.client_auto_pipeline_runs AS r
    WHERE r.client_user_id = p_client_user_id AND r.was_dry_run
  ), history_facts AS MATERIALIZED (
    SELECT public.fsd_norm_domain(s.domain) AS domain, s.hh_employer_id AS employer_id
    FROM public.client_auto_pipeline_seen_employers AS s
    WHERE s.client_user_id = p_client_user_id AND s.status <> 'dry_run'
    UNION ALL
    SELECT public.fsd_norm_domain(m.domain), NULL::text
    FROM public.client_manual_score_rows AS m
    JOIN public.client_manual_score_runs AS r ON r.id = m.run_id
    WHERE r.client_user_id = p_client_user_id AND m.domain IS NOT NULL
    UNION ALL
    SELECT public.fsd_norm_domain(s.domain),
      CASE WHEN s.source_kind = 'auto_pipeline' THEN s.source_row_id END
    FROM public.client_pipeline_domain_snapshots AS s
    WHERE s.client_user_id = p_client_user_id
      AND s.source_kind IN ('auto_pipeline', 'manual_scoring')
      AND (s.source_kind <> 'auto_pipeline' OR NOT EXISTS (
        SELECT 1 FROM dry_runs AS d WHERE d.run_id = s.source_run_id
      ))
    UNION ALL
    SELECT public.fsd_norm_domain(l.domain), l.source_row_id
    FROM public.client_campaign_contact_ledger AS l
    WHERE l.client_user_id = p_client_user_id
    UNION ALL
    SELECT public.fsd_norm_domain(d.domain), NULL::text
    FROM unnest(coalesce(p_excluded_domains, ARRAY[]::text[])) AS d(domain)
  ), history_domains AS MATERIALIZED (
    SELECT DISTINCT f.domain FROM history_facts AS f WHERE f.domain <> ''
  ), history_inns AS MATERIALIZED (
    SELECT substring(f.employer_id FROM 5) AS inn
    FROM history_facts AS f
    WHERE f.employer_id ~ '^bob:[0-9]{10}([0-9]{2})?$'
    UNION
    -- Cache domains are canonical lower-case hostnames (the cache PK contract).
    -- Explicit LATERAL+LIMIT keeps these lookups on that PK instead of scanning
    -- the entire multi-million-domain cache to recover INNs across aliases.
    SELECT alias.bob_inn
    FROM history_domains AS h
    CROSS JOIN LATERAL (
      SELECT c.bob_inn FROM public.mailganer_domain_scores AS c
      WHERE c.domain = h.domain LIMIT 1
    ) AS alias
    WHERE alias.bob_inn ~ '^[0-9]{10}([0-9]{2})?$'
  ), eligible AS MATERIALIZED (
    SELECT c.domain, c.scored_at, c.score, c.company_name, c.area,
      c.employees_count, c.industries, c.bob_inn
    FROM public.mailganer_domain_scores AS c
    WHERE c.score > 0 AND c.company_name IS NOT NULL
      AND (p_after_scored_at IS NULL OR c.scored_at < p_after_scored_at
        OR (c.scored_at = p_after_scored_at AND c.domain > p_after_domain))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p_excluded_suffixes, ARRAY[]::text[])) AS x(suffix)
        WHERE c.domain ILIKE '%' || x.suffix
      )
      AND NOT EXISTS (
        SELECT 1 FROM history_domains AS h WHERE h.domain = public.fsd_norm_domain(c.domain)
      )
      AND NOT EXISTS (SELECT 1 FROM history_inns AS h WHERE h.inn = c.bob_inn)
    ORDER BY c.scored_at DESC, c.domain
    LIMIT v_page_size + 1
  ), page AS (
    SELECT e.* FROM eligible AS e ORDER BY e.scored_at DESC, e.domain LIMIT v_page_size
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.scored_at DESC, p.domain) FROM page AS p), '[]'::jsonb),
    'has_more', (SELECT count(*) > v_page_size FROM eligible)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.mailganer_cache_topup_candidates(uuid, integer, timestamptz, text, text[], text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailganer_cache_topup_candidates(uuid, integer, timestamptz, text, text[], text[])
  TO service_role;
COMMENT ON FUNCTION public.mailganer_cache_topup_candidates(uuid, integer, timestamptz, text, text[], text[]) IS
  'Read-only cache candidates after complete client enrichment/queued-manual/contact history and INN alias exclusions. Score-only reserve remains eligible. Scalar JSON avoids PostgREST max_rows truncating cursor pages.';
NOTIFY pgrst, 'reload schema';
