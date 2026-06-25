-- «Ответы как в списке Instantly» — авто-уникальные ответы (для main-копии каталога).
--
-- Main-копия instantly_campaign_catalog кодом НЕ используется (max_sync=none) —
-- рантайм работает с instantly-postgres-prod. Эта миграция держит схемы в паритете;
-- реально работающая колонка добавляется парной миграцией в
-- supabase/instantly-migrations/20260623_0001_catalog_reply_automatic_unique.sql.

alter table public.instantly_campaign_catalog
  add column if not exists reply_count_automatic_unique integer;
