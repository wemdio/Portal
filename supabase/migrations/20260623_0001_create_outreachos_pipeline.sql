-- OutreachOS daily pipeline — ИЗОЛИРОВАННЫЙ от Mailganer self-outreach пайплайн.
--
-- Зачем отдельные таблицы, а не client_auto_pipeline_*: тот стек завязан на
-- Mailganer-скоринг (endpoint_score/spf/raw, status routed/stored, score_buckets).
-- OutreachOS принципиально БЕЗ скоринга и БЕЗ касания Mailganer — поэтому свой
-- минимальный набор таблиц. Поток: HH(ICP-индустрии) → конструктор баз (чистка/
-- валидация, без ta_scoring/personalization) → добор в одну готовую кампанию Instantly.
--
-- НИ ОДНОЙ Mailganer-формы колонок здесь нет — изоляция гарантирована структурно.

-- ── 1. Журнал виденных работодателей (дедуп между днями) ──────────────────
-- Без endpoint_score/spf/raw. Ключ — hh_employer_id (числовой id HH).
-- Дедуп по Instantly-стороне делает skip_if_in_campaign, но эта таблица не даёт
-- зря пере-скрейпить/пере-валидировать тех же работодателей каждую ночь
-- (экономит бюджет конструктора баз и SMTP-проверок).
create table if not exists public.outreachos_seen_employers (
  hh_employer_id text primary key,
  hh_employer_name text,
  domain text,
  site_url text,
  status text not null default 'appended'
    check (status in ('appended', 'skipped', 'failed', 'no_email')),
  first_seen_at timestamptz not null default now(),
  last_status_at timestamptz not null default now()
);

create index if not exists idx_outreachos_seen_domain
  on public.outreachos_seen_employers(domain);

comment on table public.outreachos_seen_employers is
  'OutreachOS дедуп-журнал работодателей HH. Изолирован от client_auto_pipeline_seen_employers и от mailganer_*. Никакого скоринга.';

-- ── 2. Конфиг прогона (singleton, id=1) ───────────────────────────────────
-- Правится без деплоя. campaign_id — ОДНА заранее созданная кампания Instantly,
-- куда каждый день доливаются новые контакты (никаких score-bucket'ов).
create table if not exists public.outreachos_pipeline_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- measure_only добавлен отдельной миграцией 20260623_0002 (0001 был применён
  -- на проде до появления колонки).
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  campaign_id text,                                  -- NULL пока кампания не создана в Instantly
  industries text[] not null default '{}',           -- HH top-level industry id (см. lib/jobs/hhIndustries)
  area text not null default '113',                  -- 113 = Россия
  window_hours int not null default 24,
  max_employees int,                                 -- отсекать гигантов (NULL = без отсечки)
  daily_limit int not null default 2000,             -- потолок работодателей за прогон
  selected_steps text[] not null default array[
    'remove_empty','dedup_full','check_sites','find_emails','split_emails',
    'remove_support_emails','dedup_email','validate_emails','clean_names'
  ],                                                 -- БЕЗ ta_scoring / personalization
  extra_exclude text[] not null default '{}',        -- доп. regex-исключения имён сверх встроенных федеральных
  job_poll_timeout_minutes int not null default 180, -- сколько ждать завершения base_constructor_job
  updated_at timestamptz not null default now()
);

comment on table public.outreachos_pipeline_config is
  'OutreachOS singleton-конфиг (id=1). Mailganer/скоринг не используется. selected_steps НЕ содержит ta_scoring и personalization.';
comment on column public.outreachos_pipeline_config.campaign_id is
  'Фиксированная кампания Instantly для ежедневного добора. NULL → cron пропускает прогон с понятным логом.';

-- ── 3. Журнал прогонов (честный лог воронки) ──────────────────────────────
create table if not exists public.outreachos_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  parsed int,            -- сколько работодателей вернул HH
  after_icp int,         -- осталось после exclude/size фильтра
  new_employers int,     -- новых (не в seen)
  base_job_id uuid,      -- id base_constructor_jobs
  valid_contacts int,    -- валидных контактов на выходе конструктора
  appended int,          -- принято Instantly
  skipped int,           -- отсев (блок-лист / дубли / лимит)
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  error_message text
);

create index if not exists idx_outreachos_runs_started
  on public.outreachos_pipeline_runs(started_at desc);

-- ── RLS: только service_role (внутренний аккаунт, клиентского доступа нет) ──
alter table public.outreachos_seen_employers enable row level security;
alter table public.outreachos_pipeline_config enable row level security;
alter table public.outreachos_pipeline_runs enable row level security;

drop policy if exists "service role full access on outreachos_seen_employers" on public.outreachos_seen_employers;
create policy "service role full access on outreachos_seen_employers"
  on public.outreachos_seen_employers for all using (true) with check (true);

drop policy if exists "service role full access on outreachos_pipeline_config" on public.outreachos_pipeline_config;
create policy "service role full access on outreachos_pipeline_config"
  on public.outreachos_pipeline_config for all using (true) with check (true);

drop policy if exists "service role full access on outreachos_pipeline_runs" on public.outreachos_pipeline_runs;
create policy "service role full access on outreachos_pipeline_runs"
  on public.outreachos_pipeline_runs for all using (true) with check (true);

grant all on public.outreachos_seen_employers to service_role, postgres;
grant all on public.outreachos_pipeline_config to service_role, postgres;
grant all on public.outreachos_pipeline_runs to service_role, postgres;
