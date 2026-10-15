-- Lock down reads of public.profiles for signed-in users.
--
-- LEAK. profiles_select_authenticated (20260221_0001) is FOR SELECT TO authenticated
-- USING (true), and authenticated holds a table-wide SELECT (20260730_0001). GoTrue
-- signup is open, so anyone with the public anon key can get a client JWT and
-- GET /rest/v1/profiles?select=* to read every staff and client row: email, phone,
-- telegram, company, signup_utm, market, role, is_demo and the capability flags.
--
-- FIX. One RESTRICTIVE select policy. Restrictive policies are ANDed with every
-- permissive one, so a row is visible only if it is the caller's own row, or the
-- caller is internal staff: one of the 7 internal roles and not is_demo. That is the
-- rule of the middleware staff API gate, auth/internalGuard.ts and
-- can_use_payment_requests() (20260818_0002).
--   * staff keep every row and every column, exactly as today;
--   * clients (RU, ENG self-serve, demo), role-NULL robots and demo staff accounts
--     see only their own row; a JWT without a profile sees nothing;
--   * no grant changes, so every own-row read (middleware, UserProvider, blockDemo,
--     /api/user/*, UPDATE ... RETURNING, other tables' "my profile is admin"
--     subqueries) behaves as before.
-- Restrictive instead of replacing profiles_select_authenticated, because it also
-- neutralises hand-made permissive policies that exist on prod but not in the repo,
-- no future permissive policy can reopen the leak, and rollback is one DROP POLICY
-- that restores today's behaviour exactly.
--
-- ALSO CLOSED. public.agent_query_readonly(text) (20260319_0001) is SECURITY DEFINER
-- and runs any SELECT as its owner. The July restore granted ALL on all functions to
-- anon and authenticated (deploy/main-db-prod/fix-roles.sql), so
-- /rest/v1/rpc/agent_query_readonly reads profiles past any policy. Its only caller is
-- the Telegram agent on the service role (app/src/lib/telegramAgent/sqlQuery.ts), and
-- service_role keeps EXECUTE.
--
-- NO SUBLINK IN THE POLICY. The policy calls auth.uid() and is_internal_staff() directly,
-- not as (select ...) InitPlans. Prod has two hand-made policies that subquery profiles
-- itself: "Admins can update profiles" (UPDATE USING exists (select 1 from profiles ...))
-- and "Admins can insert profiles" (INSERT WITH CHECK, same). When PostgreSQL expands
-- that subquery it applies the profiles SELECT policies again, and if one of them has a
-- sublink of its own it raises 42P17 "infinite recursion detected in policy for relation
-- profiles". With (select auth.uid()) here, every UPDATE and INSERT on profiles through
-- a JWT (staff editing a profile, a client changing its locale) failed in a prod
-- emulation (15.10.2026). The price is a helper call per row that is not the caller's
-- own: about 15 us per row in PGlite, so about 1 ms for a full scan of prod's 77 profiles.
--
-- RULES FOR LATER CHANGES.
--   * Never subquery public.profiles inline in a profiles policy (42P17 recursion);
--     call a SECURITY DEFINER helper such as public.is_internal_staff().
--   * No sublink at all, not even (select auth.uid()), in a profiles SELECT policy while
--     any profiles policy (repo or prod-only) subqueries profiles: see above.
--   * Never FORCE ROW LEVEL SECURITY on profiles: the helper relies on its owner
--     bypassing RLS.
--   * A user-JWT embed of profiles (select('..., profiles(...)') or x:profiles!fk(...))
--     returns null for rows the caller cannot see unless the caller is staff, and an
--     !inner embed drops the parent row. Today every such embed runs on the service role.
--
-- SAFETY. Step 5 checks the grants, the helper's owner and the result as real callers,
-- including that an UPDATE and an INSERT on profiles through a JWT still plan (5e).
-- Any failure raises, the whole file rolls back, and the deploy fails while the old
-- build keeps serving the unchanged database. CREATE POLICY takes ACCESS EXCLUSIVE on
-- profiles, which every request reads, so the lock wait is capped at 3s
-- (ensureDatabase.js retries 55P03).
--
-- ROLLBACK (restores today's reads exactly; leave agent_query_readonly revoked):
--   begin; set local lock_timeout = '3s';
--   drop policy if exists profiles_select_self_or_staff on public.profiles; commit;

set local lock_timeout = '3s';

-- ─── 1. Staff predicate ──────────────────────────────────────────────────────
create or replace function public.is_internal_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.id = (select auth.uid())
      and coalesce(actor.is_demo, false) = false
      and actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
  );
$$;

comment on function public.is_internal_staff() is
  'True when the caller (auth.uid()) is internal staff: one of the 7 internal roles and not demo. '
  'SECURITY DEFINER so the profiles select policy can call it without recursing; its owner must bypass RLS on profiles.';

-- Default privileges hand new functions to PUBLIC and, after fix-roles.sql, to anon.
revoke all on function public.is_internal_staff() from public;
revoke all on function public.is_internal_staff() from anon;
revoke all on function public.is_internal_staff() from authenticated;
grant execute on function public.is_internal_staff() to authenticated;
grant execute on function public.is_internal_staff() to service_role;

-- ─── 2. Restrictive select policy ────────────────────────────────────────────
-- No-op today; turns RLS back on if prod ever drifted (the policy would be inert).
alter table public.profiles enable row level security;

-- Plain calls, no (select ...): see NO SUBLINK IN THE POLICY above. The own-row arm comes
-- first, so an own-row read never calls the helper.
-- anon is listed too: it has no table grant today, and if one ever appears it still
-- sees nothing.
drop policy if exists profiles_select_self_or_staff on public.profiles;
create policy profiles_select_self_or_staff
  on public.profiles
  as restrictive
  for select
  to anon, authenticated
  using (
    id = auth.uid()
    or public.is_internal_staff()
  );

-- ─── 3. Close the arbitrary-SQL RPC ──────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.agent_query_readonly(text)') is not null then
    revoke all on function public.agent_query_readonly(text) from public;
    revoke all on function public.agent_query_readonly(text) from anon;
    revoke all on function public.agent_query_readonly(text) from authenticated;
    grant execute on function public.agent_query_readonly(text) to service_role;
  end if;
end;
$$;

-- ─── 4. portal-db MCP login ──────────────────────────────────────────────────
-- If the prod-only `readonly` login reads profiles THROUGH authenticated (it inherits
-- authenticated and has no RLS bypass), the restrictive policy would apply to it and,
-- with no auth.uid(), show it 0 rows. Keep today's behaviour for that one login.
-- When readonly bypasses RLS, does not inherit authenticated, or does not exist, the
-- policy stays as created above.
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_roles r
    where r.rolname = 'readonly'
      and not r.rolsuper
      and not r.rolbypassrls
      and pg_catalog.pg_has_role('readonly', 'authenticated', 'USAGE')
      and pg_catalog.has_table_privilege('readonly', 'public.profiles', 'SELECT')
  ) then
    alter policy profiles_select_self_or_staff
      on public.profiles
      using (
        id = auth.uid()
        or public.is_internal_staff()
        or current_user = 'readonly'
      );
  end if;
end;
$$;

-- ─── 5. Self-check: fails the migration, never the running app ───────────────
do $$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_unknown     uuid := '00000000-0000-4000-8000-00000000dead';
  v_total bigint;
  v_staff uuid;
  v_client uuid;
  v_n bigint;
  v_ok boolean;
  v_who uuid;
begin
  -- 5a. RLS on and not forced.
  if not exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = 'public.profiles'::regclass
      and c.relrowsecurity
      and not c.relforcerowsecurity
  ) then
    raise exception 'profiles lockdown: public.profiles must have RLS enabled and not forced';
  end if;

  -- 5b. Grants. A REVOKE or GRANT by a non-owner only warns, so check the outcome.
  --     Missing EXECUTE for authenticated would make EVERY JWT read of profiles fail
  --     (own rows included) and middleware would send every user to /login.
  if has_function_privilege('anon', 'public.is_internal_staff()', 'execute')
     or not has_function_privilege('authenticated', 'public.is_internal_staff()', 'execute')
     or not has_function_privilege('service_role', 'public.is_internal_staff()', 'execute') then
    raise exception 'profiles lockdown: wrong EXECUTE grants on public.is_internal_staff()';
  end if;
  if to_regprocedure('public.agent_query_readonly(text)') is not null
     and (has_function_privilege('anon', 'public.agent_query_readonly(text)', 'execute')
          or has_function_privilege('authenticated', 'public.agent_query_readonly(text)', 'execute')
          or not has_function_privilege('service_role', 'public.agent_query_readonly(text)', 'execute')) then
    raise exception 'profiles lockdown: agent_query_readonly(text) is still executable by anon/authenticated, or not by service_role';
  end if;

  -- 5c. The helper's owner must bypass RLS on profiles (superuser, BYPASSRLS, or the
  --     table owner while FORCE is off). Otherwise the helper is filtered by the very
  --     policy it serves and silently answers false for staff.
  select r.rolsuper
         or r.rolbypassrls
         or (pg_catalog.pg_has_role(p.proowner, c.relowner, 'USAGE') and not c.relforcerowsecurity)
    into v_ok
  from pg_catalog.pg_proc p
  join pg_catalog.pg_roles r on r.oid = p.proowner
  cross join pg_catalog.pg_class c
  where p.oid = 'public.is_internal_staff()'::regprocedure
    and c.oid = 'public.profiles'::regclass;
  if not coalesce(v_ok, false) then
    raise exception 'profiles lockdown: owner of public.is_internal_staff() does not bypass RLS on public.profiles';
  end if;

  -- 5d. Behavioural probe, the way PostgREST runs a request. Read-only.
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'profiles lockdown: % cannot SET ROLE authenticated for the self-check; run migrations as supabase_admin or postgres', current_user;
  end if;

  select count(*) into v_total from public.profiles;
  select id into v_staff from public.profiles
   where role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(is_demo, false) = false
   order by (role = 'admin') desc, created_at nulls last, id
   limit 1;
  select id into v_client from public.profiles
   where role = 'client'
   order by created_at nulls last, id
   limit 1;

  -- A JWT whose sub has no profile: nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_unknown, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_unknown::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.profiles;
  perform set_config('role', v_prev_role, true);
  if v_n <> 0 then
    raise exception 'profiles lockdown probe: a JWT without a profile sees % rows', v_n;
  end if;

  if v_client is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_client::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into v_n from public.profiles;
    perform set_config('role', v_prev_role, true);
    if v_n <> 1 then
      raise exception 'profiles lockdown probe: a client sees % rows, expected only its own', v_n;
    end if;
    -- The columns middleware.ts and blockDemo.ts read on the caller's own row.
    perform set_config('role', 'authenticated', true);
    select count(*) into v_n
      from (select p.role, p.is_demo, p.market, p.locale from public.profiles p where p.id = v_client) own;
    perform set_config('role', v_prev_role, true);
    if v_n <> 1 then
      raise exception 'profiles lockdown probe: a client cannot read its own role/is_demo/market/locale';
    end if;
  end if;

  if v_staff is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_staff::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into v_n from public.profiles;
    perform set_config('role', v_prev_role, true);
    if v_n <> v_total then
      raise exception 'profiles lockdown probe: staff % sees % of % rows', v_staff, v_n, v_total;
    end if;
  end if;

  -- 5e. Writes through a JWT still plan. A profiles policy that subqueries profiles (prod's
  --     hand-made "Admins can update/insert profiles") raises 42P17 when PostgreSQL rewrites
  --     the statement, before any row or privilege check, so WHERE false is enough and
  --     touches nothing. A missing table or column privilege (42501) is not what this
  --     probe is about and is ignored.
  foreach v_who in array array[v_staff, v_client] loop
    continue when v_who is null;
    perform set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_who::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      execute 'update public.profiles set locale = locale where false';
    exception
      when insufficient_privilege then null;
      when invalid_object_definition then
        raise exception 'profiles lockdown probe: a profiles UPDATE as % fails: %', v_who, sqlerrm;
    end;
    begin
      execute 'insert into public.profiles (id) select $1 where false' using v_unknown;
    exception
      when insufficient_privilege then null;
      when invalid_object_definition then
        raise exception 'profiles lockdown probe: a profiles INSERT as % fails: %', v_who, sqlerrm;
    end;
    perform set_config('role', v_prev_role, true);
  end loop;

  -- The MCP exemption from step 4, when it was added and the runner can check it.
  if exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'profiles'
         and policyname = 'profiles_select_self_or_staff'
         and qual like '%readonly%'
     )
     and pg_catalog.pg_has_role(current_user, 'readonly', 'MEMBER') then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'readonly', true);
    select count(*) into v_n from public.profiles;
    perform set_config('role', v_prev_role, true);
    if v_n <> v_total then
      raise exception 'profiles lockdown probe: readonly sees % of % rows', v_n, v_total;
    end if;
  end if;

  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
end;
$$;
