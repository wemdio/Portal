-- Durable idempotency for one board row per project/thread. A specialist may
-- edit/remove the displayed request; its text must not serve as a dedup key.
-- Legacy rows implicitly already contain their qualification_id's first reply.
ALTER TABLE public.project_lead_board_rows
  ADD COLUMN IF NOT EXISTS auto_reply_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.project_lead_board_rows.auto_reply_ids IS
  'Qualification IDs already merged into this board row; internal writer bookkeeping, not editable guest data.';
