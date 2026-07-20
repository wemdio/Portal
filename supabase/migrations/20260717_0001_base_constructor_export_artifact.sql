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

-- ── Columns (lock-tolerant) ──────────────────────────────────────────────────
-- ADD COLUMN needs an ACCESS EXCLUSIVE lock on base_constructor_jobs — a HOT
-- table: the worker persists multi-MB `data` blobs continuously, and the deploy
-- runs this migration precheck BEFORE it drains the workers, so writes are live.
-- A plain ALTER hit the deploy's 30s lock_timeout and aborted the whole deploy
-- (55P03 lock_not_available, 2026-07-17). Live diagnosis: the blocker was the
-- NIGHTLY pg_dump, which holds ACCESS SHARE on every table for the whole dump
-- (tens of minutes — pdl_companies alone is ~19.5M rows), not worker writes.
-- Retry with a short per-attempt lock_timeout and a budget long enough to
-- outlive a dump tail: 60 x (5s lock wait + 8s sleep) = ~13 min worst case,
-- safely under the 30-min CI job limit incl. docker pull. Short 5s waits also
-- keep the ACCESS EXCLUSIVE queue from stalling other readers for long.
-- Nullable, no-default ADD COLUMN is metadata-only once the lock is held
-- (no table rewrite), so the lock is released almost immediately.
do $$
declare
  attempt int := 0;
begin
  loop
    begin
      set local lock_timeout = '5s';
      alter table public.base_constructor_jobs
        add column if not exists export_path text,
        add column if not exists export_bytes bigint;
      exit;  -- success
    exception when lock_not_available then
      attempt := attempt + 1;
      if attempt >= 60 then
        raise exception
          'base_constructor_jobs: could not acquire ACCESS EXCLUSIVE for ADD COLUMN after % attempts (~13 min) — likely colliding with nightly pg_dump; rerun the deploy later', attempt;
      end if;
      raise notice '[migration 20260717_0001] base_constructor_jobs busy, retry %/60', attempt;
      perform pg_sleep(8);
    end;
  end loop;
end $$;

comment on column public.base_constructor_jobs.export_path is
  'Path of the precomputed .csv.gz artifact in the base-constructor-exports bucket; null = no artifact yet (legacy job or upload failed), download falls back to building CSV from data.';
comment on column public.base_constructor_jobs.export_bytes is
  'Size in bytes of the gzipped export artifact (for UI/diagnostics).';

-- ── Private bucket for the artifacts ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('base-constructor-exports', 'base-constructor-exports', false)
on conflict (id) do update set public = excluded.public;
