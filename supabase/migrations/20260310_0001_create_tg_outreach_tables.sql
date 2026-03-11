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
