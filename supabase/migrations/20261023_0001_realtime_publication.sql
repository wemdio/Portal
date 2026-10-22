-- Realtime postgres_changes read row changes through the publication
-- supabase_realtime (tenant realtime-dev, extension postgres_cdc_rls,
-- publication=supabase_realtime). It did not survive the July move of the main
-- DB: every worker channel failed and the workers fell back to polling their
-- queues every 30 s; live screens of the portal (support chat, parser progress)
-- stopped updating by themselves.
--
-- Only the queue tables the workers subscribe to (worker/*.ts realtimeTables)
-- and the support chat. The busiest queues stay on polling: base_constructor_jobs
-- (1.5M updates in 46 days, each row carries the whole result grid), ve_jobs,
-- website_enrichment_results_buffer and sender_messages.
--
-- Idempotent: applied by hand on 2026-10-23 with the owner's approval; the
-- deploy runner applies it again as a no-op and records it.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array[
    'ai_caller_jobs', 'brief_scoring_jobs', 'bugor_outreach_leads', 'client_byo_messages',
    'client_support_messages', 'crypto_payment_jobs', 'email_validation_jobs', 'google_maps_jobs',
    'google_news_jobs', 'he_jobs', 'hh_archive_jobs', 'inn_enrich_jobs', 'li_campaigns',
    'nash_outreach_leads', 'parser_jobs', 'sales_ai_analysis_jobs', 'sales_chat_archive_jobs',
    'sales_chat_sync_runs', 'search_parser_jobs', 'tg_outreach_jobs', 'tg_parser_jobs',
    'tg_scan_jobs', 'tg_transcribe_jobs', 'website_enrichment_jobs', 'website_inn_lookup_jobs',
    'yandex_direct_jobs', 'yandex_maps_jobs'
  ] loop
    if to_regclass(format('public.%I', t)) is not null and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
