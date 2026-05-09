CREATE TABLE IF NOT EXISTS public.client_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tariff_type text NOT NULL DEFAULT 'standard'
    CHECK (tariff_type IN ('standard', 'pro', 'custom')),
  max_contacts integer,
  max_rows integer,
  max_chains_per_month integer,
  max_domains integer,
  max_emails integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

COMMENT ON TABLE public.client_tariffs IS 'Per-client tariff and limit overrides. NULL limit columns use tariff defaults.';

ALTER TABLE public.client_tariffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on client_tariffs"
  ON public.client_tariffs
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Clients can read own tariff"
  ON public.client_tariffs
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT SELECT ON public.client_tariffs TO authenticated;
