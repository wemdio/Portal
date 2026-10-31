-- Apply before the sender/worker release. No backfill or replay: a legacy
-- automatic pending/failed row is NOT evidence that no external POST occurred.
ALTER TABLE public.instantly_pending_handoffs
  ADD COLUMN IF NOT EXISTS send_attempt jsonb;

COMMENT ON COLUMN public.instantly_pending_handoffs.send_attempt IS
  'V1 durable handoff attempt: ready -> claimed -> request_started -> confirmed/unknown. '
  'Claim is written before POST for manual and auto; unknown is never automatically resent. '
  'Confirmed receipt and sent status are saved together. NULL legacy auto requires review.';

NOTIFY pgrst, 'reload schema';
