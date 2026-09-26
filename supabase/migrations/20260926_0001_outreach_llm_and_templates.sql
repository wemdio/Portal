-- Автоаутричи RU и EN → «Рассылка» (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md):
-- кэш разбора сайта, шаблоны цепочек писем на оффер, отметки заливки строк
-- в «Рассылку» и настройки английского аутрича.

-- ── Кэш разбора сайта, 30 дней ──────────────────────────────────────────────
-- Повторный запуск не платит ИИ за ту же компанию. В ключе версия промпта и
-- модель: после правки промпта или смены модели старый разбор не подходит и
-- просто не находится, чистить руками не нужно. Срок годности проверяет тот,
-- кто читает (по created_at); индекс по created_at — чтобы чистка старых строк
-- не шла полным проходом.
create table if not exists public.polza_site_analysis_cache (
  lang text not null check (lang in ('ru', 'en')),
  domain text not null,
  prompt_version text not null,
  model text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (lang, domain, prompt_version, model)
);

create index if not exists idx_polza_site_analysis_cache_created
  on public.polza_site_analysis_cache(created_at);

-- Кэш пишет и читает только воркер (service_role), как polza_ru_fns_revenue.
alter table public.polza_site_analysis_cache enable row level security;
grant all on public.polza_site_analysis_cache to service_role;

-- ── Шаблоны цепочек писем: один на оффер запуска ────────────────────────────
-- Писатель (Gemini 3.1 Pro) пишет цепочку один раз на оффер, под компанию
-- подставляются проверенные факты. Уникальность (job_id, lang, offer_key) не
-- даёт заплатить за один оффер дважды. status: pending — пишется, ok — прошла
-- проверку, failed — не прошла и после повтора (компании оффера уходят в
-- «спорные», у оффера кнопка «Переписать цепочку»). Отдельный индекс по job_id
-- не нужен: уникальный индекс начинается с job_id и покрывает выборку запуска.
create table if not exists public.polza_chain_templates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,
  lang text not null check (lang in ('ru', 'en')),
  offer_key text not null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'failed')),
  letters jsonb,
  qa_flags text[] not null default '{}',
  model text,
  cost_usd numeric(10, 4) not null default 0,
  attempt integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, lang, offer_key)
);

alter table public.polza_chain_templates enable row level security;

-- Как у журнала запуска (20260922_0008): воркер пишет через service_role,
-- пользователь видит шаблоны своих задач.
drop policy if exists polza_chain_templates_own_job on public.polza_chain_templates;
create policy polza_chain_templates_own_job
  on public.polza_chain_templates
  for all
  using (
    exists (
      select 1 from public.parser_jobs j
      where j.id = polza_chain_templates.job_id and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.parser_jobs j
      where j.id = polza_chain_templates.job_id and j.user_id = auth.uid()
    )
  );

grant all on public.polza_chain_templates to service_role;
grant select, insert, update, delete on public.polza_chain_templates to authenticated;

-- ── Строки аутричей: шаблон цепочки и заливка в «Рассылку» ─────────────────
-- chain_template_id — по какому шаблону собраны письма строки.
-- sender_campaign_id / sender_uploaded_at — строка уже залита в рассылку:
-- повторное «Залить в Рассылку» доливает только строки без отметки.
-- Внешние ключи с on delete set null: удалили рассылку — строки запуска снова
-- можно залить; удалили шаблон (новый старт запуска удаляет его шаблоны) —
-- ссылка обнуляется, а не висит на несуществующей записи. Таблица шаблонов
-- создана выше, sender_campaigns — в 20260916_0001.
alter table public.polza_ru_outreach_companies
  add column if not exists chain_template_id uuid references public.polza_chain_templates(id) on delete set null,
  add column if not exists sender_campaign_id uuid references public.sender_campaigns(id) on delete set null,
  add column if not exists sender_uploaded_at timestamptz;

-- У английского ещё результат проверки почты: у русского колонка
-- email_verification есть с 20260922_0008, английский почту не проверял.
alter table public.polza_outreach_companies
  add column if not exists chain_template_id uuid references public.polza_chain_templates(id) on delete set null,
  add column if not exists email_verification text,
  add column if not exists sender_campaign_id uuid references public.sender_campaigns(id) on delete set null,
  add column if not exists sender_uploaded_at timestamptz;

-- Удаление рассылки или шаблона обнуляет ссылки в строках — без индекса каждое
-- такое удаление шло бы полным проходом по строкам всех запусков. Ссылка
-- заполнена у малой доли строк (готовых), поэтому индексы частичные.
create index if not exists idx_polza_ru_outreach_sender_campaign
  on public.polza_ru_outreach_companies(sender_campaign_id) where sender_campaign_id is not null;
create index if not exists idx_polza_ru_outreach_chain_template
  on public.polza_ru_outreach_companies(chain_template_id) where chain_template_id is not null;
create index if not exists idx_polza_outreach_sender_campaign
  on public.polza_outreach_companies(sender_campaign_id) where sender_campaign_id is not null;
create index if not exists idx_polza_outreach_chain_template
  on public.polza_outreach_companies(chain_template_id) where chain_template_id is not null;

-- ── Настройки английского аутрича ───────────────────────────────────────────
-- Подпись одна на аутрич: у русского она в «Библиотеках» (polza_ru_senders),
-- у английского была константой в коде (buildLetters.ts, SIGNATURE). Значение —
-- jsonb, чтобы следующая настройка не требовала миграции. Сид — та же
-- константа; on conflict не затирает подпись, которую уже поменяли на экране.
create table if not exists public.polza_outreach_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Настройки общие для всех операторов инструмента — как подписи русского
-- (polza_ru_senders): роут настроек ходит клиентом пользователя. Удалять
-- настройку с экрана нечем и незачем — delete не выдаём.
alter table public.polza_outreach_settings enable row level security;
drop policy if exists polza_outreach_settings_authenticated on public.polza_outreach_settings;
create policy polza_outreach_settings_authenticated on public.polza_outreach_settings
  for all to authenticated using (true) with check (true);
grant all on public.polza_outreach_settings to service_role;
grant select, insert, update on public.polza_outreach_settings to authenticated;

insert into public.polza_outreach_settings (key, value)
values ('signature', to_jsonb(E'Julia Mira\nAccount Manager\nPolza Agency'::text))
on conflict (key) do nothing;
