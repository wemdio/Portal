-- Add a two-stage lifecycle for employee reviews and make the Team workspace private.
--
-- Existing rows are completed history. New rows start scheduled and only move to
-- completed through the service-role API after meeting outcomes are supplied.

alter table public.employee_reviews
  add column if not exists status text,
  add column if not exists reason text;

update public.employee_reviews
set status = 'completed'
where status is null;

alter table public.employee_reviews
  alter column status set default 'scheduled',
  alter column status set not null,
  alter column outcomes drop not null;

alter table public.employee_reviews
  drop constraint if exists employee_reviews_status_check,
  drop constraint if exists employee_reviews_reason_length_check,
  drop constraint if exists employee_reviews_outcomes_length_check,
  drop constraint if exists employee_reviews_completed_outcomes_check,
  drop constraint if exists employee_reviews_scheduled_fields_check;

alter table public.employee_reviews
  add constraint employee_reviews_status_check
    check (status in ('scheduled', 'completed')),
  add constraint employee_reviews_reason_length_check
    check (reason is null or char_length(btrim(reason)) between 1 and 500),
  add constraint employee_reviews_outcomes_length_check
    check (
      outcomes is null
      or char_length(btrim(outcomes)) between 1 and 5000
    ),
  add constraint employee_reviews_completed_outcomes_check
    check (status <> 'completed' or (outcomes is not null and char_length(btrim(outcomes)) between 1 and 5000)),
  add constraint employee_reviews_scheduled_fields_check
    check (status <> 'scheduled' or (outcomes is null and problems is null and recommendations is null));

create or replace function public.prevent_employee_review_status_regression()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'completed' and new.status = 'scheduled' then
    raise exception
      'employee review status cannot transition from completed to scheduled'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists employee_reviews_prevent_status_regression
  on public.employee_reviews;

create trigger employee_reviews_prevent_status_regression
  before update of status on public.employee_reviews
  for each row
  execute function public.prevent_employee_review_status_regression();

create index if not exists idx_employee_reviews_status_date
  on public.employee_reviews(status, review_date, created_at);

comment on column public.employee_reviews.status is
  'scheduled until meeting results are saved; completed rows are shown in review history.';

comment on column public.employee_reviews.reason is
  'Optional short reason or agenda captured while scheduling the review.';

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
      and actor.role in ('lead', 'director', 'admin')
      and coalesce(actor.is_demo, false) = false
  );
$$;

revoke all on function public.can_access_team() from public;
grant execute on function public.can_access_team() to authenticated;

drop policy if exists employee_reviews_internal_read
  on public.employee_reviews;
drop policy if exists employee_reviews_leadership_read
  on public.employee_reviews;

create policy employee_reviews_leadership_read
  on public.employee_reviews
  for select
  to authenticated
  using (public.can_access_team());

drop policy if exists team_project_history_internal_read
  on public.team_project_history;

create policy team_project_history_internal_read
  on public.team_project_history
  for select
  to authenticated
  using (public.can_access_team());
