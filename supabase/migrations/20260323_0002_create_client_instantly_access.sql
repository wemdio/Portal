-- Maps client users to their allowed Instantly resources (campaigns, lead lists).
-- Admin assigns these manually; client can only read their own rows.

create table if not exists public.client_instantly_access (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references public.profiles(id) on delete cascade,
  resource_type text not null check (resource_type in ('campaign', 'lead_list')),
  resource_id text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_user_id, resource_type, resource_id)
);

create index if not exists idx_client_instantly_access_user
  on public.client_instantly_access(client_user_id);

alter table public.client_instantly_access enable row level security;

create policy "Clients can read own access rows"
  on public.client_instantly_access
  for select
  using (client_user_id = auth.uid());

create policy "Service role full access"
  on public.client_instantly_access
  for all
  using (true)
  with check (true);
