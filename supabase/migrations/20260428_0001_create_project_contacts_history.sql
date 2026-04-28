-- Daily snapshots of contacts_done for pace/velocity analysis.
-- One row per project per day, upserted by the daily Instantly sync cron.

create table if not exists public.project_contacts_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contacts_done integer not null,
  kpi_fact integer,
  recorded_at date not null default current_date,
  unique(project_id, recorded_at)
);

create index if not exists idx_pch_project_date
  on public.project_contacts_history(project_id, recorded_at desc);

alter table public.project_contacts_history enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='pch_select_authenticated' and tablename='project_contacts_history') then
    create policy pch_select_authenticated on public.project_contacts_history for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname='pch_all_service' and tablename='project_contacts_history') then
    create policy pch_all_service on public.project_contacts_history for all to service_role using (true) with check (true);
  end if;
end $$;
