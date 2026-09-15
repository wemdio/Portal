-- Operational Instantly DB only. Three additive performance/quota helpers:
--   1. instantly_reply_intake (campaign_id, created_at) index — the client
--      «Replies» feed reads its historical tail by campaign from the intake
--      instead of paging the provider LIST /emails.
--   2. instantly_others_seen — negative cache of Others emails that got a
--      final screening verdict, so the 15-min watchdog stops rescanning the
--      same ~200 emails (audit 14.09.2026).
--   3. instantly_leads_sync_404 — hourly leads-sync tombstones for campaigns
--      the provider keeps answering 404 (~888 wasted requests/day).
BEGIN;

CREATE INDEX IF NOT EXISTS instantly_reply_intake_campaign_created_idx
  ON public.instantly_reply_intake (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.instantly_others_seen (
  email_id text PRIMARY KEY CHECK (length(email_id) BETWEEN 1 AND 500),
  -- 'skip' = screening verdict (not a candidate): long TTL.
  -- 'drop' = candidate dropped later (no campaign / subject mismatch): short TTL.
  verdict text NOT NULL CHECK (verdict IN ('skip', 'drop')),
  seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.instantly_others_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instantly_others_seen FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.instantly_others_seen TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'instantly') THEN
    GRANT ALL ON TABLE public.instantly_others_seen TO instantly;
  END IF;
END;
$$;

COMMENT ON TABLE public.instantly_others_seen IS
  'Others-watchdog negative cache: emails with a final non-lead verdict. skip rows live 7 days, drop rows 6 hours (a project binding may appear while the email is still in the scan window). Deferred/probe-exhausted candidates are never cached.';

CREATE TABLE IF NOT EXISTS public.instantly_leads_sync_404 (
  resource_id text PRIMARY KEY CHECK (length(resource_id) BETWEEN 1 AND 500),
  account_id text NOT NULL DEFAULT 'main',
  first_404_at timestamptz NOT NULL DEFAULT now(),
  last_404_at timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 1 CHECK (hits >= 1)
);

ALTER TABLE public.instantly_leads_sync_404 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instantly_leads_sync_404 FROM PUBLIC;

COMMENT ON TABLE public.instantly_leads_sync_404 IS
  'Hourly leads-sync tombstones: campaigns the provider answers 404. Skipped for 24h after the last 404; any successful/non-404 response clears the row. Rows are hints, never deletions of client access.';

COMMIT;
NOTIFY pgrst, 'reload schema';
