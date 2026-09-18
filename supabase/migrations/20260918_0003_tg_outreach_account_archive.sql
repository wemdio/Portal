-- Архив аккаунтов TG-аутрича.
--
-- Мёртвые и проблемные аккаунты раньше только выключали или удаляли. Выключенные
-- копились в общем списке кампании, а удалённые пропадали вместе с историей —
-- через месяц уже не вспомнить, сколько номеров партии умерло и от чего.
-- Архив убирает аккаунт из списка и из работы, но хранит, когда и почему.
--
-- Архивный аккаунт всегда выключен (is_active = false): воркеры рассылки,
-- прогрева и обогащения берут только включённые, поэтому отдельных фильтров
-- по archived_at им не нужно. Включить его обратно API не даёт, пока он в архиве.
-- Причины — коды из lib/tgOutreach/accountArchive.ts; проверку списка держим в
-- коде, чтобы новая причина не требовала миграции.

alter table public.tg_outreach_accounts
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archive_note text,
  add column if not exists archived_by_name text;

comment on column public.tg_outreach_accounts.archived_at is
  'Когда аккаунт убрали в архив. null — аккаунт в работе (в списке кампании).';
comment on column public.tg_outreach_accounts.archive_reason is
  'Код причины архива (lib/tgOutreach/accountArchive.ts): session_dead, long_cooldown, resolve_fails, banned, frozen, spamblock, other.';
comment on column public.tg_outreach_accounts.archive_note is
  'Комментарий к архиву; обязателен для причины other.';
comment on column public.tg_outreach_accounts.archived_by_name is
  'Кто убрал в архив — имя сотрудника на момент действия.';
