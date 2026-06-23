-- «Ответы как в списке Instantly» = уникальные живые + уникальные авто-ответы.
--
-- Список кампаний Instantly в колонке REPLIED показывает
-- reply_count_unique + reply_count_automatic_unique (проверено на account-2:
-- Высокий 36+18=54, Средний 32+14=46, Топ 17+40=57 — совпало до цифры, и
-- rate = сумма ÷ new_leads_contacted: 54/973=5.55%, 46/1162=3.96%, 57/1143=4.99%).
-- Чтобы Портал совпадал со списком, синкаем авто-уникальные и складываем.
--
-- ВАЖНО: каталог рантайм читается через supabaseInstantly (ЭТА db,
-- instantly-postgres-prod). Парная миграция в supabase/migrations/ кладёт колонку
-- в неиспользуемую main-копию. Без instantly-миграции select упал бы с
-- undefined-column → 500. Прецедент: 20260622_0001_catalog_contacted_unique_replies.sql.

alter table public.instantly_campaign_catalog
  add column if not exists reply_count_automatic_unique integer;
