-- Store spreadsheet tab/column metadata on jobs so the worker can
-- apply results server-side without relying on browser polling.

ALTER TABLE public.brief_scoring_jobs
  ADD COLUMN IF NOT EXISTS spreadsheet_tab_id  text,
  ADD COLUMN IF NOT EXISTS score_col_index     integer,
  ADD COLUMN IF NOT EXISTS reason_col_index    integer;

ALTER TABLE public.website_enrichment_jobs
  ADD COLUMN IF NOT EXISTS spreadsheet_tab_id  text,
  ADD COLUMN IF NOT EXISTS result_col_index    integer,
  ADD COLUMN IF NOT EXISTS result_col_header   text;
