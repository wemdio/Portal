-- LinkedIn Outreach 2.0: Portal-facing state for the OpenOutreach runtime.
-- The actual automation engine can run as a separate worker/container and
-- sync data into these tables.

create table if not exists public.li2_settings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  linkedin_email        text not null default '',
  linkedin_password     text not null default '',
  llm_provider          text not null default 'openai'
                          check (llm_provider in ('openai','anthropic','google','groq','mistral','cohere','openai_compatible')),
  llm_api_key           text not null default '',
  ai_model              text not null default 'gpt-4o-mini',
  llm_api_base          text not null default '',
  proxy_url             text not null default '',
  connect_daily_limit   integer not null default 20,
  connect_weekly_limit  integer not null default 100,
  follow_up_daily_limit integer not null default 25,
  legal_accepted        boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(user_id)
);

create table if not exists public.li2_campaigns (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  name                  text not null,
  product_description   text not null default '',
  target_market         text not null default '',
  campaign_objective    text not null default '',
  booking_link          text not null default '',
  seed_profile_urls     text not null default '',
  status                text not null default 'draft'
                          check (status in ('draft','queued','running','paused','stopped','completed','error')),
  runtime_status        text not null default 'not_started',
  runtime_instance_id   text,
  stats                 jsonb not null default '{}'::jsonb,
  last_sync_at          timestamptz,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_li2_campaigns_user_status
  on public.li2_campaigns(user_id, status, created_at desc);

create table if not exists public.li2_leads (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  campaign_id           uuid references public.li2_campaigns(id) on delete cascade,
  public_identifier     text,
  profile_url           text,
  name                  text not null default '',
  first_name            text,
  last_name             text,
  position              text,
  company               text,
  state                 text not null default 'discovered'
                          check (state in ('discovered','qualified','ready_to_connect','pending','connected','completed','failed')),
  qualification_score   numeric,
  qualification_reason  text,
  outcome               text,
  chat_summary          jsonb not null default '[]'::jsonb,
  extra_data            jsonb not null default '{}'::jsonb,
  last_activity_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_li2_leads_campaign_state
  on public.li2_leads(campaign_id, state, updated_at desc);
create index if not exists idx_li2_leads_user
  on public.li2_leads(user_id, updated_at desc);

create table if not exists public.li2_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  campaign_id     uuid references public.li2_campaigns(id) on delete cascade,
  lead_id         uuid references public.li2_leads(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound','system')),
  content         text not null default '',
  provider_id     text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_li2_messages_lead
  on public.li2_messages(lead_id, sent_at asc);
create index if not exists idx_li2_messages_campaign
  on public.li2_messages(campaign_id, sent_at desc);

create table if not exists public.li2_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  campaign_id     uuid references public.li2_campaigns(id) on delete cascade,
  type            text not null check (type in ('start','stop','sync','status')),
  status          text not null default 'pending'
                    check (status in ('pending','running','completed','failed','cancelled')),
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb,
  error_message   text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

create index if not exists idx_li2_jobs_status
  on public.li2_jobs(status, created_at asc);
create index if not exists idx_li2_jobs_campaign
  on public.li2_jobs(campaign_id, created_at desc);

create table if not exists public.li2_logs (
  id              bigint generated always as identity primary key,
  user_id         uuid references public.profiles(id) on delete cascade,
  campaign_id     uuid references public.li2_campaigns(id) on delete cascade,
  lead_id         uuid references public.li2_leads(id) on delete set null,
  level           text not null default 'info' check (level in ('info','warning','error')),
  message         text not null,
  details         jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_li2_logs_campaign
  on public.li2_logs(campaign_id, created_at desc);

alter table public.li2_settings enable row level security;
alter table public.li2_campaigns enable row level security;
alter table public.li2_leads enable row level security;
alter table public.li2_messages enable row level security;
alter table public.li2_jobs enable row level security;
alter table public.li2_logs enable row level security;

create policy li2_settings_own_all on public.li2_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_campaigns_own_all on public.li2_campaigns
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_leads_own_all on public.li2_leads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_messages_own_all on public.li2_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_jobs_own_all on public.li2_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_logs_own_all on public.li2_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.li2_settings to service_role;
grant all on public.li2_campaigns to service_role;
grant all on public.li2_leads to service_role;
grant all on public.li2_messages to service_role;
grant all on public.li2_jobs to service_role;
grant all on public.li2_logs to service_role;

grant select, insert, update on public.li2_settings to authenticated;
grant select, insert, update on public.li2_campaigns to authenticated;
grant select, insert, update on public.li2_leads to authenticated;
grant select, insert, update on public.li2_messages to authenticated;
grant select, insert, update on public.li2_jobs to authenticated;
grant select, insert, update on public.li2_logs to authenticated;
