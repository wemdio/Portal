-- Run outside a transaction, once per environment, before enabling the client
-- pipeline summary on large legacy datasets. CONCURRENTLY avoids blocking
-- writers while PostgreSQL builds these indexes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_large_score_domains_job_scored_at
  ON public.large_score_domains (job_id, scored_at DESC)
  INCLUDE (status, domain)
  WHERE scored_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manual_score_rows_run_processed_at
  ON public.client_manual_score_rows (run_id, processed_at DESC)
  INCLUDE (
    domain,
    score,
    bucket,
    email,
    email_validation_status,
    email2,
    email2_validation_status
  );
