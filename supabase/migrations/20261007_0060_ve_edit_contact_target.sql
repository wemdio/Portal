-- An explicit project-wide target edit. Provider rows, reservations and campaign
-- state are never reset. The next day uses the new target; today's quota stays frozen.
alter table public.ve_projects add column delivery_target_revision bigint not null default 0;
create table public.ve_contact_target_changes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  revision bigint not null,
  previous_target integer not null,
  target_contacts integer not null check(target_contacts between 1 and 1000000),
  actor_id uuid not null,
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default now(),
  unique(project_id,revision)
);
alter table public.ve_contact_target_changes enable row level security;
revoke all on public.ve_contact_target_changes from public, anon, authenticated, service_role;
grant select on public.ve_contact_target_changes to service_role;

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
    or new.delivery_schedule_days is distinct from old.delivery_schedule_days
    or new.delivery_timezone is distinct from old.delivery_timezone
    or new.delivery_plan_bound_at is distinct from old.delivery_plan_bound_at
    or new.delivery_plan_bound_by is distinct from old.delivery_plan_bound_by
  ) then
    raise exception 'VE2 contact delivery binding is immutable';
  end if;

  if tg_op='UPDATE' and old.portal_project_id is not null
    and (new.target_contacts is distinct from old.target_contacts
      or new.delivery_target_revision is distinct from old.delivery_target_revision)
    and not exists(select 1 from public.ve_contact_target_changes c
      where c.project_id=new.id and c.revision=new.delivery_target_revision
        and c.revision=old.delivery_target_revision+1
        and c.previous_target=old.target_contacts and c.target_contacts=new.target_contacts
        and c.transaction_id=txid_current()) then
    raise exception 'Цель меняется только через сохранение общего плана проекта';
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


-- Read-only aggregate: no contact payloads and no reconciliation side effects.
-- The observed count is supplied by our authenticated server, never by the browser.
create function public.ve_contact_target_state(p_project_id uuid,p_observed_first_contacted bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_project public.ve_projects%rowtype;
  v_term record;
  v_actual bigint;
  v_committed bigint;
  v_reserved bigint;
  v_ready bigint;
  v_minimum bigint;
  v_busy boolean;
begin
  if p_observed_first_contacted is null or p_observed_first_contacted<0 then
    raise exception 'Не удалось подтвердить количество первых отправок';
  end if;
  select * into v_project from public.ve_projects where id=p_project_id;
  if not found or v_project.portal_project_id is null then
    raise exception 'Общая цель появится после подготовки первого запуска';
  end if;
  select * into v_term from public.ve_contact_delivery_term(v_project.portal_project_id,v_project.portal_period_id,p_project_id);
  if not found or v_term.status is distinct from 'active' or v_term.deadline is null then
    raise exception 'Проверьте статус и срок проекта в Portal';
  end if;
  if v_project.portal_period_id is null then
    v_actual:=p_observed_first_contacted;
  elsif v_term.contacts_done is not null and btrim(v_term.contacts_done) ~ '^[0-9]+$' then
    v_actual:=btrim(v_term.contacts_done)::bigint;
  else
    raise exception 'Не удалось подтвердить выполненные контакты периода';
  end if;
  select count(*) filter(where status in ('accepted','attempting','uncertain')),
    count(*) filter(where status='reserved'),count(*) filter(where status='ready')
    into v_committed,v_reserved,v_ready
    from public.ve_contact_delivery_rows where ve_project_id=p_project_id;
  -- Include today's frozen reservations and unresolved imports, not just sent
  -- contacts. Lowering below this floor would promise undoing provider work.
  v_minimum:=greatest(1,v_actual+greatest(0,v_committed-least(v_actual,p_observed_first_contacted))+v_reserved);
  select exists(select 1 from public.ve_outreach_runs where project_id=p_project_id
    and status in ('queued','running','waiting')) into v_busy;
  return jsonb_build_object('target_contacts',v_project.target_contacts,'revision',v_project.delivery_target_revision,
    'minimum_target',v_minimum,'actual_contacted',v_actual,'committed_contacts',v_committed,
    'reserved_contacts',v_reserved,'ready_contacts',v_ready,'deadline',v_term.deadline,
    'daily_capacity',v_project.sender_daily_capacity,'schedule_days',v_project.delivery_schedule_days,
    'timezone',v_project.delivery_timezone,'has_period',v_project.portal_period_id is not null,
    'can_edit',not v_busy);
end; $$;

create function public.ve_change_contact_target(p_project_id uuid,p_expected_revision bigint,
  p_expected_target integer,p_target_contacts integer,p_actor_id uuid,p_observed_first_contacted bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_project public.ve_projects%rowtype;
  v_state jsonb;
  v_plan public.ve_contact_supply_plans%rowtype;
begin
  if p_actor_id is null or p_target_contacts is null or p_target_contacts not between 1 and 1000000
    or p_expected_revision is null or p_expected_revision<0 or p_expected_target is null then
    raise exception 'Укажите целое число от 1 до 1 000 000';
  end if;
  -- Same locks as launch admission and daily reservation. Try-lock/NOWAIT
  -- avoids reversing the plan->batch->delivery order of in-flight supply jobs.
  if not pg_try_advisory_xact_lock(hashtextextended(p_project_id::text,22082029)) then
    raise exception 'Сейчас готовится запуск. Повторите сохранение через минуту';
  end if;
  select * into v_project from public.ve_projects where id=p_project_id;
  if not found or v_project.portal_project_id is null then raise exception 'План проекта ещё не запущен'; end if;
  if not pg_try_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_project.portal_project_id,v_project.portal_period_id)) then
    raise exception 'Сейчас рассчитывается загрузка. Повторите сохранение через минуту';
  end if;
  select * into v_project from public.ve_projects where id=p_project_id for update nowait;
  if v_project.delivery_target_revision is distinct from p_expected_revision
    or v_project.target_contacts is distinct from p_expected_target then
    raise exception 'Цель уже изменена в другой вкладке. Обновите план';
  end if;
  v_state:=public.ve_contact_target_state(p_project_id,p_observed_first_contacted);
  if not (v_state->>'can_edit')::boolean then raise exception 'Дождитесь завершения подготовки текущего запуска'; end if;
  if p_target_contacts<(v_state->>'minimum_target')::bigint then
    raise exception 'Цель не может быть меньше %: эти контакты уже учтены, загружены или зарезервированы',v_state->>'minimum_target';
  end if;
  if p_target_contacts=v_project.target_contacts then return v_state; end if;

  -- Retarget only the numeric term. Audience, letters, approvals, paused/error
  -- states and historical completed batches retain their original evidence.
  for v_plan in select * from public.ve_contact_supply_plans where project_id=p_project_id order by id for update nowait loop
    if v_plan.approval_snapshot->'target_contacts'=to_jsonb(v_project.target_contacts) then
      perform 1 from public.ve_contact_supply_batches where plan_id=v_plan.id
        and status in ('collecting','auditing','ready','failed') for update nowait;
      update public.ve_contact_supply_batches
        set rules_snapshot=jsonb_set(rules_snapshot,'{target_contacts}',to_jsonb(p_target_contacts)),updated_at=now()
        where plan_id=v_plan.id and status in ('collecting','auditing','ready','failed')
          and rules_snapshot=v_plan.approval_snapshot;
      update public.ve_contact_supply_plans
        set approval_snapshot=jsonb_set(approval_snapshot,'{target_contacts}',to_jsonb(p_target_contacts)),updated_at=now()
        where id=v_plan.id;
    end if;
  end loop;
  insert into public.ve_contact_target_changes(project_id,revision,previous_target,target_contacts,actor_id)
    values(p_project_id,p_expected_revision+1,v_project.target_contacts,p_target_contacts,p_actor_id);
  update public.ve_projects set target_contacts=p_target_contacts,delivery_target_revision=p_expected_revision+1
    where id=p_project_id;
  return public.ve_contact_target_state(p_project_id,p_observed_first_contacted);
exception when lock_not_available then
  raise exception 'Сейчас обновляется план или запас контактов. Повторите сохранение через минуту';
end; $$;

alter function public.ve_contact_target_state(uuid,bigint) owner to postgres;
revoke all on function public.ve_contact_target_state(uuid,bigint) from public,anon,authenticated;
grant execute on function public.ve_contact_target_state(uuid,bigint) to service_role,postgres;
alter function public.ve_change_contact_target(uuid,bigint,integer,integer,uuid,bigint) owner to postgres;
revoke all on function public.ve_change_contact_target(uuid,bigint,integer,integer,uuid,bigint) from public,anon,authenticated;
grant execute on function public.ve_change_contact_target(uuid,bigint,integer,integer,uuid,bigint) to service_role,postgres;
