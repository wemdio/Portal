CREATE TABLE IF NOT EXISTS public.bugor_outreach_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_date date NOT NULL DEFAULT CURRENT_DATE,
  company_name text NOT NULL,
  website text,
  founder_name text,
  founder_linkedin text,
  email_guess text,
  description text,
  niche text,
  signal_type text NOT NULL,
  signal_detail text,
  intent_score int NOT NULL DEFAULT 0,
  priority text NOT NULL DEFAULT 'WARM',
  outreach_angle text,
  timing text,
  source_url text,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bugor_leads_batch_date
  ON public.bugor_outreach_leads(batch_date DESC);
CREATE INDEX IF NOT EXISTS idx_bugor_leads_priority
  ON public.bugor_outreach_leads(priority);
CREATE INDEX IF NOT EXISTS idx_bugor_leads_dedup
  ON public.bugor_outreach_leads(company_name, website);

ALTER TABLE public.bugor_outreach_leads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_leads_select_authenticated' AND tablename = 'bugor_outreach_leads') THEN
    CREATE POLICY bugor_leads_select_authenticated ON public.bugor_outreach_leads FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_leads_insert_service' AND tablename = 'bugor_outreach_leads') THEN
    CREATE POLICY bugor_leads_insert_service ON public.bugor_outreach_leads FOR INSERT TO service_role WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bugor_leads_delete_service' AND tablename = 'bugor_outreach_leads') THEN
    CREATE POLICY bugor_leads_delete_service ON public.bugor_outreach_leads FOR DELETE TO service_role USING (true);
  END IF;
END $$;
