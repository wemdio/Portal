-- Bugor Outreach: timing-based queue for Instantly upload
-- Adds delay_days and send_after so leads wait for their optimal outreach window

ALTER TABLE public.bugor_outreach_leads
  ADD COLUMN IF NOT EXISTS delay_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_after date;

-- Backfill: existing leads get send_after = batch_date (ready now)
UPDATE public.bugor_outreach_leads
SET send_after = batch_date
WHERE send_after IS NULL;

-- Make send_after NOT NULL going forward
ALTER TABLE public.bugor_outreach_leads
  ALTER COLUMN send_after SET NOT NULL,
  ALTER COLUMN send_after SET DEFAULT CURRENT_DATE;

-- Index for the daily queue drain query
CREATE INDEX IF NOT EXISTS idx_bugor_leads_queue
  ON public.bugor_outreach_leads (send_after, instantly_uploaded)
  WHERE instantly_uploaded = false;
