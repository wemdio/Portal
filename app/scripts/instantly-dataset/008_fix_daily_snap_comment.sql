-- ============================================================================
-- 008: correct the COMMENT on raw_campaign_analytics_daily_snap
--
-- The table does NOT hold per-campaign data. The daily-analytics ingestion calls
-- GET /campaigns/analytics/daily with the campaign UUID under the query key `id`,
-- but that endpoint filters by `campaign_id` and returns the WORKSPACE-WIDE daily
-- series when no campaign_id is given. The unknown `id` param is ignored, so every
-- campaign_id row gets the identical workspace series.
--
-- Evidence (snapshot 98974f54, full pull 2026-05-21): all 1881 campaigns share the
-- exact same sum(sent)=7,381,152 and byte-identical 965-day series, including
-- campaigns whose overview lifetime contacted_count is 1..5.
--
-- The old COMMENT ("Per-campaign × per-day metrics ... Use for trend lines") is
-- dangerously wrong because agents discover semantics from pg_description live.
-- Root cause + fix tracked in wiki/concepts/dataset-schema.md (2026-05-30) and at
-- app/src/lib/instantly/client.ts:175, sync.mjs:436, pull.mjs:409.
-- ============================================================================

COMMENT ON TABLE raw_campaign_analytics_daily_snap IS
  'BROKEN for per-campaign use (2026-05-30). Holds the WORKSPACE-WIDE daily series
   duplicated under every campaign_id — campaign_id carries no information here.
   Cause: ingestion sends the UUID as query key `id`, but /campaigns/analytics/daily
   filters by `campaign_id` and returns ALL campaigns when it is omitted. Do NOT sum
   sent/opened/replies per campaign. For per-campaign aggregates use
   raw_campaign_analytics_overview_snap; for a per-campaign daily send series build it
   from raw_emails (timestamp_email::date, ue_type=1). See wiki/concepts/dataset-schema.md.';

COMMENT ON COLUMN raw_campaign_analytics_daily_snap.sent IS
  'WORKSPACE-WIDE daily sent, NOT per-campaign (identical under every campaign_id). See table comment.';
