-- Close privilege-escalation and source-data integrity gaps used by Team analytics.
--
-- Trusted server routes use service_role. Browser writes keep using the caller JWT,
-- but only exact internal, non-demo profiles may mutate projects and project periods.

-- Profiles: replace inherited/table-wide grants with an explicit self-service allowlist.
-- The task-deadline fields are personal preferences written by the authenticated
-- /api/user/task-deadline-preference route.
revoke all privileges on table public.profiles from anon;
revoke all privileges on table public.profiles from authenticated;

grant select on table public.profiles to authenticated;
grant update (
  full_name,
  avatar_url,
  email,
  default_board_id,
  locale,
  task_deadline_default_enabled,
  task_deadline_default_mode,
  task_deadline_default_at,
  task_deadline_default_time
) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

-- Direct GoTrue signup is enabled in production. User metadata is caller-controlled,
-- so every auth-created profile must start as a client. Trusted service-role routes
-- assign an internal role only after createUser succeeds.
alter table public.profiles alter column role set default 'client';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_full_name text;
begin
  v_full_name := nullif(new.raw_user_meta_data->>'full_name', '');

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(v_full_name, split_part(new.email, '@', 1)),
    'client'
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name;

  return new;
exception when others then
  -- Preserve existing auth behavior: profile failures must not block auth.users.
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

-- Defense in depth: even if a future migration accidentally restores a broad UPDATE
-- grant, a browser JWT still cannot promote itself or turn off demo restrictions.
-- Direct postgres work and service_role-backed admin routes remain trusted.
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
     )
  then
    raise exception 'role and is_demo can only be changed by a trusted server';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation() from public;
revoke all on function public.prevent_profile_privilege_escalation() from anon;
revoke all on function public.prevent_profile_privilege_escalation() from authenticated;

drop trigger if exists prevent_profile_privilege_escalation on public.profiles;
create trigger prevent_profile_privilege_escalation
  before update on public.profiles
  for each row
  execute function public.prevent_profile_privilege_escalation();

-- One operation-aware predicate keeps database writes aligned with the application's
-- project permission matrix. SECURITY DEFINER is required because callers may only
-- update their own safe profile columns, while the policy must read role flags.
create or replace function public.can_mutate_team_data(operation text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.id = auth.uid()
      and coalesce(actor.is_demo, false) = false
      and case
        when operation = 'project_insert'
          then actor.role in ('admin', 'manager', 'technician', 'director', 'lead')
        when operation = 'project_delete'
          then actor.role in ('admin', 'manager', 'director', 'lead')
        when operation in ('project_update', 'project_period') then
          actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
        else false
      end
  )
$$;

revoke all on function public.can_mutate_team_data(text) from public;
revoke all on function public.can_mutate_team_data(text) from anon;
grant execute on function public.can_mutate_team_data(text) to authenticated;
grant execute on function public.can_mutate_team_data(text) to service_role;
-- Projects
alter table public.projects enable row level security;

revoke all privileges on table public.projects from anon;
revoke all privileges on table public.projects from authenticated;
grant select, insert, update, delete on table public.projects to authenticated;
grant all on table public.projects to service_role;

drop policy if exists "projects_all" on public.projects;
-- These two permissive PUBLIC policies exist in production but were created outside
-- the checked-in migrations. Leaving either one would OR-bypass the internal guard.
drop policy if exists "Enable insert for all users" on public.projects;
drop policy if exists "Enable update for all users" on public.projects;
drop policy if exists projects_select_authenticated on public.projects;
drop policy if exists projects_insert_internal on public.projects;
drop policy if exists projects_update_internal on public.projects;
drop policy if exists projects_delete_internal on public.projects;

-- Preserve the legacy read surface; this migration only narrows mutations.
create policy projects_select_authenticated on public.projects
  for select
  to authenticated
  using (true);

create policy projects_insert_internal on public.projects
  for insert
  to authenticated
  with check (public.can_mutate_team_data('project_insert'));

create policy projects_update_internal on public.projects
  for update
  to authenticated
  using (public.can_mutate_team_data('project_update'))
  with check (public.can_mutate_team_data('project_update'));

create policy projects_delete_internal on public.projects
  for delete
  to authenticated
  using (public.can_mutate_team_data('project_delete'));

-- Project periods
alter table public.project_periods enable row level security;

revoke all privileges on table public.project_periods from anon;
revoke all privileges on table public.project_periods from authenticated;
grant select, insert, update, delete on table public.project_periods to authenticated;
grant all on table public.project_periods to service_role;

drop policy if exists project_periods_all_authenticated on public.project_periods;
drop policy if exists project_periods_select_authenticated on public.project_periods;
drop policy if exists project_periods_insert_internal on public.project_periods;
drop policy if exists project_periods_update_internal on public.project_periods;
drop policy if exists project_periods_delete_internal on public.project_periods;

-- Preserve the legacy read surface; this migration only narrows mutations.
create policy project_periods_select_authenticated on public.project_periods
  for select
  to authenticated
  using (true);

create policy project_periods_insert_internal on public.project_periods
  for insert
  to authenticated
  with check (public.can_mutate_team_data('project_period'));

create policy project_periods_update_internal on public.project_periods
  for update
  to authenticated
  using (public.can_mutate_team_data('project_period'))
  with check (public.can_mutate_team_data('project_period'));

create policy project_periods_delete_internal on public.project_periods
  for delete
  to authenticated
  using (public.can_mutate_team_data('project_period'));
