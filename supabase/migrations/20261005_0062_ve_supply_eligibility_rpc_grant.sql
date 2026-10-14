-- The VE2 worker calls this eligibility guard directly through PostgREST.
-- It was originally private to SECURITY DEFINER supply functions, so later
-- CREATE OR REPLACE statements preserved an ACL that rejected the worker RPC.
-- Keep browser roles excluded; preserve the guard body, owner and all checks.
revoke all on function public.ve_require_contact_supply_active(uuid,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ve_require_contact_supply_active(uuid,timestamptz)
  to service_role;
