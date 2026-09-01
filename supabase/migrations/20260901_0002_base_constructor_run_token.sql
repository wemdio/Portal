-- Fence Base Constructor writes to the worker invocation that most recently
-- claimed the job. During a rolling deploy the old container can keep running
-- for a few seconds after a replacement has reclaimed the same row; status
-- alone cannot distinguish those two owners.
alter table public.base_constructor_jobs
  add column if not exists run_token uuid;

comment on column public.base_constructor_jobs.run_token is
  'Fresh ownership token assigned on every worker claim; all runner writes are fenced by it.';
