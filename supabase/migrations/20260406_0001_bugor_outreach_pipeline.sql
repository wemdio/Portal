-- Bugor Outreach Pipeline: config table + new columns for email finding, validation, sequences, Instantly upload

CREATE TABLE IF NOT EXISTS public.bugor_outreach_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bugor_outreach_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_config_select_authenticated' AND tablename = 'bugor_outreach_config') THEN
    CREATE POLICY bugor_config_select_authenticated ON public.bugor_outreach_config FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_config_all_service' AND tablename = 'bugor_outreach_config') THEN
    CREATE POLICY bugor_config_all_service ON public.bugor_outreach_config FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

INSERT INTO public.bugor_outreach_config (key, value) VALUES
  ('sender_name', 'Nick S.'),
  ('sender_calendly', 'https://calendly.com/nickerhov89/brief-intro'),
  ('sender_website', 'polzaagency.com'),
  ('auto_upload_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.bugor_outreach_leads
  ADD COLUMN IF NOT EXISTS emails_found text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS emails_validated text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS email_sequence jsonb,
  ADD COLUMN IF NOT EXISTS instantly_uploaded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS instantly_lead_id text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_leads_update_service' AND tablename = 'bugor_outreach_leads') THEN
    CREATE POLICY bugor_leads_update_service ON public.bugor_outreach_leads FOR UPDATE TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
