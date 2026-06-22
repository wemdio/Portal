-- 016_worklists.sql — детерминированный «рабочий список» (см. workflow-каталог 2026-06-19).
-- Не оценка/рейт, а точный проверяемый перечень → ему не страшны малые выборки и конфаунды.
-- (F) v_blocklist_candidates убран по решению владельца 2026-06-19 — блок-лист не ведём здесь.

-- ── A) v_dropped_hot_leads: горячие лиды, чьё ПОСЛЕДНЕЕ письмо без нашего ответа ─
-- Лид ответил «interested», и его последнее входящее осталось без нашего ответа. Уточнения
-- по фидбеку владельца + адверсариальной перепроверке 2026-06-22:
--   1) ТОЛЬКО interested. referral (отдали телефон/чужой контакт) исключён — в нашем процессе
--      это НЕ лид (работаем по почтам, штатно игнорируем). referral был 63% старого списка.
--   2) «Мы ответили» считаем В ТРЕДЕ лида (по thread_id его реплаев), НЕ глобально по email:
--      наш ответ в чужой кампании/клиенте не должен помечать этот интерес отвеченным
--      (кросс-клиентское переисключение — доказано на info@shokolat-e.ru).
--   3) Якорь — ПОСЛЕДНИЙ входящий лида (max), не первый: лид, которому ответили, а он написал
--      ещё раз без ответа, корректно возвращается в список (мульти-раунд, ~38 живых).
-- Гейт честности: ТОЛЬКО кампании, где мы вообще отвечаем из Instantly (camp_ue3). Слепое пятно
-- остаётся: ответы из клиентского ящика мимо Instantly в датасет не попадают.
DROP VIEW IF EXISTS v_dropped_hot_leads;  -- схема колонок менялась → CREATE OR REPLACE не пройдёт
CREATE VIEW v_dropped_hot_leads AS
WITH camp_ue3 AS (
  SELECT DISTINCT campaign_id FROM raw_emails WHERE ue_type = 3
),
ue2 AS (
  SELECT campaign_id, lead_id, thread_id, timestamp_email AS reply_at,
         (i_status = 1 OR ai_interest_value = 1) AS inst_int_row
  FROM raw_emails
  WHERE ue_type = 2 AND lead_id IS NOT NULL
    AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day'
),
rf AS (
  SELECT campaign_id, lead_id, max(reply_at) AS last_reply_at, bool_or(inst_int_row) AS inst_int
  FROM ue2 GROUP BY 1, 2
),
our_in_thread AS (
  SELECT u.campaign_id, u.lead_id, max(e3.timestamp_email) AS last_our_at
  FROM ue2 u JOIN raw_emails e3 ON e3.ue_type = 3 AND e3.thread_id = u.thread_id
  GROUP BY 1, 2
)
SELECT
  rf.campaign_id,
  rf.lead_id,
  rf.last_reply_at,
  (now() - rf.last_reply_at)                                   AS age,
  round(extract(epoch FROM (now() - rf.last_reply_at)) / 86400) AS age_days
FROM rf
JOIN camp_ue3 c ON c.campaign_id = rf.campaign_id
LEFT JOIN reply_outcome_labels l ON l.campaign_id = rf.campaign_id AND l.lead_id = rf.lead_id
LEFT JOIN our_in_thread o ON o.campaign_id = rf.campaign_id AND o.lead_id = rf.lead_id
WHERE COALESCE(l.label = 'interested', rf.inst_int, false)
  AND (o.last_our_at IS NULL OR o.last_our_at < rf.last_reply_at);
COMMENT ON VIEW v_dropped_hot_leads IS 'A) Лиды, ответившие «interested», чьё ПОСЛЕДНЕЕ входящее осталось без нашего ответа В ТОМ ЖЕ ТРЕДЕ (thread_id), только по кампаниям где мы отвечаем из Instantly (camp_ue3). referral ИСКЛЮЧЁН (телефон/чужой контакт ≠ лид, фидбек 2026-06-22). «Мы ответили» — по треду лида, НЕ глобально по email (иначе ответ в чужой кампании скрывал бы интерес). Якорь = последний входящий (мульти-раунд возвращается). Фильтр по age (14-30 дн) на стороне потребителя. Слепое пятно: ответы из клиентского ящика мимо Instantly не видны. Процесс-флаг, НЕ «потеряно N сделок».';
