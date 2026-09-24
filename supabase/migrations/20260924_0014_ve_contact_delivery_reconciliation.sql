-- Reconcile ambiguous uploads from live campaign membership. Original attempt
-- outcomes remain immutable; observations and resolutions have their own audit.
alter table public.ve_contact_delivery_attempts add column if not exists request_lease_until timestamptz;
alter table public.ve_contact_delivery_rows
  add column if not exists recovery_token uuid,
  add column if not exists recovery_checked_at timestamptz,
  add column if not exists recovery_missing_since timestamptz;
alter table public.ve_contact_delivery_daily_runs add column if not exists recovery_retry_requested_at timestamptz;

create table if not exists public.ve_contact_delivery_reconciliations (
  id uuid primary key default gen_random_uuid(),
  row_id uuid not null references public.ve_contact_delivery_rows(id) on delete cascade,
  attempt_id uuid not null references public.ve_contact_delivery_attempts(id) on delete cascade,
  run_id uuid not null references public.ve_contact_delivery_daily_runs(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'checking' check(status in ('checking','present','missing','released','inconclusive')),
  provider_lead_id text,
  error text
);
create index if not exists ve_contact_delivery_reconciliations_row_idx on public.ve_contact_delivery_reconciliations(row_id,started_at);
create index if not exists ve_contact_delivery_recovery_rows_idx on public.ve_contact_delivery_rows(ve_project_id,recovery_checked_at,id) where status='uncertain';
alter table public.ve_contact_delivery_reconciliations enable row level security;
revoke all on public.ve_contact_delivery_reconciliations from public,anon,authenticated;
grant select on public.ve_contact_delivery_reconciliations to service_role;
grant all on public.ve_contact_delivery_reconciliations to postgres;
create policy "Service role read contact delivery reconciliations" on public.ve_contact_delivery_reconciliations
  for select to service_role using (true);
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='readonly') then
    execute 'grant select on public.ve_contact_delivery_reconciliations to readonly';
  end if;
end; $$;

-- Old workers keep their old fence and cannot opt into abandoned-attempt
-- recovery accidentally. Only this new entry point issues a renewable lease.
create or replace function public.ve_begin_recoverable_contact_delivery(p_run_id uuid,p_attempt_id uuid,p_campaign_id text,p_row_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  v_result:=public.ve_mark_contact_delivery_attempt(p_run_id,p_attempt_id,p_campaign_id,p_row_ids);
  if (v_result->>'marked')::boolean then
    update public.ve_contact_delivery_attempts set request_lease_until=pg_catalog.now()+interval '5 minutes' where id=p_attempt_id;
    update public.ve_contact_delivery_rows set recovery_token=null,recovery_checked_at=null,recovery_missing_since=null where attempt_id=p_attempt_id;
  end if;
  return v_result;
end;
$$;

create or replace function public.ve_renew_contact_delivery_request(p_run_id uuid,p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  -- Same lock order as finalization. A delayed process cannot revive a lease.
  perform 1 from public.ve_contact_delivery_daily_runs where id=p_run_id for update;
  update public.ve_contact_delivery_attempts set request_lease_until=pg_catalog.now()+interval '5 minutes'
    where id=p_attempt_id and run_id=p_run_id and status='attempting' and request_lease_until>pg_catalog.now();
  return found;
end;
$$;

create or replace function public.ve_claim_contact_delivery_reconciliation(p_ve_project_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_project public.ve_projects%rowtype; v_attempt public.ve_contact_delivery_attempts%rowtype;
  v_row public.ve_contact_delivery_rows%rowtype; v_token uuid; v_scope record; v_now timestamptz:=pg_catalog.now();
begin
  select * into v_project from public.ve_projects where id=p_ve_project_id;
  if not found then raise exception 'VE2 project not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_project.portal_project_id,v_project.portal_period_id));
  -- Retire at most one crashed new-protocol attempt per call. Its request had
  -- a 90s full-body deadline; the extra 5m grace outlives that deadline. Legacy
  -- attempts without a lease cannot prove quiescence and stay fenced.
  select a.* into v_attempt from public.ve_contact_delivery_attempts a
    join public.ve_contact_delivery_daily_runs d on d.id=a.run_id
    where d.ve_project_id=p_ve_project_id and a.status='attempting' and a.request_lease_until<=v_now-interval '5 minutes'
    order by a.request_lease_until,a.id limit 1;
  if found then
    perform 1 from public.ve_contact_delivery_daily_runs where id=v_attempt.run_id for update;
    select * into v_attempt from public.ve_contact_delivery_attempts where id=v_attempt.id for update;
    if v_attempt.status='attempting' and v_attempt.request_lease_until<=v_now-interval '5 minutes' then
      perform public.ve_finalize_contact_delivery_attempt(v_attempt.run_id,v_attempt.id,v_attempt.campaign_id,
        '{}'::uuid[],'{}'::uuid[],v_attempt.row_ids,'{}'::uuid[],'Provider attempt lease expired; checking campaign membership');
    end if;
  end if;
  select r.* into v_row from public.ve_contact_delivery_rows r
    join public.ve_contact_delivery_attempts a on a.id=r.attempt_id
    join public.ve_launch_queue_items qi on qi.id=r.item_id
    where r.ve_project_id=p_ve_project_id and r.status='uncertain' and a.status='finalized'
      and a.finalized_at<=v_now-interval '10 minutes' and qi.status='active'
      and qi.instantly_account_id=v_project.launch_instantly_account_id
      and (r.recovery_checked_at is null or r.recovery_checked_at<=v_now-interval '5 minutes')
    order by r.recovery_checked_at nulls first,r.id limit 1;
  if not found then return null; end if;
  perform 1 from public.ve_contact_delivery_daily_runs where id=v_row.run_id for update;
  select * into v_row from public.ve_contact_delivery_rows where id=v_row.id for update;
  -- The advisory lock serializes claimers. Run lock serializes finalizers.
  if v_row.status<>'uncertain' then return null; end if;
  select c.campaign_id,qi.instantly_account_id,qi.mailbox_ids into v_scope
    from public.ve_launch_queue_campaigns c join public.ve_launch_queue_items qi on qi.id=c.item_id
    where c.id=v_row.campaign_row_id and qi.id=v_row.item_id;
  insert into public.ve_contact_delivery_reconciliations(row_id,attempt_id,run_id)
    values(v_row.id,v_row.attempt_id,v_row.run_id) returning id into v_token;
  update public.ve_contact_delivery_rows set recovery_token=v_token,recovery_checked_at=v_now where id=v_row.id;
  return jsonb_build_object('token',v_token,'email',v_row.email_normalized,'campaign_id',v_scope.campaign_id,
    'account_id',v_scope.instantly_account_id,'mailbox_ids',v_scope.mailbox_ids);
end;
$$;

create or replace function public.ve_finish_contact_delivery_reconciliation(p_token uuid,p_provider_lead_id text,p_absent boolean,p_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_check public.ve_contact_delivery_reconciliations%rowtype; v_row public.ve_contact_delivery_rows%rowtype;
  v_run public.ve_contact_delivery_daily_runs%rowtype; v_now timestamptz:=pg_catalog.now(); v_status text;
  v_same_day boolean; v_accepted integer; v_skipped integer; v_uncertain integer; v_inflight integer; v_linked integer;
begin
  select * into v_check from public.ve_contact_delivery_reconciliations where id=p_token;
  if not found then raise exception 'Reconciliation not found'; end if;
  select * into v_run from public.ve_contact_delivery_daily_runs where id=v_check.run_id for update;
  select * into v_check from public.ve_contact_delivery_reconciliations where id=p_token for update;
  if v_check.status<>'checking' then return jsonb_build_object('status',v_check.status,'replayed',true); end if;
  select * into v_row from public.ve_contact_delivery_rows where id=v_check.row_id for update;
  if v_row.status<>'uncertain' or v_row.attempt_id is distinct from v_check.attempt_id or v_row.recovery_token is distinct from p_token
    or v_check.started_at<v_now-interval '2 minutes' then
    update public.ve_contact_delivery_reconciliations set status='inconclusive',finished_at=v_now,error='Stale observation' where id=p_token;
    return jsonb_build_object('status','inconclusive');
  end if;
  if p_provider_lead_id is not null and (nullif(btrim(p_provider_lead_id),'') is null or coalesce(p_absent,false) or p_error is not null) then
    raise exception 'Contradictory membership evidence';
  end if;
  v_status:=case when p_provider_lead_id is not null then 'present' when p_absent is true and p_error is null then 'missing' else 'inconclusive' end;
  if v_status='present' then
    update public.ve_contact_delivery_rows set status='accepted',last_error=null,finalized_at=v_now,recovery_missing_since=null,updated_at=v_now where id=v_row.id;
  elsif v_status='missing' then
    if v_row.recovery_missing_since is not null and v_check.started_at>=v_row.recovery_missing_since+interval '5 minutes' then
      -- Same-day retry stays in exactly the original frozen reservation. It
      -- never clears upload_blocked_at or expands the allowance. On a later
      -- day release to the ordinary planner, which rechecks term and quota.
      v_same_day:=v_run.run_date=timezone(v_run.timezone,v_now)::date;
      update public.ve_contact_delivery_rows set status=case when v_same_day then 'reserved' else 'ready' end,
        run_id=case when v_same_day then v_row.run_id else null end,attempt_id=null,
        reserved_at=case when v_same_day then v_now else null end,attempted_at=null,finalized_at=null,
        recovery_missing_since=null,last_error=null,updated_at=v_now where id=v_row.id;
      if v_same_day then update public.ve_contact_delivery_daily_runs set recovery_retry_requested_at=v_now where id=v_run.id; end if;
      v_status:='released';
    else
      update public.ve_contact_delivery_rows set recovery_missing_since=v_now where id=v_row.id;
    end if;
  else
    -- Failed/incomplete reads provide no negative evidence.
    update public.ve_contact_delivery_rows set recovery_missing_since=null where id=v_row.id;
  end if;
  update public.ve_contact_delivery_reconciliations set status=v_status,provider_lead_id=p_provider_lead_id,
    error=left(p_error,500),finished_at=v_now where id=p_token;
  if v_status in ('present','released') then
    if v_run.run_date=timezone(v_run.timezone,v_now)::date then
      -- Also resume the untouched tail of this exact failed attempt, never
      -- unrelated ready stock. A capacity pause still takes precedence.
      update public.ve_contact_delivery_rows r set status='reserved',run_id=v_run.id,attempt_id=null,
        reserved_at=v_now,attempted_at=null,finalized_at=null,last_error=null,updated_at=v_now
        where r.ve_project_id=v_row.ve_project_id and r.status='ready' and r.run_id is null
          and exists(select 1 from public.ve_contact_delivery_attempts a where a.id=v_check.attempt_id and r.id=any(a.released_row_ids))
          and exists(select 1 from public.ve_launch_queue_items qi where qi.id=r.item_id and qi.status='active');
      update public.ve_contact_delivery_daily_runs set recovery_retry_requested_at=v_now where id=v_run.id;
    end if;
    select count(*) filter(where status='accepted'),count(*) filter(where status='skipped'),count(*) filter(where status='uncertain'),
      count(*) filter(where status in ('reserved','attempting')),count(*) into v_accepted,v_skipped,v_uncertain,v_inflight,v_linked
      from public.ve_contact_delivery_rows where run_id=v_run.id;
    if v_linked>v_run.reserved_count then raise exception 'Recovery exceeds original daily reservation'; end if;
    update public.ve_contact_delivery_daily_runs set accepted_count=v_accepted,skipped_count=v_skipped,uncertain_count=v_uncertain,
      released_count=reserved_count-v_linked,status=case when v_inflight>0 then 'attempting' when v_uncertain>0 then 'uncertain' else 'completed' end,
      completed_at=case when v_inflight=0 then v_now else null end,updated_at=v_now where id=v_run.id;
    perform public.ve_refresh_contact_delivery_counters(v_row.ve_project_id,v_now);
  end if;
  return jsonb_build_object('status',v_status,'replayed',false);
end;
$$;

revoke all on function public.ve_begin_recoverable_contact_delivery(uuid,uuid,text,uuid[]) from public,anon,authenticated;
revoke all on function public.ve_renew_contact_delivery_request(uuid,uuid) from public,anon,authenticated;
revoke all on function public.ve_claim_contact_delivery_reconciliation(uuid) from public,anon,authenticated;
revoke all on function public.ve_finish_contact_delivery_reconciliation(uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.ve_begin_recoverable_contact_delivery(uuid,uuid,text,uuid[]) to service_role;
grant execute on function public.ve_renew_contact_delivery_request(uuid,uuid) to service_role;
grant execute on function public.ve_claim_contact_delivery_reconciliation(uuid) to service_role;
grant execute on function public.ve_finish_contact_delivery_reconciliation(uuid,text,boolean,text) to service_role;

create or replace function public.ve_reserve_contact_delivery_day(p_ve_project_id uuid,p_now timestamptz,p_observed_ve_first_contacted bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_period uuid; v_portal_project uuid; v_result jsonb; v_date date; v_continuous boolean;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
begin
  select portal_project_id,portal_period_id,timezone(delivery_timezone,p_now)::date into v_portal_project,v_period,v_date
    from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_portal_project,v_period));
  if exists(select 1 from public.ve_contact_supply_plans s join public.ve_launch_queue_items qi on qi.id=s.item_id
    where s.project_id=p_ve_project_id and qi.status='active' and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; delivery stopped before provider work';
  end if;
  select * into v_run from public.ve_contact_delivery_daily_runs
    where ve_project_id=p_ve_project_id and upload_blocked_at is not null order by created_at desc limit 1;
  if found then
    return jsonb_build_object('status','capacity_blocked','run_id',v_run.id,'run_date',v_run.run_date,'batches','[]'::jsonb);
  end if;
  select * into v_run from public.ve_contact_delivery_daily_runs
    where ve_project_id=p_ve_project_id and run_date=v_date and (upload_retry_requested_at is not null or recovery_retry_requested_at is not null) for update;
  if found and exists(select 1 from public.ve_contact_delivery_rows where run_id=v_run.id and status='reserved') then
    return public.ve_contact_delivery_run_response(v_run.id,'reserved',true);
  end if;
  select exists(select 1 from public.ve_contact_supply_plans where project_id=p_ve_project_id) into v_continuous;
  if v_continuous then
    delete from public.ve_contact_delivery_daily_runs r where (r.portal_period_id=v_period
      or (v_period is null and r.portal_period_id is null and r.ve_project_id=p_ve_project_id)) and r.run_date=v_date
      and r.reservation_status='no_ready_rows' and r.reserved_count=0
      and not exists(select 1 from public.ve_contact_delivery_attempts a where a.run_id=r.id)
      and not exists(select 1 from public.ve_contact_delivery_rows d where d.run_id=r.id);
  end if;
  v_result:=public.ve_reserve_contact_delivery_day_before_supply(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  return v_result;
end;
$$;
