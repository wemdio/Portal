-- Email sequence generator (ported from n8n) tables

create table if not exists public.email_sequence_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('draft', 'running', 'completed', 'failed')),
  brief jsonb not null default '{}'::jsonb,
  segments jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  error_message text
);

create index if not exists idx_email_sequence_runs_user_id on public.email_sequence_runs(user_id);

create table if not exists public.email_sequence_segments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.email_sequence_runs(id) on delete cascade,
  segment_index integer not null,
  segment_text text not null,
  segment_research text,
  pains_and_solutions text,
  tasks_and_solutions text,
  social_proof text,
  cases_lpr text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists idx_email_sequence_segments_run_segment_unique
  on public.email_sequence_segments(run_id, segment_index);
create index if not exists idx_email_sequence_segments_run_id
  on public.email_sequence_segments(run_id);

create table if not exists public.email_sequence_letters (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.email_sequence_runs(id) on delete cascade,
  segment_index integer not null,
  letter_index integer not null check (letter_index between 1 and 4),
  content text not null,
  created_at timestamp with time zone not null default now()
);

create unique index if not exists idx_email_sequence_letters_run_segment_letter_unique
  on public.email_sequence_letters(run_id, segment_index, letter_index);
create index if not exists idx_email_sequence_letters_run_id
  on public.email_sequence_letters(run_id);

-- RLS
alter table public.email_sequence_runs enable row level security;
alter table public.email_sequence_segments enable row level security;
alter table public.email_sequence_letters enable row level security;

-- Runs: owners can CRUD
drop policy if exists email_sequence_runs_select_own on public.email_sequence_runs;
create policy email_sequence_runs_select_own
  on public.email_sequence_runs
  for select
  using (auth.uid() = user_id);

drop policy if exists email_sequence_runs_insert_own on public.email_sequence_runs;
create policy email_sequence_runs_insert_own
  on public.email_sequence_runs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists email_sequence_runs_update_own on public.email_sequence_runs;
create policy email_sequence_runs_update_own
  on public.email_sequence_runs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists email_sequence_runs_delete_own on public.email_sequence_runs;
create policy email_sequence_runs_delete_own
  on public.email_sequence_runs
  for delete
  using (auth.uid() = user_id);

-- Segments: access via owning run
drop policy if exists email_sequence_segments_select_own_run on public.email_sequence_segments;
create policy email_sequence_segments_select_own_run
  on public.email_sequence_segments
  for select
  using (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_segments.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_segments_insert_own_run on public.email_sequence_segments;
create policy email_sequence_segments_insert_own_run
  on public.email_sequence_segments
  for insert
  with check (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_segments.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_segments_update_own_run on public.email_sequence_segments;
create policy email_sequence_segments_update_own_run
  on public.email_sequence_segments
  for update
  using (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_segments.run_id
        and r.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_segments.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_segments_delete_own_run on public.email_sequence_segments;
create policy email_sequence_segments_delete_own_run
  on public.email_sequence_segments
  for delete
  using (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_segments.run_id
        and r.user_id = auth.uid()
    )
  );

-- Letters: access via owning run
drop policy if exists email_sequence_letters_select_own_run on public.email_sequence_letters;
create policy email_sequence_letters_select_own_run
  on public.email_sequence_letters
  for select
  using (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_letters.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_letters_insert_own_run on public.email_sequence_letters;
create policy email_sequence_letters_insert_own_run
  on public.email_sequence_letters
  for insert
  with check (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_letters.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_letters_delete_own_run on public.email_sequence_letters;
create policy email_sequence_letters_delete_own_run
  on public.email_sequence_letters
  for delete
  using (
    exists (
      select 1
      from public.email_sequence_runs r
      where r.id = email_sequence_letters.run_id
        and r.user_id = auth.uid()
    )
  );

