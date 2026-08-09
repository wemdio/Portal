-- Allow non-demo administrators to inspect the HR activity plan without
-- broadening the existing is_hr-only mutation capability.

create or replace function public.can_view_team_activity_plan()
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
      and coalesce(actor.is_demo, false) = false
      and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
      and (
        actor.role = 'admin'
        or actor.is_hr is true
      )
  );
$$;

revoke all on function public.can_view_team_activity_plan() from public;
revoke all on function public.can_view_team_activity_plan() from anon;
revoke all on function public.can_view_team_activity_plan() from authenticated;
grant execute on function public.can_view_team_activity_plan() to authenticated;

drop policy if exists team_activity_plan_items_hr_select
  on public.team_activity_plan_items;
create policy team_activity_plan_items_hr_select
  on public.team_activity_plan_items
  for select
  to authenticated
  using (public.can_view_team_activity_plan());
