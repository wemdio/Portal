-- A contact-storage refusal is a durable pause, not a permanent recipient skip.
-- Retry reuses exact released identities and the original daily allowance.
alter table public.ve_contact_delivery_daily_runs
  add column if not exists upload_blocked_at timestamptz,
  add column if not exists upload_retry_requested_at timestamptz,
  add column if not exists upload_retry_requested_by uuid;

create or replace function public.ve_finalize_contact_delivery_capacity(
  p_run_id uuid, p_attempt_id uuid, p_campaign_id text,
  p_accepted_row_ids uuid[], p_skipped_row_ids uuid[], p_uncertain_row_ids uuid[],
  p_released_row_ids uuid[], p_error text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_error is distinct from 'INSTANTLY_CONTACT_CAPACITY' then
    raise exception 'capacity finalization requires an explicit capacity refusal';
  end if;
  v_result := public.ve_finalize_contact_delivery_attempt(p_run_id,p_attempt_id,p_campaign_id,
    p_accepted_row_ids,p_skipped_row_ids,p_uncertain_row_ids,p_released_row_ids,p_error);
  -- Replaying a finalized attempt must not undo a later explicit resume.
  if coalesce((v_result->>'replayed')::boolean,false) = false then
    update public.ve_contact_delivery_daily_runs set
      upload_blocked_at=coalesce(upload_blocked_at,pg_catalog.now()),
      upload_retry_requested_at=null,upload_retry_requested_by=null where id=p_run_id;
  end if;
  return v_result;
end;
$$;

-- Fence stale worker snapshots too: a reserved sibling batch must not start
-- after another batch has persisted the workspace pause.
create or replace function public.ve_mark_contact_delivery_attempt(p_run_id uuid,p_attempt_id uuid,p_campaign_id text,p_row_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_blocked timestamptz;
begin
  select upload_blocked_at into v_blocked from public.ve_contact_delivery_daily_runs where id=p_run_id for update;
  if v_blocked is not null then return jsonb_build_object('marked',false,'capacity_blocked',true); end if;
  if exists(select 1 from public.ve_contact_delivery_rows r join public.ve_contact_supply_plans s on s.item_id=r.item_id
    where r.id=any(p_row_ids) and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; provider attempt blocked';
  end if;
  return public.ve_mark_contact_delivery_attempt_before_supply(p_run_id,p_attempt_id,p_campaign_id,p_row_ids);
end;
$$;

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
    where ve_project_id=p_ve_project_id and run_date=v_date and upload_retry_requested_at is not null for update;
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

create or replace function public.ve_retry_contact_delivery_upload(
  p_ve_project_id uuid,p_run_id uuid,p_blocked_at timestamptz,p_actor_id uuid,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_project public.ve_projects%rowtype; v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_rows uuid[]; v_linked integer; v_pending integer; v_today date;
begin
  if p_actor_id is null or p_blocked_at is null or p_now is null then raise exception 'explicit retry identity is required'; end if;
  select * into v_project from public.ve_projects where id=p_ve_project_id;
  if not found then raise exception 'VE2 project not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_project.portal_project_id,v_project.portal_period_id));
  select * into v_run from public.ve_contact_delivery_daily_runs where id=p_run_id and ve_project_id=p_ve_project_id for update;
  if not found then raise exception 'Загрузка проекта не найдена'; end if;
  if v_run.upload_blocked_at is null then return jsonb_build_object('ok',true,'replayed',true); end if;
  if v_run.upload_blocked_at is distinct from p_blocked_at then raise exception 'Состояние загрузки изменилось. Обновите страницу.'; end if;
  v_today:=timezone(v_project.delivery_timezone,p_now)::date;
  if not exists(select 1 from public.ve_contact_delivery_term(v_project.portal_project_id,v_project.portal_period_id,p_ve_project_id)
    where status='active' and deadline>=v_today) then raise exception 'Срок проекта завершён. Дозаливка недоступна.'; end if;
  if exists(select 1 from public.ve_contact_supply_plans s join public.ve_launch_queue_items qi on qi.id=s.item_id
    where s.project_id=p_ve_project_id and qi.status='active' and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'Согласование контактов устарело. Дозаливка недоступна.';
  end if;
  if exists(select 1 from public.ve_contact_delivery_rows where run_id=p_run_id and status='attempting')
    or exists(select 1 from public.ve_contact_delivery_attempts where run_id=p_run_id and status='attempting') then
    raise exception 'Предыдущая загрузка ещё сохраняет результат. Повторите позже.';
  end if;
  if v_run.run_date=v_today then
    -- Only exact released rows of this day's original reservation may return.
    -- Accepted, skipped and uncertain rows are never reset or uploaded again.
    select coalesce(array_agg(r.id),'{}'::uuid[]) into v_rows from public.ve_contact_delivery_rows r
      join public.ve_launch_queue_items qi on qi.id=r.item_id
      where r.ve_project_id=p_ve_project_id and r.status='ready' and r.run_id is null and qi.status='active'
        and exists(select 1 from public.ve_contact_delivery_attempts a
          where a.run_id=p_run_id and a.status='finalized' and r.id=any(a.released_row_ids));
    select count(*) into v_linked from public.ve_contact_delivery_rows where run_id=p_run_id;
    if cardinality(v_rows)+v_linked>v_run.reserved_count then raise exception 'Retry exceeds original daily reservation'; end if;
    update public.ve_contact_delivery_rows set status='reserved',run_id=p_run_id,attempt_id=null,
      reserved_at=p_now,attempted_at=null,finalized_at=null,last_error=null,updated_at=p_now
      where id=any(v_rows) and status='ready' and run_id is null;
    select count(*) into v_pending from public.ve_contact_delivery_rows where run_id=p_run_id and status='reserved';
    update public.ve_contact_delivery_daily_runs set
      status=case when v_pending>0 then 'reserved' else status end,
      released_count=reserved_count-v_linked-cardinality(v_rows),
      completed_at=case when v_pending>0 then null else completed_at end
      where id=p_run_id;
  end if;
  -- On a later day the ordinary planner creates a fresh quota. Old accepted
  -- contacts continue counting against the contractual obligation.
  update public.ve_contact_delivery_daily_runs set upload_blocked_at=null,
    upload_retry_requested_at=p_now,upload_retry_requested_by=p_actor_id,updated_at=p_now where id=p_run_id;
  perform public.ve_refresh_contact_delivery_counters(p_ve_project_id,p_now);
  return jsonb_build_object('ok',true,'replayed',false,'ready',coalesce(cardinality(v_rows),0));
end;
$$;

revoke all on function public.ve_finalize_contact_delivery_capacity(uuid,uuid,text,uuid[],uuid[],uuid[],uuid[],text) from public,anon,authenticated;
grant execute on function public.ve_finalize_contact_delivery_capacity(uuid,uuid,text,uuid[],uuid[],uuid[],uuid[],text) to service_role;
revoke all on function public.ve_retry_contact_delivery_upload(uuid,uuid,timestamptz,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_retry_contact_delivery_upload(uuid,uuid,timestamptz,uuid,timestamptz) to service_role;
