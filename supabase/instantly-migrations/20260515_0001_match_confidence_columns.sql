-- Аудитная колонка для AI-маппинга кампаний к проектам.
-- См. 20260514 (silent UPSERT loss) и lead-qualifier issues — мы любим
-- бесшумные баги. Чтобы AI-маппинг кампаний больше не был «магией»,
-- сохраняем уверенность AI и краткую причину прямо в БД, по факту:
--   match_source='auto-text' — substring matcher (точность 100%, без AI)
--   match_source='auto-ai'   — AI matcher, см. match_confidence (0..1)
--   match_source='manual'    — ручная привязка, confidence не имеет смысла
--
-- Backfill: текущие 'auto' записи остаются с NULL confidence.
-- Будущий sync через новый код заполнит правильно.

ALTER TABLE public.project_instantly_campaigns
  ADD COLUMN IF NOT EXISTS match_confidence real;

ALTER TABLE public.project_instantly_campaigns
  ADD COLUMN IF NOT EXISTS match_reason text;

-- Расширяем set значений match_source. Старые 'auto' пока оставляем как есть.
-- Новый код будет писать 'auto-text' / 'auto-ai' / 'manual'.
-- В UI можно дальше показывать всё это под общим лейблом «Автоматически»,
-- но в БД они разделены — для аудита и для разной обработки denylist.
