-- Track pipeline progress independently of SSE connection
ALTER TABLE public.reputation_jobs
  ADD COLUMN IF NOT EXISTS progress_stage text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ymaps_job_id uuid;
