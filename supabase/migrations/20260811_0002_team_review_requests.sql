-- Private HR inbox for review requests submitted by team leads.
--
-- The table is deliberately API-only: authenticated browser sessions can call
-- the narrow capability predicates and the atomic conversion function, but
-- cannot read or mutate the sensitive request text through PostgREST.

create table if not exists public.team_review_requests (
  id uuid primary key default gen_random_uuid(),
  employee_user_id uuid not null,
  requested_by_user_id uuid not null,
  project_id uuid,
  problem text not null,
  examples text,
  desired_outcome text not null,
  state text not null default 'new',
  claimed_by uuid,
  claimed_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  linked_review_id uuid unique,
  decision_note text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint team_review_requests_employee_user_id_fkey
    foreign key (employee_user_id)
    references public.profiles(id)
    on delete restrict,

  constraint team_review_requests_requested_by_user_id_fkey
    foreign key (requested_by_user_id)
    references public.profiles(id)
    on delete restrict,

  constraint team_review_requests_project_id_fkey
    foreign key (project_id)
    references public.projects(id)
    on delete set null,

  constraint team_review_requests_claimed_by_fkey
    foreign key (claimed_by)
    references public.profiles(id)
    on delete restrict,

  constraint team_review_requests_resolved_by_fkey
    foreign key (resolved_by)
    references public.profiles(id)
    on delete restrict,

  constraint team_review_requests_linked_review_id_fkey
    foreign key (linked_review_id)
    references public.employee_reviews(id)
    on delete restrict,

  constraint team_review_requests_updated_by_fkey
    foreign key (updated_by)
    references public.profiles(id)
    on delete restrict,

  constraint team_review_requests_problem_length_check
    check (char_length(btrim(problem)) between 1 and 500),

  constraint team_review_requests_examples_length_check
    check (examples is null or char_length(examples) <= 5000),

  constraint team_review_requests_desired_outcome_length_check
    check (char_length(btrim(desired_outcome)) between 1 and 1000),

  constraint team_review_requests_decision_note_length_check
    check (decision_note is null or char_length(decision_note) <= 1000),

  constraint team_review_requests_state_check
    check (state in ('new', 'in_progress', 'converted', 'declined')),

  constraint team_review_requests_claim_pair_check
    check (
      (claimed_by is null and claimed_at is null)
      or (claimed_by is not null and claimed_at is not null)
    ),

  constraint team_review_requests_resolution_pair_check
    check (
      (resolved_by is null and resolved_at is null)
      or (resolved_by is not null and resolved_at is not null)
    ),

  constraint team_review_requests_lifecycle_check
    check (
      (
        state = 'new'
        and claimed_by is null
        and claimed_at is null
        and resolved_by is null
        and resolved_at is null
        and linked_review_id is null
      )
      or (
        state = 'in_progress'
        and claimed_by is not null
        and claimed_at is not null
        and resolved_by is null
        and resolved_at is null
        and linked_review_id is null
      )
      or (
        state = 'converted'
        and resolved_by is not null
        and resolved_at is not null
        and linked_review_id is not null
      )
      or (
        state = 'declined'
        and resolved_by is not null
        and resolved_at is not null
        and linked_review_id is null
      )
    )
);

create unique index if not exists idx_team_review_requests_unresolved_submitter_employee
  on public.team_review_requests(requested_by_user_id, employee_user_id)
  where state in ('new', 'in_progress');

create index if not exists idx_team_review_requests_state_created
  on public.team_review_requests(state, created_at desc, id);

drop trigger if exists trg_team_review_requests_updated_at
  on public.team_review_requests;
create trigger trg_team_review_requests_updated_at
  before update on public.team_review_requests
  for each row
  execute function public.set_updated_at();

create or replace function public.prevent_team_review_request_terminal_regression()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state in ('converted', 'declined')
     and new.state is distinct from old.state
  then
    raise exception
      'terminal team review request state cannot be changed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_team_review_request_terminal_regression() from public;
revoke all on function public.prevent_team_review_request_terminal_regression() from anon;
revoke all on function public.prevent_team_review_request_terminal_regression() from authenticated;

drop trigger if exists team_review_requests_prevent_terminal_regression
  on public.team_review_requests;
create trigger team_review_requests_prevent_terminal_regression
  before update of state on public.team_review_requests
  for each row
  execute function public.prevent_team_review_request_terminal_regression();

-- Submission is intentionally narrower than general staff access. Explicit
-- private-workspace members may submit too; otherwise only real leads and
-- directors are eligible.
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
        and actor.role in ('lead', 'director')
    );
$$;

revoke all on function public.can_submit_team_review_request() from public;
revoke all on function public.can_submit_team_review_request() from anon;
revoke all on function public.can_submit_team_review_request() from authenticated;
grant execute on function public.can_submit_team_review_request() to authenticated;

-- A single database transaction creates the scheduled review and resolves its
-- source request. The authenticated actor is always derived from auth.uid().
create or replace function public.convert_team_review_request(
  p_request_id uuid,
  p_review_date date,
  p_review_reason text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_request public.team_review_requests%rowtype;
  v_review_id uuid;
begin
  if v_actor_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not public.can_access_team() then
    raise exception 'private Team access required' using errcode = '42501';
  end if;

  if p_review_date is null or p_expected_updated_at is null then
    raise exception 'review date and expected timestamp are required'
      using errcode = '22023';
  end if;

  if p_review_reason is not null
     and char_length(btrim(p_review_reason)) not between 1 and 500
  then
    raise exception 'review reason must contain between 1 and 500 characters'
      using errcode = '22023';
  end if;

  select request.*
  into v_request
  from public.team_review_requests request
  where request.id = p_request_id
  for update;

  if not found then
    raise exception 'team review request not found' using errcode = 'P0002';
  end if;

  if v_request.updated_at is distinct from p_expected_updated_at then
    raise exception 'team review request was changed by another user'
      using errcode = '40001';
  end if;

  if not (
    v_request.state = 'new'
    or v_request.state = 'in_progress'
  ) then
    raise exception 'team review request is already resolved'
      using errcode = '23514';
  end if;

  perform 1
  from public.profiles employee
  where employee.id = v_request.employee_user_id
    and coalesce(employee.is_demo, false) = false
    and employee.role in (
      'technician',
      'manager',
      'director',
      'admin',
      'sales',
      'marketer',
      'lead'
    )
  for share;

  if not found then
    raise exception 'team review request target is no longer an internal employee'
      using errcode = '23514';
  end if;

  insert into public.employee_reviews (
    review_date,
    employee_user_id,
    candidate_name,
    reviewer_user_id,
    status,
    reason,
    outcomes,
    problems,
    recommendations
  )
  values (
    p_review_date,
    v_request.employee_user_id,
    null,
    v_actor_id,
    'scheduled',
    nullif(btrim(p_review_reason), ''),
    null,
    null,
    null
  )
  returning id into v_review_id;

  update public.team_review_requests
  set state = 'converted',
      linked_review_id = v_review_id,
      resolved_by = v_actor_id,
      resolved_at = now(),
      updated_by = v_actor_id,
      updated_at = now()
  where id = v_request.id;

  return jsonb_build_object(
    'request_id', v_request.id,
    'review_id', v_review_id
  );
end;
$$;

revoke all on function public.convert_team_review_request(uuid, date, text, timestamptz) from public;
revoke all on function public.convert_team_review_request(uuid, date, text, timestamptz) from anon;
revoke all on function public.convert_team_review_request(uuid, date, text, timestamptz) from authenticated;
grant execute on function public.convert_team_review_request(uuid, date, text, timestamptz) to authenticated;

-- Service-owned storage: no authenticated grants and no authenticated RLS
-- policies. Both application reads and ordinary writes go through guarded API
-- routes using service_role.
grant all on public.team_review_requests to postgres;
grant all on public.team_review_requests to service_role;

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

comment on table public.team_review_requests is
  'Private HR queue for review requests; API-only access and atomic conversion into employee_reviews.';
