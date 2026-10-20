-- migrate:no-transaction
-- Prepared only: apply together with the candidate RPC before deploying its caller.
-- Build online; a cache spanning millions of domains must not block normal writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mds_topup_keyset
  ON public.mailganer_domain_scores (scored_at DESC, domain)
  WHERE score > 0 AND company_name IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auto_seen_enrichment_domain
  ON public.client_auto_pipeline_seen_employers
    (client_user_id, public.fsd_norm_domain(domain))
  WHERE status <> 'dry_run' AND domain IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manual_rows_enrichment_domain
  ON public.client_manual_score_rows (public.fsd_norm_domain(domain), run_id)
  WHERE domain IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_enrichment_domain
  ON public.client_pipeline_domain_snapshots
    (client_user_id, public.fsd_norm_domain(domain))
  WHERE source_kind IN ('auto_pipeline', 'manual_scoring');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_ledger_enrichment_domain
  ON public.client_campaign_contact_ledger
    (client_user_id, public.fsd_norm_domain(domain))
  WHERE domain IS NOT NULL;
