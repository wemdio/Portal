-- Vertical Engine v2 runtime: isolated copy of the specialist Hypothesis Engine
-- schema. Does not alter he_* and does not copy ENG autopilot/auto-pipeline tables.

-- ─── ve_projects: allow a real research lifecycle ─────────────────────────

alter table public.ve_projects
  add column if not exists brief jsonb,
  add column if not exists error text,
  add column if not exists llm_model text,
  add column if not exists tokens_used bigint not null default 0,
  add column if not exists cost_usd numeric(12,6) not null default 0,
  add column if not exists market text not null default 'ru';

alter table public.ve_projects drop constraint if exists ve_projects_status_check;
alter table public.ve_projects
  add constraint ve_projects_status_check
  check (status in ('draft','researching','researched','failed'));

alter table public.ve_projects drop constraint if exists ve_projects_market_check;
alter table public.ve_projects
  add constraint ve_projects_market_check
  check (market in ('ru','us'));

-- ─── ve_jobs ──────────────────────────────────────────────────────────────

create table if not exists public.ve_jobs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.ve_projects(id) on delete cascade,
  stage       text not null
    check (stage in (
      'site_profile','competitors','brand_cloud','hypotheses','evidence','clustering',
      'chain','vocab','base_analyze','template','dossier','base_collect'
    )),
  status      text not null default 'pending'
    check (status in ('pending','running','done','failed','cancelled')),
  payload     jsonb not null default '{}',
  result      jsonb,
  error       text,
  attempts    integer not null default 0,
  progress    jsonb,
  run_after   timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ve_jobs_pending
  on public.ve_jobs(status) where status = 'pending';
create index if not exists idx_ve_jobs_project_stage
  on public.ve_jobs(project_id, stage);
create index if not exists idx_ve_jobs_pending_run_after
  on public.ve_jobs(status, run_after) where status = 'pending';

-- ─── ve_hypotheses / ve_verticals ─────────────────────────────────────────

create table if not exists public.ve_hypotheses (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.ve_projects(id) on delete cascade,
  vertical_id   uuid,
  tier          smallint not null check (tier between 1 and 3),
  title         text not null,
  description   text,
  fit_rationale text,
  evidence      jsonb not null default '[]',
  potential_pct smallint not null default 0 check (potential_pct between 0 and 100),
  status        text not null default 'proposed'
    check (status in ('proposed','accepted','rejected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ve_hypotheses_project on public.ve_hypotheses(project_id);

create table if not exists public.ve_verticals (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.ve_projects(id) on delete cascade,
  name               text not null,
  summary            text,
  synonyms           jsonb not null default '[]',
  potential_pct      smallint not null default 0 check (potential_pct between 0 and 100),
  rank               integer,
  actual_reply_pct   numeric(5,2),
  actual_sent        bigint,
  actual_measured_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_ve_verticals_project on public.ve_verticals(project_id);

alter table public.ve_hypotheses
  drop constraint if exists ve_hypotheses_vertical_id_fkey;
alter table public.ve_hypotheses
  add constraint ve_hypotheses_vertical_id_fkey
  foreign key (vertical_id) references public.ve_verticals(id) on delete set null;

-- ─── ve_chains / ve_vocab ─────────────────────────────────────────────────

create table if not exists public.ve_chains (
  id          uuid primary key default gen_random_uuid(),
  vertical_id uuid not null references public.ve_verticals(id) on delete cascade,
  language    text not null default 'ru',
  letters     jsonb not null default '[]',
  status      text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model   text,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ve_chains_vertical on public.ve_chains(vertical_id);

create table if not exists public.ve_vocab (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    uuid not null references public.ve_verticals(id) on delete cascade,
  company_types  jsonb not null default '[]',
  job_titles     jsonb not null default '[]',
  search_queries jsonb not null default '[]',
  status         text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model      text,
  tokens_used    bigint not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_ve_vocab_vertical on public.ve_vocab(vertical_id);

-- ─── ve_bases / ve_templates ──────────────────────────────────────────────

create table if not exists public.ve_bases (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.ve_projects(id) on delete cascade,
  vertical_id  uuid not null references public.ve_verticals(id) on delete cascade,
  filename     text,
  row_count    integer not null default 0,
  columns      jsonb not null default '[]',
  sample_rows  jsonb not null default '[]',
  data         jsonb not null default '[]',
  source       text not null default 'upload'
    check (source in ('upload','auto')),
  collect_info jsonb,
  status       text not null default 'uploaded'
    check (status in ('uploaded','collecting','analyzing','analyzed','failed')),
  analysis     jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_ve_bases_project on public.ve_bases(project_id);
create index if not exists idx_ve_bases_vertical on public.ve_bases(vertical_id);

-- Антигонка автосборки: два параллельных POST .../verticals/[id]/collect
-- проходят проверку «уже собирается?» до insert, проигравший получает 23505 и
-- маппится в ответ с уже существующей базой (baseCollectEnqueue.ts).
create unique index if not exists ve_bases_one_collecting_per_vertical
  on public.ve_bases (vertical_id)
  where source = 'auto' and status = 'collecting';

create table if not exists public.ve_templates (
  id                   uuid primary key default gen_random_uuid(),
  base_id              uuid not null references public.ve_bases(id) on delete cascade,
  vertical_id          uuid not null references public.ve_verticals(id) on delete cascade,
  fixed_block          text,
  personalization_plan jsonb not null default '{}',
  letters              jsonb not null default '[]',
  launch_info          jsonb,
  status               text not null default 'draft'
    check (status in ('draft','ready','failed')),
  llm_model            text,
  tokens_used          bigint not null default 0,
  cost_usd             numeric(12,6) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_ve_templates_base on public.ve_templates(base_id);
create index if not exists idx_ve_templates_vertical on public.ve_templates(vertical_id);

-- ─── ve_vertical_dossiers / ve_cases ──────────────────────────────────────

create table if not exists public.ve_vertical_dossiers (
  id          uuid primary key default gen_random_uuid(),
  vertical_id uuid not null unique references public.ve_verticals(id) on delete cascade,
  project_id  uuid not null references public.ve_projects(id) on delete cascade,
  status      text not null default 'draft'
    check (status in ('draft','ready','failed')),
  data        jsonb not null default '{}',
  error       text,
  llm_model   text,
  tokens_used bigint not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ve_vertical_dossiers_project on public.ve_vertical_dossiers(project_id);

create table if not exists public.ve_cases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.ve_projects(id) on delete cascade,
  source      text not null check (source in ('site','upload')),
  filename    text,
  industry    text,
  client_type text,
  task        text,
  metrics     jsonb not null default '{}',
  result      text,
  text        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ve_cases_project on public.ve_cases(project_id);

-- ─── RLS / grants (service role only, like the v2 foundation) ─────────────

alter table public.ve_jobs enable row level security;
alter table public.ve_hypotheses enable row level security;
alter table public.ve_verticals enable row level security;
alter table public.ve_chains enable row level security;
alter table public.ve_vocab enable row level security;
alter table public.ve_bases enable row level security;
alter table public.ve_templates enable row level security;
alter table public.ve_vertical_dossiers enable row level security;
alter table public.ve_cases enable row level security;

grant all on public.ve_jobs to service_role, postgres;
grant all on public.ve_hypotheses to service_role, postgres;
grant all on public.ve_verticals to service_role, postgres;
grant all on public.ve_chains to service_role, postgres;
grant all on public.ve_vocab to service_role, postgres;
grant all on public.ve_bases to service_role, postgres;
grant all on public.ve_templates to service_role, postgres;
grant all on public.ve_vertical_dossiers to service_role, postgres;
grant all on public.ve_cases to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.ve_jobs, public.ve_hypotheses, public.ve_verticals, public.ve_chains, public.ve_vocab, public.ve_bases, public.ve_templates, public.ve_vertical_dossiers, public.ve_cases to readonly';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 've_jobs'
     ) then
    alter publication supabase_realtime add table public.ve_jobs;
  end if;
end
$$;
