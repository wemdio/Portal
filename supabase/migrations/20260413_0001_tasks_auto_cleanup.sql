-- Auto-cleanup: delete completed tasks older than 2 days
-- Runs daily at 03:00 UTC via pg_cron

-- Enable pg_cron if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Grant usage to postgres role
GRANT USAGE ON SCHEMA cron TO postgres;

-- Create the cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_old_completed_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.tasks
  WHERE status = 'done'
    AND updated_at < now() - interval '2 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Schedule: every day at 03:00 UTC
SELECT cron.schedule(
  'cleanup-completed-tasks',
  '0 3 * * *',
  $$SELECT public.cleanup_old_completed_tasks()$$
);
