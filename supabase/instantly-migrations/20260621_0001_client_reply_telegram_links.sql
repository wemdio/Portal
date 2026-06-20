-- Self-serve client → Telegram binding for AUTOMATIC reply notifications.
--
-- When a lead replies to a client's campaign and the qualifier classifies the
-- reply as meaningful (status lead / objection / needs_review), we DM the reply
-- text straight to the client here — via a dedicated bot the client connected
-- themselves through the portal (deep-link `/start lnk<token>` flow).
--
-- Deliberately SEPARATE from `client_telegram_chats` (team-managed GROUP chats
-- used for the existing MANUAL lead-forwarding flow), so:
--   * the manual team flow is completely untouched, and
--   * auto-forwarding goes ONLY to clients who opted in themselves.
--
-- One binding per client (client_user_id PK); one Telegram chat maps to at most
-- one client (unique chat_id) so a second client can't hijack an existing chat.
-- `enabled` is the per-client opt-out toggle.

CREATE TABLE IF NOT EXISTS public.client_reply_telegram_links (
  client_user_id uuid PRIMARY KEY,
  chat_id bigint NOT NULL,
  telegram_username text,
  telegram_first_name text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_reply_tg_links_chat
  ON public.client_reply_telegram_links(chat_id);

ALTER TABLE public.client_reply_telegram_links ENABLE ROW LEVEL SECURITY;

-- The Instantly DB connects as service_role on prod and (in local dev) as the
-- `instantly` PostgREST role — grant to whichever exists. Mirrors the pattern in
-- 20260520_0001_create_project_period_campaigns.sql so the table is reachable in
-- every environment, not just where RLS is bypassed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.client_reply_telegram_links to service_role;
  end if;

  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant all on public.client_reply_telegram_links to instantly;
  end if;
end $$;

DROP POLICY IF EXISTS "Service role full access on client_reply_telegram_links" ON public.client_reply_telegram_links;
CREATE POLICY "Service role full access on client_reply_telegram_links"
  ON public.client_reply_telegram_links FOR ALL USING (true) WITH CHECK (true);
