-- TG Outreach: индекс под курсорную листалку логов прогрева.
--
-- С 06.08.2026 прогрев пишет в журнал каждую отправку (кто → кому, какой текст),
-- то есть ~600–700 строк в день на кампанию вместо десятков. Вкладка листает
-- историю за все дни курсором по id (`... where campaign_id = ? and id < ?
-- order by id desc`), а существующие индексы идут по created_at и с account_id
-- посередине — для такой выборки они не работают.
--
-- Таблица небольшая, поэтому обычный CREATE INDEX (не CONCURRENTLY): блокировка
-- на доли секунды, зато миграция остаётся транзакционной.

create index if not exists tg_outreach_warmup_logs_campaign_id_idx
  on public.tg_outreach_warmup_logs (campaign_id, id desc);
