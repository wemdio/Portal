-- Close the public anon key, SECURITY DEFINER functions and owner-rights views.
--
-- LEAK 1: ANON. After the July 2026 restore, deploy/main-db-prod/fix-roles.sql ran
-- GRANT ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public TO anon, plus
-- matching default privileges. Every browser bundle ships the anon key, and Kong
-- lets anon reach /rest/v1. So anyone could read and write each table that has no
-- RLS or an open `TO public USING (true)` policy, and use 48 sequences. No app
-- path reads PostgREST without a session: public pages go through API routes on
-- the service role, and sign-in goes through GoTrue. Three objects keep a
-- deliberate anon grant (lk_cfg keys anon_select / anon_insert below).
--
-- LEAK 2: SECURITY DEFINER FUNCTIONS. They run as their owner, a superuser that
-- bypasses RLS. Many are executable by PUBLIC (that is, anon) and by any signed-in
-- account, including clients and open ENG signups. Examples: agent_query_readonly(text)
-- runs any SELECT; the cleanup_* functions delete rows; the yandex_maps_catalog_*
-- functions write.
--
-- LEAK 3: VIEWS. Views without security_invoker run with their owner's rights:
-- sender_threads, sender_mailbox_stats, sender_lead_queue,
-- v_sales_ai_stale_transcripts, and the prod-only public.buckets, objects,
-- migrations and s3_multipart_uploads(_parts). These bypass RLS for every grantee,
-- and sender_mailbox_stats, buckets and objects are even writable through the view.
-- A grep of app/src, app/worker, app/scripts and services shows every view is read
-- only with the service role.
--
-- FIX. All steps read the catalog, so prod-only objects are covered too.
--   1. anon loses every privilege on every relation in public, except the deliberate
--      ones listed below.
--   2. anon and authenticated lose every privilege on every view in public. Nothing
--      reads a view with a user JWT (lk_cfg views_for_jwt is empty). service_role,
--      postgres, supabase_admin and readonly keep theirs.
--   3. Every SECURITY DEFINER function in public that is not an extension member:
--      - PUBLIC and anon lose EXECUTE;
--      - authenticated keeps EXECUTE only on the allowlist below, plus any definer
--        function a policy for authenticated or PUBLIC calls;
--      - service_role keeps exactly what it can execute today. It gets an explicit
--        grant first, so losing PUBLIC does not take EXECUTE away from it;
--      - a pg_cron job owned by a non-superuser keeps EXECUTE on the function its
--        command calls (explicit grant to that user).
--   4. Default privileges. In public, no role's default ACL grants anon anything
--      any more. For the migration runner (postgres), new functions are no longer
--      executable by PUBLIC: anon is a member of PUBLIC, so this is the only way to
--      keep anon away from new functions. authenticated and service_role get an
--      explicit schema-level default instead, so their effective access to new
--      functions in public stays as it is. So do the direct logins that call functions
--      in public and used to get EXECUTE through PUBLIC: readonly (portal-db MCP),
--      nick_ro, supabase_auth_admin (GoTrue hooks) and supabase_storage_admin, each only
--      if it exists and is not a superuser (lk_cfg direct_fn_roles). Without that, a
--      view or query of theirs that calls a function created by a later migration would
--      fail with "permission denied for function", silently, after the deploy.
--      Any OTHER non-superuser role that must call a function created by a later
--      migration needs an explicit GRANT EXECUTE in that migration. The extensions
--      schema keeps PUBLIC. authenticated and service_role defaults on tables and
--      sequences do not change.
--   5. Direct DB roles (readonly MCP, nick_ro, Django-style logins) keep their
--      table access. If any of them received a privilege only through anon
--      membership, it is re-granted to that role explicitly.
--
-- WHAT DOES NOT CHANGE
--   * staff and client table access through the authenticated role. No table grant
--     or policy for authenticated is touched here; the per-table shards do that.
--   * the RLS helpers and capability RPCs that staff pages call with their JWT.
--   * service_role, postgres, supabase_admin, readonly and nick_ro (all superuser
--     or BYPASSRLS), and triggers (a trigger needs no EXECUTE to fire).
--   * EXECUTE on functions that later migrations create, for authenticated,
--     service_role and the direct_fn_roles above (step 4).
--
-- DEVIATIONS, deliberate
--   * staff lose REST access to the 15 views (they have never used it).
--   * readonly, nick_ro and other non-superuser logins lose EXECUTE on definer
--     functions they could call only through PUBLIC. Nothing in the repo calls them
--     that way, and those calls would run as a superuser. For functions created
--     later, the direct_fn_roles keep EXECUTE through the step-4 default (definer
--     ones included, exactly as through PUBLIC today); a later definer function that
--     they must not call revokes it explicitly.
--   * supabase_admin's built-in PUBLIC EXECUTE on new functions is left as is,
--     because a global revoke would also hit platform schemas on future image
--     upgrades. supabase_admin only creates objects in public during a restore,
--     and that restore must use the patched fix-roles.sql.
--
-- SAFETY
--   * Requires public.is_internal_staff() (20261015_0030_profiles_read_lockdown) and
--     public.is_api_robot() (20261015_0031); the table gates of 0032-0034 call them.
--   * GRANT, REVOKE and ALTER DEFAULT PRIVILEGES only rewrite catalog rows; unlike
--     CREATE POLICY or ENABLE RLS they do not take ACCESS EXCLUSIVE on the target.
--     Before rewriting a table's ACL the file takes SHARE UPDATE EXCLUSIVE on it (blocks
--     only VACUUM/ANALYZE/CREATE INDEX, not reads or writes): prod runs PostgreSQL 15.8,
--     which predates the minor-release fix for the race between an in-place pg_class
--     update by (auto)VACUUM and a concurrent GRANT/REVOKE of the same row.
--     The probe objects (steps 0 and 6) are new and private to this transaction.
--     lock_timeout guards against the unexpected; ensureDatabase.js retries 55P03.
--   * An allowlisted staff RPC whose exact signature is missing while a function of the
--     same name exists (prod drifted from the repo) aborts the file instead of being
--     revoked from authenticated silently.
--   * Step 6 checks the end state against a snapshot taken in step 0, then probes
--     as anon, a client, a staff member and service_role the way PostgREST does.
--     Any mismatch raises, the file rolls back, and the deploy fails while the old
--     build keeps serving the unchanged database.
--   * Idempotent: a second run changes nothing and passes the same checks.
--
-- ROLLBACK
--   Step 0 copies every ACL this file can change (public relations and their columns,
--   public functions, default ACLs) into lockdown_backup.acl_20261015_0036 inside the
--   same transaction, so the snapshot is exactly the state before this file, whatever
--   ran before it in the same deploy. A re-run keeps the first snapshot. Step 7 records
--   the state this file leaves (acl_after) in the same rows.
--   supabase/operator-sql/20261015_0036_anon_definer_view_lockdown.rollback.sql restores
--   the "before" ACL of every entry 0036 changed, but only while the entry still equals
--   acl_after: an ACL a later migration changed is left alone and listed (a WARNING),
--   so a rollback never silently reopens what a newer migration closed. Narrow levers:
--     grant execute on function public.<fn>(<args>) to authenticated;
--     grant select on public.<view> to authenticated;
--   To re-apply a corrected version, keep this file's portal_migrations row and ship a
--   NEW migration.

set local lock_timeout = '3s';

-- ─── 0. Preconditions, configuration and "before" snapshot ─────────────────────
do $$
begin
  if to_regprocedure('public.is_internal_staff()') is null or to_regprocedure('public.is_api_robot()') is null then
    raise exception 'anon lockdown: public.is_internal_staff() or public.is_api_robot() is missing; apply 20261015_0030 and 20261015_0031 first';
  end if;
  if (select count(*) from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'anon lockdown: Supabase API roles anon/authenticated/service_role are missing';
  end if;
  if not (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
     and not (pg_catalog.pg_has_role(current_user, 'anon', 'MEMBER')
              and pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER')
              and pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER')) then
    raise exception 'anon lockdown: % cannot act as anon/authenticated/service_role for the self-check; run migrations as postgres', current_user;
  end if;
end;
$$;

-- ACL snapshot for the rollback file. Not exposed: PostgREST serves only public,
-- storage and graphql_public, and no API role gets USAGE on this schema.
create schema if not exists lockdown_backup;
revoke all on schema lockdown_backup from public;
-- grants-lint: no-service-role-grant lockdown_backup.acl_20261015_0036 — operator-only ACL snapshot for the rollback file; no API role may read it
create table if not exists lockdown_backup.acl_20261015_0036 (
  kind text not null check (kind in ('rel', 'col', 'fn', 'defacl')),
  ident text not null,
  acl text,
  captured_at timestamptz not null default now(),
  acl_after text,
  after_captured_at timestamptz,
  primary key (kind, ident)
);
alter table lockdown_backup.acl_20261015_0036 add column if not exists acl_after text;
alter table lockdown_backup.acl_20261015_0036 add column if not exists after_captured_at timestamptz;
revoke all on table lockdown_backup.acl_20261015_0036 from public;
do $$
begin
  execute 'revoke all on schema lockdown_backup from anon, authenticated, service_role';
  execute 'revoke all on table lockdown_backup.acl_20261015_0036 from anon, authenticated, service_role';
end;
$$;
insert into lockdown_backup.acl_20261015_0036 (kind, ident, acl)
select 'rel', pg_catalog.format('%I.%I', 'public', c.relname), c.relacl::text
from pg_catalog.pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
union all
select 'col', pg_catalog.format('%I.%I', 'public', c.relname) || ' ' || pg_catalog.quote_ident(att.attname), att.attacl::text
from pg_catalog.pg_class c
join pg_catalog.pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and att.attacl is not null
union all
select 'fn', p.oid::regprocedure::text, p.proacl::text
from pg_catalog.pg_proc p
where p.pronamespace = 'public'::regnamespace
union all
select 'defacl',
       pg_catalog.pg_get_userbyid(d.defaclrole) || '|'
         || case when d.defaclnamespace = 0 then '' else d.defaclnamespace::regnamespace::text end
         || '|' || d.defaclobjtype::text,
       d.defaclacl::text
from pg_catalog.pg_default_acl d
on conflict (kind, ident) do nothing;
-- Default ACL rows this file may create, recorded as absent (NULL) so the rollback
-- removes them again.
insert into lockdown_backup.acl_20261015_0036 (kind, ident, acl)
select 'defacl', x, null
from unnest(array['postgres||f', 'postgres|public|f', 'postgres|extensions|f']) x
where exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres')
on conflict (kind, ident) do nothing;

create temp table lk_cfg (k text primary key, v text[]) on commit drop;
insert into lk_cfg values
  -- Deliberate anon objects (task decision). database_review_row_marks has no anon
  -- consumer in the code (the guest page uses an API route on the service role);
  -- drop it from both lists once the owner confirms.
  ('anon_select', array['public.reglament_documents', 'public.companies_directory', 'public.database_review_row_marks']),
  ('anon_insert', array['public.database_review_row_marks']),
  -- Views that a user JWT reads directly. None today.
  ('views_for_jwt', array[]::text[]),
  -- SECURITY DEFINER functions that authenticated keeps. Each is either a policy
  -- helper or an RPC that staff code calls with the user's JWT, and each checks
  -- auth.uid(), a staff capability or the caller's own row first.
  ('auth_definers', array[
    'public.is_internal_staff()',                      -- profiles + table-shard policies
    'public.can_access_email_subscriptions()',          -- policy email_subscriptions_select
    'public.can_manage_email_subscriptions()',          -- policies email_subscriptions_insert/update
    'public.can_access_team()',                         -- policies + UserProvider + lib/auth/teamAccess.ts
    'public.can_mutate_team_data(text)',                -- policies on projects/project_periods
    'public.can_view_team_activity_plan()',             -- policy + api/team/activity-plan
    'public.can_manage_team_activity_plan()',           -- api/team/activity-plan/helpers.ts
    'public.can_submit_team_review_request()',          -- UserProvider + teamAccess
    'public.can_view_team_review_requests_shared()',    -- UserProvider + teamAccess
    'public.can_use_payment_requests()',                -- lib/payments/server.ts
    'public.can_manage_payment_requests()',             -- lib/payments/server.ts
    'public.convert_team_review_request(uuid,date,text,timestamp with time zone)',
    'public.payment_requests_read_model(date)',
    'public.submit_payment_request_with_budget(uuid,text,text,numeric,uuid,text,text,text,text,date,text,text)',
    'public.transition_payment_request(uuid,text,timestamp with time zone,text,date,text)',
    'public.record_email_subscription_payment_today(uuid,text,text,integer,numeric,text,text,text)',
    'public.decide_email_subscription(uuid,text,text,timestamp with time zone)',
    'public.copilot_dialog_stats(uuid)',                -- staff browser; counts only the caller's configs
    -- Gate helper (20261015_0031) and the staff EU/US count (20261015_0033):
    'public.is_api_robot()',
    'public.pdl_count_estimate(text[],text[],text[],text)',
    -- staff EU/US company search and export (api/company-base/search, /export), made
    -- SECURITY DEFINER with its own caller check in 20261015_0033:
    'public.search_pdl_companies(text[],text[],text[],text,text,integer)'
  ]),
  -- Direct logins that call functions in public and used to get EXECUTE on new ones
  -- through PUBLIC (step 4). Missing roles and superusers are skipped.
  ('direct_fn_roles', array['readonly', 'nick_ro', 'supabase_auth_admin', 'supabase_storage_admin']);

-- Privileges of the roles that must NOT change (API roles other than anon, and direct
-- non-superuser logins that inherit anon or authenticated), plus anon itself.
create temp table lk_rel_before on commit drop as
select c.oid as relid, c.relkind, r.rolname,
       array(
         select p
         from unnest(case when c.relkind = 'S'
                          then array['USAGE', 'SELECT', 'UPDATE']
                          else array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] end) p
         where case when c.relkind = 'S' then pg_catalog.has_sequence_privilege(r.oid, c.oid, p)
                    else pg_catalog.has_table_privilege(r.oid, c.oid, p) end
       )
       || array(
         select 'COLUMN ' || p
         from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
         where case when c.relkind = 'S' then false else pg_catalog.has_any_column_privilege(r.oid, c.oid, p) end
       ) as privs
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join pg_catalog.pg_roles r
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  and (r.rolname in ('anon', 'authenticated', 'service_role')
       or (not r.rolsuper
           and r.rolname not in ('authenticator')
           and (pg_catalog.pg_has_role(r.oid, 'anon', 'USAGE')
                or pg_catalog.pg_has_role(r.oid, 'authenticated', 'USAGE'))));

create temp table lk_fn_before on commit drop as
select p.oid as fnoid, p.prosecdef,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';

-- Default-privilege probe: create a table, a sequence and a SECURITY DEFINER function
-- as p_owner, record what the API roles get, and drop them. Run once before the
-- change and once after, so step 6 can compare.
create function pg_temp.lk_probe(p_owner name)
returns table (kind text, rolname text, privs text[], raw_acl text)
language plpgsql
as $$
declare
  v_prev text := current_setting('role');
  v_tbl oid;
  v_seq oid;
  v_fn oid;
begin
  drop function if exists public._anon_lockdown_probe_fn();
  drop table if exists public._anon_lockdown_probe_tbl;
  drop sequence if exists public._anon_lockdown_probe_seq;
  perform pg_catalog.set_config('role', p_owner, true);
  -- grants-lint: no-service-role-grant public._anon_lockdown_probe_tbl — transient probe; created and dropped inside this transaction to test default privileges
  create table public._anon_lockdown_probe_tbl (id int);
  create sequence public._anon_lockdown_probe_seq;
  create function public._anon_lockdown_probe_fn() returns int language sql security definer as 'select 1';
  perform pg_catalog.set_config('role', v_prev, true);
  -- Runtime lookups: a regclass/regprocedure literal would be frozen into the cached
  -- plan and point at the previous call's (dropped) objects.
  v_tbl := pg_catalog.to_regclass('public._anon_lockdown_probe_tbl');
  v_seq := pg_catalog.to_regclass('public._anon_lockdown_probe_seq');
  v_fn  := pg_catalog.to_regprocedure('public._anon_lockdown_probe_fn()');

  -- The API roles, plus the direct logins step 4 keeps on new functions.
  return query
  with probed as (
    select r.oid, r.rolname
    from pg_catalog.pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
       or r.rolname = any (coalesce((select c.v from lk_cfg c where c.k = 'direct_fn_roles'), array[]::text[]))
  )
  select 'table'::text, r.rolname::text,
         array(select x from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) x
               where pg_catalog.has_table_privilege(r.oid, v_tbl, x)),
         (select c.relacl::text from pg_catalog.pg_class c where c.oid = v_tbl)
  from probed r
  union all
  select 'sequence', r.rolname::text,
         array(select x from unnest(array['USAGE', 'SELECT', 'UPDATE']) x
               where pg_catalog.has_sequence_privilege(r.oid, v_seq, x)),
         (select c.relacl::text from pg_catalog.pg_class c where c.oid = v_seq)
  from probed r
  union all
  select 'function', r.rolname::text,
         case when pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')
              then array['EXECUTE'] else array[]::text[] end,
         (select p.proacl::text from pg_catalog.pg_proc p where p.oid = v_fn)
  from probed r;

  drop function public._anon_lockdown_probe_fn();
  drop table public._anon_lockdown_probe_tbl;
  drop sequence public._anon_lockdown_probe_seq;
end;
$$;

create temp table lk_probe_before on commit drop as
select o.rolname as owner, x.*
from pg_catalog.pg_roles o
cross join lateral pg_temp.lk_probe(o.rolname) x
where o.rolname in ('postgres', 'supabase_admin')
  and pg_catalog.pg_has_role(current_user, o.oid, 'MEMBER');

-- SHARE UPDATE EXCLUSIVE before rewriting a table's ACL (see SAFETY). Views and
-- sequences get no in-place updates from VACUUM.
create function pg_temp.lk_hold(p_rel oid)
returns void
language plpgsql
as $$
begin
  if (select c.relkind from pg_catalog.pg_class c where c.oid = p_rel) in ('r', 'p', 'm') then
    execute pg_catalog.format('lock table %s in share update exclusive mode', p_rel::regclass);
  end if;
end;
$$;

-- ─── 1-5. Changes ──────────────────────────────────────────────────────────────
do $$
declare
  v_anon oid := 'anon'::regrole;
  v_auth oid := 'authenticated'::regrole;
  v_public oid := 'public'::regnamespace;
  v_prev_role text := current_setting('role');
  v_sel text[] := (select v from lk_cfg where k = 'anon_select');
  v_ins text[] := (select v from lk_cfg where k = 'anon_insert');
  v_jwt_views text[] := (select v from lk_cfg where k = 'views_for_jwt');
  v_keep oid[];
  v_missing text;
  v_public_grants text;
  r record;
begin
  -- 1. anon on relations ------------------------------------------------------
  -- A table grant to PUBLIC would also reach anon. Revoking it would change every
  -- other role too, so stop and let a human decide (none exist in the repo).
  select string_agg(c.oid::regclass::text, ', ') into v_public_grants
  from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
  where c.relnamespace = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and a.grantee = 0;
  if v_public_grants is not null then
    raise exception 'anon lockdown: relations granted to PUBLIC (reach anon too): %', v_public_grants;
  end if;

  -- REVOKE by a superuser acts as the object owner, which is the grantor of every
  -- anon grant seen on prod (supabase_admin or postgres). A second pass revokes as
  -- any other grantor. REVOKE ALL ON TABLE also removes column grants.
  for r in
    select c.oid, c.relkind, pg_catalog.format('%I.%I', n.nspname, c.relname) as qn
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.oid = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and (exists (select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee = v_anon)
           or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                      where att.attrelid = c.oid and a.grantee = v_anon))
      -- A deliberate object already holding exactly its target grant is left alone,
      -- so a second run does not rewrite its ACL.
      and not (
        c.oid = any (array(select to_regclass(t)::oid from unnest(v_sel) t))
        and not exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                        where att.attrelid = c.oid and a.grantee = v_anon)
        and not exists (select 1 from pg_catalog.aclexplode(c.relacl) a
                        where a.grantee = v_anon and (a.grantor <> c.relowner or a.is_grantable))
        and array(select a.privilege_type::text from pg_catalog.aclexplode(c.relacl) a
                  where a.grantee = v_anon order by 1)
            = array(select x from unnest(array['SELECT']
                                         || case when c.oid = any (array(select to_regclass(t)::oid from unnest(v_ins) t))
                                                 then array['INSERT'] else array[]::text[] end) x order by 1)
      )
  loop
    perform pg_temp.lk_hold(r.oid);
    execute pg_catalog.format('revoke all on %s %s from anon',
      case when r.relkind = 'S' then 'sequence' else 'table' end, r.qn);
  end loop;
  for r in
    select distinct c.oid, c.relkind, pg_catalog.format('%I.%I', n.nspname, c.relname) as qn,
           pg_catalog.pg_get_userbyid(a.grantor) as grantor
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
    where n.oid = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and a.grantee = v_anon
      and a.grantor <> c.relowner
  loop
    perform pg_temp.lk_hold(r.oid);
    perform pg_catalog.set_config('role', r.grantor, true);
    execute pg_catalog.format('revoke all on %s %s from anon',
      case when r.relkind = 'S' then 'sequence' else 'table' end, r.qn);
    perform pg_catalog.set_config('role', v_prev_role, true);
  end loop;

  -- Deliberate public objects.
  for r in select t from unnest(v_sel) t
           where to_regclass(t) is not null and not pg_catalog.has_table_privilege(v_anon, to_regclass(t), 'SELECT') loop
    perform pg_temp.lk_hold(to_regclass(r.t));
    execute pg_catalog.format('grant select on table %s to anon', r.t);
  end loop;
  for r in select t from unnest(v_ins) t
           where to_regclass(t) is not null and not pg_catalog.has_table_privilege(v_anon, to_regclass(t), 'INSERT') loop
    perform pg_temp.lk_hold(to_regclass(r.t));
    execute pg_catalog.format('grant insert on table %s to anon', r.t);
  end loop;

  -- 2. Views: only the roles that bypass RLS keep them ------------------------
  for r in
    select c.oid, pg_catalog.format('%I.%I', n.nspname, c.relname) as qn
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.oid = v_public and c.relkind in ('v', 'm')
      and c.oid <> all (array(select to_regclass(t)::oid from unnest(v_jwt_views) t where to_regclass(t) is not null))
      and (exists (select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee = v_auth)
           or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                      where att.attrelid = c.oid and a.grantee = v_auth))
  loop
    execute pg_catalog.format('revoke all on table %s from authenticated', r.qn);
  end loop;
  for r in
    select distinct pg_catalog.format('%I.%I', n.nspname, c.relname) as qn, pg_catalog.pg_get_userbyid(a.grantor) as grantor
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
    where n.oid = v_public and c.relkind in ('v', 'm') and a.grantee = v_auth
      and a.grantor <> c.relowner
      and c.oid <> all (array(select to_regclass(t)::oid from unnest(v_jwt_views) t where to_regclass(t) is not null))
  loop
    perform pg_catalog.set_config('role', r.grantor, true);
    execute pg_catalog.format('revoke all on table %s from authenticated', r.qn);
    perform pg_catalog.set_config('role', v_prev_role, true);
  end loop;

  -- 3. SECURITY DEFINER functions ---------------------------------------------
  -- Keep-set: the static allowlist (when present) plus every definer function a
  -- policy for authenticated or PUBLIC calls, or that a constraint, default, index
  -- or generated column depends on (whoever writes the table needs EXECUTE).
  select array_agg(x) into v_keep from (
    select to_regprocedure(s)::oid as x
    from unnest((select v from lk_cfg where k = 'auth_definers')) s
    where to_regprocedure(s) is not null
    union
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef
    join pg_catalog.pg_policy pol on d.classid = 'pg_catalog.pg_policy'::regclass and pol.oid = d.objid
    where d.refclassid = 'pg_catalog.pg_proc'::regclass
      and pol.polroles && array[0::oid, v_auth]
    union
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef
    where d.refclassid = 'pg_catalog.pg_proc'::regclass
      and d.classid in ('pg_catalog.pg_constraint'::regclass, 'pg_catalog.pg_attrdef'::regclass)
    union
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef
    join pg_catalog.pg_class ic on d.classid = 'pg_catalog.pg_class'::regclass and ic.oid = d.objid and ic.relkind = 'i'
    where d.refclassid = 'pg_catalog.pg_proc'::regclass
  ) k;
  v_keep := coalesce(v_keep, array[]::oid[]);

  -- An allowlisted signature that does not resolve while a function of that name
  -- exists means prod drifted from the repo: that staff RPC would lose EXECUTE for
  -- authenticated silently. Stop instead. A name that does not exist at all is skipped.
  select string_agg(s || ' (present: ' || (
           select string_agg(p.oid::regprocedure::text, ', ')
           from pg_catalog.pg_proc p
           where p.pronamespace = v_public and p.proname = split_part(split_part(s, '(', 1), '.', 2)) || ')', '; ')
    into v_missing
  from unnest((select v from lk_cfg where k = 'auth_definers')) s
  where to_regprocedure(s) is null
    and exists (select 1 from pg_catalog.pg_proc p
                where p.pronamespace = v_public and p.proname = split_part(split_part(s, '(', 1), '.', 2));
  if v_missing is not null then
    raise exception 'anon lockdown: allowlisted staff functions changed signature: %; update lk_cfg auth_definers', v_missing;
  end if;
  select string_agg(s, ', ') into v_missing
  from unnest((select v from lk_cfg where k = 'auth_definers')) s
  where to_regprocedure(s) is null;
  if v_missing is not null then
    raise notice 'anon lockdown: allowlisted functions not present here (skipped): %', v_missing;
  end if;

  -- pg_cron jobs run as their scheduler. A non-superuser job user that reached a
  -- definer function only through PUBLIC (e.g. cleanup_old_project_notes) gets an
  -- explicit grant, so revoking PUBLIC does not break the job.
  if to_regclass('cron.job') is not null
     and exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = to_regclass('cron.job') and attname = 'username' and not attisdropped) then
    for r in execute $q$
      select distinct j.username,
             pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as fn
      from cron.job j
      join pg_catalog.pg_roles ro on ro.rolname = j.username and not ro.rolsuper
      join pg_catalog.pg_proc p on p.prosecdef and j.command ~* ('\m' || p.proname || '\s*\(')
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where pg_catalog.has_function_privilege(ro.oid, p.oid, 'EXECUTE')
    $q$
    loop
      raise notice 'anon lockdown: pg_cron user % keeps EXECUTE on %', r.username, r.fn;
      execute pg_catalog.format('grant execute on function %s to %I', r.fn, r.username);
    end loop;
  end if;

  for r in
    select p.oid,
           pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as fn,
           b.svc, b.auth
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join lk_fn_before b on b.fnoid = p.oid
    where n.oid = v_public and p.prosecdef
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    -- Explicit grants first, so removing PUBLIC takes nothing from the roles that keep it.
    if r.svc then
      execute pg_catalog.format('grant execute on function %s to service_role', r.fn);
    end if;
    if r.oid = any (v_keep) and r.auth then
      execute pg_catalog.format('grant execute on function %s to authenticated', r.fn);
    elsif not (r.oid = any (v_keep)) then
      execute pg_catalog.format('revoke all on function %s from authenticated', r.fn);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon', r.fn);
  end loop;

  -- Grants made by a role other than the owner survive the owner's REVOKE.
  for r in
    select distinct pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as fn,
           pg_catalog.pg_get_userbyid(a.grantor) as grantor,
           case when a.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end as grantee
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
         pg_catalog.aclexplode(p.proacl) a
    where n.oid = v_public and p.prosecdef
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and (a.grantee in (0, v_anon) or (a.grantee = v_auth and not (p.oid = any (v_keep))))
      and a.grantor <> p.proowner
  loop
    perform pg_catalog.set_config('role', r.grantor, true);
    execute pg_catalog.format('revoke all on function %s from %s', r.fn, r.grantee);
    perform pg_catalog.set_config('role', v_prev_role, true);
  end loop;

  -- 4. Default privileges -----------------------------------------------------
  -- No role's defaults (global or in public) grant anon anything.
  for r in
    select pg_catalog.pg_get_userbyid(d.defaclrole) as rolname, d.defaclnamespace, d.defaclobjtype
    from pg_catalog.pg_default_acl d
    where (d.defaclnamespace = 0 or d.defaclnamespace = v_public)
      and exists (select 1 from pg_catalog.aclexplode(d.defaclacl) a where a.grantee = v_anon)
  loop
    if r.defaclobjtype not in ('r', 'S', 'f', 'T', 'n') then
      raise exception 'anon lockdown: unexpected default-ACL object type % for role %', r.defaclobjtype, r.rolname;
    end if;
    execute pg_catalog.format('alter default privileges for role %I %s revoke all on %s from anon',
      r.rolname,
      case when r.defaclnamespace = 0 then '' else 'in schema public' end,
      case r.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                           when 'T' then 'types' when 'n' then 'schemas' end);
  end loop;

  -- The migration runner's new functions: no PUBLIC (that is how anon reached them).
  -- authenticated and service_role keep EXECUTE through an explicit default in public,
  -- and the extensions schema keeps PUBLIC, so extensions created there later still work.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role';
    -- Direct logins that reached new functions through PUBLIC (header, step 4).
    for r in
      select ro.rolname
      from pg_catalog.pg_roles ro
      where ro.rolname = any (coalesce((select c.v from lk_cfg c where c.k = 'direct_fn_roles'), array[]::text[]))
        and not ro.rolsuper
      order by 1
    loop
      execute pg_catalog.format('alter default privileges for role postgres in schema public grant execute on functions to %I', r.rolname);
    end loop;
    if to_regnamespace('extensions') is not null then
      execute 'alter default privileges for role postgres in schema extensions grant execute on functions to public';
    end if;
    execute 'alter default privileges for role postgres revoke execute on functions from public';
  end if;

  -- 5. Direct DB roles keep every table privilege they had --------------------
  for r in
    select pg_catalog.format('%I.%I', n.nspname, c.relname) as qn, c.oid, c.relkind, b.rolname, p as priv
    from lk_rel_before b
    join pg_catalog.pg_class c on c.oid = b.relid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest(b.privs) p
    where b.rolname not in ('anon', 'authenticated', 'service_role')
      and p not like 'COLUMN %'
      and not case when c.relkind = 'S' then pg_catalog.has_sequence_privilege(b.rolname, c.oid, p)
                   else pg_catalog.has_table_privilege(b.rolname, c.oid, p) end
  loop
    raise notice 'anon lockdown: re-granting % on % to %, which had it only through anon/authenticated', r.priv, r.qn, r.rolname;
    perform pg_temp.lk_hold(r.oid);
    execute pg_catalog.format('grant %s on %s %s to %I', r.priv,
      case when r.relkind = 'S' then 'sequence' else 'table' end, r.qn, r.rolname);
  end loop;
end;
$$;

-- ─── 6. Self-check: fails the migration, never the running app ────────────────
do $$
declare
  v_anon oid := 'anon'::regrole;
  v_auth oid := 'authenticated'::regrole;
  v_public oid := 'public'::regnamespace;
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_sel text[] := (select v from lk_cfg where k = 'anon_select');
  v_ins text[] := (select v from lk_cfg where k = 'anon_insert');
  v_jwt_views text[] := (select v from lk_cfg where k = 'views_for_jwt');
  v_keep_static oid[];
  v_bad text;
  v_rel text;
  v_staff uuid;
  v_client uuid;
  v_b boolean;
  r record;
begin
  -- 6a. anon: nothing in public except the deliberate grants. ------------------
  select string_agg(c.oid::regclass::text, ', ') into v_bad
  from pg_catalog.pg_class c
  where c.relnamespace = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and (
      case when c.relkind = 'S'
           then pg_catalog.has_sequence_privilege(v_anon, c.oid, 'USAGE,SELECT,UPDATE')
           else pg_catalog.has_table_privilege(v_anon, c.oid,
                  case when c.oid = any (array(select to_regclass(t)::oid from unnest(v_sel) t))
                       then 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                            || case when c.oid = any (array(select to_regclass(t)::oid from unnest(v_ins) t)) then '' else ',INSERT' end
                       else 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' end)
                or (not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_sel) t)))
                    and pg_catalog.has_any_column_privilege(v_anon, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
      end
      -- MAINTAIN (PG17+) and anything has_*_privilege does not name:
      or exists (select 1 from pg_catalog.aclexplode(c.relacl) a
                 where a.grantee in (0, v_anon)
                   and not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_sel) t)) and a.privilege_type = 'SELECT')
                   and not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_ins) t)) and a.privilege_type = 'INSERT'))
    );
  if v_bad is not null then
    raise exception 'anon lockdown: anon still holds privileges on %', v_bad;
  end if;
  select string_agg(distinct c.oid::regclass::text, ', ') into v_bad
  from pg_catalog.pg_class c
  join pg_catalog.pg_attribute att on att.attrelid = c.oid,
       pg_catalog.aclexplode(att.attacl) a
  where c.relnamespace = v_public and a.grantee in (0, v_anon);
  if v_bad is not null then
    raise exception 'anon lockdown: anon still holds column privileges on %', v_bad;
  end if;
  select string_agg(t, ', ') into v_bad from unnest(v_sel) t
  where to_regclass(t) is not null and not pg_catalog.has_table_privilege(v_anon, to_regclass(t), 'SELECT');
  if v_bad is not null then raise exception 'anon lockdown: deliberate anon SELECT missing on %', v_bad; end if;
  select string_agg(t, ', ') into v_bad from unnest(v_ins) t
  where to_regclass(t) is not null and not pg_catalog.has_table_privilege(v_anon, to_regclass(t), 'INSERT');
  if v_bad is not null then raise exception 'anon lockdown: deliberate anon INSERT missing on %', v_bad; end if;

  -- 6b. authenticated, service_role and direct roles: unchanged, except that
  --     authenticated has nothing on views. ----------------------------------
  select string_agg(pg_catalog.format('%s/%s: %s -> %s', c.oid::regclass, b.rolname, b.privs, a.privs), '; ') into v_bad
  from lk_rel_before b
  join pg_catalog.pg_class c on c.oid = b.relid
  cross join lateral (
    select array(
             select p
             from unnest(case when c.relkind = 'S'
                              then array['USAGE', 'SELECT', 'UPDATE']
                              else array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] end) p
             where case when c.relkind = 'S' then pg_catalog.has_sequence_privilege(b.rolname, c.oid, p)
                        else pg_catalog.has_table_privilege(b.rolname, c.oid, p) end)
           || array(
             select 'COLUMN ' || p
             from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
             where case when c.relkind = 'S' then false else pg_catalog.has_any_column_privilege(b.rolname, c.oid, p) end) as privs
  ) a
  where b.rolname <> 'anon'
    and a.privs is distinct from (
      case when b.rolname = 'authenticated' and c.relkind in ('v', 'm')
                and not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_jwt_views) t)))
           then array[]::text[]
           else b.privs end);
  if v_bad is not null then
    raise exception 'anon lockdown: relation privileges changed unexpectedly: %', v_bad;
  end if;

  -- 6c. Functions. --------------------------------------------------------------
  select array_agg(to_regprocedure(s)::oid) into v_keep_static
  from unnest((select v from lk_cfg where k = 'auth_definers')) s where to_regprocedure(s) is not null;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = v_public and p.prosecdef
    and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and (pg_catalog.has_function_privilege(v_anon, p.oid, 'EXECUTE')
         or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                    where a.grantee = 0));
  if v_bad is not null then
    raise exception 'anon lockdown: PUBLIC/anon can still execute SECURITY DEFINER %', v_bad;
  end if;

  -- authenticated: only the keep-set, and only what it already had; service_role and
  -- invoker functions: exactly as before.
  select string_agg(pg_catalog.format('%s (auth %s->%s, svc %s->%s)', p.oid::regprocedure, b.auth,
                      pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE'), b.svc,
                      pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')), '; ') into v_bad
  from pg_catalog.pg_proc p
  join lk_fn_before b on b.fnoid = p.oid
  where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') is distinct from b.svc
     or (not p.prosecdef and pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE') is distinct from b.auth)
     or (p.prosecdef and not exists (select 1 from pg_catalog.pg_depend e where e.classid = 'pg_catalog.pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
         and pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE')
         and not (b.auth and (p.oid = any (coalesce(v_keep_static, array[]::oid[]))
                              or exists (select 1 from pg_catalog.pg_depend d where d.refobjid = p.oid
                                           and d.refclassid = 'pg_catalog.pg_proc'::regclass
                                           and d.classid in ('pg_catalog.pg_policy'::regclass, 'pg_catalog.pg_constraint'::regclass,
                                                             'pg_catalog.pg_attrdef'::regclass, 'pg_catalog.pg_class'::regclass)))))
     or (p.prosecdef and not exists (select 1 from pg_catalog.pg_depend e where e.classid = 'pg_catalog.pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
         and b.auth and not pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE')
         and p.oid = any (coalesce(v_keep_static, array[]::oid[])));
  if v_bad is not null then
    raise exception 'anon lockdown: function EXECUTE changed unexpectedly: %', v_bad;
  end if;
  if not pg_catalog.has_function_privilege(v_auth, 'public.is_internal_staff()', 'EXECUTE')
     or pg_catalog.has_function_privilege(v_anon, 'public.is_internal_staff()', 'EXECUTE') then
    raise exception 'anon lockdown: wrong EXECUTE grants on public.is_internal_staff()';
  end if;

  -- Every function a policy for authenticated/PUBLIC calls stays callable, otherwise
  -- every query on that table fails with "permission denied for function".
  select string_agg(distinct pol.polrelid::regclass::text || '.' || pol.polname || ' -> ' || d.refobjid::regprocedure::text, '; ')
    into v_bad
  from pg_catalog.pg_policy pol
  join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_policy'::regclass and d.objid = pol.oid
                             and d.refclassid = 'pg_catalog.pg_proc'::regclass
  join lk_fn_before b on b.fnoid = d.refobjid and b.auth
  where pol.polroles && array[0::oid, v_auth]
    and not pg_catalog.has_function_privilege(v_auth, d.refobjid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'anon lockdown: policies call functions authenticated can no longer execute: %', v_bad;
  end if;

  -- pg_cron jobs of non-superusers can still run their definer functions.
  if to_regclass('cron.job') is not null
     and exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = to_regclass('cron.job') and attname = 'username' and not attisdropped) then
    execute $q$
      select string_agg(distinct j.jobname || ' (' || j.username || ') -> ' || p.proname, '; ')
      from cron.job j
      join pg_catalog.pg_roles ro on ro.rolname = j.username and not ro.rolsuper
      join pg_catalog.pg_proc p on p.prosecdef and p.pronamespace = 'public'::regnamespace
                               and j.command ~* ('\m' || p.proname || '\s*\(')
      where not pg_catalog.has_function_privilege(ro.oid, p.oid, 'EXECUTE')
    $q$ into v_bad;
    if v_bad is not null then
      raise exception 'anon lockdown: pg_cron jobs lost EXECUTE: %', v_bad;
    end if;
  end if;

  -- 6d. Default privileges. ---------------------------------------------------
  select string_agg(pg_catalog.pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text || '/' || d.defaclnamespace::regnamespace::text, ', ')
    into v_bad
  from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
  where (d.defaclnamespace = 0 or d.defaclnamespace = v_public) and a.grantee = v_anon;
  if v_bad is not null then
    raise exception 'anon lockdown: default privileges still grant anon: %', v_bad;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres'
                                                  and pg_catalog.pg_has_role(current_user, oid, 'MEMBER')) then
    for r in select * from pg_temp.lk_probe('postgres') loop
      if r.rolname = 'anon' and cardinality(r.privs) > 0 then
        raise exception 'anon lockdown: a new % created by postgres is open to anon: % (%)', r.kind, r.privs, r.raw_acl;
      end if;
      if r.rolname <> 'anon' and r.privs is distinct from (
           select b.privs from lk_probe_before b where b.owner = 'postgres' and b.kind = r.kind and b.rolname = r.rolname) then
        raise exception 'anon lockdown: default % privileges of % changed for postgres: % -> %', r.kind, r.rolname,
          (select b.privs from lk_probe_before b where b.owner = 'postgres' and b.kind = r.kind and b.rolname = r.rolname), r.privs;
      end if;
    end loop;
  end if;
  -- supabase_admin: no explicit anon grant on anything new. Its new functions keep
  -- the built-in PUBLIC EXECUTE by design (see header).
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_admin'
                                                  and pg_catalog.pg_has_role(current_user, oid, 'MEMBER')) then
    for r in select * from pg_temp.lk_probe('supabase_admin') loop
      if r.rolname = 'anon' and ((r.kind <> 'function' and cardinality(r.privs) > 0) or r.raw_acl like '%anon=%') then
        raise exception 'anon lockdown: a new % created by supabase_admin is granted to anon: %', r.kind, r.raw_acl;
      end if;
      if r.rolname <> 'anon' and r.privs is distinct from (
           select b.privs from lk_probe_before b where b.owner = 'supabase_admin' and b.kind = r.kind and b.rolname = r.rolname) then
        raise exception 'anon lockdown: default % privileges of % changed for supabase_admin', r.kind, r.rolname;
      end if;
    end loop;
  end if;

  -- 6e. Behavioural probe, the way PostgREST runs a request. Read-only: denial
  --     probes use WHERE false (ACLs are still checked), allowed reads LIMIT 1. ----
  -- anon
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  for r in select t from unnest(v_sel) t where to_regclass(t) is not null loop
    perform pg_catalog.set_config('role', 'anon', true);
    execute pg_catalog.format('select 1 from %s limit 1', r.t);
    perform pg_catalog.set_config('role', v_prev_role, true);
  end loop;
  for r in
    select pg_catalog.format('%I.%I', n.nspname, c.relname) as qn
    from lk_rel_before b join pg_catalog.pg_class c on c.oid = b.relid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where b.rolname = 'anon' and cardinality(b.privs) > 0
      and not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_sel) t)))
  loop
    begin
      perform pg_catalog.set_config('role', 'anon', true);
      execute pg_catalog.format('select 1 from %s where false', r.qn);
      perform pg_catalog.set_config('role', v_prev_role, true);
      raise exception 'anon lockdown probe: anon can still read %', r.qn using errcode = 'P0001';
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform pg_catalog.set_config('role', 'anon', true);
    perform public.is_internal_staff();
    perform pg_catalog.set_config('role', v_prev_role, true);
    raise exception 'anon lockdown probe: anon can execute public.is_internal_staff()';
  exception when insufficient_privilege then null;
  end;

  select id into v_staff from public.profiles
   where role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(is_demo, false) = false
   order by (role = 'admin') desc, created_at nulls last, id limit 1;
  select id into v_client from public.profiles
   where role = 'client' order by created_at nulls last, id limit 1;

  -- client and staff: the allowlisted read-only helpers run; views are closed.
  for r in
    select u.who, u.uid
    from (values ('client', v_client), ('staff', v_staff)) u(who, uid)
    where u.uid is not null
  loop
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_catalog.set_config('request.jwt.claim.sub', r.uid::text, true);

    perform pg_catalog.set_config('role', 'authenticated', true);
    execute 'select public.is_internal_staff()' into v_b;
    perform pg_catalog.set_config('role', v_prev_role, true);
    if v_b is distinct from (r.who = 'staff') then
      raise exception 'anon lockdown probe: is_internal_staff() is % for the %', v_b, r.who;
    end if;

    -- Zero-argument, non-volatile boolean helpers on the allowlist must run.
    for v_rel in
      select pg_catalog.format('%I.%I()', n.nspname, p.proname)
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where p.oid = any (coalesce(v_keep_static, array[]::oid[]))
        and p.pronargs = 0 and p.prorettype = 'boolean'::regtype and p.provolatile in ('s', 'i')
    loop
      perform pg_catalog.set_config('role', 'authenticated', true);
      execute pg_catalog.format('select %s', v_rel);
      perform pg_catalog.set_config('role', v_prev_role, true);
    end loop;

    for v_rel in
      select pg_catalog.format('%I.%I', n.nspname, c.relname)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.oid = v_public and c.relkind in ('v', 'm')
        and not (c.oid = any (array(select to_regclass(t)::oid from unnest(v_jwt_views) t)))
    loop
      begin
        perform pg_catalog.set_config('role', 'authenticated', true);
        execute pg_catalog.format('select 1 from %s where false', v_rel);
        perform pg_catalog.set_config('role', v_prev_role, true);
        raise exception 'anon lockdown probe: the % can still read view %', r.who, v_rel using errcode = 'P0001';
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;

  -- A revoked, read-only, zero-argument definer function is denied to a client.
  if v_client is not null then
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.json_build_object('sub', v_client, 'role', 'authenticated')::text, true);
    perform pg_catalog.set_config('request.jwt.claim.sub', v_client::text, true);
    for v_rel in
      select pg_catalog.format('%I.%I()', n.nspname, p.proname)
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join lk_fn_before b on b.fnoid = p.oid
      where n.oid = v_public and p.prosecdef and b.auth
        and p.pronargs = 0 and p.provolatile in ('s', 'i')
        and not pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE')
      order by 1 limit 1
    loop
      begin
        perform pg_catalog.set_config('role', 'authenticated', true);
        execute pg_catalog.format('select %s', v_rel);
        perform pg_catalog.set_config('role', v_prev_role, true);
        raise exception 'anon lockdown probe: a client can still execute %', v_rel using errcode = 'P0001';
      exception when insufficient_privilege then null;
      end;
    end loop;
  end if;

  -- service_role still reads every view.
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  for v_rel in
    select pg_catalog.format('%I.%I', n.nspname, c.relname)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join lk_rel_before b on b.relid = c.oid and b.rolname = 'service_role' and 'SELECT' = any (b.privs)
    where n.oid = v_public and c.relkind in ('v', 'm')
  loop
    perform pg_catalog.set_config('role', 'service_role', true);
    execute pg_catalog.format('select 1 from %s where false', v_rel);
    perform pg_catalog.set_config('role', v_prev_role, true);
  end loop;

  perform pg_catalog.set_config('request.jwt.claims', v_prev_claims, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', v_prev_sub, true);
end;
$$;

-- ─── 7. "After" snapshot for the rollback ──────────────────────────────────────
-- The rollback reverts an entry only while it still equals the state recorded here,
-- so it never undoes a later migration's ACL change. Column and default-ACL entries
-- that exist only now were absent before (acl NULL); no relation or function is
-- created by this file, so those kinds have no new entries.
insert into lockdown_backup.acl_20261015_0036 (kind, ident, acl)
select 'col', pg_catalog.format('%I.%I', 'public', c.relname) || ' ' || pg_catalog.quote_ident(att.attname), null
from pg_catalog.pg_class c
join pg_catalog.pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and att.attacl is not null
union all
select 'defacl',
       pg_catalog.pg_get_userbyid(d.defaclrole) || '|'
         || case when d.defaclnamespace = 0 then '' else d.defaclnamespace::regnamespace::text end
         || '|' || d.defaclobjtype::text,
       null
from pg_catalog.pg_default_acl d
on conflict (kind, ident) do nothing;

update lockdown_backup.acl_20261015_0036 set acl_after = null, after_captured_at = pg_catalog.now();
update lockdown_backup.acl_20261015_0036 b
   set acl_after = cur.acl
  from (
    select 'rel' as kind, pg_catalog.format('%I.%I', 'public', c.relname) as ident, c.relacl::text as acl
    from pg_catalog.pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    union all
    select 'col', pg_catalog.format('%I.%I', 'public', c.relname) || ' ' || pg_catalog.quote_ident(att.attname), att.attacl::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and att.attacl is not null
    union all
    select 'fn', p.oid::regprocedure::text, p.proacl::text
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
    union all
    select 'defacl',
           pg_catalog.pg_get_userbyid(d.defaclrole) || '|'
             || case when d.defaclnamespace = 0 then '' else d.defaclnamespace::regnamespace::text end
             || '|' || d.defaclobjtype::text,
           d.defaclacl::text
    from pg_catalog.pg_default_acl d
  ) cur
 where cur.kind = b.kind and cur.ident = b.ident;

drop function pg_temp.lk_probe(name);
drop function pg_temp.lk_hold(oid);
