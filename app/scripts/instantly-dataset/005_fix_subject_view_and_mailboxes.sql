-- ============================================================================
-- 005: fix two gaps surfaced by the eval loop (query_log id=2, ДПО ПРОФ)
--   Gap A: v_subject_performance pointed at the GLOBAL latest snapshot for step
--          data, but delta syncs don't write step analytics there → subjects
--          NULL for everyone. Fix: per-campaign latest step snapshot.
--   Gap B: campaigns assign senders via email_tag_list (tags), not email_list,
--          so mailbox health couldn't resolve senders. Fix: v_campaign_mailboxes
--          that resolves BOTH email_list and email_tag_list → accounts.
-- ============================================================================

-- ─── lookup for tag-mapping resource_type ──────────────────────────────────
CREATE TABLE IF NOT EXISTS lookup_tag_resource_type (
  value INT PRIMARY KEY, label TEXT NOT NULL, description TEXT
);
INSERT INTO lookup_tag_resource_type(value, label, description) VALUES
  (1, 'account',  'Tag applied to a sending mailbox. raw_custom_tag_mappings.resource_id = raw_accounts.email'),
  (2, 'campaign', 'Tag applied to a campaign (assumed; resource_id = raw_campaigns.id)')
ON CONFLICT (value) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description;
COMMENT ON TABLE lookup_tag_resource_type IS 'Decodes raw_custom_tag_mappings.resource_type (stored as text ''1''/''2'').';

-- ─── Gap B: campaign → mailbox resolution (list + tags) ────────────────────
CREATE OR REPLACE VIEW v_campaign_mailboxes AS
  -- explicit email_list
  SELECT c.id AS campaign_id, e AS email, 'list'::text AS source
  FROM raw_campaigns c, unnest(c.email_list) AS e
  WHERE c.email_list IS NOT NULL AND array_length(c.email_list, 1) > 0
  UNION
  -- tag-resolved senders (resource_type='1' = account, resource_id = email)
  SELECT c.id AS campaign_id, tm.resource_id AS email, 'tag'::text AS source
  FROM raw_campaigns c
  JOIN raw_custom_tag_mappings tm
    ON tm.resource_type = '1' AND tm.tag_id = ANY(c.email_tag_list)
  WHERE c.email_tag_list IS NOT NULL AND array_length(c.email_tag_list, 1) > 0;
COMMENT ON VIEW v_campaign_mailboxes IS
  'Resolves which sending mailboxes a campaign uses, via explicit email_list AND
   tag-based email_tag_list (most campaigns use tags). source = list | tag.
   JOIN raw_accounts ON email for status/warmup health.';

-- ─── Gap A: v_subject_performance uses per-campaign latest step snapshot ────
CREATE OR REPLACE VIEW v_subject_performance AS
WITH latest_step_snap AS (
  -- the most recent snapshot that actually has step data, PER campaign
  SELECT DISTINCT ON (a.campaign_id) a.campaign_id, a.snapshot_id
  FROM raw_campaign_step_analytics_snap a
  JOIN dataset_snapshots ds ON ds.id = a.snapshot_id AND ds.ok
  ORDER BY a.campaign_id, ds.started_at DESC
)
SELECT
  s.campaign_id, c.name AS campaign_name, c.status AS campaign_status,
  s.sequence_n, s.step_n, s.variant_n, s.subject,
  a.sent, a.opened, a.unique_opened, a.replies, a.unique_replies, a.clicks, a.unique_clicks, a.opportunities,
  CASE WHEN COALESCE(a.sent,0) > 0 THEN round(100.0 * a.unique_opened::numeric  / a.sent::numeric, 2) END AS open_rate_pct,
  CASE WHEN COALESCE(a.sent,0) > 0 THEN round(100.0 * a.unique_replies::numeric / a.sent::numeric, 2) END AS reply_rate_pct,
  CASE WHEN COALESCE(a.sent,0) > 0 THEN round(100.0 * a.unique_clicks::numeric  / a.sent::numeric, 2) END AS click_rate_pct
FROM raw_campaign_steps s
JOIN raw_campaigns c ON c.id = s.campaign_id
LEFT JOIN latest_step_snap lss ON lss.campaign_id = s.campaign_id
LEFT JOIN raw_campaign_step_analytics_snap a
  ON a.campaign_id = s.campaign_id AND a.step_n = s.step_n AND a.variant_n = s.variant_n
 AND a.snapshot_id = lss.snapshot_id;
COMMENT ON VIEW v_subject_performance IS
  'Subject × step × variant performance. Uses each campaign''s most-recent step-analytics
   snapshot (not the global latest), so it stays correct as deltas accumulate.';
