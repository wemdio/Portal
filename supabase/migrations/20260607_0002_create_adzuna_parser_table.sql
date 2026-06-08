-- Adzuna (whole-market aggregator) parser results table.
-- Reuses the shared public.parser_jobs queue (parser_type = 'adzuna_companies');
-- mirrors the ats_companies ownership model.

create table if not exists public.adzuna_companies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  company text not null,
  company_key text not null,
  domain text,
  country text,
  cities text[] not null default '{}'::text[],
  roles_found text[] not null default '{}'::text[],
  job_count integer not null default 0,
  job_titles text[] not null default '{}'::text[],
  job_urls text[] not null default '{}'::text[],
  queries text[] not null default '{}'::text[],
  latest_posted_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_adzuna_companies_job_country_key_unique
  on public.adzuna_companies(job_id, country, company_key);

create index if not exists idx_adzuna_companies_job_id
  on public.adzuna_companies(job_id);

alter table public.adzuna_companies enable row level security;

drop policy if exists adzuna_companies_select_own_job on public.adzuna_companies;
create policy adzuna_companies_select_own_job
  on public.adzuna_companies
  for select
  using (exists (select 1 from public.parser_jobs j where j.id = adzuna_companies.job_id and j.user_id = auth.uid()));

drop policy if exists adzuna_companies_insert_own_job on public.adzuna_companies;
create policy adzuna_companies_insert_own_job
  on public.adzuna_companies
  for insert
  with check (exists (select 1 from public.parser_jobs j where j.id = adzuna_companies.job_id and j.user_id = auth.uid()));

drop policy if exists adzuna_companies_update_own_job on public.adzuna_companies;
create policy adzuna_companies_update_own_job
  on public.adzuna_companies
  for update
  using (exists (select 1 from public.parser_jobs j where j.id = adzuna_companies.job_id and j.user_id = auth.uid()))
  with check (exists (select 1 from public.parser_jobs j where j.id = adzuna_companies.job_id and j.user_id = auth.uid()));

drop policy if exists adzuna_companies_delete_own_job on public.adzuna_companies;
create policy adzuna_companies_delete_own_job
  on public.adzuna_companies
  for delete
  using (exists (select 1 from public.parser_jobs j where j.id = adzuna_companies.job_id and j.user_id = auth.uid()));
