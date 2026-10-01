-- migrate:no-transaction
--
-- Индекс под источник автоаутрича «Яндекс Карты: новые точки сетей»
-- (`public.polza_ru_ymaps_new_branches`, миграция 20260925_0001).
--
-- Что было: запуск 01.10.2026 отдавал
-- `Яндекс Карты: canceling statement due to statement timeout`. В функции стоит
-- `statement_timeout = '30s'`, а план на боевом каталоге — два параллельных
-- seq scan по `yandex_maps_company_catalog` (10,0 млн строк, heap 11 ГБ) плюс
-- nested loop semi join с `Join Filter: f.network_id = o.network_id`:
--
--   Nested Loop Semi Join  (cost=1560313.72..3108431.49)
--     ->  Parallel Seq Scan on yandex_maps_company_catalog f   -- 11 ГБ
--     ->  Materialize -> Parallel Seq Scan on ... o            -- ещё 11 ГБ
--
-- Индексов по `network_id` и `first_seen_at` в каталоге не было ни одного, и
-- стоимость плана не зависела от того, что в ответе ноль строк.
--
-- Почему индекс частичный и крошечный: `network_id` заполнен у 0,02% строк
-- (`most_common_vals = {''}`, частота 0,999767 — примерно 2,3 тыс. карточек из
-- 10 млн; поле пишет только импорт выгрузки `app/scripts/yandex-maps-catalog/
-- import-snapshot.ts`, живой обход карт его не заполняет). Предикат совпадает
-- с условием `network_id <> ''` в обеих половинах запроса, поэтому планировщик
-- матчит его напрямую — так же, как уже делает с `idx_yandex_maps_catalog_website`.
--
-- Порядок колонок: `(network_id, first_seen_at)` обслуживает и внешнюю выборку
-- (проход по всему индексу с фильтром `first_seen_at >= p_since`), и подзапрос
-- `exists` (точный поиск по network_id + диапазон по дате).
--
-- Почему `concurrently` и `no-transaction`: обычный `create index` держит на
-- таблице SHARE всё время сборки, а сборка требует полного обхода heap в 11 ГБ
-- — при живой записи в каталог это упирается в `lock_timeout = 30s` и роняет
-- деплой (прецедент 08.08.2026,
-- docs/incidents/2026-08-08-yandex-maps-index-migration-lock.md). Первый деплой
-- с этой миграцией простоит на этом шаге несколько минут: индекс выйдет
-- маленьким, но heap обойдётся целиком и дважды.
--
-- Почему сначала drop: оборванная сборка `concurrently` оставляет невалидный
-- индекс, и повторный `create ... if not exists` увидел бы имя занятым и молча
-- ничего не сделал. На первом прогоне строка — no-op, на повторном — уборка.

drop index concurrently if exists public.idx_ymc_network_first_seen;

create index concurrently if not exists idx_ymc_network_first_seen
  on public.yandex_maps_company_catalog (network_id, first_seen_at)
  where network_id <> '';
