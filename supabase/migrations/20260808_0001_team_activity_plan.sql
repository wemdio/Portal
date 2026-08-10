-- HR-only activity planning for the Team workspace.
--
-- The browser may read through RLS when the authoritative profile capability
-- is present. All writes still go through the bearer-authenticated API and its
-- service-role client; authenticated browser writes have no policies or grants.

alter table public.profiles
  add column if not exists is_hr boolean not null default false;

update public.profiles
set is_hr = true
where id = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9'::uuid;

create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('anon', 'authenticated')
     and (
       new.role is distinct from old.role
       or new.is_demo is distinct from old.is_demo
       or new.is_hr is distinct from old.is_hr
     )
  then
    raise exception 'role, is_demo, and is_hr can only be changed by a trusted server';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation() from public;
revoke all on function public.prevent_profile_privilege_escalation() from anon;
revoke all on function public.prevent_profile_privilege_escalation() from authenticated;

create or replace function public.can_manage_team_activity_plan()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.id = auth.uid()
      and actor.is_hr is true
      and coalesce(actor.is_demo, false) = false
      and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
  );
$$;

revoke all on function public.can_manage_team_activity_plan() from public;
revoke all on function public.can_manage_team_activity_plan() from anon;
revoke all on function public.can_manage_team_activity_plan() from authenticated;
grant execute on function public.can_manage_team_activity_plan() to authenticated;

create table if not exists public.team_activity_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_month date not null,
  periodicity text not null,
  activity text not null,
  format text,
  planned_date date,
  planned_time time without time zone,
  schedule_note text,
  note text,
  budget_amount numeric(12, 2),
  budget_note text,
  status text not null default 'planned',
  position integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint team_activity_plan_items_plan_month_check
    check (plan_month = date_trunc('month', plan_month)::date),
  constraint team_activity_plan_items_periodicity_check
    check (char_length(btrim(periodicity)) between 1 and 100),
  constraint team_activity_plan_items_activity_check
    check (char_length(btrim(activity)) between 1 and 500),
  constraint team_activity_plan_items_format_check
    check (format is null or char_length(btrim(format)) between 1 and 500),
  constraint team_activity_plan_items_schedule_note_check
    check (schedule_note is null or char_length(btrim(schedule_note)) between 1 and 500),
  constraint team_activity_plan_items_time_requires_date_check
    check (planned_time is null or planned_date is not null),
  constraint team_activity_plan_items_date_schedule_exclusive_check
    check (planned_date is null or schedule_note is null),
  constraint team_activity_plan_items_note_check
    check (note is null or char_length(btrim(note)) between 1 and 5000),
  constraint team_activity_plan_items_budget_amount_check
    check (budget_amount is null or budget_amount >= 0),
  constraint team_activity_plan_items_budget_note_check
    check (budget_note is null or char_length(btrim(budget_note)) between 1 and 500),
  constraint team_activity_plan_items_status_check
    check (status in ('planned', 'completed', 'cancelled')),
  constraint team_activity_plan_items_position_check
    check (position >= 0),
  constraint team_activity_plan_items_created_by_fkey
    foreign key (created_by)
    references public.profiles(id)
    on delete set null
);

create index if not exists idx_team_activity_plan_items_month_position
  on public.team_activity_plan_items(plan_month, position, created_at, id);

drop trigger if exists trg_team_activity_plan_items_updated_at on public.team_activity_plan_items;
create trigger trg_team_activity_plan_items_updated_at
  before update on public.team_activity_plan_items
  for each row
  execute function public.set_updated_at();

grant all on public.team_activity_plan_items to postgres;
grant all on public.team_activity_plan_items to service_role;

revoke all on public.team_activity_plan_items from anon;
revoke all on public.team_activity_plan_items from authenticated;
grant select on public.team_activity_plan_items to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'revoke all on public.team_activity_plan_items from readonly';
  end if;
end;
$$;

alter table public.team_activity_plan_items enable row level security;
alter table public.team_activity_plan_items force row level security;

drop policy if exists team_activity_plan_items_hr_select
  on public.team_activity_plan_items;
create policy team_activity_plan_items_hr_select
  on public.team_activity_plan_items
  for select
  to authenticated
  using (public.can_manage_team_activity_plan());

drop policy if exists team_activity_plan_items_hr_insert
  on public.team_activity_plan_items;

drop policy if exists team_activity_plan_items_hr_update
  on public.team_activity_plan_items;

drop policy if exists team_activity_plan_items_hr_delete
  on public.team_activity_plan_items;

comment on column public.profiles.is_hr is
  'Explicit capability for HR-only Team workspaces; not inferred from role.';

comment on table public.team_activity_plan_items is
  'Monthly HR activity plan shown in the private Team workspace.';
