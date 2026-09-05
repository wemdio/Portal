-- Durable client-policy exclusions for large-file scoring.
-- Existing scored/cache/history rows are intentionally left unchanged.

ALTER TABLE public.large_score_jobs
  ADD COLUMN IF NOT EXISTS excluded_domains bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.large_score_jobs.excluded_domains IS
  'Unique queued domains excluded by the client domain policy before cache/API scoring.';

ALTER TABLE public.large_score_domains
  DROP CONSTRAINT IF EXISTS large_score_domains_status_check;

ALTER TABLE public.large_score_domains
  ADD CONSTRAINT large_score_domains_status_check
  CHECK (status IN ('pending','scored','cached','error','excluded')) NOT VALID;

-- Intentionally leave the replacement NOT VALID during this atomic migration:
-- the prior stricter CHECK already guaranteed every historical row, while a
-- NOT VALID CHECK still protects all new writes. A separate maintenance window
-- can validate it without extending this migration's ACCESS EXCLUSIVE lock.

-- Keep the aggregate exact in the same transaction as each queue mutation.
-- Statement-level transition tables make this one job-row update per batch,
-- rather than one update per domain, and avoid repeated full/index recounts.
CREATE OR REPLACE FUNCTION public.sync_large_score_excluded_domains()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.large_score_jobs AS job
       SET excluded_domains = job.excluded_domains + delta.amount
      FROM (
        SELECT job_id, count(*)::bigint AS amount
          FROM new_rows
         WHERE status = 'excluded'
         GROUP BY job_id
      ) AS delta
     WHERE job.id = delta.job_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.large_score_jobs AS job
       SET excluded_domains = GREATEST(0, job.excluded_domains + delta.amount)
      FROM (
        SELECT job_id, sum(amount)::bigint AS amount
          FROM (
            SELECT job_id, -count(*)::bigint AS amount
              FROM old_rows
             WHERE status = 'excluded'
             GROUP BY job_id
            UNION ALL
            SELECT job_id, count(*)::bigint AS amount
              FROM new_rows
             WHERE status = 'excluded'
             GROUP BY job_id
          ) AS changes
         GROUP BY job_id
        HAVING sum(amount) <> 0
      ) AS delta
     WHERE job.id = delta.job_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.large_score_jobs AS job
       SET excluded_domains = GREATEST(0, job.excluded_domains - delta.amount)
      FROM (
        SELECT job_id, count(*)::bigint AS amount
          FROM old_rows
         WHERE status = 'excluded'
         GROUP BY job_id
      ) AS delta
     WHERE job.id = delta.job_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS large_score_excluded_after_insert ON public.large_score_domains;
CREATE TRIGGER large_score_excluded_after_insert
AFTER INSERT ON public.large_score_domains
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_large_score_excluded_domains();

DROP TRIGGER IF EXISTS large_score_excluded_after_update ON public.large_score_domains;
CREATE TRIGGER large_score_excluded_after_update
AFTER UPDATE ON public.large_score_domains
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_large_score_excluded_domains();

DROP TRIGGER IF EXISTS large_score_excluded_after_delete ON public.large_score_domains;
CREATE TRIGGER large_score_excluded_after_delete
AFTER DELETE ON public.large_score_domains
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_large_score_excluded_domains();

COMMENT ON FUNCTION public.sync_large_score_excluded_domains() IS
  'Maintains restart-safe excluded-domain counters atomically for large-score queue batches.';
