-- A specialist-approved VE2 launch continues past its planning deadline at
-- the selected daily capacity, until the contact target or an explicit pause.
-- Dates are not rewritten. Active project/period, immutable approval, source
-- budgets, provider Pause/Start, daily limits and upload idempotency stay intact.
-- Only VE2 functions are changed; no ENG/shared campaign behavior changes.
-- Patch the currently installed bodies to preserve prior recovery/rate fences.
-- Every replacement is checked; unexpected definitions abort this migration.
-- CREATE OR REPLACE retains the existing owner and grants. Re-run is a no-op.
do $migration$
declare
  v_name text;
  v_oid oid;
  v_def text;
  v_marker text;
  v_change record;
begin
  foreach v_name in array array[
    've_bind_contact_delivery_plan',
    've_finalize_template_contact_delivery',
    've_reserve_contact_delivery_day_before_supply',
    've_mark_contact_delivery_attempt_before_supply',
    've_retry_contact_delivery_upload',
    've_reconcile_launch_campaign_statuses',
    've_approve_contact_supply',
    've_require_contact_supply_active',
    've_hold_continuous_supply_slot'
  ]
  loop
    select p.oid into strict v_oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    v_def := pg_catalog.pg_get_functiondef(v_oid);
    v_marker := '-- VE2 planning deadline continuation 20260929';
    if position(v_marker in v_def)>0 then continue; end if;
    for v_change in select * from (values
    ('ve_bind_contact_delivery_plan', 0, $old$  if v_period.deadline < timezone(v_timezone, p_now)::date then
    raise exception 'active Portal project period deadline has passed';
  end if;
$old$, $new$$new$),
    ('ve_bind_contact_delivery_plan', 1, $old$v_period.deadline - timezone(v_timezone, p_now)::date$old$, $new$greatest(7, v_period.deadline - timezone(v_timezone, p_now)::date)$new$),
    ('ve_finalize_template_contact_delivery', 0, $old$  if v_period.deadline < timezone(v_project.delivery_timezone, p_now)::date then
    raise exception 'bound Portal period deadline passed before launch finalize';
  end if;
$old$, $new$$new$),
    ('ve_reserve_contact_delivery_day_before_supply', 0, $old$    if v_local_date > v_period.deadline then
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
    v_required := ceiling(v_remaining::numeric / v_workdays::numeric)::integer;$old$, $new$    if v_local_date > v_period.deadline then
      -- Continue at the selected capacity; keep the original deadline in the run.
      v_workdays := least(366, greatest(2, ceiling(v_remaining::numeric /
        greatest(1, v_project.sender_daily_capacity))::integer));
      v_required := least(v_remaining, v_project.sender_daily_capacity);
    else
      select count(*)::integer into v_workdays
        from generate_series(0, v_period.deadline - v_local_date) as day(day_offset)
       where extract(dow from v_local_date + day.day_offset)::smallint
             = any(v_project.delivery_schedule_days);
      if v_workdays = 0 then
        -- Wait for the next allowed day, even if it is after the deadline.
        v_required := least(v_remaining, v_project.sender_daily_capacity);
      else
        v_required := ceiling(v_remaining::numeric / v_workdays::numeric)::integer;
      end if;
    end if;$new$),
    ('ve_mark_contact_delivery_attempt_before_supply', 0, $old$pp.deadline >= timezone(v_run.timezone, v_now)::date$old$, $new$pp.deadline is not null$new$),
    ('ve_retry_contact_delivery_upload', 0, $old$status='active' and deadline>=v_today$old$, $new$status='active' and deadline is not null$new$),
    ('ve_retry_contact_delivery_upload', 1, $old$Срок проекта завершён. Дозаливка недоступна.$old$, $new$Проект или период не активен. Дозаливка недоступна.$new$),
    ('ve_reconcile_launch_campaign_statuses', 0, $old$when pp.deadline < timezone(p.delivery_timezone, p_now)::date then false$old$, $new$when pp.deadline is null then false$new$),
    ('ve_approve_contact_supply', 0, $old$pp.deadline>=p_now::date$old$, $new$pp.deadline is not null$new$),
    ('ve_require_contact_supply_active', 0, $old$pp.deadline>=timezone(p.delivery_timezone,p_now)::date$old$, $new$pp.deadline is not null$new$),
    ('ve_hold_continuous_supply_slot', 0, $old$pp.deadline>=timezone(p.delivery_timezone,new.updated_at)::date$old$, $new$pp.deadline is not null$new$)
    ) as changes(name, step, before_text, after_text) where name=v_name order by step
    loop
      if (length(v_def)-length(replace(v_def,v_change.before_text,'')))
           / length(v_change.before_text) <> 1 then
        raise exception 'Unexpected definition for %, change %',v_name,v_change.step;
      end if;
      v_def := replace(v_def,v_change.before_text,v_change.after_text);
    end loop;
    if position('AS $function$' in v_def)=0 then
      raise exception 'Unexpected function delimiter for %',v_name;
    end if;
    v_def := replace(v_def,'AS $function$','AS $function$'||E'
'||v_marker||E'
');
    execute v_def;
  end loop;
end;
$migration$;
