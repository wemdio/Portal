-- Closes schema drift between instantly-migrations init and main supabase/migrations.
-- Adds: briefs, objection handling, forwarded leads, client chats, lead comments.
-- Also adds columns (read_at, read_by) and index (instantly_email_id) that were present
-- in the main DB migration but absent from the separate instantly-migrations init.

-- ── 1. Missing columns on instantly_lead_qualifications ─────────────────────────

ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS read_by uuid;
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS objection_handleable boolean DEFAULT false;
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS objection_draft text;

ALTER TABLE public.instantly_lead_qualifications
  DROP CONSTRAINT IF EXISTS instantly_lead_qualifications_status_check;
ALTER TABLE public.instantly_lead_qualifications
  ADD CONSTRAINT instantly_lead_qualifications_status_check
  CHECK (status = ANY (ARRAY['pending','processing','lead','not_lead','needs_review','error','objection']));

CREATE UNIQUE INDEX IF NOT EXISTS idx_instantly_lead_qualifications_email_id
  ON public.instantly_lead_qualifications (instantly_email_id)
  WHERE instantly_email_id IS NOT NULL;

-- ── 2. instantly_briefs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.instantly_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brief_text text NOT NULL,
  file_name text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.instantly_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on instantly_briefs" ON public.instantly_briefs;
CREATE POLICY "Service role full access on instantly_briefs"
  ON public.instantly_briefs FOR ALL USING (true) WITH CHECK (true);

-- ── 3. instantly_brief_campaigns ────────────────────────────────────────────────

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

ALTER TABLE public.instantly_brief_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on instantly_brief_campaigns" ON public.instantly_brief_campaigns;
CREATE POLICY "Service role full access on instantly_brief_campaigns"
  ON public.instantly_brief_campaigns FOR ALL USING (true) WITH CHECK (true);

-- ── 4. client_telegram_chats ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_telegram_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL,
  chat_id bigint NOT NULL,
  chat_title text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_client_tg_chats_client
  ON public.client_telegram_chats(client_user_id);

ALTER TABLE public.client_telegram_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on client_telegram_chats" ON public.client_telegram_chats;
CREATE POLICY "Service role full access on client_telegram_chats"
  ON public.client_telegram_chats FOR ALL USING (true) WITH CHECK (true);

-- ── 5. client_forwarded_leads ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_forwarded_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id uuid,
  client_user_id uuid NOT NULL,
  forwarded_by uuid NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  lead_email text NOT NULL,
  lead_name text,
  company_name text,
  phone text,
  website text,
  linkedin_url text,
  reply_subject text,
  reply_body text,
  last_outbound_preview text,
  reply_timestamp timestamptz,
  status text,
  ai_reason text,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_forwarded_leads_client
  ON public.client_forwarded_leads(client_user_id);
CREATE INDEX IF NOT EXISTS idx_client_forwarded_leads_qual
  ON public.client_forwarded_leads(qualification_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_forwarded_leads_unique_qual_client
  ON public.client_forwarded_leads(qualification_id, client_user_id)
  WHERE qualification_id IS NOT NULL;

ALTER TABLE public.client_forwarded_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on client_forwarded_leads" ON public.client_forwarded_leads;
CREATE POLICY "Service role full access on client_forwarded_leads"
  ON public.client_forwarded_leads FOR ALL USING (true) WITH CHECK (true);

-- ── 6. client_lead_comments ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_lead_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forwarded_lead_id uuid NOT NULL REFERENCES public.client_forwarded_leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_name text,
  comment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_lead_comments_lead
  ON public.client_lead_comments(forwarded_lead_id);

ALTER TABLE public.client_lead_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on client_lead_comments" ON public.client_lead_comments;
CREATE POLICY "Service role full access on client_lead_comments"
  ON public.client_lead_comments FOR ALL USING (true) WITH CHECK (true);
