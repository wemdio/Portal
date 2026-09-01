-- Vertical Engine v2: atomic per-project UTC-day budget for refill sends.
--
-- A read(sum(previous runs)) -> provider POST sequence is racy: two workers
-- can observe the same remainder. Reservations are claimed under a
-- transaction-scoped advisory lock before any Instantly write. Unfinalized
-- reservations keep their full amount until the UTC day ends (safe under-send
-- after a crash, never an accidental over-send).

-- The first reservation of a project/day freezes that day's cap from the
-- server-side VE2 auto-pipeline config. Later config edits take effect on the
-- next UTC day, so callers cannot race by submitting different cap values.
create table if not exists public.ve_refill_daily_budgets (
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  budget_date date not null,
  daily_cap integer not null check (daily_cap >= 0),
  created_at timestamptz not null default now(),
  primary key (project_id, budget_date)
);

create table if not exists public.ve_refill_daily_reservations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  -- Snapshot identifier, intentionally without an FK: deleting an analyzed
  -- base must not erase budget already spent by its provider request.
  base_id uuid not null,
  budget_date date not null,
  reserved_count integer not null check (reserved_count > 0),
  consumed_count integer not null default 0
    check (consumed_count >= 0 and consumed_count <= reserved_count),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (base_id, budget_date)
);

create index if not exists ve_refill_daily_reservations_project_day
  on public.ve_refill_daily_reservations(project_id, budget_date);

comment on table public.ve_refill_daily_reservations is
  'Atomic VE2 refill budget claims. Open claims consume reserved_count; finalized claims consume consumed_count.';
comment on table public.ve_refill_daily_budgets is
  'Immutable per-project UTC-day VE2 refill cap snapshot; config changes apply on the next day.';

alter table public.ve_refill_daily_budgets enable row level security;
alter table public.ve_refill_daily_reservations enable row level security;

drop policy if exists "Service role full access on ve_refill_daily_reservations"
  on public.ve_refill_daily_reservations;
drop policy if exists "Service role read access on ve_refill_daily_budgets"
  on public.ve_refill_daily_budgets;
create policy "Service role read access on ve_refill_daily_budgets"
  on public.ve_refill_daily_budgets
  for select to service_role
  using (true);

drop policy if exists "Service role read access on ve_refill_daily_reservations"
  on public.ve_refill_daily_reservations;
create policy "Service role read access on ve_refill_daily_reservations"
  on public.ve_refill_daily_reservations
  for select to service_role
  using (true);

revoke all on table public.ve_refill_daily_budgets, public.ve_refill_daily_reservations
  from public, anon, authenticated, service_role;
grant select on public.ve_refill_daily_budgets to service_role;
grant select on public.ve_refill_daily_reservations to service_role;
grant all on table public.ve_refill_daily_budgets, public.ve_refill_daily_reservations
  to postgres;

create or replace function public.ve_reserve_refill_daily_budget(
  p_project_id uuid,
  p_base_id uuid,
  p_requested integer
)
returns table(reservation_id uuid, granted integer, budget_date date)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget_date date := pg_catalog.timezone('UTC', pg_catalog.now())::date;
  v_cap integer;
  v_config_cap integer;
  v_spent bigint;
  v_granted integer;
  v_reservation_id uuid;
begin
  if p_project_id is null or p_base_id is null then
    raise exception 'project and base are required';
  end if;
  if p_requested is null or p_requested < 0 then
    raise exception 'requested must be a non-negative integer';
  end if;
  if p_requested = 0 then
    return query select null::uuid, 0, v_budget_date;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      've-refill-budget:' || p_project_id::text || ':' || v_budget_date::text,
      0
    )
  );

  if not exists (
    select 1
    from public.ve_bases b
    where b.id = p_base_id
      and b.project_id = p_project_id
      and b.source = 'auto'
      and b.status = 'collecting'
  ) then
    raise exception 'collecting VE2 refill base does not belong to project';
  end if;

  select b.daily_cap
    into v_cap
    from public.ve_refill_daily_budgets b
   where b.project_id = p_project_id
     and b.budget_date = v_budget_date;
  if not found then
    -- The VE2 auto-pipeline tables are a separately deployed phase. Until the
    -- config table exists (or when a project has no row), use the documented
    -- server-side default. Dynamic SQL keeps this migration deployable before
    -- that optional table while never trusting a caller-supplied cap.
    v_cap := 50;
    if pg_catalog.to_regclass('public.ve_auto_pipeline_configs') is not null then
      execute
        'select daily_leads_cap from public.ve_auto_pipeline_configs where project_id = $1'
        into v_config_cap
        using p_project_id;
      if v_config_cap is not null then
        v_cap := v_config_cap;
      end if;
    end if;
    if v_cap < 0 then
      raise exception 'configured VE2 refill cap must be non-negative';
    end if;
    insert into public.ve_refill_daily_budgets (project_id, budget_date, daily_cap)
    values (p_project_id, v_budget_date, v_cap);
  end if;

  -- A lost RPC response or a retried worker must not obtain a second claim
  -- for the same base/day. The existing reservation remains conservative.
  if exists (
    select 1
    from public.ve_refill_daily_reservations r
    where r.base_id = p_base_id
      and r.budget_date = v_budget_date
  ) then
    return query select null::uuid, 0, v_budget_date;
    return;
  end if;

  select coalesce(sum(
    case when r.finalized_at is null then r.reserved_count else r.consumed_count end
  ), 0)
    into v_spent
    from public.ve_refill_daily_reservations r
   where r.project_id = p_project_id
     and r.budget_date = v_budget_date;

  v_granted := greatest(
    0,
    least(p_requested::bigint, v_cap::bigint - v_spent)
  )::integer;
  if v_granted = 0 then
    return query select null::uuid, 0, v_budget_date;
    return;
  end if;

  insert into public.ve_refill_daily_reservations (
    project_id,
    base_id,
    budget_date,
    reserved_count
  ) values (
    p_project_id,
    p_base_id,
    v_budget_date,
    v_granted
  )
  returning id into v_reservation_id;

  return query select v_reservation_id, v_granted, v_budget_date;
end;
$$;

create or replace function public.ve_finalize_refill_daily_budget(
  p_reservation_id uuid,
  p_base_id uuid,
  p_consumed integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_budget_date date;
  v_reserved integer;
  v_consumed integer;
  v_finalized_at timestamptz;
begin
  if p_reservation_id is null or p_base_id is null then
    raise exception 'reservation and base are required';
  end if;
  if p_consumed is null or p_consumed < 0 then
    raise exception 'consumed must be a non-negative integer';
  end if;

  select r.project_id, r.budget_date
    into v_project_id, v_budget_date
    from public.ve_refill_daily_reservations r
   where r.id = p_reservation_id
     and r.base_id = p_base_id;
  if not found then
    raise exception 'VE2 refill reservation not found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      've-refill-budget:' || v_project_id::text || ':' || v_budget_date::text,
      0
    )
  );

  select r.reserved_count, r.consumed_count, r.finalized_at
    into v_reserved, v_consumed, v_finalized_at
    from public.ve_refill_daily_reservations r
   where r.id = p_reservation_id
     and r.base_id = p_base_id
   for update;
  if not found then
    raise exception 'VE2 refill reservation not found';
  end if;
  if p_consumed > v_reserved then
    raise exception 'consumed count exceeds reserved refill budget';
  end if;
  if v_finalized_at is not null then
    if p_consumed <> v_consumed then
      raise exception 'VE2 refill reservation is already finalized with consumed count %', v_consumed;
    end if;
    return;
  end if;

  update public.ve_refill_daily_reservations r
     set consumed_count = p_consumed,
         finalized_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where r.id = p_reservation_id
     and r.base_id = p_base_id;
end;
$$;

revoke all on function public.ve_reserve_refill_daily_budget(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.ve_finalize_refill_daily_budget(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ve_reserve_refill_daily_budget(uuid, uuid, integer)
  to service_role, postgres;
grant execute on function public.ve_finalize_refill_daily_budget(uuid, uuid, integer)
  to service_role, postgres;
