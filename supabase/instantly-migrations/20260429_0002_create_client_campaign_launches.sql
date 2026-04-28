-- History of campaign launches initiated by clients via /client/launch.
-- Each row represents one client's attempt to create + populate + activate
-- a campaign in Instantly.
--
-- Lives in the Instantly DB (supabaseInstantly). client_user_id and preset_id
-- are stored as plain uuids (preset_id has a real FK because both tables
-- live in the same DB; client_user_id references main DB profiles, no FK).

create table if not exists public.client_campaign_launches (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,
  preset_id uuid references public.client_campaign_presets(id) on delete set null,
  instantly_campaign_id text,
  campaign_name text not null,
  sequence_steps jsonb not null default '[]'::jsonb,
  column_mapping jsonb not null default '{}'::jsonb,
  uploaded_rows int not null default 0,
  accepted_rows int not null default 0,
  skipped_rows int not null default 0,
  status text not null default 'uploading'
    check (status in ('uploading', 'active', 'paused', 'failed', 'completed')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_campaign_launches_user
  on public.client_campaign_launches(client_user_id, created_at desc);

create index if not exists idx_client_campaign_launches_instantly_campaign
  on public.client_campaign_launches(instantly_campaign_id)
  where instantly_campaign_id is not null;

alter table public.client_campaign_launches enable row level security;

drop policy if exists "Service role full access on client_campaign_launches" on public.client_campaign_launches;
create policy "Service role full access on client_campaign_launches"
  on public.client_campaign_launches for all using (true) with check (true);
