-- Tracks when contacts_done was last filled in by the daily Instantly sync cron.
-- The column itself stays manually editable: specialists can override the auto value,
-- and the cron will overwrite again on the next run for projects that have linked
-- Instantly campaigns (project_instantly_campaigns).
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS contacts_done_synced_at timestamptz;
