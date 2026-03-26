-- Composite indexes for sorted result queries to avoid in-memory sorts.

create index concurrently if not exists idx_search_results_job_created
  on public.search_results (job_id, created_at);

create index concurrently if not exists idx_hh_vacancies_job_published
  on public.hh_vacancies (job_id, published_at desc);
