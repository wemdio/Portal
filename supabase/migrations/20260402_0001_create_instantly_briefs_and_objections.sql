-- Instantly briefs: client briefs linked to campaigns for objection handling

CREATE TABLE IF NOT EXISTS public.instantly_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brief_text text NOT NULL,
  file_name text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.instantly_brief_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid NOT NULL REFERENCES public.instantly_briefs(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brief_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_instantly_brief_campaigns_campaign
  ON public.instantly_brief_campaigns (campaign_id);
CREATE INDEX IF NOT EXISTS idx_instantly_brief_campaigns_brief
  ON public.instantly_brief_campaigns (brief_id);

-- Objection handling columns on lead qualifications
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS objection_handleable boolean DEFAULT false;
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS objection_draft text;

-- Add 'objection' to the status CHECK constraint
ALTER TABLE public.instantly_lead_qualifications
  DROP CONSTRAINT IF EXISTS instantly_lead_qualifications_status_check;
ALTER TABLE public.instantly_lead_qualifications
  ADD CONSTRAINT instantly_lead_qualifications_status_check
  CHECK (status = ANY (ARRAY['pending','processing','lead','not_lead','needs_review','error','objection']));
