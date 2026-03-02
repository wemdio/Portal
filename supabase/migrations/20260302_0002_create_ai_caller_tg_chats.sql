-- Formalize the ai_caller_tg_chats table already used in code.
CREATE TABLE IF NOT EXISTS public.ai_caller_tg_chats (
  chat_id bigint PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'group',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_caller_tg_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tg_chats_all_authenticated" ON public.ai_caller_tg_chats;
CREATE POLICY "tg_chats_all_authenticated"
  ON public.ai_caller_tg_chats
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
