-- Build website-enrichment queues behind a non-claimable lifecycle gate.
alter table public.website_enrichment_jobs
  add column if not exists preparing_heartbeat_at timestamp with time zone;

alter table public.website_enrichment_jobs
  drop constraint if exists website_enrichment_jobs_status_check;

alter table public.website_enrichment_jobs
  add constraint website_enrichment_jobs_status_check
  check (status in ('preparing','pending','running','completed','failed','cancelled'))
  not valid;

alter table public.website_enrichment_jobs
  validate constraint website_enrichment_jobs_status_check;

-- Preserve the domain-diverse claim order while refusing queue work until the
-- parent job has completed preparation and has been claimed by a worker.
create or replace function public.claim_website_enrichment_items(
  p_job_id uuid,
  p_limit integer
)
returns setof public.website_enrichment_queue
language plpgsql
as $$
begin
  return query
  with candidates as (
    select q.id,
           q.url_normalized,
           q.created_at,
           coalesce(
             nullif(split_part(split_part(q.url_normalized, '://', 2), '/', 1), ''),
             q.url_normalized
           ) as host
      from public.website_enrichment_queue q
     where q.job_id = p_job_id
       and q.status = 'pending'
       and exists (
         select 1
           from public.website_enrichment_jobs j
          where j.id = p_job_id
            and j.status = 'running'
       )
  ),
  ranked as (
    select id,
           row_number() over (partition by host order by created_at) as slot,
           host,
           created_at
      from candidates
  ),
  picked as (
    select id
      from ranked
     order by slot, host, created_at
     limit p_limit
     for update skip locked
  )
  update public.website_enrichment_queue q
     set status = 'processing',
         started_at = now(),
         updated_at = now(),
         attempt_count = q.attempt_count + 1
    from picked
   where q.id = picked.id
  returning q.*;
end;
$$;

comment on function public.claim_website_enrichment_items is
  'Claims a domain-diverse queue batch only while its parent website enrichment job is running.';

-- One transaction-consistent snapshot prevents five independent COUNT queries
-- from observing a row between status transitions and inventing a false 0/N.
create or replace function public.get_website_enrichment_queue_counts(p_job_id uuid)
returns table (
  pending bigint,
  processing bigint,
  completed bigint,
  failed bigint,
  skipped bigint,
  total bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*) filter (where q.status = 'pending') as pending,
         count(*) filter (where q.status = 'processing') as processing,
         count(*) filter (where q.status = 'completed') as completed,
         count(*) filter (where q.status = 'failed') as failed,
         count(*) filter (where q.status = 'skipped') as skipped,
         count(*) as total
    from public.website_enrichment_queue q
   where q.job_id = p_job_id;
$$;

revoke execute on function public.get_website_enrichment_queue_counts(uuid)
  from public, anon, authenticated;
grant execute on function public.get_website_enrichment_queue_counts(uuid)
  to service_role;

comment on function public.get_website_enrichment_queue_counts is
  'Returns one consistent status snapshot for safe website-enrichment job finalization.';

-- The coordinator updates queue rows before incrementing the parent counters.
-- If the worker finalizes between those two statements, a late increment must
-- not push the exact final counters above total.
create or replace function public.increment_website_enrichment_job_counters(
  p_job_id uuid,
  p_processed_inc int default 0,
  p_success_inc int default 0,
  p_error_inc int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.website_enrichment_jobs
     set processed = coalesce(processed, 0) + greatest(0, p_processed_inc),
         success_count = coalesce(success_count, 0) + greatest(0, p_success_inc),
         error_count = coalesce(error_count, 0) + greatest(0, p_error_inc)
   where id = p_job_id
     and status in ('pending','running');
end;
$$;

revoke execute on function public.increment_website_enrichment_job_counters(uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.increment_website_enrichment_job_counters(uuid, integer, integer, integer)
  to service_role;

comment on function public.increment_website_enrichment_job_counters is
  'Atomically increments website-enrichment progress only while the parent job is active; late coordinator flushes cannot corrupt final counters.';
