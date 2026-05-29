-- ============================================================================
-- 007: v_subject_ab_within_campaign — the ONLY statistically honest way to
-- compare subjects. Surfaces variant-vs-variant within the same campaign+step
-- (same list, same timing) so cross-campaign segment confound can't sneak in.
--
-- WHY (query_log id=9, 2026-05-29): pooling the same subject template across
-- campaigns gave z=40 "wins" — but that measured SEGMENT differences, not the
-- subject. Held constant within-campaign, route-vs-pitch was z=1.37 (p=0.17,
-- not significant). And reply rate above ~1% does NOT convert to more leads
-- (vanity metric). So subject A/B must be judged within-campaign, and even then
-- it rarely moves the needle. This view enforces the within-campaign frame.
-- ============================================================================

CREATE OR REPLACE VIEW v_subject_ab_within_campaign AS
WITH s0 AS (
  SELECT campaign_id, campaign_name, step_n, variant_n, subject, sent, unique_replies,
         CASE WHEN COALESCE(sent,0) > 0 THEN round(100.0*unique_replies::numeric/sent, 2) END AS reply_pct
  FROM v_subject_performance
  WHERE subject IS NOT NULL AND trim(subject) <> '' AND COALESCE(sent,0) >= 50
),
multi AS (  -- only campaign+step with >=2 variants of meaningful volume = a real A/B
  SELECT campaign_id, step_n FROM s0 GROUP BY campaign_id, step_n HAVING count(*) >= 2
)
SELECT s0.campaign_id, s0.campaign_name, s0.step_n, s0.variant_n, s0.subject, s0.sent, s0.unique_replies, s0.reply_pct,
       max(s0.reply_pct) OVER (PARTITION BY s0.campaign_id, s0.step_n) AS best_in_test_pct,
       round(s0.reply_pct - min(s0.reply_pct) OVER (PARTITION BY s0.campaign_id, s0.step_n), 2) AS spread_from_worst
FROM s0 JOIN multi USING (campaign_id, step_n)
ORDER BY s0.campaign_id, s0.step_n, s0.reply_pct DESC NULLS LAST;

COMMENT ON VIEW v_subject_ab_within_campaign IS
  'Subject A/B compared ONLY within the same campaign+step (same list/timing = de-confounded).
   Use this, NOT cross-campaign pooling, to judge a subject. Even here, at ~150-500 sends/variant
   most differences are not significant (z-test before claiming). Reply rate >~1% does not convert
   to more leads (it is a vanity metric above that). See wiki/subjects/winning-patterns.md.';
