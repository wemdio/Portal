-- TG Outreach: campaigns (campaign-scoped tables)
-- Pool tables (tg_pool_*) are in a separate migration: create_tg_pool_tables

-- TG Outreach: campaigns
create table if not exists public.tg_outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  status text not null default 'stopped'
    check (status in ('stopped','running','paused','error')),
  openai_settings jsonb not null default '{}'::jsonb,
  telegram_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tg_outreach_campaigns_user_idx
  on public.tg_outreach_campaigns (user_id);

alter table public.tg_outreach_campaigns enable row level security;

create policy tg_outreach_campaigns_select_own on public.tg_outreach_campaigns
  for select to authenticated using (user_id = auth.uid());
create policy tg_outreach_campaigns_insert_own on public.tg_outreach_campaigns
  for insert to authenticated with check (user_id = auth.uid());
create policy tg_outreach_campaigns_update_own on public.tg_outreach_campaigns
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tg_outreach_campaigns_delete_own on public.tg_outreach_campaigns
  for delete to authenticated using (user_id = auth.uid());

-- TG Outreach: proxies
create table if not exists public.tg_outreach_proxies (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  url text not null,
  name text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists tg_outreach_proxies_campaign_idx
  on public.tg_outreach_proxies (campaign_id);

alter table public.tg_outreach_proxies enable row level security;

create policy tg_outreach_proxies_select_own on public.tg_outreach_proxies
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxies_insert_own on public.tg_outreach_proxies
  for insert to authenticated
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxies_update_own on public.tg_outreach_proxies
  for update to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxies_delete_own on public.tg_outreach_proxies
  for delete to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- TG Outreach: accounts
create table if not exists public.tg_outreach_accounts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  session_name text not null,
  api_id integer not null,
  api_hash text not null,
  phone text not null default '',
  proxy_id uuid references public.tg_outreach_proxies(id) on delete set null,
  session_data text not null default '',
  is_active boolean not null default true,
  cooldown_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tg_outreach_accounts_campaign_idx
  on public.tg_outreach_accounts (campaign_id);

alter table public.tg_outreach_accounts enable row level security;

create policy tg_outreach_accounts_select_own on public.tg_outreach_accounts
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_accounts_insert_own on public.tg_outreach_accounts
  for insert to authenticated
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_accounts_update_own on public.tg_outreach_accounts
  for update to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_accounts_delete_own on public.tg_outreach_accounts
  for delete to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- TG Outreach: dialogs
create table if not exists public.tg_outreach_dialogs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  tg_user_id bigint not null,
  tg_username text,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'none'
    check (status in ('none','lead','not_lead','later')),
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tg_outreach_dialogs_campaign_idx
  on public.tg_outreach_dialogs (campaign_id);
create index if not exists tg_outreach_dialogs_account_idx
  on public.tg_outreach_dialogs (account_id);
create unique index if not exists tg_outreach_dialogs_campaign_account_user_idx
  on public.tg_outreach_dialogs (campaign_id, account_id, tg_user_id);

alter table public.tg_outreach_dialogs enable row level security;

create policy tg_outreach_dialogs_select_own on public.tg_outreach_dialogs
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_dialogs_insert_own on public.tg_outreach_dialogs
  for insert to authenticated
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_dialogs_update_own on public.tg_outreach_dialogs
  for update to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_dialogs_delete_own on public.tg_outreach_dialogs
  for delete to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- TG Outreach: processed clients
create table if not exists public.tg_outreach_processed (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  tg_user_id bigint not null,
  tg_username text,
  processed_at timestamptz not null default now(),
  unique (campaign_id, tg_user_id)
);

create index if not exists tg_outreach_processed_campaign_idx
  on public.tg_outreach_processed (campaign_id);

alter table public.tg_outreach_processed enable row level security;

create policy tg_outreach_processed_select_own on public.tg_outreach_processed
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_processed_insert_own on public.tg_outreach_processed
  for insert to authenticated
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_processed_delete_own on public.tg_outreach_processed
  for delete to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

-- TG Outreach: jobs (start / stop / restart)
create table if not exists public.tg_outreach_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('start','stop','restart')),
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists tg_outreach_jobs_campaign_idx
  on public.tg_outreach_jobs (campaign_id);
create index if not exists tg_outreach_jobs_status_idx
  on public.tg_outreach_jobs (status) where status = 'pending';

alter table public.tg_outreach_jobs enable row level security;

create policy tg_outreach_jobs_select_own on public.tg_outreach_jobs
  for select to authenticated using (user_id = auth.uid());
create policy tg_outreach_jobs_insert_own on public.tg_outreach_jobs
  for insert to authenticated with check (user_id = auth.uid());

-- TG Outreach: logs
create table if not exists public.tg_outreach_logs (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  level text not null default 'info'
    check (level in ('info','warning','error')),
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists tg_outreach_logs_campaign_created_idx
  on public.tg_outreach_logs (campaign_id, created_at desc);

alter table public.tg_outreach_logs enable row level security;

create policy tg_outreach_logs_select_own on public.tg_outreach_logs
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
