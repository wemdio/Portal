-- TG Outreach: proxies, accounts, tags, junction tables

-- Tags
create table if not exists tg_outreach_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#3b82f6',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table tg_outreach_tags enable row level security;

create policy "Authenticated users can view tags"
  on tg_outreach_tags for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert tags"
  on tg_outreach_tags for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update tags"
  on tg_outreach_tags for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete tags"
  on tg_outreach_tags for delete using (auth.role() = 'authenticated');

-- Proxies
create table if not exists tg_outreach_proxies (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  port integer not null,
  login text not null default '',
  password text not null default '',
  type text not null default 'HTTP' check (type in ('HTTP', 'SOCKS4', 'SOCKS5')),
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tg_outreach_proxies enable row level security;

create policy "Authenticated users can view proxies"
  on tg_outreach_proxies for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert proxies"
  on tg_outreach_proxies for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update proxies"
  on tg_outreach_proxies for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete proxies"
  on tg_outreach_proxies for delete using (auth.role() = 'authenticated');

-- Accounts
create table if not exists tg_outreach_accounts (
  id uuid primary key default gen_random_uuid(),
  format text not null default 'session_json' check (format in ('tdata', 'session_json')),
  session_data jsonb not null default '{}'::jsonb,
  phone text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  username text not null default '',
  bio text not null default '',
  avatar_url text not null default '',
  proxy_id uuid references tg_outreach_proxies(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'banned', 'frozen', 'limited')),
  account_price numeric not null default 0,
  notes text not null default '',

  max_invites_per_day integer not null default 3,
  max_messages_per_day integer not null default 3,
  max_chat_messages_per_day integer not null default 20,
  max_contact_adds_per_day integer not null default 3,
  max_story_views_per_day integer not null default 50,
  max_neurocomment_posts_per_day integer not null default 100,
  control_tg_request_limit boolean not null default false,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tg_outreach_accounts enable row level security;

create policy "Authenticated users can view accounts"
  on tg_outreach_accounts for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert accounts"
  on tg_outreach_accounts for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update accounts"
  on tg_outreach_accounts for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete accounts"
  on tg_outreach_accounts for delete using (auth.role() = 'authenticated');

-- Junction: account <-> tag
create table if not exists tg_outreach_account_tags (
  account_id uuid not null references tg_outreach_accounts(id) on delete cascade,
  tag_id uuid not null references tg_outreach_tags(id) on delete cascade,
  primary key (account_id, tag_id)
);

alter table tg_outreach_account_tags enable row level security;

create policy "Authenticated users can view account_tags"
  on tg_outreach_account_tags for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert account_tags"
  on tg_outreach_account_tags for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can delete account_tags"
  on tg_outreach_account_tags for delete using (auth.role() = 'authenticated');

-- Junction: proxy <-> tag
create table if not exists tg_outreach_proxy_tags (
  proxy_id uuid not null references tg_outreach_proxies(id) on delete cascade,
  tag_id uuid not null references tg_outreach_tags(id) on delete cascade,
  primary key (proxy_id, tag_id)
);

alter table tg_outreach_proxy_tags enable row level security;

create policy "Authenticated users can view proxy_tags"
  on tg_outreach_proxy_tags for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert proxy_tags"
  on tg_outreach_proxy_tags for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can delete proxy_tags"
  on tg_outreach_proxy_tags for delete using (auth.role() = 'authenticated');

-- Indexes
create index if not exists idx_tg_outreach_accounts_proxy on tg_outreach_accounts(proxy_id);
create index if not exists idx_tg_outreach_accounts_status on tg_outreach_accounts(status);
create index if not exists idx_tg_outreach_accounts_created_by on tg_outreach_accounts(created_by);
create index if not exists idx_tg_outreach_proxies_created_by on tg_outreach_proxies(created_by);

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
