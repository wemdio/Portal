-- Keep at most one active start job per TG Outreach campaign.
--
-- Prefer the already-running job, then the oldest pending job. Mark every
-- extra row completed before creating the unique index so this migration can
-- repair installations that already accumulated duplicates.
lock table public.tg_outreach_jobs in share row exclusive mode;

with ranked_active_starts as (
  select
    id,
    row_number() over (
      partition by campaign_id
      order by
        case when status = 'running' then 0 else 1 end,
        created_at,
        id
    ) as duplicate_rank
  from public.tg_outreach_jobs
  where action = 'start'
    and status in ('pending', 'running')
)
update public.tg_outreach_jobs as jobs
set
  status = 'completed',
  finished_at = coalesce(jobs.finished_at, now()),
  error_message = coalesce(
    jobs.error_message,
    'Auto-completed duplicate active start job before enforcing uniqueness'
  )
from ranked_active_starts
where jobs.id = ranked_active_starts.id
  and ranked_active_starts.duplicate_rank > 1;

create unique index if not exists tg_outreach_jobs_one_active_start_per_campaign_idx
  on public.tg_outreach_jobs (campaign_id)
  where action = 'start'
    and status in ('pending', 'running');
