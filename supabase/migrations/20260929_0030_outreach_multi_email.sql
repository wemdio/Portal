-- Автоаутричи (RU и EN): до трёх проверенных почт на компанию (29.09.2026,
-- docs/superpowers/specs/2026-09-29-outreach-multi-email-design.md).
--
-- Раньше у компании в работе был ровно один адрес — первый, прошедший проверку.
-- Теперь поиск собирает до трёх адресов со статусом OK в порядке приоритета.
-- Главный адрес (первый) по-прежнему лежит в прежних колонках
-- (EN selected_company_email / email_type / email_verification, RU
-- recipient_email / email_type / is_routing / email_verification) — всё, что от
-- них зависит, работает как раньше. Полный список — в emails:
--   [{ "email", "verification", "type", "is_routing" }], главный — первым.
-- Старые строки (emails = []) читаются как «только главный адрес».

alter table public.polza_outreach_companies
  add column if not exists emails jsonb not null default '[]'::jsonb;

alter table public.polza_ru_outreach_companies
  add column if not exists emails jsonb not null default '[]'::jsonb;

-- «Рассылка»: адреса одной компании пишутся с одного ящика и с разницей в
-- сутки. Заливка аутрича ставит в group_key id строки компании; у ручных
-- рассылок он пустой, и для них планировщик ничего не меняет. Индекс — только
-- по заполненным ключам: планировщик ищет соседей получателя в его рассылке.

alter table public.sender_recipients
  add column if not exists group_key text;

create index if not exists idx_sender_recipients_campaign_group
  on public.sender_recipients (campaign_id, group_key)
  where group_key is not null;
