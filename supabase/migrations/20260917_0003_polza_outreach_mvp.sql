-- Polza ENG outreach MVP: результат конвейера SDR-вакансия → домен → ICP →
-- LLM-разбор → корпоративная почта → цепочка писем (parser_type='polza_outreach').
-- Одна строка = одна компания; отсеянные на любой стадии строки остаются
-- в таблице со статусом excluded/needs_review и причиной — по ним считается воронка.

create table if not exists public.polza_outreach_companies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,

  -- источник
  source_type text not null default 'sdr_job',
  vacancy_id uuid references public.eng_hiring_cache(id) on delete set null,
  job_title text,
  job_source_url text,
  job_country_code text,
  job_published_at timestamptz,

  -- компания
  company_name text not null,
  normalized_domain text,
  company_website text,

  -- разбор вакансии
  outbound_mandate boolean,
  outbound_evidence text,
  service_line text,
  target_sales_geo text,
  target_sales_geo_evidence text,
  target_sales_geo_confidence text check (target_sales_geo_confidence in ('high','medium','low')),

  -- почта
  selected_company_email text,
  email_type text,
  email_source_url text,

  -- письма
  sequence_id text,
  letters jsonb,

  -- конвейер
  status text not null default 'discovered',
  stage text,
  exclusion_reason text,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_polza_outreach_job on public.polza_outreach_companies(job_id);
create index if not exists idx_polza_outreach_domain on public.polza_outreach_companies(normalized_domain);

alter table public.polza_outreach_companies enable row level security;

-- Рабочие пишут через service_role; пользователь видит только строки своих задач.
drop policy if exists polza_outreach_companies_select_own_job on public.polza_outreach_companies;
create policy polza_outreach_companies_select_own_job
  on public.polza_outreach_companies
  for select
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = polza_outreach_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists polza_outreach_companies_insert_own_job on public.polza_outreach_companies;
create policy polza_outreach_companies_insert_own_job
  on public.polza_outreach_companies
  for insert
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = polza_outreach_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists polza_outreach_companies_update_own_job on public.polza_outreach_companies;
create policy polza_outreach_companies_update_own_job
  on public.polza_outreach_companies
  for update
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = polza_outreach_companies.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = polza_outreach_companies.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists polza_outreach_companies_delete_own_job on public.polza_outreach_companies;
create policy polza_outreach_companies_delete_own_job
  on public.polza_outreach_companies
  for delete
  using (
    exists (
      select 1
      from public.parser_jobs j
      where j.id = polza_outreach_companies.job_id
        and j.user_id = auth.uid()
    )
  );

grant all on public.polza_outreach_companies to service_role;
grant select, insert, update, delete on public.polza_outreach_companies to authenticated;
