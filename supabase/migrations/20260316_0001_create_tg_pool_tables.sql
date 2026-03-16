-- TG Outreach pool: shared accounts/proxies/tags tables

create table if not exists public.tg_pool_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#3b82f6',
  created_by uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists tg_pool_tags_created_by_idx
  on public.tg_pool_tags (created_by);

alter table public.tg_pool_tags enable row level security;

create policy tg_pool_tags_select_own on public.tg_pool_tags
  for select to authenticated using (created_by = auth.uid());
create policy tg_pool_tags_insert_own on public.tg_pool_tags
  for insert to authenticated with check (created_by = auth.uid());
create policy tg_pool_tags_update_own on public.tg_pool_tags
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy tg_pool_tags_delete_own on public.tg_pool_tags
  for delete to authenticated using (created_by = auth.uid());

create table if not exists public.tg_pool_proxies (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  port integer not null check (port > 0 and port <= 65535),
  login text not null default '',
  password text not null default '',
  type text not null default 'HTTP'
    check (type in ('HTTP', 'SOCKS4', 'SOCKS5')),
  notes text not null default '',
  created_by uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tg_pool_proxies_created_by_idx
  on public.tg_pool_proxies (created_by);
create index if not exists tg_pool_proxies_ip_port_idx
  on public.tg_pool_proxies (ip, port);

alter table public.tg_pool_proxies enable row level security;

create policy tg_pool_proxies_select_own on public.tg_pool_proxies
  for select to authenticated using (created_by = auth.uid());
create policy tg_pool_proxies_insert_own on public.tg_pool_proxies
  for insert to authenticated with check (created_by = auth.uid());
create policy tg_pool_proxies_update_own on public.tg_pool_proxies
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy tg_pool_proxies_delete_own on public.tg_pool_proxies
  for delete to authenticated using (created_by = auth.uid());

create table if not exists public.tg_pool_accounts (
  id uuid primary key default gen_random_uuid(),
  format text not null default 'session_json'
    check (format in ('tdata', 'session_json')),
  session_data jsonb not null default '{}'::jsonb,
  phone text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  username text not null default '',
  bio text not null default '',
  avatar_url text not null default '',
  proxy_id uuid references public.tg_pool_proxies(id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'banned', 'frozen', 'limited')),
  account_price numeric(12,2) not null default 0,
  notes text not null default '',
  max_invites_per_day integer not null default 0,
  max_messages_per_day integer not null default 0,
  max_chat_messages_per_day integer not null default 0,
  max_contact_adds_per_day integer not null default 0,
  max_story_views_per_day integer not null default 0,
  max_neurocomment_posts_per_day integer not null default 0,
  control_tg_request_limit boolean not null default false,
  created_by uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tg_pool_accounts_created_by_idx
  on public.tg_pool_accounts (created_by);
create index if not exists tg_pool_accounts_proxy_idx
  on public.tg_pool_accounts (proxy_id);
create index if not exists tg_pool_accounts_phone_idx
  on public.tg_pool_accounts (phone);
create index if not exists tg_pool_accounts_username_idx
  on public.tg_pool_accounts (username);

alter table public.tg_pool_accounts enable row level security;

create policy tg_pool_accounts_select_own on public.tg_pool_accounts
  for select to authenticated using (created_by = auth.uid());
create policy tg_pool_accounts_insert_own on public.tg_pool_accounts
  for insert to authenticated with check (created_by = auth.uid());
create policy tg_pool_accounts_update_own on public.tg_pool_accounts
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy tg_pool_accounts_delete_own on public.tg_pool_accounts
  for delete to authenticated using (created_by = auth.uid());

create table if not exists public.tg_pool_account_tags (
  account_id uuid not null references public.tg_pool_accounts(id) on delete cascade,
  tag_id uuid not null references public.tg_pool_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, tag_id)
);

create index if not exists tg_pool_account_tags_tag_id_idx
  on public.tg_pool_account_tags (tag_id);

alter table public.tg_pool_account_tags enable row level security;

create policy tg_pool_account_tags_select_own on public.tg_pool_account_tags
  for select to authenticated
  using (
    exists (
      select 1
      from public.tg_pool_accounts a
      where a.id = account_id and a.created_by = auth.uid()
    )
  );
create policy tg_pool_account_tags_insert_own on public.tg_pool_account_tags
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tg_pool_accounts a
      where a.id = account_id and a.created_by = auth.uid()
    )
    and exists (
      select 1
      from public.tg_pool_tags t
      where t.id = tag_id and t.created_by = auth.uid()
    )
  );
create policy tg_pool_account_tags_delete_own on public.tg_pool_account_tags
  for delete to authenticated
  using (
    exists (
      select 1
      from public.tg_pool_accounts a
      where a.id = account_id and a.created_by = auth.uid()
    )
  );

create table if not exists public.tg_pool_proxy_tags (
  proxy_id uuid not null references public.tg_pool_proxies(id) on delete cascade,
  tag_id uuid not null references public.tg_pool_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (proxy_id, tag_id)
);

create index if not exists tg_pool_proxy_tags_tag_id_idx
  on public.tg_pool_proxy_tags (tag_id);

alter table public.tg_pool_proxy_tags enable row level security;

create policy tg_pool_proxy_tags_select_own on public.tg_pool_proxy_tags
  for select to authenticated
  using (
    exists (
      select 1
      from public.tg_pool_proxies p
      where p.id = proxy_id and p.created_by = auth.uid()
    )
  );
create policy tg_pool_proxy_tags_insert_own on public.tg_pool_proxy_tags
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tg_pool_proxies p
      where p.id = proxy_id and p.created_by = auth.uid()
    )
    and exists (
      select 1
      from public.tg_pool_tags t
      where t.id = tag_id and t.created_by = auth.uid()
    )
  );
create policy tg_pool_proxy_tags_delete_own on public.tg_pool_proxy_tags
  for delete to authenticated
  using (
    exists (
      select 1
      from public.tg_pool_proxies p
      where p.id = proxy_id and p.created_by = auth.uid()
    )
  );
