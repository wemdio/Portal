-- TG User Parser: Telegram accounts (session_data stored plain, like tg-outreach)
create table if not exists public.tg_parser_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  api_id integer not null,
  api_hash text not null,
  phone text not null default '',
  session_data text not null default '',
  proxy_url text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists tg_parser_accounts_user_idx
  on public.tg_parser_accounts (user_id);

alter table public.tg_parser_accounts enable row level security;

create policy tg_parser_accounts_select_own on public.tg_parser_accounts
  for select to authenticated using (user_id = auth.uid());
create policy tg_parser_accounts_insert_own on public.tg_parser_accounts
  for insert to authenticated with check (user_id = auth.uid());
create policy tg_parser_accounts_update_own on public.tg_parser_accounts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tg_parser_accounts_delete_own on public.tg_parser_accounts
  for delete to authenticated using (user_id = auth.uid());
