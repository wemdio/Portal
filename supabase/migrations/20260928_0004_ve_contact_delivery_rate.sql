-- Explicit, versioned rate policy. Existing launches retain their limit until a specialist opts in.
create table public.ve_contact_delivery_rates (
  project_id uuid primary key references public.ve_projects(id) on delete cascade,
  preset_id text not null, template_ids uuid[] not null,
  mode text not null check(mode in ('auto','manual')),
  manual_limit integer check(manual_limit between 1 and 100000),
  revision integer not null check(revision > 0),
  status text not null check(status in ('pending','ready','updating','blocked')),
  effective_capacity integer check(effective_capacity > 0),
  snapshot jsonb not null, checked_at timestamptz, error text,
  lease_token uuid, lease_until timestamptz,
  updated_by uuid not null, updated_at timestamptz not null default now(),
  check((mode='auto' and manual_limit is null) or (mode='manual' and manual_limit is not null))
);
create table public.ve_contact_delivery_rate_changes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  revision integer not null, actor_id uuid not null,
  previous_policy jsonb, new_policy jsonb not null, created_at timestamptz not null default now()
);
alter table public.ve_contact_delivery_rates enable row level security;
alter table public.ve_contact_delivery_rate_changes enable row level security;
revoke all on table public.ve_contact_delivery_rates from public, anon, authenticated, service_role;
revoke all on table public.ve_contact_delivery_rate_changes from public, anon, authenticated, service_role;
grant select on public.ve_contact_delivery_rates, public.ve_contact_delivery_rate_changes to service_role;

create function public.ve_save_contact_delivery_rate(p_project_id uuid,p_preset_id text,p_template_ids uuid[],
 p_mode text,p_manual_limit integer,p_expected_revision integer,p_snapshot jsonb,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_project public.ve_projects%rowtype; v_old public.ve_contact_delivery_rates%rowtype;
 v_capacity integer; v_now timestamptz := clock_timestamp();
begin
 select * into v_project from public.ve_projects where id=p_project_id for update;
 if not found then raise exception 'Проект не найден'; end if;
 if p_actor_id is null or p_preset_id is null or btrim(p_preset_id)='' or coalesce(cardinality(p_template_ids),0)=0
  or p_mode not in ('auto','manual') or p_mode is null
  or (p_mode='manual' and (p_manual_limit is null or p_manual_limit not between 1 and 100000))
  or (p_mode='auto' and p_manual_limit is not null) then raise exception 'Некорректные настройки темпа'; end if;
 if v_project.launch_preset_id is not null and v_project.launch_preset_id::text <> p_preset_id then raise exception 'Профиль запуска закреплён'; end if;
 if exists(select 1 from unnest(p_template_ids) t(id) where not exists(select 1 from public.ve_templates vt
   join public.ve_bases b on b.id=vt.base_id where vt.id=t.id and b.project_id=p_project_id and vt.status='ready'))
 then raise exception 'Письма проекта ещё не готовы'; end if;
 v_capacity := (p_snapshot->>'effective_capacity')::integer;
 if p_snapshot->>'checked_at' is null or p_snapshot->>'max_new_contacts' is null or v_capacity is null or v_capacity <= 0 or v_capacity > (p_snapshot->>'max_new_contacts')::integer
   or (p_mode='manual' and v_capacity > p_manual_limit)
   or (p_snapshot->>'checked_at')::timestamptz < v_now-interval '5 minutes'
   or (p_snapshot->>'checked_at')::timestamptz > v_now+interval '1 minute'
 then raise exception 'Нужен свежий подтверждённый расчёт мощности'; end if;
 select * into v_old from public.ve_contact_delivery_rates where project_id=p_project_id for update;
 if coalesce(v_old.revision,0) is distinct from p_expected_revision then raise exception 'Темп изменён в другой вкладке. Обновите расчёт'; end if;
 if v_old.lease_until > v_now then raise exception 'Воркер применяет темп. Повторите через минуту'; end if;
 insert into public.ve_contact_delivery_rates(project_id,preset_id,template_ids,mode,manual_limit,revision,status,effective_capacity,snapshot,checked_at,updated_by)
 values(p_project_id,p_preset_id,p_template_ids,p_mode,p_manual_limit,p_expected_revision+1,
   case when v_project.portal_project_id is null then 'ready' else 'pending' end,v_capacity,p_snapshot,v_now,p_actor_id)
 on conflict(project_id) do update set preset_id=excluded.preset_id,template_ids=excluded.template_ids,mode=excluded.mode,
  manual_limit=excluded.manual_limit,revision=excluded.revision,status=excluded.status,effective_capacity=excluded.effective_capacity,
  snapshot=excluded.snapshot,checked_at=excluded.checked_at,error=null,lease_token=null,lease_until=null,updated_by=p_actor_id,updated_at=v_now;
 insert into public.ve_contact_delivery_rate_changes(project_id,revision,actor_id,previous_policy,new_policy)
 values(p_project_id,p_expected_revision+1,p_actor_id,to_jsonb(v_old),jsonb_build_object('preset_id',p_preset_id,'mode',p_mode,'manual_limit',p_manual_limit,'snapshot',p_snapshot));
 return (select to_jsonb(r) from public.ve_contact_delivery_rates r where project_id=p_project_id);
end; $$;

create function public.ve_claim_contact_delivery_rate(p_project_id uuid,p_revision integer,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.ve_projects where id=p_project_id for update;
 if p_token is null then raise exception 'rate lease identity required'; end if;
 update public.ve_contact_delivery_rates set status='updating',lease_token=p_token,lease_until=clock_timestamp()+interval '2 minutes'
 where project_id=p_project_id and revision=p_revision and (lease_until is null or lease_until <= clock_timestamp() or lease_token=p_token);
 return found;
end; $$;

create function public.ve_finish_contact_delivery_rate(p_project_id uuid,p_revision integer,p_token uuid,p_snapshot jsonb,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_rate public.ve_contact_delivery_rates%rowtype; v_capacity integer; v_now timestamptz:=clock_timestamp();
begin
 perform 1 from public.ve_projects where id=p_project_id for update;
 select * into v_rate from public.ve_contact_delivery_rates where project_id=p_project_id for update;
 if not found or v_rate.revision<>p_revision or v_rate.lease_token is distinct from p_token or v_rate.lease_until <= v_now
 then raise exception 'Rate lease changed; retry with current policy'; end if;
 if p_error is not null then
  update public.ve_contact_delivery_rates set status='blocked',error=left(p_error,500),lease_token=null,lease_until=null where project_id=p_project_id;
  return false;
 end if;
 v_capacity:=(p_snapshot->>'effective_capacity')::integer;
 if p_snapshot->>'checked_at' is null or p_snapshot->>'max_new_contacts' is null or v_capacity is null or v_capacity<=0 or v_capacity>(p_snapshot->>'max_new_contacts')::integer
  or (v_rate.mode='manual' and v_capacity>v_rate.manual_limit)
  or (p_snapshot->>'checked_at')::timestamptz < v_now-interval '5 minutes'
  or (p_snapshot->>'checked_at')::timestamptz > v_now+interval '1 minute'
 then raise exception 'Invalid rate capacity'; end if;
 update public.ve_contact_delivery_rates set status='ready',snapshot=p_snapshot,effective_capacity=v_capacity,checked_at=v_now,
  error=null,lease_token=null,lease_until=null where project_id=p_project_id;
 update public.ve_projects set sender_daily_capacity=v_capacity where id=p_project_id and portal_project_id is not null;
 return true;
end; $$;

create or replace function public.ve_guard_contact_delivery_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bound boolean;
begin
  v_bound := new.portal_project_id is not null;

  if tg_op = 'UPDATE' and old.portal_project_id is not null and (
    new.portal_project_id is distinct from old.portal_project_id
    or new.portal_period_id is distinct from old.portal_period_id
    or new.target_contacts is distinct from old.target_contacts
    or new.delivery_schedule_days is distinct from old.delivery_schedule_days
    or new.delivery_timezone is distinct from old.delivery_timezone
    or new.delivery_plan_bound_at is distinct from old.delivery_plan_bound_at
    or new.delivery_plan_bound_by is distinct from old.delivery_plan_bound_by
  ) then
    raise exception 'VE2 contact delivery binding is immutable';
  end if;

  if tg_op='UPDATE' and old.portal_project_id is not null
    and new.sender_daily_capacity is distinct from old.sender_daily_capacity
    and not exists(select 1 from public.ve_contact_delivery_rates r where r.project_id=new.id
      and r.preset_id=new.launch_preset_id::text and r.status='ready' and r.effective_capacity=new.sender_daily_capacity
      and r.checked_at >= clock_timestamp()-interval '5 minutes') then
    raise exception 'Дневной лимит меняется только через подтверждённый расчёт темпа';
  end if;

  if v_bound and (tg_op = 'INSERT' or old.portal_project_id is null) then
    if new.delivery_schedule_days
       is distinct from public.ve_normalize_delivery_schedule_days(new.delivery_schedule_days)
       or cardinality(new.delivery_schedule_days) = 0
       or not (new.delivery_schedule_days <@ array[1,2,3,4,5]::smallint[]) then
      raise exception 'delivery schedule days must be a canonical non-empty weekday subset of 1..5';
    end if;
    if not exists (
      select 1
        from pg_catalog.pg_timezone_names z
       where z.name = new.delivery_timezone
    ) then
      raise exception 'delivery timezone is not a known IANA timezone: %', new.delivery_timezone;
    end if;
    if new.portal_period_id is not null and not exists (
      select 1
        from public.project_periods pp
       where pp.id = new.portal_period_id
         and pp.project_id = new.portal_project_id
         and pp.status = 'active'
    ) then
      raise exception 'bound Portal project period is not active';
    end if;
    if new.portal_period_id is null and not exists (
      select 1
        from public.ve_contact_delivery_term(new.portal_project_id, null, new.id) t
       where t.status = 'active'
    ) then
      raise exception 'bound Portal project without periods is not launchable';
    end if;
    if tg_op = 'UPDATE' and exists (
      select 1
        from public.ve_launch_queue_items qi
       where qi.project_id = new.id
    ) then
      raise exception 'delivery plan must be bound before a VE2 launch bundle exists';
    end if;
  end if;

  return new;
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

alter function public.ve_save_contact_delivery_rate(uuid,text,uuid[],text,integer,integer,jsonb,uuid) owner to postgres;
revoke all on function public.ve_save_contact_delivery_rate(uuid,text,uuid[],text,integer,integer,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.ve_save_contact_delivery_rate(uuid,text,uuid[],text,integer,integer,jsonb,uuid) to service_role, postgres;

alter function public.ve_claim_contact_delivery_rate(uuid,integer,uuid) owner to postgres;
revoke all on function public.ve_claim_contact_delivery_rate(uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.ve_claim_contact_delivery_rate(uuid,integer,uuid) to service_role, postgres;

alter function public.ve_finish_contact_delivery_rate(uuid,integer,uuid,jsonb,text) owner to postgres;
revoke all on function public.ve_finish_contact_delivery_rate(uuid,integer,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.ve_finish_contact_delivery_rate(uuid,integer,uuid,jsonb,text) to service_role, postgres;
