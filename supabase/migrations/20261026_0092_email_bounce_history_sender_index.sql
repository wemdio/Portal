-- migrate:no-transaction
-- Address lookup for the sender branch of email_bounce_history (20261026_0090):
-- hard bounces of our own sender. Built online beside sender writes; the drop
-- cleans up an invalid index left by a failed build.
DROP INDEX CONCURRENTLY IF EXISTS public.ix_sender_suppressions_hard_bounce_email;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_sender_suppressions_hard_bounce_email
  ON public.sender_suppressions (lower(email))
  WHERE reason = 'hard_bounce';
