-- Расширение check-constraint external_sync_runs.source двумя новыми источниками
-- для нового воркера leadsReportCron (см. docs/superpowers/plans/2026-07-22-leads-report-automation.md).
--
-- До: metrika, amo_leads, amo_events, bank_tochka, bank_tbank, attribution, amo_enrich.
-- После: + leads_report_marketing, leads_report_outreach.

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
    'leads_report_outreach'
  ));
