-- Improve results polling performance
create index if not exists idx_website_enrichment_queue_job_status_updated
  on public.website_enrichment_queue(job_id, status, updated_at, id);

create index if not exists idx_website_enrichment_queue_job_updated_id
  on public.website_enrichment_queue(job_id, updated_at, id);
