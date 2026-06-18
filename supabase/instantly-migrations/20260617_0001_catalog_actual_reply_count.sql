-- Точный счётчик ответов из ФАКТИЧЕСКИХ входящих (/emails received), а не из
-- analytics-API.
--
-- Зачем: Instantly analytics reply_count недосчитывает ответы на
-- многопереписочных кампаниях. Аудит 17.06 (account-2): «Топ скор» — API даёт
-- 21 (портал показывал 18), а реально ответил 31 уникальный лид (60 живых
-- входящих, 0 автоответов). На Высокий/Средний расхождение мало. Квалификатор
-- account-2 не покрывает, вебхук-таблица только с 04.06 — единственный полный
-- источник ответов — /emails.
--
-- actual_reply_count заполняет throttled-синк syncActualReplyCounts (раз в
-- сутки на кампанию, только клиентские кампании, паузы между /emails). Отчёт
-- (buildClientReport) использует actual_reply_count при наличии, иначе
-- фоллбэк на reply_count.

ALTER TABLE public.instantly_campaign_catalog
  ADD COLUMN IF NOT EXISTS actual_reply_count integer,
  ADD COLUMN IF NOT EXISTS actual_reply_synced_at timestamptz;

COMMENT ON COLUMN public.instantly_campaign_catalog.actual_reply_count IS
  'Уникальных ответивших лидов по фактическим входящим (/emails received). Точнее analytics reply_count (тот недосчитывает). NULL = ещё не считалось.';
COMMENT ON COLUMN public.instantly_campaign_catalog.actual_reply_synced_at IS
  'Когда последний раз пересчитывался actual_reply_count из /emails (для throttle/gating синка).';
