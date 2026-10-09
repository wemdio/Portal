-- Read-only Mailganer no_email retry cohort. Run with psql
-- -v client_user_id=<uuid>. Every candidate was positively scored already;
-- there is no API call or campaign write here.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '180s';

WITH failed AS MATERIALIZED (
  SELECT DISTINCT lower(btrim(domain)) AS domain
  FROM public.client_auto_pipeline_seen_employers
  WHERE client_user_id = :'client_user_id'::uuid
    AND endpoint_score > 1000
    AND skip_reason = 'no_email'
    AND domain IS NOT NULL
), ready_seen AS MATERIALIZED (
  SELECT DISTINCT lower(btrim(domain)) AS domain
  FROM public.client_auto_pipeline_seen_employers
  WHERE client_user_id = :'client_user_id'::uuid
    AND domain IS NOT NULL
    AND (
      status = 'routed'
      OR resolved_email IS NOT NULL
      OR email_found IS NOT NULL
      OR email2 IS NOT NULL
    )
), ready_snapshots AS MATERIALIZED (
  SELECT DISTINCT lower(btrim(domain)) AS domain
  FROM public.client_pipeline_domain_snapshots
  WHERE client_user_id = :'client_user_id'::uuid
    AND (email_found_count > 0 OR email_validated_count > 0 OR routed_campaign_id IS NOT NULL)
), contacted AS MATERIALIZED (
  SELECT DISTINCT lower(btrim(domain)) AS domain
  FROM public.client_campaign_contact_ledger
  WHERE client_user_id = :'client_user_id'::uuid
    AND append_status IN ('submitted', 'accepted')
    AND domain IS NOT NULL
), prior_retry AS MATERIALIZED (
  SELECT DISTINCT lower(btrim(m.domain)) AS domain
  FROM public.client_manual_score_rows AS m
  JOIN public.client_manual_score_runs AS r ON r.id = m.run_id
  WHERE r.client_user_id = :'client_user_id'::uuid
    AND (r.is_no_email_retry OR r.source_filename LIKE 'no-email-retry-%')
    AND m.domain IS NOT NULL

  UNION

  -- Durable retry history survives the 30-day cleanup of manual runs/rows.
  SELECT DISTINCT lower(btrim(domain)) AS domain
  FROM public.client_pipeline_domain_snapshots
  WHERE client_user_id = :'client_user_id'::uuid
    AND source_kind = 'manual_scoring'
    AND (metadata->>'is_no_email_retry' = 'true'
      OR metadata->>'source_filename' LIKE 'no-email-retry-%')
    AND domain IS NOT NULL
)
SELECT json_build_object(
  'domain', failed.domain,
  'company_name', cache.company_name
)::text
FROM failed
JOIN public.mailganer_domain_scores AS cache ON cache.domain = failed.domain
LEFT JOIN ready_seen ON ready_seen.domain = failed.domain
LEFT JOIN ready_snapshots ON ready_snapshots.domain = failed.domain
LEFT JOIN contacted ON contacted.domain = failed.domain
LEFT JOIN prior_retry ON prior_retry.domain = failed.domain
WHERE cache.score > 1000
  AND (
    failed.domain LIKE '%.ru'
    OR failed.domain LIKE '%.su'
    OR failed.domain LIKE '%.xn--p1ai'
  )
  AND ready_seen.domain IS NULL
  AND ready_snapshots.domain IS NULL
  AND contacted.domain IS NULL
  AND prior_retry.domain IS NULL
ORDER BY failed.domain;

COMMIT;
