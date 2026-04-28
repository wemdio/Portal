-- Daily snapshots of contacts_done for pace/velocity analysis.
-- One row per project per day, upserted by the daily Instantly sync cron.

create table if not exists public.project_contacts_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contacts_done integer not null,
  recorded_at date not null default current_date,
  unique(project_id, recorded_at)
);

create index if not exists idx_pch_project_date
  on public.project_contacts_history(project_id, recorded_at desc);

alter table public.project_contacts_history enable row level security;

create policy pch_select_authenticated
  on public.project_contacts_history for select to authenticated using (true);

create policy pch_all_service
  on public.project_contacts_history for all to service_role using (true) with check (true);
