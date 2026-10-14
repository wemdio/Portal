-- migrate:no-transaction
--
-- ENG-кабинет, страница «Replies» (api/client/eng/replies,
-- lib/hypothesisEngine/engReplies.ts), читает ответы на кампании клиента из
-- instantly_activity_events запросом вида
--   where event_type = 'replied' and campaign_id in (...)
--   order by occurred_at desc, id desc limit N
-- Индекса под него нет: есть только (instantly_account_id, occurred_at) для
-- партнёрского API, и без нового индекса каждая страница кабинета проходит
-- всю таблицу вместе с событиями открытий всех воркспейсов.
--
-- Частичный — только 'replied': открытий на порядки больше, и им этот индекс
-- не нужен.
--
-- Вне транзакции и concurrently: таблицу пишет приёмник вебхуков рассыльщика
-- (api/instantly/webhook/[account]). Обычный create index держал бы его
-- вставки всю сборку, а рассыльщик выключает вебхук после серии неудачных
-- доставок (lib/instantly/activityWebhooks.ts) — тихий обрыв и этой ленты, и
-- партнёрского API. drop перед созданием — уборка невалидного индекса упавшей
-- сборки (шапка isNoTransactionMigration в app/scripts/db/ensureDatabase.js),
-- на первом прогоне ничего не делает.
--
-- Откат: drop index concurrently if exists public.ix_instantly_activity_replied_campaign
drop index concurrently if exists public.ix_instantly_activity_replied_campaign;

create index concurrently if not exists ix_instantly_activity_replied_campaign
  on public.instantly_activity_events (campaign_id, occurred_at desc, id desc)
  where event_type = 'replied';
