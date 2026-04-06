-- Instantly Lead Qualification: raw webhook events, AI classification results, user campaign preferences.

-- 1. Raw inbound webhook events from Instantly
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

-- 2. AI lead qualification results
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
  -- Our last outbound message before this reply
  last_outbound_preview text,
  last_outbound_ue_type integer,
  -- Classification
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'lead', 'not_lead', 'needs_review', 'error')),
  proposal_seen boolean,
  interest_signals text[],
  ai_reason text,
  ai_confidence real,
  error_message text,
  -- Metadata
  instantly_email_id text,
  instantly_lead_id text,
  reply_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz,
  read_by uuid
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

create unique index if not exists idx_instantly_lead_qualifications_email_id
  on public.instantly_lead_qualifications (instantly_email_id)
  where instantly_email_id is not null;

alter table public.instantly_lead_qualifications enable row level security;

drop policy if exists "Internal users can read all qualifications" on public.instantly_lead_qualifications;
create policy "Internal users can read all qualifications"
  on public.instantly_lead_qualifications for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role != 'client'
    )
  );

drop policy if exists "Service role full access on instantly_lead_qualifications" on public.instantly_lead_qualifications;
create policy "Service role full access on instantly_lead_qualifications"
  on public.instantly_lead_qualifications for all using (true) with check (true);

-- 3. Per-user campaign preferences for lead feed filtering
create table if not exists public.user_instantly_campaign_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  campaign_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, campaign_id)
);

create index if not exists idx_user_instantly_campaign_prefs_user
  on public.user_instantly_campaign_preferences (user_id);

alter table public.user_instantly_campaign_preferences enable row level security;

drop policy if exists "Users can read own campaign preferences" on public.user_instantly_campaign_preferences;
create policy "Users can read own campaign preferences"
  on public.user_instantly_campaign_preferences for select
  using (user_id = auth.uid());

drop policy if exists "Users can insert own campaign preferences" on public.user_instantly_campaign_preferences;
create policy "Users can insert own campaign preferences"
  on public.user_instantly_campaign_preferences for insert
  with check (user_id = auth.uid());

drop policy if exists "Users can delete own campaign preferences" on public.user_instantly_campaign_preferences;
create policy "Users can delete own campaign preferences"
  on public.user_instantly_campaign_preferences for delete
  using (user_id = auth.uid());

drop policy if exists "Service role full access on user_instantly_campaign_preferences" on public.user_instantly_campaign_preferences;
create policy "Service role full access on user_instantly_campaign_preferences"
  on public.user_instantly_campaign_preferences for all
  using (true) with check (true);
