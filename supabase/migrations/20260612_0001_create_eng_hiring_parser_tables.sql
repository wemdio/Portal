-- ENG Hiring parser: cache-first vacancy collection for English-speaking markets.
-- The shared cache is written by service workers; user-visible rows are copied
-- into eng_hiring_vacancies per parser_jobs row (parser_type = 'eng_hiring').

create table if not exists public.eng_hiring_cache (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee')),
  source_company_slug text not null,
  source_job_id text not null,
  company_name text not null,
  company_site_url text,
  company_description text,
  vacancy_title text not null,
  vacancy_description text,
  vacancy_url text not null,
  careers_url text,
  location text,
  city text,
  country text,
  country_code text,
  salary_from integer,
  salary_to integer,
  salary_currency text,
  published_at timestamp with time zone,
  raw jsonb not null default '{}'::jsonb,
  last_seen_at timestamp with time zone not null default now(),
  cache_fetched_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists idx_eng_hiring_cache_source_job_unique
  on public.eng_hiring_cache(source, source_job_id);

create index if not exists idx_eng_hiring_cache_source_fetched
  on public.eng_hiring_cache(source, cache_fetched_at desc);

create index if not exists idx_eng_hiring_cache_country_published
  on public.eng_hiring_cache(country_code, published_at desc);

create table if not exists public.eng_hiring_cache_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee')),
  companies_limit integer not null default 0,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  scanned_companies integer not null default 0,
  cached_vacancies integer not null default 0,
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_eng_hiring_cache_runs_fresh
  on public.eng_hiring_cache_runs(source, companies_limit, completed_at desc)
  where status = 'completed';

create table if not exists public.eng_hiring_vacancies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  cache_id uuid references public.eng_hiring_cache(id) on delete set null,
  source text not null check (source in ('greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee')),
  source_company_slug text not null,
  source_job_id text not null,
  company_name text not null,
  company_site_url text,
  company_description text,
  vacancy_title text not null,
  vacancy_description text,
  vacancy_url text not null,
  careers_url text,
  location text,
  city text,
  country text,
  country_code text,
  salary_from integer,
  salary_to integer,
  salary_currency text,
  published_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_eng_hiring_vacancies_job_source_job_unique
  on public.eng_hiring_vacancies(job_id, source, source_job_id);

create index if not exists idx_eng_hiring_vacancies_job_id
  on public.eng_hiring_vacancies(job_id);

alter table public.eng_hiring_cache enable row level security;
alter table public.eng_hiring_cache_runs enable row level security;
alter table public.eng_hiring_vacancies enable row level security;

drop policy if exists eng_hiring_cache_service_only on public.eng_hiring_cache;
create policy eng_hiring_cache_service_only
  on public.eng_hiring_cache
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists eng_hiring_cache_runs_service_only on public.eng_hiring_cache_runs;
create policy eng_hiring_cache_runs_service_only
  on public.eng_hiring_cache_runs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists eng_hiring_vacancies_select_own_job on public.eng_hiring_vacancies;
create policy eng_hiring_vacancies_select_own_job
  on public.eng_hiring_vacancies
  for select
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = eng_hiring_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists eng_hiring_vacancies_insert_own_job on public.eng_hiring_vacancies;
create policy eng_hiring_vacancies_insert_own_job
  on public.eng_hiring_vacancies
  for insert
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = eng_hiring_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists eng_hiring_vacancies_update_own_job on public.eng_hiring_vacancies;
create policy eng_hiring_vacancies_update_own_job
  on public.eng_hiring_vacancies
  for update
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = eng_hiring_vacancies.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = eng_hiring_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists eng_hiring_vacancies_delete_own_job on public.eng_hiring_vacancies;
create policy eng_hiring_vacancies_delete_own_job
  on public.eng_hiring_vacancies
  for delete
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = eng_hiring_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

grant all on public.eng_hiring_cache to service_role;
grant all on public.eng_hiring_cache_runs to service_role;
grant all on public.eng_hiring_vacancies to service_role;
grant select, insert, update, delete on public.eng_hiring_vacancies to authenticated;
