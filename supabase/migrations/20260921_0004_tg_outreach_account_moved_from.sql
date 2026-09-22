-- Откуда пришёл перенесённый аккаунт — прямо в строке аккаунта.
--
-- История переездов лежит в tg_outreach_account_moves, но она про прошлое:
-- «этот аккаунт когда-то переезжал». А в списке нужен ответ про настоящее —
-- «этот аккаунт СЕЙЧАС гостит у нас из такой-то кампании», потому что от него
-- зависят и пометка в строке, и то, что с аккаунтом вообще можно сделать.
--
-- Отсюда денормализация: имя исходной кампании копируется рядом с её id.
-- Кампании удаляют, а пометка «пришёл из ATOL-1» должна пережить удаление —
-- иначе в строке останется голый uuid.
alter table public.tg_outreach_accounts
  add column if not exists moved_from_campaign_id uuid;

alter table public.tg_outreach_accounts
  add column if not exists moved_from_campaign_name text;

alter table public.tg_outreach_accounts
  add column if not exists moved_reason text;

alter table public.tg_outreach_accounts
  add column if not exists moved_at timestamptz;

comment on column public.tg_outreach_accounts.moved_from_campaign_id is
  'Кампания, из которой аккаунт перенесён сюда. Заполнено — аккаунт «в гостях»: его можно вернуть обратно, но не перенести в третью кампанию. Очищается при возврате.';
comment on column public.tg_outreach_accounts.moved_from_campaign_name is
  'Имя исходной кампании на момент переноса: кампании удаляют, а пометка в строке должна остаться читаемой.';
