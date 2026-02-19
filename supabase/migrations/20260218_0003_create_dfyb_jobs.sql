-- Done For You База: automated lead generation pipeline jobs
create table if not exists public.dfyb_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  brief text not null,
  company_url text,
  target_count integer not null check (target_count in (1000, 2000, 3000, 4000, 5000)),
  status text not null default 'planning'
    check (status in ('planning', 'parsing', 'processing', 'completed', 'failed', 'cancelled')),
  current_step integer not null default 0,
  current_step_name text default 'Инициализация',
  current_step_progress integer not null default 0,
  total_steps integer not null default 12,
  plan jsonb,
  data jsonb,
  result_stats jsonb,
  personalization_prompt text,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

create index if not exists idx_dfyb_jobs_user_id on public.dfyb_jobs(user_id);
create index if not exists idx_dfyb_jobs_status on public.dfyb_jobs(status);
create index if not exists idx_dfyb_jobs_created_at on public.dfyb_jobs(created_at desc);

alter table public.dfyb_jobs enable row level security;

drop policy if exists dfyb_jobs_select on public.dfyb_jobs;
create policy dfyb_jobs_select on public.dfyb_jobs for select using (auth.uid() = user_id);

drop policy if exists dfyb_jobs_insert on public.dfyb_jobs;
create policy dfyb_jobs_insert on public.dfyb_jobs for insert with check (auth.uid() = user_id);

drop policy if exists dfyb_jobs_update on public.dfyb_jobs;
create policy dfyb_jobs_update on public.dfyb_jobs for update using (auth.uid() = user_id);
