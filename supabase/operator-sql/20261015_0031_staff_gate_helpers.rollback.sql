-- ROLLBACK of 20261015_0031_staff_gate_helpers.sql. Run as postgres, and only after the
-- rollbacks of 0036, 0034 and 0033 (their policies, pdl_count_estimate and
-- search_pdl_companies call is_api_robot(); the drop fails while a policy uses it, and a
-- plpgsql caller left behind would fail at run time). Keep the 0031 row in portal_migrations.
begin;
set local lock_timeout = '3s';
alter function public.is_internal_staff() parallel unsafe;
drop function if exists public.is_api_robot();
commit;
