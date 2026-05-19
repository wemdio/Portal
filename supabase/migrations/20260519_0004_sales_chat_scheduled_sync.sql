-- «Анализатор сейлз-переписок»: переход на плановую синхронизацию.
--
-- Вместо постоянных MTProto-соединений — синхронизация по расписанию
-- (01:00 МСК) и по ручному запуску. Каждый запуск инкрементально дотягивает
-- новые сообщения по всем активным аккаунтам.

-- Время последней успешной синхронизации аккаунта (точка отсчёта инкремента).
alter table public.sales_chat_accounts
  add column if not exists last_synced_at timestamptz;

-- Очередь запусков синхронизации (плановых и ручных).
create table if not exists public.sales_chat_sync_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('manual', 'scheduled')),
  sync_date date not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error')),
  requested_by uuid references public.profiles(id) on delete set null,
  accounts_total integer,
  accounts_done integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_sales_chat_sync_runs_pending
  on public.sales_chat_sync_runs(status, created_at) where status = 'pending';

-- Не больше одного планового запуска на дату (защита от гонок воркера).
create unique index if not exists idx_sales_chat_sync_runs_scheduled_unique
  on public.sales_chat_sync_runs(sync_date) where trigger = 'scheduled';

-- RLS включён без permissive-политик — доступ только через service role.
alter table public.sales_chat_sync_runs enable row level security;

grant all on public.sales_chat_sync_runs to service_role;
grant select, insert, update on public.sales_chat_sync_runs to authenticated;
