-- Per-client domain selection for cold-outreach mailboxes (client onboarding).
-- The client picks N domains out of 2N system-generated suggestions (checked
-- for availability via the reg.ru API); the manager then buys and configures
-- them manually. Exactly ONE row per client (PRIMARY KEY on client_user_id).
--
-- Lives in the Instantly DB (supabaseInstantly). client_user_id references
-- public.profiles(id) in the MAIN DB; cross-database FK is not possible
-- so we store as plain uuid (same pattern as client_campaign_presets).

create table if not exists public.client_domain_selections (
  client_user_id uuid primary key,
  -- Brand the suggestions were generated from (extracted from the brief
  -- website or entered by the client manually). Null until known.
  brand text,
  -- Last generated batch: [{domain, tld, available, checked_at}, ...]
  suggested jsonb not null default '[]',
  -- Domains the client confirmed (subset of suggested with available=true).
  selected text[] not null default '{}',
  -- How many domains the client's tariff requires (3 standard / 6 pro).
  required_count int not null default 3,
  -- 'suggested' = variants generated, 'selected' = client confirmed a full set.
  status text not null default 'suggested',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_domain_selections enable row level security;

drop policy if exists "Service role full access on client_domain_selections" on public.client_domain_selections;
create policy "Service role full access on client_domain_selections"
  on public.client_domain_selections for all using (true) with check (true);

-- updated_at trigger
create or replace function public.client_domain_selections_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_client_domain_selections_updated_at on public.client_domain_selections;
create trigger trg_client_domain_selections_updated_at
  before update on public.client_domain_selections
  for each row
  execute function public.client_domain_selections_set_updated_at();
