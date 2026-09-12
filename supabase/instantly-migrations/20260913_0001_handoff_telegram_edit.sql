-- Manual Telegram editing only; automatic delivery settings remain unchanged.
ALTER TABLE public.instantly_pending_handoffs
  ADD COLUMN IF NOT EXISTS edit_token uuid,
  ADD COLUMN IF NOT EXISTS edit_user_id bigint,
  ADD COLUMN IF NOT EXISTS edit_chat_id bigint,
  ADD COLUMN IF NOT EXISTS edit_prompt_id bigint,
  ADD COLUMN IF NOT EXISTS edit_preview_id bigint,
  ADD COLUMN IF NOT EXISTS edit_text text,
  ADD COLUMN IF NOT EXISTS edit_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_send_claimed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS pending_handoff_edit_token
  ON public.instantly_pending_handoffs(edit_token) WHERE edit_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pending_handoff_edit_prompt
  ON public.instantly_pending_handoffs(edit_chat_id, edit_prompt_id)
  WHERE edit_prompt_id IS NOT NULL;
COMMENT ON COLUMN public.instantly_pending_handoffs.manual_send_claimed_at IS
  'One-shot manual send claim. Never reset automatically after timeout: provider may have accepted the email.';
NOTIFY pgrst, 'reload schema';
