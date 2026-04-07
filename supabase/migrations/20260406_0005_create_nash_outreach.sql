-- Nash Outreach: Russian B2B lead collection pipeline

CREATE TABLE IF NOT EXISTS public.nash_outreach_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_date date NOT NULL DEFAULT CURRENT_DATE,
  company_name text NOT NULL,
  website text,
  city text,
  employee_count text,
  description text,
  niche text,
  signal_type text NOT NULL,
  signal_detail text,
  intent_score int NOT NULL DEFAULT 0,
  priority text NOT NULL DEFAULT 'WARM',
  outreach_angle text,
  source_url text,
  hh_employer_id text,
  hh_vacancy_name text,
  inn text,
  raw_data jsonb,

  emails_found text[] NOT NULL DEFAULT '{}',
  emails_validated text[] NOT NULL DEFAULT '{}',
  smtp_status text NOT NULL DEFAULT 'pending',
  smtp_tier integer,
  email_sequence jsonb,
  instantly_uploaded boolean NOT NULL DEFAULT false,
  instantly_lead_id text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nash_leads_batch_date
  ON public.nash_outreach_leads(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_nash_leads_priority
  ON public.nash_outreach_leads(priority);
CREATE INDEX IF NOT EXISTS idx_nash_leads_dedup
  ON public.nash_outreach_leads(company_name, website);
CREATE INDEX IF NOT EXISTS idx_nash_leads_smtp_pending
  ON public.nash_outreach_leads(smtp_status)
  WHERE smtp_status = 'pending' AND emails_validated != '{}';

ALTER TABLE public.nash_outreach_leads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nash_leads_select_authenticated' AND tablename = 'nash_outreach_leads') THEN
    CREATE POLICY nash_leads_select_authenticated ON public.nash_outreach_leads FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nash_leads_all_service' AND tablename = 'nash_outreach_leads') THEN
    CREATE POLICY nash_leads_all_service ON public.nash_outreach_leads FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Config table
CREATE TABLE IF NOT EXISTS public.nash_outreach_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.nash_outreach_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nash_config_select_authenticated' AND tablename = 'nash_outreach_config') THEN
    CREATE POLICY nash_config_select_authenticated ON public.nash_outreach_config FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nash_config_all_service' AND tablename = 'nash_outreach_config') THEN
    CREATE POLICY nash_config_all_service ON public.nash_outreach_config FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Default config
INSERT INTO public.nash_outreach_config (key, value) VALUES
  ('sender_name', 'Nick S.'),
  ('sender_calendly', 'https://calendly.com/nickerhov89/brief-intro'),
  ('sender_website', 'polzaagency.com'),
  ('auto_upload_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
