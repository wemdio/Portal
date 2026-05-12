-- Structural fix: mirror Supabase's default privileges to objects created
-- by the `postgres` role.
--
-- WHY THIS EXISTS
-- ────────────────
-- Our `ensureDatabase.js` migration runner connects as the `postgres`
-- role (see app/scripts/db/ensureDatabase.js — it picks up DATABASE_URL
-- which on the VPS uses postgres://postgres:...@main-postgres). Inside
-- the Supabase-provisioned cluster, `public` has default privileges
-- pre-configured, but **only for objects created by `supabase_admin`**:
--
--   pg_default_acl, grantor=supabase_admin, schema=public:
--     TABLES:    anon=r, authenticated=arwd, service_role=arwdDxt
--     SEQUENCES: authenticated=rU,           service_role=rwU
--     FUNCTIONS: service_role=X
--
-- When the runner role differs, every `create table public.X` lands with
-- empty ACLs for anon/authenticated/service_role, and our service-role
-- API hits `permission denied for table ...`. May-2026 incident with
-- client_support_threads on the production VPS is the documented case.
-- The author of each new table has been working around this manually
-- with one-off GRANTs (see client_tariffs, email_sequence_v2_*, etc.),
-- and forgetting to do it is silent — local tests pass, prod breaks.
--
-- This migration plugs the hole by replicating the supabase_admin
-- default-ACLs for the postgres role too. It applies to FUTURE objects
-- only (Postgres semantics); existing tables that are missing GRANTs
-- still need their own migration (see e.g.
-- 20260509_0002_client_support_grants.sql).
--
-- Idempotent: ALTER DEFAULT PRIVILEGES with the same target rewrites the
-- pg_default_acl row in place. Safe to re-apply.
--
-- Roles assumed present (Supabase-managed): postgres, supabase_admin,
-- anon, authenticated, service_role. The DO-block degrades to a no-op
-- on environments missing the Supabase role set (e.g. a bare local
-- postgres used in unit tests), so this won't break non-Supabase CI.

do $$
declare
  v_have_anon          boolean := exists(select 1 from pg_roles where rolname = 'anon');
  v_have_authenticated boolean := exists(select 1 from pg_roles where rolname = 'authenticated');
  v_have_service_role  boolean := exists(select 1 from pg_roles where rolname = 'service_role');
  v_have_postgres      boolean := exists(select 1 from pg_roles where rolname = 'postgres');
begin
  if not (v_have_postgres and v_have_anon and v_have_authenticated and v_have_service_role) then
    raise notice 'public_default_privileges_for_postgres: skipping — Supabase role set not present (postgres=% anon=% authenticated=% service_role=%)',
      v_have_postgres, v_have_anon, v_have_authenticated, v_have_service_role;
    return;
  end if;

  -- TABLES
  execute 'alter default privileges for role postgres in schema public
             grant all on tables to service_role';
  execute 'alter default privileges for role postgres in schema public
             grant select, insert, update, delete on tables to authenticated';
  execute 'alter default privileges for role postgres in schema public
             grant select on tables to anon';

  -- SEQUENCES (identity / serial columns)
  execute 'alter default privileges for role postgres in schema public
             grant usage, select on sequences to authenticated, service_role';
  execute 'alter default privileges for role postgres in schema public
             grant select on sequences to anon';

  -- FUNCTIONS (RPC endpoints behind PostgREST)
  execute 'alter default privileges for role postgres in schema public
             grant execute on functions to service_role, authenticated, anon';

  raise notice 'public_default_privileges_for_postgres: applied for role postgres in schema public';
end
$$;
