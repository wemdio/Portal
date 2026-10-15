-- Close every remaining RLS table to non-staff accounts, except the rows clients and
-- Bench robots really use with their own JWT.
--
-- LEAK. 20261015_0032 and 0033 cover the tables the prod TSV flagged (RLS off, or a
-- policy open to any signed-in account). About 90 more public tables have RLS on with
-- OWN-ROW policies (user_id = auth.uid(), or "own through the parent job"). They look
-- safe but are not: any signed-in account, including an open ENG self-serve signup or
-- the demo account, can INSERT its own rows through /rest/v1 into worker queues
-- (google_maps_jobs, website_enrichment_jobs, inn_enrich_jobs, email_validation_jobs,
-- lpr_jobs, reputation_jobs, brief_scoring_jobs, crypto_payment_jobs,
-- polza_report_jobs, sales_hypotheses_runs, hh_archive_jobs, yandex_direct_jobs,
-- lead_import_jobs, base_constructor_jobs, ...). Workers claim such rows and spend
-- money on them, while the tariff and demo checks live only in the API routes. A client
-- can also create sales-copilot configs bound to the studio's Telegram pool, tg-outreach
-- blocked-user rows, notifications and so on. And parser_jobs has
-- parser_jobs_select_outreach_shared (parser_type in polza outreach) for every signed-in
-- account, which shows clients the staff Polza outreach runs.
--
-- FIX. One RESTRICTIVE gate per table, TO anon, authenticated. Restrictive policies are
-- ANDed with every permissive one, so staff (public.is_internal_staff()) keep exactly
-- today's access and every other permissive policy is capped:
--   * default: staff only. Clients, demo, role-NULL accounts and demo staff get nothing.
--   * the client surface (the only tables a client page or allowlisted client route
--     reads or writes with the user's JWT; map in docs): own rows only, through the
--     owner column or the parent job/run/thread.
--       parser_jobs, search_parser_jobs, yandex_maps_jobs, yandex_maps_links,
--       email_sequence_v2_runs, email_sequence_v2_letters: read, write, delete own;
--       hh_vacancies, search_results, search_parser_query_stats,
--       yandex_maps_organizations, client_support_threads, client_support_messages:
--       read own (Realtime on the support chat included).
--     Writes need a non-demo client account (blockDemo already refuses demo in every
--     route that writes these tables). Client rows still pass the route's tariff check
--     only when created through the route; moving those inserts to the service role is
--     a code change (see the release notes), after which clients can lose INSERT here.
--   * the Bench API robot (public.is_api_robot()): own rows of the tables its tools use
--     (lib/bench/tools/*): read and write own jobs, read own results.
--   * deliberate public objects are not touched: reglament_documents keeps its
--     published-read for everyone, and companies_directory / database_review_row_marks
--     were handled in 0033.
-- The scope is read from the catalog: every public table with RLS on and a permissive
-- policy that applies to anon, authenticated or PUBLIC, minus profiles (0030),
-- reglament_documents, and tables that already carry a restrictive is_internal_staff()
-- gate (0032/0033). So prod-only tables are covered too.
--
-- WHO IS NOT AFFECTED. service_role (BYPASSRLS), postgres / supabase_admin (superusers:
-- migration runner, workers' direct pools, bots, backups, Realtime connection),
-- readonly and nick_ro (BYPASSRLS on prod). The gate is TO anon, authenticated only.
-- FK cascades and checks run as the table owner and bypass RLS.
--
-- DEPENDS ON public.is_internal_staff() (0030) and public.is_api_robot() (0031).
--
-- SAFETY. All tables in scope are locked ACCESS EXCLUSIVE up front, children before
-- parents (FK order); each lock wait is capped at 3s and the lock phase at 30s. Several
-- of these tables are worker queues (parser_jobs, hh_vacancies, search_*,
-- yandex_maps_*, email_validation_*, ...): apply with the workers drained, outside the
-- 06:00/18:00 UTC pg_dump and the 22:00 UTC portal-mirror cron. The self-check compares
-- what staff see before and after, and probes a JWT without a profile, a client and a
-- Bench robot; probes that must return no rows only run on tables of at most 8 MB. Any
-- mismatch raises and the whole file rolls back. The staff probe counts a fixed sample
-- of up to 1000 rows per table, read by ctid (a TID scan; tideq is leakproof, so RLS
-- keeps that plan): today's own-row policies show the probe account only its own rows,
-- so a "limit 1000" probe would read the whole heap of every big table while the locks
-- are held.
--
-- ROLLBACK: supabase/operator-sql/20261015_0034_rls_tables_staff_or_own_gate.rollback.sql
-- (drops lockdown_api_gate and lockdown_api_delete_gate on every public table). To
-- re-apply a corrected version, keep this file's portal_migrations row and ship a NEW
-- migration.

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ─── 1. Dependencies ─────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_internal_staff()') is null
     or to_regprocedure('public.is_api_robot()') is null then
    raise exception 'rls staff-or-own gate: apply 20261015_0030_profiles_read_lockdown and 20261015_0031_staff_gate_helpers first';
  end if;
  if not has_function_privilege('authenticated', 'public.is_internal_staff()', 'execute')
     or not has_function_privilege('authenticated', 'public.is_api_robot()', 'execute') then
    raise exception 'rls staff-or-own gate: authenticated must be able to execute is_internal_staff() and is_api_robot()';
  end if;
end;
$$;

-- ─── 2. Who may see own rows where ───────────────────────────────────────────
-- owner_col: the owner column of the table itself; or fk_col -> parent_tbl.parent_col.
-- client_ops / robot_ops: r = read own, w = insert/update own, d = delete own.
create temp table lockdown_api_surface (
  tbl text primary key,
  owner_col text,
  fk_col text,
  parent_tbl text,
  parent_col text,
  client_ops text not null default '',
  robot_ops text not null default '',
  check ((owner_col is not null) <> (fk_col is not null))
) on commit drop;

insert into pg_temp.lockdown_api_surface (tbl, owner_col, fk_col, parent_tbl, parent_col, client_ops, robot_ops) values
  -- client surface (/client/parsers, /client/sequences, /client/support) + Bench robot
  ('parser_jobs',               'user_id',        null,        null,                     null,             'rwd', 'rw'),
  ('hh_vacancies',              null,             'job_id',    'parser_jobs',            'user_id',        'r',   'r'),
  ('search_parser_jobs',        'user_id',        null,        null,                     null,             'rwd', 'rw'),
  ('search_results',            null,             'job_id',    'search_parser_jobs',     'user_id',        'r',   'r'),
  ('search_parser_query_stats', null,             'job_id',    'search_parser_jobs',     'user_id',        'r',   ''),
  ('yandex_maps_jobs',          'user_id',        null,        null,                     null,             'rwd', 'rw'),
  ('yandex_maps_links',         null,             'job_id',    'yandex_maps_jobs',       'user_id',        'rwd', ''),
  ('yandex_maps_organizations', null,             'job_id',    'yandex_maps_jobs',       'user_id',        'r',   'r'),
  ('email_sequence_v2_runs',    'user_id',        null,        null,                     null,             'rwd', ''),
  ('email_sequence_v2_letters', null,             'run_id',    'email_sequence_v2_runs', 'user_id',        'rwd', ''),
  ('client_support_threads',    'client_user_id', null,        null,                     null,             'r',   ''),
  ('client_support_messages',   null,             'thread_id', 'client_support_threads', 'client_user_id', 'r',   ''),
  -- Bench robot only (lib/bench/tools/*)
  ('ats_companies',             null,             'job_id',    'parser_jobs',            'user_id',        '',    'r'),
  ('eng_hiring_vacancies',      null,             'job_id',    'parser_jobs',            'user_id',        '',    'r'),
  ('google_maps_jobs',          'user_id',        null,        null,                     null,             '',    'rw'),
  ('google_maps_places',        null,             'job_id',    'google_maps_jobs',       'user_id',        '',    'r'),
  ('google_news_jobs',          'user_id',        null,        null,                     null,             '',    'rw'),
  ('google_news_results',       null,             'job_id',    'google_news_jobs',       'user_id',        '',    'r'),
  ('hh_archive_jobs',           'user_id',        null,        null,                     null,             '',    'rw'),
  ('hh_archive_results',        null,             'job_id',    'hh_archive_jobs',        'user_id',        '',    'r'),
  ('yandex_direct_jobs',        'user_id',        null,        null,                     null,             '',    'rw'),
  ('yandex_direct_results',     null,             'job_id',    'yandex_direct_jobs',     'user_id',        '',    'r'),
  ('email_validation_jobs',     'user_id',        null,        null,                     null,             '',    'rw'),
  ('email_validation_queue',    null,             'job_id',    'email_validation_jobs',  'user_id',        '',    'rw'),
  ('base_constructor_jobs',     'user_id',        null,        null,                     null,             '',    'rw'),
  ('inn_enrich_jobs',           'user_id',        null,        null,                     null,             '',    'rw');

-- ─── 3. Scope from the catalog ───────────────────────────────────────────────
create temp table lockdown_api_scope (
  tbl text primary key,
  rel regclass not null,
  own_expr text,
  read_ids text,
  write_ids text,
  delete_ids text,
  lock_rank integer not null default 0,
  small boolean not null default true,
  staff_before bigint,
  sample tid[]
) on commit drop;

insert into pg_temp.lockdown_api_scope (tbl, rel)
select c.relname, c.oid::regclass
from pg_catalog.pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r', 'p')
  and c.relname not in ('profiles', 'reglament_documents')
  and (
    -- reachable by an API role through a permissive policy
    exists (select 1 from pg_catalog.pg_policy p
            where p.polrelid = c.oid and p.polpermissive
              and p.polroles && array[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid])
    or c.relname in (select s.tbl from pg_temp.lockdown_api_surface s)
  )
  -- not already gated by 0032/0033
  and not exists (select 1 from pg_catalog.pg_policy p
                  where p.polrelid = c.oid and not p.polpermissive
                    and p.polroles && array[0::oid, 'authenticated'::regrole::oid]
                    and coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
                        || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') like '%is_internal_staff()%'
                    and p.polname not in ('lockdown_api_gate', 'lockdown_api_delete_gate'));

do $$
declare
  c_client_read  constant text := '(select exists (select 1 from public.profiles me where me.id = (select auth.uid()) and me.role = ''client''))';
  c_client_write constant text := '(select exists (select 1 from public.profiles me where me.id = (select auth.uid()) and me.role = ''client'' and not coalesce(me.is_demo, false)))';
  c_robot        constant text := '(select public.is_api_robot())';
  s record;
  v_rel regclass;
  v_bad text;
begin
  -- A gate on a table without RLS would be inert.
  select string_agg(x.tbl, ', ') into v_bad
  from pg_temp.lockdown_api_scope x
  join pg_catalog.pg_class c on c.oid = x.rel
  where not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'rls staff-or-own gate: RLS is disabled on %; enable it deliberately first', v_bad;
  end if;

  for s in
    select a.* from pg_temp.lockdown_api_surface a
    join pg_temp.lockdown_api_scope x on x.tbl = a.tbl
  loop
    v_rel := format('public.%I', s.tbl)::regclass;
    -- Every column the predicate names must exist, or the gate would not compile.
    if s.owner_col is not null then
      perform 1 from pg_catalog.pg_attribute where attrelid = v_rel and attname = s.owner_col and not attisdropped;
      if not found then raise exception 'rls staff-or-own gate: %.% is missing', s.tbl, s.owner_col; end if;
    else
      perform 1 from pg_catalog.pg_attribute where attrelid = v_rel and attname = s.fk_col and not attisdropped;
      if not found then raise exception 'rls staff-or-own gate: %.% is missing', s.tbl, s.fk_col; end if;
      perform 1 from pg_catalog.pg_attribute
       where attrelid = to_regclass(format('public.%I', s.parent_tbl)) and attname = s.parent_col and not attisdropped;
      if not found then raise exception 'rls staff-or-own gate: %.% is missing', s.parent_tbl, s.parent_col; end if;
    end if;

    update pg_temp.lockdown_api_scope x
       set own_expr = case
             when s.owner_col is not null then format('%I = (select auth.uid())', s.owner_col)
             else format('exists (select 1 from public.%I p where p.id = %I.%I and p.%I = (select auth.uid()))',
                         s.parent_tbl, s.tbl, s.fk_col, s.parent_col)
           end,
           read_ids = nullif(concat_ws(' or ',
                        case when s.client_ops like '%r%' then c_client_read end,
                        case when s.robot_ops like '%r%' then c_robot end), ''),
           write_ids = nullif(concat_ws(' or ',
                        case when s.client_ops like '%w%' then c_client_write end,
                        case when s.robot_ops like '%w%' then c_robot end), ''),
           delete_ids = nullif(concat_ws(' or ',
                        case when s.client_ops like '%d%' then c_client_write end,
                        case when s.robot_ops like '%d%' then c_robot end), '')
     where x.tbl = s.tbl;
  end loop;
end;
$$;

-- ─── 4. Lock phase, children before parents ──────────────────────────────────
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select rel from pg_temp.lockdown_api_scope)
    and con.confrelid in (select rel from pg_temp.lockdown_api_scope)
), walk(start, node, depth, path) as (
  select s.rel::oid, s.rel::oid, 0, array[s.rel::oid] from pg_temp.lockdown_api_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update pg_temp.lockdown_api_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = s.rel::oid;

do $$
declare
  r record;
begin
  for r in select s.rel from pg_temp.lockdown_api_scope s order by s.lock_rank desc, s.tbl loop
    execute format('lock table %s in access exclusive mode', r.rel);
  end loop;
end;
$$;
set local statement_timeout = '120s';

update pg_temp.lockdown_api_scope s
   set small = pg_catalog.pg_total_relation_size(s.rel) <= 8 * 1024 * 1024;

-- The staff probe's sample: up to 1000 rows per table, read here as the migration runner
-- (no RLS). The tables are locked, so the ctids cannot move before the second probe.
do $$
declare
  r record;
  v tid[];
begin
  for r in select s.rel from pg_temp.lockdown_api_scope s loop
    execute format('select coalesce(array_agg(x.ctid), array[]::tid[]) from (select ctid from %s limit 1000) x', r.rel) into v;
    update pg_temp.lockdown_api_scope s set sample = v where s.rel = r.rel;
  end loop;
end;
$$;

-- One PostgREST-style request: role + JWT claims, then a count over the ctid sample,
-- the first p_limit rows, or (p_limit null) the whole table.
-- Returns -1 when the role has no privilege on the table.
create function pg_temp.lockdown_api_probe(p_rel regclass, p_sub uuid, p_limit integer, p_sample tid[] default null)
returns bigint
language plpgsql
as $f$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    if p_sample is not null then
      execute format('select count(*) from %s where ctid = any ($1)', p_rel) into v_n using p_sample;
    elsif p_limit is null then
      execute format('select count(*) from %s', p_rel) into v_n;
    else
      execute format('select count(*) from (select 1 from %s limit %s) s', p_rel, p_limit) into v_n;
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

-- What staff see today among the sampled rows (bounded: a TID scan of at most 1000 rows,
-- however few of them the staff account's own-row policies let through).
do $$
declare
  v_staff uuid;
begin
  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id
   limit 1;
  if v_staff is not null then
    update pg_temp.lockdown_api_scope s set staff_before = pg_temp.lockdown_api_probe(s.rel, v_staff, null, s.sample);
  end if;
end;
$$;

-- ─── 5. Gates ────────────────────────────────────────────────────────────────
do $$
declare
  c_staff constant text := '(select public.is_internal_staff())';
  r record;
  v_using text;
  v_check text;
begin
  for r in select * from pg_temp.lockdown_api_scope order by lock_rank desc, tbl loop
    -- format() turns NULL into '', so test for NULL explicitly.
    v_using := c_staff || case when r.read_ids is not null then format(' or (%s and (%s))', r.own_expr, r.read_ids) else '' end;
    v_check := c_staff || case when r.write_ids is not null then format(' or (%s and (%s))', r.own_expr, r.write_ids) else '' end;
    execute format('drop policy if exists lockdown_api_gate on %s', r.rel);
    execute format('create policy lockdown_api_gate on %s as restrictive for all to anon, authenticated using (%s) with check (%s)',
                   r.rel, v_using, v_check);
    -- DELETE checks only USING; delete rights are narrower than read rights.
    execute format('drop policy if exists lockdown_api_delete_gate on %s', r.rel);
    if r.read_ids is not null then
      execute format('create policy lockdown_api_delete_gate on %s as restrictive for delete to anon, authenticated using (%s)',
                     r.rel, c_staff || case when r.delete_ids is not null then format(' or (%s and (%s))', r.own_expr, r.delete_ids) else '' end);
    end if;
  end loop;
end;
$$;

-- ─── 6. Self-check: fails the migration, never the running app ───────────────
do $$
declare
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_unknown uuid := '00000000-0000-4000-8000-00000000dead';
  v_staff uuid;
  v_client uuid;
  v_robot uuid;
  r record;
  v_n bigint;
  v_expect bigint;
  v_count int;
begin
  select count(*) into v_count from pg_temp.lockdown_api_scope;
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'rls staff-or-own gate: % cannot SET ROLE authenticated for the self-check', current_user;
  end if;

  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id
   limit 1;
  -- A client that owns parser jobs, if any, so the own branch is really exercised.
  select p.id into v_client from public.profiles p
   where p.role = 'client'
   order by (exists (select 1 from public.parser_jobs j where j.user_id = p.id)) desc, p.created_at nulls last, p.id
   limit 1;
  select p.id into v_robot from public.profiles p
   where p.is_api_robot = true and p.role is null
   order by p.created_at nulls last, p.id
   limit 1;

  for r in select * from pg_temp.lockdown_api_scope order by tbl loop
    -- 6a. Structure.
    if not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = 'lockdown_api_gate'
        and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
        and p.roles = array['anon', 'authenticated']::name[]
        and p.qual like '%is_internal_staff()%' and p.with_check like '%is_internal_staff()%'
    ) then
      raise exception 'rls staff-or-own gate: % has no restrictive gate', r.rel;
    end if;
    if r.read_ids is not null and not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = 'lockdown_api_delete_gate'
        and p.permissive = 'RESTRICTIVE' and p.cmd = 'DELETE'
    ) then
      raise exception 'rls staff-or-own gate: % has no delete gate', r.rel;
    end if;

    -- 6b. Staff: exactly what they saw before, on the same sampled rows.
    if v_staff is not null then
      v_n := pg_temp.lockdown_api_probe(r.rel, v_staff, null, r.sample);
      if v_n is distinct from r.staff_before then
        raise exception 'rls staff-or-own gate probe: staff sees % rows in %, before: %', v_n, r.rel, r.staff_before;
      end if;
    end if;

    -- 6c. Non-staff: nothing, or exactly their own rows where the surface allows it.
    --     These probes scan the whole table, so only small tables.
    if r.small then
      v_n := pg_temp.lockdown_api_probe(r.rel, v_unknown, null);
      if v_n not in (0, -1) then
        raise exception 'rls staff-or-own gate probe: a JWT without a profile sees % rows in %', v_n, r.rel;
      end if;

      if v_client is not null then
        if r.read_ids like '%''client''%' then
          perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role', 'authenticated')::text, true);
          perform set_config('request.jwt.claim.sub', v_client::text, true);
          execute format('select count(*) from %s where %s', r.rel, r.own_expr) into v_expect;
        else
          v_expect := 0;
        end if;
        v_n := pg_temp.lockdown_api_probe(r.rel, v_client, null);
        if not (v_n = v_expect or (v_expect = 0 and v_n = -1)) then
          raise exception 'rls staff-or-own gate probe: client % sees % rows in %, expected %', v_client, v_n, r.rel, v_expect;
        end if;
      end if;

      if v_robot is not null then
        if r.read_ids like '%is_api_robot%' then
          perform set_config('request.jwt.claims', json_build_object('sub', v_robot, 'role', 'authenticated')::text, true);
          perform set_config('request.jwt.claim.sub', v_robot::text, true);
          execute format('select count(*) from %s where %s', r.rel, r.own_expr) into v_expect;
        else
          v_expect := 0;
        end if;
        v_n := pg_temp.lockdown_api_probe(r.rel, v_robot, null);
        if not (v_n = v_expect or (v_expect = 0 and v_n = -1)) then
          raise exception 'rls staff-or-own gate probe: Bench robot % sees % rows in %, expected %', v_robot, v_n, r.rel, v_expect;
        end if;
      end if;
    end if;
  end loop;

  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
  raise notice 'rls staff-or-own gate: % tables gated', v_count;
end;
$$;

drop function pg_temp.lockdown_api_probe(regclass, uuid, integer, tid[]);
