-- AI Caller: campaigns and contacts (prerequisite for ai_caller_jobs).

create table if not exists public.ai_campaigns (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  assistant_id text not null,
  phone_number_id text not null,
  provider text not null,
  status text not null default 'draft'
    check (status in ('draft','running','paused','completed')),
  total_contacts integer not null default 0,
  called_contacts integer not null default 0,
  successful_contacts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_campaigns_created_by_idx
  on public.ai_campaigns (created_by);

alter table public.ai_campaigns enable row level security;

create policy ai_campaigns_select_own on public.ai_campaigns
  for select to authenticated using (created_by = auth.uid());
create policy ai_campaigns_insert_own on public.ai_campaigns
  for insert to authenticated with check (created_by = auth.uid());
create policy ai_campaigns_update_own on public.ai_campaigns
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy ai_campaigns_delete_own on public.ai_campaigns
  for delete to authenticated using (created_by = auth.uid());

-- AI Caller: campaign contacts

create table if not exists public.ai_campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ai_campaigns(id) on delete cascade,
  phone_number text not null,
  company_name text,
  contact_name text,
  email text,
  extra_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','calling','completed','failed')),
  called_at timestamptz,
  vapi_call_id text,
  call_duration integer,
  call_ended_reason text,
  created_at timestamptz not null default now()
);

create index if not exists ai_campaign_contacts_campaign_idx
  on public.ai_campaign_contacts (campaign_id);
create index if not exists ai_campaign_contacts_status_idx
  on public.ai_campaign_contacts (campaign_id, status)
  where status = 'pending';

alter table public.ai_campaign_contacts enable row level security;

create policy ai_campaign_contacts_select_own on public.ai_campaign_contacts
  for select to authenticated
  using (exists (select 1 from public.ai_campaigns c where c.id = campaign_id and c.created_by = auth.uid()));
create policy ai_campaign_contacts_insert_own on public.ai_campaign_contacts
  for insert to authenticated
  with check (exists (select 1 from public.ai_campaigns c where c.id = campaign_id and c.created_by = auth.uid()));
create policy ai_campaign_contacts_update_own on public.ai_campaign_contacts
  for update to authenticated
  using (exists (select 1 from public.ai_campaigns c where c.id = campaign_id and c.created_by = auth.uid()))
  with check (exists (select 1 from public.ai_campaigns c where c.id = campaign_id and c.created_by = auth.uid()));
create policy ai_campaign_contacts_delete_own on public.ai_campaign_contacts
  for delete to authenticated
  using (exists (select 1 from public.ai_campaigns c where c.id = campaign_id and c.created_by = auth.uid()));
