-- Atomically elect one specialist-alert qualification for a managed project thread.
-- Every qualification with a stable thread key receives a durable decision so a
-- later recovery pass cannot notify a duplicate that lost an earlier race.

create or replace function public.instantly_stable_thread_key(p_thread_id text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog, public
as $$
  select case
    when btrim(p_thread_id) = '' then null
    when btrim(p_thread_id) ~* '^[a-z0-9]{2}-.+'
      then substr(btrim(p_thread_id), 4)
    else btrim(p_thread_id)
  end
$$;

create table if not exists public.instantly_specialist_alert_decisions (
  qualification_id uuid primary key
    references public.instantly_lead_qualifications(id) on delete cascade,
  project_id uuid not null,
  thread_key text not null,
  is_claimant boolean not null,
  winner_qualification_id uuid not null
    references public.instantly_lead_qualifications(id) on delete cascade,
  decided_at timestamptz not null default now(),
  constraint instantly_specialist_alert_decisions_thread_key_check
    check (thread_key = btrim(thread_key) and thread_key <> ''),
  constraint instantly_specialist_alert_decisions_claimant_winner_check
    check ((is_claimant and winner_qualification_id = qualification_id)
      or (not is_claimant and winner_qualification_id <> qualification_id))
);

create unique index if not exists uq_instantly_specialist_alert_project_thread_claimant
  on public.instantly_specialist_alert_decisions (project_id, thread_key)
  where is_claimant;

create index if not exists idx_instantly_specialist_alert_decisions_winner
  on public.instantly_specialist_alert_decisions (winner_qualification_id);

alter table public.instantly_specialist_alert_decisions enable row level security;

comment on table public.instantly_specialist_alert_decisions is
  'Durable atomic specialist-alert decision per Instantly qualification. Exactly one claimant may notify for each managed project and stable thread key.';

comment on column public.instantly_specialist_alert_decisions.thread_key is
  'Thread identifier normalized with the same two-character Instantly account-prefix rule as the application stableThreadKey helper.';

-- Durable bridge between the Instantly qualification transaction and the
-- cross-database/external handoff side effect. There is deliberately no
-- historical backfill: old qualifications cannot distinguish an intentionally
-- disabled/unconfigured handoff from a lost attempt without replay risk.
create table if not exists public.instantly_lead_handoff_outbox (
  qualification_id uuid primary key
    references public.instantly_lead_qualifications(id) on delete cascade,
  project_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'skipped', 'dead')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0
    check (attempts >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  outcome text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint instantly_lead_handoff_outbox_state_check check (
    (status = 'pending'
      and lease_token is null
      and lease_expires_at is null
      and completed_at is null)
    or (status = 'processing'
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null)
    or (status in ('completed', 'skipped', 'dead')
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null)
  )
);

create index if not exists idx_instantly_lead_handoff_outbox_due
  on public.instantly_lead_handoff_outbox (
    status,
    available_at,
    created_at,
    qualification_id
  )
  where status in ('pending', 'processing');

create index if not exists idx_instantly_lead_handoff_outbox_expired_lease
  on public.instantly_lead_handoff_outbox (lease_expires_at, qualification_id)
  where status = 'processing';

alter table public.instantly_lead_handoff_outbox enable row level security;

comment on table public.instantly_lead_handoff_outbox is
  'Durable handoff work created atomically only for opted-in winning specialist-alert qualifications. Workers lease jobs through SECURITY DEFINER RPCs.';

-- Snapshot the delivery mode at materialization time. Recovery must not infer
-- auto-send from mutable project settings after a crash between insert and send.
alter table if exists public.instantly_pending_handoffs
  add column if not exists auto_send boolean not null default false;

-- Existing proven managed leads predate the claim RPC. Elect the oldest persisted
-- qualification as claimant so later recovery cannot re-notify another account copy.
with eligible as (
  select
    q.id as qualification_id,
    q.qualified_project_id as project_id,
    public.instantly_stable_thread_key(q.thread_id) as thread_key,
    q.updated_at
  from public.instantly_lead_qualifications q
  where q.status = 'lead'
    and q.qualified_project_owner_proven is true
    and q.qualified_project_id is not null
    and public.instantly_stable_thread_key(q.thread_id) is not null
), ranked as (
  select
    qualification_id,
    project_id,
    thread_key,
    row_number() over (
      partition by project_id, thread_key
      order by updated_at asc, qualification_id asc
    ) as winner_rank,
    first_value(qualification_id) over (
      partition by project_id, thread_key
      order by updated_at asc, qualification_id asc
    ) as winner_qualification_id
  from eligible
)
insert into public.instantly_specialist_alert_decisions (
  qualification_id,
  project_id,
  thread_key,
  is_claimant,
  winner_qualification_id
)
select
  qualification_id,
  project_id,
  thread_key,
  true,
  winner_qualification_id
from ranked
where winner_rank = 1
union all
select
  qualification_id,
  project_id,
  thread_key,
  false,
  winner_qualification_id
from ranked
where winner_rank > 1
on conflict do nothing;

create or replace function public.claim_instantly_specialist_alert(
  p_qualification_id uuid,
  p_enqueue_handoff boolean default false
)
returns table (
  should_alert boolean,
  winner_qualification_id uuid,
  dedup_applied boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_project_id uuid;
  v_owner_proven boolean;
  v_thread_key text;
  v_is_claimant boolean;
  v_should_alert boolean;
  v_winner_id uuid;
  v_dedup_applied boolean;
begin
  select
    q.status,
    q.qualified_project_id,
    q.qualified_project_owner_proven,
    public.instantly_stable_thread_key(q.thread_id)
  into
    v_status,
    v_project_id,
    v_owner_proven,
    v_thread_key
  from public.instantly_lead_qualifications q
  where q.id = p_qualification_id;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'instantly_specialist_alert_qualification_not_found';
  end if;

  if v_status <> 'lead'
     or v_owner_proven is not true
     or v_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'instantly_specialist_alert_qualification_not_eligible';
  end if;

  -- A missing stable key cannot be deduplicated safely. It still represents a
  -- winning delivery and therefore receives an opted-in durable handoff job.
  if v_thread_key is null then
    v_should_alert := true;
    v_winner_id := p_qualification_id;
    v_dedup_applied := false;
  else
    select d.is_claimant, d.winner_qualification_id
    into v_is_claimant, v_winner_id
    from public.instantly_specialist_alert_decisions d
    where d.qualification_id = p_qualification_id;

    if found then
      v_should_alert := v_is_claimant;
      v_dedup_applied := true;
    else
      -- The partial unique index is the concurrency primitive. A conflicting
      -- insert waits for the winner transaction, then returns no row.
      v_winner_id := null;
      insert into public.instantly_specialist_alert_decisions (
        qualification_id,
        project_id,
        thread_key,
        is_claimant,
        winner_qualification_id
      )
      values (p_qualification_id, v_project_id, v_thread_key, true, p_qualification_id)
      on conflict do nothing
      returning qualification_id into v_winner_id;

      if v_winner_id is not null then
        v_should_alert := true;
        v_dedup_applied := true;
      else
        -- The conflict can also be a concurrent call for this exact
        -- qualification. Re-read its durable decision first.
        select d.is_claimant, d.winner_qualification_id
        into v_is_claimant, v_winner_id
        from public.instantly_specialist_alert_decisions d
        where d.qualification_id = p_qualification_id;

        if found then
          v_should_alert := v_is_claimant;
          v_dedup_applied := true;
        else
          select d.qualification_id
          into v_winner_id
          from public.instantly_specialist_alert_decisions d
          where d.project_id = v_project_id
            and d.thread_key = v_thread_key
            and d.is_claimant is true;

          if v_winner_id is null then
            raise exception using
              errcode = '40001',
              message = 'instantly_specialist_alert_claim_retry';
          end if;

          insert into public.instantly_specialist_alert_decisions (
            qualification_id,
            project_id,
            thread_key,
            is_claimant,
            winner_qualification_id
          )
          values (p_qualification_id, v_project_id, v_thread_key, false, v_winner_id)
          on conflict (qualification_id) do nothing;

          select d.is_claimant, d.winner_qualification_id
          into v_is_claimant, v_winner_id
          from public.instantly_specialist_alert_decisions d
          where d.qualification_id = p_qualification_id;

          if not found then
            raise exception using
              errcode = '40001',
              message = 'instantly_specialist_alert_decision_retry';
          end if;

          v_should_alert := v_is_claimant;
          v_dedup_applied := true;
        end if;
      end if;
    end if;
  end if;

  -- One write point covers fresh winners, existing claimant self-healing and
  -- null-thread fail-open winners. Duplicate losers never enter this branch.
  if v_should_alert is true
     and coalesce(p_enqueue_handoff, false) then
    insert into public.instantly_lead_handoff_outbox (
      qualification_id,
      project_id
    )
    values (p_qualification_id, v_project_id)
    on conflict (qualification_id) do nothing;
  end if;

  return query select v_should_alert, v_winner_id, v_dedup_applied;
end;
$$;

create or replace function public.lease_instantly_lead_handoff_jobs(
  p_limit integer default 2,
  p_qualification_id uuid default null,
  p_lease_seconds integer default 1800
)
returns table (
  qualification_id uuid,
  project_id uuid,
  status text,
  available_at timestamptz,
  attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz,
  outcome text,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_limit integer := greatest(1, least(coalesce(p_limit, 2), 50));
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 1800), 86400));
begin
  return query
  with candidates as (
    select o.qualification_id
    from public.instantly_lead_handoff_outbox o
    where (p_qualification_id is null or o.qualification_id = p_qualification_id)
      and (
        (o.status = 'pending' and o.available_at <= v_now)
        or (o.status = 'processing' and o.lease_expires_at <= v_now)
      )
    order by
      case
        when o.status = 'pending' then o.available_at
        else o.lease_expires_at
      end,
      o.created_at,
      o.qualification_id
    for update of o skip locked
    limit v_limit
  ), leased as (
    update public.instantly_lead_handoff_outbox o
    set
      status = 'processing',
      attempts = o.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
      outcome = null,
      completed_at = null,
      updated_at = v_now
    from candidates c
    where o.qualification_id = c.qualification_id
    returning
      o.qualification_id,
      o.project_id,
      o.status,
      o.available_at,
      o.attempts,
      o.lease_token,
      o.lease_expires_at,
      o.outcome,
      o.last_error,
      o.created_at,
      o.updated_at,
      o.completed_at
  )
  select
    l.qualification_id,
    l.project_id,
    l.status,
    l.available_at,
    l.attempts,
    l.lease_token,
    l.lease_expires_at,
    l.outcome,
    l.last_error,
    l.created_at,
    l.updated_at,
    l.completed_at
  from leased l
  order by l.created_at, l.qualification_id;
end;
$$;

create or replace function public.finish_instantly_lead_handoff_job(
  p_qualification_id uuid,
  p_lease_token uuid,
  p_disposition text,
  p_outcome text default null,
  p_error text default null,
  p_retry_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_finished boolean;
begin
  if p_qualification_id is null or p_lease_token is null then
    raise exception using
      errcode = '22023',
      message = 'instantly_lead_handoff_finish_missing_lease';
  end if;

  if p_disposition is null
     or p_disposition not in ('completed', 'skipped', 'retry', 'dead') then
    raise exception using
      errcode = '22023',
      message = 'instantly_lead_handoff_finish_invalid_disposition';
  end if;

  update public.instantly_lead_handoff_outbox o
  set
    status = case
      when p_disposition = 'retry' then 'pending'
      else p_disposition
    end,
    available_at = case
      when p_disposition = 'retry'
        then greatest(coalesce(p_retry_at, v_now + interval '15 minutes'), v_now)
      else o.available_at
    end,
    lease_token = null,
    lease_expires_at = null,
    outcome = case
      when p_disposition = 'retry' then null
      else nullif(btrim(p_outcome), '')
    end,
    last_error = case
      when p_disposition = 'completed' then null
      else nullif(left(coalesce(p_error, ''), 2000), '')
    end,
    updated_at = v_now,
    completed_at = case
      when p_disposition = 'retry' then null
      else v_now
    end
  where o.qualification_id = p_qualification_id
    and o.status = 'processing'
    and o.lease_token = p_lease_token
  returning true into v_finished;

  return coalesce(v_finished, false);
end;
$$;

revoke all on function public.instantly_stable_thread_key(text)
  from public;
revoke all on function public.claim_instantly_specialist_alert(uuid, boolean)
  from public;
revoke all on function public.lease_instantly_lead_handoff_jobs(integer, uuid, integer)
  from public;
revoke all on function public.finish_instantly_lead_handoff_job(uuid, uuid, text, text, text, timestamptz)
  from public;

revoke all on table public.instantly_specialist_alert_decisions
  from public;
revoke all on table public.instantly_lead_handoff_outbox
  from public;

-- The self-hosted Instantly database normally has only the `instantly` role,
-- while hosted Supabase exposes service_role/anon/authenticated. Keep one
-- migration valid in both environments and do not reference absent roles.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.instantly_stable_thread_key(text) from anon';
    execute 'revoke all on function public.claim_instantly_specialist_alert(uuid, boolean) from anon';
    execute 'revoke all on function public.lease_instantly_lead_handoff_jobs(integer, uuid, integer) from anon';
    execute 'revoke all on function public.finish_instantly_lead_handoff_job(uuid, uuid, text, text, text, timestamptz) from anon';
    execute 'revoke all on table public.instantly_specialist_alert_decisions from anon';
    execute 'revoke all on table public.instantly_lead_handoff_outbox from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.instantly_stable_thread_key(text) from authenticated';
    execute 'revoke all on function public.claim_instantly_specialist_alert(uuid, boolean) from authenticated';
    execute 'revoke all on function public.lease_instantly_lead_handoff_jobs(integer, uuid, integer) from authenticated';
    execute 'revoke all on function public.finish_instantly_lead_handoff_job(uuid, uuid, text, text, text, timestamptz) from authenticated';
    execute 'revoke all on table public.instantly_specialist_alert_decisions from authenticated';
    execute 'revoke all on table public.instantly_lead_handoff_outbox from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.instantly_stable_thread_key(text) from service_role';
    execute 'revoke all on table public.instantly_lead_handoff_outbox from service_role';
    execute 'grant execute on function public.claim_instantly_specialist_alert(uuid, boolean) to service_role';
    execute 'grant execute on function public.lease_instantly_lead_handoff_jobs(integer, uuid, integer) to service_role';
    execute 'grant execute on function public.finish_instantly_lead_handoff_job(uuid, uuid, text, text, text, timestamptz) to service_role';
    execute 'grant select on table public.instantly_specialist_alert_decisions to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'revoke all on function public.instantly_stable_thread_key(text) from instantly';
    execute 'revoke all on table public.instantly_lead_handoff_outbox from instantly';
    execute 'grant execute on function public.claim_instantly_specialist_alert(uuid, boolean) to instantly';
    execute 'grant execute on function public.lease_instantly_lead_handoff_jobs(integer, uuid, integer) to instantly';
    execute 'grant execute on function public.finish_instantly_lead_handoff_job(uuid, uuid, text, text, text, timestamptz) to instantly';
    execute 'grant select on table public.instantly_specialist_alert_decisions to instantly';
  end if;
end $$;
