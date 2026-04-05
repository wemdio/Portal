-- Bugor Outreach: SMTP verification status tracking
-- Adds smtp_status and smtp_tier so the Docker worker can verify emails
-- before uploading to Instantly.

ALTER TABLE public.bugor_outreach_leads
  ADD COLUMN IF NOT EXISTS smtp_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS smtp_tier integer;

-- Backfill: already-uploaded leads are considered valid
UPDATE public.bugor_outreach_leads
SET smtp_status = 'valid'
WHERE instantly_uploaded = true;

-- Leads with no emails get 'skipped'
UPDATE public.bugor_outreach_leads
SET smtp_status = 'skipped'
WHERE emails_validated = '{}' AND instantly_uploaded = false;

-- Index for the worker to efficiently find pending leads
CREATE INDEX IF NOT EXISTS idx_bugor_leads_smtp_pending
  ON public.bugor_outreach_leads (smtp_status)
  WHERE smtp_status = 'pending' AND emails_validated != '{}';
