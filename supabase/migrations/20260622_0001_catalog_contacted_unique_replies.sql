-- Метрики кампаний «как в Instantly» (на контакт).
--
-- Зачем: страница «Кампании» считала открываемость = открытия ÷ ПИСЬМА (каждый
-- контакт получает ~3 письма → знаменатель втрое больше → ставка занижена против
-- Instantly, который делит на КОНТАКТЫ), а «Ответы» брала reply_count (всего
-- событий), тогда как Instantly в аналитике показывает уникальных ответивших.
-- Досинхронизируем из /campaigns/analytics: contacted_count (знаменатель
-- открываемости) и reply_count_unique (уникальные ответившие). См.
-- syncInstantlyCampaignAnalytics + app/src/app/client/page.tsx.

alter table public.instantly_campaign_catalog
  add column if not exists contacted_count integer,
  add column if not exists reply_count_unique integer;
