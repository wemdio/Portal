-- Vertical Engine v2: contact delivery for a Portal project without periods.
--
-- Many Portal projects never had a project_periods row: the project card
-- itself is the contract (projects.status/deadline). Until now every VE2
-- delivery boundary joined project_periods, so such a project could not be
-- launched at all. A binding with portal_project_id set and portal_period_id
-- NULL now means "the project is the term":
--   * it is active while the project has NO periods at all, its status is a
--     working one and projects.deadline is a valid ISO date not yet passed;
--   * the plan fact is the first-contacted count of this VE2 project's own
--     campaigns (the accumulated projects.contacts_done is never parsed);
--   * the deadline is read live, so fixing the project card resumes delivery
--     while the plan's campaigns are unfinished; if they all complete during
--     the pause, reconcile releases the bundle, as for a closed period.
-- Period bindings keep their exact formulas and advisory-lock key.
--
-- Additive only: no data is rewritten, nothing is written to projects or
-- project_periods. Every recreated body below is the 20260902/20260903 text
-- with the listed point edits (see tests/migrations/veContactDeliveryWithoutPeriod.test.ts).

alter table public.ve_projects
  drop constraint if exists ve_projects_delivery_plan_all_or_none,
  drop constraint if exists ve_projects_portal_project_fkey;

alter table public.ve_projects
  add constraint ve_projects_delivery_plan_all_or_none
  check (
    (
      portal_project_id is null
      and portal_period_id is null
      and target_contacts is null
      and delivery_schedule_days is null
      and delivery_timezone is null
      and sender_daily_capacity is null
      and delivery_plan_bound_at is null
      and delivery_plan_bound_by is null
    )
    or
    (
      portal_project_id is not null
      and target_contacts is not null
      and target_contacts > 0
      and delivery_schedule_days is not null
      and cardinality(delivery_schedule_days) between 1 and 5
      and delivery_schedule_days = public.ve_normalize_delivery_schedule_days(delivery_schedule_days)
      and delivery_schedule_days <@ array[1,2,3,4,5]::smallint[]
      and nullif(btrim(delivery_timezone), '') is not null
      and sender_daily_capacity is not null
      and sender_daily_capacity > 0
      and delivery_plan_bound_at is not null
      and delivery_plan_bound_by is not null
    )
  ),
  -- Mirrors the period FK: a Portal project that owns a VE2 plan cannot vanish.
  add constraint ve_projects_portal_project_fkey
  foreign key (portal_project_id)
  references public.projects(id)
  on delete restrict;

create unique index if not exists ve_projects_one_delivery_plan_per_project_without_period
  on public.ve_projects(portal_project_id)
  where portal_project_id is not null and portal_period_id is null;

comment on column public.ve_projects.portal_period_id is
  'Explicit active Portal period whose first-contacted fact drives remaining obligation. NULL with portal_project_id set: the project has no periods and the project card is the term.';

alter table public.ve_contact_delivery_daily_runs
  alter column portal_period_id drop not null;

create unique index if not exists ve_contact_delivery_daily_runs_project_date_without_period
  on public.ve_contact_delivery_daily_runs(portal_project_id, run_date)
  where portal_period_id is null;

-- projects.deadline is free text in production. Anything but a real
-- YYYY-MM-DD date is treated as "no deadline", never guessed.
create or replace function public.ve_try_iso_date(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value text := btrim(p_value);
begin
  if v_value is null or v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return v_value::date;
exception
  when invalid_datetime_format or datetime_field_overflow then
    return null;
end;
$$;

-- One serialization key per delivery term. The period key is byte-for-byte
-- the historical one; a project without periods gets its own namespace.
-- Never NULL: pg_advisory_xact_lock is STRICT and would silently not lock.
create or replace function public.ve_contact_delivery_lock_key(
  p_portal_project_id uuid,
  p_portal_period_id uuid
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.hashtextextended(
    case
      when p_portal_period_id is not null
        then 've-contact-delivery-period:' || p_portal_period_id::text
      else 've-contact-delivery-period:project:' || coalesce(p_portal_project_id::text, 'unbound')
    end,
    0
  )
$$;

-- The live term behind a delivery binding, shaped like a project_periods row.
-- Period: that exact row of that project. Project without periods: 'active'
-- only while it has no periods, a working status (the same list as the
-- launch step, app/src/lib/verticalEngineV2/portalDeliveryTerm.ts) and a
-- real ISO deadline; the fact is the last daily run's first-contacted count
-- of this VE2 project. An empty or non-ISO deadline is 'no_deadline': a pause
-- like a passed deadline, so reconcile frees the slot once campaigns finish.
create or replace function public.ve_contact_delivery_term(
  p_portal_project_id uuid,
  p_portal_period_id uuid,
  p_ve_project_id uuid
)
returns table(status text, deadline date, contacts_done text)
language sql
volatile
security definer
set search_path = ''
as $$
  select pp.status, pp.deadline, pp.contacts_done
    from public.project_periods pp
   where p_portal_period_id is not null
     and pp.id = p_portal_period_id
     and pp.project_id = p_portal_project_id
  union all
  select
    case
      when exists (
        select 1 from public.project_periods any_period where any_period.project_id = p.id
      ) then 'has_periods'
      when p.status in ('В работе', 'Тестирование', 'Подготовка', 'На паузе') then
        case when public.ve_try_iso_date(p.deadline::text) is null then 'no_deadline' else 'active' end
      else 'not_launchable'
    end,
    public.ve_try_iso_date(p.deadline::text),
    coalesce((
      select r.actual_first_contacted::text
        from public.ve_contact_delivery_daily_runs r
       where r.ve_project_id = p_ve_project_id
         and r.portal_project_id = p.id
         and r.portal_period_id is null
       order by r.run_date desc, r.created_at desc
       limit 1
    ), '0')
    from public.projects p
   where p_portal_period_id is null
     and p.id = p_portal_project_id
$$;

create or replace function public.ve_guard_contact_delivery_item_counters()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_initial integer;
  v_ready integer;
begin
  if not exists (
    select 1
      from public.ve_projects p
     where p.id = new.project_id and p.portal_project_id is not null
  ) then
    return new;
  end if;
  select count(*)::integer,
         count(*) filter (where r.status = 'ready')::integer
    into v_initial, v_ready
    from public.ve_contact_delivery_rows r
   where r.item_id = new.id;
  if new.ready_leads_count <> v_initial
     or new.ready_remaining_count <> v_ready then
    raise exception 'bound queue item delivery counters must match its durable rows';
  end if;
  return new;
end;
$$;

create or replace function public.ve_guard_contact_delivery_campaign_counters()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_initial integer;
  v_ready integer;
  v_accepted integer;
begin
  if not exists (
    select 1
      from public.ve_launch_queue_items qi
      join public.ve_projects p on p.id = qi.project_id
     where qi.id = new.item_id and p.portal_project_id is not null
  ) then
    return new;
  end if;
  select count(*)::integer,
         count(*) filter (where r.status = 'ready')::integer,
         count(*) filter (where r.status = 'accepted')::integer
    into v_initial, v_ready, v_accepted
    from public.ve_contact_delivery_rows r
   where r.campaign_row_id = new.id;
  if new.ready_leads_count <> v_initial
     or new.ready_remaining_count <> v_ready
     or new.leads_count <> v_accepted then
    raise exception 'bound campaign delivery counters must match its durable rows';
  end if;
  return new;
end;
$$;

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
    or new.sender_daily_capacity is distinct from old.sender_daily_capacity
    or new.delivery_plan_bound_at is distinct from old.delivery_plan_bound_at
    or new.delivery_plan_bound_by is distinct from old.delivery_plan_bound_by
  ) then
    raise exception 'VE2 contact delivery binding is immutable';
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

create or replace function public.ve_finalize_template_contact_delivery(
  p_audit_id uuid,
  p_template_id uuid,
  p_launch_reservation_id uuid,
  p_launch_status text,
  p_launch_info jsonb,
  p_error text,
  p_now timestamptz,
  p_drip_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.ve_projects%rowtype;
  v_period public.project_periods%rowtype;
  v_item public.ve_launch_queue_items%rowtype;
  v_campaign_row public.ve_launch_queue_campaigns%rowtype;
  v_existing_row public.ve_contact_delivery_rows%rowtype;
  v_result jsonb;
  v_launch_info jsonb;
  v_campaigns jsonb;
  v_enriched_campaigns jsonb := '[]'::jsonb;
  v_campaign jsonb;
  v_row jsonb;
  v_campaign_id text;
  v_seen_campaign_ids text[] := '{}'::text[];
  v_payload jsonb;
  v_email text;
  v_supplied_email text;
  v_source_row_index numeric;
  v_drip_order numeric;
  v_row_count integer;
  v_campaign_ready integer;
  v_matched_count integer;
begin
  if p_launch_status is null
     or p_launch_status not in ('succeeded','failed','uncertain') then
    raise exception 'invalid launch status: %', p_launch_status;
  end if;
  if p_drip_rows is null or jsonb_typeof(p_drip_rows) <> 'array' then
    raise exception 'p_drip_rows must be an array';
  end if;

  if p_launch_status <> 'succeeded' then
    if jsonb_array_length(p_drip_rows) <> 0 then
      raise exception 'non-succeeded launch cannot persist delivery rows';
    end if;
    return public.ve_finalize_template_launch(
      p_audit_id,
      p_template_id,
      p_launch_reservation_id,
      p_launch_status,
      p_launch_info,
      p_error,
      p_now
    );
  end if;

  if p_launch_info is null or jsonb_typeof(p_launch_info) <> 'object' then
    raise exception 'succeeded delivery launch requires launch_info object';
  end if;
  v_row_count := jsonb_array_length(p_drip_rows);
  if v_row_count = 0 then
    raise exception 'succeeded delivery launch requires durable drip rows';
  end if;

  select p.*
    into v_project
    from public.ve_templates t
    join public.ve_bases b on b.id = t.base_id
    join public.ve_projects p on p.id = b.project_id
   where t.id = p_template_id
   for share of p;
  if not found then
    raise exception 'template project identity not found';
  end if;
  if v_project.portal_project_id is null
     or v_project.target_contacts is null
     or v_project.launch_preset_id is null then
    raise exception 'VE2 project has no complete delivery/preset binding';
  end if;
  if nullif(btrim(p_launch_info ->> 'preset_id'), '')
     is distinct from v_project.launch_preset_id::text then
    raise exception 'launch preset does not match immutable VE2 project binding';
  end if;
  if v_project.launch_instantly_account_id is not null
     and nullif(btrim(p_launch_info ->> 'instantly_account_id'), '')
         is distinct from v_project.launch_instantly_account_id then
    raise exception 'launch workspace does not match immutable VE2 project binding';
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
      raise exception 'bound Portal project period is not active at launch finalize';
    end if;
  else
    select t.deadline, t.contacts_done
      into v_period.deadline, v_period.contacts_done
      from public.ve_contact_delivery_term(v_project.portal_project_id, null, v_project.id) t
     where t.status = 'active';
    if not found then
      raise exception 'bound Portal project without periods is not launchable at launch finalize';
    end if;
  end if;
  if v_period.deadline is null
     or v_period.contacts_done is null
     or btrim(v_period.contacts_done) !~ '^[0-9]+$'
     or btrim(v_period.contacts_done)::numeric > 9223372036854775807::numeric then
    raise exception 'bound Portal period is missing an exact deadline/fact snapshot';
  end if;
  if v_period.deadline < timezone(v_project.delivery_timezone, p_now)::date then
    raise exception 'bound Portal period deadline passed before launch finalize';
  end if;
  if p_launch_info ? 'portal_project_id'
     and nullif(btrim(p_launch_info ->> 'portal_project_id'), '')
         is distinct from v_project.portal_project_id::text then
    raise exception 'launch Portal project does not match immutable delivery binding';
  end if;
  if p_launch_info ? 'portal_period_id'
     and nullif(btrim(p_launch_info ->> 'portal_period_id'), '')
         is distinct from v_project.portal_period_id::text then
    raise exception 'launch Portal period does not match immutable delivery binding';
  end if;
  if p_launch_info ? 'target_contacts' and (
    jsonb_typeof(p_launch_info -> 'target_contacts') <> 'number'
    or (p_launch_info ->> 'target_contacts')::numeric <> v_project.target_contacts
  ) then
    raise exception 'launch target does not match immutable delivery binding';
  end if;

  if jsonb_typeof(p_launch_info -> 'campaigns') = 'array'
     and jsonb_array_length(p_launch_info -> 'campaigns') > 0 then
    v_campaigns := p_launch_info -> 'campaigns';
  elsif nullif(btrim(p_launch_info ->> 'campaign_id'), '') is not null then
    v_campaigns := jsonb_build_array(jsonb_build_object(
      'campaign_id', p_launch_info ->> 'campaign_id',
      'campaign_name', p_launch_info ->> 'campaign_name',
      'campaign_url', p_launch_info ->> 'campaign_url',
      'segment', null,
      'leads_count', 0
    ));
  else
    raise exception 'succeeded delivery launch requires at least one campaign';
  end if;

  for v_campaign in select value from jsonb_array_elements(v_campaigns)
  loop
    if jsonb_typeof(v_campaign) <> 'object' then
      raise exception 'campaign snapshot must be an object';
    end if;
    v_campaign_id := nullif(btrim(v_campaign ->> 'campaign_id'), '');
    if v_campaign_id is null then
      raise exception 'campaign snapshot requires campaign_id';
    end if;
    if v_campaign_id = any(v_seen_campaign_ids) then
      raise exception 'duplicate campaign_id in delivery launch: %', v_campaign_id;
    end if;
    if v_campaign ? 'remote_status' and (
      jsonb_typeof(v_campaign -> 'remote_status') is distinct from 'number'
      or (v_campaign ->> 'remote_status')::numeric <> 2
    ) then
      raise exception 'recovered delivery campaign must be proven paused and empty';
    end if;
    v_seen_campaign_ids := array_append(v_seen_campaign_ids, v_campaign_id);
    if v_campaign ? 'leads_count' and (
      jsonb_typeof(v_campaign -> 'leads_count') <> 'number'
      or (v_campaign ->> 'leads_count')::numeric <> 0
    ) then
      raise exception 'delivery campaign % must start with leads_count=0', v_campaign_id;
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(p_drip_rows)
  loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'delivery row must be an object';
    end if;
    v_campaign_id := nullif(btrim(v_row ->> 'campaign_id'), '');
    if v_campaign_id is null or not (v_campaign_id = any(v_seen_campaign_ids)) then
      raise exception 'delivery row references an unknown campaign: %', v_campaign_id;
    end if;
    if jsonb_typeof(v_row -> 'source_row_index') <> 'number'
       or jsonb_typeof(v_row -> 'drip_order') <> 'number' then
      raise exception 'delivery row requires numeric source_row_index and drip_order';
    end if;
    v_source_row_index := (v_row ->> 'source_row_index')::numeric;
    v_drip_order := (v_row ->> 'drip_order')::numeric;
    if v_source_row_index < 0
       or trunc(v_source_row_index) <> v_source_row_index
       or v_source_row_index > 2147483647::numeric then
      raise exception 'delivery source_row_index must be a non-negative integer';
    end if;
    if v_drip_order < 0
       or trunc(v_drip_order) <> v_drip_order
       or v_drip_order > 9223372036854775807::numeric then
      raise exception 'delivery drip_order must be a non-negative bigint';
    end if;
    v_payload := v_row -> 'lead_payload';
    if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
      raise exception 'delivery row requires lead_payload object';
    end if;
    v_email := lower(nullif(btrim(v_payload ->> 'email'), ''));
    if v_email is null then
      raise exception 'delivery lead payload requires email';
    end if;
    if v_row ? 'email_normalized' then
      v_supplied_email := lower(nullif(btrim(v_row ->> 'email_normalized'), ''));
      if v_supplied_email is distinct from v_email then
        raise exception 'delivery email_normalized does not match lead_payload.email';
      end if;
    end if;
  end loop;

  -- Freeze immutable initial supply in the launch snapshot consumed by the
  -- existing finalizer. Each campaign must own at least one durable row.
  for v_campaign in select value from jsonb_array_elements(v_campaigns)
  loop
    v_campaign_id := btrim(v_campaign ->> 'campaign_id');
    select count(*)::integer
      into v_campaign_ready
      from jsonb_array_elements(p_drip_rows) row_value(value)
     where btrim(row_value.value ->> 'campaign_id') = v_campaign_id;
    if v_campaign_ready = 0 then
      raise exception 'delivery campaign % has no durable rows', v_campaign_id;
    end if;
    v_enriched_campaigns := v_enriched_campaigns || jsonb_build_array(
      v_campaign || jsonb_build_object(
        'leads_count', 0,
        'ready_leads_count', v_campaign_ready
      )
    );
  end loop;

  v_launch_info := p_launch_info || jsonb_build_object(
    'leads_count', 0,
    'ready_leads_count', v_row_count,
    'portal_project_id', v_project.portal_project_id,
    'portal_period_id', v_project.portal_period_id,
    'target_contacts', v_project.target_contacts,
    'delivery_schedule_days', v_project.delivery_schedule_days,
    'delivery_timezone', v_project.delivery_timezone,
    'sender_daily_capacity', v_project.sender_daily_capacity,
    'campaigns', v_enriched_campaigns
  );

  v_result := public.ve_finalize_template_launch(
    p_audit_id,
    p_template_id,
    p_launch_reservation_id,
    p_launch_status,
    v_launch_info,
    p_error,
    p_now
  );
  if coalesce((v_result ->> 'finalized')::boolean, false) is not true then
    return v_result || jsonb_build_object('delivery_rows_count', 0);
  end if;

  select qi.*
    into v_item
    from public.ve_launch_queue_items qi
   where qi.prepare_reservation_id = p_launch_reservation_id
     and qi.project_id = v_project.id
   for update;
  if not found then
    raise exception 'finalized delivery launch has no immutable queue item';
  end if;

  for v_row in select value from jsonb_array_elements(p_drip_rows)
  loop
    v_campaign_id := btrim(v_row ->> 'campaign_id');
    v_payload := v_row -> 'lead_payload';
    v_email := lower(btrim(v_payload ->> 'email'));
    v_source_row_index := (v_row ->> 'source_row_index')::numeric;
    v_drip_order := (v_row ->> 'drip_order')::numeric;

    select c.*
      into v_campaign_row
      from public.ve_launch_queue_campaigns c
     where c.item_id = v_item.id
       and c.campaign_id = v_campaign_id
     for update;
    if not found then
      raise exception 'campaign % is not a child of finalized queue item', v_campaign_id;
    end if;

    insert into public.ve_contact_delivery_rows(
      ve_project_id,
      item_id,
      campaign_row_id,
      source_row_index,
      email_normalized,
      lead_payload,
      drip_order,
      status,
      created_at,
      updated_at
    ) values (
      v_project.id,
      v_item.id,
      v_campaign_row.id,
      v_source_row_index::integer,
      v_email,
      v_payload,
      v_drip_order::bigint,
      'ready',
      p_now,
      p_now
    )
    on conflict do nothing;

    select r.*
      into v_existing_row
      from public.ve_contact_delivery_rows r
     where r.item_id = v_item.id
       and r.source_row_index = v_source_row_index::integer;
    if not found
       or v_existing_row.ve_project_id <> v_project.id
       or v_existing_row.campaign_row_id <> v_campaign_row.id
       or v_existing_row.email_normalized <> v_email
       or v_existing_row.lead_payload is distinct from v_payload
       or v_existing_row.drip_order <> v_drip_order::bigint then
      raise exception 'delivery row replay conflicts at source_row_index %', v_source_row_index;
    end if;
  end loop;

  select count(*)::integer
    into v_matched_count
    from public.ve_contact_delivery_rows r
   where r.item_id = v_item.id;
  if v_matched_count <> v_row_count then
    raise exception 'delivery row replay is not an exact immutable match';
  end if;

  if v_item.ready_leads_count not in (0, v_row_count) then
    raise exception 'queue item initial delivery supply is already different';
  end if;
  if exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = v_item.id
       and c.ready_leads_count not in (
         0,
         (select count(*)::integer
            from public.ve_contact_delivery_rows r
           where r.campaign_row_id = c.id)
       )
  ) then
    raise exception 'campaign initial delivery supply is already different';
  end if;

  update public.ve_launch_queue_campaigns c
     set ready_leads_count = counts.initial_count,
         ready_remaining_count = counts.ready_count,
         leads_count = counts.accepted_count,
         updated_at = p_now
    from (
      select r.campaign_row_id,
             count(*)::integer as initial_count,
             count(*) filter (where r.status = 'ready')::integer as ready_count,
             count(*) filter (where r.status = 'accepted')::integer as accepted_count
        from public.ve_contact_delivery_rows r
       where r.item_id = v_item.id
       group by r.campaign_row_id
    ) counts
   where c.id = counts.campaign_row_id;

  update public.ve_launch_queue_items qi
     set ready_leads_count = v_row_count,
         ready_remaining_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.item_id = v_item.id and r.status = 'ready'
         ),
         updated_at = p_now
   where qi.id = v_item.id
   returning qi.* into v_item;

  return v_result || jsonb_build_object(
    'launch_info', v_launch_info,
    'queue_item', to_jsonb(v_item),
    'delivery_rows_count', v_row_count
  );
end;
$$;

create or replace function public.ve_require_contact_delivery_rows()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_row_count integer;
  v_campaign_count integer;
begin
  select qi.*
    into v_item
    from public.ve_launch_queue_items qi
   where qi.id = new.id;
  if not found then
    return null;
  end if;
  if not exists (
    select 1
      from public.ve_projects p
     where p.id = v_item.project_id
       and p.portal_project_id is not null
  ) then
    return null;
  end if;

  select count(*)::integer
    into v_campaign_count
    from public.ve_launch_queue_campaigns c
   where c.item_id = new.id;
  select count(*)::integer
    into v_row_count
    from public.ve_contact_delivery_rows r
   where r.item_id = new.id;

  if v_campaign_count = 0 or v_row_count = 0 then
    raise exception 'bound VE2 launch requires campaign children and durable delivery rows';
  end if;
  if v_item.ready_leads_count <> v_row_count then
    raise exception 'bundle initial ready count does not match durable delivery rows';
  end if;
  if v_item.ready_remaining_count <> (
    select count(*)::integer
      from public.ve_contact_delivery_rows r
     where r.item_id = new.id and r.status = 'ready'
  ) then
    raise exception 'bundle ready remainder cache does not match durable delivery rows';
  end if;
  if exists (
    select 1
      from public.ve_launch_queue_campaigns c
     where c.item_id = new.id
       and (
         c.ready_leads_count <> (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.campaign_row_id = c.id
         )
         or c.ready_remaining_count <> (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.campaign_row_id = c.id and r.status = 'ready'
         )
         or c.leads_count <> (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.campaign_row_id = c.id and r.status = 'accepted'
         )
       )
  ) then
    raise exception 'campaign delivery counters do not match durable rows';
  end if;

  return null;
end;
$$;

create or replace function public.ve_bind_contact_delivery_plan(
  p_ve_project_id uuid,
  p_portal_project_id uuid,
  p_expected_portal_period_id uuid,
  p_target_contacts integer,
  p_schedule_days smallint[],
  p_timezone text,
  p_sender_daily_capacity integer,
  p_bound_by uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.ve_projects%rowtype;
  v_period public.project_periods%rowtype;
  v_days smallint[];
  v_timezone text;
begin
  if p_ve_project_id is null
     or p_portal_project_id is null
     or p_bound_by is null
     or p_now is null then
    raise exception 'VE project, Portal project/period, actor and timestamp are required';
  end if;
  if p_target_contacts is null or p_target_contacts <= 0 then
    raise exception 'target_contacts must be an exact positive integer';
  end if;
  if p_sender_daily_capacity is null or p_sender_daily_capacity <= 0 then
    raise exception 'sender daily capacity must be positive';
  end if;

  v_days := public.ve_normalize_delivery_schedule_days(p_schedule_days);
  if cardinality(v_days) = 0
     or not (v_days <@ array[1,2,3,4,5]::smallint[]) then
    raise exception 'schedule_days must contain only weekdays in 1..5';
  end if;
  v_timezone := nullif(btrim(p_timezone), '');
  if v_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone
  ) then
    raise exception 'delivery timezone is not a known IANA timezone: %', p_timezone;
  end if;

  select p.*
    into v_project
    from public.ve_projects p
   where p.id = p_ve_project_id
   for update;
  if not found then
    raise exception 'VE2 project not found';
  end if;
  if v_project.launch_preset_id is null then
    raise exception 'launch preset must be bound before the contact delivery plan';
  end if;

  -- Once persisted, an exact retry returns the immutable snapshot even if
  -- the operational period later closes. Launch/reserve independently require
  -- that the same bound period is still active.
  if v_project.portal_project_id is not null then
    if v_project.portal_project_id = p_portal_project_id
       and v_project.portal_period_id is not distinct from p_expected_portal_period_id
       and v_project.target_contacts = p_target_contacts
       and v_project.delivery_schedule_days = v_days
       and v_project.delivery_timezone = v_timezone
       and v_project.sender_daily_capacity = p_sender_daily_capacity then
      return jsonb_build_object(
        'bound', true,
        'replayed', true,
        'delivery_plan', jsonb_build_object(
          'portal_project_id', v_project.portal_project_id,
          'portal_period_id', v_project.portal_period_id,
          'target_contacts', v_project.target_contacts,
          'delivery_schedule_days', v_project.delivery_schedule_days,
          'delivery_timezone', v_project.delivery_timezone,
          'sender_daily_capacity', v_project.sender_daily_capacity,
          'delivery_plan_bound_at', v_project.delivery_plan_bound_at,
          'delivery_plan_bound_by', v_project.delivery_plan_bound_by
        )
      );
    end if;
    raise exception 'VE2 project already has a different immutable contact delivery plan';
  end if;

  if p_expected_portal_period_id is not null then
    select pp.*
      into v_period
      from public.project_periods pp
     where pp.id = p_expected_portal_period_id
       and pp.project_id = p_portal_project_id
       and pp.status = 'active'
     for share;
    if not found then
      raise exception 'expected Portal project period is not active';
    end if;
  else
    select t.deadline, t.contacts_done
      into v_period.deadline, v_period.contacts_done
      from public.ve_contact_delivery_term(p_portal_project_id, null, p_ve_project_id) t
     where t.status = 'active';
    if not found then
      raise exception 'Portal project without periods is not launchable: it has periods, a non-working status, no ISO deadline or does not exist';
    end if;
  end if;
  if v_period.deadline is null then
    raise exception 'active Portal project period has no deadline';
  end if;
  if v_period.contacts_done is null
     or btrim(v_period.contacts_done) !~ '^[0-9]+$'
     or btrim(v_period.contacts_done)::numeric > 9223372036854775807::numeric then
    raise exception 'active Portal project period has no exact numeric contacts_done fact';
  end if;
  if v_period.deadline < timezone(v_timezone, p_now)::date then
    raise exception 'active Portal project period deadline has passed';
  end if;
  if not exists (
    select 1
      from generate_series(
        0,
        v_period.deadline - timezone(v_timezone, p_now)::date
      ) as day(day_offset)
     where extract(
       dow from timezone(v_timezone, p_now)::date + day.day_offset
     )::smallint = any(v_days)
  ) then
    raise exception 'delivery schedule has no allowed days through the period deadline';
  end if;

  if exists (
    select 1 from public.ve_launch_queue_items qi where qi.project_id = p_ve_project_id
  ) then
    raise exception 'contact delivery plan must be bound before launch preparation';
  end if;

  update public.ve_projects p
     set portal_project_id = p_portal_project_id,
         portal_period_id = p_expected_portal_period_id,
         target_contacts = p_target_contacts,
         delivery_schedule_days = v_days,
         delivery_timezone = v_timezone,
         sender_daily_capacity = p_sender_daily_capacity,
         delivery_plan_bound_at = p_now,
         delivery_plan_bound_by = p_bound_by,
         updated_at = p_now
   where p.id = p_ve_project_id
   returning p.* into v_project;

  return jsonb_build_object(
    'bound', true,
    'replayed', false,
    'delivery_plan', jsonb_build_object(
      'portal_project_id', v_project.portal_project_id,
      'portal_period_id', v_project.portal_period_id,
      'target_contacts', v_project.target_contacts,
      'delivery_schedule_days', v_project.delivery_schedule_days,
      'delivery_timezone', v_project.delivery_timezone,
      'sender_daily_capacity', v_project.sender_daily_capacity,
      'delivery_plan_bound_at', v_project.delivery_plan_bound_at,
      'delivery_plan_bound_by', v_project.delivery_plan_bound_by
    )
  );
exception
  when unique_violation then
    if p_expected_portal_period_id is null then
      raise exception 'Portal project without periods already belongs to another VE2 delivery plan';
    end if;
    raise exception 'Portal period already belongs to another VE2 delivery plan';
end;
$$;

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
     and row_value.status = 'ready';

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

  -- Dense per-bundle drip_order is a durable virtual progress counter. Dividing
  -- by the immutable potential weight interleaves active hypotheses without
  -- resetting already consumed progress every day. A newly active hypothesis
  -- starts at zero and catches up. Seasonality controls admission to active;
  -- its/manual portfolio priorities are deterministic ties, not extra quota.
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
       order by fair_progress,
                qi.manual_order asc nulls last,
                qi.latest_activation_at asc nulls last,
                case qi.seasonality_confidence
                  when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0
                end desc,
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

create or replace function public.ve_reserve_contact_delivery_activation_before_supply(
  p_item_id uuid,
  p_campaign_id text,
  p_attempt_id uuid,
  p_remote_status integer,
  p_status_observed_at timestamptz,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_campaign public.ve_launch_queue_campaigns%rowtype;
  v_attempt public.ve_contact_delivery_activation_attempts%rowtype;
  v_accepted integer;
  v_watermark integer;
begin
  if p_item_id is null or p_attempt_id is null
     or nullif(btrim(p_campaign_id), '') is null or p_now is null
     or p_remote_status is null or p_remote_status not in (0,2,3)
     or p_status_observed_at is null
     or p_status_observed_at < p_now - interval '5 minutes'
     or p_status_observed_at > p_now + interval '1 minute' then
    raise exception 'activation requires exact identity and fresh draft/paused/completed proof';
  end if;
  select q.* into v_item from public.ve_launch_queue_items q
   where q.id = p_item_id for update;
  if not found then raise exception 'activation bundle not found'; end if;
  select c.* into v_campaign from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id and c.campaign_id = btrim(p_campaign_id)
   for update;
  if not found then raise exception 'activation campaign is not a child of bundle'; end if;

  select a.* into v_attempt from public.ve_contact_delivery_activation_attempts a
   where a.id = p_attempt_id;
  if found then
    if v_attempt.item_id <> p_item_id or v_attempt.campaign_row_id <> v_campaign.id then
      raise exception 'activation attempt UUID belongs to another campaign';
    end if;
    return jsonb_build_object('reserved', false, 'replayed', true,
      'attempt_id', v_attempt.id, 'campaign_id', v_campaign.campaign_id,
      'accepted_count', v_attempt.accepted_count, 'activation_status', v_attempt.status);
  end if;
  if v_item.status <> 'active' or not exists (
    select 1 from public.ve_projects p
    cross join lateral public.ve_contact_delivery_term(p.portal_project_id, p.portal_period_id, p.id) pp
     where p.id = v_item.project_id
       and pp.status = 'active'
       and pp.contacts_done is not null
       and btrim(pp.contacts_done) ~ '^[0-9]+$'
       and case when btrim(pp.contacts_done) ~ '^[0-9]+$'
                then btrim(pp.contacts_done)::numeric < p.target_contacts
                else false end
       and pp.deadline >= timezone(p.delivery_timezone, p_now)::date
       and extract(dow from timezone(p.delivery_timezone, p_now))::smallint
           = any(p.delivery_schedule_days)
  ) then
    return jsonb_build_object('reserved', false, 'replayed', false, 'reason', 'delivery_not_active');
  end if;

  select a.* into v_attempt from public.ve_contact_delivery_activation_attempts a
   where a.campaign_row_id = v_campaign.id and a.status in ('attempting','uncertain')
   order by a.started_at desc limit 1;
  if found then
    return jsonb_build_object('reserved', false, 'replayed', true,
      'attempt_id', v_attempt.id, 'campaign_id', v_campaign.campaign_id,
      'accepted_count', v_attempt.accepted_count, 'activation_status', v_attempt.status,
      'reason', 'activation_outcome_uncertain');
  end if;
  if p_remote_status in (0,2) and v_campaign.activated_at is not null then
    return jsonb_build_object('reserved', false, 'replayed', false, 'reason', 'previously_started_campaign_paused');
  end if;
  if exists (
    select 1 from public.ve_contact_delivery_rows r
     where r.campaign_row_id = v_campaign.id and r.status in ('attempting','uncertain')
  ) then
    return jsonb_build_object('reserved', false, 'replayed', false, 'reason', 'upload_outcome_uncertain');
  end if;
  select count(*)::integer into v_accepted from public.ve_contact_delivery_rows r
   where r.campaign_row_id = v_campaign.id and r.status = 'accepted';
  select coalesce(max(a.accepted_count), 0) into v_watermark
    from public.ve_contact_delivery_activation_attempts a
   where a.campaign_row_id = v_campaign.id;
  if v_accepted <= v_watermark then
    return jsonb_build_object('reserved', false, 'replayed', false, 'reason', 'no_new_accepted_contacts');
  end if;

  insert into public.ve_contact_delivery_activation_attempts(
    id, item_id, campaign_row_id, campaign_id, accepted_count, status,
    observed_status, observed_at, started_at
  ) values (
    p_attempt_id, p_item_id, v_campaign.id, v_campaign.campaign_id, v_accepted,
    'attempting', p_remote_status, p_status_observed_at, p_now
  );
  return jsonb_build_object('reserved', true, 'replayed', false,
    'attempt_id', p_attempt_id, 'campaign_id', v_campaign.campaign_id,
    'accepted_count', v_accepted, 'activation_status', 'attempting');
end;
$$;

create or replace function public.ve_reconcile_launch_campaign_statuses(
  p_item_id uuid,
  p_campaigns jsonb,
  p_now timestamptz,
  p_max_observation_age interval default interval '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_observation record;
  v_campaign_count integer;
  v_all_completed boolean;
  v_all_active_or_completed boolean;
  v_any_active boolean;
  v_any_completed boolean;
  v_all_paused boolean;
  v_all_delivery_runnable boolean;
  v_delivery_authorized boolean;
  v_delivery_pending boolean;
  v_seen_campaign_ids text[] := '{}'::text[];
begin
  if p_item_id is null or p_now is null then
    raise exception 'item and timestamp are required';
  end if;
  if p_campaigns is null
     or jsonb_typeof(p_campaigns) <> 'array'
     or jsonb_array_length(p_campaigns) = 0 then
    raise exception 'campaign observations must be a non-empty array';
  end if;
  if p_max_observation_age is null or p_max_observation_age < interval '0 seconds' then
    raise exception 'max observation age must be non-negative';
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;
  if not found then
    return jsonb_build_object('reconciled', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_item.instantly_account_id || ':' || m.mailbox_id, 28082032)
  )
    from unnest(v_item.mailbox_ids) as m(mailbox_id)
   order by m.mailbox_id;
  perform pg_advisory_xact_lock(hashtextextended(p_item_id::text, 28082033));

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('reconciled', false, 'code', 'VE_LAUNCH_ITEM_NOT_FOUND');
  end if;

  for v_observation in
    select *
      from jsonb_to_recordset(p_campaigns)
        as x(campaign_id text, status integer, status_observed_at timestamptz)
  loop
    if nullif(btrim(v_observation.campaign_id), '') is null
       or v_observation.status is null
       or v_observation.status not in (-99,-2,-1,0,1,2,3,4)
       or v_observation.status_observed_at is null
       or v_observation.status_observed_at > p_now + interval '1 minute' then
      raise exception 'invalid campaign observation';
    end if;
    if v_observation.campaign_id = any(v_seen_campaign_ids) then
      raise exception 'duplicate campaign observation: %', v_observation.campaign_id;
    end if;
    v_seen_campaign_ids := array_append(v_seen_campaign_ids, v_observation.campaign_id);

    if not exists (
      select 1
        from public.ve_launch_queue_campaigns c
       where c.item_id = p_item_id
         and c.campaign_id = v_observation.campaign_id
    ) then
      raise exception 'campaign % does not belong to bundle %', v_observation.campaign_id, p_item_id;
    end if;

    update public.ve_launch_queue_campaigns
       set remote_status = v_observation.status,
           status_observed_at = v_observation.status_observed_at,
           activated_at = case
             when v_observation.status in (1,3,4)
               then coalesce(activated_at, v_observation.status_observed_at)
             else activated_at
           end,
           completed_at = case
             when v_observation.status = 3
               then coalesce(completed_at, v_observation.status_observed_at)
             else completed_at
           end,
           updated_at = p_now
     where item_id = p_item_id
       and campaign_id = v_observation.campaign_id
       and (
         status_observed_at is null
         or status_observed_at <= v_observation.status_observed_at
       );
  end loop;

  select count(*)::integer
    into v_campaign_count
    from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id;
  if cardinality(v_seen_campaign_ids) <> v_campaign_count then
    raise exception 'campaign observations are not the exact bundle set for %', p_item_id;
  end if;

  select
    bool_and(
      c.remote_status = 3
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_and(
      c.remote_status in (1,3,4)
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_or(
      c.remote_status in (1,4)
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_or(
      c.remote_status = 3
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    ),
    bool_and(
      c.remote_status = 2
      and c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    )
    into v_all_completed, v_all_active_or_completed, v_any_active, v_any_completed, v_all_paused
    from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id;

  select bool_and(
      c.remote_status in (1,3,4)
      or (
        c.remote_status in (0,2) and c.activated_at is null
        and exists (
          select 1 from public.ve_contact_delivery_rows r
           where r.campaign_row_id = c.id
             and r.status in ('ready','reserved','attempting','accepted','uncertain')
        )
      )
    ) and bool_and(
      c.status_observed_at is not null
      and c.status_observed_at >= p_now - p_max_observation_age
    )
    into v_all_delivery_runnable
    from public.ve_launch_queue_campaigns c
    join public.ve_launch_queue_items qi on qi.id = c.item_id
    join public.ve_projects p on p.id = qi.project_id
   where c.item_id = p_item_id and p.portal_project_id is not null;

  -- A known fulfilled/closed/expired contract no longer authorizes new waves.
  -- Missing or malformed facts remain fail-closed and keep the slot; they are
  -- not evidence that the contact obligation is complete.
  select case
      when pp.status <> 'active' then false
      when pp.deadline < timezone(p.delivery_timezone, p_now)::date then false
      when btrim(pp.contacts_done) ~ '^[0-9]+$' then
        btrim(pp.contacts_done)::numeric < p.target_contacts
      else true
    end
    into v_delivery_authorized
    from public.ve_projects p
    cross join lateral public.ve_contact_delivery_term(p.portal_project_id, p.portal_period_id, p.id) pp
   where p.id = v_item.project_id and p.portal_project_id is not null;

  select exists (
      select 1 from public.ve_contact_delivery_rows r
       where r.item_id = p_item_id and r.status in ('attempting','uncertain')
    ) or exists (
      select 1 from public.ve_contact_delivery_activation_attempts a
       where a.item_id = p_item_id and a.status in ('attempting','uncertain')
    ) or (
      coalesce(v_delivery_authorized, false) and (
        exists (
          select 1 from public.ve_contact_delivery_rows r
           where r.item_id = p_item_id and r.status in ('ready','reserved')
        ) or exists (
          select 1 from public.ve_launch_queue_campaigns c
           where c.item_id = p_item_id
             and c.leads_count > coalesce((
               select max(a.accepted_count)
                 from public.ve_contact_delivery_activation_attempts a
                where a.campaign_row_id = c.id and a.status = 'succeeded'
             ), 0)
        )
      )
    ) into v_delivery_pending;

  if coalesce(v_all_delivery_runnable, false)
     and v_item.status in ('prepared','queued')
     and not coalesce(v_any_active, false)
     and not coalesce(v_any_completed, false) then
    -- Draft/paused children with a durable audience have not started yet.
    -- Merely viewing the portfolio must not convert preparation to uncertain.
    null;
  elsif v_campaign_count > 0
     and coalesce(v_all_completed, false)
     and v_delivery_pending then
    -- A completed daily batch is not an exhausted hypothesis. Keep the slot
    -- until its durable audience has been processed; no provider activation
    -- occurs here. Queued preparations still require explicit activation.
    update public.ve_launch_queue_items
       set status = case
             when status in ('activating','active','uncertain') then 'active'
             else status
           end,
           activation_error = null,
           updated_at = p_now
     where id = p_item_id
     returning * into v_item;
  elsif v_campaign_count > 0
     and coalesce(v_all_completed, false) then
    update public.ve_launch_queue_items
       set status = 'released',
           ever_active_at = coalesce(ever_active_at, p_now),
           released_at = coalesce(released_at, p_now),
           release_reason = coalesce(release_reason, 'Все кампании завершены'),
           activation_error = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif (coalesce(v_all_active_or_completed, false) and coalesce(v_any_active, false))
        or (coalesce(v_all_delivery_runnable, false)
            and v_item.status in ('activating','active','uncertain')) then
    update public.ve_launch_queue_items
       set status = 'active',
           ever_active_at = coalesce(ever_active_at, p_now),
           activation_error = null,
           released_at = null,
           released_by = null,
           release_reason = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif coalesce(v_any_active, false)
        or coalesce(v_any_completed, false)
        or not coalesce(v_all_paused, false) then
    update public.ve_launch_queue_items
       set status = 'uncertain',
           ever_active_at = case
             when coalesce(v_any_active, false) or coalesce(v_any_completed, false)
               then coalesce(ever_active_at, p_now)
             else ever_active_at
           end,
           activation_error = 'Live reconciliation found a partial or inconsistent campaign state',
           released_at = null,
           released_by = null,
           release_reason = null,
           updated_at = p_now
     where id = p_item_id
       and status in ('prepared','queued','activating','active','uncertain','released')
     returning * into v_item;
  elsif coalesce(v_all_paused, false)
        and v_item.status in ('active','uncertain') then
    update public.ve_launch_queue_items
       set status = 'uncertain',
           activation_error = 'Live reconciliation found every campaign paused',
           updated_at = p_now
     where id = p_item_id
       and status in ('active','uncertain')
     returning * into v_item;
  end if;

  select q.*
    into v_item
    from public.ve_launch_queue_items q
   where q.id = p_item_id;

  return jsonb_build_object(
    'reconciled', true,
    'item', to_jsonb(v_item),
    'all_completed', coalesce(v_all_completed, false),
    'holds_slot', v_item.status in ('activating','active','uncertain')
  );
end;
$$;

create or replace function public.ve_contact_supply_approval_current(p_plan_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select
    s.approval_snapshot = public.ve_contact_supply_rules_snapshot(s.template_id,
      s.approval_snapshot->>'preset_id',(s.approval_snapshot->>'portal_project_id')::uuid,
      (s.approval_snapshot->>'portal_period_id')::uuid,(s.approval_snapshot->>'target_contacts')::integer,
      s.approval_snapshot->>'instantly_account_id')
    and (p.launch_preset_id is null or p.launch_preset_id::text=s.approval_snapshot->>'preset_id')
    and (p.launch_instantly_account_id is null or p.launch_instantly_account_id=s.approval_snapshot->>'instantly_account_id')
    and (p.portal_project_id is null or p.portal_project_id::text=s.approval_snapshot->>'portal_project_id')
    and (p.portal_project_id is null or p.portal_period_id is not distinct from (s.approval_snapshot->>'portal_period_id')::uuid)
    and (p.target_contacts is null or p.target_contacts=(s.approval_snapshot->>'target_contacts')::integer)
    and (s.item_id is not null or (s.preview_revision=public.ve_contact_supply_preview_revision(s.template_id)
      and exists(select 1 from public.ve_segmentation_audits a where a.id=s.preview_audit_id
        and a.status='ready' and a.input_hash=s.preview_audit_hash)))
    from public.ve_contact_supply_plans s join public.ve_projects p on p.id=s.project_id
    where s.id=p_plan_id),false);
$$;

create or replace function public.ve_approve_contact_supply(
  p_template_id uuid,p_audit_id uuid,p_expected_preview_revision text,p_preset_id text,
  p_portal_project_id uuid,p_portal_period_id uuid,p_target_contacts integer,
  p_instantly_account_id text,p_approved_by uuid,p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_template public.ve_templates%rowtype; v_base public.ve_bases%rowtype;
  v_audit public.ve_segmentation_audits%rowtype; v_plan public.ve_contact_supply_plans%rowtype;
  v_snapshot jsonb; v_revision text;
begin
  if p_approved_by is null or p_now is null or p_target_contacts is null or p_target_contacts<=0
     or nullif(btrim(p_preset_id),'') is null or nullif(btrim(p_instantly_account_id),'') is null then
    raise exception 'complete explicit approval identity and contact obligation required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ve-supply-template:'||p_template_id::text,0));
  select * into v_template from public.ve_templates where id=p_template_id for share;
  select * into v_base from public.ve_bases where id=v_template.base_id for share;
  if v_template.id is null or v_template.status<>'ready' or v_template.supply_batch_id is not null
     or v_base.hypothesis_id is null or v_base.collect_info->>'collection_mode' is distinct from 'preview' then
    raise exception 'approval requires a ready hypothesis preview template';
  end if;
  if v_base.status not in ('analyzing','analyzed')
    or coalesce(v_base.collect_info->'target_progress'->>'status','') not in ('target_reached','exhausted','limited')
    or coalesce((v_base.collect_info->'target_progress'->>'ready_rows')::integer,0)<=0 then
    raise exception 'approval requires a terminal preview with ready contacts';
  end if;
  if exists(select 1 from public.ve_hypotheses where id=v_base.hypothesis_id and status='rejected') then
    raise exception 'rejected hypothesis cannot approve continuous supply';
  end if;
  if not exists(select 1 from public.ve_contact_delivery_term(p_portal_project_id,p_portal_period_id,null) pp
    where pp.status='active' and pp.deadline>=p_now::date) then
    raise exception 'approval requires the explicit active Portal period';
  end if;
  select * into v_audit from public.ve_segmentation_audits where id=p_audit_id for share;
  if v_audit.id is null or v_audit.template_id<>p_template_id or v_audit.base_id<>v_base.id
     or v_audit.status<>'ready' or v_audit.input_hash is null
     or coalesce((v_audit.summary->>'unclassified_rows_total')::integer,-1)<>0 then
    raise exception 'approval requires a complete current preview audit';
  end if;
  v_revision:=public.ve_contact_supply_preview_revision(p_template_id);
  if v_revision is distinct from p_expected_preview_revision then raise exception 'preview changed during approval'; end if;
  v_snapshot:=public.ve_contact_supply_rules_snapshot(p_template_id,p_preset_id,p_portal_project_id,
    p_portal_period_id,p_target_contacts,p_instantly_account_id);
  if v_snapshot is null then raise exception 'approval targeting snapshot unavailable'; end if;
  select * into v_plan from public.ve_contact_supply_plans where template_id=p_template_id for update;
  if found then
    if v_plan.item_id is not null and v_plan.approval_snapshot is distinct from v_snapshot then
      raise exception 'launched approval rules cannot change without reviewing existing campaigns';
    end if;
    update public.ve_contact_supply_plans set approval_snapshot=v_snapshot,preview_audit_id=p_audit_id,
      preview_audit_hash=v_audit.input_hash,preview_revision=v_revision,approved_by=p_approved_by,
      approved_at=p_now,status=case when item_id is null then 'approved' else status end,updated_at=p_now
      where id=v_plan.id returning * into v_plan;
  else
    insert into public.ve_contact_supply_plans(project_id,hypothesis_id,template_id,approval_snapshot,
      preview_audit_id,preview_audit_hash,preview_revision,approved_by,approved_at,updated_at)
    values(v_base.project_id,v_base.hypothesis_id,p_template_id,v_snapshot,p_audit_id,
      v_audit.input_hash,v_revision,p_approved_by,p_now,p_now) returning * into v_plan;
  end if;
  if not public.ve_contact_supply_approval_current(v_plan.id) then raise exception 'approval conflicts with project binding'; end if;
  return to_jsonb(v_plan);
end;
$$;

create or replace function public.ve_require_contact_supply_active(p_plan_id uuid,p_now timestamptz)
returns public.ve_contact_supply_plans language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype;
begin
  select * into v_plan from public.ve_contact_supply_plans where id=p_plan_id for update;
  if not found or v_plan.status<>'active' then raise exception 'supply plan is not active (paused or stopped)'; end if;
  if not public.ve_contact_supply_approval_current(p_plan_id) then raise exception 'supply approval rules are stale'; end if;
  if not exists(select 1 from public.ve_launch_queue_items qi join public.ve_projects p on p.id=qi.project_id
    cross join lateral public.ve_contact_delivery_term(p.portal_project_id,p.portal_period_id,p.id) pp
    where qi.id=v_plan.item_id and qi.project_id=v_plan.project_id and qi.hypothesis_id=v_plan.hypothesis_id
      and qi.status='active' and qi.preset_id=p.launch_preset_id::text
      and qi.instantly_account_id=p.launch_instantly_account_id and pp.status='active'
      and pp.deadline>=timezone(p.delivery_timezone,p_now)::date
      and extract(dow from timezone(p.delivery_timezone,p_now))::smallint=any(p.delivery_schedule_days)
      and btrim(pp.contacts_done)~'^[0-9]+$' and btrim(pp.contacts_done)::numeric<p.target_contacts) then
    raise exception 'supply requires active campaign ownership and unfulfilled period';
  end if;
  return v_plan;
end;
$$;

create or replace function public.ve_append_contact_supply_batch(p_batch_id uuid,p_audit_id uuid,p_rows jsonb,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.ve_contact_supply_plans%rowtype; v_batch public.ve_contact_supply_batches%rowtype;
  v_audit public.ve_segmentation_audits%rowtype; v_template public.ve_templates%rowtype;
  v_row jsonb; v_index integer; v_payload jsonb; v_email text; v_segment text;
  v_campaign public.ve_launch_queue_campaigns%rowtype; v_order bigint; v_added integer:=0; v_count integer;
  v_seen integer[]:='{}';
begin
  if p_now is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>20000 then
    raise exception 'bounded audited supply rows required';
  end if;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id;
  if not found then raise exception 'supply batch not found'; end if;
  select * into v_plan from public.ve_contact_supply_plans where id=v_batch.plan_id for update;
  select * into v_batch from public.ve_contact_supply_batches where id=p_batch_id for update;
  if v_batch.status='appended' then
    if v_batch.audit_id is distinct from p_audit_id or v_batch.append_snapshot is distinct from p_rows then
      raise exception 'supply append replay differs from original snapshot';
    end if;
    return jsonb_build_object('appended_count',v_batch.appended_count,'replayed',true);
  end if;
  v_plan:=public.ve_require_contact_supply_active(v_plan.id,p_now);
  if v_batch.rules_snapshot is distinct from v_plan.approval_snapshot then raise exception 'batch approval rules changed'; end if;
  select * into v_audit from public.ve_segmentation_audits where id=p_audit_id for share;
  select * into v_template from public.ve_templates where id=v_batch.template_id for share;
  if v_batch.status not in ('auditing','ready') or v_batch.audit_id is distinct from p_audit_id
    or v_audit.template_id is distinct from v_batch.template_id or v_audit.base_id is distinct from v_batch.base_id
    or v_audit.status is distinct from 'ready' or v_audit.supply_leads is null
    or v_audit.supply_source_revision is distinct from public.ve_contact_supply_preview_revision(v_batch.template_id)
    or v_template.letters is distinct from v_plan.approval_snapshot->'letters'
    or v_template.personalization_plan is distinct from v_plan.approval_snapshot->'mapping'
    or coalesce((v_audit.summary->>'unclassified_rows_total')::integer,-1)<>0
    or jsonb_array_length(v_audit.assignments)<>jsonb_array_length(v_audit.supply_leads) then
    raise exception 'complete current audited supply snapshot required';
  end if;
  -- The shared period lock serializes append with today's selection. Project
  -- email uniqueness is still the final authority across different plans.
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(
    (v_plan.approval_snapshot->>'portal_project_id')::uuid,(v_plan.approval_snapshot->>'portal_period_id')::uuid));
  perform 1 from public.ve_launch_queue_items where id=v_plan.item_id for update;
  select coalesce(max(drip_order)+1,0) into v_order from public.ve_contact_delivery_rows where item_id=v_plan.item_id;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row->'source_row_index') is distinct from 'number'
      or (v_row->>'source_row_index')::numeric<0 or trunc((v_row->>'source_row_index')::numeric)<>(v_row->>'source_row_index')::numeric then
      raise exception 'supply row requires exact nonnegative source index';
    end if;
    v_index:=(v_row->>'source_row_index')::integer;
    if v_index=any(v_seen) or v_index>=jsonb_array_length(v_audit.supply_leads) then raise exception 'duplicate or unknown audited source index'; end if;
    v_seen:=array_append(v_seen,v_index); v_payload:=v_row->'lead_payload';
    if v_payload is distinct from v_audit.supply_leads->v_index then raise exception 'supply payload differs from audited source'; end if;
    v_email:=lower(nullif(btrim(v_payload->>'email'),''));
    if v_email is null or (v_row?'email_normalized' and v_row->>'email_normalized' is distinct from v_email) then
      raise exception 'supply email identity mismatch';
    end if;
    select count(*)::integer,min(a.value->>'segment') into v_count,v_segment
      from jsonb_array_elements(v_audit.assignments) a(value) where (a.value->>'row_index')::integer=v_index;
    if v_count<>1 then raise exception 'supply assignment missing or ambiguous'; end if;
    select * into v_campaign from public.ve_launch_queue_campaigns where item_id=v_plan.item_id and campaign_id=v_row->>'campaign_id' for update;
    if not found or v_campaign.segment is distinct from v_segment then raise exception 'supply campaign does not match audited segment'; end if;
    insert into public.ve_contact_delivery_rows(ve_project_id,item_id,campaign_row_id,source_row_index,
      supply_batch_id,email_normalized,lead_payload,drip_order,status,created_at,updated_at)
    values(v_plan.project_id,v_plan.item_id,v_campaign.id,v_index,p_batch_id,v_email,v_payload,v_order,'ready',p_now,p_now)
    on conflict(ve_project_id,email_normalized) do nothing;
    get diagnostics v_count=row_count;
    v_added:=v_added+v_count; v_order:=v_order+v_count;
  end loop;
  update public.ve_contact_supply_batches set status='appended',appended_count=v_added,
    append_snapshot=p_rows,updated_at=p_now where id=p_batch_id;
  -- Counters are cumulative after replenishment; the original template's
  -- launch_info.ready_leads_count remains the immutable initial approval fact.
  update public.ve_launch_queue_campaigns c set
    ready_leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id),
    ready_remaining_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id and r.status='ready'),
    leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.campaign_row_id=c.id and r.status='accepted'),updated_at=p_now
    where c.item_id=v_plan.item_id;
  update public.ve_launch_queue_items qi set
    ready_leads_count=(select count(*) from public.ve_contact_delivery_rows r where r.item_id=qi.id),
    ready_remaining_count=(select count(*) from public.ve_contact_delivery_rows r where r.item_id=qi.id and r.status='ready'),updated_at=p_now
    where qi.id=v_plan.item_id;
  return jsonb_build_object('appended_count',v_added,'replayed',false);
end;
$$;

create or replace function public.ve_hold_continuous_supply_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status in ('active','activating','uncertain') and new.status='released'
    and new.release_reason='Все кампании завершены'
    and exists(select 1 from public.ve_contact_supply_plans s join public.ve_projects p on p.id=s.project_id
      cross join lateral public.ve_contact_delivery_term(p.portal_project_id,p.portal_period_id,p.id) pp
      where s.item_id=old.id and s.status='active' and public.ve_contact_supply_approval_current(s.id)
        and pp.status='active' and pp.deadline>=timezone(p.delivery_timezone,new.updated_at)::date
        and btrim(pp.contacts_done)~'^[0-9]+$' and btrim(pp.contacts_done)::numeric<p.target_contacts) then
    new.status:='active'; new.released_at:=old.released_at; new.release_reason:=old.release_reason;
  end if;
  return new;
end;
$$;

create or replace function public.ve_reserve_contact_delivery_day(p_ve_project_id uuid,p_now timestamptz,p_observed_ve_first_contacted bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_period uuid; v_portal_project uuid; v_result jsonb; v_date date; v_continuous boolean;
begin
  select portal_project_id,portal_period_id,timezone(delivery_timezone,p_now)::date into v_portal_project,v_period,v_date from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_portal_project,v_period));
  if exists(select 1 from public.ve_contact_supply_plans s join public.ve_launch_queue_items qi on qi.id=s.item_id
    where s.project_id=p_ve_project_id and qi.status='active' and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale; delivery stopped before provider work';
  end if;
  select exists(select 1 from public.ve_contact_supply_plans where project_id=p_ve_project_id) into v_continuous;
  if v_continuous then
    -- Only zero-work observations may reopen. Attempted/reserved/uncertain days
    -- retain the original immutable quota and all provider fences.
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

-- Helpers are internal: reached only from the SECURITY DEFINER delivery RPCs.
revoke all on function public.ve_try_iso_date(text)
  from public, anon, authenticated, service_role;
revoke all on function public.ve_contact_delivery_lock_key(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ve_contact_delivery_term(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.ve_try_iso_date(text) to postgres;
grant execute on function public.ve_contact_delivery_lock_key(uuid, uuid) to postgres;
grant execute on function public.ve_contact_delivery_term(uuid, uuid, uuid) to postgres;
