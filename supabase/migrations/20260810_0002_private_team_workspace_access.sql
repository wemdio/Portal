-- Restrict the private Team workspaces to explicitly approved profiles.
-- "Load" keeps its existing access model; this capability governs only
-- Statistics, Reviews, and Activities.

alter table public.profiles
  add column if not exists can_access_team_private boolean not null default false;

update public.profiles
set can_access_team_private = true
where id in (
  '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9'::uuid,
  '66873c8c-ae56-4ab2-afa5-5e77dcda391d'::uuid
);

-- Keep browser sessions from assigning the capability to themselves even if a
-- future migration accidentally restores an overly broad profiles UPDATE grant.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() in ('anon', 'authenticated')
     and (
       new.role is distinct from old.role
       or new.is_demo is distinct from old.is_demo
       or new.is_hr is distinct from old.is_hr
       or new.can_access_team_private is distinct from old.can_access_team_private
     )
  then
    raise exception
      'role, is_demo, is_hr, and can_access_team_private can only be changed by a trusted server';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation() from public;
revoke all on function public.prevent_profile_privilege_escalation() from anon;
revoke all on function public.prevent_profile_privilege_escalation() from authenticated;

-- Canonical predicate for every private Team surface. The explicit role set is
-- only a validity boundary: role alone never grants access.
create or replace function public.can_access_team()
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
      and actor.can_access_team_private is true
      and coalesce(actor.is_demo, false) = false
      and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
  );
$$;

revoke all on function public.can_access_team() from public;
revoke all on function public.can_access_team() from anon;
revoke all on function public.can_access_team() from authenticated;
grant execute on function public.can_access_team() to authenticated;

-- Preserve the established activity API/RLS entry points while making both
-- read and management decisions use the same canonical capability.
create or replace function public.can_view_team_activity_plan()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_access_team();
$$;

revoke all on function public.can_view_team_activity_plan() from public;
revoke all on function public.can_view_team_activity_plan() from anon;
revoke all on function public.can_view_team_activity_plan() from authenticated;
grant execute on function public.can_view_team_activity_plan() to authenticated;

create or replace function public.can_manage_team_activity_plan()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_access_team();
$$;

revoke all on function public.can_manage_team_activity_plan() from public;
revoke all on function public.can_manage_team_activity_plan() from anon;
revoke all on function public.can_manage_team_activity_plan() from authenticated;
grant execute on function public.can_manage_team_activity_plan() to authenticated;

comment on column public.profiles.can_access_team_private is
  'Explicit capability for private Team workspaces: Statistics, Reviews, and Activities.';
