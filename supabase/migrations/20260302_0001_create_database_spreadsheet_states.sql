-- Formalize the database_spreadsheet_states table already used in code.
CREATE TABLE IF NOT EXISTS public.database_spreadsheet_states (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.database_spreadsheet_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "spreadsheet_states_select_own" ON public.database_spreadsheet_states;
CREATE POLICY "spreadsheet_states_select_own"
  ON public.database_spreadsheet_states
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "spreadsheet_states_upsert_own" ON public.database_spreadsheet_states;
CREATE POLICY "spreadsheet_states_upsert_own"
  ON public.database_spreadsheet_states
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
