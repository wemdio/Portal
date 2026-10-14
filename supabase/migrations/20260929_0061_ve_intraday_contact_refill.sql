-- Fill a partially supplied day when another checked batch becomes ready.
-- Keep one durable day/run and its original quota; never reset provider attempts.
-- Already allocated rows (including uncertain/released/skipped outcomes) consume
-- that quota conservatively. Explicit recovery/retry still owns those identities.
create or replace function public.ve_top_up_contact_delivery_day(
  p_ve_project_id uuid, p_now timestamptz, p_observed_ve_first_contacted bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_project public.ve_projects%rowtype;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_period public.project_periods%rowtype;
  v_actual bigint;
  v_remaining integer;
  v_committed integer;
  v_outstanding integer;
  v_headroom integer;
  v_available integer;
  v_take integer;
  v_total integer;
  v_ids uuid[];
  v_response jsonb;
  v_batches jsonb;
begin
  if p_now is null or p_observed_ve_first_contacted is null or p_observed_ve_first_contacted < 0 then
    raise exception 'exact day and first-contacted fact required';
  end if;
  -- The public reservation wrapper already holds the project/day advisory lock
  -- and checks rate freshness, workspace capacity and current approval.
  select * into strict v_project from public.ve_projects where id=p_ve_project_id;
  select * into strict v_run from public.ve_contact_delivery_daily_runs
    where ve_project_id=p_ve_project_id and run_date=timezone(v_project.delivery_timezone,p_now)::date for update;
  if v_run.reservation_status not in ('reserved','awaiting_delivery')
    or extract(dow from v_run.run_date)::smallint <> all(v_project.delivery_schedule_days)
    or v_run.upload_blocked_at is not null
    or exists(select 1 from public.ve_contact_delivery_rows where run_id=v_run.id and status='attempting')
    or exists(select 1 from public.ve_contact_delivery_attempts where run_id=v_run.id and status='attempting') then
    return public.ve_contact_delivery_run_response(v_run.id,'replayed',false);
  end if;

  -- A new tranche must pass the live term/target check, even though the old
  -- run itself is a valid historical record after closing a project or period.
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
    or btrim(v_period.contacts_done) !~ '^[0-9]+$'
    or btrim(v_period.contacts_done)::numeric > 9223372036854775807::numeric then
    raise exception 'bound Portal term has no exact deadline/contact fact';
  end if;
  v_actual:=btrim(v_period.contacts_done)::bigint;
  v_remaining:=greatest(0::bigint,v_project.target_contacts::bigint-v_actual)::integer;
  select least(count(*),2147483647)::integer into v_committed from public.ve_contact_delivery_rows
    where ve_project_id=p_ve_project_id and status in ('accepted','attempting','uncertain');
  v_outstanding:=greatest(0::bigint,v_committed::bigint-least(p_observed_ve_first_contacted,v_actual))::integer;
  v_headroom:=greatest(0,v_remaining-v_outstanding);
  -- A committed reservation whose reply was lost must be returned again,
  -- even if an earlier tranche already has finalized attempts in this day.
  -- Only the row/attempt fence authorizes an actual provider request.
  if exists(select 1 from public.ve_contact_delivery_rows where run_id=v_run.id and status='reserved') then
    v_response:=public.ve_contact_delivery_run_response(v_run.id,'reserved',true);
    select coalesce(jsonb_agg(b),'[]'::jsonb) into v_batches
      from jsonb_array_elements(v_response->'batches') b
      where exists(select 1 from public.ve_launch_queue_campaigns c join public.ve_launch_queue_items qi on qi.id=c.item_id
        where c.campaign_id=b->>'campaign_id' and qi.project_id=p_ve_project_id and qi.status='active'
          and public.ve_manual_campaign_delivery_allowed(c.id,p_now));
    if v_remaining=0 or jsonb_array_length(v_batches)=0 then
      return public.ve_contact_delivery_run_response(v_run.id,'replayed',false);
    end if;
    return jsonb_set(v_response,'{batches}',v_batches);
  end if;
  -- A higher/new policy never grants a second daily quota. A lower policy
  -- immediately limits the unallocated remainder, including other hypotheses.
  v_available:=greatest(0,least(v_run.required_daily,v_run.sender_daily_capacity,v_project.sender_daily_capacity)-v_run.reserved_count);
  v_take:=least(v_available,v_headroom);
  if v_take=0 then return public.ve_contact_delivery_run_response(v_run.id,'replayed',false); end if;

  select coalesce(array_agg(selected.id order by selected.fair_progress,selected.id),'{}'::uuid[]) into v_ids
    from (
      select r.id,(r.drip_order::numeric+1)/greatest(coalesce(qi.potential_pct,0),1) as fair_progress
        from public.ve_contact_delivery_rows r join public.ve_launch_queue_items qi on qi.id=r.item_id
       where qi.project_id=p_ve_project_id and qi.status='active' and r.status='ready' and r.run_id is null
         and public.ve_manual_campaign_delivery_allowed(r.campaign_row_id,p_now)
         -- A released/negatively reconciled original request is not a new row.
         -- Only its explicit retry/recovery path may return it to this day.
         and not exists(select 1 from public.ve_contact_delivery_attempts a where a.run_id=v_run.id and r.id=any(a.row_ids))
       order by fair_progress,qi.created_at,qi.id,r.id limit v_take for update of r skip locked
    ) selected;
  v_take:=cardinality(v_ids);
  if v_take=0 then return public.ve_contact_delivery_run_response(v_run.id,'replayed',false); end if;
  v_total:=v_run.reserved_count+v_take;
  update public.ve_contact_delivery_daily_runs set
    reservation_status='reserved',status='reserved',effective_count=v_total,reserved_count=v_total,
    -- These constrained snapshot fields also cover the newly evidenced supply;
    -- quota fields stay frozen. Live preview reads ready rows independently.
    ready_remaining=greatest(ready_remaining,v_total),upload_headroom=greatest(upload_headroom,v_total),
    actual_first_contacted=v_actual,observed_ve_first_contacted=p_observed_ve_first_contacted,
    committed_count=v_committed,outstanding_count=v_outstanding,remaining_contacts=v_remaining,
    reserved_at=coalesce(reserved_at,p_now),completed_at=null,updated_at=p_now
    where id=v_run.id;
  update public.ve_contact_delivery_rows set status='reserved',run_id=v_run.id,reserved_at=p_now,updated_at=p_now
    where id=any(v_ids) and status='ready' and run_id is null;
  get diagnostics v_total=row_count;
  if v_total<>v_take then raise exception 'intraday reservation did not claim the exact fresh rows'; end if;
  perform public.ve_refresh_contact_delivery_counters(p_ve_project_id,p_now);
  return public.ve_contact_delivery_run_response(v_run.id,'reserved',true);
end;
$$;
alter function public.ve_top_up_contact_delivery_day(uuid,timestamptz,bigint) owner to postgres;
revoke all on function public.ve_top_up_contact_delivery_day(uuid,timestamptz,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ve_top_up_contact_delivery_day(uuid,timestamptz,bigint) to postgres;

-- Preserve the installed wrapper's rate/approval/capacity/recovery fences.
-- Never reopen an in-flight request and never delete a day with upload history.
do $migration$
declare v_def text; v_before text; v_after text;
begin
  v_def:=pg_catalog.pg_get_functiondef('public.ve_reserve_contact_delivery_day(uuid,timestamptz,bigint)'::regprocedure);
  if position('-- VE2 intraday refill 20260929' in v_def)>0 then return; end if;
  v_before:=$old$  v_result:=public.ve_reserve_contact_delivery_day_before_supply(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  return v_result;$old$;
  v_after:=$new$  v_result:=public.ve_reserve_contact_delivery_day_before_supply(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  -- VE2 intraday refill 20260929
  if v_result->>'status'='replayed' then
    return public.ve_top_up_contact_delivery_day(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  end if;
  return v_result;$new$;
  if (length(v_def)-length(replace(v_def,v_before,'')))/length(v_before)<>1 then
    raise exception 'Unexpected VE2 reservation wrapper definition';
  end if;
  execute replace(v_def,v_before,v_after);
end;
$migration$;
