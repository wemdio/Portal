-- Instantly's daily analytics omits bounces. Persist the timestamped
-- email_bounced webhook in instantly_activity_events and expose a small daily
-- aggregate to the mailbox outcomes dashboard. Older days have no coverage.

CREATE TABLE IF NOT EXISTS public.instantly_bounce_coverage (
  instantly_account_id text PRIMARY KEY,
  started_at timestamptz NOT NULL
);

ALTER TABLE public.instantly_bounce_coverage ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.instantly_bounce_coverage TO service_role;

CREATE INDEX IF NOT EXISTS ix_instantly_activity_bounced_account_time
  ON public.instantly_activity_events (instantly_account_id, occurred_at)
  WHERE event_type = 'bounced';

CREATE OR REPLACE FUNCTION public.instantly_bounces_daily(p_from date, p_to date)
RETURNS TABLE(day text, bounced bigint)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         count(*) AS bounced
  FROM public.instantly_activity_events
  WHERE instantly_account_id = 'main'
    AND event_type = 'bounced'
    AND occurred_at >= p_from::timestamp AT TIME ZONE 'UTC'
    AND occurred_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC'
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.instantly_bounces_daily(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.instantly_bounces_daily(date, date) TO service_role;
