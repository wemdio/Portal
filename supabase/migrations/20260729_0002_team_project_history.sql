-- Append-only project/cycle snapshots for calendar Team statistics.
-- Exact history starts when this migration is applied. The initial
-- snapshot lets the launch month render with an explicit "partial" coverage flag.

create table if not exists public.team_project_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  period_id uuid,
  project_name text,
  client text,
  project_status text,
  period_status text,
  manager text,
  specialist text,
  specialist_user_id uuid,
  kpi_plan text,
  kpi_fact text,
  launch_date date,
  deadline date,
  period_start date,
  period_end date,
  capture_source text not null
    check (capture_source in ('initial', 'project_trigger', 'period_trigger', 'project_delete', 'period_delete')),
  captured_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_team_project_history_capture
  on public.team_project_history(captured_at desc);

create index if not exists idx_team_project_history_cycle_capture
  on public.team_project_history(project_id, period_id, captured_at desc);

alter table public.team_project_history enable row level security;

revoke all on public.team_project_history from anon;
revoke all on public.team_project_history from authenticated;
grant select on public.team_project_history to authenticated;
grant all on public.team_project_history to service_role;

-- Team metrics are organization-wide, but must never be exposed to clients or
-- demo accounts. The API repeats this check before using the service-role client.
drop policy if exists team_project_history_internal_read on public.team_project_history;
create policy team_project_history_internal_read
  on public.team_project_history
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles actor
      where actor.id = auth.uid()
        and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
        and coalesce(actor.is_demo, false) = false
    )
  );

create or replace function public.team_statistics_safe_date(value text)
returns date
language plpgsql
immutable
as $$
declare
  normalized text;
  iso_candidate text;
begin
  normalized := btrim(value);
  if normalized ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    iso_candidate := normalized;
  elsif normalized ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4}$' then
    -- Legacy projects contain MM.DD.YYYY values such as 05.23.2026.
    iso_candidate := substring(normalized from 7 for 4)
      || '-' || substring(normalized from 1 for 2)
      || '-' || substring(normalized from 4 for 2);
  else
    return null;
  end if;

  begin
    return iso_candidate::date;
  exception when others then
    return null;
  end;
end;
$$;
create or replace function public.capture_team_project_history_from_project()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_period public.project_periods%rowtype;
begin
  if tg_op = 'UPDATE' and
    row(
      old.name,
      old.client,
      old.status,
      old.manager,
      old.specialist,
      old.specialist_user_id,
      old.kpi_plan,
      old.kpi_fact,
      old.launch_date,
      old.deadline,
      old.contract_date
    ) is not distinct from row(
      new.name,
      new.client,
      new.status,
      new.manager,
      new.specialist,
      new.specialist_user_id,
      new.kpi_plan,
      new.kpi_fact,
      new.launch_date,
      new.deadline,
      new.contract_date
    )
  then
    return new;
  end if;

  select pp.*
    into current_period
    from public.project_periods pp
   where pp.project_id = new.id
     and pp.status = 'active'
   order by pp.period_start desc, pp.created_at desc
   limit 1;

  -- A project with explicit cycles but no active one has only frozen history.
  -- Later project edits must not overwrite the latest closed-cycle snapshot.
  if current_period.id is null and exists (
    select 1
      from public.project_periods pp
     where pp.project_id = new.id
  ) then
    return new;
  end if;

  insert into public.team_project_history (
    project_id,
    period_id,
    project_name,
    client,
    project_status,
    period_status,
    manager,
    specialist,
    specialist_user_id,
    kpi_plan,
    kpi_fact,
    launch_date,
    deadline,
    period_start,
    period_end,
    capture_source,
    captured_at
  ) values (
    new.id,
    current_period.id,
    new.name,
    new.client,
    new.status,
    current_period.status,
    new.manager,
    new.specialist,
    new.specialist_user_id,
    new.kpi_plan,
    new.kpi_fact,
    public.team_statistics_safe_date(new.launch_date::text),
    public.team_statistics_safe_date(new.deadline::text),
    coalesce(
      public.team_statistics_safe_date(current_period.period_start::text),
      public.team_statistics_safe_date(new.launch_date::text),
      public.team_statistics_safe_date(new.contract_date::text),
      (new.created_at at time zone 'Europe/Moscow')::date
    ),
    public.team_statistics_safe_date(current_period.period_end::text),
    'project_trigger',
    clock_timestamp()
  );

  return new;
end;
$$;

create or replace function public.capture_team_project_history_from_period()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  parent_project public.projects%rowtype;
  use_parent_metrics boolean := false;
begin
  -- Closed cycles are immutable in Team history. Ignore later metadata edits
  -- so stale project_period KPI placeholders cannot replace the frozen result.
  if tg_op = 'UPDATE' and old.status = 'closed' and new.status = 'closed' then
    return new;
  end if;

  if tg_op = 'UPDATE' and
    row(
      old.status,
      old.period_start,
      old.period_end,
      old.kpi_plan,
      old.kpi_fact,
      old.deadline
    ) is not distinct from row(
      new.status,
      new.period_start,
      new.period_end,
      new.kpi_plan,
      new.kpi_fact,
      new.deadline
    )
  then
    return new;
  end if;

  select p.*
    into parent_project
    from public.projects p
   where p.id = new.project_id;

  if not found then
    return new;
  end if;

  use_parent_metrics := tg_op = 'UPDATE' and old.status = 'active';

  insert into public.team_project_history (
    project_id,
    period_id,
    project_name,
    client,
    project_status,
    period_status,
    manager,
    specialist,
    specialist_user_id,
    kpi_plan,
    kpi_fact,
    launch_date,
    deadline,
    period_start,
    period_end,
    capture_source,
    captured_at
  ) values (
    parent_project.id,
    new.id,
    parent_project.name,
    parent_project.client,
    parent_project.status,
    new.status,
    parent_project.manager,
    parent_project.specialist,
    parent_project.specialist_user_id,
    case when use_parent_metrics then parent_project.kpi_plan else new.kpi_plan end,
    case when use_parent_metrics then parent_project.kpi_fact else new.kpi_fact end,
    public.team_statistics_safe_date(parent_project.launch_date::text),
    case
      when use_parent_metrics then public.team_statistics_safe_date(parent_project.deadline::text)
      else public.team_statistics_safe_date(new.deadline::text)
    end,
    public.team_statistics_safe_date(new.period_start::text),
    public.team_statistics_safe_date(new.period_end::text),
    'period_trigger',
    clock_timestamp()
  );

  return new;
end;
$$;

create or replace function public.capture_team_project_history_from_period_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  frozen public.team_project_history%rowtype;
  parent_project public.projects%rowtype;
  has_frozen boolean := false;
begin
  select h.*
    into frozen
    from public.team_project_history h
   where h.project_id = old.project_id
     and h.period_id = old.id
   order by h.captured_at desc, h.id desc
   limit 1;

  has_frozen := found;

  -- Project deletion already wrote the authoritative active-cycle tombstone.
  if has_frozen and frozen.capture_source = 'project_delete' then
    return old;
  end if;

  select p.*
    into parent_project
    from public.projects p
   where p.id = old.project_id;

  insert into public.team_project_history (
    project_id,
    period_id,
    project_name,
    client,
    project_status,
    period_status,
    manager,
    specialist,
    specialist_user_id,
    kpi_plan,
    kpi_fact,
    launch_date,
    deadline,
    period_start,
    period_end,
    capture_source,
    captured_at
  ) values (
    old.project_id,
    old.id,
    case when has_frozen then frozen.project_name else parent_project.name end,
    case when has_frozen then frozen.client else parent_project.client end,
    case when has_frozen then frozen.project_status else parent_project.status end,
    'closed',
    case when has_frozen then frozen.manager else parent_project.manager end,
    case when has_frozen then frozen.specialist else parent_project.specialist end,
    case when has_frozen then frozen.specialist_user_id else parent_project.specialist_user_id end,
    case
      when has_frozen then frozen.kpi_plan
      when old.status = 'active' then parent_project.kpi_plan
      else old.kpi_plan
    end,
    case
      when has_frozen then frozen.kpi_fact
      when old.status = 'active' then parent_project.kpi_fact
      else old.kpi_fact
    end,
    case
      when has_frozen then frozen.launch_date
      else public.team_statistics_safe_date(parent_project.launch_date::text)
    end,
    case
      when has_frozen then frozen.deadline
      when old.status = 'active' then public.team_statistics_safe_date(parent_project.deadline::text)
      else public.team_statistics_safe_date(old.deadline::text)
    end,
    case
      when has_frozen then frozen.period_start
      else public.team_statistics_safe_date(old.period_start::text)
    end,
    coalesce(
      public.team_statistics_safe_date(old.period_end::text),
      case when has_frozen then frozen.period_end end,
      (clock_timestamp() at time zone 'Europe/Moscow')::date
    ),
    'period_delete',
    clock_timestamp()
  );

  return old;
end;
$$;

create or replace function public.capture_team_project_history_from_project_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  active_period public.project_periods%rowtype;
begin
  select pp.*
    into active_period
    from public.project_periods pp
   where pp.project_id = old.id
     and pp.status = 'active'
   order by pp.period_start desc, pp.created_at desc
   limit 1;

  if active_period.id is null and exists (
    select 1 from public.project_periods pp where pp.project_id = old.id
  ) then
    return old;
  end if;

  insert into public.team_project_history (
    project_id,
    period_id,
    project_name,
    client,
    project_status,
    period_status,
    manager,
    specialist,
    specialist_user_id,
    kpi_plan,
    kpi_fact,
    launch_date,
    deadline,
    period_start,
    period_end,
    capture_source,
    captured_at
  ) values (
    old.id,
    active_period.id,
    old.name,
    old.client,
    'Удален',
    'closed',
    old.manager,
    old.specialist,
    old.specialist_user_id,
    old.kpi_plan,
    old.kpi_fact,
    public.team_statistics_safe_date(old.launch_date::text),
    public.team_statistics_safe_date(old.deadline::text),
    coalesce(
      public.team_statistics_safe_date(active_period.period_start::text),
      public.team_statistics_safe_date(old.launch_date::text),
      public.team_statistics_safe_date(old.contract_date::text),
      (old.created_at at time zone 'Europe/Moscow')::date
    ),
    (clock_timestamp() at time zone 'Europe/Moscow')::date,
    'project_delete',
    clock_timestamp()
  );

  return old;
end;
$$;

revoke all on function public.team_statistics_safe_date(text) from public;
revoke all on function public.capture_team_project_history_from_project() from public;
revoke all on function public.capture_team_project_history_from_period() from public;
revoke all on function public.capture_team_project_history_from_period_delete() from public;
revoke all on function public.capture_team_project_history_from_project_delete() from public;

drop trigger if exists team_project_history_from_projects on public.projects;
create trigger team_project_history_from_projects
  after insert or update on public.projects
  for each row execute function public.capture_team_project_history_from_project();

drop trigger if exists team_project_history_from_project_delete on public.projects;
create trigger team_project_history_from_project_delete
  before delete on public.projects
  for each row execute function public.capture_team_project_history_from_project_delete();

drop trigger if exists team_project_history_from_periods on public.project_periods;
create trigger team_project_history_from_periods
  after insert or update on public.project_periods
  for each row execute function public.capture_team_project_history_from_period();

drop trigger if exists team_project_history_from_period_delete on public.project_periods;
create trigger team_project_history_from_period_delete
  before delete on public.project_periods
  for each row execute function public.capture_team_project_history_from_period_delete();

-- One row per known cycle; projects without project_periods receive a legacy row.
-- IDs are intentionally stored as snapshot values rather than cascading FKs so
-- deleting a current project cannot silently rewrite historical statistics.
insert into public.team_project_history (
  project_id,
  period_id,
  project_name,
  client,
  project_status,
  period_status,
  manager,
  specialist,
  specialist_user_id,
  kpi_plan,
  kpi_fact,
  launch_date,
  deadline,
  period_start,
  period_end,
  capture_source,
  captured_at
)
-- Active project_period KPI/deadline fields are legacy placeholders and are not
-- kept in sync. Use current projects fields for the active cycle; closed period
-- rows are immutable cycle results and remain the historical source of truth.
select
  p.id,
  pp.id,
  p.name,
  p.client,
  p.status,
  pp.status,
  p.manager,
  p.specialist,
  p.specialist_user_id,
  case when pp.id is null or pp.status = 'active' then p.kpi_plan else pp.kpi_plan end,
  case when pp.id is null or pp.status = 'active' then p.kpi_fact else pp.kpi_fact end,
  public.team_statistics_safe_date(p.launch_date::text),
  case
    when pp.id is null or pp.status = 'active' then public.team_statistics_safe_date(p.deadline::text)
    else public.team_statistics_safe_date(pp.deadline::text)
  end,
  coalesce(
    public.team_statistics_safe_date(pp.period_start::text),
    public.team_statistics_safe_date(p.launch_date::text),
    public.team_statistics_safe_date(p.contract_date::text),
    (p.created_at at time zone 'Europe/Moscow')::date
  ),
  public.team_statistics_safe_date(pp.period_end::text),
  'initial',
  clock_timestamp()
from public.projects p
left join public.project_periods pp on pp.project_id = p.id
where not exists (
  select 1
  from public.team_project_history existing
  where existing.project_id = p.id
    and existing.period_id is not distinct from pp.id
    and existing.capture_source = 'initial'
);

comment on table public.team_project_history is
  'Append-only project/cycle state for Team calendar statistics; coverage starts at the first captured snapshot.';
