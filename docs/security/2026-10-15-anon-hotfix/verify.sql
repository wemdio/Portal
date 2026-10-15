-- READ-ONLY. Проверка состояния после hotfix-anon-tables.sql и hotfix-rpc-anon.sql.
-- Ничего не меняет и не берёт блокировок сильнее ACCESS SHARE. Запускать на прод-базе
-- только с согласия владельца:
--   ssh root@139.60.162.24
--   docker exec -i main-postgres psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 < verify.sql
-- Ожидания ниже — для состояния «хотфикс применён, 20261015_0036 ещё нет».
-- После 0036 отличается только V3: tg_outreach_swap_proxy теряет authenticated (auth_exec = f).

\echo 'V1. Объекты public, к которым у anon есть хоть какое-то право. Ожидается ровно 3 строки:'
\echo '    companies_directory (select), database_review_row_marks (select, insert), reglament_documents (select).'
select c.relname, c.relkind,
       has_any_column_privilege('anon', c.oid, 'SELECT') as sel,
       has_any_column_privilege('anon', c.oid, 'INSERT') as ins,
       has_any_column_privilege('anon', c.oid, 'UPDATE') as upd,
       has_table_privilege('anon', c.oid, 'DELETE') as del,
       has_table_privilege('anon', c.oid, 'TRUNCATE,REFERENCES,TRIGGER') as other
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_table_privilege('anon', c.oid, 'DELETE,TRUNCATE,TRIGGER'))
order by 1;

\echo 'V2. Последовательности public, доступные anon. Ожидается 0 строк.'
-- CASE, а не AND: порядок проверки условий в WHERE не гарантирован, а
-- has_sequence_privilege падает на объекте, который не последовательность.
select c.relname
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') else false end;

\echo 'V3. 25 функций хотфикса. Ожидается: present = t и anon_exec = f во всех строках, service_exec = t во всех,'
\echo '    auth_exec = t только у copilot_dialog_stats и tg_outreach_swap_proxy (после 0036 — только у copilot_dialog_stats).'
select s.sig,
       p.oid is not null as present,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
from unnest(array[
  'public.agent_query_readonly(text)',
  'public.cleanup_application_logs(integer)',
  'public.cleanup_expired_manual_score_runs()',
  'public.cleanup_old_completed_tasks()',
  'public.cleanup_old_project_notes()',
  'public.copilot_dialog_stats(uuid)',
  'public.drain_enrich_results_buffer(integer)',
  'public.instantly_acquire_token(text,double precision,double precision,double precision)',
  'public.mailganer_acquire_score_token(text,double precision,double precision,double precision)',
  'public.tg_outreach_swap_proxy(uuid,uuid,uuid,text,integer)',
  'public.tg_parser_increment_usage(uuid)',
  'public.tg_transcribed_chat_topic_counts()',
  'public.yandex_maps_catalog_reserve_daily_budget(integer,integer)',
  'public.yandex_maps_catalog_upsert_rows(jsonb)',
  'public.yandex_maps_catalog_claim_refresh_batch(integer,integer)',
  'public.yandex_maps_catalog_record_completed(integer)',
  'public.yandex_maps_catalog_refresh_dictionaries(integer)',
  'public.yandex_maps_catalog_search(text[],text[],text[],integer,integer,text)',
  'public.yandex_maps_catalog_count(text[],text[],text[],integer)',
  'public.yandex_maps_catalog_seed_discovery_queue(integer,integer)',
  'public.yandex_maps_catalog_claim_discovery(integer,integer)',
  'public.yandex_maps_catalog_finish_discovery(bigint,integer,integer,boolean,text)',
  'public.yandex_maps_catalog_known_ids(text[])',
  'public.yandex_maps_catalog_fill_job(uuid,text[],text[],text[],integer)',
  'public.yandex_maps_catalog_mark_seen(text[],text,text,text,boolean,integer)'
]) as s(sig)
left join pg_proc p on p.oid = to_regprocedure(s.sig)
order by 1;

\echo 'V4. Остальные SECURITY DEFINER функции public, которые anon ещё может вызвать (хотфикс их не трогал).'
\echo '    До 0036 строки здесь ожидаемы — это остаток, который закрывает 0036. После 0036 ожидается 0 строк.'
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
order by 1;

\echo 'V5. Применены ли уже миграции серии. Пока строк нет, действует только хотфикс.'
select name, applied_at
from public.portal_migrations
where name like '20261015_003%'
order by name;
