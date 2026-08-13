-- Separate the private HR inbox from the read-only queue shared by leads.
-- Existing rows stay private because they were written with that expectation.

alter table public.team_review_requests
  add column if not exists visibility text not null default 'private';

alter table public.team_review_requests
  drop constraint if exists team_review_requests_visibility_check;
alter table public.team_review_requests
  add constraint team_review_requests_visibility_check
  check (visibility in ('private', 'lead_shared'));

-- This capability permits an explicitly approved executive to submit a
-- private request without granting access to the HR or lead-shared inboxes.
alter table public.profiles
  add column if not exists can_submit_team_review_request_private boolean not null default false;

update public.profiles
set can_submit_team_review_request_private = true
where id in (
  '9e2c53fe-4b86-40b1-b464-757ffe0944dd'::uuid,
  '416b456b-83b4-48c1-9eeb-9cb6ab88e455'::uuid
);

-- Keep browser sessions from assigning the capability to themselves. The
-- existing trigger remains attached to this replaced function.
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
       or new.can_submit_team_review_request_private
          is distinct from old.can_submit_team_review_request_private
     )
  then
    raise exception
      'profile privileges can only be changed by a trusted server';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_privilege_escalation() from public;
revoke all on function public.prevent_profile_privilege_escalation() from anon;
revoke all on function public.prevent_profile_privilege_escalation() from authenticated;

-- The API derives visibility too so its insert is explicit and testable. This
-- trigger is the database backstop for every service-role writer: caller input
-- is overwritten from the immutable requester profile.
create or replace function public.derive_team_review_request_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_is_demo boolean;
  v_can_access_private boolean;
  v_can_submit_private boolean;
begin
  select actor.role,
         coalesce(actor.is_demo, false),
         coalesce(actor.can_access_team_private, false),
         coalesce(actor.can_submit_team_review_request_private, false)
  into v_role,
       v_is_demo,
       v_can_access_private,
       v_can_submit_private
  from public.profiles actor
  where actor.id = new.requested_by_user_id;

  if not found or v_is_demo then
    raise exception 'review request requester is not eligible'
      using errcode = '23514';
  end if;

  if v_role in ('lead', 'director') then
    new.visibility := 'lead_shared';
  elsif v_role in (
      'technician',
      'manager',
      'director',
      'admin',
      'sales',
      'marketer',
      'lead'
    )
    and (v_can_access_private or v_can_submit_private)
  then
    new.visibility := 'private';
  else
    raise exception 'review request requester is not eligible'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.derive_team_review_request_visibility() from public;
revoke all on function public.derive_team_review_request_visibility() from anon;
revoke all on function public.derive_team_review_request_visibility() from authenticated;

drop trigger if exists team_review_requests_derive_visibility
  on public.team_review_requests;
create trigger team_review_requests_derive_visibility
  before insert on public.team_review_requests
  for each row
  execute function public.derive_team_review_request_visibility();

-- Attribution and visibility are immutable after insert, including during
-- request lifecycle changes.
create or replace function public.prevent_team_review_request_visibility_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.visibility is distinct from old.visibility
     or new.requested_by_user_id is distinct from old.requested_by_user_id
  then
    raise exception
      'team review request requester and visibility are immutable after creation'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_team_review_request_visibility_change() from public;
revoke all on function public.prevent_team_review_request_visibility_change() from anon;
revoke all on function public.prevent_team_review_request_visibility_change() from authenticated;

drop trigger if exists team_review_requests_visibility_immutable
  on public.team_review_requests;
create trigger team_review_requests_visibility_immutable
  before update of visibility on public.team_review_requests
  for each row
  execute function public.prevent_team_review_request_visibility_change();

drop trigger if exists team_review_requests_requester_immutable
  on public.team_review_requests;
create trigger team_review_requests_requester_immutable
  before update of requested_by_user_id on public.team_review_requests
  for each row
  execute function public.prevent_team_review_request_visibility_change();

-- Private Team users, explicitly approved executives, leads and directors may
-- submit. The explicit flag is still bounded to real internal roles.
create or replace function public.can_submit_team_review_request()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_access_team()
    or exists (
      select 1
      from public.profiles actor
      where actor.id = auth.uid()
        and coalesce(actor.is_demo, false) = false
        and (
          actor.role in ('lead', 'director')
          or (
            actor.can_submit_team_review_request_private is true
            and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
          )
        )
    );
$$;

revoke all on function public.can_submit_team_review_request() from public;
revoke all on function public.can_submit_team_review_request() from anon;
revoke all on function public.can_submit_team_review_request() from authenticated;
grant execute on function public.can_submit_team_review_request() to authenticated;

-- Only real leads and directors can read the shared queue. Private-Team and
-- private-submit capabilities do not imply shared visibility.
create or replace function public.can_view_team_review_requests_shared()
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
      and actor.role in ('lead', 'director')
  );
$$;

revoke all on function public.can_view_team_review_requests_shared() from public;
revoke all on function public.can_view_team_review_requests_shared() from anon;
revoke all on function public.can_view_team_review_requests_shared() from authenticated;
grant execute on function public.can_view_team_review_requests_shared() to authenticated;

create index if not exists team_review_requests_shared_queue_idx
  on public.team_review_requests (visibility, state, created_at desc, id);

-- Storage remains API-only under forced RLS. No browser role gets table access.
revoke all on public.team_review_requests from public;
revoke all on public.team_review_requests from anon;
revoke all on public.team_review_requests from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'revoke all on public.team_review_requests from readonly';
  end if;
end;
$$;

alter table public.team_review_requests enable row level security;
alter table public.team_review_requests force row level security;

comment on column public.profiles.can_submit_team_review_request_private is
  'Explicit capability to submit private Team review requests without inbox access.';
comment on column public.team_review_requests.visibility is
  'Immutable server-derived audience: private or lead_shared.';
