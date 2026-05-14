alter table public.telegram_links
  add column if not exists telegram_username text,
  add column if not exists telegram_first_name text,
  add column if not exists telegram_last_name text,
  add column if not exists updated_at timestamp with time zone not null default now();

create index if not exists idx_telegram_links_username
  on public.telegram_links(lower(telegram_username))
  where telegram_username is not null;
