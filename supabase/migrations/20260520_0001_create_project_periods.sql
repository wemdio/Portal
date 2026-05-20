-- Periods for long-running/renewed projects.
-- Existing projects keep legacy project-level campaign links until a period is created explicitly.

create table if not exists public.project_periods (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text,
  status text not null default 'active'
    check (status in ('active', 'closed')),
  period_start date not null default current_date,
  period_end date,
  contacts_obligation text,
  contacts_done text,
  contacts_done_synced_at timestamptz,
  kpi_plan text,
  kpi_fact text,
  deadline date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_project_periods_one_active
  on public.project_periods(project_id)
  where status = 'active';

create index if not exists idx_project_periods_project
  on public.project_periods(project_id, created_at desc);

alter table public.project_contacts_history
  add column if not exists period_id uuid references public.project_periods(id) on delete cascade;

create unique index if not exists idx_pch_period_date
  on public.project_contacts_history(period_id, recorded_at)
  where period_id is not null;

create index if not exists idx_pch_project_period_date
  on public.project_contacts_history(project_id, period_id, recorded_at desc);

alter table public.project_periods enable row level security;

grant all on public.project_periods to service_role;
grant select, insert, update, delete on public.project_periods to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='project_periods_all_authenticated' and tablename='project_periods') then
    create policy project_periods_all_authenticated on public.project_periods for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname='project_periods_all_service' and tablename='project_periods') then
    create policy project_periods_all_service on public.project_periods for all to service_role using (true) with check (true);
  end if;
end $$;
