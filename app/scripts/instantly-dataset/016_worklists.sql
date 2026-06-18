-- 016_worklists.sql — детерминированный «рабочий список» (см. workflow-каталог 2026-06-19).
-- Не оценка/рейт, а точный проверяемый перечень → ему не страшны малые выборки и конфаунды.
-- (F) v_blocklist_candidates убран по решению владельца 2026-06-19 — блок-лист не ведём здесь.

-- ── A) v_dropped_hot_leads: горячие лиды без нашего ответа ───────────────────
-- positive-ответ (interested|referral, канонический v_reply_outcomes), а ue3 (наш ответ)
-- после него отсутствует. Гейт честности: ТОЛЬКО кампании, где мы вообще отвечаем из
-- Instantly (camp_ue3) — иначе клиент отвечает из своего ящика, и «нет ue3» = слепое
-- пятно, а не брошенный лид. Окно свежести/возраст — на стороне потребителя.
CREATE OR REPLACE VIEW v_dropped_hot_leads AS
WITH camp_ue3 AS (
  SELECT DISTINCT campaign_id FROM raw_emails WHERE ue_type = 3
),
ours AS (
  SELECT campaign_id, lead_id, min(timestamp_email) AS first_our_at
  FROM raw_emails WHERE ue_type = 3 GROUP BY 1, 2
)
SELECT
  o.campaign_id,
  o.lead_id,
  o.first_reply_at,
  CASE WHEN o.llm_label = 'referral' THEN 'referral' ELSE 'interested' END AS bucket,
  o.label_source,
  (now() - o.first_reply_at)                                   AS age,
  round(extract(epoch FROM (now() - o.first_reply_at)) / 86400) AS age_days
FROM v_reply_outcomes o
JOIN camp_ue3 c ON c.campaign_id = o.campaign_id
LEFT JOIN ours u ON u.campaign_id = o.campaign_id AND u.lead_id = o.lead_id
WHERE o.positive
  AND (u.first_our_at IS NULL OR u.first_our_at < o.first_reply_at);
COMMENT ON VIEW v_dropped_hot_leads IS 'A) Горячие лиды (interested|referral) без нашего ответа (ue3) после их реплая, только по кампаниям где мы отвечаем из Instantly (camp_ue3). bucket: interested срочнее, referral мягче (часто ведётся новым тредом). Потребитель фильтрует по age (окно 14-30 дн — живые, не кладбище). Это процесс-флаг, НЕ «потеряно N сделок» (сделок в датасете нет).';
