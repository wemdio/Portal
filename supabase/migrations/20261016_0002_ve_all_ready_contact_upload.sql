-- Uploading checked inventory is separate from sending. Opt-in only: existing
-- projects retain their daily upload policy, sender capacity and supply budget.
alter table public.ve_projects
  add column contact_upload_mode text not null default 'daily'
  check (contact_upload_mode in ('daily','all_ready')),
  add column contact_upload_mode_updated_at timestamptz,
  add column contact_upload_mode_updated_by uuid;
alter table public.ve_contact_delivery_daily_runs
  add column contact_upload_mode text not null default 'daily'
  check (contact_upload_mode in ('daily','all_ready'));

-- Keep the original daily quota snapshots. An all-ready reservation may exceed
-- those two quota fields, but all row/accounting/headroom constraints still apply.
do $migration$
declare v_constraint record; v_count integer:=0;
begin
  for v_constraint in select conname,pg_get_constraintdef(oid) definition from pg_constraint
    where conrelid='public.ve_contact_delivery_daily_runs'::regclass and contype='c'
  loop
    if v_constraint.definition in ('CHECK ((effective_count <= required_daily))',
      'CHECK ((effective_count <= sender_daily_capacity))') then
      execute format('alter table public.ve_contact_delivery_daily_runs drop constraint %I',v_constraint.conname);
      v_count:=v_count+1;
    end if;
  end loop;
  if v_count<>2 then raise exception 'Unexpected VE2 daily quota constraints'; end if;
end;
$migration$;
alter table public.ve_contact_delivery_daily_runs
  add constraint ve_delivery_daily_required_limit check(contact_upload_mode='all_ready' or effective_count<=required_daily),
  add constraint ve_delivery_daily_sender_limit check(contact_upload_mode='all_ready' or effective_count<=sender_daily_capacity);

-- Called only by the authenticated internal API under service_role. The actor
-- is recorded; a stale tab cannot silently replace a newer explicit choice.
create function public.ve_set_contact_upload_mode(
  p_project_id uuid,p_mode text,p_expected_mode text,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_project public.ve_projects%rowtype;
begin
  if p_actor_id is null or p_mode is null or p_mode not in ('daily','all_ready')
    or p_expected_mode is null or p_expected_mode not in ('daily','all_ready') then
    raise exception 'Некорректный режим загрузки';
  end if;
  select * into v_project from public.ve_projects where id=p_project_id;
  if not found then raise exception 'Проект не найден'; end if;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_project.portal_project_id,v_project.portal_period_id));
  select * into strict v_project from public.ve_projects where id=p_project_id for update;
  if v_project.contact_upload_mode=p_mode then return jsonb_build_object('mode',p_mode); end if;
  if v_project.contact_upload_mode is distinct from p_expected_mode then
    raise exception 'Режим загрузки изменён в другой вкладке. Обновите страницу';
  end if;
  if exists(select 1 from public.ve_contact_delivery_rates where project_id=p_project_id and lease_until>clock_timestamp()) then
    raise exception 'Воркер применяет темп. Повторите через минуту';
  end if;
  update public.ve_projects set contact_upload_mode=p_mode,contact_upload_mode_updated_at=clock_timestamp(),
    contact_upload_mode_updated_by=p_actor_id,updated_at=clock_timestamp() where id=p_project_id;
  -- Before the first launch, the verified sender forecast stays valid and
  -- there is no campaign to PATCH yet. Invalidating it would deadlock launch
  -- preflight because only existing campaigns can refresh the rate.
  update public.ve_contact_delivery_rates set status='pending',checked_at=null,updated_at=clock_timestamp()
    where project_id=p_project_id and v_project.portal_project_id is not null;
  return jsonb_build_object('mode',p_mode);
end;
$$;
alter function public.ve_set_contact_upload_mode(uuid,text,text,uuid) owner to postgres;
revoke all on function public.ve_set_contact_upload_mode(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.ve_set_contact_upload_mode(uuid,text,text,uuid) to service_role,postgres;

-- A never-started draft can hold all checked rows for the specialist's review.
-- A campaign explicitly paused AFTER activation still cannot receive new rows.
-- Fresh provider observation remains mandatory before every provider attempt.
create or replace function public.ve_manual_campaign_delivery_allowed(p_campaign_row_id uuid,p_now timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select c.status_observed_at>=p_now-interval '5 minutes'
    and c.status_observed_at<=p_now+interval '1 minute'
    and (c.remote_status in (1,3,4) or (c.remote_status in (0,2) and c.activated_at is null
      and (p.contact_upload_mode='all_ready' or exists(
        select 1 from public.ve_contact_delivery_rows r join public.ve_contact_delivery_daily_runs dr on dr.id=r.run_id
        where r.campaign_row_id=c.id and r.status='reserved' and dr.contact_upload_mode='all_ready')
        or (c.leads_count=0 and not exists(
        select 1 from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id
          and r.status in ('accepted','attempting','uncertain'))))))
    from public.ve_launch_queue_campaigns c
    join public.ve_launch_queue_items qi on qi.id=c.item_id
    join public.ve_projects p on p.id=qi.project_id
    where c.id=p_campaign_row_id),false);
$$;
alter function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) owner to postgres;
revoke all on function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) to postgres;

create function public.ve_reserve_all_ready_contact_delivery_day(
  p_ve_project_id uuid,p_now timestamptz,p_observed_ve_first_contacted bigint default 0
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_project public.ve_projects%rowtype;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_period public.project_periods%rowtype;
  v_date date;
  v_actual bigint;
  v_remaining integer;
  v_committed integer;
  v_outstanding integer;
  v_headroom integer;
  v_reserved integer;
  v_take integer;
  v_total integer;
  v_ids uuid[];
  v_response jsonb;
  v_batches jsonb;
  v_status text;
begin
  if p_ve_project_id is null or p_now is null or p_observed_ve_first_contacted is null or p_observed_ve_first_contacted<0 then
    raise exception 'exact project, day and first-contacted fact required';
  end if;
  select * into v_project from public.ve_projects where id=p_ve_project_id;
  if not found then raise exception 'VE2 project not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_project.portal_project_id,v_project.portal_period_id));
  select * into strict v_project from public.ve_projects where id=p_ve_project_id for update;
  if v_project.contact_upload_mode<>'all_ready' then raise exception 'all-ready upload mode is not enabled'; end if;
  if v_project.portal_project_id is null or v_project.target_contacts is null
    or v_project.delivery_timezone is null or v_project.delivery_schedule_days is null
    or v_project.sender_daily_capacity is null then raise exception 'VE2 delivery plan is not explicitly bound'; end if;
  v_date:=timezone(v_project.delivery_timezone,p_now)::date;
  if exists(select 1 from public.ve_contact_supply_plans s join public.ve_launch_queue_items qi on qi.id=s.item_id
    where s.project_id=p_ve_project_id and qi.status='active' and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; delivery stopped before provider work';
  end if;
  select * into v_run from public.ve_contact_delivery_daily_runs
    where ve_project_id=p_ve_project_id and upload_blocked_at is not null order by created_at desc limit 1;
  if found then
    return jsonb_build_object('status','capacity_blocked','run_id',v_run.id,'run_date',v_run.run_date,'batches','[]'::jsonb);
  end if;
  if v_project.portal_period_id is not null then
    select * into v_period from public.project_periods
      where id=v_project.portal_period_id and project_id=v_project.portal_project_id and status='active' for share;
    if not found then raise exception 'bound Portal project period is not active'; end if;
  else
    select t.deadline into v_period.deadline
      from public.ve_contact_delivery_term(v_project.portal_project_id,null,p_ve_project_id) t where t.status='active';
    if not found then raise exception 'bound Portal project without periods is not launchable'; end if;
    v_period.contacts_done:=p_observed_ve_first_contacted::text;
  end if;
  if v_period.deadline is null or v_period.contacts_done is null
    or btrim(v_period.contacts_done)!~'^[0-9]+$'
    or btrim(v_period.contacts_done)::numeric>9223372036854775807::numeric then
    raise exception 'bound Portal term has no exact deadline/contact fact';
  end if;
  v_actual:=btrim(v_period.contacts_done)::bigint;
  v_remaining:=greatest(0::bigint,v_project.target_contacts::bigint-v_actual)::integer;

  -- Same midnight cleanup as daily upload: only unattempted reservations are
  -- safe to release. Provider requests and unknown results remain fenced.
  perform 1 from public.ve_contact_delivery_daily_runs where ve_project_id=p_ve_project_id
    and run_date<v_date and reservation_status='reserved' order by run_date,id for update;
  update public.ve_contact_delivery_rows r set status='ready',run_id=null,attempt_id=null,last_error=null,
    reserved_at=null,attempted_at=null,finalized_at=null,updated_at=p_now
    from public.ve_contact_delivery_daily_runs old_run where old_run.id=r.run_id
      and old_run.ve_project_id=p_ve_project_id and old_run.run_date<v_date and r.status='reserved';
  update public.ve_contact_delivery_daily_runs old_run set
    accepted_count=(select count(*) from public.ve_contact_delivery_rows r where r.run_id=old_run.id and r.status='accepted'),
    skipped_count=(select count(*) from public.ve_contact_delivery_rows r where r.run_id=old_run.id and r.status='skipped'),
    uncertain_count=(select count(*) from public.ve_contact_delivery_rows r where r.run_id=old_run.id and r.status='uncertain'),
    released_count=old_run.reserved_count-(select count(*) from public.ve_contact_delivery_rows r where r.run_id=old_run.id),
    status=case when exists(select 1 from public.ve_contact_delivery_rows r where r.run_id=old_run.id and r.status in ('attempting','uncertain'))
      then 'uncertain' else 'completed' end,
    completed_at=coalesce(old_run.completed_at,p_now),updated_at=p_now
    where old_run.ve_project_id=p_ve_project_id and old_run.run_date<v_date
      and old_run.reservation_status='reserved' and old_run.status in ('reserved','attempting');

  select least(count(*),2147483647)::integer into v_committed from public.ve_contact_delivery_rows
    where ve_project_id=p_ve_project_id and status in ('accepted','attempting','uncertain');
  v_outstanding:=greatest(0::bigint,v_committed::bigint-least(p_observed_ve_first_contacted,v_actual))::integer;
  v_headroom:=greatest(0,v_remaining-v_outstanding);
  select * into v_run from public.ve_contact_delivery_daily_runs
    where ve_project_id=p_ve_project_id and run_date=v_date for update;
  if found then
    if exists(select 1 from public.ve_contact_delivery_rows where run_id=v_run.id and status in ('attempting','uncertain'))
      or exists(select 1 from public.ve_contact_delivery_attempts where run_id=v_run.id and status='attempting') then
      return public.ve_contact_delivery_run_response(v_run.id,'replayed',false);
    end if;
    if exists(select 1 from public.ve_contact_delivery_rows where run_id=v_run.id and status='reserved') then
      v_response:=public.ve_contact_delivery_run_response(v_run.id,'reserved',true);
      select coalesce(jsonb_agg(b),'[]'::jsonb) into v_batches from jsonb_array_elements(v_response->'batches') b
        where exists(select 1 from public.ve_launch_queue_campaigns c join public.ve_launch_queue_items qi on qi.id=c.item_id
          where c.campaign_id=b->>'campaign_id' and qi.project_id=p_ve_project_id and qi.status='active'
            and public.ve_manual_campaign_delivery_allowed(c.id,p_now));
      if v_remaining=0 then return public.ve_contact_delivery_run_response(v_run.id,'replayed',false); end if;
      if jsonb_array_length(v_batches)>0 then return jsonb_set(v_response,'{batches}',v_batches); end if;
      -- A paused campaign's unattempted rows still consume headroom, but do not
      -- prevent filling a different eligible campaign with the remaining room.
    end if;
  end if;
  select least(count(*),2147483647)::integer into v_reserved from public.ve_contact_delivery_rows
    where ve_project_id=p_ve_project_id and status='reserved';
  -- A transport tranche, not a daily allowance: subsequent worker sweeps can
  -- claim the next tranche immediately after finalization. Keep RPC payloads bounded.
  v_take:=least(5000,greatest(0,v_headroom-v_reserved));
  select coalesce(array_agg(selected.id order by selected.fair_progress,selected.id),'{}'::uuid[]) into v_ids
    from (
      select r.id,(r.drip_order::numeric+1)/greatest(coalesce(qi.potential_pct,0),1) as fair_progress
      from public.ve_contact_delivery_rows r join public.ve_launch_queue_items qi on qi.id=r.item_id
      where qi.project_id=p_ve_project_id and qi.status='active' and r.status='ready' and r.run_id is null
        and public.ve_manual_campaign_delivery_allowed(r.campaign_row_id,p_now)
        and not exists(select 1 from public.ve_contact_delivery_attempts a where a.run_id=v_run.id and r.id=any(a.row_ids))
      order by fair_progress,qi.created_at,qi.id,r.id limit v_take for update of r skip locked
    ) selected;
  v_take:=cardinality(v_ids);
  v_status:=case when v_take>0 then 'reserved' when v_remaining=0 then 'fulfilled'
    when v_headroom=0 then 'awaiting_delivery' else 'no_ready_rows' end;
  if v_run.id is null then
    insert into public.ve_contact_delivery_daily_runs(
      ve_project_id,portal_project_id,portal_period_id,run_date,reservation_status,status,target_contacts,
      actual_first_contacted,observed_ve_first_contacted,committed_count,outstanding_count,upload_headroom,
      deadline,schedule_days,timezone,sender_daily_capacity,remaining_contacts,remaining_workdays,required_daily,
      ready_remaining,effective_count,reserved_count,reserved_at,completed_at,created_at,updated_at,contact_upload_mode
    ) values (
      p_ve_project_id,v_project.portal_project_id,v_project.portal_period_id,v_date,v_status,
      case when v_take>0 then 'reserved' else 'completed' end,v_project.target_contacts,
      v_actual,p_observed_ve_first_contacted,v_committed,v_outstanding,v_headroom,
      v_period.deadline,v_project.delivery_schedule_days,v_project.delivery_timezone,v_project.sender_daily_capacity,
      v_remaining,0,0,v_take,v_take,v_take,case when v_take>0 then p_now end,
      case when v_take=0 then p_now end,p_now,p_now,'all_ready'
    ) returning * into v_run;
  elsif v_take=0 then
    return public.ve_contact_delivery_run_response(v_run.id,'replayed',false);
  else
    v_total:=v_run.reserved_count+v_take;
    update public.ve_contact_delivery_daily_runs set contact_upload_mode='all_ready',
      reservation_status='reserved',status='reserved',effective_count=v_total,reserved_count=v_total,
      ready_remaining=greatest(ready_remaining,v_total),upload_headroom=greatest(upload_headroom,v_total),
      actual_first_contacted=v_actual,observed_ve_first_contacted=p_observed_ve_first_contacted,
      committed_count=v_committed,outstanding_count=v_outstanding,remaining_contacts=v_remaining,
      reserved_at=coalesce(reserved_at,p_now),completed_at=null,updated_at=p_now where id=v_run.id;
  end if;
  if v_take>0 then
    update public.ve_contact_delivery_rows set status='reserved',run_id=v_run.id,reserved_at=p_now,updated_at=p_now
      where id=any(v_ids) and status='ready' and run_id is null;
    get diagnostics v_total=row_count;
    if v_total<>v_take then raise exception 'all-ready reservation did not claim the exact fresh rows'; end if;
  end if;
  perform public.ve_refresh_contact_delivery_counters(p_ve_project_id,p_now);
  v_response:=public.ve_contact_delivery_run_response(v_run.id,v_status,v_take>0);
  -- An earlier reservation can belong to a campaign paused since its creation.
  -- Keep it accounted for, but never put it before a newly eligible sibling in
  -- the provider batch loop. The final attempt fence checks eligibility again.
  select coalesce(jsonb_agg(b),'[]'::jsonb) into v_batches from jsonb_array_elements(v_response->'batches') b
    where exists(select 1 from public.ve_launch_queue_campaigns c join public.ve_launch_queue_items qi on qi.id=c.item_id
      where c.campaign_id=b->>'campaign_id' and qi.project_id=p_ve_project_id and qi.status='active'
        and public.ve_manual_campaign_delivery_allowed(c.id,p_now));
  return jsonb_set(v_response,'{batches}',v_batches);
end;
$$;
alter function public.ve_reserve_all_ready_contact_delivery_day(uuid,timestamptz,bigint) owner to postgres;
revoke all on function public.ve_reserve_all_ready_contact_delivery_day(uuid,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.ve_reserve_all_ready_contact_delivery_day(uuid,timestamptz,bigint) to service_role,postgres;
