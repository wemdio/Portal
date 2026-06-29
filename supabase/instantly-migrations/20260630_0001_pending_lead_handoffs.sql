-- Pending lead handoffs: a generated handoff reply posted to Telegram with a
-- "Передать клиенту" button, awaiting a press by the responsible specialist.
-- The worker inserts a row (status='pending') when it posts the button; the
-- callback handler reads it, verifies the presser, sends via replyToEmail, and
-- flips it to 'sent'. One row per qualification (idempotent re-posts).

CREATE TABLE IF NOT EXISTS public.instantly_pending_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id uuid NOT NULL UNIQUE,
  campaign_id text,
  draft_text text NOT NULL,
  reply_to_uuid text NOT NULL,      -- instantly_email_id to reply into the thread
  eaccount text NOT NULL,           -- sending mailbox
  client_email text NOT NULL,       -- CC'd on send (project.handoff_email)
  responsible_user_id uuid,         -- main-db profiles.id; only they may press
  tg_chat_id bigint,
  tg_message_id bigint,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  sent_by_telegram_id bigint,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_handoffs_status
  ON public.instantly_pending_handoffs(status);
