-- Per-client structured brief filled in /client/brief.
-- Used by AI tools (brief scoring, hypotheses, sequences, etc.) to improve results.
-- Exactly ONE row per client (UNIQUE on client_user_id), same pattern as client_campaign_presets.
--
-- Lives in the Instantly DB (supabaseInstantly). client_user_id references
-- public.profiles(id) in the MAIN DB; cross-database FK is not possible
-- so we store as plain uuid (same pattern as client_campaign_presets).

create table if not exists public.client_briefs (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null unique,
  fields jsonb not null default '{}'::jsonb,
  pdf_path text,
  pdf_file_name text,
  pdf_uploaded_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_client_briefs_user
  on public.client_briefs(client_user_id);

alter table public.client_briefs enable row level security;

drop policy if exists "Service role full access on client_briefs" on public.client_briefs;
create policy "Service role full access on client_briefs"
  on public.client_briefs for all using (true) with check (true);

create or replace function public.client_briefs_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_client_briefs_updated_at on public.client_briefs;
create trigger trg_client_briefs_updated_at
  before update on public.client_briefs
  for each row
  execute function public.client_briefs_set_updated_at();
