-- Bugor Outreach: region-based campaign routing (US / EU)

ALTER TABLE public.bugor_outreach_leads
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'US';

-- Rename single campaign key to EU, add US key
UPDATE public.bugor_outreach_config
SET key = 'instantly_campaign_id_eu'
WHERE key = 'instantly_campaign_id';

INSERT INTO public.bugor_outreach_config (key, value)
VALUES ('instantly_campaign_id_us', '')
ON CONFLICT (key) DO NOTHING;
