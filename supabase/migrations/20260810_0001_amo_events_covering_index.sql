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
-- Порядок ключей не меняется, поэтому новый индекс полностью заменяет старый:
-- любой план, который брал idx_amo_events_type_deal_changed, возьмёт и этот.
-- Держать оба — платить за вставку дважды на каждом ночном синке событий.
create index if not exists idx_amo_events_type_deal_changed_covering
  on public.amo_events (event_type, amo_deal_id, changed_at)
  include (from_value, to_value);

drop index if exists public.idx_amo_events_type_deal_changed;

comment on index public.idx_amo_events_type_deal_changed_covering is
  'Покрывает CTE ev во view amo_lead_stage_dates_v: INCLUDE снимает heap fetch за from_value/to_value. Заменяет idx_amo_events_type_deal_changed (те же ключи).';
