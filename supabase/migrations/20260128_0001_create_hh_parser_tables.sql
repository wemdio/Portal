-- Parser jobs table
create table if not exists public.parser_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  parser_type text not null,
  status text not null check (status in ('pending','running','completed','failed')),
  config jsonb not null default '{}'::jsonb,
  total_found integer,
  total_parsed integer,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

-- HH vacancies result table
create table if not exists public.hh_vacancies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  vacancy_id text not null,
  name text not null,
  url text not null,
  salary_from integer,
  salary_to integer,
  salary_currency text,
  company_name text not null,
  company_url text,
  company_description text,
  area text not null,
  industries text[] not null default '{}'::text[],
  published_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_hh_vacancies_job_vacancy_unique
  on public.hh_vacancies(job_id, vacancy_id);

-- RLS
alter table public.parser_jobs enable row level security;
alter table public.hh_vacancies enable row level security;

-- Jobs: owners can CRUD
drop policy if exists parser_jobs_select_own on public.parser_jobs;
create policy parser_jobs_select_own
  on public.parser_jobs
  for select
  using (auth.uid() = user_id);

drop policy if exists parser_jobs_insert_own on public.parser_jobs;
create policy parser_jobs_insert_own
  on public.parser_jobs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists parser_jobs_update_own on public.parser_jobs;
create policy parser_jobs_update_own
  on public.parser_jobs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists parser_jobs_delete_own on public.parser_jobs;
create policy parser_jobs_delete_own
  on public.parser_jobs
  for delete
  using (auth.uid() = user_id);

-- Vacancies: read/write only via owning job
drop policy if exists hh_vacancies_select_own_job on public.hh_vacancies;
create policy hh_vacancies_select_own_job
  on public.hh_vacancies
  for select
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = hh_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists hh_vacancies_insert_own_job on public.hh_vacancies;
create policy hh_vacancies_insert_own_job
  on public.hh_vacancies
  for insert
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = hh_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists hh_vacancies_update_own_job on public.hh_vacancies;
create policy hh_vacancies_update_own_job
  on public.hh_vacancies
  for update
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = hh_vacancies.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = hh_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists hh_vacancies_delete_own_job on public.hh_vacancies;
create policy hh_vacancies_delete_own_job
  on public.hh_vacancies
  for delete
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = hh_vacancies.job_id
        and j.user_id = auth.uid()
    )
  );

