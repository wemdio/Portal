-- Add retry_after column for greylisting delay
ALTER TABLE public.email_validation_queue
  ADD COLUMN IF NOT EXISTS retry_after timestamp with time zone;

-- Update claim function to skip items that are not yet ready for retry
CREATE OR REPLACE FUNCTION public.claim_email_validation_items(p_job_id uuid, p_limit integer)
RETURNS SETOF public.email_validation_queue
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id
    FROM public.email_validation_queue
    WHERE job_id = p_job_id
      AND status = 'pending'
      AND (retry_after IS NULL OR retry_after <= now())
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_validation_queue q
  SET status = 'processing',
      started_at = now(),
      updated_at = now(),
      attempt_count = q.attempt_count + 1
  FROM cte
  WHERE q.id = cte.id
  RETURNING q.*;
END;
$$;
