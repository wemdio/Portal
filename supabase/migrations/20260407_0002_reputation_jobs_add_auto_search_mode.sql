-- Add auto_search mode to reputation_jobs
ALTER TABLE public.reputation_jobs
  DROP CONSTRAINT IF EXISTS reputation_jobs_mode_check;

ALTER TABLE public.reputation_jobs
  ADD CONSTRAINT reputation_jobs_mode_check
  CHECK (mode IN ('local_reviews', 'brand_serp', 'auto_search'));
