-- Copilot Dialog Sync: local DB cache for TG dialogs + message history
-- Replaces constant getDialogs() API polling with DB-backed proactive scans

-- Track all TG dialogs discovered by the copilot
CREATE TABLE IF NOT EXISTS public.copilot_dialogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES public.sales_copilot_configs(id) ON DELETE CASCADE,
  tg_user_id bigint NOT NULL,
  tg_username text,
  tg_display_name text,
  is_bot boolean NOT NULL DEFAULT false,
  last_message_date timestamptz,
  last_synced_msg_id bigint,
  message_count integer NOT NULL DEFAULT 0,
  kb_document_id uuid REFERENCES public.kb_documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(config_id, tg_user_id)
);

CREATE INDEX IF NOT EXISTS copilot_dialogs_config_idx
  ON public.copilot_dialogs (config_id);
CREATE INDEX IF NOT EXISTS copilot_dialogs_config_last_msg_idx
  ON public.copilot_dialogs (config_id, last_message_date DESC);

ALTER TABLE public.copilot_dialogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS copilot_dialogs_select_own ON public.copilot_dialogs;
CREATE POLICY copilot_dialogs_select_own ON public.copilot_dialogs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_copilot_configs c WHERE c.id = config_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS copilot_dialogs_insert_own ON public.copilot_dialogs;
CREATE POLICY copilot_dialogs_insert_own ON public.copilot_dialogs
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.sales_copilot_configs c WHERE c.id = config_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS copilot_dialogs_update_own ON public.copilot_dialogs;
CREATE POLICY copilot_dialogs_update_own ON public.copilot_dialogs
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_copilot_configs c WHERE c.id = config_id AND c.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.sales_copilot_configs c WHERE c.id = config_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS copilot_dialogs_delete_own ON public.copilot_dialogs;
CREATE POLICY copilot_dialogs_delete_own ON public.copilot_dialogs
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales_copilot_configs c WHERE c.id = config_id AND c.user_id = auth.uid()));

-- Full message history per dialog
CREATE TABLE IF NOT EXISTS public.copilot_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dialog_id uuid NOT NULL REFERENCES public.copilot_dialogs(id) ON DELETE CASCADE,
  tg_message_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  message_date timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(dialog_id, tg_message_id)
);

CREATE INDEX IF NOT EXISTS copilot_messages_dialog_date_idx
  ON public.copilot_messages (dialog_id, message_date ASC);

ALTER TABLE public.copilot_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS copilot_messages_select_own ON public.copilot_messages;
CREATE POLICY copilot_messages_select_own ON public.copilot_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.copilot_dialogs d
    JOIN public.sales_copilot_configs c ON c.id = d.config_id
    WHERE d.id = dialog_id AND c.user_id = auth.uid()
  ));

-- Sync tracking columns on sales_copilot_configs
ALTER TABLE public.sales_copilot_configs
  ADD COLUMN IF NOT EXISTS initial_sync_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS initial_sync_offset integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_full_sync_at timestamptz;
