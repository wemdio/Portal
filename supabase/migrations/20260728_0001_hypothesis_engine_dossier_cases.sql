-- Hypothesis Engine (Движок вертикалей): досье вертикалей и кейсы клиента.
--
-- he_vertical_dossiers — «вертикальное досье»: объективные рыночные цифры
-- по вертикали (объём сегмента в нашей директории компаний по ОКВЭД-2,
-- открытые вакансии hh.ru, детерминированные болевые сигналы).
-- Сбор — app/src/lib/hypothesisEngine/dossierData.ts (collectDossierCounters),
-- результат складывается в data (HeDossierCounters). Одна строка на вертикаль.
--
-- he_cases — кейсы клиента (распарсенные с сайта или загруженные файлы):
-- задача, метрики, результат. Социальное доказательство для цепочек/шаблонов.

-- ─── 1. he_vertical_dossiers ─────────────────────────────────────────────
-- Досье вертикали: счётчики рынка + статус сбора. Собирается без LLM
-- (детерминированные источники), но поля llm_model/tokens/cost оставлены
-- на случай LLM-обогащения, как в остальных he_-таблицах.

create table if not exists public.he_vertical_dossiers (
  id          uuid primary key default gen_random_uuid(),
  vertical_id uuid not null unique references public.he_verticals(id) on delete cascade,
  project_id  uuid not null references public.he_projects(id) on delete cascade,
  status      text not null default 'draft'
    check (status in ('draft','ready','failed')),
  data        jsonb not null default '{}',       -- HeDossierCounters (companies_total, hh_vacancies_total, signals, ...)
  error       text,
  llm_model   text,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_he_vertical_dossiers_project
  on public.he_vertical_dossiers(project_id);

comment on table public.he_vertical_dossiers is
  'Досье вертикали: объективные рыночные цифры (компании директории, вакансии hh.ru, сигналы). Одна строка на вертикаль.';

-- ─── 2. he_cases ─────────────────────────────────────────────────────────
-- Кейсы клиента: с сайта (source='site') или загруженные специалистом
-- (source='upload'). metrics — структурированные цифры результата.

create table if not exists public.he_cases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.he_projects(id) on delete cascade,
  source      text not null check (source in ('site','upload')),
  filename    text,                            -- имя файла для upload
  industry    text,                            -- отрасль/вертикаль клиента из кейса
  client_type text,                            -- тип клиента (из кейса)
  task        text,                            -- задача клиента
  metrics     jsonb not null default '{}',     -- структурированные метрики результата
  result      text,                            -- достигнутый результат
  text        text,                            -- полный текст кейса
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_he_cases_project
  on public.he_cases(project_id);
create index if not exists idx_he_cases_project_industry
  on public.he_cases(project_id, industry);

comment on table public.he_cases is
  'Кейсы клиента (с сайта или загруженные): задача, метрики, результат — соцдоказательство для цепочек и шаблонов.';

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table public.he_vertical_dossiers enable row level security;
alter table public.he_cases             enable row level security;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'he_vertical_dossiers','he_cases'
  ] loop
    execute format('drop policy if exists %I_select_auth on public.%I', tbl, tbl);
    execute format(
      'create policy %I_select_auth on public.%I for select using (auth.uid() is not null)',
      tbl, tbl
    );
  end loop;
end$$;

-- ─── Grants ─────────────────────────────────────────────────────────────

grant all on public.he_vertical_dossiers to service_role, postgres;
grant all on public.he_cases             to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_vertical_dossiers, public.he_cases to readonly';
  end if;
end $$;
