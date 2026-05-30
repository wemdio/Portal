-- ============================================================================
-- 009: purge the poisoned daily-snap rows + provide a correct daily series.
--
-- Context: migration 008 + the client.ts/sync.mjs/pull.mjs fix (2026-05-30)
-- stopped the bug where /campaigns/analytics/daily was called with `id` (→
-- workspace-wide series written under every campaign_id). ALL existing rows in
-- raw_campaign_analytics_daily_snap (1.94M, across 2 snapshots) are that garbage.
--
-- (1) Purge them so the fixed nightly sync doesn't mix correct new rows with
--     poisoned old ones (any query not filtering by snapshot would blend them).
-- (2) Give a CORRECT, complete daily sends/replies series derived from
--     raw_emails — zero API cost, always right. (Opens/clicks/bounces are NOT
--     per-email in our data; for those use the now-fixed daily_snap going
--     forward, or overview_snap for lifetime aggregates.)
-- ============================================================================

-- (1) purge — every row is workspace-wide garbage
TRUNCATE raw_campaign_analytics_daily_snap;

COMMENT ON TABLE raw_campaign_analytics_daily_snap IS
  'Per (snapshot, campaign, date) daily metrics from /campaigns/analytics/daily.
   PURGED 2026-05-30: all prior rows were workspace-wide garbage (ingestion sent
   `id` not `campaign_id`; fixed same day). Going forward holds CORRECT rows but
   only for campaigns active on each sync night (sparse). For a complete, always-
   correct daily SENDS/REPLIES series use v_campaign_daily (derived from raw_emails).
   This table is only needed for daily opens/clicks/bounces of active campaigns.';

-- (2) correct daily series from the per-email truth table
CREATE OR REPLACE VIEW v_campaign_daily AS
SELECT
  campaign_id,
  (COALESCE(timestamp_email, timestamp_created))::date            AS date,
  count(*) FILTER (WHERE ue_type = 1)                             AS sent,
  count(*) FILTER (WHERE ue_type = 2)                             AS lead_replies,
  count(*) FILTER (WHERE ue_type = 3)                             AS our_replies,
  count(DISTINCT thread_id) FILTER (WHERE ue_type = 2)            AS threads_with_reply
FROM raw_emails
WHERE campaign_id IS NOT NULL
  AND COALESCE(timestamp_email, timestamp_created) IS NOT NULL
GROUP BY campaign_id, (COALESCE(timestamp_email, timestamp_created))::date;

COMMENT ON VIEW v_campaign_daily IS
  'CORRECT per-campaign daily series (sent / lead_replies / our_replies) derived
   from raw_emails by timestamp_email::date and ue_type. Complete and always right
   — use this for sends/replies over time, NOT raw_campaign_analytics_daily_snap
   (which was workspace-wide garbage, purged 2026-05-30). Does NOT include
   opens/clicks/bounces (not per-email in our data).';
