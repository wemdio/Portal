-- HOTFIX 2026-10-15: the public anon key (in every browser bundle) could read and write
-- public tables without RLS or with `TO public USING (true)` policies. No app path uses
-- anon for tables (public pages go through API routes on the service role; auth goes
-- through GoTrue). Keep the three tables that have deliberate anon policies.
begin;
set local lock_timeout = '3s';
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select on table public.reglament_documents to anon;
grant select on table public.companies_directory to anon;
grant select, insert on table public.database_review_row_marks to anon;
do $$
declare n int;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid=c.relnamespace
   where s.nspname='public' and c.relkind in ('r','p','v','m')
     and has_table_privilege('anon', c.oid, 'SELECT')
     and c.relname not in ('reglament_documents','companies_directory','database_review_row_marks');
  if n <> 0 then raise exception 'anon still reads % relations', n; end if;
end $$;
commit;
