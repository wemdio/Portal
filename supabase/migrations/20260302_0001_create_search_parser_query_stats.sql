-- Per-query statistics for search parser jobs: up to which Google page we went, etc.
create table if not exists public.search_parser_query_stats (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.search_parser_jobs(id) on delete cascade,
  query text not null,
  query_index integer not null,
  provider text,
  last_google_page integer,
  results_count integer not null default 0,
  created_at timestamp with time zone not null default now(),
  unique(job_id, query_index)
);

comment on column public.search_parser_query_stats.last_google_page is 'До какой страницы в Google зашли (1-based). Для Serper = 1. Для DDG/Bing/Mojeek = null.';

create index if not exists idx_search_parser_query_stats_job_id on public.search_parser_query_stats(job_id);

alter table public.search_parser_query_stats enable row level security;

drop policy if exists search_parser_query_stats_select_own on public.search_parser_query_stats;
create policy search_parser_query_stats_select_own
  on public.search_parser_query_stats for select
  using (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_parser_query_stats.job_id
      and j.user_id = auth.uid()
    )
  );

drop policy if exists search_parser_query_stats_insert_own on public.search_parser_query_stats;
create policy search_parser_query_stats_insert_own
  on public.search_parser_query_stats for insert
  with check (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_parser_query_stats.job_id
      and j.user_id = auth.uid()
    )
  );

drop policy if exists search_parser_query_stats_update_own on public.search_parser_query_stats;
create policy search_parser_query_stats_update_own
  on public.search_parser_query_stats for update
  using (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_parser_query_stats.job_id
      and j.user_id = auth.uid()
    )
  );

drop policy if exists search_parser_query_stats_delete_own on public.search_parser_query_stats;
create policy search_parser_query_stats_delete_own
  on public.search_parser_query_stats for delete
  using (
    exists (
      select 1 from public.search_parser_jobs j
      where j.id = search_parser_query_stats.job_id
      and j.user_id = auth.uid()
    )
  );
