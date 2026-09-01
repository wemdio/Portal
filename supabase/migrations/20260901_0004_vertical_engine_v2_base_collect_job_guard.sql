-- Vertical Engine v2: one active base_collect worker job per persisted base.
--
-- ve_bases already has collecting-base uniqueness, but legacy/direct writes
-- can leave a collecting base without its job. Concurrent retries that repair
-- that orphan need a database invariant as well as an application pre-check.

lock table public.ve_jobs in share row exclusive mode;

do $$
begin
  if exists (
    select 1
    from public.ve_jobs
    where stage = 'base_collect'
      and status in ('pending', 'running')
      and jsonb_typeof(payload -> 'base_id') = 'string'
      and nullif(btrim(payload ->> 'base_id'), '') is not null
    group by payload ->> 'base_id'
    having count(*) > 1
  ) then
    raise exception 'Cannot install VE2 base_collect guard: duplicate active jobs already exist'
      using hint = 'Inspect active base_collect jobs by payload.base_id and resolve duplicates before retrying this migration.';
  end if;
end $$;

create unique index if not exists ve_jobs_one_active_base_collect_per_base
  on public.ve_jobs ((payload ->> 'base_id'))
  where stage = 'base_collect'
    and status in ('pending', 'running')
    and jsonb_typeof(payload -> 'base_id') = 'string'
    and nullif(btrim(payload ->> 'base_id'), '') is not null;

comment on index public.ve_jobs_one_active_base_collect_per_base is
  'Prevents concurrent normal/refill orphan repair from enqueueing two active workers for one VE2 base.';
