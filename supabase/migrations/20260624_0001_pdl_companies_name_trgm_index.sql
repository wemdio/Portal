-- pdl_companies is indexed on (country, industry, size) but NOT on name, so every
-- name lookup seq-scans ~19.5M rows. Two callers need a name lookup:
--   1) the company-base UI search  -> name ilike '%term%'
--   2) the ENG domain resolver      -> name ilike 'prefix%'  (resolveCompanyDomainViaPdl)
-- A GIN trigram index serves both ILIKE shapes (substring and prefix), turning the
-- resolver from a per-company full scan into an index probe — required before the
-- enrich step can resolve hundreds of companies within the request timeout.
--
-- One-time HEAVY build (minutes on ~19.5M rows). The migration runner wraps each
-- file in a transaction, so CONCURRENTLY is not available; pdl_companies is a
-- read-mostly, bulk-loaded catalog, so the brief write-lock is harmless — just avoid
-- deploying this during a pdl_companies refresh. statement_timeout is lifted and
-- maintenance_work_mem raised so the build completes and runs faster.
set local statement_timeout = 0;
set local maintenance_work_mem = '256MB';

create extension if not exists pg_trgm;

create index if not exists idx_pdl_companies_name_trgm
  on public.pdl_companies using gin (name gin_trgm_ops);
