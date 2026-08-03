-- Регистрация источника meeting_links в логе ночного синка.
--
-- external_sync_runs.source — CHECK со списком имён. main.py пишет запись о
-- прогоне ДО вызова источника и делает это вне try/except (см. run_all() в
-- services/portal-external-sync/main.py) — незарегистрированное имя роняет
-- не один источник, а весь ночной цикл целиком: отвалятся и AMO, и банки, и
-- курсы. Тот же приём, что уже применён в 20260730_0001_expenses_core.sql
-- для 'expense_rules'.
--
-- Список продолжает актуальный из 20260730_0001_expenses_core.sql, полностью
-- без сокращений — иначе отвалятся уже работающие источники.

alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika',
    'amo_leads',
    'amo_events',
    'bank_tochka',
    'bank_tbank',
    'attribution',
    'amo_enrich',
    'leads_report_marketing',
    'leads_report_outreach',
    'leads_report_summary',
    'brocard',
    'fx_cbr',
    'expense_rules',
    'meeting_links'
  ));
