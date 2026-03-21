-- LinkedIn Outreach: accounts, leads, campaigns, scraper tasks, webhook logs
-- All tables prefixed with li_ to avoid conflicts

-----------------------------
-- li_settings (per-user Unipile + OpenAI credentials)
-----------------------------

create table if not exists public.li_settings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  unipile_dsn     text not null default '',
  unipile_api_key text not null default '',
  openai_api_key  text not null default '',
  openai_model    text not null default 'gpt-4o-mini',
  webhook_secret  text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists idx_li_settings_user on public.li_settings(user_id);

-----------------------------
-- li_accounts (LinkedIn accounts connected via Unipile)
-----------------------------

create table if not exists public.li_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  unipile_account_id text not null,
  name              text,
  is_active         boolean not null default true,
  profile_url       text,
  headline          text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists idx_li_accounts_user_unipile on public.li_accounts(user_id, unipile_account_id);
create index if not exists idx_li_accounts_user on public.li_accounts(user_id);

-----------------------------
-- li_lead_lists (groups for organizing leads)
-----------------------------

create table if not exists public.li_lead_lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_li_lead_lists_user on public.li_lead_lists(user_id);

-----------------------------
-- li_leads (people to contact)
-----------------------------

create table if not exists public.li_leads (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  lead_list_id         uuid references public.li_lead_lists(id) on delete set null,
  linkedin_id          text,
  public_identifier    text,
  profile_url          text,
  name                 text not null default '',
  first_name           text,
  last_name            text,
  position             text,
  company              text,
  chat_id              text,
  status               text not null default 'new'
                         check (status in ('new','invited','connected','messaged','replied','completed','error')),
  account_id           uuid references public.li_accounts(id) on delete set null,
  conversation_history jsonb not null default '[]'::jsonb,
  extra_data           jsonb not null default '{}'::jsonb,
  last_activity        timestamptz default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_li_leads_user on public.li_leads(user_id);
create index if not exists idx_li_leads_list on public.li_leads(lead_list_id);
create index if not exists idx_li_leads_linkedin_id on public.li_leads(linkedin_id);
create index if not exists idx_li_leads_chat_id on public.li_leads(chat_id);
create index if not exists idx_li_leads_status on public.li_leads(user_id, status);

-----------------------------
-- li_campaigns (outreach campaigns)
-----------------------------

create table if not exists public.li_campaigns (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null references public.profiles(id) on delete cascade,
  name                          text not null,
  account_id                    uuid references public.li_accounts(id) on delete set null,
  lead_list_id                  uuid references public.li_lead_lists(id) on delete set null,
  steps                         jsonb not null default '[]'::jsonb,
  use_ai                        boolean not null default false,
  ai_prompt_invite              text,
  ai_prompt_chat                text,
  stop_on_reply                 boolean not null default true,
  min_delay                     integer not null default 60,
  max_delay                     integer not null default 180,
  daily_invite_limit            integer not null default 25,
  invites_sent_today            integer not null default 0,
  last_invite_date              date,
  welcome_message               text,
  message_existing_connections  boolean not null default false,
  use_ai_welcome                boolean not null default false,
  use_ai_followup               boolean not null default true,
  status                        text not null default 'draft'
                                  check (status in ('draft','running','paused','stopped','completed','error')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create index if not exists idx_li_campaigns_user on public.li_campaigns(user_id);
create index if not exists idx_li_campaigns_status on public.li_campaigns(user_id, status);

-----------------------------
-- li_campaign_leads (lead progress in campaigns)
-----------------------------

create table if not exists public.li_campaign_leads (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.li_campaigns(id) on delete cascade,
  lead_id         uuid not null references public.li_leads(id) on delete cascade,
  current_step    integer not null default 0,
  status          text not null default 'pending'
                    check (status in ('pending','in_progress','waiting','completed','error','skipped')),
  next_action_at  timestamptz,
  user_replied    boolean not null default false,
  invite_accepted boolean not null default false,
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(campaign_id, lead_id)
);

create index if not exists idx_li_campaign_leads_campaign on public.li_campaign_leads(campaign_id);
create index if not exists idx_li_campaign_leads_lead on public.li_campaign_leads(lead_id);
create index if not exists idx_li_campaign_leads_status on public.li_campaign_leads(campaign_id, status);
create index if not exists idx_li_campaign_leads_next_action on public.li_campaign_leads(next_action_at);

-----------------------------
-- li_campaign_step_stats (progress per step)
-----------------------------

create table if not exists public.li_campaign_step_stats (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.li_campaigns(id) on delete cascade,
  step_index  integer not null,
  step_type   text not null,
  reached     integer not null default 0,
  completed   integer not null default 0,
  failed      integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(campaign_id, step_index)
);

create index if not exists idx_li_campaign_step_stats_campaign on public.li_campaign_step_stats(campaign_id);

-----------------------------
-- li_campaign_logs (activity logs)
-----------------------------

create table if not exists public.li_campaign_logs (
  id          bigint generated always as identity primary key,
  campaign_id uuid not null references public.li_campaigns(id) on delete cascade,
  level       text not null default 'info',
  message     text not null,
  lead_name   text,
  step_index  integer,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_li_campaign_logs_campaign on public.li_campaign_logs(campaign_id, created_at desc);

-----------------------------
-- li_tasks (scraper + import background tasks)
-----------------------------

create table if not exists public.li_tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  type           text not null check (type in ('search','post_reactions','csv_import')),
  status         text not null default 'pending'
                   check (status in ('pending','running','completed','failed','cancelled')),
  params         jsonb not null default '{}'::jsonb,
  result         jsonb,
  progress       integer not null default 0,
  total          integer not null default 0,
  error_message  text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  completed_at   timestamptz
);

create index if not exists idx_li_tasks_user on public.li_tasks(user_id);
create index if not exists idx_li_tasks_status on public.li_tasks(status);

-----------------------------
-- li_webhook_logs (incoming webhook event log)
-----------------------------

create table if not exists public.li_webhook_logs (
  id            bigint generated always as identity primary key,
  user_id       uuid references public.profiles(id) on delete cascade,
  event_type    text,
  payload       jsonb not null default '{}'::jsonb,
  processed     boolean not null default false,
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_li_webhook_logs_event on public.li_webhook_logs(event_type);
create index if not exists idx_li_webhook_logs_created on public.li_webhook_logs(created_at desc);

-----------------------------
-- Row Level Security
-----------------------------

alter table public.li_settings enable row level security;
alter table public.li_accounts enable row level security;
alter table public.li_lead_lists enable row level security;
alter table public.li_leads enable row level security;
alter table public.li_campaigns enable row level security;
alter table public.li_campaign_leads enable row level security;
alter table public.li_tasks enable row level security;
alter table public.li_webhook_logs enable row level security;

-- li_settings
drop policy if exists li_settings_select_own on public.li_settings;
create policy li_settings_select_own on public.li_settings for select using (auth.uid() = user_id);
drop policy if exists li_settings_insert_own on public.li_settings;
create policy li_settings_insert_own on public.li_settings for insert with check (auth.uid() = user_id);
drop policy if exists li_settings_update_own on public.li_settings;
create policy li_settings_update_own on public.li_settings for update using (auth.uid() = user_id);

-- li_accounts
drop policy if exists li_accounts_select_own on public.li_accounts;
create policy li_accounts_select_own on public.li_accounts for select using (auth.uid() = user_id);
drop policy if exists li_accounts_insert_own on public.li_accounts;
create policy li_accounts_insert_own on public.li_accounts for insert with check (auth.uid() = user_id);
drop policy if exists li_accounts_update_own on public.li_accounts;
create policy li_accounts_update_own on public.li_accounts for update using (auth.uid() = user_id);
drop policy if exists li_accounts_delete_own on public.li_accounts;
create policy li_accounts_delete_own on public.li_accounts for delete using (auth.uid() = user_id);

-- li_lead_lists
drop policy if exists li_lead_lists_select_own on public.li_lead_lists;
create policy li_lead_lists_select_own on public.li_lead_lists for select using (auth.uid() = user_id);
drop policy if exists li_lead_lists_insert_own on public.li_lead_lists;
create policy li_lead_lists_insert_own on public.li_lead_lists for insert with check (auth.uid() = user_id);
drop policy if exists li_lead_lists_update_own on public.li_lead_lists;
create policy li_lead_lists_update_own on public.li_lead_lists for update using (auth.uid() = user_id);
drop policy if exists li_lead_lists_delete_own on public.li_lead_lists;
create policy li_lead_lists_delete_own on public.li_lead_lists for delete using (auth.uid() = user_id);

-- li_leads
drop policy if exists li_leads_select_own on public.li_leads;
create policy li_leads_select_own on public.li_leads for select using (auth.uid() = user_id);
drop policy if exists li_leads_insert_own on public.li_leads;
create policy li_leads_insert_own on public.li_leads for insert with check (auth.uid() = user_id);
drop policy if exists li_leads_update_own on public.li_leads;
create policy li_leads_update_own on public.li_leads for update using (auth.uid() = user_id);
drop policy if exists li_leads_delete_own on public.li_leads;
create policy li_leads_delete_own on public.li_leads for delete using (auth.uid() = user_id);

-- li_campaigns
drop policy if exists li_campaigns_select_own on public.li_campaigns;
create policy li_campaigns_select_own on public.li_campaigns for select using (auth.uid() = user_id);
drop policy if exists li_campaigns_insert_own on public.li_campaigns;
create policy li_campaigns_insert_own on public.li_campaigns for insert with check (auth.uid() = user_id);
drop policy if exists li_campaigns_update_own on public.li_campaigns;
create policy li_campaigns_update_own on public.li_campaigns for update using (auth.uid() = user_id);
drop policy if exists li_campaigns_delete_own on public.li_campaigns;
create policy li_campaigns_delete_own on public.li_campaigns for delete using (auth.uid() = user_id);

-- li_campaign_leads (access via campaign owner)
drop policy if exists li_campaign_leads_select_own on public.li_campaign_leads;
create policy li_campaign_leads_select_own on public.li_campaign_leads for select
  using (exists (select 1 from public.li_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
drop policy if exists li_campaign_leads_insert_own on public.li_campaign_leads;
create policy li_campaign_leads_insert_own on public.li_campaign_leads for insert
  with check (exists (select 1 from public.li_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
drop policy if exists li_campaign_leads_update_own on public.li_campaign_leads;
create policy li_campaign_leads_update_own on public.li_campaign_leads for update
  using (exists (select 1 from public.li_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
drop policy if exists li_campaign_leads_delete_own on public.li_campaign_leads;
create policy li_campaign_leads_delete_own on public.li_campaign_leads for delete
  using (exists (select 1 from public.li_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- li_tasks
drop policy if exists li_tasks_select_own on public.li_tasks;
create policy li_tasks_select_own on public.li_tasks for select using (auth.uid() = user_id);
drop policy if exists li_tasks_insert_own on public.li_tasks;
create policy li_tasks_insert_own on public.li_tasks for insert with check (auth.uid() = user_id);
drop policy if exists li_tasks_update_own on public.li_tasks;
create policy li_tasks_update_own on public.li_tasks for update using (auth.uid() = user_id);

-- li_webhook_logs
drop policy if exists li_webhook_logs_select_own on public.li_webhook_logs;
create policy li_webhook_logs_select_own on public.li_webhook_logs for select using (auth.uid() = user_id);
drop policy if exists li_webhook_logs_insert_own on public.li_webhook_logs;
create policy li_webhook_logs_insert_own on public.li_webhook_logs for insert with check (auth.uid() = user_id);
