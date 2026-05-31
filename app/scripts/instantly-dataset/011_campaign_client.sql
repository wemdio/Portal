-- ============================================================================
-- 011: authoritative CLIENT per campaign (the studio customer the outreach
-- runs ON BEHALF OF). Campaign names almost always lead with the client name —
-- so client is the clean primary axis, and stripping it is the key to a clean
-- TARGET vertical (see 010 re-classification v2).
--   source='project'    — authoritative: project_instantly_campaigns→projects.client
--   source='name_match' — campaign unmapped, but a known client name appears in the name
-- ============================================================================

CREATE TABLE IF NOT EXISTS dim_campaign_client (
  campaign_id  TEXT PRIMARY KEY,
  client       TEXT NOT NULL,
  source       TEXT NOT NULL,                 -- project | name_match
  confidence   TEXT NOT NULL DEFAULT 'high',  -- high (project) | med (name_match)
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE dim_campaign_client IS
  'Authoritative studio CLIENT (sender) per campaign. source=project is from the
   operational project_instantly_campaigns→projects.client mapping (clean);
   source=name_match means a known client name was found in the campaign name.
   Use as the clean segmentation axis — NOT the leaky name-keyword vertical.';
CREATE INDEX IF NOT EXISTS dim_campaign_client_client_idx ON dim_campaign_client (client);

CREATE OR REPLACE VIEW v_campaign_client AS
SELECT c.id AS campaign_id, c.name AS campaign_name, c.status,
       cl.client, cl.source AS client_source, cl.confidence AS client_confidence
FROM raw_campaigns c
LEFT JOIN dim_campaign_client cl ON cl.campaign_id = c.id;
COMMENT ON VIEW v_campaign_client IS 'raw_campaigns joined to its authoritative studio client (dim_campaign_client).';
