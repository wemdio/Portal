-- Фикс «сирот-ответов» Instantly (инцидент 11.08.2026).
--
-- Предыстория: лид ответил на аутрич-переписку с ДРУГОГО адреса своей компании
-- и со сломанными заголовками треда. Instantly НЕ привязал письмо к кампании
-- (campaign_id=null, lead=null) — оно лежит сиротой в Unibox «Others». Его
-- подхватил othersWatchdog, атрибутировал по цитируемому домену через
-- account-campaign-mappings и отправил клиенту DM «Новый ответ по вашей
-- кампании». Это ложная атрибуция: кабинет /client/replies читает live из
-- Instantly только кампанийные письма, и этого ответа там нет и быть не может.
--
-- Новые колонки фиксируют такие письма честно:
--   reply_out_of_campaign — true, когда письмо подхвачено ВНЕ треда кампании
--     (Others-контур вотчдога, детектор: у исходного письма campaign_id пуст
--     или не совпадает с атрибутированным). Main-poll контур таких не пишет —
--     там фильтр !!campaign_id в fetchRecentLinkedReplies;
--   eaccount — ящик, физически принявший письмо. Для честного DM («Ящик:») и
--     блока «Ответы вне кампании» в кабинете. Приватность (чужой ящик не
--     показывать) решается на отображении — см. resolveClientMailboxes в
--     clientCampaignReplies/foreignMailboxFilter.
--
-- Только ADD COLUMN на существующую таблицу — grants/политики не требуются
-- (таблица и её service-политика созданы в 20260401_0001_init_instantly_schema).
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS reply_out_of_campaign boolean NOT NULL DEFAULT false;

ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS eaccount text;

COMMENT ON COLUMN public.instantly_lead_qualifications.reply_out_of_campaign IS
  'true = письмо не привязано Instantly к кампании (сирота из Others, атрибуция по цитируемому домену); false = обычный кампанийный ответ.';
COMMENT ON COLUMN public.instantly_lead_qualifications.eaccount IS
  'Ящик, физически принявший письмо (Email.eaccount). Для сирот — «Ящик:» в DM и кабинете; чужой ящик клиенту не показываем.';
