-- Per-client "leads only" toggle for reply DMs (/client/replies TG card).
--
-- Default (false) keeps today's behavior: DM every human reply. When true,
-- the client is DM'd ONLY replies the qualifier marked status='lead' — by
-- their own criteria (client_lead_criteria) when set, otherwise the studio
-- default. Lives on the TG link row because it is a property of the
-- notification channel (dropped together with the binding on disconnect).
ALTER TABLE public.client_reply_telegram_links
  ADD COLUMN IF NOT EXISTS leads_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_reply_telegram_links.leads_only IS
  'true = DM only qualifier-confirmed leads; false = DM every human reply (default).';
