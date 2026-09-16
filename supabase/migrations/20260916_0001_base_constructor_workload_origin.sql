-- Metadata-only addition; NULL keeps old writers compatible during rollout.
-- Unknown work stays in the shared pool and counts against the manual quota
-- until its provenance is known. A filename is never an authority signal.
set local lock_timeout = '5s';
alter table public.base_constructor_jobs
  add column if not exists workload_origin text
    check (workload_origin in ('manual', 'automation'));

comment on column public.base_constructor_jobs.workload_origin is
  'Trusted producer: manual upload or automation. NULL is unclassified legacy/rolling-deploy work; shared pool only.';

-- Clients cannot relabel a job to bypass quotas or consume reserved capacity.
-- Server producers use service_role and set the origin explicitly.
create or replace function public.guard_base_constructor_workload_origin()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if current_user in ('authenticated', 'anon') or auth.role() in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' then
      NEW.workload_origin := 'manual';
    else
      NEW.workload_origin := OLD.workload_origin;
    end if;
  end if;
  return NEW;
end;
$$;
revoke all on function public.guard_base_constructor_workload_origin() from public;
drop trigger if exists guard_base_constructor_workload_origin on public.base_constructor_jobs;
create trigger guard_base_constructor_workload_origin
  before insert or update of workload_origin on public.base_constructor_jobs
  for each row execute function public.guard_base_constructor_workload_origin();

create index if not exists idx_base_constructor_active_origin
  on public.base_constructor_jobs (workload_origin, created_at, id)
  where status in ('pending', 'processing');

-- Historical backfill is in a separate transaction so its JSON reads never
-- prolong the ACCESS EXCLUSIVE lock held by ADD COLUMN.
