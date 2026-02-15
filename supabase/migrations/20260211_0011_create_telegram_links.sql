-- Telegram links table
create table if not exists public.telegram_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  telegram_id bigint not null,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_telegram_links_user_id
  on public.telegram_links(user_id);
create unique index if not exists idx_telegram_links_telegram_id
  on public.telegram_links(telegram_id);
create index if not exists idx_telegram_links_created_at
  on public.telegram_links(created_at desc);

-- RLS
alter table public.telegram_links enable row level security;

drop policy if exists telegram_links_select_own on public.telegram_links;
create policy telegram_links_select_own
  on public.telegram_links
  for select
  using (user_id = auth.uid());

drop policy if exists telegram_links_insert_service on public.telegram_links;
create policy telegram_links_insert_service
  on public.telegram_links
  for insert
  with check (auth.role() = 'service_role');
