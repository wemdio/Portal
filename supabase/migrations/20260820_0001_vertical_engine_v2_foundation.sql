-- Vertical Engine v2: изолированный фундамент внутреннего инструмента.
--
-- ВАЖНО: существующие he_* принадлежат production-backend ENG-портала.
-- Эта миграция не изменяет he_*, не создаёт FK/cascade в их сторону и не
-- добавляет очередь: ve_jobs появится вместе с первым реальным v2-воркером.
--
-- Доступ к обеим таблицам идёт только через server-side internal API под
-- service_role. RLS включён без authenticated-политик.

-- ─── 1. ve_projects ─────────────────────────────────────────────────────

create table if not exists public.ve_projects (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null,
  name        text not null,
  website_url text not null,
  status      text not null default 'draft'
    check (status in ('draft')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ve_projects_created_at
  on public.ve_projects(created_at desc);

create index if not exists idx_ve_projects_created_by
  on public.ve_projects(created_by, created_at desc);

comment on table public.ve_projects is
  'Vertical Engine v2 projects: новые внутренние прогоны, изолированные от ENG he_*.';

-- ─── 2. ve_legacy_project_links ─────────────────────────────────────────

create table if not exists public.ve_legacy_project_links (
  legacy_he_project_id uuid primary key,
  verified_by          uuid not null,
  verified_at          timestamptz not null default now(),
  review_notes         text,
  backfill_batch_id    text,
  created_at           timestamptz not null default now()
);

create index if not exists idx_ve_legacy_project_links_verified_at
  on public.ve_legacy_project_links(verified_at desc);

comment on table public.ve_legacy_project_links is
  'Проверенный вручную реестр внутренних legacy-проектов для read-only архива v2.';

comment on column public.ve_legacy_project_links.legacy_he_project_id is
  'UUID legacy-проекта. Намеренно без FK: v2 не должен менять семантику удаления ENG he_*.';

-- ─── RLS / grants ───────────────────────────────────────────────────────

alter table public.ve_projects enable row level security;
alter table public.ve_legacy_project_links enable row level security;

grant all on public.ve_projects to service_role, postgres;
grant all on public.ve_legacy_project_links to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.ve_projects, public.ve_legacy_project_links to readonly';
  end if;
end $$;
