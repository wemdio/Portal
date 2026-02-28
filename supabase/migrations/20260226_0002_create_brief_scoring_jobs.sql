-- Brief scoring jobs (queue + worker)
create table if not exists public.brief_scoring_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','running','completed','failed','cancelled')),
  brief_text text not null,
  total integer not null default 0,
  processed integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  created_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  error_message text
);

create table if not exists public.brief_scoring_queue (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.brief_scoring_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  row_index integer not null,
  company_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed')),
  attempt_count integer not null default 0,
  score integer,
  reason text,
  last_error text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone
);

create index if not exists idx_brief_scoring_jobs_user_id on public.brief_scoring_jobs(user_id);
create index if not exists idx_brief_scoring_jobs_status on public.brief_scoring_jobs(status);
create index if not exists idx_brief_scoring_queue_job_status on public.brief_scoring_queue(job_id, status);
create index if not exists idx_brief_scoring_queue_job_updated on public.brief_scoring_queue(job_id, updated_at desc);
create unique index if not exists idx_brief_scoring_queue_job_row
  on public.brief_scoring_queue(job_id, row_index);

-- RLS
alter table public.brief_scoring_jobs enable row level security;
alter table public.brief_scoring_queue enable row level security;

-- Jobs: owners can CRUD
drop policy if exists brief_scoring_jobs_select_own on public.brief_scoring_jobs;
create policy brief_scoring_jobs_select_own
  on public.brief_scoring_jobs
  for select
  using (auth.uid() = user_id);

drop policy if exists brief_scoring_jobs_insert_own on public.brief_scoring_jobs;
create policy brief_scoring_jobs_insert_own
  on public.brief_scoring_jobs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists brief_scoring_jobs_update_own on public.brief_scoring_jobs;
create policy brief_scoring_jobs_update_own
  on public.brief_scoring_jobs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists brief_scoring_jobs_delete_own on public.brief_scoring_jobs;
create policy brief_scoring_jobs_delete_own
  on public.brief_scoring_jobs
  for delete
  using (auth.uid() = user_id);

-- Queue: read/write only via owning job
drop policy if exists brief_scoring_queue_select_own_job on public.brief_scoring_queue;
create policy brief_scoring_queue_select_own_job
  on public.brief_scoring_queue
  for select
  using (
    exists (
      select 1
      from public.brief_scoring_jobs j
      where j.id = brief_scoring_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists brief_scoring_queue_insert_own_job on public.brief_scoring_queue;
create policy brief_scoring_queue_insert_own_job
  on public.brief_scoring_queue
  for insert
  with check (
    exists (
      select 1
      from public.brief_scoring_jobs j
      where j.id = brief_scoring_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists brief_scoring_queue_update_own_job on public.brief_scoring_queue;
create policy brief_scoring_queue_update_own_job
  on public.brief_scoring_queue
  for update
  using (
    exists (
      select 1
      from public.brief_scoring_jobs j
      where j.id = brief_scoring_queue.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.brief_scoring_jobs j
      where j.id = brief_scoring_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists brief_scoring_queue_delete_own_job on public.brief_scoring_queue;
create policy brief_scoring_queue_delete_own_job
  on public.brief_scoring_queue
  for delete
  using (
    exists (
      select 1
      from public.brief_scoring_jobs j
      where j.id = brief_scoring_queue.job_id
        and j.user_id = auth.uid()
    )
  );

-- Claim queue items atomically (uses SKIP LOCKED)
create or replace function public.claim_brief_scoring_items(p_job_id uuid, p_limit integer)
returns setof public.brief_scoring_queue
language plpgsql
as $$
begin
  return query
  with cte as (
    select id
    from public.brief_scoring_queue
    where job_id = p_job_id and status = 'pending'
    order by created_at
    limit p_limit
    for update skip locked
  )
  update public.brief_scoring_queue q
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
create or replace function public.reset_stale_brief_scoring_items(p_job_id uuid, p_minutes integer default 5)
returns integer
language plpgsql
as $$
declare
  updated_count integer;
begin
  update public.brief_scoring_queue
  set status = 'pending',
      updated_at = now(),
      started_at = null
  where job_id = p_job_id
    and status = 'processing'
    and updated_at < now() - (p_minutes || ' minutes')::interval;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

