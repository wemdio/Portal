-- Correct the four ENG budget functions only. The existing public-schema
-- defaults also grant new functions to direct DB logins (20261015_0036), so
-- revoking PUBLIC/anon/authenticated in 0003 did not seal these definer RPCs.
-- Keep the function owner/postgres and service_role on the three mutations;
-- the state helper is callable only by its owner/postgres.
--
-- Readonly SELECT on the ledger tables, other functions and global defaults
-- are untouched. Inspect actual ACL entries instead of naming optional roles:
-- readonly, nick_ro, supabase_auth_admin or supabase_storage_admin may be absent.
-- Idempotent roll-forward fix; do not restore the unintended EXECUTE grants.
do $$
declare
  target record;
  recipient record;
  function_oid oid;
  owner_oid oid;
  postgres_oid oid := to_regrole('postgres');
  service_oid oid := to_regrole('service_role');
begin
  for target in
    select * from (values
      ('public.he_eng_base_budget_state(uuid)', false),
      ('public.he_eng_base_budget_begin(uuid,uuid)', true),
      ('public.he_eng_base_budget_reserve(uuid,uuid,uuid,text,text,text,bigint)', true),
      ('public.he_eng_base_budget_settle(uuid,uuid,uuid,bigint,bigint)', true)
    ) as functions(signature, allow_service)
  loop
    function_oid := to_regprocedure(target.signature);
    if function_oid is null then
      raise exception 'ENG base budget grants: missing function %, apply 20261020_0003 first', target.signature;
    end if;
    select p.proowner into owner_oid from pg_catalog.pg_proc p where p.oid = function_oid;
    for recipient in
      select distinct acl.grantee, role.rolname
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
      left join pg_catalog.pg_roles role on role.oid = acl.grantee
      where p.oid = function_oid and acl.privilege_type = 'EXECUTE'
        and acl.grantee <> owner_oid
        and acl.grantee is distinct from postgres_oid
        and not (target.allow_service and acl.grantee is not distinct from service_oid)
    loop
      if recipient.grantee = 0 then
        execute pg_catalog.format('revoke execute on function %s from public', function_oid::regprocedure);
      else
        execute pg_catalog.format('revoke execute on function %s from %I',
          function_oid::regprocedure, recipient.rolname);
      end if;
    end loop;
  end loop;
end;
$$;
