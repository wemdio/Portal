-- Client telegram chats: maps client users to telegram group chats for lead notifications
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

-- Forwarded leads: denormalized lead data sent to clients
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

-- Comments on forwarded leads from clients
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
