-- ROLLBACK of 20261015_0034_rls_tables_staff_or_own_gate.sql. Run as postgres:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 20261015_0034_rls_tables_staff_or_own_gate.rollback.sql
-- Drops the two policies 0034 created on every public table; every other policy is
-- untouched, so today's behaviour comes back exactly.
--
-- LOCKS. Every gated table is locked ACCESS EXCLUSIVE up front, children before parents
-- (FK order, as the migration did), so no lock is upgraded midway and a worker's child
-- INSERT (its FK check needs the parent) cannot deadlock with this file. Each wait is
-- capped at 3s and the whole lock phase at 30s; either aborts the file with nothing
-- changed. Several of these tables are worker queues (parser_jobs, hh_vacancies,
-- search_*, yandex_maps_*, email_validation_*, ...): run it with the workers drained,
-- outside the 06:00/18:00 UTC pg_dump and the 22:00 UTC portal-mirror cron.
-- Keep the 0034 row in public.portal_migrations; ship a corrected fix as a NEW migration.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temp table rb_0034_scope (rel regclass primary key, lock_rank integer not null default 0) on commit drop;
insert into rb_0034_scope (rel)
select distinct c.oid::regclass
from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
where c.relnamespace = 'public'::regnamespace
  and p.polname in ('lockdown_api_gate', 'lockdown_api_delete_gate');

-- lock_rank = longest chain of in-scope FK references starting at the table.
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select rel from rb_0034_scope)
    and con.confrelid in (select rel from rb_0034_scope)
), walk(start, node, depth, path) as (
  select s.rel::oid, s.rel::oid, 0, array[s.rel::oid] from rb_0034_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update rb_0034_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = s.rel::oid;

do $$
declare
  r record;
begin
  for r in select s.rel from rb_0034_scope s order by s.lock_rank desc, s.rel::text loop
    execute format('lock table %s in access exclusive mode', r.rel);
  end loop;
end;
$$;
-- Every gated table is held; no lock waits from here on.
set local statement_timeout = '120s';

do $$
declare
  r record;
begin
  for r in select s.rel from rb_0034_scope s order by s.rel::text loop
    execute format('drop policy if exists lockdown_api_delete_gate on %s', r.rel);
    execute format('drop policy if exists lockdown_api_gate on %s', r.rel);
  end loop;
end;
$$;
commit;
