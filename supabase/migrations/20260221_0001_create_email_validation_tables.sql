-- Email validation jobs (queue + worker)
create table if not exists public.email_validation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed','cancelled')),
  total integer not null default 0,
  processed integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

create table if not exists public.email_validation_queue (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.email_validation_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  row_index integer not null,
  email_raw text not null,
  email_normalized text not null,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed')),
  attempt_count integer not null default 0,
  last_error text,
  -- Validation result fields
  result text check (result in ('ok','invalid','disposable','catch_all','unknown')),
  quality text check (quality in ('good','bad','risky')),
  is_free boolean,
  is_role boolean,
  is_disposable boolean,
  is_catch_all boolean,
  did_you_mean text,
  mx_found boolean,
  smtp_code integer,
  details jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone
);

-- Domain-level cache: MX records, catch-all status, disposable flag per domain
create table if not exists public.email_validation_domain_cache (
  domain text primary key,
  mx_hosts text[],
  mx_found boolean not null default false,
  is_catch_all boolean,
  is_disposable boolean not null default false,
  checked_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null
);

-- Indexes
create index if not exists idx_email_validation_jobs_user_id on public.email_validation_jobs(user_id);
create index if not exists idx_email_validation_jobs_status on public.email_validation_jobs(status);
create index if not exists idx_email_validation_queue_job_status on public.email_validation_queue(job_id, status);
create index if not exists idx_email_validation_queue_job_updated on public.email_validation_queue(job_id, updated_at desc);
create unique index if not exists idx_email_validation_queue_job_row
  on public.email_validation_queue(job_id, row_index);
create index if not exists idx_email_validation_domain_cache_expires on public.email_validation_domain_cache(expires_at);

-- RLS
alter table public.email_validation_jobs enable row level security;
alter table public.email_validation_queue enable row level security;
alter table public.email_validation_domain_cache enable row level security;

-- Jobs: owners can CRUD
drop policy if exists email_validation_jobs_select_own on public.email_validation_jobs;
create policy email_validation_jobs_select_own
  on public.email_validation_jobs for select using (auth.uid() = user_id);
drop policy if exists email_validation_jobs_insert_own on public.email_validation_jobs;
create policy email_validation_jobs_insert_own
  on public.email_validation_jobs for insert with check (auth.uid() = user_id);
drop policy if exists email_validation_jobs_update_own on public.email_validation_jobs;
create policy email_validation_jobs_update_own
  on public.email_validation_jobs for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists email_validation_jobs_delete_own on public.email_validation_jobs;
create policy email_validation_jobs_delete_own
  on public.email_validation_jobs for delete using (auth.uid() = user_id);

-- Queue: read/write only via owning job
drop policy if exists email_validation_queue_select_own_job on public.email_validation_queue;
create policy email_validation_queue_select_own_job
  on public.email_validation_queue for select
  using (exists (
    select 1 from public.email_validation_jobs j
    where j.id = email_validation_queue.job_id and j.user_id = auth.uid()
  ));
drop policy if exists email_validation_queue_insert_own_job on public.email_validation_queue;
create policy email_validation_queue_insert_own_job
  on public.email_validation_queue for insert
  with check (exists (
    select 1 from public.email_validation_jobs j
    where j.id = email_validation_queue.job_id and j.user_id = auth.uid()
  ));
drop policy if exists email_validation_queue_update_own_job on public.email_validation_queue;
create policy email_validation_queue_update_own_job
  on public.email_validation_queue for update
  using (exists (
    select 1 from public.email_validation_jobs j
    where j.id = email_validation_queue.job_id and j.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.email_validation_jobs j
    where j.id = email_validation_queue.job_id and j.user_id = auth.uid()
  ));
drop policy if exists email_validation_queue_delete_own_job on public.email_validation_queue;
create policy email_validation_queue_delete_own_job
  on public.email_validation_queue for delete
  using (exists (
    select 1 from public.email_validation_jobs j
    where j.id = email_validation_queue.job_id and j.user_id = auth.uid()
  ));

-- Domain cache: only service role (no user policies needed)
drop policy if exists email_validation_domain_cache_select_admin on public.email_validation_domain_cache;
create policy email_validation_domain_cache_select_admin
  on public.email_validation_domain_cache for select
  using (exists (
    select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'
  ));

-- Claim queue items atomically (SKIP LOCKED for concurrency safety)
create or replace function public.claim_email_validation_items(p_job_id uuid, p_limit integer)
returns setof public.email_validation_queue
language plpgsql
as $$
begin
  return query
  with cte as (
    select id
    from public.email_validation_queue
    where job_id = p_job_id and status = 'pending'
    order by created_at
    limit p_limit
    for update skip locked
  )
  update public.email_validation_queue q
  set status = 'processing',
      started_at = now(),
      updated_at = now(),
      attempt_count = q.attempt_count + 1
  from cte
  where q.id = cte.id
  returning q.*;
end;
$$;

-- Reset stale "processing" items back to pending
create or replace function public.reset_stale_email_validation_items(p_job_id uuid, p_minutes integer default 5)
returns integer
language plpgsql
as $$
declare
  updated_count integer;
begin
  update public.email_validation_queue
  set status = 'pending',
      updated_at = now()
  where job_id = p_job_id
    and status = 'processing'
    and updated_at < now() - (p_minutes || ' minutes')::interval;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;
