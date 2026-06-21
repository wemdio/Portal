-- 016_worklists.sql — детерминированный «рабочий список» (см. workflow-каталог 2026-06-19).
-- Не оценка/рейт, а точный проверяемый перечень → ему не страшны малые выборки и конфаунды.
-- (F) v_blocklist_candidates убран по решению владельца 2026-06-19 — блок-лист не ведём здесь.

-- ── A) v_dropped_hot_leads: горячие лиды без нашего ответа ───────────────────
-- Лид ответил «interested», а нашего ответа (ue3) после нет. Два уточнения по фидбеку
-- владельца 2026-06-22:
--   1) ТОЛЬКО interested. referral (отдали телефон/чужой контакт) исключён — в нашем
--      процессе это НЕ лид (работаем по почтам, такие письма штатно игнорируем). referral
--      был 63% старого списка и создавал ложное «мы бросили лида».
--   2) «мы ответили» матчим по EMAIL (lead_id = адрес) в ЛЮБОЙ кампании (не только в той же,
--      ловит сабсиквенсы) и берём ПОСЛЕДНИЙ наш ответ (max): если отвечали и до, и после реплая,
--      прежний min ошибочно держал отвеченного лида в списке (≈30% ложных «брошенных»).
-- Гейт честности: ТОЛЬКО кампании, где мы вообще отвечаем из Instantly (camp_ue3). Слепое пятно
-- остаётся: ответы из клиентского ящика мимо Instantly в датасет не попадают.
DROP VIEW IF EXISTS v_dropped_hot_leads;  -- bucket-колонка убрана 2026-06-22 → CREATE OR REPLACE не пройдёт
CREATE VIEW v_dropped_hot_leads AS
WITH camp_ue3 AS (
  SELECT DISTINCT campaign_id FROM raw_emails WHERE ue_type = 3
),
ours AS (
  SELECT lead_id, max(timestamp_email) AS last_our_at
  FROM raw_emails WHERE ue_type = 3 GROUP BY 1
)
SELECT
  o.campaign_id,
  o.lead_id,
  o.first_reply_at,
  o.label_source,
  (now() - o.first_reply_at)                                   AS age,
  round(extract(epoch FROM (now() - o.first_reply_at)) / 86400) AS age_days
FROM v_reply_outcomes o
JOIN camp_ue3 c ON c.campaign_id = o.campaign_id
LEFT JOIN ours u ON u.lead_id = o.lead_id
WHERE COALESCE(o.llm_label = 'interested', o.instantly_interested, false)
  AND (u.last_our_at IS NULL OR u.last_our_at < o.first_reply_at);
COMMENT ON VIEW v_dropped_hot_leads IS 'A) Лиды, ответившие «interested», без нашего ответа (ue3) после их реплая, только по кампаниям где мы отвечаем из Instantly (camp_ue3). referral ИСКЛЮЧЁН (телефон/чужой контакт ≠ лид в нашем процессе, фидбек 2026-06-22). «Мы ответили» матчится по email в любой кампании (ловит сабсиквенсы/кросс-кампанийные треды). Потребитель фильтрует по age (14-30 дн). Слепое пятно: ответы из клиентского ящика мимо Instantly не видны. Процесс-флаг, НЕ «потеряно N сделок».';
