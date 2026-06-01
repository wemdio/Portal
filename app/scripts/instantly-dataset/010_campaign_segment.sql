-- ============================================================================
-- 010: campaign → vertical segment dimension (LLM-classified).
-- Replaces ad-hoc campaign-name keyword regex (which leaked: matched fish
-- wholesale / construction / medical into "logistics"). Lead-level OKVED does
-- NOT exist in our data (0.025% of leads), and OKVED codes appear in only 4.4%
-- of campaign names — so the only signal is the campaign name as free text,
-- classified into the TARGET-audience vertical.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dim_campaign_segment (
  campaign_id    TEXT PRIMARY KEY,
  segment        TEXT NOT NULL,                 -- target-audience vertical (see classifier taxonomy)
  confidence     TEXT NOT NULL DEFAULT 'med',   -- high | med | low
  classified_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE dim_campaign_segment IS
  'Each campaign classified into the vertical it TARGETS (recipients'' industry),
   inferred from the campaign name by LLM. The name mixes client/product + target
   industry + list source (СБИС/руспрофайл/HH/2GIS) — only the target industry is
   captured here. Use for vertical analysis instead of name keyword-matching.
   segment values: logistics_transport, construction_realestate, medical_pharma,
   retail_ecommerce, manufacturing_industrial, food_horeca, it_software_saas,
   finance_legal, marketing_media_events, education_hr, beauty_wellness, auto,
   agriculture, other_unclear.';

CREATE INDEX IF NOT EXISTS dim_campaign_segment_seg_idx ON dim_campaign_segment (segment);

CREATE OR REPLACE VIEW v_campaign_segment AS
SELECT c.id AS campaign_id, c.name AS campaign_name, c.status,
       s.segment, s.confidence
FROM raw_campaigns c
LEFT JOIN dim_campaign_segment s ON s.campaign_id = c.id;
COMMENT ON VIEW v_campaign_segment IS
  'raw_campaigns joined to its classified target vertical (dim_campaign_segment).
   segment NULL = not yet classified.';
