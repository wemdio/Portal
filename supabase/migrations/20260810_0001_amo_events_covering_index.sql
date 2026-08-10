-- Покрывающий индекс под CTE `ev` во view `amo_lead_stage_dates_v`.
--
-- Повод: дашборд первички долго грузится. Замер на боевых данных 10.08.2026 —
-- один SELECT из `amo_lead_stage_dates_v` (любой, с любым фильтром) стоит
-- ~155 мс, и почти вся эта цена — материализация CTE `ev`:
--
--   CTE ev -> WindowAgg (actual 0.318..88.027 rows=16318)
--     -> Index Scan using idx_amo_events_type_deal_changed (actual ..37.071)
--          Buffers: shared hit=15597
--
-- 15597 обращений к буферам на 16318 строк при том, что вся таблица — 21 МБ
-- (≈2700 страниц). Индекс отдаёт строки в порядке (event_type, amo_deal_id,
-- changed_at), а лежат они в куче в порядке вставки — heap fetch прыгает по
-- страницам и возвращается к одной и той же по многу раз. Ходит он туда
-- исключительно за `from_value`/`to_value`: остальные три колонки, которые
-- нужны `ev`, в индексе уже есть.
--
-- INCLUDE(from_value, to_value) делает скан index-only и убирает эти походы в
-- кучу. Колонки короткие (max length по боевым данным — 8 символов), индекс от
-- этого почти не растёт.
--
-- Порядок ключей не меняется, поэтому новый индекс перекрывает старый: любой
-- план, который брал idx_amo_events_type_deal_changed, возьмёт и этот.
--
-- Старый индекс при этом НЕ удаляется, и это не забывчивость.
--
-- Первая версия миграции заканчивалась `drop index if exists
-- idx_amo_events_type_deal_changed` — и уронила деплой с 55P03 (lock_timeout).
-- DROP INDEX берёт ACCESS EXCLUSIVE, то есть конфликтует с КАЖДЫМ читателем
-- таблицы, а в одной транзакции с CREATE это ещё и повышение уже удерживаемого
-- SHARE — ждать приходится всех, кто успел начать чтение. amo_events читается
-- дашбордами через amo_lead_stage_dates_v непрерывно, каждое чтение ~155 мс,
-- так что свободного окна практически не бывает: ранер отвёл на ожидание
-- lock_timeout=30 с и шесть попыток, и все шесть проиграли.
--
-- CREATE INDEX (без CONCURRENTLY) берёт всего лишь SHARE — он конфликтует с
-- пишущими, но не с читающими. В amo_events пишет только ночной синк, поэтому
-- эта половина миграции проходит.
--
-- CONCURRENTLY здесь недоступно: ранер оборачивает каждую миграцию в
-- транзакцию, а CREATE/DROP INDEX CONCURRENTLY внутри транзакции запрещены.
--
-- Цена лишнего индекса — вставка в него на ночном синке. В таблице 16 тыс.
-- строк, так что цена символическая, и платить за неё сорванным деплоем
-- незачем. Убрать старый индекс можно отдельно и вручную, в спокойный момент:
-- `drop index concurrently idx_amo_events_type_deal_changed;`
create index if not exists idx_amo_events_type_deal_changed_covering
  on public.amo_events (event_type, amo_deal_id, changed_at)
  include (from_value, to_value);

comment on index public.idx_amo_events_type_deal_changed_covering is
  'Покрывает CTE ev во view amo_lead_stage_dates_v: INCLUDE снимает heap fetch за from_value/to_value. Перекрывает idx_amo_events_type_deal_changed (те же ключи); тот оставлен, чтобы не брать ACCESS EXCLUSIVE на деплое.';
