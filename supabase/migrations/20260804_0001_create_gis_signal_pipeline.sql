-- Пайплайн «2GIS + сигналы» (gisSignalOutreach) — третья изолированная аутрич-автоматизация.
--
-- Поток: 2gis_dataset (5 сегментов по рубрикам, has_website) → детекция 6 сигналов
-- по сайту (>= signal_min_count) → конструктор баз (find_emails → validate →
-- cap_emails_per_company=5) → добор в 5 заранее созданных кампаний Instantly
-- (по одной на сегмент). Реконтакт запрещён навсегда (seen по 2gis id).
--
-- Изоляция: НИ одной Mailganer/OutreachOS-формы колонок; HH здесь не используется
-- вообще — источником является 2GIS. Свои таблицы, свой конфиг, свой журнал.

-- ── 1. Сегменты (5 штук; маппинг на рубрики 2GIS правится без деплоя) ─────
create table if not exists public.gis_signal_segments (
  key text primary key,                          -- edu / remont / legal / accounting / consulting
  label text not null,
  instantly_campaign_id text,                    -- NULL пока кампания не создана в Instantly
  rubric_groups jsonb not null default '[]'::jsonb,
  -- TwoGisRubricGroup[]: [{category, includedSubcategories[], excludedSubcategories[]}]
  priority int not null default 100,             -- порядок обхода; компания попадает в ОДИН сегмент
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gis_signal_segments is
  'Сегменты пайплайна gis-signals: маппинг на рубрики 2GIS + заранее созданная кампания Instantly. Компания попадает в один сегмент (по priority).';

-- ── 2. Конфиг прогона (singleton, id=1) ───────────────────────────────────
create table if not exists public.gis_signal_pipeline_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- measure_only=true: полный прогон воронки БЕЗ заливки в Instantly и БЕЗ записи
  -- seen (неразрушающе, для калибровки маппинга рубрик и качества сигналов).
  measure_only boolean not null default true,
  client_user_id uuid references public.profiles(id) on delete cascade,
  monthly_target_companies int not null default 20000, -- цель ТЗ: ~20k компаний/мес
  daily_limit int not null default 1600,               -- потолок кандидатов за прогон (≈1000 контактов/день по конверсии тест-прогона)
  signal_min_count int not null default 1,             -- порог сигналов (ТЗ: 1; в будущем 2-3)
  selected_steps jsonb not null default
    '["remove_empty","dedup_full","find_emails","split_emails","dedup_email","validate_emails","cap_emails_per_company","clean_names"]'::jsonb,
  -- БЕЗ remove_support_emails (ТЗ: берём все почты), БЕЗ ta_scoring/personalization.
  step_config jsonb not null default
    '{"find_emails":{"stop_at_first":false,"max_per_site":8},"cap_emails_per_company":{"max":5}}'::jsonb,
  job_poll_timeout_minutes int not null default 180,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gis_signal_pipeline_config is
  'gis-signals singleton-конфиг (id=1). client_user_id — владелец дашборда и user_id для base_constructor_jobs.';

-- ── 3. Журнал виденных компаний (реконтакт ЗАПРЕЩЁН навсегда) ─────────────
-- Ключ — стабильный 2GIS id карточки. Пишется ТОЛЬКО после успешного append
-- в Instantly (at-least-once: падение до записи в Instantly не сжигает компанию).
create table if not exists public.gis_signal_seen_companies (
  twogis_id text primary key,
  domain text,
  company_name text,
  segment_key text references public.gis_signal_segments(key),
  first_seen_at timestamptz not null default now()
);

create index if not exists idx_gis_signal_seen_domain
  on public.gis_signal_seen_companies(domain);

comment on table public.gis_signal_seen_companies is
  'gis-signals дедуп-журнал по 2GIS id. Реконтакт запрещён навсегда (в отличие от 45-дневного окна OutreachOS).';

-- ── 4. Архив сигналов по каждой проверенной компании (основа «общего среза») ──
-- Пишутся ВСЕ проверенные компании — и прошедшие, и отфильтрованные: это даёт
-- клиенту срез «сегмент × сигнал» для корректировки критериев.
create table if not exists public.gis_signal_company_signals (
  id bigint generated always as identity primary key,
  twogis_id text not null,
  site text,
  segment_key text,
  signal_general_phone boolean not null default false,   -- С1 общий телефон / колл-центр
  signal_contact_form boolean not null default false,    -- С2 форма заявки / обратной связи
  signal_sales_dept boolean not null default false,      -- С3 отдел продаж / приёмная / call-центр
  signal_target_vacancy boolean not null default false,  -- С4 вакансии целевых ролей
  signal_high_volume boolean not null default false,     -- С5 признак большого потока
  signal_multi_office boolean not null default false,    -- С6 несколько офисов / филиалов
  evidence jsonb not null default '{}'::jsonb,           -- уточнения по каждому сигналу (<=200 символов)
  signals_count int not null default 0,
  note text,                                             -- 'Homepage checked' / 'Site unreachable' / ...
  checked_at timestamptz not null default now()
);

create unique index if not exists idx_gis_signal_company_signals_twogis
  on public.gis_signal_company_signals(twogis_id);
create index if not exists idx_gis_signal_company_signals_segment
  on public.gis_signal_company_signals(segment_key, signals_count desc);

comment on table public.gis_signal_company_signals is
  'gis-signals архив 6 сигналов по каждой проверенной компании (вкл. отфильтрованные) — данные для среза сегмент×сигнал.';

-- ── 5. Журнал прогонов (воронка по этапам и сегментам) ────────────────────
create table if not exists public.gis_signal_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  funnel jsonb not null default '{}'::jsonb,
  -- { perSegment: { [key]: {pulled, signalsOk, bcIn, validContacts, appended} }, total: {...} }
  error text
);

create index if not exists idx_gis_signal_runs_started
  on public.gis_signal_runs(started_at desc);

-- ── RLS: только service_role (воркеры + серверные API-роуты) ──────────────
alter table public.gis_signal_segments enable row level security;
alter table public.gis_signal_pipeline_config enable row level security;
alter table public.gis_signal_seen_companies enable row level security;
alter table public.gis_signal_company_signals enable row level security;
alter table public.gis_signal_runs enable row level security;

drop policy if exists "service role full access on gis_signal_segments" on public.gis_signal_segments;
create policy "service role full access on gis_signal_segments"
  on public.gis_signal_segments for all using (true) with check (true);

drop policy if exists "service role full access on gis_signal_pipeline_config" on public.gis_signal_pipeline_config;
create policy "service role full access on gis_signal_pipeline_config"
  on public.gis_signal_pipeline_config for all using (true) with check (true);

drop policy if exists "service role full access on gis_signal_seen_companies" on public.gis_signal_seen_companies;
create policy "service role full access on gis_signal_seen_companies"
  on public.gis_signal_seen_companies for all using (true) with check (true);

drop policy if exists "service role full access on gis_signal_company_signals" on public.gis_signal_company_signals;
create policy "service role full access on gis_signal_company_signals"
  on public.gis_signal_company_signals for all using (true) with check (true);

drop policy if exists "service role full access on gis_signal_runs" on public.gis_signal_runs;
create policy "service role full access on gis_signal_runs"
  on public.gis_signal_runs for all using (true) with check (true);

grant all on public.gis_signal_segments to service_role, postgres;
grant all on public.gis_signal_pipeline_config to service_role, postgres;
grant all on public.gis_signal_seen_companies to service_role, postgres;
grant all on public.gis_signal_company_signals to service_role, postgres;
grant all on public.gis_signal_runs to service_role, postgres;

-- ── Сиды: конфиг (enabled=false, measure_only=true — включаем после калибровки) ──
insert into public.gis_signal_pipeline_config (id) values (1)
on conflict (id) do nothing;

-- ── Сиды: 5 сегментов. Маппинг подобран по facet_categories/facet_subcategories
-- снапшота 2gis_dataset 2026-07-26. instantly_campaign_id заполняет клиент/мы
-- после создания кампаний — до этого прогон работает в measure_only.
insert into public.gis_signal_segments (key, label, priority, rubric_groups) values
('edu', 'Онлайн-образование', 10, '[
  {"category":"Образование / Работа / Карьера","includedSubcategories":[
    "Языковые школы",
    "Профессиональная переподготовка / Повышение квалификации",
    "Помощь в обучении",
    "Бизнес-тренинги",
    "Личностные тренинги",
    "Компьютерные курсы",
    "Центры дистанционного обучения",
    "Обучение бизнес-профессиям",
    "Обучение рабочим профессиям",
    "Обучение по охране труда"
  ],"excludedSubcategories":[]}
]'::jsonb),
('remont', 'Ремонт / мебель', 20, '[
  {"category":"Мебель / Материалы / Фурнитура","includedSubcategories":[
    "Корпусная мебель",
    "Мебель для кухни",
    "Мебель на заказ",
    "Мягкая мебель",
    "Мебельные магазины",
    "Детская мебель",
    "Офисная мебель",
    "Матрасы",
    "Мебель для ванных комнат",
    "Ремонт мебели"
  ],"excludedSubcategories":[]},
  {"category":"Строительство / Недвижимость / Ремонт","includedSubcategories":[
    "Ремонт помещений",
    "Ремонт зданий",
    "Дизайн интерьеров",
    "Электромонтажные работы",
    "Кровельные работы",
    "Фасадные работы"
  ],"excludedSubcategories":[]}
]'::jsonb),
('legal', 'Юридические услуги', 30, '[
  {"category":"Юридические / финансовые / бизнес-услуги","includedSubcategories":[
    "Юридические услуги",
    "Ведение дел в судах",
    "Услуги адвоката",
    "Регистрация / ликвидация предприятий",
    "Помощь в банкротстве физических лиц",
    "Патентные услуги",
    "Защита авторских прав"
  ],"excludedSubcategories":[]}
]'::jsonb),
('accounting', 'Бухгалтерские услуги', 40, '[
  {"category":"Юридические / финансовые / бизнес-услуги","includedSubcategories":[
    "Бухгалтерские услуги",
    "Аудиторские услуги"
  ],"excludedSubcategories":[]}
]'::jsonb),
('consulting', 'Консалтинговые услуги', 50, '[
  {"category":"Юридические / финансовые / бизнес-услуги","includedSubcategories":[
    "Управленческий консалтинг",
    "Финансовый консалтинг"
  ],"excludedSubcategories":[]}
]'::jsonb)
on conflict (key) do nothing;
