-- Persisted leads from client campaigns.
-- Leads are synced from Instantly on demand and NEVER deleted,
-- so they survive campaign cleanup in Instantly.

create table if not exists public.client_campaign_leads (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  campaign_id text not null,
  email text not null,
  first_name text,
  last_name text,
  company_name text,
  website text,
  linkedin_url text,
  synced_at timestamptz not null default now(),
  unique (client_user_id, campaign_id, email)
);

create index if not exists idx_client_campaign_leads_user_campaign
  on public.client_campaign_leads(client_user_id, campaign_id);

alter table public.client_campaign_leads enable row level security;

drop policy if exists "Clients can read own leads" on public.client_campaign_leads;
create policy "Clients can read own leads"
  on public.client_campaign_leads
  for select
  using (client_user_id = auth.uid());

drop policy if exists "Service role full access on client_campaign_leads" on public.client_campaign_leads;
create policy "Service role full access on client_campaign_leads"
  on public.client_campaign_leads
  for all
  using (true)
  with check (true);

-- Track when leads were last synced per campaign assignment
alter table public.client_instantly_access
  add column if not exists leads_synced_at timestamptz;
