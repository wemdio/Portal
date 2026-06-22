-- Метрики кампаний «как в Instantly» (на контакт) — для ЖИВОГО каталога.
--
-- ВАЖНО: instantly_campaign_catalog рантайм читается/пишется через supabaseInstantly
-- (INSTANTLY db, instantly-postgres-prod), а НЕ main. Парная миграция в
-- supabase/migrations/ добавляет колонки в main-копию каталога (она не используется
-- кодом, max_sync=none) — а ЭТА добавляет их туда, где код реально работает.
-- Без неё readCampaignAnalyticsFromDb.select упал бы с undefined-column → 500 на
-- /api/client/campaigns и /reports, а upsert синка отвалился бы целиком. Прецедент:
-- 20260617_0001_catalog_actual_reply_count.sql. См. app/src/app/client/page.tsx и
-- syncInstantlyCampaignAnalytics.

alter table public.instantly_campaign_catalog
  add column if not exists contacted_count integer,
  add column if not exists reply_count_unique integer;
