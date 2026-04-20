-- Per-user reply macros (quick-reply templates for lead qualification inbox).
-- System-wide macros are hardcoded in the frontend; this table stores user-created ones.

CREATE TABLE IF NOT EXISTS public.user_reply_macros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_reply_macros_user
  ON public.user_reply_macros (user_id, sort_order);

ALTER TABLE public.user_reply_macros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own macros" ON public.user_reply_macros;
CREATE POLICY "Users can manage own macros"
  ON public.user_reply_macros FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access on user_reply_macros" ON public.user_reply_macros;
CREATE POLICY "Service role full access on user_reply_macros"
  ON public.user_reply_macros FOR ALL USING (true) WITH CHECK (true);
