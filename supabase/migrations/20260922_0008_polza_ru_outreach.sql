-- «Наш автоаутрич» (parser_type='polza_ru_outreach'): русский сигнальный аутрич
-- Polza по трём офферам — найм SDR, автоматизация аутрича, сигналы.
--
-- polza_ru_outreach_companies — журнал запуска: строка на компанию, отсеянные
-- строки остаются с этапом и причиной (по ним считается воронка). Готовые
-- строки (row_status='ready') — это и есть «выгруженные» компании: по ним
-- следующий запуск любого оффера отсекает повторы.
--
-- Библиотеки (офферы, кейсы, подписи) — versioned-данные, которые генератор
-- берёт как есть. Неутверждённая или истёкшая запись для генератора не
-- существует. Сигнальные загрузки — каталоги выставок и выгрузки госконтрактов
-- из ЕИС: у этих источников нет доступного API, поэтому оператор кладёт файл.

create table if not exists public.polza_ru_outreach_companies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  profile_code text not null
    check (profile_code in ('sdr_hiring_v1', 'automated_outreach_v1', 'signals_v1')),

  -- источник
  source_type text not null,
  source_record_id text,
  source_url text,
  source_urls text[] not null default '{}',

  -- компания
  company_name text not null,
  company_brand text,
  inn text,
  normalized_domain text,
  company_website text,
  hh_employer_id text,
  crm_lead_id bigint,

  -- отношения (только по AMO)
  prior_contact boolean not null default false,
  prior_contact_date timestamptz,

  -- сигнал и доказательство
  signal_type text,
  signal_date timestamptz,
  signal_title text,
  evidence_quote text,
  evidence_level text check (evidence_level in ('A', 'B', 'C', 'NONE')),
  market_evidence_quote text,
  target_market text,
  signals jsonb not null default '[]'::jsonb,
  fit_reasons jsonb not null default '[]'::jsonb,
  signal_score integer,
  generation_mode text,

  -- адресат
  recipient_email text,
  email_type text,
  email_source_url text,
  recipient_role text,
  is_routing boolean,

  -- письма и версии библиотек
  letters jsonb,
  subject_b text,
  case_id text,
  offer_version text,
  offer_claim_ids text[] not null default '{}',
  sender_id uuid,
  template_version text,

  -- QA и конвейер
  qa_status text check (qa_status in ('passed', 'failed')),
  qa_flags text[] not null default '{}',
  row_status text not null default 'processing'
    check (row_status in ('processing', 'ready', 'rejected', 'manual_review', 'failed')),
  pipeline_stage text,
  reason_code text,
  reason_detail text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_polza_ru_outreach_job on public.polza_ru_outreach_companies(job_id);
create index if not exists idx_polza_ru_outreach_ready_domain
  on public.polza_ru_outreach_companies(normalized_domain) where row_status = 'ready';
create index if not exists idx_polza_ru_outreach_ready_inn
  on public.polza_ru_outreach_companies(inn) where row_status = 'ready';

alter table public.polza_ru_outreach_companies enable row level security;

-- Рабочий пишет через service_role; пользователь видит строки своих задач.
drop policy if exists polza_ru_outreach_companies_own_job on public.polza_ru_outreach_companies;
create policy polza_ru_outreach_companies_own_job
  on public.polza_ru_outreach_companies
  for all
  using (
    exists (
      select 1 from public.parser_jobs j
      where j.id = polza_ru_outreach_companies.job_id and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.parser_jobs j
      where j.id = polza_ru_outreach_companies.job_id and j.user_id = auth.uid()
    )
  );

grant all on public.polza_ru_outreach_companies to service_role;
grant select, insert, update, delete on public.polza_ru_outreach_companies to authenticated;

-- ── Утверждённые коммерческие утверждения оффера ────────────────────────────
create table if not exists public.polza_ru_offer_claims (
  id uuid primary key default gen_random_uuid(),
  profile_code text not null
    check (profile_code in ('sdr_hiring_v1', 'automated_outreach_v1', 'signals_v1', 'all')),
  claim_key text not null,
  claim_text text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'expired')),
  approved_at timestamptz,
  expires_at timestamptz,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Библиотека кейсов (CASE_LIBRARY_INPUT_TEMPLATE) ─────────────────────────
create table if not exists public.polza_ru_cases (
  id uuid primary key default gen_random_uuid(),
  case_id text not null unique,
  public_name text not null,
  client_name_internal text,
  anonymization_required boolean not null default false,
  industry_tags text[] not null default '{}',
  product_tags text[] not null default '{}',
  sales_model_tags text[] not null default '{}',
  geography_tags text[] not null default '{}',
  allowed_profiles text[] not null default '{}',
  case_text_short text not null,
  case_text_long text,
  metrics jsonb not null default '[]'::jsonb,
  source_file_or_url text,
  source_location text,
  verified_at timestamptz,
  verified_by text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'expired')),
  expires_at timestamptz,
  legal_publication_approved boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Подписи отправителей ────────────────────────────────────────────────────
create table if not exists public.polza_ru_senders (
  id uuid primary key default gen_random_uuid(),
  sender_name text not null,
  sender_title text,
  company_name text not null default 'Polza Agency',
  phone text,
  website text,
  telegram text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.polza_ru_senders (sender_name, sender_title, company_name, phone, website, telegram, status, is_default)
select 'Егор', 'Коммерческий директор', 'Polza Agency', '+7 (495) 120-29-71', 'https://polzaagency.ru', '@ROP_PolzaAgency', 'active', true
where not exists (select 1 from public.polza_ru_senders);

-- ── Загруженные файлы сигналов: каталоги выставок и выгрузки контрактов ─────
create table if not exists public.polza_ru_signal_uploads (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('exhibitors', 'contracts')),
  title text not null,
  event_start date,
  event_end date,
  official_url text,
  catalog_year integer,
  file_name text,
  rows_total integer not null default 0,
  uploaded_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.polza_ru_signal_rows (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.polza_ru_signal_uploads(id) on delete cascade,
  kind text not null check (kind in ('exhibitors', 'contracts')),
  company_name text not null,
  company_website text,
  inn text,
  -- выставка: стенд/категория; контракт: номер/предмет/сумма/заказчик
  details jsonb not null default '{}'::jsonb,
  record_url text,
  record_date date,
  created_at timestamptz not null default now()
);

create index if not exists idx_polza_ru_signal_rows_upload on public.polza_ru_signal_rows(upload_id);
create index if not exists idx_polza_ru_signal_rows_kind_date on public.polza_ru_signal_rows(kind, record_date);

-- Библиотеки и загрузки общие для всех операторов инструмента.
alter table public.polza_ru_offer_claims enable row level security;
alter table public.polza_ru_cases enable row level security;
alter table public.polza_ru_senders enable row level security;
alter table public.polza_ru_signal_uploads enable row level security;
alter table public.polza_ru_signal_rows enable row level security;

drop policy if exists polza_ru_offer_claims_authenticated on public.polza_ru_offer_claims;
create policy polza_ru_offer_claims_authenticated on public.polza_ru_offer_claims
  for all to authenticated using (true) with check (true);
drop policy if exists polza_ru_cases_authenticated on public.polza_ru_cases;
create policy polza_ru_cases_authenticated on public.polza_ru_cases
  for all to authenticated using (true) with check (true);
drop policy if exists polza_ru_senders_authenticated on public.polza_ru_senders;
create policy polza_ru_senders_authenticated on public.polza_ru_senders
  for all to authenticated using (true) with check (true);
drop policy if exists polza_ru_signal_uploads_authenticated on public.polza_ru_signal_uploads;
create policy polza_ru_signal_uploads_authenticated on public.polza_ru_signal_uploads
  for all to authenticated using (true) with check (true);
drop policy if exists polza_ru_signal_rows_authenticated on public.polza_ru_signal_rows;
create policy polza_ru_signal_rows_authenticated on public.polza_ru_signal_rows
  for all to authenticated using (true) with check (true);

grant all on public.polza_ru_offer_claims to service_role;
grant all on public.polza_ru_cases to service_role;
grant all on public.polza_ru_senders to service_role;
grant all on public.polza_ru_signal_uploads to service_role;
grant all on public.polza_ru_signal_rows to service_role;
grant select, insert, update, delete on public.polza_ru_offer_claims to authenticated;
grant select, insert, update, delete on public.polza_ru_cases to authenticated;
grant select, insert, update, delete on public.polza_ru_senders to authenticated;
grant select, insert, update, delete on public.polza_ru_signal_uploads to authenticated;
grant select, insert, update, delete on public.polza_ru_signal_rows to authenticated;

-- ── Кандидаты из hh_vacancies одним запросом на запуск ──────────────────────
-- В hh_vacancies ~4,4 млн строк почти целиком за последние недели, индекс по
-- дате не сужает выборку, а регэксп по названию — это полный проход (~30 с на
-- замере 22.09.2026). Поэтому раннер зовёт функцию один раз в начале запуска
-- и режет результат на волны в памяти, а не листает таблицу страницами.
-- Одна строка = работодатель; вакансии внутри — свежие первыми, дубли
-- vacancy_id (одна вакансия в нескольких задачах парсера) схлопнуты.
create or replace function public.polza_ru_hh_employers(
  p_pattern text,
  p_since timestamptz,
  p_min_vacancies integer default 1
)
returns table (
  employer_key text,
  employer_id text,
  company_name text,
  company_site_url text,
  vacancy_count integer,
  latest_published_at timestamptz,
  vacancies jsonb
)
language sql
stable
set statement_timeout = '110s'
as $$
  with v as (
    select distinct on (h.vacancy_id)
      h.vacancy_id, h.name, h.url, h.published_at, h.employer_id, h.company_name,
      nullif(h.company_site_url, '') as company_site_url
    from public.hh_vacancies h
    where h.published_at >= p_since
      and h.name ~* p_pattern
      and h.company_name is not null
    order by h.vacancy_id, h.created_at desc
  ), g as (
    select
      coalesce(nullif(v.employer_id, ''), lower(v.company_name)) as employer_key,
      max(v.employer_id) as employer_id,
      max(v.company_name) as company_name,
      max(v.company_site_url) as company_site_url,
      count(*)::integer as vacancy_count,
      max(v.published_at) as latest_published_at,
      (jsonb_agg(
        jsonb_build_object('vacancy_id', v.vacancy_id, 'name', v.name, 'url', v.url, 'published_at', v.published_at)
        order by v.published_at desc
      ) -> 0) as freshest,
      jsonb_agg(
        jsonb_build_object('vacancy_id', v.vacancy_id, 'name', v.name, 'url', v.url, 'published_at', v.published_at)
        order by v.published_at desc
      ) as all_vacancies
    from v
    group by 1
  )
  select g.employer_key, g.employer_id, g.company_name, g.company_site_url, g.vacancy_count,
         g.latest_published_at,
         (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
            select e from jsonb_array_elements(g.all_vacancies) e limit 10
          ) s) as vacancies
  from g
  where g.vacancy_count >= greatest(1, p_min_vacancies)
  order by g.latest_published_at desc;
$$;

revoke all on function public.polza_ru_hh_employers(text, timestamptz, integer) from public;
grant execute on function public.polza_ru_hh_employers(text, timestamptz, integer) to service_role;
