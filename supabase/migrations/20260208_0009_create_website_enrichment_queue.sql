-- Website enrichment jobs (queue + worker)
create table if not exists public.website_enrichment_jobs (
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

create table if not exists public.website_enrichment_queue (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.website_enrichment_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  row_index integer not null,
  url_raw text not null,
  url_normalized text not null,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','skipped')),
  attempt_count integer not null default 0,
  last_error text,
  result_text text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone
);

create table if not exists public.website_enrichment_cache (
  url_normalized text primary key,
  text text,
  last_error text,
  fetched_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  source_url text
);

-- Indexes
create index if not exists idx_website_enrichment_jobs_user_id on public.website_enrichment_jobs(user_id);
create index if not exists idx_website_enrichment_jobs_status on public.website_enrichment_jobs(status);
create index if not exists idx_website_enrichment_queue_job_status on public.website_enrichment_queue(job_id, status);
create index if not exists idx_website_enrichment_queue_job_updated on public.website_enrichment_queue(job_id, updated_at desc);
create unique index if not exists idx_website_enrichment_queue_job_row
  on public.website_enrichment_queue(job_id, row_index);
create index if not exists idx_website_enrichment_cache_expires on public.website_enrichment_cache(expires_at);

-- RLS
alter table public.website_enrichment_jobs enable row level security;
alter table public.website_enrichment_queue enable row level security;
alter table public.website_enrichment_cache enable row level security;

-- Jobs: owners can CRUD
drop policy if exists website_enrichment_jobs_select_own on public.website_enrichment_jobs;
create policy website_enrichment_jobs_select_own
  on public.website_enrichment_jobs
  for select
  using (auth.uid() = user_id);

drop policy if exists website_enrichment_jobs_insert_own on public.website_enrichment_jobs;
create policy website_enrichment_jobs_insert_own
  on public.website_enrichment_jobs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists website_enrichment_jobs_update_own on public.website_enrichment_jobs;
create policy website_enrichment_jobs_update_own
  on public.website_enrichment_jobs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists website_enrichment_jobs_delete_own on public.website_enrichment_jobs;
create policy website_enrichment_jobs_delete_own
  on public.website_enrichment_jobs
  for delete
  using (auth.uid() = user_id);

-- Queue: read/write only via owning job
drop policy if exists website_enrichment_queue_select_own_job on public.website_enrichment_queue;
create policy website_enrichment_queue_select_own_job
  on public.website_enrichment_queue
  for select
  using (
    exists (
      select 1
      from public.website_enrichment_jobs j
      where j.id = website_enrichment_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists website_enrichment_queue_insert_own_job on public.website_enrichment_queue;
create policy website_enrichment_queue_insert_own_job
  on public.website_enrichment_queue
  for insert
  with check (
    exists (
      select 1
      from public.website_enrichment_jobs j
      where j.id = website_enrichment_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists website_enrichment_queue_update_own_job on public.website_enrichment_queue;
create policy website_enrichment_queue_update_own_job
  on public.website_enrichment_queue
  for update
  using (
    exists (
      select 1
      from public.website_enrichment_jobs j
      where j.id = website_enrichment_queue.job_id
        and j.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.website_enrichment_jobs j
      where j.id = website_enrichment_queue.job_id
        and j.user_id = auth.uid()
    )
  );

drop policy if exists website_enrichment_queue_delete_own_job on public.website_enrichment_queue;
create policy website_enrichment_queue_delete_own_job
  on public.website_enrichment_queue
  for delete
  using (
    exists (
      select 1
      from public.website_enrichment_jobs j
      where j.id = website_enrichment_queue.job_id
        and j.user_id = auth.uid()
    )
  );

-- Cache: only service role should use it (no user policies)
drop policy if exists website_enrichment_cache_select_admin on public.website_enrichment_cache;
create policy website_enrichment_cache_select_admin
  on public.website_enrichment_cache
  for select
  using (
    exists (
      select 1
      from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

-- Claim queue items atomically (uses SKIP LOCKED)
create or replace function public.claim_website_enrichment_items(p_job_id uuid, p_limit integer)
returns setof public.website_enrichment_queue
language plpgsql
as $$
begin
  return query
  with cte as (
    select id
    from public.website_enrichment_queue
    where job_id = p_job_id and status = 'pending'
    order by created_at
    limit p_limit
    for update skip locked
  )
  update public.website_enrichment_queue q
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
create or replace function public.reset_stale_website_enrichment_items(p_job_id uuid, p_minutes integer default 10)
returns integer
language plpgsql
as $$
declare
  updated_count integer;
begin
  update public.website_enrichment_queue
  set status = 'pending',
      updated_at = now()
  where job_id = p_job_id
    and status = 'processing'
    and updated_at < now() - (p_minutes || ' minutes')::interval;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;
