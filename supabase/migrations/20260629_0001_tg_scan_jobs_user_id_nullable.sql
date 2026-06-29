-- Allow cron-initiated tg_scan_jobs to skip the user_id column.
--
-- Today every row in tg_scan_jobs traces back to the human admin who hit
-- "Сканировать" in the UI. We're adding a daily auto-sync cron that queues
-- a full scan for every registered chat at 01:00 MSK — there's no user
-- behind that, it's a system job. Making the column nullable is the
-- minimum change; the UI path keeps writing the auth'd user as before, the
-- /scan GET endpoint's isOwner check already short-circuits to "anyone can
-- see it" when user_id is null which is exactly what we want for system
-- jobs.

alter table public.tg_scan_jobs
  alter column user_id drop not null;

comment on column public.tg_scan_jobs.user_id is
  'Auth.users id of the admin who started the scan via the UI. NULL when the job was queued by the daily auto-sync cron (no human initiator).';

notify pgrst, 'reload schema';
