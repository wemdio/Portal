-- Base Constructor: pipeline for processing uploaded CSV/Excel databases
create table if not exists public.base_constructor_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  file_name text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  selected_steps jsonb not null default '[]'::jsonb,
  step_config jsonb not null default '{}'::jsonb,
  current_step integer not null default 0,
  current_step_key text default '',
  current_step_progress integer not null default 0,
  total_steps integer not null default 0,
  data jsonb,
  initial_row_count integer not null default 0,
  result_stats jsonb,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

create index if not exists idx_base_constructor_jobs_user on public.base_constructor_jobs(user_id);
create index if not exists idx_base_constructor_jobs_status on public.base_constructor_jobs(status);
create index if not exists idx_base_constructor_jobs_created on public.base_constructor_jobs(created_at desc);

alter table public.base_constructor_jobs enable row level security;

drop policy if exists base_constructor_jobs_select on public.base_constructor_jobs;
create policy base_constructor_jobs_select on public.base_constructor_jobs for select using (auth.uid() = user_id);

drop policy if exists base_constructor_jobs_insert on public.base_constructor_jobs;
create policy base_constructor_jobs_insert on public.base_constructor_jobs for insert with check (auth.uid() = user_id);

drop policy if exists base_constructor_jobs_update on public.base_constructor_jobs;
create policy base_constructor_jobs_update on public.base_constructor_jobs for update using (auth.uid() = user_id);
