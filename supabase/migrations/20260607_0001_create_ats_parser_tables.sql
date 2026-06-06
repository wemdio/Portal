-- ATS (Greenhouse/Lever/Ashby) parser results table.
-- Reuses the shared public.parser_jobs queue (parser_type = 'ats_companies');
-- this migration only adds the per-company results table + RLS, mirroring the
-- hh_vacancies ownership model (see 20260128_0001_create_hh_parser_tables.sql).

create table if not exists public.ats_companies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  company text not null,
  domain text,
  ats text not null,
  slug text not null,
  country text,
  cities text[] not null default '{}'::text[],
  roles_found text[] not null default '{}'::text[],
  job_count integer not null default 0,
  job_titles text[] not null default '{}'::text[],
  job_urls text[] not null default '{}'::text[],
  careers_url text,
  latest_posted_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_ats_companies_job_ats_slug_unique
  on public.ats_companies(job_id, ats, slug);

create index if not exists idx_ats_companies_job_id
  on public.ats_companies(job_id);

-- RLS: rows are readable/writable only through the owning parser_jobs row.
alter table public.ats_companies enable row level security;

drop policy if exists ats_companies_select_own_job on public.ats_companies;
create policy ats_companies_select_own_job
  on public.ats_companies
  for select
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = ats_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists ats_companies_insert_own_job on public.ats_companies;
create policy ats_companies_insert_own_job
  on public.ats_companies
  for insert
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = ats_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists ats_companies_update_own_job on public.ats_companies;
create policy ats_companies_update_own_job
  on public.ats_companies
  for update
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = ats_companies.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = ats_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists ats_companies_delete_own_job on public.ats_companies;
create policy ats_companies_delete_own_job
  on public.ats_companies
  for delete
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = ats_companies.job_id
        and j.user_id = auth.uid()
    )
  );
