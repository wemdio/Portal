-- Per-client campaign launch preset configured by tech specialists.
-- Defines schedule, attached email accounts, tracking flags etc.
-- Exactly ONE row per client (UNIQUE on client_user_id).
--
-- Lives in the Instantly DB (supabaseInstantly). client_user_id references
-- public.profiles(id) in the MAIN DB; cross-database FK is not possible
-- so we store as plain uuid (same pattern as client_instantly_access).

create table if not exists public.client_campaign_presets (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null unique,
  email_account_ids text[] not null default '{}',
  daily_limit int not null default 50,
  daily_max_leads int not null default 50,
  email_gap_minutes int not null default 10,
  open_tracking boolean not null default true,
  link_tracking boolean not null default true,
  stop_on_reply boolean not null default true,
  text_only boolean not null default false,
  schedule_from text not null default '09:00',
  schedule_to text not null default '18:00',
  schedule_days int[] not null default '{1,2,3,4,5}',
  schedule_timezone text not null default 'Europe/Moscow',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_client_campaign_presets_user
  on public.client_campaign_presets(client_user_id);

alter table public.client_campaign_presets enable row level security;

drop policy if exists "Service role full access on client_campaign_presets" on public.client_campaign_presets;
create policy "Service role full access on client_campaign_presets"
  on public.client_campaign_presets for all using (true) with check (true);

-- updated_at trigger
create or replace function public.client_campaign_presets_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_client_campaign_presets_updated_at on public.client_campaign_presets;
create trigger trg_client_campaign_presets_updated_at
  before update on public.client_campaign_presets
  for each row
  execute function public.client_campaign_presets_set_updated_at();
