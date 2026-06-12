-- 012_canonical_metrics.sql — канонический слой метрик для campaign-insights.
-- Контекст: wiki/analyses/2026-06-11-dataset-objectivity-audit.md
-- Чинит разом все найденные аудитом ловушки сырых таблиц:
--   * 20.2% дублей автоответчиков  -> ответы считаем как 1 строка на (campaign, lead)
--   * фантомные даты (2008)        -> кламп timestamp_email
--   * сентинелы (-29995, -29999..) -> i_status только {-3,-1,1}, ai_interest только {-1,1}
--   * зомби-кампании (replies/0)   -> universe tag: email | snapshot_only | none
--   * возраст кампании             -> left_truncated флаг (created << первая retained-отправка)
--   * смешение источников          -> lifetime-числа отдельными колонками с as-of датой

-- ── Wilson 95% CI для пропорций (безопасен при n=0 -> NULL) ────────────────
CREATE OR REPLACE FUNCTION wilson_ci_low(k numeric, n numeric, z numeric DEFAULT 1.96)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 OR k IS NULL THEN NULL ELSE
    GREATEST(0, ((k/n) + z*z/(2*n) - z * sqrt(((k/n)*(1-(k/n)) + z*z/(4*n)) / n)) / (1 + z*z/n))
  END
$$;
COMMENT ON FUNCTION wilson_ci_low(numeric, numeric, numeric) IS 'Нижняя граница 95% Wilson CI для доли k/n. NULL при n<=0.';

CREATE OR REPLACE FUNCTION wilson_ci_high(k numeric, n numeric, z numeric DEFAULT 1.96)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL OR n <= 0 OR k IS NULL THEN NULL ELSE
    LEAST(1, ((k/n) + z*z/(2*n) + z * sqrt(((k/n)*(1-(k/n)) + z*z/(4*n)) / n)) / (1 + z*z/n))
  END
$$;
COMMENT ON FUNCTION wilson_ci_high(numeric, numeric, numeric) IS 'Верхняя граница 95% Wilson CI для доли k/n. NULL при n<=0.';

-- ── v_reply_facts: ОДНА строка на (campaign, lead) ──────────────────────────
-- Единственный легальный источник для "сколько ответили". Сырые ue2-строки
-- содержат 20.2% повторов автоответчиков (до 12x на лида) — здесь они схлопнуты.
CREATE OR REPLACE VIEW v_reply_facts AS
SELECT
  campaign_id,
  lead_id,
  min(timestamp_email)                                   AS first_reply_at,
  max(timestamp_email)                                   AS last_reply_at,
  count(*)                                               AS reply_rows,
  count(DISTINCT md5(coalesce(body_text, '')))           AS distinct_bodies,
  (count(*) > count(DISTINCT md5(coalesce(body_text,'')))) AS has_repeated_body, -- маркер автоответчика
  bool_or(i_status = 1 OR ai_interest_value = 1)         AS interested,
  bool_or(i_status IN (-3,-1,1) OR ai_interest_value IN (-1,1)) AS labeled,
  max(CASE WHEN i_status IN (-3,-1,1) THEN i_status END) AS best_i_status
FROM raw_emails
WHERE ue_type = 2
  AND lead_id IS NOT NULL
  AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day' -- кламп: убивает битые Date-заголовки (2008 и т.п.)
GROUP BY 1, 2;
COMMENT ON VIEW v_reply_facts IS 'Канонический факт ответа: 1 строка на (campaign_id, lead_id). Дедуп автоответчиков, кламп дат, сентинелы i_status/ai_interest_value отфильтрованы. labeled = есть осмысленная метка исхода; interested = Instantly пометил interested.';

-- ── v_campaign_daily_canonical: дневной ряд, последний снапшот побеждает ───
-- 16 месяцев истории (с 2025-02-07, бэкфилл 2026-06-11) + еженощные дельты.
CREATE OR REPLACE VIEW v_campaign_daily_canonical AS
SELECT DISTINCT ON (d.campaign_id, d.date)
  d.campaign_id, d.date,
  d.sent, d.replies, d.unique_replies, d.opened, d.unique_opened,
  d.clicks, d.unique_clicks, d.bounced, d.unsubscribed,
  ds.started_at AS as_of
FROM raw_campaign_analytics_daily_snap d
JOIN dataset_snapshots ds ON ds.id = d.snapshot_id
ORDER BY d.campaign_id, d.date, ds.started_at DESC;
COMMENT ON VIEW v_campaign_daily_canonical IS 'Дневная аналитика per campaign: при пересечении снапшотов берётся самый свежий. Покрытие с 2025-02-07 (16-мес бэкфилл). Это агрегаты Instantly — источник для трендов/сезонности; для текстов ответов см. raw_emails (ретеншен ~90 дней).';

-- ── v_campaign_health: канонические метрики кампании с universe-тегом ──────
CREATE OR REPLACE VIEW v_campaign_health AS
WITH sends AS (
  SELECT campaign_id, count(*) AS sent_retained,
         min(timestamp_email) AS sent_from, max(timestamp_email) AS sent_to
  FROM raw_emails
  WHERE ue_type = 1
    AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day'
  GROUP BY 1
), reps AS (
  SELECT campaign_id,
         count(*)                            AS repliers,
         count(*) FILTER (WHERE labeled)     AS labeled_repliers,
         count(*) FILTER (WHERE interested)  AS interested_repliers
  FROM v_reply_facts
  GROUP BY 1
), snap AS (
  SELECT DISTINCT ON (o.campaign_id)
         o.campaign_id, o.emails_sent_count AS lifetime_sent,
         o.reply_count AS lifetime_replies_instantly,
         o.bounced_count AS lifetime_bounced,
         o.open_count_unique AS lifetime_unique_opens,
         ds.started_at AS snapshot_as_of
  FROM raw_campaign_analytics_overview_snap o
  JOIN dataset_snapshots ds ON ds.id = o.snapshot_id
  ORDER BY o.campaign_id, ds.started_at DESC
)
SELECT
  c.id   AS campaign_id,
  c.name,
  c.status,
  ls.label AS status_label,
  cc.client,
  seg.segment,
  c.timestamp_created AS campaign_created,
  CASE WHEN s.campaign_id IS NOT NULL THEN 'email'
       WHEN sn.campaign_id IS NOT NULL THEN 'snapshot_only'
       ELSE 'none' END AS universe,
  COALESCE(c.timestamp_created < s.sent_from - interval '7 days', false) AS left_truncated,
  s.sent_retained, s.sent_from, s.sent_to,
  r.repliers, r.labeled_repliers, r.interested_repliers,
  -- rate-метрики ТОЛЬКО при достаточном n (gate: 200 отправок), иначе NULL = "недостаточно данных"
  CASE WHEN s.sent_retained >= 200 THEN round(r.repliers::numeric / s.sent_retained, 5) END AS reply_rate,
  CASE WHEN s.sent_retained >= 200 THEN round(wilson_ci_low(r.repliers::numeric,  s.sent_retained::numeric), 5) END AS reply_rate_ci_low,
  CASE WHEN s.sent_retained >= 200 THEN round(wilson_ci_high(r.repliers::numeric, s.sent_retained::numeric), 5) END AS reply_rate_ci_high,
  -- lead rate среди РАЗМЕЧЕННЫХ ответивших (gate: 20 размеченных); coverage обязан показываться рядом
  CASE WHEN r.labeled_repliers >= 20 THEN round(r.interested_repliers::numeric / r.labeled_repliers, 5) END AS lead_rate_labeled,
  CASE WHEN r.labeled_repliers >= 20 THEN round(wilson_ci_low(r.interested_repliers::numeric,  r.labeled_repliers::numeric), 5) END AS lead_rate_ci_low,
  CASE WHEN r.labeled_repliers >= 20 THEN round(wilson_ci_high(r.interested_repliers::numeric, r.labeled_repliers::numeric), 5) END AS lead_rate_ci_high,
  CASE WHEN r.repliers > 0 THEN round(r.labeled_repliers::numeric / r.repliers, 3) END AS label_coverage,
  -- lifetime-агрегаты Instantly: ДРУГОЙ источник, не смешивать с email-derived в одном сравнении
  sn.lifetime_sent, sn.lifetime_replies_instantly, sn.lifetime_bounced, sn.lifetime_unique_opens,
  CASE WHEN sn.lifetime_sent > 0 THEN round(sn.lifetime_bounced::numeric / sn.lifetime_sent, 5) END AS bounce_rate_lifetime,
  sn.snapshot_as_of
FROM raw_campaigns c
LEFT JOIN lookup_campaign_status ls ON ls.value = c.status
LEFT JOIN dim_campaign_client  cc  ON cc.campaign_id = c.id
LEFT JOIN dim_campaign_segment seg ON seg.campaign_id = c.id
LEFT JOIN sends s  ON s.campaign_id = c.id
LEFT JOIN reps  r  ON r.campaign_id = c.id
LEFT JOIN snap  sn ON sn.campaign_id = c.id;
COMMENT ON VIEW v_campaign_health IS 'Канонические метрики кампании. universe: email = есть retained-отправки (метрики честные), snapshot_only = отправки стёрты ретеншеном (только lifetime-агрегаты, rate из raw_emails НЕЛЬЗЯ), none = писем нет. Rate-колонки NULL при n ниже гейта (sent<200 / labeled<20) — это сознательный отказ, не отсутствие данных. lead_rate_labeled валиден только вместе с label_coverage.';
