-- Per-user default board preference
-- Each user can pin one board as their personal default on /board.

alter table public.profiles
  add column if not exists default_board_id uuid references public.task_boards(id) on delete set null;

-- Allow authenticated users to update their own default_board_id
-- (extends the existing column-level grant from 20260221_0001_profiles_rls_and_avatars.sql)
grant update (full_name, avatar_url, email, default_board_id) on table public.profiles to authenticated;
