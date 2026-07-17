-- Precomputed CSV-export artifact for base-constructor jobs (Fix B of the
-- slow-download incident, 2026-07-17).
--
-- Why: the download endpoint used to pull the whole `data` jsonb (up to ~50MB)
-- out of PostgREST and build the CSV per request — 13-15s TTFB for big bases.
-- Now the worker builds a gzipped CSV ONCE at job completion and stores it in
-- a private storage bucket; the download route streams the ~3MB artifact with
-- sub-second TTFB. Old jobs (export_path is null) fall back to the legacy
-- per-request path and get lazily backfilled on first download.
--
-- The bucket is private: only the service-role key touches it (worker upload,
-- download route). Service role bypasses RLS, so no storage.objects policies
-- are needed.

insert into storage.buckets (id, name, public)
values ('base-constructor-exports', 'base-constructor-exports', false)
on conflict (id) do update set public = excluded.public;

alter table public.base_constructor_jobs
  add column if not exists export_path text,
  add column if not exists export_bytes bigint;

comment on column public.base_constructor_jobs.export_path is
  'Path of the precomputed .csv.gz artifact in the base-constructor-exports bucket; null = no artifact yet (legacy job or upload failed), download falls back to building CSV from data.';
comment on column public.base_constructor_jobs.export_bytes is
  'Size in bytes of the gzipped export artifact (for UI/diagnostics).';
