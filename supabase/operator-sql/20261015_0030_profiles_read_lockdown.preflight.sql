-- READ-ONLY preflight for 20261015_0030_profiles_read_lockdown.sql. Nothing here writes or
-- takes more than ACCESS SHARE. Run on prod (SSH to .24 + docker exec psql) ONLY after the
-- owner's explicit yes, as the same user ensureDatabase.js uses (DATABASE_URL, supabase_admin).
-- Blocks are separated by "-- @@".

-- P1. Every policy on profiles. Expected: profiles_select_authenticated (PERMISSIVE, SELECT,
--     {authenticated}, true) and profiles_update_own (UPDATE). Extra PERMISSIVE ones are
--     neutralised by the fix. Any RESTRICTIVE one: stop and review (the migration probe will
--     refuse to commit if it hides own rows or rows from staff).
select policyname, permissive, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'profiles'
order by policyname;
-- @@

-- P2. RLS facts. Expected: rls = true, force = false.
select c.relowner::regrole as table_owner, c.relrowsecurity as rls, c.relforcerowsecurity as force
from pg_class c
where c.oid = 'public.profiles'::regclass;
-- @@

-- P3. The migration runner. Expected: supabase_admin, rolsuper = true (or BYPASSRLS / owns
--     profiles), can SET ROLE authenticated and readonly, and owns (or is superuser over)
--     agent_query_readonly so the REVOKE is not a warning.
select current_user as runner, r.rolsuper, r.rolbypassrls,
       pg_has_role(current_user, 'authenticated', 'MEMBER') as can_set_authenticated,
       pg_has_role(current_user, (select relowner from pg_class where oid = 'public.profiles'::regclass), 'USAGE') as owns_profiles,
       (select pg_has_role(current_user, p.proowner, 'USAGE') from pg_proc p
         where p.oid = to_regprocedure('public.agent_query_readonly(text)')) as owns_agent_fn
from pg_roles r
where r.rolname = current_user;
-- @@

-- P4. Table grants on profiles. Expected: authenticated SELECT (+ column UPDATE allowlist),
--     service_role all, anon nothing.
select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'profiles'
group by grantee
order by grantee;
-- @@

-- P5. The arbitrary-SQL RPC. Expected TODAY: true/true (open to the anon key). After apply:
--     false/false/true.
select has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_exec,
       p.proowner::regrole as owner
from pg_proc p
where p.oid = to_regprocedure('public.agent_query_readonly(text)');
-- @@

-- P6. Impact: who drops to their own row. staff_keeps_all_rows = no change. Investigate any
--     staff_role_demo or role_null_or_other with active_30d > 0: their staff pickers
--     (/, /tasks, /team, /projects/*) will list only themselves.
select bucket,
       count(*)::int as accounts,
       count(*) filter (where last_sign_in_at > now() - interval '30 days')::int as active_30d,
       string_agg(email, ', ' order by email) filter (where bucket in ('staff_role_demo', 'role_null_or_other')) as who
from (
  select case
           when p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
                and not coalesce(p.is_demo, false) then 'staff_keeps_all_rows'
           when p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead') then 'staff_role_demo'
           when p.role = 'client' and coalesce(p.is_demo, false) then 'client_demo'
           when p.role = 'client' and p.market = 'eng' then 'client_eng'
           when p.role = 'client' then 'client_ru'
           when p.role is null and coalesce(p.is_api_robot, false) then 'api_robot'
           else 'role_null_or_other'
         end as bucket,
         p.email,
         u.last_sign_in_at
  from public.profiles p
  left join auth.users u on u.id = p.id
) s
group by bucket
order by bucket;
-- @@

-- P7. Name is free. Expected: null.
select to_regprocedure('public.is_internal_staff()') as existing_helper;
-- @@

-- P8. DB logins that read profiles. readonly (portal-db MCP): with rolbypassrls = false and
--     inherits_authenticated = true the migration adds `or current_user = 'readonly'` to the
--     policy (keeps today's view); otherwise nothing. authenticator must NOT be able to
--     become readonly (expected false).
select r.rolname, r.rolsuper, r.rolbypassrls, r.rolinherit,
       pg_has_role(r.oid, 'authenticated', 'USAGE') as inherits_authenticated,
       has_table_privilege(r.oid, 'public.profiles', 'select') as can_select_profiles
from pg_roles r
where r.rolcanlogin and has_table_privilege(r.oid, 'public.profiles', 'select')
order by r.rolname;
-- @@
select case when exists (select 1 from pg_roles where rolname = 'readonly')
            then pg_has_role('authenticator', 'readonly', 'MEMBER') end as authenticator_can_become_readonly;
-- @@

-- P9. Realtime on profiles. Expected: no rows (or the publication is not FOR ALL TABLES).
select p.pubname, p.puballtables
from pg_publication p
where p.puballtables
   or exists (select 1 from pg_publication_tables t
              where t.pubname = p.pubname and t.schemaname = 'public' and t.tablename = 'profiles');
-- @@

-- P10. Accounts linked to the Telegram agent (service-role SQL over every table). Rows with
--      role client / demo / null are refused by the identifyUser change.
select p.role, p.market, coalesce(p.is_demo, false) as is_demo, count(*)::int as links
from public.telegram_links l
join public.profiles p on p.id = l.user_id
group by 1, 2, 3
order by 1, 2, 3;
-- @@

-- P11. Views / matviews over profiles that API roles can read. Owner-rights views and
--      matviews bypass RLS, so each row here is a leak the policy does not close.
--      Expected: no rows.
select distinct v.oid::regclass as view, v.relkind, pg_get_userbyid(v.relowner) as owner,
       coalesce(v.reloptions::text, '') as options,
       has_table_privilege('anon', v.oid, 'select') as anon_select,
       has_table_privilege('authenticated', v.oid, 'select') as auth_select
from pg_depend d
join pg_rewrite rw on rw.oid = d.objid
join pg_class v on v.oid = rw.ev_class
where d.classid = 'pg_rewrite'::regclass
  and d.refclassid = 'pg_class'::regclass
  and d.refobjid = 'public.profiles'::regclass
  and v.oid <> 'public.profiles'::regclass
order by 1;
-- @@

-- P12. SECURITY DEFINER functions callable by anon/authenticated that mention profiles.
--      Expected only gated own-row helpers and gated RPCs: can_* helpers, payment_* RPCs,
--      convert_team_review_request, team/email-subscription helpers, handle_new_user
--      (trigger, cannot be called). Anything else that returns other users' profile data
--      without a role gate must be closed before this fix counts as complete.
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef
  and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'extensions', 'graphql', 'realtime', 'storage', 'vault', 'pgsodium', 'cron')
  and p.prosrc ~* 'profiles'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
order by 1;
-- @@

-- P13. Other arbitrary-SQL holes: SECURITY DEFINER functions with dynamic SQL that anon or
--      authenticated can call. agent_query_readonly is expected TODAY; review every other row.
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef
  and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'extensions', 'graphql', 'realtime', 'storage', 'vault', 'pgsodium', 'cron')
  and p.prosrc ~* '\mexecute\M'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
order by 1;
-- @@

-- P14. GraphQL path (applies the same RLS; informational). Expected: no row.
select extname, extversion from pg_extension where extname = 'pg_graphql';
-- @@

-- P15. Right before the deploy: sessions holding locks on profiles. A long one makes the
--      migration give up after 3s (nothing applied, deploy fails, ensureDatabase retries).
select a.pid, a.usename, a.application_name, a.state, now() - a.xact_start as xact_age, l.mode,
       left(a.query, 120) as query
from pg_locks l
join pg_stat_activity a on a.pid = l.pid
where l.relation = 'public.profiles'::regclass
  and a.pid <> pg_backend_pid()
order by a.xact_start;
-- @@

-- POST-APPLY (read-only, always rolled back, no DDL; pick ids from P6):
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', '<client uuid>', 'role', 'authenticated')::text, true);
--   select count(*) from public.profiles;   -- expect 1
--   select set_config('request.jwt.claims', json_build_object('sub', '<sales or marketer uuid>', 'role', 'authenticated')::text, true);
--   select count(*) from public.profiles;   -- expect all rows
-- rollback;
-- Re-run P1, P5 and P11: the restrictive policy is listed, P5 = false/false/true.
