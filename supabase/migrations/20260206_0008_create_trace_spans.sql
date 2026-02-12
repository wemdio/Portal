-- Trace spans table: hierarchical tracing for jobs/tasks (Logfire-style)
create table if not exists public.trace_spans (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null,                              -- groups all spans in one trace
  parent_span_id uuid references public.trace_spans(id) on delete cascade,
  name text not null,                                   -- span name, e.g. "hh.execute", "hh.fetch_vacancies"
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  input jsonb not null default '{}'::jsonb,             -- input parameters/context
  output jsonb not null default '{}'::jsonb,            -- result/output data
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  duration_ms integer,                                  -- computed on end
  user_id uuid references public.profiles(id) on delete set null,
  job_id uuid references public.parser_jobs(id) on delete cascade,
  level text not null default 'info'
    check (level in ('info', 'warn', 'error')),
  message text,                                         -- optional human-readable description
  created_at timestamp with time zone not null default now()
);

-- Indexes for efficient querying
create index if not exists idx_trace_spans_trace_id on public.trace_spans(trace_id);
create index if not exists idx_trace_spans_parent_span_id on public.trace_spans(parent_span_id);
create index if not exists idx_trace_spans_job_id on public.trace_spans(job_id);
create index if not exists idx_trace_spans_user_id on public.trace_spans(user_id);
create index if not exists idx_trace_spans_started_at on public.trace_spans(started_at desc);
create index if not exists idx_trace_spans_status on public.trace_spans(status);

-- RLS: admins can read, service role can insert/update
alter table public.trace_spans enable row level security;

drop policy if exists trace_spans_select_admin on public.trace_spans;
create policy trace_spans_select_admin on public.trace_spans
  for select using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

drop policy if exists trace_spans_insert_service on public.trace_spans;
create policy trace_spans_insert_service on public.trace_spans
  for insert with check (true);

drop policy if exists trace_spans_update_service on public.trace_spans;
create policy trace_spans_update_service on public.trace_spans
  for update using (true);

-- Enable realtime
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trace_spans'
  ) then
    alter publication supabase_realtime add table public.trace_spans;
  end if;
end
$$;

-- Cleanup function
create or replace function public.cleanup_trace_spans(retention_days integer default 30)
returns void
language sql
as $$
  delete from public.trace_spans
  where created_at < now() - (retention_days || ' days')::interval;
$$;
