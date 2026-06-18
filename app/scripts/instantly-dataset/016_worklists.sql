-- 016_worklists.sql — два детерминированных «рабочих списка» (см. workflow-каталог 2026-06-19).
-- Не оценки/рейты, а точные проверяемые перечни → им не страшны малые выборки и конфаунды.

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

-- ── F) v_blocklist_candidates: повторно отписавшиеся, ещё не в блок-листе ─────
-- Email отписался (label='unsubscribe') в >=2 разных кампаниях, чьи даты старта
-- разнесены на >=7 дней (значит «отписался → потом снова написали», а не один тред),
-- и его НЕТ в raw_block_list (ни по email, ни по домену). Email-уровень — безопасный.
CREATE OR REPLACE VIEW v_blocklist_candidates AS
WITH bl AS (
  SELECT lower(raw_payload->>'bl_value') AS val, (raw_payload->>'is_domain')::boolean AS is_domain
  FROM raw_block_list WHERE raw_payload->>'bl_value' IS NOT NULL
),
unsub AS (
  SELECT l.lead_id,
         count(DISTINCT l.campaign_id)     AS n_campaigns,
         min(rc.timestamp_created)         AS first_camp,
         max(rc.timestamp_created)         AS last_camp,
         array_agg(DISTINCT left(rc.name, 50)) AS campaigns
  FROM reply_outcome_labels l
  JOIN raw_campaigns rc ON rc.id = l.campaign_id
  WHERE l.label = 'unsubscribe' AND l.lead_id LIKE '%@%'
  GROUP BY 1
)
SELECT u.lead_id AS email, u.n_campaigns,
       round(extract(epoch FROM (u.last_camp - u.first_camp)) / 86400) AS camp_span_days,
       u.campaigns
FROM unsub u
WHERE u.n_campaigns >= 2
  AND (u.last_camp - u.first_camp) >= interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM bl WHERE NOT bl.is_domain AND bl.val = lower(u.lead_id))
  AND NOT EXISTS (SELECT 1 FROM bl WHERE bl.is_domain AND lower(u.lead_id) LIKE '%@' || bl.val);
COMMENT ON VIEW v_blocklist_candidates IS 'F) Адреса, отписавшиеся в >=2 кампаниях с разницей стартов >=7 дн и ещё НЕ в блок-листе — их мы повторно письмами тревожим (compliance/репутация). Email-уровень (безопасный). Добавлять в блок ТОЛЬКО после ручного подтверждения (unsubscribe — LLM-метка, не истина). Домены НЕ блокировать через эту вьюху (free-mail вроде mail.ru несёт тысячи позитивных лидов).';
