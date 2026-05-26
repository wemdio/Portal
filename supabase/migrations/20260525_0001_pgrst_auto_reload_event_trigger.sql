-- Auto-reload PostgREST schema cache on any DDL change.
--
-- Why: PostgREST holds an in-memory schema cache. Without an explicit reload,
-- newly added columns/tables stay invisible to the REST API until the cache
-- is invalidated. Symptom:
--   "Could not find the 'X' column of 'Y' in the schema cache"
-- after a migration runs but before PostgREST is notified.
--
-- app/scripts/db/ensureDatabase.js already calls
--   NOTIFY pgrst, 'reload schema'
-- after applying new migrations on startup, but ONLY when appliedCount > 0
-- (i.e. only on the deploy that first runs the migration). If that single
-- NOTIFY is missed (PostgREST connection dropped, restart timing race,
-- pgbouncer in transaction mode swallows the notify before commit, etc.),
-- the cache stays stale forever — subsequent container restarts hit
-- appliedCount == 0 and never re-send the notify.
--
-- This event trigger fires NOTIFY on EVERY ddl_command_end inside the DB,
-- regardless of who ran the DDL (migration script, manual psql, Supabase
-- Studio, ad-hoc hotfix). Belt-and-suspenders alongside the ensureDatabase
-- path. Pattern taken from official PostgREST docs:
--   https://postgrest.org/en/stable/references/schema_cache.html

create or replace function public.pgrst_watch() returns event_trigger
  language plpgsql
  as $$
begin
  notify pgrst, 'reload schema';
end;
$$;

comment on function public.pgrst_watch() is
  'Fires NOTIFY pgrst on every DDL_command_end so PostgREST reloads its schema cache. See migration 20260525_0001 for rationale.';

drop event trigger if exists pgrst_watch;
create event trigger pgrst_watch
  on ddl_command_end
  execute procedure public.pgrst_watch();

comment on event trigger pgrst_watch is
  'Auto-reload PostgREST schema cache after any DDL. Drop this trigger to disable auto-reload.';
