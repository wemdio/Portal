-- Add scan_mode to tg_scan_jobs to distinguish bounded "find N videos in last 2000 messages"
-- scans (the default) from unbounded "walk the entire chat history" scans triggered by the
-- "Сканировать весь чат" button. The worker reads this column to decide whether to honor or
-- ignore the maxScan / video_count caps. Existing rows are 'limited' (backfill via default),
-- which matches their original semantics.
alter table public.tg_scan_jobs
  add column if not exists scan_mode text not null default 'limited';

alter table public.tg_scan_jobs
  drop constraint if exists tg_scan_jobs_scan_mode_check;

alter table public.tg_scan_jobs
  add constraint tg_scan_jobs_scan_mode_check
    check (scan_mode in ('limited', 'full'));
