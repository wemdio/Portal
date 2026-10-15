-- Turn on row level security for the 59 public tables that have it off on prod.
--
-- LEAK. On prod these tables have RLS disabled, and the July restore granted ALL on them
-- to anon and authenticated (deploy/main-db-prod/fix-roles.sql). GoTrue signup is open,
-- so anyone with the public anon key can get an authenticated JWT and read, insert,
-- update and delete through /rest/v1:
--   - live credentials and personal data: tg_video_transcripts (call transcripts),
--     audio_transcripts, phone_identities, li_campaign_logs, tg_transcribe_jobs,
--     tg_atmos_* (client chats), outreachos_suppression (our client list), companies;
--   - access control: user_tool_visibility unlocks the money, first-sales, renewals,
--     database-review and sales-chat sections for the supabaseAdmin guards;
--   - integrity: portal_migrations (a forged row makes the deploy skip a migration),
--     instantly_rate_budget and mailganer_scoring_rate_budget (the shared Instantly
--     limiter and the 20k/day Mailganer contract), health_check_settings (mutes alerts),
--     tg_atmos_settings, in_app_bot_states;
--   - prod-only leftovers: the Django/OpenOutreach set (auth_*, django_*, chat_*,
--     linkedin_*, crm_*), backups and scratch tables.
--
-- FIX. Who keeps what:
--   * staff (internal role, not demo; public.is_internal_staff() from
--     20261015_0030_profiles_read_lockdown) keep exactly today's access: every row,
--     every command, through a permissive <t>_staff_all policy;
--   * clients (RU, ENG self-serve, demo), demo staff and role-NULL robots get nothing,
--     except their OWN rows of user_tool_visibility (UserProvider reads them on
--     /review/base/* and /login), read-only;
--   * anon gets nothing (revoked here too, so this file does not depend on the hotfix);
--   * service_role is unchanged (BYPASSRLS);
--   * direct DB logins are unchanged whatever their attributes: postgres and
--     supabase_admin are superusers, readonly and nick_ro are BYPASSRLS on prod, and a
--     <t>_direct_db_roles policy keeps any other login (a Django or bot role without
--     BYPASSRLS, a role that inherits anon or authenticated) on today's behaviour.
--     PostgREST, storage-api and Realtime always run requests as anon or authenticated,
--     so that policy never matches an API request;
--   * a RESTRICTIVE <t>_staff_gate caps anon and authenticated at "staff or direct"; it
--     neutralises any permissive policy hand-made on prod that would otherwise switch on
--     together with RLS (policies of RLS-off tables are not in the prod TSV).
-- Five tables that authenticated cannot touch on prod today (fx_rate_probes,
-- gis_signal_company_signals_bak_20260812, health_check_job_alerts,
-- transcript_amo_lead_link, ve_search_cache) get no staff policy and lose authenticated
-- in the repo as well (a no-op on prod): service role and direct logins only.
--
-- NOT CHANGED. No column grants, no grants for service_role or direct logins, no FORCE
-- (owners are superusers), no default privileges (20261015_0036). FK checks and ON DELETE
-- actions bypass RLS. SECURITY DEFINER callers (instantly_acquire_token,
-- mailganer_acquire_score_token, tg_transcribed_chat_topic_counts) run as a superuser
-- owner and are unaffected. Staff keep today's REST writes on the access-control and
-- integrity tables above; removing them is a separate owner decision.
--
-- KNOWN BYPASS OUTSIDE THIS FILE. public.v_sales_ai_stale_transcripts is an owner-rights
-- view over tg_video_transcripts and transcript_amo_lead_link; 20261015_0036 revokes it
-- from anon and authenticated.
--
-- RULES FOR LATER CHANGES.
--   * A non-invoker view owned by a non-superuser, non-BYPASSRLS role over these tables
--     returns nothing to API callers: RLS is checked as the owner, but current_user in
--     <t>_direct_db_roles is still anon/authenticated.
--   * A client page that needs one of these tables needs its own permissive policy AND
--     an own-row arm in the restrictive gate (see user_tool_visibility).
--   * Bots that CREATE TABLE IF NOT EXISTS at startup (atmos-bot, changelog-bot,
--     health-check) create RLS-off tables in a fresh environment; enable RLS there.
--
-- SAFETY. All tables in scope are locked ACCESS EXCLUSIVE up front, children before
-- parents (FK order), so a concurrent child INSERT never deadlocks with this file. Each
-- lock wait is capped at 3s and the whole lock phase at 30s; either aborts the file
-- (55P03 / 57014) and the deploy fails cleanly while the old build keeps serving the
-- unchanged database. Apply with workers drained and outside the 06:00/18:00 UTC
-- pg_dump and the 22:00 UTC (01:00 MSK) portal-mirror cron. Section 5 checks the grants
-- and the policies, then reads every table as a staff JWT, a client JWT, a JWT without
-- a profile, service_role and every direct login the runner can become. Probes that
-- must return no rows only run on tables of at most 8 MB, so the check never full-scans
-- a big table while the locks are held.
--
-- ROLLBACK: supabase/operator-sql/20261015_0032_no_rls_tables_lockdown.rollback.sql
-- (drops the policies, disables RLS again; anon stays revoked). To re-apply a corrected
-- version, keep this file's portal_migrations row and ship a NEW migration.

set local lock_timeout = '3s';

-- ─── 1. Dependency ───────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_internal_staff()') is null then
    raise exception 'no-RLS lockdown: public.is_internal_staff() is missing; apply 20261015_0030_profiles_read_lockdown first';
  end if;
  if not has_function_privilege('authenticated', 'public.is_internal_staff()', 'execute') then
    raise exception 'no-RLS lockdown: authenticated cannot execute public.is_internal_staff(); every staff read would fail';
  end if;
end;
$$;

-- ─── 2. Scope and lock phase ─────────────────────────────────────────────────
-- mode: service  service role and direct logins only (authenticated has no grant on prod)
--       staff    staff all, nobody else
--       own_read staff all, everybody else reads own rows (user_tool_visibility)
create temp table no_rls_lockdown_scope (
  tbl text primary key,
  mode text not null check (mode in ('service', 'staff', 'own_read')),
  rel regclass,
  lock_rank integer not null default 0,
  small boolean not null default true
) on commit drop;

insert into pg_temp.no_rls_lockdown_scope (tbl, mode)
select t, 'service' from unnest(array[
  'fx_rate_probes', 'gis_signal_company_signals_bak_20260812', 'health_check_job_alerts',
  'transcript_amo_lead_link', 've_search_cache'
]) t
union all
select t, 'staff' from unnest(array[
  -- prod-only leftovers of the removed Django/OpenOutreach service (empty except
  -- django_migrations); candidates for DROP after the owner confirms
  'auth_group', 'auth_group_permissions', 'auth_permission', 'auth_user',
  'auth_user_groups', 'auth_user_user_permissions', 'chat_chatmessage',
  'chat_chatmessage_recipients', 'chat_chatmessage_to', 'crm_deal', 'crm_lead',
  'django_admin_log', 'django_content_type', 'django_migrations',
  'linkedin_actionlog', 'linkedin_campaign', 'linkedin_campaign_users',
  'linkedin_linkedinprofile', 'linkedin_searchkeyword', 'linkedin_task',
  -- prod-only backups and scratch
  '_tmp_okved_rank', 'bak_stored_passscore_20260710',
  -- main-DB copies left behind by the April 2026 Instantly split (live tables are on
  -- the Instantly DB and are not touched here)
  'bot_known_chats', 'client_forwarded_leads', 'client_lead_comments',
  'client_telegram_chats', 'instantly_brief_campaigns', 'instantly_briefs',
  -- the rest
  'schema_migrations', 'activity_type_okved_mapping', 'audio_transcripts',
  'demo_personalize_runs', 'li_campaign_step_stats', 'tg_atmos_settings',
  'tg_atmos_users', 'tg_atmos_checks', 'tg_atmos_chat_state', 'tg_atmos_messages',
  'health_check_settings', 'in_app_bot_states', 'changelog_digests', 'tg_bot_chats',
  'phone_identities', 'outreachos_suppression', 'companies', 'tg_video_transcripts',
  'tg_scan_jobs', 'tg_transcribe_jobs', 'portal_migrations',
  'okved_reference', 'li_campaign_logs', 'mailganer_scoring_rate_budget',
  'instantly_rate_budget'
]) t
union all
select 'user_tool_visibility', 'own_read';

do $$
begin
  if (select count(*) from pg_temp.no_rls_lockdown_scope) <> 59 then
    raise exception 'no-RLS lockdown: table list has % entries, expected 59', (select count(*) from pg_temp.no_rls_lockdown_scope);
  end if;
end;
$$;

-- Prod-only tables do not exist in CI or a fresh environment; views or foreign tables
-- with these names are not ours to change.
update pg_temp.no_rls_lockdown_scope s set rel = to_regclass(format('public.%I', s.tbl));
delete from pg_temp.no_rls_lockdown_scope s
 where s.rel is null
    or (select c.relkind from pg_catalog.pg_class c where c.oid = s.rel) not in ('r', 'p');

-- Lock children before parents: rank = longest chain of in-scope FK references.
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select rel from pg_temp.no_rls_lockdown_scope)
    and con.confrelid in (select rel from pg_temp.no_rls_lockdown_scope)
), walk(start, node, depth, path) as (
  select s.rel::oid, s.rel::oid, 0, array[s.rel::oid] from pg_temp.no_rls_lockdown_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update pg_temp.no_rls_lockdown_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = s.rel::oid;

update pg_temp.no_rls_lockdown_scope s
   set small = pg_catalog.pg_total_relation_size(s.rel) <= 8 * 1024 * 1024;

set local statement_timeout = '30s';
do $$
declare
  r record;
begin
  for r in select s.rel from pg_temp.no_rls_lockdown_scope s order by s.lock_rank desc, s.tbl loop
    execute format('lock table %s in access exclusive mode', r.rel);
  end loop;
end;
$$;
-- No lock waits after this point; bound the rest generously.
set local statement_timeout = '120s';

-- ─── 3. Service-only tables: authenticated has no grant on prod today ───────
-- Literal revokes for the tables that exist in the repo (the engine grants lint needs
-- the literal form for ve_search_cache); the loop below covers the prod-only ones.
revoke all on table public.fx_rate_probes from anon, authenticated;
revoke all on table public.transcript_amo_lead_link from anon, authenticated;
revoke all on table public.ve_search_cache from anon, authenticated;

do $$
declare
  c_direct constant text := '(select current_user) not in (''anon'', ''authenticated'')';
  c_staff constant text := '(select public.is_internal_staff())';
  r record;
  s regclass;
begin
  for r in select x.tbl, x.rel, x.mode from pg_temp.no_rls_lockdown_scope x order by x.lock_rank desc, x.tbl loop
    if r.mode = 'service' then
      execute format('revoke all on table %s from anon, authenticated', r.rel);
    else
      execute format('revoke all on table %s from anon', r.rel);
    end if;
    for s in
      select d.objid::regclass from pg_catalog.pg_depend d
      join pg_catalog.pg_class sq on sq.oid = d.objid and sq.relkind = 'S'
      where d.classid = 'pg_catalog.pg_class'::regclass and d.refobjid = r.rel and d.deptype in ('a', 'i')
    loop
      if r.mode = 'service' then
        execute format('revoke all on sequence %s from anon, authenticated', s);
      else
        execute format('revoke all on sequence %s from anon', s);
      end if;
    end loop;

    execute format('alter table %s enable row level security', r.rel);

    -- Direct DB logins (never an API request) keep today's behaviour.
    execute format('drop policy if exists %I on %s', r.tbl || '_direct_db_roles', r.rel);
    execute format('create policy %I on %s as permissive for all to public using (%s) with check (%s)',
                   r.tbl || '_direct_db_roles', r.rel, c_direct, c_direct);

    if r.mode in ('staff', 'own_read') then
      execute format('drop policy if exists %I on %s', r.tbl || '_staff_all', r.rel);
      execute format('create policy %I on %s as permissive for all to authenticated using (%s) with check (%s)',
                     r.tbl || '_staff_all', r.rel, c_staff, c_staff);
    end if;

    if r.mode in ('service', 'staff') then
      execute format('drop policy if exists %I on %s', r.tbl || '_staff_gate', r.rel);
      execute format('create policy %I on %s as restrictive for all to anon, authenticated using (%s or %s) with check (%s or %s)',
                     r.tbl || '_staff_gate', r.rel, c_direct, c_staff, c_direct, c_staff);
    end if;
  end loop;
end;
$$;

-- ─── 4. user_tool_visibility: staff all, everyone else reads only own rows ───
-- Clients mount UserProvider on /review/base/* and the demo account on /login; it
-- reads tool_id, enabled where user_id = self. No JWT writes exist (the admin API uses
-- the service role), but staff keep today's REST writes per the lockdown goal.
do $$
begin
  if to_regclass('public.user_tool_visibility') is null then
    return;
  end if;
  execute 'drop policy if exists user_tool_visibility_select_own on public.user_tool_visibility';
  execute $p$create policy user_tool_visibility_select_own on public.user_tool_visibility
    as permissive for select to authenticated using (user_id = (select auth.uid()))$p$;
  execute 'drop policy if exists user_tool_visibility_select_gate on public.user_tool_visibility';
  execute $p$create policy user_tool_visibility_select_gate on public.user_tool_visibility
    as restrictive for select to anon, authenticated
    using ((select current_user) not in ('anon', 'authenticated') or (select public.is_internal_staff()) or user_id = (select auth.uid()))$p$;
  execute 'drop policy if exists user_tool_visibility_insert_gate on public.user_tool_visibility';
  execute $p$create policy user_tool_visibility_insert_gate on public.user_tool_visibility
    as restrictive for insert to anon, authenticated
    with check ((select current_user) not in ('anon', 'authenticated') or (select public.is_internal_staff()))$p$;
  execute 'drop policy if exists user_tool_visibility_update_gate on public.user_tool_visibility';
  execute $p$create policy user_tool_visibility_update_gate on public.user_tool_visibility
    as restrictive for update to anon, authenticated
    using ((select current_user) not in ('anon', 'authenticated') or (select public.is_internal_staff()))
    with check ((select current_user) not in ('anon', 'authenticated') or (select public.is_internal_staff()))$p$;
  execute 'drop policy if exists user_tool_visibility_delete_gate on public.user_tool_visibility';
  execute $p$create policy user_tool_visibility_delete_gate on public.user_tool_visibility
    as restrictive for delete to anon, authenticated
    using ((select current_user) not in ('anon', 'authenticated') or (select public.is_internal_staff()))$p$;
end;
$$;

-- ─── 5. Self-check: fails the migration, never the running app ───────────────
do $$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_unknown     uuid := '00000000-0000-4000-8000-00000000dead';
  v_gates text[];
  r record;
  v_role text;
  v_staff uuid;
  v_client uuid;
  v_owner bigint;
  v_n bigint;
  v_expect bigint;
  v_count_sql text;
  v_checked int := 0;
begin
  if has_function_privilege('anon', 'public.is_internal_staff()', 'execute') then
    raise exception 'no-RLS lockdown: anon can execute public.is_internal_staff()';
  end if;

  -- 5a. Structure.
  for r in select * from pg_temp.no_rls_lockdown_scope order by tbl loop
    v_checked := v_checked + 1;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = r.rel) then
      raise exception 'no-RLS lockdown: RLS is not enabled on %', r.rel;
    end if;
    -- A REVOKE by a non-owner only warns, so check the outcome.
    if has_table_privilege('anon', r.rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 'no-RLS lockdown: anon still has privileges on %', r.rel;
    end if;
    if r.mode = 'service' and has_table_privilege('authenticated', r.rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 'no-RLS lockdown: authenticated still has privileges on service-only %', r.rel;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.tbl || '_direct_db_roles'
        and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL' and p.roles = array['public']::name[]
    ) then
      raise exception 'no-RLS lockdown: % has no direct-role policy', r.rel;
    end if;
    if r.mode <> 'service' and not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.tbl || '_staff_all'
        and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL'
        and p.qual like '%is_internal_staff()%' and p.with_check like '%is_internal_staff()%'
    ) then
      raise exception 'no-RLS lockdown: % has no staff policy', r.rel;
    end if;
    v_gates := case when r.mode = 'own_read'
                    then array[r.tbl || '_select_gate', r.tbl || '_insert_gate', r.tbl || '_update_gate', r.tbl || '_delete_gate']
                    else array[r.tbl || '_staff_gate'] end;
    if (select count(*) from pg_catalog.pg_policies p
         where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = any (v_gates)
           and p.permissive = 'RESTRICTIVE'
           and p.roles @> array['anon', 'authenticated']::name[]
           and coalesce(p.qual, p.with_check) like '%is_internal_staff()%')
       <> array_length(v_gates, 1) then
      raise exception 'no-RLS lockdown: % is missing its restrictive gate', r.rel;
    end if;
  end loop;

  -- 5b. Behavioural probe, the way PostgREST runs a request. Read-only.
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'no-RLS lockdown: % cannot SET ROLE authenticated for the self-check; run migrations as supabase_admin or postgres', current_user;
  end if;

  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id
   limit 1;
  select p.id into v_client from public.profiles p
   where p.role = 'client'
   order by p.created_at nulls last, p.id
   limit 1;

  for r in select * from pg_temp.no_rls_lockdown_scope order by tbl loop
    -- Staff, service and direct probes: the gate arms are per-statement constants
    -- (InitPlans), so a cap of 1000 rows is as strong as a full count.
    v_count_sql := format('select count(*) from (select 1 from %s limit 1000) s', r.rel);
    execute v_count_sql into v_owner;

    if has_table_privilege('authenticated', r.rel, 'SELECT') then
      -- Probes that must see no rows scan the whole table; only on small tables.
      if r.small then
        perform set_config('request.jwt.claims', json_build_object('sub', v_unknown, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', v_unknown::text, true);
        perform set_config('role', 'authenticated', true);
        execute format('select count(*) from %s', r.rel) into v_n;
        perform set_config('role', v_prev_role, true);
        if v_n <> 0 then
          raise exception 'no-RLS lockdown probe: a JWT without a profile reads % rows of %', v_n, r.rel;
        end if;

        if v_client is not null then
          if r.mode = 'own_read' then
            execute format('select count(*) from %s u where u.user_id = $1', r.rel) into v_expect using v_client;
          else
            v_expect := 0;
          end if;
          perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role', 'authenticated')::text, true);
          perform set_config('request.jwt.claim.sub', v_client::text, true);
          perform set_config('role', 'authenticated', true);
          execute format('select count(*) from %s', r.rel) into v_n;
          perform set_config('role', v_prev_role, true);
          if v_n <> v_expect then
            raise exception 'no-RLS lockdown probe: a client reads % rows of %, expected %', v_n, r.rel, v_expect;
          end if;
        end if;
      end if;

      -- Staff: every row, as today.
      if v_staff is not null and r.mode <> 'service' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', v_staff::text, true);
        perform set_config('role', 'authenticated', true);
        execute v_count_sql into v_n;
        perform set_config('role', v_prev_role, true);
        if v_n <> v_owner then
          raise exception 'no-RLS lockdown probe: staff % reads % of % rows of %', v_staff, v_n, v_owner, r.rel;
        end if;
      end if;
    end if;

    -- service_role and every direct login the runner can become: every row, as today.
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    for v_role in
      select ro.rolname::text from pg_catalog.pg_roles ro
      where (ro.rolname = 'service_role' or ro.rolcanlogin)
        and ro.rolname not in ('anon', 'authenticated', 'authenticator')
        and not ro.rolsuper
        and pg_catalog.pg_has_role(current_user, ro.oid, 'MEMBER')
        and has_schema_privilege(ro.oid, 'public', 'USAGE')
        and has_table_privilege(ro.oid, r.rel, 'SELECT')
      order by 1
    loop
      perform set_config('role', v_role, true);
      execute v_count_sql into v_n;
      perform set_config('role', v_prev_role, true);
      if v_n <> v_owner then
        raise exception 'no-RLS lockdown probe: % reads % of % rows of %', v_role, v_n, v_owner, r.rel;
      end if;
    end loop;
  end loop;

  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
  raise notice 'no-RLS lockdown: % of 59 tables present and checked', v_checked;
end;
$$;
