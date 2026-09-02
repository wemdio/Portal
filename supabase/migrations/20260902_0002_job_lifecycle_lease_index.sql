-- migrate:no-transaction
--
-- Индекс (status, lease_until) для 28 таблиц задач из 20260902_0001 —
-- отдельной no-transaction миграцией, тем же приёмом, что и idx_amo_leads_inn
-- на amo_leads (20260813_0002).
--
-- Почему отдельно и concurrently: обычный create index внутри транзакции
-- держит SHARE-блокировку на таблице на всё время сборки и блокирует
-- INSERT/UPDATE/DELETE. На горячих таблицах очередей (parser_jobs,
-- website_enrichment_jobs, email_validation_jobs, yandex_maps_jobs,
-- yandex_maps_catalog_discovery_queue и остальных) это как раз стопорит
-- воркеров, для защиты которых эта фича и делается — а по 30s lock_timeout
-- сборка ещё и падает целиком на всех 28 таблицах разом. create index
-- concurrently вне транзакции такого лока не берёт, но Postgres запрещает
-- concurrently внутри транзакции и внутри do-блока с долларовыми кавычками —
-- отсюда маркер -- migrate:no-transaction выше и явные statements без
-- долларовых кавычек вместо цикла (noTransactionMigrations.test.ts это и
-- проверяет).
--
-- Почему сначала drop: упавшая на середине сборка concurrently оставляет
-- невалидный индекс с занятым именем — повторный create index concurrently
-- if not exists увидел бы имя занятым и молча ничего не сделал бы, и в базе
-- навсегда остался бы индекс, которым планировщик не пользуется. drop index
-- concurrently if exists на первом прогоне — no-op, на повторном — уборка.

drop index concurrently if exists public.base_constructor_jobs_lease_idx;
create index concurrently if not exists base_constructor_jobs_lease_idx on public.base_constructor_jobs (status, lease_until);
drop index concurrently if exists public.tg_parser_jobs_lease_idx;
create index concurrently if not exists tg_parser_jobs_lease_idx on public.tg_parser_jobs (status, lease_until);
drop index concurrently if exists public.parser_jobs_lease_idx;
create index concurrently if not exists parser_jobs_lease_idx on public.parser_jobs (status, lease_until);
drop index concurrently if exists public.hh_archive_jobs_lease_idx;
create index concurrently if not exists hh_archive_jobs_lease_idx on public.hh_archive_jobs (status, lease_until);
drop index concurrently if exists public.yandex_direct_jobs_lease_idx;
create index concurrently if not exists yandex_direct_jobs_lease_idx on public.yandex_direct_jobs (status, lease_until);
drop index concurrently if exists public.search_parser_jobs_lease_idx;
create index concurrently if not exists search_parser_jobs_lease_idx on public.search_parser_jobs (status, lease_until);
drop index concurrently if exists public.sales_chat_archive_jobs_lease_idx;
create index concurrently if not exists sales_chat_archive_jobs_lease_idx on public.sales_chat_archive_jobs (status, lease_until);
drop index concurrently if exists public.sales_chat_sync_runs_lease_idx;
create index concurrently if not exists sales_chat_sync_runs_lease_idx on public.sales_chat_sync_runs (status, lease_until);
drop index concurrently if exists public.yandex_maps_jobs_lease_idx;
create index concurrently if not exists yandex_maps_jobs_lease_idx on public.yandex_maps_jobs (status, lease_until);
drop index concurrently if exists public.yandex_maps_catalog_discovery_queue_lease_idx;
create index concurrently if not exists yandex_maps_catalog_discovery_queue_lease_idx on public.yandex_maps_catalog_discovery_queue (status, lease_until);
drop index concurrently if exists public.tg_outreach_campaigns_lease_idx;
create index concurrently if not exists tg_outreach_campaigns_lease_idx on public.tg_outreach_campaigns (status, lease_until);
drop index concurrently if exists public.tg_outreach_warmup_runs_lease_idx;
create index concurrently if not exists tg_outreach_warmup_runs_lease_idx on public.tg_outreach_warmup_runs (status, lease_until);
drop index concurrently if exists public.tg_outreach_jobs_lease_idx;
create index concurrently if not exists tg_outreach_jobs_lease_idx on public.tg_outreach_jobs (status, lease_until);
drop index concurrently if exists public.ai_campaigns_lease_idx;
create index concurrently if not exists ai_campaigns_lease_idx on public.ai_campaigns (status, lease_until);
drop index concurrently if exists public.ai_caller_jobs_lease_idx;
create index concurrently if not exists ai_caller_jobs_lease_idx on public.ai_caller_jobs (status, lease_until);
drop index concurrently if exists public.li_campaigns_lease_idx;
create index concurrently if not exists li_campaigns_lease_idx on public.li_campaigns (status, lease_until);
drop index concurrently if exists public.website_enrichment_jobs_lease_idx;
create index concurrently if not exists website_enrichment_jobs_lease_idx on public.website_enrichment_jobs (status, lease_until);
drop index concurrently if exists public.brief_scoring_jobs_lease_idx;
create index concurrently if not exists brief_scoring_jobs_lease_idx on public.brief_scoring_jobs (status, lease_until);
drop index concurrently if exists public.crypto_payment_jobs_lease_idx;
create index concurrently if not exists crypto_payment_jobs_lease_idx on public.crypto_payment_jobs (status, lease_until);
drop index concurrently if exists public.email_validation_jobs_lease_idx;
create index concurrently if not exists email_validation_jobs_lease_idx on public.email_validation_jobs (status, lease_until);
drop index concurrently if exists public.inn_enrich_jobs_lease_idx;
create index concurrently if not exists inn_enrich_jobs_lease_idx on public.inn_enrich_jobs (status, lease_until);
drop index concurrently if exists public.website_inn_lookup_jobs_lease_idx;
create index concurrently if not exists website_inn_lookup_jobs_lease_idx on public.website_inn_lookup_jobs (status, lease_until);
drop index concurrently if exists public.tg_scan_jobs_lease_idx;
create index concurrently if not exists tg_scan_jobs_lease_idx on public.tg_scan_jobs (status, lease_until);
drop index concurrently if exists public.tg_transcribe_jobs_lease_idx;
create index concurrently if not exists tg_transcribe_jobs_lease_idx on public.tg_transcribe_jobs (status, lease_until);
drop index concurrently if exists public.client_report_export_jobs_lease_idx;
create index concurrently if not exists client_report_export_jobs_lease_idx on public.client_report_export_jobs (status, lease_until);
drop index concurrently if exists public.he_jobs_lease_idx;
create index concurrently if not exists he_jobs_lease_idx on public.he_jobs (status, lease_until);
drop index concurrently if exists public.ve_jobs_lease_idx;
create index concurrently if not exists ve_jobs_lease_idx on public.ve_jobs (status, lease_until);
drop index concurrently if exists public.client_manual_score_runs_lease_idx;
create index concurrently if not exists client_manual_score_runs_lease_idx on public.client_manual_score_runs (status, lease_until);