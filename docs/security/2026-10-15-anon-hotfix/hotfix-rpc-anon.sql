-- HOTFIX 2026-10-14: SECURITY DEFINER functions in public were executable by anon
-- (public anon key via /rest/v1/rpc) and by any signed-in user. Callers verified:
-- service role everywhere, except copilot_dialog_stats (staff browser) and
-- tg_outreach_swap_proxy (kept for authenticated until its callers are fully traced).
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
    execute format('grant execute on function %s to service_role', f);
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
  foreach f in array array['public.copilot_dialog_stats(uuid)',
    'public.tg_outreach_swap_proxy(uuid,uuid,uuid,text,integer)']::regprocedure[] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.agent_query_readonly(text)',
    'public.cleanup_application_logs(integer)',
    'public.cleanup_expired_manual_score_runs()',
    'public.cleanup_old_completed_tasks()',
    'public.cleanup_old_project_notes()',
    'public.drain_enrich_results_buffer(integer)',
    'public.instantly_acquire_token(text,double precision,double precision,double precision)',
    'public.mailganer_acquire_score_token(text,double precision,double precision,double precision)',
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
    execute format('revoke execute on function %s from authenticated', f);
  end loop;
end $$;
do $$
declare n_anon int; n_auth int; n_svc int;
begin
  select count(*) filter (where has_function_privilege('anon', p.oid, 'execute')),
         count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')),
         count(*) filter (where not has_function_privilege('service_role', p.oid, 'execute'))
    into n_anon, n_auth, n_svc
  from unnest(array['public.agent_query_readonly(text)',
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
    'public.yandex_maps_catalog_mark_seen(text[],text,text,text,boolean,integer)']::regprocedure[]) as t(f) join pg_proc p on p.oid = t.f;
  if n_anon <> 0 or n_auth <> 2 or n_svc <> 0 then
    raise exception 'hotfix check failed: anon=% authenticated=% service_role_missing=%', n_anon, n_auth, n_svc;
  end if;
end $$;
commit;
