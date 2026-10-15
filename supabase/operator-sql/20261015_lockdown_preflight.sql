-- READ-ONLY preflight for 20261015_0030 .. 20261015_0036. Changes nothing.
-- Run only after the owner's explicit yes, as postgres on main-postgres:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 20261015_lockdown_preflight.sql
-- Each block says what to expect; anything else is a decision before applying.

\echo 'Q1. Version. Expect 15.x; 15.8 has the in-place-update race 0036 guards with SHARE UPDATE EXCLUSIVE.'
select version();

\echo 'Q2. Runner. Expect postgres, superuser.'
select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;

\echo 'Q3. LOGIN roles that inherit anon/authenticated. A row with bypassrls = f makes 0031 stop on purpose.'
select r.rolname, r.rolsuper, r.rolbypassrls, r.rolinherit,
       pg_has_role(r.oid, 'anon', 'USAGE') as inherits_anon,
       pg_has_role(r.oid, 'authenticated', 'USAGE') as inherits_authenticated
from pg_roles r
where r.rolcanlogin and not r.rolsuper and r.rolname not in ('authenticator')
order by 1;

\echo 'Q4. service_role bypasses RLS. Expect t.'
select rolbypassrls from pg_roles where rolname = 'service_role';

\echo 'Q5. Staff-role demo accounts. Expect 0: they lose staff rows everywhere (is_internal_staff excludes demo).'
select count(*) as demo_staff from public.profiles where coalesce(is_demo, false) and role is distinct from 'client' and role is not null;

\echo 'Q6. Policies already on the 59 RLS-off tables (switch on with RLS). A RESTRICTIVE one that cuts staff stops 0032.'
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relrowsecurity)
order by 1, 2;

\echo 'Q7. Tables 0034 will gate (catalog scope) and their size. Review the list; on big ones the no-rows probes are skipped and staff are probed on a 1000-row ctid sample.'
select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size,
       (select count(*) from pg_policy p where p.polrelid = c.oid and p.polpermissive) as permissive_policies
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relrowsecurity
  and c.relname not in ('profiles', 'reglament_documents')
  and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive
              and p.polroles && array[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid])
order by pg_total_relation_size(c.oid) desc;

\echo 'Q8. Allowlisted staff RPCs: expect every row present = t (0036 stops on a changed signature).'
select s as signature, to_regprocedure(s) is not null as present
from unnest(array[
  'public.can_access_email_subscriptions()', 'public.can_manage_email_subscriptions()', 'public.can_access_team()',
  'public.can_mutate_team_data(text)', 'public.can_view_team_activity_plan()', 'public.can_manage_team_activity_plan()',
  'public.can_submit_team_review_request()', 'public.can_view_team_review_requests_shared()', 'public.can_use_payment_requests()',
  'public.can_manage_payment_requests()', 'public.convert_team_review_request(uuid,date,text,timestamp with time zone)',
  'public.payment_requests_read_model(date)',
  'public.submit_payment_request_with_budget(uuid,text,text,numeric,uuid,text,text,text,text,date,text,text)',
  'public.transition_payment_request(uuid,text,timestamp with time zone,text,date,text)',
  'public.record_email_subscription_payment_today(uuid,text,text,integer,numeric,text,text,text)',
  'public.decide_email_subscription(uuid,text,text,timestamp with time zone)', 'public.copilot_dialog_stats(uuid)',
  'public.pdl_count_estimate(text[],text[],text[],text)',
  'public.search_pdl_companies(text[],text[],text[],text,text,integer)']) s;

\echo 'Q9. pg_cron jobs. Expect superuser usernames (postgres / supabase_admin).'
select j.jobname, j.schedule, j.username, r.rolsuper from cron.job j left join pg_roles r on r.rolname = j.username;

\echo 'Q10. Relations granted to PUBLIC (0036 stops if any). Expect 0 rows.'
select c.oid::regclass from pg_class c, aclexplode(c.relacl) a
where c.relnamespace = 'public'::regnamespace and a.grantee = 0;

\echo 'Q11. storage.objects: owner columns and existing policies of the two private buckets.'
select attname from pg_attribute where attrelid = 'storage.objects'::regclass and attname in ('owner', 'owner_id') and not attisdropped;
select policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1;
\echo 'Q11b. Permissive storage.objects policies that reach anon (TO public or anon). 0035 neutralises them for briefs and'
\echo '      knowledge-base with a restrictive anon policy; any row naming those buckets is a leak open TODAY: tell the owner.'
select policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE'
  and roles && array['public', 'anon']::name[]
order by 1;

\echo 'Q12. Per-role statement_timeout for anon / authenticated (a client can still seq-scan a big gated table to get nothing).'
select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname in ('anon', 'authenticated', 'authenticator');

\echo 'Q13. Long transactions right now (apply only when this is empty and the workers are drained).'
select pid, usename, application_name, state, now() - xact_start as xact_age, wait_event_type
from pg_stat_activity where xact_start < now() - interval '3 seconds' and pid <> pg_backend_pid() order by xact_start;

\echo 'Q14. Parallel-plan baseline for staff (compare after 0031..0034; EXPLAIN only, no ANALYZE).'
explain select count(*) from public.pdl_companies;

\echo 'Q15. Staff searches that the gates take off their index unless they run as a definer (0033 header 7).'
\echo '     search_pdl_companies: expect owner superuser/bypassrls (0033 stops otherwise) and the trigram index valid.'
\echo '     kb_chunks stays on an invoker search: a seq scan per staff KB search; fine up to a few hundred MB.'
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner, r.rolsuper, r.rolbypassrls, p.prosecdef, p.proconfig
from pg_proc p join pg_roles r on r.oid = p.proowner
where p.oid in (to_regprocedure('public.search_pdl_companies(text[],text[],text[],text,text,integer)'),
                to_regprocedure('public.kb_search_chunks(text,text,text[],integer,integer)'));
select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size, c.reltuples::bigint as est_rows,
       (select string_agg(i.indexrelid::regclass::text || case when i.indisvalid then '' else ' (INVALID)' end, ', ')
          from pg_index i where i.indrelid = c.oid) as indexes
from pg_class c
where c.oid in (to_regclass('public.pdl_companies'), to_regclass('public.kb_chunks'));

\echo 'Q16. Non-superuser roles that get EXECUTE on new public functions after 0036 (direct_fn_roles that exist).'
\echo '     Any other login that calls functions created by later migrations needs an explicit grant there.'
select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin
from pg_roles r
where r.rolname in ('readonly', 'nick_ro', 'supabase_auth_admin', 'supabase_storage_admin')
order by 1;
