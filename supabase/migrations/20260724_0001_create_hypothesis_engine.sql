-- Hypothesis Engine (Движок вертикалей): сайт клиента → гипотезы вертикалей
-- с доказательствами → цепочки писем, вокабуляр и шаблоны 85/15.
--
-- Пайплайн (см. app/worker/hypothesisEngine.ts):
-- 1. POST /api/tools/hypothesis-engine/projects → he_projects + he_jobs enqueue
-- 2. Воркер claims job (stage) → выполняет стадию → done/failed
-- 3. Стадии: site_profile → competitors → brand_cloud → hypotheses → evidence
--    → clustering (he_hypotheses, he_verticals)
-- 4. Дальше на вертикаль: chain (he_chains), vocab (he_vocab);
--    на загруженную базу: base_analyze → template (he_bases, he_templates)
--
-- Отдельный инструмент от существующих «Гипотез» (/tools/sales-hypotheses) —
-- те про сбор базы, этот про рынки/вертикали. Префикс таблиц he_.
-- Токены и стоимость LLM-вызовов агрегируются в tokens_used / cost_usd.

-- ─── 1. he_projects ──────────────────────────────────────────────────────
-- Проект исследования: один сайт клиента → один прогон research-пайплайна.

create table if not exists public.he_projects (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid,
  name        text not null,
  website_url text not null,
  brief       jsonb,                          -- снапшот автобрифа (clientBrief/autofill)
  status      text not null default 'draft'
    check (status in ('draft','researching','researched','failed')),
  error       text,
  llm_model   text,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.he_projects is
  'Проекты Движка вертикалей: сайт клиента + бриф → research-пайплайн гипотез.';

-- ─── 2. he_jobs ──────────────────────────────────────────────────────────
-- Очередь стадий воркера по паттерну sales_ai_analysis_jobs.

create table if not exists public.he_jobs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.he_projects(id) on delete cascade,
  stage       text not null
    check (stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','chain','vocab','base_analyze','template')),
  status      text not null default 'pending'
    check (status in ('pending','running','done','failed')),
  payload     jsonb not null default '{}',    -- вход стадии (vertical_id, base_id и т.п.)
  result      jsonb,
  error       text,
  attempts    integer not null default 0,
  started_at  timestamptz,
  finished_at timestamptz,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_he_jobs_pending
  on public.he_jobs(status) where status = 'pending';
create index if not exists idx_he_jobs_project_stage
  on public.he_jobs(project_id, stage);

comment on table public.he_jobs is
  'Очередь стадий Hypothesis Engine. payload/result — вход и выход конкретной стадии.';

-- ─── 3. he_hypotheses ────────────────────────────────────────────────────
-- Сырые гипотезы вертикалей с доказательствами. vertical_id проставляется
-- после кластеризации (стадия clustering), FK добавляется ниже — после
-- создания he_verticals.

create table if not exists public.he_hypotheses (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.he_projects(id) on delete cascade,
  vertical_id   uuid,                          -- fk на he_verticals добавляется ниже
  tier          smallint not null check (tier between 1 and 3),
  title         text not null,
  description   text,
  evidence      jsonb not null default '[]',   -- [{claim, source_url, quote}]
  potential_pct smallint not null default 0 check (potential_pct between 0 and 100),
  status        text not null default 'proposed'
    check (status in ('proposed','accepted','rejected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_he_hypotheses_project
  on public.he_hypotheses(project_id);

comment on table public.he_hypotheses is
  'Гипотезы рынков/вертикалей (tier 1-3) с массивом доказательств и процентовкой потенциала.';

-- ─── 4. he_verticals ─────────────────────────────────────────────────────
-- Чистые вертикали после схлопывания синонимов (стадия clustering).

create table if not exists public.he_verticals (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.he_projects(id) on delete cascade,
  name          text not null,
  summary       text,
  synonyms      jsonb not null default '[]',   -- схлопнутые названия/синонимы
  potential_pct smallint not null default 0 check (potential_pct between 0 and 100),
  rank          integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_he_verticals_project
  on public.he_verticals(project_id);

comment on table public.he_verticals is
  'Вертикали после кластеризации гипотез: каноническое имя + синонимы + ранжирование по %.';

alter table public.he_hypotheses
  drop constraint if exists he_hypotheses_vertical_id_fkey;
alter table public.he_hypotheses
  add constraint he_hypotheses_vertical_id_fkey
  foreign key (vertical_id) references public.he_verticals(id) on delete set null;

-- ─── 5. he_chains ────────────────────────────────────────────────────────
-- Цепочки писем под вертикаль (стадия chain, регламент instantly-email-patterns).

create table if not exists public.he_chains (
  id          uuid primary key default gen_random_uuid(),
  vertical_id uuid not null references public.he_verticals(id) on delete cascade,
  language    text not null default 'ru',
  letters     jsonb not null default '[]',     -- [{subject, body, wait_days, variants[]}]
  status      text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model   text,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_he_chains_vertical
  on public.he_chains(vertical_id);

comment on table public.he_chains is
  'Цепочки писем под вертикаль: массив писем с вариантами, RU/EN/PL.';

-- ─── 6. he_vocab ─────────────────────────────────────────────────────────
-- Матрица вокабуляра вертикали: типы компаний × должности × поисковые запросы.

create table if not exists public.he_vocab (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    uuid not null references public.he_verticals(id) on delete cascade,
  company_types  jsonb not null default '[]',  -- [{term, kind, geo, notes}]
  job_titles     jsonb not null default '[]',  -- [{title, seniority, function, geo, alt_names[]}]
  search_queries jsonb not null default '[]',  -- готовые запросы под источники (HH/LinkedIn/карты)
  status         text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model      text,
  tokens_used    bigint not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_he_vocab_vertical
  on public.he_vocab(vertical_id);

comment on table public.he_vocab is
  'Вокабуляр вертикали: все варианты типов компаний и целевых должностей + поисковые запросы.';

-- ─── 7. he_bases ─────────────────────────────────────────────────────────
-- Загруженные специалистом базы под гипотезу. data — сами строки (jsonb),
-- как у base_constructor_jobs.data.

create table if not exists public.he_bases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.he_projects(id) on delete cascade,
  vertical_id uuid not null references public.he_verticals(id) on delete cascade,
  filename    text,
  row_count   integer not null default 0,
  columns     jsonb not null default '[]',
  sample_rows jsonb not null default '[]',
  data        jsonb not null default '[]',
  status      text not null default 'uploaded'
    check (status in ('uploaded','analyzing','analyzed','failed')),
  analysis    jsonb,                           -- профиль базы: гео/индустрии/должности/типы компаний
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_he_bases_project
  on public.he_bases(project_id);
create index if not exists idx_he_bases_vertical
  on public.he_bases(vertical_id);

comment on table public.he_bases is
  'Базы специалиста под вертикаль: строки jsonb + AI-профиль базы (стадия base_analyze).';

-- ─── 8. he_templates ─────────────────────────────────────────────────────
-- Финальный шаблон 85/15: фиксированный блок от гипотезы + план
-- персонализации под конкретную загруженную базу.

create table if not exists public.he_templates (
  id                   uuid primary key default gen_random_uuid(),
  base_id              uuid not null references public.he_bases(id) on delete cascade,
  vertical_id          uuid not null references public.he_verticals(id) on delete cascade,
  fixed_block          text,                     -- ~85%: фиксированный текст под гипотезу
  personalization_plan jsonb not null default '{}', -- ~15%: операторы/переменные по письмам
  letters              jsonb not null default '[]',   -- финальные письма
  status               text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model            text,
  tokens_used          bigint not null default 0,
  cost_usd             numeric(12,6) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_he_templates_base
  on public.he_templates(base_id);
create index if not exists idx_he_templates_vertical
  on public.he_templates(vertical_id);

comment on table public.he_templates is
  'Шаблон 85/15: фиксированный блок под гипотезу + план персонализации под загруженную базу.';

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table public.he_projects    enable row level security;
alter table public.he_jobs        enable row level security;
alter table public.he_hypotheses  enable row level security;
alter table public.he_verticals   enable row level security;
alter table public.he_chains      enable row level security;
alter table public.he_vocab       enable row level security;
alter table public.he_bases       enable row level security;
alter table public.he_templates   enable row level security;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'he_projects','he_jobs','he_hypotheses','he_verticals',
    'he_chains','he_vocab','he_bases','he_templates'
  ] loop
    execute format('drop policy if exists %I_select_auth on public.%I', tbl, tbl);
    execute format(
      'create policy %I_select_auth on public.%I for select using (auth.uid() is not null)',
      tbl, tbl
    );
  end loop;
end$$;

-- ─── Grants ─────────────────────────────────────────────────────────────

grant all on public.he_projects   to service_role, postgres;
grant all on public.he_jobs       to service_role, postgres;
grant all on public.he_hypotheses to service_role, postgres;
grant all on public.he_verticals  to service_role, postgres;
grant all on public.he_chains     to service_role, postgres;
grant all on public.he_vocab      to service_role, postgres;
grant all on public.he_bases      to service_role, postgres;
grant all on public.he_templates  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_projects, public.he_jobs, public.he_hypotheses, public.he_verticals, public.he_chains, public.he_vocab, public.he_bases, public.he_templates to readonly';
  end if;
end $$;
