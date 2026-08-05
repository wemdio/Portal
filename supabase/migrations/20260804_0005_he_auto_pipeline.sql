-- ENG auto-pipeline Движка вертикалей: ежедневный добор лидов в уже
-- запущенные кампании us-проектов (аналог client_auto_pipeline_configs/runs
-- клиентского RU-пайплайна, но поверх HE-машинерии).
--
-- Крон-воркер (app/worker/heAutoPipelineCron.ts) раз в сутки для каждого
-- enabled-конфига (проект market='us') ставит refill-сборки base_collect под
-- вертикали с запущенной кампанией (he_templates.launch_info), а refill-ветка
-- стадии (app/src/lib/hypothesisEngine/stages/baseCollectRefill.ts) после
-- конструктора доливает свежие валидные лиды в ту же кампанию Instantly.
--
-- Гранты — как у остальных he_* таблиц (см. 20260724_0001): внутренние
-- ops-таблицы, доступ только service_role (RLS включён, политик нет).

-- ─── 1. he_auto_pipeline_configs ─────────────────────────────────────────
-- Конфиг добора: один на проект (unique project_id). daily_leads_cap —
-- потолок лидов в сутки НА ПРОЕКТ (суммарно по вертикалям за UTC-день);
-- verticals_per_run — сколько вертикалей ставится в сборку за один тик крона.

create table if not exists public.he_auto_pipeline_configs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null unique references public.he_projects(id) on delete cascade,
  enabled           boolean not null default true,
  daily_leads_cap   integer not null default 50,
  verticals_per_run integer not null default 3,
  last_run_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.he_auto_pipeline_configs is
  'ENG auto-pipeline HE: конфиг ежедневного добора лидов в запущенные кампании us-проекта (1:1 к he_projects).';

-- ─── 2. he_auto_pipeline_runs ────────────────────────────────────────────
-- Журнал прогонов: 'collecting' — refill-сборка поставлена (пишет крон);
-- 'appended'/'no_new'/'failed' — финал refill-ветки base_collect (пишет стадия
-- по base_id) либо ошибка постановки (пишет крон, base_id NULL).
-- stats: {collected, with_email, valid, appended, skipped_blocklist,
-- skipped_instantly, capped}.

create table if not exists public.he_auto_pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  config_id    uuid references public.he_auto_pipeline_configs(id) on delete cascade,
  project_id   uuid,
  vertical_id  uuid,
  base_id      uuid,
  status       text not null default 'collecting'
    check (status in ('collecting','appended','no_new','failed')),
  stats        jsonb not null default '{}',
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_he_auto_pipeline_runs_config
  on public.he_auto_pipeline_runs(config_id, created_at);
create index if not exists idx_he_auto_pipeline_runs_base_collecting
  on public.he_auto_pipeline_runs(base_id) where status = 'collecting';

comment on table public.he_auto_pipeline_runs is
  'ENG auto-pipeline HE: журнал refill-прогонов (collecting → appended/no_new/failed) со статистикой воронки.';

-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.he_auto_pipeline_configs enable row level security;
alter table public.he_auto_pipeline_runs   enable row level security;

-- ─── Grants ──────────────────────────────────────────────────────────────

grant all on public.he_auto_pipeline_configs to service_role, postgres;
grant all on public.he_auto_pipeline_runs   to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_auto_pipeline_configs, public.he_auto_pipeline_runs to readonly';
  end if;
end $$;
