-- Background-job tracking for the event-outreach collect pipeline.
-- The collect endpoint inserts a 'running' row and returns immediately;
-- the pipeline runs in the background and updates this row on finish.

CREATE TABLE IF NOT EXISTS public.event_outreach_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running',
  params jsonb,
  stats jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE public.event_outreach_jobs IS
  'Event-outreach tool: one row per collect run (status running/completed/failed + result stats).';

CREATE INDEX IF NOT EXISTS event_outreach_jobs_created_idx ON public.event_outreach_jobs (created_at DESC);

-- GRANT: the pipeline reaches the DB only via the service role.
grant all on public.event_outreach_jobs to service_role, postgres;

-- RLS on with no policies: clients have no direct access; service role bypasses RLS.
alter table public.event_outreach_jobs enable row level security;
