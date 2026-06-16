alter table if exists public.eng_hiring_cache_runs
  add column if not exists next_company_index integer not null default 0,
  add column if not exists total_companies integer not null default 0,
  add column if not exists updated_at timestamp with time zone not null default now();

create index if not exists idx_eng_hiring_cache_runs_running_resume
  on public.eng_hiring_cache_runs(source, companies_limit, started_at desc)
  where status = 'running';
