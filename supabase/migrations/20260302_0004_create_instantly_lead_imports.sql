create table if not exists instantly_lead_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  campaign_id text,
  campaign_name text,
  lead_list_id text,
  lead_list_name text,
  leads_count integer not null default 0,
  imported_by uuid references auth.users(id),
  tab_name text,
  created_at timestamptz not null default now()
);

alter table instantly_lead_imports enable row level security;

drop policy if exists "Users can view their own imports" on instantly_lead_imports;
create policy "Users can view their own imports"
  on instantly_lead_imports for select
  using (imported_by = auth.uid());

drop policy if exists "Users can insert their own imports" on instantly_lead_imports;
create policy "Users can insert their own imports"
  on instantly_lead_imports for insert
  with check (imported_by = auth.uid());
