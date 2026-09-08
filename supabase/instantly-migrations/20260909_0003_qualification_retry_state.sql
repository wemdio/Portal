-- Instantly operational DB, NOT main Portal. Additive scheduling metadata;
-- existing pending rows and original ids/body/age remain intact.
BEGIN;
ALTER TABLE public.instantly_lead_qualifications
  ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_next_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_failure_kind text,
  ADD COLUMN IF NOT EXISTS recovery_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_use_snapshot boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reply_recovery_snapshot jsonb;
CREATE INDEX IF NOT EXISTS instantly_qualification_retry_due_idx
  ON public.instantly_lead_qualifications (recovery_next_at, created_at, updated_at)
  WHERE status IN ('pending', 'needs_review') AND ai_confidence = 0;
COMMENT ON COLUMN public.instantly_lead_qualifications.recovery_attempts IS
  'Durable claimed recovery attempts; not AI calls or billed requests. Never reset by a worker restart.';
COMMENT ON COLUMN public.instantly_lead_qualifications.recovery_use_snapshot IS
  'Provider GET returned 404; subsequent retries check safe local inbound evidence instead of requesting the dead ID again. Missing original To/CC/body blocks qualification, never owner proof bypass.';
COMMIT;
NOTIFY pgrst, 'reload schema';
