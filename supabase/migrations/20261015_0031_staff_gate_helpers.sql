-- Helpers for the table gates in 20261015_0032 .. 0034.
--
-- 1. public.is_internal_staff() (20261015_0030) becomes PARALLEL SAFE.
--    The gates below put `(select public.is_internal_staff())` into the RLS quals of
--    big staff tables (pdl_companies has 19.5M rows; pdl_facets and wide
--    search_pdl_companies calls already run for tens of seconds). The planner refuses a
--    parallel plan for a whole query as soon as any function in it, RLS quals included,
--    is PARALLEL UNSAFE, which is the default for a new function. Marking the helper
--    safe keeps today's parallel plans for staff. It is safe: it only reads the
--    caller's profiles row and the JWT settings, which parallel workers inherit; the
--    SET search_path in its definition is allowed in parallel mode.
--
-- 2. public.is_api_robot(): true for a Bench API robot account (profile role NULL and
--    is_api_robot = true, minted by lib/bench/robotToken.ts). Robots are not staff, but
--    they read pdl_companies and their own Bench job rows with their own JWT. Users
--    cannot set either column on their own row: is_api_robot is outside the profiles
--    UPDATE column grant and prevent_profile_privilege_escalation() blocks role changes.
--    SECURITY DEFINER for the same reason as is_internal_staff(): policies on profiles
--    must not subquery profiles, and a definer helper keeps the gate an InitPlan.
--    PARALLEL SAFE for the reason above.
--
-- 3. Direct DB logins (MCP readonly, nick_ro, bots) must keep today's access through the
--    whole lockdown, which revokes anon (0032, 0033, 0036) and gates anon and
--    authenticated with RESTRICTIVE policies (0032-0035):
--    * a BYPASSRLS login that inherits anon gets explicit grants for exactly the table
--      and sequence privileges it receives through anon today, so the anon revokes do
--      not take them away (RLS never applies to it);
--    * a login WITHOUT BYPASSRLS that inherits anon or authenticated would be gated like
--      an API caller, and today's behaviour cannot be kept for it. The file stops and
--      names it; make it BYPASSRLS or drop the membership, then deploy again. The prod
--      preflight (2026-10-15) found readonly and nick_ro BYPASSRLS and not inheriting
--      authenticated; anon membership is checked by Q3 of
--      supabase/operator-sql/20261015_lockdown_preflight.sql.
--
-- NOTHING ELSE CHANGES. No table policy is touched; no lock is taken on any table.
--
-- ROLLBACK (only after 0033 and 0034 are rolled back; their gates call is_api_robot()):
--   alter function public.is_internal_staff() parallel unsafe;
--   drop function if exists public.is_api_robot();

set local lock_timeout = '3s';

do $$
begin
  if to_regprocedure('public.is_internal_staff()') is null then
    raise exception 'staff gate helpers: public.is_internal_staff() is missing; apply 20261015_0030_profiles_read_lockdown first';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.profiles'::regclass and attname = 'is_api_robot' and not attisdropped
  ) then
    raise exception 'staff gate helpers: public.profiles.is_api_robot is missing';
  end if;
end;
$$;

alter function public.is_internal_staff() parallel safe;

create or replace function public.is_api_robot()
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.id = (select auth.uid())
      and actor.is_api_robot = true
      and actor.role is null
  );
$$;

comment on function public.is_api_robot() is
  'True when the caller (auth.uid()) is a Bench API robot: profiles.is_api_robot and role NULL. '
  'SECURITY DEFINER so table policies can call it; its owner must bypass RLS on profiles.';

-- Default privileges hand new functions to PUBLIC and, after fix-roles.sql, to anon.
revoke all on function public.is_api_robot() from public;
revoke all on function public.is_api_robot() from anon;
revoke all on function public.is_api_robot() from authenticated;
grant execute on function public.is_api_robot() to authenticated;
grant execute on function public.is_api_robot() to service_role;

-- Direct DB logins that inherit an API role.
do $$
declare
  v_bad text;
  r record;
begin
  select string_agg(ro.rolname, ', ' order by ro.rolname) into v_bad
  from pg_catalog.pg_roles ro
  where ro.rolcanlogin and not ro.rolsuper and not ro.rolbypassrls
    and ro.rolname not in ('anon', 'authenticated', 'service_role', 'authenticator')
    and (pg_catalog.pg_has_role(ro.oid, 'anon', 'USAGE') or pg_catalog.pg_has_role(ro.oid, 'authenticated', 'USAGE'));
  if v_bad is not null then
    raise exception 'staff gate helpers: login role(s) % inherit anon/authenticated without BYPASSRLS; the table gates would cut them like an API caller. Grant BYPASSRLS or revoke the membership first', v_bad;
  end if;

  for r in
    select ro.rolname, c.oid::regclass as rel, c.relkind, p.priv
    from pg_catalog.pg_roles ro
    cross join pg_catalog.pg_class c
    cross join lateral unnest(case when c.relkind = 'S' then array['USAGE', 'SELECT', 'UPDATE']
                                   else array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] end) p(priv)
    where ro.rolcanlogin and not ro.rolsuper
      and ro.rolname not in ('anon', 'authenticated', 'service_role', 'authenticator')
      and pg_catalog.pg_has_role(ro.oid, 'anon', 'USAGE')
      and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and case when c.relkind = 'S' then pg_catalog.has_sequence_privilege('anon', c.oid, p.priv)
               else pg_catalog.has_table_privilege('anon', c.oid, p.priv) end
      and not exists (select 1 from pg_catalog.aclexplode(c.relacl) a
                      where a.grantee = ro.oid and a.privilege_type = p.priv)
    order by 1, 2, 4
  loop
    raise notice 'staff gate helpers: % keeps % on % (today only through anon)', r.rolname, r.priv, r.rel;
    execute format('grant %s on %s %s to %I', r.priv, case when r.relkind = 'S' then 'sequence' else 'table' end, r.rel, r.rolname);
  end loop;
end;
$$;

-- Self-check: fails the migration, never the running app.
do $$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_ok boolean;
  v_robot uuid;
  v_staff uuid;
  v_client uuid;
  v_r boolean;
  v_s boolean;
  r record;
begin
  -- Both helpers: definer, parallel safe, owner bypasses RLS on profiles, grants.
  for r in select unnest(array['public.is_internal_staff()', 'public.is_api_robot()']) as fn loop
    select p.prosecdef and p.proparallel = 's' and p.provolatile = 's'
           and (ro.rolsuper or ro.rolbypassrls
                or (pg_catalog.pg_has_role(p.proowner, c.relowner, 'USAGE') and not c.relforcerowsecurity))
      into v_ok
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles ro on ro.oid = p.proowner
    cross join pg_catalog.pg_class c
    where p.oid = r.fn::regprocedure and c.oid = 'public.profiles'::regclass;
    if not coalesce(v_ok, false) then
      raise exception 'staff gate helpers: % must be SECURITY DEFINER, STABLE, PARALLEL SAFE and owned by a role that bypasses RLS on profiles', r.fn;
    end if;
    if has_function_privilege('anon', r.fn, 'execute')
       or not has_function_privilege('authenticated', r.fn, 'execute')
       or not has_function_privilege('service_role', r.fn, 'execute') then
      raise exception 'staff gate helpers: wrong EXECUTE grants on %', r.fn;
    end if;
  end loop;

  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'staff gate helpers: % cannot SET ROLE authenticated for the self-check', current_user;
  end if;

  select id into v_robot from public.profiles where is_api_robot = true and role is null order by created_at nulls last, id limit 1;
  select id into v_staff from public.profiles
   where role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead') and coalesce(is_demo, false) = false
   order by (role = 'admin') desc, created_at nulls last, id limit 1;
  select id into v_client from public.profiles where role = 'client' order by created_at nulls last, id limit 1;

  for r in
    select u.kind, u.id from (values ('robot', v_robot), ('staff', v_staff), ('client', v_client)) u(kind, id)
    where u.id is not null
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.id, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', r.id::text, true);
    perform set_config('role', 'authenticated', true);
    select public.is_api_robot(), public.is_internal_staff() into v_r, v_s;
    perform set_config('role', v_prev_role, true);
    if v_r is distinct from (r.kind = 'robot') or v_s is distinct from (r.kind = 'staff') then
      raise exception 'staff gate helpers probe: % answers is_api_robot=% is_internal_staff=%', r.kind, v_r, v_s;
    end if;
  end loop;

  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
end;
$$;
