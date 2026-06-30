-- Уникальные открытия (open_count_unique) для каталога кампаний.
--
-- Открываемость на СПИСКЕ кампаний (/client) и в отчётах (buildClientReport)
-- считалась от ОБЩИХ открытий (open_count), который учитывает повторные открытия
-- и перезагрузки трекинг-пикселя (Apple Mail Privacy, прокси картинок) → ставка
-- вылетала за 100% и расходилась с детальной страницей (та уже на уникальных).
-- Синкаем open_count_unique, чтобы все экраны считали одинаково: уникальные ≤
-- contacted_count → ставка всегда ≤100%.
--
-- ВАЖНО: instantly_campaign_catalog рантайм читается/пишется через supabaseInstantly
-- (ЭТА db, instantly-postgres-prod), а НЕ main. Без этой колонки select в
-- readCampaignAnalyticsFromDb упал бы с undefined-column → 500 на /api/client/campaigns
-- и /reports, а upsert синка отвалился бы. Парная миграция в supabase/migrations/
-- держит main-копию (кодом не используется, max_sync=none) в паритете.
-- Прецедент: 20260622_0001_catalog_contacted_unique_replies.sql.

alter table public.instantly_campaign_catalog
  add column if not exists open_count_unique integer;
