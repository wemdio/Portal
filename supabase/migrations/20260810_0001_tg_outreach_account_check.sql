-- Проверка аккаунтов: жив ли, кто ещё в него заходит.
--
-- Повод. За две недели ~50 аккаунтов потеряли сессии (SESSION_REVOKED), причём
-- пачками за считанные часы, а банов номеров при этом ноль. Отличить «нас
-- разлогинили» от «номер забанили» можно было только руками, по одному. Здесь
-- результат проверки хранится рядом с аккаунтом, чтобы вся партия была видна
-- одним взглядом.
--
-- other_sessions отвечает на главный вопрос расследования: в аккаунте кроме нас
-- кто-то есть? Telegram отдаёт список активных сеансов с устройством, страной и
-- временем — по нему сразу видно и продавца, и второй софт.

alter table public.tg_outreach_accounts
  add column if not exists check_status text,
  add column if not exists check_detail text,
  add column if not exists checked_at timestamptz,
  add column if not exists other_sessions jsonb;

comment on column public.tg_outreach_accounts.check_status is
  'Итог последней проверки: ok | session_revoked | banned | session_duplicate | restricted | proxy_dead | no_session | error.';

comment on column public.tg_outreach_accounts.other_sessions is
  'Чужие активные сеансы Telegram на момент проверки: устройство, страна, когда заходили. Пусто — кроме портала в аккаунте никого.';
