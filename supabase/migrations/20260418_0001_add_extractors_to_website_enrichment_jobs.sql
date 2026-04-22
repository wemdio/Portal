-- Add per-extractor configuration to website_enrichment_jobs.
--
-- `extractors`  — list of ExtractorKey strings the worker should run for each URL.
--                 NULL or empty array → legacy behavior (only stack + profile).
-- `extra_cols`  — JSON array of {"key","colIndex","header"} objects describing
--                 extra spreadsheet columns to populate from the extractor results.
--                 NULL → only the original stack/profile columns are written.
--
-- Both columns are nullable to preserve backward compatibility with jobs created
-- before this migration. The worker and applier treat absence as "default behavior".

alter table public.website_enrichment_jobs
  add column if not exists extractors text[],
  add column if not exists extra_cols jsonb;

comment on column public.website_enrichment_jobs.extractors is
  'Optional array of ExtractorKey values to run (e.g. {stack,profile,customers,pricing_model}). NULL = default [stack,profile].';

comment on column public.website_enrichment_jobs.extra_cols is
  'Optional JSON array of {key,colIndex,header} configs for extractor-driven spreadsheet columns. NULL = only stack/profile written.';
