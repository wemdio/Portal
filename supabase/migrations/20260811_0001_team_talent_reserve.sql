-- Private HR talent reserve. Browser roles have no table privileges or RLS
-- policies; authenticated callers must pass can_access_team() in the API
-- before the trusted server client reads or mutates these rows.

create table if not exists public.team_talent_reserve_entries (
  id uuid primary key default gen_random_uuid(),
  contact text not null,
  candidate_name text not null,
  vacancy_direction text not null,
  test_assignment text,
  test_result text,
  test_sent_on date,
  interview_on date,
  revisit_on date,
  comment text,
  revisit_note text,
  stage text not null default 'new',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint team_talent_reserve_entries_contact_check
    check (char_length(btrim(contact)) between 1 and 500),
  constraint team_talent_reserve_entries_candidate_name_check
    check (char_length(btrim(candidate_name)) between 1 and 200),
  constraint team_talent_reserve_entries_vacancy_direction_check
    check (char_length(btrim(vacancy_direction)) between 1 and 500),
  constraint team_talent_reserve_entries_test_assignment_check
    check (test_assignment is null or char_length(test_assignment) <= 5000),
  constraint team_talent_reserve_entries_test_result_check
    check (test_result is null or char_length(test_result) <= 500),
  constraint team_talent_reserve_entries_comment_check
    check (comment is null or char_length(comment) <= 5000),
  constraint team_talent_reserve_entries_revisit_note_check
    check (revisit_note is null or char_length(revisit_note) <= 500),
  constraint team_talent_reserve_entries_stage_check
    check (stage in ('new', 'test', 'interview', 'reserve', 'return_later', 'hired', 'rejected', 'archived')),
  constraint team_talent_reserve_entries_return_later_check
    check (
      stage <> 'return_later'
      or revisit_on is not null
      or nullif(btrim(revisit_note), '') is not null
    ),
  constraint team_talent_reserve_entries_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null,
  constraint team_talent_reserve_entries_updated_by_fkey
    foreign key (updated_by) references public.profiles(id) on delete set null
);

drop trigger if exists trg_team_talent_reserve_entries_updated_at
  on public.team_talent_reserve_entries;
create trigger trg_team_talent_reserve_entries_updated_at
  before update on public.team_talent_reserve_entries
  for each row
  execute function public.set_updated_at();

create index if not exists idx_team_talent_reserve_entries_stage_updated_at
  on public.team_talent_reserve_entries(stage, updated_at desc, id);
create index if not exists idx_team_talent_reserve_entries_revisit_on
  on public.team_talent_reserve_entries(revisit_on)
  where revisit_on is not null;
create index if not exists idx_team_talent_reserve_entries_interview_on
  on public.team_talent_reserve_entries(interview_on)
  where interview_on is not null;
create index if not exists idx_team_talent_reserve_entries_created_at
  on public.team_talent_reserve_entries(created_at desc, id);

alter table public.team_talent_reserve_entries enable row level security;
alter table public.team_talent_reserve_entries force row level security;

revoke all on public.team_talent_reserve_entries from public;
revoke all on public.team_talent_reserve_entries from anon;
revoke all on public.team_talent_reserve_entries from authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'revoke all on public.team_talent_reserve_entries from readonly';
  end if;
end;
$$;

grant all on public.team_talent_reserve_entries to service_role;
grant all on public.team_talent_reserve_entries to postgres;
