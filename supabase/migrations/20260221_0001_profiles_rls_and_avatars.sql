-- Secure profiles access + add avatars support

-- 1) Profiles: add avatar URL field
alter table public.profiles
  add column if not exists avatar_url text;

-- 2) Profiles: enable RLS and restrict access
alter table public.profiles enable row level security;

-- Authenticated users can read profiles (used across many pages: /team, projects, tasks, etc.).
-- RLS still protects unauthenticated access.
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles
  for select
  to authenticated
  using (true);

-- Authenticated users can update only their own row.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Column-level restriction: users can update only safe fields.
revoke update on table public.profiles from authenticated;
grant update (full_name, avatar_url, email) on table public.profiles to authenticated;

