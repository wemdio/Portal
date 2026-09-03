-- Vertical Engine v2: explicit Portal-period delivery plan and durable daily
-- contact drip. Provider acceptance is a technical upload ledger only;
-- project_periods.contacts_done remains the first-contacted fulfillment fact.
--
-- The existing VE2 refill budget tables intentionally remain independent.

-- A composite target lets every delivery reference prove that the period
-- belongs to the explicitly selected Portal project.
create unique index if not exists project_periods_project_id_id_key
  on public.project_periods(project_id, id);

create or replace function public.ve_normalize_delivery_schedule_days(
  p_days smallint[]
)
returns smallint[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct d order by d), '{}'::smallint[])
    from unnest(coalesce(p_days, '{}'::smallint[])) as value(d)
   where d is not null
$$;

revoke all on function public.ve_normalize_delivery_schedule_days(smallint[])
  from public, anon, authenticated, service_role;
grant execute on function public.ve_normalize_delivery_schedule_days(smallint[])
  to service_role, postgres;

alter table public.ve_projects
  add column if not exists portal_project_id uuid,
  add column if not exists portal_period_id uuid,
  add column if not exists target_contacts integer,
  add column if not exists delivery_schedule_days smallint[],
  add column if not exists delivery_timezone text,
  add column if not exists sender_daily_capacity integer,
  add column if not exists delivery_plan_bound_at timestamptz,
  add column if not exists delivery_plan_bound_by uuid;

alter table public.ve_projects
  drop constraint if exists ve_projects_delivery_plan_all_or_none,
  drop constraint if exists ve_projects_delivery_schedule_canonical,
  drop constraint if exists ve_projects_portal_period_project_fkey;

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
      and portal_period_id is not null
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
  add constraint ve_projects_portal_period_project_fkey
  foreign key (portal_project_id, portal_period_id)
  references public.project_periods(project_id, id)
  on delete restrict;

create unique index if not exists ve_projects_one_delivery_plan_per_period
  on public.ve_projects(portal_period_id)
  where portal_period_id is not null;

comment on column public.ve_projects.portal_project_id is
  'Explicit Portal project that owns this VE2 delivery plan; never inferred by name.';
comment on column public.ve_projects.portal_period_id is
  'Explicit active Portal period whose first-contacted fact drives remaining obligation.';
comment on column public.ve_projects.target_contacts is
  'Exact specialist-confirmed target. Legacy text obligation ranges are never parsed.';
comment on column public.ve_projects.delivery_schedule_days is
  'Immutable weekday intersection of the preset schedule; DOW 1=Monday..5=Friday.';
comment on column public.ve_projects.delivery_timezone is
  'Immutable IANA timezone snapshot from the selected launch preset.';
comment on column public.ve_projects.sender_daily_capacity is
  'Immutable positive daily sender capacity snapshot from the selected launch preset.';

-- Initial prepared supply and current ready supply are deliberately separate.
-- leads_count remains the accepted/uploaded technical count.
alter table public.ve_launch_queue_items
  add column if not exists ready_leads_count integer not null default 0,
  add column if not exists ready_remaining_count integer not null default 0;

alter table public.ve_launch_queue_items
  drop constraint if exists ve_launch_queue_items_ready_leads_nonnegative,
  drop constraint if exists ve_launch_queue_items_ready_remaining_nonnegative,
  add constraint ve_launch_queue_items_ready_leads_nonnegative
    check (ready_leads_count >= 0),
  add constraint ve_launch_queue_items_ready_remaining_nonnegative
    check (ready_remaining_count >= 0 and ready_remaining_count <= ready_leads_count);

alter table public.ve_launch_queue_campaigns
  add column if not exists ready_leads_count integer not null default 0,
  add column if not exists ready_remaining_count integer not null default 0;

alter table public.ve_launch_queue_campaigns
  drop constraint if exists ve_launch_queue_campaigns_ready_leads_nonnegative,
  drop constraint if exists ve_launch_queue_campaigns_ready_remaining_nonnegative,
  add constraint ve_launch_queue_campaigns_ready_leads_nonnegative
    check (ready_leads_count >= 0),
  add constraint ve_launch_queue_campaigns_ready_remaining_nonnegative
    check (ready_remaining_count >= 0 and ready_remaining_count <= ready_leads_count);

comment on column public.ve_launch_queue_items.ready_leads_count is
  'Immutable initial durable delivery supply for the bundle.';
comment on column public.ve_launch_queue_items.ready_remaining_count is
  'Current rows in ready state; maintained transactionally by delivery RPCs.';
comment on column public.ve_launch_queue_campaigns.ready_leads_count is
  'Immutable initial durable delivery supply for the campaign child.';
comment on column public.ve_launch_queue_campaigns.ready_remaining_count is
  'Current rows in ready state for the campaign child.';
comment on column public.ve_launch_queue_campaigns.leads_count is
  'Rows confirmed accepted by the provider; not the first-contacted fulfillment fact.';

create unique index if not exists ve_launch_queue_items_project_id_id_key
  on public.ve_launch_queue_items(project_id, id);
create unique index if not exists ve_launch_queue_campaigns_item_id_id_key
  on public.ve_launch_queue_campaigns(item_id, id);

create table public.ve_contact_delivery_daily_runs (
  id                       uuid primary key default gen_random_uuid(),
  ve_project_id            uuid not null references public.ve_projects(id) on delete restrict,
  portal_project_id        uuid not null,
  portal_period_id         uuid not null,
  run_date                 date not null,
  reservation_status       text not null
    check (reservation_status in ('reserved','not_scheduled','fulfilled','no_ready_rows','awaiting_delivery')),
  status                   text not null
    check (status in ('reserved','attempting','completed','uncertain')),
  target_contacts          integer not null check (target_contacts > 0),
  actual_first_contacted   bigint not null check (actual_first_contacted >= 0),
  observed_ve_first_contacted bigint not null check (observed_ve_first_contacted >= 0),
  committed_count          integer not null check (committed_count >= 0),
  outstanding_count        integer not null check (outstanding_count >= 0),
  upload_headroom          integer not null check (upload_headroom >= 0),
  deadline                 date not null,
  schedule_days            smallint[] not null,
  timezone                 text not null,
  sender_daily_capacity    integer not null check (sender_daily_capacity > 0),
  remaining_contacts       integer not null check (remaining_contacts >= 0),
  remaining_workdays       integer not null check (remaining_workdays >= 0),
  required_daily           integer not null check (required_daily >= 0),
  ready_remaining          integer not null check (ready_remaining >= 0),
  effective_count          integer not null check (effective_count >= 0),
  reserved_count           integer not null default 0 check (reserved_count >= 0),
  accepted_count           integer not null default 0 check (accepted_count >= 0),
  skipped_count            integer not null default 0 check (skipped_count >= 0),
  uncertain_count          integer not null default 0 check (uncertain_count >= 0),
  released_count           integer not null default 0 check (released_count >= 0),
  error                    text,
  reserved_at              timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  foreign key (portal_project_id, portal_period_id)
    references public.project_periods(project_id, id) on delete restrict,
  unique (portal_period_id, run_date),
  check (schedule_days = public.ve_normalize_delivery_schedule_days(schedule_days)),
  check (cardinality(schedule_days) between 1 and 5),
  check (schedule_days <@ array[1,2,3,4,5]::smallint[]),
  check (nullif(btrim(timezone), '') is not null),
  check (effective_count <= required_daily),
  check (effective_count <= sender_daily_capacity),
  check (effective_count <= ready_remaining),
  check (effective_count <= upload_headroom),
  check (reserved_count = effective_count),
  check (
    accepted_count + skipped_count + uncertain_count + released_count
    <= reserved_count
  ),
  check (
    (reservation_status = 'reserved' and reserved_count > 0 and reserved_at is not null)
    or
    (reservation_status <> 'reserved' and reserved_count = 0 and status = 'completed')
  )
);

create index ve_contact_delivery_daily_runs_project_date
  on public.ve_contact_delivery_daily_runs(ve_project_id, run_date desc);

create table public.ve_contact_delivery_attempts (
  id                 uuid primary key,
  run_id             uuid not null references public.ve_contact_delivery_daily_runs(id) on delete restrict,
  campaign_row_id    uuid not null references public.ve_launch_queue_campaigns(id) on delete restrict,
  campaign_id        text not null,
  row_ids            uuid[] not null,
  status             text not null default 'attempting'
    check (status in ('attempting','finalized')),
  accepted_row_ids   uuid[] not null default '{}'::uuid[],
  skipped_row_ids    uuid[] not null default '{}'::uuid[],
  uncertain_row_ids  uuid[] not null default '{}'::uuid[],
  released_row_ids   uuid[] not null default '{}'::uuid[],
  error              text,
  started_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (nullif(btrim(campaign_id), '') is not null),
  check (cardinality(row_ids) > 0),
  check (
    (status = 'attempting' and finalized_at is null)
    or (status = 'finalized' and finalized_at is not null)
  )
);

create index ve_contact_delivery_attempts_run
  on public.ve_contact_delivery_attempts(run_id, created_at);

-- A provider activation fence is distinct from an upload fence. A new wave
-- requires a strictly larger accepted-row watermark; ambiguous activation
-- is never retried until live reconciliation confirms the original attempt.
create table public.ve_contact_delivery_activation_attempts (
  id                 uuid primary key,
  item_id            uuid not null references public.ve_launch_queue_items(id) on delete restrict,
  campaign_row_id    uuid not null references public.ve_launch_queue_campaigns(id) on delete restrict,
  campaign_id        text not null,
  accepted_count     integer not null check (accepted_count > 0),
  status             text not null check (status in ('attempting','succeeded','uncertain')),
  observed_status    integer not null check (observed_status in (0,2,3)),
  observed_at        timestamptz not null,
  started_at         timestamptz not null,
  completed_at       timestamptz,
  error              text,
  unique (campaign_row_id, accepted_count),
  foreign key (item_id, campaign_row_id)
    references public.ve_launch_queue_campaigns(item_id, id) on delete restrict,
  check ((status = 'attempting' and completed_at is null)
      or (status in ('succeeded','uncertain') and completed_at is not null))
);
create index ve_contact_delivery_activation_attempts_pending
  on public.ve_contact_delivery_activation_attempts(campaign_row_id, status);

create table public.ve_contact_delivery_rows (
  id                 uuid primary key default gen_random_uuid(),
  ve_project_id      uuid not null references public.ve_projects(id) on delete restrict,
  item_id            uuid not null references public.ve_launch_queue_items(id) on delete restrict,
  campaign_row_id    uuid not null references public.ve_launch_queue_campaigns(id) on delete restrict,
  source_row_index   integer not null check (source_row_index >= 0),
  email_normalized   text not null,
  lead_payload       jsonb not null check (jsonb_typeof(lead_payload) = 'object'),
  drip_order         bigint not null check (drip_order >= 0),
  status             text not null default 'ready'
    check (status in ('ready','reserved','attempting','accepted','skipped','uncertain')),
  run_id             uuid references public.ve_contact_delivery_daily_runs(id) on delete restrict,
  attempt_id         uuid references public.ve_contact_delivery_attempts(id) on delete restrict,
  last_error         text,
  reserved_at        timestamptz,
  attempted_at       timestamptz,
  finalized_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (item_id, source_row_index),
  unique (ve_project_id, email_normalized),
  unique (item_id, drip_order),
  foreign key (ve_project_id, item_id)
    references public.ve_launch_queue_items(project_id, id) on delete restrict,
  foreign key (item_id, campaign_row_id)
    references public.ve_launch_queue_campaigns(item_id, id) on delete restrict,
  check (nullif(btrim(email_normalized), '') is not null),
  check (nullif(btrim(lead_payload ->> 'email'), '') is not null),
  check (email_normalized = lower(btrim(lead_payload ->> 'email'))),
  check (
    (status = 'ready'
      and run_id is null and attempt_id is null
      and reserved_at is null and attempted_at is null and finalized_at is null)
    or
    (status = 'reserved'
      and run_id is not null and attempt_id is null
      and reserved_at is not null and attempted_at is null and finalized_at is null)
    or
    (status = 'attempting'
      and run_id is not null and attempt_id is not null
      and reserved_at is not null and attempted_at is not null and finalized_at is null)
    or
    (status in ('accepted','skipped','uncertain')
      and run_id is not null and attempt_id is not null
      and reserved_at is not null and attempted_at is not null and finalized_at is not null)
  )
);

create index ve_contact_delivery_rows_ready
  on public.ve_contact_delivery_rows(ve_project_id, status, drip_order, id);
create index ve_contact_delivery_rows_run
  on public.ve_contact_delivery_rows(run_id, status);
create index ve_contact_delivery_rows_attempt
  on public.ve_contact_delivery_rows(attempt_id);

comment on table public.ve_contact_delivery_daily_runs is
  'One frozen local-day obligation calculation and durable reservation per Portal period.';
comment on table public.ve_contact_delivery_attempts is
  'Provider-call fence and exact replay record. The caller supplies the UUID before I/O.';
comment on table public.ve_contact_delivery_rows is
  'Row-level VE2 drip ledger. Terminal upload states never change fulfillment contacts_done.';

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
     where p.id = new.project_id and p.portal_period_id is not null
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
     where qi.id = new.item_id and p.portal_period_id is not null
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

drop trigger if exists ve_launch_queue_items_guard_delivery_counters
  on public.ve_launch_queue_items;
create trigger ve_launch_queue_items_guard_delivery_counters
before update of ready_leads_count, ready_remaining_count
on public.ve_launch_queue_items
for each row execute function public.ve_guard_contact_delivery_item_counters();

drop trigger if exists ve_launch_queue_campaigns_guard_delivery_counters
  on public.ve_launch_queue_campaigns;
create trigger ve_launch_queue_campaigns_guard_delivery_counters
before update of ready_leads_count, ready_remaining_count, leads_count
on public.ve_launch_queue_campaigns
for each row execute function public.ve_guard_contact_delivery_campaign_counters();

create or replace function public.ve_guard_contact_delivery_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bound boolean;
begin
  v_bound := new.portal_period_id is not null;

  if tg_op = 'UPDATE' and old.portal_period_id is not null and (
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

  if v_bound and (tg_op = 'INSERT' or old.portal_period_id is null) then
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
    if not exists (
      select 1
        from public.project_periods pp
       where pp.id = new.portal_period_id
         and pp.project_id = new.portal_project_id
         and pp.status = 'active'
    ) then
      raise exception 'bound Portal project period is not active';
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

-- Additive companion to the established seven-argument launch finalizer.
-- Failed/uncertain launches delegate with an empty row array. Successful
-- bound launches freeze initial supply and materialize every provider row in
-- the same transaction as the paused campaign children.
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
     or v_project.portal_period_id is null
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

-- Recovery first crosses the existing audited resolution boundary, then adds
-- the exact durable audience before this transaction can commit. The deferred
-- queue invariant below rejects the legacy recovery RPC used by itself for a
-- bound project. Any audience conflict rolls the audit back to uncertain too.
create or replace function public.ve_resolve_template_contact_delivery(
  p_audit_id uuid,
  p_template_id uuid,
  p_launch_reservation_id uuid,
  p_resolution text,
  p_launch_info jsonb,
  p_resolved_by uuid,
  p_resolution_id uuid,
  p_now timestamptz,
  p_drip_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resolution jsonb;
  v_finalize jsonb;
begin
  if p_drip_rows is null or jsonb_typeof(p_drip_rows) <> 'array' then
    raise exception 'p_drip_rows must be an array';
  end if;
  if p_resolution = 'no_campaign' and jsonb_array_length(p_drip_rows) <> 0 then
    raise exception 'no_campaign resolution cannot persist delivery rows';
  end if;

  v_resolution := public.ve_resolve_template_launch(
    p_audit_id, p_template_id, p_launch_reservation_id, p_resolution,
    p_launch_info, p_resolved_by, p_resolution_id, p_now
  );
  if p_resolution <> 'campaign_created'
     or coalesce((v_resolution ->> 'resolved')::boolean, false) is not true then
    return v_resolution;
  end if;

  v_finalize := public.ve_finalize_template_contact_delivery(
    p_audit_id, p_template_id, p_launch_reservation_id, 'succeeded',
    p_launch_info, null, p_now, p_drip_rows
  );
  if coalesce((v_finalize ->> 'finalized')::boolean, false) is not true then
    raise exception 'recovered launch could not persist its exact durable audience';
  end if;

  return v_resolution || jsonb_build_object(
    'launch_info', v_finalize -> 'launch_info',
    'queue_item', v_finalize -> 'queue_item',
    'delivery_rows_count', v_finalize -> 'delivery_rows_count'
  );
end;
$$;

drop trigger if exists ve_projects_guard_contact_delivery_binding
  on public.ve_projects;
create trigger ve_projects_guard_contact_delivery_binding
before insert or update of
  portal_project_id,
  portal_period_id,
  target_contacts,
  delivery_schedule_days,
  delivery_timezone,
  sender_daily_capacity,
  delivery_plan_bound_at,
  delivery_plan_bound_by
on public.ve_projects
for each row execute function public.ve_guard_contact_delivery_binding();

-- Existing finalize calls are allowed for legacy VE2 projects. A bound project
-- must use the companion finalize so campaigns and durable rows commit together.
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
       and p.portal_period_id is not null
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

drop trigger if exists ve_launch_queue_items_require_delivery_rows
  on public.ve_launch_queue_items;
create constraint trigger ve_launch_queue_items_require_delivery_rows
after insert on public.ve_launch_queue_items
deferrable initially deferred
for each row execute function public.ve_require_contact_delivery_rows();

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
     or p_expected_portal_period_id is null
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
  if v_project.portal_period_id is not null then
    if v_project.portal_project_id = p_portal_project_id
       and v_project.portal_period_id = p_expected_portal_period_id
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
    raise exception 'Portal period already belongs to another VE2 delivery plan';
end;
$$;

create or replace function public.ve_refresh_contact_delivery_counters(
  p_ve_project_id uuid,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Reconciliation/activation lock bundle before campaign. Keep that order
  -- here too, including deterministic ordering across several hypotheses.
  perform 1 from public.ve_launch_queue_items qi
   where qi.project_id = p_ve_project_id
   order by qi.id
   for update;

  update public.ve_launch_queue_campaigns c
     set ready_remaining_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.campaign_row_id = c.id and r.status = 'ready'
         ),
         leads_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.campaign_row_id = c.id and r.status = 'accepted'
         ),
         updated_at = p_now
    from public.ve_launch_queue_items qi
   where qi.id = c.item_id
     and qi.project_id = p_ve_project_id
     and exists (
       select 1 from public.ve_contact_delivery_rows r where r.campaign_row_id = c.id
     );

  update public.ve_launch_queue_items qi
     set ready_remaining_count = (
           select count(*)::integer
             from public.ve_contact_delivery_rows r
            where r.item_id = qi.id and r.status = 'ready'
         ),
         updated_at = p_now
   where qi.project_id = p_ve_project_id
     and exists (
       select 1 from public.ve_contact_delivery_rows r where r.item_id = qi.id
     );
end;
$$;

create or replace function public.ve_normalize_delivery_row_ids(
  p_row_ids uuid[]
)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct row_id order by row_id), '{}'::uuid[])
    from unnest(coalesce(p_row_ids, '{}'::uuid[])) as value(row_id)
   where row_id is not null
$$;

revoke all on function public.ve_normalize_delivery_row_ids(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.ve_normalize_delivery_row_ids(uuid[])
  to postgres;

create or replace function public.ve_contact_delivery_run_response(
  p_run_id uuid,
  p_status text,
  p_include_batches boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_project public.ve_projects%rowtype;
  v_batches jsonb := '[]'::jsonb;
begin
  if p_status not in ('reserved','replayed','not_scheduled','fulfilled','no_ready_rows','awaiting_delivery') then
    raise exception 'invalid delivery response status: %', p_status;
  end if;
  select r.*
    into v_run
    from public.ve_contact_delivery_daily_runs r
   where r.id = p_run_id;
  if not found then
    raise exception 'contact delivery run not found';
  end if;
  select p.* into v_project from public.ve_projects p where p.id = v_run.ve_project_id;
  if not found then
    raise exception 'contact delivery project not found';
  end if;

  if p_include_batches then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'campaign_id', batch.campaign_id,
          'row_ids', batch.row_ids,
          'leads', batch.leads
        ) order by batch.campaign_id
      ),
      '[]'::jsonb
    )
      into v_batches
      from (
        select c.campaign_id,
               jsonb_agg(r.id order by r.drip_order, r.id) as row_ids,
               jsonb_agg(r.lead_payload order by r.drip_order, r.id) as leads
          from public.ve_contact_delivery_rows r
          join public.ve_launch_queue_campaigns c on c.id = r.campaign_row_id
         where r.run_id = p_run_id
           and r.status = 'reserved'
         group by c.id, c.campaign_id
      ) batch;
  end if;

  return jsonb_build_object(
    'status', p_status,
    'run_id', v_run.id,
    'run_date', v_run.run_date,
    'batches', v_batches,
    've_project_id', v_run.ve_project_id,
    'portal_project_id', v_run.portal_project_id,
    'portal_period_id', v_run.portal_period_id,
    'launch_preset_id', v_project.launch_preset_id,
    'target_contacts', v_run.target_contacts,
    'actual_first_contacted', v_run.actual_first_contacted,
    'observed_ve_first_contacted', v_run.observed_ve_first_contacted,
    'committed_count', v_run.committed_count,
    'outstanding_count', v_run.outstanding_count,
    'upload_headroom', v_run.upload_headroom,
    'deadline', v_run.deadline,
    'delivery_schedule_days', v_run.schedule_days,
    'delivery_timezone', v_run.timezone,
    'sender_daily_capacity', v_run.sender_daily_capacity,
    'remaining_contacts', v_run.remaining_contacts,
    'remaining_workdays', v_run.remaining_workdays,
    'required_daily', v_run.required_daily,
    'ready_remaining', v_run.ready_remaining,
    'effective_count', v_run.effective_count,
    'reservation_status', v_run.reservation_status,
    'run_status', v_run.status
  );
end;
$$;

create or replace function public.ve_reserve_contact_delivery_day(
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
     or v_project.portal_period_id is null
     or v_project.target_contacts is null
     or v_project.delivery_schedule_days is null
     or v_project.delivery_timezone is null
     or v_project.sender_daily_capacity is null then
    raise exception 'VE2 delivery plan is not explicitly bound';
  end if;

  v_local_date := timezone(v_project.delivery_timezone, p_now)::date;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      've-contact-delivery-period:' || v_project.portal_period_id::text,
      0
    )
  );

  select r.*
    into v_existing
    from public.ve_contact_delivery_daily_runs r
   where r.portal_period_id = v_project.portal_period_id
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

create or replace function public.ve_mark_contact_delivery_attempt(
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
       select 1 from public.project_periods pp
        where pp.id = v_run.portal_period_id
          and pp.project_id = v_run.portal_project_id
          and pp.status = 'active'
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

create or replace function public.ve_finalize_contact_delivery_attempt(
  p_run_id uuid,
  p_attempt_id uuid,
  p_campaign_id text,
  p_accepted_row_ids uuid[],
  p_skipped_row_ids uuid[],
  p_uncertain_row_ids uuid[],
  p_released_row_ids uuid[],
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.ve_contact_delivery_attempts%rowtype;
  v_run public.ve_contact_delivery_daily_runs%rowtype;
  v_campaign_id text;
  v_accepted uuid[];
  v_skipped uuid[];
  v_uncertain uuid[];
  v_released uuid[];
  v_union uuid[];
  v_updated integer;
  v_linked integer;
  v_inflight integer;
  v_accepted_count integer;
  v_skipped_count integer;
  v_uncertain_count integer;
  v_released_count integer;
  v_status text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_run_id is null or p_attempt_id is null then
    raise exception 'run and attempt UUIDs are required';
  end if;
  v_campaign_id := nullif(btrim(p_campaign_id), '');
  if v_campaign_id is null then
    raise exception 'campaign_id is required';
  end if;

  v_accepted := public.ve_normalize_delivery_row_ids(p_accepted_row_ids);
  v_skipped := public.ve_normalize_delivery_row_ids(p_skipped_row_ids);
  v_uncertain := public.ve_normalize_delivery_row_ids(p_uncertain_row_ids);
  v_released := public.ve_normalize_delivery_row_ids(p_released_row_ids);
  if cardinality(v_accepted) <> cardinality(coalesce(p_accepted_row_ids, '{}'::uuid[]))
     or cardinality(v_skipped) <> cardinality(coalesce(p_skipped_row_ids, '{}'::uuid[]))
     or cardinality(v_uncertain) <> cardinality(coalesce(p_uncertain_row_ids, '{}'::uuid[]))
     or cardinality(v_released) <> cardinality(coalesce(p_released_row_ids, '{}'::uuid[])) then
    raise exception 'attempt outcomes must contain unique non-null row UUIDs';
  end if;
  v_union := public.ve_normalize_delivery_row_ids(
    v_accepted || v_skipped || v_uncertain || v_released
  );
  if cardinality(v_union) <>
     cardinality(v_accepted) + cardinality(v_skipped)
       + cardinality(v_uncertain) + cardinality(v_released) then
    raise exception 'attempt outcome row sets must be disjoint';
  end if;

  -- Keep the same lock order as mark: run first, then attempt.
  select r.*
    into v_run
    from public.ve_contact_delivery_daily_runs r
   where r.id = p_run_id
   for update;
  if not found then
    raise exception 'contact delivery run not found';
  end if;

  select a.*
    into v_attempt
    from public.ve_contact_delivery_attempts a
   where a.id = p_attempt_id
   for update;
  if not found then
    raise exception 'contact delivery attempt not found';
  end if;
  if v_attempt.run_id <> p_run_id or v_attempt.campaign_id <> v_campaign_id then
    raise exception 'attempt does not belong to requested run/campaign';
  end if;
  if v_union <> v_attempt.row_ids then
    raise exception 'attempt outcomes must classify every fenced row exactly once';
  end if;

  if v_attempt.status = 'finalized' then
    if v_attempt.accepted_row_ids = v_accepted
       and v_attempt.skipped_row_ids = v_skipped
       and v_attempt.uncertain_row_ids = v_uncertain
       and v_attempt.released_row_ids = v_released
       and v_attempt.error is not distinct from p_error then
      return jsonb_build_object(
        'finalized', true,
        'replayed', true,
        'run_id', p_run_id,
        'attempt_id', p_attempt_id,
        'campaign_id', v_campaign_id,
        'run_status', v_run.status,
        'accepted_count', v_run.accepted_count,
        'skipped_count', v_run.skipped_count,
        'uncertain_count', v_run.uncertain_count,
        'released_count', v_run.released_count
      );
    end if;
    raise exception 'finalized delivery attempt was replayed with different outcomes';
  end if;

  update public.ve_contact_delivery_rows row_value
     set status = case
           when row_value.id = any(v_accepted) then 'accepted'
           when row_value.id = any(v_skipped) then 'skipped'
           when row_value.id = any(v_uncertain) then 'uncertain'
           when row_value.id = any(v_released) then 'ready'
         end,
         run_id = case when row_value.id = any(v_released) then null else p_run_id end,
         attempt_id = case when row_value.id = any(v_released) then null else p_attempt_id end,
         last_error = case
           when row_value.id = any(v_released) then null
           when row_value.id = any(v_uncertain) then p_error
           else null
         end,
         reserved_at = case when row_value.id = any(v_released) then null else row_value.reserved_at end,
         attempted_at = case when row_value.id = any(v_released) then null else row_value.attempted_at end,
         finalized_at = case when row_value.id = any(v_released) then null else v_now end,
         updated_at = v_now
   where row_value.attempt_id = p_attempt_id
     and row_value.run_id = p_run_id
     and row_value.status = 'attempting'
     and row_value.id = any(v_attempt.row_ids);
  get diagnostics v_updated = row_count;
  if v_updated <> cardinality(v_attempt.row_ids) then
    raise exception 'attempt durable rows are not all in the fenced state';
  end if;

  update public.ve_contact_delivery_attempts a
     set status = 'finalized',
         accepted_row_ids = v_accepted,
         skipped_row_ids = v_skipped,
         uncertain_row_ids = v_uncertain,
         released_row_ids = v_released,
         error = p_error,
         finalized_at = v_now,
         updated_at = v_now
   where a.id = p_attempt_id;

  select count(*) filter (where row_value.status = 'accepted')::integer,
         count(*) filter (where row_value.status = 'skipped')::integer,
         count(*) filter (where row_value.status = 'uncertain')::integer,
         count(*) filter (where row_value.status in ('reserved','attempting'))::integer,
         count(*)::integer
    into v_accepted_count, v_skipped_count, v_uncertain_count, v_inflight, v_linked
    from public.ve_contact_delivery_rows row_value
   where row_value.run_id = p_run_id;
  v_released_count := v_run.reserved_count - v_linked;
  v_status := case
    when v_inflight > 0 then 'attempting'
    when v_uncertain_count > 0 then 'uncertain'
    else 'completed'
  end;

  update public.ve_contact_delivery_daily_runs r
     set status = v_status,
         accepted_count = v_accepted_count,
         skipped_count = v_skipped_count,
         uncertain_count = v_uncertain_count,
         released_count = v_released_count,
         error = case
           when p_error is null then r.error
           when r.error is null then p_error
           else left(r.error || '; ' || p_error, 2000)
         end,
         completed_at = case when v_inflight = 0 then v_now else null end,
         updated_at = v_now
   where r.id = p_run_id
   returning * into v_run;

  perform public.ve_refresh_contact_delivery_counters(v_run.ve_project_id, v_now);

  return jsonb_build_object(
    'finalized', true,
    'replayed', false,
    'run_id', p_run_id,
    'attempt_id', p_attempt_id,
    'campaign_id', v_campaign_id,
    'run_status', v_run.status,
    'accepted_count', v_run.accepted_count,
    'skipped_count', v_run.skipped_count,
    'uncertain_count', v_run.uncertain_count,
    'released_count', v_run.released_count,
    'portal_project_id', v_run.portal_project_id,
    'portal_period_id', v_run.portal_period_id,
    'target_contacts', v_run.target_contacts,
    'actual_first_contacted', v_run.actual_first_contacted
  );
end;
$$;

-- Preserve live reconciliation for legacy launches; durable delivery bundles
-- keep their slot when Instantly completes only the current daily batch.
create or replace function public.ve_reserve_contact_delivery_activation(
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
    join public.project_periods pp on pp.id = p.portal_period_id
                                 and pp.project_id = p.portal_project_id
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

create or replace function public.ve_finalize_contact_delivery_activation(
  p_item_id uuid,
  p_campaign_id text,
  p_attempt_id uuid,
  p_succeeded boolean,
  p_error text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.ve_launch_queue_campaigns%rowtype;
  v_attempt public.ve_contact_delivery_activation_attempts%rowtype;
begin
  if p_item_id is null or p_attempt_id is null or p_succeeded is null
     or nullif(btrim(p_campaign_id), '') is null or p_now is null then
    raise exception 'activation finalization requires exact identity, outcome and timestamp';
  end if;
  perform 1 from public.ve_launch_queue_items q where q.id = p_item_id for update;
  if not found then raise exception 'activation bundle not found'; end if;
  select c.* into v_campaign from public.ve_launch_queue_campaigns c
   where c.item_id = p_item_id and c.campaign_id = btrim(p_campaign_id) for update;
  if not found then raise exception 'activation campaign is not a child of bundle'; end if;
  select a.* into v_attempt from public.ve_contact_delivery_activation_attempts a
   where a.id = p_attempt_id and a.item_id = p_item_id
     and a.campaign_row_id = v_campaign.id for update;
  if not found then raise exception 'activation attempt fence not found'; end if;
  if v_attempt.status = 'succeeded' then
    if not p_succeeded then raise exception 'confirmed activation cannot change to uncertain'; end if;
    return jsonb_build_object('finalized', true, 'replayed', true,
      'attempt_id', p_attempt_id, 'activation_status', 'succeeded');
  end if;
  if v_attempt.status = 'uncertain' and not p_succeeded then
    return jsonb_build_object('finalized', true, 'replayed', true,
      'attempt_id', p_attempt_id, 'activation_status', 'uncertain');
  end if;

  -- Trusted caller passes success only after fresh live Active/Running proof.
  -- That observation may reconcile an earlier timeout without another POST.
  update public.ve_contact_delivery_activation_attempts
     set status = case when p_succeeded then 'succeeded' else 'uncertain' end,
         completed_at = p_now,
         error = case when p_succeeded then null else left(p_error, 2000) end
   where id = p_attempt_id;
  if p_succeeded then
    update public.ve_launch_queue_campaigns
       set activated_at = coalesce(activated_at, p_now),
           remote_status = 1, status_observed_at = p_now,
           completed_at = null, updated_at = p_now
     where id = v_campaign.id;
  end if;
  return jsonb_build_object('finalized', true, 'replayed', false,
    'attempt_id', p_attempt_id,
    'activation_status', case when p_succeeded then 'succeeded' else 'uncertain' end);
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
   where c.item_id = p_item_id and p.portal_period_id is not null;

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
    join public.project_periods pp on pp.id = p.portal_period_id
                                 and pp.project_id = p.portal_project_id
   where p.id = v_item.project_id and p.portal_period_id is not null;

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

revoke all on function public.ve_reconcile_launch_campaign_statuses(uuid, jsonb, timestamptz, interval)
  from public, anon, authenticated;
grant execute on function public.ve_reconcile_launch_campaign_statuses(uuid, jsonb, timestamptz, interval)
  to service_role, postgres;


alter table public.ve_contact_delivery_daily_runs enable row level security;
alter table public.ve_contact_delivery_attempts enable row level security;
alter table public.ve_contact_delivery_rows enable row level security;
alter table public.ve_contact_delivery_activation_attempts enable row level security;

revoke all on table public.ve_contact_delivery_daily_runs
  from public, anon, authenticated, service_role;
revoke all on table public.ve_contact_delivery_attempts
  from public, anon, authenticated, service_role;
revoke all on table public.ve_contact_delivery_rows
  from public, anon, authenticated, service_role;
revoke all on table public.ve_contact_delivery_activation_attempts
  from public, anon, authenticated, service_role;

grant select on public.ve_contact_delivery_daily_runs to service_role;
grant select on public.ve_contact_delivery_attempts to service_role;
grant select on public.ve_contact_delivery_rows to service_role;
grant select on public.ve_contact_delivery_activation_attempts to service_role;

grant all on public.ve_contact_delivery_daily_runs to postgres;
grant all on public.ve_contact_delivery_attempts to postgres;
grant all on public.ve_contact_delivery_rows to postgres;
grant all on public.ve_contact_delivery_activation_attempts to postgres;

drop policy if exists "Service role read contact delivery runs"
  on public.ve_contact_delivery_daily_runs;
create policy "Service role read contact delivery runs"
  on public.ve_contact_delivery_daily_runs
  for select to service_role using (true);

drop policy if exists "Service role read contact delivery attempts"
  on public.ve_contact_delivery_attempts;
create policy "Service role read contact delivery attempts"
  on public.ve_contact_delivery_attempts
  for select to service_role using (true);

drop policy if exists "Service role read contact delivery rows"
  on public.ve_contact_delivery_rows;
create policy "Service role read contact delivery rows"
  on public.ve_contact_delivery_rows
  for select to service_role using (true);

create policy "Service role read contact delivery activations"
  on public.ve_contact_delivery_activation_attempts
  for select to service_role using (true);

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.ve_contact_delivery_daily_runs, public.ve_contact_delivery_attempts, public.ve_contact_delivery_rows, public.ve_contact_delivery_activation_attempts to readonly';
  end if;
end;
$$;

revoke all on function public.ve_guard_contact_delivery_binding()
  from public, anon, authenticated, service_role;
revoke all on function public.ve_guard_contact_delivery_item_counters()
  from public, anon, authenticated, service_role;
revoke all on function public.ve_guard_contact_delivery_campaign_counters()
  from public, anon, authenticated, service_role;
revoke all on function public.ve_require_contact_delivery_rows()
  from public, anon, authenticated, service_role;
revoke all on function public.ve_refresh_contact_delivery_counters(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.ve_contact_delivery_run_response(uuid, text, boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.ve_guard_contact_delivery_binding() to postgres;
grant execute on function public.ve_guard_contact_delivery_item_counters() to postgres;
grant execute on function public.ve_guard_contact_delivery_campaign_counters() to postgres;
grant execute on function public.ve_require_contact_delivery_rows() to postgres;
grant execute on function public.ve_refresh_contact_delivery_counters(uuid, timestamptz) to postgres;
grant execute on function public.ve_contact_delivery_run_response(uuid, text, boolean) to postgres;

revoke all on function public.ve_bind_contact_delivery_plan(
  uuid, uuid, uuid, integer, smallint[], text, integer, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.ve_finalize_template_contact_delivery(
  uuid, uuid, uuid, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ve_resolve_template_contact_delivery(
  uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ve_reserve_contact_delivery_day(uuid, timestamptz, bigint)
  from public, anon, authenticated;
revoke all on function public.ve_mark_contact_delivery_attempt(uuid, uuid, text, uuid[])
  from public, anon, authenticated;
revoke all on function public.ve_finalize_contact_delivery_attempt(
  uuid, uuid, text, uuid[], uuid[], uuid[], uuid[], text
) from public, anon, authenticated;
revoke all on function public.ve_reserve_contact_delivery_activation(
  uuid, text, uuid, integer, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.ve_finalize_contact_delivery_activation(
  uuid, text, uuid, boolean, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.ve_bind_contact_delivery_plan(
  uuid, uuid, uuid, integer, smallint[], text, integer, uuid, timestamptz
) to service_role, postgres;
grant execute on function public.ve_finalize_template_contact_delivery(
  uuid, uuid, uuid, text, jsonb, text, timestamptz, jsonb
) to service_role, postgres;
grant execute on function public.ve_resolve_template_contact_delivery(
  uuid, uuid, uuid, text, jsonb, uuid, uuid, timestamptz, jsonb
) to service_role, postgres;
grant execute on function public.ve_reserve_contact_delivery_day(uuid, timestamptz, bigint)
  to service_role, postgres;
grant execute on function public.ve_mark_contact_delivery_attempt(uuid, uuid, text, uuid[])
  to service_role, postgres;
grant execute on function public.ve_finalize_contact_delivery_attempt(
  uuid, uuid, text, uuid[], uuid[], uuid[], uuid[], text
) to service_role, postgres;
grant execute on function public.ve_reserve_contact_delivery_activation(
  uuid, text, uuid, integer, timestamptz, timestamptz
) to service_role, postgres;
grant execute on function public.ve_finalize_contact_delivery_activation(
  uuid, text, uuid, boolean, text, timestamptz
) to service_role, postgres;
