-- Rollback of 20261015_0032_no_rls_tables_lockdown.sql. Run as postgres or supabase_admin
-- with psql -v ON_ERROR_STOP=1 -f. Restores today's state of the 59 tables: the policies
-- this migration created are dropped and RLS is disabled again (all 59 were RLS-off on
-- prod). Hand-made policies, if any, are left alone and become dormant again. Also drops
-- the policies of optional-hardening.sql if that was applied.
-- NOT restored on purpose: anon privileges (the 2026-10-15 hotfix state; no app path
-- uses anon on these tables) and authenticated on the five service-only tables (prod
-- had none).
-- Keep the 20261015_0032 row in public.portal_migrations; ship a corrected fix as a NEW
-- migration file.
--
-- LOCKS. Every table of the list that exists is locked ACCESS EXCLUSIVE up front, children
-- before parents (FK order, as the migration did), so no lock is upgraded midway and a
-- worker's child INSERT (its FK check needs the parent) cannot deadlock with this file.
-- Each wait is capped at 3s and the whole lock phase at 30s; either aborts the file with
-- nothing changed. Run it with the workers drained (tg_scan_jobs, tg_transcribe_jobs,
-- demo_personalize_runs, the rate-budget tables and portal_migrations are hot), outside
-- the 06:00/18:00 UTC pg_dump and the 22:00 UTC portal-mirror cron, and not while a
-- deploy runs (ensureDatabase writes portal_migrations).
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temp table rb_0032_scope (tbl text primary key, rel regclass, lock_rank integer not null default 0) on commit drop;
insert into rb_0032_scope (tbl)
select t from unnest(array[
    'fx_rate_probes', 'gis_signal_company_signals_bak_20260812', 'health_check_job_alerts',
    'transcript_amo_lead_link', 've_search_cache',
    'auth_group', 'auth_group_permissions', 'auth_permission', 'auth_user',
    'auth_user_groups', 'auth_user_user_permissions', 'chat_chatmessage',
    'chat_chatmessage_recipients', 'chat_chatmessage_to', 'crm_deal', 'crm_lead',
    'django_admin_log', 'django_content_type', 'django_migrations',
    'linkedin_actionlog', 'linkedin_campaign', 'linkedin_campaign_users',
    'linkedin_linkedinprofile', 'linkedin_searchkeyword', 'linkedin_task',
    '_tmp_okved_rank', 'bak_stored_passscore_20260710',
    'bot_known_chats', 'client_forwarded_leads', 'client_lead_comments',
    'client_telegram_chats', 'instantly_brief_campaigns', 'instantly_briefs',
    'schema_migrations', 'activity_type_okved_mapping', 'audio_transcripts',
    'demo_personalize_runs', 'li_campaign_step_stats', 'tg_atmos_settings',
    'tg_atmos_users', 'tg_atmos_checks', 'tg_atmos_chat_state', 'tg_atmos_messages',
    'health_check_settings', 'in_app_bot_states', 'changelog_digests', 'tg_bot_chats',
    'phone_identities', 'outreachos_suppression', 'companies', 'tg_video_transcripts',
    'tg_scan_jobs', 'tg_transcribe_jobs', 'portal_migrations',
    'okved_reference', 'li_campaign_logs', 'mailganer_scoring_rate_budget',
    'instantly_rate_budget', 'user_tool_visibility'
]) t;
update rb_0032_scope set rel = to_regclass(format('public.%I', tbl));
delete from rb_0032_scope where rel is null;

-- lock_rank = longest chain of in-scope FK references starting at the table.
with recursive fk as (
  select con.conrelid as child, con.confrelid as parent
  from pg_catalog.pg_constraint con
  where con.contype = 'f' and con.conrelid <> con.confrelid
    and con.conrelid in (select rel from rb_0032_scope)
    and con.confrelid in (select rel from rb_0032_scope)
), walk(start, node, depth, path) as (
  select s.rel::oid, s.rel::oid, 0, array[s.rel::oid] from rb_0032_scope s
  union all
  select w.start, fk.parent, w.depth + 1, w.path || fk.parent
  from walk w join fk on fk.child = w.node
  where not fk.parent = any (w.path) and w.depth < 32
)
update rb_0032_scope s
   set lock_rank = d.rank
  from (select start, max(depth) as rank from walk group by start) d
 where d.start = s.rel::oid;

do $$
declare
  r record;
begin
  for r in select s.rel from rb_0032_scope s order by s.lock_rank desc, s.tbl loop
    execute format('lock table %s in access exclusive mode', r.rel);
  end loop;
end;
$$;
-- Every table in scope is held; no lock waits from here on.
set local statement_timeout = '120s';

do $$
declare
  t text;
  r regclass;
  p text;
begin
  for t, r in select x.tbl, x.rel from rb_0032_scope x order by x.tbl loop
    foreach p in array array['_staff_all', '_staff_select', '_direct_db_roles', '_staff_gate',
                             '_select_own', '_select_gate', '_insert_gate', '_update_gate', '_delete_gate',
                             '_no_api_insert', '_no_api_update', '_no_api_delete'] loop
      execute format('drop policy if exists %I on %s', t || p, r);
    end loop;
    execute format('alter table %s disable row level security', r);
  end loop;
end;
$$;
commit;

-- Narrower levers when only one thing is wrong (instead of the full rollback):
--   a staff page lost rows of table X, PostgREST logs "permission denied for function
--   is_internal_staff":  grant execute on function public.is_internal_staff() to authenticated;
--   a direct DB login lost rows of table X:
--     create policy X_direct_db_roles on public.X for all to public
--       using ((select current_user) not in ('anon', 'authenticated'))
--       with check ((select current_user) not in ('anon', 'authenticated'));
--   one table only:  begin; set local lock_timeout = '3s';
--     alter table public.X disable row level security; commit;
