-- Close the open RLS policies on 115 public tables to everyone except internal staff.
--
-- LEAK. On prod 180 permissive policies on 115 public tables let ANY signed-in account
-- through: USING (true), auth.role() = 'authenticated' or auth.uid() IS NOT NULL. GoTrue
-- signup is open (ENG self-serve), so anyone with the public anon key can get a client
-- JWT and read or rewrite, through /rest/v1, things like client_tariffs (grant itself a
-- paid tariff), client_auto_pipeline_configs.endpoint_api_key, tg_outreach_accounts /
-- tg_parser_accounts / tg_pool_accounts session strings, tg_pool_proxies credentials,
-- bank_transactions, invoices, projects (budget, margin), amo_leads, sales AI analyses,
-- kb_documents, other clients' manual-scoring runs and rows. 28 of the policies are
-- named "service role ..." but are written TO public USING (true), so before the
-- anon hotfix they also opened the tables to the anon key.
--
-- FIX. Middleware already keeps clients out of staff pages and staff API paths; this
-- makes the database say the same thing.
--   1. One RESTRICTIVE gate per table, TO anon, authenticated:
--        using ((select public.is_internal_staff())) with check (same)
--      Restrictive policies are ANDed with every permissive one, so for internal
--      staff (7 roles, not is_demo) nothing changes, and for everybody else every
--      existing permissive policy, including prod-only ones that are not in the repo,
--      is neutralised. Clients, ENG self-serve, demo accounts, role-NULL robots and
--      demo staff accounts get no rows and no writes.
--   2. The only client-JWT reads of these tables are the manual-scoring routes
--      (api/client/manual-scoring/runs, runs/[id], runs/[id]/download/[bucket]), so
--      client_manual_score_runs and client_manual_score_rows get "staff OR own run"
--      for reads and staff-only writes. The Bench API robot reads pdl_companies with
--      its own JWT (lib/bench/tools/companyBase.ts), so pdl_companies gets "staff OR
--      API robot" (public.is_api_robot() from 20261015_0031) for reads and staff-only
--      writes. These three tables carry a second restrictive policy FOR DELETE (staff
--      only): DELETE checks only USING, so a single FOR ALL "staff OR own" gate would
--      let a permissive delete policy through for the owner. No client code writes
--      these tables with a JWT (all writes are on the service role), so clients lose
--      nothing they use.
--   3. Deliberate public objects keep their public part: companies_directory stays
--      readable by anon and every JWT (only writes are gated);
--      database_review_row_marks keeps its anon select/insert policies (the gate is TO
--      authenticated only).
--   4. Every "service role ..." policy written TO public USING (true) is retargeted TO
--      service_role (a no-op for service_role, which bypasses RLS). The staff access
--      those policies gave is kept by a permissive "<table>_staff_<cmd>" policy for
--      the same command TO authenticated USING (is_internal_staff()), so staff keep
--      exactly the rows and commands they have today.
--   5. anon loses every table privilege on these tables (same as the anon hotfix;
--      a no-op if that already ran), except the deliberate public ones.
--   6. pdl_count_estimate() (EXPLAIN-based count shown on the staff EU/US company
--      base page) becomes SECURITY DEFINER with an explicit staff-or-robot check.
--      Under the gate the planner prices the per-row RLS filter at 0.5-0.75, so the
--      invoker version would show staff a count 25-50% too low. 20261015_0036 keeps
--      authenticated on it (allowlist).
--   7. search_pdl_companies() (the filter-first reader behind /api/company-base/search
--      and /export, called with the staff JWT) becomes SECURITY DEFINER with an explicit
--      caller check, same body. Any non-constant RLS qual on pdl_companies (the gate
--      below is one) stops the planner from using a caller's `name ilike '%x%'` as an
--      index condition, because ~~* is not leakproof: the staff name search would fall
--      back to a full scan of the 19.5M-row catalogue, the scan that 20260624_0001
--      (idx_pdl_companies_name_trgm) removed (PGlite, 200k rows: 3 ms -> 161 ms). Run as
--      its owner, which bypasses RLS, the function plans exactly as today. Rows go only
--      to a caller that may read pdl_companies AND either bypasses RLS (service_role,
--      superusers, readonly / nick_ro) or carries a staff or Bench-robot JWT; everybody
--      else gets '[]' before the table is touched. 20261015_0036 keeps authenticated on
--      it (allowlist).
--
-- STILL OPEN IN CODE. The Bench company-base tool (lib/bench/tools/companyBase.ts) reads
-- pdl_companies directly with the robot JWT, so its name filter cannot use the trigram
-- index under the gate either. It must call search_pdl_companies (release notes). Staff
-- KB search (kb_search_chunks, invoker, staff JWT) likewise loses the GIN index on
-- kb_chunks under the gate; measured 2 ms -> 32 ms at 200k chunks, so it stays invoker.
--
-- WHO IS NOT AFFECTED. service_role (BYPASSRLS), postgres / supabase_admin (superusers:
-- migration runner, workers' direct pools, health-check, external-sync, atmos-bot,
-- backups, realtime), readonly and nick_ro (BYPASSRLS on prod). A non-bypass direct
-- login that today reads a retargeted table through its TO public policy keeps that
-- policy (it is added to the policy's role list and named in a NOTICE).
--
-- NOT IN THIS FILE. profiles (20261015_0030), RLS-disabled tables (0032), the other
-- RLS tables incl. the client surface (0034), storage (0035), views, SECURITY DEFINER
-- EXECUTE grants and default privileges (0036).
--
-- DEPENDS ON public.is_internal_staff() from 20261015_0030_profiles_read_lockdown.sql and
-- public.is_api_robot() from 20261015_0031_staff_gate_helpers.sql (both PARALLEL SAFE, so
-- staff queries on big gated tables keep their parallel plans).
--
-- SAFETY. Every table in scope is locked ACCESS EXCLUSIVE up front, children before
-- parents (FK order), so the before/after probes see the same data, no lock is upgraded
-- midway, and a concurrent child INSERT (whose FK check needs the parent) never
-- deadlocks with this file. The lock wait is capped at 3s per table and the whole lock
-- phase at 30s (statement_timeout); either aborts the file (55P03/57014) and the deploy
-- fails cleanly. After the lock phase the timeout is raised to 120s for the probes.
-- Apply as a planned operator step with the VE2/HE/tg-outreach workers drained: the
-- catalog RPCs on companies_directory and pdl_companies run for up to 180s and would
-- make the lock phase time out. Not during the 06:00 / 18:00 UTC pg_dump (it holds
-- ACCESS SHARE on every table) or the 22:00 UTC (01:00 MSK) portal-mirror cron.
-- The last step probes the result as real callers and raises on any mismatch, which
-- rolls the whole file back and fails the deploy while the old build keeps serving
-- the unchanged database. Probes that are expected to see no rows only run on tables
-- of at most 8 MB, so the check never full-scans a big table while the locks are
-- held; bigger tables are covered by the structural checks. On those bigger tables the
-- staff before/after probe counts only a sample of up to 1000 rows picked by ctid (a
-- TID scan; tideq is leakproof, so RLS keeps it), which stays bounded even where the
-- staff account's own policies let only a few rows through.
--
-- ROLLBACK: supabase/operator-sql/20261015_0033_open_policies_staff_gate.rollback.sql
-- (drops the gates and staff policies, retargets the service policies back TO public,
-- restores the invoker pdl_count_estimate and search_pdl_companies). It does not
-- re-grant anon. To re-apply a corrected version, keep this file's portal_migrations
-- row and ship a NEW migration.

set local lock_timeout = '3s';
-- Locks taken early are held until commit, so a slow lock queue on a later table would
-- keep the earlier ones locked. Bound every statement (the lock phase is one statement)
-- so the worst case is a 30s stall followed by a clean rollback.
set local statement_timeout = '30s';

-- ─── 0. Dependency ───────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_internal_staff()') is null then
    raise exception 'open-policy lockdown: public.is_internal_staff() is missing; apply 20261015_0030_profiles_read_lockdown.sql first';
  end if;
  if not has_function_privilege('authenticated', 'public.is_internal_staff()', 'execute')
     or has_function_privilege('anon', 'public.is_internal_staff()', 'execute') then
    raise exception 'open-policy lockdown: wrong EXECUTE grants on public.is_internal_staff()';
  end if;
end;
$$;

-- ─── 1. Bench API robot predicate ────────────────────────────────────────────
-- public.is_api_robot() (20261015_0031): profiles with is_api_robot = true and role NULL
-- (lib/bench/issueKey.ts). A PARALLEL SAFE definer helper rather than an inline
-- auth.uid() subquery, so staff queries on pdl_companies keep parallel plans.
do $$
begin
  if to_regprocedure('public.is_api_robot()') is null
     or not has_function_privilege('authenticated', 'public.is_api_robot()', 'execute') then
    raise exception 'open-policy lockdown: public.is_api_robot() is missing or not executable by authenticated; apply 20261015_0031_staff_gate_helpers first';
  end if;
end;
$$;

-- ─── 2. Scope ────────────────────────────────────────────────────────────────
-- mode: staff       restrictive gate, staff only
--       own         reads: staff or own_pred; writes: staff only
--       robot       reads: staff or Bench robot; writes: staff only
--       public_read select stays open (deliberate public object); writes: staff only
--       anon_marks  deliberate anon select/insert stay; authenticated: staff only
--       skip        handled elsewhere (profiles: 20261015_0030)
-- Tables that do not exist (prod-only tables in a repo-built database) are skipped.
create temp table open_policy_lockdown_scope (
  tbl text primary key,
  mode text not null check (mode in ('staff', 'own', 'robot', 'public_read', 'anon_marks', 'skip')),
  own_pred text,
  probe_limit integer
) on commit drop;

insert into pg_temp.open_policy_lockdown_scope (tbl, mode, own_pred) values
  ('ai_call_analyses', 'staff', null),
  ('ai_caller_tg_chats', 'staff', null),
  ('ai_campaign_contacts', 'staff', null),
  ('ai_campaigns', 'staff', null),
  ('amo_events', 'staff', null),
  ('amo_leads', 'staff', null),
  ('amo_statuses', 'staff', null),
  ('amo_users', 'staff', null),
  ('attribution_amo_project', 'staff', null),
  ('attribution_payment_project', 'staff', null),
  ('attribution_visit_lead', 'staff', null),
  ('background_scorer_state', 'staff', null),
  ('bank_transactions', 'staff', null),
  ('bugor_outreach_config', 'staff', null),
  ('bugor_outreach_leads', 'staff', null),
  ('client_auto_pipeline_configs', 'staff', null),
  ('client_auto_pipeline_runs', 'staff', null),
  ('client_auto_pipeline_seen_employers', 'staff', null),
  ('client_campaign_leads', 'staff', null),
  ('client_instantly_access', 'staff', null),
  ('client_manual_score_rows', 'own',
     'exists (select 1 from public.client_manual_score_runs r where r.id = client_manual_score_rows.run_id and r.client_user_id = (select auth.uid()))'),
  ('client_manual_score_runs', 'own', 'client_user_id = (select auth.uid())'),
  ('client_tariffs', 'staff', null),
  ('companies_directory', 'public_read', null),
  ('database_review_requests', 'staff', null),
  ('database_review_row_marks', 'anon_marks', null),
  ('external_sync_runs', 'staff', null),
  ('finance_expenses', 'staff', null),
  ('fns_revenue', 'staff', null),
  ('funded_companies', 'staff', null),
  ('gis_signal_company_signals', 'staff', null),
  ('gis_signal_pipeline_config', 'staff', null),
  ('gis_signal_runs', 'staff', null),
  ('gis_signal_seen_companies', 'staff', null),
  ('gis_signal_segments', 'staff', null),
  ('global_tool_visibility', 'staff', null),
  ('instantly_lead_qualifications', 'staff', null),
  ('instantly_webhook_events', 'staff', null),
  ('invoices', 'staff', null),
  ('kb_chunks', 'staff', null),
  ('kb_compiled_brief', 'staff', null),
  ('kb_documents', 'staff', null),
  ('large_score_domains', 'staff', null),
  ('large_score_jobs', 'staff', null),
  ('leadgen_radar_signals', 'staff', null),
  ('leads_report_subscribers', 'staff', null),
  ('li_accounts', 'staff', null),
  ('li_campaigns', 'staff', null),
  ('mailganer_domain_scores', 'staff', null),
  ('metrika_visits', 'staff', null),
  ('metrika_visits_daily', 'staff', null),
  ('nash_outreach_config', 'staff', null),
  ('nash_outreach_leads', 'staff', null),
  ('outreachos_pipeline_config', 'staff', null),
  ('outreachos_pipeline_runs', 'staff', null),
  ('outreachos_seen_employers', 'staff', null),
  ('pdl_companies', 'robot', '(select public.is_api_robot())'),
  ('polza_chain_templates', 'staff', null),
  ('polza_outreach_companies', 'staff', null),
  ('polza_outreach_settings', 'staff', null),
  ('polza_ru_cases', 'staff', null),
  ('polza_ru_offer_claims', 'staff', null),
  ('polza_ru_outreach_companies', 'staff', null),
  ('polza_ru_senders', 'staff', null),
  ('polza_ru_signal_rows', 'staff', null),
  ('polza_ru_signal_uploads', 'staff', null),
  ('portal_translations', 'staff', null),
  ('profiles', 'skip', null),
  ('project_contacts_history', 'staff', null),
  ('project_notes', 'staff', null),
  ('project_periods', 'staff', null),
  ('projects', 'staff', null),
  ('rdp_bookings', 'staff', null),
  ('rdp_sessions', 'staff', null),
  ('sales_ai_analysis_jobs', 'staff', null),
  ('sales_ai_deal_analysis', 'staff', null),
  ('sales_ai_evidence', 'staff', null),
  ('sales_regulation', 'staff', null),
  ('task_board_columns', 'staff', null),
  ('task_boards', 'staff', null),
  ('tasks', 'staff', null),
  ('tg_outreach_account_moves', 'staff', null),
  ('tg_outreach_accounts', 'staff', null),
  ('tg_outreach_base_attachments', 'staff', null),
  ('tg_outreach_base_contacts', 'staff', null),
  ('tg_outreach_bases', 'staff', null),
  ('tg_outreach_campaign_bases', 'staff', null),
  ('tg_outreach_campaigns', 'staff', null),
  ('tg_outreach_crm_pushes', 'staff', null),
  ('tg_outreach_dialogs', 'staff', null),
  ('tg_outreach_jobs', 'staff', null),
  ('tg_outreach_lead_forwards', 'staff', null),
  ('tg_outreach_logs', 'staff', null),
  ('tg_outreach_processed', 'staff', null),
  ('tg_outreach_proxies', 'staff', null),
  ('tg_outreach_proxy_swaps', 'staff', null),
  ('tg_outreach_warmup_activities', 'staff', null),
  ('tg_outreach_warmup_chat_members', 'staff', null),
  ('tg_outreach_warmup_chats', 'staff', null),
  ('tg_outreach_warmup_conversations', 'staff', null),
  ('tg_outreach_warmup_logs', 'staff', null),
  ('tg_outreach_warmup_peers', 'staff', null),
  ('tg_outreach_warmup_runs', 'staff', null),
  ('tg_parser_account_usage', 'staff', null),
  ('tg_parser_accounts', 'staff', null),
  ('tg_parser_jobs', 'staff', null),
  ('tg_parser_logs', 'staff', null),
  ('tg_pool_account_tags', 'staff', null),
  ('tg_pool_accounts', 'staff', null),
  ('tg_pool_proxies', 'staff', null),
  ('tg_pool_proxy_tags', 'staff', null),
  ('tg_pool_tags', 'staff', null),
  ('trace_spans', 'staff', null),
  ('user_instantly_campaign_preferences', 'staff', null),
  ('user_reply_macros', 'staff', null);

delete from pg_temp.open_policy_lockdown_scope s
 where s.mode = 'skip'
    or to_regclass(format('public.%I', s.tbl)) is null;

-- ─── 3. Lock everything in scope, children before parents ────────────────────
-- lock_rank = longest chain of in-scope FK references starting at the table.
alter table pg_temp.open_policy_lockdown_scope add column lock_rank integer not null default 0;
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select to_regclass(format('public.%I', s.tbl)) from pg_temp.open_policy_lockdown_scope s)
    and con.confrelid in (select to_regclass(format('public.%I', s.tbl)) from pg_temp.open_policy_lockdown_scope s)
), walk(start, node, depth, path) as (
  select to_regclass(format('public.%I', s.tbl))::oid, to_regclass(format('public.%I', s.tbl))::oid, 0,
         array[to_regclass(format('public.%I', s.tbl))::oid]
  from pg_temp.open_policy_lockdown_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update pg_temp.open_policy_lockdown_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = to_regclass(format('public.%I', s.tbl))::oid;

do $$
declare
  r record;
begin
  for r in select s.tbl from pg_temp.open_policy_lockdown_scope s order by s.lock_rank desc, s.tbl loop
    execute format('lock table public.%I in access exclusive mode', r.tbl);
  end loop;
end;
$$;
-- No lock waits after this point (every table in scope is held); bound the probes
-- and the policy DDL generously instead of with the 30s lock-phase cap.
set local statement_timeout = '120s';

-- Probes that must return no rows scan the whole table, so they only run on tables
-- of at most 8 MB; on bigger ones the probes read at most 1000 rows.
update pg_temp.open_policy_lockdown_scope s
   set probe_limit = case
     when pg_catalog.pg_relation_size(format('public.%I', s.tbl)::regclass) <= 8 * 1024 * 1024 then null
     else 1000
   end;

-- A "limit 1000" probe stops early only if the caller sees most rows. The staff probe on
-- a big table therefore counts a fixed sample instead: up to 1000 rows read here as the
-- migration runner (no RLS), probed by ctid (a TID scan, bounded whatever the policies
-- let through). The tables are locked, so the ctids cannot move before the second probe.
alter table pg_temp.open_policy_lockdown_scope add column sample tid[];
do $$
declare
  r record;
  v tid[];
begin
  for r in select s.tbl from pg_temp.open_policy_lockdown_scope s where s.probe_limit is not null loop
    execute format('select coalesce(array_agg(x.ctid), array[]::tid[]) from (select ctid from public.%I limit 1000) x', r.tbl) into v;
    update pg_temp.open_policy_lockdown_scope s set sample = v where s.tbl = r.tbl;
  end loop;
end;
$$;

-- One PostgREST-style request: role + JWT claims, then a (bounded) count.
-- Returns -1 when the role has no privilege on the table.
create or replace function pg_temp.olp_probe(p_tbl text, p_role text, p_sub uuid, p_limit integer, p_sample tid[] default null)
returns bigint
language plpgsql
as $f$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_n bigint;
begin
  if p_role is not null then
    perform set_config('request.jwt.claims',
      case when p_sub is null then json_build_object('role', p_role)::text
           else json_build_object('sub', p_sub, 'role', p_role)::text end, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_role, true);
  end if;
  begin
    if p_sample is not null then
      execute format('select count(*) from public.%I where ctid = any ($1)', p_tbl) into v_n using p_sample;
    elsif p_limit is null then
      execute format('select count(*) from public.%I', p_tbl) into v_n;
    else
      execute format('select count(*) from (select 1 from public.%I limit %s) s', p_tbl, p_limit) into v_n;
    end if;
  exception when insufficient_privilege then
    v_n := -1;
  end;
  perform set_config('role', v_prev_role, true);
  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
  return v_n;
end;
$f$;

-- Probe accounts: a non-demo staff member (admin first), a client (one with manual
-- scoring runs first), a Bench robot, and a JWT whose sub has no profile.
create temp table open_policy_lockdown_actor (kind text primary key, id uuid) on commit drop;
insert into pg_temp.open_policy_lockdown_actor (kind, id)
select 'staff', p.id from public.profiles p
 where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
   and coalesce(p.is_demo, false) = false
 order by (p.role = 'admin') desc, p.created_at nulls last, p.id
 limit 1;
insert into pg_temp.open_policy_lockdown_actor (kind, id)
select 'client', p.id from public.profiles p
 where p.role = 'client'
 order by (to_regclass('public.client_manual_score_runs') is not null
           and exists (select 1 from public.client_manual_score_runs r where r.client_user_id = p.id)) desc,
          p.created_at nulls last, p.id
 limit 1;
insert into pg_temp.open_policy_lockdown_actor (kind, id)
select 'robot', p.id from public.profiles p
 where p.is_api_robot = true and p.role is null
 order by p.created_at nulls last, p.id
 limit 1;
insert into pg_temp.open_policy_lockdown_actor (kind, id)
values ('unknown', '00000000-0000-4000-8000-00000000dead');

-- What the staff probe sees today, per table.
create temp table open_policy_lockdown_before (tbl text primary key, staff_n bigint) on commit drop;
do $$
declare
  v_staff uuid := (select a.id from pg_temp.open_policy_lockdown_actor a where a.kind = 'staff');
  r record;
begin
  if v_staff is null then
    return;
  end if;
  for r in select s.tbl, s.probe_limit, s.sample from pg_temp.open_policy_lockdown_scope s order by s.tbl loop
    insert into pg_temp.open_policy_lockdown_before (tbl, staff_n)
    values (r.tbl, pg_temp.olp_probe(r.tbl, 'authenticated', v_staff, r.probe_limit, r.sample));
  end loop;
end;
$$;

-- ─── 4. Gates, service-policy retarget, anon revoke ──────────────────────────
do $$
declare
  c_staff constant text := '(select public.is_internal_staff())';
  r record;
  p record;
  v_rel regclass;
  v_roles text;
  v_extra text;
  v_name text;
  v_gate text;
  v_seq record;
begin
  for r in select s.* from pg_temp.open_policy_lockdown_scope s order by s.tbl loop
    v_rel := format('public.%I', r.tbl)::regclass;

    -- fns_revenue: the repo never enabled RLS on it, prod did (with an open select
    -- policy that only exists on prod). Same end state in both: RLS on, staff read.
    if r.tbl = 'fns_revenue' then
      execute 'alter table public.fns_revenue enable row level security';
      execute 'drop policy if exists fns_revenue_staff_select on public.fns_revenue';
      execute format('create policy fns_revenue_staff_select on public.fns_revenue as permissive for select to authenticated using (%s)', c_staff);
    end if;

    -- A gate on a table without RLS would be inert. Prod has RLS on all of these.
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_rel) then
      raise exception 'open-policy lockdown: RLS is disabled on public.%; enable it deliberately first', r.tbl;
    end if;

    -- "service role ..." policies written TO public USING (true): retarget them and
    -- keep the staff part of what they gave.
    for p in
      select pol.policyname, pol.cmd
        from pg_catalog.pg_policies pol
       where pol.schemaname = 'public'
         and pol.tablename = r.tbl
         and pol.permissive = 'PERMISSIVE'
         and pol.roles = array['public']::name[]
         and coalesce(pol.qual, 'true') = 'true'
         and coalesce(pol.with_check, 'true') = 'true'
         and pol.policyname ilike '%service%'
       order by pol.policyname
    loop
      -- A direct non-bypass login that reads this table today through the TO public
      -- policy keeps it. Expected to be empty on prod (readonly/nick_ro are BYPASSRLS).
      select string_agg(quote_ident(rr.rolname), ', ' order by rr.rolname)
        into v_extra
        from pg_catalog.pg_roles rr
       where rr.rolcanlogin
         and not rr.rolsuper
         and not rr.rolbypassrls
         and rr.rolname not in ('anon', 'authenticated', 'service_role', 'authenticator')
         and rr.rolname !~ '^pg_'
         and pg_catalog.has_table_privilege(rr.oid, v_rel, 'SELECT');
      v_roles := 'service_role' || coalesce(', ' || v_extra, '');
      if v_extra is not null then
        raise notice 'open-policy lockdown: policy "%" on public.% kept for direct login(s) %', p.policyname, r.tbl, v_extra;
      end if;
      execute format('alter policy %I on public.%I to %s', p.policyname, r.tbl, v_roles);

      v_name := r.tbl || '_staff_' || lower(p.cmd);
      execute format('drop policy if exists %I on public.%I', v_name, r.tbl);
      execute format('create policy %I on public.%I as permissive for %s to authenticated %s',
        v_name, r.tbl, p.cmd,
        case p.cmd
          when 'SELECT' then format('using (%s)', c_staff)
          when 'DELETE' then format('using (%s)', c_staff)
          when 'INSERT' then format('with check (%s)', c_staff)
          else format('using (%s) with check (%s)', c_staff, c_staff)
        end);
    end loop;

    -- The gate.
    if r.mode = 'staff' then
      v_gate := r.tbl || '_staff_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for all to anon, authenticated using (%s) with check (%s)',
        v_gate, r.tbl, c_staff, c_staff);
    elsif r.mode in ('own', 'robot') then
      v_gate := r.tbl || case r.mode when 'own' then '_staff_or_own_gate' else '_staff_or_robot_gate' end;
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for all to anon, authenticated using (%s or %s) with check (%s)',
        v_gate, r.tbl, c_staff, r.own_pred, c_staff);
      -- DELETE only checks USING; keep deletes staff-only.
      v_gate := r.tbl || '_staff_delete_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for delete to anon, authenticated using (%s)',
        v_gate, r.tbl, c_staff);
    elsif r.mode = 'public_read' then
      v_gate := r.tbl || '_staff_insert_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for insert to anon, authenticated with check (%s)',
        v_gate, r.tbl, c_staff);
      v_gate := r.tbl || '_staff_update_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for update to anon, authenticated using (%s) with check (%s)',
        v_gate, r.tbl, c_staff, c_staff);
      v_gate := r.tbl || '_staff_delete_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for delete to anon, authenticated using (%s)',
        v_gate, r.tbl, c_staff);
    elsif r.mode = 'anon_marks' then
      v_gate := r.tbl || '_staff_gate';
      execute format('drop policy if exists %I on public.%I', v_gate, r.tbl);
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
        v_gate, r.tbl, c_staff, c_staff);
    end if;

    -- anon: nothing, except the deliberate public parts.
    if r.mode = 'public_read' then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from anon', r.tbl);
    elsif r.mode = 'anon_marks' then
      execute format('revoke update, delete, truncate, references, trigger on table public.%I from anon', r.tbl);
    else
      execute format('revoke all on table public.%I from anon', r.tbl);
    end if;
    for v_seq in
      select d.objid::regclass as seq
        from pg_catalog.pg_depend d
        join pg_catalog.pg_class sc on sc.oid = d.objid and sc.relkind = 'S'
       where d.classid = 'pg_catalog.pg_class'::regclass
         and d.refclassid = 'pg_catalog.pg_class'::regclass
         and d.refobjid = v_rel
         and d.deptype in ('a', 'i')
    loop
      execute format('revoke all on sequence %s from anon', v_seq.seq);
    end loop;
  end loop;
end;
$$;

-- ─── 5. pdl_count_estimate: same number for staff as before the gate ─────────
-- Runs the EXPLAIN as the owner (no RLS filter in the plan) and checks the caller
-- itself. API callers that are neither staff nor a Bench robot get 0 (today they get
-- the planner estimate of the whole catalogue). service_role and direct DB callers
-- are not API callers and get the estimate.
create or replace function public.pdl_count_estimate(
  p_country  text[] default null,
  p_industry text[] default null,
  p_size     text[] default null,
  p_name     text   default null
) returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  conds text := '';
  plan  json;
begin
  if coalesce(nullif(current_setting('role', true), 'none'), session_user::text) in ('anon', 'authenticated')
     and not (public.is_internal_staff() or public.is_api_robot()) then
    return 0;
  end if;
  if p_country is not null and array_length(p_country, 1) > 0 then
    conds := conds || format(' and country = any (%L::text[])', p_country);
  end if;
  if p_industry is not null and array_length(p_industry, 1) > 0 then
    conds := conds || format(' and industry = any (%L::text[])', p_industry);
  end if;
  if p_size is not null and array_length(p_size, 1) > 0 then
    conds := conds || format(' and size = any (%L::text[])', p_size);
  end if;
  if p_name is not null and length(trim(p_name)) > 0 then
    conds := conds || format(' and name ilike %L', '%' || trim(p_name) || '%');
  end if;

  execute 'explain (format json) select 1 from public.pdl_companies where true' || conds into plan;
  return (plan -> 0 -> 'Plan' ->> 'Plan Rows')::bigint;
end;
$$;

revoke all on function public.pdl_count_estimate(text[], text[], text[], text) from public;
revoke all on function public.pdl_count_estimate(text[], text[], text[], text) from anon;
grant execute on function public.pdl_count_estimate(text[], text[], text[], text) to authenticated;
grant execute on function public.pdl_count_estimate(text[], text[], text[], text) to service_role;

-- ─── 5b. search_pdl_companies: the staff name search keeps its trigram index ─
-- Body unchanged from 20260901_0001. As SECURITY DEFINER the catalogue query runs as
-- the owner, without the gate's RLS qual, so `name ilike '%x%'` can still use
-- idx_pdl_companies_name_trgm. The caller check mirrors what the table allows: rows
-- only for a caller that has SELECT on pdl_companies and is service_role (the VE2/HE
-- workers), bypasses RLS (superusers, readonly, nick_ro) or carries a staff or
-- Bench-robot JWT. Anyone else gets '[]' before the table is read (today a client gets
-- [] from RLS).
create or replace function public.search_pdl_companies(
  p_industries text[] default null,
  p_sizes      text[] default null,
  p_countries  text[] default null,
  p_name       text   default null,
  p_after_id   text   default null,
  p_limit      int    default 1000
)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  v_caller text := coalesce(nullif(pg_catalog.current_setting('role', true), 'none'), session_user::text);
begin
  if not (pg_catalog.has_table_privilege(v_caller, 'public.pdl_companies', 'SELECT')
          and (v_caller = 'service_role'
               or exists (select 1 from pg_catalog.pg_roles r
                           where r.rolname = v_caller and (r.rolsuper or r.rolbypassrls))
               or public.is_internal_staff()
               or public.is_api_robot())) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      with m as materialized (
        select p.id, p.name, p.website, p.industry, p.size, p.country,
               p.region, p.locality, p.description
        from public.pdl_companies p
        where (p_industries is null or p.industry = any(p_industries))
          and (p_sizes is null or p.size = any(p_sizes))
          and (p_countries is null or p.country = any(p_countries))
          and (p_name is null or p.name ilike '%' || p_name || '%')
      )
      select * from m
      where (p_after_id is null or m.id > p_after_id)
      order by m.id
      limit greatest(1, least(coalesce(p_limit, 1000), 100000))
    ) sub
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.search_pdl_companies(text[], text[], text[], text, text, int) from public;
revoke all on function public.search_pdl_companies(text[], text[], text[], text, text, int) from anon;
grant execute on function public.search_pdl_companies(text[], text[], text[], text, text, int) to authenticated;
grant execute on function public.search_pdl_companies(text[], text[], text[], text, text, int) to service_role;

-- ─── 6. Self-check: fails the migration, never the running app ───────────────
do $$
declare
  -- pg_get_expr omits the schema when public is on the search_path, so match the call.
  c_staff_qual constant text := 'is_internal_staff()';
  v_staff   uuid := (select a.id from pg_temp.open_policy_lockdown_actor a where a.kind = 'staff');
  v_client  uuid := (select a.id from pg_temp.open_policy_lockdown_actor a where a.kind = 'client');
  v_robot   uuid := (select a.id from pg_temp.open_policy_lockdown_actor a where a.kind = 'robot');
  v_unknown uuid := (select a.id from pg_temp.open_policy_lockdown_actor a where a.kind = 'unknown');
  r record;
  v_rel regclass;
  v_owner_n bigint;
  v_n bigint;
  v_expect bigint;
  v_ok boolean;
  v_gates text[];
  v_bad text;
  v_prev_role text := current_setting('role');
begin
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER')
     or not pg_catalog.pg_has_role(current_user, 'anon', 'MEMBER')
     or not pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER') then
    raise exception 'open-policy lockdown: % cannot SET ROLE anon/authenticated/service_role for the self-check; run migrations as supabase_admin or postgres', current_user;
  end if;

  -- 6a. The staff helper's owner and the estimate function bypass RLS; EXECUTE grants.
  select rr.rolsuper
         or rr.rolbypassrls
         or (pg_catalog.pg_has_role(pp.proowner, c.relowner, 'USAGE') and not c.relforcerowsecurity)
    into v_ok
    from pg_catalog.pg_proc pp
    join pg_catalog.pg_roles rr on rr.oid = pp.proowner
   cross join pg_catalog.pg_class c
   where pp.oid = 'public.is_internal_staff()'::regprocedure
     and c.oid = 'public.profiles'::regclass;
  if not coalesce(v_ok, false) then
    raise exception 'open-policy lockdown: owner of is_internal_staff() does not bypass RLS on public.profiles';
  end if;
  select pp.prosecdef
         and (rr.rolsuper or rr.rolbypassrls)
    into v_ok
    from pg_catalog.pg_proc pp
    join pg_catalog.pg_roles rr on rr.oid = pp.proowner
   where pp.oid = 'public.pdl_count_estimate(text[],text[],text[],text)'::regprocedure;
  if not coalesce(v_ok, false)
     or has_function_privilege('anon', 'public.pdl_count_estimate(text[],text[],text[],text)', 'execute')
     or not has_function_privilege('authenticated', 'public.pdl_count_estimate(text[],text[],text[],text)', 'execute')
     or not has_function_privilege('service_role', 'public.pdl_count_estimate(text[],text[],text[],text)', 'execute') then
    raise exception 'open-policy lockdown: pdl_count_estimate is not SECURITY DEFINER with a bypassing owner, or has wrong EXECUTE grants';
  end if;
  -- A definer whose owner bypasses RLS plans without the gate's qual: that, not a plan
  -- shape, is what keeps the trigram index usable (EXPLAIN cannot see inside it).
  select pp.prosecdef
         and (rr.rolsuper or rr.rolbypassrls)
         and 'search_path=""' = any (coalesce(pp.proconfig, array[]::text[]))
    into v_ok
    from pg_catalog.pg_proc pp
    join pg_catalog.pg_roles rr on rr.oid = pp.proowner
   where pp.oid = 'public.search_pdl_companies(text[],text[],text[],text,text,integer)'::regprocedure;
  if not coalesce(v_ok, false)
     or not has_function_privilege('authenticated', 'public.search_pdl_companies(text[],text[],text[],text,text,integer)', 'execute')
     or not has_function_privilege('service_role', 'public.search_pdl_companies(text[],text[],text[],text,text,integer)', 'execute') then
    raise exception 'open-policy lockdown: search_pdl_companies is not SECURITY DEFINER with a bypassing owner and an empty search_path, or has wrong EXECUTE grants';
  end if;

  for r in select s.* from pg_temp.open_policy_lockdown_scope s order by s.tbl loop
    v_rel := format('public.%I', r.tbl)::regclass;

    -- 6b. Structure.
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_rel) then
      raise exception 'open-policy lockdown: RLS is off on public.%', r.tbl;
    end if;
    v_gates := case r.mode
      when 'staff'       then array[r.tbl || '_staff_gate']
      when 'anon_marks'  then array[r.tbl || '_staff_gate']
      when 'own'         then array[r.tbl || '_staff_or_own_gate', r.tbl || '_staff_delete_gate']
      when 'robot'       then array[r.tbl || '_staff_or_robot_gate', r.tbl || '_staff_delete_gate']
      when 'public_read' then array[r.tbl || '_staff_insert_gate', r.tbl || '_staff_update_gate', r.tbl || '_staff_delete_gate']
    end;
    if (select count(*)
          from pg_catalog.pg_policies pol
         where pol.schemaname = 'public' and pol.tablename = r.tbl
           and pol.policyname = any (v_gates)
           and pol.permissive = 'RESTRICTIVE'
           and pol.roles = case when r.mode = 'anon_marks' then array['authenticated']::name[]
                                else array['anon', 'authenticated']::name[] end
           and (coalesce(pol.qual, '') like '%' || c_staff_qual || '%'
                or coalesce(pol.with_check, '') like '%' || c_staff_qual || '%')) <> cardinality(v_gates) then
      raise exception 'open-policy lockdown: gate policies on public.% are missing or wrong', r.tbl;
    end if;
    if exists (
      select 1 from pg_catalog.pg_policies pol
       where pol.schemaname = 'public' and pol.tablename = r.tbl
         and pol.permissive = 'PERMISSIVE'
         and pol.roles && array['public', 'anon', 'authenticated']::name[]
         and pol.policyname ilike '%service%'
         and coalesce(pol.qual, 'true') = 'true'
         and coalesce(pol.with_check, 'true') = 'true'
    ) then
      raise exception 'open-policy lockdown: public.% still has a service policy open to public/anon/authenticated', r.tbl;
    end if;

    -- 6c. anon privileges.
    v_ok := case r.mode
      when 'public_read' then
        has_table_privilege('anon', v_rel, 'SELECT')
        and not has_table_privilege('anon', v_rel, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      when 'anon_marks' then
        not has_table_privilege('anon', v_rel, 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      else
        not has_table_privilege('anon', v_rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    end;
    if not v_ok then
      raise exception 'open-policy lockdown: anon has unexpected privileges on public.% (a REVOKE by a non-owner only warns)', r.tbl;
    end if;

    -- 6d. Behaviour.
    if r.probe_limit is null then
      execute format('select count(*) from public.%I', r.tbl) into v_owner_n;
    else
      execute format('select count(*) from (select 1 from public.%I limit %s) s', r.tbl, r.probe_limit) into v_owner_n;
    end if;

    -- service_role: unchanged (everything).
    v_n := pg_temp.olp_probe(r.tbl, 'service_role', null, r.probe_limit);
    if v_n <> v_owner_n then
      raise exception 'open-policy lockdown probe: service_role sees % of % rows in public.%', v_n, v_owner_n, r.tbl;
    end if;

    -- staff: exactly what it saw before.
    if v_staff is not null then
      v_n := pg_temp.olp_probe(r.tbl, 'authenticated', v_staff, r.probe_limit, r.sample);
      v_expect := (select b.staff_n from pg_temp.open_policy_lockdown_before b where b.tbl = r.tbl);
      if v_n is distinct from v_expect then
        raise exception 'open-policy lockdown probe: staff % sees % rows in public.%, before: %', v_staff, v_n, r.tbl, v_expect;
      end if;
    end if;

    -- anon.
    v_n := pg_temp.olp_probe(r.tbl, 'anon', null, r.probe_limit);
    if r.mode in ('public_read', 'anon_marks') then
      if v_n <> v_owner_n then
        raise exception 'open-policy lockdown probe: anon sees % of % rows in deliberate public table public.%', v_n, v_owner_n, r.tbl;
      end if;
    elsif v_n <> -1 then
      raise exception 'open-policy lockdown probe: anon is not denied on public.% (% rows)', r.tbl, v_n;
    end if;

    -- Non-staff JWTs. Deliberate public reads stay; otherwise only own rows.
    if r.mode = 'public_read' then
      if v_client is not null and pg_temp.olp_probe(r.tbl, 'authenticated', v_client, r.probe_limit) <> v_owner_n then
        raise exception 'open-policy lockdown probe: a client lost read access to deliberate public table public.%', r.tbl;
      end if;
    elsif r.probe_limit is null then
      -- A JWT without a profile: nothing.
      v_n := pg_temp.olp_probe(r.tbl, 'authenticated', v_unknown, null);
      if v_n not in (0, -1) then
        raise exception 'open-policy lockdown probe: a JWT without a profile sees % rows in public.%', v_n, r.tbl;
      end if;
      -- A client: its own rows on the manual-scoring tables, nothing elsewhere.
      if v_client is not null then
        v_n := pg_temp.olp_probe(r.tbl, 'authenticated', v_client, null);
        if r.tbl = 'client_manual_score_runs' then
          select count(*) into v_expect from public.client_manual_score_runs x where x.client_user_id = v_client;
        elsif r.tbl = 'client_manual_score_rows' then
          select count(*) into v_expect from public.client_manual_score_rows x
           where x.run_id in (select y.id from public.client_manual_score_runs y where y.client_user_id = v_client);
        else
          v_expect := 0;
        end if;
        if not (v_n = v_expect or (v_expect = 0 and v_n = -1)) then
          raise exception 'open-policy lockdown probe: client % sees % rows in public.%, expected %', v_client, v_n, r.tbl, v_expect;
        end if;
      end if;
      -- A Bench robot: nothing except the pdl_companies catalogue.
      if v_robot is not null and r.mode <> 'robot' then
        v_n := pg_temp.olp_probe(r.tbl, 'authenticated', v_robot, null);
        if v_n not in (0, -1) then
          raise exception 'open-policy lockdown probe: Bench robot sees % rows in public.%', v_n, r.tbl;
        end if;
      end if;
    end if;
    if r.mode = 'robot' and v_robot is not null then
      v_n := pg_temp.olp_probe(r.tbl, 'authenticated', v_robot, r.probe_limit);
      if v_n <> v_owner_n then
        raise exception 'open-policy lockdown probe: Bench robot sees % of % rows in public.%', v_n, v_owner_n, r.tbl;
      end if;
    end if;
  end loop;

  -- 6e. pdl_count_estimate: staff get the owner's estimate, other JWTs get 0.
  if to_regclass('public.pdl_companies') is not null then
    v_owner_n := public.pdl_count_estimate(null, null, null, null);
    if v_staff is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_staff::text, true);
      perform set_config('role', 'authenticated', true);
      v_n := public.pdl_count_estimate(null, null, null, null);
      perform set_config('role', v_prev_role, true);
      if v_n <> v_owner_n then
        raise exception 'open-policy lockdown probe: staff pdl_count_estimate % <> owner estimate %', v_n, v_owner_n;
      end if;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_unknown, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_unknown::text, true);
    perform set_config('role', 'authenticated', true);
    v_n := public.pdl_count_estimate(null, null, null, null);
    perform set_config('role', v_prev_role, true);
    if v_n <> 0 then
      raise exception 'open-policy lockdown probe: a JWT without a profile gets pdl_count_estimate %', v_n;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);

    -- 6e'. search_pdl_companies. A JWT without a profile and a client get [] from the
    -- caller check, before the table is read, so these probes are cheap at any size.
    -- Staff and the Bench robot read the catalogue, so they are compared with the owner
    -- only where pdl_companies is small (with no filter the function materialises every
    -- row); on the big table the structural check in 6a covers them.
    for r in
      select u.who, u.uid
      from (values ('unknown', v_unknown), ('client', v_client), ('staff', v_staff), ('robot', v_robot)) u(who, uid)
      where u.uid is not null
        and (u.who in ('unknown', 'client')
             or (select s.probe_limit is null from pg_temp.open_policy_lockdown_scope s where s.tbl = 'pdl_companies'))
    loop
      v_expect := case when r.who in ('unknown', 'client') then 0
                       else pg_catalog.jsonb_array_length(public.search_pdl_companies(null, null, null, null, null, 1000)) end;
      perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', r.uid::text, true);
      perform set_config('role', 'authenticated', true);
      v_n := pg_catalog.jsonb_array_length(public.search_pdl_companies(null, null, null, null, null, 1000));
      perform set_config('role', v_prev_role, true);
      if v_n <> v_expect then
        raise exception 'open-policy lockdown probe: search_pdl_companies gives the % % rows, expected %', r.who, v_n, v_expect;
      end if;
    end loop;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- 6f. Direct logins that inherit anon/authenticated are gated like API callers.
  select string_agg(rr.rolname, ', ' order by rr.rolname) into v_bad
    from pg_catalog.pg_roles rr
   where rr.rolcanlogin and not rr.rolsuper and not rr.rolbypassrls
     and rr.rolname not in ('authenticator')
     and (pg_catalog.pg_has_role(rr.oid, 'authenticated', 'USAGE') or pg_catalog.pg_has_role(rr.oid, 'anon', 'USAGE'));
  if v_bad is not null then
    raise notice 'open-policy lockdown: direct login(s) % inherit anon/authenticated and now see only what a non-staff JWT sees on the gated tables', v_bad;
  end if;
end;
$$;

drop function pg_temp.olp_probe(text, text, uuid, integer, tid[]);
