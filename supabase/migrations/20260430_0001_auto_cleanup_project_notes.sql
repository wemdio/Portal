-- Auto-cleanup: delete project notes older than 2 days
-- Runs daily at 03:05 UTC via pg_cron (5 min after tasks cleanup)

CREATE OR REPLACE FUNCTION public.cleanup_old_project_notes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.project_notes
  WHERE created_at < now() - interval '2 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

SELECT cron.schedule(
  'cleanup-old-project-notes',
  '5 3 * * *',
  $$SELECT public.cleanup_old_project_notes()$$
);
