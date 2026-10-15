-- READ-ONLY smoke after the lockdown series 20261015_0030..0036. Changes nothing: every
-- statement runs inside BEGIN READ ONLY ... ROLLBACK; role switches are SET LOCAL.
-- One file for both databases; it detects where it runs:
--   main DB      docker exec -i main-postgres psql -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 < 20261015_lockdown_smoke.sql
--   Instantly DB docker exec -i instantly-postgres-prod psql -U instantly -d instantly -X -q -At -v ON_ERROR_STOP=1 < 20261015_lockdown_smoke.sql
-- Output:
--   stderr  NOTICE lines "SMOKE|<check>|PASS|FAIL|WARN|INFO|<detail>", then
--           "SMOKE|summary|PASS|..." or an ERROR "lockdown smoke: N check(s) FAILED".
--   stdout  (main DB only) POLICIES|<table>|<permissive>|<restrictive>|<names>,
--           ACL|<relation>|<relkind>|<rls>|<relacl>, FN|<function>|<definer>|<proacl>
--           for a diff against the same lines printed by the rehearsal.
--   psql exit 0 = every check passed; 3 = a check failed (or an unexpected error).
-- 20261015_lockdown_rehearsal.sh runs this file inside its rehearsal transaction, after the
-- seven files and before its ROLLBACK, without the two lines marked lockdown-smoke:begin/end.
-- Keep those two markers and keep every other statement read-only.
-- Expectations are those of the series as tested (map/coverage-1015, scenario P4 = prod
-- catalog of 15.10.2026). Before the series is applied many checks FAIL by design.
begin read only; -- lockdown-smoke:begin

do $$
begin
  perform pg_catalog.set_config('lockdown_smoke.fails', '0', true);
  perform pg_catalog.set_config('lockdown_smoke.db',
    case when to_regclass('public.client_reply_telegram_links') is not null then 'instantly'
         when to_regclass('public.profiles') is not null and to_regclass('public.portal_migrations') is not null then 'main'
         else 'unknown' end, true);
  raise notice 'SMOKE|db|INFO|% (current_user %, %)', pg_catalog.current_setting('lockdown_smoke.db'), current_user,
    pg_catalog.current_setting('server_version');
end;
$$;

-- ─── M1–M12: catalog state (main DB) ─────────────────────────────────────────
do $$
declare
  v_fails int := 0;
  v_files text[] := array[
    '20261015_0030_profiles_read_lockdown.sql', '20261015_0031_staff_gate_helpers.sql',
    '20261015_0032_no_rls_tables_lockdown.sql', '20261015_0033_open_policies_staff_gate.sql',
    '20261015_0034_rls_tables_staff_or_own_gate.sql', '20261015_0035_storage_private_buckets_gate.sql',
    '20261015_0036_anon_definer_view_lockdown.sql'];
  -- 20261015_0036 lk_cfg 'auth_definers': the SECURITY DEFINER functions authenticated keeps.
  v_allow text[] := array[
    'public.is_internal_staff()', 'public.can_access_email_subscriptions()', 'public.can_manage_email_subscriptions()',
    'public.can_access_team()', 'public.can_mutate_team_data(text)', 'public.can_view_team_activity_plan()',
    'public.can_manage_team_activity_plan()', 'public.can_submit_team_review_request()',
    'public.can_view_team_review_requests_shared()', 'public.can_use_payment_requests()',
    'public.can_manage_payment_requests()',
    'public.convert_team_review_request(uuid,date,text,timestamp with time zone)',
    'public.payment_requests_read_model(date)',
    'public.submit_payment_request_with_budget(uuid,text,text,numeric,uuid,text,text,text,text,date,text,text)',
    'public.transition_payment_request(uuid,text,timestamp with time zone,text,date,text)',
    'public.record_email_subscription_payment_today(uuid,text,text,integer,numeric,text,text,text)',
    'public.decide_email_subscription(uuid,text,text,timestamp with time zone)', 'public.copilot_dialog_stats(uuid)',
    'public.is_api_robot()', 'public.pdl_count_estimate(text[],text[],text[],text)',
    'public.search_pdl_companies(text[],text[],text[],text,text,integer)'];
  v_allow_oids oid[];
  v_public oid := 'public'::regnamespace;
  v_n bigint;
  v_txt text;
  v_txt2 text;
  v_ok boolean;
  v_sig text;
  v_oid oid;
begin
  if pg_catalog.current_setting('lockdown_smoke.db') <> 'main' then return; end if;

  -- M1. Ledger.
  select count(*), string_agg(f, ', ') filter (where m.name is null)
    into v_n, v_txt
  from unnest(v_files) f left join public.portal_migrations m on m.name = f;
  select count(*) into v_n from public.portal_migrations where name = any (v_files);
  if v_n = 7 then raise notice 'SMOKE|M1 ledger|PASS|all 7 files in portal_migrations';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M1 ledger|FAIL|% of 7 in portal_migrations; missing: %', v_n, v_txt; end if;

  -- M2. Gate helpers: definer, parallel safe, owner bypasses RLS, EXECUTE only for
  --     authenticated (and service_role), never anon or PUBLIC.
  foreach v_sig in array array['public.is_internal_staff()', 'public.is_api_robot()'] loop
    v_oid := to_regprocedure(v_sig);
    if v_oid is null then
      v_fails := v_fails + 1; raise notice 'SMOKE|M2 helper|FAIL|% is missing', v_sig; continue;
    end if;
    select p.prosecdef and p.proparallel = 's' and (r.rolsuper or r.rolbypassrls)
           and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
           and not exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
           pg_catalog.format('definer=%s parallel=%s owner=%s acl=%s', p.prosecdef, p.proparallel, r.rolname, p.proacl)
      into v_ok, v_txt
    from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner where p.oid = v_oid;
    if v_ok then raise notice 'SMOKE|M2 helper|PASS|% %', v_sig, v_txt;
    else v_fails := v_fails + 1; raise notice 'SMOKE|M2 helper|FAIL|% %', v_sig, v_txt; end if;
  end loop;

  -- M3. anon on public relations: exactly the deliberate grants (0036 lk_cfg anon_select /
  --     anon_insert), table or column level, sequences included.
  select coalesce(string_agg(x.rel || ':' || x.privs, '; ' order by x.rel), '')
    into v_txt
  from (
    select c.relname as rel,
           array_to_string(array_remove(array[
             case when c.relkind = 'S' then case when pg_catalog.has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') then 'SEQUENCE' end end,
             case when c.relkind <> 'S' and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') or pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT')) then 'SELECT' end,
             case when c.relkind <> 'S' and (pg_catalog.has_table_privilege('anon', c.oid, 'INSERT') or pg_catalog.has_any_column_privilege('anon', c.oid, 'INSERT')) then 'INSERT' end,
             case when c.relkind <> 'S' and (pg_catalog.has_table_privilege('anon', c.oid, 'UPDATE') or pg_catalog.has_any_column_privilege('anon', c.oid, 'UPDATE')) then 'UPDATE' end,
             case when c.relkind <> 'S' and pg_catalog.has_table_privilege('anon', c.oid, 'DELETE') then 'DELETE' end,
             case when c.relkind <> 'S' and pg_catalog.has_table_privilege('anon', c.oid, 'TRUNCATE') then 'TRUNCATE' end,
             case when c.relkind <> 'S' and (pg_catalog.has_table_privilege('anon', c.oid, 'REFERENCES') or pg_catalog.has_any_column_privilege('anon', c.oid, 'REFERENCES')) then 'REFERENCES' end,
             case when c.relkind <> 'S' and pg_catalog.has_table_privilege('anon', c.oid, 'TRIGGER') then 'TRIGGER' end
           ], null), ',') as privs
    from pg_catalog.pg_class c
    where c.relnamespace = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  ) x
  where x.privs <> '';
  v_txt2 := 'companies_directory:SELECT; database_review_row_marks:SELECT,INSERT; reglament_documents:SELECT';
  if v_txt = v_txt2 then raise notice 'SMOKE|M3 anon relations|PASS|%', v_txt;
  else v_fails := v_fails + 1; raise notice 'SMOKE|M3 anon relations|FAIL|anon has: % (expected: %)', v_txt, v_txt2; end if;

  -- M4. No SECURITY DEFINER function in public is executable by anon or PUBLIC.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_txt
  from pg_catalog.pg_proc p
  where p.pronamespace = v_public and p.prosecdef
    and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
         or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_txt is null then raise notice 'SMOKE|M4 anon definers|PASS|none';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M4 anon definers|FAIL|anon/PUBLIC can execute: %', v_txt; end if;

  -- M5. authenticated: only the allowlist plus functions the policies (or constraints,
  --     defaults) call; every allowlisted function that exists stays executable.
  select array_agg(o) into v_allow_oids
  from (select to_regprocedure(s)::oid as o from unnest(v_allow) s) z where o is not null;
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), count(*) into v_txt, v_n
  from pg_catalog.pg_proc p
  where p.pronamespace = v_public and p.prosecdef
    and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not (p.oid = any (coalesce(v_allow_oids, array[]::oid[])))
    and not exists (select 1 from pg_catalog.pg_depend d
                    where d.refobjid = p.oid and d.refclassid = 'pg_catalog.pg_proc'::regclass
                      and d.classid in ('pg_catalog.pg_policy'::regclass, 'pg_catalog.pg_constraint'::regclass,
                                        'pg_catalog.pg_attrdef'::regclass, 'pg_catalog.pg_class'::regclass));
  select string_agg(s, ', ') into v_txt2 from unnest(v_allow) s
  where to_regprocedure(s) is not null and not pg_catalog.has_function_privilege('authenticated', to_regprocedure(s), 'EXECUTE');
  if v_txt is null and v_txt2 is null then
    select count(*) into v_n from pg_catalog.pg_proc p
    where p.pronamespace = v_public and p.prosecdef and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
    raise notice 'SMOKE|M5 authenticated definers|PASS|% executable (allowlist % present of %)', v_n, coalesce(cardinality(v_allow_oids), 0), cardinality(v_allow);
  else
    v_fails := v_fails + 1;
    raise notice 'SMOKE|M5 authenticated definers|FAIL|not allowlisted: %; allowlisted but not executable: %', coalesce(v_txt, '-'), coalesce(v_txt2, '-');
  end if;

  -- M6. Row level security on every table in public.
  select string_agg(c.relname, ', ' order by c.relname), count(*) into v_txt, v_n
  from pg_catalog.pg_class c where c.relnamespace = v_public and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v_n = 0 then raise notice 'SMOKE|M6 rls|PASS|every public table has RLS on';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M6 rls|FAIL|% table(s) without RLS: %', v_n, v_txt; end if;

  -- M7. profiles: the restrictive select policy of 0030.
  select count(*) into v_n from pg_catalog.pg_policy p
  where p.polrelid = 'public.profiles'::regclass and p.polname = 'profiles_select_self_or_staff'
    and not p.polpermissive and p.polcmd = 'r'
    and p.polroles @> array['anon'::regrole::oid, 'authenticated'::regrole::oid];
  if v_n = 1 then raise notice 'SMOKE|M7 profiles policy|PASS|profiles_select_self_or_staff restrictive for anon, authenticated';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M7 profiles policy|FAIL|profiles_select_self_or_staff missing or changed'; end if;

  -- M8. storage.objects: the two gates of 0035.
  select string_agg(n, ', ') into v_txt
  from unnest(array['lockdown_private_buckets_gate', 'lockdown_private_buckets_anon_gate']) n
  where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'storage.objects'::regclass and p.polname = n and not p.polpermissive);
  if v_txt is null then raise notice 'SMOKE|M8 storage gates|PASS|both restrictive gates present';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M8 storage gates|FAIL|missing: %', v_txt; end if;

  -- M9. Default privileges give anon nothing (global or in public).
  select string_agg(distinct pg_catalog.pg_get_userbyid(d.defaclrole)::text || '/' || d.defaclobjtype::text, ', ') into v_txt
  from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
  where (d.defaclnamespace = 0 or d.defaclnamespace = v_public) and a.grantee = 'anon'::regrole;
  if v_txt is null then raise notice 'SMOKE|M9 default privileges|PASS|nothing for anon';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M9 default privileges|FAIL|anon in default ACLs of: %', v_txt; end if;

  -- M10. The staff catalogue readers run as definer (0033 5a/5b), so the gate does not cost
  --      them their indexes.
  select string_agg(s, ', ') into v_txt
  from unnest(array['public.search_pdl_companies(text[],text[],text[],text,text,integer)',
                    'public.pdl_count_estimate(text[],text[],text[],text)']) s
  where to_regprocedure(s) is null
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = to_regprocedure(s));
  if v_txt is null then raise notice 'SMOKE|M10 catalogue definers|PASS|search_pdl_companies, pdl_count_estimate are SECURITY DEFINER';
  else v_fails := v_fails + 1; raise notice 'SMOKE|M10 catalogue definers|FAIL|not SECURITY DEFINER or missing: %', v_txt; end if;

  -- M11. The 0036 rollback snapshot exists and no API role can reach it.
  if to_regclass('lockdown_backup.acl_20261015_0036') is null then
    v_fails := v_fails + 1; raise notice 'SMOKE|M11 rollback snapshot|FAIL|lockdown_backup.acl_20261015_0036 is missing';
  elsif pg_catalog.has_schema_privilege('anon', 'lockdown_backup', 'USAGE')
        or pg_catalog.has_schema_privilege('authenticated', 'lockdown_backup', 'USAGE')
        or pg_catalog.has_schema_privilege('service_role', 'lockdown_backup', 'USAGE') then
    v_fails := v_fails + 1; raise notice 'SMOKE|M11 rollback snapshot|FAIL|an API role has USAGE on schema lockdown_backup';
  else
    select count(*) into v_n from lockdown_backup.acl_20261015_0036;
    raise notice 'SMOKE|M11 rollback snapshot|PASS|% rows, closed to API roles', v_n;
  end if;

  -- M12. service_role (supabaseAdmin: workers, client routes, Telegram reply flow) is unchanged.
  if (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = 'service_role')
     and pg_catalog.has_table_privilege('service_role', 'public.profiles', 'SELECT,INSERT,UPDATE,DELETE')
     and to_regprocedure('public.is_internal_staff()') is not null
     and pg_catalog.has_function_privilege('service_role', to_regprocedure('public.is_internal_staff()'), 'EXECUTE') then
    raise notice 'SMOKE|M12 service_role|PASS|BYPASSRLS, full rights on profiles';
  else
    v_fails := v_fails + 1; raise notice 'SMOKE|M12 service_role|FAIL|service_role lost BYPASSRLS or rights on profiles / is_internal_staff()';
  end if;

  perform pg_catalog.set_config('lockdown_smoke.fails',
    (pg_catalog.current_setting('lockdown_smoke.fails')::int + v_fails)::text, true);
end;
$$;

-- ─── P*: behaviour as PostgREST runs a request (role + JWT claims), main DB ──
-- Actors as in 0033: a non-demo staff member (admin first), a non-demo client (one with
-- manual scoring runs first), a Bench robot, a JWT whose sub has no profile, anon and
-- service_role. Probes are SELECTs; "limit 1" probes only read one row.
do $$
declare
  v_fails int := 0;
  v_staff uuid;
  v_client uuid;
  v_robot uuid;
  v_unknown uuid := '00000000-0000-4000-8000-00000000beef';
  v_prev_role text := pg_catalog.current_setting('role');
  v_prev_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_prev_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_actor_id uuid;
  v_role text;
  v_expect text;
  v_got text;
  v_skip text;
  r record;
begin
  if pg_catalog.current_setting('lockdown_smoke.db') <> 'main' then return; end if;

  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id limit 1;
  select p.id into v_client from public.profiles p
   where p.role = 'client' and coalesce(p.is_demo, false) = false
   order by (to_regclass('public.client_manual_score_runs') is not null
             and exists (select 1 from public.client_manual_score_runs m where m.client_user_id = p.id)) desc,
            p.created_at nulls last, p.id
   limit 1;
  begin
    execute 'select p.id from public.profiles p where p.is_api_robot = true and p.role is null order by p.created_at nulls last, p.id limit 1'
      into v_robot;
  exception when undefined_column then v_robot := null;
  end;
  raise notice 'SMOKE|actors|INFO|staff % client % robot % unknown %', v_staff, v_client, coalesce(v_robot::text, '-'), v_unknown;

  for r in
    select * from (values
      -- id, actor, needs (relation or function that must exist), probe, expectation
      -- expectation: 'sql:<query run as postgres>' | 'error:<SQLSTATE>' | 'noerror' |
      --              'closed' (0 rows or permission denied) | literal
      ('S1 staff helper', 'staff', 'public.is_internal_staff()', 'select public.is_internal_staff()::text', 'true'),
      ('S2 staff profiles', 'staff', 'public.profiles', 'select count(*)::text from public.profiles', 'sql:select count(*)::text from public.profiles'),
      ('S3 staff projects', 'staff', 'public.projects', 'select count(*)::text from public.projects', 'sql:select count(*)::text from public.projects'),
      ('S3 staff project_periods', 'staff', 'public.project_periods', 'select count(*)::text from public.project_periods', 'sql:select count(*)::text from public.project_periods'),
      ('S3 staff tasks', 'staff', 'public.tasks', 'select count(*)::text from public.tasks', 'sql:select count(*)::text from public.tasks'),
      ('S3 staff invoices', 'staff', 'public.invoices', 'select count(*)::text from public.invoices', 'sql:select count(*)::text from public.invoices'),
      ('S3 staff bank_transactions', 'staff', 'public.bank_transactions', 'select count(*)::text from public.bank_transactions', 'sql:select count(*)::text from public.bank_transactions'),
      ('S3 staff client_tariffs', 'staff', 'public.client_tariffs', 'select count(*)::text from public.client_tariffs', 'sql:select count(*)::text from public.client_tariffs'),
      ('S4 staff pdl_companies', 'staff', 'public.pdl_companies', 'select count(*)::text from (select 1 from public.pdl_companies limit 1) s', 'sql:select count(*)::text from (select 1 from public.pdl_companies limit 1) s'),
      ('S5 staff can_access_team()', 'staff', 'public.can_access_team()', 'select public.can_access_team()::text', 'noerror'),
      ('C1 client helper', 'client', 'public.is_internal_staff()', 'select public.is_internal_staff()::text', 'false'),
      ('C2 client profiles', 'client', 'public.profiles', 'select count(*)::text from public.profiles', '1'),
      ('C3 client projects', 'client', 'public.projects', 'select count(*)::text from (select 1 from public.projects limit 1) s', '0'),
      ('C3 client project_periods', 'client', 'public.project_periods', 'select count(*)::text from (select 1 from public.project_periods limit 1) s', '0'),
      ('C3 client tasks', 'client', 'public.tasks', 'select count(*)::text from (select 1 from public.tasks limit 1) s', '0'),
      ('C3 client invoices', 'client', 'public.invoices', 'select count(*)::text from (select 1 from public.invoices limit 1) s', '0'),
      ('C3 client bank_transactions', 'client', 'public.bank_transactions', 'select count(*)::text from (select 1 from public.bank_transactions limit 1) s', '0'),
      ('C3 client client_tariffs', 'client', 'public.client_tariffs', 'select count(*)::text from (select 1 from public.client_tariffs limit 1) s', '0'),
      ('C3 client finance_expenses', 'client', 'public.finance_expenses', 'select count(*)::text from (select 1 from public.finance_expenses limit 1) s', '0'),
      ('C3 client kb_documents', 'client', 'public.kb_documents', 'select count(*)::text from (select 1 from public.kb_documents limit 1) s', '0'),
      ('C4 client own manual runs', 'client', 'public.client_manual_score_runs', 'select count(*)::text from public.client_manual_score_runs', 'sql:select count(*)::text from public.client_manual_score_runs where client_user_id = $CLIENT'),
      ('C4 client own parser_jobs', 'client', 'public.parser_jobs', 'select count(*)::text from public.parser_jobs', 'sql:select count(*)::text from public.parser_jobs where user_id = $CLIENT'),
      ('C4 client own search_parser_jobs', 'client', 'public.search_parser_jobs', 'select count(*)::text from public.search_parser_jobs', 'sql:select count(*)::text from public.search_parser_jobs where user_id = $CLIENT'),
      ('C4 client own support threads', 'client', 'public.client_support_threads', 'select count(*)::text from public.client_support_threads', 'sql:select count(*)::text from public.client_support_threads where client_user_id = $CLIENT'),
      ('C5 client foreign private files', 'client', 'storage.objects', 'select count(*)::text from storage.objects o where o.bucket_id in (''briefs'', ''knowledge-base'') and coalesce(o.owner_id, o.owner::text) is distinct from $CLIENT::text', 'closed'),
      ('R1 robot helper', 'robot', 'public.is_api_robot()', 'select public.is_api_robot()::text', 'true'),
      ('R2 robot pdl_companies', 'robot', 'public.pdl_companies', 'select count(*)::text from (select 1 from public.pdl_companies limit 1) s', 'sql:select count(*)::text from (select 1 from public.pdl_companies limit 1) s'),
      ('R3 robot projects', 'robot', 'public.projects', 'select count(*)::text from (select 1 from public.projects limit 1) s', '0'),
      ('U1 no-profile JWT profiles', 'unknown', 'public.profiles', 'select count(*)::text from public.profiles', '0'),
      ('U2 no-profile JWT helper', 'unknown', 'public.is_internal_staff()', 'select public.is_internal_staff()::text', 'false'),
      ('U3 no-profile JWT projects', 'unknown', 'public.projects', 'select count(*)::text from (select 1 from public.projects limit 1) s', '0'),
      ('A1 anon profiles', 'anon', 'public.profiles', 'select count(*)::text from public.profiles', 'error:42501'),
      ('A2 anon is_internal_staff()', 'anon', 'public.is_internal_staff()', 'select public.is_internal_staff()::text', 'error:42501'),
      ('A3 anon projects', 'anon', 'public.projects', 'select count(*)::text from (select 1 from public.projects limit 1) s', 'error:42501'),
      ('A4 anon reglament_documents', 'anon', 'public.reglament_documents', 'select count(*)::text from (select 1 from public.reglament_documents limit 1) s', 'noerror'),
      ('A5 anon companies_directory', 'anon', 'public.companies_directory', 'select count(*)::text from (select 1 from public.companies_directory limit 1) s', 'noerror'),
      ('A6 anon private files', 'anon', 'storage.objects', 'select count(*)::text from storage.objects o where o.bucket_id in (''briefs'', ''knowledge-base'')', 'closed'),
      ('V1 service_role profiles', 'service', 'public.profiles', 'select count(*)::text from public.profiles', 'sql:select count(*)::text from public.profiles')
    ) s(id, actor, needs, probe, expectation)
  loop
    v_skip := null;
    if r.needs like '%(%' then
      if to_regprocedure(r.needs) is null then v_skip := r.needs || ' does not exist'; end if;
    elsif to_regclass(r.needs) is null then
      v_skip := r.needs || ' does not exist';
    end if;
    v_actor_id := case r.actor when 'staff' then v_staff when 'client' then v_client when 'robot' then v_robot
                               when 'unknown' then v_unknown else null end;
    if v_skip is null and r.actor in ('staff', 'client', 'robot') and v_actor_id is null then
      v_skip := 'no ' || r.actor || ' account';
    end if;
    -- A probe that must find no rows reads the whole table under RLS (the gate runs per
    -- row), and so does a full count: on a big table (pdl_companies, 19.5M rows) that is
    -- minutes of load. Such probes run only on tables up to 200k rows.
    if v_skip is null and r.needs not like '%(%'
       and (r.expectation in ('0', 'closed') or r.probe not like '%limit 1%')
       and (select c.reltuples from pg_catalog.pg_class c where c.oid = to_regclass(r.needs)) > 200000 then
      v_skip := r.needs || ' is too big for a probe that reads every row';
    end if;
    if v_skip is not null then
      raise notice 'SMOKE|%|INFO|skipped: %', r.id, v_skip;
      continue;
    end if;

    v_expect := r.expectation;
    if v_expect like 'sql:%' then
      execute replace(substr(v_expect, 5), '$CLIENT', pg_catalog.quote_literal(coalesce(v_client::text, ''))) into v_expect;
    end if;

    v_role := case r.actor when 'anon' then 'anon' when 'service' then 'service_role' else 'authenticated' end;
    perform pg_catalog.set_config('request.jwt.claims',
      case r.actor when 'anon' then '{"role":"anon"}'
                   when 'service' then '{"role":"service_role"}'
                   else json_build_object('sub', v_actor_id, 'role', 'authenticated')::text end, true);
    perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_actor_id::text, ''), true);
    begin
      perform pg_catalog.set_config('role', v_role, true);
      execute replace(r.probe, '$CLIENT', pg_catalog.quote_literal(coalesce(v_client::text, ''))) into v_got;
      perform pg_catalog.set_config('role', v_prev_role, true);
    exception when others then
      v_got := 'error:' || sqlstate;
      if v_expect not like 'error:%' and v_expect <> 'closed' then v_got := v_got || ' ' || sqlerrm; end if;
    end;
    perform pg_catalog.set_config('role', v_prev_role, true);
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);

    if (v_expect = 'noerror' and v_got not like 'error:%')
       or (v_expect = 'closed' and (v_got = '0' or v_got like 'error:42501%'))
       or v_got = v_expect then
      raise notice 'SMOKE|%|PASS|got %', r.id, v_got;
    else
      v_fails := v_fails + 1;
      raise notice 'SMOKE|%|FAIL|got %, expected %', r.id, v_got, v_expect;
    end if;
  end loop;

  perform pg_catalog.set_config('lockdown_smoke.fails',
    (pg_catalog.current_setting('lockdown_smoke.fails')::int + v_fails)::text, true);
end;
$$;

-- ─── Fingerprint (main DB): one md5 per section; the lines follow on stdout ──
do $$
declare
  v_pol text; v_acl text; v_fn text; v_np bigint; v_nr bigint;
begin
  if pg_catalog.current_setting('lockdown_smoke.db') <> 'main' then return; end if;
  select md5(string_agg(l, E'\n' order by l)), sum(np), sum(nr) into v_pol, v_np, v_nr from (
    select n.nspname || '.' || c.relname || '|' || count(*) filter (where p.polpermissive) || '|'
           || count(*) filter (where not p.polpermissive) || '|' || string_agg(p.polname, ',' order by p.polname) as l,
           count(*) filter (where p.polpermissive) as np, count(*) filter (where not p.polpermissive) as nr
    from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'storage') group by n.nspname, c.relname) x;
  select md5(string_agg(n.nspname || '.' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity || '|' || coalesce(c.relacl::text, ''), E'\n'
                        order by n.nspname, c.relname))
    into v_acl
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S');
  select md5(string_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || coalesce(p.proacl::text, ''), E'\n'
                        order by p.oid::regprocedure::text))
    into v_fn
  from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace;
  raise notice 'SMOKE|fingerprint|INFO|policies % (permissive %, restrictive %) md5 % | acl md5 % | functions md5 %',
    v_np + v_nr, v_np, v_nr, v_pol, v_acl, v_fn;
end;
$$;

select 'POLICIES|' || n.nspname || '.' || c.relname || '|' || count(*) filter (where p.polpermissive) || '|'
       || count(*) filter (where not p.polpermissive) || '|' || string_agg(p.polname, ',' order by p.polname)
from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'storage') and pg_catalog.current_setting('lockdown_smoke.db') = 'main'
group by n.nspname, c.relname order by 1;

select 'ACL|' || n.nspname || '.' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity || '|' || coalesce(c.relacl::text, '')
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  and pg_catalog.current_setting('lockdown_smoke.db') = 'main'
order by n.nspname, c.relname;

select 'FN|' || p.oid::regprocedure::text || '|' || p.prosecdef || '|' || coalesce(p.proacl::text, '')
from pg_catalog.pg_proc p
where p.pronamespace = 'public'::regnamespace and pg_catalog.current_setting('lockdown_smoke.db') = 'main'
order by p.oid::regprocedure::text;

-- ─── I1–I3: Instantly DB — the client Telegram reply links are untouched ─────
-- The series never connects to this database; this proves it. Baseline read (read-only)
-- from instantly-postgres-prod on 15.10.2026.
do $$
declare
  v_fails int := 0;
  v_fp text;
  v_expect text := 'rls=t force=f owner=instantly acl=- policies=Service role full access on client_reply_telegram_links/PERMISSIVE/public/*/true/true columns=client_user_id:uuid,chat_id:bigint,telegram_username:text,telegram_first_name:text,enabled:boolean,created_at:timestamp with time zone,updated_at:timestamp with time zone,leads_only:boolean';
  v_n bigint;
  v_e bigint;
begin
  if pg_catalog.current_setting('lockdown_smoke.db') <> 'instantly' then return; end if;
  select pg_catalog.format('rls=%s force=%s owner=%s acl=%s', c.relrowsecurity, c.relforcerowsecurity,
                           pg_catalog.pg_get_userbyid(c.relowner), coalesce(c.relacl::text, '-'))
         || ' policies=' || coalesce((
              select string_agg(pg_catalog.format('%s/%s/%s/%s/%s/%s', p.polname,
                       case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
                       (select string_agg(case when x = 0 then 'public' else pg_catalog.pg_get_userbyid(x)::text end, ','
                                         order by case when x = 0 then 'public' else pg_catalog.pg_get_userbyid(x)::text end)
                          from unnest(p.polroles) x),
                       p.polcmd, coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '-'),
                       coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '-')), ';' order by p.polname)
              from pg_catalog.pg_policy p where p.polrelid = c.oid), '-')
         || ' columns=' || (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
                              from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
    into v_fp
  from pg_catalog.pg_class c where c.oid = 'public.client_reply_telegram_links'::regclass;
  if v_fp = v_expect then raise notice 'SMOKE|I1 telegram links schema|PASS|unchanged since 15.10.2026';
  else v_fails := v_fails + 1; raise notice 'SMOKE|I1 telegram links schema|FAIL|now: % | baseline: %', v_fp, v_expect; end if;

  select count(*) into v_n from pg_catalog.pg_trigger t where t.tgrelid = 'public.client_reply_telegram_links'::regclass and not t.tgisinternal;
  if v_n = 0 then raise notice 'SMOKE|I2 telegram links triggers|PASS|none, as before';
  else v_fails := v_fails + 1; raise notice 'SMOKE|I2 telegram links triggers|FAIL|% trigger(s) appeared', v_n; end if;

  select count(*), count(*) filter (where enabled) into v_n, v_e from public.client_reply_telegram_links;
  raise notice 'SMOKE|I3 telegram links rows|INFO|% links, % enabled', v_n, v_e;

  perform pg_catalog.set_config('lockdown_smoke.fails',
    (pg_catalog.current_setting('lockdown_smoke.fails')::int + v_fails)::text, true);
end;
$$;

-- ─── Verdict ─────────────────────────────────────────────────────────────────
do $$
declare
  v_f int := pg_catalog.current_setting('lockdown_smoke.fails')::int;
  v_db text := pg_catalog.current_setting('lockdown_smoke.db');
begin
  if v_db = 'unknown' then
    raise exception 'lockdown smoke: this is neither the main DB nor the Instantly DB';
  end if;
  if v_f > 0 then
    raise exception 'lockdown smoke: % check(s) FAILED on the % DB (SMOKE|...|FAIL lines above)', v_f, v_db;
  end if;
  raise notice 'SMOKE|summary|PASS|% DB: every check passed', v_db;
end;
$$;

rollback; -- lockdown-smoke:end
