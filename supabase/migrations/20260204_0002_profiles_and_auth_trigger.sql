-- Profiles table for user metadata
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text default 'technician',
  created_at timestamp with time zone not null default now()
);

-- Ensure columns exist (for older schemas)
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists created_at timestamp with time zone;

-- Ensure defaults
alter table public.profiles alter column role set default 'technician';
alter table public.profiles alter column created_at set default now();

create index if not exists idx_profiles_email on public.profiles(email);

-- Trigger: create profile on auth user insert
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full_name text;
  v_role text;
begin
  v_full_name := nullif(new.raw_user_meta_data->>'full_name', '');
  v_role := nullif(new.raw_user_meta_data->>'role', '');
  if v_role is null then
    v_role := 'technician';
  end if;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(v_full_name, split_part(new.email, '@', 1)),
    v_role
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        role = excluded.role;

  return new;
exception when others then
  -- Do not block auth signup because of profiles insert failure
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
