-- Outreach SMTP retry tracking
-- Adds smtp_retry_count + smtp_last_attempt_at to both Bugor (English) and
-- Nash (Russian) outreach lead tables. Used by retryUnknown*Leads() schedulers
-- in worker/outreach.ts to give a second chance to leads that ended in
-- smtp_status='unknown' (proxy timeout / transient blacklist / tarpit).
--
-- Logic:
--   - smtp_retry_count: 0 = never retried, 1 = retried once. Max one retry total.
--   - smtp_last_attempt_at: set on every status transition by the SMTP worker.
--     Retry scheduler picks unknown leads with retry_count=0 AND
--     last_attempt_at < now() - 4 hours.

ALTER TABLE public.bugor_outreach_leads
  ADD COLUMN IF NOT EXISTS smtp_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smtp_last_attempt_at timestamptz;

ALTER TABLE public.nash_outreach_leads
  ADD COLUMN IF NOT EXISTS smtp_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smtp_last_attempt_at timestamptz;

-- Partial indexes to make the retry scheduler cheap (typically <50 rows match).
CREATE INDEX IF NOT EXISTS idx_bugor_leads_unknown_for_retry
  ON public.bugor_outreach_leads (smtp_last_attempt_at)
  WHERE smtp_status = 'unknown' AND smtp_retry_count = 0;

CREATE INDEX IF NOT EXISTS idx_nash_leads_unknown_for_retry
  ON public.nash_outreach_leads (smtp_last_attempt_at)
  WHERE smtp_status = 'unknown' AND smtp_retry_count = 0;
