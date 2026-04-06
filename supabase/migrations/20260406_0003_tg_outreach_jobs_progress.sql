alter table public.tg_outreach_jobs
  add column if not exists progress jsonb;
