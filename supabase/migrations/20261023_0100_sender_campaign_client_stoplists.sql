-- «Рассылка»: стоп-листы клиента и проекта.
--
-- Решение владельца 23.10.2026: новые запуски идут через «Рассылку», и запрет
-- клиента или специалиста писать адресу должен действовать так же, как при
-- загрузке в Instantly (clientLaunch/appendLeads).
--
-- Клиент кампании — пользователь кабинета, чей стоп-лист
-- (client_blocked_contacts, база Instantly) действует на её получателей.
-- projects.client_user_id почти всегда пуст (1 проект из 177 на 23.10), поэтому
-- клиента хранит сама кампания: его выбирают в форме или ставит запуск.
--
-- Эти три миграции (0100, 0110, 0120) нужны коду воркеров sender-leads,
-- polza-outreach и «Рассылки»: без них сверка стоп-листов, заливка и запуск
-- кампаний падают. Применяет их ensureDatabase.js из нового образа портала при
-- деплое — образ воркеров без нового образа портала их не принесёт (23.10).
alter table public.sender_campaigns
  add column if not exists client_user_id uuid;

create index if not exists sender_campaigns_client_user_id_idx
  on public.sender_campaigns (client_user_id)
  where client_user_id is not null;

comment on column public.sender_campaigns.client_user_id is
  'Client cabinet user whose do-not-contact list (client_blocked_contacts) applies to this campaign; null for internal campaigns.';

-- Когда база кампании последний раз сверена со списками клиента и проекта.
-- Запуск по расписанию делает почтовый хост, а он базы Instantly не видит:
-- он запускает кампанию, только если сверка воркера sender-leads свежая.
alter table public.sender_campaigns
  add column if not exists stoplist_checked_at timestamptz;

comment on column public.sender_campaigns.stoplist_checked_at is
  'Last successful check of this campaign''s recipients against the client and project do-not-contact lists; a scheduled start requires a fresh one.';

-- Стоп-лист кампании пополняет и сверка со списками клиента и проекта
-- (lib/sender/stopLists): адрес, который закрыли уже после заливки, планировщик
-- снимает перед следующим письмом.
alter table public.sender_campaign_suppressions
  drop constraint if exists sender_campaign_suppressions_reason_check;

alter table public.sender_campaign_suppressions
  add constraint sender_campaign_suppressions_reason_check
  check (reason in ('hard_bounce', 'unsubscribe', 'manual', 'complaint', 'client_blocklist', 'project_block'));
