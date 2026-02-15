alter table public.trace_spans
  add column if not exists search_job_id uuid references public.search_parser_jobs(id) on delete cascade;

create index if not exists idx_trace_spans_search_job_id on public.trace_spans(search_job_id);

