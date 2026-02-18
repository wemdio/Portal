-- Add extraction_type to website_enrichment_jobs to support email scraping mode.
-- 'text' = existing behavior (extract company description text)
-- 'email' = new behavior (extract email addresses from websites)

alter table public.website_enrichment_jobs
  add column if not exists extraction_type text not null default 'text'
  check (extraction_type in ('text', 'email'));

-- Also add a separate email cache table so email results are cached independently.
create table if not exists public.email_scraper_cache (
  url_normalized text primary key,
  emails text,
  last_error text,
  fetched_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  source_url text,
  pages_scanned integer not null default 0
);

create index if not exists idx_email_scraper_cache_expires on public.email_scraper_cache(expires_at);

-- RLS: only service role should use the email cache
alter table public.email_scraper_cache enable row level security;

drop policy if exists email_scraper_cache_select_admin on public.email_scraper_cache;
create policy email_scraper_cache_select_admin
  on public.email_scraper_cache
  for select
  using (
    exists (
      select 1
      from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );
