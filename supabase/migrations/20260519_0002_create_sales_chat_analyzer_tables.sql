-- «Анализатор сейлз-переписок» — захват переписок Telegram-аккаунтов сейлз-менеджеров.
--
-- Подключаем ТГ-аккаунт (телефон → код → сессия), храним зашифрованную сессию,
-- пишем все диалоги в БД: при подключении — полный бэкфилл истории, далее реал-тайм.
--
-- ПОЛНОСТЬЮ ИЗОЛИРОВАННЫЕ таблицы sales_chat_* — не пересекаются с tg_parser_* / tg_outreach_*.
--
-- RLS включён, но БЕЗ permissive-политик: PostgREST для роли authenticated не получит
-- доступ. Весь доступ — через service role (worker и API-роуты после проверки роли).

create table if not exists public.sales_chat_accounts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.profiles(id) on delete set null,

  label text,
  phone text not null,

  -- Метаданные подключённого ТГ-аккаунта.
  tg_user_id bigint,
  tg_username text,
  tg_first_name text,
  tg_last_name text,

  -- Зашифрованная (AES-256-GCM) строка StringSession.
  session_sealed text not null,

  status text not null default 'active'
    check (status in ('active', 'auth_error', 'disabled')),

  -- Бэкфилл истории при первом подключении.
  backfill_status text not null default 'pending'
    check (backfill_status in ('pending', 'running', 'done', 'error')),
  backfill_dialogs_done integer not null default 0,
  backfill_dialogs_total integer,

  last_connected_at timestamptz,
  last_event_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_chat_accounts_status
  on public.sales_chat_accounts(status);

create table if not exists public.sales_chat_dialogs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sales_chat_accounts(id) on delete cascade,

  tg_peer_id bigint not null,
  peer_type text not null default 'user'
    check (peer_type in ('user', 'chat', 'channel')),
  peer_title text,
  peer_username text,

  last_message_at timestamptz,
  message_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_sales_chat_dialogs_unique
  on public.sales_chat_dialogs(account_id, tg_peer_id);
create index if not exists idx_sales_chat_dialogs_account_last
  on public.sales_chat_dialogs(account_id, last_message_at desc);

create table if not exists public.sales_chat_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sales_chat_accounts(id) on delete cascade,
  dialog_id uuid not null references public.sales_chat_dialogs(id) on delete cascade,

  tg_message_id bigint not null,
  tg_peer_id bigint not null,

  direction text not null check (direction in ('in', 'out')),
  sender_tg_id bigint,
  sender_name text,

  text text,
  media_type text,

  sent_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Идемпотентность: бэкфилл и реал-тайм-захват могут пересекаться без дублей.
create unique index if not exists idx_sales_chat_messages_unique
  on public.sales_chat_messages(account_id, tg_peer_id, tg_message_id);
create index if not exists idx_sales_chat_messages_dialog
  on public.sales_chat_messages(dialog_id, sent_at);

-- Авто-обновление updated_at.
create or replace function public.set_sales_chat_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_sales_chat_accounts_set_updated_at on public.sales_chat_accounts;
create trigger trg_sales_chat_accounts_set_updated_at
  before update on public.sales_chat_accounts
  for each row execute function public.set_sales_chat_updated_at();

drop trigger if exists trg_sales_chat_dialogs_set_updated_at on public.sales_chat_dialogs;
create trigger trg_sales_chat_dialogs_set_updated_at
  before update on public.sales_chat_dialogs
  for each row execute function public.set_sales_chat_updated_at();

-- RLS включён, permissive-политик нет — доступ только через service role.
alter table public.sales_chat_accounts enable row level security;
alter table public.sales_chat_dialogs enable row level security;
alter table public.sales_chat_messages enable row level security;

grant all on public.sales_chat_accounts to service_role;
grant select, insert, update on public.sales_chat_accounts to authenticated;

grant all on public.sales_chat_dialogs to service_role;
grant select, insert, update on public.sales_chat_dialogs to authenticated;

grant all on public.sales_chat_messages to service_role;
grant select, insert, update on public.sales_chat_messages to authenticated;
