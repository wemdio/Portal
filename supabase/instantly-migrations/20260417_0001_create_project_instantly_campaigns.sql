-- Junction table: links Portal projects to Instantly campaign IDs.
-- Lives in PolzaInstantlyDB (referenced by worker and qualified-leads API).
-- No FK to projects: projects table is in main DB.

CREATE TABLE IF NOT EXISTS public.project_instantly_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  campaign_id text NOT NULL,
  match_source text NOT NULL DEFAULT 'auto'
    CHECK (match_source IN ('auto', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_project_instantly_campaigns_campaign
  ON public.project_instantly_campaigns (campaign_id);

CREATE INDEX IF NOT EXISTS idx_project_instantly_campaigns_project
  ON public.project_instantly_campaigns (project_id);

ALTER TABLE public.project_instantly_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on project_instantly_campaigns" ON public.project_instantly_campaigns;
CREATE POLICY "Service role full access on project_instantly_campaigns"
  ON public.project_instantly_campaigns FOR ALL USING (true) WITH CHECK (true);
