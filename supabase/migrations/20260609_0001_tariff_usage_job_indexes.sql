-- Индексы под расчёт тарифа клиента (app/src/lib/tariffs.ts → countClientRows).
-- Эти job-таблицы фильтруются по (user_id [, parser_type], created_at, status)
-- на КАЖДОЙ загрузке /api/client/tariff (баннер оплаты в layout + сама страница
-- тарифа + инлайн-виджет) и после каждого запуска кампании. Индекса по user_id
-- на них не было вовсе (на parser_jobs — вообще ни одного индекса кроме PK),
-- поэтому каждый расчёт тарифа делал seq scan по растущим таблицам ВСЕХ клиентов.
--
-- Не CONCURRENTLY: ensureDatabase.js выполняет миграции внутри транзакции, а
-- CREATE INDEX CONCURRENTLY в PostgreSQL в транзакции запрещён (см. комментарий
-- в 20260326_0001_parser_results_composite_indexes.sql). Таблицы небольшие и
-- пишутся воркерами пачками — короткий лок на сборку индекса при деплое
-- (выкатывать off-peak) безопасен. `if not exists` делает миграцию идемпотентной:
-- если индекс уже создан вручную CONCURRENTLY на проде, миграция станет no-op.

-- parser_jobs: countClientRows фильтрует hh-джобы по
-- (user_id, parser_type='hh_vacancies', created_at, status).
create index if not exists idx_parser_jobs_user_type_created
  on public.parser_jobs (user_id, parser_type, created_at desc);

-- search_parser_jobs: фильтр по (user_id, created_at, status).
create index if not exists idx_search_parser_jobs_user_created
  on public.search_parser_jobs (user_id, created_at desc);

-- yandex_maps_jobs: фильтр по (user_id, created_at, status).
create index if not exists idx_yandex_maps_jobs_user_created
  on public.yandex_maps_jobs (user_id, created_at desc);
