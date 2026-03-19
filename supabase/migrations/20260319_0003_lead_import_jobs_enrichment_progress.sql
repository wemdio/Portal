-- Track enrichment progress (0.0 - 1.0) in lead_import_jobs.
-- Updated after each enrichment stage in the pipeline.

alter table public.lead_import_jobs
  add column if not exists enrichment_progress numeric not null default 0;

comment on column public.lead_import_jobs.enrichment_progress is
  'Enrichment pipeline progress 0.0-1.0, updated after each stage (DaData, Perplexity, website, phone, etc.)';
