-- Initial schema for PolzaInstantlyDB (separate Supabase project).
-- This DB holds only Instantly-related tables.
-- All cross-DB FK references (profiles, projects, auth.users) are intentionally absent.
-- RLS policies use service-role-only access (using (true)) since auth.uid() is not available.

-- ── 1. Campaign catalog ────────────────────────────────────────────────────────

create table if not exists public.instantly_campaign_catalog (
  id uuid primary key,
  name text not null default '',
  status integer,
  timestamp_created timestamptz,
  timestamp_updated timestamptz,
  synced_at timestamptz not null default now(),
  emails_sent_count integer,
  open_count integer,
  reply_count integer,
  new_leads_contacted_count integer,
  bounced_count integer,
  unsubscribed_count integer,
  leads_count integer,
  analytics_synced_at timestamptz
);

create index if not exists idx_instantly_campaign_catalog_synced_at
  on public.instantly_campaign_catalog (synced_at desc);

create index if not exists idx_instantly_campaign_catalog_updated
  on public.instantly_campaign_catalog (timestamp_updated desc nulls last);

alter table public.instantly_campaign_catalog enable row level security;

drop policy if exists "Service role full access on instantly_campaign_catalog" on public.instantly_campaign_catalog;
create policy "Service role full access on instantly_campaign_catalog"
  on public.instantly_campaign_catalog for all using (true) with check (true);

comment on table public.instantly_campaign_catalog is
  'Instantly campaign id/name/analytics cache; synced periodically from api.instantly.ai';

comment on column public.instantly_campaign_catalog.analytics_synced_at is
  'Timestamp of the last successful analytics sync from Instantly API';

-- ── 2. Webhook events ─────────────────────────────────────────────────────────

create table if not exists public.instantly_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  campaign_id text,
  lead_email text,
  thread_id text,
  email_id text,
  payload jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_instantly_webhook_events_processed
  on public.instantly_webhook_events (processed, created_at)
  where not processed;

create index if not exists idx_instantly_webhook_events_campaign
  on public.instantly_webhook_events (campaign_id);

alter table public.instantly_webhook_events enable row level security;

drop policy if exists "Service role full access on instantly_webhook_events" on public.instantly_webhook_events;
create policy "Service role full access on instantly_webhook_events"
  on public.instantly_webhook_events for all using (true) with check (true);

-- ── 3. Lead qualifications ────────────────────────────────────────────────────

create table if not exists public.instantly_lead_qualifications (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid references public.instantly_webhook_events(id) on delete set null,
  campaign_id text not null,
  campaign_name text,
  lead_email text not null,
  lead_name text,
  company_name text,
  thread_id text,
  reply_subject text,
  reply_preview text,
  reply_body text,
  last_outbound_preview text,
  last_outbound_ue_type integer,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'lead', 'not_lead', 'needs_review', 'error')),
  proposal_seen boolean,
  interest_signals text[],
  ai_reason text,
  ai_confidence real,
  error_message text,
  instantly_email_id text,
  instantly_lead_id text,
  reply_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_instantly_lead_qualifications_status
  on public.instantly_lead_qualifications (status);

create index if not exists idx_instantly_lead_qualifications_campaign
  on public.instantly_lead_qualifications (campaign_id, created_at desc);

create index if not exists idx_instantly_lead_qualifications_email
  on public.instantly_lead_qualifications (lead_email);

create unique index if not exists idx_instantly_lead_qualifications_event
  on public.instantly_lead_qualifications (webhook_event_id)
  where webhook_event_id is not null;

alter table public.instantly_lead_qualifications enable row level security;

drop policy if exists "Service role full access on instantly_lead_qualifications" on public.instantly_lead_qualifications;
create policy "Service role full access on instantly_lead_qualifications"
  on public.instantly_lead_qualifications for all using (true) with check (true);

-- ── 4. User campaign preferences ─────────────────────────────────────────────
-- user_id is stored as uuid but without FK (profiles table lives in main DB).

create table if not exists public.user_instantly_campaign_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, campaign_id)
);

create index if not exists idx_user_instantly_campaign_prefs_user
  on public.user_instantly_campaign_preferences (user_id);

alter table public.user_instantly_campaign_preferences enable row level security;

drop policy if exists "Service role full access on user_instantly_campaign_preferences" on public.user_instantly_campaign_preferences;
create policy "Service role full access on user_instantly_campaign_preferences"
  on public.user_instantly_campaign_preferences for all using (true) with check (true);

-- ── 5. Client Instantly access ────────────────────────────────────────────────
-- client_user_id / created_by stored as uuid without FK (profiles in main DB).

create table if not exists public.client_instantly_access (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,
  resource_type text not null check (resource_type in ('campaign', 'lead_list')),
  resource_id text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  leads_synced_at timestamptz,
  unique (client_user_id, resource_type, resource_id)
);

create index if not exists idx_client_instantly_access_user
  on public.client_instantly_access (client_user_id);

alter table public.client_instantly_access enable row level security;

drop policy if exists "Service role full access on client_instantly_access" on public.client_instantly_access;
create policy "Service role full access on client_instantly_access"
  on public.client_instantly_access for all using (true) with check (true);

-- ── 6. Client campaign leads ──────────────────────────────────────────────────
-- client_user_id stored as uuid without FK (profiles in main DB).

create table if not exists public.client_campaign_leads (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,
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
  on public.client_campaign_leads (client_user_id, campaign_id);

alter table public.client_campaign_leads enable row level security;

drop policy if exists "Service role full access on client_campaign_leads" on public.client_campaign_leads;
create policy "Service role full access on client_campaign_leads"
  on public.client_campaign_leads for all using (true) with check (true);

-- ── 7. Lead imports ───────────────────────────────────────────────────────────
-- project_id / imported_by stored as uuid without FK (projects/auth.users in main DB).

create table if not exists public.instantly_lead_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  campaign_id text,
  campaign_name text,
  lead_list_id text,
  lead_list_name text,
  leads_count integer not null default 0,
  imported_by uuid,
  tab_name text,
  created_at timestamptz not null default now()
);

alter table public.instantly_lead_imports enable row level security;

drop policy if exists "Service role full access on instantly_lead_imports" on public.instantly_lead_imports;
create policy "Service role full access on instantly_lead_imports"
  on public.instantly_lead_imports for all using (true) with check (true);
