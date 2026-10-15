-- ROLLBACK of 20261015_0033_open_policies_staff_gate.sql. Run as postgres or supabase_admin:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 20261015_0033_open_policies_staff_gate.rollback.sql
-- Restores today's policy behaviour for staff, clients and service_role:
--   * drops every gate and every <table>_staff_<cmd> / fns_revenue_staff_select policy;
--   * retargets the 28 "service role ..." policies back TO public;
--   * restores the SECURITY INVOKER pdl_count_estimate and search_pdl_companies (EXECUTE
--     for authenticated and service_role, as before; PUBLIC is not re-granted, since
--     that would reach anon too).
-- Deliberately NOT restored: anon table grants (that is
-- docs/security/2026-10-15-anon-hotfix/hotfix-anon-tables.rollback.sql), RLS on fns_revenue
-- is switched off again only where no other policy exists (repo-built DB).
-- Keep the 0033 row in public.portal_migrations; ship a corrected fix as a NEW migration.
-- Run after the 0036 and 0034 rollbacks and before the 0031 rollback (the functions
-- restored here no longer call is_api_robot()).
--
-- LOCKS. Every table of the list that exists is locked ACCESS EXCLUSIVE up front, children
-- before parents (FK order, as the migration did), so no lock is upgraded midway and a
-- worker's child INSERT (its FK check needs the parent) cannot deadlock with this file.
-- Each wait is capped at 3s and the whole lock phase at 30s; either aborts the file with
-- nothing changed. Even so, run it with the VE2/HE/tg-outreach and parser workers drained,
-- outside the 06:00/18:00 UTC pg_dump and the 22:00 UTC portal-mirror cron: a long holder
-- makes the lock phase time out, and while it waits every reader of the locked tables queues.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temp table rb_0033_scope (tbl text primary key, rel regclass, lock_rank integer not null default 0) on commit drop;
insert into rb_0033_scope (tbl)
select t from unnest(array[
    'ai_call_analyses',
    'ai_caller_tg_chats',
    'ai_campaign_contacts',
    'ai_campaigns',
    'amo_events',
    'amo_leads',
    'amo_statuses',
    'amo_users',
    'attribution_amo_project',
    'attribution_payment_project',
    'attribution_visit_lead',
    'background_scorer_state',
    'bank_transactions',
    'bugor_outreach_config',
    'bugor_outreach_leads',
    'client_auto_pipeline_configs',
    'client_auto_pipeline_runs',
    'client_auto_pipeline_seen_employers',
    'client_campaign_leads',
    'client_instantly_access',
    'client_manual_score_rows',
    'client_manual_score_runs',
    'client_tariffs',
    'companies_directory',
    'database_review_requests',
    'database_review_row_marks',
    'external_sync_runs',
    'finance_expenses',
    'fns_revenue',
    'funded_companies',
    'gis_signal_company_signals',
    'gis_signal_pipeline_config',
    'gis_signal_runs',
    'gis_signal_seen_companies',
    'gis_signal_segments',
    'global_tool_visibility',
    'instantly_lead_qualifications',
    'instantly_webhook_events',
    'invoices',
    'kb_chunks',
    'kb_compiled_brief',
    'kb_documents',
    'large_score_domains',
    'large_score_jobs',
    'leadgen_radar_signals',
    'leads_report_subscribers',
    'li_accounts',
    'li_campaigns',
    'mailganer_domain_scores',
    'metrika_visits',
    'metrika_visits_daily',
    'nash_outreach_config',
    'nash_outreach_leads',
    'outreachos_pipeline_config',
    'outreachos_pipeline_runs',
    'outreachos_seen_employers',
    'pdl_companies',
    'polza_chain_templates',
    'polza_outreach_companies',
    'polza_outreach_settings',
    'polza_ru_cases',
    'polza_ru_offer_claims',
    'polza_ru_outreach_companies',
    'polza_ru_senders',
    'polza_ru_signal_rows',
    'polza_ru_signal_uploads',
    'portal_translations',
    'project_contacts_history',
    'project_notes',
    'project_periods',
    'projects',
    'rdp_bookings',
    'rdp_sessions',
    'sales_ai_analysis_jobs',
    'sales_ai_deal_analysis',
    'sales_ai_evidence',
    'sales_regulation',
    'task_board_columns',
    'task_boards',
    'tasks',
    'tg_outreach_account_moves',
    'tg_outreach_accounts',
    'tg_outreach_base_attachments',
    'tg_outreach_base_contacts',
    'tg_outreach_bases',
    'tg_outreach_campaign_bases',
    'tg_outreach_campaigns',
    'tg_outreach_crm_pushes',
    'tg_outreach_dialogs',
    'tg_outreach_jobs',
    'tg_outreach_lead_forwards',
    'tg_outreach_logs',
    'tg_outreach_processed',
    'tg_outreach_proxies',
    'tg_outreach_proxy_swaps',
    'tg_outreach_warmup_activities',
    'tg_outreach_warmup_chat_members',
    'tg_outreach_warmup_chats',
    'tg_outreach_warmup_conversations',
    'tg_outreach_warmup_logs',
    'tg_outreach_warmup_peers',
    'tg_outreach_warmup_runs',
    'tg_parser_account_usage',
    'tg_parser_accounts',
    'tg_parser_jobs',
    'tg_parser_logs',
    'tg_pool_account_tags',
    'tg_pool_accounts',
    'tg_pool_proxies',
    'tg_pool_proxy_tags',
    'tg_pool_tags',
    'trace_spans',
    'user_instantly_campaign_preferences',
    'user_reply_macros'
]) t;
update rb_0033_scope set rel = to_regclass(format('public.%I', tbl));
delete from rb_0033_scope where rel is null;

-- lock_rank = longest chain of in-scope FK references starting at the table.
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select rel from rb_0033_scope)
    and con.confrelid in (select rel from rb_0033_scope)
), walk(start, node, depth, path) as (
  select s.rel::oid, s.rel::oid, 0, array[s.rel::oid] from rb_0033_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update rb_0033_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = s.rel::oid;

do $$
declare
  r record;
begin
  for r in select s.rel from rb_0033_scope s order by s.lock_rank desc, s.tbl loop
    execute format('lock table %s in access exclusive mode', r.rel);
  end loop;
end;
$$;
-- Every table in scope is held; no lock waits from here on.
set local statement_timeout = '120s';

do $$
declare
  t text;
  p record;
  v_name text;
begin
  for t in select s.tbl from rb_0033_scope s order by s.tbl loop
    foreach v_name in array array[
      t || '_staff_gate', t || '_staff_or_own_gate', t || '_staff_or_robot_gate',
      t || '_staff_insert_gate', t || '_staff_update_gate', t || '_staff_delete_gate',
      t || '_staff_all', t || '_staff_select', t || '_staff_insert', t || '_staff_update', t || '_staff_delete'
    ] loop
      execute format('drop policy if exists %I on public.%I', v_name, t);
    end loop;
  end loop;

  for p in
    select v.tbl, v.pol
      from (values
    ('background_scorer_state', 'Service role full access on background_scorer_state'),
    ('client_auto_pipeline_configs', 'Service role full access on client_auto_pipeline_configs'),
    ('client_auto_pipeline_runs', 'Service role full access on auto_pipeline_runs'),
    ('client_auto_pipeline_seen_employers', 'Service role full access on seen_employers'),
    ('client_campaign_leads', 'Service role full access on client_campaign_leads'),
    ('client_instantly_access', 'Service role full access'),
    ('client_manual_score_rows', 'Service role full access on manual_rows'),
    ('client_manual_score_runs', 'Service role full access on manual_runs'),
    ('client_tariffs', 'Service role full access on client_tariffs'),
    ('companies_directory', 'service_role_full_access'),
    ('gis_signal_company_signals', 'service role full access on gis_signal_company_signals'),
    ('gis_signal_pipeline_config', 'service role full access on gis_signal_pipeline_config'),
    ('gis_signal_runs', 'service role full access on gis_signal_runs'),
    ('gis_signal_seen_companies', 'service role full access on gis_signal_seen_companies'),
    ('gis_signal_segments', 'service role full access on gis_signal_segments'),
    ('instantly_lead_qualifications', 'Service role full access on instantly_lead_qualifications'),
    ('instantly_webhook_events', 'Service role full access on instantly_webhook_events'),
    ('invoices', 'invoices_service_role_all'),
    ('large_score_domains', 'Service role full access on large_score_domains'),
    ('large_score_jobs', 'Service role full access on large_score_jobs'),
    ('mailganer_domain_scores', 'Service role full access on mailganer cache'),
    ('outreachos_pipeline_config', 'service role full access on outreachos_pipeline_config'),
    ('outreachos_pipeline_runs', 'service role full access on outreachos_pipeline_runs'),
    ('outreachos_seen_employers', 'service role full access on outreachos_seen_employers'),
    ('trace_spans', 'trace_spans_insert_service'),
    ('trace_spans', 'trace_spans_update_service'),
    ('user_instantly_campaign_preferences', 'Service role full access on user_instantly_campaign_preferences'),
    ('user_reply_macros', 'Service role full access on user_reply_macros')
      ) v(tbl, pol)
     where exists (select 1 from pg_catalog.pg_policies x
                    where x.schemaname = 'public' and x.tablename = v.tbl and x.policyname = v.pol)
  loop
    execute format('alter policy %I on public.%I to public', p.pol, p.tbl);
  end loop;
end;
$$;

drop policy if exists fns_revenue_staff_select on public.fns_revenue;
-- In a repo-built database fns_revenue never had RLS (the migration enabled it). On prod it
-- has its own select policy and RLS stays on.
do $$
begin
  if to_regclass('public.fns_revenue') is not null
     and not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'fns_revenue') then
    alter table public.fns_revenue disable row level security;
  end if;
end;
$$;

create or replace function public.pdl_count_estimate(
  p_country  text[] default null,
  p_industry text[] default null,
  p_size     text[] default null,
  p_name     text   default null
) returns bigint
language plpgsql
volatile
security invoker
set search_path = public
as $fn$
declare
  conds text := '';
  plan  json;
begin
  if p_country is not null and array_length(p_country, 1) > 0 then
    conds := conds || format(' and country = any (%L::text[])', p_country);
  end if;
  if p_industry is not null and array_length(p_industry, 1) > 0 then
    conds := conds || format(' and industry = any (%L::text[])', p_industry);
  end if;
  if p_size is not null and array_length(p_size, 1) > 0 then
    conds := conds || format(' and size = any (%L::text[])', p_size);
  end if;
  if p_name is not null and length(trim(p_name)) > 0 then
    conds := conds || format(' and name ilike %L', '%' || trim(p_name) || '%');
  end if;

  execute 'explain (format json) select 1 from public.pdl_companies where true' || conds into plan;
  return (plan -> 0 -> 'Plan' ->> 'Plan Rows')::bigint;
end;
$fn$;
grant execute on function public.pdl_count_estimate(text[], text[], text[], text) to authenticated, service_role;

-- search_pdl_companies exactly as 20260901_0001 defined it (SECURITY INVOKER, no
-- search_path). CREATE OR REPLACE keeps the owner and the ACL.
create or replace function public.search_pdl_companies(
  p_industries text[] default null,
  p_sizes      text[] default null,
  p_countries  text[] default null,
  p_name       text   default null,
  p_after_id   text   default null,
  p_limit      int    default 1000
)
returns jsonb
language plpgsql stable
security invoker
set statement_timeout = '120s'
as $fn$
begin
  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      with m as materialized (
        select p.id, p.name, p.website, p.industry, p.size, p.country,
               p.region, p.locality, p.description
        from public.pdl_companies p
        where (p_industries is null or p.industry = any(p_industries))
          and (p_sizes is null or p.size = any(p_sizes))
          and (p_countries is null or p.country = any(p_countries))
          and (p_name is null or p.name ilike '%' || p_name || '%')
      )
      select * from m
      where (p_after_id is null or m.id > p_after_id)
      order by m.id
      limit greatest(1, least(coalesce(p_limit, 1000), 100000))
    ) sub
  ), '[]'::jsonb);
end;
$fn$;
grant execute on function public.search_pdl_companies(text[], text[], text[], text, text, int) to service_role, authenticated;

commit;
