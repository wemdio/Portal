-- migrate:no-transaction
-- Address lookups for email_bounce_history (20261026_0090): its bounced events
-- and the opened/replied events after them. instantly_activity_events holds
-- 1.5 M rows (2 GB, 26.10.2026) and takes webhook writes, so the index is built
-- online, as in 20261011_0010; the drop cleans up an invalid index left by a
-- failed build. Alone in its file: a retry of this file rebuilds only this
-- index. CONCURRENTLY waits for older transactions under the runner's
-- lock_timeout: deploy away from the 06:00/18:00 UTC main-full backup.
DROP INDEX CONCURRENTLY IF EXISTS public.ix_instantly_activity_email_event_time;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_instantly_activity_email_event_time
  ON public.instantly_activity_events (lower(lead_email), event_type, occurred_at);
