
-- Search Parser jobs table
create table if not exists public.search_parser_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed')),
  config jsonb not null default '{}'::jsonb, -- { queries: string[] }
  total_queries integer default 0,
  processed_queries integer default 0,
  total_results integer default 0,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

-- Search results table
create table if not exists public.search_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.search_parser_jobs(id) on delete cascade,
  query text not null,
  title text,
  link text,
  snippet text,
  position integer,
  created_at timestamp with time zone not null default now()
);

-- Indexes
create index if not exists idx_search_results_job_id on public.search_results(job_id);

-- RLS
alter table public.search_parser_jobs enable row level security;
alter table public.search_results enable row level security;

-- Policies for jobs
drop policy if exists search_parser_jobs_select_own on public.search_parser_jobs;
create policy search_parser_jobs_select_own
  on public.search_parser_jobs for select
  using (auth.uid() = user_id);

drop policy if exists search_parser_jobs_insert_own on public.search_parser_jobs;
create policy search_parser_jobs_insert_own
  on public.search_parser_jobs for insert
  with check (auth.uid() = user_id);

drop policy if exists search_parser_jobs_update_own on public.search_parser_jobs;
create policy search_parser_jobs_update_own
  on public.search_parser_jobs for update
  using (auth.uid() = user_id);

drop policy if exists search_parser_jobs_delete_own on public.search_parser_jobs;
create policy search_parser_jobs_delete_own
  on public.search_parser_jobs for delete
  using (auth.uid() = user_id);

-- Policies for results (access via job ownership)
drop policy if exists search_results_select_own_job on public.search_results;
create policy search_results_select_own_job
  on public.search_results for select
  using (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_results.job_id
      and j.user_id = auth.uid()
    )
  );

drop policy if exists search_results_insert_own_job on public.search_results;
create policy search_results_insert_own_job
  on public.search_results for insert
  with check (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_results.job_id
      and j.user_id = auth.uid()
    )
  );

drop policy if exists search_results_delete_own_job on public.search_results;
create policy search_results_delete_own_job
  on public.search_results for delete
  using (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_results.job_id
      and j.user_id = auth.uid()
    )
  );
