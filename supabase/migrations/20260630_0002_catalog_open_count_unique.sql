-- Уникальные открытия — паритет схемы main-копии instantly_campaign_catalog
-- (кодом НЕ используется, max_sync=none). Реально работающая колонка добавляется
-- парной миграцией в
-- supabase/instantly-migrations/20260630_0002_catalog_open_count_unique.sql.

alter table public.instantly_campaign_catalog
  add column if not exists open_count_unique integer;
