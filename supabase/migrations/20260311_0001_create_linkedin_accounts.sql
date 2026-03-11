-- LinkedIn Companies: accounts (login/password, encrypted)
create table if not exists public.linkedin_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  login text not null,
  password_encrypted text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists linkedin_accounts_user_idx
  on public.linkedin_accounts (user_id);

alter table public.linkedin_accounts enable row level security;

create policy linkedin_accounts_select_own on public.linkedin_accounts
  for select to authenticated using (user_id = auth.uid());
create policy linkedin_accounts_insert_own on public.linkedin_accounts
  for insert to authenticated with check (user_id = auth.uid());
create policy linkedin_accounts_update_own on public.linkedin_accounts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy linkedin_accounts_delete_own on public.linkedin_accounts
  for delete to authenticated using (user_id = auth.uid());
