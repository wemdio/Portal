-- Rollback of 20261015_0030_profiles_read_lockdown.sql. Run as supabase_admin (or postgres)
-- with psql -v ON_ERROR_STOP=1 -f. Restores today's reads of public.profiles exactly:
-- profiles_select_authenticated using(true) was never touched, so dropping the restrictive
-- policy is enough. The explicit transaction makes lock_timeout apply: SET LOCAL outside a
-- transaction does nothing, and an unbounded DROP POLICY queued behind a long transaction
-- would stall every profiles read.
begin;
set local lock_timeout = '3s';
drop policy if exists profiles_select_self_or_staff on public.profiles;
commit;

-- Notes (not executed):
-- * Keep the row of 20261015_0030_profiles_read_lockdown.sql in public.portal_migrations, so the
--   next deploy does not re-apply the lockdown. Ship the corrected fix as a NEW migration file.
--   Only to re-apply this same file on the next deploy:
--     delete from public.portal_migrations where name = '20261015_0030_profiles_read_lockdown.sql';
-- * Optional, after the policy is gone (nothing else depends on the helper):
--     drop function if exists public.is_internal_staff();
-- * agent_query_readonly is deliberately NOT re-granted. service_role keeps EXECUTE and is its
--   only caller; re-granting anon/authenticated reopens arbitrary SQL to the public anon key.
-- * Narrower levers when only one thing is wrong:
--     every user sent to /login, PostgREST logs "permission denied for function is_internal_staff":
--       grant execute on function public.is_internal_staff() to authenticated;
--     portal-db MCP (readonly) sees no profiles: see open question on the readonly role.
-- * Code rollback is a plain git revert; none of the code changes depends on the migration.
