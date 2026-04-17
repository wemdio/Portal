-- Add 'signals' extraction type for website signal detection (tech stack + business profile).
-- Reuses website_enrichment_jobs / website_enrichment_queue infrastructure.
-- Worker writes JSON {"stack":"...","profile":"..."} into queue.result_text.
-- Applier (applySignalJobResults) parses JSON and writes to TWO spreadsheet columns
-- (stack column and profile column = stack column + 1).

-- Allow 'signals' value in extraction_type check constraint
alter table public.website_enrichment_jobs
  drop constraint if exists website_enrichment_jobs_extraction_type_check;

alter table public.website_enrichment_jobs
  add constraint website_enrichment_jobs_extraction_type_check
  check (extraction_type in ('text', 'email', 'signals'));

-- Add second result column index/header for signals (Profile column).
-- For 'signals' extraction_type:
--   result_col_index   = stack column index
--   result_col_index_2 = profile column index (typically stack + 1)
-- For 'text' / 'email': result_col_index_2 stays null (single column).
alter table public.website_enrichment_jobs
  add column if not exists result_col_index_2 integer,
  add column if not exists result_col_header_2 text;
