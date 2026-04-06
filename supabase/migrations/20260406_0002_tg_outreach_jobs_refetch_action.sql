-- Allow 'refetch_messages' as a valid job action for TG outreach
alter table public.tg_outreach_jobs
  drop constraint tg_outreach_jobs_action_check;

alter table public.tg_outreach_jobs
  add constraint tg_outreach_jobs_action_check
    check (action in ('start', 'stop', 'restart', 'refetch_messages'));
