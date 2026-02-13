-- Add structured lead fields to search_results
alter table if exists public.search_results
  add column if not exists company_name text,
  add column if not exists site text,
  add column if not exists description text,
  add column if not exists email text,
  add column if not exists provider text;

create index if not exists idx_search_results_site on public.search_results(site);

