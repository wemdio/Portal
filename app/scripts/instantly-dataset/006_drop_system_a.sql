-- ============================================================================
-- 006: remove "System A" (the deterministic SQL health calculator).
-- Decision: the eval loop is AI-in-the-loop (the agent answers on demand and
-- logs to query_log). The SQL calculator + its storage are redundant. The
-- client→campaign map is queried LIVE from the operational DBs per session
-- (always fresh, nothing to rot), so the dim_* mirror tables are dropped too.
--
-- KEEPS (genuinely useful, independent of System A):
--   - v_subject_performance / v_campaign_mailboxes  (migration 005 — real fixes)
--   - lookup_tag_resource_type                       (documents the data)
--   - sync.mjs step+daily refresh                    (data freshness)
-- ============================================================================

DROP VIEW  IF EXISTS v_client_health_attention;
DROP VIEW  IF EXISTS v_client_health_latest;
DROP TABLE IF EXISTS client_health_snapshots;
DROP TABLE IF EXISTS health_questions;

-- dim mirrors — the agent queries the operational DBs live instead (no rot)
DROP TABLE IF EXISTS dim_lead_qualifications;
DROP TABLE IF EXISTS dim_project_campaigns;
DROP TABLE IF EXISTS dim_projects;
