-- Internal VE2 only. Specialists start/pause campaigns in Instantly.
-- `active` in the historical queue now authorizes contact delivery, NOT sending.
-- No migration backfill activates or uploads anything. The worker verifies live
-- identity and a fully committed preparation before enrolling an existing draft.

create or replace function public.ve_observe_manual_campaigns(
  p_item_id uuid, p_campaigns jsonb, p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_observation record;
  v_ids text[] := '{}';
  v_count integer;
begin
  if p_now is null or p_campaigns is null or jsonb_typeof(p_campaigns)<>'array'
     or jsonb_array_length(p_campaigns)=0 then raise exception 'exact campaign observations required'; end if;
  select * into v_item from public.ve_launch_queue_items where id=p_item_id for update;
  if not found then raise exception 'prepared launch not found'; end if;
  if v_item.status not in ('prepared','queued','active','uncertain') then
    raise exception 'cancelled, released or in-flight launch cannot be enrolled';
  end if;
  if not exists (
    select 1 from public.ve_templates t
    join public.ve_segmentation_audits a on a.id=(t.launch_info->>'segmentation_audit_id')::uuid
    join public.ve_projects p on p.id=v_item.project_id
    where t.id=v_item.template_id and a.template_id=t.id and a.project_id=p.id
      and a.launch_status='succeeded' and t.status='ready'
      and coalesce((t.launch_info->>'reconciliation_required')::boolean,false)=false
      and t.launch_info->>'preset_id'=v_item.preset_id
      and t.launch_info->>'instantly_account_id'=v_item.instantly_account_id
      and t.launch_info->>'portal_project_id'=p.portal_project_id::text
      and (t.launch_info->>'portal_period_id')::uuid is not distinct from p.portal_period_id
      and (t.launch_info->>'target_contacts')::integer=p.target_contacts
      and p.delivery_plan_bound_at is not null and p.delivery_plan_bound_by is not null
      and p.launch_preset_id::text=v_item.preset_id
      and p.launch_instantly_account_id=v_item.instantly_account_id
  ) then raise exception 'campaign preparation or bound delivery plan is not confirmed'; end if;
  if exists (select 1 from public.ve_contact_supply_plans s where s.item_id=p_item_id
    and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale';
  end if;
  for v_observation in select * from jsonb_to_recordset(p_campaigns)
    as x(campaign_id text,status integer,status_observed_at timestamptz)
  loop
    if v_observation.campaign_id is null or v_observation.status is null
      or v_observation.status not in (-99,-2,-1,0,1,2,3,4)
      or v_observation.status_observed_at is null
      or v_observation.status_observed_at < p_now-interval '5 minutes'
      or v_observation.status_observed_at > p_now+interval '1 minute'
      or v_observation.campaign_id=any(v_ids) then raise exception 'invalid or stale campaign observation'; end if;
    v_ids:=array_append(v_ids,v_observation.campaign_id);
    update public.ve_launch_queue_campaigns c set
      remote_status=v_observation.status, status_observed_at=v_observation.status_observed_at,
      activated_at=case when v_observation.status in (1,3,4)
        then coalesce(c.activated_at,v_observation.status_observed_at) else c.activated_at end,
      completed_at=case when v_observation.status=3
        then coalesce(c.completed_at,v_observation.status_observed_at) else c.completed_at end,
      updated_at=p_now
    where c.item_id=p_item_id and c.campaign_id=v_observation.campaign_id
      and (c.status_observed_at is null or c.status_observed_at<=v_observation.status_observed_at);
    if not found then raise exception 'campaign identity changed or observation is older than stored state'; end if;
  end loop;
  select count(*) into v_count from public.ve_launch_queue_campaigns where item_id=p_item_id;
  if v_count<>cardinality(v_ids) then raise exception 'observations must include every campaign'; end if;
  update public.ve_launch_queue_items set status='active', activation_error=null,
    ever_active_at=case when exists(select 1 from public.ve_launch_queue_campaigns
      where item_id=p_item_id and remote_status in (1,3,4)) then coalesce(ever_active_at,p_now) else ever_active_at end,
    updated_at=p_now where id=p_item_id;
  return jsonb_build_object('observed',true);
end;
$$;
alter function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) owner to postgres;
revoke all on function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) to service_role,postgres;

-- One review tranche for a never-started draft/paused campaign, then wait for
-- manual Start. Already-started paused/error campaigns never receive more rows.
-- Completed campaigns may receive the next tranche, without a Portal Start call.
create or replace function public.ve_manual_campaign_delivery_allowed(p_campaign_row_id uuid,p_now timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.status_observed_at>=p_now-interval '5 minutes'
    and c.status_observed_at<=p_now+interval '1 minute'
    and (c.remote_status in (1,3,4) or (c.remote_status in (0,2) and c.activated_at is null
      and c.leads_count=0 and not exists(select 1 from public.ve_contact_delivery_rows r
        where r.campaign_row_id=c.id and r.status in ('accepted','attempting','uncertain'))))
    from public.ve_launch_queue_campaigns c where c.id=p_campaign_row_id),false);
$$;
alter function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) owner to postgres;
revoke all on function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ve_manual_campaign_delivery_allowed(uuid,timestamptz) to postgres;

-- Retain all daily quota, idempotency, ownership and uncertain-upload fences.
create or replace function public.ve_reserve_contact_delivery_day_before_supply(
  p_ve_project_id uuid,
  p_now timestamptz,
  p_observed_ve_first_contacted bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.ve_projects%rowtype;
  v_period public.project_periods%rowtype;
  v_existing public.ve_contact_delivery_daily_runs%rowtype;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_local_date date;
  v_actual bigint;
  v_committed integer;
  v_outstanding integer;
  v_upload_headroom integer;
  v_remaining integer;
  v_workdays integer;
  v_required integer;
  v_ready integer;
  v_effective integer;
  v_reservation_status text;
  v_selected_ids uuid[];
  v_reserved_rows integer;
begin
  if p_ve_project_id is null or p_now is null then
    raise exception 'VE project and timestamp are required';
  end if;
  if p_observed_ve_first_contacted is null or p_observed_ve_first_contacted < 0 then
    raise exception 'observed VE first-contacted count must be an exact non-negative integer';
  end if;

  select p.*
    into v_project
    from public.ve_projects p
   where p.id = p_ve_project_id
   for share;
  if not found then
    raise exception 'VE2 project not found';
  end if;
  if v_project.portal_project_id is null
     or v_project.target_contacts is null
     or v_project.delivery_schedule_days is null
     or v_project.delivery_timezone is null
     or v_project.sender_daily_capacity is null then
    raise exception 'VE2 delivery plan is not explicitly bound';
  end if;

  v_local_date := timezone(v_project.delivery_timezone, p_now)::date;
  perform pg_catalog.pg_advisory_xact_lock(
    public.ve_contact_delivery_lock_key(v_project.portal_project_id, v_project.portal_period_id)
  );

  select r.*
    into v_existing
    from public.ve_contact_delivery_daily_runs r
   where (r.portal_period_id = v_project.portal_period_id
          or (v_project.portal_period_id is null
              and r.portal_period_id is null
              and r.ve_project_id = p_ve_project_id))
     and r.run_date = v_local_date
   for update;
  if found then
    if v_existing.reservation_status = 'reserved'
       and v_existing.status = 'reserved'
       and not exists (
         select 1
           from public.ve_contact_delivery_attempts a
          where a.run_id = v_existing.id
       ) then
      select count(*)::integer
        into v_reserved_rows
        from public.ve_contact_delivery_rows row_value
       where row_value.run_id = v_existing.id
         and row_value.status = 'reserved';
      if v_reserved_rows <> v_existing.reserved_count then
        raise exception 'pre-attempt delivery reservation no longer matches its durable rows';
      end if;
      return public.ve_contact_delivery_run_response(v_existing.id, 'reserved', true);
    end if;
    return public.ve_contact_delivery_run_response(v_existing.id, 'replayed', false);
  end if;

  if v_project.portal_period_id is not null then
    select pp.*
      into v_period
      from public.project_periods pp
     where pp.id = v_project.portal_period_id
       and pp.project_id = v_project.portal_project_id
       and pp.status = 'active'
     for share;
    if not found then
      raise exception 'bound Portal project period is not active';
    end if;
  else
    -- Без периода факт плана — первые контакты кампаний этого VE2-проекта.
    select t.deadline
      into v_period.deadline
      from public.ve_contact_delivery_term(v_project.portal_project_id, null, p_ve_project_id) t
     where t.status = 'active';
    if not found then
      raise exception 'bound Portal project without periods is not launchable';
    end if;
    v_period.contacts_done := p_observed_ve_first_contacted::text;
  end if;
  if v_period.deadline is null then
    raise exception 'bound Portal project period has no deadline';
  end if;
  if v_period.contacts_done is null
     or btrim(v_period.contacts_done) !~ '^[0-9]+$'
     or btrim(v_period.contacts_done)::numeric > 9223372036854775807::numeric then
    raise exception 'bound Portal project period has no exact numeric contacts_done fact';
  end if;
  v_actual := btrim(v_period.contacts_done)::bigint;
  v_remaining := greatest(0::bigint, v_project.target_contacts::bigint - v_actual)::integer;

  -- Unattempted rows from an older local day are provably safe to release.
  -- Attempting rows remain fenced and make the old run uncertain.
  -- Mark/finalize acquire run before row; midnight cleanup must do the same.
  perform 1 from public.ve_contact_delivery_daily_runs old_run
   where old_run.ve_project_id = p_ve_project_id
     and old_run.run_date < v_local_date
     and old_run.reservation_status = 'reserved'
   order by old_run.run_date, old_run.id
   for update;

  update public.ve_contact_delivery_rows row_value
     set status = 'ready',
         run_id = null,
         attempt_id = null,
         last_error = null,
         reserved_at = null,
         attempted_at = null,
         finalized_at = null,
         updated_at = p_now
    from public.ve_contact_delivery_daily_runs old_run
   where old_run.id = row_value.run_id
     and old_run.ve_project_id = p_ve_project_id
     and old_run.run_date < v_local_date
     and row_value.status = 'reserved';

  update public.ve_contact_delivery_daily_runs old_run
     set accepted_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows row_value
            where row_value.run_id = old_run.id and row_value.status = 'accepted'
         ),
         skipped_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows row_value
            where row_value.run_id = old_run.id and row_value.status = 'skipped'
         ),
         uncertain_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows row_value
            where row_value.run_id = old_run.id and row_value.status = 'uncertain'
         ),
         released_count = old_run.reserved_count - (
           select count(*)::integer
             from public.ve_contact_delivery_rows row_value
            where row_value.run_id = old_run.id
         ),
         status = case
           when exists (
             select 1
               from public.ve_contact_delivery_rows row_value
              where row_value.run_id = old_run.id and row_value.status = 'attempting'
           ) then 'uncertain'
           when exists (
             select 1
               from public.ve_contact_delivery_rows row_value
              where row_value.run_id = old_run.id and row_value.status = 'uncertain'
           ) then 'uncertain'
           else 'completed'
         end,
         error = case
           when exists (
             select 1
               from public.ve_contact_delivery_rows row_value
              where row_value.run_id = old_run.id and row_value.status = 'attempting'
           ) then coalesce(old_run.error, 'provider attempt remained unresolved after local day ended')
           else old_run.error
         end,
         completed_at = coalesce(old_run.completed_at, p_now),
         updated_at = p_now
   where old_run.ve_project_id = p_ve_project_id
     and old_run.run_date < v_local_date
     and old_run.reservation_status = 'reserved'
     and old_run.status in ('reserved','attempting');

  perform public.ve_refresh_contact_delivery_counters(p_ve_project_id, p_now);

  -- Accepted uploads and ambiguous/in-flight provider calls still consume the
  -- unsent reserve until the attributed sync proves first contact. Never count
  -- that reserve as fulfillment, and cap the attributed fact by the period fact
  -- so independent sync clocks only reduce uploads conservatively.
  select least(count(*), 2147483647)::integer
    into v_committed
    from public.ve_contact_delivery_rows row_value
   where row_value.ve_project_id = p_ve_project_id
     and row_value.status in ('accepted','attempting','uncertain');
  v_outstanding := greatest(
    0::bigint,
    v_committed::bigint - least(p_observed_ve_first_contacted, v_actual)
  )::integer;
  v_upload_headroom := greatest(0, v_remaining - v_outstanding);

  if v_remaining = 0 then
    v_workdays := case when v_local_date <= v_period.deadline then (
      select count(*)::integer
        from generate_series(0, v_period.deadline - v_local_date) as day(day_offset)
       where extract(dow from v_local_date + day.day_offset)::smallint
             = any(v_project.delivery_schedule_days)
    ) else 0 end;
    v_required := 0;
  else
    if v_local_date > v_period.deadline then
      raise exception 'bound Portal period deadline passed with contacts remaining';
    end if;
    select count(*)::integer
      into v_workdays
      from generate_series(0, v_period.deadline - v_local_date) as day(day_offset)
     where extract(dow from v_local_date + day.day_offset)::smallint
           = any(v_project.delivery_schedule_days);
    if v_workdays = 0 then
      raise exception 'delivery schedule has no remaining allowed days through deadline';
    end if;
    v_required := ceiling(v_remaining::numeric / v_workdays::numeric)::integer;
  end if;

  select least(count(*), 2147483647)::integer
    into v_ready
    from public.ve_contact_delivery_rows row_value
    join public.ve_launch_queue_items qi on qi.id = row_value.item_id
   where qi.project_id = p_ve_project_id
     and qi.status = 'active'
     and row_value.status = 'ready'
     and public.ve_manual_campaign_delivery_allowed(row_value.campaign_row_id,p_now);

  if v_remaining = 0 then
    v_reservation_status := 'fulfilled';
    v_effective := 0;
  elsif extract(dow from v_local_date)::smallint
        <> all(v_project.delivery_schedule_days) then
    v_reservation_status := 'not_scheduled';
    v_effective := 0;
  elsif v_upload_headroom = 0 then
    v_reservation_status := 'awaiting_delivery';
    v_effective := 0;
  elsif v_ready = 0 then
    v_reservation_status := 'no_ready_rows';
    v_effective := 0;
  else
    v_reservation_status := 'reserved';
    v_effective := least(v_required, v_project.sender_daily_capacity, v_ready, v_upload_headroom);
  end if;

  if v_reservation_status <> 'reserved' then
    insert into public.ve_contact_delivery_daily_runs(
      ve_project_id,
      portal_project_id,
      portal_period_id,
      run_date,
      reservation_status,
      status,
      target_contacts,
      actual_first_contacted,
      observed_ve_first_contacted,
      committed_count,
      outstanding_count,
      upload_headroom,
      deadline,
      schedule_days,
      timezone,
      sender_daily_capacity,
      remaining_contacts,
      remaining_workdays,
      required_daily,
      ready_remaining,
      effective_count,
      reserved_count,
      completed_at,
      created_at,
      updated_at
    ) values (
      p_ve_project_id,
      v_project.portal_project_id,
      v_project.portal_period_id,
      v_local_date,
      v_reservation_status,
      'completed',
      v_project.target_contacts,
      v_actual,
      p_observed_ve_first_contacted,
      v_committed,
      v_outstanding,
      v_upload_headroom,
      v_period.deadline,
      v_project.delivery_schedule_days,
      v_project.delivery_timezone,
      v_project.sender_daily_capacity,
      v_remaining,
      v_workdays,
      v_required,
      v_ready,
      0,
      0,
      p_now,
      p_now,
      p_now
    ) returning * into v_run;
    return public.ve_contact_delivery_run_response(
      v_run.id,
      v_reservation_status,
      false
    );
  end if;

  -- Share the project quota across bases explicitly selected by the specialist.
  -- Source potential affects allocation only; it does not admit or delay a launch.
  select array_agg(selected.id order by selected.fair_progress, selected.id)
    into v_selected_ids
    from (
      select row_value.id,
             (row_value.drip_order::numeric + 1)
               / greatest(coalesce(qi.potential_pct, 0), 1) as fair_progress
        from public.ve_contact_delivery_rows row_value
        join public.ve_launch_queue_items qi on qi.id = row_value.item_id
       where qi.project_id = p_ve_project_id
         and qi.status = 'active'
         and row_value.status = 'ready'
         and public.ve_manual_campaign_delivery_allowed(row_value.campaign_row_id,p_now)
       order by fair_progress,
                qi.created_at, qi.id, row_value.id
       limit v_effective
       for update of row_value skip locked
    ) selected;
  if cardinality(coalesce(v_selected_ids, '{}'::uuid[])) <> v_effective then
    raise exception 'ready delivery supply changed during atomic reservation';
  end if;

  insert into public.ve_contact_delivery_daily_runs(
    ve_project_id,
    portal_project_id,
    portal_period_id,
    run_date,
    reservation_status,
    status,
    target_contacts,
    actual_first_contacted,
    observed_ve_first_contacted,
    committed_count,
    outstanding_count,
    upload_headroom,
    deadline,
    schedule_days,
    timezone,
    sender_daily_capacity,
    remaining_contacts,
    remaining_workdays,
    required_daily,
    ready_remaining,
    effective_count,
    reserved_count,
    reserved_at,
    created_at,
    updated_at
  ) values (
    p_ve_project_id,
    v_project.portal_project_id,
    v_project.portal_period_id,
    v_local_date,
    'reserved',
    'reserved',
    v_project.target_contacts,
    v_actual,
    p_observed_ve_first_contacted,
    v_committed,
    v_outstanding,
    v_upload_headroom,
    v_period.deadline,
    v_project.delivery_schedule_days,
    v_project.delivery_timezone,
    v_project.sender_daily_capacity,
    v_remaining,
    v_workdays,
    v_required,
    v_ready,
    v_effective,
    v_effective,
    p_now,
    p_now,
    p_now
  ) returning * into v_run;

  update public.ve_contact_delivery_rows row_value
     set status = 'reserved',
         run_id = v_run.id,
         reserved_at = p_now,
         updated_at = p_now
   where row_value.id = any(v_selected_ids)
     and row_value.status = 'ready';
  get diagnostics v_reserved_rows = row_count;
  if v_reserved_rows <> v_effective then
    raise exception 'failed to reserve the exact delivery row quota';
  end if;

  perform public.ve_refresh_contact_delivery_counters(p_ve_project_id, p_now);
  return public.ve_contact_delivery_run_response(v_run.id, 'reserved', true);
end;
$$;

create or replace function public.ve_mark_contact_delivery_attempt_before_supply(
  p_run_id uuid,
  p_attempt_id uuid,
  p_campaign_id text,
  p_row_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_existing public.ve_contact_delivery_attempts%rowtype;
  v_rows uuid[];
  v_campaign_id text;
  v_campaign_row_ids uuid[];
  v_total integer;
  v_identity integer;
  v_reserved integer;
  v_updated integer;
  v_now timestamptz := pg_catalog.now();
begin
  if p_run_id is null or p_attempt_id is null then
    raise exception 'run and attempt UUIDs are required';
  end if;
  v_campaign_id := nullif(btrim(p_campaign_id), '');
  if v_campaign_id is null then
    raise exception 'campaign_id is required';
  end if;
  if p_row_ids is null or cardinality(p_row_ids) = 0 then
    raise exception 'attempt row_ids must be non-empty';
  end if;
  v_rows := public.ve_normalize_delivery_row_ids(p_row_ids);
  if cardinality(v_rows) <> cardinality(p_row_ids) then
    raise exception 'attempt row_ids must be unique and non-null';
  end if;

  select r.*
    into v_run
    from public.ve_contact_delivery_daily_runs r
   where r.id = p_run_id
   for update;
  if not found then
    raise exception 'contact delivery run not found';
  end if;

  select a.*
    into v_existing
    from public.ve_contact_delivery_attempts a
   where a.id = p_attempt_id
   for update;
  if found then
    if v_existing.run_id = p_run_id
       and v_existing.campaign_id = v_campaign_id
       and v_existing.row_ids = v_rows then
      return jsonb_build_object(
        'marked', false,
        'replayed', true,
        'run_id', p_run_id,
        'attempt_id', p_attempt_id,
        'campaign_id', v_campaign_id,
        'row_count', cardinality(v_rows)
      );
    end if;
    raise exception 'attempt UUID already belongs to a different immutable request';
  end if;

  if v_run.reservation_status <> 'reserved'
     or v_run.status not in ('reserved','attempting') then
    return jsonb_build_object(
      'marked', false,
      'replayed', true,
      'run_id', p_run_id,
      'attempt_id', p_attempt_id,
      'campaign_id', v_campaign_id,
      'row_count', cardinality(v_rows)
    );
  end if;

  if timezone(v_run.timezone, v_now)::date <> v_run.run_date
     or not exists (
       select 1 from public.ve_contact_delivery_term(v_run.portal_project_id, v_run.portal_period_id, v_run.ve_project_id) pp
        where pp.status = 'active'
          and pp.deadline >= timezone(v_run.timezone, v_now)::date
     ) then
    raise exception 'delivery reservation is no longer in an active period/local day';
  end if;

  select count(*)::integer,
         count(*) filter (
           where c.campaign_id = v_campaign_id
             and qi.project_id = v_run.ve_project_id
             and qi.status = 'active'
             and public.ve_manual_campaign_delivery_allowed(c.id,v_now)
         )::integer,
         count(*) filter (
           where c.campaign_id = v_campaign_id
             and qi.project_id = v_run.ve_project_id
             and row_value.run_id = p_run_id
             and row_value.status = 'reserved'
             and row_value.attempt_id is null
         )::integer,
         coalesce(array_agg(distinct c.id) filter (
           where c.campaign_id = v_campaign_id
             and qi.project_id = v_run.ve_project_id
         ), '{}'::uuid[])
    into v_total, v_identity, v_reserved, v_campaign_row_ids
    from unnest(v_rows) requested(id)
    left join public.ve_contact_delivery_rows row_value on row_value.id = requested.id
    left join public.ve_launch_queue_campaigns c on c.id = row_value.campaign_row_id
    left join public.ve_launch_queue_items qi on qi.id = row_value.item_id
   where row_value.id is not null;

  if v_total <> cardinality(v_rows) then
    raise exception 'attempt references unknown delivery rows';
  end if;
  if v_identity <> cardinality(v_rows) or cardinality(v_campaign_row_ids) <> 1 then
    raise exception 'attempt rows do not belong to the requested project campaign';
  end if;
  if v_reserved <> cardinality(v_rows) then
    return jsonb_build_object(
      'marked', false,
      'replayed', true,
      'run_id', p_run_id,
      'attempt_id', p_attempt_id,
      'campaign_id', v_campaign_id,
      'row_count', cardinality(v_rows)
    );
  end if;

  insert into public.ve_contact_delivery_attempts(
    id,
    run_id,
    campaign_row_id,
    campaign_id,
    row_ids,
    status,
    started_at,
    created_at,
    updated_at
  ) values (
    p_attempt_id,
    p_run_id,
    v_campaign_row_ids[1],
    v_campaign_id,
    v_rows,
    'attempting',
    v_now,
    v_now,
    v_now
  );

  update public.ve_contact_delivery_rows row_value
     set status = 'attempting',
         attempt_id = p_attempt_id,
         attempted_at = v_now,
         updated_at = v_now
   where row_value.id = any(v_rows)
     and row_value.run_id = p_run_id
     and row_value.status = 'reserved'
     and row_value.attempt_id is null;
  get diagnostics v_updated = row_count;
  if v_updated <> cardinality(v_rows) then
    raise exception 'attempt fence failed to claim every requested row';
  end if;

  update public.ve_contact_delivery_daily_runs r
     set status = 'attempting',
         updated_at = v_now
   where r.id = p_run_id;

  return jsonb_build_object(
    'marked', true,
    'replayed', false,
    'run_id', p_run_id,
    'attempt_id', p_attempt_id,
    'campaign_id', v_campaign_id,
    'row_count', cardinality(v_rows)
  );
end;
$$;

alter function public.ve_reserve_contact_delivery_day_before_supply(uuid,timestamptz,bigint) owner to postgres;
revoke all on function public.ve_reserve_contact_delivery_day_before_supply(uuid,timestamptz,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ve_reserve_contact_delivery_day_before_supply(uuid,timestamptz,bigint) to postgres;

alter function public.ve_mark_contact_delivery_attempt_before_supply(uuid,uuid,text,uuid[]) owner to postgres;
revoke all on function public.ve_mark_contact_delivery_attempt_before_supply(uuid,uuid,text,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.ve_mark_contact_delivery_attempt_before_supply(uuid,uuid,text,uuid[]) to postgres;

-- A manual Start can make rows eligible later on the same day. Retry only an
-- empty, never-attempted reservation; never reopen work already sent or uncertain.
create or replace function public.ve_reserve_contact_delivery_day(p_ve_project_id uuid,p_now timestamptz,p_observed_ve_first_contacted bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_period uuid; v_portal_project uuid; v_result jsonb; v_date date;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
begin
  select portal_project_id,portal_period_id,timezone(delivery_timezone,p_now)::date into v_portal_project,v_period,v_date
    from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_portal_project,v_period));
  perform 1 from public.ve_projects where id=p_ve_project_id for update;
  if exists(select 1 from public.ve_contact_delivery_rates r where r.project_id=p_ve_project_id
    and (r.status<>'ready' or r.checked_at is null or r.checked_at < clock_timestamp()-interval '10 minutes')) then
    raise exception 'Новый темп ещё не подтверждён в Instantly. Загрузка отложена';
  end if;
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
    delete from public.ve_contact_delivery_daily_runs r where (r.portal_period_id=v_period
      or (v_period is null and r.portal_period_id is null and r.ve_project_id=p_ve_project_id)) and r.run_date=v_date
      and r.reservation_status='no_ready_rows' and r.reserved_count=0
      and not exists(select 1 from public.ve_contact_delivery_attempts a where a.run_id=r.id)
      and not exists(select 1 from public.ve_contact_delivery_rows d where d.run_id=r.id);
  v_result:=public.ve_reserve_contact_delivery_day_before_supply(p_ve_project_id,p_now,p_observed_ve_first_contacted);
  return v_result;
end;
$$;

-- Fence old web/worker versions during rollout as well. Neither automatic daily
-- delivery nor an old Portal tab may reserve permission to call provider Start.
create or replace function public.ve_reserve_contact_delivery_activation(
  p_item_id uuid,p_campaign_id text,p_attempt_id uuid,p_remote_status integer,
  p_status_observed_at timestamptz,p_now timestamptz
) returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('reserved',false,'reason','manual_start_in_instantly');
$$;
create or replace function public.ve_reserve_launch_activation(
  p_item_id uuid,p_expected_plan_version bigint,p_activation_reservation_id uuid,
  p_idempotency_key uuid,p_actor_id uuid,p_now timestamptz
) returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('reserved',false,'code','VE_START_IN_INSTANTLY',
    'error','Проверьте кампанию и нажмите Start в Instantly.');
$$;
