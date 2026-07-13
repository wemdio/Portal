-- Self-serve client's own AI lead definition ("свой промпт"), set on the
-- /client/replies page next to the Telegram connect card.
--
-- Self-serve campaigns (client_instantly_access) have no Portal project, so
-- projects.lead_criteria never applies to them. This table is the client-side
-- counterpart: the qualifier uses it for the client's campaigns, and the reply
-- DM gets a «Лид по вашим критериям» badge when the verdict is lead. Empty /
-- missing row = default studio criteria, zero behavior change.
--
-- Separate from client_reply_telegram_links on purpose: criteria must survive
-- TG disconnect/reconnect (the links row is dropped on disconnect).
CREATE TABLE IF NOT EXISTS public.client_lead_criteria (
  client_user_id uuid PRIMARY KEY,
  criteria text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.client_lead_criteria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "client_lead_criteria_service_only" ON public.client_lead_criteria;
CREATE POLICY "client_lead_criteria_service_only"
  ON public.client_lead_criteria
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
