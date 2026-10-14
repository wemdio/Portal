-- «Рассылка»: итог синхронизации каталога Google Workspace по каждому аккаунту.
--
-- Синк идёт раз в час в sender-воркере и по кнопке на экране, но итог раньше
-- оставался только строкой в логе воркера: с экрана не было видно, когда
-- каталог читался последний раз и не отказал ли Google одному из Workspace.
-- Одна строка на аккаунт (админ Workspace), перезаписывается каждым прогоном.
-- Последняя ошибка хранится отдельно от последнего успеха: успешный прогон её
-- не стирает, а экран сравнивает даты и понимает, ошибка ли это сейчас.
create table if not exists public.sender_google_sync_accounts (
  account text primary key,
  -- Последний прогон — удачный или нет.
  last_run_at timestamptz not null default now(),
  -- auto — ежечасный синк воркера, manual — кнопка на экране.
  last_source text not null default 'auto',
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  -- Ящиков в каталоге и новых за последний прочитанный прогон.
  mailboxes integer,
  added integer
);

alter table public.sender_google_sync_accounts enable row level security;

grant all on public.sender_google_sync_accounts to service_role;

comment on table public.sender_google_sync_accounts is
  'Sender: last Google Workspace directory sync per admin account (hourly worker + manual button). last_error is kept after later successes; compare last_error_at with last_ok_at.';
