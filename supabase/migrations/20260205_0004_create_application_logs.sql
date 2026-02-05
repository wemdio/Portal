-- Application logs table
create table if not exists public.application_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone not null default now(),
  level text not null,
  source text not null,
  event text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  user_id uuid references public.profiles(id) on delete set null,
  request_id text,
  route text,
  ip text
);

create index if not exists idx_application_logs_created_at
  on public.application_logs(created_at desc);
create index if not exists idx_application_logs_level
  on public.application_logs(level);
create index if not exists idx_application_logs_source
  on public.application_logs(source);
create index if not exists idx_application_logs_user_id
  on public.application_logs(user_id);
create index if not exists idx_application_logs_request_id
  on public.application_logs(request_id);

-- RLS
alter table public.application_logs enable row level security;

-- Admins can read logs
drop policy if exists application_logs_select_admin on public.application_logs;
create policy application_logs_select_admin
  on public.application_logs
  for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
    )
  );

-- Only service role can insert logs
drop policy if exists application_logs_insert_service on public.application_logs;
create policy application_logs_insert_service
  on public.application_logs
  for insert
  with check (auth.role() = 'service_role');

-- Enable realtime for logs table
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'application_logs'
  ) then
    alter publication supabase_realtime add table public.application_logs;
  end if;
end;
$$;

-- Optional cleanup function for retention policies
create or replace function public.cleanup_application_logs(retention_days int default 30)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.application_logs
  where created_at < now() - make_interval(days => retention_days);
end;
$$;
