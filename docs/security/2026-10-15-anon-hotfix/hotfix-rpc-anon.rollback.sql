-- ROLLBACK of hotfix-rpc-anon.sql: restores the ACLs saved in rpc-acl-before.txt.
begin;
set local lock_timeout = '3s';
do $$
declare f regprocedure;
begin
  foreach f in array array['public.agent_query_readonly(text)',
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
    'public.yandex_maps_catalog_mark_seen(text[],text,text,text,boolean,integer)']::regprocedure[] loop
    execute format('grant execute on function %s to public', f);
  end loop;
  foreach f in array array['public.agent_query_readonly(text)',
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
    'public.tg_transcribed_chat_topic_counts()']::regprocedure[] loop
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
commit;
